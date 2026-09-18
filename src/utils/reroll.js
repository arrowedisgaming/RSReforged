import { MODULE_SHORT } from "../module/const.js";
import { ChatUtility } from "./chat.js";
import { CoreUtility } from "./core.js";
import { LogUtility } from "./log.js";
import { SETTING_NAMES, SettingsUtility } from "./settings.js";
import { usesNativeWorkflow } from "./dnd5e-compat.js";

/**
 * Utility class to handle rerolling and fudging individual dice on the canvas.
 */
export class RerollManager {
    static registerGlobalListener() {
        // FIX: Broadened the selector from '.roll.die' to '.roll' to catch 5e damage dice templates
        $(document).on("mousedown", ".dice-tooltip .dice-rolls .roll", (event) => {
            // dnd5e 6 keeps these classes inside its roll breakdown, so this listener
            // still matches there. Rerolls persist through the legacy flag cache, which
            // native cards never read, so stay out until native rerolls are restored.
            if (usesNativeWorkflow()) return;
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

        const oldResult = targetTerm.results[resultIndex].result;
        const faces = targetTerm.faces;

        const newDieRoll = await new Roll(`1d${faces}`).evaluate();
        const newResult = newDieRoll.dice[0].results[0];

        targetTerm.results[resultIndex].result = newResult.result;
        this._recalculateModifiers(targetTerm);
        targetRoll._total = targetRoll._evaluateTotal();

        _persistRolls(message, rolls);

        await this._announceReroll(message, newDieRoll, { faces, oldResult, newResult: newResult.result });
    }

    /**
     * Provide audio/visual feedback and public logging for a reroll.
     * Honors the REROLL_SOUND_ENABLED and REROLL_LOG_CHAT settings, and falls
     * back from Dice So Nice to the configured dice sound when DSN is absent.
     */
    static async _announceReroll(message, newDieRoll, { faces, oldResult, newResult }) {
        const localize = (key, data) => CoreUtility.localize(`${MODULE_SHORT}.chat.reroll.${key}`, data);

        if (SettingsUtility.getSettingValue(SETTING_NAMES.REROLL_SOUND_ENABLED)) {
            const playedDsn = await CoreUtility.tryRollDice3D(newDieRoll, message?.id ?? null);
            if (!playedDsn) {
                CoreUtility.playRollSound();
            }
        }

        if (SettingsUtility.getSettingValue(SETTING_NAMES.REROLL_LOG_CHAT)) {
            const { rollMode, whisper, blind } = CoreUtility.getWhisperData();
            // Escape the user's display name before interpolating into HTML — Foundry user names
            // allow characters that would otherwise render as markup in the chat message.
            const safeUser = foundry.utils.escapeHTML(game.user.name);
            const content = localize("log", { user: safeUser, faces, old: oldResult, new: newResult });

            await ChatMessage.create({
                user: game.user.id,
                speaker: ChatMessage.getSpeaker({ user: game.user }),
                flavor: localize("flavor"),
                content,
                whisper,
                blind: blind ?? false,
                rollMode,
                flags: { [MODULE_SHORT]: { rerollLog: true } }
            });
        }

        ui.notifications.info(localize("notification", { new: newResult }));
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
    const serialised = CoreUtility.serializeRolls(rolls);

    if (message.flags?.[MODULE_SHORT]) {
        message.flags[MODULE_SHORT].rolls = serialised;
        ChatUtility.updateChatMessage(message, { flags: message.flags });
    } else {
        message.update({ rolls: serialised });
    }
}
