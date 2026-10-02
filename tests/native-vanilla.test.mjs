import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRoll, setupFoundryEnv } from "./helpers/foundry-env.mjs";

let env;
let vanilla;
let edits;
let bonus;
let damageSources = () => [];

async function load(settings = {}) {
    vi.resetModules();
    env = await setupFoundryEnv({ settings: { enableOverlayButtons: true, ...settings } });
    game.user.isGM = true;
    edits = { retroAdvantage: vi.fn(), retroCritical: vi.fn() };
    // The edits have their own tests (native-card); here only the wiring is checked.
    vi.doMock("../src/utils/native-card.js", () => ({
        canEditRolls: child => env.settings.enableOverlayButtons && (game.user.isGM || child.isAuthor === true),
        onEditClick: (buttons, handler) => buttons.forEach(b => b.addEventListener("click", event => handler(event, b))),
        retroAdvantage: edits.retroAdvantage,
        retroCritical: edits.retroCritical,
        damageDieSources: (...args) => damageSources(...args)
    }));
    damageSources = () => [];
    bonus = vi.fn();
    vi.doMock("../src/utils/bonus.js", () => ({ BonusManager: { openBonusDialog: bonus } }));
    vanilla = await import("../src/utils/native-vanilla.js");
}

beforeEach(() => load());

/** dnd5e 6's compact roll row: the roll button followed by its breakdown popover. */
function row({ total = 12, d20 = null, outcome = "" } = {}) {
    return `<section class="icon-row"><button type="button" class="dice-roll ${outcome}">
        <span class="icons">${outcome ? "<i></i>" : ""}</span><span class="result"><strong class="total">${total}</strong></span>
        ${d20 === null ? "" : `<span class="d20die"><i></i><span class="roll">${d20}</span></span>`}
    </button><div class="roll-breakdown" popover><div class="dice-tooltip-collapser"><div class="dice-tooltip"></div></div></div></section>`;
}

function message(type, rolls, content, extra = {}) {
    const node = document.createElement("li");
    node.className = "chat-message message";
    node.dataset.messageId = type;
    node.innerHTML = `<div class="message-content">${content}</div>`;
    return { id: type, type, rolls, isAuthor: true, flags: {}, system: {}, renderHTML: async () => node, ...extra };
}

const d20 = (rollOptions = {}) => makeRoll(env.classes.D20Roll, { formula: "1d20 + 5", total: 12, faces: 20, results: [7], rollOptions });
const damage = () => makeRoll(env.classes.DamageRoll, { formula: "1d8", total: 5, faces: 8, results: [5], type: "slashing" });
const labels = scope => [...scope.querySelectorAll(".rsr-roll-action")].map(b => b.textContent);

describe("Vanilla+ sections", () => {
    it("moves dnd5e's roll rows onto the card, leaves the item header behind, and keeps the child's identity", async () => {
        const child = message("attack", [d20()], `<div class="chat-card">header</div>${row({ d20: 7 })}<recorded-targets></recorded-targets>`);
        const section = await vanilla.renderVanillaSection({}, child);

        expect(section.className).toBe("rsr-vanilla-section rsr-vanilla-attack");
        expect(section.dataset.messageId).toBe("attack");
        expect(section.dataset.rsrMessageId).toBe("attack");
        expect([...section.children].map(n => n.tagName.toLowerCase())).toEqual(["section", "recorded-targets"]);
        expect(section.querySelector(".chat-card")).toBeNull();
    });

    it("returns nothing for a child with no rows to show", async () => {
        expect(await vanilla.renderVanillaSection({}, message("attack", [d20()], `<div class="chat-card"></div>`))).toBeNull();
    });
});

