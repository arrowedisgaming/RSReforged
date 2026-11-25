import { beforeEach, describe, expect, it } from "vitest";

const { CoreUtility } = await import("../src/utils/core.js");

describe("CoreUtility.areKeysPressed", () => {
    beforeEach(() => {
        globalThis.foundry = {
            helpers: {
                interaction: {
                    KeyboardManager: {
                        MODIFIER_KEYS: {
                            CONTROL: "Control",
                            SHIFT: "Shift",
                            ALT: "Alt"
                        },
                        MODIFIER_CODES: {
                            Control: ["ControlLeft", "ControlRight", "MetaLeft", "MetaRight"],
                            Shift: ["ShiftLeft", "ShiftRight"],
                            Alt: ["AltLeft", "AltRight"]
                        }
                    }
                }
            }
        };
    });

    it("recognizes the default Shift keybinding used by dnd5e Skip Dialog", () => {
        globalThis.game = {
            keyboard: { downKeys: new Set() },
            keybindings: {
                get: () => [{ key: "Shift", modifiers: [] }]
            }
        };

        expect(CoreUtility.areKeysPressed({ shiftKey: true }, "skipDialogNormal")).toBe(true);
        expect(CoreUtility.areKeysPressed({ shiftKey: false }, "skipDialogNormal")).toBe(false);
    });

    it("recognizes physical Shift codes from Foundry modifier aliases", () => {
        globalThis.game = {
            keyboard: { downKeys: new Set() },
            keybindings: {
                get: () => [{ key: "ShiftLeft", modifiers: [] }]
            }
        };

        expect(CoreUtility.areKeysPressed({ shiftKey: true }, "skipDialogNormal")).toBe(true);
    });
});

describe("CoreUtility.localizeFirst", () => {
    const withTranslations = (translations, fallback = {}) => {
        globalThis.game = {
            i18n: {
                has: (key, useFallback = true) => typeof translations[key] === "string"
                    || (useFallback && typeof fallback[key] === "string"),
                localize: (key) => translations[key] ?? fallback[key] ?? key
            }
        };
    };

    it("prefers the first key that exists (dnd5e 6.1 shape)", () => {
        withTranslations({ "DND5E.HEAL.HealingButton.Full": "Healing" });
        expect(CoreUtility.localizeFirst("DND5E.HEAL.HealingButton.Full", "DND5E.HEAL.HealingButton")).toBe("Healing");
    });

    it("falls back to a later key (dnd5e 6.0 shape)", () => {
        withTranslations({ "DND5E.HEAL.HealingButton": "Healing" });
        expect(CoreUtility.localizeFirst("DND5E.HEAL.HealingButton.Full", "DND5E.HEAL.HealingButton")).toBe("Healing");
    });

    it("prefers an active-language translation on an older key over an English fallback", () => {
        withTranslations(
            { "DND5E.HEAL.HealingButton": "Soins" },
            { "DND5E.HEAL.HealingButton.Full": "Healing" }
        );
        expect(CoreUtility.localizeFirst("DND5E.HEAL.HealingButton.Full", "DND5E.HEAL.HealingButton")).toBe("Soins");
    });

    it("uses the English fallback when the active language has no candidate", () => {
        withTranslations({}, { "DND5E.HEAL.HealingButton.Full": "Healing" });
        expect(CoreUtility.localizeFirst("DND5E.HEAL.HealingButton.Full", "DND5E.HEAL.HealingButton")).toBe("Healing");
    });

    it("localizes the last key when none exist", () => {
        withTranslations({});
        expect(CoreUtility.localizeFirst("A.Missing", "B.Missing")).toBe("B.Missing");
    });
});
