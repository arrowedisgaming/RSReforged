import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

let renderer, handlers, frames, observers;

beforeEach(async () => {
    vi.resetModules();
    ({ hookHandlers: handlers } = await setupFoundryEnv());
    game.system = { version: "6.0.1" };
    CONFIG.ChatMessage = { dataModels: Object.fromEntries(
        ["attack", "damage", "healing", "check", "save", "generic"].map(type => [type, {}])) };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    frames = new Map();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", callback => {
        frames.set(++nextFrame, callback);
        return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", id => frames.delete(id));
    // Use real DOM observers, but disconnect them between tests on the shared document.
    observers = [];
    vi.stubGlobal("MutationObserver", class extends window.MutationObserver {
        constructor(callback) {
            super(callback);
            observers.push(this);
        }
    });
    renderer = await import("../src/utils/native-render.js");
    const { HooksUtility } = await import("../src/utils/hooks.js");
    HooksUtility.registerChatHooks();
});

afterEach(() => {
    observers.forEach(observer => observer.disconnect());
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function flushFrame() {
    for (const id of [...frames.keys()]) {
        const callback = frames.get(id);
        if (!callback) continue;
        frames.delete(id);
        callback(0);
    }
}

function cards() {
    const original = document.createElement("li");
    original.className = "message";
    original.dataset.messageId = "attack";
    original.innerHTML = '<div class="message-content"><button>Roll</button></div>';
    const usage = document.createElement("li");
    usage.className = "message";
    usage.dataset.messageId = "usage";
    usage.innerHTML = '<div class="message-content"><section class="rsr-native-source" data-rsr-message-id="attack"></section></div>';
    // As renderNativeMessage registers the fold-ins it builds.
    renderer.markNativeSource(usage.querySelector(".rsr-native-source"));
    game.messages.set("attack", { id: "attack", type: "attack" });
    return { original, usage };
}

function render(original) {
    handlers.get("dnd5e.renderChatMessage")(game.messages.get("attack"), original);
}

const isHidden = original => original.classList.contains("rsr-native-combined-original");

it("hides a batch inserted after its rendering frame has already run", async () => {
    const { original, usage } = cards();
    render(original);
    // Foundry renders cards sequentially before inserting the entire batch. A later
    // unmanaged usage card can still be awaiting enrichment when this frame fires.
    flushFrame();
    document.body.append(usage, original);
    await Promise.resolve();
    flushFrame();

    expect(isHidden(original)).toBe(true);
    expect(original.querySelector(".message-content").childNodes).toHaveLength(0);
});

it("hides a late batch while frames remain stalled, even after all earlier fallback timers ran", async () => {
    const { original, usage } = cards();
    render(original);
    await vi.advanceTimersByTimeAsync(500);
    document.body.append(usage, original);
    await vi.advanceTimersByTimeAsync(100);

    expect(isHidden(original)).toBe(true);
});

it("restores an original after the usage card's deletion animation removes it", async () => {
    const { original, usage } = cards();
    document.body.append(usage, original);
    render(original);
    flushFrame();
    expect(isHidden(original)).toBe(true);
    ui.chat.updateMessage = vi.fn();

    handlers.get("deleteChatMessage")({ id: "usage", type: "usage" });
    flushFrame();
    // Foundry removes the card only after its 100 ms animation has finished.
    setTimeout(() => usage.remove(), 100);
    await vi.advanceTimersByTimeAsync(100);
    flushFrame();

    expect(isHidden(original)).toBe(false);
    expect(ui.chat.updateMessage).toHaveBeenCalledWith(game.messages.get("attack"));
});

it("observes cards adopted into a detached window while main-window frames are stalled", async () => {
    const { original, usage } = cards();
    const detachedDocument = document.implementation.createHTMLDocument("Detached chat");
    const detachedWindow = { document: detachedDocument };
    foundry.applications.detached = {
        querySelectorAll: selector => [
            ...document.querySelectorAll(selector), ...detachedDocument.querySelectorAll(selector)
        ]
    };
    // Production creates the window before moving already-rendered nodes into it.
    handlers.get("openDetachedWindow")?.("chat", detachedWindow);
    render(original);
    await vi.advanceTimersByTimeAsync(500);
    detachedDocument.body.append(usage, original);
    await vi.advanceTimersByTimeAsync(100);

    expect(isHidden(original)).toBe(true);
});

it("reconciles insertion after an earlier timer on clients without animation frames", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const { original, usage } = cards();
    render(original);
    setTimeout(() => document.body.append(usage, original), 0);
    renderer.scheduleReconcile();
    await vi.runAllTimersAsync();

    expect(isHidden(original)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
});

it("coalesces a burst and queries represented IDs only once, ignoring its own cleanup and unrelated DOM edits", async () => {
    const { original, usage } = cards();
    render(original);
    document.body.append(usage, original);
    // More messages must not multiply the source query.
    for (let i = 0; i < 50; i++) {
        const unrelated = original.cloneNode(true);
        unrelated.dataset.messageId = `unrelated-${i}`;
        document.body.append(unrelated);
    }
    for (let i = 0; i < 166; i++) renderer.scheduleReconcile();
    await Promise.resolve();
    const spy = vi.spyOn(document, "querySelectorAll");
    flushFrame();
    expect(isHidden(original)).toBe(true);
    expect(spy.mock.calls.filter(([selector]) => selector === ".rsr-native-source[data-rsr-message-id]")).toHaveLength(1);
    expect(spy.mock.calls.filter(([selector]) => selector === ".message[data-message-id]")).toHaveLength(1);

    // Neither clearing the original's controls nor normal page updates need a pass.
    original.classList.add("hovered");
    document.body.append(document.createElement("aside"));
    usage.querySelector(".rsr-native-source").append(document.createTextNode("Result"));
    await Promise.resolve();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

it("restores originals when the last detached representation closes and releases its observer", async () => {
    const { original, usage } = cards();
    const detachedDocument = document.implementation.createHTMLDocument("Detached chat");
    let open = true;
    foundry.applications.detached = {
        querySelectorAll: selector => [
            ...document.querySelectorAll(selector), ...(open ? detachedDocument.querySelectorAll(selector) : [])
        ]
    };
    handlers.get("openDetachedWindow")("chat", { document: detachedDocument });
    render(original);
    document.body.append(original);
    detachedDocument.body.append(usage);
    await Promise.resolve();
    flushFrame();
    expect(isHidden(original)).toBe(true);
    await Promise.resolve();
    ui.chat.updateMessage = vi.fn();

    // Foundry removes the window from its query registry before firing this hook.
    open = false;
    handlers.get("closeDetachedWindow")("chat");
    flushFrame();
    expect(isHidden(original)).toBe(false);
    expect(ui.chat.updateMessage).toHaveBeenCalledWith(game.messages.get("attack"));
    detachedDocument.body.replaceChildren();
    await Promise.resolve();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

it("leaves a card visible and settled when its own HTML copies a source marker for itself", async () => {
    const { original } = cards();
    // Foundry allows class and data-* attributes in message content. Such a marker
    // is not a fold-in RSR built, so it must not hide the card it sits in.
    original.querySelector(".message-content").innerHTML =
        '<section class="rsr-native-source" data-rsr-message-id="attack">Copied card</section>';
    const template = original.cloneNode(true);
    let current = original;
    ui.chat.updateMessage = vi.fn(() => {
        const replacement = template.cloneNode(true);
        render(replacement);
        current.replaceWith(replacement);
        current = replacement;
    });
    render(original);
    document.body.append(original);
    await Promise.resolve();
    for (let i = 0; i < 10; i++) {
        flushFrame();
        await Promise.resolve();
    }

    expect(isHidden(current)).toBe(false);
    expect(current.querySelector(".message-content").textContent).toBe("Copied card");
    expect(ui.chat.updateMessage).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

function cardWithCopiedMarker(id, markerFor) {
    const card = document.createElement("li");
    card.className = "message";
    card.dataset.messageId = id;
    card.innerHTML = `<div class="message-content"><section class="rsr-native-source" data-rsr-message-id="${markerFor}">Copied</section></div>`;
    game.messages.set(id, { id, type: "usage" });
    return card;
}

it("never hides cards whose own HTML carries copied source markers, so two of them can't loop", async () => {
    // Each card claims to represent itself; restoring one used to re-hide the other.
    const cardsById = { first: cardWithCopiedMarker("first", "first"), second: cardWithCopiedMarker("second", "second") };
    const { first, second } = cardsById;
    // Restoring a card re-renders it, which re-inserts its copied marker.
    ui.chat.updateMessage = vi.fn(message => {
        const replacement = cardWithCopiedMarker(message.id, message.id);
        cardsById[message.id].replaceWith(replacement);
        cardsById[message.id] = replacement;
    });
    renderer.observeNativeSources(document);
    document.body.append(first);
    await Promise.resolve();
    flushFrame();
    document.body.append(second);
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
        flushFrame();
    }

    expect(isHidden(cardsById.first)).toBe(false);
    expect(isHidden(cardsById.second)).toBe(false);
    expect(ui.chat.updateMessage).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

it("ignores a copied marker for another card, even inside an original that gets hidden", async () => {
    // A's content copies a marker for B; a real fold-in represents A, and A precedes B.
    const { original, usage } = cards();
    original.querySelector(".message-content").innerHTML =
        '<section class="rsr-native-source" data-rsr-message-id="other">Copied</section>';
    const other = document.createElement("li");
    other.className = "message";
    other.dataset.messageId = "other";
    other.innerHTML = '<div class="message-content"><button>Roll</button></div>';
    game.messages.set("other", { id: "other", type: "damage" });
    render(original);
    document.body.append(usage, original, other);
    await Promise.resolve();
    flushFrame();

    expect(isHidden(original)).toBe(true);
    expect(isHidden(other)).toBe(false);
    expect(other.querySelector(".message-content").childNodes).toHaveLength(1);
});

// Issue #48: rows of rolls RSR folds into its usage card. dnd5e can post one twice.

const PARENT = "usage";

function rsrUsage(id = PARENT) {
    const usage = { id, type: "usage", flags: { rsreforged: { workflowVersion: 2, quickRoll: true } } };
    game.messages.set(id, usage);
    return usage;
}

function foldedRoll(id, { type = "damage", parentId = PARENT, origin = parentId } = {}) {
    if (!game.messages.has(id)) {
        game.messages.set(id, {
            id, type, canUserModify: () => true,
            flags: { rsreforged: { workflowVersion: 2, parentId, deleteWithParent: true } },
            system: { origin }
        });
    }
    return game.messages.get(id);
}

function rowFor(id, { register = true } = {}) {
    const row = document.createElement("li");
    row.className = "chat-message message";
    row.dataset.messageId = id;
    row.innerHTML = '<header class="message-header"><time class="message-timestamp"></time></header><div class="message-content"><p>Roll</p></div>';
    // As dnd5e.renderChatMessage registers every rendered card, before ChatLog inserts it.
    if (register) renderRow(row, game.messages.get(id));
    return row;
}

function chatCard(id, options) {
    foldedRoll(id, options);
    return rowFor(id);
}

function renderRow(row, message) {
    handlers.get("dnd5e.renderChatMessage")(message, row);
}

function chatLog() {
    const log = document.createElement("ol");
    log.className = "chat-log";
    document.body.append(log);
    return log;
}

const ids = log => [...log.children].map(row => row.dataset.messageId);

/** By identity: duplicate rows are structurally equal, so toEqual cannot tell them apart. */
function expectRows(log, rows) {
    expect(log.children).toHaveLength(rows.length);
    rows.forEach((row, index) => expect(log.children[index]).toBe(row));
}

async function settle() {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
        flushFrame();
    }
    await vi.advanceTimersByTimeAsync(200);
    flushFrame();
}

it("drops the earlier copy as soon as Foundry posts a card again, keeping the one it still measures, with no frame, timer or saved message", async () => {
    rsrUsage();
    const [log, notifications] = [chatLog(), chatLog()];
    const [first, repost, notification] = [1, 2, 3].map(() => chatCard("damage"));
    renderer.observeNativeSources(document);
    log.append(first);
    notifications.append(notification);
    await Promise.resolve();
    // Foundry's timestamp ticks put Text nodes in the same observer batch.
    first.querySelector(".message-timestamp").textContent = "now";
    log.append(repost);
    await Promise.resolve();

    expect(first.isConnected).toBe(false);
    expect(repost.isConnected).toBe(true);
    expect(notification.isConnected).toBe(true);
});

it("keeps the card a scrolled-back page prepends in date order and drops the stray Foundry had appended at the bottom", async () => {
    rsrUsage();
    const log = chatLog();
    const [stray, newer, inOrder] = [chatCard("old"), chatCard("newer"), chatCard("old")];
    renderer.observeNativeSources(document);
    log.append(newer, stray);
    await Promise.resolve();
    log.prepend(inOrder);
    await Promise.resolve();

    expect(inOrder.isConnected).toBe(true);
    expect(stray.isConnected).toBe(false);
});

it("keeps the last insertion when a prepend follows an append within one observer delivery", async () => {
    rsrUsage();
    const log = chatLog();
    const [old, latest] = [chatCard("damage"), chatCard("damage")];
    renderer.observeNativeSources(document);
    log.append(old);
    log.prepend(latest);
    await Promise.resolve();

    expectRows(log, [latest]);
});

it("never removes a row RSR did not register: a non-message sibling, Foundry's notification placeholder, or a local-only card", async () => {
    rsrUsage();
    const log = chatLog();
    const real = chatCard("damage");
    renderer.observeNativeSources(document);
    log.append(real);
    await Promise.resolve();
    const sibling = document.createElement("div");
    sibling.dataset.messageId = "damage";
    const placeholder = rowFor("damage", { register: false });
    const localOnly = rowFor("local", { register: false });
    log.append(sibling, placeholder, localOnly);
    await settle();

    expectRows(log, [real, sibling, placeholder, localOnly]);
    expect(localOnly.classList.contains("rsr-native-combined-original")).toBe(false);
});

it("leaves cards with an empty message id alone, so two local-only cards both stay", async () => {
    const log = chatLog();
    const [first, second] = [rowFor("", { register: false }), rowFor("", { register: false })];
    renderer.observeNativeSources(document);
    log.append(first);
    await Promise.resolve();
    log.append(second);
    await Promise.resolve();

    expect(first.isConnected).toBe(true);
    expect(second.isConnected).toBe(true);
});

it("dedupes only the cards a chat log holds directly, not a copy quoted in an earlier message or a list outside a log", async () => {
    rsrUsage();
    const log = chatLog();
    const quoting = chatCard("quoting");
    quoting.querySelector(".message-content").innerHTML = '<div class="message" data-message-id="damage"></div>';
    const list = document.createElement("ol");
    document.body.append(list);
    const [damage, listed, relisted] = [1, 2, 3].map(() => chatCard("damage"));
    renderer.observeNativeSources(document);
    log.append(quoting);
    list.append(listed);
    await Promise.resolve();
    log.append(damage);
    list.append(relisted);
    await Promise.resolve();

    expect(damage.isConnected).toBe(true);
    expect(quoting.querySelector('[data-message-id="damage"]')).not.toBeNull();
    expect(listed.isConnected).toBe(true);
    expect(relisted.isConnected).toBe(true);
});

it("dedupes a multi-row batch per log in one scan, compares a quoted ID as a string, and then goes quiet", async () => {
    rsrUsage();
    const [log, other] = [chatLog(), chatLog()];
    const quoted = 'say "hi"';
    const kept = chatCard(quoted);
    const elsewhere = chatCard(quoted);
    renderer.observeNativeSources(document);
    log.append(chatCard("unique"), kept);
    other.append(elsewhere);
    await Promise.resolve();

    const reads = Object.getOwnPropertyDescriptor(window.Element.prototype, "children").get;
    let scans = 0;
    Object.defineProperty(log, "children", { configurable: true, get() { scans++; return reads.call(this); } });
    const batch = document.createDocumentFragment();
    const [x, repost, y, xAgain] = [chatCard("x"), chatCard(quoted), chatCard("y"), chatCard("x")];
    batch.append(x, repost, y, xAgain);
    log.append(batch);
    await Promise.resolve();
    expect(scans).toBe(1);
    await settle();

    delete log.children;
    expect(ids(log)).toEqual(["unique", quoted, "y", "x"]);
    expect(kept.isConnected).toBe(false);
    expect(repost.isConnected).toBe(true);
    expect(xAgain.isConnected).toBe(true);
    expect(elsewhere.isConnected).toBe(true);
    expect(scans).toBe(1);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

/**
 * The folded card from issue #48: a usage card representing an attack and a damage roll,
 * with the damage row posted twice, as dnd5e's origin refresh does for a batched roll.
 */
async function foldedCard() {
    const log = chatLog();
    const usage = rsrUsage();
    foldedRoll("attack", { type: "attack" });
    foldedRoll("damage");
    const usageRow = document.createElement("li");
    usageRow.className = "chat-message message";
    usageRow.dataset.messageId = PARENT;
    usageRow.innerHTML = '<div class="message-content"></div>';
    for (const id of ["attack", "damage"]) {
        const section = document.createElement("section");
        section.dataset.rsrMessageId = id;
        renderer.markNativeSource(section);
        usageRow.querySelector(".message-content").append(section);
    }
    renderer.observeNativeSources(document);
    const [attack, damage, repost] = [rowFor("attack"), rowFor("damage"), rowFor("damage")];
    log.append(usageRow, attack, damage);
    log.append(repost);
    await settle();
    return { log, usage, usageRow, attack, damage: repost };
}

/** Foundry's deletion: the batch leaves the collection, then each client's ChatLog removes the first row per ID and fires the hook. */
async function serverDelete(log, documents, userId = "user-1") {
    for (const message of documents) game.messages.delete(message.id);
    for (const message of documents) {
        log.querySelector(`.message[data-message-id="${message.id}"]`)?.remove();
        handlers.get("deleteChatMessage")(message, {}, userId);
    }
    await settle();
}

it("keeps one row per folded roll while the card shows them, then deletes the card and its rolls with nothing left behind", async () => {
    const { log, usage, usageRow, attack, damage } = await foldedCard();
    expectRows(log, [usageRow, attack, damage]);
    expect(isHidden(attack) && isHidden(damage)).toBe(true);

    let rowsDuringCascade;
    ChatMessage.implementation.deleteDocuments = vi.fn(async deleted => {
        // The usage row is gone, its rolls are not yet: they must not be exposed.
        rowsDuringCascade = [...log.children].map(row => [row.dataset.messageId, isHidden(row)]);
        await serverDelete(log, deleted.map(id => game.messages.get(id)));
    });
    await serverDelete(log, [usage]);

    expect(ChatMessage.implementation.deleteDocuments).toHaveBeenCalledWith(["attack", "damage"]);
    expect(rowsDuringCascade).toEqual([["attack", true], ["damage", true]]);
    expect(log.children).toHaveLength(0);
    expect(game.messages.size).toBe(0);
});

it("leaves an empty log after a flush, and a fresh roll still posts normally", async () => {
    const { log, usage } = await foldedCard();
    ChatMessage.implementation.deleteDocuments = vi.fn();
    const all = [usage, game.messages.get("attack"), game.messages.get("damage")];
    await serverDelete(log, all);

    expect(log.children).toHaveLength(0);
    expect(game.messages.size).toBe(0);
    // Already deleted in the same batch: nothing left to cascade.
    expect(ChatMessage.implementation.deleteDocuments).not.toHaveBeenCalled();

    rsrUsage("next");
    const fresh = chatCard("fresh", { parentId: "next" });
    log.append(fresh);
    await settle();
    expectRows(log, [fresh]);
    expect(isHidden(fresh)).toBe(false);
});

it("removes a registered row that arrives after its document was deleted, with no duplicate left to compare", async () => {
    rsrUsage();
    const log = chatLog();
    renderer.observeNativeSources(document);
    const late = chatCard("damage");
    game.messages.delete("damage");
    log.append(late);
    await settle();

    expect(late.isConnected).toBe(false);
});

it("keeps rolls hidden while their deleted card's cascade cannot run, including after a reload", async () => {
    const { log, usage, attack, damage } = await foldedCard();
    // The deleting player may not delete these, and no GM is online.
    for (const id of ["attack", "damage"]) game.messages.get(id).canUserModify = () => false;
    ChatMessage.implementation.deleteDocuments = vi.fn();
    await serverDelete(log, [usage]);

    expect(ChatMessage.implementation.deleteDocuments).not.toHaveBeenCalled();
    expectRows(log, [attack, damage]);
    expect(isHidden(attack) && isHidden(damage)).toBe(true);

    // Reload: the rows are rendered afresh, with no RSR state carried over.
    log.replaceChildren();
    await settle();
    const [attackAgain, damageAgain] = [rowFor("attack"), rowFor("damage")];
    expect(isHidden(attackAgain) && isHidden(damageAgain)).toBe(true);
    log.append(attackAgain, damageAgain);
    await settle();
    expect(isHidden(attackAgain) && isHidden(damageAgain)).toBe(true);
});

it("restores a folded roll when its live card only leaves the view, as on a pruned page", async () => {
    const { usageRow, damage } = await foldedCard();
    ui.chat.updateMessage = vi.fn();
    usageRow.remove();
    await settle();

    expect(isHidden(damage)).toBe(false);
    expect(ui.chat.updateMessage).toHaveBeenCalledWith(game.messages.get("damage"));
    expect(game.messages.has("damage")).toBe(true);
});

it("does not claim a roll whose native origin names a different card than its RSR link", async () => {
    rsrUsage();
    foldedRoll("damage", { parentId: "deleted-card", origin: PARENT });
    const log = chatLog();
    renderer.observeNativeSources(document);
    const row = rowFor("damage");
    log.append(row);
    await settle();

    expect(isHidden(row)).toBe(false);
    expect(row.isConnected).toBe(true);
});

it("keeps showing a roll from before this version whose card is gone, as that version restored it", async () => {
    foldedRoll("damage", { parentId: "deleted-before-upgrade" });
    delete game.messages.get("damage").flags.rsreforged.deleteWithParent;
    const log = chatLog();
    renderer.observeNativeSources(document);
    const row = rowFor("damage");
    log.append(row);
    await settle();

    expect(isHidden(row)).toBe(false);
    expect(row.isConnected).toBe(true);
});

it("cleans up the duplicate rows of a Damage-button roll made before rolls were linked to their card", async () => {
    const { log } = await foldedCard();
    // dnd5e's own message: no RSR flags, only its native origin names the RSR card.
    game.messages.set("old-manual", { id: "old-manual", type: "damage", flags: {}, system: { origin: PARENT }, canUserModify: () => true });
    const [first, repost] = [rowFor("old-manual"), rowFor("old-manual")];
    log.append(first);
    await Promise.resolve();
    log.append(repost);
    await settle();
    expect(first.isConnected).toBe(false);
    expect(repost.isConnected).toBe(true);

    // Its document goes before Foundry removes the row: the row is removed, not exposed empty.
    game.messages.delete("old-manual");
    log.append(rowFor("unrelated", { register: false }));
    await settle();
    expect(repost.isConnected).toBe(false);
});

it("removes a stray copy of a row RSR hid once its document is gone, even after it was shown again", async () => {
    const { log, usage, usageRow, attack } = await foldedCard();
    // A roll from before this version: shown again when its card goes, not kept hidden.
    delete game.messages.get("attack").flags.rsreforged.deleteWithParent;
    const stray = attack.cloneNode(true);
    log.append(stray);
    await settle();
    expect(isHidden(stray)).toBe(true);

    ui.chat.updateMessage = vi.fn();
    game.messages.delete(usage.id);
    usageRow.remove();
    await settle();
    expect(isHidden(stray)).toBe(false);

    // Foundry removes only the first row for the deleted roll.
    game.messages.delete("attack");
    attack.remove();
    await settle();
    expect(stray.isConnected).toBe(false);
});
