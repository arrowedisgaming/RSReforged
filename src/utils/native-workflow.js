import { MODULE_SHORT } from '../module/const.js';
import { ActivityUtility } from './activity.js';
import { SettingsUtility, SETTING_NAMES } from './settings.js';

const pending = new Map();
const ammunitionSnapshots = new WeakMap();

export const NATIVE_ACTIVITY_TYPES = new Set(['attack', 'damage', 'heal', 'save', 'check', 'utility']);

export function getNativeRollSources(parent) {
    return (parent.getAssociatedRolls?.() ?? []).filter(message => message.id !== parent.id);
}

/** Reproduce the native chat-action context without spending usage resources again. */
export function getUsageActivity(parent, activity = parent.getAssociatedActivity?.()) {
    if (!activity) return null;
    const consumed = activity.createConsumedFlag?.(parent.getAssociatedActor?.(), parent.system?.deltas);
    const scaling = parent.system?.scaling ?? 0;
    const item = (consumed || scaling)
        ? activity.item.clone({ 'flags.dnd5e': { consumed, scaling } }, { keepId: true })
        : activity.item;
    const resolved = item.system?.activities?.get(activity.id);
    if (!resolved) throw new Error("The finalized activity could not be resolved on its item snapshot.");
    return resolved;
}

/**
 * dnd5e fires `dnd5e.rollAttack` with the pending ammunition update before it deletes
 * the final auto-destroyed unit. Because the workflow rolls with `create:false`, the
 * registry lookup dnd5e uses to stash that unit's snapshot on the attack message cannot
 * succeed, so the snapshot is recorded here and written into the attack data instead.
 */
export function recordAmmunitionSnapshot(activity, ammoUpdate, snapshot = () => activity?.actor?.items?.get(ammoUpdate.id)?.toObject()) {
    if (!activity || !ammoUpdate?.destroy) return;
    const data = snapshot();
    if (data) ammunitionSnapshots.set(activity, data);
}

function takeAmmunitionSnapshot(activity) {
    const data = ammunitionSnapshots.get(activity);
    ammunitionSnapshots.delete(activity);
    return data;
}

const messageCaptures = new Map();
let captureSequence = 0;

/**
 * dnd5e never mutates the message configuration a caller passes to a roll method: it
 * merges it into its own object, and BasicRoll.buildPost assigns the fully prepared
 * message source (type, speaker, rolls, system) to `data` on THAT object. With
 * `create:false` the prepared source is therefore unreachable from the caller's side.
 * `dnd5e.postRollConfiguration` receives dnd5e's internal object, so the reference is
 * kept here, correlated by a token the seed carries in its module flags, and its `data`
 * is read once the roll method resolves.
 */
export function captureNativeMessageConfig(message) {
    const id = message?.data?.flags?.[MODULE_SHORT]?.nativeCaptureId;
    if (id && messageCaptures.has(id)) messageCaptures.set(id, message);
}

/** Read and release the prepared message source for a seed; throws if dnd5e never prepared one. */
function takePreparedData(seed) {
    const id = seed.data.flags[MODULE_SHORT].nativeCaptureId;
    const captured = messageCaptures.get(id);
    messageCaptures.delete(id);
    const data = captured?.data;
    if (!data?.type || !data.rolls?.length) {
        throw new Error("dnd5e did not provide a prepared roll message; nothing was created.");
    }
    delete data.flags?.[MODULE_SHORT]?.nativeCaptureId;
    return data;
}

function releaseCapture(seed) {
    messageCaptures.delete(seed.data.flags[MODULE_SHORT].nativeCaptureId);
}

function messageConfig(parent, seeds) {
    const nativeCaptureId = `native-${++captureSequence}`;
    messageCaptures.set(nativeCaptureId, null);
    const seed = {
        create: false,
        rollMode: false,
        data: {
            whisper: [...(parent.whisper ?? [])],
            blind: parent.blind ?? false,
            system: { origin: parent.id, targets: foundry.utils.deepClone(parent.system?.targets ?? []) },
            flags: { [MODULE_SHORT]: { workflowVersion: 2, parentId: parent.id, quickRoll: true, processed: true, nativeCaptureId } }
        }
    };
    seeds.push(seed);
    return seed;
}

function resolveAmmunition(actor, id, snapshot) {
    if (!id) return undefined;
    const live = actor?.items?.get?.(id);
    if (live) return live;
    if (snapshot?._id === id && globalThis.Item?.implementation) return new Item.implementation(snapshot, { parent: actor });
    return undefined;
}

function damageConfig(parent, attack, snapshot) {
    if (!attack) return {};
    const options = attack.options ?? {};
    const config = { isCritical: attack.isCritical === true };
    if (options.ability) config.ability = options.ability;
    if (options.attackMode) config.attackMode = options.attackMode;
    const ammunition = resolveAmmunition(parent.getAssociatedActor?.(), options.ammunition, snapshot);
    if (ammunition) config.ammunition = ammunition;
    return config;
}

