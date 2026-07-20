// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

// The bonus selector dialog renders effect name, icon path, and formula — all
// world data a player can author on their own actor — into HTML shown on the
// GM's client. These tests pin that such values are escaped, not interpolated
// as live markup.
describe("BonusSelector escaping", () => {
    let BonusSelector;

    beforeEach(async () => {
        vi.resetModules();
        await setupFoundryEnv();
        ({ BonusSelector } = await import("../src/utils/bonus.js"));
    });

    const render = (bonus) => new BonusSelector({ bonuses: [bonus], type: "damage" })._renderHTML();

    it("renders a script-injection effect name as inert text", async () => {
        const payload = `<img src=x onerror="window.__pwned = 1">`;
        const div = await render({ name: payload, rawFormula: "1d4", icon: "icons/svg/aura.svg" });

        // One icon for the custom-bonus row, one for the bonus itself — an
        // unescaped payload would inject a third.
        expect(div.querySelectorAll("img")).toHaveLength(2);
        expect(div.querySelector("strong + br + small")).not.toBeNull();
        expect(div.querySelector("label[for='bonus-0'] strong").textContent).toBe(payload);
    });

    it("renders a malicious formula as inert text", async () => {
        const payload = `<script>window.__pwned = 1</script>`;
        const div = await render({ name: "Bless", rawFormula: payload, icon: "icons/svg/aura.svg" });

        expect(div.querySelector("script")).toBeNull();
        expect(div.querySelector("label[for='bonus-0'] small").textContent).toBe(payload);
    });

    it("keeps an attribute-breaking icon path inside the src attribute", async () => {
        const payload = `x" onerror="window.__pwned = 1`;
        const div = await render({ name: "Bless", rawFormula: "1d4", icon: payload });

        const icon = div.querySelector("label[for='bonus-0'] img");
        expect(icon.hasAttribute("onerror")).toBe(false);
        expect(icon.getAttribute("src")).toBe(payload);
    });
});
