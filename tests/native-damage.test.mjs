import {beforeEach,it,expect,vi} from 'vitest';
import {setupFoundryEnv} from './helpers/foundry-env.mjs';
let apply;
beforeEach(async()=>{vi.resetModules();await setupFoundryEnv();globalThis.dnd5e={dice:{aggregateDamageRolls:vi.fn(rolls=>rolls)}};apply=(await import('../src/utils/native-damage.js')).applyNativeDamage;});
it('applies authoritative types and properties with source identity',async()=>{
 const actor={isOwner:true,applyDamage:vi.fn()};
 const token={actor,document:{uuid:'Token.t'}};
 const message={id:'child',type:'damage',system:{},rolls:[{total:8,options:{type:'fire',properties:['magical']}}]};
 await apply(message,{multiplier:0.5,targets:new Set([token])});
 expect(actor.applyDamage).toHaveBeenCalledWith([{type:'fire',value:8,properties:new Set(['magical'])}],expect.objectContaining({multiplier:0.5,origin:message,isDelta:true}));
});
it('applies temp HP through native temp-HP rules and skips unowned actors',async()=>{
 const actor={isOwner:true,applyTempHP:vi.fn()},other={isOwner:false,applyTempHP:vi.fn()};game.user.isGM=false;
 await apply({type:'healing',rolls:[{total:9,options:{type:'temphp'}}],system:{}},{targets:new Set([{actor},{actor:other}])});
 expect(actor.applyTempHP).toHaveBeenCalledWith(9);expect(other.applyTempHP).not.toHaveBeenCalled();
});

it('uses native aggregation and automatic successful-save outcomes unless overridden', async () => {
    const actor = { isOwner: true, applyDamage: vi.fn() };
    const token = { actor, document: { uuid: 'Token.t' } };
    const message = { type: 'damage', rolls: [{ total: 10, options: { type: 'fire' } }],
        system: { onSave: 'half', origin: { system: { outcomes: new Map([['Token.t', 'success']]) } } } };
    dnd5e.dice.aggregateDamageRolls.mockReturnValue([
        { total: 6, options: { type: 'fire' } }, { total: 4, options: { type: 'cold' } }
    ]);
    await apply(message, { targets: new Set([token]) });
    expect(dnd5e.dice.aggregateDamageRolls).toHaveBeenCalledWith(message.rolls, { respectProperties: true });
    expect(actor.applyDamage.mock.calls[0][0].map(d => d.type)).toEqual(['fire', 'cold']);
    expect(actor.applyDamage.mock.calls[0][1].multiplier).toBe(0.5);
    await apply(message, { targets: new Set([token]), multiplier: 2 });
    expect(actor.applyDamage.mock.calls[1][1].multiplier).toBe(2);
});