function extractRolls(result) {
    return ActivityUtility._extractRolls(result);
}

async function setState(parent, workflowState, extra = {}) {
    await parent.update({ [`flags.${MODULE_SHORT}.workflowState`]: workflowState, ...extra });
}

/** Create every prepared native message in one batch so Dice So Nice animates them together. */
async function createBatch(prepared) {
    // Takes the prepared data out of the list, so the error path can never create
    // a batch that was already created (e.g. when only the later state update failed).
    const datas = prepared.splice(0);
    if (!datas.length) return [];
    // Explicit null, not delete: Foundry's ChatMessage#_preCreate restores the dice
    // sound on any roll message whose data has no `sound` key at all.
    datas.forEach((data, index) => { if (index > 0) data.sound = null; });
    return ChatMessage.implementation.createDocuments(datas);
}

/** Called only after native usage finalization, never while rendering a document. */
export function runNativeUsage(activity, usageConfig, results) {
    const parent = results?.message;
    const flags = parent?.flags?.[MODULE_SHORT];
    if (!parent?.id || game.messages.get(parent.id) !== parent || !parent.isAuthor
        || flags?.workflowVersion !== 2 || !flags.quickRoll) return Promise.resolve();
    if (pending.has(parent.id)) return pending.get(parent.id);
    if (flags.workflowState) return Promise.resolve(); // Never replay partially consumed work after reload.

    const execution = Promise.resolve().then(async () => {
        await setState(parent, 'running');
        // Prepared-but-uncreated message data. Anything here has already consumed its
        // resources, so it is created even when a later step fails.
        const prepared = [];
        const seeds = [];
        try {
            const resolved = getUsageActivity(parent, activity);
            let attack = null;
            let snapshot;
            if (resolved.type === 'attack') {
                const ammunition = ActivityUtility._resolveQuickRollAmmunition(resolved, parent);
                const targets = parent.system?.targets;
                const config = {
                    ...(targets?.length === 1 ? { target: targets[0].ac } : {}),
                    ...(flags.advantage ? { advantage: true } : {}),
                    ...(flags.disadvantage ? { disadvantage: true } : {}),
                    ...(ammunition !== undefined ? { ammunition } : {}),
                    ...(flags.attackMode ? { attackMode: flags.attackMode } : {})
                };
                const attackMessage = messageConfig(parent, seeds);
                const attacks = extractRolls(await resolved.rollAttack(config, { configure: false }, attackMessage));
                snapshot = takeAmmunitionSnapshot(resolved);
                if (!attacks.length) {
                    releaseCapture(attackMessage);
                    await setState(parent, 'cancelled');
                    return;
                }
                attack = attacks[0];
                const attackData = takePreparedData(attackMessage);
                if (snapshot) {
                    attackData.system ??= {};
                    const deltas = attackData.system.deltas ?? {};
                    attackData.system.deltas = { ...deltas, deleted: [...(deltas.deleted ?? []), snapshot] };
                }
                prepared.push(attackData);
            }

            const manual = SettingsUtility.getSettingValue(SETTING_NAMES.MANUAL_DAMAGE_MODE);
            const deferDamage = resolved.type !== 'heal' && (manual === 2 || (manual === 1 && resolved.type === 'attack'));
            const config = damageConfig(parent, attack, snapshot);
            if (!deferDamage && resolved.rollDamage && resolved.getDamageConfig?.(config).rolls?.length) {
                const damageMessage = messageConfig(parent, seeds);
                const damage = extractRolls(await resolved.rollDamage(config, { configure: false }, damageMessage));
                if (!damage.length) {
                    releaseCapture(damageMessage);
                    const created = prepared.length;
                    await createBatch(prepared);
                    await setState(parent, created ? 'partial' : 'cancelled');
                    return;
                }
                prepared.push(takePreparedData(damageMessage));
            }

            if (resolved.type === 'utility' && resolved.rollFormula && resolved.roll?.formula) {
                const formulaMessage = messageConfig(parent, seeds);
                const formula = extractRolls(await resolved.rollFormula({}, { configure: false }, formulaMessage));
                if (!formula.length) {
                    releaseCapture(formulaMessage);
                    const created = prepared.length;
                    await createBatch(prepared);
                    await setState(parent, created ? 'partial' : 'cancelled');
                    return;
                }
                prepared.push(takePreparedData(formulaMessage));
            }

            await createBatch(prepared);
            await setState(parent, 'complete', { [`flags.${MODULE_SHORT}.processed`]: true });
        } catch (error) {
            const created = await createBatch(prepared).catch(() => []);
            await setState(parent, created.length || getNativeRollSources(parent).length ? 'partial' : 'failed');
            throw error;
        } finally {
            // A roll that threw never reached takePreparedData; drop its token.
            seeds.forEach(releaseCapture);
        }
    }).finally(() => pending.delete(parent.id));
    pending.set(parent.id, execution);
    return execution;
}
