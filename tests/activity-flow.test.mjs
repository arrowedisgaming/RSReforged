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

    function ammunitionOption(id, { equipped = false, quantity = 1, disabled = quantity <= 0 } = {}) {
        return {
            item: { id, system: { equipped, quantity } },
            value: id,
            label: id,
            disabled
        };
    }

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

    it("publishes the evaluated attack ammunition before building damage", async () => {
        const attack = makeRoll(env.classes.D20Roll, {
            formula: "1d20+5",
            total: 18,
            faces: 20,
            results: [13],
            rollOptions: { ammunition: "normal-arrow" }
        });
        const message = new env.classes.TestChatMessage({
            id: "usage-ammunition",
            flags: {
                [MODULE_SHORT]: {
                    renderAttack: true,
                    renderDamage: true,
                    rolls: []
                }
            }
        });

        vi.spyOn(ActivityUtility, "getAttackFromMessage").mockResolvedValue([attack]);
        const damageSpy = vi.spyOn(ActivityUtility, "getDamageFromMessage")
            .mockImplementation(currentMessage => {
                expect(currentMessage.flags[MODULE_SHORT].ammunition).toBe("normal-arrow");
                return [];
            });

        await ActivityUtility.runActivityActions(message);

        expect(damageSpy).toHaveBeenCalledTimes(1);
        expect(message.updatedWith.flags[MODULE_SHORT].ammunition).toBe("normal-arrow");
    });

    it("clears stale captured ammunition when the evaluated attack used none", async () => {
        const attack = makeRoll(env.classes.D20Roll, {
            formula: "1d20+5",
            total: 18,
            faces: 20,
            results: [13],
            rollOptions: { ammunition: "" }
        });
        const message = new env.classes.TestChatMessage({
            id: "usage-no-ammunition",
            flags: {
                [MODULE_SHORT]: {
                    ammunition: "exhausted-arrow",
                    renderAttack: true,
                    renderDamage: true,
                    rolls: []
                }
            }
        });

        vi.spyOn(ActivityUtility, "getAttackFromMessage").mockResolvedValue([attack]);
        vi.spyOn(ActivityUtility, "getDamageFromMessage")
            .mockImplementation(currentMessage => {
                expect(currentMessage.flags[MODULE_SHORT]).not.toHaveProperty("ammunition");
                return [];
            });

        await ActivityUtility.runActivityActions(message);

        expect(message.updatedWith.flags[MODULE_SHORT]).not.toHaveProperty("ammunition");
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

    it("restores raw roll source so modern Dice So Nice animates an attack-only update exactly once", async () => {
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
        const rawRollSource = structuredClone(message._source.rolls);
        // Deliberately diverge the live Roll collection from raw source. The restore
        // must use _source.rolls, not these instantiated Roll objects.
        message.rolls = [makeRoll(env.classes.BasicRoll, { formula: "1d4", total: 3, faces: 4, results: [3] })];
        const tryRollDice3D = vi.spyOn(CoreUtility, "tryRollDice3D").mockResolvedValue(true);

        vi.spyOn(ActivityUtility, "getAttackFromMessage").mockResolvedValue([attack]);

        await ActivityUtility.runActivityActions(message);

        // RSR restores the raw pre-registration source, so modern DSN owns the complete
        // appended update and no synchronized manual d20 broadcast is needed.
        expect(tryRollDice3D).not.toHaveBeenCalled();
        expect(foundry.audio.AudioHelper.play).not.toHaveBeenCalled();
        expect(message._source.rolls).toEqual(rawRollSource);
        expect(message.updatedWith.rolls).toHaveLength(1);
        expect(message.updatedWith.rolls[0].class).toBe("D20Roll");
    });

    it("temporarily preloads the attack for AC5e/WM5E while preserving live flag additions and deletions", async () => {
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
                },
                "test-removed-hook": { stale: true }
            }
        });
        const rawRollSource = structuredClone(message._source.rolls);
        const updateSource = vi.spyOn(message, "updateSource");
        const originalUpdate = message.update.bind(message);
        let markUpdateStarted;
        let releaseUpdate;
        const updateStarted = new Promise((resolve) => { markUpdateStarted = resolve; });
        const updateCanFinish = new Promise((resolve) => { releaseUpdate = resolve; });
        vi.spyOn(message, "update").mockImplementation(async (update) => {
            markUpdateStarted();
            await updateCanFinish;
            return originalUpdate(update);
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
            expect(message._source.rolls[0]).not.toBe(attack);
            expect(message._source.rolls[0].class).toBe("D20Roll");

            // Simulate third-party damage hooks adding and deleting in-memory flags
            // after the registration updateSource. The rolls-only restore must retain
            // the exact live state rather than resurrecting source-only namespaces.
            message.flags["test-damage-hook"] = { resolved: true };
            delete message.flags["test-removed-hook"];

            return [damage];
        });

        const activityActions = ActivityUtility.runActivityActions(message);
        await updateStarted;

        // While the persisted update is pending, DSN sees the restored raw source for
        // its appended-roll diff, but registry consumers still see the prepared attack
        // d20 and every live flag. The final two-roll update has not landed yet.
        expect(message.toObject().rolls).toEqual(rawRollSource);
        expect(message._source.rolls).toEqual(rawRollSource);
        expect(message.rolls).toHaveLength(1);
        // The lightweight test document retains serialized roll data here; Foundry's
        // real ChatMessage.prepareDerivedData rebuilds this entry as a D20Roll instance.
        expect(message.rolls[0].class).toBe("D20Roll");
        expect(message._source.flags.dnd5e).toMatchObject({
            originatingMessage: "usage-dsn-weapon",
            roll: { type: "attack" }
        });
        expect(message.flags["test-damage-hook"]).toEqual({ resolved: true });
        expect(message.flags).not.toHaveProperty("test-removed-hook");
        expect(message.updatedWith).toBeUndefined();

        releaseUpdate();
        await activityActions;

        expect(tryRollDice3D).not.toHaveBeenCalled();
        expect(foundry.audio.AudioHelper.play).not.toHaveBeenCalled();
        expect(updateSource).toHaveBeenCalledTimes(2);
        expect(updateSource.mock.calls[1][0]).toEqual({ rolls: rawRollSource });
        expect(message.updatedWith.rolls.map((roll) => roll.class)).toEqual([
            "D20Roll",
            "DamageRoll"
        ]);
        expect(message.rolls).toHaveLength(2);
        expect(message.flags["test-damage-hook"]).toEqual({ resolved: true });
        expect(message.updatedWith.flags).not.toHaveProperty("test-removed-hook");
        expect(message._source.flags.dnd5e).toMatchObject({
            originatingMessage: "usage-dsn-weapon",
            roll: { type: "attack" }
        });
    });

    it("does not restore or re-initialize roll source for a formula-only activity", async () => {
        const formula = makeRoll(env.classes.BasicRoll, { formula: "1d6", total: 4, faces: 6, results: [4] });
        const message = new env.classes.TestChatMessage({
            id: "usage-formula-only",
            flags: {
                [MODULE_SHORT]: {
                    renderFormula: true,
                    rolls: []
                }
            }
        });
        const updateSource = vi.spyOn(message, "updateSource");
        vi.spyOn(ActivityUtility, "getFormulaFromMessage").mockResolvedValue([formula]);

        await ActivityUtility.runActivityActions(message);

        expect(updateSource).not.toHaveBeenCalled();
        expect(message.updatedWith.rolls.map((roll) => roll.class)).toEqual(["BasicRoll"]);
    });

    it("does not restore roll source when an attack action produces no attack roll", async () => {
        const message = new env.classes.TestChatMessage({
            id: "usage-empty-attack",
            flags: {
                [MODULE_SHORT]: {
                    renderAttack: true,
                    rolls: []
                }
            }
        });
        const updateSource = vi.spyOn(message, "updateSource");
        vi.spyOn(ActivityUtility, "getAttackFromMessage").mockResolvedValue([]);

        await ActivityUtility.runActivityActions(message);

        expect(updateSource).not.toHaveBeenCalled();
        expect(message.updatedWith.rolls).toEqual([]);
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
        const damage = makeRoll(env.classes.DamageRoll, { formula: "1d8+3", total: 8, faces: 8, results: [5] });
        const message = new env.classes.TestChatMessage({
            id: "usage-dsn-legacy",
            flags: {
                [MODULE_SHORT]: {
                    renderAttack: true,
                    renderDamage: true,
                    rolls: []
                }
            }
        });
        const tryRollDice3D = vi.spyOn(CoreUtility, "tryRollDice3D").mockResolvedValue(true);

        vi.spyOn(ActivityUtility, "getAttackFromMessage").mockResolvedValue([attack]);
        vi.spyOn(ActivityUtility, "getDamageFromMessage").mockResolvedValue([damage]);

        await ActivityUtility.runActivityActions(message);

        expect(tryRollDice3D).toHaveBeenCalledWith([attack, damage], "usage-dsn-legacy");
        expect(foundry.audio.AudioHelper.play).not.toHaveBeenCalled();
        expect(message.updatedWith.rolls).toHaveLength(2);
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

    it("keeps a non-empty ammunition ID captured from configured activity consumption", () => {
        const activity = {
            id: "attack-1",
            item: {
                getFlag: vi.fn(() => undefined),
                system: {
                    ammunitionOptions: [
                        ammunitionOption("fire-arrow"),
                        ammunitionOption("normal-arrow", { equipped: true })
                    ]
                }
            }
        };

        expect(ActivityUtility._resolveQuickRollAmmunition(activity, {
            flags: { [MODULE_SHORT]: { ammunition: "fire-arrow" } }
        })).toBe("fire-arrow");
    });

    it("prefers an available equipped option before a usable remembered choice", () => {
        const activity = {
            id: "attack-1",
            item: {
                getFlag: vi.fn(() => "ice-arrow"),
                system: {
                    ammunitionOptions: [
                        ammunitionOption("fire-arrow"),
                        ammunitionOption("ice-arrow"),
                        ammunitionOption("normal-arrow", { equipped: true })
                    ]
                }
            }
        };

        expect(ActivityUtility._resolveQuickRollAmmunition(activity, {
            flags: { [MODULE_SHORT]: {} }
        })).toBe("normal-arrow");
    });

    it("reuses a usable remembered choice when no ammunition is equipped", () => {
        const activity = {
            id: "attack-1",
            item: {
                getFlag: vi.fn(() => "ice-arrow"),
                system: {
                    ammunitionOptions: [
                        ammunitionOption("fire-arrow"),
                        ammunitionOption("ice-arrow"),
                        ammunitionOption("normal-arrow")
                    ]
                }
            }
        };

        expect(ActivityUtility._resolveQuickRollAmmunition(activity, {
            flags: { [MODULE_SHORT]: {} }
        })).toBe("ice-arrow");
    });

    it("uses dnd5e option order when none are equipped and returns blank when none are usable", () => {
        const item = {
            getFlag: vi.fn(() => undefined),
            system: {
                ammunitionOptions: [
                    ammunitionOption("fire-arrow"),
                    ammunitionOption("ice-arrow")
                ]
            }
        };
        const message = { flags: { [MODULE_SHORT]: {} } };

        expect(ActivityUtility._resolveQuickRollAmmunition({ id: "attack-1", item }, message))
            .toBe("fire-arrow");

        item.system.ammunitionOptions = [
            ammunitionOption("fire-arrow", { quantity: 0 }),
            ammunitionOption("ice-arrow", { quantity: 0 })
        ];
        expect(ActivityUtility._resolveQuickRollAmmunition({ id: "attack-1", item }, message))
            .toBe("");
    });

    it("returns undefined for weapons without ammunition options", () => {
        const activity = {
            id: "attack-1",
            item: {
                getFlag: vi.fn(),
                system: { ammunitionOptions: [] }
            }
        };

        expect(ActivityUtility._resolveQuickRollAmmunition(activity, {
            flags: { [MODULE_SHORT]: {} }
        })).toBeUndefined();
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

    it("stamps a capture token into the roll message config it hands to dnd5e", () => {
        const rollAttack = vi.fn(() => []);
        vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue({ rollAttack });

        ActivityUtility.getAttackFromMessage({ flags: { [MODULE_SHORT]: {} } });

        const messageConfig = rollAttack.mock.calls[0][2];
        expect(messageConfig.data.flags[MODULE_SHORT].quickRoll).toBe(true);
        expect(typeof messageConfig.data.flags[MODULE_SHORT].captureId).toBe("string");
        // The top-level flags block is what dnd5e copies onto the roll message itself;
        // RSR's internal bookkeeping must stay out of it.
        expect(messageConfig.flags).toEqual({ [MODULE_SHORT]: { quickRoll: true } });
    });

    it("applies target descriptors captured during the roll onto the card", async () => {
        const rollAttack = vi.fn((config, dialog, messageConfig) => {
            ActivityUtility.captureRollMessageConfig({
                data: {
                    flags: {
                        [MODULE_SHORT]: messageConfig.data.flags[MODULE_SHORT],
                        dnd5e: { targets: [{ name: "Goblin", uuid: "Actor.goblin", ac: 17 }] }
                    }
                }
            });
            return [];
        });
        vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue({ rollAttack });

        const message = {
            flags: {
                [MODULE_SHORT]: {},
                // Stale pre-roll descriptors, as stamped by dnd5e's Activity#use.
                dnd5e: { targets: [{ name: "Goblin", uuid: "Actor.goblin", ac: 15 }] }
            }
        };

        await ActivityUtility.getAttackFromMessage(message);

        expect(message.flags.dnd5e.targets).toEqual([
            { name: "Goblin", uuid: "Actor.goblin", ac: 17 }
        ]);
    });

    it("leaves the card's descriptors alone when no capture was taken", async () => {
        const rollAttack = vi.fn(() => []);
        vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue({ rollAttack });

        const message = {
            flags: {
                [MODULE_SHORT]: {},
                dnd5e: { targets: [{ name: "Goblin", uuid: "Actor.goblin", ac: 15 }] }
            }
        };

        await ActivityUtility.getAttackFromMessage(message);

        expect(message.flags.dnd5e.targets).toEqual([
            { name: "Goblin", uuid: "Actor.goblin", ac: 15 }
        ]);
    });

    it("releases the capture when the attack roll rejects", async () => {
        let captureId;
        const rollAttack = vi.fn((config, dialog, messageConfig) => {
            captureId = messageConfig.data.flags[MODULE_SHORT].captureId;
            ActivityUtility.captureRollMessageConfig({
                data: {
                    flags: {
                        [MODULE_SHORT]: { captureId },
                        dnd5e: { targets: [{ uuid: "Actor.goblin", ac: 17 }] }
                    }
                }
            });
            return Promise.reject(new Error("roll cancelled"));
        });
        vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue({ rollAttack });

        await expect(ActivityUtility.getAttackFromMessage({ flags: { [MODULE_SHORT]: {} } }))
            .rejects.toThrow("roll cancelled");

        expect(ActivityUtility._consumeRollCapture(captureId)).toBeNull();
    });

    it("releases the capture when rollAttack throws synchronously", () => {
        // dnd5e's own rollAttack is async and cannot do this, but a module that wraps or
        // monkey-patches it can — and a synchronous throw skips the promise chain
        // entirely, so the cleanup cannot live only in .finally().
        let captureId;
        const rollAttack = vi.fn((config, dialog, messageConfig) => {
            captureId = messageConfig.data.flags[MODULE_SHORT].captureId;
            ActivityUtility.captureRollMessageConfig({
                data: {
                    flags: {
                        [MODULE_SHORT]: { captureId },
                        dnd5e: { targets: [{ uuid: "Actor.goblin", ac: 17 }] }
                    }
                }
            });
            throw new Error("wrapper exploded");
        });
        vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue({ rollAttack });

        expect(() => ActivityUtility.getAttackFromMessage({ flags: { [MODULE_SHORT]: {} } }))
            .toThrow("wrapper exploded");
        expect(ActivityUtility._consumeRollCapture(captureId)).toBeNull();
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

    it("lets a child attack message's targets overwrite the card's stale ones", () => {
        // dnd5e's Activity#use stamps descriptors on the usage card before the attack
        // roll runs. The child roll message is created later in the workflow, after any
        // module has adjusted the descriptors against the roll, so it wins (#38).
        const message = {
            flags: {
                dnd5e: {
                    targets: [{ name: "Goblin", uuid: "Actor.goblin", ac: 15 }]
                }
            }
        };
        const child = {
            flags: {
                dnd5e: {
                    targets: [{ name: "Goblin", uuid: "Actor.goblin", ac: 17 }]
                }
            }
        };

        ActivityUtility._syncAttackTargets(message, child);

        expect(message.flags.dnd5e.targets).toEqual([
            { name: "Goblin", uuid: "Actor.goblin", ac: 17 }
        ]);
    });

    it("does not overwrite the card's targets when there is no child message to offer", () => {
        // Without a child message the only alternative source is the user's current
        // targets, which are not newer than what the card already has — never clobber.
        game.user.targets = new Set([
            {
                name: "Bandit",
                actor: {
                    uuid: "Actor.bandit",
                    system: { attributes: { ac: { value: 12 } } },
                    statuses: new Set()
                }
            }
        ]);
        const message = {
            flags: {
                dnd5e: {
                    targets: [{ name: "Existing", uuid: "Actor.existing", ac: 10 }]
                }
            }
        };

        ActivityUtility._syncAttackTargets(message);

        expect(message.flags.dnd5e.targets).toEqual([
            { name: "Existing", uuid: "Actor.existing", ac: 10 }
        ]);
    });

    it("deep-copies the child's targets so the card does not alias the child message", () => {
        const childTargets = [{ name: "Goblin", uuid: "Actor.goblin", ac: 17 }];
        const message = { flags: { dnd5e: {} } };

        ActivityUtility._syncAttackTargets(message, { flags: { dnd5e: { targets: childTargets } } });

        expect(message.flags.dnd5e.targets).not.toBe(childTargets);
        expect(message.flags.dnd5e.targets[0]).not.toBe(childTargets[0]);
    });

    it("issues a unique capture id per call", () => {
        const first = ActivityUtility._nextRollCaptureId();
        const second = ActivityUtility._nextRollCaptureId();

        expect(typeof first).toBe("string");
        expect(first).not.toBe(second);
    });

    it("captures the target descriptors a roll workflow wrote into the message config", () => {
        const captureId = ActivityUtility._nextRollCaptureId();
        const messageConfig = {
            data: {
                flags: {
                    [MODULE_SHORT]: { quickRoll: true, captureId },
                    dnd5e: { targets: [{ name: "Goblin", uuid: "Actor.goblin", ac: 17 }] }
                }
            }
        };

        ActivityUtility.captureRollMessageConfig(messageConfig);

        expect(ActivityUtility._consumeRollCapture(captureId)).toEqual({
            targets: [{ name: "Goblin", uuid: "Actor.goblin", ac: 17 }],
            flags: messageConfig.data.flags
        });
    });

    it("copies the captured descriptors so later mutation of the config cannot change them", () => {
        const captureId = ActivityUtility._nextRollCaptureId();
        const target = { name: "Goblin", uuid: "Actor.goblin", ac: 17 };
        ActivityUtility.captureRollMessageConfig({
            data: { flags: { [MODULE_SHORT]: { captureId }, dnd5e: { targets: [target] } } }
        });

        target.ac = 99;

        expect(ActivityUtility._consumeRollCapture(captureId).targets).toEqual([
            { name: "Goblin", uuid: "Actor.goblin", ac: 17 }
        ]);
    });

    it("ignores roll message configs that carry no RSR capture token", () => {
        const captureId = ActivityUtility._nextRollCaptureId();

        // A roll from another module, or a vanilla dnd5e roll: no token, nothing stored.
        ActivityUtility.captureRollMessageConfig({
            data: { flags: { dnd5e: { targets: [{ name: "Goblin", uuid: "Actor.goblin", ac: 17 }] } } }
        });
        ActivityUtility.captureRollMessageConfig(undefined);
        ActivityUtility.captureRollMessageConfig({});

        expect(ActivityUtility._consumeRollCapture(captureId)).toBeNull();
    });

    it("distinguishes a roll with no targets from a config that carries no target list", () => {
        const emptyId = ActivityUtility._nextRollCaptureId();
        ActivityUtility.captureRollMessageConfig({
            data: { flags: { [MODULE_SHORT]: { captureId: emptyId }, dnd5e: { targets: [] } } }
        });
        expect(ActivityUtility._consumeRollCapture(emptyId).targets).toEqual([]);

        const absentId = ActivityUtility._nextRollCaptureId();
        ActivityUtility.captureRollMessageConfig({
            data: { flags: { [MODULE_SHORT]: { captureId: absentId }, dnd5e: {} } }
        });
        expect(ActivityUtility._consumeRollCapture(absentId).targets).toBeNull();
    });

    it("removes a capture once consumed so the registry cannot leak", () => {
        const captureId = ActivityUtility._nextRollCaptureId();
        ActivityUtility.captureRollMessageConfig({
            data: { flags: { [MODULE_SHORT]: { captureId }, dnd5e: { targets: [{ uuid: "Actor.a", ac: 1 }] } } }
        });

        expect(ActivityUtility._consumeRollCapture(captureId)).not.toBeNull();
        expect(ActivityUtility._consumeRollCapture(captureId)).toBeNull();
    });

    it("overwrites the card's stale use-time target descriptors with the captured set", () => {
        const message = {
            flags: { dnd5e: { targets: [{ name: "Goblin", uuid: "Actor.goblin", ac: 15 }] } }
        };

        expect(ActivityUtility._applyRollCapture(message, {
            targets: [{ name: "Goblin", uuid: "Actor.goblin", ac: 17 }],
            flags: {}
        })).toBe(true);
        expect(message.flags.dnd5e.targets).toEqual([
            { name: "Goblin", uuid: "Actor.goblin", ac: 17 }
        ]);
    });

    it("clears stale descriptors when the roll itself had no targets", () => {
        // The user cleared their targets between activity use and the attack roll. The
        // roll's view is authoritative, so the card must not keep advertising a target
        // that was never rolled against.
        const message = {
            flags: { dnd5e: { targets: [{ name: "Goblin", uuid: "Actor.goblin", ac: 15 }] } }
        };

        expect(ActivityUtility._applyRollCapture(message, { targets: [], flags: {} })).toBe(true);
        expect(message.flags.dnd5e.targets).toEqual([]);
    });

    it("leaves the card untouched when there is nothing captured to apply", () => {
        const targets = [{ name: "Goblin", uuid: "Actor.goblin", ac: 15 }];
        const message = { flags: { dnd5e: { targets } } };

        expect(ActivityUtility._applyRollCapture(message, null)).toBe(false);
        expect(ActivityUtility._applyRollCapture(message, { targets: null, flags: {} })).toBe(false);
        expect(message.flags.dnd5e.targets).toBe(targets);
    });

    it("creates the dnd5e flag namespace when applying to a card that has none", () => {
        const message = {};

        expect(ActivityUtility._applyRollCapture(message, {
            targets: [{ name: "Goblin", uuid: "Actor.goblin", ac: 17 }],
            flags: {}
        })).toBe(true);
        expect(message.flags.dnd5e.targets).toEqual([
            { name: "Goblin", uuid: "Actor.goblin", ac: 17 }
        ]);
    });
});
