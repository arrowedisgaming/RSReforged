import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

let claimNativeThrow;

beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    await setupFoundryEnv();
    ({ claimNativeThrow } = await import("../src/utils/native-dice.js"));
    game.dice3d = { renderRolls: vi.fn() };
});

afterEach(() => vi.useRealTimers());

function child(id, rolls, { sound = null, flags = { workflowVersion: 2, parentId: "parent" } } = {}) {
    const message = { id, rolls, sound, flags: { rsreforged: flags } };
    game.messages.set(id, message);
    return message;
}

const intercepted = () => ({ willTrigger3DRoll: true });

it("throws every roll of a workflow batch together, on its first message", async () => {
    const attack = child("attack", ["d20"], { sound: CONFIG.sounds.dice });
    const damage = child("damage", ["d10", "d6"]);
    const first = intercepted();
    const second = intercepted();

    claimNativeThrow("attack", first);
    claimNativeThrow("damage", second);

    expect(first.willTrigger3DRoll).toBe(false);
    expect(second.willTrigger3DRoll).toBe(false);
    // The combined card waits on the first message; the others never animate alone.
    expect(attack._dice3danimating).toBe(true);
    expect(damage._dice3danimating).toBeUndefined();
    expect(attack.sound).toBeUndefined();
    expect(game.dice3d.renderRolls).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();

    expect(game.dice3d.renderRolls).toHaveBeenCalledTimes(1);
    expect(game.dice3d.renderRolls).toHaveBeenCalledWith(attack, ["d20", "d10", "d6"]);
});

it("leaves messages Dice So Nice would not animate, and other messages, to Dice So Nice", async () => {
    child("hidden", ["d20"]);
    const skipped = { willTrigger3DRoll: false };
    claimNativeThrow("hidden", skipped);

    child("vanilla", ["d20"], { flags: {} });
    const vanilla = intercepted();
    claimNativeThrow("vanilla", vanilla);

    expect(skipped.willTrigger3DRoll).toBe(false);
    expect(game.messages.get("hidden")._dice3danimating).toBeUndefined();
    expect(vanilla.willTrigger3DRoll).toBe(true);
    await vi.runAllTimersAsync();
    expect(game.dice3d.renderRolls).not.toHaveBeenCalled();
});

it("keeps separate workflows in separate throws", async () => {
    const a = child("a", ["d20"], { flags: { workflowVersion: 2, parentId: "one" } });
    const b = child("b", ["d8"], { flags: { workflowVersion: 2, parentId: "two" } });

    claimNativeThrow("a", intercepted());
    claimNativeThrow("b", intercepted());
    await vi.runAllTimersAsync();

    expect(game.dice3d.renderRolls.mock.calls).toEqual([[a, ["d20"]], [b, ["d8"]]]);
});

it("releases the card if Dice So Nice has gone away before the throw", async () => {
    const attack = child("attack", ["d20"]);
    claimNativeThrow("attack", intercepted());
    game.dice3d = undefined;

    await vi.runAllTimersAsync();

    expect(attack._dice3danimating).toBeUndefined();
});
