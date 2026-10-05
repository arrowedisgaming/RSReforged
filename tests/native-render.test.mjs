import { beforeEach, it, expect, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

let renderer;

beforeEach(async () => {
    vi.resetModules();
    await setupFoundryEnv();
    // The section markup has its own tests; here each child becomes a stub section.
    vi.doMock("../src/utils/native-card.js", () => ({
        renderRsrSection: vi.fn(async (parent, child) => {
            const section = document.createElement("div");
            section.className = `rsr-card rsr-section-${child.type}`;
            section.dataset.messageId = child.id;
            section.dataset.rsrMessageId = child.id;
            return section;
        }),
        renderRsrCheck: vi.fn(async (message) => {
            const section = document.createElement("div");
            section.className = "rsr-card rsr-check";
            section.dataset.messageId = message.id;
            return section;
        })
    }));
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
    html.innerHTML = `<div class="message-content"><div class="chat-card"><section class="icon-row"><ul>
        <li><button data-action="rollAttack">Attack</button></li>
        <li><button data-action="rollDamage">Damage</button></li>
    </ul></section></div><div class="card-summary"></div></div>`;
    return html;
}

function manualUsageHtml(actions = ["rollAttack", "rollDamage", "placeTemplate"]) {
    const html = document.createElement("li");
    html.className = "chat-message message";
    html.dataset.messageId = "parent";
    const buttons = actions.map((action) =>
        `<li><button type="button" class="icon" data-action="${action}" aria-label="${action}-label"><i class="fa-solid fa-burst"></i></button></li>`).join("");
    html.innerHTML = `<div class="message-content"><div class="chat-card"><section class="icon-row"><ul>${buttons}</ul></section></div></div>`;
    return html;
}

const isHidden = (html, action) => html.querySelector(`[data-action="${action}"]`).closest("li").classList.contains("rsr-native-hidden");

it("renders one RSR section per child under the item card, attack first, each keeping its child's identity", async () => {
    const attack = nativeChild("attack", "attack", "");
    const damage = nativeChild("damage", "damage", "");
    const html = usageHtml();

    // dnd5e's registry does not guarantee creation order.
    await renderer.renderNativeMessage(usageParent([damage.message, attack.message]), html);

    const combined = html.querySelector(".message-content > .rsr-native-combined");
    expect(combined.previousElementSibling.classList.contains("chat-card")).toBe(true);
    expect(combined.nextElementSibling.classList.contains("card-summary")).toBe(true);
    expect([...combined.children].map((node) => node.dataset.messageId)).toEqual(["attack", "damage"]);
    expect([...combined.children].every((node) => node.classList.contains("rsr-native-source"))).toBe(true);
    // Scopes the description and pill-row adjustments to RSR's cards.
    expect(html.classList.contains("rsr-native-card")).toBe(true);
    expect(attack.message.delete).not.toHaveBeenCalled();
});

it("hides the usage card's roll buttons once their rolls are shown, and widens an unrolled Damage", async () => {
    const attack = nativeChild("attack", "attack", "");
    const html = manualUsageHtml();

    await renderer.renderNativeMessage(usageParent([attack.message]), html);

    expect(isHidden(html, "rollAttack")).toBe(true);
    // Damage isn't rolled yet: its icon gives way to one wide button.
    expect(isHidden(html, "rollDamage")).toBe(true);
    expect(html.querySelectorAll(".rsr-wide-action")).toHaveLength(1);
    // Unrelated native actions stay usable, and so does their row.
    expect(isHidden(html, "placeTemplate")).toBe(false);
    expect(html.querySelector(".icon-row").classList.contains("rsr-native-hidden")).toBe(false);

    const both = manualUsageHtml(["rollAttack", "rollDamage"]);
    await renderer.renderNativeMessage(usageParent([attack.message, nativeChild("damage", "damage", "").message]), both);
    expect(both.querySelector(".rsr-wide-action")).toBeNull();
    expect(both.querySelector(".icon-row").classList.contains("rsr-native-hidden")).toBe(true);
});

it("toggles a section's breakdown on click, but not from its buttons", async () => {
    const attack = nativeChild("attack", "attack", "");
    const html = usageHtml();
    await renderer.renderNativeMessage(usageParent([attack.message]), html);
    const section = html.querySelector(".rsr-card");
    section.innerHTML = `<div class="dice-roll"><h4 class="dice-total">12
        <div class="rsr-overlay"><div data-action="rsr-retro" data-state="kh"></div></div></h4>
        <button class="apply">x</button></div>`;
    const roll = section.querySelector(".dice-roll");

    section.querySelector(".dice-total").click();
    expect(roll.classList.contains("expanded")).toBe(true);
    section.querySelector(".apply").click();
    expect(roll.classList.contains("expanded")).toBe(true);
    // A hovered retro overlay covers the whole total: clicking the number through it
    // still toggles, but its chevrons do not.
    section.querySelector(".rsr-overlay").click();
    expect(roll.classList.contains("expanded")).toBe(false);
    section.querySelector(".rsr-overlay [data-action]").click();
    expect(roll.classList.contains("expanded")).toBe(false);
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
    const { renderRsrSection } = await import("../src/utils/native-card.js");
    const hidden = { id: "hidden", type: "damage", visible: true, isContentVisible: false };
    const save = { id: "save", type: "save", visible: true, isContentVisible: true };
    const html = usageHtml();

    await renderer.renderNativeMessage(usageParent([hidden, save]), html);

    expect(renderRsrSection).not.toHaveBeenCalled();
    expect(html.querySelector(".rsr-native-combined")).toBeNull();
});

it("leaves usage cards that RSR did not manage and non-usage messages untouched", async () => {
    const child = nativeChild("attack", "attack", '<button class="dice-roll"></button>');
    const legacy = usageHtml();
    await renderer.renderNativeMessage(usageParent([child.message], { flags: {} }), legacy);
    expect(legacy.querySelector(".rsr-native-combined")).toBeNull();
    expect(legacy.classList.contains("rsr-native-card")).toBe(false);

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

it("keeps the combined block hidden until RSR's pooled throw lands", async () => {
    const attack = nativeChild("attack", "attack", "");
    let land;
    attack.message._rsrNativeThrow = new Promise((resolve) => { land = resolve; });
    game.dice3d = { isEnabled: () => true, waitFor3DAnimationByMessageID: vi.fn() };
    const html = usageHtml();

    const rendering = renderer.renderNativeMessage(usageParent([attack.message]), html);
    await Promise.resolve();
    await Promise.resolve();
    expect(html.querySelector(".rsr-native-combined").hidden).toBe(true);
    expect(game.dice3d.waitFor3DAnimationByMessageID).not.toHaveBeenCalled();

    land();
    await rendering;
    expect(html.querySelector(".rsr-native-combined").hidden).toBe(false);
});

function checkMessage({ quickRoll = true, isContentVisible = true, isAuthor = true } = {}) {
    return { id: "chk", type: "check", isContentVisible, isAuthor, system: { type: "ability", skill: "ath" }, flags: { rsreforged: { quickRoll, processed: true } }, rolls: [] };
}

function checkHtml() {
    const html = document.createElement("li");
    html.className = "chat-message message";
    html.dataset.messageId = "chk";
    html.innerHTML = `<header class="message-header"><h4 class="message-sender">Azer</h4><span class="flavor-text">Athletics</span></header>
        <div class="message-content"><div class="chat-card"><p class="supplement">kept</p></div>
        <section class="icon-row"><i class="fa-dice"></i><button class="dice-roll">12</button><div class="roll-breakdown" popover></div></section></div>`;
    return html;
}

it("replaces a quick-rolled check's compact roll row with RSR's, keeping dnd5e's header and supplements", async () => {
    const html = checkHtml();

    await renderer.renderNativeMessage(checkMessage(), html);

    const content = html.querySelector(".message-content");
    expect(content.querySelector(":scope > .icon-row")).toBeNull();
    expect(content.querySelector(":scope > .rsr-check")).not.toBeNull();
    expect(content.querySelector(".supplement").textContent).toBe("kept");
    expect(html.classList.contains("rsr-native-card")).toBe(true);
    // The 4.x header "+" for the roll's author.
    expect(html.querySelector('.message-header .rsr-addon-bonus-btn[data-type="skill"]')).not.toBeNull();
});

it("leaves dialog-rolled and private checks as dnd5e rendered them", async () => {
    const { renderRsrCheck } = await import("../src/utils/native-card.js");
    for (const message of [checkMessage({ quickRoll: false }), checkMessage({ isContentVisible: false })]) {
        const html = checkHtml();
        await renderer.renderNativeMessage(message, html);
        expect(html.querySelector(".icon-row .dice-roll")).not.toBeNull();
        expect(html.querySelector(".rsr-check")).toBeNull();
    }
    expect(renderRsrCheck).not.toHaveBeenCalled();
});

it("styles every check in vanilla-with-styling mode, and gives other players no bonus button", async () => {
    game.settings.set("rsreforged", "enableVanillaQuickRoll", true);
    const html = checkHtml();

    await renderer.renderNativeMessage(checkMessage({ quickRoll: false, isAuthor: false }), html);

    expect(html.querySelector(".rsr-check")).not.toBeNull();
    expect(html.querySelector(".rsr-addon-bonus-btn")).toBeNull();
});

it("masks an NPC's save summarised on a usage card for players, in either hidden style", async () => {
    game.settings.set("rsreforged", "hideNpcRollMode", "all");
    game.user.isGM = false;
    const save = { id: "sv", type: "save", system: { type: "ability", ability: "dex" }, getAssociatedActor: () => ({ isOwner: false }) };
    game.messages.set("sv", save);
    const summaryHtml = () => {
        const html = usageHtml();
        html.querySelector(".card-summary").dataset.messageId = "sv";
        html.querySelector(".card-summary").innerHTML = `<section class="icon-row save-summary">
            <button class="dice-roll failure"><span class="icons"><i class="fa-xmark"></i></span>
            <span class="result"><strong class="total">10</strong></span><span class="d20die"><span class="roll">9</span></span></button>
            <div class="roll-breakdown" popover>9 + 1</div></section>`;
        return html;
    };

    game.settings.set("rsreforged", "hideNpcRollStyle", "total");
    const total = summaryHtml();
    await renderer.renderNativeMessage(usageParent([]), total);
    const hidden = total.querySelector(".card-summary");
    expect(hidden.querySelector(".total").textContent).toBe("rsreforged.chat.hide");
    expect(hidden.querySelector(".d20die .roll").textContent).toBe("9");
    expect(hidden.querySelector(".icons").children).toHaveLength(0);
    expect(hidden.querySelector(".dice-roll").classList.contains("failure")).toBe(false);
    expect(hidden.querySelector(".roll-breakdown")).toBeNull();

    game.settings.set("rsreforged", "hideNpcRollStyle", "breakdown");
    const breakdown = summaryHtml();
    await renderer.renderNativeMessage(usageParent([]), breakdown);
    expect(breakdown.querySelector(".card-summary .total").textContent).toBe("10");
    expect(breakdown.querySelector(".card-summary .d20die")).toBeNull();

    // The GM always sees it.
    game.user.isGM = true;
    const gm = summaryHtml();
    await renderer.renderNativeMessage(usageParent([]), gm);
    expect(gm.querySelector(".card-summary .total").textContent).toBe("10");
});

it("asks dnd5e to refresh a usage card's cached save outcomes when a save's rolls change", async () => {
    // Any usage card, RSR-managed or not: its damage tray reads these outcomes.
    const onDescendentRefresh = vi.fn();
    const parent = { id: "spell", flags: {}, system: { onDescendentRefresh } };
    game.messages.set("spell", parent);
    ui.chat.updateMessage = vi.fn();
    const save = { id: "save", type: "save", system: { origin: parent } };

    renderer.refreshNativeOrigin(save, { rollsChanged: true });
    await Promise.resolve();

    expect(onDescendentRefresh).toHaveBeenCalledWith(save);
    expect(ui.chat.updateMessage).toHaveBeenCalledWith(parent);

    // Other changes leave a card RSR does not manage alone, as before.
    onDescendentRefresh.mockClear();
    ui.chat.updateMessage.mockClear();
    renderer.refreshNativeOrigin(save);
    await Promise.resolve();
    expect(onDescendentRefresh).not.toHaveBeenCalled();
    expect(ui.chat.updateMessage).not.toHaveBeenCalled();
});

it("puts the wide Damage button under the attack, forwarding the click and its keys to dnd5e's button", async () => {
    const attack = nativeChild("attack", "attack", "");
    const html = manualUsageHtml();
    const native = html.querySelector('[data-action="rollDamage"]');
    const clicks = [];
    native.addEventListener("click", (event) => clicks.push(event));

    await renderer.renderNativeMessage(usageParent([attack.message]), html);

    const combined = html.querySelector(".rsr-native-combined");
    expect(combined.lastElementChild.classList.contains("rsr-wide-actions")).toBe(true);
    const wide = combined.lastElementChild.querySelector("button.rsr-wide-action");
    expect(wide.textContent).toContain("rollDamage-label");
    expect(wide.hasAttribute("data-action")).toBe(false);

    wide.dispatchEvent(new window.MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(clicks).toHaveLength(1);
    expect(clicks[0].shiftKey).toBe(true);
    expect(clicks[0].button).toBe(0);
});

it("never forwards to dnd5e's button while its action is still running, and recovers after", async () => {
    // dnd5e's Activity#onChatAction disables the clicked button for the whole action and
    // re-enables it in `finally`, so success, cancellation, and errors all end the same way.
    const html = manualUsageHtml(["rollDamage"]);
    const native = html.querySelector('[data-action="rollDamage"]');
    const handler = vi.fn(() => { native.disabled = true; });
    native.addEventListener("click", handler);

    await renderer.renderNativeMessage(usageParent([]), html);
    const wide = html.querySelector(".rsr-wide-action");

    wide.click();
    wide.click();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(wide.disabled).toBe(true);

    native.disabled = false;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wide.disabled).toBe(false);
    wide.click();
    expect(handler).toHaveBeenCalledTimes(2);
});

it("shows the wide button under the item card when nothing has been rolled yet", async () => {
    // A save or damage activity in "manual damage for everything" mode has no children at first.
    const html = manualUsageHtml(["rollDamage"]);

    await renderer.renderNativeMessage(usageParent([]), html);

    const row = html.querySelector(".message-content > .rsr-wide-actions");
    expect(row.previousElementSibling.classList.contains("chat-card")).toBe(true);
});

it("rebuilds the wide buttons and RSR's hiding on every render of the same card", async () => {
    const attack = nativeChild("attack", "attack", "");
    const damage = nativeChild("damage", "damage", "");

    // Attack only, rendered twice: still exactly one wide Damage button.
    const twice = manualUsageHtml();
    await renderer.renderNativeMessage(usageParent([attack.message]), twice);
    await renderer.renderNativeMessage(usageParent([attack.message]), twice);
    expect(twice.querySelectorAll(".rsr-wide-action")).toHaveLength(1);

    // Nothing rolled -> attack -> damage on one root: the standalone row goes, then the wide button goes.
    const html = manualUsageHtml();
    await renderer.renderNativeMessage(usageParent([]), html);
    expect(html.querySelector(".message-content > .rsr-wide-actions")).not.toBeNull();
    expect(isHidden(html, "rollAttack")).toBe(false);

    await renderer.renderNativeMessage(usageParent([attack.message]), html);
    expect(html.querySelector(".message-content > .rsr-wide-actions")).toBeNull();
    expect(html.querySelectorAll(".rsr-native-combined .rsr-wide-action")).toHaveLength(1);

    await renderer.renderNativeMessage(usageParent([attack.message, damage.message]), html);
    expect(html.querySelectorAll(".rsr-wide-action")).toHaveLength(0);
    expect(isHidden(html, "rollDamage")).toBe(true);

    // And back: a deleted damage child brings the wide button back.
    await renderer.renderNativeMessage(usageParent([attack.message]), html);
    expect(html.querySelectorAll(".rsr-wide-action")).toHaveLength(1);
});

it("gives a single-ability save the 4.x wide DC button, hiding the DC when dnd5e would", async () => {
    CONFIG.DND5E = { ...(CONFIG.DND5E ?? {}), abilities: { dex: { label: "Dexterity" } } };
    const damage = nativeChild("damage", "damage", "");
    for (const [shouldDisplayChallenge, key] of [[true, "DND5E.SavingThrowDC"], [false, "DND5E.SavePromptTitle"]]) {
        const html = manualUsageHtml([]);
        html.querySelector(".icon-row ul").innerHTML =
            '<li><button type="button" class="icon" data-action="rollSave" data-ability="dex" data-dc="15" aria-label="Saving Throw"><i class="fa-solid fa-shield-heart"></i></button></li>';
        const parent = { ...usageParent([damage.message]), shouldDisplayChallenge };

        await renderer.renderNativeMessage(parent, html);

        const wide = html.querySelector(".rsr-native-combined > .rsr-wide-actions > .rsr-wide-action");
        expect(wide.textContent).toContain(key);
        expect(wide.textContent.includes('"dc":"15"')).toBe(shouldDisplayChallenge);
    }
});

it("leaves grouped multi-ability saves as dnd5e's icon", async () => {
    const html = manualUsageHtml([]);
    html.querySelector(".icon-row ul").innerHTML =
        '<li><button type="button" class="icon" data-group data-forward-action="rollSave" aria-label="Saving Throw"></button></li>';

    await renderer.renderNativeMessage(usageParent([]), html);

    expect(html.querySelector(".rsr-wide-actions")).toBeNull();
    expect(html.querySelector("[data-forward-action]").closest("li").classList.contains("rsr-native-hidden")).toBe(false);
});
