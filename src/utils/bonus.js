import { MODULE_SHORT } from "../module/const.js";
import { ChatUtility } from "./chat.js";
import { LogUtility } from "./log.js";

const { ApplicationV2 } = foundry.applications.api;

// Active Effect change.key namespace consumed by the retroactive bonus picker.
// Module authors / world builders create AE changes targeting this flag path
// to register selectable bonuses (e.g. Bless, Bardic Inspiration).
const AE_BONUS_FLAG = `flags.${MODULE_SHORT}.bonus`;

export class BonusManager {
    static init(message, html) {
        const $html = html instanceof HTMLElement ? $(html) : html;

        if (!message.isAuthor && !game.user.isGM) return false;
        if (!$html || $html.length === 0) return false;

        $html.find('.rsr-damage-buttons button, .rsr-damage-buttons-xl button')
            .off('click.rsrFix')
            .on('click.rsrFix', (ev) => {
                ev.stopPropagation();
            });

        const hasAttackSection = $html.find('.rsr-section-attack').length > 0;
        const hasDamageSection = $html.find('.rsr-section-damage').length > 0;

        const isDnd5eRoll = !!message.flags.dnd5e?.roll?.type;
        const isInitiative = message.flags.core?.initiativeRoll || 
                             (message.flavor && message.flavor.includes("Initiative")) ||
                             $html.find('.dice-flavor').text().includes("Initiative");

        if (!hasAttackSection && !hasDamageSection && !isDnd5eRoll && !isInitiative) return false;

        let injected = false;

        if (hasAttackSection) {
            this.injectButton(message, $html, "attack", ".rsr-section-attack");
            injected = true;
        }
        
        if (hasDamageSection) {
            this.injectButton(message, $html, "damage", ".rsr-section-damage");
            injected = true;
        }

        let rollType = null;
        if (isInitiative) rollType = "initiative";
        else if (isDnd5eRoll) rollType = message.flags.dnd5e.roll.type;

        const validTypes = ["skill", "tool", "ability", "save", "death", "concentration", "initiative"];

        if (rollType && validTypes.includes(rollType)) {
            const label = rollType === "ability" ? "check" : rollType;
            this.injectButton(message, $html, label, ".message-header");
            injected = true;
        }

        return injected;
    }

    static injectButton(message, html, type, sectionSelector) {
        const section = html.find(sectionSelector);
        if (section.length === 0) return;

        if (section.find(`.rsr-addon-bonus-btn[data-type="${type}"]`).length > 0) return;

        let container = section.find('.rsr-header .rsr-title').first();
        if (container.length === 0) container = section.find('.rsr-header').first();
        if (container.length === 0) container = section.find('.message-sender').first(); 
        if (container.length === 0) container = section; 

        const titleType = type.charAt(0).toUpperCase() + type.slice(1);
        const btn = $(`<i class="fas fa-plus-circle rsr-addon-bonus-btn" data-type="${type}" title="Add Bonus to ${titleType}"></i>`);
        
        if (sectionSelector === ".message-header") {
            btn.css({ "margin-left": "8px", "align-self": "center", "font-size": "1.2em", "order": "10", "cursor": "pointer" });
            section.append(btn);
        } else {
            container.append(btn);
        }
        
        btn.click((ev) => {
            ev.preventDefault();
            ev.stopPropagation(); 
            this.openBonusDialog(message, type);
        });
    }

