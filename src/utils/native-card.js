import { MODULE_SHORT, ROLL_TYPE } from '../module/const.js';
import { TEMPLATE } from '../module/templates.js';
import { BonusManager } from './bonus.js';
import { ChatUtility } from './chat.js';
import { getRollType } from './dnd5e-compat.js';
import { CoreUtility } from './core.js';
import { DialogUtility } from './dialog.js';
import { setNativeCritical } from './native-critical.js';
import { RenderUtility } from './render.js';
import { ROLL_STATE, RollUtility } from './roll.js';
import { SETTING_NAMES, SettingsUtility } from './settings.js';

/**
 * dnd5e 6: RSReforged's own card sections, rendered from the native roll messages
 * folded into a usage card. The rolls stay authoritative on those child documents;
 * each section carries its child's ID so native components and RSR controls resolve
 * the real attack or damage message.
 */
export async function renderRsrSection(parent, child) {
    let section = null;
    switch (child.type) {
        case 'attack': section = await _attackSection(parent, child); break;
        case 'damage':
        case 'healing': section = await _damageSection(parent, child); break;
        case 'generic': section = await _formulaSection(parent, child); break;
    }
    if (section) _restoreExpanded(section, child);
    return section;
}

/**
 * dnd5e 6: the 4.x look for a standalone check or save: RSR's multiroll total and
 * collapsible breakdown in place of dnd5e's compact roll row. Hide NPC Roll Results,
 * the retroactive advantage overlay, and Add Bonus apply as on 4.x cards.
 */
export async function renderRsrCheck(message) {
    const roll = message.rolls.find(r => r instanceof CONFIG.Dice.D20Roll);
    if (!roll) return null;
    const rollType = getRollType(message);

    const shown = Roll.fromData(foundry.utils.deepClone(roll.toJSON()));
    shown.options.displayChallenge = message.shouldDisplayChallenge ?? game.user.isGM;
    ChatUtility.configureNpcRollVisibility(shown, rollType, ChatUtility.getActorFromMessage(message));

    const rollHTML = await _renderRoll(shown, message.rolls.indexOf(roll));
    const total = await RenderUtility.render(TEMPLATE.MULTIROLL, { roll: shown, key: rollType });
    rollHTML.querySelector('.dice-total')?.replaceWith(_fragment(total));
    if (shown.options.hideFinalResult) ChatUtility.maskHiddenRoll($(rollHTML), shown);

    const section = document.createElement('div');
    section.className = 'rsr-card rsr-check';
    section.dataset.messageId = message.id;
    section.append(rollHTML);
    // As 4.x did, a retroactive change of mode is also written into the flavor.
    await _addAdvantageOverlay(section, message, roll, { flavor: true });
    _restoreExpanded(section, message);
    return section;
}

async function _attackSection(parent, child) {
    const roll = child.rolls.find(r => r instanceof CONFIG.Dice.D20Roll);
    if (!roll) return null;

    // Render from a copy: the display options below are per viewer and must never
    // reach the document through a later edit that serializes its rolls.
    const shown = Roll.fromData(foundry.utils.deepClone(roll.toJSON()));
    shown.options.displayChallenge = game.user.isGM || game.settings.get('dnd5e', 'attackRollVisibility') !== 'none';
    // Hide NPC Roll Results: masks the total or the breakdown for players who do not own the actor.
    ChatUtility.configureNpcRollVisibility(shown, ROLL_TYPE.ATTACK, ChatUtility.getActorFromMessage(child));

    const rollHTML = await _renderRoll(shown, child.rolls.indexOf(roll));
    const total = await RenderUtility.render(TEMPLATE.MULTIROLL, { roll: shown, key: ROLL_TYPE.ATTACK });
    rollHTML.querySelector('.dice-total')?.replaceWith(_fragment(total));
    if (shown.options.hideFinalResult) ChatUtility.maskHiddenRoll($(rollHTML), shown);

    const ammo = child.system?.ammunitionItem?.name;
    const section = await _section(child, {
        section: `rsr-section-${ROLL_TYPE.ATTACK}`,
        title: CoreUtility.localize('DND5E.Attack'),
        icon: '<dnd5e-icon src="systems/dnd5e/icons/svg/trait-weapon-proficiencies.svg"></dnd5e-icon>',
        subtitle: ammo ? `${CoreUtility.localize('DND5E.CONSUMABLE.Type.Ammunition.Label')} - ${ammo}` : undefined
    });
    section.append(rollHTML);
    await _addAdvantageOverlay(section, child, roll);
    _addBonusButton(section, child, ROLL_TYPE.ATTACK);
    return section;
}

