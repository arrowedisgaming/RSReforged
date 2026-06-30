import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

describe("SettingsUtility and CoreUtility configuration behavior", () => {
    let env;
    let CoreUtility;
    let HooksUtility;
    let SettingsUtility;
    let SETTING_NAMES;
    let HIDE_NPC_ROLL_MODES;
    let HIDE_NPC_ROLL_STYLES;
    let ROLL_TYPE;

    beforeEach(async () => {
        vi.resetModules();
        env = await setupFoundryEnv();
        ({ CoreUtility } = await import("../src/utils/core.js"));
        ({ SettingsUtility, SETTING_NAMES, HIDE_NPC_ROLL_MODES, HIDE_NPC_ROLL_STYLES } = await import("../src/utils/settings.js"));
        ({ ROLL_TYPE } = await import("../src/utils/roll.js"));
        ({ HooksUtility } = await import("../src/utils/hooks.js"));
    });

    it("registers the module settings that drive quick rolls, damage buttons, cards, and rerolls", () => {
        SettingsUtility.registerSettings();

        expect([...env.registeredSettings.keys()]).toEqual(expect.arrayContaining([
            SETTING_NAMES.QUICK_VANILLA_ENABLED,
            SETTING_NAMES.QUICK_ABILITY_ENABLED,
            SETTING_NAMES.QUICK_SKILL_ENABLED,
            SETTING_NAMES.QUICK_TOOL_ENABLED,
            SETTING_NAMES.QUICK_ACTIVITY_ENABLED,
            SETTING_NAMES.MANUAL_DAMAGE_MODE,
            SETTING_NAMES.DAMAGE_APPLY_MODE,
            SETTING_NAMES.DAMAGE_BUTTONS_ENABLED,
            SETTING_NAMES.HIDE_NPC_ROLL_MODE,
            SETTING_NAMES.HIDE_FINAL_RESULT_ENABLED,
            SETTING_NAMES.APPLY_DAMAGE_TO,
            SETTING_NAMES.REROLL_EVERYONE,
            SETTING_NAMES.REROLL_PLAYERS,
            SETTING_NAMES.FUDGE_GM,
            SETTING_NAMES.REROLL_SOUND_ENABLED,
            SETTING_NAMES.REROLL_LOG_CHAT
        ]));

        expect(env.registeredSettings.get(SETTING_NAMES.HIDE_NPC_ROLL_MODE)).toMatchObject({
            scope: "world",
            type: String,
            default: "none",
            config: true
        });
        expect(env.registeredSettings.get(SETTING_NAMES.HIDE_FINAL_RESULT_ENABLED)).toMatchObject({
            scope: "world",
            type: Boolean,
            config: false
        });

        expect(env.registeredSettings.get(SETTING_NAMES.QUICK_VANILLA_ENABLED)).toMatchObject({
            scope: "world",
            type: Boolean,
            default: false
        });
        expect(env.registeredSettings.get(SETTING_NAMES.MANUAL_DAMAGE_MODE).choices).toHaveProperty("2");
        expect(env.registeredSettings.get(SETTING_NAMES.DAMAGE_APPLY_MODE).choices).toMatchObject({
            dnd5e: expect.any(String),
            rsr: expect.any(String)
        });
    });

    it("registers hideNpcRollStyle as a world choice setting defaulting to total", () => {
        SettingsUtility.registerSettings();
        expect(env.registeredSettings.get(SETTING_NAMES.HIDE_NPC_ROLL_STYLE)).toMatchObject({
            scope: "world",
            config: true,
            type: String,
            default: HIDE_NPC_ROLL_STYLES.TOTAL
        });
    });

    it("getHideNpcRollStyle returns the configured style and defaults to total", () => {
        env.settings.hideNpcRollStyle = HIDE_NPC_ROLL_STYLES.BREAKDOWN;
        expect(SettingsUtility.getHideNpcRollStyle()).toBe(HIDE_NPC_ROLL_STYLES.BREAKDOWN);

        env.settings.hideNpcRollStyle = HIDE_NPC_ROLL_STYLES.TOTAL;
        expect(SettingsUtility.getHideNpcRollStyle()).toBe(HIDE_NPC_ROLL_STYLES.TOTAL);
    });

    it("registers the versatile two-handed keybinding under the module namespace", () => {
        HooksUtility.registerKeybindings();

        expect(game.keybindings.register).toHaveBeenCalledWith(
            "rsreforged",
            "versatileTwoHanded",
            expect.objectContaining({
                editable: [{ key: "KeyV" }],
                restricted: false
            })
        );
    });

    it("applies to selected tokens only with the registered default (applyDamageTo 0)", async () => {
        const selected = { id: "selected" };
        const targeted = { id: "targeted" };
        // No applyDamageTo override — exercises the real registered default of 0.
        env = await setupFoundryEnv({
            controlled: [selected],
            targets: [targeted]
        });

        expect(CoreUtility.getCurrentTargets()).toEqual(new Set([selected]));
    });

    it("applies to targeted tokens only when applyDamageTo is 1", async () => {
        const selected = { id: "selected" };
        const targeted = { id: "targeted" };
        env = await setupFoundryEnv({
            settings: { applyDamageTo: 1 },
            controlled: [selected],
            targets: [targeted]
        });

        expect(CoreUtility.getCurrentTargets()).toEqual(new Set([targeted]));
    });

    it("combines selected and targeted tokens when applyDamageTo is 2", async () => {
        const selected = { id: "selected" };
        const targeted = { id: "targeted" };
        env = await setupFoundryEnv({
            settings: { applyDamageTo: 2 },
            controlled: [selected],
            targets: [targeted]
        });

        expect(CoreUtility.getCurrentTargets()).toEqual(new Set([selected, targeted]));
    });

    it("prioritizes selected tokens in selected-first mode", async () => {
        const selected = { id: "selected" };
        const targeted = { id: "targeted" };
        await setupFoundryEnv({
            settings: { applyDamageTo: 3 },
            controlled: [selected],
            targets: [targeted]
        });

        expect(CoreUtility.getCurrentTargets()).toEqual(new Set([selected]));
    });

    it("prioritizes targeted tokens in targeted-first mode", async () => {
        const selected = { id: "selected" };
        const targeted = { id: "targeted" };
        await setupFoundryEnv({
            settings: { applyDamageTo: 4 },
            controlled: [selected],
            targets: [targeted]
        });

        expect(CoreUtility.getCurrentTargets()).toEqual(new Set([targeted]));
    });

    it("scopes hide NPC roll totals by mode and never hides damage", () => {
        env.settings.hideNpcRollMode = HIDE_NPC_ROLL_MODES.NONE;
        expect(SettingsUtility.shouldHideNpcRollTotal(ROLL_TYPE.ATTACK)).toBe(false);
        expect(SettingsUtility.shouldHideNpcRollTotal(ROLL_TYPE.SKILL)).toBe(false);

        env.settings.hideNpcRollMode = HIDE_NPC_ROLL_MODES.ATTACKS;
        expect(SettingsUtility.shouldHideNpcRollTotal(ROLL_TYPE.ATTACK)).toBe(true);
        expect(SettingsUtility.shouldHideNpcRollTotal(ROLL_TYPE.SKILL)).toBe(false);
        expect(SettingsUtility.shouldHideNpcRollTotal(ROLL_TYPE.DAMAGE)).toBe(false);

        env.settings.hideNpcRollMode = HIDE_NPC_ROLL_MODES.ALL;
        expect(SettingsUtility.shouldHideNpcRollTotal(ROLL_TYPE.SKILL)).toBe(true);
        expect(SettingsUtility.shouldHideNpcRollTotal(ROLL_TYPE.ABILITY_SAVE)).toBe(true);
        expect(SettingsUtility.shouldHideNpcRollTotal(ROLL_TYPE.DAMAGE)).toBe(false);
        expect(SettingsUtility.shouldHideNpcRollTotal(ROLL_TYPE.HEALING)).toBe(false);
    });

    it("honors the legacy hide flag as attacks-only before the GM migration runs", () => {
        // Upgraded world, mode still default "none", but the legacy boolean is still
        // set because no GM has run the ready migration yet (non-GMs never do). NPC
        // attack totals must stay hidden in this window rather than briefly leaking.
        env.settings.hideNpcRollMode = HIDE_NPC_ROLL_MODES.NONE;
        env.settings.enableHideFinalResult = true;

        expect(SettingsUtility.shouldHideNpcRollTotal(ROLL_TYPE.ATTACK)).toBe(true);
        // Legacy behavior was attack-only — it must not start hiding skills/saves.
        expect(SettingsUtility.shouldHideNpcRollTotal(ROLL_TYPE.SKILL)).toBe(false);
        expect(SettingsUtility.shouldHideNpcRollTotal(ROLL_TYPE.DAMAGE)).toBe(false);

        // Once the legacy flag is cleared (post-migration), "none" means none again,
        // so a GM who deliberately sets the mode back to Off is respected.
        env.settings.enableHideFinalResult = false;
        expect(SettingsUtility.shouldHideNpcRollTotal(ROLL_TYPE.ATTACK)).toBe(false);
    });

    it("hides NPC rolls only for non-owners when the mode applies", () => {
        env.settings.hideNpcRollMode = HIDE_NPC_ROLL_MODES.ALL;

        expect(SettingsUtility.shouldHideNpcRollForActor({ isOwner: false }, ROLL_TYPE.SKILL)).toBe(true);
        expect(SettingsUtility.shouldHideNpcRollForActor({ isOwner: true }, ROLL_TYPE.SKILL)).toBe(false);
    });

    it("fails closed for unresolvable actors but never hides from GMs", () => {
        env.settings.hideNpcRollMode = HIDE_NPC_ROLL_MODES.ALL;

        // A null actor means ownership cannot be determined: hide from players...
        expect(SettingsUtility.shouldHideNpcRollForActor(null, ROLL_TYPE.SKILL)).toBe(true);

        // ...but GMs always see full results, even when the actor is unresolvable.
        game.user.isGM = true;
        expect(SettingsUtility.shouldHideNpcRollForActor(null, ROLL_TYPE.SKILL)).toBe(false);
        expect(SettingsUtility.shouldHideNpcRollForActor({ isOwner: false }, ROLL_TYPE.SKILL)).toBe(false);
    });

    it("migrates the legacy hide-final-result boolean to attacks-only mode on ready", async () => {
        SettingsUtility.registerSettings();

        game.user.isGM = true;
        env.settings.enableHideFinalResult = true;
        env.settings.hideNpcRollMode = HIDE_NPC_ROLL_MODES.NONE;
        CONFIG.rsreforged ??= {};

        HooksUtility.registerModuleHooks();
        const readyHandler = Hooks.on.mock.calls.find(([name]) => name === "ready")?.[1];
        expect(readyHandler).toBeTypeOf("function");
        await readyHandler();

        expect(game.settings.set).toHaveBeenCalledWith(
            "rsreforged",
            SETTING_NAMES.HIDE_NPC_ROLL_MODE,
            HIDE_NPC_ROLL_MODES.ATTACKS
        );

        // The legacy flag is cleared so the migration is one-shot: a GM who later
        // sets the mode back to "none" must not have it forced to "attacks" again.
        expect(env.settings.enableHideFinalResult).toBe(false);
        env.settings.hideNpcRollMode = HIDE_NPC_ROLL_MODES.NONE;
        game.settings.set.mockClear();
        await readyHandler();
        expect(game.settings.set).not.toHaveBeenCalled();
    });

    it("does not attempt the world-setting migration on non-GM clients", async () => {
        SettingsUtility.registerSettings();

        env.settings.enableHideFinalResult = true;
        env.settings.hideNpcRollMode = HIDE_NPC_ROLL_MODES.NONE;
        CONFIG.rsreforged ??= {};

        HooksUtility.registerModuleHooks();
        const readyHandler = Hooks.on.mock.calls.find(([name]) => name === "ready")?.[1];
        await readyHandler();

        expect(game.settings.set).not.toHaveBeenCalled();
        expect(env.settings.hideNpcRollMode).toBe(HIDE_NPC_ROLL_MODES.NONE);
    });
});