    static async openBonusDialog(message, type) {
        // Use ChatUtility.getActorFromMessage for consistent, null-safe actor resolution
        // that correctly handles unlinked token actors (same fix as was applied in chat.js).
        const actor = ChatUtility.getActorFromMessage(message);
        if (!actor) return ui.notifications.warn("No actor found for this message.");
        
        const rollData = actor.getRollData();
        const bonuses = [];
        const actorEffects = actor.appliedEffects || actor.effects; 
        const candidateEffects = actorEffects.filter(e => !e.disabled && !e.isSuppressed);

        for (const effect of candidateEffects) {
            const changes = effect.changes.filter(c => c.key.trim() === AE_BONUS_FLAG);
            for (const change of changes) {
                const parts = change.value.split(";").map(s => s.trim());
                const typePart = parts.find(p => p.toLowerCase().startsWith("type:"));
                const consumePart = parts.find(p => p.toLowerCase().startsWith("consume"));
                const isOnce = parts.some(p => p.toLowerCase() === "once");

                let consumeTarget = null;
                if (consumePart) {
                    const split = consumePart.split(":");
                    consumeTarget = split.length > 1 ? split[1].trim() : "origin";
                }

                const formulaParts = parts.filter(p => 
                    !p.toLowerCase().startsWith("type:") && 
                    !p.toLowerCase().startsWith("consume") && 
                    p.toLowerCase() !== "once"
                );
                
                let rawFormula = formulaParts.length > 0 ? formulaParts[0] : "0";
                const resolvedFormula = this._resolveFormula(rawFormula, rollData);

                let allowedTypes = ["any"];
                if (typePart) {
                    const typeString = typePart.split(":")[1];
                    allowedTypes = typeString.split(",").map(t => t.trim().toLowerCase());
                }

                let isMatch = false;
                for (const allowedType of allowedTypes) {
                    if (allowedType === "all" || allowedType === "any") isMatch = true;
                    else if (allowedType === type) isMatch = true;
                    else if (allowedType === "check" && ["skill", "tool", "ability", "check", "initiative"].includes(type)) isMatch = true;
                    else if (allowedType === "save" && ["save", "death", "concentration"].includes(type)) isMatch = true;
                    else if (type === "check" && ["skill", "tool", "initiative"].includes(allowedType)) isMatch = true;
                    if (isMatch) break;
                }
                
                if (isMatch) {
                    bonuses.push({
                        effectId: effect.id,
                        origin: effect.origin,
                        name: effect.name,
                        icon: effect.img || effect.icon || "icons/svg/aura.svg",
                        rawFormula: rawFormula,
                        resolvedFormula: resolvedFormula,
                        isOnce: isOnce,
                        consumeTarget: consumeTarget
                    });
                }
            }
        }

        new BonusSelector({
            bonuses: bonuses,
            type: type,
            onSubmit: async (result) => {
                let bonusDef = result.isCustom ? { name: "Custom Bonus", rawFormula: result.formula, isOnce: false } : bonuses[result.index];
                if (bonusDef) await this.applyBonus(message, type, bonusDef, actor);
            }
        }).render(true);
    }

    static async applyBonus(message, type, bonusDef, actor) {
        try {
            if (bonusDef.consumeTarget) {
                let itemToConsume = null;
                if (bonusDef.consumeTarget === "origin" && bonusDef.origin) {
                    const parts = bonusDef.origin.split('.');
                    itemToConsume = actor.items.get(parts[parts.length - 1]);
                } else if (bonusDef.consumeTarget !== "origin") {
                    itemToConsume = actor.items.get(bonusDef.consumeTarget) || actor.items.find(i => i.name === bonusDef.consumeTarget);
                }

                if (itemToConsume) {
                    const uses = itemToConsume.system?.uses;
                    if (uses?.max && uses.value > 0) {
                        await itemToConsume.update({"system.uses.spent": (uses.spent || 0) + 1});
                    } else if (uses?.max) {
                        return ui.notifications.warn(`No uses left for ${itemToConsume.name}!`);
                    }
                }
            }

            // RSR stores rolls in message.flags[MODULE_SHORT].rolls, not in message.rolls.
            // For a processed RSR activity card, message.rolls is empty — the attack and
            // damage rolls were intercepted and stored in flags by runActivityActions().
            // ChatUtility.getMessageRolls() reads the flags path first, falling back to
            // message.rolls for non-RSR messages.
            const currentRolls = ChatUtility.getMessageRolls(message).map(r => {
                return r instanceof Roll ? r : Roll.fromData(r);
            });

            let targetRollIndex = currentRolls.findIndex(r =>
                type === "damage" ? r instanceof CONFIG.Dice.DamageRoll : r instanceof CONFIG.Dice.D20Roll
            );
            if (targetRollIndex === -1) targetRollIndex = currentRolls.length > 0 ? 0 : -1;
            if (targetRollIndex === -1) return ui.notifications.error("No roll found.");

            const originalRoll = currentRolls[targetRollIndex];
            const TargetRollClass = originalRoll.constructor;
            const rollData = actor.getRollData();
            const cleanFormula = this._resolveFormula(bonusDef.rawFormula, rollData);
            
            if (!cleanFormula || cleanFormula.trim() === "") return ui.notifications.warn("Invalid bonus formula.");

            const bonusRoll = new TargetRollClass(cleanFormula, rollData, originalRoll.options);
            await bonusRoll.evaluate();

            const newTerms = [
                ...originalRoll.terms.map(t => foundry.utils.deepClone(t)),
                new foundry.dice.terms.OperatorTerm({operator: "+"}),
                ...bonusRoll.terms
            ];

            const newRoll = TargetRollClass.fromTerms(newTerms);
            newRoll.options = foundry.utils.deepClone(originalRoll.options);
            newRoll._total = originalRoll.total + bonusRoll.total;
            newRoll._evaluated = true; 

            currentRolls[targetRollIndex] = newRoll;

            // Persist via flags so the RSR card re-renders from the correct data source.
            const serialised = currentRolls.map(r => r.toJSON ? r.toJSON() : r);
            if (message.flags?.[MODULE_SHORT]) {
                message.flags[MODULE_SHORT].rolls = serialised;
                await ChatUtility.updateChatMessage(message, { flags: message.flags });
            } else {
                await message.update({ rolls: serialised });
            }

            if (type === "initiative") {
                const combat = game.combats.find(c => c.scene?.id === message.speaker.scene) || game.combat;
                const combatant = combat?.combatants.find(c => c.tokenId === message.speaker.token || c.actorId === message.speaker.actor);
                if (combatant) await combat.setInitiative(combatant.id, newRoll.total);
            }

            if (bonusDef.isOnce && bonusDef.effectId) {
                const effect = actor.effects.get(bonusDef.effectId);
                if (effect) await effect.delete();
            }
            ui.notifications.info(`Applied ${bonusDef.name} (+${bonusRoll.total}).`);

        } catch (err) {
            LogUtility.logError(`Error applying bonus: ${err.message}`, { ui: true });
            console.error(err);
        }
    }