async function _damageSection(parent, child) {
    const rolls = child.rolls.filter(r => r instanceof CONFIG.Dice.DamageRoll);
    if (!rolls.length) return null;

    const healing = child.type === 'healing';
    const critical = rolls.some(r => r.isCritical);
    const versatile = parent.flags?.[MODULE_SHORT]?.versatile;
    const section = await _section(child, healing
        ? {
            section: `rsr-section-${ROLL_TYPE.DAMAGE}`,
            title: CoreUtility.localize('DND5E.HEAL.HealingButton'),
            icon: '<i class="fas fa-heart"></i>'
        }
        : {
            section: `rsr-section-${ROLL_TYPE.DAMAGE}`,
            title: `${CoreUtility.localize('DND5E.Damage')} ${versatile ? `(${CoreUtility.localize('DND5E.Versatile')})` : ''}`,
            icon: '<i class="fas fa-burst"></i>',
            subtitle: critical ? `${CoreUtility.localize('DND5E.CriticalHit')}!` : undefined,
            critical
        });

    const rollHTML = _renderDamage(rolls, child.rolls);
    rollHTML.querySelector('.dice-result').classList.add('rsr-damage');
    section.append(rollHTML);
    if (!healing && !critical) await _addCriticalOverlay(section, child);
    _addBonusButton(section, child, ROLL_TYPE.DAMAGE);

    const onSave = child.system?.onSave;
    if (onSave) {
        const note = document.createElement('p');
        note.className = 'supplement rsr-supplement';
        note.innerHTML = `<strong>${CoreUtility.localize('DND5E.SAVE.OnSave')}</strong> `;
        note.append(onSave);
        section.append(note);
    }

    // Click a part's type label or icon to switch it, e.g. Chromatic Orb.
    ChatUtility.injectNativeDamageTypeToggles(child, $(section));

    if (SettingsUtility._useRsrDamageApplyButtons) {
        await ChatUtility.injectNativeApplyButtons(child, $(section));
    } else if (game.user.isGM || dnd5e.settings?.allowPlayerDamageTray) {
        // Resolves its message, damages, and save outcome from the nearest
        // data-message-id, which the section sets to the damage child.
        const tray = document.createElement('damage-application');
        tray.classList.add('dnd5e2');
        section.append(tray);
    }
    return section;
}

async function _formulaSection(parent, child) {
    const roll = child.rolls[0];
    if (!roll) return null;
    const section = await _section(child, {
        section: `rsr-section-${ROLL_TYPE.FORMULA}`,
        title: parent.flags?.[MODULE_SHORT]?.formulaName ?? CoreUtility.localize('DND5E.OtherFormula'),
        icon: '<i class="fas fa-dice"></i>'
    });
    // A formula child can hold several rolls; its hidden original must not be their only view.
    for (const [index, each] of child.rolls.entries()) section.append(await _renderRoll(each, index));
    return section;
}

/**
 * The 4.x hover overlays. Each edit rewrites the child document's own rolls; its update
 * refreshes the usage card, which rebuilds these sections from the new rolls.
 */
function _canEdit(child) {
    return SettingsUtility.getSettingValue(SETTING_NAMES.OVERLAY_BUTTONS_ENABLED)
        && (game.user.isGM || child.isAuthor === true);
}

