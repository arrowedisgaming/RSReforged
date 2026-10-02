import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

let renderer;
let sections;

async function load(cardStyle) {
    vi.resetModules();
    await setupFoundryEnv({ settings: cardStyle ? { cardStyle } : {} });
    globalThis.CONFIG.DND5E = { ...(globalThis.CONFIG.DND5E ?? {}), abilities: { con: { label: "Constitution" }, dex: { label: "Dexterity" } } };
    game.i18n.format = (key, data) => key === "DND5E.SavingThrowDC" ? `DC ${data.dc} ${data.ability} Saving Throw` : `${data.ability} Saving Throw`;
    const stub = kind => vi.fn(async (parent, child) => {
        const section = document.createElement("div");
        section.className = kind;
        section.dataset.messageId = child.id;
        section.dataset.rsrMessageId = child.id;
        return section;
    });
    sections = { classic: stub("rsr-card"), vanilla: stub("rsr-vanilla-section") };
    vi.doMock("../src/utils/native-card.js", () => ({ renderRsrSection: sections.classic, renderRsrCheck: vi.fn(async () => document.createElement("div")) }));
    const decorate = vi.fn();
    vi.doMock("../src/utils/native-vanilla.js", () => ({ renderVanillaSection: sections.vanilla, decorateVanillaRolls: decorate }));
    sections.decorate = decorate;
    renderer = await import("../src/utils/native-render.js");
}

function child(id, type) {
    return { id, type, visible: true, isContentVisible: true, rolls: [], flags: {}, timestamp: 0 };
}

function parent(children) {
    return { id: "parent", type: "usage", isContentVisible: true, shouldDisplayChallenge: true, flags: { rsreforged: { workflowVersion: 2, quickRoll: true } }, getAssociatedRolls: () => children };
}

function saveCard() {
    const html = document.createElement("li");
    html.className = "chat-message message";
    html.dataset.messageId = "parent";
    html.innerHTML = `<div class="message-content"><div class="chat-card"><section class="icon-row"><ul>
        <li><button data-action="rollSave" data-dc="22" data-ability="con"></button></li>
        <li><button data-action="rollDamage"></button></li>
    </ul></section></div><div class="card-summary" data-message-id="save1"></div></div>`;
    return html;
}

describe("card style", () => {
    beforeEach(() => load());

    it("defaults to the classic sections and adds the wide save button under them", async () => {
        const html = saveCard();
        await renderer.renderNativeMessage(parent([child("damage", "damage")]), html);

        expect(sections.classic).toHaveBeenCalledTimes(1);
        expect(sections.vanilla).not.toHaveBeenCalled();
        expect(html.classList.contains("rsr-vanilla-card")).toBe(false);
        const order = [...html.querySelector(".message-content").children].map(n => n.className);
        expect(order).toEqual(["chat-card", "rsr-native-combined", "rsr-wide-buttons", "card-summary"]);
        expect(html.querySelector(".rsr-wide-save").textContent).toBe("DC 22 Constitution Saving Throw");
    });

    it("adds the wide save button to a save with nothing rolled, once, and forwards the click with its modifiers", async () => {
        const html = saveCard();
        const clicks = [];
        html.querySelector('[data-action="rollSave"]').addEventListener("click", event => clicks.push(event.shiftKey));
        const card = parent([]);
        await renderer.renderNativeMessage(card, html);
        await renderer.renderNativeMessage(card, html);

        const wide = html.querySelectorAll(".rsr-wide-buttons button");
        expect(html.querySelectorAll(".rsr-wide-buttons")).toHaveLength(1);
        expect(wide).toHaveLength(1);
        expect(wide[0].dataset.action).toBeUndefined();
        wide[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true, shiftKey: true }));
        expect(clicks).toEqual([true]);
    });

    it("leaves the DC off the wide button when the viewer may not see it", async () => {
        const html = saveCard();
        await renderer.renderNativeMessage({ ...parent([]), shouldDisplayChallenge: false }, html);
        expect(html.querySelector(".rsr-wide-save").textContent).toBe("Constitution Saving Throw");
    });

    it("adds no wide button to a card without a save", async () => {
        const html = saveCard();
        html.querySelector('[data-action="rollSave"]').closest("li").remove();
        await renderer.renderNativeMessage(parent([child("damage", "damage")]), html);
        expect(html.querySelector(".rsr-wide-buttons")).toBeNull();
    });

    it("Vanilla+ folds dnd5e's rows instead, keeps dnd5e's save icon, and decorates save summaries", async () => {
        await load("vanilla");
        const save = { id: "save1", type: "save", isContentVisible: true, rolls: [] };
        game.messages.set("save1", save);
        const html = saveCard();
        await renderer.renderNativeMessage(parent([child("damage", "damage")]), html);

        expect(sections.vanilla).toHaveBeenCalledTimes(1);
        expect(sections.classic).not.toHaveBeenCalled();
        expect(html.classList.contains("rsr-native-card")).toBe(true);
        expect(html.classList.contains("rsr-vanilla-card")).toBe(true);
        const combined = html.querySelector(".rsr-native-combined");
        expect(combined.classList.contains("rsr-vanilla")).toBe(true);
        expect(combined.firstElementChild.classList.contains("rsr-native-source")).toBe(true);
        expect(html.querySelector(".rsr-wide-buttons")).toBeNull();
        expect(sections.decorate).toHaveBeenCalledWith(save, html.querySelector(".card-summary"), { flavor: true, mask: false });
    });
});
