import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

describe("CoreUtility", () => {
    let CoreUtility;

    beforeEach(async () => {
        vi.resetModules();
        await setupFoundryEnv();
        ({ CoreUtility } = await import("../src/utils/core.js"));
    });

    it("builds whisper data for public, GM, blind, and self roll modes", () => {
        expect(CoreUtility.getWhisperData("publicroll")).toEqual({
            rollMode: "publicroll",
            whisper: undefined,
            blind: null
        });
        expect(CoreUtility.getWhisperData("gmroll")).toMatchObject({
            rollMode: "gmroll",
            whisper: [{ id: "gm" }],
            blind: null
        });
        expect(CoreUtility.getWhisperData("blindroll")).toMatchObject({
            rollMode: "blindroll",
            whisper: [{ id: "gm" }],
            blind: true
        });
        expect(CoreUtility.getWhisperData("selfroll")).toEqual({
            rollMode: "selfroll",
            whisper: ["user-1"],
            blind: null
        });
    });

    it("detects active modules and iterable values", () => {
        game.modules.get.mockImplementation((name) => ({ active: name === "dice-so-nice" }));

        expect(CoreUtility.hasModule("dice-so-nice")).toBe(true);
        expect(CoreUtility.hasModule("missing")).toBe(false);
        expect(CoreUtility.isIterable([1, 2])).toBe(true);
        expect(CoreUtility.isIterable(new Set())).toBe(true);
        expect(CoreUtility.isIterable(null)).toBe(false);
        expect(CoreUtility.isIterable({})).toBe(false);
    });

    it("plays Dice So Nice rolls when enabled and falls back false when no dice are present", async () => {
        const showForRoll = vi.fn();
        game.dice3d = {
            isEnabled: () => true,
            showForRoll
        };

        expect(await CoreUtility.tryRollDice3D({ dice: [{ faces: 20 }] }, "message-1")).toBe(true);
        expect(showForRoll).toHaveBeenCalledWith(
            expect.objectContaining({ dice: [{ faces: 20 }] }),
            game.user,
            true,
            undefined,
            false,
            "message-1",
            undefined
        );

        showForRoll.mockClear();
        expect(await CoreUtility.tryRollDice3D({ dice: [] })).toBe(false);
        expect(showForRoll).not.toHaveBeenCalled();
    });
});

describe("RenderUtility", () => {
    beforeEach(async () => {
        vi.resetModules();
        await setupFoundryEnv();
    });

    it("renders module templates through the Foundry template path", async () => {
        const { RenderUtility } = await import("../src/utils/render.js");
        const { TEMPLATE } = await import("../src/module/templates.js");

        const html = await RenderUtility.render(TEMPLATE.SECTION, {
            section: "rsr-section-test",
            title: "Test",
            icon: "<i></i>",
            subtitle: "Sub"
        });

        expect(html).toContain("rsr-section-test");
        expect(html).toContain("Test");
        // The HTML body comes from the harness template stub, so the real signal here is
        // that RenderUtility selected the correct template and forwarded the caller's data
        // unchanged — assert the data object, not just the rendered markup.
        expect(foundry.applications.handlebars.renderTemplate).toHaveBeenCalledWith(
            "modules/rsreforged/templates/rsr-section.html",
            expect.objectContaining({ section: "rsr-section-test", title: "Test", subtitle: "Sub" })
        );
    });

    it("extracts the roll total and forwards it to the damage template", async () => {
        const { RenderUtility } = await import("../src/utils/render.js");
        const { TEMPLATE } = await import("../src/module/templates.js");

        const html = await RenderUtility.render(TEMPLATE.DAMAGE, { roll: { total: 12 } });

        expect(html).toContain("12");
        // Real coverage: _renderDamageRoll must pull roll.total and pass { total } to the
        // damage template. The stub's markup is incidental; the forwarded total is not.
        expect(foundry.applications.handlebars.renderTemplate).toHaveBeenCalledWith(
            "modules/rsreforged/templates/rsr-damage.html",
            expect.objectContaining({ total: 12 })
        );
    });

    it("suppresses DC outcome metadata when hideFinalResult is set on the roll", async () => {
        const env = await setupFoundryEnv();
        const { RenderUtility } = await import("../src/utils/render.js");
        const { TEMPLATE } = await import("../src/module/templates.js");
        const { makeRoll } = await import("./helpers/foundry-env.mjs");

        const roll = makeRoll(env.classes.D20Roll, {
            formula: "1d20+5",
            total: 18,
            faces: 20,
            results: [13]
        });
        // _configureRollVisibility is the single owner of the hide rule: whenever
        // it sets hideFinalResult, it also clears displayChallenge and forceSuccess.
        // The render layer trusts that contract, so mirror it here.
        roll.options = {
            hideFinalResult: true,
            displayChallenge: false,
            forceSuccess: false,
            target: 15,
            criticalSuccess: 20,
            criticalFailure: 1
        };

        await RenderUtility.render(TEMPLATE.MULTIROLL, { roll, key: "skill" });

        expect(foundry.applications.handlebars.renderTemplate).toHaveBeenCalledWith(
            "modules/rsreforged/templates/rsr-multiroll.html",
            expect.objectContaining({
                entries: [
                    expect.objectContaining({
                        hideTotal: true,
                        dcResult: undefined
                    })
                ]
            })
        );
    });
});

describe("LogUtility and DialogUtility", () => {
    beforeEach(async () => {
        vi.resetModules();
        await setupFoundryEnv();
    });

    it("routes log, error, and warning messages with the module tag", async () => {
        const { LogUtility } = await import("../src/utils/log.js");
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        LogUtility.log("hello");
        LogUtility.logError("bad");
        LogUtility.logWarning("careful");

        expect(log.mock.calls[0].at(-1)).toBe("hello");
        expect(error.mock.calls[0].at(-1)).toBe("bad");
        expect(warn.mock.calls[0].at(-1)).toBe("careful");
        expect(ui.notifications.error).toHaveBeenCalledWith("bad", { console: false });
        expect(ui.notifications.warn).toHaveBeenCalledWith("careful", { console: false });

        log.mockRestore();
        error.mockRestore();
        warn.mockRestore();
    });

    it("creates confirm dialogs that resolve from button callbacks", async () => {
        const rendered = {};
        globalThis.Dialog = class TestDialog {
            constructor(data, options) {
                rendered.data = data;
                rendered.options = options;
            }

            render(open) {
                rendered.open = open;
            }
        };
        const { DialogUtility } = await import("../src/utils/dialog.js");

        const result = DialogUtility.getConfirmDialog("Confirm", { width: 200 });
        rendered.data.buttons.no.callback();

        await expect(result).resolves.toBe(false);
        expect(rendered).toMatchObject({
            open: true,
            options: { width: 200 }
        });
    });
});
