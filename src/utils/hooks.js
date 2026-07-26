import { BonusManager } from "./bonus.js";
import { RerollManager } from "./reroll.js";
import { MODULE_NAME, MODULE_SHORT, MODULE_TITLE } from "../module/const.js";
import { ActivityUtility } from "./activity.js";
import { ChatUtility } from "./chat.js";
import { CoreUtility } from "./core.js";
import { LogUtility } from "./log.js";
import { KEYBIND_VERSATILE_TWO_HANDED, ROLL_TYPE, RollUtility } from "./roll.js";
import { SETTING_NAMES, SettingsUtility, HIDE_NPC_ROLL_MODES } from "./settings.js";

export const HOOKS_CORE = { INIT: "init", READY: "ready" }

export const HOOKS_DND5E = {
    PRE_ROLL_ABILITY_CHECK: "dnd5e.preRollAbilityCheck",
    PRE_ROLL_SAVING_THROW: "dnd5e.preRollSavingThrow",
    PRE_ROLL_SKILL: "dnd5e.preRollSkill",
    PRE_ROLL_TOOL_CHECK: "dnd5e.preRollTool",
    PRE_ROLL_ATTACK: "dnd5e.preRollAttack",
    POST_ROLL_CONFIGURATION: "dnd5e.postRollConfiguration",
    PRE_ROLL_DAMAGE: "dnd5e.preRollDamage",
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
            HooksUtility.registerKeybindings();
            HooksUtility.registerRollHooks();
            HooksUtility.registerChatHooks();
            RerollManager.registerGlobalListener();
        });

        Hooks.on(HOOKS_CORE.READY, async () => {
            CONFIG[MODULE_SHORT].combinedDamageTypes = foundry.utils.mergeObject(
                Object.fromEntries(Object.entries(CONFIG.DND5E.damageTypes).map(([k, v]) => [k, v.label])),
                Object.fromEntries(Object.entries(CONFIG.DND5E.healingTypes).map(([k, v]) => [k, v.label])),
                { recursive: false }
            );
            CONFIG.DND5E.aggregateDamageDisplay = SettingsUtility.getSettingValue(SETTING_NAMES.AGGREGATE_DAMAGE) ?? true;
            await _migrateHideNpcRollSetting().catch(err => LogUtility.logError(`Failed to migrate hide NPC roll setting: ${err}`));
            LogUtility.log(`Loaded ${MODULE_TITLE}`);
        });
    }

    /**
     * Register RSReforged-namespaced keybindings. Must be called during `init` —
     * Foundry rejects keybinding registration once the game is ready.
     *
     * `versatileTwoHanded` defaults to KeyV (matching Midi-QOL's convention) and
     * is rebindable through Foundry's *Configure Controls* UI. The keybinding does
     * not need an `onDown`/`onUp` handler: we read the held state at click time
     * via `game.keyboard.downKeys`, which Foundry maintains regardless of whether
     * a handler is attached. The registration exists purely so the binding shows
     * up in Configure Controls with a localised name.
     */
    static registerKeybindings() {
        LogUtility.log("Registering keybindings");

        game.keybindings.register(MODULE_NAME, KEYBIND_VERSATILE_TWO_HANDED, {
            name: CoreUtility.localize(`${MODULE_SHORT}.keybindings.versatileTwoHanded.name`),
            hint: CoreUtility.localize(`${MODULE_SHORT}.keybindings.versatileTwoHanded.hint`),
            editable: [{ key: "KeyV" }],
            restricted: false,
            precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
        });
    }

    static registerRollHooks() {
        LogUtility.log("Registering roll hooks");

        Hooks.on(HOOKS_DND5E.PRE_ROLL_ABILITY_CHECK, (config, dialog, message) => {
            // dnd5e fires preRollAbilityCheck for skill and tool checks too (their
            // hookNames chain is [type, "abilityCheck", "d20Test"]). Defer to
            // PRE_ROLL_SKILL / PRE_ROLL_TOOL_CHECK so each category's setting controls
            // its own roll path instead of QUICK_ABILITY_ENABLED hijacking them.
            if (config.hookNames?.some(n => n === "skill" || n === "tool")) return true;

            if (SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ABILITY_ENABLED)) {
                RollUtility.processRoll(config, dialog, message);
            }
            return true;
        });
        Hooks.on(HOOKS_DND5E.PRE_ROLL_SAVING_THROW, (config, dialog, message) => {
            if (SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ABILITY_ENABLED)) {
                RollUtility.processRoll(config, dialog, message);
            }
            return true;
        });

        Hooks.on(HOOKS_DND5E.PRE_ROLL_SKILL, (config, dialog, message) => {
            if (SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_SKILL_ENABLED)) {
                RollUtility.processRoll(config, dialog, message);
            }
            return true;
        });

        Hooks.on(HOOKS_DND5E.PRE_ROLL_TOOL_CHECK, (config, dialog, message) => {
            if (SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_TOOL_ENABLED)) {
                RollUtility.processRoll(config, dialog, message);
            }
            return true;
        });

        // dnd5e 5.3.0: processActivity sets usageConfig.subsequentActions = false on the
        // quick-roll path to prevent the system from auto-triggering attack/damage rolls
        // after item use — RSR drives those itself via preCreateChatMessage +
        // ActivityUtility.runActivityActions(). Slow-roll (shift-click) leaves
        // subsequentActions alone so dnd5e's _triggerSubsequentActions can fire the
        // follow-up rolls after the usage dialog closes.
        Hooks.on(HOOKS_DND5E.PRE_USE_ACTIVITY, (activity, usageConfig, dialogConfig, messageConfig) => {
            if (
                SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ACTIVITY_ENABLED)
                && !SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_VANILLA_ENABLED)
            ) {
                RollUtility.processActivity(activity, usageConfig, dialogConfig, messageConfig);
            }
            return true;
        });

        Hooks.on(HOOKS_DND5E.PRE_ROLL_ATTACK, (config, dialog, message) => {
            if (
                !SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ACTIVITY_ENABLED)
                || SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_VANILLA_ENABLED)
            ) return true;

            const flags = message?.flags || message?.data?.flags;
            if (!flags || !flags[MODULE_SHORT]?.quickRoll) return true;

            for (const roll of config.rolls) {
                roll.options.advantage ??= config.advantage;
                roll.options.disadvantage ??= config.disadvantage;
            }
            dialog.configure = false;
            return true;
        });

        // The last configuration hook dnd5e fires before a roll is evaluated. An attack
        // fires three in sequence — postAttackRollConfiguration, postD20TestRollConfiguration,
        // postRollConfiguration — as BasicRoll.buildConfigure walks config.hookNames, so
        // only this one is guaranteed to run after every listener that adjusts a roll
        // against its targets (cover, condition automation) has rewritten the pending
        // message configuration.
        //
        // RSR rolls with create:false, so dnd5e discards that configuration; without this
        // capture the card keeps the target descriptors Activity#use stamped on it before
        // the roll, which predate all of those adjustments (issue #38).
        //
        // Registered for every roll type rather than just attacks: captureRollMessageConfig
        // no-ops unless the config carries RSR's own correlation token, which is cheaper
        // and more robust than re-deriving the quick-roll settings here. Must not return
        // false — dnd5e treats that as a veto and cancels the roll.
        Hooks.on(HOOKS_DND5E.POST_ROLL_CONFIGURATION, (rolls, config, dialog, message) => {
            ActivityUtility.captureRollMessageConfig(message);
        });

        Hooks.on(HOOKS_DND5E.PRE_ROLL_DAMAGE, (config, dialog, message) => {
            if (
                !SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ACTIVITY_ENABLED)
                || SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_VANILLA_ENABLED)
            ) return true;

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
            if (
                !SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ACTIVITY_ENABLED)
                || SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_VANILLA_ENABLED)
            ) return;

            // processActivity seeds this namespace during preUseActivity for both RSR
            // quick rolls and RSR-managed slow rolls. dnd5e's later chat-card
            // "Consume Resource" action invokes this same hook with an empty
            // messageConfig and no rollAttack follows, so capturing/restoring ammo in
            // that path would both overwrite card state and cancel real consumption.
            const moduleFlags = messageConfig.data?.flags?.[MODULE_SHORT];
            if (!moduleFlags) return;

            const hasAttack = activity.type === "attack" || !!activity.attack || activity.hasOwnProperty(ROLL_TYPE.ATTACK);
            const items = updates.item;

            if (hasAttack && items && items.length > 0) {
                const ammo = items.find(i => i["system.quantity"] !== undefined || i["system.uses.spent"] !== undefined);
                if (!ammo) return;

                moduleFlags.ammunition = ammo._id;

                // Add back the single unit that dnd5e's rollAttack will itself decrement, but
                // only when this item is a valid weapon-ammunition option that reaches
                // rolls[].options.ammunition (dnd5e.mjs AttackActivity#rollAttack) — otherwise
                // the consumption phase and the attack roll would each spend one. A standalone
                // "material"/Consume-Resource target (e.g. a vehicle cannon's cannonballs) is
                // decremented ONLY by the consumption phase, so adding one back here would
                // cancel a unit of its consumption (issue #34).
                if (ammo["system.quantity"] !== undefined) {
                    const isWeaponAmmo = activity.item?.system?.ammunitionOptions?.some(o => o.value === ammo._id);
                    if (isWeaponAmmo) ammo["system.quantity"]++;
                }
            }
        });
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
                const patched = CoreUtility.serializeRolls(message.rolls);
                for (const json of patched) {
                    for (const term of json.terms ?? []) {
                        if (term.class === "Die") {
                            term.class = "BasicDie";
                            changed = true;
                        }
                    }
                }
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

                const flags = { ...(message.flags?.[MODULE_SHORT] || {}) };
                flags.quickRoll ??= true;
                flags.processed ??= false;

                const activity = ActivityUtility._getActivityFromMessage(message);

                if (activity) {
                    // Single source of truth for render-flag derivation (activity.js).
                    ActivityUtility.setRenderFlags(activity, flags);
                } else if (flags.quickRoll) {
                    // Slow-roll messages are driven by dnd5e's dialog path; only quick-roll
                    // messages need an immediately resolvable activity for RSR rendering.
                    // Not fatal: runActivityActions retries resolution at render time,
                    // when the persisted document's getAssociatedActivity is available.
                    LogUtility.logWarning("Could not resolve activity during preCreate; will retry at render.");
                }

                message.updateSource({ [`flags.${MODULE_SHORT}`]: flags });
            }
        });

        Hooks.on("renderChatMessageHTML", (message, html) => {
            const $html = html instanceof HTMLElement ? $(html) : html;
            // Self-heal before suppressing: if a previous render pass failed before
            // dnd5e.renderChatMessage could restore the suppressed roll flag (e.g.
            // another module's render handler threw mid-chain), restore it now so the
            // in-memory document never diverges across renders.
            ChatUtility.restoreDnd5eEnrichedRollFlavor(message);
            ChatUtility.suppressDnd5eEnrichedRollFlavor(message);
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
            ChatUtility.restoreDnd5eEnrichedRollFlavor(message);
            ChatUtility.processUsageChatMessage(message, html);
        });
    }

    static registerSheetHooks() {}
    static registerIntegrationHooks() {}
}

async function _migrateHideNpcRollSetting() {
    // Both settings are world-scoped and only GMs may write those, so non-GM
    // clients must not attempt the migration (the set call would throw).
    if (!game.user.isGM) return;

    const legacyEnabled = SettingsUtility.getSettingValue(SETTING_NAMES.HIDE_FINAL_RESULT_ENABLED);
    if (!legacyEnabled) return;

    const currentMode = SettingsUtility.getSettingValue(SETTING_NAMES.HIDE_NPC_ROLL_MODE);
    if (currentMode === HIDE_NPC_ROLL_MODES.NONE) {
        await game.settings.set(MODULE_NAME, SETTING_NAMES.HIDE_NPC_ROLL_MODE, HIDE_NPC_ROLL_MODES.ATTACKS);
    }

    // Clear the legacy flag so the migration is one-shot. Without this, a GM who
    // deliberately sets the new mode back to "none" would have it silently forced
    // back to "attacks" on every subsequent reload.
    await game.settings.set(MODULE_NAME, SETTING_NAMES.HIDE_FINAL_RESULT_ENABLED, false);
}
