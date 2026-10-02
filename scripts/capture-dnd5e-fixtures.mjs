// Paste this source into a Script macro in a disposable Foundry world.
// Use synthetic actors, items, and targets only. Replace both values before running.
const scenario = "PASTE_SCENARIO_NAME";
const id = "PASTE_TEST_MESSAGE_ID";

const VERIFIED_UPSTREAM_COMMITS = {
    "6.0.1": "14037023a87372688bbb59be99f55fcd3a83318d"
};

const upstreamCommit = VERIFIED_UPSTREAM_COMMITS[game.system.version];
if (!upstreamCommit) {
    throw new Error(`Add the verified upstream commit for dnd5e ${game.system.version} before capturing`);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(scenario)) {
    throw new Error("Use a lowercase, hyphenated scenario name");
}

const message = game.messages.get(id);
if (!message) throw new Error("Select an existing synthetic test message");

const readSetting = (namespace, key) => {
    try {
        return game.settings.get(namespace, key);
    } catch (_error) {
        return null;
    }
};

const element = await message.renderHTML();
const damageInputs = [
    { formula: "1d8 + 3", data: {}, options: { type: "slashing" } },
    { formula: "2d6kh1 + 3", data: {}, options: { type: "slashing" } },
    { formula: "(1d6 + 2) * 2", data: {}, options: { type: "fire" } },
    { formula: "1d8 - 1d4", data: {}, options: { type: "slashing" } }
];

const damageRolls = [];
for (const input of damageInputs) {
    const base = new CONFIG.Dice.DamageRoll(
        input.formula,
        foundry.utils.deepClone(input.data),
        foundry.utils.deepClone(input.options)
    );
    const criticalOptions = foundry.utils.mergeObject(input.options, {
        isCritical: true,
        critical: {
            multiplyNumeric: readSetting("dnd5e", "criticalDamageModifiers"),
            powerfulCritical: readSetting("dnd5e", "criticalDamageMaxDice")
        }
    }, { inplace: false });
    const critical = new CONFIG.Dice.DamageRoll(
        input.formula,
        foundry.utils.deepClone(input.data),
        criticalOptions
    );

    try {
        await base.evaluate();
        await critical.evaluate();
    } catch (error) {
        damageRolls.push({ input, error: error.message });
        continue;
    }
    damageRolls.push({
        input,
        base: { formula: base.formula, options: base.options, outcome: base.toJSON() },
        critical: { formula: critical.formula, options: critical.options, outcome: critical.toJSON() }
    });
}

const capture = {
    scenario,
    provenance: {
        foundry: game.version,
        system: game.system.version,
        upstreamCommit,
        capturedAt: new Date().toISOString(),
        browser: navigator.userAgent,
        modules: [...game.modules.values()].filter(module => module.active)
            .map(module => ({ id: module.id, version: module.version }))
    },
    settings: {
        chatCardSummary: readSetting("dnd5e", "chatCardSummary"),
        damageApplyMode: readSetting("rsreforged", "damageApplyMode"),
        criticalDamageModifiers: readSetting("dnd5e", "criticalDamageModifiers"),
        criticalDamageMaxDice: readSetting("dnd5e", "criticalDamageMaxDice")
    },
    source: message.toObject(),
    rolls: message.rolls.map(roll => roll.toJSON()),
    html: element.outerHTML,
    damageRolls
};

foundry.utils.saveDataToFile(
    JSON.stringify(capture, null, 2),
    "application/json",
    `${scenario}.json`
);
