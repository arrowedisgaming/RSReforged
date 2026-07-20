import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

// Targeted regression tests for the 4.13.3 multi-roll rendering fixes: the
// bonus-term evaluation loop must actually await term.evaluate() (the old
// `await bonusTerms.forEach(async ...)` never waited), rerolled d20 results
// are folded into one entry via deep copies that leave the source roll
// untouched, and a reroll replaced by a fixer value (count) stays active.
describe("RenderUtility multiroll rendering", () => {
    let RenderUtility;
    let TEMPLATE;

    beforeEach(async () => {
        vi.resetModules();
        await setupFoundryEnv();
        ({ RenderUtility } = await import("../src/utils/render.js"));
        ({ TEMPLATE } = await import("../src/module/templates.js"));
    });

    const makeD20 = (results) => new foundry.dice.terms.Die({
        number: results.length,
        faces: 20,
        results: results.map((r) => ({ active: true, ...r })),
        modifiers: []
    });

    // The multiroll template mock discards `entries`, so assert on the data
    // handed to renderTemplate instead of on the rendered markup.
    const renderedData = () => foundry.applications.handlebars.renderTemplate.mock.calls.at(-1)[1];

    it("waits for genuinely async bonus-term evaluation before building the bonus roll", async () => {
        const d20 = makeD20([{ result: 12 }]);
        // Resolves on a macrotask so a not-actually-awaited loop (the old
        // `await bonusTerms.forEach(async ...)`) reaches Roll.fromTerms while
        // the term still has no total.
        const bonusTerm = {
            _evaluated: false,
            results: [],
            async evaluate() {
                await new Promise((resolve) => setTimeout(resolve, 0));
                this.total = 3;
                this._evaluated = true;
                return this;
            }
        };
        const roll = { terms: [d20, bonusTerm], dice: [d20], options: {} };

        await RenderUtility.render(TEMPLATE.MULTIROLL, { roll, key: "attack" });

        expect(bonusTerm._evaluated).toBe(true);
        expect(renderedData().entries).toHaveLength(1);
        expect(renderedData().entries[0].total).toBe(15);
    });

    it("folds an uncounted rerolled d20 into one entry without mutating the source roll", async () => {
        const d20 = makeD20([{ result: 5, rerolled: true }, { result: 18 }]);
        const roll = { terms: [d20], dice: [d20], options: {} };

        await RenderUtility.render(TEMPLATE.MULTIROLL, { roll, key: "attack" });

        const { entries } = renderedData();
        expect(entries).toHaveLength(1);
        // The rerolled result is deactivated only in the entry's copy, so the
        // entry totals the replacement die alone...
        expect(entries[0].roll.terms[0].results.map((r) => r.active)).toEqual([false, true]);
        expect(entries[0].total).toBe(18);
        // ...while the source roll's results stay untouched.
        expect(d20.results.map((r) => r.active)).toEqual([true, true]);
    });

    it("keeps a rerolled result active when a fixer value (count) replaced it", async () => {
        const d20 = makeD20([{ result: 1, rerolled: true, count: 10 }]);
        const roll = { terms: [d20], dice: [d20], options: {} };

        await RenderUtility.render(TEMPLATE.MULTIROLL, { roll, key: "check" });

        const { entries } = renderedData();
        expect(entries).toHaveLength(1);
        expect(entries[0].roll.terms[0].results[0].active).toBe(true);
        // The fixer value, not the raw rerolled die, is what the entry totals.
        expect(entries[0].total).toBe(10);
    });
});
