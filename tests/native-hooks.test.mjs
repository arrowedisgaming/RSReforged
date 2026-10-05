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

// dnd5e 6.0.1 DamageRoll.applyKeybindings (dnd5e.mjs ≈72410; identical in 6.0.5), which
// BasicRoll.buildConfigure runs after every preRoll hook. Kept verbatim so these tests
// assert the final dialog decision, not just what RSR's hook wrote.
function dnd5eDamageKeybindings(config, dialog, areKeysPressed) {
    const keys = {
        default: areKeysPressed(config.event, "skipDialogNormal"),
        normal: areKeysPressed(config.event, "skipDialogDisadvantage"),
        critical: areKeysPressed(config.event, "skipDialogAdvantage")
    };
    dialog.configure ??= Object.values(keys).every(k => !k);
    config.isCritical ||= keys.critical;
    config.isCritical &&= !keys.normal;
    for (const roll of config.rolls) {
        roll.options ??= {};
        roll.options.isCritical ??= config.isCritical;
    }
}

// dnd5e's default bindings (dnd5e.mjs ≈57247).
function registerDnd5eSkipKeys({ normal = [{ key: "ShiftLeft", modifiers: [] }] } = {}) {
    game.keybindings.register("dnd5e", "skipDialogNormal", { editable: normal });
    game.keybindings.register("dnd5e", "skipDialogAdvantage", { editable: [{ key: "AltLeft", modifiers: [] }] });
    game.keybindings.register("dnd5e", "skipDialogDisadvantage", { editable: [{ key: "ControlLeft", modifiers: [] }] });
}

function damageClick({ quickRoll = true, isCritical = false, ...keys } = {}) {
    const card = document.createElement("li");
    card.dataset.messageId = "card";
    card.innerHTML = '<div class="chat-card"><button data-action="rollDamage"></button></div>';
    game.messages.set("card", { id: "card", flags: { rsreforged: { workflowVersion: 2, quickRoll } } });
    return { event: { target: card.querySelector("button"), ...keys }, rolls: [{ options: {} }], isCritical };
}

async function rollDamageThroughDnd5e(config) {
    const { CoreUtility } = await import("../src/utils/core.js");
    const dialog = {};
    const result = callbacks.get("dnd5e.preRollDamage")(config, dialog, {});
    dnd5eDamageKeybindings(config, dialog, (event, action) => CoreUtility.areKeysPressed(event, action));
    return { result, dialog, critical: config.rolls[0].options.isCritical };
}

it("quick-rolls dnd5e's Damage button on an RSR card, and opens the dialog with Shift", async () => {
    registerDnd5eSkipKeys();

    const plain = await rollDamageThroughDnd5e(damageClick());
    expect(plain.dialog.configure).toBe(false);
    expect(plain.result).not.toBe(false);

    // dnd5e alone would fast-forward on Shift; RSR's convention is the reverse.
    expect((await rollDamageThroughDnd5e(damageClick({ shiftKey: true }))).dialog.configure).toBe(true);
});

it("leaves critical and normal modifiers to dnd5e on a forwarded click", async () => {
    registerDnd5eSkipKeys();

    const alt = await rollDamageThroughDnd5e(damageClick({ altKey: true }));
    expect(alt.dialog.configure).toBe(false);
    expect(alt.critical).toBe(true);

    // Ctrl on a critical hit's damage asks for normal damage.
    const ctrl = await rollDamageThroughDnd5e(damageClick({ ctrlKey: true, isCritical: true }));
    expect(ctrl.dialog.configure).toBe(false);
    expect(ctrl.critical).toBe(false);

    // A plain click on a critical hit keeps it critical.
    expect((await rollDamageThroughDnd5e(damageClick({ isCritical: true }))).critical).toBe(true);
});

it("follows a rebound dialog key rather than Shift", async () => {
    registerDnd5eSkipKeys({ normal: [{ key: "KeyQ", modifiers: [] }] });

    game.keyboard.downKeys.add("KeyQ");
    expect((await rollDamageThroughDnd5e(damageClick())).dialog.configure).toBe(true);
    game.keyboard.downKeys.delete("KeyQ");
    expect((await rollDamageThroughDnd5e(damageClick({ shiftKey: true }))).dialog.configure).toBe(false);
});

it("leaves dialog-rolled cards and non-RSR rolls entirely to dnd5e", async () => {
    registerDnd5eSkipKeys();
    for (const config of [damageClick({ quickRoll: false }), { rolls: [{ options: {} }], event: undefined }]) {
        expect((await rollDamageThroughDnd5e(config)).dialog.configure).toBe(true);
    }
    expect((await rollDamageThroughDnd5e(damageClick({ quickRoll: false, shiftKey: true }))).dialog.configure).toBe(false);
});