describe("Vanilla+ breakdown buttons", () => {
    it("offers disadvantage, advantage and bonus on a normal d20 roll and routes them to the shared edits", async () => {
        const child = message("attack", [d20()], row({ d20: 7 }));
        const section = await vanilla.renderVanillaSection({}, child);
        const buttons = section.querySelectorAll(".roll-breakdown .dice-tooltip .rsr-roll-action");
        expect(buttons).toHaveLength(3);

        buttons[0].click();
        expect(edits.retroAdvantage).toHaveBeenLastCalledWith(child, "kl", expect.objectContaining({ flavor: false }));
        buttons[1].click();
        expect(edits.retroAdvantage).toHaveBeenLastCalledWith(child, "kh", expect.objectContaining({ flavor: false }));
        buttons[2].click();
        expect(bonus).toHaveBeenCalledWith(child, "attack");
    });

    it("drops the mode buttons once the roll has advantage or disadvantage", async () => {
        const roll = d20();
        Object.defineProperty(roll, "hasAdvantage", { get: () => true });
        const section = await vanilla.renderVanillaSection({}, message("attack", [roll], row({ d20: 7 })));
        expect(section.querySelectorAll(".rsr-roll-action")).toHaveLength(1);
    });

    it("offers critical on damage only, and never on healing or an already critical roll", async () => {
        const hit = message("damage", [damage()], row());
        const section = await vanilla.renderVanillaSection({}, hit);
        expect(section.querySelectorAll(".rsr-roll-action")).toHaveLength(2);
        section.querySelector(".rsr-roll-action").click();
        expect(edits.retroCritical).toHaveBeenCalledWith(hit, expect.anything());
        section.querySelectorAll(".rsr-roll-action")[1].click();
        expect(bonus).toHaveBeenCalledWith(hit, "damage");

        const heal = await vanilla.renderVanillaSection({}, message("healing", [damage()], row()));
        expect(heal.querySelectorAll(".rsr-roll-action")).toHaveLength(1);

        const crit = damage();
        Object.defineProperty(crit, "isCritical", { get: () => true });
        const already = await vanilla.renderVanillaSection({}, message("damage", [crit], row()));
        expect(already.querySelectorAll(".rsr-roll-action")).toHaveLength(1);
    });

    it("shows nothing to a player who did not make the roll", async () => {
        game.user.isGM = false;
        const section = await vanilla.renderVanillaSection({}, message("attack", [d20()], row({ d20: 7 }), { isAuthor: false, getAssociatedActor: () => ({ isOwner: true }) }));
        expect(section.querySelector(".rsr-roll-actions")).toBeNull();
    });

    it("keeps Add Bonus when the overlay buttons are switched off", async () => {
        await load({ enableOverlayButtons: false });
        const section = await vanilla.renderVanillaSection({}, message("attack", [d20()], row({ d20: 7 })));
        expect(section.querySelectorAll(".rsr-roll-action")).toHaveLength(1);
    });

    it("writes a retroactive mode into the flavor of a check or save, and uses the check bonus category", async () => {
        const check = message("check", [d20()], row({ d20: 7 }));
        const scope = (await check.renderHTML()).querySelector(".message-content");
        vanilla.decorateVanillaRolls(check, scope, { flavor: true });
        vanilla.decorateVanillaRolls(check, scope, { flavor: true }); // a second pass adds nothing
        const buttons = scope.querySelectorAll(".rsr-roll-action");
        expect(buttons).toHaveLength(3);
        buttons[1].click();
        expect(edits.retroAdvantage).toHaveBeenLastCalledWith(check, "kh", expect.objectContaining({ flavor: true }));
        buttons[2].click();
        expect(bonus).toHaveBeenCalledWith(check, "check");
    });
});

describe("Vanilla+ display", () => {
    it("shows a stored extra d20 as a faded die beside the real one", async () => {
        const roll = d20({ rsreforgedAlternates: [{ result: 15, active: true }] });
        const section = await vanilla.renderVanillaSection({}, message("attack", [roll], row({ d20: 7 })));
        const dice = section.querySelectorAll(".d20die");
        expect(dice).toHaveLength(2);
        expect(dice[0].classList.contains("rsr-d20die-alt")).toBe(false);
        expect(dice[0].querySelector(".roll").textContent).toBe("7");
        expect(dice[1].classList.contains("rsr-d20die-alt")).toBe(true);
        expect(dice[1].querySelector(".roll").textContent).toBe("15");
    });

    it("Hide NPC Roll Results masks the total, keeps the d20, and removes the breakdown and outcome", async () => {
        await load({ hideNpcRollMode: "all", hideNpcRollStyle: "total" });
        game.user.isGM = false;
        const npc = { getAssociatedActor: () => ({ isOwner: false }), isAuthor: false };
        const roll = d20({ rsreforgedAlternates: [{ result: 15, active: true }] });
        const section = await vanilla.renderVanillaSection({}, message("attack", [roll], row({ d20: 7, outcome: "success" }), npc));

        const button = section.querySelector("button.dice-roll");
        expect(button.querySelector(".total").textContent).toBe("rsreforged.chat.hide");
        expect(button.querySelectorAll(".d20die")).toHaveLength(1);
        expect(button.classList.contains("success")).toBe(false);
        expect(button.querySelector(".icons").childElementCount).toBe(0);
        expect(section.querySelector(".roll-breakdown")).toBeNull();
    });

    it("Hide NPC Roll Results in breakdown style keeps the total and removes the d20", async () => {
        await load({ hideNpcRollMode: "all", hideNpcRollStyle: "breakdown" });
        game.user.isGM = false;
        const npc = { getAssociatedActor: () => ({ isOwner: false }), isAuthor: false };
        const section = await vanilla.renderVanillaSection({}, message("attack", [d20()], row({ d20: 7 }), npc));
        expect(section.querySelector(".total").textContent).toBe("12");
        expect(section.querySelector(".d20die")).toBeNull();
        expect(section.querySelector(".roll-breakdown")).toBeNull();
    });

    it("never masks damage", async () => {
        await load({ hideNpcRollMode: "all", hideNpcRollStyle: "total" });
        game.user.isGM = false;
        const npc = { getAssociatedActor: () => ({ isOwner: false }), isAuthor: false };
        const section = await vanilla.renderVanillaSection({}, message("damage", [damage()], row({ total: 5 }), npc));
        expect(section.querySelector(".total").textContent).toBe("5");
        expect(section.querySelector(".roll-breakdown")).not.toBeNull();
    });
});

