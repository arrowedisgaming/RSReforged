import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRoll, setupFoundryEnv } from "./helpers/foundry-env.mjs";

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
    //
    // `lateBonus` models a listener on the SECOND post-config hook: it lands between the
    // second and third hook, so it is visible only to a capture taken at the third and
    // last one. `rolls` is what the fake resolves with, so callers can drive the parts of
    // runActivityActions that only run when an attack roll actually came back.
    function fakeRollAttack({ baseAC = 15, coverBonus = 2, lateBonus = 0, targets = true, rolls = [] } = {}) {
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

            const hookNames = [
                "dnd5e.postAttackRollConfiguration",
                "dnd5e.postD20TestRollConfiguration",
                "dnd5e.postRollConfiguration"
            ];
            for (const [index, name] of hookNames.entries()) {
                if (index === hookNames.length - 1) {
                    for (const target of merged.data.flags.dnd5e.targets) target.ac += lateBonus;
                }
                env.hookHandlers.get(name)?.([], config, dialogConfig, merged);
            }

            return rolls;
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

    it("captures at the last post-configuration hook, after every earlier listener", async () => {
        // A cover module writes +2 before the first hook, a second module writes +3
        // between the second and third. Only a capture taken at the third and last hook
        // sees both; capturing at postAttackRollConfiguration or
        // postD20TestRollConfiguration would land 17 instead of 20.
        const rollAttack = fakeRollAttack({ baseAC: 15, coverBonus: 2, lateBonus: 3 });
        vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue({ rollAttack });
        const message = usageCard(15);

        await ActivityUtility.getAttackFromMessage(message);

        expect(message.flags.dnd5e.targets[0].ac).toBe(20);
    });

    it("does not put the correlation token in the top-level flags block", async () => {
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

    // The two writers that touch flags.dnd5e.targets on the quick-roll path only ever
    // meet inside runActivityActions: getAttackFromMessage applies the capture, then
    // runActivityActions runs _syncAttackTargets and _registerCardAsAttack over the same
    // field. Driving getAttackFromMessage alone cannot see any of that.
    describe("through the full runActivityActions pass", () => {
        // A persisted card, unlike the plain object above: its _source holds the stale
        // pre-roll descriptors, so updateSource-driven flag rebuilds behave as they do
        // on a real ChatMessage.
        function usageDocument(staleAC = 15) {
            return new env.classes.TestChatMessage({
                id: "usage-1",
                flags: {
                    [MODULE_SHORT]: { quickRoll: true, renderAttack: true, rolls: [] },
                    dnd5e: {
                        targets: [{ name: "Goblin", img: "goblin.webp", uuid: "Actor.goblin", ac: staleAC }]
                    }
                }
            });
        }

        function attackRoll() {
            return makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 15, faces: 20, results: [10] });
        }

        it("persists the roll-time AC rather than the stale pre-roll set", async () => {
            const rollAttack = fakeRollAttack({ baseAC: 15, coverBonus: 2, rolls: [attackRoll()] });
            vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue({ rollAttack });
            const message = usageDocument(15);

            await ActivityUtility.runActivityActions(message);

            expect(message.flags.dnd5e.targets).toEqual([
                { name: "Goblin", img: "goblin.webp", uuid: "Actor.goblin", ac: 17 }
            ]);
            // What actually reaches the database, after _registerCardAsAttack's
            // updateSource re-initialises the live flags from source.
            expect(message.updatedWith.flags.dnd5e.targets[0].ac).toBe(17);
        });

        it("does not re-stamp the user's targets over a capture that cleared them", async () => {
            // A third-party module emptied the configuration's target list, which is the
            // documented way to say "this roll had no targets". The user still has a token
            // targeted, so the _syncAttackTargets fallback would happily re-stamp it.
            game.user.targets = new Set([{
                name: "Bandit",
                actor: {
                    uuid: "Actor.bandit",
                    img: "bandit.webp",
                    system: { attributes: { ac: { value: 12 } } },
                    statuses: new Set()
                }
            }]);

            const rollAttack = fakeRollAttack({ targets: false, rolls: [attackRoll()] });
            vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue({ rollAttack });
            const message = usageDocument(15);

            await ActivityUtility.runActivityActions(message);

            expect(message.flags.dnd5e.targets).toEqual([]);
            expect(message.updatedWith.flags.dnd5e.targets).toEqual([]);
        });

        it("still falls back to the user's targets when no capture was taken", async () => {
            // No capture hook fires (a cancelled roll, or a dnd5e build that never seeds a
            // target list), so the card keeps its own pre-roll answer and the fallback
            // stays available for cards that have none.
            const rollAttack = vi.fn(async () => [attackRoll()]);
            vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue({ rollAttack });
            game.user.targets = new Set([{
                name: "Bandit",
                actor: {
                    uuid: "Actor.bandit",
                    img: "bandit.webp",
                    system: { attributes: { ac: { value: 12 } } },
                    statuses: new Set()
                }
            }]);
            const message = new env.classes.TestChatMessage({
                id: "usage-2",
                flags: { [MODULE_SHORT]: { quickRoll: true, renderAttack: true, rolls: [] } }
            });

            await ActivityUtility.runActivityActions(message);

            expect(message.flags.dnd5e.targets).toEqual([
                { name: "Bandit", img: "bandit.webp", uuid: "Actor.bandit", ac: 12 }
            ]);
        });
    });
});
