import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    handlers: new Map(),
    settings: {
        enableActivityQuickRoll: true,
        enableAbilityQuickRoll: true,
        enableSkillQuickRoll: true,
        enableToolQuickRoll: true,
        enableVanillaQuickRoll: false,
        manualDamageMode: 0
    },
    logError: vi.fn(),
    logWarning: vi.fn(),
    suppressDnd5eEnrichedRollFlavor: vi.fn(),
    restoreDnd5eEnrichedRollFlavor: vi.fn(),
    processChatMessage: vi.fn(),
    processUsageChatMessage: vi.fn(),
    processActivity: vi.fn(),
    processRoll: vi.fn()
}));

vi.mock("../src/utils/activity.js", async () => {
    // Mock activity resolution, but route render-flag derivation through the real
    // setRenderFlags so this stays an integration test of preCreate's single source
    // of truth rather than a re-implementation of it.
    const actual = await vi.importActual("../src/utils/activity.js");
    return {
        ActivityUtility: {
            _getActivityFromMessage: vi.fn((message) => message._activity ?? null),
            setRenderFlags: actual.ActivityUtility.setRenderFlags
        }
    };
});

vi.mock("../src/utils/settings.js", () => ({
    SETTING_NAMES: {
        QUICK_ABILITY_ENABLED: "enableAbilityQuickRoll",
        QUICK_ACTIVITY_ENABLED: "enableActivityQuickRoll",
        QUICK_SKILL_ENABLED: "enableSkillQuickRoll",
        QUICK_TOOL_ENABLED: "enableToolQuickRoll",
        QUICK_VANILLA_ENABLED: "enableVanillaQuickRoll",
        MANUAL_DAMAGE_MODE: "manualDamageMode"
    },
    SettingsUtility: {
        getSettingValue: vi.fn((setting) => {
            if (Object.hasOwn(state.settings, setting)) return state.settings[setting];
            throw new Error(`Unexpected setting read: ${setting}`);
        })
    }
}));

vi.mock("../src/utils/log.js", () => ({
    LogUtility: {
        log: vi.fn(),
        logError: state.logError,
        logWarning: state.logWarning
    }
}));

vi.mock("../src/utils/bonus.js", () => ({ BonusManager: { init: vi.fn() } }));
vi.mock("../src/utils/chat.js", () => ({
    ChatUtility: {
        suppressDnd5eEnrichedRollFlavor: state.suppressDnd5eEnrichedRollFlavor,
        restoreDnd5eEnrichedRollFlavor: state.restoreDnd5eEnrichedRollFlavor,
        processChatMessage: state.processChatMessage,
        processUsageChatMessage: state.processUsageChatMessage
    }
}));
vi.mock("../src/utils/reroll.js", () => ({ RerollManager: { registerGlobalListener: vi.fn() } }));
vi.mock("../src/utils/roll.js", () => ({
    KEYBIND_VERSATILE_TWO_HANDED: "versatileTwoHanded",
    ROLL_TYPE: { ATTACK: "attack", DAMAGE: "damage", HEALING: "healing", FORMULA: "roll" },
    RollUtility: {
        processActivity: state.processActivity,
        processRoll: state.processRoll
    }
}));

const { MODULE_SHORT } = await import("../src/module/const.js");
const { HooksUtility } = await import("../src/utils/hooks.js");

function registerPreCreateHook() {
    globalThis.game = { user: { id: "user-1" } };
    globalThis.Hooks = {
        on: vi.fn((name, handler) => state.handlers.set(name, handler))
    };

    HooksUtility.registerChatHooks();
    return state.handlers.get("preCreateChatMessage");
}

function registerRollHooks() {
    state.handlers.clear();
    globalThis.Hooks = {
        on: vi.fn((name, handler) => state.handlers.set(name, handler))
    };

    HooksUtility.registerRollHooks();
    return state.handlers;
}

function usageMessage(flags = {}) {
    const updates = [];
    return {
        type: "usage",
        flags,
        updateSource: vi.fn((update) => updates.push(update)),
        _updates: updates
    };
}

