import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupFoundryEnv, makeRoll } from "./helpers/foundry-env.mjs";

// Coverage for the registry re-sync that keeps AC5e in step after an attack roll is
// mutated post-creation (retroactive advantage, or a bonus applied to the attack).
describe("ChatUtility.resyncAttackRegistry", () => {
    let ChatUtility;
    let ActivityUtility;
    let MODULE_SHORT;
    let env;

    beforeEach(async () => {
        vi.resetModules();
        env = await setupFoundryEnv();
        ({ ChatUtility } = await import("../src/utils/chat.js"));
        ({ ActivityUtility } = await import("../src/utils/activity.js"));
        ({ MODULE_SHORT } = await import("../src/module/const.js"));
    });

    afterEach(() => {
        delete globalThis.dnd5e;
    });

    function makeAttackCard(id, originatingMessage) {
        return new env.classes.TestChatMessage({
            id,
            flags: { dnd5e: { originatingMessage }, [MODULE_SHORT]: { rolls: [] } }
        });
    }

    it("refreshes message.rolls in-memory and re-tracks a self-registered attack card", () => {
        const track = vi.fn();
        globalThis.dnd5e = { registry: { messages: { track } } };
        const attack = makeRoll(env.classes.D20Roll, { formula: "2d20kh1", total: 22, faces: 20, results: [17] });
        vi.spyOn(ChatUtility, "getMessageRolls").mockReturnValue([attack]);

        const message = makeAttackCard("card-1", "card-1");
        ChatUtility.resyncAttackRegistry(message);

        // updateSource wrote the serialized current rolls onto the live document...
        expect(message.rolls).toHaveLength(1);
        // ...and the registry was re-tracked with that document.
        expect(track).toHaveBeenCalledWith(message);
    });

    it("no-ops when the card is not self-registered under the attack hook", () => {
        const track = vi.fn();
        globalThis.dnd5e = { registry: { messages: { track } } };
        const getRolls = vi.spyOn(ChatUtility, "getMessageRolls");

        const message = makeAttackCard("card-2", "a-different-message");
        ChatUtility.resyncAttackRegistry(message);

        expect(track).not.toHaveBeenCalled();
        expect(getRolls).not.toHaveBeenCalled();
    });

    it("swallows a missing registry without throwing (cross-module resilience)", () => {
        // No globalThis.dnd5e — the track call throws ReferenceError, caught internally.
        const attack = makeRoll(env.classes.D20Roll, { formula: "1d20", total: 10, faces: 20, results: [10] });
        vi.spyOn(ChatUtility, "getMessageRolls").mockReturnValue([attack]);

        const message = makeAttackCard("card-3", "card-3");
        expect(() => ChatUtility.resyncAttackRegistry(message)).not.toThrow();
        // The in-memory roll sync still happened before the registry call failed.
        expect(message.rolls).toHaveLength(1);
    });

    it("preloads the attack snapshot onto the live card and tracks that document", () => {
        const track = vi.fn();
        globalThis.dnd5e = { registry: { messages: { track } } };
        const attack = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 22, faces: 20, results: [17] });

        const message = makeAttackCard("card-4", undefined);
        const registered = ActivityUtility._registerCardAsAttack(message, [attack]);

        expect(registered).toBe(true);
        // dnd5e's MessageRegistry.get() resolves stored ids back through
        // game.messages.get(), so AC5e/WM5E only ever read this live document — the
        // attack roll, roll type and self-link must be on it, not a detached copy.
        expect(message.rolls).toHaveLength(1);
        expect(message.flags.dnd5e.roll).toMatchObject({ type: "attack" });
        expect(message.flags.dnd5e.originatingMessage).toBe("card-4");
        expect(track).toHaveBeenCalledTimes(1);
        expect(track.mock.calls[0][0]).toBe(message);
    });

    it("reports that it did not register when there is no attack roll to preload", () => {
        const track = vi.fn();
        globalThis.dnd5e = { registry: { messages: { track } } };
        const damage = makeRoll(env.classes.DamageRoll, { formula: "1d8", total: 5, faces: 8, results: [5] });

        const message = makeAttackCard("card-5", undefined);
        const registered = ActivityUtility._registerCardAsAttack(message, [damage]);

        expect(registered).toBe(false);
        expect(track).not.toHaveBeenCalled();
        expect(message.rolls).toEqual([]);
    });
});
