import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/chat.js", () => ({
    ChatUtility: { getActorFromMessage: vi.fn(() => ({ id: "actor1", items: { get: vi.fn((id) => id ? { id } : undefined) } })) }
}));
vi.mock("../src/utils/core.js", () => ({
    CoreUtility: {
        hasModule: vi.fn(() => false),
        tryRollDice3D: vi.fn(),
        playRollSound: vi.fn(),
        dice3dAnimatesRollUpdates: vi.fn(() => true),
        serializeRolls: vi.fn((rolls) => Array.from(rolls ?? []))
    }
}));
vi.mock("../src/utils/settings.js", () => ({
    SETTING_NAMES: {},
    SettingsUtility: { getSettingValue: vi.fn(() => false) }
}));
vi.mock("../src/utils/roll.js", () => ({
    ROLL_TYPE: { DAMAGE: "damage" },
    RollUtility: {
        isRollOfType: vi.fn(() => false),
        mergeRollsByType: vi.fn((existingRolls, newRolls) => [...(existingRolls ?? []), ...(newRolls ?? [])])
    }
}));
vi.mock("../src/module/const.js", () => ({ MODULE_SHORT: "rsr" }));
vi.mock("../src/module/integration.js", () => ({ MODULE_MIDI: "midi-qol" }));

const { ActivityUtility } = await import("../src/utils/activity.js");
const { ChatUtility } = await import("../src/utils/chat.js");

