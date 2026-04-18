import { BonusManager } from "./bonus.js";
import { RerollManager } from "./reroll.js";
import { MODULE_SHORT, MODULE_TITLE } from "../module/const.js";
import { ActivityUtility } from "./activity.js";
import { ChatUtility } from "./chat.js";
import { CoreUtility } from "./core.js";
import { LogUtility } from "./log.js";
import { ROLL_TYPE, RollUtility } from "./roll.js";
import { SETTING_NAMES, SettingsUtility } from "./settings.js";

export const HOOKS_CORE = { INIT: "init", READY: "ready" }

export const HOOKS_DND5E = {
    PRE_ROLL_ABILITY_CHECK: "dnd5e.preRollAbilityCheckV2",
    PRE_ROLL_SAVING_THROW: "dnd5e.preRollSavingThrowV2",
    PRE_ROLL_SKILL: "dnd5e.preRollSkillV2",
    PRE_ROLL_TOOL_CHECK: "dnd5e.preRollToolV2",
    PRE_ROLL_ATTACK: "dnd5e.preRollAttackV2",
    PRE_ROLL_DAMAGE: "dnd5e.preRollDamageV2",
    PRE_USE_ACTIVITY: "dnd5e.preUseActivity",
    // POST_USE_ACTIVITY removed: in dnd5e 5.3.0 we use usageConfig.subsequentActions = false
    // in PRE_USE_ACTIVITY instead of returning false from POST_USE_ACTIVITY to block auto-rolls.
    ACTIVITY_CONSUMPTION: "dnd5e.activityConsumption",
    DISPLAY_CARD: "dnd5e.displayCard",
    RENDER_CHAT_MESSAGE: "dnd5e.renderChatMessage",
    RENDER_ITEM_SHEET: "renderItemSheet5e",
    RENDER_ACTOR_SHEET: "renderActorSheet5e",
}

export const HOOKS_INTEGRATION = { DSN_ROLL_COMPLETE: "diceSoNiceRollComplete" }

export class HooksUtility {
    static registerModuleHooks() {
        Hooks.once(HOOKS_CORE.INIT, () => {
            LogUtility.log(`Initialising ${MODULE_TITLE}`);
            SettingsUtility.registerSettings();
            HooksUtility.registerRollHooks();
            HooksUtility.registerChatHooks();
            RerollManager.registerGlobalListener();
        });

        Hooks.on(HOOKS_CORE.READY, () => {
            CONFIG[MODULE_SHORT].combinedDamageTypes = foundry.utils.mergeObject(
                Object.fromEntries(Object.entries(CONFIG.DND5E.damageTypes).map(([k, v]) => [k, v.label])),
                Object.fromEntries(Object.entries(CONFIG.DND5E.healingTypes).map(([k, v]) => [k, v.label])),
                { recursive: false }
            );
            CONFIG.DND5E.aggregateDamageDisplay = SettingsUtility.getSettingValue(SETTING_NAMES.AGGREGATE_DAMAGE) ?? true;
            LogUtility.log(`Loaded ${MODULE_TITLE}`);
        });
    }

    static registerRollHooks() {
        LogUtility.log("Registering roll hooks");

        if (SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ABILITY_ENABLED)) {
            Hooks.on(HOOKS_DND5E.PRE_ROLL_ABILITY_CHECK, (config, dialog, message) => {
                RollUtility.processRoll(config, dialog, message);
                return true;
            });
            Hooks.on(HOOKS_DND5E.PRE_ROLL_SAVING_THROW, (config, dialog, message) => {
                RollUtility.processRoll(config, dialog, message);
                return true;
            });
        }

