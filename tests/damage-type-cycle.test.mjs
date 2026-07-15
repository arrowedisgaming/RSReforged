import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRoll, setupFoundryEnv } from "./helpers/foundry-env.mjs";

/**
 * Issue #27 — changing the damage type on a chat card for activities that offer
 * more than one type on a damage part (Pact of the Blade, Empowered Strikes, ...).
 */
describe("damage type cycling (issue #27)", () => {
    let env;
    let ChatUtility;
    let ActivityUtility;
    let MODULE_SHORT;

    /** Register the types these tests cycle between; the shared env only ships `slashing`. */
    function registerDamageTypes() {
        Object.assign(CONFIG.DND5E.damageTypes, {
            fire: { label: "Fire", labelShort: "Fire", icon: "systems/dnd5e/icons/svg/damage/fire.svg" },
            cold: { label: "Cold", labelShort: "Cold", icon: "systems/dnd5e/icons/svg/damage/cold.svg" },
            force: { label: "Force", labelShort: "Force", icon: "systems/dnd5e/icons/svg/damage/force.svg" }
        });
        CONFIG[MODULE_SHORT] = {
            combinedDamageTypes: {
                ...Object.fromEntries(Object.entries(CONFIG.DND5E.damageTypes).map(([k, v]) => [k, v.label])),
                ...Object.fromEntries(Object.entries(CONFIG.DND5E.healingTypes).map(([k, v]) => [k, v.label]))
            }
        };
    }

    function makeDamageRoll({ type, types, total = 7 }) {
        return makeRoll(env.classes.DamageRoll, {
            formula: "2d6",
            total,
            faces: 6,
            results: [3, 4],
            type,
            rollOptions: types ? { types } : {}
        });
    }

    /**
     * Build and render a processed usage card carrying `rolls`.
     * `expandTooltip` mimics the marker the cycle handler leaves before its update
     * re-renders the card.
     */
    async function renderCard(rolls, { isAuthor = true, expandTooltip = false } = {}) {
        const message = new env.classes.TestChatMessage({
            type: "usage",
            isAuthor,
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    renderDamage: true,
                    rolls
                },
                dnd5e: { activity: { type: "attack" } }
            }
        });
        const html = $(`
            <article class="chat-message">
                <div class="message-content">
                    <div class="dnd5e2 chat-card usage-card">
                        <div class="card-buttons"><button data-action="rollDamage"></button></div>
                    </div>
                </div>
            </article>
        `);

        if (expandTooltip) message._rsrExpandDamageTooltip = true;

        await ChatUtility.processUsageChatMessage(message, html[0]);
        return { message, html };
    }

    beforeEach(async () => {
        vi.resetModules();
        env = await setupFoundryEnv();
        ({ MODULE_SHORT } = await import("../src/module/const.js"));
        ({ ChatUtility } = await import("../src/utils/chat.js"));
        ({ ActivityUtility } = await import("../src/utils/activity.js"));
        registerDamageTypes();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("marks a multi-type damage part as cyclable and leaves a fixed-type part inert", async () => {
        const { html } = await renderCard([
            makeDamageRoll({ type: "fire", types: ["fire", "cold"] })
        ]);

        expect(html.find(".rsr-damage-type-toggle")).toHaveLength(1);
        expect(html.find(".rsr-damage-type-toggle").attr("data-rsr-damage-type")).toBe("fire");
        expect(html.find(".rsr-damage-type-toggle .total .label").attr("title"))
            .toBe(`${MODULE_SHORT}.chat.buttons.damageType`);
    });

    it("does not mark a part whose damage part offers only one type", async () => {
        const { html } = await renderCard([
            makeDamageRoll({ type: "fire", types: ["fire"] })
        ]);

        expect(html.find(".rsr-damage-type-toggle")).toHaveLength(0);
    });

    it("does not mark a part on a roll with no type list at all", async () => {
        const { html } = await renderCard([
            makeDamageRoll({ type: "slashing" })
        ]);

        expect(html.find(".rsr-damage-type-toggle")).toHaveLength(0);
    });

    it("does not tag an untyped part with a neighbouring part's type", async () => {
        // An untyped part renders with no icon and an empty label. Resolving it via the
        // apply-damage fallback would borrow the fire roll's type and make clicking the
        // untyped part cycle the fire one.
        const { html } = await renderCard([
            makeDamageRoll({ type: "fire", types: ["fire", "cold"] }),
            makeDamageRoll({ type: undefined })
        ]);

        expect(html.find(".rsr-damage-type-toggle")).toHaveLength(1);
        expect(html.find(".rsr-damage-type-toggle").attr("data-rsr-damage-type")).toBe("fire");
    });

    it("advances the damage type to the next candidate on click", async () => {
        const { message, html } = await renderCard([
            makeDamageRoll({ type: "fire", types: ["fire", "cold"] })
        ]);

        await html.find(".rsr-damage-type-toggle .total .label").triggerHandler("click");

        expect(message.flags[MODULE_SHORT].rolls[0].options.type).toBe("cold");
        expect(message.flags[MODULE_SHORT].damageTypes).toEqual({ 0: "cold" });
    });

    it("wraps around to the first candidate from the last", async () => {
        const { message, html } = await renderCard([
            makeDamageRoll({ type: "cold", types: ["fire", "cold"] })
        ]);

        await html.find(".rsr-damage-type-toggle .total .label").triggerHandler("click");

        expect(message.flags[MODULE_SHORT].rolls[0].options.type).toBe("fire");
        expect(message.flags[MODULE_SHORT].damageTypes).toEqual({ 0: "fire" });
    });

    it("is clickable via the damage type icon as well as the label", async () => {
        const { message, html } = await renderCard([
            makeDamageRoll({ type: "fire", types: ["fire", "cold"] })
        ]);

        await html.find(".rsr-damage-type-toggle .total img").triggerHandler("click");

        expect(message.flags[MODULE_SHORT].rolls[0].options.type).toBe("cold");
    });

    it("does not change the roll total", async () => {
        const { message, html } = await renderCard([
            makeDamageRoll({ type: "fire", types: ["fire", "cold"], total: 7 })
        ]);

        await html.find(".rsr-damage-type-toggle .total .label").triggerHandler("click");

        expect(message.flags[MODULE_SHORT].rolls[0].total).toBe(7);
    });

    it("persists the whole roll array so other rolls on the card survive the update", async () => {
        const attack = makeRoll(env.classes.D20Roll, { formula: "1d20", total: 15, faces: 20, results: [15] });
        const damage = makeDamageRoll({ type: "fire", types: ["fire", "cold"] });
        const { message, html } = await renderCard([attack, damage]);

        await html.find(".rsr-damage-type-toggle .total .label").triggerHandler("click");

        const rolls = message.flags[MODULE_SHORT].rolls;
        expect(rolls).toHaveLength(2);
        expect(rolls[0].class).toBe("D20Roll");
        expect(rolls[1].options.type).toBe("cold");
        // Keyed by index within the damage rolls, not the full roll array.
        expect(message.flags[MODULE_SHORT].damageTypes).toEqual({ 0: "cold" });
    });

    it("cycles each type independently when a card has several multi-type parts", async () => {
        const { message, html } = await renderCard([
            makeDamageRoll({ type: "fire", types: ["fire", "cold"] }),
            makeDamageRoll({ type: "force", types: ["force", "cold"] })
        ]);

        expect(html.find(".rsr-damage-type-toggle")).toHaveLength(2);
        await html.find('.rsr-damage-type-toggle[data-rsr-damage-type="force"] .total .label').triggerHandler("click");

        expect(message.flags[MODULE_SHORT].rolls[0].options.type).toBe("fire");
        expect(message.flags[MODULE_SHORT].rolls[1].options.type).toBe("cold");
        expect(message.flags[MODULE_SHORT].damageTypes).toEqual({ 1: "cold" });
    });

    it("cycles rolls that share a type together", async () => {
        // Documented behaviour, not an accident: aggregation merges same-typed rolls into
        // one part, so "change this damage type" has to move every roll showing it.
        const { message, html } = await renderCard([
            makeDamageRoll({ type: "fire", types: ["fire", "cold"] }),
            makeDamageRoll({ type: "fire", types: ["fire", "force"] })
        ]);

        await html.find('.rsr-damage-type-toggle[data-rsr-damage-type="fire"] .total .label')
            .first()
            .triggerHandler("click");

        expect(message.flags[MODULE_SHORT].rolls[0].options.type).toBe("cold");
        expect(message.flags[MODULE_SHORT].rolls[1].options.type).toBe("force");
        expect(message.flags[MODULE_SHORT].damageTypes).toEqual({ 0: "cold", 1: "force" });
    });

    it("reopens the dice breakdown for the user who cycled", async () => {
        // The type label is only reachable with the breakdown open, and the re-render
        // resets Foundry's collapse state — so it must be restored, or the card snaps
        // shut on every click.
        const { message, html } = await renderCard([
            makeDamageRoll({ type: "fire", types: ["fire", "cold"] })
        ], { expandTooltip: true });

        expect(html.find(".dice-roll.expanded")).toHaveLength(1);
        // Consumed, so a later unrelated re-render does not force it open again.
        expect(message._rsrExpandDamageTooltip).toBeUndefined();
    });

    it("does not force the breakdown open for a user who did not cycle", async () => {
        const { html } = await renderCard([
            makeDamageRoll({ type: "fire", types: ["fire", "cold"] })
        ]);

        expect(html.find(".dice-roll.expanded")).toHaveLength(0);
    });

    it("leaves the native damage-apply mode alone", async () => {
        // Native mode hands damage rendering to dnd5e wholesale; RSR must not decorate it.
        env.settings.damageApplyMode = "native";
        const { html } = await renderCard([
            makeDamageRoll({ type: "fire", types: ["fire", "cold"] })
        ]);

        expect(html.find(".rsr-damage-type-toggle")).toHaveLength(0);
    });

    it("does not offer the affordance to a user who is neither GM nor author", async () => {
        game.user.isGM = false;
        const { html } = await renderCard([
            makeDamageRoll({ type: "fire", types: ["fire", "cold"] })
        ], { isAuthor: false });

        expect(html.find(".rsr-damage-type-toggle")).toHaveLength(0);
    });

    it("offers the affordance to a GM who is not the author", async () => {
        game.user.isGM = true;
        const { html } = await renderCard([
            makeDamageRoll({ type: "fire", types: ["fire", "cold"] })
        ], { isAuthor: false });

        expect(html.find(".rsr-damage-type-toggle")).toHaveLength(1);
    });

    it("skips a candidate type the system no longer registers", async () => {
        const { message, html } = await renderCard([
            // "eldritch" is not a registered dnd5e type — cycling must not land on it.
            makeDamageRoll({ type: "fire", types: ["fire", "eldritch", "cold"] })
        ]);

        await html.find(".rsr-damage-type-toggle .total .label").triggerHandler("click");

        expect(message.flags[MODULE_SHORT].rolls[0].options.type).toBe("cold");
    });

    it("resolves the part's type with aggregateDamageDisplay off", async () => {
        // Aggregation changes how dnd5e groups tooltip parts; type resolution reads the
        // part's own DOM, so it must hold either way.
        CONFIG.DND5E.aggregateDamageDisplay = false;
        const { message, html } = await renderCard([
            makeDamageRoll({ type: "fire", types: ["fire", "cold"] })
        ]);

        await html.find(".rsr-damage-type-toggle .total .label").triggerHandler("click");

        expect(message.flags[MODULE_SHORT].rolls[0].options.type).toBe("cold");
    });

    it("accepts a damage type registered after the ready hook", async () => {
        // Types are validated against the live registries, not the combinedDamageTypes
        // snapshot built at ready — a module can register a custom type later.
        CONFIG[MODULE_SHORT] = { combinedDamageTypes: { fire: "Fire" } };
        CONFIG.DND5E.damageTypes.psychic = {
            label: "Psychic", labelShort: "Psychic", icon: "systems/dnd5e/icons/svg/damage/psychic.svg"
        };
        const { message, html } = await renderCard([
            makeDamageRoll({ type: "fire", types: ["fire", "psychic"] })
        ]);

        await html.find(".rsr-damage-type-toggle .total .label").triggerHandler("click");

        expect(message.flags[MODULE_SHORT].rolls[0].options.type).toBe("psychic");
    });

    it("does not treat an inherited Object key as a damage type", async () => {
        // `type in map` would accept "constructor"; hasOwn must not.
        const { html } = await renderCard([
            makeDamageRoll({ type: "fire", types: ["fire", "constructor"] })
        ]);

        // "constructor" is not a real type, so fire is the only candidate left.
        expect(html.find(".rsr-damage-type-toggle")).toHaveLength(0);
    });

    describe("remembering the choice as the activity default", () => {
        /**
         * dnd5e's Activity#rollDamage writes last.<activityId>.damageType after every
         * damage build, and _processDamagePart reads it back. A quick roll therefore
         * records the auto-picked type — but the card click that changes it never goes
         * through rollDamage, so RSR must write the flag itself or features like
         * Empowered Strikes reset to the auto-pick on every roll.
         */
        function stubActivity({ isOwner = true, inCompendium = false, onActor = true } = {}) {
            const setFlag = vi.fn(async () => {});
            const item = { id: "item-1", isOwner, inCompendium, setFlag };
            const actor = { items: new Map(onActor ? [["item-1", item]] : []) };
            const activity = { id: "act-1", item, actor };
            vi.spyOn(ActivityUtility, "_getActivityFromMessage").mockReturnValue(activity);
            return { setFlag, item };
        }

        it("writes the picked type as dnd5e's remembered default", async () => {
            const { setFlag } = stubActivity();
            const { html } = await renderCard([
                makeDamageRoll({ type: "fire", types: ["fire", "cold"] })
            ]);

            await html.find(".rsr-damage-type-toggle .total .label").triggerHandler("click");

            expect(setFlag).toHaveBeenCalledWith("dnd5e", "last.act-1.damageType", { 0: "cold" });
        });

        it("writes every damage roll's type, matching dnd5e's own shape", async () => {
            const { setFlag } = stubActivity();
            const { html } = await renderCard([
                makeDamageRoll({ type: "bludgeoning", types: ["bludgeoning"] }),
                makeDamageRoll({ type: "fire", types: ["fire", "cold"] })
            ]);

            await html.find('.rsr-damage-type-toggle[data-rsr-damage-type="fire"] .total .label')
                .triggerHandler("click");

            expect(setFlag).toHaveBeenCalledWith("dnd5e", "last.act-1.damageType", {
                0: "bludgeoning",
                1: "cold"
            });
        });

        it.each([
            ["an item the user does not own", { isOwner: false }],
            ["a compendium item", { inCompendium: true }],
            ["an item no longer on the actor", { onActor: false }]
        ])("does not write the default for %s", async (_label, opts) => {
            const { setFlag } = stubActivity(opts);
            const { message, html } = await renderCard([
                makeDamageRoll({ type: "fire", types: ["fire", "cold"] })
            ]);

            await html.find(".rsr-damage-type-toggle .total .label").triggerHandler("click");

            expect(setFlag).not.toHaveBeenCalled();
            // The card still keeps the choice — only the shared default is skipped.
            expect(message.flags[MODULE_SHORT].damageTypes).toEqual({ 0: "cold" });
        });
    });

    describe("surviving re-derived damage (retroactive crit / manual damage)", () => {
        /**
         * rollDamage() re-runs dnd5e's _processDamagePart, which re-picks the default
         * type — so getDamageFromMessage must re-apply the saved choice or it silently
         * reverts.
         */
        function messageWithOverrides(damageTypes, rolledTypes) {
            const rolls = rolledTypes.map(({ type, types }) => makeDamageRoll({ type, types }));
            const activity = {
                item: { flags: {} },
                getDamageConfig: () => ({ rolls: [{}] }),
                rollDamage: vi.fn(async () => rolls)
            };
            const actor = { items: new Map() };
            const message = new env.classes.TestChatMessage({
                type: "usage",
                isAuthor: true,
                flags: {
                    [MODULE_SHORT]: { quickRoll: true, processed: true, damageTypes },
                    dnd5e: { activity: { type: "attack" } }
                },
                getAssociatedActivity: () => activity,
                getAssociatedActor: () => actor
            });
            return message;
        }

        it("re-applies a chosen type to a freshly derived damage roll", async () => {
            const message = messageWithOverrides({ 0: "cold" }, [{ type: "fire", types: ["fire", "cold"] }]);

            const rolls = await ActivityUtility.getDamageFromMessage(message);

            expect(rolls[0].options.type).toBe("cold");
        });

        it("ignores an override the roll no longer offers", async () => {
            // The activity was edited between rolls and no longer has "cold".
            const message = messageWithOverrides({ 0: "cold" }, [{ type: "fire", types: ["fire", "force"] }]);

            const rolls = await ActivityUtility.getDamageFromMessage(message);

            expect(rolls[0].options.type).toBe("fire");
        });

        it("leaves rolls untouched when no choice was ever made", async () => {
            const message = messageWithOverrides(undefined, [{ type: "fire", types: ["fire", "cold"] }]);

            const rolls = await ActivityUtility.getDamageFromMessage(message);

            expect(rolls[0].options.type).toBe("fire");
        });

        it("applies overrides only to the indexed roll", async () => {
            const message = messageWithOverrides({ 1: "cold" }, [
                { type: "fire", types: ["fire", "cold"] },
                { type: "force", types: ["force", "cold"] }
            ]);

            const rolls = await ActivityUtility.getDamageFromMessage(message);

            expect(rolls[0].options.type).toBe("fire");
            expect(rolls[1].options.type).toBe("cold");
        });
    });
});