describe("ActivityUtility.getDamageFromMessage", () => {
    let getActivitySpy;

    beforeEach(() => {
        getActivitySpy = vi.spyOn(ActivityUtility, "_getActivityFromMessage");
    });

    afterEach(() => {
        getActivitySpy.mockRestore();
        vi.unstubAllGlobals();
    });

    // Regression (#36): a weapon with no ammunition (e.g. Dagger) leaves both the
    // rsr ammunition flag and flags.dnd5e.roll.ammunitionData undefined, so the
    // `storedAmmunitionId === ammunitionId` fallback compared undefined === undefined
    // and constructed `new Item.implementation(undefined)` — which Foundry rejects
    // with "name: may not be undefined, type: may not be undefined", killing the
    // whole damage roll.
    it("does not reconstruct an ammunition item when the weapon has no ammunition", () => {
        class FakeItem5e {
            constructor(data) {
                if (data?.name === undefined || data?.type === undefined) {
                    throw new Error("[Item5e] validation errors: name: may not be undefined");
                }
            }
        }
        vi.stubGlobal("Item", { implementation: FakeItem5e });

        const rollDamage = vi.fn(() => Promise.resolve([]));
        const activity = {
            rollDamage,
            getDamageConfig: vi.fn(() => ({ rolls: [{ parts: ["1d4"] }] })),
            item: { flags: { dnd5e: {} } }
        };
        getActivitySpy.mockReturnValue(activity);

        const message = { flags: { rsr: {} }, system: {} };
        const result = ActivityUtility.getDamageFromMessage(message);

        expect(result).not.toBeNull();
        expect(rollDamage).toHaveBeenCalledTimes(1);
        expect(rollDamage.mock.calls[0][0].ammunition).toBeUndefined();
    });

    // _resolveQuickRollAmmunition returns "" as the no-usable-ammo sentinel; it must
    // not trigger reconstruction either.
    it("does not reconstruct an ammunition item when the ammunition flag is the empty sentinel", () => {
        class FakeItem5e {
            constructor(data) {
                if (data?.name === undefined || data?.type === undefined) {
                    throw new Error("[Item5e] validation errors: name: may not be undefined");
                }
            }
        }
        vi.stubGlobal("Item", { implementation: FakeItem5e });

        const rollDamage = vi.fn(() => Promise.resolve([]));
        const activity = {
            rollDamage,
            getDamageConfig: vi.fn(() => ({ rolls: [{ parts: ["1d8"] }] })),
            item: { flags: { dnd5e: {} } }
        };
        getActivitySpy.mockReturnValue(activity);

        const message = { flags: { rsr: { ammunition: "" } }, system: {} };
        const result = ActivityUtility.getDamageFromMessage(message);

        expect(result).not.toBeNull();
        expect(rollDamage.mock.calls[0][0].ammunition).toBeUndefined();
    });

    // The guard must still allow the intended path: quantity-one autoDestroy ammo is
    // deleted before the damage roll, so a matching snapshot in
    // flags.dnd5e.roll.ammunitionData is reconstructed as a transient Item.
    it("reconstructs deleted autoDestroy ammunition from the stored snapshot", () => {
        class FakeItem5e {
            constructor(data) {
                if (data?.name === undefined || data?.type === undefined) {
                    throw new Error("[Item5e] validation errors: name: may not be undefined");
                }
                Object.assign(this, data);
            }
        }
        vi.stubGlobal("Item", { implementation: FakeItem5e });

        // Actor whose items collection no longer contains the ammo (it was deleted).
        ChatUtility.getActorFromMessage.mockReturnValueOnce({
            id: "actor1",
            items: { get: vi.fn(() => undefined) }
        });

        const rollDamage = vi.fn(() => Promise.resolve([]));
        const activity = {
            rollDamage,
            getDamageConfig: vi.fn(() => ({ rolls: [{ parts: ["1d6"] }] })),
            item: { flags: { dnd5e: {} } }
        };
        getActivitySpy.mockReturnValue(activity);

        const message = {
            flags: {
                rsr: { ammunition: "last-arrow" },
                dnd5e: { roll: { ammunitionData: { _id: "last-arrow", name: "Last Arrow", type: "consumable" } } }
            },
            system: {}
        };
        const result = ActivityUtility.getDamageFromMessage(message);

        expect(result).not.toBeNull();
        const passedAmmunition = rollDamage.mock.calls[0][0].ammunition;
        expect(passedAmmunition).toBeInstanceOf(FakeItem5e);
        expect(passedAmmunition.name).toBe("Last Arrow");
    });

    // Regression: dnd5e 5.3 SaveActivity with no damage parts (e.g. Faerie Fire, Bane)
    // returns { rolls: [] } from getDamageConfig (base-activity.mjs:744). Calling
    // rollDamage on it crashes inside DamageRoll._evaluateASTAsync because the empty
    // rolls array reaches the roll builder. The guard in getDamageFromMessage must
    // short-circuit before rollDamage is invoked.
    it("returns null and does not call rollDamage when getDamageConfig has no rolls", () => {
        const rollDamage = vi.fn();
        const activity = {
            rollDamage,
            getDamageConfig: vi.fn(() => ({ rolls: [] })),
            item: { flags: { dnd5e: {} } }
        };
        getActivitySpy.mockReturnValue(activity);

        const message = { flags: { rsr: {} }, system: {} };
        const result = ActivityUtility.getDamageFromMessage(message);

        expect(result).toBeNull();
        expect(rollDamage).not.toHaveBeenCalled();
    });

    it("does not short-circuit when getDamageConfig reports at least one roll", () => {
        const rollDamage = vi.fn(() => Promise.resolve([]));
        const activity = {
            rollDamage,
            getDamageConfig: vi.fn(() => ({ rolls: [{ parts: ["1d6"] }] })),
            item: { flags: { dnd5e: {} } }
        };
        getActivitySpy.mockReturnValue(activity);

        const message = { flags: { rsr: {} }, system: {} };
        const result = ActivityUtility.getDamageFromMessage(message);

        expect(result).not.toBeNull();
        expect(rollDamage).toHaveBeenCalledTimes(1);
    });

    // Regression: AttackActivity#getDamageConfig in dnd5e 5.3 only merges ammunition
    // damage when config.ammunition is supplied (see dnd5e attack-data.mjs ~line 290).
    // The guard MUST therefore evaluate getDamageConfig against the same resolved
    // config that rollDamage will receive — calling it with `{}` would suppress
    // ammo-driven attacks whose entire damage comes from the ammunition.
    it("passes the resolved config (including ammunition) to getDamageConfig", () => {
        const rollDamage = vi.fn(() => Promise.resolve([]));
        const getDamageConfig = vi.fn((config) => {
            // Empty when called bare, populated when ammo is present —
            // mirrors AttackActivity behaviour for an ammo-only weapon.
            if (config?.ammunition) return { rolls: [{ parts: ["1d6"], options: {} }] };
            return { rolls: [] };
        });
        const activity = {
            rollDamage,
            getDamageConfig,
            item: { flags: { dnd5e: {} } }
        };
        getActivitySpy.mockReturnValue(activity);

        const message = {
            flags: { rsr: { ammunition: "arrow-of-slaying" } },
            system: {}
        };
        const result = ActivityUtility.getDamageFromMessage(message);

        expect(result).not.toBeNull();
        expect(rollDamage).toHaveBeenCalledTimes(1);

        // The guard call should have received the resolved config, not `{}`.
        const guardCallConfig = getDamageConfig.mock.calls[0]?.[0];
        expect(guardCallConfig).toBeDefined();
        expect(guardCallConfig.ammunition).toBeDefined();
        expect(guardCallConfig.ammunition.id).toBe("arrow-of-slaying");
    });
});
