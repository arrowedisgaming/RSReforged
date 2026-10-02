import { describe, beforeEach, afterEach, it, expect, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

let claimNativeThrow;

beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    await setupFoundryEnv();
    ({ claimNativeThrow } = await import("../src/utils/native-dice.js"));
    // A pooled roll records which rolls it wraps.
    foundry.dice.terms.PoolTerm = { fromRolls: (rolls) => ({ pooled: rolls }) };
    CONFIG.Dice.rolls = [{ fromTerms: (terms) => ({ terms }) }];
    game.dice3d = { showForRoll: vi.fn(async () => true) };
});

afterEach(() => vi.useRealTimers());

function child(id, rolls, { sound = null, flags = { workflowVersion: 2, parentId: "parent" } } = {}) {
    const message = { id, rolls, sound, author: { id: "gm" }, speaker: { actor: "a1" }, flags: { rsreforged: flags } };
    game.messages.set(id, message);
    return message;
}

const intercepted = () => ({ willTrigger3DRoll: true });

it("throws every roll of a workflow batch as one pooled roll through the public API", async () => {
    const damage = child("damage", ["d10", "d6"], { sound: CONFIG.sounds.dice });
    const attack = child("attack", ["d20"]);
    const first = intercepted();
    const second = intercepted();

    // dnd5e fires the batch's create hooks in either order.
    claimNativeThrow("damage", first);
    claimNativeThrow("attack", second);

    expect(first.willTrigger3DRoll).toBe(false);
    expect(second.willTrigger3DRoll).toBe(false);
    expect(damage.sound).toBeUndefined();
    // Both messages wait on the same throw; nothing is thrown until the batch is complete.
    expect(attack._rsrNativeThrow).toBe(damage._rsrNativeThrow);
    expect(game.dice3d.showForRoll).not.toHaveBeenCalled();

    const landed = damage._rsrNativeThrow;
    await vi.runAllTimersAsync();

    expect(game.dice3d.showForRoll).toHaveBeenCalledTimes(1);
    const [roll, user, synchronize, users, blind, messageId, speaker] = game.dice3d.showForRoll.mock.calls[0];
    expect(roll.terms[0].pooled).toEqual(["d10", "d6", "d20"]);
    expect([user, synchronize, users, blind, messageId, speaker]).toEqual([damage.author, false, null, false, "damage", damage.speaker]);
    await expect(landed).resolves.toBeUndefined();
    expect(attack._rsrNativeThrow).toBeUndefined();
});

it("leaves messages Dice So Nice would not animate, and other messages, to Dice So Nice", async () => {
    child("hidden", ["d20"]);
    const skipped = { willTrigger3DRoll: false };
    claimNativeThrow("hidden", skipped);

    child("vanilla", ["d20"], { flags: {} });
    const vanilla = intercepted();
    claimNativeThrow("vanilla", vanilla);

    expect(game.messages.get("hidden")._rsrNativeThrow).toBeUndefined();
    expect(vanilla.willTrigger3DRoll).toBe(true);
    await vi.runAllTimersAsync();
    expect(game.dice3d.showForRoll).not.toHaveBeenCalled();
});

it("leaves the throw to Dice So Nice when its public API is missing", () => {
    game.dice3d = { renderRolls: vi.fn() };
    child("attack", ["d20"]);
    const interception = intercepted();

    claimNativeThrow("attack", interception);

    expect(interception.willTrigger3DRoll).toBe(true);
    expect(game.messages.get("attack")._rsrNativeThrow).toBeUndefined();
});

it("keeps separate workflows in separate throws", async () => {
    child("a", ["d20"], { flags: { workflowVersion: 2, parentId: "one" } });
    child("b", ["d8"], { flags: { workflowVersion: 2, parentId: "two" } });

    claimNativeThrow("a", intercepted());
    claimNativeThrow("b", intercepted());
    await vi.runAllTimersAsync();

    expect(game.dice3d.showForRoll.mock.calls.map((call) => call[0].terms[0].pooled)).toEqual([["d20"], ["d8"]]);
});

