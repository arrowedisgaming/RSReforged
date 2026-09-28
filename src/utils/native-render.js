import { MODULE_SHORT } from '../module/const.js';
import { BonusManager } from './bonus.js';
import { getOriginId, getRollType } from './dnd5e-compat.js';
import { getNativeRollSources } from './native-workflow.js';
import { renderRsrCheck, renderRsrSection } from './native-card.js';
import { HIDE_NPC_ROLL_STYLES, SETTING_NAMES, SettingsUtility } from './settings.js';

const combinedTypes = new Set(['attack', 'damage', 'healing', 'generic']);
const sectionOrder = { attack: 0, damage: 1, healing: 1, generic: 2 };
const refreshing = new Set();
const renders = new WeakMap();
/** Longest a folded card waits for Dice So Nice before revealing its results anyway. */
const DICE_REVEAL_TIMEOUT_MS = 10000;

/** UI-only refresh: never update a document from its render/update hook. */
export function refreshNativeOrigin(message) {
    const id = getOriginId(message);
    if (!id || refreshing.has(id)) return;
    const parent = game.messages.get(id);
    if (!parent?.flags?.[MODULE_SHORT]?.workflowVersion) return;
    refreshing.add(id);
    queueMicrotask(() => {
        refreshing.delete(id);
        ui.chat?.updateMessage?.(parent);
    });
}

function activateTargets(html) {
    // ChatLog observes direct message insertion only; late native components need
    // their own visibility observer to load target data after a combined render.
    const targets = [...html.querySelectorAll('recorded-targets, damage-application')];
    if (!targets.length || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) entry.target.visible = entry.isIntersecting;
        if (!html.isConnected) observer.disconnect();
    });
    targets.forEach(target => observer.observe(target));
}

// The usage-card buttons whose roll an RSR section already shows, as on the 5.3 card.
const representedActions = {
    attack: ['rollAttack'],
    damage: ['rollDamage'],
    healing: ['rollDamage', 'rollHealing'],
    generic: ['rollFormula']
};

function hideRepresentedButtons(content, sources) {
    const actions = new Set(sources.flatMap(source => representedActions[source.type] ?? []));
    for (const button of content.querySelectorAll(':scope > .chat-card button[data-action]')) {
        if (actions.has(button.dataset.action)) (button.closest('li') ?? button).classList.add('rsr-native-hidden');
    }
    // Drop a button row left with nothing to show.
    for (const row of content.querySelectorAll(':scope > .chat-card .icon-row')) {
        const entries = row.querySelectorAll('li');
        if (entries.length && [...entries].every(entry => entry.classList.contains('rsr-native-hidden'))) {
            row.classList.add('rsr-native-hidden');
        }
    }
}

/**
 * What each source's dice are still doing: RSR's pooled throw (native-dice.js) for
 * workflow rolls, or Dice So Nice's own animation for rolls it animated itself, such
 * as dnd5e's Damage button in manual damage mode.
 */
function pendingThrows(sources) {
    if (!game.dice3d?.isEnabled?.() || game.settings.get('dice-so-nice', 'immediatelyDisplayChatMessages')) return [];
    return sources.map(source => source._rsrNativeThrow
        ?? (source._dice3danimating ? game.dice3d.waitFor3DAnimationByMessageID(source.id) : null))
        .filter(Boolean);
}

/**
 * Runs after dnd5e finishes all native rendering. Renders RSR's sections for the usage
 * card's native children into it; the children's own cards are hidden while represented.
 */
export async function renderNativeMessage(message, suppliedHtml) {
    const html = suppliedHtml instanceof HTMLElement ? suppliedHtml : suppliedHtml?.[0];
    if (!html) return;
    html.classList.remove('rsr-native-combined-original');
    if (message.type !== 'usage') {
        if (checkTypes.has(message.type)) await renderNativeCheck(message, html);
        scheduleReconcile();
        return;
    }
    if (message.flags?.[MODULE_SHORT]?.workflowVersion !== 2 || !message.isContentVisible) return;
    // Scopes RSR's layout adjustments to the cards it manages.
    html.classList.add('rsr-native-card');
    const content = html.querySelector('.message-content');
    if (!content) return;

    const token = {};
    renders.set(html, token);
    content.querySelector(':scope > .rsr-native-combined')?.remove();
    // dnd5e's registry returns children in no guaranteed order; the card reads top-down.
    maskHiddenSummaries(content);
    const sources = getNativeRollSources(message).filter(child =>
        combinedTypes.has(child.type) && child.visible !== false && child.isContentVisible)
        .sort((a, b) => (sectionOrder[a.type] - sectionOrder[b.type]) || (a.timestamp - b.timestamp));
    if (!sources.length) {
        scheduleReconcile();
        return;
    }

    const combined = document.createElement('div');
    combined.className = 'rsr-native-combined';
    // Results appear when the dice land, as they do on a plain native card.
    const throws = pendingThrows(sources);
    combined.hidden = throws.length > 0;
    // RSR's sections sit where 5.3 put them: under the item card, above summaries.
    const face = content.querySelector(':scope > .chat-card');
    if (face) face.after(combined);
    else content.append(combined);

    for (const child of sources) {
        const section = await renderRsrSection(message, child);
        if (renders.get(html) !== token) return;
        if (!section) continue;
        // The section's data-message-id identifies the real child document, so
        // native components and RSR controls inside it resolve that message.
        section.classList.add('rsr-native-source');
        combined.append(section);
    }
    // The legacy 5.3 breakdown toggles on click, as dnd5e's own roll cards did.
    combined.addEventListener('click', toggleBreakdown);
    hideRepresentedButtons(content, sources);
    activateTargets(combined);
    scheduleReconcile();

    if (combined.hidden) {
        // Bounded: a backgrounded tab can hold a throw indefinitely, and Dice So Nice's
        // own safety timeout never fires its roll-complete hook. Neither may leave the
        // results hidden.
        const landed = Promise.all(throws);
        let timer;
        const giveUp = new Promise(resolve => { timer = setTimeout(resolve, DICE_REVEAL_TIMEOUT_MS); });
        await Promise.race([landed, giveUp]).catch(() => {});
        clearTimeout(timer);
        if (renders.get(html) === token) combined.hidden = false;
    }
}

