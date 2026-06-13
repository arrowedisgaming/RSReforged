import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

// Coverage for the retroactive-bonus damage-type keywords added in PR #22:
// bare <type>, random:<list>, choice:<list>, their precedence, and validation of
// the list keys against CONFIG.DND5E.damageTypes.
describe("BonusManager.parseBonusChange", () => {
    let BonusManager;

    beforeEach(async () => {
        vi.resetModules();
        await setupFoundryEnv();
        ({ BonusManager } = await import("../src/utils/bonus.js"));
        // The base env only registers "slashing"; add the types these tests use and
        // deliberately leave "frost" out so it exercises the invalid-key path.
        CONFIG.DND5E.damageTypes.fire = { label: "Fire" };
        CONFIG.DND5E.damageTypes.cold = { label: "Cold" };
        CONFIG.DND5E.damageTypes.lightning = { label: "Lightning" };
    });

    it("reads a bare damage type as a fixed-type bonus and keeps it out of the formula", () => {
        const parsed = BonusManager.parseBonusChange("2d6; type:damage; fire", "damage");
        expect(parsed).toMatchObject({ damageMode: "fixed", damageTypeOptions: ["fire"], rawFormula: "2d6" });
    });

    it("parses random: and choice: lists, lowercasing and trimming entries", () => {
        expect(BonusManager.parseBonusChange("1d6; type:damage; random:Fire, Cold", "damage"))
            .toMatchObject({ damageMode: "random", damageTypeOptions: ["fire", "cold"] });
        expect(BonusManager.parseBonusChange("1d6; type:damage; choice:fire,lightning", "damage"))
            .toMatchObject({ damageMode: "choice", damageTypeOptions: ["fire", "lightning"] });
    });

    it("applies precedence random: > choice: > bare type", () => {
        const parsed = BonusManager.parseBonusChange("1d6; type:damage; random:fire; choice:cold", "damage");
        expect(parsed.damageMode).toBe("random");
        expect(parsed.damageTypeOptions).toEqual(["fire"]);
    });

    it("drops unknown types from random:/choice: lists with a warning", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const parsed = BonusManager.parseBonusChange("1d6; type:damage; random:frost,fire", "damage");
        expect(parsed.damageMode).toBe("random");
        expect(parsed.damageTypeOptions).toEqual(["fire"]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("frost"));
        warn.mockRestore();
    });

    it("falls back to an untyped bonus when every listed type is unknown", () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const parsed = BonusManager.parseBonusChange("1d6; type:damage; choice:frost,sonic", "damage");
        expect(parsed.damageMode).toBeNull();
        expect(parsed.damageTypeOptions).toEqual([]);
    });

    it("returns null when the bonus's type restriction excludes the rolled type", () => {
        expect(BonusManager.parseBonusChange("1d4; type:save; fire", "damage")).toBeNull();
    });

    it("treats a formula-less damage-type token as a pure 0 tag", () => {
        const parsed = BonusManager.parseBonusChange("type:damage; fire", "damage");
        expect(parsed).toMatchObject({ damageMode: "fixed", rawFormula: "0" });
    });

    it("resolves @-references in the formula against the supplied roll data", () => {
        const parsed = BonusManager.parseBonusChange("@abilities.str.mod; type:damage; fire", "damage", {
            abilities: { str: { mod: 3 } }
        });
        expect(parsed.resolvedFormula).toBe("3");
    });
});
