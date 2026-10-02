import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRoll, setupFoundryEnv } from "./helpers/foundry-env.mjs";

describe("BonusManager", () => {
    let BonusManager;
    let env;

    beforeEach(async () => {
        vi.resetModules();
        env = await setupFoundryEnv();
        ({ BonusManager } = await import("../src/utils/bonus.js"));
    });

    it("resolves scalar and dice-shaped roll data references inside bonus formulas", () => {
        const formula = BonusManager._resolveFormula("@abilities.str.mod + @resources.bardic + @missing", {
            abilities: { str: { mod: 4 } },
            resources: { bardic: { number: 1, faces: 8 } }
        });

        expect(formula).toBe("4 + 1d8 + @missing");
    });

    it("injects one bonus button per supported roll section and avoids duplicates", () => {
        const message = {
            isAuthor: true,
            flags: { dnd5e: { roll: { type: "skill" } } }
        };
        const html = $(`
            <article>
                <header class="message-header"><span class="message-sender">Avery</span></header>
                <section class="rsr-section-attack"><div class="rsr-header"><div class="rsr-title">Attack</div></div></section>
                <section class="rsr-section-damage"><div class="rsr-header"><div class="rsr-title">Damage</div></div></section>
            </article>
        `);

        expect(BonusManager.init(message, html)).toBe(true);
        expect(BonusManager.init(message, html)).toBe(true);

        expect(html.find('.rsr-addon-bonus-btn[data-type="attack"]')).toHaveLength(1);
        expect(html.find('.rsr-addon-bonus-btn[data-type="damage"]')).toHaveLength(1);
        expect(html.find('.rsr-addon-bonus-btn[data-type="skill"]')).toHaveLength(1);
    });

    it("does not inject bonus controls for users who cannot alter the message", () => {
        const message = {
            isAuthor: false,
            flags: { dnd5e: { roll: { type: "skill" } } }
        };
        const html = $(`<article><header class="message-header"></header></article>`);

        expect(BonusManager.init(message, html)).toBe(false);
        expect(html.find(".rsr-addon-bonus-btn")).toHaveLength(0);
    });

    it("writes a bonus on a dnd5e 6 roll message to that message's own rolls, not RSR's flag cache", async () => {
        const { DamageRoll } = env.classes;
        const roll = makeRoll(DamageRoll, { formula: "1d8 + 3", total: 7, faces: 8, results: [4], type: "slashing" });
        roll.options.rsreforgedCriticalBase = { formula: "stale" };
        // Native children carry RSR workflow flags, which must not divert the write.
        const message = { type: "damage", rolls: [roll], flags: { rsreforged: { workflowVersion: 2, parentId: "p" } }, update: vi.fn(async () => {}) };
        const actor = { getRollData: () => ({}), effects: { get: () => null }, items: { get: () => null } };

        await BonusManager.applyBonus(message, "damage", { name: "Custom Bonus", rawFormula: "2", isOnce: false }, actor);

        expect(message.update).toHaveBeenCalledTimes(1);
        const [written] = message.update.mock.calls[0][0].rolls;
        expect(written.total).toBe(9);
        expect(written.options.type).toBe("slashing");
        expect(written.options.rsreforgedCriticalBase).toBeUndefined();
        expect(message.flags.rsreforged.rolls).toBeUndefined();
    });
});

describe("RerollManager", () => {
    let RerollManager;
    let env;

    beforeEach(async () => {
        vi.resetModules();
        env = await setupFoundryEnv();
        ({ RerollManager } = await import("../src/utils/reroll.js"));
    });

    it("finds the roll, term, and result indexes from the clicked die element", () => {
        const html = $(`
            <article class="message-content">
                <div class="dice-roll">
                    <div class="dice-tooltip">
                        <section class="tooltip-part"><span class="roll die">1</span></section>
                    </div>
                </div>
                <div class="dice-roll">
                    <div class="dice-tooltip">
                        <section class="tooltip-part"><span class="roll die">2</span></section>
                        <section class="tooltip-part">
                            <span class="roll die">3</span>
                            <span class="roll die">4</span>
                            <span class="roll die target">5</span>
                        </section>
                    </div>
                </div>
            </article>
        `);

        expect(RerollManager._getDiePath(html.find(".target"))).toEqual({
            rollIndex: 1,
            termIndex: 1,
            resultIndex: 2
        });
    });

    it("re-applies keep-high (advantage) and refolds the roll total after a die changes", () => {
        const { TestDie, D20Roll } = env.classes;
        // 2d20kh1 (advantage) that previously kept the 17.
        const die = new TestDie({
            number: 2,
            faces: 20,
            modifiers: ["kh"],
            results: [
                { result: 4, active: false, discarded: true },
                { result: 17, active: true, discarded: false }
            ]
        });
        const roll = D20Roll.fromTerms([die]);
        expect(roll.total).toBe(17);

        // Fudge the kept die down to a 2; RSR must reset the results and re-delegate to
        // the term's own keep-high evaluation, then refold the roll total.
        die.results[1].result = 2;
        RerollManager._recalculateModifiers(die);
        roll._total = roll._evaluateTotal();

        // Keep-high now keeps the 4 and discards the 2 — the real modifier logic ran,
        // not a stub — and the discarded die is excluded from the recomputed total.
        expect(die.results[0]).toMatchObject({ active: true, discarded: false });
        expect(die.results[1]).toMatchObject({ active: false, discarded: true });
        expect(roll.total).toBe(4);
    });

    it("re-applies keep-low (disadvantage) after a die changes", () => {
        const { TestDie, D20Roll } = env.classes;
        // 2d20kl1 (disadvantage) that previously kept the 5.
        const die = new TestDie({
            number: 2,
            faces: 20,
            modifiers: ["kl"],
            results: [
                { result: 5, active: true, discarded: false },
                { result: 12, active: false, discarded: true }
            ]
        });
        const roll = D20Roll.fromTerms([die]);
        expect(roll.total).toBe(5);

        // Reroll the kept low die up to an 18; keep-low must now keep the 12.
        die.results[0].result = 18;
        RerollManager._recalculateModifiers(die);
        roll._total = roll._evaluateTotal();

        expect(die.results[1]).toMatchObject({ active: true, discarded: false });
        expect(die.results[0]).toMatchObject({ active: false, discarded: true });
        expect(roll.total).toBe(12);
    });

    it("leaves a non-keep term untouched (no modifier evaluation)", () => {
        const { TestDie, DamageRoll } = env.classes;
        const die = new TestDie({
            number: 2,
            faces: 6,
            modifiers: [],
            results: [
                { result: 3, active: true, discarded: false },
                { result: 5, active: true, discarded: false }
            ]
        });
        const roll = DamageRoll.fromTerms([die]);

        die.results[0].result = 1;
        RerollManager._recalculateModifiers(die);
        roll._total = roll._evaluateTotal();

        // Both dice stay active (no kh/kl) and the total folds in the new value.
        expect(die.results.every((result) => result.active)).toBe(true);
        expect(roll.total).toBe(6);
    });
});
