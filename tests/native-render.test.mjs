import {beforeEach,it,expect,vi} from 'vitest';
import {setupFoundryEnv} from './helpers/foundry-env.mjs';
let renderer;
beforeEach(async()=>{vi.resetModules();await setupFoundryEnv({settings:{damageApplyMode:"dnd5e"}});renderer=await import('../src/utils/native-render.js');});
it('moves rendered native children without replacing their identity or deleting documents',async()=>{
 const node=document.createElement('li');node.className='chat-message';node.dataset.messageId='child';node.innerHTML='<header class="message-header"></header><div class="message-content"><damage-application></damage-application></div>';
 const control=node.querySelector('damage-application');
 const child={id:'child',type:'damage',visible:true,isContentVisible:true,rolls:[],renderHTML:async()=>node,flags:{},delete:vi.fn()};
 const parent={id:'parent',type:'usage',isContentVisible:true,flags:{rsreforged:{workflowVersion:2,quickRoll:true}},getAssociatedRolls:()=>[child]};
 const html=document.createElement('li');html.innerHTML='<div class="message-content">Native usage buttons</div>';
 await renderer.renderNativeMessage(parent,html);
 expect(html.querySelector('[data-rsr-message-id="child"] damage-application')).toBe(control);
 expect(control.closest('[data-message-id]').dataset.messageId).toBe('child');
 expect(child.delete).not.toHaveBeenCalled();
});
it('keeps private children and save responses out of public combined cards',async()=>{
 const hidden={id:'hidden',type:'damage',visible:true,isContentVisible:false,renderHTML:vi.fn()};
 const save={id:'save',type:'save',visible:true,isContentVisible:true,renderHTML:vi.fn()};
 const parent={id:'p',type:'usage',isContentVisible:true,flags:{rsreforged:{workflowVersion:2,quickRoll:true}},getAssociatedRolls:()=>[hidden,save]};
 const html=document.createElement('li');html.innerHTML='<div class="message-content"></div>';
 await renderer.renderNativeMessage(parent,html);
 expect(hidden.renderHTML).not.toHaveBeenCalled();expect(save.renderHTML).not.toHaveBeenCalled();
});
it('decorates saving-throw summaries with the real source ID', async () => {
 const source = { id:'save', type:'save', isContentVisible:true, rolls:[], flags:{} };
 game.messages.set('save', source);
 const html = document.createElement('li');
 html.innerHTML = '<div class="message-content"><div class="card-summary" data-message-id="save"><section class="icon-row"><button class="dice-roll"></button><div class="roll-breakdown"></div></section></div></div>';
 await renderer.renderNativeMessage({type:'usage',isContentVisible:true,flags:{}},html);
 expect(html.querySelector('.card-summary').dataset.rsrMessageId).toBe('save');
 expect(html.querySelector('.roll-breakdown').dataset.rsrRollIndex).toBe('0');
});
it('masks native totals and breakdowns while retaining the configured natural d20', async () => {
 await setupFoundryEnv({settings:{hideNpcRollMode:'attacks',hideNpcRollStyle:'total',enableD20Icons:true}});
 game.user.isGM=false;
 const message = {type:'attack',isContentVisible:true,rolls:[],getAssociatedActor:()=>({isOwner:false})};
 const html=document.createElement('li');
 html.innerHTML='<div class="message-content"><button class="dice-roll"><span class="result"><strong class="total">22</strong></span><span class="d20die"><span class="roll">17</span></span></button><div class="roll-breakdown">Hidden modifier</div></div>';
 await renderer.renderNativeMessage(message,html);
 expect(html.querySelector('.result .total').textContent).toBe('?');
 expect(html.querySelector('.d20die .roll').textContent).toBe('17');
 expect(html.querySelector('.roll-breakdown')).toBeNull();
});
