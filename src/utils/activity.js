import { MODULE_SHORT } from "../module/const.js";
import { MODULE_MIDI } from "../module/integration.js";
import { ChatUtility } from "./chat.js";
import { CoreUtility } from "./core.js";
import { ROLL_TYPE } from "./roll.js";
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
     * Set RSR render flags on the message based on the activity's capabilities.
     * Called from processChatMessage when flags haven't been written yet (i.e. the
     * message was not caught by preCreateChatMessage, which can happen when another
     * module creates a usage message programmatically after the fact).
     */
    static setRenderFlags(activity, message) {
        if (!message || !activity) return;
        const flags = message.flags;
        if (!flags || !flags[MODULE_SHORT] || !flags[MODULE_SHORT].quickRoll) return;

        const hasAttack  = activity.type === "attack"  || !!activity.attack   || activity.hasOwnProperty(ROLL_TYPE.ATTACK);
        const hasDamage  = activity.type === "damage"  || !!activity.damage   || activity.type === "attack" || activity.type === "save" || activity.hasOwnProperty(ROLL_TYPE.DAMAGE);
        const hasHealing = activity.type === "heal"    || !!activity.healing  || activity.hasOwnProperty(ROLL_TYPE.HEALING);
        const hasFormula = activity.type === "utility" || !!activity.roll     || activity.hasOwnProperty(ROLL_TYPE.FORMULA);

        if (hasAttack) {
            flags[MODULE_SHORT].renderAttack = true;
        }

        const manualDamageMode = SettingsUtility.getSettingValue(SETTING_NAMES.MANUAL_DAMAGE_MODE);

        if (hasDamage) {
            flags[MODULE_SHORT].manualDamage = (manualDamageMode === 2 || (manualDamageMode === 1 && hasAttack));
            flags[MODULE_SHORT].renderDamage = !flags[MODULE_SHORT].manualDamage;
        }

        if (hasHealing) {
            flags[MODULE_SHORT].isHealing = true;
            flags[MODULE_SHORT].renderDamage = true;
        }

        if (hasFormula) {
            flags[MODULE_SHORT].renderFormula = true;
            const fName = activity.roll?.name || activity[ROLL_TYPE.FORMULA]?.name;
            if (fName && fName !== "") {
                flags[MODULE_SHORT].formulaName = fName;
            }
        }
    }

    /**
     * Execute all pending roll actions for a usage message (attack, damage, formula)
     * and persist the resulting rolls back to the message flags.
     */
    static async runActivityActions(message) {
        let currentRolls = Array.from(message.flags[MODULE_SHORT]?.rolls || []);
        const newRolls = [];

        if (message.flags[MODULE_SHORT].renderAttack) {
            const rawAttack = await ActivityUtility.getAttackFromMessage(message);
            const attackRolls = ActivityUtility._extractRolls(rawAttack);

            if (attackRolls.length > 0) {
                currentRolls = _injectRollsToArray(currentRolls, attackRolls, CONFIG.Dice.D20Roll);
                newRolls.push(...attackRolls);
                // dual flag means a multi-roll was enforced by ALWAYS_ROLL_MULTIROLL;
                // in that case isCritical is determined later during rendering.
                message.flags[MODULE_SHORT].isCritical = message.flags[MODULE_SHORT].dual
                    ? false
                    : attackRolls[0].isCritical;
            } else {
                message.flags[MODULE_SHORT].isCritical = false;
            }
        }

        if (message.flags[MODULE_SHORT].renderDamage) {
            const rawDamage = await ActivityUtility.getDamageFromMessage(message);
            const damageRolls = ActivityUtility._extractRolls(rawDamage);

            if (damageRolls.length > 0) {
                currentRolls = _injectRollsToArray(currentRolls, damageRolls, CONFIG.Dice.DamageRoll);
                newRolls.push(...damageRolls);
            }
        }

        if (message.flags[MODULE_SHORT].renderFormula) {
            const rawFormula = await ActivityUtility.getFormulaFromMessage(message);
            const formulaRolls = ActivityUtility._extractRolls(rawFormula);

            if (formulaRolls.length > 0) {
                currentRolls = _injectRollsToArray(currentRolls, formulaRolls, CONFIG.Dice.BasicRoll);
                newRolls.push(...formulaRolls);
            }
        }

        // dnd5e's rollAttack/rollDamage/rollFormula were called with create: false, so no
        // ChatMessage was created for these rolls and Dice So Nice's createChatMessage
        // hook never fires. Trigger the 3D animation manually and fall back to playing
        // the dice sound when DSN is absent. Mirrors the retro-crit pattern in chat.js.
        if (newRolls.length > 0) {
            await CoreUtility.tryRollDice3D(newRolls, message.id);

            if (!game.dice3d || !game.dice3d.isEnabled()) {
                CoreUtility.playRollSound();
            }
        }

        message.flags[MODULE_SHORT].processed = true;
        message.flags[MODULE_SHORT].rolls = currentRolls.map(r => r.toJSON ? r.toJSON() : r);

        await ChatUtility.updateChatMessage(message, {
            flags: message.flags
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
                    currentRolls = _injectRollsToArray(currentRolls, damageRolls, CONFIG.Dice.DamageRoll);
                    newRolls.push(...damageRolls);
                }
                break;
            }
        }

        // create: false suppresses the chat-message-creation path that Dice So Nice hooks
        // into; trigger the 3D animation manually and play the dice sound as a fallback.
        if (newRolls.length > 0) {
            await CoreUtility.tryRollDice3D(newRolls, message.id);

            if (!game.dice3d || !game.dice3d.isEnabled()) {
                CoreUtility.playRollSound();
            }
        }

        message.flags[MODULE_SHORT].rolls = currentRolls.map(r => r.toJSON ? r.toJSON() : r);

        await ChatUtility.updateChatMessage(message, {
            flags: message.flags
        });
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

        const config = {
            advantage:    message.flags[MODULE_SHORT].advantage    ?? false,
            disadvantage: message.flags[MODULE_SHORT].disadvantage ?? false,
            ammunition:   message.flags[MODULE_SHORT].ammunition
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
            midiOptions: CoreUtility.hasModule(MODULE_MIDI)
                ? { isCritical: message.flags[MODULE_SHORT].isCritical ?? false }
                : undefined
        };

        const dialogConfig  = { configure: false };
        const messageConfig = { create: false, data: { flags: {} }, flags: {} };
        messageConfig.data.flags[MODULE_SHORT] = { quickRoll: true };
        messageConfig.flags[MODULE_SHORT]      = { quickRoll: true };

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
 * Merge a set of new rolls into an existing roll array, first removing any rolls of the
 * same class so that re-rolls replace rather than duplicate the previous result.
 *
 * @param {Roll[]|object[]} existingRolls  Current serialised or live roll array.
 * @param {Roll[]}          newRolls       Fresh rolls to inject.
 * @param {typeof Roll}     cleanType      Roll class whose existing entries to evict.
 * @returns {Roll[]}
 */
function _injectRollsToArray(existingRolls, newRolls, cleanType) {
    if (!CoreUtility.isIterable(newRolls)) {
        return existingRolls;
    }

    let processedRolls = Array.from(existingRolls);

    if (cleanType) {
        processedRolls = processedRolls.filter(r => {
            const isTargetType = r instanceof cleanType || r.class === cleanType.name;
            return !isTargetType;
        });
    }

    processedRolls.push(...newRolls);
    return processedRolls;
}