async function _addAdvantageOverlay(section, child, roll, { flavor = false } = {}) {
    if (!_canEdit(child) || roll.hasAdvantage || roll.hasDisadvantage) return;
    const total = section.querySelector('.rsr-multiroll .dice-total');
    if (!total) return;
    total.append(_fragment(await RenderUtility.render(TEMPLATE.OVERLAY_MULTIROLL, {})));
    _onOverlayClick(total.querySelectorAll('.rsr-overlay-multiroll [data-action="rsr-retro"]'), async (event, button) => {
        const state = button.dataset.state;
        const target = CoreUtility.localize(state === ROLL_STATE.ADV ? 'DND5E.Advantage' : 'DND5E.Disadvantage');
        if (!await _confirm(SETTING_NAMES.CONFIRM_RETRO_ADV, CoreUtility.localize(`${MODULE_SHORT}.chat.prompts.retroAdv`, { target }), event)) return;
        const rolls = _cloneRolls(child);
        const index = rolls.findIndex(r => r instanceof CONFIG.Dice.D20Roll);
        if (index < 0) return;
        // Rolls and shows only the extra d20, keeping the original result.
        rolls[index] = await RollUtility.upgradeRoll(rolls[index], state);
        const update = { rolls: CoreUtility.serializeRolls(rolls) };
        if (flavor) update.flavor = `${child.flavor ?? ''} (${target})`.trim();
        await child.update(update);
    });
}

async function _addCriticalOverlay(section, child) {
    if (!_canEdit(child) || child.type !== 'damage') return;
    const total = section.querySelector('.rsr-damage > .dice-total');
    if (!total) return;
    total.append(_fragment(await RenderUtility.render(TEMPLATE.OVERLAY_CRIT, {})));
    _onOverlayClick(total.querySelectorAll('.rsr-overlay-crit [data-action="rsr-retro"]'), async event => {
        if (!await _confirm(SETTING_NAMES.CONFIRM_RETRO_CRIT, CoreUtility.localize(`${MODULE_SHORT}.chat.prompts.retroCrit`), event)) return;
        const rolls = _cloneRolls(child);
        const promoted = [];
        for (const [index, roll] of rolls.entries()) {
            if (!(roll instanceof CONFIG.Dice.DamageRoll)) continue;
            // dnd5e builds the critical expression; the original dice keep their results.
            rolls[index] = await setNativeCritical(roll, true);
            promoted.push(rolls[index]);
        }
        if (!promoted.length) return;
        await _showDice(child, promoted);
        await child.update({ rolls: CoreUtility.serializeRolls(rolls) });
    });
}

/** The 4.x header "+": the bonus is added to this child's own roll, as the overlays are. */
function _addBonusButton(section, child, type) {
    if (!game.user.isGM && child.isAuthor !== true) return;
    BonusManager.injectButton(child, $(section), type, `.rsr-section-${type}`);
}

function _onOverlayClick(buttons, handler) {
    let busy = false;
    for (const button of buttons) {
        button.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            // One edit at a time: a second click would upgrade the already-upgraded roll.
            if (busy) return;
            busy = true;
            try {
                await handler(event, button);
            } catch (error) {
                console.error('RSReforged | roll edit failed', error);
                ui.notifications?.error(error.message);
            } finally {
                busy = false;
            }
        });
    }
}

async function _confirm(setting, prompt, event) {
    if (!SettingsUtility.getSettingValue(setting)) return true;
    return DialogUtility.getConfirmDialog(prompt, {
        width: 100,
        top: event ? event.clientY - 50 : null,
        left: window.innerWidth - 510
    });
}

function _cloneRolls(child) {
    return child.rolls.map(roll => Roll.fromData(foundry.utils.deepClone(roll.toJSON())));
}

/** Throw promoted dice for everyone the child message is visible to. */
function _showDice(child, rolls) {
    if (!game.dice3d?.isEnabled?.()) return;
    const whisper = child.whisper?.length ? child.whisper : null;
    return Promise.all(rolls.map(roll =>
        game.dice3d.showForRoll(roll, game.user, true, whisper, child.blind ?? false, child.id, child.speaker)));
}

