/**
 * The few helpers tray.js and privacy.js need, so the GMC extras do not import anything
 * from RSReforged's own source (src/utils/), which is upstream's and changes with it.
 */
export const MODULE_SHORT = "rsreforged";

export const SETTING_NAMES = {
    FAST_FORWARD_ROLLS: "fastForwardRolls",
    HIDE_PRIVATE_ROLLS: "hidePrivateRolls"
};

export const CoreUtility = {
    localize: (key, data = null) => data ? game.i18n.format(key, data) : game.i18n.localize(key)
};

export const LogUtility = {
    log: text => console.log("%cRSReforged", "color: #cf6000; font-weight: bold;", "|", text),
    debug: () => {},
    logWarning: text => console.warn("RSReforged |", text)
};

export const SettingsUtility = {
    getSettingValue: key => game.settings.get(MODULE_SHORT, key)
};
