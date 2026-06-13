import { MODULE_SHORT } from "../module/const.js";
import { MODULE_MIDI } from "../module/integration.js";
import { ChatUtility } from "./chat.js";
import { CoreUtility } from "./core.js";
import { ROLL_TYPE, RollUtility } from "./roll.js";
import { SETTING_NAMES, SettingsUtility } from "./settings.js";

export class ActivityUtility {

    /**
     * Resolve the activity associated with a chat message.
     *
     * dnd5e 5.3.0: `getAssociatedActivity()` is now a native ChatMessage5e method
     * (line 69694 of dnd5e.mjs). It tries `fromUuidSync(flags.dnd5e.activity.uuid)`
     * first, then falls back to `getAssociatedItem()?.system.activities?.get(flags.dnd5e.activity.id)`.
     * We call it directly and only fall through to manual UUID/id resolution when the
     * message object is a plain data object (e.g. during preCreateChatMessage before the
     * document is instantiated) where the method may not exist.
     *
     * NOTE: `message.system.activity` is intentionally NOT used as a primary path.
     * In 5.3.0 it is a getter on UsageMessageData that itself calls
     * `this.parent.getAssociatedActivity()` — identical to calling the method directly,
     * but with the added risk of throwing when `message.system` is undefined (non-usage
     * messages) or when the system data model is not yet initialised (preCreate hooks).
     */
    static _getActivityFromMessage(message) {
        // Primary: native ChatMessage5e method available on instantiated documents.
        if (typeof message.getAssociatedActivity === "function") {
            const act = message.getAssociatedActivity();
            if (act) return act;
        }

        // Fallback A: resolve via item UUID + activity id (covers preCreate where the
        // document method above may not yet exist, or may return null because flags
        // haven't been saved to the database yet and fromUuidSync can't find the UUID).
        let item = null;
        if (typeof message.getAssociatedItem === "function") item = message.getAssociatedItem();
        if (!item && message.flags?.dnd5e?.item?.uuid) item = fromUuidSync(message.flags.dnd5e.item.uuid, { strict: false });
        if (!item && message.flags?.dnd5e?.use?.itemUuid) item = fromUuidSync(message.flags.dnd5e.use.itemUuid, { strict: false });

        const activityId = message.flags?.dnd5e?.activity?.id;
        if (item && activityId) {
            const act = item.system?.activities?.get(activityId);
            if (act) return act;
        }

        // Fallback B: resolve directly via activity UUID stored in flags.
        // dnd5e 5.3.0: the activity UUID is stored at flags.dnd5e.activity.uuid
        // (set by Activity#messageFlags getter, line 16711 of dnd5e.mjs).
        const activityUuid = message.flags?.dnd5e?.activity?.uuid;
        if (activityUuid) {
            const act = fromUuidSync(activityUuid, { strict: false });
            if (act) return act;
        }

        return null;
    }

    /**
     * Resolve the actor associated with a chat message.
     *
     * dnd5e 5.3.0: delegates to ChatUtility.getActorFromMessage which already uses the
     * native getAssociatedActor() method with a proper null-safe manual fallback.
     */
    static _getActorFromMessage(message) {
        return ChatUtility.getActorFromMessage(message);
    }

    /**
     * Extract Roll instances from the raw return value of rollAttack / rollDamage /
     * rollFormula. In dnd5e 5.3.0 all three methods return Roll[] directly when
     * messageConfig.create is false, so the array branch is hit in the normal case.
     * The other branches are kept for defensive compatibility.
     */
    static _extractRolls(result) {
        let extracted = [];
        if (!result) return extracted;
        const items = Array.isArray(result) ? result : [result];
        for (const item of items) {
            if (!item) continue;
            if (item instanceof Roll) {
                extracted.push(item);
            } else if (item.rolls && Array.isArray(item.rolls)) {
                extracted.push(...item.rolls);
            } else if (item.roll && item.roll instanceof Roll) {
                extracted.push(item.roll);
            } else if (item.class && item.formula) {
                try { extracted.push(Roll.fromData(item)); } catch(e) {}
            }
        }
        return extracted;
    }

