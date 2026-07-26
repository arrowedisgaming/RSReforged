import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

describe("attack roll capture end to end", () => {
    let env;
    let ActivityUtility;
    let HooksUtility;
    let MODULE_SHORT;

    beforeEach(async () => {
        vi.resetModules();
        env = await setupFoundryEnv();
        ({ MODULE_SHORT } = await import("../src/module/const.js"));
        ({ ActivityUtility } = await import("../src/utils/activity.js"));
        ({ HooksUtility } = await import("../src/utils/hooks.js"));
        HooksUtility.registerRollHooks();
    });

    function isPlainObject(value) {
        return !!value && (typeof value === "object") && !Array.isArray(value);
    }

    // Faithful stand-in for foundry.utils.mergeObject(original, other): mutates and
    // returns `original`, recurses into plain objects, treats arrays as atomic values.
    // The harness stub is a shallow non-mutating spread, which cannot model the nested
    // flag propagation this fix depends on.
    function mergeObject(original, other) {
        for (const [key, value] of Object.entries(other ?? {})) {
            if (isPlainObject(value) && isPlainObject(original[key])) mergeObject(original[key], value);
            else original[key] = value;
        }
        return original;
    }

    // Stands in for dnd5e's AttackActivity#rollAttack + BasicRoll.buildConfigure:
    // builds dnd5e's own defaults (including messageFlags.targets from
    // getTargetDescriptors), merges RSR's config INTO them, lets a cover-style module
    // adjust the descriptors during preRollAttack, then fires the three post-config
    // hooks in dnd5e's order.
    function fakeRollAttack({ baseAC = 15, coverBonus = 2, targets = true } = {}) {
        return vi.fn(async (config, dialogConfig, messageConfig) => {
            const merged = mergeObject({
                create: true,
                data: {
                    flags: {
                        dnd5e: {
                            activity: { type: "attack", id: "activity-1" },
                            messageType: "roll",
                            roll: { type: "attack" },
                            ...(targets
                                ? { targets: [{ name: "Goblin", img: "goblin.webp", uuid: "Actor.goblin", ac: baseAC }] }
                                : { targets: [] })
                        }
                    }
                }
            }, messageConfig);

            // A cover module in dnd5e.preRollAttack.
            for (const target of merged.data.flags.dnd5e.targets) target.ac += coverBonus;

            for (const name of [
                "dnd5e.postAttackRollConfiguration",
                "dnd5e.postD20TestRollConfiguration",
                "dnd5e.postRollConfiguration"
            ]) {
                env.hookHandlers.get(name)?.([], config, dialogConfig, merged);
            }

            return [];
        });
    }

    function usageCard(staleAC = 15) {
        return {
            id: "usage-1",
            flags: {
                [MODULE_SHORT]: { quickRoll: true },
                // What dnd5e's Activity#use stamped before the roll.
                dnd5e: {
                    targets: [{ name: "Goblin", img: "goblin.webp", uuid: "Actor.goblin", ac: staleAC }]
                }
            }
        };
    }

    it("lands the roll-time AC on the card through the registered hook", async () => {
        const rollAttack = fakeRollAttack({ baseAC: 15, coverBonus: 2 });
        vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue({ rollAttack });
        const message = usageCard(15);

        await ActivityUtility.getAttackFromMessage(message);

        expect(message.flags.dnd5e.targets).toEqual([
            { name: "Goblin", img: "goblin.webp", uuid: "Actor.goblin", ac: 17 }
        ]);
    });

    it("keeps RSR's correlation token out of the flags dnd5e copies onto the roll", async () => {
        const rollAttack = fakeRollAttack();
        vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue({ rollAttack });

        await ActivityUtility.getAttackFromMessage(usageCard());

        const messageConfig = rollAttack.mock.calls[0][2];
        expect(messageConfig.flags[MODULE_SHORT].captureId).toBeUndefined();
        expect(messageConfig.data.flags[MODULE_SHORT].captureId).toMatch(new RegExp(`^${MODULE_SHORT}-capture-\\d+$`));
    });

    it("clears the card's stale targets when the roll had none", async () => {
        const rollAttack = fakeRollAttack({ targets: false });
        vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue({ rollAttack });
        const message = usageCard(15);

        await ActivityUtility.getAttackFromMessage(message);

        expect(message.flags.dnd5e.targets).toEqual([]);
    });

    it("keeps two concurrent attack rolls' captures apart", async () => {
        const first = usageCard(15);
        const second = usageCard(15);

        vi.spyOn(ActivityUtility, "_getActivityFromMessage")
            .mockReturnValueOnce({ rollAttack: fakeRollAttack({ baseAC: 15, coverBonus: 2 }) })
            .mockReturnValueOnce({ rollAttack: fakeRollAttack({ baseAC: 15, coverBonus: 5 }) });

        await Promise.all([
            ActivityUtility.getAttackFromMessage(first),
            ActivityUtility.getAttackFromMessage(second)
        ]);

        expect(first.flags.dnd5e.targets[0].ac).toBe(17);
        expect(second.flags.dnd5e.targets[0].ac).toBe(20);
    });

    it("does not capture a roll RSR did not issue", async () => {
        // A vanilla dnd5e roll carries no RSR token; the handler must ignore it and
        // leave no registry entry behind for the next RSR roll to pick up.
        env.hookHandlers.get("dnd5e.postRollConfiguration")?.([], {}, {}, {
            data: { flags: { dnd5e: { targets: [{ name: "Wolf", uuid: "Actor.wolf", ac: 99 }] } } }
        });

        const rollAttack = fakeRollAttack({ baseAC: 15, coverBonus: 2 });
        vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue({ rollAttack });
        const message = usageCard(15);

        await ActivityUtility.getAttackFromMessage(message);

        expect(message.flags.dnd5e.targets).toEqual([
            { name: "Goblin", img: "goblin.webp", uuid: "Actor.goblin", ac: 17 }
        ]);
    });
});
