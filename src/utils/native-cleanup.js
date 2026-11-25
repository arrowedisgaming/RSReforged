import { MODULE_SHORT } from '../module/const.js';
import { getOriginId } from './dnd5e-compat.js';
import { LogUtility } from './log.js';

/**
 * dnd5e 6: deleting an RSR usage card deletes the rolls folded into it (issue #48), and
 * revealing or concealing one does the same to them (issue #51).
 *
 * The only evidence used is stored on the roll itself, by its own author when it is
 * created: `flags.rsreforged.parentId`, or for an older roll made with a card's Damage
 * button, the native origin that names the card. Nothing a client merely remembers, and
 * nothing another user can write, decides what is hidden or deleted.
 *
 * Only rolls created by this version carry `flags.rsreforged.deleteWithParent`. Only those
 * are hidden, or deleted by a GM later, once their card is gone without them. Before this
 * version, deleting a card restored its rolls on purpose, so older rolls whose card is
 * already gone are never touched, and nothing writes to existing messages.
 */

/** Native roll types RSR folds into its usage card. */
export const FOLDED_TYPES = new Set(['attack', 'damage', 'healing', 'generic']);

export function isRsrUsageCard(message) {
    const flags = message?.flags?.[MODULE_SHORT];
    return message?.type === 'usage' && flags?.workflowVersion === 2 && !!flags.quickRoll;
}

/**
 * The RSR usage card a roll was folded into, or null. A native origin that names another
 * card means the roll belongs elsewhere, so it is never claimed.
 */
export function getRsrParentId(message) {
    if (!FOLDED_TYPES.has(message?.type)) return null;
    const parentId = message.flags?.[MODULE_SHORT]?.parentId;
    if (typeof parentId !== 'string' || !parentId) return null;
    const origin = getOriginId(message);
    return origin && origin !== parentId ? null : parentId;
}

/**
 * A roll RSR folds into a card: linked to one, or, made with a card's Damage button before
 * rolls were linked, naming a live RSR card as its native origin.
 */
export function isFoldedRoll(message) {
    if (getRsrParentId(message)) return true;
    if (!FOLDED_TYPES.has(message?.type) || message.flags?.[MODULE_SHORT]?.parentId) return false;
    const origin = getOriginId(message);
    return !!origin && isRsrUsageCard(game.messages.get(origin));
}

/** A folded roll created by this version whose usage card is gone: hidden until it is deleted. */
export function isOrphanedRoll(message) {
    const parentId = getRsrParentId(message);
    return !!parentId && message.flags[MODULE_SHORT].deleteWithParent === true && !game.messages.has(parentId);
}

/**
 * On the creating client: link a roll made from an RSR card to it, e.g. one rolled with
 * the card's own Damage button, which carries no RSR flags. Quick rolls are linked already.
 */
export function stampRsrParent(message) {
    if (!FOLDED_TYPES.has(message?.type) || message.flags?.[MODULE_SHORT]?.parentId) return;
    const origin = getOriginId(message);
    if (!origin || !isRsrUsageCard(game.messages.get(origin))) return;
    message.updateSource({
        [`flags.${MODULE_SHORT}.parentId`]: origin,
        [`flags.${MODULE_SHORT}.deleteWithParent`]: true
    });
}

/**
 * Whether a roll belongs to a deleted RSR card: linked to it, or, made with its Damage button
 * before rolls were linked, naming it as its native origin.
 */
function belongsTo(message, parentId) {
    if (getRsrParentId(message) === parentId) return true;
    return FOLDED_TYPES.has(message.type) && !message.flags?.[MODULE_SHORT]?.parentId && getOriginId(message) === parentId;
}

/**
 * Foundry fires this after the whole deletion batch has left the collection, so rolls
 * deleted in the same batch, including a cleared log, are already gone and skipped.
 * The deleting user removes the rolls it may delete. The active GM removes only those it
 * could not, so the two never request the same deletion. Whatever is left (the deleting
 * client disconnected, or no GM was online) stays hidden until a GM's next ready.
 */
export async function cascadeUsageDeletion(parent, userId) {
    if (!isRsrUsageCard(parent)) return;
    const initiator = userId === game.user.id;
    const gm = isActiveGM();
    if (!initiator && !gm) return;
    const deletingUser = initiator ? game.user : game.users?.get?.(userId);
    const ids = allMessages()
        .filter(message => belongsTo(message, parent.id))
        .filter(message => {
            const allowed = !!deletingUser && canModify(message, deletingUser, 'delete');
            return initiator ? allowed : !allowed;
        })
        .map(message => message.id);
    await deleteMessages(ids);
}

/**
 * Revealing or concealing an RSR usage card does the same to the rolls folded into it
 * (issue #51). Foundry changes only the message that was right-clicked, and the rolls' own
 * rows are hidden, so the card is the only one a user can reach: without this, a revealed
 * card showed players no results, and a concealed card left its rolls public.
 * Split like the deletion cascade: the user who changed the card updates the rolls it may,
 * and the active GM the rest. Rolls that already have the card's audience are not written.
 */
export async function cascadeUsageAudience(parent, changes, userId) {
    if (!isRsrUsageCard(parent) || !('whisper' in changes || 'blind' in changes)) return;
    const initiator = userId === game.user.id;
    if (!initiator && !isActiveGM()) return;
    const updatingUser = initiator ? game.user : game.users?.get?.(userId);
    const whisper = [...(parent.whisper ?? [])];
    const blind = parent.blind ?? false;
    const updates = allMessages()
        .filter(message => belongsTo(message, parent.id) && !hasAudience(message, whisper, blind))
        .filter(message => {
            const allowed = !!updatingUser && canModify(message, updatingUser, 'update');
            return initiator ? allowed : !allowed;
        })
        .map(message => ({ _id: message.id, whisper: [...whisper], blind }));
    if (updates.length) await ChatMessage.implementation.updateDocuments(updates);
}

function hasAudience(message, whisper, blind) {
    const current = message.whisper ?? [];
    return (message.blind ?? false) === blind
        && current.length === whisper.length && whisper.every(id => current.includes(id));
}

/** Active GM only, at ready: delete the rolls whose card was deleted without them. */
export async function deleteOrphanedRolls() {
    if (!isActiveGM()) return;
    await deleteMessages(allMessages().filter(isOrphanedRoll).map(message => message.id));
}

function isActiveGM() {
    return !!game.user?.isGM && game.users?.activeGM?.isSelf === true;
}

function canModify(message, user, action) {
    if (user.isGM) return true;
    return typeof message.canUserModify === 'function' ? message.canUserModify(user, action) : false;
}

function allMessages() {
    return [...(game.messages?.values?.() ?? [])];
}

/**
 * Another session of the same user can delete the same rolls at the same time. Retry once
 * with whatever is still there rather than fail the rest of the batch.
 */
async function deleteMessages(ids) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const live = ids.filter(id => game.messages.has(id));
        if (!live.length) return;
        try {
            await ChatMessage.implementation.deleteDocuments(live);
            return;
        } catch (error) {
            if (attempt) LogUtility.logWarning(`Could not delete the rolls of a deleted card: ${error.message}`);
        }
    }
}
