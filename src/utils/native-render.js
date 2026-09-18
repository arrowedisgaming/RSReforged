import { MODULE_SHORT } from '../module/const.js';
import { getOriginId } from './dnd5e-compat.js';
import { getNativeRollSources } from './native-workflow.js';

const combinedTypes = new Set(['attack', 'damage', 'healing', 'generic']);
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

function animating(sources) {
    return !!game.dice3d?.isEnabled?.() && sources.some(source => source._dice3danimating);
}

/**
 * Runs after dnd5e finishes all native rendering. Folds the usage card's native
 * children into it by moving their live rendered nodes; their markup is dnd5e's own.
 */
export async function renderNativeMessage(message, suppliedHtml) {
    const html = suppliedHtml instanceof HTMLElement ? suppliedHtml : suppliedHtml?.[0];
    if (!html) return;
    html.classList.remove('rsr-native-combined-original');
    if (message.type !== 'usage') {
        scheduleReconcile();
        return;
    }
    if (message.flags?.[MODULE_SHORT]?.workflowVersion !== 2 || !message.isContentVisible) return;
    const content = html.querySelector('.message-content');
    if (!content) return;

    const token = {};
    renders.set(html, token);
    content.querySelector(':scope > .rsr-native-combined')?.remove();
    const sources = getNativeRollSources(message).filter(child =>
        combinedTypes.has(child.type) && child.visible !== false && child.isContentVisible);
    if (!sources.length) {
        scheduleReconcile();
        return;
    }

    const combined = document.createElement('div');
    combined.className = 'rsr-native-combined';
    // Results appear when the dice land, as they do on a plain native card.
    combined.hidden = animating(sources);
    content.append(combined);

    for (const child of sources) {
        const rendered = await child.renderHTML();
        if (renders.get(html) !== token) return;
        const node = rendered instanceof HTMLElement ? rendered : rendered[0];
        // Retain the native root with its components and listeners. The nearest
        // data-message-id must always identify the real child document.
        node.dataset.messageId = child.id;
        node.dataset.rsrMessageId = child.id;
        node.classList.add('rsr-native-source');
        combined.append(node);
    }
    activateTargets(combined);
    scheduleReconcile();

    if (combined.hidden) {
        // Bounded: Dice So Nice resolves this wait only from its roll-complete hook, and
        // its own safety timeout never fires that hook. A backgrounded tab or an
        // animation error must not leave the results hidden.
        const landed = Promise.all(sources
            .filter(source => source._dice3danimating)
            .map(source => game.dice3d.waitFor3DAnimationByMessageID(source.id)));
        let timer;
        const giveUp = new Promise(resolve => { timer = setTimeout(resolve, DICE_REVEAL_TIMEOUT_MS); });
        await Promise.race([landed, giveUp]).catch(() => {});
        clearTimeout(timer);
        if (renders.get(html) === token) combined.hidden = false;
    }
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
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reconcileNativeSources);
    else setTimeout(reconcileNativeSources, 0);
}
