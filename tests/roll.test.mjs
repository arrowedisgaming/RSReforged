import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    pressed: {},
    quickVanilla: false
}));

vi.mock("../src/utils/core.js", () => ({
    CoreUtility: {
        areKeysPressed: vi.fn((event, action) => Boolean(event && state.pressed[action])),
        localize: vi.fn((key) => key)
    }
}));

vi.mock("../src/utils/settings.js", async (importOriginal) => ({
    ...(await importOriginal()),
    SettingsUtility: {
        getSettingValue: vi.fn((setting) => {
            if (setting === "enableVanillaQuickRoll") return state.quickVanilla;
            throw new Error(`Unexpected setting read: ${setting}`);
        })
    }
}));

const { MODULE_SHORT } = await import("../src/module/const.js");
const { RollUtility } = await import("../src/utils/roll.js");

function rollInputs({ configure, vanilla = false, processed = false } = {}) {
    return {
        config: { event: {}, vanilla },
        dialog: configure === undefined ? {} : { configure },
        message: {
            data: {
                flags: processed ? { [MODULE_SHORT]: { processed: true } } : {}
            }
        }
    };
}

function activityInputs({ activity = {}, configure, scaling, vanilla = false, type } = {}) {
    return {
        activity,
        usageConfig: { event: {}, vanilla, ...(scaling !== undefined ? { scaling } : {}) },
        dialogConfig: configure === undefined ? {} : { configure },
        messageConfig: {
            data: {
                flags: type ? { dnd5e: { activity: { type } } } : {}
            }
        }
    };
}

describe("RollUtility.processRoll", () => {
    beforeEach(() => {
        state.pressed = {};
        state.quickVanilla = false;
    });

    it("skips the dialog and marks quick roll when no skip-dialog key is held", () => {
        const { config, dialog, message } = rollInputs();

        RollUtility.processRoll(config, dialog, message);

        expect(dialog.configure).toBe(false);
        expect(message.data.flags[MODULE_SHORT]).toMatchObject({
            quickRoll: true,
            processed: true
        });
    });

    it("opens the dialog when shift is held even if dnd5e initialized configure false", () => {
        state.pressed.skipDialogNormal = true;
        const { config, dialog, message } = rollInputs({ configure: false });

        RollUtility.processRoll(config, dialog, message);

        expect(dialog.configure).toBe(true);
        expect(message.data.flags[MODULE_SHORT]).toMatchObject({
            quickRoll: false,
            processed: true
        });
    });

    it("skips the dialog when no shift is held even if dnd5e initialized configure true", () => {
        const { config, dialog, message } = rollInputs({ configure: true });

        RollUtility.processRoll(config, dialog, message);

        expect(dialog.configure).toBe(false);
        expect(message.data.flags[MODULE_SHORT].quickRoll).toBe(true);
    });

    it("opens the dialog for vanilla rolls while preserving current quick-roll flag behavior", () => {
        const { config, dialog, message } = rollInputs({ vanilla: true });

        RollUtility.processRoll(config, dialog, message);

        expect(dialog.configure).toBe(true);
        expect(message.data.flags[MODULE_SHORT].quickRoll).toBe(false);
    });

    it("forces the dialog globally when vanilla workflow with RSR styling is enabled", () => {
        state.quickVanilla = true;
        const { config, dialog, message } = rollInputs();

        RollUtility.processRoll(config, dialog, message);

        expect(dialog.configure).toBe(true);
        expect(message.data.flags[MODULE_SHORT].quickRoll).toBe(true);
    });

    it("does not mutate an already processed message", () => {
        const { config, dialog, message } = rollInputs({ configure: false, processed: true });
        const originalFlags = message.data.flags[MODULE_SHORT];

        RollUtility.processRoll(config, dialog, message);

        expect(dialog.configure).toBe(false);
        expect(message.data.flags[MODULE_SHORT]).toBe(originalFlags);
    });
});

