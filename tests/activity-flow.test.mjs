import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRoll, setupFoundryEnv } from "./helpers/foundry-env.mjs";

describe("ActivityUtility roll action flow", () => {
    let env;
    let ActivityUtility;
    let CoreUtility;
    let MODULE_SHORT;

    beforeEach(async () => {
        vi.resetModules();
        env = await setupFoundryEnv();
        ({ MODULE_SHORT } = await import("../src/module/const.js"));
        ({ ActivityUtility } = await import("../src/utils/activity.js"));
        ({ CoreUtility } = await import("../src/utils/core.js"));
    });

    afterEach(() => {
        delete globalThis.dnd5e;
    });

    it("resolves activities from native message methods before manual fallbacks", () => {
        const nativeActivity = { id: "native" };
        const itemActivity = { id: "item" };
        const message = {
            getAssociatedActivity: vi.fn(() => nativeActivity),
            getAssociatedItem: vi.fn(() => ({
                system: { activities: new Map([["activity-1", itemActivity]]) }
            })),
            flags: { dnd5e: { activity: { id: "activity-1" } } }
        };

        expect(ActivityUtility._getActivityFromMessage(message)).toBe(nativeActivity);
        expect(message.getAssociatedItem).not.toHaveBeenCalled();
    });

    it("resolves activities from associated items and activity UUID flags when native methods are absent", () => {
        const itemActivity = { id: "item" };
        const uuidActivity = { id: "uuid" };

        expect(ActivityUtility._getActivityFromMessage({
            getAssociatedItem: () => ({
                system: { activities: new Map([["activity-1", itemActivity]]) }
            }),
            flags: { dnd5e: { activity: { id: "activity-1" } } }
        })).toBe(itemActivity);

        globalThis.fromUuidSync.mockReturnValue(uuidActivity);
        expect(ActivityUtility._getActivityFromMessage({
            flags: { dnd5e: { activity: { uuid: "Activity.uuid" } } }
        })).toBe(uuidActivity);
    });

    it("extracts rolls from common dnd5e return shapes", () => {
        const direct = makeRoll(env.classes.D20Roll, { formula: "1d20", total: 10, faces: 20, results: [10] });
        const nested = makeRoll(env.classes.DamageRoll, { formula: "1d8", total: 6, faces: 8, results: [6] });
        const single = makeRoll(env.classes.BasicRoll, { formula: "1d6", total: 4, faces: 6, results: [4] });
        const serialized = single.toJSON();

        expect(ActivityUtility._extractRolls([
            direct,
            { rolls: [nested] },
            { roll: single },
            serialized,
            null
        ]).map((roll) => roll.constructor.name)).toEqual([
            "D20Roll",
            "DamageRoll",
            "BasicRoll",
            "BasicRoll"
        ]);
    });

    it("sets render flags from activity capabilities and manual damage mode", () => {
        const flags = { quickRoll: true };
        env.settings.manualDamageMode = 1;

        ActivityUtility.setRenderFlags(
            {
                type: "attack",
                hasOwnProperty: Object.prototype.hasOwnProperty,
                roll: { name: "Recharge" }
            },
            flags
        );

        expect(flags).toMatchObject({
            renderAttack: true,
            manualDamage: true,
            renderDamage: false,
            renderFormula: true,
            formulaName: "Recharge"
        });
    });

    it("runs attack, damage, and formula actions, then persists serialized rolls to the message", async () => {
        const attack = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 25, faces: 20, results: [20] });
        const damage = makeRoll(env.classes.DamageRoll, { formula: "1d8+3", total: 8, faces: 8, results: [5] });
        const formula = makeRoll(env.classes.BasicRoll, { formula: "1d6", total: 4, faces: 6, results: [4] });
        const message = new env.classes.TestChatMessage({
            id: "usage-1",
            flags: {
                [MODULE_SHORT]: {
                    renderAttack: true,
                    renderDamage: true,
                    renderFormula: true,
                    rolls: []
                }
            }
        });

        vi.spyOn(ActivityUtility, "getAttackFromMessage").mockResolvedValue([attack]);
        vi.spyOn(ActivityUtility, "getDamageFromMessage").mockResolvedValue([damage]);
        vi.spyOn(ActivityUtility, "getFormulaFromMessage").mockResolvedValue([formula]);

        await ActivityUtility.runActivityActions(message);

        expect(message.flags[MODULE_SHORT]).toMatchObject({
            processed: true,
            isCritical: true
        });
        expect(message.flags[MODULE_SHORT].rolls.map((roll) => roll.class)).toEqual([
            "D20Roll",
            "DamageRoll",
            "BasicRoll"
        ]);
        expect(message.updatedWith.flags).toBe(message.flags);
        expect(foundry.audio.AudioHelper.play).toHaveBeenCalledWith({ src: "dice.wav" }, true);
    });

    it("passes a real d20 critical state from quick attack into quick damage rolls (#25, #28)", async () => {
        const attack = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 25, faces: 20, results: [20] });
        const damage = makeRoll(env.classes.DamageRoll, { formula: "1d8+3", total: 9, faces: 8, results: [6] });
        const rollDamage = vi.fn(() => [damage]);
        const getDamageConfig = vi.fn(() => ({ rolls: [{ parts: ["1d8"] }] }));
        const activity = {
            rollDamage,
            getDamageConfig,
            item: { flags: { dnd5e: {} } }
        };
        const actor = { items: { get: vi.fn() } };
        const message = new env.classes.TestChatMessage({
            id: "usage-critical-damage",
            flags: {
                [MODULE_SHORT]: {
                    renderAttack: true,
                    renderDamage: true,
                    rolls: []
                }
            }
        });

        vi.spyOn(ActivityUtility, "getAttackFromMessage").mockResolvedValue([attack]);
        vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue(activity);
        vi.spyOn(ActivityUtility, "_getActorFromMessage").mockReturnValue(actor);

        await ActivityUtility.runActivityActions(message);

        expect(message.flags[MODULE_SHORT].isCritical).toBe(true);
        expect(getDamageConfig).toHaveBeenCalledWith(expect.objectContaining({ isCritical: true }));
        const damageConfig = rollDamage.mock.calls[0][0];
        expect(damageConfig.isCritical).toBe(true);
        expect(damageConfig).not.toHaveProperty("critical");
    });

    it("derives quick attack critical state from serialized d20 roll data (#25, #28)", async () => {
        const attack = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 25, faces: 20, results: [20] });
        const damage = makeRoll(env.classes.DamageRoll, { formula: "1d8+3", total: 9, faces: 8, results: [6] });
        const rollDamage = vi.fn(() => [damage]);
        const activity = {
            rollDamage,
            getDamageConfig: vi.fn(() => ({ rolls: [{ parts: ["1d8"] }] })),
            item: { flags: { dnd5e: {} } }
        };
        const message = new env.classes.TestChatMessage({
            id: "usage-serialized-critical",
            flags: {
                [MODULE_SHORT]: {
                    renderAttack: true,
                    renderDamage: true,
                    rolls: []
                }
            }
        });

        vi.spyOn(ActivityUtility, "getAttackFromMessage").mockResolvedValue([structuredClone(attack.toJSON())]);
        vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue(activity);
        vi.spyOn(ActivityUtility, "_getActorFromMessage").mockReturnValue({ items: { get: vi.fn() } });

        await ActivityUtility.runActivityActions(message);

        expect(message.flags[MODULE_SHORT].isCritical).toBe(true);
        expect(rollDamage.mock.calls[0][0].isCritical).toBe(true);
    });

    it("preserves in-memory RSR flags (isCritical) across the attack-registration updateSource (#25, #28)", () => {
        // Root cause of #25/#28: _registerCardAsAttack calls message.updateSource() to
        // anchor the card for AC5e/WM5E. Foundry's updateSource re-initialises the
        // document and rebuilds flags from the persisted source, dropping in-memory-only
        // RSR writes. isCritical is set in memory during the attack roll and read later by
        // the damage roll, so if it does not survive this step a confirmed crit rolls
        // un-doubled damage. (Relies on the faithful TestChatMessage.updateSource, which
        // mirrors that rebuild — see tests/helpers/foundry-env.mjs.)
        const attack = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 25, faces: 20, results: [20] });
        const message = new env.classes.TestChatMessage({
            id: "usage-register-preserve",
            flags: {
                [MODULE_SHORT]: { renderAttack: true, renderDamage: true, rolls: [] }
            }
        });
        // In-memory-only write (never persisted to _source), exactly as runActivityActions
        // does before rolling damage.
        message.flags[MODULE_SHORT].isCritical = true;

        const registered = ActivityUtility._registerCardAsAttack(message, [attack]);

        expect(registered).toBe(true);
        // The dnd5e self-link was written through updateSource — proves the re-initialising
        // source update actually ran...
        expect(message.flags.dnd5e.originatingMessage).toBe("usage-register-preserve");
        // ...yet the in-memory RSR crit flag (and render flags) survived it.
        expect(message.flags[MODULE_SHORT].isCritical).toBe(true);
        expect(message.flags[MODULE_SHORT].renderDamage).toBe(true);
    });

    it.each([
        { name: "does not mark an ordinary d20 as critical", total: 18, results: [13], expected: false },
        { name: "respects die-level custom critical success thresholds", total: 24, results: [19], dieOptions: { criticalSuccess: 19 }, expected: true },
        { name: "respects roll-level Improved Critical thresholds (#25, #28)", total: 19, results: [19], rollOptions: { criticalSuccess: 19 }, expected: true },
        { name: "ignores discarded critical d20 results", total: 17, results: [{ result: 20, discarded: true, active: false }, { result: 12 }], expected: false },
        { name: "ignores rerolled critical d20 results (e.g. Halfling Luck)", total: 14, results: [{ result: 20, rerolled: true }, { result: 7 }], expected: false },
        { name: "treats a forced-success d20 as critical even below the threshold", total: 12, results: [7], rollOptions: { forceSuccess: true }, expected: true }
    ])("$name", async ({ name, total, results, dieOptions = {}, rollOptions = {}, expected }) => {
        const attack = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total, faces: 20, results, dieOptions, rollOptions });
        const message = new env.classes.TestChatMessage({
            id: `usage-critical-${name}`,
            flags: {
                [MODULE_SHORT]: {
                    renderAttack: true,
                    rolls: []
                }
            }
        });

        vi.spyOn(ActivityUtility, "getAttackFromMessage").mockResolvedValue([attack]);

        await ActivityUtility.runActivityActions(message);

        expect(message.flags[MODULE_SHORT].isCritical).toBe(expected);
    });

    it("derives roll-level Improved Critical state from serialized d20 roll data (#25, #28)", async () => {
        const attack = makeRoll(env.classes.D20Roll, {
            formula: "1d20+5", total: 24, faces: 20, results: [19], rollOptions: { criticalSuccess: 19 }
        });
        const message = new env.classes.TestChatMessage({
            id: "usage-serialized-improved-critical",
            flags: { [MODULE_SHORT]: { renderAttack: true, rolls: [] } }
        });

        // A natural 19 is only a crit because the roll-level criticalSuccess threshold
        // survives serialization — proving isCriticalRoll reads it off the rebuilt data
        // rather than falling back to a hard-coded 20.
        vi.spyOn(ActivityUtility, "getAttackFromMessage").mockResolvedValue([structuredClone(attack.toJSON())]);

        await ActivityUtility.runActivityActions(message);

        expect(message.flags[MODULE_SHORT].isCritical).toBe(true);
    });

    it("does not treat a damage roll that contains a d20 term as a critical hit", async () => {
        // A non-critical DamageRoll whose formula includes a d20 die that rolled 20.
        // isCriticalRoll must read the damage roll's own (false) crit flag, not mistake
        // the d20 damage die for an attack crit.
        const damage = makeRoll(env.classes.DamageRoll, { formula: "1d20", total: 20, faces: 20, results: [20] });

        expect(ActivityUtility.isCriticalRoll(damage)).toBe(false);

        damage.options.isCritical = true;
        expect(ActivityUtility.isCriticalRoll(damage)).toBe(true);
    });

    it("manually animates only the preloaded attack under modern Dice So Nice (DSN appends nothing new to animate)", async () => {
        game.dice3d = {
            isEnabled: vi.fn(() => true),
            showForRoll: vi.fn()
        };
        const attack = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 22, faces: 20, results: [17] });
        const message = new env.classes.TestChatMessage({
            id: "usage-dsn",
            flags: {
                [MODULE_SHORT]: {
                    renderAttack: true,
                    rolls: []
                }
            }
        });
        const tryRollDice3D = vi.spyOn(CoreUtility, "tryRollDice3D").mockResolvedValue(true);

        vi.spyOn(ActivityUtility, "getAttackFromMessage").mockResolvedValue([attack]);

        await ActivityUtility.runActivityActions(message);

        // _registerCardAsAttack preloaded the attack into the document source, so the
        // final update appends no *new* roll for DSN to animate — RSR must roll the
        // attack d20 itself or it would never animate on an attack-only quick roll.
        expect(tryRollDice3D).toHaveBeenCalledTimes(1);
        expect(tryRollDice3D).toHaveBeenCalledWith([attack], "usage-dsn");
        expect(foundry.audio.AudioHelper.play).not.toHaveBeenCalled();
        expect(message.updatedWith.rolls).toHaveLength(1);
    });

    it("preloads the attack on the live card for AC5e/WM5E and manually animates it under modern Dice So Nice", async () => {
        game.dice3d = {
            isEnabled: vi.fn(() => true),
            showForRoll: vi.fn()
        };
        game.modules.get.mockImplementation((name) => name === "dice-so-nice"
            ? { active: true, version: "6.2.8" }
            : { active: false, version: "test" });

        const track = vi.fn();
        globalThis.dnd5e = { registry: { messages: { track } } };
        const tryRollDice3D = vi.spyOn(CoreUtility, "tryRollDice3D").mockResolvedValue(true);

        const attack = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 22, faces: 20, results: [17] });
        const damage = makeRoll(env.classes.DamageRoll, { formula: "1d8+3", total: 8, faces: 8, results: [5] });
        const message = new env.classes.TestChatMessage({
            id: "usage-dsn-weapon",
            flags: {
                [MODULE_SHORT]: {
                    renderAttack: true,
                    renderDamage: true,
                    rolls: []
                }
            }
        });

        vi.spyOn(ActivityUtility, "getAttackFromMessage").mockResolvedValue([attack]);
        vi.spyOn(ActivityUtility, "getDamageFromMessage").mockImplementation(async () => {
            // dnd5e's MessageRegistry.get() resolves to this live document, so the attack
            // roll + roll flag must be on it (not a detached copy) during the damage roll
            // — that is what AC5e (rolls[0]) and WM5E (roll.mastery) read.
            expect(track).toHaveBeenCalledTimes(1);
            expect(track.mock.calls[0][0]).toBe(message);
            expect(message.rolls).toHaveLength(1);
            expect(message.flags.dnd5e).toMatchObject({
                originatingMessage: "usage-dsn-weapon",
                roll: { type: "attack" }
            });

            return [damage];
        });

        await ActivityUtility.runActivityActions(message);

        // Modern DSN animates the update-appended damage itself; RSR animates only the
        // preloaded attack d20 (which DSN skips) — exactly once, no double animation.
        expect(tryRollDice3D).toHaveBeenCalledTimes(1);
        expect(tryRollDice3D).toHaveBeenCalledWith([attack], "usage-dsn-weapon");
        expect(foundry.audio.AudioHelper.play).not.toHaveBeenCalled();
        expect(message.updatedWith.rolls.map((roll) => roll.class)).toEqual([
            "D20Roll",
            "DamageRoll"
        ]);
        expect(message.rolls).toHaveLength(2);
    });

    it("manually animates quick activity rolls for legacy Dice So Nice versions that do not watch roll updates", async () => {
        game.dice3d = {
            isEnabled: vi.fn(() => true),
            showForRoll: vi.fn()
        };
        // DSN < 5.1.0 only animates rolls present at message creation; rolls appended
        // via ChatMessage.update need the manual showForRoll path.
        game.modules.get.mockImplementation((name) => name === "dice-so-nice"
            ? { active: true, version: "4.6.3" }
            : { active: false, version: "test" });
        const attack = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 22, faces: 20, results: [17] });
        const message = new env.classes.TestChatMessage({
            id: "usage-dsn-legacy",
            flags: {
                [MODULE_SHORT]: {
                    renderAttack: true,
                    rolls: []
                }
            }
        });
        const tryRollDice3D = vi.spyOn(CoreUtility, "tryRollDice3D").mockResolvedValue(true);

        vi.spyOn(ActivityUtility, "getAttackFromMessage").mockResolvedValue([attack]);

        await ActivityUtility.runActivityActions(message);

        expect(tryRollDice3D).toHaveBeenCalledWith([attack], "usage-dsn-legacy");
        expect(foundry.audio.AudioHelper.play).not.toHaveBeenCalled();
        expect(message.updatedWith.rolls).toHaveLength(1);
    });

    it("derives render flags at render time when preCreate activity resolution failed", async () => {
        // Regression: a quick-roll message claimed by processActivity (quickRoll set,
        // dnd5e subsequentActions already suppressed) arrives with no render flags
        // because _getActivityFromMessage returned null during preCreate. The retry
        // must re-resolve against the now-persisted document and fire the rolls
        // instead of marking the message processed with nothing on it.
        const attack = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 18, faces: 20, results: [13] });
        const damage = makeRoll(env.classes.DamageRoll, { formula: "1d8+3", total: 7, faces: 8, results: [4] });
        const message = new env.classes.TestChatMessage({
            id: "usage-retry",
            flags: {
                [MODULE_SHORT]: { quickRoll: true, processed: false }
            }
        });

        vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue({
            type: "attack",
            hasOwnProperty: Object.prototype.hasOwnProperty
        });
        vi.spyOn(ActivityUtility, "getAttackFromMessage").mockResolvedValue([attack]);
        vi.spyOn(ActivityUtility, "getDamageFromMessage").mockResolvedValue([damage]);

        await ActivityUtility.runActivityActions(message);

        expect(message.flags[MODULE_SHORT]).toMatchObject({
            renderAttack: true,
            renderDamage: true,
            processed: true
        });
        expect(message.flags[MODULE_SHORT].rolls.map((roll) => roll.class)).toEqual([
            "D20Roll",
            "DamageRoll"
        ]);
    });

    it("marks an unresolvable claimed message processed without inventing render flags", async () => {
        // If the retry also fails, the message must settle (processed: true, no
        // re-render loop) and stay roll-less rather than crash or guess flags.
        const message = new env.classes.TestChatMessage({
            id: "usage-unresolvable",
            flags: {
                [MODULE_SHORT]: { quickRoll: true, processed: false }
            }
        });

        vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue(null);
        const getAttack = vi.spyOn(ActivityUtility, "getAttackFromMessage");

        await ActivityUtility.runActivityActions(message);

        expect(message.flags[MODULE_SHORT].processed).toBe(true);
        expect(message.flags[MODULE_SHORT]).not.toHaveProperty("renderAttack");
        expect(message.flags[MODULE_SHORT].rolls).toEqual([]);
        expect(getAttack).not.toHaveBeenCalled();
    });

    it("passes advantage, ammunition, and attackMode into rollAttack", () => {
        const rollAttack = vi.fn(() => []);
        const activity = { rollAttack };
        vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue(activity);

        const message = {
            flags: {
                [MODULE_SHORT]: {
                    advantage: true,
                    disadvantage: false,
                    ammunition: "arrow-1",
                    attackMode: "twoHanded"
                }
            }
        };

        ActivityUtility.getAttackFromMessage(message);

        expect(rollAttack).toHaveBeenCalledWith(
            {
                advantage: true,
                disadvantage: false,
                ammunition: "arrow-1",
                attackMode: "twoHanded"
            },
            { configure: false },
            expect.objectContaining({
                create: false,
                flags: { [MODULE_SHORT]: { quickRoll: true } }
            })
        );
    });

    it("passes scaling, resolved ammunition, critical state, attackMode, and Midi options into rollDamage", async () => {
        vi.resetModules();
        env = await setupFoundryEnv({ modules: { "midi-qol": true } });
        ({ MODULE_SHORT } = await import("../src/module/const.js"));
        ({ ActivityUtility } = await import("../src/utils/activity.js"));

        const ammo = { id: "arrow-1", name: "Arrow" };
        const actor = { items: { get: vi.fn(() => ammo) } };
        const rollDamage = vi.fn(() => []);
        const getDamageConfig = vi.fn(() => ({ rolls: [{ parts: ["1d8"] }] }));
        const activity = {
            rollDamage,
            getDamageConfig,
            item: { flags: { dnd5e: {} } }
        };

        vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue(activity);
        vi.spyOn(ActivityUtility, "_getActorFromMessage").mockReturnValue(actor);

        const message = {
            id: "usage-damage",
            system: { scaling: 2 },
            flags: {
                [MODULE_SHORT]: {
                    isCritical: true,
                    ammunition: "arrow-1",
                    attackMode: "twoHanded"
                }
            }
        };

        ActivityUtility.getDamageFromMessage(message);

        const expectedConfig = {
            isCritical: true,
            ammunition: ammo,
            scaling: 2,
            attackMode: "twoHanded",
            midiOptions: {
                isCritical: true,
                attackMode: "twoHanded"
            }
        };
        expect(getDamageConfig).toHaveBeenCalledWith(expectedConfig);
        expect(rollDamage).toHaveBeenCalledWith(
            expectedConfig,
            { configure: false },
            expect.objectContaining({
                create: false,
                // Damage roll is anchored to its card so condition modules (AC5e) can
                // resolve the originating attack via the dnd5e MessageRegistry.
                flags: {
                    [MODULE_SHORT]: { quickRoll: true },
                    dnd5e: { originatingMessage: "usage-damage" }
                }
            })
        );
        expect(activity.item.flags.dnd5e.scaling).toBe(2);
    });

    it("stamps flags.dnd5e.targets from a child attack message for wm5e mastery actions", () => {
        const parent = { flags: { dnd5e: {} } };
        const child = {
            flags: {
                dnd5e: {
                    targets: [{ name: "Goblin", uuid: "Actor.goblin", ac: 13 }]
                }
            }
        };

        ActivityUtility._syncAttackTargets(parent, child);

        expect(parent.flags.dnd5e.targets).toEqual([
            { name: "Goblin", uuid: "Actor.goblin", ac: 13 }
        ]);
    });

    it("stamps flags.dnd5e.targets from the user's targeted tokens when no child message exists", () => {
        const targetActor = {
            uuid: "Actor.target",
            system: { attributes: { ac: { value: 15 } } }
        };
        const targetToken = { name: "Bandit", actor: targetActor };
        game.user.targets = new Set([targetToken]);

        const message = { flags: { dnd5e: {} } };
        ActivityUtility._syncAttackTargets(message);

        expect(message.flags.dnd5e.targets).toEqual([
            { name: "Bandit", uuid: "Actor.target", ac: 15 }
        ]);
    });

    it("mirrors dnd5e's target-descriptor shape for fully-covered and AC-less tokens in the fallback path", () => {
        const coveredActor = {
            uuid: "Actor.covered",
            img: "covered.webp",
            system: { attributes: { ac: { value: 18 } } },
            statuses: new Set(["coverTotal"])
        };
        const acLessActor = {
            uuid: "Actor.acless",
            img: "acless.webp",
            system: { attributes: {} },
            statuses: new Set()
        };
        game.user.targets = new Set([
            { name: "Sheltered", actor: coveredActor },
            { name: "Statless", actor: acLessActor }
        ]);

        const message = { flags: { dnd5e: {} } };
        ActivityUtility._syncAttackTargets(message);

        // Full cover and a missing AC both resolve to ac:null (never a real AC or
        // undefined), and the avatar img is carried — matching dnd5e.utils.getTargetDescriptors.
        expect(message.flags.dnd5e.targets).toEqual([
            { name: "Sheltered", img: "covered.webp", uuid: "Actor.covered", ac: null },
            { name: "Statless", img: "acless.webp", uuid: "Actor.acless", ac: null }
        ]);
    });

    it("dedupes multiple tokens of the same actor by uuid in the fallback path", () => {
        const actor = {
            uuid: "Actor.twin",
            img: "twin.webp",
            system: { attributes: { ac: { value: 12 } } },
            statuses: new Set()
        };
        game.user.targets = new Set([
            { name: "Twin A", actor },
            { name: "Twin B", actor }
        ]);

        const message = { flags: { dnd5e: {} } };
        ActivityUtility._syncAttackTargets(message);

        expect(message.flags.dnd5e.targets).toHaveLength(1);
        expect(message.flags.dnd5e.targets[0].uuid).toBe("Actor.twin");
    });

    it("does not overwrite existing flags.dnd5e.targets on the card", () => {
        const message = {
            flags: {
                dnd5e: {
                    targets: [{ name: "Existing", uuid: "Actor.existing", ac: 10 }]
                }
            }
        };
        const child = {
            flags: {
                dnd5e: {
                    targets: [{ name: "Goblin", uuid: "Actor.goblin", ac: 13 }]
                }
            }
        };

        ActivityUtility._syncAttackTargets(message, child);

        expect(message.flags.dnd5e.targets).toEqual([
            { name: "Existing", uuid: "Actor.existing", ac: 10 }
        ]);
    });
});