async function _section(child, header) {
    const section = _fragment(await RenderUtility.render(TEMPLATE.SECTION, header)).firstElementChild;
    const wrapper = document.createElement('div');
    wrapper.className = `rsr-card ${header.section}`;
    wrapper.dataset.messageId = child.id;
    wrapper.dataset.rsrMessageId = child.id;
    wrapper.append(section);
    return wrapper;
}

function _fragment(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html).trim();
    return template.content;
}

/** Core roll markup in dnd5e 5.3's collapsible breakdown. Foundry 14 already lists constant terms. */
async function _renderRoll(roll, rollIndex) {
    const root = _fragment(await roll.render()).firstElementChild;
    delete root.dataset.action;

    const tooltip = root.querySelector('.dice-tooltip');
    if (tooltip) {
        // dnd5e 6 lists one part per die term in roll.dice order, then its constant
        // part, which holds no dice; stamp each result with its source for rerolls.
        const parts = [...tooltip.querySelectorAll('.tooltip-part')].filter(part => part.querySelector('.dice-rolls .roll'));
        if (parts.length === roll.dice.length) parts.forEach((part, dieIndex) => {
            const results = part.querySelectorAll('.dice-rolls .roll');
            if (results.length !== roll.dice[dieIndex].results.length) return;
            results.forEach((node, resultIndex) => _stampDie(node, rollIndex, dieIndex, resultIndex));
        });
        const collapser = document.createElement('div');
        collapser.className = 'dice-tooltip-collapser';
        tooltip.replaceWith(collapser);
        collapser.append(tooltip);
        // As on the 5.3 card, the formula shows only with the breakdown open.
        const formula = root.querySelector('.dice-formula');
        if (formula) tooltip.prepend(formula);
    }
    return root;
}

/**
 * Coalesce damage rolls into one breakdown, as dnd5e 5.3's `_enrichDamageTooltip`
 * did before dnd5e 6 replaced it with the compact roll button.
 */
function _renderDamage(rolls, sources = rolls) {
    const aggregate = CONFIG.DND5E.aggregateDamageDisplay;
    const parts = aggregate ? dnd5e.dice.aggregateDamageRolls(rolls) : rolls;
    // Aggregated parts carry their own leading " + ", which the first part must drop.
    const formula = parts.map(r => r.formula).join(aggregate ? '' : ' + ').replace(/^\s*\+\s*/, '');
    const total = parts.reduce((sum, r) => sum + Math.max(0, r.total), 0);

    const breakdown = parts.map((roll, index) => {
        const { type, total, constant, dice, icon, method } = _simplifyDamageRoll(roll);
        const config = CONFIG.DND5E.damageTypes[type] ?? CONFIG.DND5E.healingTypes[type];
        // Tells a part's apply buttons which rolls it shows: one roll, or every roll
        // of its type once the display has merged them.
        const source = aggregate ? '' : ` data-rsr-roll-index="${index}"`;
        return `<section class="tooltip-part" data-rsr-damage-type="${_escape(type ?? '')}"${source}><div class="dice">
            ${icon ? `<span class="part-method" data-tooltip aria-label="${_escape(CoreUtility.localize(method))}">${icon}</span>` : ''}
            <ol class="dice-rolls">
                ${dice.map(die => `<li class="roll ${die.classes}"${_dieSource(die, sources)}>${die.result}</li>`).join('')}
                ${constant ? `<li class="constant"><span class="sign">${constant < 0 ? '-' : '+'}</span>${Math.abs(constant)}</li>` : ''}
            </ol>
            <div class="total">
                ${config ? `<img src="${_escape(config.icon)}" alt="${_escape(config.label)}">` : ''}
                <span class="label">${_escape(config?.labelShort ?? config?.label ?? '')}</span>
                <span class="value">${total}</span>
            </div>
        </div></section>`;
    }).join('');

    const root = document.createElement('div');
    root.className = 'dice-roll';
    root.innerHTML = `<div class="dice-result">
        <div class="dice-tooltip-collapser"><div class="dice-tooltip"><div class="dice-formula"></div>${breakdown}</div></div>
        <h4 class="dice-total">${total}</h4>
    </div>`;
    root.querySelector('.dice-formula').textContent = formula;
    return root;
}

