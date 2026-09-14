import { CoreUtility } from './core.js';

/** Apply native roll data without deriving damage types or amounts from HTML. */
export async function applyNativeDamage(message, { multiplier, rollIndex, temporary = false,
    targets = CoreUtility.getCurrentTargets() } = {}) {
    const rolls = Number.isInteger(rollIndex) ? [message.rolls[rollIndex]] : message.rolls;
    const aggregate = dnd5e.dice.aggregateDamageRolls(rolls.filter(Boolean), { respectProperties: true });
    const damages = aggregate.map(roll => ({
        value: Math.max(0, roll.total),
        type: multiplier < 0 && !['temphp', 'maximum'].includes(roll.options.type) ? 'healing' : roll.options.type,
        properties: new Set(roll.options.properties ?? [])
    }));
    if (!damages.length || (multiplier !== undefined && !Number.isFinite(multiplier))) return;
    for (const token of targets) {
        const actor = token.actor;
        if (!actor || (!game.user.isGM && !actor.isOwner)) continue;
        const uuid = token.document?.uuid ?? token.uuid;
        const succeeded = message.system?.origin?.system?.outcomes?.get(uuid) === 'success';
        const saveMultiplier = succeeded ? ({ half: 0.5, none: 0, full: 1 }[message.system.onSave] ?? 1) : 1;
        const options = { multiplier: multiplier === undefined ? saveMultiplier : Math.abs(multiplier), origin: message, isDelta: true };
        if (damages.some(d => d.type === 'maximum') && (message.type === 'healing' || multiplier < 0)) options.only = 'healing';
        if (temporary || damages.every(d => d.type === 'temphp')) {
            await actor.applyTempHP(Math.floor(damages.reduce((sum, d) => sum + d.value, 0) * options.multiplier));
        } else await actor.applyDamage(damages, options);
    }
}
