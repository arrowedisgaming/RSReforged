import { MODULE_SHORT } from '../module/const.js';
import { SETTING_NAMES, SettingsUtility } from './settings.js';

/**
 * dnd5e 6: a quick roll's attack and damage are separate native messages, and Dice So
 * Nice animates each message on its own unless its world "Simultaneous Rolls" setting
 * happens to merge them. Each client therefore claims a workflow batch's messages and
 * throws all their rolls as one pooled roll through Dice So Nice's public `showForRoll`.
 * Visibility stays Dice So Nice's per-client decision: only messages it would have
 * animated are claimed, and ghost/secret dice still follow the message.
 */
const batches = new Map();

/**
 * Always Roll Multiple Dice on dnd5e 6. 4.x turned the roll itself into an unkept 2d20,
 * which dnd5e 6 would sum for hit, success, and critical checks. Instead the extra d20 is
 * stored beside the real roll: the card shows it as a second total, it joins the dice
 * throw, and retroactive advantage adopts it.
 *
 * `dnd5e.postRollConfiguration` hands over the configured rolls just before dnd5e
 * evaluates them and builds the message. Foundry 14 cannot roll dice synchronously, so
 * each quick-rolled d20 gets a one-shot evaluate that rolls its extra die right after its
 * own, through Foundry's normal fulfillment; the message then carries both from creation.
 */
export function prepareAlternates(rolls, message) {
    if (!SettingsUtility.getSettingValue(SETTING_NAMES.ALWAYS_ROLL_MULTIROLL)) return;
    if (!message?.data?.flags?.[MODULE_SHORT]?.quickRoll) return;
    for (const roll of rolls ?? []) {
        if (!(roll instanceof CONFIG.Dice.D20Roll) || roll._evaluated || Object.hasOwn(roll, 'evaluate')) continue;
        const evaluate = roll.evaluate;
        roll.evaluate = async function (options) {
            delete this.evaluate;
            const result = await evaluate.call(this, options);
            await seedAlternate(this, options);
            return result;
        };
    }
}

async function seedAlternate(roll, options = {}) {
    const die = roll.dice?.find(d => d.faces === 20);
    if (!die || die.number !== 1 || roll.hasAdvantage || roll.hasDisadvantage) return;
    try {
        const count = roll.options.elvenAccuracy ? 2 : 1;
        const extra = await new Roll(`${count}d20${die.modifiers.join('')}`).evaluate({ allowInteractive: options.allowInteractive });
        roll.options.rsreforgedAlternates = extra.dice[0].results;
    } catch (error) {
        console.warn('RSReforged | could not roll the extra d20', error);
    }
}

/** A roll of a message's stored extra d20s, so they are thrown with the real dice. */
function alternateRolls(message) {
    return (message.rolls ?? []).flatMap(roll => {
        const results = roll.options?.rsreforgedAlternates;
        if (!results?.length) return [];
        const die = new foundry.dice.terms.Die({ number: results.length, faces: 20, results: foundry.utils.deepClone(results) });
        die._evaluated = true;
        const alternate = Roll.fromTerms([die]);
        alternate._evaluated = true;
        return [alternate];
    });
}

/** `diceSoNiceMessagePreProcess` listener, called synchronously from Dice So Nice's createChatMessage hook. */
export function claimNativeThrow(messageId, interception) {
    if (!interception?.willTrigger3DRoll) return;
    const message = game.messages.get(messageId);
    const flags = message?.flags?.[MODULE_SHORT];
    if (!message?.rolls?.length) return;
    const workflow = flags?.workflowVersion === 2 && flags.parentId;
    const alternates = alternateRolls(message);
    // Workflow children throw together; a lone check or save only when it has extras.
    if (!workflow && !alternates.length) return;
    if (typeof game.dice3d?.showForRoll !== 'function') return;
    // Visibility "none" or disabled during combat: Dice So Nice throws nothing and keeps
    // the core dice sound, so leave the message to it.
    if (game.dice3d.isEnabled?.() === false) return;
    interception.willTrigger3DRoll = false;

    const key = workflow ? flags.parentId : message.id;
    let batch = batches.get(key);
    if (!batch) {
        let landed;
        batch = { messages: [], rolls: [], landed: new Promise(resolve => { landed = resolve; }) };
        batch.resolve = landed;
        batches.set(key, batch);
        // The batch's other messages fire their create hooks in the same task.
        setTimeout(() => throwBatch(key), 0);
    }
    // The combined card waits on this until the dice land.
    message._rsrNativeThrow = batch.landed;
    // Dice So Nice replaces the core dice sound on messages it animates.
    if (message.sound === CONFIG.sounds?.dice) delete message.sound;
    batch.messages.push(message);
    batch.rolls.push(...message.rolls, ...alternates);
}

async function throwBatch(key) {
    const batch = batches.get(key);
    batches.delete(key);
    if (!batch) return;
    const [first] = batch.messages;
    try {
        const { PoolTerm } = foundry.dice.terms;
        const roll = CONFIG.Dice.rolls[0].fromTerms([PoolTerm.fromRolls(batch.rolls)]);
        await game.dice3d.showForRoll(roll, first.author ?? game.user, false, null, false, first.id, first.speaker);
    } catch (error) {
        console.error('RSReforged | Dice So Nice throw failed', error);
    } finally {
        for (const message of batch.messages) delete message._rsrNativeThrow;
        batch.resolve();
    }
}
