import { beforeEach, describe, it, expect, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

let env;
let card;

class NumericTerm {
    constructor(number) {
        this.number = number;
    }

    get total() {
        return this.number;
    }
}

class PoolTerm {}

beforeEach(async () => {
    vi.resetModules();
    env = await setupFoundryEnv();
    const { TestDie, D20Roll } = env.classes;
    // dnd5e 5.3's damage breakdown walks real term classes and die tooltip data.
    foundry.dice.terms.NumericTerm = NumericTerm;
    foundry.dice.terms.DiceTerm = TestDie;
    foundry.dice.terms.PoolTerm = PoolTerm;
    TestDie.prototype.getTooltipData = function () {
        return { rolls: this.results.map((r) => ({ result: r.result, classes: `d${this.faces}` })), icon: null, method: null };
    };
    // Foundry 14's core roll template, reduced to the structure the section reshapes.
    D20Roll.prototype.render = async function () {
        return `<div class="dice-roll" data-action="expandRoll"><div class="dice-result">
            <div class="dice-formula">${this.formula}</div>
            <div class="dice-tooltip"><div class="wrapper"><section class="tooltip-part">d20</section></div></div>
            <h4 class="dice-total">${this.total}</h4></div></div>`;
    };
    CONFIG.DND5E.damageTypes.fire = { label: "Fire", labelShort: "Fire", icon: "systems/dnd5e/icons/svg/damage/fire.svg" };
    CONFIG.DND5E.aggregateDamageDisplay = false;
    game.settings.set("dnd5e", "attackRollVisibility", "all");
    globalThis.dnd5e = { dice: { aggregateDamageRolls: (rolls) => rolls }, settings: {} };
    // The critical mapper has its own suite against real dnd5e 6 captures.
    vi.doMock("../src/utils/native-critical.js", () => ({
        setNativeCritical: vi.fn(async (roll) => { roll.options.isCritical = true; return roll; })
    }));
    // The real multiroll template: one .dice-total per d20 entry.
    const renderTemplate = foundry.applications.handlebars.renderTemplate;
    const base = renderTemplate.getMockImplementation();
    renderTemplate.mockImplementation(async (template, data) => template.endsWith("rsr-multiroll.html")
        ? `<div class="rsr-multiroll" data-key="${data.key}">${data.entries.map((entry) => `<h4 class="dice-total">${entry.hideTotal ? "???" : entry.total}${entry.d20Result ? `<span class="die-icon">${entry.d20Result}</span>` : ""}</h4>`).join("")}</div>`
        : base(template, data));
    card = await import("../src/utils/native-card.js");
});

function damageRoll(type, dieResult, faces, constant) {
    const { DamageRoll, TestDie, OperatorTerm } = env.classes;
    const roll = new DamageRoll(`1d${faces}${constant ? ` + ${constant}` : ""}`);
    const die = new TestDie({ number: 1, faces, results: [{ result: dieResult, active: true }] });
    roll.terms = constant ? [die, new OperatorTerm({ operator: "+" }), new NumericTerm(constant)] : [die];
    roll.dice = [die];
    roll.total = dieResult + (constant ?? 0);
    roll.options.type = type;
    return roll;
}

function child(id, type, rolls, system = {}) {
    return { id, type, rolls, system, flags: {} };
}

const parent = { id: "parent", flags: { rsreforged: {} } };

it("renders the 5.3 damage breakdown from a native damage child, one part per damage type", async () => {
    const damage = child("dmg", "damage", [damageRoll("slashing", 7, 10, 3), damageRoll("fire", 6, 6)]);

    const section = await card.renderRsrSection(parent, damage);

    expect(section.dataset.messageId).toBe("dmg");
    expect(section.querySelector(".rsr-section-damage")).not.toBeNull();
    const parts = [...section.querySelectorAll(".rsr-damage .dice-tooltip .tooltip-part")];
    expect(parts.map((part) => part.querySelector(".total .label").textContent)).toEqual(["Slashing", "Fire"]);
    expect(parts.map((part) => part.querySelector(".total .value").textContent)).toEqual(["10", "6"]);
    expect(parts[0].querySelector(".constant").textContent).toBe("+3");
    expect(section.querySelector(".rsr-damage > .dice-total").textContent).toBe("16");
    // The formula lives inside the collapsible breakdown, as on the 5.3 card.
    expect(section.querySelector(".dice-tooltip-collapser .dice-tooltip > .dice-formula").textContent).toBe("1d10 + 3 + 1d6");
});

it("drops the leading plus that aggregated damage parts carry", async () => {
    CONFIG.DND5E.aggregateDamageDisplay = true;
    const roll = damageRoll("fire", 4, 6, 2);
    roll.formula = " + 1d6 + 2";

    const section = await card.renderRsrSection(parent, child("dmg", "damage", [roll]));

    expect(section.querySelector(".dice-formula").textContent).toBe("1d6 + 2");
});

it("uses RSR's apply buttons by default and dnd5e's tray when that mode is chosen", async () => {
    const rsr = await card.renderRsrSection(parent, child("dmg", "damage", [damageRoll("fire", 4, 6)]));
    expect(rsr.querySelector(".rsr-damage-buttons-xl")).not.toBeNull();
    expect(rsr.querySelector("damage-application")).toBeNull();

    env.settings.damageApplyMode = "dnd5e";
    game.user.isGM = false;
    const player = await card.renderRsrSection(parent, child("dmg", "damage", [damageRoll("fire", 4, 6)]));
    // dnd5e shows its tray to players only when its own setting allows it.
    expect(player.querySelector("damage-application")).toBeNull();

    game.user.isGM = true;
    const native = await card.renderRsrSection(parent, child("dmg", "damage", [damageRoll("fire", 4, 6)]));
    const tray = native.querySelector("damage-application");
    expect(tray).not.toBeNull();
    // The tray resolves its message from the nearest data-message-id: the damage child.
    expect(tray.closest("[data-message-id]").dataset.messageId).toBe("dmg");
    expect(native.querySelector(".rsr-damage-buttons, .rsr-damage-buttons-xl")).toBeNull();
});

it("titles healing children as healing and notes a damage child's save outcome", async () => {
    const heal = await card.renderRsrSection(parent, child("heal", "healing", [damageRoll("healing", 5, 8, 2)]));
    expect(heal.querySelector(".rsr-title").textContent).toContain("DND5E.HEAL.HealingButton");

    const save = await card.renderRsrSection(parent, child("dmg", "damage", [damageRoll("fire", 8, 6)], { onSave: "half" }));
    expect(save.querySelector(".supplement").textContent).toContain("half");
});

it("renders the attack section with RSR's total inside core's roll markup, collapsed by default", async () => {
    const { D20Roll, TestDie } = env.classes;
    const roll = new D20Roll("1d20 + 5");
    roll.terms = [new TestDie({ number: 1, faces: 20, results: [{ result: 14, active: true }] })];
    roll.dice = roll.terms;
    roll.total = 19;

    const section = await card.renderRsrSection(parent, child("atk", "attack", [roll], { ammunitionItem: { name: "Arrow" } }));

    const dice = section.querySelector(".dice-roll");
    expect(dice.dataset.action).toBeUndefined();
    expect(section.querySelector(".rsr-multiroll")).not.toBeNull();
    expect(section.querySelector(".dice-result > h4.dice-total")).toBeNull();
    expect(section.querySelector(".dice-tooltip-collapser > .dice-tooltip > .dice-formula").textContent).toBe("1d20 + 5");
    expect(section.querySelector(".rsr-subtitle").textContent).toContain("Arrow");
    // Per-viewer display options stay off the document's own roll.
    expect(roll.options.displayChallenge).toBeUndefined();
    expect(roll.options.hideFinalResult).toBeUndefined();
});

it("escapes damage-type labels and icons that another module registered", async () => {
    CONFIG.DND5E.damageTypes.cursed = { label: 'Cursed"', labelShort: '<img src=x onerror="alert(1)">', icon: 'x" onerror="alert(1)' };

    const section = await card.renderRsrSection(parent, child("dmg", "damage", [damageRoll("cursed", 3, 6)]));

    const total = section.querySelector(".tooltip-part .total");
    expect(total.querySelector(".label").textContent).toBe('<img src=x onerror="alert(1)">');
    expect(total.querySelectorAll("img")).toHaveLength(1);
    expect(total.querySelector("img").getAttribute("onerror")).toBeNull();
    expect(total.querySelector("img").getAttribute("src")).toBe('x" onerror="alert(1)');
});

it("renders every roll of a formula child, since its original card is hidden", async () => {
    const { BasicRoll } = env.classes;
    const rolls = ["1d4", "1d6"].map((formula) => {
        const roll = new BasicRoll(formula);
        roll.render = async () => `<div class="dice-roll"><div class="dice-result"><div class="dice-formula">${formula}</div><div class="dice-tooltip"></div><h4 class="dice-total">1</h4></div></div>`;
        return roll;
    });

    const section = await card.renderRsrSection(parent, child("formula", "generic", rolls));

    expect([...section.querySelectorAll(".dice-formula")].map((node) => node.textContent)).toEqual(["1d4", "1d6"]);
});

it("applies a native damage part with its own properties, like dnd5e's tray", async () => {
    const actor = { applyDamage: vi.fn(async () => {}), applyTempHP: vi.fn(async () => {}) };
    canvas.tokens.controlled = [{ actor }];
    const magical = damageRoll("slashing", 7, 10, 3);
    magical.options.properties = ["mgc"];
    const mundane = damageRoll("slashing", 4, 6);
    const aggregate = vi.fn((rolls) => rolls);
    dnd5e.dice.aggregateDamageRolls = aggregate;

    const section = await card.renderRsrSection(parent, child("dmg", "damage", [magical, mundane]));
    document.body.append(section);

    // The second part's own button applies only that roll, with no magical property.
    section.querySelectorAll(".tooltip-part")[1].querySelector('[data-action="rsr-apply-damage"][data-multiplier="1"]').click();
    await vi.waitFor(() => expect(actor.applyDamage).toHaveBeenCalledTimes(1));
    expect(actor.applyDamage.mock.calls[0][0]).toEqual([{ value: 4, type: "slashing", properties: new Set() }]);

    // The total button applies both, each keeping its properties.
    section.querySelector('.rsr-damage-buttons-xl [data-action="rsr-apply-damage"][data-multiplier="1"]').click();
    await vi.waitFor(() => expect(actor.applyDamage).toHaveBeenCalledTimes(2));
    expect(actor.applyDamage.mock.calls[1][0]).toEqual([
        { value: 10, type: "slashing", properties: new Set(["mgc"]) },
        { value: 4, type: "slashing", properties: new Set() }
    ]);
    expect(aggregate).toHaveBeenLastCalledWith([magical, mundane], { respectProperties: true });

    // The heart heals rather than damages.
    section.querySelector('.rsr-damage-buttons-xl [data-action="rsr-apply-damage"][data-multiplier="-1"]').click();
    await vi.waitFor(() => expect(actor.applyDamage).toHaveBeenCalledTimes(3));
    expect(actor.applyDamage.mock.calls[2][0].map((damage) => damage.type)).toEqual(["healing", "healing"]);
});

function attackRoll() {
    const { D20Roll, TestDie, OperatorTerm } = env.classes;
    const roll = new D20Roll("1d20 + 5");
    const d20 = new TestDie({ number: 1, faces: 20, results: [{ result: 14, active: true }] });
    // Own data properties, as serialized Foundry terms carry, so a copied roll keeps its +5.
    roll.terms = [d20, Object.assign(new OperatorTerm({ operator: "+" }), { _evaluated: true }), { number: 5, total: 5, _evaluated: true }];
    roll.dice = [d20];
    roll.total = 19;
    return roll;
}

function editable(message, { isAuthor = true } = {}) {
    return Object.assign(message, { isAuthor, whisper: [], blind: false, speaker: { actor: "a1" }, update: vi.fn(async () => {}) });
}

it("offers retroactive advantage and disadvantage on an attack, persisting the upgraded roll to the attack message", async () => {
    env.settings.enableOverlayButtons = true;
    const { RollUtility } = await import("../src/utils/roll.js");
    const upgrade = vi.spyOn(RollUtility, "upgradeRoll").mockImplementation(async (roll, state) => {
        roll.options.advantageMode = state === "kh" ? 1 : -1;
        return roll;
    });
    const attack = editable(child("atk", "attack", [attackRoll()]));

    const section = await card.renderRsrSection(parent, attack);
    const overlay = section.querySelector(".rsr-multiroll .dice-total .rsr-overlay-multiroll");
    expect(overlay).not.toBeNull();

    overlay.querySelector('[data-state="kh"]').click();
    await vi.waitFor(() => expect(attack.update).toHaveBeenCalledTimes(1));

    expect(upgrade).toHaveBeenCalledWith(expect.anything(), "kh");
    // The edit is written to the attack message itself, never to the usage card.
    const { rolls } = attack.update.mock.calls[0][0];
    expect(rolls[0].options.advantageMode).toBe(1);
    // The original roll object is left alone until the update lands.
    expect(attack.rolls[0].options.advantageMode).toBeUndefined();
});

it("offers no advantage overlay once the attack has advantage, to other players, or with overlays off", async () => {
    env.settings.enableOverlayButtons = true;
    const upgraded = attackRoll();
    Object.defineProperty(upgraded, "hasAdvantage", { value: true });
    expect((await card.renderRsrSection(parent, editable(child("a", "attack", [upgraded])))).querySelector(".rsr-overlay")).toBeNull();

    game.user.isGM = false;
    const other = editable(child("b", "attack", [attackRoll()]), { isAuthor: false });
    expect((await card.renderRsrSection(parent, other)).querySelector(".rsr-overlay")).toBeNull();

    game.user.isGM = true;
    env.settings.enableOverlayButtons = false;
    expect((await card.renderRsrSection(parent, editable(child("c", "attack", [attackRoll()])))).querySelector(".rsr-overlay")).toBeNull();
});

it("promotes damage to a critical, throws the dice for the message's audience, and persists to the damage message", async () => {
    env.settings.enableOverlayButtons = true;
    const { setNativeCritical } = await import("../src/utils/native-critical.js");
    game.dice3d = { isEnabled: () => true, showForRoll: vi.fn(async () => true) };
    const damage = editable(child("dmg", "damage", [damageRoll("slashing", 7, 10, 3), damageRoll("fire", 6, 6)]));
    damage.whisper = ["gm-id"];

    const section = await card.renderRsrSection(parent, damage);
    section.querySelector(".rsr-damage > .dice-total .rsr-overlay-crit [data-action='rsr-retro']").click();
    await vi.waitFor(() => expect(damage.update).toHaveBeenCalledTimes(1));

    expect(setNativeCritical).toHaveBeenCalledTimes(2);
    expect(damage.update.mock.calls[0][0].rolls.every((roll) => roll.options.isCritical)).toBe(true);
    expect(game.dice3d.showForRoll).toHaveBeenCalledTimes(2);
    expect(game.dice3d.showForRoll.mock.calls[0].slice(2, 6)).toEqual([true, ["gm-id"], false, "dmg"]);
});

it("offers no critical overlay on healing or on damage that is already critical", async () => {
    env.settings.enableOverlayButtons = true;
    const heal = await card.renderRsrSection(parent, editable(child("h", "healing", [damageRoll("healing", 5, 8)])));
    expect(heal.querySelector(".rsr-overlay-crit")).toBeNull();

    const crit = damageRoll("fire", 6, 6);
    Object.defineProperty(crit, "isCritical", { value: true });
    const done = await card.renderRsrSection(parent, editable(child("d", "damage", [crit])));
    expect(done.querySelector(".rsr-overlay-crit")).toBeNull();
});

it("puts the 4.x Add Bonus button on attack, damage, and healing headers for the roll's author or the GM", async () => {
    const attack = await card.renderRsrSection(parent, editable(child("atk", "attack", [attackRoll()])));
    expect(attack.querySelector('.rsr-title .rsr-addon-bonus-btn[data-type="attack"]')).not.toBeNull();

    const damage = await card.renderRsrSection(parent, editable(child("dmg", "damage", [damageRoll("fire", 4, 6)])));
    expect(damage.querySelector('.rsr-title .rsr-addon-bonus-btn[data-type="damage"]')).not.toBeNull();

    const heal = await card.renderRsrSection(parent, editable(child("heal", "healing", [damageRoll("healing", 5, 8)])));
    expect(heal.querySelector('.rsr-addon-bonus-btn[data-type="damage"]')).not.toBeNull();

    game.user.isGM = false;
    const other = await card.renderRsrSection(parent, editable(child("x", "attack", [attackRoll()]), { isAuthor: false }));
    expect(other.querySelector(".rsr-addon-bonus-btn")).toBeNull();
});

it("opens the bonus picker for the child message, not the usage card", async () => {
    const { BonusManager } = await import("../src/utils/bonus.js");
    const open = vi.spyOn(BonusManager, "openBonusDialog").mockResolvedValue();
    const damage = editable(child("dmg", "damage", [damageRoll("fire", 4, 6)]));

    const section = await card.renderRsrSection(parent, damage);
    section.querySelector(".rsr-addon-bonus-btn").click();

    expect(open).toHaveBeenCalledWith(damage, "damage");
});

it("cycles a damage part's type on the damage message itself and remembers the choice", async () => {
    CONFIG.DND5E.damageTypes.cold = { label: "Cold", labelShort: "Cold", icon: "systems/dnd5e/icons/svg/damage/cold.svg" };
    const { ActivityUtility } = await import("../src/utils/activity.js");
    const remember = vi.spyOn(ActivityUtility, "rememberDamageTypes").mockResolvedValue();
    const orb = damageRoll("fire", 5, 8);
    orb.options.types = ["fire", "cold"];
    orb.options.rsreforgedCriticalBase = { stale: true };
    const damage = editable(child("dmg", "damage", [orb, damageRoll("slashing", 3, 6)]));
    // Real children carry workflow flags, which must not divert the write to the flag cache.
    damage.flags = { rsreforged: { workflowVersion: 2, parentId: "parent" } };

    const section = await card.renderRsrSection(parent, damage);
    const parts = section.querySelectorAll(".rsr-damage .tooltip-part");
    // Only the part with an alternative type reads as clickable.
    expect(parts[0].classList.contains("rsr-damage-type-toggle")).toBe(true);
    expect(parts[1].classList.contains("rsr-damage-type-toggle")).toBe(false);

    parts[0].querySelector(".total .label").click();
    await vi.waitFor(() => expect(damage.update).toHaveBeenCalledTimes(1));

    const [cycled, untouched] = damage.update.mock.calls[0][0].rolls;
    expect(cycled.options.type).toBe("cold");
    expect(cycled.options.rsreforgedCriticalBase).toBeUndefined();
    expect(untouched.options.type).toBe("slashing");
    // The live document is only changed by the update itself.
    expect(orb.options.type).toBe("fire");
    expect(damage.flags.rsreforged.rolls).toBeUndefined();
    await vi.waitFor(() => expect(remember).toHaveBeenCalledWith(damage, expect.any(Array)));
});

it("offers damage-type cycling only to the GM and the roll's author", async () => {
    const orb = damageRoll("fire", 5, 8);
    orb.options.types = ["fire", "cold"];
    game.user.isGM = false;

    const section = await card.renderRsrSection(parent, editable(child("dmg", "damage", [orb]), { isAuthor: false }));

    expect(section.querySelector(".rsr-damage-type-toggle")).toBeNull();
});

describe("Hide NPC Roll Results", () => {
    function npcAttack({ owner = false } = {}) {
        const message = editable(child("atk", "attack", [attackRoll()]), { isAuthor: false });
        message.getAssociatedActor = () => ({ isOwner: owner });
        return message;
    }

    beforeEach(() => {
        env.settings.hideNpcRollMode = "attacks";
        game.user.isGM = false;
    });

    it("masks an NPC attack total from players, keeping the natural d20 (Hide Total)", async () => {
        env.settings.hideNpcRollStyle = "total";

        const section = await card.renderRsrSection(parent, npcAttack());

        const total = section.querySelector(".rsr-multiroll .dice-total");
        expect(total.textContent).toContain("???");
        expect(total.textContent).not.toContain("19");
        expect(total.querySelector(".die-icon").textContent).toBe("14");
        expect(section.querySelector(".dice-formula").textContent).not.toContain("5");
    });

    it("shows the total but masks the d20 and every modifier (Hide Breakdown)", async () => {
        env.settings.hideNpcRollStyle = "breakdown";

        const section = await card.renderRsrSection(parent, npcAttack());

        const total = section.querySelector(".rsr-multiroll .dice-total");
        expect(total.textContent).toContain("19");
        expect(total.querySelector(".die-icon")).toBeNull();
        expect(section.querySelectorAll(".dice-tooltip .tooltip-part")).toHaveLength(0);
    });

    it("never hides from the GM or the actor's owner, and never hides damage", async () => {
        env.settings.hideNpcRollStyle = "total";
        const owned = await card.renderRsrSection(parent, npcAttack({ owner: true }));
        expect(owned.querySelector(".rsr-multiroll .dice-total").textContent).toContain("19");

        game.user.isGM = true;
        const gm = await card.renderRsrSection(parent, npcAttack());
        expect(gm.querySelector(".rsr-multiroll .dice-total").textContent).toContain("19");

        game.user.isGM = false;
        const damage = editable(child("dmg", "damage", [damageRoll("fire", 4, 6)]), { isAuthor: false });
        damage.getAssociatedActor = () => ({ isOwner: false });
        const shown = await card.renderRsrSection(parent, damage);
        expect(shown.querySelector(".rsr-damage > .dice-total").textContent).toBe("4");
    });
});

describe("check and save cards", () => {
    function check({ owner = true, isAuthor = true } = {}) {
        const message = editable(child("chk", "check", [attackRoll()]), { isAuthor });
        Object.assign(message, { flavor: "Strength (Athletics) Check", shouldDisplayChallenge: true, system: { type: "ability", skill: "ath" } });
        message.getAssociatedActor = () => ({ isOwner: owner });
        return message;
    }

    it("renders the 4.x total and collapsible breakdown for a check", async () => {
        const section = await card.renderRsrCheck(check());

        expect(section.classList.contains("rsr-check")).toBe(true);
        expect(section.dataset.messageId).toBe("chk");
        expect(section.querySelector(".rsr-multiroll").dataset.key).toBe("skill");
        expect(section.querySelector(".rsr-multiroll .dice-total").textContent).toContain("19");
        expect(section.querySelector(".dice-tooltip-collapser .dice-formula")).not.toBeNull();
    });

    it("masks an NPC check from players when Hide NPC Roll Results covers all rolls", async () => {
        env.settings.hideNpcRollMode = "all";
        env.settings.hideNpcRollStyle = "total";
        game.user.isGM = false;

        const section = await card.renderRsrCheck(check({ owner: false, isAuthor: false }));

        expect(section.querySelector(".rsr-multiroll .dice-total").textContent).toContain("???");
        expect(section.querySelector(".rsr-overlay")).toBeNull();

        // Attacks-only hiding leaves checks alone.
        env.settings.hideNpcRollMode = "attacks";
        const shown = await card.renderRsrCheck(check({ owner: false, isAuthor: false }));
        expect(shown.querySelector(".rsr-multiroll .dice-total").textContent).toContain("19");
    });

    it("writes a retroactive advantage into the check's flavor, as 4.x did", async () => {
        env.settings.enableOverlayButtons = true;
        const { RollUtility } = await import("../src/utils/roll.js");
        vi.spyOn(RollUtility, "upgradeRoll").mockImplementation(async (roll) => roll);
        const message = check();

        const section = await card.renderRsrCheck(message);
        section.querySelector('.rsr-overlay-multiroll [data-state="kh"]').click();
        await vi.waitFor(() => expect(message.update).toHaveBeenCalledTimes(1));

        expect(message.update.mock.calls[0][0].flavor).toBe("Strength (Athletics) Check (DND5E.Advantage)");
    });
});

describe("reroll stamps", () => {
    it("stamps each damage die with its own roll, die term, and result, across rolls", async () => {
        const slashing = damageRoll("slashing", 7, 10, 3);
        const fire = damageRoll("fire", 6, 6);
        const section = await card.renderRsrSection(parent, child("dmg", "damage", [slashing, fire]));

        const stamps = [...section.querySelectorAll(".dice-rolls .roll")].map((die) => [die.textContent, die.dataset.rsrRoll, die.dataset.rsrDie, die.dataset.rsrResult]);
        expect(stamps).toEqual([["7", "0", "0", "0"], ["6", "1", "0", "0"]]);
        // Constants are not dice.
        expect(section.querySelector(".dice-rolls .constant").dataset.rsrRoll).toBeUndefined();
    });

    it("stamps the dice of a core-rendered roll by their place in roll.dice", async () => {
        const { D20Roll, TestDie } = env.classes;
        D20Roll.prototype.render = async function () {
            return `<div class="dice-roll"><div class="dice-result"><div class="dice-formula">2d20kh + 5</div><div class="dice-tooltip">
                <section class="tooltip-part"><div class="dice"><ol class="dice-rolls"><li class="roll d20 discarded">4</li><li class="roll d20">15</li></ol></div></section>
                <section class="tooltip-part constant-term"><div class="dice"><div class="total">+5</div></div></section>
            </div><h4 class="dice-total">20</h4></div></div>`;
        };
        const roll = attackRoll();
        roll.dice[0].results = [{ result: 4, discarded: true, active: false }, { result: 15, active: true }];

        const section = await card.renderRsrSection(parent, child("atk", "attack", [roll]));

        expect([...section.querySelectorAll(".dice-rolls .roll")].map((die) => [die.dataset.rsrRoll, die.dataset.rsrDie, die.dataset.rsrResult]))
            .toEqual([["0", "0", "0"], ["0", "0", "1"]]);
    });

    it("reopens the breakdown after an edit re-renders the section", async () => {
        const damage = child("dmg", "damage", [damageRoll("fire", 4, 6)]);
        damage._rsrKeepExpanded = true;

        const section = await card.renderRsrSection(parent, damage);

        expect(section.querySelector(".dice-roll").classList.contains("expanded")).toBe(true);
        expect(damage._rsrKeepExpanded).toBeUndefined();
    });
});