    /**
     * Derive RSR render flags (renderAttack / renderDamage / renderFormula / isHealing /
     * formulaName) from an activity's capabilities and write them onto the given RSR
     * flags object. Mutates `flags` in place; a no-op unless `flags.quickRoll` is set.
     *
     * Single source of truth for creation-time render-flag derivation: called from the
     * preCreateChatMessage hook (hooks.js) after the base quickRoll/processed flags are
     * seeded. Deliberately NOT called during chat re-render — legacy usage messages that
     * were never stamped at creation must stay passive rather than be pulled into the
     * quick-roll pipeline retroactively (see issue #15). The one exception is the
     * guarded retry at the top of runActivityActions, which only fires for messages
     * RSR itself claimed at creation (quickRoll set, not yet processed) whose activity
     * could not be resolved during preCreate.
     *
     * @param {object} activity The dnd5e activity resolved for the message.
     * @param {object} flags    The message's `flags[MODULE_SHORT]` object to mutate.
     */
    static setRenderFlags(activity, flags) {
        if (!activity || !flags || !flags.quickRoll) return;

        const hasAttack  = activity.type === "attack"  || !!activity.attack   || activity.hasOwnProperty(ROLL_TYPE.ATTACK);
        const hasDamage  = activity.type === "damage"  || !!activity.damage   || activity.type === "attack" || activity.type === "save" || activity.hasOwnProperty(ROLL_TYPE.DAMAGE);
        const hasHealing = activity.type === "heal"    || !!activity.healing  || activity.hasOwnProperty(ROLL_TYPE.HEALING);
        const hasFormula = activity.type === "utility" || !!activity.roll     || activity.hasOwnProperty(ROLL_TYPE.FORMULA);

        if (hasAttack) {
            flags.renderAttack = true;
        }

        const manualDamageMode = SettingsUtility.getSettingValue(SETTING_NAMES.MANUAL_DAMAGE_MODE);

        if (hasDamage) {
            flags.manualDamage = (manualDamageMode === 2 || (manualDamageMode === 1 && hasAttack));
            flags.renderDamage = !flags.manualDamage;
        }

        if (hasHealing) {
            flags.isHealing = true;
            flags.renderDamage = true;
        }

        if (hasFormula) {
            flags.renderFormula = true;
            const fName = activity.roll?.name || activity[ROLL_TYPE.FORMULA]?.name;
            if (fName && fName !== "") {
                flags.formulaName = fName;
            }
        }
    }

