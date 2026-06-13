/**
 * String identifier for the module used throughout other scripts.
 */
export const MODULE_NAME = "rsreforged";

/**
 * Full title string of the module.
 */
export const MODULE_TITLE = "RSReforged";

/**
 * Shorthand string identifier for the module. Also used as the CONFIG namespace
 * key and as the top-level i18n key prefix (see lang/*.json).
 */
export const MODULE_SHORT = "rsreforged";

/**
 * String attached to debug logs to identify logs made by this module.
 */
export const MODULE_DEBUG_TAG = [
    `%cRSReforged`,
    `color: #cf6000; font-weight: bold;`,
    `|`,
];

/**
 * Path to the default image to use when an actor/item image isn't available.
 */
export const DEFAULT_IMG = "icons/svg/mystery-man.svg";

/**
 * Enumerable of identifiers for different roll types that can be made.
 * Lives here (rather than roll.js, which re-exports it) so that settings.js can
 * consume it without creating a roll.js <-> settings.js import cycle.
 * @enum {String}
 */
export const ROLL_TYPE = {
    SKILL: "skill",
    ABILITY_TEST: "ability",
    ABILITY_SAVE: "save",
    DEATH_SAVE: "death",
    TOOL: "tool",
    ACTIVITY: "activity",
    CHECK: "check",
    ATTACK: "attack",
    DAMAGE: "damage",
    VERSATILE: "versatile",
    OTHER: "formula",
    CONCENTRATION: "concentration",
    HEALING: "healing",
    FORMULA: "roll"
}