import { describe, beforeEach, it, expect, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

let RerollManager;
let env;

beforeEach(async () => {
    vi.resetModules();
    env = await setupFoundryEnv({ settings: { rerollEveryone: true, rerollPlayers: false } });
    $(document).off("mousedown");
    game.user.isGM = true;
    ({ RerollManager } = await import("../src/utils/reroll.js"));
    RerollManager.registerGlobalListener();
});

/** dnd5e 6 keeps core's tooltip classes inside its roll breakdown popover. */
function nativeBreakdownDie() {
    const message = document.createElement("li");
    message.className = "chat-message message";
    message.dataset.messageId = "attack";
    message.innerHTML = `
        <div class="message-content">
            <button class="dice-roll"><span class="total">17</span></button>
            <div class="roll-breakdown" popover>
                <div class="dice-tooltip-collapser"><div class="dice-tooltip">
                    <section class="tooltip-part"><div class="dice">
                        <ol class="dice-rolls"><li class="roll die d20">11</li></ol>
                    </div></section>
                </div></div>
            </div>
        </div>`;
    document.body.append(message);
    game.messages.set("attack", { id: "attack", isAuthor: true, rolls: [], flags: {} });
    return message.querySelector(".roll");
}

function click(die) {
    $(die).trigger($.Event("mousedown", { button: 0 }));
}

function useDnd5e(version) {
    game.system = { version };
    CONFIG.ChatMessage.dataModels = version.startsWith("6")
        ? Object.fromEntries(["attack", "damage", "healing", "check", "save", "generic"].map((t) => [t, {}]))
        : {};
}

it("still rerolls a clicked die on the legacy workflow", () => {
    useDnd5e("5.3.3");
    const reroll = vi.spyOn(RerollManager, "_handleReroll").mockImplementation(() => {});

    click(nativeBreakdownDie());

    expect(reroll).toHaveBeenCalledOnce();
});

it("leaves dice in dnd5e 6's own breakdowns alone", () => {
    useDnd5e("6.0.1");
    const reroll = vi.spyOn(RerollManager, "_handleReroll").mockImplementation(() => {});
    const fudge = vi.spyOn(RerollManager, "_handleFudge").mockImplementation(() => {});
    const die = nativeBreakdownDie();

    click(die);
    $(die).trigger($.Event("mousedown", { button: 2 }));

    expect(reroll).not.toHaveBeenCalled();
    expect(fudge).not.toHaveBeenCalled();
});

/** A die RSR rendered on a dnd5e 6 section: its source is stamped on it. */
function stampedDie({ isAuthor = true } = {}) {
    const section = document.createElement("div");
    section.className = "rsr-card";
    section.dataset.messageId = "dmg";
    section.innerHTML = `<div class="dice-roll expanded"><div class="dice-tooltip"><section class="tooltip-part"><div class="dice">
        <ol class="dice-rolls"><li class="roll d6">2</li><li class="roll d6" data-rsr-roll="1" data-rsr-die="0" data-rsr-result="1">5</li></ol>
    </div></section></div></div>`;
    document.body.append(section);
    game.messages.set("dmg", { id: "dmg", type: "damage", isAuthor, rolls: [], flags: { rsreforged: { workflowVersion: 2 } } });
    return section.querySelectorAll(".roll");
}

it("rerolls a stamped die on dnd5e 6 using its stamped source, not its position", () => {
    useDnd5e("6.0.5");
    const reroll = vi.spyOn(RerollManager, "_handleReroll").mockImplementation(() => {});
    const [unstamped, stamped] = stampedDie();

    click(unstamped);
    expect(reroll).not.toHaveBeenCalled();

    click(stamped);
    expect(reroll).toHaveBeenCalledOnce();
    const [message, , path] = reroll.mock.calls[0];
    expect(message.id).toBe("dmg");
    expect(path).toEqual({ messageId: "dmg", rollIndex: 1, termIndex: 0, resultIndex: 1 });
});

it("fudges a stamped die for the GM only, and rerolls for its author only with player rerolls on", () => {
    useDnd5e("6.0.5");
    game.settings.set("rsreforged", "fudgeGM", true);
    const fudge = vi.spyOn(RerollManager, "_handleFudge").mockImplementation(() => {});
    const reroll = vi.spyOn(RerollManager, "_handleReroll").mockImplementation(() => {});
    const [, stamped] = stampedDie({ isAuthor: false });

    $(stamped).trigger($.Event("mousedown", { button: 2 }));
    expect(fudge).toHaveBeenCalledOnce();

    game.user.isGM = false;
    $(stamped).trigger($.Event("mousedown", { button: 2 }));
    click(stamped);
    expect(fudge).toHaveBeenCalledOnce();
    expect(reroll).not.toHaveBeenCalled();
});

it("writes a dnd5e 6 reroll to the message's own rolls and keeps its breakdown open", async () => {
    const { DamageRoll, TestDie } = env.classes;
    const makeRoll = () => {
        const roll = new DamageRoll("2d6");
        const die = new TestDie({ number: 2, faces: 6, results: [{ result: 2, active: true }, { result: 5, active: true }] });
        roll.terms = [die];
        roll.dice = [die];
        roll.total = 7;
        roll.options.rsreforgedCriticalBase = { stale: true };
        return roll;
    };
    const live = makeRoll();
    const message = { id: "dmg", type: "damage", rolls: [live], flags: { rsreforged: { workflowVersion: 2 } }, update: vi.fn(async () => {}) };
    vi.spyOn(RerollManager, "_announceReroll").mockResolvedValue();
    // Roll.fromData returns an independent copy, as in Foundry; a fresh 1d6 rolls a 6.
    globalThis.Roll = class extends Roll {
        static fromData() { return makeRoll(); }
        async evaluate() { this.dice = [{ results: [{ result: 6 }] }]; return this; }
    };

    await RerollManager._handleReroll(message, $(), { messageId: "dmg", rollIndex: 0, termIndex: 0, resultIndex: 1 });

    expect(message.update).toHaveBeenCalledTimes(1);
    const [written] = message.update.mock.calls[0][0].rolls;
    expect(written.dice[0].results.map((r) => r.result)).toEqual([2, 6]);
    expect(written.options.rsreforgedCriticalBase).toBeUndefined();
    // The live document only changes through the update.
    expect(live.dice[0].results.map((r) => r.result)).toEqual([2, 5]);
    expect(message.flags.rsreforged.rolls).toBeUndefined();
    expect(message._rsrKeepExpanded).toBe(true);
});

describe("retroactive advantage's extra d20", () => {
    let RollUtility;

    beforeEach(async () => {
        ({ RollUtility } = await import("../src/utils/roll.js"));
        game.dice3d = { isEnabled: () => true, showForRoll: vi.fn(async () => true) };
    });

    function single() {
        const { D20Roll, TestDie } = env.classes;
        const roll = new D20Roll("1d20 + 5");
        const die = new TestDie({ number: 1, faces: 20, results: [{ result: 9, active: true }] });
        die._evaluateModifiers = () => {};
        roll.terms = [die];
        roll.dice = [die];
        return roll;
    }

    it("adopts an Always Roll Multiple Dice alternate instead of rolling and throwing a new die", async () => {
        const roll = single();
        roll.options.rsreforgedAlternates = [{ result: 15, active: true }];

        const upgraded = await RollUtility.ensureMultiRoll(roll, { message: { id: "m", whisper: [] } });

        expect(upgraded.terms[0].results.map((r) => r.result)).toEqual([9, 15]);
        expect(upgraded.options.rsreforgedAlternates).toBeUndefined();
        expect(game.dice3d.showForRoll).not.toHaveBeenCalled();
    });

    it("adopts a whole stored die, reroll history included, rather than a truncated one", async () => {
        const roll = single();
        // Halfling Lucky: the stored die's 1 was replaced by an 18.
        roll.options.rsreforgedAlternates = [{ result: 1, active: false, rerolled: true }, { result: 18, active: true }];

        const upgraded = await RollUtility.ensureMultiRoll(roll, { message: { id: "m", whisper: [] } });

        expect(upgraded.terms[0].results.map((r) => r.result)).toEqual([9, 1, 18]);
        expect(game.dice3d.showForRoll).not.toHaveBeenCalled();
    });

    it("throws a freshly rolled extra d20 for the message's audience, not the current roll mode", async () => {
        const TestRoll = Roll;
        globalThis.Roll = class extends TestRoll {
            async evaluate() { this.dice = [{ faces: 20, results: [{ result: 4, active: true }] }]; return this; }
        };
        const roll = single();
        const message = { id: "m", whisper: ["gm"], blind: true, speaker: { actor: "a" } };

        await RollUtility.ensureMultiRoll(roll, { message });

        expect(game.dice3d.showForRoll).toHaveBeenCalledTimes(1);
        expect(game.dice3d.showForRoll.mock.calls[0].slice(2, 7)).toEqual([true, ["gm"], true, "m", { actor: "a" }]);
    });
});

describe("review fixes", () => {
    it("reselects dnd5e 6 advantage (adv) after a die changes, not only kh/kl", () => {
        const { TestDie } = env.classes;
        const die = new TestDie({ number: 2, faces: 20, modifiers: ["adv"], results: [
            { result: 18, active: true }, { result: 10, active: false, discarded: true }
        ] });
        die.results[1].result = 20; // fudged

        RerollManager._recalculateModifiers(die);

        expect(die.results.map((r) => [r.result, r.active])).toEqual([[18, false], [20, true]]);
    });

    it("keeps a reroll modifier's replaced result out of advantage reselection", () => {
        const { TestDie } = env.classes;
        const die = new TestDie({ number: 2, faces: 20, modifiers: ["dis"], results: [
            { result: 1, active: false, rerolled: true }, { result: 7, active: true },
            { result: 12, active: false, discarded: true }
        ] });

        RerollManager._recalculateModifiers(die);

        expect(die.results.map((r) => r.active)).toEqual([false, true, false]);
    });

    it("announces a reroll of a whispered roll only to that roll's audience", async () => {
        const { RollUtility } = await import("../src/utils/roll.js");
        const show = vi.spyOn(RollUtility, "_showExtraDice").mockResolvedValue(true);
        game.settings.set("rsreforged", "rerollLogChat", true);
        game.settings.set("rsreforged", "rerollSoundEnabled", true);
        // The user's current roll mode is public.
        game.settings.set("core", "rollMode", "publicroll");
        ChatMessage.create = vi.fn(async () => {});
        const message = { id: "m", whisper: ["gm"], blind: true };

        await RerollManager._announceReroll(message, { dice: [] }, { faces: 20, oldResult: 3, newResult: 17 });

        expect(show).toHaveBeenCalledWith(expect.anything(), message);
        const logged = ChatMessage.create.mock.calls[0][0];
        expect(logged.whisper).toEqual(["gm"]);
        expect(logged.blind).toBe(true);
    });
});
