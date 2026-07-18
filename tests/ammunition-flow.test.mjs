import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRoll, setupFoundryEnv } from "./helpers/foundry-env.mjs";

describe("Quick-roll ammunition pipeline", () => {
    let env;
    let ActivityUtility;
    let HooksUtility;
    let MODULE_SHORT;

    beforeEach(async () => {
        vi.resetModules();
        env = await setupFoundryEnv();
        globalThis.dnd5e = { registry: { messages: { track: vi.fn() } } };
        ({ MODULE_SHORT } = await import("../src/module/const.js"));
        ({ ActivityUtility } = await import("../src/utils/activity.js"));
        ({ HooksUtility } = await import("../src/utils/hooks.js"));
        HooksUtility.registerRollHooks();
    });

    afterEach(() => {
        delete globalThis.dnd5e;
        delete globalThis.Item;
    });

    function ammunitionItem(id, { equipped = false, quantity = 10, autoDestroy = false } = {}) {
        const item = {
            id,
            _id: id,
            name: id,
            system: {
                equipped,
                quantity,
                uses: { autoDestroy },
                damage: { parts: [["1d6", "piercing"]] }
            }
        };
        item.toObject = vi.fn(() => foundry.utils.deepClone({
            _id: item.id,
            name: item.name,
            system: item.system
        }));
        return item;
    }

    function ammunitionOption(item) {
        return {
            item,
            value: item.id,
            label: item.name,
            disabled: item.system.quantity <= 0
        };
    }

    it("prefers equipped ammunition before dnd5e's alphabetic default and carries it into damage", async () => {
        const fire = ammunitionItem("fire-arrow");
        const ice = ammunitionItem("ice-arrow");
        const normal = ammunitionItem("normal-arrow", { equipped: true });
        const actor = { items: new Map([[fire.id, fire], [ice.id, ice], [normal.id, normal]]) };
        const attack = makeRoll(env.classes.D20Roll, {
            formula: "1d20+5", total: 18, faces: 20, results: [13]
        });
        const damage = makeRoll(env.classes.DamageRoll, {
            formula: "1d8+3", total: 8, faces: 8, results: [5]
        });
        const item = {
            id: "bow-1",
            type: "weapon",
            flags: { dnd5e: {} },
            system: {
                ammunitionOptions: [
                    ammunitionOption(fire),
                    ammunitionOption(ice),
                    ammunitionOption(normal)
                ]
            },
            getFlag: vi.fn(() => undefined)
        };
        const activity = {
            id: "attack-1",
            type: "attack",
            actor,
            item,
            hasOwnProperty: Object.prototype.hasOwnProperty,
            rollAttack: vi.fn(config => {
                attack.options.ammunition = config.ammunition;
                return [attack];
            }),
            getDamageConfig: vi.fn(() => ({ rolls: [{ parts: ["1d8"] }] })),
            rollDamage: vi.fn(config => {
                expect(config.ammunition).toBe(normal);
                return [damage];
            })
        };
        const usageConfig = { event: {} };
        const dialogConfig = {};
        const messageConfig = { data: { flags: {} } };

        env.hookHandlers.get("dnd5e.preUseActivity")(
            activity, usageConfig, dialogConfig, messageConfig
        );
        env.hookHandlers.get("dnd5e.activityConsumption")(
            activity, usageConfig, messageConfig, { item: [] }
        );

        expect(messageConfig.data.flags[MODULE_SHORT]).not.toHaveProperty("ammunition");

        const message = new env.classes.TestChatMessage({
            id: "usage-equipped-ammunition",
            type: "usage",
            flags: foundry.utils.deepClone(messageConfig.data.flags),
            getAssociatedActivity: () => activity,
            getAssociatedActor: () => actor
        });

        await ActivityUtility.runActivityActions(message);

        expect(activity.rollAttack).toHaveBeenCalledWith(
            expect.objectContaining({ ammunition: "normal-arrow" }),
            { configure: false },
            expect.any(Object)
        );
        expect(activity.rollDamage).toHaveBeenCalledTimes(1);
        expect(message.flags[MODULE_SHORT].ammunition).toBe("normal-arrow");
        expect(message.updatedWith.flags[MODULE_SHORT].ammunition).toBe("normal-arrow");
    });

    it("carries the final auto-destroyed ammunition item into damage and persisted card state", async () => {
        class TestItem {
            constructor(data, { parent } = {}) {
                Object.assign(this, foundry.utils.deepClone(data));
                this.id = data._id ?? data.id;
                this.parent = parent;
            }
        }
        globalThis.Item = { implementation: TestItem };

        const lastArrow = ammunitionItem("last-arrow", {
            equipped: true,
            quantity: 1,
            autoDestroy: true
        });
        const actor = { items: new Map([[lastArrow.id, lastArrow]]) };
        const attack = makeRoll(env.classes.D20Roll, {
            formula: "1d20+5", total: 18, faces: 20, results: [13]
        });
        const damage = makeRoll(env.classes.DamageRoll, {
            formula: "1d6+3", total: 8, faces: 6, results: [5]
        });
        const item = {
            id: "bow-1",
            type: "weapon",
            flags: { dnd5e: {} },
            system: { ammunitionOptions: [ammunitionOption(lastArrow)] },
            getFlag: vi.fn(() => undefined)
        };
        const activity = {
            id: "attack-1",
            type: "attack",
            actor,
            item,
            hasOwnProperty: Object.prototype.hasOwnProperty,
            rollAttack: vi.fn(async config => {
                attack.options.ammunition = config.ammunition;
                // dnd5e deletes quantity-one autoDestroy ammunition before rollAttack
                // resolves, so the subsequent damage step cannot find it on the actor.
                actor.items.delete(config.ammunition);
                return [attack];
            }),
            getDamageConfig: vi.fn(config => ({
                rolls: config.ammunition ? [{ parts: config.ammunition.system.damage.parts }] : []
            })),
            rollDamage: vi.fn(config => {
                expect(config.ammunition).toBeInstanceOf(TestItem);
                expect(config.ammunition.id).toBe(lastArrow.id);
                expect(config.ammunition.name).toBe(lastArrow.name);
                expect(config.ammunition.system.damage.parts).toEqual([["1d6", "piercing"]]);
                return [damage];
            })
        };
        const usageConfig = { event: {} };
        const messageConfig = { data: { flags: {} } };

        env.hookHandlers.get("dnd5e.preUseActivity")(
            activity, usageConfig, {}, messageConfig
        );
        env.hookHandlers.get("dnd5e.activityConsumption")(
            activity, usageConfig, messageConfig,
            { item: [{ _id: lastArrow.id, "system.quantity": 0 }] }
        );

        const message = new env.classes.TestChatMessage({
            id: "usage-auto-destroy-ammunition",
            type: "usage",
            flags: foundry.utils.deepClone(messageConfig.data.flags),
            getAssociatedActivity: () => activity,
            getAssociatedActor: () => actor
        });

        await ActivityUtility.runActivityActions(message);

        expect(actor.items.has(lastArrow.id)).toBe(false);
        expect(activity.rollDamage).toHaveBeenCalledTimes(1);
        expect(message.flags.dnd5e.roll.ammunitionData).toEqual(
            expect.objectContaining({ _id: lastArrow.id, name: lastArrow.name })
        );
        expect(message.updatedWith.flags.dnd5e.roll.ammunitionData).toEqual(
            expect.objectContaining({ _id: lastArrow.id, name: lastArrow.name })
        );
    });
});