    /**
     * Execute all pending roll actions for a usage message (attack, damage, formula)
     * and persist the resulting rolls back to the message flags.
     */
    static async runActivityActions(message) {
        const flags = message.flags[MODULE_SHORT] ?? (message.flags[MODULE_SHORT] = {});

        // Render-time retry for preCreate resolution failures. preCreate sees the
        // message before it is persisted, so the UUID fallbacks in
        // _getActivityFromMessage can miss and the message arrives here claimed
        // (quickRoll set by processActivity, which already suppressed dnd5e's
        // subsequentActions) but without render flags — and would otherwise be
        // marked processed with zero rolls. By now the message is a full document
        // with getAssociatedActivity available, so resolution that failed at
        // preCreate normally succeeds. Legacy messages (issue #15) cannot reach
        // this: runActivityActions only runs when quickRoll is set and the message
        // is unprocessed. If the activity has no rollable parts, setRenderFlags is
        // an idempotent no-op and the message stays passive as before.
        if (!flags.renderAttack && !flags.renderDamage && !flags.renderFormula && !flags.manualDamage) {
            const activity = ActivityUtility._getActivityFromMessage(message);
            if (activity) {
                ActivityUtility.setRenderFlags(activity, flags);
            }
        }

        let currentRolls = Array.from(flags.rolls || []);
        const newRolls = [];

        if (message.flags[MODULE_SHORT].renderAttack) {
            const rawAttack = await ActivityUtility.getAttackFromMessage(message);
            const attackRolls = ActivityUtility._extractRolls(rawAttack);

            if (attackRolls.length > 0) {
                currentRolls = RollUtility.mergeRollsByType(currentRolls, attackRolls, CONFIG.Dice.D20Roll);
                newRolls.push(...attackRolls);
                // dual flag means a multi-roll was enforced by ALWAYS_ROLL_MULTIROLL;
                // in that case isCritical is determined later during rendering.
                message.flags[MODULE_SHORT].isCritical = message.flags[MODULE_SHORT].dual
                    ? false
                    : attackRolls[0].isCritical;
            } else {
                message.flags[MODULE_SHORT].isCritical = false;
            }

            // Register this card as its own "attack" roll message so condition
            // modules (AC5e) and dnd5e's native attack->damage association can find
            // the attack roll via dnd5e.registry.messages.get(<cardId>, "attack").
            // RSR rolls with create:false and emits no discrete attack message, so
            // the registry would otherwise have no attack entry for this card. Must
            // run BEFORE the damage roll below so the lookup resolves during the
            // damage roll's hooks on the quick-roll (attack+damage) path.
            ActivityUtility._registerCardAsAttack(message, currentRolls);
        }

        if (message.flags[MODULE_SHORT].renderDamage) {
            const rawDamage = await ActivityUtility.getDamageFromMessage(message);
            const damageRolls = ActivityUtility._extractRolls(rawDamage);

            if (damageRolls.length > 0) {
                currentRolls = RollUtility.mergeRollsByType(currentRolls, damageRolls, CONFIG.Dice.DamageRoll);
                newRolls.push(...damageRolls);
            }
        }

        if (message.flags[MODULE_SHORT].renderFormula) {
            const rawFormula = await ActivityUtility.getFormulaFromMessage(message);
            const formulaRolls = ActivityUtility._extractRolls(rawFormula);

            if (formulaRolls.length > 0) {
                currentRolls = RollUtility.mergeRollsByType(currentRolls, formulaRolls, CONFIG.Dice.BasicRoll);
                newRolls.push(...formulaRolls);
            }
        }

        await _animateNewRolls(newRolls, message);

        message.flags[MODULE_SHORT].processed = true;
        const serializedRolls = CoreUtility.serializeRolls(currentRolls);
        message.flags[MODULE_SHORT].rolls = serializedRolls;

        const attackRoll = currentRolls.find(r => r instanceof CONFIG.Dice.D20Roll || r.class === "D20Roll" || r.constructor?.name === "D20Roll");
        if (attackRoll) {
            message.flags.dnd5e ??= {};
            message.flags.dnd5e.roll = {
                ...(message.flags.dnd5e.roll ?? {}),
                type: ROLL_TYPE.ATTACK,
                ...(attackRoll.options?.mastery ? { mastery: attackRoll.options.mastery } : {})
            };
            // Persist the self-link so dnd5e's ChatMessage5e#prepareData ->
            // MessageRegistry.track re-registers this card under the "attack" hook on
            // every load. Pairs with the chat.js _injectContent guard that stops a
            // self-referencing card from being treated as its own merge parent.
            message.flags.dnd5e.originatingMessage = message.id;
        }

        await ChatUtility.updateChatMessage(message, {
            flags: message.flags,
            rolls: serializedRolls
        });
    }

