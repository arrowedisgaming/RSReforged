import { MODULE_SHORT, ROLL_TYPE } from '../module/const.js';
import { TEMPLATE } from '../module/templates.js';
import { ChatUtility } from './chat.js';
import { CoreUtility } from './core.js';
import { RenderUtility } from './render.js';
import { SettingsUtility } from './settings.js';

/**
 * dnd5e 6: RSReforged's own card sections, rendered from the native roll messages
 * folded into a usage card. The rolls stay authoritative on those child documents;
 * each section carries its child's ID so native components and RSR controls resolve
 * the real attack or damage message.
 */
export async function renderRsrSection(parent, child) {
    switch (child.type) {
        case 'attack': return _attackSection(parent, child);
        case 'damage':
        case 'healing': return _damageSection(parent, child);
        case 'generic': return _formulaSection(parent, child);
    }
    return null;
}

async function _attackSection(parent, child) {
    const roll = child.rolls.find(r => r instanceof CONFIG.Dice.D20Roll);
    if (!roll) return null;

    const rollHTML = await _renderRoll(roll);
    roll.options.displayChallenge = game.user.isGM || game.settings.get('dnd5e', 'attackRollVisibility') !== 'none';
    const total = await RenderUtility.render(TEMPLATE.MULTIROLL, { roll, key: ROLL_TYPE.ATTACK });
    rollHTML.querySelector('.dice-total')?.replaceWith(_fragment(total));

    const ammo = child.system?.ammunitionItem?.name;
    const section = await _section(child, {
        section: `rsr-section-${ROLL_TYPE.ATTACK}`,
        title: CoreUtility.localize('DND5E.Attack'),
        icon: '<dnd5e-icon src="systems/dnd5e/icons/svg/trait-weapon-proficiencies.svg"></dnd5e-icon>',
        subtitle: ammo ? `${CoreUtility.localize('DND5E.CONSUMABLE.Type.Ammunition.Label')} - ${ammo}` : undefined
    });
    section.append(rollHTML);
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

    const rollHTML = _renderDamage(rolls);
    rollHTML.querySelector('.dice-result').classList.add('rsr-damage');
    section.append(rollHTML);

    const onSave = child.system?.onSave;
    if (onSave) {
        const note = document.createElement('p');
        note.className = 'supplement rsr-supplement';
        note.innerHTML = `<strong>${CoreUtility.localize('DND5E.SAVE.OnSave')}</strong> `;
        note.append(onSave);
        section.append(note);
    }

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
    section.append(await _renderRoll(roll));
    return section;
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
async function _renderRoll(roll) {
    const root = _fragment(await roll.render()).firstElementChild;
    delete root.dataset.action;

    const tooltip = root.querySelector('.dice-tooltip');
    if (tooltip) {
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
function _renderDamage(rolls) {
    const aggregate = CONFIG.DND5E.aggregateDamageDisplay;
    const parts = aggregate ? dnd5e.dice.aggregateDamageRolls(rolls) : rolls;
    // Aggregated parts carry their own leading " + ", which the first part must drop.
    const formula = parts.map(r => r.formula).join(aggregate ? '' : ' + ').replace(/^\s*\+\s*/, '');
    const total = parts.reduce((sum, r) => sum + Math.max(0, r.total), 0);

    const breakdown = parts.map(roll => {
        const { type, total, constant, dice, icon, method } = _simplifyDamageRoll(roll);
        const config = CONFIG.DND5E.damageTypes[type] ?? CONFIG.DND5E.healingTypes[type];
        return `<section class="tooltip-part"><div class="dice">
            ${icon ? `<span class="part-method" data-tooltip aria-label="${CoreUtility.localize(method)}">${icon}</span>` : ''}
            <ol class="dice-rolls">
                ${dice.map(({ result, classes }) => `<li class="roll ${classes}">${result}</li>`).join('')}
                ${constant ? `<li class="constant"><span class="sign">${constant < 0 ? '-' : '+'}</span>${Math.abs(constant)}</li>` : ''}
            </ol>
            <div class="total">
                ${config ? `<img src="${config.icon}" alt="${config.label}">` : ''}
                <span class="label">${config?.labelShort ?? config?.label ?? ''}</span>
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
            aggregate.dice.push(...tooltipData.rolls);
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
