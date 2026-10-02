/**
 * GMC extras: Max's additions that sit on top of RSReforged and do not touch its source.
 * Loaded as its own entry in module.json, so src/utils/ can be replaced by a new upstream
 * release without merging anything here.
 *
 *   - damage tray facelift (heart / hourglass temp-HP mode / burst on x2)      tray.js
 *   - private rolls hidden completely from players, GM reveal eye on summaries  privacy.js
 *   - fast-forward for rolls with no dialog choice of their own, Shift to configure
 *
 * Each one is guarded so a failure here can never stop RSReforged itself.
 */
import { PrivacyUtility } from "./privacy.js";
import { TrayUtility } from "./tray.js";
import { MODULE_SHORT, SETTING_NAMES } from "./shim.js";
import { STRINGS } from "./strings.js";

function _guard(label, fn) {
    return (...args) => {
        try {
            return fn(...args);
        } catch (err) {
            console.warn(`RSReforged | ${label} failed`, err);
        }
    };
}

Hooks.once("init", _guard("GMC extras settings", () => {
    const register = (key, data) => game.settings.register(MODULE_SHORT, key, {
        name: `${MODULE_SHORT}.settings.${key}.name`,
        hint: `${MODULE_SHORT}.settings.${key}.hint`,
        config: true,
        ...data
    });
    register(SETTING_NAMES.FAST_FORWARD_ROLLS, { scope: "client", type: Boolean, default: true });
    register(SETTING_NAMES.HIDE_PRIVATE_ROLLS, {
        scope: "world", type: Boolean, default: true, onChange: () => ui.chat?.render?.()
    });
}));

// Foundry 14 loads translations after `init`, then fires `i18nInit`. Existing keys win, so
// a translation that defines these strings is kept.
Hooks.once("i18nInit", _guard("GMC extras strings", () => {
    const i18n = game.i18n;
    const target = (i18n.lang === "en" || !i18n._fallback) ? i18n.translations : i18n._fallback;
    foundry.utils.mergeObject(target, foundry.utils.expandObject(STRINGS), { overwrite: false });
}));

Hooks.once("setup", _guard("damage tray facelift", () => TrayUtility.patchDamageApplication()));

// Private rolls: hide the whole message from users who may not see it, drop its line from
// a usage card's save/check summary, and give the GM the reveal eye there.
Hooks.on("dnd5e.renderChatMessage", _guard("private roll handling", (message, html) => {
    const element = html instanceof HTMLElement ? html : html?.[0];
    if (!message || !element) return;
    if (PrivacyUtility.applyToElement(message, element)) return;
    PrivacyUtility.processSummaries(element);
}));

// A summarized child was revealed or hidden again: dnd5e only refreshes the origin card
// for `system` changes.
Hooks.on("updateChatMessage", _guard("private roll refresh", (message, changed) => {
    if (!("whisper" in changed) && !("blind" in changed)) return;
    const origin = message.system?.origin ?? null;
    if (!origin || origin === message || !origin.id) return;
    ui.chat?.updateMessage?.(origin);
}));

// Fast-forward: a roll with no explicit dialog choice (card buttons, save requests, hit
// dice, ...) skips the configuration dialog unless Shift is held. dnd5e fires preRollV2
// last, so RSReforged's own handlers have already decided the rolls they manage.
Hooks.on("dnd5e.preRollV2", (config, dialog) => {
    try {
        if (!dialog || dialog.configure !== undefined) return true;
        const setting = key => game.settings.get(MODULE_SHORT, key);
        // "Use Vanilla Rolls with RSReforged Styling" asks for dnd5e's own dialogs.
        if (setting("enableVanillaQuickRoll") || !setting(SETTING_NAMES.FAST_FORWARD_ROLLS)) return true;
        if (!setting(_quickRollSetting(config?.hookNames ?? []))) return true;
        dialog.configure = _skipDialogKeyHeld(config?.event);
    } catch (err) {
        console.warn("RSReforged | fast-forward failed", err);
    }
    return true; // never veto a roll
});

/** The RSReforged "Enable Quick Roll" toggle that governs a roll with these dnd5e hook names. */
function _quickRollSetting(hookNames) {
    const has = name => hookNames.includes(name);
    if (has("skill")) return "enableSkillQuickRoll";
    if (has("tool")) return "enableToolQuickRoll";
    if (has("abilityCheck") || has("savingThrow") || has("deathSave") || has("concentration") || has("initiativeDialog")) {
        return "enableAbilityQuickRoll";
    }
    return "enableActivityQuickRoll";
}

/** Whether dnd5e's "Skip Dialog" key (Shift by default) is held: here it means "show the dialog". */
function _skipDialogKeyHeld(event) {
    const bindings = game.keybindings.get("dnd5e", "skipDialogNormal") ?? [];
    if (!event) {
        return bindings.some(b => game.keyboard.downKeys.has(b.key) && b.modifiers.every(m => game.keyboard.isModifierActive(m)));
    }
    const { MODIFIER_CODES, MODIFIER_KEYS } = foundry.helpers.interaction.KeyboardManager;
    const active = {};
    const add = (key, pressed) => {
        active[key] = pressed;
        MODIFIER_CODES[key].forEach(code => { active[code] = pressed; });
    };
    add(MODIFIER_KEYS.CONTROL, event.ctrlKey || event.metaKey);
    add(MODIFIER_KEYS.SHIFT, event.shiftKey);
    add(MODIFIER_KEYS.ALT, event.altKey);
    return bindings.some(b => {
        if (game.keyboard.downKeys.has(b.key) && b.modifiers.every(m => active[m])) return true;
        if (b.modifiers.length) return false;
        return !!active[b.key];
    });
}