    /**
     * Execute a single on-demand roll action (currently only ROLL_TYPE.DAMAGE, triggered
     * by the manual damage button) and persist the result.
     */
    static async runActivityAction(message, action) {
        let currentRolls = Array.from(message.flags[MODULE_SHORT]?.rolls || []);
        const newRolls = [];

        switch (action) {
            case ROLL_TYPE.DAMAGE: {
                const rawDamage = await ActivityUtility.getDamageFromMessage(message);
                const damageRolls = ActivityUtility._extractRolls(rawDamage);

                if (damageRolls.length > 0) {
                    currentRolls = RollUtility.mergeRollsByType(currentRolls, damageRolls, CONFIG.Dice.DamageRoll);
                    newRolls.push(...damageRolls);
                }
                break;
            }
        }

        await _animateNewRolls(newRolls, message);

        const serializedRolls = CoreUtility.serializeRolls(currentRolls);
        message.flags[MODULE_SHORT].rolls = serializedRolls;

        await ChatUtility.updateChatMessage(message, {
            flags: message.flags,
            rolls: serializedRolls
        });
    }

    /**
     * Register the activation card as its own "attack" roll message in dnd5e's
     * MessageRegistry, so dnd5e.registry.messages.get(<cardId>, "attack") resolves to
     * this card and its stored attack D20Roll. RSR rolls with create:false and emits no
     * discrete attack message, so without this the registry has no attack entry and
     * condition modules (AC5e) / dnd5e's native attack->damage association cannot
     * recover the attack roll's advantage state.
     *
     * Uses in-memory updateSource (no DB write, no re-render — the same pattern RSR
     * already uses in preCreateChatMessage) so the live document immediately exposes
     * the attack roll and the self-link, then tracks it explicitly. The self-link is
     * also persisted by runActivityActions' final update, so prepareData re-registers
     * the card on reload.
     *
     * Safe despite the self-referential originatingMessage: chat.js _injectContent
     * guards against treating a self-referencing card as its own merge parent.
     * @param {ChatMessage} message The activation card.
     * @param {Array<Roll|object>} currentRolls Rolls gathered so far (must include the attack).
     */
    static _registerCardAsAttack(message, currentRolls) {
        const attackRoll = (currentRolls ?? []).find(r => RollUtility.isRollOfType(r, CONFIG.Dice.D20Roll));
        if (!attackRoll || !message?.id) return;

        const rollFlag = {
            ...(message.flags?.dnd5e?.roll ?? {}),
            type: ROLL_TYPE.ATTACK,
            ...(attackRoll.options?.mastery ? { mastery: attackRoll.options.mastery } : {})
        };

        // In-memory only: expose the attack roll + self-link on the live document so
        // both the registry lookup and AC5e's rolls[0] read resolve during the
        // immediately following damage roll. runActivityActions persists the final
        // state afterwards.
        message.updateSource({
            rolls: CoreUtility.serializeRolls(currentRolls),
            "flags.dnd5e.roll": rollFlag,
            "flags.dnd5e.originatingMessage": message.id
        });

        try {
            dnd5e.registry?.messages?.track?.(message);
        } catch (err) {
            console.warn("RSReforged | failed to register card as attack roll message:", err);
        }
    }

    /**
     * Roll the attack for the activity associated with this message.
     *
     * dnd5e 5.3.0: rollAttack() merges our config object into its own rollConfig via
     * foundry.utils.mergeObject, then passes config.advantage / config.disadvantage
     * into D20Roll.applyKeybindings() (line 78549), which sets roll.options.advantageMode.
     * Passing them at the top level of the config object is therefore the correct approach.
     *
     * The ammunition field passed here is the item ID stored during the
     * activityConsumption hook. rollAttack() looks up the ammo item internally when
     * needed; passing the ID in config means it reaches roll.options.ammunition for
     * the PRE_ROLL_ATTACK hook to see.
     */
    static getAttackFromMessage(message) {
        const activity = ActivityUtility._getActivityFromMessage(message);
        if (!activity || typeof activity.rollAttack !== "function") return null;

        const attackMode = message.flags[MODULE_SHORT].attackMode;
        const config = {
            advantage:    message.flags[MODULE_SHORT].advantage    ?? false,
            disadvantage: message.flags[MODULE_SHORT].disadvantage ?? false,
            ammunition:   message.flags[MODULE_SHORT].ammunition,
            ...(attackMode ? { attackMode } : {})
        };

        const dialogConfig  = { configure: false };
        const messageConfig = { create: false, data: { flags: {} }, flags: {} };
        messageConfig.data.flags[MODULE_SHORT] = { quickRoll: true };
        messageConfig.flags[MODULE_SHORT]      = { quickRoll: true };

        return activity.rollAttack(config, dialogConfig, messageConfig);
    }