describe("Vanilla+ reroll and fudge stamps", () => {
    /** A breakdown part as dnd5e lists it: one <li class="roll"> per die result. */
    const part = (...values) => `<section class="tooltip-part"><div class="dice"><ol class="dice-rolls">${values.map(v => `<li class="roll">${v}</li>`).join("")}<li class="constant">+3</li></ol></div></section>`;
    const withParts = (html, ...parts) => html.replace('<div class="dice-tooltip"></div>', `<div class="dice-tooltip">${parts.join("")}<section class="tooltip-part constant-term"></section></div>`);
    const stamps = scope => [...scope.querySelectorAll(".dice-rolls .roll")].map(n => [n.dataset.rsrRoll, n.dataset.rsrDie, n.dataset.rsrResult]);

    it("stamps a d20 roll's dice with their roll, die and result so the reroll listener can act on them", async () => {
        const roll = makeRoll(env.classes.D20Roll, { formula: "2d20kh + 5", total: 20, faces: 20, results: [15, { result: 4, active: false, discarded: true }] });
        const section = await vanilla.renderVanillaSection({}, message("attack", [roll], withParts(row({ d20: 15 }), part(15, 4))));
        expect(stamps(section)).toEqual([["0", "0", "0"], ["0", "0", "1"]]);
        // The listener resolves the message from the nearest data-message-id.
        expect(section.querySelector(".roll").closest("[data-message-id]").dataset.messageId).toBe("attack");
    });

    it("leaves the breakdown inert when it does not show the dice the roll holds", async () => {
        const roll = makeRoll(env.classes.D20Roll, { formula: "1d20", total: 15, faces: 20, results: [15] });
        const wrongValue = await vanilla.renderVanillaSection({}, message("attack", [roll], withParts(row({ d20: 15 }), part(14))));
        expect(stamps(wrongValue)).toEqual([[undefined, undefined, undefined]]);
        const wrongCount = await vanilla.renderVanillaSection({}, message("attack", [roll], withParts(row({ d20: 15 }), part(15, 15))));
        expect(stamps(wrongCount).flat().every(v => v === undefined)).toBe(true);
    });

    it("stamps damage in whichever layout dnd5e drew: merged by type, or one part per roll", async () => {
        const rolls = [damage(), damage()];
        const perRoll = [[{ rollIndex: 0, dieIndex: 0, resultIndex: 0, result: "5" }], [{ rollIndex: 1, dieIndex: 0, resultIndex: 0, result: "2" }]];
        const merged = [[{ rollIndex: 1, dieIndex: 0, resultIndex: 0, result: "2" }, { rollIndex: 0, dieIndex: 0, resultIndex: 0, result: "5" }]];
        damageSources = (shown, sources, aggregate) => aggregate ? merged : perRoll;

        const one = await vanilla.renderVanillaSection({}, message("damage", rolls, withParts(row(), part(2, 5))));
        expect(stamps(one)).toEqual([["1", "0", "0"], ["0", "0", "0"]]);
        const two = await vanilla.renderVanillaSection({}, message("damage", rolls, withParts(row(), part(5), part(2))));
        expect(stamps(two)).toEqual([["0", "0", "0"], ["1", "0", "0"]]);
    });

    it("stamps nothing on damage it cannot place, or when working it out fails", async () => {
        damageSources = () => [[{ rollIndex: 0, dieIndex: 0, resultIndex: 0, result: "9" }]];
        const mismatch = await vanilla.renderVanillaSection({}, message("damage", [damage()], withParts(row(), part(5))));
        expect(stamps(mismatch)).toEqual([[undefined, undefined, undefined]]);
        damageSources = () => { throw new Error("no aggregation"); };
        const failed = await vanilla.renderVanillaSection({}, message("damage", [damage()], withParts(row(), part(5))));
        expect(stamps(failed)).toEqual([[undefined, undefined, undefined]]);
        expect(failed.querySelector(".rsr-roll-actions")).not.toBeNull();
    });

    it("stamps nothing on a hidden NPC roll", async () => {
        await load({ hideNpcRollMode: "all", hideNpcRollStyle: "total" });
        game.user.isGM = false;
        const roll = makeRoll(env.classes.D20Roll, { formula: "1d20", total: 15, faces: 20, results: [15] });
        const npc = { getAssociatedActor: () => ({ isOwner: false }), isAuthor: false };
        const section = await vanilla.renderVanillaSection({}, message("attack", [roll], withParts(row({ d20: 15 }), part(15)), npc));
        expect(section.querySelector(".dice-rolls")).toBeNull();
    });
});
