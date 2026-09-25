import { beforeEach, afterEach, it, expect, vi } from "vitest";
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
