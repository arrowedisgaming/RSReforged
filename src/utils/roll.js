import { MODULE_NAME, MODULE_SHORT, ROLL_TYPE } from "../module/const.js";
import { CoreUtility } from "./core.js";
import { SETTING_NAMES, SettingsUtility } from "./settings.js";

export const KEYBIND_VERSATILE_TWO_HANDED = "versatileTwoHanded";

// ROLL_TYPE is defined in const.js (so settings.js can use it without an import
// cycle) but re-exported here to preserve the established import path.
export { ROLL_TYPE };

/**
 * Enumerable of identifiers for roll states (advantage or disadvantage).
 * @enum {String}
 */
export const ROLL_STATE = {
    ADV: "kh",
    DIS: "kl",
    DUAL: "dual",
    SINGLE: "single"
}

/**
 * Enumerable of identifiers for crit result types.
 * @enum {String}
 */
export const CRIT_TYPE = {
    MIXED: "mixed",
    SUCCESS: "success",
    FAILURE: "failure"
}

/**
 * Utility class for functions related to making specific rolls.
 */
export class RollUtility {
    static processRoll(config, dialog, message) {
        if (message.data.flags[MODULE_SHORT]?.processed) return;

        const keys = _readSkipDialogKeys(config.event);
        const vanillaWorkflow = SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_VANILLA_ENABLED);

        dialog.configure = vanillaWorkflow || keys.normal || (config.vanilla ?? false);

        if (config.isConcentration) {
            config.flavor = `${CoreUtility.localize("DND5E.ToolPromptTitle", { tool: CoreUtility.localize("DND5E.Concentration") })}`;
        }