describe("RollUtility.processActivity", () => {
    beforeEach(() => {
        state.pressed = {};
        state.quickVanilla = false;
    });

    it("skips the usage dialog and marks quick roll with no shift", () => {
        const inputs = activityInputs();

        RollUtility.processActivity(inputs.activity, inputs.usageConfig, inputs.dialogConfig, inputs.messageConfig);

        expect(inputs.dialogConfig.configure).toBe(false);
        expect(inputs.messageConfig.data.flags[MODULE_SHORT]).toMatchObject({
            quickRoll: true,
            processed: false
        });
    });

    it("opens the usage dialog and suppresses quick roll when shift is held", () => {
        state.pressed.skipDialogNormal = true;
        const inputs = activityInputs();

        RollUtility.processActivity(inputs.activity, inputs.usageConfig, inputs.dialogConfig, inputs.messageConfig);

        expect(inputs.dialogConfig.configure).toBe(true);
        expect(inputs.messageConfig.data.flags[MODULE_SHORT]).toMatchObject({
            quickRoll: false,
            processed: true
        });
    });

    it("clears the event on slow-roll so dnd5e's downstream dialogs default to showing", () => {
        state.pressed.skipDialogNormal = true;
        const inputs = activityInputs();
        inputs.usageConfig.event = { shiftKey: true, clientX: 100, clientY: 200 };

        RollUtility.processActivity(inputs.activity, inputs.usageConfig, inputs.dialogConfig, inputs.messageConfig);

        expect(inputs.usageConfig.event).toBeNull();
        expect(inputs.usageConfig.subsequentActions).toBeUndefined();
    });

    it("preserves the event and suppresses subsequent actions on quick-roll", () => {
        const original = { clientX: 100, clientY: 200 };
        const inputs = activityInputs();
        inputs.usageConfig.event = original;

        RollUtility.processActivity(inputs.activity, inputs.usageConfig, inputs.dialogConfig, inputs.messageConfig);

        expect(inputs.usageConfig.event).toBe(original);
        expect(inputs.usageConfig.subsequentActions).toBe(false);
    });

    it("preserves the dialog for leveled spells", () => {
        const inputs = activityInputs({
            activity: { item: { type: "spell", system: { level: 1 } } }
        });

        RollUtility.processActivity(inputs.activity, inputs.usageConfig, inputs.dialogConfig, inputs.messageConfig);

        expect(inputs.dialogConfig.configure).toBe(true);
        expect(inputs.messageConfig.data.flags[MODULE_SHORT].quickRoll).toBe(true);
    });

    it("allows cantrip and non-leveled spell activities to quick roll", () => {
        const inputs = activityInputs({
            activity: { item: { type: "spell", system: { level: 0 } } }
        });

        RollUtility.processActivity(inputs.activity, inputs.usageConfig, inputs.dialogConfig, inputs.messageConfig);

        expect(inputs.dialogConfig.configure).toBe(false);
        expect(inputs.messageConfig.data.flags[MODULE_SHORT].quickRoll).toBe(true);
    });

    it("preserves the dialog for order activities", () => {
        const inputs = activityInputs({ activity: { type: "order" } });

        RollUtility.processActivity(inputs.activity, inputs.usageConfig, inputs.dialogConfig, inputs.messageConfig);

        expect(inputs.dialogConfig.configure).toBe(true);
    });

    it("preserves the dialog when scaling is present", () => {
        const inputs = activityInputs({ scaling: 1 });

        RollUtility.processActivity(inputs.activity, inputs.usageConfig, inputs.dialogConfig, inputs.messageConfig);

        expect(inputs.dialogConfig.configure).toBe(true);
    });

    it("preserves the dialog for features with a spellSlots consumption target (Divine Smite)", () => {
        const inputs = activityInputs({
            activity: {
                item: { type: "feat", system: {} },
                consumption: {
                    spellSlot: true,
                    targets: [{ type: "spellSlots", value: "1" }]
                }
            },
            scaling: 0
        });

        RollUtility.processActivity(inputs.activity, inputs.usageConfig, inputs.dialogConfig, inputs.messageConfig);

        expect(inputs.dialogConfig.configure).toBe(true);
        expect(inputs.messageConfig.data.flags[MODULE_SHORT].quickRoll).toBe(true);
    });

    it("does not preserve the dialog for features with no spellSlots target, even if consumption.spellSlot is the default true", () => {
        const inputs = activityInputs({
            activity: {
                item: { type: "feat", system: {} },
                consumption: { spellSlot: true, targets: [] }
            },
            scaling: 0
        });

        RollUtility.processActivity(inputs.activity, inputs.usageConfig, inputs.dialogConfig, inputs.messageConfig);

        expect(inputs.dialogConfig.configure).toBe(false);
        expect(inputs.messageConfig.data.flags[MODULE_SHORT].quickRoll).toBe(true);
    });

    it("preserves the dialog for features with consumption scaling allowed (Lay on Hands)", () => {
        const inputs = activityInputs({
            activity: {
                item: { type: "feat", system: {} },
                consumption: {
                    targets: [{ type: "itemUses", value: "1" }],
                    scaling: { allowed: true }
                }
            },
            scaling: 0
        });

        RollUtility.processActivity(inputs.activity, inputs.usageConfig, inputs.dialogConfig, inputs.messageConfig);

        expect(inputs.dialogConfig.configure).toBe(true);
        expect(inputs.messageConfig.data.flags[MODULE_SHORT].quickRoll).toBe(true);
    });

    it("does not preserve the dialog for features with consumption scaling disallowed", () => {
        const inputs = activityInputs({
            activity: {
                item: { type: "feat", system: {} },
                consumption: {
                    targets: [{ type: "itemUses", value: "1" }],
                    scaling: { allowed: false }
                }
            },
            scaling: 0
        });

        RollUtility.processActivity(inputs.activity, inputs.usageConfig, inputs.dialogConfig, inputs.messageConfig);

        expect(inputs.dialogConfig.configure).toBe(false);
        expect(inputs.messageConfig.data.flags[MODULE_SHORT].quickRoll).toBe(true);
    });

    it("stamps one-handed attackMode on quick versatile weapon rolls when the versatile key is not held", () => {
        const inputs = activityInputs({
            activity: {
                item: { type: "weapon", system: { isVersatile: true } }
            }
        });

        RollUtility.processActivity(inputs.activity, inputs.usageConfig, inputs.dialogConfig, inputs.messageConfig);

        expect(inputs.messageConfig.data.flags[MODULE_SHORT]).toMatchObject({
            quickRoll: true,
            attackMode: "oneHanded",
            versatile: false
        });
    });

    it("stamps two-handed attackMode on quick versatile weapon rolls when the versatile key is held", () => {
        state.pressed.versatileTwoHanded = true;
        const inputs = activityInputs({
            activity: {
                item: { type: "weapon", system: { isVersatile: true } }
            }
        });

        RollUtility.processActivity(inputs.activity, inputs.usageConfig, inputs.dialogConfig, inputs.messageConfig);

        expect(inputs.messageConfig.data.flags[MODULE_SHORT]).toMatchObject({
            quickRoll: true,
            attackMode: "twoHanded",
            versatile: true
        });
    });

    it("does not stamp attackMode on slow versatile rolls because dnd5e owns that dialog path", () => {
        state.pressed.skipDialogNormal = true;
        state.pressed.versatileTwoHanded = true;
        const inputs = activityInputs({
            activity: {
                item: { type: "weapon", system: { isVersatile: true } }
            }
        });

        RollUtility.processActivity(inputs.activity, inputs.usageConfig, inputs.dialogConfig, inputs.messageConfig);

        expect(inputs.dialogConfig.configure).toBe(true);
        expect(inputs.messageConfig.data.flags[MODULE_SHORT].attackMode).toBeUndefined();
        expect(inputs.messageConfig.data.flags[MODULE_SHORT].versatile).toBeUndefined();
    });
});