const checkTypes = new Set(['check', 'save']);

/**
 * The 4.x check/save card: RSR's total and breakdown replace dnd5e's compact roll row,
 * on checks and saves RSR rolled (or every one, in vanilla-with-styling mode). dnd5e's
 * header, save outcome, supplements, buttons, and HP deltas stay as they are.
 */
async function renderNativeCheck(message, html) {
    const styled = message.flags?.[MODULE_SHORT]?.quickRoll
        || SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_VANILLA_ENABLED);
    // A private roll's content is dnd5e's to withhold; leave its placeholder alone.
    if (!styled || !message.isContentVisible) return;
    const content = html.querySelector('.message-content');
    const rows = [...(content?.querySelectorAll(':scope > .icon-row') ?? [])].filter(row => row.querySelector('.dice-roll'));
    if (!rows.length) return;

    const section = await renderRsrCheck(message);
    // dnd5e fires this before ChatLog inserts the card, so ask whether the row is still
    // part of this render, not whether it is in the document.
    if (!section || !html.contains(rows[0])) return;
    rows[0].before(section);
    rows.forEach(row => row.remove());
    html.classList.add('rsr-native-card');
    section.addEventListener('click', toggleBreakdown);

    if (game.user.isGM || message.isAuthor) {
        const rollType = getRollType(message);
        BonusManager.injectButton(message, $(html), rollType === 'ability' ? 'check' : rollType, '.message-header');
    }
}

/**
 * dnd5e 6 summarises target saves and checks on the usage card. Hide NPC Roll Results
 * masks those rows as it does the standalone cards: the total (keeping the natural d20)
 * or the d20 and breakdown (keeping the total), and the pass/fail mark either way.
 */
function maskHiddenSummaries(content) {
    for (const summary of content.querySelectorAll(':scope > .card-summary[data-message-id]')) {
        const source = game.messages.get(summary.dataset.messageId);
        if (!source || !checkTypes.has(source.type)) continue;
        if (!SettingsUtility.shouldHideNpcRollForActor(source.getAssociatedActor?.(), getRollType(source))) continue;
        const breakdown = SettingsUtility.getHideNpcRollStyle() === HIDE_NPC_ROLL_STYLES.BREAKDOWN;
        for (const roll of summary.querySelectorAll('.dice-roll')) {
            roll.classList.remove('success', 'failure', 'critical', 'fumble');
            roll.querySelector('.icons')?.replaceChildren();
            if (breakdown) roll.querySelector('.d20die')?.remove();
            else roll.querySelector('.result .total')?.replaceChildren(game.i18n.localize(`${MODULE_SHORT}.chat.hide`));
        }
        summary.querySelectorAll('.roll-breakdown').forEach(node => node.remove());
    }
}

function toggleBreakdown(event) {
    // The retro overlay covers the whole total while hovered; only its own
    // controls are exempt, so clicking the number still opens the breakdown.
    if (event.target.closest('button, a, input, damage-application, .rsr-overlay [data-action]')) return;
    event.target.closest('.dice-roll')?.classList.toggle('expanded');
}

/** Hide originals that a fold-in represents; restore them when it disappears. */
export function reconcileNativeSources() {
    const query = selector => globalThis.foundry?.applications?.detached?.querySelectorAll?.(selector)
        ?? document.querySelectorAll(selector);
    for (const root of query('.message[data-message-id]')) {
        if (root.classList.contains('rsr-native-source')) continue;
        const id = root.dataset.messageId;
        const represented = [...query('.rsr-native-source[data-rsr-message-id]')].some(node =>
            node.dataset.rsrMessageId === id && node.isConnected);
        const wasHidden = root.classList.contains('rsr-native-combined-original');
        root.classList.toggle('rsr-native-combined-original', represented);
        if (represented) {
            // Disconnect the duplicate live custom elements, preserving the root
            // for ChatLog pagination and updates. Re-render if it becomes visible.
            const content = root.querySelector('.message-content');
            if (content?.childNodes.length) content.replaceChildren();
        } else if (wasHidden) {
            const message = game.messages.get(id);
            if (message) ui.chat?.updateMessage?.(message);
        }
    }
}

function scheduleReconcile() {
    // Background tabs pause animation frames; a hidden client must still hide originals.
    if (typeof requestAnimationFrame === 'function' && document.visibilityState !== 'hidden') requestAnimationFrame(reconcileNativeSources);
    else setTimeout(reconcileNativeSources, 0);
}