    /**
     * Roll damage for the activity associated with this message.
     *
     * dnd5e 5.3.0: scaling is stored in message.system.scaling (a NumberField on
     * UsageMessageData, written at line 17085 of dnd5e.mjs). The legacy path
     * message.flags?.dnd5e?.scaling is kept as a fallback for older persisted messages.
     *
     * Scaling is applied two ways:
     *   1. usageConfig.scaling   → used by getDamageConfig → _processDamagePart via
     *                              `rollConfig.scaling ?? rollData.scaling` (line 12494).
     *   2. activity.item.flags.dnd5e.scaling → populates rollData.scaling through
     *                              getRollData() on the item clone, which is the path
     *                              `rollData.scaling` in _processDamagePart falls back to.
     *
     * Both paths remain necessary: (1) is authoritative when the activity is called
     * outside a full use() workflow (as RSR does), and (2) ensures the item's own
     * formula variables resolve correctly for cantrips and other scaling modes that
     * read rollData rather than rollConfig.
     *
     * midiOptions is not part of the dnd5e 5.3.0 API but is read by midi-qol from the
     * config object when that module is active; it is left in place.
     */
    static getDamageFromMessage(message) {
        const activity = ActivityUtility._getActivityFromMessage(message);
        const actor    = ActivityUtility._getActorFromMessage(message);

        if (!activity || !actor || typeof activity.rollDamage !== "function") return null;

        // Resolve scaling from system data (5.3.0 canonical) with flags fallback.
        const scaling = message.system?.scaling ?? message.flags?.dnd5e?.scaling ?? 0;

        // Stamp scaling onto the item clone so rollData.scaling is populated correctly
        // for formula resolution (see getDamageConfig → getRollData path).
        activity.item.flags.dnd5e ??= {};
        if (scaling > 0 && activity.item.flags.dnd5e.scaling !== scaling) {
            activity.item.flags.dnd5e.scaling = scaling;
        }

        const attackMode = message.flags[MODULE_SHORT].attackMode;
        const config = {
            isCritical: message.flags[MODULE_SHORT].isCritical ?? false,
            // Pass the live Item document so rollDamage can read ammo properties.
            ammunition: actor.items?.get(message.flags[MODULE_SHORT].ammunition),
            // Only override rollConfig.scaling when there's an upcast delta. For
            // cantrips and base-level casts, leave scaling undefined so dnd5e's
            // _processDamagePart falls through to rollData.scaling (the Scaling
            // instance auto-computed by Item5e#scalingIncrease → SpellData, which
            // applies Math.floor((cantripLevel + 1) / 6) for cantrips). Passing
            // scaling: 0 forces scaledFormula(0) because rollConfig.scaling is
            // nullish-coalesced with rollData.scaling at dnd5e.mjs:12545.
            ...(scaling > 0 ? { scaling } : {}),
            // dnd5e's AttackActivity.rollDamage swaps the base damage formula for
            // the versatile formula when attackMode === "twoHanded" && item.isVersatile
            // (dnd5e.mjs:28327-28328), and clamps the mod for *-offhand modes
            // (dnd5e.mjs:28343). Forwarding attackMode is therefore enough — no
            // formula manipulation needed on our side.
            ...(attackMode ? { attackMode } : {}),
            midiOptions: CoreUtility.hasModule(MODULE_MIDI)
                ? {
                    isCritical: message.flags[MODULE_SHORT].isCritical ?? false,
                    ...(attackMode ? { attackMode } : {})
                }
                : undefined
        };

        // Skip activities that resolve to zero damage parts under the resolved config
        // (e.g. SaveActivity for Faerie Fire / Bane). Passing the same `config`
        // rollDamage will use keeps ammo-driven attacks alive — AttackActivity.getDamageConfig
        // only merges ammunition damage when config.ammunition is set
        // (dnd5e.mjs AttackActivity#getDamageConfig), so calling it with `{}` would
        // false-negative on weapons whose damage comes entirely from the ammo.
        if (typeof activity.getDamageConfig === "function" && !activity.getDamageConfig(config).rolls?.length) return null;

        const dialogConfig  = { configure: false };
        const messageConfig = { create: false, data: { flags: {} }, flags: {} };
        messageConfig.data.flags[MODULE_SHORT] = { quickRoll: true };
        messageConfig.flags[MODULE_SHORT]      = { quickRoll: true };
        // Anchor this damage roll to its card so condition modules (AC5e) resolve the
        // originating attack via dnd5e.registry.messages.get(<cardId>, "attack"). AC5e
        // reads flags.dnd5e.originatingMessage off the message config's `data` (the
        // dot-notation key first, then the nested object), so set both shapes.
        messageConfig.data["flags.dnd5e.originatingMessage"] = message.id;
        messageConfig.data.flags.dnd5e = { originatingMessage: message.id };
        messageConfig.flags.dnd5e      = { originatingMessage: message.id };

        return activity.rollDamage(config, dialogConfig, messageConfig);
    }

