/**
 * English strings for the GMC extras, merged into the translations on `i18nInit` so the
 * extras need no entry of their own in lang/*.json (which are upstream's files).
 */
export const STRINGS = {
    "rsreforged": {
        "settings": {
            "fastForwardRolls.name": "Fast-Forward Rolls (Shift to Configure)",
            "fastForwardRolls.hint": "Inverts dnd5e's dialog key for every roll that goes through the dnd5e roll pipeline and has no explicit dialog choice (card buttons, save request buttons, hit dice, initiative, ...): rolls skip the configuration dialog unless the dnd5e 'Skip Dialog' key (Shift by default) is held. Alt/Ctrl keep their dnd5e meaning (advantage/disadvantage, critical/normal damage). dnd5e has no built-in setting for this. Activity, ability, skill and tool rolls follow the 'Enable Quick Roll' toggles.",
            "hidePrivateRolls.name": "Hide Private Rolls Completely",
            "hidePrivateRolls.hint": "GM, blind and self rolls are hidden completely from players who may not see them: no '???' placeholder card and no line in a usage card's save/check summary. The GM can reveal such a message to everyone with the eye button in its header (or on its summary line)."
        },
        "chat": {
            "tray": {
                "healing": "Apply as healing",
                "none": "Apply no damage",
                "quarter": "Apply a quarter of the damage",
                "half": "Apply half damage",
                "full": "Apply full damage",
                "double": "Apply double damage",
                "tempHp": "Temporary hit points: preview and apply the total as temp HP"
            },
            "buttons": {
                "reveal": "Reveal this message to everyone",
                "hide": "Make this message private again"
            }
        }
    }
};