/**
 * A die's place in its message: roll, die term (roll.dice), and result. The reroll and
 * fudge listener acts only on dice stamped this way; dnd5e's own breakdowns stay inert.
 */
function _stampDie(node, rollIndex, dieIndex, resultIndex) {
    if (!(rollIndex >= 0)) return;
    Object.assign(node.dataset, { rsrRoll: rollIndex, rsrDie: dieIndex, rsrResult: resultIndex });
}

/** The same stamp as markup, found by term identity: damage parts list dice in their own order. */
function _dieSource({ term, resultIndex }, sources) {
    for (const [rollIndex, roll] of sources.entries()) {
        const dieIndex = roll.dice?.indexOf(term) ?? -1;
        if (dieIndex >= 0) return ` data-rsr-roll="${rollIndex}" data-rsr-die="${dieIndex}" data-rsr-result="${resultIndex}"`;
    }
    return '';
}

/** After a reroll or other in-place edit, reopen the breakdown the user was working in. */
function _restoreExpanded(section, message) {
    if (!message._rsrKeepExpanded) return;
    delete message._rsrKeepExpanded;
    section.querySelectorAll('.dice-roll').forEach(node => node.classList.add('expanded'));
}

/** Damage types can be registered by other modules; dnd5e 6's own template escapes them. */
function _escape(value) {
    const text = document.createElement('span');
    text.textContent = String(value);
    return text.innerHTML.replaceAll('"', '&quot;');
}

/** dnd5e 5.3's `ChatMessage5e#_simplifyDamageRoll`, unchanged in behaviour. */
function _simplifyDamageRoll(roll) {
    const { OperatorTerm, NumericTerm, DiceTerm, PoolTerm } = foundry.dice.terms;
    const termResultClasses = ['success', 'failure', 'rerolled', 'exploded', 'discarded'];
    const aggregate = { type: roll.options.type, total: Math.max(0, roll.total), constant: 0, dice: [], icon: null, method: null };
    let hasMultiplication = false;
    for (let i = roll.terms.length - 1; i >= 0;) {
        const term = roll.terms[i--];
        if (!(term instanceof NumericTerm) && !(term instanceof DiceTerm) && !(term instanceof PoolTerm)) continue;
        const value = term.total;
        if (term instanceof DiceTerm) {
            const tooltipData = term.getTooltipData();
            // Keep each result's term so the breakdown can stamp its source for rerolls.
            aggregate.dice.push(...tooltipData.rolls.map((die, resultIndex) => ({ ...die, term, resultIndex })));
            aggregate.icon ??= tooltipData.icon;
            aggregate.method ??= tooltipData.method;
        }
        if (term instanceof PoolTerm) {
            term.rolls.forEach((poolTermRoll, index) => {
                const simplified = _simplifyDamageRoll(poolTermRoll);
                const result = term.results[index];
                simplified.dice.forEach(die => {
                    const resultClasses = termResultClasses.filter(c => result[c]).join(' ');
                    if (resultClasses.length) die.classes += ` ${resultClasses}`;
                });
                aggregate.dice.push(...simplified.dice);
                aggregate.icon ??= simplified.icon;
                aggregate.method ??= simplified.method;
            });
        }
        let multiplier = 1;
        let operator = roll.terms[i];
        while (operator instanceof OperatorTerm) {
            if (!['+', '-'].includes(operator.operator)) hasMultiplication = true;
            if (operator.operator === '-') multiplier *= -1;
            operator = roll.terms[--i];
        }
        if (term instanceof NumericTerm) aggregate.constant += value * multiplier;
    }
    if (hasMultiplication) aggregate.constant = null;
    return aggregate;
}
