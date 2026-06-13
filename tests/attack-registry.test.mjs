import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupFoundryEnv, makeRoll } from "./helpers/foundry-env.mjs";

// Coverage for the registry re-sync that keeps AC5e in step after an attack roll is
// mutated post-creation (retroactive advantage, or a bonus applied to the attack).
describe("ChatUtility.resyncAttackRegistry", () => {
    let ChatUtility;
    let MODULE_SHORT;
    let env;

    beforeEach(async () => {
        vi.resetModules();
        env = await setupFoundryEnv();
        ({ ChatUtility } = await import("../src/utils/chat.js"));
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
});
