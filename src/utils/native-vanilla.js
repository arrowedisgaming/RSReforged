import { MODULE_SHORT, ROLL_TYPE } from '../module/const.js';
import { BonusManager } from './bonus.js';
import { ChatUtility } from './chat.js';
import { CoreUtility } from './core.js';
import { getRollType } from './dnd5e-compat.js';
import { canEditRolls, damageDieSources, onEditClick, retroAdvantage, retroCritical } from './native-card.js';
import { ROLL_STATE } from './roll.js';
import { HIDE_NPC_ROLL_STYLES, SettingsUtility } from './settings.js';

/**
 * dnd5e 6, Card Style "Vanilla+": the usage card shows dnd5e's own compact roll rows
 * instead of RSReforged's sections.
 *
 * Nothing here draws a roll. dnd5e renders each child message as it always does and its
 * rows (roll button, breakdown popover, target list, damage tray) are moved onto the usage
 * card, so the look follows the system and other modules' render hooks have already run
 * on them. RSReforged only adds a small row of buttons inside each breakdown, which call
 * the same edits as the classic overlays, stamps each die with its source so click-to-
 * reroll and GM fudging work on it, and masks hidden NPC rolls.
 */

/**
 * The roll rows of a native child message, wrapped so components and controls inside
 * resolve the child document (as the classic sections do).
 * @param {ChatMessage} parent The usage card.
 * @param {ChatMessage} child A native attack, damage, healing or formula message.
 * @returns {Promise<HTMLElement|null>}
 */
export async function renderVanillaSection(parent, child) {
    const rendered = await child.renderHTML();
    const content = (rendered instanceof HTMLElement ? rendered : rendered?.[0])?.querySelector('.message-content');
    if (!content) return null;

    const section = document.createElement('div');
    section.className = `rsr-vanilla-section rsr-vanilla-${child.type}`;
    section.dataset.messageId = child.id;
    section.dataset.rsrMessageId = child.id;
    for (const node of [...content.children]) {
        // The usage card already shows the item header and its pills.
        if (node.classList.contains('chat-card')) continue;
        section.append(node);
    }
    if (!section.childElementCount) return null;
    decorateVanillaRolls(child, section);
    return section;
}

/**
 * Add RSReforged's controls to dnd5e's compact roll rows inside `scope`, which shows
 * `message`'s rolls: a folded section, a standalone check or save card, or a save/check
 * summary line on a usage card.
 * @param {ChatMessage} message The message that owns the rolls.
 * @param {HTMLElement} scope The element holding its roll rows.
 * @param {object} [options]
 * @param {boolean} [options.flavor] Write a retroactive mode into the flavor (checks and saves).
 * @param {boolean} [options.mask] Apply Hide NPC Roll Results (false where the caller already did).
 */
export function decorateVanillaRolls(message, scope, { flavor = false, mask = true } = {}) {
    const buttons = [...scope.querySelectorAll('button.dice-roll')];
    if (!buttons.length) return;
    const rollType = getRollType(message);
    const hidden = mask && SettingsUtility.shouldHideNpcRollForActor(ChatUtility.getActorFromMessage(message), rollType);

    buttons.forEach((button, index) => {
        const roll = message.rolls[index];
        const breakdown = button.nextElementSibling?.classList.contains('roll-breakdown') ? button.nextElementSibling : null;
        if (hidden) return maskVanillaRoll(button, breakdown);
        if (!roll) return;
        _showAlternates(button, roll);
        if (breakdown) _addActions(breakdown, message, roll, rollType, flavor);
    });
    if (!hidden) _stampDice(message, scope);
}

/**
 * Click-to-reroll and GM fudging (reroll.js) act only on dice that carry their source:
 * roll, die term and result. The classic sections stamp the dice they render; here the
 * breakdown is dnd5e's, so the source of each die is worked out and then checked against
 * what the breakdown shows. Any difference in count or value leaves that breakdown
 * unstamped, and so inert, rather than risk editing the wrong die.
 */
function _stampDice(message, scope) {
    const parts = [...scope.querySelectorAll('.roll-breakdown .tooltip-part')]
        .map(part => [...part.querySelectorAll('.dice-rolls .roll')])
        .filter(dice => dice.length);
    if (!parts.length) return;

    const damage = message.rolls.filter(r => r instanceof CONFIG.Dice.DamageRoll);
    // dnd5e may list damage per roll or merged per type; take whichever it actually drew.
    const candidates = damage.length
        ? [true, false].map(aggregate => _tryDamageSources(damage, message.rolls, aggregate))
        : [message.rolls.flatMap((roll, rollIndex) => (roll.dice ?? []).map((die, dieIndex) =>
            die.results.map((result, resultIndex) => ({ rollIndex, dieIndex, resultIndex, result: _label(die, result) }))))
            .filter(dice => dice.length)];

    const sources = candidates.find(candidate => candidate && _matches(parts, candidate));
    if (!sources) return;
    parts.forEach((dice, partIndex) => dice.forEach((node, index) => {
        const { rollIndex, dieIndex, resultIndex } = sources[partIndex][index];
        Object.assign(node.dataset, { rsrRoll: rollIndex, rsrDie: dieIndex, rsrResult: resultIndex });
    }));
}

