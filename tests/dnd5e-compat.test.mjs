import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

const REQUIRED_NATIVE_MODELS = ["attack", "damage", "healing", "check", "save", "generic"];

function installNativeModels(names = REQUIRED_NATIVE_MODELS) {
    CONFIG.ChatMessage = {
        dataModels: Object.fromEntries(names.map(name => [name, class {}]))
    };
}

describe("dnd5e compatibility reads", () => {
    let compat;

    beforeEach(async () => {
        vi.resetModules();
        await setupFoundryEnv();
        game.system = { version: "6.0.1" };
        installNativeModels();
        compat = await import("../src/utils/dnd5e-compat.js");
    });

    it.each([
        [{ type: "attack", system: {} }, "attack"],
        [{ type: "damage", system: {} }, "damage"],
        [{ type: "check", system: { type: "ability" } }, "ability"],
        [{ type: "generic", system: {}, rolls: [{ formula: "1d6" }] }, "roll"],
        [{ type: "base", rolls: [{ formula: "1d6" }] }, "roll"],
        [{ type: "base", rolls: [] }, null],
        [{ type: "check", system: { skill: "ste" } }, "skill"],
        [{ type: "check", system: { tool: "thief" } }, "tool"],
        [{ type: "check", system: { type: "initiative" } }, "initiative"],
        [{ type: "save", system: { type: "death" } }, "death"],
        [{ type: "save", system: { type: "concentration" } }, "concentration"],
        [{ type: "save", system: { type: "ability" } }, "save"],
        [{ type: "healing", system: {} }, "healing"],
        [{ type: "usage", system: {} }, "activity"]
    ])("classifies native message %j as %s", (message, expected) => {
        expect(compat.getRollType(message)).toBe(expected);
    });

    it("leaves a generic non-roll model unclassified", () => {
        expect(compat.getRollType({ type: "generic", system: {}, rolls: [] })).toBeNull();
        expect(compat.getRollType({ type: "generic", system: {} })).toBeNull();
    });

    it.each([
        [{ type: "usage", flags: { dnd5e: { roll: { type: "damage" } } } }, "activity"],
        [{ type: "check", system: { skill: "ste" }, flags: { dnd5e: { roll: { type: "save" } } } }, "skill"],
        [{ type: "save", system: { type: "death" }, flags: { dnd5e: { roll: { type: "concentration" } } } }, "death"]
    ])("prefers native message metadata over conflicting legacy flags", (message, expected) => {
        expect(compat.getRollType(message)).toBe(expected);
    });

    it.each([
        [{ type: "roll", flags: { dnd5e: { roll: { type: "skill" } } } }, "skill"],
        [{ type: "dnd5e.roll", system: { roll: { type: "tool" } } }, "tool"],
        [{ flags: { dnd5e: { messageType: "usage" } } }, "activity"],
        [{ flags: { dnd5e: { use: { itemId: "item-1" } } } }, "activity"],
        [{ flags: { dnd5e: { messageType: "roll", roll: { type: "death" } } } }, "death"]
    ])("keeps legacy message classification for %j", (message, expected) => {
        expect(compat.getRollType(message)).toBe(expected);
    });

    it("normalizes raw and prepared native origins before falling back to legacy flags", () => {
        expect(compat.getOriginId({
            _source: { system: { origin: "raw-origin" } },
            system: { origin: { id: "prepared-origin" } },
            flags: { dnd5e: { originatingMessage: "legacy-origin" } }
        })).toBe("raw-origin");

        expect(compat.getOriginId({ system: { origin: { id: "prepared-origin" } } })).toBe("prepared-origin");
        expect(compat.getOriginId({ system: { origin: { _id: "prepared-underscore" } } })).toBe("prepared-underscore");
        expect(compat.getOriginId({ flags: { dnd5e: { originatingMessage: "legacy-origin" } } })).toBe("legacy-origin");
    });

    it("treats an explicit native origin as authoritative over a conflicting legacy origin", () => {
        expect(compat.getOriginId({
            system: { origin: "native-origin" },
            flags: { dnd5e: { originatingMessage: "legacy-origin" } }
        })).toBe("native-origin");
        expect(compat.getOriginId({
            system: { origin: null },
            flags: { dnd5e: { originatingMessage: "legacy-origin" } }
        })).toBeNull();
    });

    it("prefers native targets, including an explicit empty array", () => {
        const nativeTargets = [{ actor: "Actor.native", token: "Scene.s.Token.t" }];
        const legacyTargets = [{ uuid: "Scene.legacy.Token.old" }];

        expect(compat.getTargets({
            system: { targets: nativeTargets },
            flags: { dnd5e: { targets: legacyTargets } }
        })).toBe(nativeTargets);
        expect(compat.getTargets({
            system: { targets: [] },
            flags: { dnd5e: { targets: legacyTargets } }
        })).toEqual([]);
        expect(compat.getTargets({ flags: { dnd5e: { targets: legacyTargets } } })).toBe(legacyTargets);
        expect(compat.getTargets({})).toBeUndefined();
    });

    it.each([
        ["5.3.0", true, false],
        ["5.3.3", true, false],
        ["6.0.0", true, true],
        ["6.0.1", true, true],
        ["6.0.1", false, false],
        ["7.0.0", true, false],
        [undefined, true, false]
    ])("selects native workflow for version %s with capabilities=%s", (version, hasCapabilities, expected) => {
        game.system.version = version;
        installNativeModels(hasCapabilities ? REQUIRED_NATIVE_MODELS : REQUIRED_NATIVE_MODELS.slice(0, -1));

        expect(compat.usesNativeWorkflow()).toBe(expected);
    });
});