        message.data.flags[MODULE_SHORT] = { 
            quickRoll: vanillaWorkflow || !dialog.configure,
            advantage: keys.advantage,
            disadvantage: keys.disadvantage,
            isConcentration: config.isConcentration,
            processed: true
        };
    }

    static processActivity(activity, usageConfig, dialogConfig, messageConfig) {
        const keys = _readSkipDialogKeys(usageConfig.event);

        const fastForward = !(keys.normal || (usageConfig.vanilla ?? false))
        // Preserve dnd5e's usage dialog for leveled spells so the player can
        // choose an upcast slot; cantrips skip it and use automatic scaling.
        // Note: dnd5e seeds usageConfig.scaling = 0 for any scalable activity
        // (including cantrips), so it isn't a reliable "user wants the dialog"
        // signal — the item-level check below is.
        const isLeveledSpell = activity?.item?.type === "spell"
            && (activity.item.system?.level ?? 0) > 0;
        // Preserve OrderActivity dialogs because they populate costs/craft/trade
        // flags that dnd5e later expects during bastion order resolution.
        const isOrderActivity = activity?.type === "order";
        // Smite-like features (Divine Smite et al.) need the dialog so the player can
        // pick which slot to spend. The reliable signal is a spellSlots-typed entry in
        // the activity's consumption.targets — the bare consumption.spellSlot boolean
        // can't be used because dnd5e's schema initialises it to `true` on every
        // activity (dnd5e.mjs:11857) and only honors it when `requiresSpellSlot`
        // returns true, which is false for non-spell items. Reading the targets list
        // distinguishes "configured spell-slot consumer" from "scaffolded default".
        // Spell-type activities (cantrips, leveled spells) use a different consumption
        // path and are handled by isLeveledSpell above.
        const consumesSpellSlot = !!activity?.consumption?.targets?.some?.(t => t?.type === "spellSlots");
        // Nonzero scaling means an upcast delta has already been seeded (e.g.
        // drag-to-slot, macro). Preserve the dialog so the player can confirm or
        // adjust. scaling = 0 is dnd5e's noisy default for any scalable activity
        // (cantrips included), so check strictly > 0.
        const hasUpcastScaling = (usageConfig.scaling ?? 0) > 0;

        dialogConfig.configure = isLeveledSpell
            || isOrderActivity
            || consumesSpellSlot
            || hasUpcastScaling
            || !fastForward;

        const flagSeed = {
            quickRoll: fastForward,
            advantage: keys.advantage,
            disadvantage: keys.disadvantage,
            processed: !fastForward
        };

        // Versatile shortcut. On a quick-roll click of a Versatile weapon, stamp
        // attackMode explicitly so dnd5e doesn't fall back to whatever it last
        // persisted on the item. dnd5e's rollAttack writes
        // flags.dnd5e.last.<id>.attackMode after every roll, so without an
        // explicit choice here a single V-held click would pin the weapon to
        // twoHanded for all subsequent plain clicks. Holding the
        // rsreforged.versatileTwoHanded key (KeyV by default, matches Midi-QOL's
        // convention) flips this roll to twoHanded; releasing it falls back to
        // oneHanded. Both modes also surface in the chat-card label via
        // flags.rsreforged.versatile.
        //
        // No event = no keystroke. fastForward only — slow-roll uses dnd5e's own
        // attack-mode dropdown which writes the same last.attackMode item flag.
        if (fastForward && activity?.item?.system?.isVersatile) {
            const versatileHeld = !!usageConfig.event && CoreUtility.areKeysPressed(
                usageConfig.event,
                KEYBIND_VERSATILE_TWO_HANDED,
                MODULE_NAME
            );
            flagSeed.attackMode = versatileHeld ? "twoHanded" : "oneHanded";
            flagSeed.versatile = versatileHeld;
        }

        messageConfig.data.flags[MODULE_SHORT] = flagSeed;

        // Only suppress dnd5e's follow-up rolls when RSR will fire them itself
        // on the quick-roll path. On a slow roll, leave subsequentActions alone
        // so dnd5e's _triggerSubsequentActions can drive attack/damage/healing/
        // formula rolls after the usage dialog closes.
        if (fastForward) {
            usageConfig.subsequentActions = false;
        } else {
            // RSR inverts dnd5e's skipDialog keybind: holding shift/ctrl/alt at
            // activity click means "give me the full vanilla flow" (RSR shows the
            // usage dialog, dnd5e then shows attack/damage/healing/formula dialogs).
            // dnd5e's _triggerSubsequentActions forwards usageConfig.event into
            // rollAttack/rollDamage, where applyKeybindings reads its modifier flags
            // and interprets shift as "skip dialog" — the opposite of what the user
            // just asked for. Strip the event so dnd5e's downstream keybinding
            // checks see no modifier and default to showing their dialogs. All
            // dnd5e call sites that read config.event after this point are
            // null-safe (positional `event ? event.clientY - 80 : null`, `?.target`
            // chains, `if (!event) return false` in areKeysPressed).
            usageConfig.event = null;
        }
    }

    /**
     * Checks if the roll needs to be forced to multi roll and returns the updated roll if needed.
     * @param {Roll} roll The roll to check.
     * @returns {Promise<Roll>} The version of the roll with multi roll enforced if needed, or the original roll otherwise.
     */
    static async ensureMultiRoll(roll) {
        if (!roll) {
			LogUtility.logError(CoreUtility.localize(`${MODULE_SHORT}.messages.error.rollIsNullOrUndefined`));
            return null;
        }

        if (!(roll.hasAdvantage || roll.hasDisadvantage)) {
            const forcedDiceCount = roll.options.elvenAccuracy ? 3 : 2;
            const d20BaseTerm = roll.terms.find(d => d.faces === 20);
            const d20Additional = await new Roll(`${forcedDiceCount - d20BaseTerm.number}d20${d20BaseTerm.modifiers.join('')}`).evaluate();

            await CoreUtility.tryRollDice3D(d20Additional);

            const d20Forced = new foundry.dice.terms.Die({
                number: forcedDiceCount,
                faces: 20,
                results: [...d20BaseTerm.results, ...d20Additional.dice[0].results],
                modifiers: d20BaseTerm.modifiers
            });

            roll.terms[roll.terms.indexOf(d20BaseTerm)] = d20Forced;

            RollUtility.resetRollGetters(roll);
        }

        return roll;
    }

    /**
     * Upgrades a roll into a multi roll with the given target state (advantage/disadvantage).
     * @param {Roll} roll The roll to upgrade.
     * @param {ROLL_STATE} targetState The target state of the roll.
     * @returns {Promise<Roll>} The upgraded multi roll from the provided roll.
     */
    static async upgradeRoll(roll, targetState) {
        if (!roll) {
            LogUtility.logError(CoreUtility.localize(`${MODULE_SHORT}.messages.error.rollIsNullOrUndefined`));
            return null;
        }

		if (targetState !== ROLL_STATE.ADV && targetState !== ROLL_STATE.DIS) {
			LogUtility.logError(CoreUtility.localize(`${MODULE_SHORT}.messages.error.incorrectTargetState`, { state: targetState }));
			return roll;
		}

        if (targetState === ROLL_STATE.DIS) {
            roll.options.elvenAccuracy = false;
        }

        const upgradedRoll = await RollUtility.ensureMultiRoll(roll);
        
        const d20BaseTerm = upgradedRoll.terms.find(d => d.faces === 20);
        d20BaseTerm.keep(targetState);
        d20BaseTerm.modifiers.push(targetState);
        
        upgradedRoll.options.advantageMode = targetState === ROLL_STATE.ADV 
            ? CONFIG.Dice.D20Roll.ADV_MODE.ADVANTAGE 
            : CONFIG.Dice.D20Roll.ADV_MODE.DISADVANTAGE;

        RollUtility.resetRollGetters(upgradedRoll);
        return upgradedRoll;
    }

    static resetRollGetters(roll) {
        roll._total = roll._evaluateTotal();
        roll.resetFormula();
    }

    /**
     * Processes a set of dice results to check what type of critical was rolled (for showing colour in chat card).
     * @param {Die} die A die term to process into a crit type.
     * @param {Number} options.critThreshold The threshold above which a result is considered a crit.
     * @param {Number} options.fumbleThreshold The threshold below which a result is considered a crit.
     * @returns {CRIT_TYPE} The type of crit for the die term.
     */
    static getCritTypeForDie(die, options = {}) {
        if (!die) return null;

        const { crit, fumble } = _countCritsFumbles(die, options)

        return _getCritResult(crit, fumble);
    }

    /**
     * Checks if a roll (live instance or serialised flag data) is of a given roll class.
     * Serialised rolls carry the class name in `.class`; live rolls match via instanceof
     * or, for cross-realm/test instances, the constructor name.
     * @param {Roll|object} roll The roll or serialised roll data to test.
     * @param {typeof Roll} rollClass The roll class to test against.
     * @returns {Boolean} Whether the roll is of the given class.
     */
    static isRollOfType(roll, rollClass) {
        if (!roll || !rollClass) return false;
        return roll instanceof rollClass || roll.class === rollClass.name || roll.constructor?.name === rollClass.name;
    }

    /**
     * Merge a set of new rolls into an existing roll array, replacing any rolls of the
     * same class (at their original position) so that re-rolls replace rather than
     * duplicate the previous result. When there is nothing to merge, the existing rolls
     * are kept untouched — same-type entries are never evicted without a replacement
     * (e.g. a child message whose rolls failed to deserialize).
     * @param {Roll[]|object[]} existingRolls Current serialised or live roll array.
     * @param {Roll[]} newRolls Fresh rolls to merge in.
     * @param {typeof Roll} cleanType Roll class whose existing entries to replace.
     * @returns {Roll[]|object[]} The merged roll array.
     */
    static mergeRollsByType(existingRolls, newRolls, cleanType) {
        const existing = Array.from(existingRolls ?? []);
        const fresh = CoreUtility.isIterable(newRolls) ? Array.from(newRolls) : [];

        if (fresh.length === 0) return existing;
        if (!cleanType) return [...existing, ...fresh];

        const merged = [];
        let inserted = false;

        for (const roll of existing) {
            if (RollUtility.isRollOfType(roll, cleanType)) {
                if (!inserted) {
                    merged.push(...fresh);
                    inserted = true;
                }
                continue;
            }
            merged.push(roll);
        }

        if (!inserted) merged.push(...fresh);
        return merged;
    }
}