        if (SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_SKILL_ENABLED)) {
            Hooks.on(HOOKS_DND5E.PRE_ROLL_SKILL, (config, dialog, message) => {
                RollUtility.processRoll(config, dialog, message);
                return true;
            });
        }

        if (SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_TOOL_ENABLED)) {
            Hooks.on(HOOKS_DND5E.PRE_ROLL_TOOL_CHECK, (config, dialog, message) => {
                RollUtility.processRoll(config, dialog, message);
                return true;
            });
        }

        if (SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ACTIVITY_ENABLED)) {
            // dnd5e 5.3.0: Set subsequentActions = false to prevent the system from
            // auto-triggering attack/damage rolls after item use. RSR handles those itself
            // via preCreateChatMessage + ActivityUtility.runActivityActions(). This replaces
            // the old setTimeout/postUseActivity hack that returned false to block auto-rolls,
            // which broke entirely in 5.3.0 because postUseActivity now only gates the
            // _triggerSubsequentActions call (line 16848 in dnd5e.mjs), not message creation.
            Hooks.on(HOOKS_DND5E.PRE_USE_ACTIVITY, (activity, usageConfig, dialogConfig, messageConfig) => {
                if (!SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_VANILLA_ENABLED)) {
                    // Preserve dnd5e's usage-configuration dialog for *leveled* spells so
                    // the player can select an upcast slot; the dialog writes the chosen
                    // upcast delta to message.system.scaling, which ActivityUtility then
                    // passes to rollDamage. Cantrips skip the dialog — they have no slot
                    // choice and ActivityUtility falls through to rollData.scaling, which
                    // SpellData#scalingIncrease auto-computes from actor.cantripLevel.
                    const isLeveledSpell = activity?.item?.type === "spell"
                        && (activity.item.system?.level ?? 0) > 0;
                    if (!isLeveledSpell) {
                        dialogConfig.configure = false;
                    }
                    usageConfig.subsequentActions = false;
                }
                return true;
            });

            Hooks.on(HOOKS_DND5E.PRE_ROLL_ATTACK, (config, dialog, message) => {
                const flags = message?.flags || message?.data?.flags;
                if (!flags || !flags[MODULE_SHORT]?.quickRoll) return true;

                for (const roll of config.rolls) {
                    roll.options.advantage ??= config.advantage;
                    roll.options.disadvantage ??= config.disadvantage;
                }
                dialog.configure = false;
                return true;
            });

            Hooks.on(HOOKS_DND5E.PRE_ROLL_DAMAGE, (config, dialog, message) => {
                const flags = message?.flags || message?.data?.flags;
                if (!flags || !flags[MODULE_SHORT]?.quickRoll) return true;

                for (const roll of config.rolls) {
                    roll.options ??= {};
                    roll.options.isCritical ??= config.isCritical;
                }
                dialog.configure = false;
                return true;
            });

            // dnd5e 5.3.0: ActivityUsageUpdates always uses `updates.item` (an array of
            // { _id, ...dotNotationProperties } objects). The `updates.items` key from older
            // versions no longer exists and has been removed from this hook.
            Hooks.on(HOOKS_DND5E.ACTIVITY_CONSUMPTION, (activity, usageConfig, messageConfig, updates) => {
                const hasAttack = activity.type === "attack" || !!activity.attack || activity.hasOwnProperty(ROLL_TYPE.ATTACK);
                const items = updates.item;

                if (hasAttack && items && items.length > 0) {
                    const ammo = items.find(i => i["system.quantity"] !== undefined || i["system.uses.spent"] !== undefined);
                    if (!ammo) return;

                    messageConfig.flags ??= {};
                    messageConfig.flags[MODULE_SHORT] ??= {};
                    messageConfig.flags[MODULE_SHORT].ammunition = ammo._id;

                    // Temporarily restore the quantity so the attack roll can access live ammo
                    // data. The system will apply its own decrement after consumption.
                    if (ammo["system.quantity"] !== undefined) ammo["system.quantity"]++;
                }
            });
        }
    }

    static registerChatHooks() {
        LogUtility.log("Registering chat hooks");

        Hooks.on("preCreateChatMessage", (message, data, options, userId) => {
            if (userId !== game.user.id) return;

            // Forward-compat hygiene: dnd5e 5.3's D20Roll constructs its d20 term using
            // Foundry's legacy `Die` class, while Foundry V14 canonicalises on `BasicDie`
            // (the subclass registered at CONFIG.Dice.terms.d, which extends Die with
            // modifier aliases). Sheet-initiated roll messages therefore serialise with
            // `term.class === "Die"` while chat-command rolls serialise as `"BasicDie"`.
            // Rewriting the serialised class so Foundry rebuilds sheet-roll terms as
            // BasicDie aligns RSR-processed messages with the V14 canonical and keeps
            // the stored representation consistent across entry points. The swap is
            // safe because BasicDie extends Die — every method, modifier, and behaviour
            // is inherited, and dnd5e-specific behaviour (advantage mode, elven accuracy,
            // halfling lucky, crit/fumble thresholds) lives on `term.options` as data
            // and is consumed at D20Roll level, not on the Die class itself.
            if (message.rolls?.length) {
                let changed = false;
                const patched = message.rolls.map(roll => {
                    const json = typeof roll.toJSON === "function" ? roll.toJSON() : roll;
                    for (const term of json.terms ?? []) {
                        if (term.class === "Die") {
                            term.class = "BasicDie";
                            changed = true;
                        }
                    }
                    return json;
                });
                if (changed) message.updateSource({ rolls: patched });
            }

            const t = message.type;
            // dnd5e 5.3.0: Usage cards are typed as "usage" (plain string, set in
            // Activity#_createUsageMessage). The "dnd5e.usage" variant and the
            // flags.dnd5e.use / flags.dnd5e.messageType === "usage" checks are kept as
            // fallbacks for messages created by older dnd5e versions that may still exist
            // in a world's chat history or be produced by other modules.
            const isUsage = t === "usage"
                || t === "dnd5e.usage"
                || (!t && (message.flags?.dnd5e?.messageType === "usage" || !!message.flags?.dnd5e?.use));

            if (isUsage && SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ACTIVITY_ENABLED)) {
                const quickVanilla = SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_VANILLA_ENABLED);
                if (quickVanilla) return;

                const flags = message.flags[MODULE_SHORT] || {};
                flags.quickRoll = true;
                flags.processed = false;

                const activity = ActivityUtility._getActivityFromMessage(message);

                if (activity) {
                    const hasAttack = activity.type === "attack" || !!activity.attack || activity.hasOwnProperty("attack");
                    const hasDamage = activity.type === "damage" || !!activity.damage || activity.type === "attack" || activity.type === "save" || activity.hasOwnProperty("damage");
                    const hasHealing = activity.type === "heal" || !!activity.healing || activity.hasOwnProperty("healing");
                    const hasFormula = activity.type === "utility" || !!activity.roll || activity.hasOwnProperty("formula");

                    if (hasAttack) flags.renderAttack = true;

                    const manualDamageMode = SettingsUtility.getSettingValue(SETTING_NAMES.MANUAL_DAMAGE_MODE);
                    if (hasDamage) {
                        flags.manualDamage = (manualDamageMode === 2 || (manualDamageMode === 1 && hasAttack));
                        flags.renderDamage = !flags.manualDamage;
                    }

                    if (hasHealing) {
                        flags.isHealing = true;
                        flags.renderDamage = true;
                    }

                    if (hasFormula) {
                        flags.renderFormula = true;
                        const fName = activity.roll?.name || activity.formula?.name;
                        if (fName && fName !== "") flags.formulaName = fName;
                    }
                } else {
                    LogUtility.logError("Could not resolve activity during preCreate.");
                }

                message.updateSource({ [`flags.${MODULE_SHORT}`]: flags });
            }
        });

        Hooks.on("renderChatMessageHTML", (message, html) => {
            const $html = html instanceof HTMLElement ? $(html) : html;
            ChatUtility.processChatMessage(message, html);
            BonusManager.init(message, $html);
            if (html instanceof HTMLElement || html[0] instanceof HTMLElement) {
                const element = html instanceof HTMLElement ? html : html[0];
                const observer = new MutationObserver(() => BonusManager.init(message, $(element)));
                observer.observe(element, { childList: true, subtree: true });
                setTimeout(() => observer.disconnect(), 15000);
            }
            if ($html.find('.dice-tooltip .dice-rolls .roll.die').length > 0) {
                $html.find('.dice-tooltip .dice-rolls .roll.die').addClass('rsr-ready');
            }
        });

        // dnd5e 5.3.0: For usage (activity) messages, ChatMessage5e.renderHTML() calls
        // system.getHTML() after the renderChatMessageHTML hook, which completely replaces
        // .message-content innerHTML. RSR's injection for activity cards must therefore
        // happen here, after system.getHTML() has finished rewriting the DOM.
        Hooks.on(HOOKS_DND5E.RENDER_CHAT_MESSAGE, (message, html) => {
            ChatUtility.processUsageChatMessage(message, html);
        });
    }

    static registerSheetHooks() {}
    static registerIntegrationHooks() {}
}
