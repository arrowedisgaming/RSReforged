import {beforeEach, it, expect, vi} from 'vitest';
import {setupFoundryEnv} from './helpers/foundry-env.mjs';
let hooks, callbacks;
beforeEach(async()=>{
 vi.resetModules();await setupFoundryEnv({settings:{enableQuickActivity:true}});
 game.system={version:'6.0.1'};
 CONFIG.ChatMessage={dataModels:Object.fromEntries(['attack','damage','healing','check','save','generic'].map(t=>[t,{}]))};
 callbacks=new Map();Hooks.on=(name,cb)=>callbacks.set(name,cb);
 hooks=await import('../src/utils/hooks.js');hooks.HooksUtility.registerRollHooks();
});
it('leaves unsupported activities and message-free uses entirely native',()=>{
 const cb=callbacks.get('dnd5e.preUseActivity');
 for(const [type,create] of [['summon',true],['attack',false]]){
 const usage={subsequentActions:true},dialog={},message={create};
 cb({type},usage,dialog,message);
 expect(usage.subsequentActions).toBe(true);expect(message.data).toBeUndefined();
 }
});
it('registers finalized-use execution independently of rendering',()=>{
 expect(callbacks.has('dnd5e.postUseActivity')).toBe(true);
});
it('only seeds extra d20s in the initiating client, including same-user remote tabs', async () => {
 const workflow = await import('../src/utils/native-workflow.js');
 const seed = vi.spyOn(workflow, 'seedNativeAlternates').mockResolvedValue();
 hooks.HooksUtility.registerChatHooks();
 const message={id:'new-roll',isAuthor:true};
 const remoteOptions={rsreforgedInitiator:'another-client'};
 callbacks.get('createChatMessage')(message,remoteOptions,game.user.id);
 expect(seed).not.toHaveBeenCalled();
 const localOptions={};
 callbacks.get('preCreateChatMessage')(message,{},localOptions,game.user.id);
 callbacks.get('createChatMessage')(message,localOptions,game.user.id);
 expect(seed).toHaveBeenCalledOnce();
});