function _readSkipDialogKeys(event) {
    return {
        normal: CoreUtility.areKeysPressed(event, "skipDialogNormal"),
        advantage: CoreUtility.areKeysPressed(event, "skipDialogAdvantage"),
        disadvantage: CoreUtility.areKeysPressed(event, "skipDialogDisadvantage")
    };
}

function _getCritResult(crit, fumble)
{
    if (crit > 0 && fumble > 0) {
        return CRIT_TYPE.MIXED;
    }
    
    if (crit > 0) {
        return CRIT_TYPE.SUCCESS;
    }
    
    if (fumble > 0) {
        return CRIT_TYPE.FAILURE;
    }
}

function _countCritsFumbles(die, options)
{
    let crit = 0;
    let fumble = 0;

    if (die && die.faces > 1) {
        let { critThreshold, fumbleThreshold, target, ignoreDiscarded, displayChallenge, forceSuccess } = options

        if (forceSuccess) {
            return { crit: 1, fumble: 0 };
        }

        critThreshold = critThreshold ?? die.options.criticalSuccess ?? die.faces;
        fumbleThreshold = fumbleThreshold ?? die.options.criticalFailure ?? 1;

        for (const result of die.results) {
            if (result.rerolled || (result.discarded && ignoreDiscarded)) {
                continue;
            }
            
            if ((displayChallenge && result.result >= target) || result.result >= critThreshold) {
                crit += 1;
            } else if ((displayChallenge && result.result < target) || result.result <= fumbleThreshold) {
                fumble += 1;
            }
        }
    }

    return { crit, fumble }
}
