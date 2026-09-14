import { MODULE_SHORT } from '../module/const.js';
import { getOriginId, getRollType } from './dnd5e-compat.js';
import { getNativeRollSources, runNativeDamage, updateNativeRolls, getUsageActivity, getNativeDamageConfig } from './native-workflow.js';
import { RollUtility, ROLL_STATE } from './roll.js';
import { BonusManager } from './bonus.js';
import { setNativeCritical } from './native-critical.js';
import { applyNativeDamage } from './native-damage.js';
import { SettingsUtility, SETTING_NAMES } from './settings.js';

const combinedTypes = new Set(['attack', 'damage', 'healing', 'generic']);
const refreshing = new Set();
const renders = new WeakMap();
const decorations = new WeakMap();

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

function button(label, handler) {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = game.i18n.localize(`rsreforged.native.${label}`);
    node.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        node.disabled = true;
        try { await handler(); }
        catch (error) { ui.notifications.error(error.message); }
        finally { node.disabled = false; }
    });
    return node;
}

function decorateRoll(message, html) {
    if (!decorations.has(html)) decorations.set(html, decorateRollContent(message, html));
    return decorations.get(html);
}

async function decorateRollContent(message, html) {
    if (html.querySelector(':scope > .message-content > .rsr-native-controls')) return;
    const content = html.matches('.card-summary') ? html : html.querySelector('.message-content');
    if (!content || !message.isContentVisible) return;
    if (['damage', 'healing'].includes(message.type)) {
        for (const row of content.querySelectorAll(':scope > .icon-row')) {
            if (row.querySelector('.dice-roll')) row.remove();
        }
        const parts = document.createElement('div');
        parts.className = 'rsr-native-parts';
        for (const [index, roll] of (message.rolls ?? []).entries()) {
            const part = document.createElement('section');
            part.className = 'dice-roll';
            part.dataset.rsrRollIndex = String(index);
            const type = roll.options?.type;
            const label = CONFIG.DND5E.damageTypes?.[type]?.label ?? CONFIG.DND5E.healingTypes?.[type]?.label ?? type ?? '';
            const total = document.createElement('button');
            total.type = 'button';
            total.className = 'rsr-native-total';
            total.textContent = `${game.i18n.localize(label)}: ${roll.total}`;
            const tooltip = document.createElement('div');
            tooltip.innerHTML = await roll.getTooltip();
            tooltip.hidden = true;
            total.addEventListener('click', event => { event.stopPropagation(); tooltip.hidden = !tooltip.hidden; });
            part.append(total, tooltip);
            if (message.isAuthor || game.user.isGM) {
                const select = document.createElement('select');
                select.setAttribute('aria-label', game.i18n.localize('rsreforged.native.Damage type'));
                const types = { ...CONFIG.DND5E.damageTypes, ...CONFIG.DND5E.healingTypes };
                for (const [key, definition] of Object.entries(types)) {
                    const option = document.createElement('option');
                    option.value = key;
                    option.textContent = game.i18n.localize(definition.label ?? key);
                    option.selected = key === type;
                    select.append(option);
                }
                select.addEventListener('change', async event => {
                    event.stopPropagation();
                    const rolls = message.rolls.map(r => Roll.fromData(foundry.utils.deepClone(r.toJSON())));
                    rolls[index].options.type = select.value;
                    delete rolls[index].options.rsreforgedCriticalBase;
                    await updateNativeRolls(message, rolls);
                });
                const edits = document.createElement('div');
                edits.className = 'rsr-native-controls';
                edits.append(button('Add Bonus', () => BonusManager.openBonusDialog(message, 'damage', index)));
                part.append(select, edits);
                if (SettingsUtility.getSettingValue(SETTING_NAMES.OVERLAY_BUTTONS_ENABLED) && message.type === 'damage' && (!roll.options.isCritical || roll.options.rsreforgedCriticalBase)) {
                    const critical = roll.options.isCritical === true;
                    edits.append(button(critical ? 'Normal Damage' : 'Critical', async () => {
                        if (!await confirmChange(SETTING_NAMES.CONFIRM_RETRO_CRIT, 'Critical')) return;
                        const rolls = message.rolls.map(r => Roll.fromData(foundry.utils.deepClone(r.toJSON())));
                        rolls[index] = await setNativeCritical(rolls[index], !critical);
                        await updateNativeRolls(message, rolls);
                    }));
                }
            }
            if (SettingsUtility._useRsrDamageApplyButtons && SettingsUtility.getSettingValue(SETTING_NAMES.DAMAGE_BUTTONS_ENABLED)) {
                part.append(damageButtons(message, index));
            }
            parts.append(part);
        }
        if (SettingsUtility.getSettingValue(SETTING_NAMES.AGGREGATE_DAMAGE) && message.rolls.length) {
            const groups = dnd5e.dice.aggregateDamageRolls(message.rolls);
            const heading = document.createElement('div');
            heading.className = 'rsr-native-group-totals';
            for (const group of groups) {
                const label = CONFIG.DND5E.damageTypes?.[group.options.type]?.label ?? CONFIG.DND5E.healingTypes?.[group.options.type]?.label ?? group.options.type;
                const total = document.createElement('div');
                total.textContent = `${game.i18n.localize(label)}: ${group.total}`;
                heading.append(total);
            }
            if (message.rolls.length > 1 || groups.length > 1) parts.prepend(heading);
        }
        content.prepend(parts);
        if (SettingsUtility._useRsrDamageApplyButtons) {
            content.querySelectorAll('damage-application').forEach(node => node.remove());
            if (SettingsUtility.getSettingValue(SETTING_NAMES.DAMAGE_BUTTONS_ENABLED) && message.rolls.length > 1) parts.append(damageButtons(message));
        }
    }
    const primary = message.rolls?.[0];
    if (primary?.options.rsreforgedAlternates?.length) {
        const alternatives = document.createElement('div');
        alternatives.className = 'rsr-native-alternatives';
        const modifier = primary.total - primary.dice.find(d => d.faces === 20).total;
        for (const result of primary.options.rsreforgedAlternates.filter(r => r.active !== false)) {
            const total = document.createElement('span');
            total.className = 'dice-total';
            total.textContent = String(result.result + modifier);
            alternatives.append(total);
        }
        content.querySelector('.dice-roll')?.parentElement.append(alternatives);
    }
    // Each source's roll index is independent of its position in the combined card.
    content.querySelectorAll('.dice-roll').forEach((node, index) => {
        node.dataset.rsrRollIndex = String(index);
        if (node.nextElementSibling?.classList.contains('roll-breakdown')) node.nextElementSibling.dataset.rsrRollIndex = String(index);
    });
    if (!SettingsUtility.getSettingValue(SETTING_NAMES.D20_ICONS_ENABLED)) content.querySelectorAll('.dice-roll > .d20die').forEach(node => node.remove());
    const hidden = SettingsUtility.shouldHideNpcRollForActor(message.getAssociatedActor?.(), getRollType(message));
    if (hidden) {
        const breakdown = SettingsUtility.getHideNpcRollStyle() === 'breakdown';
        content.querySelectorAll('.dice-tooltip, .dice-formula, .roll-breakdown').forEach(node => node.remove());
        if (!breakdown) content.querySelectorAll('.dice-total, .dice-roll .result .total').forEach(node => { node.textContent = '?'; });
        else content.querySelectorAll('.d20die .roll').forEach(node => { node.textContent = '?'; });
    }
    if (!message.isAuthor && !game.user.isGM) return;
    const controls = document.createElement('div');
    controls.className = 'rsr-native-controls';
    const roll = message.rolls?.[0];
    if (SettingsUtility.getSettingValue(SETTING_NAMES.OVERLAY_BUTTONS_ENABLED) && !roll?.hasAdvantage && !roll?.hasDisadvantage && roll?.dice?.some(die => die.faces === 20) && !['damage', 'healing'].includes(message.type)) {
        for (const [label, state] of [['Advantage', ROLL_STATE.ADV], ['Disadvantage', ROLL_STATE.DIS]]) {
            controls.append(button(label, async () => {
                if (!await confirmChange(SETTING_NAMES.CONFIRM_RETRO_ADV, label)) return;
                const rolls = message.rolls.map(r => Roll.fromData(foundry.utils.deepClone(r.toJSON())));
                await RollUtility.upgradeRoll(rolls[0], state);
                await updateNativeRolls(message, rolls);
            }));
        }
    }
    if (message.rolls?.length && !['damage', 'healing'].includes(message.type)) {
        const category = ['damage', 'healing'].includes(message.type) ? 'damage' : getRollType(message);
        controls.append(button('Add Bonus', () => BonusManager.openBonusDialog(message, category)));
    }
    if (controls.childNodes.length) content.append(controls);
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

/** Runs after dnd5e finishes all native rendering. Moves live nodes, never serialized HTML. */
export async function renderNativeMessage(message, suppliedHtml) {
    const html = suppliedHtml instanceof HTMLElement ? suppliedHtml : suppliedHtml[0];
    if (!html) return;
    html.classList.remove('rsr-native-combined-original');
    if (!message.isContentVisible) return;
    if (message.type !== 'usage') {
        await decorateRoll(message, html);
        scheduleReconcile();
        return;
    }
    for (const summary of html.querySelectorAll('.card-summary[data-message-id]')) {
        const source = game.messages.get(summary.dataset.messageId);
        if (!source?.isContentVisible) continue;
        summary.dataset.rsrMessageId = source.id;
        await decorateRoll(source, summary);
    }
    if (message.flags?.[MODULE_SHORT]?.workflowVersion !== 2) return;
    const token = {};
    renders.set(html, token);
    const content = html.querySelector('.message-content');
    if (!content) return;
    content.querySelector(':scope > .rsr-native-combined')?.remove();
    const combined = document.createElement('div');
    combined.className = 'rsr-native-combined';
    const sources = getNativeRollSources(message).filter(child =>
        combinedTypes.has(child.type) && child.visible !== false && child.isContentVisible);
    for (const child of sources) {
        const rendered = await child.renderHTML();
        if (renders.get(html) !== token) return;
        const node = rendered instanceof HTMLElement ? rendered : rendered[0];
        // Retain the native root as well as its components and listeners. The
        // nearest data-message-id must always identify the real child document.
        node.dataset.messageId = child.id;
        node.dataset.rsrMessageId = child.id;
        node.classList.add('rsr-native-source');
        await decorateRoll(child, node);
        combined.append(node);
    }
    if (message.isAuthor || game.user.isGM || message.getAssociatedActor?.()?.isOwner) {
        const activity = getUsageActivity(message);
        if (activity?.rollDamage && activity.getDamageConfig?.(getNativeDamageConfig(message)).rolls?.length) {
            content.querySelectorAll('[data-action="rollDamage"]').forEach(node => node.remove());
            combined.append(button('Roll Damage', () => runNativeDamage(message, activity)));
        }
    }
    content.append(combined);
    activateTargets(combined);
    scheduleReconcile();
}

/** Restore originals whenever no visible combined representation exists. */
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

function damageButtons(message, rollIndex) {
    const controls = document.createElement('div');
    controls.className = 'rsr-native-controls rsr-native-apply';
    if (!SettingsUtility.getSettingValue(SETTING_NAMES.ALWAYS_SHOW_BUTTONS)) controls.classList.add('rsr-native-on-hover');
    for (const [label, multiplier] of [['Apply', undefined], ['Half', 0.5], ['Quarter', 0.25], ['Double', 2], ['Heal', -1]]) {
        const control = button(label, () => applyNativeDamage(message, { multiplier, rollIndex }));
        control.dataset.action = 'rsr-apply-damage';
        controls.append(control);
    }
    controls.append(button('Temp HP', () => applyNativeDamage(message, { temporary: true, rollIndex })));
    Hooks.callAll(`${MODULE_SHORT}.renderApplyDamageButtons`, message, $(controls), $(controls));
    return controls;
}

async function confirmChange(setting, label) {
    if (!SettingsUtility.getSettingValue(setting)) return true;
    const title = game.i18n.localize(`rsreforged.native.${label}`);
    return foundry.applications.api.DialogV2.confirm({ window: { title }, content: `<p>${title}?</p>` });
}
