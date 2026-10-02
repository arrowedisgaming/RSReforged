import { beforeEach, it, expect, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

let hooks, callbacks;

beforeEach(async () => {
    vi.resetModules();
    await setupFoundryEnv({ settings: { enableQuickActivity: true } });
    game.system = { version: "6.0.1" };
    CONFIG.ChatMessage = { dataModels: Object.fromEntries(["attack", "damage", "healing", "check", "save", "generic"].map((t) => [t, {}])) };
    callbacks = new Map();
    Hooks.on = (name, cb) => callbacks.set(name, cb);
    hooks = await import("../src/utils/hooks.js");
    hooks.HooksUtility.registerRollHooks();
});

it("leaves unsupported activities and message-free uses entirely native", () => {
    const cb = callbacks.get("dnd5e.preUseActivity");
    for (const [type, create] of [["summon", true], ["attack", false]]) {
        const usage = { subsequentActions: true }, dialog = {}, message = { create };
        cb({ type }, usage, dialog, message);
        expect(usage.subsequentActions).toBe(true);
        expect(message.data).toBeUndefined();
    }
});

it("registers finalized-use execution independently of rendering", () => {
    expect(callbacks.has("dnd5e.postUseActivity")).toBe(true);
});

it("records the destroyed ammunition snapshot from dnd5e's attack hook", async () => {
    const workflow = await import("../src/utils/native-workflow.js");
    const record = vi.spyOn(workflow, "recordAmmunitionSnapshot").mockImplementation(() => {});
    const subject = { id: "activity" };
    const ammoUpdate = { id: "arrow", quantity: 0, destroy: true };

    callbacks.get("dnd5e.rollAttack")([], { subject, ammoUpdate });

    expect(record).toHaveBeenCalledWith(subject, ammoUpdate);
});

it("hands dnd5e's internal message config to the native capture without vetoing the roll", async () => {
    const workflow = await import("../src/utils/native-workflow.js");
    const capture = vi.spyOn(workflow, "captureNativeMessageConfig").mockImplementation(() => {});
    const message = { data: { flags: { rsreforged: { nativeCaptureId: "native-1" } } } };

    const result = callbacks.get("dnd5e.postRollConfiguration")([], {}, {}, message);

    expect(capture).toHaveBeenCalledWith(message);
    expect(result).not.toBe(false);
});

it("does not register document-creation side effects for the base workflow", () => {
    hooks.HooksUtility.registerChatHooks();
    expect(callbacks.has("createChatMessage")).toBe(false);
});
