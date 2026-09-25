import { MODULE_SHORT } from '../module/const.js';

/**
 * dnd5e 6: a quick roll's attack and damage are separate native messages, and Dice So
 * Nice animates each message on its own unless its world "Simultaneous Rolls" setting
 * happens to merge them. Each client therefore claims a workflow batch's messages and
 * throws all their rolls as one pooled roll through Dice So Nice's public `showForRoll`.
 * Visibility stays Dice So Nice's per-client decision: only messages it would have
 * animated are claimed, and ghost/secret dice still follow the message.
 */
const batches = new Map();

/** `diceSoNiceMessagePreProcess` listener, called synchronously from Dice So Nice's createChatMessage hook. */
export function claimNativeThrow(messageId, interception) {
    if (!interception?.willTrigger3DRoll) return;
    const message = game.messages.get(messageId);
    const flags = message?.flags?.[MODULE_SHORT];
    if (flags?.workflowVersion !== 2 || !flags.parentId || !message.rolls?.length) return;
    if (typeof game.dice3d?.showForRoll !== 'function') return;
    interception.willTrigger3DRoll = false;

    let batch = batches.get(flags.parentId);
    if (!batch) {
        let landed;
        batch = { messages: [], rolls: [], landed: new Promise(resolve => { landed = resolve; }) };
        batch.resolve = landed;
        batches.set(flags.parentId, batch);
        // The batch's other messages fire their create hooks in the same task.
        setTimeout(() => throwBatch(flags.parentId), 0);
    }
    // The combined card waits on this until the dice land.
    message._rsrNativeThrow = batch.landed;
    // Dice So Nice replaces the core dice sound on messages it animates.
    if (message.sound === CONFIG.sounds?.dice) delete message.sound;
    batch.messages.push(message);
    batch.rolls.push(...message.rolls);
}

async function throwBatch(parentId) {
    const batch = batches.get(parentId);
    batches.delete(parentId);
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
