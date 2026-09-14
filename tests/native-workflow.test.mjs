import {beforeEach,describe,it,expect,vi} from 'vitest';
import {setupFoundryEnv} from './helpers/foundry-env.mjs';
let workflow, env;
beforeEach(async()=>{vi.resetModules();env=await setupFoundryEnv();workflow=await import('../src/utils/native-workflow.js');});
function fixture(){
 const calls=[];const actor={id:'actor'};const activity={id:'a',type:'attack',item:{},createConsumedFlag:()=>({hd:'1d8'}),getDamageConfig:()=>({rolls:[{}]})};
 const rollActivity={...activity,rollAttack:async(c,d,m)=>{calls.push(['attack',c,d,m]);const roll=new Roll('1d20');roll.isCritical=true;roll.options={ammunition:'arrow',attackMode:'twoHanded',ability:'dex'};return [roll];},rollDamage:async(c,d,m)=>{calls.push(['damage',c,d,m]);return [new Roll("1d8")];}};
 activity.item.clone=(data)=>{calls.push(['clone',data]);return {system:{activities:new Map([['a',rollActivity]])}};};activity.item.system={ammunitionOptions:[]};
 const parent={id:'parent',isAuthor:true,flags:{rsreforged:{workflowVersion:2,quickRoll:true}},system:{scaling:2,deltas:{item:{}}},getAssociatedActor:()=>actor,getAssociatedActivity:()=>activity,getAssociatedRolls:()=>[],update:async(data)=>{for(const [k,v] of Object.entries(data)){if(k.startsWith('flags.rsreforged.'))parent.flags.rsreforged[k.slice(17)]=v;}calls.push(['update',data]);}};
 game.messages.set(parent.id,parent);
 return {activity,parent,calls,rollActivity};
}
describe('native usage orchestration',()=>{
 it('uses finalized consumed/scaled clone and real typed children with native origins',async()=>{const {activity,parent,calls}=fixture();await workflow.runNativeUsage(activity,{}, {message:parent});expect(calls[0]).toEqual(['update',expect.objectContaining({'flags.rsreforged.workflowState':'running'})]);expect(calls.find(c=>c[0]==='clone')[1]).toEqual({'flags.dnd5e':{consumed:{hd:'1d8'},scaling:2}});const attack=calls.find(c=>c[0]==='attack');expect(attack[3]).toMatchObject({create:true,data:{system:{origin:'parent'}}});expect(attack[2]).toEqual({configure:false});expect(calls.find(c=>c[0]==='damage')[1]).toMatchObject({isCritical:true,attackMode:'twoHanded'});});
 it('runs once when repeated lifecycle callbacks overlap',async()=>{const f=fixture();await Promise.all([workflow.runNativeUsage(f.activity,{}, {message:f.parent}),workflow.runNativeUsage(f.activity,{}, {message:f.parent})]);expect(f.calls.filter(c=>c[0]==='attack')).toHaveLength(1);});
 it('does not execute from observers, unpersisted data or historical cards',async()=>{const f=fixture();f.parent.isAuthor=false;await workflow.runNativeUsage(f.activity,{}, {message:f.parent});f.parent.isAuthor=true;game.messages.delete(f.parent.id);await workflow.runNativeUsage(f.activity,{}, {message:f.parent});game.messages.set(f.parent.id,f.parent);delete f.parent.flags.rsreforged.workflowVersion;await workflow.runNativeUsage(f.activity,{}, {message:f.parent});expect(f.calls).toEqual([]);});
 it('honors manual damage mode without rolling damage',async()=>{await setupFoundryEnv({settings:{manualDamageMode:1}});const f=fixture();await workflow.runNativeUsage(f.activity,{}, {message:f.parent});expect(f.calls.filter(c=>c[0]==='damage')).toHaveLength(0);});
 it('does not replay interrupted work on reload',async()=>{const f=fixture();f.parent.flags.rsreforged.workflowState='running';await workflow.runNativeUsage(f.activity,{}, {message:f.parent});expect(f.calls).toEqual([]);});
});

