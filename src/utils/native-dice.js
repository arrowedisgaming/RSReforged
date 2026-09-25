import { MODULE_SHORT } from '../module/const.js';

/**
 * dnd5e 6: a quick roll's attack and damage are separate native messages, and Dice So
 * Nice animates each message on its own unless its world "Simultaneous Rolls" setting
 * happens to merge them. Each client therefore hands Dice So Nice every roll of a
 * workflow batch on the batch's first message, so they land as one throw regardless.
 * Visibility is still Dice So Nice's own per-client decision: only messages it would
 * have animated are claimed.
 */
const batches = new Map();

/** `diceSoNiceMessagePreProcess` listener, called synchronously from Dice So Nice's createChatMessage hook. */
export function claimNativeThrow(messageId, interception) {
    if (!interception?.willTrigger3DRoll) return;
    const message = game.messages.get(messageId);
    const flags = message?.flags?.[MODULE_SHORT];
    if (flags?.workflowVersion !== 2 || !flags.parentId || !message.rolls?.length) return;
    interception.willTrigger3DRoll = false;

    let batch = batches.get(flags.parentId);
    if (!batch) {
        batch = { primary: message, rolls: [] };
        batches.set(flags.parentId, batch);
        // What Dice So Nice does for a message it animates: the card waits for the
        // dice, and the renderRolls call below settles this count when they land.
        message._dice3danimating = true;
        message._dice3dPendingRenders = (message._dice3dPendingRenders ?? 0) + 1;
        // The batch's other messages fire their create hooks in the same task.
        setTimeout(() => flush(flags.parentId), 0);
    }
    // Dice So Nice replaces the core dice sound on messages it animates.
    if (message.sound === CONFIG.sounds?.dice) delete message.sound;
    batch.rolls.push(...message.rolls);
}

function flush(parentId) {
    const batch = batches.get(parentId);
    batches.delete(parentId);
    if (!batch) return;
    if (game.dice3d?.renderRolls) game.dice3d.renderRolls(batch.primary, batch.rolls);
    else settle(batch.primary);
}

/** Never leave a card waiting on dice that will not be thrown. */
function settle(message) {
    delete message._dice3danimating;
    message._dice3dPendingRenders = 0;
}