    static _resolveFormula(formula, rollData) {
        if (!formula || typeof formula !== 'string' || !formula.includes("@")) return formula;
        return formula.replace(/@([a-zA-Z0-9._-]+)/g, (match, term) => {
            let value = foundry.utils.getProperty(rollData, term);
            if (value === undefined) return match;
            if (typeof value === 'object' && value !== null) {
                if ('number' in value && 'faces' in value) return `${value.number}d${value.faces}`;
                return value.value ?? "0"; 
            }
            return String(value);
        });
    }
}

class BonusSelector extends ApplicationV2 {
    constructor(options) {
        super(options);
        this.bonuses = options.bonuses;
        this.type = options.type;
        this.onSubmitCallback = options.onSubmit;
    }

    static DEFAULT_OPTIONS = {
        tag: "form", id: "rsr-bonus-selector", classes: ["rsr-bonus-window"],
        window: { title: "Apply Retroactive Bonus", icon: "fas fa-dice-d20", resizable: false, width: 400 },
        position: { width: 400, height: "auto" },
        form: { handler: BonusSelector.prototype._handleSubmit, closeOnSubmit: true }
    };

    async _renderHTML() {
        const customChecked = this.bonuses.length === 0 ? "checked" : "";
        let html = `
        <div class="rsr-bonus-content" style="padding: 10px; display: flex; flex-direction: column; gap: 10px;">
            <p>Select a bonus for the <strong>${this.type} roll</strong>:</p>
            <div class="rsr-bonus-list" style="display: flex; flex-direction: column; gap: 6px;">
                <div class="form-group" style="padding: 8px; border: 1px solid var(--color-border-light-2); border-radius: 4px; background: var(--color-bg-light);">
                    <div style="display:flex; align-items:center;">
                        <input type="radio" name="bonusIndex" value="custom" id="bonus-custom" ${customChecked}>
                        <label for="bonus-custom" style="display:flex; align-items:center; cursor:pointer; flex:1; margin-left:12px;">
                            <img src="icons/magic/life/crosses-trio-red.webp" width="32" height="32" style="border:none; margin-right:12px;">
                            <strong>Custom Bonus</strong>
                        </label>
                    </div>
                    <div class="custom-input-container" style="margin-top: 8px; margin-left: 44px; display: ${customChecked ? 'block' : 'none'};">
                        <input type="text" name="customFormula" placeholder="e.g. +5 or 1d4" style="width: 100%;">
                    </div>
                </div>`;

        this.bonuses.forEach((b, i) => {
            html += `
                <div class="form-group" style="display:flex; align-items:center; padding: 8px; border: 1px solid var(--color-border-light-2); border-radius: 4px; background: var(--color-bg-light);">
                    <input type="radio" name="bonusIndex" value="${i}" id="bonus-${i}" ${i === 0 && !customChecked ? "checked" : ""}>
                    <label for="bonus-${i}" style="display:flex; align-items:center; cursor:pointer; flex:1; margin-left:12px;">
                        <img src="${b.icon}" width="32" height="32" style="border:none; margin-right:12px;">
                        <div><strong>${b.name}</strong><br><small>${b.rawFormula}</small></div>
                    </label>
                </div>`;
        });

        html += `
            </div>
            <footer class="form-footer" style="margin-top: 10px; display: flex; justify-content: flex-end;">
                <button type="submit" style="width: auto;"><i class="fas fa-dice-d20"></i> Apply Bonus</button>
            </footer>
        </div>`;

        const div = document.createElement("div");
        div.innerHTML = html;
        div.querySelectorAll('input[name="bonusIndex"]').forEach(r => {
            r.addEventListener('change', e => div.querySelector('.custom-input-container').style.display = e.target.value === "custom" ? 'block' : 'none');
        });
        return div;
    }

    _replaceHTML(result, content) { content.replaceChildren(result); }

    async _handleSubmit(event, form, formData) {
        if (this.onSubmitCallback) {
            if (formData.object.bonusIndex === "custom") {
                if (!formData.object.customFormula) return ui.notifications.warn("Enter formula.");
                await this.onSubmitCallback({ isCustom: true, formula: formData.object.customFormula });
            } else {
                await this.onSubmitCallback({ isCustom: false, index: parseInt(formData.object.bonusIndex) });
            }
        }
    }
}