function _tryDamageSources(damage, rolls, aggregate) {
    try {
        return damageDieSources(damage, rolls, aggregate).filter(dice => dice.length);
    } catch (error) {
        return null;
    }
}

function _label(die, result) {
    return String(typeof die.getResultLabel === 'function' ? die.getResultLabel(result) : result.result);
}

function _matches(parts, sources) {
    return parts.length === sources.length && parts.every((dice, partIndex) =>
        dice.length === sources[partIndex].length && dice.every((node, index) => {
            const source = sources[partIndex][index];
            return source.rollIndex >= 0 && source.dieIndex >= 0 && node.textContent.trim() === source.result;
        }));
}

/**
 * Hide NPC Roll Results on a compact roll row: the total (keeping the natural d20) or the
 * d20 and breakdown (keeping the total), and the outcome mark either way.
 */
export function maskVanillaRoll(button, breakdown) {
    button.classList.remove('success', 'failure', 'critical', 'fumble');
    button.querySelector('.icons')?.replaceChildren();
    if (SettingsUtility.getHideNpcRollStyle() === HIDE_NPC_ROLL_STYLES.BREAKDOWN) button.querySelector('.d20die')?.remove();
    else button.querySelector('.result .total')?.replaceChildren(CoreUtility.localize(`${MODULE_SHORT}.chat.hide`));
    button.popoverTargetElement = null;
    breakdown?.remove();
}

/** Always Roll Multiple Dice: the stored extra d20s, faded, beside the one that counts. */
function _showAlternates(button, roll) {
    const alternates = roll.options?.rsreforgedAlternates;
    const die = button.querySelector('.d20die');
    if (!alternates?.length || !die || button.querySelector('.rsr-d20die-alt')) return;
    alternates.forEach((result, index) => {
        const extra = die.cloneNode(true);
        extra.classList.add('rsr-d20die-alt');
        extra.style.setProperty('--rsr-alt-index', index + 1);
        extra.dataset.tooltip = CoreUtility.localize(`${MODULE_SHORT}.chat.ignoredDie`);
        const value = extra.querySelector('.roll');
        if (value) value.textContent = result.result;
        die.after(extra);
    });
}

function _addActions(breakdown, message, roll, rollType, flavor) {
    if (breakdown.querySelector('.rsr-roll-actions')) return;
    const actions = [];
    const isD20 = roll instanceof CONFIG.Dice.D20Roll;
    const isDamage = roll instanceof CONFIG.Dice.DamageRoll;

    if (canEditRolls(message)) {
        if (isD20 && !roll.hasAdvantage && !roll.hasDisadvantage) {
            actions.push(_action('fa-solid fa-chevrons-down', 'rollDisadvantage', 'DND5E.Disadvantage',
                event => retroAdvantage(message, ROLL_STATE.DIS, { flavor, event })));
            actions.push(_action('fa-solid fa-chevrons-up', 'rollAdvantage', 'DND5E.Advantage',
                event => retroAdvantage(message, ROLL_STATE.ADV, { flavor, event })));
        }
        if (isDamage && message.type === 'damage' && !message.rolls.some(r => r.isCritical)) {
            actions.push(_action('fa-solid fa-dice', 'rollCrit', 'DND5E.CriticalHit', event => retroCritical(message, event)));
        }
    }

    const bonusType = _bonusType(rollType, isD20, isDamage);
    if (bonusType && (game.user.isGM || message.isAuthor === true)) {
        actions.push(_action('fa-solid fa-plus', 'bonus', `${MODULE_SHORT}.chat.buttons.bonusShort`,
            () => BonusManager.openBonusDialog(message, bonusType)));
    }
    if (!actions.length) return;

    const row = document.createElement('div');
    row.className = 'rsr-roll-actions';
    row.append(...actions);
    (breakdown.querySelector('.dice-tooltip') ?? breakdown).append(row);
}

/** The Add Bonus category for a roll, as the classic card uses. */
function _bonusType(rollType, isD20, isDamage) {
    if (isDamage) return ROLL_TYPE.DAMAGE;
    if (!isD20 || !rollType) return null;
    return rollType === ROLL_TYPE.ABILITY_TEST ? ROLL_TYPE.CHECK : rollType;
}

function _action(icon, tooltipKey, labelKey, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rsr-roll-action';
    const tooltip = CoreUtility.localize(`${MODULE_SHORT}.chat.buttons.${tooltipKey}`);
    button.dataset.tooltip = tooltip;
    button.setAttribute('aria-label', tooltip);
    const glyph = document.createElement('i');
    glyph.className = icon;
    glyph.inert = true;
    const text = document.createElement('span');
    text.textContent = CoreUtility.localize(labelKey);
    button.append(glyph, text);
    onEditClick([button], handler);
    return button;
}
