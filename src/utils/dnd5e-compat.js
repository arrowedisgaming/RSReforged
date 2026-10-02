import { ROLL_TYPE } from "../module/const.js";

const REQUIRED_NATIVE_MODELS = ["attack", "damage", "healing", "check", "save", "generic"];

/**
 * Classify both native dnd5e 6 messages and legacy flag-backed messages.
 * Native message data is authoritative when the document has a native type.
 *
 * @param {ChatMessage|object} message Chat message or message-shaped data.
 * @returns {string|null} One of ROLL_TYPE's values, the initiative bonus category, or null.
 */
export function getRollType(message) {
    const type = message?.type;
    const system = message?.system ?? {};

    switch (type) {
        case "attack":
            return ROLL_TYPE.ATTACK;
        case "damage":
            return ROLL_TYPE.DAMAGE;
        case "healing":
            return ROLL_TYPE.HEALING;
        case "usage":
        case "dnd5e.usage":
            return ROLL_TYPE.ACTIVITY;
        case "check":
            if (system.skill) return ROLL_TYPE.SKILL;
            if (system.tool) return ROLL_TYPE.TOOL;
            if (system.type === "initiative") return "initiative";
            return ROLL_TYPE.ABILITY_TEST;
        case "save":
            if (system.type === "death") return ROLL_TYPE.DEATH_SAVE;
            if (system.type === "concentration") return ROLL_TYPE.CONCENTRATION;
            return ROLL_TYPE.ABILITY_SAVE;
        case "generic":
            return _hasRolls(message) ? ROLL_TYPE.FORMULA : null;
        case "base":
            return _hasRolls(message) ? ROLL_TYPE.FORMULA : null;
        case "roll":
        case "dnd5e.roll":
            return system.roll?.type ?? message.flags?.dnd5e?.roll?.type ?? null;
    }

    if (message?.flags?.dnd5e?.messageType === "usage" || message?.flags?.dnd5e?.use) {
        return ROLL_TYPE.ACTIVITY;
    }
    if (message?.flags?.dnd5e?.messageType === "roll" || message?.flags?.dnd5e?.roll) {
        return message.flags?.dnd5e?.roll?.type ?? null;
    }

    return null;
}

/**
 * Resolve a native source/prepared origin or a legacy originating-message flag to an ID.
 * An explicitly present native origin, including null, outranks legacy metadata.
 *
 * @param {ChatMessage|object} message Chat message or message-shaped data.
 * @returns {string|null} Originating chat-message ID, or null.
 */
export function getOriginId(message) {
    const rawSystem = message?._source?.system;
    if (rawSystem && Object.hasOwn(rawSystem, "origin")) return _documentId(rawSystem.origin);

    const preparedSystem = message?.system;
    if (preparedSystem && Object.hasOwn(preparedSystem, "origin")) return _documentId(preparedSystem.origin);

    return _documentId(message?.flags?.dnd5e?.originatingMessage);
}

/**
 * Read native target descriptors when present, preserving an authoritative empty array.
 *
 * @param {ChatMessage|object} message Chat message or message-shaped data.
 * @returns {object[]|undefined} Native or legacy target descriptors.
 */
export function getTargets(message) {
    if (message?.system && Object.hasOwn(message.system, "targets")) return message.system.targets;
    return message?.flags?.dnd5e?.targets;
}

/**
 * Whether this installation has the supported dnd5e 6 typed-message capabilities.
 * Unknown majors and incomplete model registrations remain on the legacy path.
 *
 * @returns {boolean}
 */
export function usesNativeWorkflow() {
    const models = globalThis.CONFIG?.ChatMessage?.dataModels;
    if (!models || !REQUIRED_NATIVE_MODELS.every(type => _hasModel(models, type))) return false;

    const version = globalThis.game?.system?.version;
    return typeof version === "string" && /^6(?:\.|$)/.test(version);
}

function _hasRolls(message) {
    const rolls = message?.rolls;
    return Array.isArray(rolls) ? rolls.length > 0 : Boolean(rolls?.size ?? rolls?.length);
}

function _documentId(value) {
    if (typeof value === "string") return value || null;
    return value?.id ?? value?._id ?? null;
}

function _hasModel(models, type) {
    if (typeof models.has === "function") return models.has(type);
    return Object.hasOwn(models, type);
}