describe("modern configuration and classification consumers", () => {
    let BonusManager;
    let ChatUtility;
    let MODULE_SHORT;
    let RollUtility;

    beforeEach(async () => {
        vi.resetModules();
        await setupFoundryEnv();
        ({ MODULE_SHORT } = await import("../src/module/const.js"));
        ({ RollUtility } = await import("../src/utils/roll.js"));
        ({ ChatUtility } = await import("../src/utils/chat.js"));
        ({ BonusManager } = await import("../src/utils/bonus.js"));
    });

    it("configures a roll when dnd5e supplies type and system without flags", () => {
        const message = { data: { type: "check", system: {}, foreign: "kept" } };
        const dialog = { configure: true };

        expect(() => RollUtility.processRoll({ event: {} }, dialog, message)).not.toThrow();
        expect(dialog.configure).toBe(false);
        expect(message.data.foreign).toBe("kept");
        expect(message.data.flags[MODULE_SHORT]).toMatchObject({ quickRoll: true, processed: true });
    });

    it("merges roll state into existing module flags and preserves foreign flags", () => {
        const message = {
            data: {
                type: "check",
                system: {},
                flags: {
                    foreign: { marker: 1 },
                    [MODULE_SHORT]: { captureId: "capture-1", listenerValue: 2 }
                }
            }
        };

        RollUtility.processRoll({ event: {} }, {}, message);

        expect(message.data.flags.foreign).toEqual({ marker: 1 });
        expect(message.data.flags[MODULE_SHORT]).toMatchObject({
            captureId: "capture-1",
            listenerValue: 2,
            quickRoll: true,
            processed: true
        });
    });

    it("configures an activity from messageConfig without flags while preserving message fields", () => {
        const messageConfig = { data: { type: "usage", system: {}, foreign: "kept" } };
        const usageConfig = { event: {} };
        const dialog = { configure: true };

        expect(() => RollUtility.processActivity({}, usageConfig, dialog, messageConfig)).not.toThrow();
        expect(dialog.configure).toBe(false);
        expect(messageConfig.data.foreign).toBe("kept");
        expect(messageConfig.data.flags[MODULE_SHORT]).toMatchObject({ quickRoll: true, processed: false });
    });

    it("merges activity state into existing module flags and preserves foreign flags", () => {
        const messageConfig = {
            data: {
                type: "usage",
                system: {},
                flags: {
                    foreign: { marker: 1 },
                    [MODULE_SHORT]: { captureId: "capture-2", listenerValue: 3 }
                }
            }
        };

        RollUtility.processActivity({}, { event: {} }, {}, messageConfig);

        expect(messageConfig.data.flags.foreign).toEqual({ marker: 1 });
        expect(messageConfig.data.flags[MODULE_SHORT]).toMatchObject({
            captureId: "capture-2",
            listenerValue: 3,
            quickRoll: true,
            processed: false
        });
    });

    it("exposes modern native classification through ChatUtility", () => {
        expect(ChatUtility.getMessageType({ type: "check", system: { skill: "ste" } })).toBe("skill");
        expect(ChatUtility.getMessageType({ type: "damage", system: {} })).toBe("damage");
    });

    it("uses native rolls for modern typed messages even when a stale legacy cache exists", () => {
        const nativeRoll = { formula: "1d20+5" };
        const staleRoll = { class: "Roll", formula: "1d4" };
        const message = {
            type: "attack",
            system: {},
            rolls: [nativeRoll],
            flags: { [MODULE_SHORT]: { rolls: [staleRoll] } }
        };

        expect(ChatUtility.getMessageRolls(message)).toEqual([nativeRoll]);
    });

    it.each([
        [{ type: "check", system: { skill: "ste" } }, "skill"],
        [{ type: "check", system: { tool: "thief" } }, "tool"],
        [{ type: "check", system: { type: "ability" } }, "check"],
        [{ type: "save", system: { type: "ability" } }, "save"],
        [{ type: "save", system: { type: "death" } }, "death"],
        [{ type: "save", system: { type: "concentration" } }, "concentration"],
        [{ type: "check", system: { type: "initiative" } }, "initiative"]
    ])("adds a %s bonus control for a modern message", (messageData, expectedType) => {
        const message = { ...messageData, isAuthor: true, flags: {} };
        const html = $(`<article><header class="message-header"></header></article>`);

        expect(BonusManager.init(message, html)).toBe(true);
        expect(html.find(`.rsr-addon-bonus-btn[data-type="${expectedType}"]`)).toHaveLength(1);
    });
});
