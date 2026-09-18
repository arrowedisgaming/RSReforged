import { beforeEach, it, expect, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

let renderer;

beforeEach(async () => {
    vi.resetModules();
    await setupFoundryEnv();
    renderer = await import("../src/utils/native-render.js");
});

function nativeChild(id, type, innerHTML) {
    const node = document.createElement("li");
    node.className = "chat-message message";
    node.dataset.messageId = id;
    node.innerHTML = `<header class="message-header">${id}</header><div class="message-content">${innerHTML}</div>`;
    return { node, message: { id, type, visible: true, isContentVisible: true, rolls: [], flags: {}, renderHTML: async () => node, delete: vi.fn() } };
}

function usageParent(children, { flags = { rsreforged: { workflowVersion: 2, quickRoll: true } } } = {}) {
    return { id: "parent", type: "usage", isContentVisible: true, flags, getAssociatedRolls: () => children };
}

function usageHtml() {
    const html = document.createElement("li");
    html.className = "chat-message message";
    html.dataset.messageId = "parent";
    html.innerHTML = '<div class="message-content"><div class="chat-card"><button data-action="rollDamage">Damage</button></div></div>';
    return html;
}

it("folds native children into the usage card, keeping their identity and markup untouched", async () => {
    const attack = nativeChild("attack", "attack", '<button class="dice-roll"><span class="total">17</span></button><div class="roll-breakdown" popover>d20</div>');
    const damage = nativeChild("damage", "damage", '<button class="dice-roll"><span class="total">9</span></button><damage-application></damage-application>');
    const tray = damage.node.querySelector("damage-application");
    const html = usageHtml();

    await renderer.renderNativeMessage(usageParent([attack.message, damage.message]), html);

    const combined = html.querySelector(".message-content > .rsr-native-combined");
    expect([...combined.children].map((node) => node.dataset.messageId)).toEqual(["attack", "damage"]);
    expect(combined.querySelector('[data-message-id="damage"] damage-application')).toBe(tray);
    expect(tray.closest("[data-message-id]").dataset.messageId).toBe("damage");
    expect(combined.querySelectorAll("button").length).toBe(2);
    expect(combined.querySelector("select")).toBeNull();
    expect(combined.querySelector(".rsr-native-controls")).toBeNull();
    expect(html.querySelector('[data-action="rollDamage"]')).not.toBeNull();
    expect(attack.message.delete).not.toHaveBeenCalled();
});

it("replaces a previous fold-in instead of stacking a second one", async () => {
    const attack = nativeChild("attack", "attack", '<button class="dice-roll"></button>');
    const parent = usageParent([attack.message]);
    const html = usageHtml();

    await renderer.renderNativeMessage(parent, html);
    await renderer.renderNativeMessage(parent, html);

    expect(html.querySelectorAll(".rsr-native-combined")).toHaveLength(1);
});

it("keeps private children and save responses out of the combined card", async () => {
    const hidden = { id: "hidden", type: "damage", visible: true, isContentVisible: false, renderHTML: vi.fn() };
    const save = { id: "save", type: "save", visible: true, isContentVisible: true, renderHTML: vi.fn() };
    const html = usageHtml();

    await renderer.renderNativeMessage(usageParent([hidden, save]), html);

    expect(hidden.renderHTML).not.toHaveBeenCalled();
    expect(save.renderHTML).not.toHaveBeenCalled();
});

it("leaves usage cards that RSR did not manage and non-usage messages untouched", async () => {
    const child = nativeChild("attack", "attack", '<button class="dice-roll"></button>');
    const legacy = usageHtml();
    await renderer.renderNativeMessage(usageParent([child.message], { flags: {} }), legacy);
    expect(legacy.querySelector(".rsr-native-combined")).toBeNull();

    const before = child.node.outerHTML;
    await renderer.renderNativeMessage(child.message, child.node);
    expect(child.node.outerHTML).toBe(before);
});

it("keeps the combined block hidden until Dice So Nice finishes the child's throw", async () => {
    const attack = nativeChild("attack", "attack", '<button class="dice-roll"></button>');
    attack.message._dice3danimating = true;
    let finish;
    game.dice3d = {
        isEnabled: () => true,
        waitFor3DAnimationByMessageID: vi.fn((id) => new Promise((resolve) => { finish = () => resolve(id); }))
    };
    const html = usageHtml();

    const rendering = renderer.renderNativeMessage(usageParent([attack.message]), html);
    await Promise.resolve();
    await Promise.resolve();
    const combined = html.querySelector(".rsr-native-combined");
    expect(combined).not.toBeNull();
    expect(combined.hidden).toBe(true);
    expect(game.dice3d.waitFor3DAnimationByMessageID).toHaveBeenCalledWith("attack");

    finish();
    await rendering;
    expect(combined.hidden).toBe(false);
});

it("reveals the combined block even if Dice So Nice never reports the throw complete", async () => {
    vi.useFakeTimers();
    try {
        const attack = nativeChild("attack", "attack", '<button class="dice-roll"></button>');
        attack.message._dice3danimating = true;
        // A backgrounded tab or a Dice So Nice error: the completion hook never fires.
        game.dice3d = { isEnabled: () => true, waitFor3DAnimationByMessageID: () => new Promise(() => {}) };
        const html = usageHtml();

        const rendering = renderer.renderNativeMessage(usageParent([attack.message]), html);
        await vi.advanceTimersByTimeAsync(60_000);
        await rendering;

        expect(html.querySelector(".rsr-native-combined").hidden).toBe(false);
    } finally {
        vi.useRealTimers();
    }
});

it("hides an original child card only while a fold-in represents it", () => {
    const original = document.createElement("li");
    original.className = "message";
    original.dataset.messageId = "attack";
    original.innerHTML = '<div class="message-content"><button class="dice-roll"></button></div>';
    document.body.append(original);
    const folded = document.createElement("li");
    folded.className = "message rsr-native-source";
    folded.dataset.messageId = "attack";
    folded.dataset.rsrMessageId = "attack";
    document.body.append(folded);
    ui.chat.updateMessage = vi.fn();
    game.messages.set("attack", { id: "attack" });

    renderer.reconcileNativeSources();
    expect(original.classList.contains("rsr-native-combined-original")).toBe(true);
    expect(original.querySelector(".message-content").childNodes).toHaveLength(0);

    folded.remove();
    renderer.reconcileNativeSources();
    expect(original.classList.contains("rsr-native-combined-original")).toBe(false);
    expect(ui.chat.updateMessage).toHaveBeenCalledWith(game.messages.get("attack"));
});

it("re-renders a managed parent once for roll-only child updates", async () => {
    const parent = { id: "parent", flags: { rsreforged: { workflowVersion: 2 } } };
    game.messages.set("parent", parent);
    ui.chat.updateMessage = vi.fn();
    const child = { id: "child", system: { origin: parent } };

    renderer.refreshNativeOrigin(child);
    renderer.refreshNativeOrigin(child);
    await Promise.resolve();

    expect(ui.chat.updateMessage).toHaveBeenCalledTimes(1);
    expect(ui.chat.updateMessage).toHaveBeenCalledWith(parent);
});
