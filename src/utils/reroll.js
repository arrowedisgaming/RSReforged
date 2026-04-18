import { MODULE_SHORT } from "../module/const.js";
import { ChatUtility } from "./chat.js";
import { LogUtility } from "./log.js";
import { SETTING_NAMES, SettingsUtility } from "./settings.js";

/**
 * Utility class to handle rerolling and fudging individual dice on the canvas.
 */
export class RerollManager {
    static registerGlobalListener() {
        // FIX: Broadened the selector from '.roll.die' to '.roll' to catch 5e damage dice templates
        $(document).on("mousedown", ".dice-tooltip .dice-rolls .roll", (event) => {
            if (!SettingsUtility.getSettingValue(SETTING_NAMES.REROLL_EVERYONE)) return;
            
            const dieElement = $(event.currentTarget);
            const messageElement = dieElement.closest(".chat-message");
            const messageId = messageElement.data("messageId");
            const message = game.messages.get(messageId);

            if (!message) return;

            if (event.button === 2) {
                if (!game.user.isGM || !SettingsUtility.getSettingValue(SETTING_NAMES.FUDGE_GM)) return;
                this._handleFudge(message, dieElement);
            } else if (event.button === 0) {
                const canReroll = game.user.isGM || 
                                 (message.isAuthor && SettingsUtility.getSettingValue(SETTING_NAMES.REROLL_PLAYERS));
                if (!canReroll) return;
                this._handleReroll(message, dieElement);
            }
        });
    }

    static async _handleReroll(message, dieElement) {
        const { rollIndex, termIndex, resultIndex } = this._getDiePath(dieElement);

        const rolls = ChatUtility.getMessageRolls(message).map(r => {
            return r instanceof Roll ? r : Roll.fromData(r);
        });

        const targetRoll = rolls[rollIndex];
        if (!targetRoll) {
            LogUtility.logWarning(`_handleReroll: no roll at index ${rollIndex}`, { ui: false });
            return;
        }

        // dnd5e tooltips render `roll.dice` (not `roll.terms`) as one tooltip-part each,
        // so termIndex is an index into `dice`, not `terms`.
        const targetTerm = targetRoll.dice[termIndex];
        if (!targetTerm) {
            LogUtility.logWarning(`_handleReroll: no dice term at index ${termIndex}`, { ui: false });
            return;
        }

        const newDieRoll = await new Roll(`1d${targetTerm.faces}`).evaluate();
        const newResult = newDieRoll.dice[0].results[0];
        
        targetTerm.results[resultIndex].result = newResult.result;
        this._recalculateModifiers(targetTerm);
        targetRoll._total = targetRoll._evaluateTotal();

        _persistRolls(message, rolls);
        ui.notifications.info(`Rerolled die: New result is ${newResult.result}`);
    }

    static async _handleFudge(message, dieElement) {
        const { rollIndex, termIndex, resultIndex } = this._getDiePath(dieElement);

        const content = `<div style="padding:4px 0">
            <input type="number" id="fudge-value" placeholder="Enter new value" autofocus
                   style="width:100%; text-align:center; font-size:1.2em;">
        </div>`;

        const newVal = await foundry.applications.api.DialogV2.prompt({
            window: { title: "Fudge Die Result" },
            content,
            ok: {
                label: "Fudge It",
                callback: (event, button) => {
                    const val = parseInt(button.form.elements["fudge-value"]?.value
                        ?? button.form.querySelector("#fudge-value")?.value);
                    return isNaN(val) ? null : val;
                }
            }
        });

        if (newVal === null || newVal === undefined) return;

        const rolls = ChatUtility.getMessageRolls(message).map(r => {
            return r instanceof Roll ? r : Roll.fromData(r);
        });

        const targetRoll = rolls[rollIndex];
        if (!targetRoll) {
            LogUtility.logWarning(`_handleFudge: no roll at index ${rollIndex}`, { ui: false });
            return;
        }

        const targetTerm = targetRoll.dice[termIndex];
        if (!targetTerm) {
            LogUtility.logWarning(`_handleFudge: no dice term at index ${termIndex}`, { ui: false });
            return;
        }

        targetTerm.results[resultIndex].result = newVal;
        this._recalculateModifiers(targetTerm);
        targetRoll._total = targetRoll._evaluateTotal();

        _persistRolls(message, rolls);
    }

    static _recalculateModifiers(targetTerm) {
        if (targetTerm.modifiers.some(m => m.includes("kh") || m.includes("kl"))) {
            targetTerm.results.forEach(r => {
                r.discarded = false;
                r.active = true;
            });
            targetTerm._evaluateModifiers();
        }
    }

    static _getDiePath(dieElement) {
        const tooltipPart = dieElement.closest(".tooltip-part");
        const allParts = dieElement.closest(".dice-tooltip").find(".tooltip-part");
        const termIndex = allParts.index(tooltipPart);

        const diceRoll = dieElement.closest(".dice-roll");
        const allDiceRolls = dieElement.closest(".message-content").find(".dice-roll");
        const rollIndex = Math.max(0, allDiceRolls.index(diceRoll));

        const resultIndex = dieElement.index();

        return { rollIndex, termIndex, resultIndex };
    }
}

function _persistRolls(message, rolls) {
    const serialised = rolls.map(r => r.toJSON ? r.toJSON() : r);

    if (message.flags?.[MODULE_SHORT]) {
        message.flags[MODULE_SHORT].rolls = serialised;
        ChatUtility.updateChatMessage(message, { flags: message.flags });
    } else {
        message.update({ rolls: serialised });
    }
}
