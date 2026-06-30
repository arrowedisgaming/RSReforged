import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRoll, setupFoundryEnv } from "./helpers/foundry-env.mjs";

describe("ChatUtility message lifecycle behavior", () => {
    let env;
    let ChatUtility;
    let ActivityUtility;
    let RenderUtility;
    let MODULE_SHORT;
    let TEMPLATE;
    let HIDE_NPC_ROLL_STYLES;

    beforeEach(async () => {
        vi.resetModules();
        env = await setupFoundryEnv();
        ({ MODULE_SHORT } = await import("../src/module/const.js"));
        ({ ChatUtility } = await import("../src/utils/chat.js"));
        ({ ActivityUtility } = await import("../src/utils/activity.js"));
        ({ RenderUtility } = await import("../src/utils/render.js"));
        ({ TEMPLATE } = await import("../src/module/templates.js"));
        ({ HIDE_NPC_ROLL_STYLES } = await import("../src/utils/settings.js"));
    });

    afterEach(() => {
        // Explicit teardown so spy isolation does not depend on resetModules()
        // happening to orphan the previous module's spies.
        vi.restoreAllMocks();
    });

    it("does not process legacy usage messages without rsreforged flags (issue #15)", async () => {
        const activity = { type: "attack", hasOwnProperty: Object.prototype.hasOwnProperty };
        const message = new env.classes.TestChatMessage({
            type: "usage",
            isAuthor: true,
            flags: { dnd5e: { activity: { type: "attack", id: "activity-1" } } },
            getAssociatedActivity: () => activity
        });
        const html = $(`<article class="chat-message"><div class="message-content"><div class="card-buttons"><button data-action="rollAttack"></button></div></div></article>`);

        const setRenderFlags = vi.spyOn(ActivityUtility, "setRenderFlags");
        const runActivityActions = vi.spyOn(ActivityUtility, "runActivityActions").mockResolvedValue(undefined);
        const updateChatMessage = vi.spyOn(ChatUtility, "updateChatMessage");

        await ChatUtility.processChatMessage(message, html);

        expect(message.flags[MODULE_SHORT]).toBeUndefined();
        expect(setRenderFlags).not.toHaveBeenCalled();
        expect(runActivityActions).not.toHaveBeenCalled();
        expect(updateChatMessage).not.toHaveBeenCalled();
        expect(message.updatedWith).toBeUndefined();
        expect(html.hasClass("rsr-hide")).toBe(false);
    });

    it("runs activity actions once for creation-stamped unprocessed usage messages", async () => {
        // Forward-path complement to the issue #15 test above: a message that WAS
        // stamped at creation (quickRoll + render flags present) must still drive the
        // quick-roll pipeline. Render flags are consumed as-is — processChatMessage must
        // never re-derive them at render time (that retroactive stamping was the #15 bug),
        // so setRenderFlags must NOT be called here.
        const message = new env.classes.TestChatMessage({
            type: "usage",
            isAuthor: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: false,
                    renderAttack: true
                },
                dnd5e: { activity: { type: "attack" } }
            }
        });
        const html = $(`<article class="chat-message"><div class="message-content"></div></article>`);

        const setRenderFlags = vi.spyOn(ActivityUtility, "setRenderFlags");
        const runActivityActions = vi.spyOn(ActivityUtility, "runActivityActions").mockResolvedValue(undefined);

        await ChatUtility.processChatMessage(message, html);

        expect(runActivityActions).toHaveBeenCalledTimes(1);
        expect(runActivityActions).toHaveBeenCalledWith(message);
        expect(setRenderFlags).not.toHaveBeenCalled();
        // quickRoll preserved, not rewritten by the vanilla path.
        expect(message.flags[MODULE_SHORT].quickRoll).toBe(true);
        expect(html.hasClass("rsr-hide")).toBe(true);
    });

    it("renders processed usage cards after dnd5e has produced stable card HTML", async () => {
        const attack = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 23, faces: 20, results: [18] });
        const damage = makeRoll(env.classes.DamageRoll, { formula: "1d8+3", total: 9, faces: 8, results: [6] });
        const formula = makeRoll(env.classes.BasicRoll, { formula: "1d6", total: 4, faces: 6, results: [4] });
        const actor = { isOwner: true, items: { get: vi.fn() } };
        const message = new env.classes.TestChatMessage({
            type: "usage",
            isAuthor: true,
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    renderAttack: true,
                    renderDamage: true,
                    renderFormula: true,
                    rolls: [attack, damage, formula]
                },
                dnd5e: { activity: { type: "attack" } }
            },
            getAssociatedActor: () => actor
        });
        const html = $(`
            <article class="chat-message">
                <div class="message-content">
                    <div class="dnd5e2 chat-card usage-card">
                        <div class="card-buttons">
                            <button data-action="rollAttack"></button>
                            <button data-action="rollDamage"></button>
                            <button data-action="rollFormula"></button>
                        </div>
                        <span class="supplement">Weapon mastery</span>
                    </div>
                    <div class="dnd5e2 chat-card"><div class="dice-roll"></div></div>
                </div>
            </article>
        `);

        await ChatUtility.processUsageChatMessage(message, html[0]);

        expect(html.find(".rsr-section-attack")).toHaveLength(1);
        expect(html.find(".rsr-section-damage")).toHaveLength(1);
        expect(html.find(".rsr-section-roll")).toHaveLength(1);
        expect(html.find("[data-action=rollAttack], [data-action=rollDamage], [data-action=rollFormula]")).toHaveLength(0);
        expect(html.find(".rsr-damage-buttons-xl")).toHaveLength(1);
        expect(ui.chat.scrollBottom).toHaveBeenCalled();

        const hookNames = env.hookCalls.map((call) => call.name);
        expect(hookNames).toEqual(expect.arrayContaining([
            `${MODULE_SHORT}.preRenderChatMessageContent`,
            `${MODULE_SHORT}.renderChatMessageContent`,
            `${MODULE_SHORT}.renderApplyDamageButtons`
        ]));
        expect(env.hookCalls.filter((call) => call.name === `${MODULE_SHORT}.renderRoll`).map((call) => call.args[2])).toEqual([
            "attack",
            "damage",
            "roll"
        ]);
    });

    it("uses native damage rendering when dnd5e damage apply mode is selected", async () => {
        env.settings.damageApplyMode = "dnd5e";

        const damage = makeRoll(env.classes.DamageRoll, { formula: "1d10+3", total: 11, faces: 10, results: [8] });
        const message = new env.classes.TestChatMessage({
            type: "usage",
            isAuthor: true,
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    renderDamage: true,
                    versatile: true,
                    rolls: [damage]
                },
                dnd5e: { activity: { type: "damage" } }
            }
        });
        const html = $(`<article><div class="message-content"><div class="card-buttons"><button data-action="rollDamage"></button></div></div></article>`);

        await ChatUtility.processUsageChatMessage(message, html[0]);

        expect(html.find(".rsr-section-damage")).toHaveLength(0);
        expect(html.find(".rsr-damage-buttons-xl")).toHaveLength(0);
        expect(html.find(".rsr-versatile-tag")).toHaveLength(1);
        expect(env.hookCalls.filter((call) => call.name === `${MODULE_SHORT}.renderRoll`).map((call) => call.args[2])).toEqual(["damage"]);
    });

    it("applies temporary hit point rolls as temporary HP from the RSR x1 button (issue #20)", async () => {
        const actor = {
            applyTempHP: vi.fn(async () => undefined),
            applyDamage: vi.fn(async () => undefined)
        };
        canvas.tokens.controlled = [{ actor }];

        const tempHP = makeRoll(env.classes.DamageRoll, { formula: "1d6+2", total: 7, type: "temphp", faces: 6, results: [5] });
        const message = new env.classes.TestChatMessage({
            type: "usage",
            isAuthor: true,
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    renderDamage: true,
                    rolls: [tempHP]
                },
                dnd5e: { activity: { type: "heal" } }
            }
        });
        const html = $(`<article class="chat-message" data-message-id="${message.id}"><div class="message-content"><div class="dnd5e2 chat-card usage-card"><div class="card-buttons"></div></div></div></article>`);

        await ChatUtility.processUsageChatMessage(message, html[0]);
        const result = html.find('.rsr-damage-buttons-xl [data-action="rsr-apply-damage"][data-multiplier="1"]').triggerHandler("click");
        if (result?.then) await result;

        expect(actor.applyTempHP).toHaveBeenCalledWith(7);
        expect(actor.applyDamage).not.toHaveBeenCalled();
    });

    it("keeps maximum hit point reduction as maximum damage from the RSR x1 button", async () => {
        const actor = {
            applyTempHP: vi.fn(async () => undefined),
            applyDamage: vi.fn(async () => undefined)
        };
        canvas.tokens.controlled = [{ actor }];

        const maxHP = makeRoll(env.classes.DamageRoll, { formula: "1d4", total: 4, type: "maximum", faces: 4, results: [4] });
        const message = new env.classes.TestChatMessage({
            type: "usage",
            isAuthor: true,
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    renderDamage: true,
                    rolls: [maxHP]
                },
                dnd5e: { activity: { type: "damage" } }
            }
        });
        const html = $(`<article class="chat-message" data-message-id="${message.id}"><div class="message-content"><div class="dnd5e2 chat-card usage-card"><div class="card-buttons"></div></div></div></article>`);

        await ChatUtility.processUsageChatMessage(message, html[0]);
        const result = html.find('.rsr-damage-buttons-xl [data-action="rsr-apply-damage"][data-multiplier="1"]').triggerHandler("click");
        if (result?.then) await result;

        expect(actor.applyTempHP).not.toHaveBeenCalled();
        expect(actor.applyDamage).toHaveBeenCalledTimes(1);
        expect(actor.applyDamage.mock.calls[0][0]).toEqual([
            { value: 4, type: "maximum", properties: expect.any(Set) }
        ]);
        expect(actor.applyDamage.mock.calls[0][1]).toEqual({ multiplier: 1 });
    });

    it("restores max HP when the heart button is clicked on a maximum-type damage card", async () => {
        const actor = {
            applyTempHP: vi.fn(async () => undefined),
            applyDamage: vi.fn(async () => undefined)
        };
        canvas.tokens.controlled = [{ actor }];

        const maxHP = makeRoll(env.classes.DamageRoll, { formula: "1d4", total: 4, type: "maximum", faces: 4, results: [4] });
        const message = new env.classes.TestChatMessage({
            type: "usage",
            isAuthor: true,
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    renderDamage: true,
                    rolls: [maxHP]
                },
                // A damage activity (not heal): the heart button is the only signal
                // that the user wants to restore max HP rather than reduce it.
                dnd5e: { activity: { type: "damage" } }
            }
        });
        const html = $(`<article class="chat-message" data-message-id="${message.id}"><div class="message-content"><div class="dnd5e2 chat-card usage-card"><div class="card-buttons"></div></div></div></article>`);

        await ChatUtility.processUsageChatMessage(message, html[0]);
        const result = html.find('.rsr-damage-buttons-xl [data-action="rsr-apply-damage"][data-multiplier="-1"]').triggerHandler("click");
        if (result?.then) await result;

        expect(actor.applyTempHP).not.toHaveBeenCalled();
        expect(actor.applyDamage).toHaveBeenCalledTimes(1);
        expect(actor.applyDamage.mock.calls[0][0]).toEqual([
            { value: 4, type: "maximum", properties: expect.any(Set) }
        ]);
        // Heart button = apply as healing → only:"healing" routes maximum to max-HP restore.
        expect(actor.applyDamage.mock.calls[0][1]).toEqual({ multiplier: 1, only: "healing" });
    });

    it("treats Aid-style maximum hit point healing as healing from the RSR x1 button", async () => {
        const actor = {
            applyTempHP: vi.fn(async () => undefined),
            applyDamage: vi.fn(async () => undefined)
        };
        canvas.tokens.controlled = [{ actor }];

        const maxHP = makeRoll(env.classes.DamageRoll, { formula: "1d4", total: 4, type: "maximum", faces: 4, results: [4] });
        const message = new env.classes.TestChatMessage({
            type: "usage",
            isAuthor: true,
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    renderDamage: true,
                    rolls: [maxHP]
                },
                dnd5e: { activity: { type: "heal" } }
            }
        });
        const html = $(`<article class="chat-message" data-message-id="${message.id}"><div class="message-content"><div class="dnd5e2 chat-card usage-card"><div class="card-buttons"></div></div></div></article>`);

        await ChatUtility.processUsageChatMessage(message, html[0]);
        const result = html.find('.rsr-damage-buttons-xl [data-action="rsr-apply-damage"][data-multiplier="1"]').triggerHandler("click");
        if (result?.then) await result;

        expect(actor.applyTempHP).not.toHaveBeenCalled();
        expect(actor.applyDamage).toHaveBeenCalledTimes(1);
        expect(actor.applyDamage.mock.calls[0][0]).toEqual([
            { value: 4, type: "maximum", properties: expect.any(Set) }
        ]);
        expect(actor.applyDamage.mock.calls[0][1]).toEqual({ multiplier: 1, only: "healing" });
    });

    it("keeps Aid-style maximum healing as max-HP healing from the heart (negative-multiplier) button, not damage", async () => {
        const actor = {
            applyTempHP: vi.fn(async () => undefined),
            applyDamage: vi.fn(async () => undefined)
        };
        canvas.tokens.controlled = [{ actor }];

        const maxHP = makeRoll(env.classes.DamageRoll, { formula: "1d4", total: 4, type: "maximum", faces: 4, results: [4] });
        const message = new env.classes.TestChatMessage({
            type: "usage",
            isAuthor: true,
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    renderDamage: true,
                    rolls: [maxHP]
                },
                dnd5e: { activity: { type: "heal" } }
            }
        });
        const html = $(`<article class="chat-message" data-message-id="${message.id}"><div class="message-content"><div class="dnd5e2 chat-card usage-card"><div class="card-buttons"></div></div></div></article>`);

        await ChatUtility.processUsageChatMessage(message, html[0]);
        // The heart button carries data-multiplier="-1". A "maximum" roll must keep
        // its type (not collapse to "healing") so dnd5e's only:"healing" path raises
        // max HP — clicking the intuitive heart button must not deal damage.
        const result = html.find('.rsr-damage-buttons-xl [data-action="rsr-apply-damage"][data-multiplier="-1"]').triggerHandler("click");
        if (result?.then) await result;

        expect(actor.applyTempHP).not.toHaveBeenCalled();
        expect(actor.applyDamage).toHaveBeenCalledTimes(1);
        expect(actor.applyDamage.mock.calls[0][0]).toEqual([
            { value: 4, type: "maximum", properties: expect.any(Set) }
        ]);
        expect(actor.applyDamage.mock.calls[0][1]).toEqual({ multiplier: 1, only: "healing" });
    });

    it("applies temporary hit point rolls as temp HP even from the healing (negative-multiplier) button", async () => {
        const actor = {
            applyTempHP: vi.fn(async () => undefined),
            applyDamage: vi.fn(async () => undefined)
        };
        canvas.tokens.controlled = [{ actor }];

        const tempHP = makeRoll(env.classes.DamageRoll, { formula: "1d6+2", total: 7, type: "temphp", faces: 6, results: [5] });
        const message = new env.classes.TestChatMessage({
            type: "usage",
            isAuthor: true,
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    renderDamage: true,
                    rolls: [tempHP]
                },
                dnd5e: { activity: { type: "heal" } }
            }
        });
        const html = $(`<article class="chat-message" data-message-id="${message.id}"><div class="message-content"><div class="dnd5e2 chat-card usage-card"><div class="card-buttons"></div></div></div></article>`);

        await ChatUtility.processUsageChatMessage(message, html[0]);
        // The healing button carries data-multiplier="-1"; a temp-HP roll must still
        // route to applyTempHP rather than being collapsed into ordinary healing.
        const result = html.find('.rsr-damage-buttons-xl [data-action="rsr-apply-damage"][data-multiplier="-1"]').triggerHandler("click");
        if (result?.then) await result;

        expect(actor.applyTempHP).toHaveBeenCalledWith(7);
        expect(actor.applyDamage).not.toHaveBeenCalled();
    });

    it("hides dnd5e roll metadata during usage-card enrichment, then restores it for RSR (#18)", () => {
        const message = new env.classes.TestChatMessage({
            type: "usage",
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true
                },
                dnd5e: {
                    item: { id: "weapon-1" },
                    roll: { type: "attack", mastery: "sap" }
                }
            }
        });
        const html = $(`
            <article class="chat-message">
                <header class="message-header"></header>
                <div class="message-content"></div>
            </article>
        `);

        ChatUtility.suppressDnd5eEnrichedRollFlavor(message);

        expect(message.flags.dnd5e.roll).toBeUndefined();
        expect(message._rsrSuppressedDnd5eRoll).toEqual({ type: "attack", mastery: "sap" });
        expect(html[0].querySelector(".message-content .chat-card")).toBeNull();

        ChatUtility.restoreDnd5eEnrichedRollFlavor(message);

        expect(message.flags.dnd5e.roll).toEqual({ type: "attack", mastery: "sap" });
        expect(message._rsrSuppressedDnd5eRoll).toBeUndefined();
    });

    it("merges child attack rolls into their originating usage card and deletes the child message", async () => {
        const parentRoll = makeRoll(env.classes.D20Roll, { formula: "1d20+3", total: 14, faces: 20, results: [11] });
        const childRoll = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 19, faces: 20, results: [14] });
        const parent = new env.classes.TestChatMessage({
            id: "parent",
            type: "usage",
            isAuthor: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    rolls: [parentRoll]
                }
            }
        });
        const child = new env.classes.TestChatMessage({
            id: "child",
            type: "roll",
            isAuthor: true,
            rolls: [childRoll],
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true
                },
                dnd5e: { roll: { type: "attack" } }
            },
            getOriginatingMessage: () => parent
        });
        const html = $(`<article><div class="message-content"><div class="dice-roll"></div></div></article>`);

        await ChatUtility.processChatMessage(child, html);

        expect(child.deleted).toBe(true);
        expect(parent.flags[MODULE_SHORT]).toMatchObject({
            quickRoll: true,
            renderAttack: true
        });
        expect(parent.flags[MODULE_SHORT].rolls.map((roll) => roll.class)).toEqual(["D20Roll"]);
        expect(parent.flags[MODULE_SHORT].rolls[0].total).toBe(19);
        expect(parent.updatedWith).toMatchObject({ flavor: "vanilla" });
        expect(child.flags[MODULE_SHORT].processed).toBe(false);
    });

    it("replaces a merged child attack roll without dropping existing damage rolls", async () => {
        const parentAttack = makeRoll(env.classes.D20Roll, { formula: "1d20+3", total: 14, faces: 20, results: [11] });
        const parentDamage = makeRoll(env.classes.DamageRoll, { formula: "1d8+3", total: 8, faces: 8, results: [5] });
        const childAttack = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 19, faces: 20, results: [14] });
        const parent = new env.classes.TestChatMessage({
            id: "parent-with-damage",
            type: "usage",
            isAuthor: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    rolls: [parentAttack, parentDamage]
                }
            }
        });
        const child = new env.classes.TestChatMessage({
            id: "replacement-child",
            type: "roll",
            isAuthor: true,
            rolls: [childAttack],
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true
                },
                dnd5e: { roll: { type: "attack" } }
            },
            getOriginatingMessage: () => parent
        });
        const html = $(`<article><div class="message-content"><div class="dice-roll"></div></div></article>`);

        await ChatUtility.processChatMessage(child, html);

        expect(parent.flags[MODULE_SHORT].rolls.map((roll) => roll.class)).toEqual(["D20Roll", "DamageRoll"]);
        expect(parent.flags[MODULE_SHORT].rolls.map((roll) => roll.total)).toEqual([19, 8]);
    });

    it("keeps existing parent rolls when a merged child carries no usable rolls", async () => {
        // Regression guard: replace-by-type must never evict same-type rolls without a
        // replacement — a child whose rolls fail to deserialize (getMessageRolls returns
        // an empty array) must leave the parent's roll data untouched.
        const parentAttack = makeRoll(env.classes.D20Roll, { formula: "1d20+3", total: 14, faces: 20, results: [11] });
        const parent = new env.classes.TestChatMessage({
            id: "parent-kept-intact",
            type: "usage",
            isAuthor: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    rolls: [parentAttack]
                }
            }
        });
        const child = new env.classes.TestChatMessage({
            id: "rollless-child",
            type: "roll",
            isAuthor: true,
            rolls: [],
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true
                },
                dnd5e: { roll: { type: "attack" } }
            },
            getOriginatingMessage: () => parent
        });
        const html = $(`<article><div class="message-content"><div class="dice-roll"></div></div></article>`);

        await ChatUtility.processChatMessage(child, html);

        expect(parent.flags[MODULE_SHORT].rolls.map((roll) => roll.class)).toEqual(["D20Roll"]);
        expect(parent.flags[MODULE_SHORT].rolls[0].total).toBe(14);
    });

    it("hides NPC skill roll totals when hideNpcRollMode is all", async () => {
        env.settings.hideNpcRollMode = "all";

        const skillRoll = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 18, faces: 20, results: [13] });
        const renderSpy = vi.spyOn(RenderUtility, "render").mockImplementation(async (template, data) => {
            if (template === TEMPLATE.MULTIROLL) {
                return `<span class="rsr-multiroll" data-key="${data.key}"></span>`;
            }
            return "";
        });

        const message = new env.classes.TestChatMessage({
            type: "roll",
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    displayChallenge: true
                },
                dnd5e: { roll: { type: "skill", target: 15, forceSuccess: true } }
            },
            rolls: [skillRoll],
            getAssociatedActor: () => ({ isOwner: false })
        });
        const html = $(`
            <article><div class="message-content">
                <div class="dice-roll">
                    <div class="dice-total">18</div>
                    <div class="dice-tooltip">
                        <div class="dice-formula">1d20 + 5</div>
                        <div class="tooltip-part constant">+5</div>
                    </div>
                </div>
            </div></article>
        `);

        await ChatUtility.processChatMessage(message, html);

        const multiRollCall = renderSpy.mock.calls.find(([template]) => template === TEMPLATE.MULTIROLL);
        expect(multiRollCall?.[1]?.roll?.options?.hideFinalResult).toBe(true);
        // Hiding must suppress every outcome signal, not just the total: the DC
        // pass/fail icon (displayChallenge) and forced-success crit styling would
        // both reveal the result of a masked roll.
        expect(multiRollCall?.[1]?.roll?.options?.displayChallenge).toBe(false);
        expect(multiRollCall?.[1]?.roll?.options?.forceSuccess).toBe(false);
        expect(html.find(".tooltip-part.constant")).toHaveLength(0);
        expect(html.find(".dice-formula").text()).not.toBe("1d20 + 5");
    });

    it("stamps hideRollStyle onto a hidden roll from the hideNpcRollStyle setting", async () => {
        env.settings.hideNpcRollMode = "all";
        env.settings.hideNpcRollStyle = HIDE_NPC_ROLL_STYLES.BREAKDOWN;

        const skillRoll = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 18, faces: 20, results: [13] });
        const renderSpy = vi.spyOn(RenderUtility, "render").mockImplementation(async (template, data) => {
            if (template === TEMPLATE.MULTIROLL) {
                return `<span class="rsr-multiroll" data-key="${data.key}"></span>`;
            }
            return "";
        });

        const message = new env.classes.TestChatMessage({
            type: "roll",
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: { quickRoll: true, processed: true, displayChallenge: true },
                dnd5e: { roll: { type: "skill", target: 15 } }
            },
            rolls: [skillRoll],
            getAssociatedActor: () => ({ isOwner: false })
        });
        const html = $(`
            <article><div class="message-content">
                <div class="dice-roll">
                    <div class="dice-total">18</div>
                    <div class="dice-tooltip">
                        <div class="dice-formula">1d20 + 5</div>
                        <div class="tooltip-part constant">+5</div>
                    </div>
                </div>
            </div></article>
        `);

        await ChatUtility.processChatMessage(message, html);

        const multiRollCall = renderSpy.mock.calls.find(([template]) => template === TEMPLATE.MULTIROLL);
        expect(multiRollCall?.[1]?.roll?.options?.hideFinalResult).toBe(true);
        expect(multiRollCall?.[1]?.roll?.options?.hideRollStyle).toBe(HIDE_NPC_ROLL_STYLES.BREAKDOWN);
    });

    it("strips bonus dice (Bless/Guidance) from a hidden NPC d20 tooltip, keeping only the natural d20", async () => {
        env.settings.hideNpcRollMode = "all";

        const skillRoll = makeRoll(env.classes.D20Roll, { formula: "1d20+5+1d4", total: 21, faces: 20, results: [13] });
        const renderSpy = vi.spyOn(RenderUtility, "render").mockImplementation(async (template, data) => {
            if (template === TEMPLATE.MULTIROLL) {
                return `<span class="rsr-multiroll" data-key="${data.key}"></span>`;
            }
            return "";
        });

        const message = new env.classes.TestChatMessage({
            type: "roll",
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: { quickRoll: true, processed: true, displayChallenge: true },
                dnd5e: { roll: { type: "skill", target: 15 } }
            },
            rolls: [skillRoll],
            getAssociatedActor: () => ({ isOwner: false })
        });
        // A Blessed NPC save: a d20 part, a Bless 1d4 bonus-die part, and a flat +5.
        const html = $(`
            <article><div class="message-content">
                <div class="dice-roll">
                    <div class="dice-total">21</div>
                    <div class="dice-tooltip">
                        <div class="dice-formula">1d20 + 5 + 1d4</div>
                        <section class="tooltip-part"><div class="dice"><ol class="dice-rolls"><li class="roll die d20">13</li></ol></div></section>
                        <section class="tooltip-part"><div class="dice"><ol class="dice-rolls"><li class="roll die d4">3</li></ol></div></section>
                        <div class="tooltip-part constant">+5</div>
                    </div>
                </div>
            </div></article>
        `);

        await ChatUtility.processChatMessage(message, html);

        // Only the natural d20 part survives; the Bless die and the flat modifier are gone.
        expect(html.find(".tooltip-part").length).toBe(1);
        expect(html.find(".tooltip-part .roll.d20").length).toBe(1);
        expect(html.find(".tooltip-part .roll.d4").length).toBe(0);
        expect(html.find(".tooltip-part.constant").length).toBe(0);
        expect(html.find(".dice-formula").text()).not.toContain("1d4");
    });

    it("breakdown style strips ALL tooltip parts including the natural d20", async () => {
        env.settings.hideNpcRollMode = "all";
        env.settings.hideNpcRollStyle = HIDE_NPC_ROLL_STYLES.BREAKDOWN;

        const skillRoll = makeRoll(env.classes.D20Roll, { formula: "1d20+5+1d4", total: 21, faces: 20, results: [13] });
        const renderSpy = vi.spyOn(RenderUtility, "render").mockImplementation(async (template, data) => {
            if (template === TEMPLATE.MULTIROLL) {
                return `<span class="rsr-multiroll" data-key="${data.key}"></span>`;
            }
            return "";
        });

        const message = new env.classes.TestChatMessage({
            type: "roll",
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: { quickRoll: true, processed: true, displayChallenge: true },
                dnd5e: { roll: { type: "skill", target: 15 } }
            },
            rolls: [skillRoll],
            getAssociatedActor: () => ({ isOwner: false })
        });
        const html = $(`
            <article><div class="message-content">
                <div class="dice-roll">
                    <div class="dice-total">21</div>
                    <div class="dice-tooltip">
                        <div class="dice-formula">1d20 + 5 + 1d4</div>
                        <section class="tooltip-part"><div class="dice"><ol class="dice-rolls"><li class="roll die d20">13</li></ol></div></section>
                        <section class="tooltip-part"><div class="dice"><ol class="dice-rolls"><li class="roll die d4">3</li></ol></div></section>
                        <div class="tooltip-part constant">+5</div>
                    </div>
                </div>
            </div></article>
        `);

        await ChatUtility.processChatMessage(message, html);

        // Breakdown style: NOTHING in the tooltip survives — no d20, no bonus die, no flat mod.
        expect(html.find(".tooltip-part").length).toBe(0);
        expect(html.find(".dice-formula").text()).not.toBe("1d20 + 5 + 1d4");
    });

    it("shows full NPC skill totals to actor owners even when hideNpcRollMode is all", async () => {
        env.settings.hideNpcRollMode = "all";

        const skillRoll = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 18, faces: 20, results: [13] });
        const renderSpy = vi.spyOn(RenderUtility, "render").mockImplementation(async (template, data) => {
            if (template === TEMPLATE.MULTIROLL) {
                return `<span class="rsr-multiroll" data-key="${data.key}"></span>`;
            }
            return "";
        });

        const message = new env.classes.TestChatMessage({
            type: "roll",
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    displayChallenge: true
                },
                dnd5e: { roll: { type: "skill" } }
            },
            rolls: [skillRoll],
            getAssociatedActor: () => ({ isOwner: true })
        });
        const html = $(`
            <article><div class="message-content">
                <div class="dice-roll">
                    <div class="dice-total">18</div>
                    <div class="dice-tooltip">
                        <div class="dice-formula">1d20 + 5</div>
                        <div class="tooltip-part constant">+5</div>
                    </div>
                </div>
            </div></article>
        `);

        await ChatUtility.processChatMessage(message, html);

        const multiRollCall = renderSpy.mock.calls.find(([template]) => template === TEMPLATE.MULTIROLL);
        expect(multiRollCall?.[1]?.roll?.options?.hideFinalResult).toBe(false);
        expect(html.find(".tooltip-part.constant")).toHaveLength(1);
    });

    it("does not hide NPC skill rolls when hideNpcRollMode is attacks only", async () => {
        env.settings.hideNpcRollMode = "attacks";

        const skillRoll = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 18, faces: 20, results: [13] });
        const renderSpy = vi.spyOn(RenderUtility, "render").mockImplementation(async (template, data) => {
            if (template === TEMPLATE.MULTIROLL) {
                return `<span class="rsr-multiroll" data-key="${data.key}"></span>`;
            }
            return "";
        });

        const message = new env.classes.TestChatMessage({
            type: "roll",
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true
                },
                dnd5e: { roll: { type: "skill" } }
            },
            rolls: [skillRoll],
            getAssociatedActor: () => ({ isOwner: false })
        });
        const html = $(`<article><div class="message-content"><div class="dice-roll"><div class="dice-total">18</div><div class="dice-tooltip"><div class="dice-formula">1d20 + 5</div></div></div></div></article>`);

        await ChatUtility.processChatMessage(message, html);

        const multiRollCall = renderSpy.mock.calls.find(([template]) => template === TEMPLATE.MULTIROLL);
        expect(multiRollCall?.[1]?.roll?.options?.hideFinalResult).toBe(false);
    });

    it("keeps NPC damage totals visible when hideNpcRollMode is all", async () => {
        env.settings.hideNpcRollMode = "all";

        const attack = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 23, faces: 20, results: [18] });
        const damage = makeRoll(env.classes.DamageRoll, { formula: "1d8+3", total: 9, faces: 8, results: [6] });
        const message = new env.classes.TestChatMessage({
            type: "usage",
            isAuthor: true,
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    renderAttack: true,
                    renderDamage: true,
                    rolls: [attack, damage]
                },
                dnd5e: { activity: { type: "attack" } }
            },
            getAssociatedActor: () => ({ isOwner: false, items: { get: vi.fn() } })
        });
        const html = $(`
            <article class="chat-message">
                <div class="message-content">
                    <div class="dnd5e2 chat-card usage-card">
                        <div class="card-buttons"><button data-action="rollAttack"></button></div>
                    </div>
                </div>
            </article>
        `);

        await ChatUtility.processUsageChatMessage(message, html[0]);

        expect(html.find(".rsr-section-damage")).toHaveLength(1);
        expect(html.find(".rsr-damage")).toHaveLength(1);
    });

    it("breakdown style reveals total and drops the d20 icon in multiroll entries", async () => {
        // Harness adaptation: foundry.applications.handlebars.renderTemplate is already
        // a vi.fn() — spy on it directly and capture the raw data argument (no JSON.parse).
        // Also: makeRoll sets roll.terms = [die] only, giving _renderMultiRoll a base total
        // of 13 (d20 result). To reach the asserted total of 18 (13 + 5), we append a
        // pre-evaluated bonus term so bonusRoll.total = 5 and the loop computes 13 + 5 = 18.
        const tmplSpy = vi
            .spyOn(foundry.applications.handlebars, "renderTemplate")
            .mockImplementation(async (_path, data) => JSON.stringify(data));

        env.settings.enableD20Icons = true; // would normally produce a d20Result

        const roll = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 18, faces: 20, results: [13] });
        // Append a pre-evaluated +5 bonus term so _renderMultiRoll totals 13 + 5 = 18.
        roll.terms = [roll.dice[0], { total: 5, _evaluated: true, results: [] }];
        roll.options.hideFinalResult = true;
        roll.options.hideRollStyle = HIDE_NPC_ROLL_STYLES.BREAKDOWN;

        await RenderUtility.render(TEMPLATE.MULTIROLL, { roll, key: "skill" });

        const call = tmplSpy.mock.calls.find(([p]) => String(p).includes("rsr-multiroll"));
        const data = call[1]; // direct access — no JSON.parse needed, call[1] is the raw data object
        expect(data.entries[0].hideTotal).toBe(false);
        expect(data.entries[0].d20Result).toBeNull();
        expect(data.entries[0].total).toBe(18);

        tmplSpy.mockRestore();
    });

    it("total style (default) keeps the total masked and shows the d20 icon", async () => {
        const tmplSpy = vi
            .spyOn(foundry.applications.handlebars, "renderTemplate")
            .mockImplementation(async (_path, data) => JSON.stringify(data));

        env.settings.enableD20Icons = true;

        const roll = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 18, faces: 20, results: [13] });
        roll.terms = [roll.dice[0], { total: 5, _evaluated: true, results: [] }];
        roll.options.hideFinalResult = true;
        roll.options.hideRollStyle = HIDE_NPC_ROLL_STYLES.TOTAL;

        await RenderUtility.render(TEMPLATE.MULTIROLL, { roll, key: "skill" });

        const call = tmplSpy.mock.calls.find(([p]) => String(p).includes("rsr-multiroll"));
        const data = call[1];
        expect(data.entries[0].hideTotal).toBe(true);
        expect(data.entries[0].d20Result).toBe(13);

        tmplSpy.mockRestore();
    });
});