it('forwards attack ability and exact privacy without applying a new global roll mode', async () => {
    const f = fixture();
    f.parent.whisper = ['gm'];
    f.parent.blind = true;
    await workflow.runNativeUsage(f.activity, {}, { message: f.parent });
    expect(f.calls.find(c => c[0] === 'damage')[1].ability).toBe('dex');
    expect(f.calls.find(c => c[0] === 'attack')[3]).toMatchObject({
        rollMode: false, data: { whisper: ['gm'], blind: true }
    });
});
it('records partial after a damage veto without repeating the attack', async () => {
    const f = fixture();
    f.rollActivity.rollDamage = async () => [];
    await workflow.runNativeUsage(f.activity, {}, { message: f.parent });
    expect(f.parent.flags.rsreforged.workflowState).toBe('partial');
    await workflow.runNativeUsage(f.activity, {}, { message: f.parent });
    expect(f.calls.filter(c => c[0] === 'attack')).toHaveLength(1);
});
it('records partial when damage throws after a completed attack', async () => {
    const f = fixture();
    f.rollActivity.rollDamage = async () => { throw new Error('damage veto'); };
    await expect(workflow.runNativeUsage(f.activity, {}, { message: f.parent })).rejects.toThrow('damage veto');
    expect(f.parent.flags.rsreforged.workflowState).toBe('partial');
});
it('uses a consumed ammunition snapshot when live ammunition is gone', () => {
    const f = fixture();
    const ammunitionItem = { name: 'Consumed arrow', system: { quantity: 0 } };
    f.parent.getAssociatedRolls = () => [{ type: 'attack', system: {
        ammunitionItem, ability: 'dex', mode: 'twoHanded'
    }, rolls: [{ isCritical: true }] }];
    expect(workflow.getNativeDamageConfig(f.parent)).toMatchObject({
        ammunition: ammunitionItem, ability: 'dex', attackMode: 'twoHanded', isCritical: true
    });
});

it('preserves distinct token target snapshots and an authoritative empty array', async () => {
    const f = fixture();
    f.parent.system.targets = [
        { actor: 'Actor.a', token: 'Scene.s.Token.a', ac: null },
        { actor: 'Actor.a', token: 'Scene.s.Token.b', ac: 18 }
    ];
    await workflow.runNativeUsage(f.activity, {}, { message: f.parent });
    expect(f.calls.find(c => c[0] === 'attack')[3].data.system.targets).toEqual(f.parent.system.targets);
    const empty = fixture();
    empty.parent.system.targets = [];
    await workflow.runNativeUsage(empty.activity, {}, { message: empty.parent });
    expect(empty.calls.find(c => c[0] === 'attack')[3].data.system.targets).toEqual([]);
});
it('retains an explicit null attack target for total cover', async () => {
    const f = fixture();
    f.parent.system.targets = [{ actor: 'Actor.a', token: 'Scene.s.Token.a', ac: null }];
    await workflow.runNativeUsage(f.activity, {}, { message: f.parent });
    expect(f.calls.find(c => c[0] === 'attack')[1]).toHaveProperty('target', null);
});
it('prepares supplementary d20s once without changing the native normal total', async () => {
    await setupFoundryEnv({settings:{alwaysRollMulti:true}});
    const roll = new CONFIG.Dice.D20Roll('1d20 + 3');
    roll.dice=[{number:1,faces:20,modifiers:[],results:[{result:8,active:true}]}];
    roll.total=11;
    vi.spyOn(Roll.prototype, 'evaluate').mockImplementation(async function () {
        this.dice=[{faces:20,results:[{result:14,active:true}]}];return this;
    });
    const message = {id:'alternate',isAuthor:true,flags:{rsreforged:{quickRoll:true}},rolls:[roll]};
    const before = roll.total;
    message.update = vi.fn(async data => { message.rolls=data.rolls.map(r=>Roll.fromData(r)); });
    await workflow.seedNativeAlternates(message);
    expect(message.rolls[0].total).toBe(before);
    expect(message.rolls[0].options.rsreforgedAlternates.length).toBeGreaterThan(0);
    await workflow.seedNativeAlternates(message);
    expect(message.update).toHaveBeenCalledTimes(1);
});