it("still releases the card when the throw fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    game.dice3d.showForRoll = vi.fn(async () => { throw new Error("boom"); });
    const attack = child("attack", ["d20"]);
    claimNativeThrow("attack", intercepted());
    const landed = attack._rsrNativeThrow;

    await vi.runAllTimersAsync();

    await expect(landed).resolves.toBeUndefined();
    expect(attack._rsrNativeThrow).toBeUndefined();
});

describe("Always Roll Multiple Dice", () => {
    let prepareAlternates;
    let env;

    beforeEach(async () => {
        vi.resetModules();
        env = await setupFoundryEnv({ settings: { alwaysRollMulti: true } });
        ({ prepareAlternates, claimNativeThrow } = await import("../src/utils/native-dice.js"));
        foundry.dice.terms.PoolTerm = { fromRolls: (rolls) => ({ pooled: rolls }) };
        CONFIG.Dice.rolls = [{ fromTerms: (terms) => ({ terms }) }];
        game.dice3d = { showForRoll: vi.fn(async () => true) };
        // The extra d20 rolls a 12.
        const TestRoll = Roll;
        globalThis.Roll = class extends TestRoll {
            async evaluate() { this.dice = [{ results: [{ result: 12, active: true }] }]; return this; }
        };
    });

    function d20Roll({ advantage = false } = {}) {
        const { D20Roll, TestDie } = env.classes;
        const roll = new D20Roll("1d20 + 5");
        const die = new TestDie({ number: advantage ? 2 : 1, faces: 20, results: [{ result: 9, active: true }] });
        roll.terms = [die];
        roll.dice = [die];
        roll._evaluated = false;
        if (advantage) Object.defineProperty(roll, "hasAdvantage", { value: true });
        return roll;
    }

    const quick = { data: { flags: { rsreforged: { quickRoll: true } } } };

    it("rolls the extra d20 when dnd5e evaluates a quick-rolled d20, before its message is built", async () => {
        const roll = d20Roll();

        prepareAlternates([roll], quick);
        expect(roll.options.rsreforgedAlternates).toBeUndefined();
        await roll.evaluate();

        expect(roll.options.rsreforgedAlternates).toEqual([{ result: 12, active: true }]);
        // The one-shot evaluate is gone; the roll is back on its own method.
        expect(Object.hasOwn(roll, "evaluate")).toBe(false);
    });

    it("leaves dialog rolls, advantaged rolls, and the setting off alone", async () => {
        const dialog = d20Roll();
        prepareAlternates([dialog], { data: { flags: { rsreforged: { quickRoll: false } } } });
        const advantaged = d20Roll({ advantage: true });
        prepareAlternates([advantaged], quick);
        env.settings.alwaysRollMulti = false;
        const off = d20Roll();
        prepareAlternates([off], quick);

        for (const roll of [dialog, advantaged, off]) {
            await roll.evaluate();
            expect(roll.options.rsreforgedAlternates).toBeUndefined();
        }
    });

    it("throws a lone check's extra d20 with its real one, claiming it from Dice So Nice", async () => {
        const roll = d20Roll();
        roll.options.rsreforgedAlternates = [{ result: 12, active: true }];
        const check = { id: "chk", type: "check", rolls: [roll], flags: { rsreforged: { quickRoll: true } } };
        game.messages.set("chk", check);
        const interception = { willTrigger3DRoll: true };

        claimNativeThrow("chk", interception);
        expect(interception.willTrigger3DRoll).toBe(false);
        expect(check._rsrNativeThrow).toBeInstanceOf(Promise);
        await vi.waitFor(() => expect(game.dice3d.showForRoll).toHaveBeenCalledTimes(1));

        const pooled = game.dice3d.showForRoll.mock.calls[0][0].terms[0].pooled;
        expect(pooled[0]).toBe(roll);
        expect(pooled[1].dice[0].results.map((r) => r.result)).toEqual([12]);
    });
});

it("leaves a message to Dice So Nice when it is not throwing dice (visibility none, combat)", () => {
    game.dice3d = { showForRoll: vi.fn(), isEnabled: () => false };
    const attack = child("attack", ["d20"], { sound: CONFIG.sounds.dice });
    const interception = intercepted();

    claimNativeThrow("attack", interception);

    expect(interception.willTrigger3DRoll).toBe(true);
    expect(attack.sound).toBe(CONFIG.sounds.dice);
    expect(attack._rsrNativeThrow).toBeUndefined();
});