describe("HooksUtility preCreateChatMessage quick-roll flags", () => {
    beforeEach(() => {
        state.handlers.clear();
        state.settings = {
            enableActivityQuickRoll: true,
            enableAbilityQuickRoll: true,
            enableSkillQuickRoll: true,
            enableToolQuickRoll: true,
            enableVanillaQuickRoll: false,
            manualDamageMode: 0
        };
        state.logError.mockClear();
        state.logWarning.mockClear();
        state.suppressDnd5eEnrichedRollFlavor.mockClear();
        state.restoreDnd5eEnrichedRollFlavor.mockClear();
        state.processChatMessage.mockClear();
        state.processUsageChatMessage.mockClear();
        state.processActivity.mockClear();
        state.processRoll.mockClear();
    });

    it("honors the skill quick-roll setting at roll time", () => {
        const handlers = registerRollHooks();
        const preRollSkill = handlers.get("dnd5e.preRollSkill");
        const config = {};
        const dialog = { configure: true };
        const message = { data: { flags: {} } };

        state.settings.enableSkillQuickRoll = false;
        expect(preRollSkill(config, dialog, message)).toBe(true);
        expect(state.processRoll).not.toHaveBeenCalled();

        state.settings.enableSkillQuickRoll = true;
        expect(preRollSkill(config, dialog, message)).toBe(true);
        expect(state.processRoll).toHaveBeenCalledWith(config, dialog, message);
    });

    it("does not let the ability hook process skill or tool rolls", () => {
        const handlers = registerRollHooks();
        const preRollAbility = handlers.get("dnd5e.preRollAbilityCheck");
        const dialog = { configure: true };
        const message = { data: { flags: {} } };

        expect(preRollAbility({ hookNames: ["skill", "abilityCheck"] }, dialog, message)).toBe(true);
        expect(preRollAbility({ hookNames: ["tool", "abilityCheck"] }, dialog, message)).toBe(true);

        expect(state.processRoll).not.toHaveBeenCalled();
    });

    it("processes a plain ability check through the ability hook", () => {
        const handlers = registerRollHooks();
        const preRollAbility = handlers.get("dnd5e.preRollAbilityCheck");
        const config = { hookNames: ["abilityCheck", "d20Test"] };
        const dialog = { configure: true };
        const message = { data: { flags: {} } };

        // Positive branch: a genuine ability check (no skill/tool in the chain) must
        // still be quick-rolled, otherwise the skill/tool guard would have swallowed it.
        expect(preRollAbility(config, dialog, message)).toBe(true);
        expect(state.processRoll).toHaveBeenCalledWith(config, dialog, message);
    });

    it("honors the activity quick-roll setting at use time", () => {
        const handlers = registerRollHooks();
        const preUseActivity = handlers.get("dnd5e.preUseActivity");
        const activity = {};
        const usageConfig = {};
        const dialogConfig = {};
        const messageConfig = { data: { flags: {} } };

        state.settings.enableActivityQuickRoll = false;
        expect(preUseActivity(activity, usageConfig, dialogConfig, messageConfig)).toBe(true);
        expect(state.processActivity).not.toHaveBeenCalled();

        state.settings.enableActivityQuickRoll = true;
        expect(preUseActivity(activity, usageConfig, dialogConfig, messageConfig)).toBe(true);
        expect(state.processActivity).toHaveBeenCalledWith(activity, usageConfig, dialogConfig, messageConfig);
        // The hook's contract is delegation: it routes PRE_USE_ACTIVITY into
        // processActivity when the setting is on. Side effects on usageConfig
        // (subsequentActions, dialogConfig.configure, MODULE_SHORT flags) belong
        // to processActivity and are exercised in roll.test.mjs against the real
        // implementation — asserting them here would lock in mock behavior.
    });

    it("does not process activity quick-roll hooks when vanilla workflow mode is enabled", () => {
        const handlers = registerRollHooks();
        const preUseActivity = handlers.get("dnd5e.preUseActivity");

        state.settings.enableActivityQuickRoll = true;
        state.settings.enableVanillaQuickRoll = true;

        expect(preUseActivity({}, {}, {}, { data: { flags: {} } })).toBe(true);
        expect(state.processActivity).not.toHaveBeenCalled();
    });

    it("records consumed ammunition and restores quantity for weapon-ammunition targets rollAttack re-consumes", () => {
        const handlers = registerRollHooks();
        const activityConsumption = handlers.get("dnd5e.activityConsumption");
        // arrow-1 is a valid ammunitionOption, so dnd5e's rollAttack will consume it a
        // second time — the restore cancels the consumption-phase decrement to avoid
        // double-counting, leaving a single net decrement.
        const activity = {
            type: "attack",
            hasOwnProperty: Object.prototype.hasOwnProperty,
            item: { system: { ammunitionOptions: [{ value: "arrow-1" }] } }
        };
        const messageConfig = {
            data: { flags: { [MODULE_SHORT]: { quickRoll: true } } }
        };
        const ammoUpdate = { _id: "arrow-1", "system.quantity": 0 };

        activityConsumption(activity, {}, messageConfig, { item: [ammoUpdate] });

        expect(messageConfig.data.flags[MODULE_SHORT].ammunition).toBe("arrow-1");
        expect(messageConfig).not.toHaveProperty("flags");
        expect(ammoUpdate["system.quantity"]).toBe(1);
    });

    it("preserves the consumption decrement for material/Consume-Resource targets (issue #34)", () => {
        const handlers = registerRollHooks();
        const activityConsumption = handlers.get("dnd5e.activityConsumption");
        // A vehicle cannon's cannonballs are a "material" consumption target, not a weapon
        // ammunition option — rollAttack never re-consumes them, so the consumption-phase
        // decrement must survive. The old ++ restore turned this 9 into 10 (net 0 consumed).
        const activity = {
            type: "attack",
            hasOwnProperty: Object.prototype.hasOwnProperty,
            item: { system: { ammunitionOptions: [] } }
        };
        const messageConfig = {
            data: { flags: { [MODULE_SHORT]: { quickRoll: true } } }
        };
        const ammoUpdate = { _id: "cannonball-1", "system.quantity": 9 };

        activityConsumption(activity, {}, messageConfig, { item: [ammoUpdate] });

        expect(messageConfig.data.flags[MODULE_SHORT].ammunition).toBe("cannonball-1");
        expect(messageConfig).not.toHaveProperty("flags");
        expect(ammoUpdate["system.quantity"]).toBe(9);
    });

    it("does not invent captured ammunition when activity consumption produced no item update", () => {
        const handlers = registerRollHooks();
        const activityConsumption = handlers.get("dnd5e.activityConsumption");
        const activity = {
            type: "attack",
            hasOwnProperty: Object.prototype.hasOwnProperty,
            item: {
                system: {
                    ammunitionOptions: [{ value: "fire-arrow" }, { value: "normal-arrow" }]
                }
            }
        };
        const messageConfig = {
            data: { flags: { [MODULE_SHORT]: { quickRoll: true } } }
        };

        activityConsumption(activity, {}, messageConfig, { item: [] });

        expect(messageConfig.data.flags[MODULE_SHORT]).not.toHaveProperty("ammunition");
        expect(messageConfig).not.toHaveProperty("flags");
    });

    it("does not capture or restore ammunition for a chat-card Consume Resource action", () => {
        const handlers = registerRollHooks();
        const activityConsumption = handlers.get("dnd5e.activityConsumption");
        const activity = {
            type: "attack",
            hasOwnProperty: Object.prototype.hasOwnProperty,
            item: { system: { ammunitionOptions: [{ value: "arrow-1" }] } }
        };
        // dnd5e's chat-card Consume Resource action invokes the consumption hook with
        // an empty messageConfig and applies the returned item update immediately. No
        // rollAttack follows, so RSR must neither stamp card state nor add the unit back.
        const messageConfig = {};
        const ammoUpdate = { _id: "arrow-1", "system.quantity": 0 };

        activityConsumption(activity, {}, messageConfig, { item: [ammoUpdate] });

        expect(messageConfig).toEqual({});
        expect(ammoUpdate["system.quantity"]).toBe(0);
    });

    it("preserves slow-roll flags written by the pre-use activity hook", () => {
        const preCreate = registerPreCreateHook();
        const message = usageMessage({
            [MODULE_SHORT]: {
                quickRoll: false,
                processed: true,
                advantage: true
            }
        });

        preCreate(message, {}, {}, "user-1");

        expect(message.updateSource).toHaveBeenCalledWith({
            [`flags.${MODULE_SHORT}`]: {
                quickRoll: false,
                processed: true,
                advantage: true
            }
        });
        expect(state.logError).not.toHaveBeenCalled();
    });

    it("stamps base flags without render flags and warns when activity resolution fails in preCreate", () => {
        // Regression: quickRoll already seeded (by processActivity), activity null in
        // preCreate. The message must keep its claim (runActivityActions retries
        // resolution at render time) but must NOT gain render flags it can't back,
        // and the failure must be surfaced as a warning rather than swallowed.
        const preCreate = registerPreCreateHook();
        const message = usageMessage({
            [MODULE_SHORT]: { quickRoll: true, processed: false }
        });
        // no message._activity — _getActivityFromMessage returns null

        preCreate(message, {}, {}, "user-1");

        expect(message.updateSource).toHaveBeenCalledTimes(1);
        const written = message._updates[0][`flags.${MODULE_SHORT}`];
        expect(written).toMatchObject({ quickRoll: true, processed: false });
        expect(written).not.toHaveProperty("renderAttack");
        expect(written).not.toHaveProperty("renderDamage");
        expect(written).not.toHaveProperty("renderFormula");
        expect(state.logWarning).toHaveBeenCalledTimes(1);
        expect(state.logError).not.toHaveBeenCalled();
    });

    it("adds render flags for quick-roll activity messages", () => {
        const preCreate = registerPreCreateHook();
        const message = usageMessage();
        message._activity = { type: "attack", hasOwnProperty: Object.prototype.hasOwnProperty };

        preCreate(message, {}, {}, "user-1");

        expect(message.updateSource).toHaveBeenCalledWith({
            [`flags.${MODULE_SHORT}`]: expect.objectContaining({
                quickRoll: true,
                processed: false,
                renderAttack: true,
                renderDamage: true
            })
        });
    });

    it("suppresses dnd5e roll metadata before processing renderChatMessageHTML", () => {
        registerPreCreateHook();
        const render = state.handlers.get("renderChatMessageHTML");
        const message = usageMessage({
            [MODULE_SHORT]: { quickRoll: true, processed: true },
            dnd5e: {
                item: { id: "weapon-1" },
                roll: { type: "attack" }
            }
        });
        const html = {
            0: {},
            find: vi.fn(() => ({ length: 0, addClass: vi.fn() }))
        };
        globalThis.HTMLElement = class TestHTMLElement {};

        render(message, html);

        expect(state.suppressDnd5eEnrichedRollFlavor).toHaveBeenCalledWith(message);
        expect(state.processChatMessage).toHaveBeenCalledWith(message, html);
        expect(state.suppressDnd5eEnrichedRollFlavor.mock.invocationCallOrder[0])
            .toBeLessThan(state.processChatMessage.mock.invocationCallOrder[0]);

        // Self-heal: a restore runs BEFORE the suppress so a stale suppression left by
        // a render pass that failed mid-chain (dnd5e.renderChatMessage never fired) is
        // repaired instead of permanently desyncing the in-memory document.
        expect(state.restoreDnd5eEnrichedRollFlavor).toHaveBeenCalledWith(message);
        expect(state.restoreDnd5eEnrichedRollFlavor.mock.invocationCallOrder[0])
            .toBeLessThan(state.suppressDnd5eEnrichedRollFlavor.mock.invocationCallOrder[0]);
    });

    it("restores dnd5e roll metadata before processing dnd5e.renderChatMessage", () => {
        registerPreCreateHook();
        const render = state.handlers.get("dnd5e.renderChatMessage");
        const message = usageMessage({
            [MODULE_SHORT]: { quickRoll: true, processed: true }
        });
        const html = {};

        render(message, html);

        expect(state.restoreDnd5eEnrichedRollFlavor).toHaveBeenCalledWith(message);
        expect(state.processUsageChatMessage).toHaveBeenCalledWith(message, html);
        expect(state.restoreDnd5eEnrichedRollFlavor.mock.invocationCallOrder[0])
            .toBeLessThan(state.processUsageChatMessage.mock.invocationCallOrder[0]);
    });
});