    /**
     * Roll the utility formula for the activity associated with this message.
     *
     * dnd5e 5.3.0: UtilityActivity.rollFormula() uses rollConfig.scaling (passed via
     * getRollData / scaledFormula) but does not explicitly consume a scaling field from
     * config the way rollDamage does. Passing it anyway is harmless and future-proof.
     */
    static getFormulaFromMessage(message) {
        const activity = ActivityUtility._getActivityFromMessage(message);
        if (!activity || typeof activity.rollFormula !== "function") return null;

        const scaling = message.system?.scaling ?? message.flags?.dnd5e?.scaling ?? 0;

        activity.item.flags.dnd5e ??= {};
        if (scaling > 0 && activity.item.flags.dnd5e.scaling !== scaling) {
            activity.item.flags.dnd5e.scaling = scaling;
        }

        // See getDamageFromMessage for rationale — only pass scaling when > 0 so
        // cantrips fall through to rollData.scaling for auto-computation.
        const config        = scaling > 0 ? { scaling } : {};
        const dialogConfig  = { configure: false };
        const messageConfig = { create: false, data: { flags: {} }, flags: {} };
        messageConfig.data.flags[MODULE_SHORT] = { quickRoll: true };
        messageConfig.flags[MODULE_SHORT]      = { quickRoll: true };

        return activity.rollFormula(config, dialogConfig, messageConfig);
    }
}

/**
 * Trigger the audio/visual feedback for freshly added quick rolls. The caller's
 * subsequent ChatMessage.update includes the new rolls: Dice So Nice >= 5.1.0 watches
 * that update and animates the added rolls itself, so manually calling showForRoll as
 * well would double-animate the dice (#18). Older DSN versions only animate on message
 * creation, so trigger the 3D roll manually for them; with no enabled DSN at all, fall
 * back to playing the dice sound.
 *
 * @param {Roll[]} newRolls The rolls added in this action.
 * @param {ChatMessage} message The message the rolls are persisted to.
 */
async function _animateNewRolls(newRolls, message) {
    if (newRolls.length === 0) return;

    if (!game.dice3d || !game.dice3d.isEnabled()) {
        CoreUtility.playRollSound();
        return;
    }

    if (!CoreUtility.dice3dAnimatesRollUpdates()) {
        await CoreUtility.tryRollDice3D(newRolls, message.id);
    }
}
