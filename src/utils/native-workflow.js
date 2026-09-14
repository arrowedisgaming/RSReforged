import { MODULE_SHORT } from '../module/const.js';
import { ActivityUtility } from './activity.js';
import { SettingsUtility, SETTING_NAMES } from './settings.js';
import { CoreUtility } from './core.js';

const pending = new Map();
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

function messageConfig(parent, source = parent) {
    return { create: true, rollMode: false, data: { whisper: [...(parent.whisper ?? [])], blind: parent.blind ?? false, system: { origin: parent.id, targets: foundry.utils.deepClone(source.system?.targets ?? parent.system?.targets ?? []) }, flags: {
        [MODULE_SHORT]: { workflowVersion: 2, parentId: parent.id, quickRoll: true, processed: true }
    } } };
}

export function getNativeDamageConfig(parent, attack) {
    const options = attack?.options ?? {};
    const child = attack?.parent ?? getNativeRollSources(parent).filter(m => m.type === 'attack').at(-1);
    const config = { ability: options.ability ?? child?.system?.ability, isCritical: attack?.isCritical ?? child?.rolls?.[0]?.isCritical ?? false };
    const ammunition = child?.system?.ammunitionItem;
    if (ammunition) config.ammunition = ammunition;
    const mode = options.attackMode ?? child?.system?.mode ?? parent.flags?.[MODULE_SHORT]?.attackMode;
    if (mode) config.attackMode = mode;
    return config;
}

export async function runNativeDamage(parent, activity, attack) {
    activity ??= getUsageActivity(parent);
    if (!activity?.rollDamage || (!parent.isAuthor && !game.user.isGM && !parent.getAssociatedActor?.()?.isOwner)) return [];
    const config = getNativeDamageConfig(parent, attack);
    if (activity.getDamageConfig && !activity.getDamageConfig(config).rolls?.length) return [];
    const source = getNativeRollSources(parent).filter(message => message.type === 'attack').at(-1) ?? parent;
    return extractRolls(await activity.rollDamage(config, { configure: false }, messageConfig(parent, source)));
}

function extractRolls(result) {
    return ActivityUtility._extractRolls(result);
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
        await parent.update({ [`flags.${MODULE_SHORT}.workflowState`]: 'running' });
        let produced = false;
        try {
            const resolved = getUsageActivity(parent, activity);
            let attacks = [];
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
                attacks = extractRolls(await resolved.rollAttack(config, { configure: false }, messageConfig(parent)));
                if (!attacks.length) {
                    await parent.update({ [`flags.${MODULE_SHORT}.workflowState`]: 'cancelled' });
                    return;
                }
            }
            produced = attacks.length > 0;
            const manual = SettingsUtility.getSettingValue(SETTING_NAMES.MANUAL_DAMAGE_MODE);
            const deferDamage = resolved.type !== 'heal' && (manual === 2 || (manual === 1 && resolved.type === 'attack'));
            if (!deferDamage && resolved.rollDamage && resolved.getDamageConfig?.(getNativeDamageConfig(parent, attacks[0])).rolls?.length) {
                const damage = await runNativeDamage(parent, resolved, attacks[0]);
                if (!damage.length) {
                    await parent.update({ [`flags.${MODULE_SHORT}.workflowState`]: produced ? 'partial' : 'cancelled' });
                    return;
                }
                produced = true;
            }
            if (resolved.type === 'utility' && resolved.rollFormula && resolved.roll?.formula) {
                const formula = extractRolls(await resolved.rollFormula({}, { configure: false }, messageConfig(parent)));
                if (!formula.length) {
                    await parent.update({ [`flags.${MODULE_SHORT}.workflowState`]: produced ? 'partial' : 'cancelled' });
                    return;
                }
                produced = true;
            }
            await parent.update({ [`flags.${MODULE_SHORT}.workflowState`]: 'complete', [`flags.${MODULE_SHORT}.processed`]: true });
        } catch (error) {
            await parent.update({ [`flags.${MODULE_SHORT}.workflowState`]: produced || getNativeRollSources(parent).length ? 'partial' : 'failed' });
            throw error;
        }
    }).finally(() => pending.delete(parent.id));
    pending.set(parent.id, execution);
    return execution;
}

export async function updateNativeRolls(message, rolls) {
    if (!message || (!message.isAuthor && !game.user.isGM)) return;
    await message.update({ rolls: CoreUtility.serializeRolls(rolls) });
}

const preparingAlternates = new Set();
/** Optional extra d20s are prepared once at document creation, never at render. */
export async function seedNativeAlternates(message) {
    if (!message.isAuthor || !message.flags?.[MODULE_SHORT]?.quickRoll
        || !SettingsUtility.getSettingValue(SETTING_NAMES.ALWAYS_ROLL_MULTIROLL)
        || preparingAlternates.has(message.id)) return;
    const roll = message.rolls?.[0];
    const die = roll?.dice?.find(d => d.faces === 20);
    if (!(roll instanceof CONFIG.Dice.D20Roll) || !die || die.number !== 1 || roll.hasAdvantage || roll.hasDisadvantage || roll.options.rsreforgedAlternates) return;
    preparingAlternates.add(message.id);
    try {
        const count = roll.options.elvenAccuracy ? 2 : 1;
        const extra = await new Roll(`${count}d20${die.modifiers.join('')}`).evaluate();
        const rolls = message.rolls.map(r => Roll.fromData(foundry.utils.deepClone(r.toJSON())));
        rolls[0].options.rsreforgedAlternates = extra.dice[0].results;
        await updateNativeRolls(message, rolls);
    } finally { preparingAlternates.delete(message.id); }
}
