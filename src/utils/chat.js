import { MODULE_SHORT } from "../module/const.js";
import { MODULE_MIDI } from "../module/integration.js";
import { TEMPLATE } from "../module/templates.js";
import { ActivityUtility } from "./activity.js";
import { CoreUtility } from "./core.js";
import { DialogUtility } from "./dialog.js";
import { LogUtility } from "./log.js";
import { RenderUtility } from "./render.js";
import { ROLL_STATE, ROLL_TYPE, RollUtility } from "./roll.js";
import { SETTING_NAMES, SettingsUtility } from "./settings.js";

export const MESSAGE_TYPE = {
    ROLL: "roll",
    USAGE: "usage",
}

export class ChatUtility {
    static getMessageRolls(message) {
        const flagRolls = message.flags?.[MODULE_SHORT]?.rolls;
        if (flagRolls && Array.isArray(flagRolls)) {
            return flagRolls.map(r => {
                if (r instanceof Roll) return r;
                try { return Roll.fromData(r); } catch(e) { return null; }
            }).filter(r => r);
        }
        return Array.from(message.rolls || []);
    }

    static async processChatMessage(message, html) {
        if (!message || !html) return;
        
        if (!message.flags) message.flags = {};

        const type = ChatUtility.getMessageType(message);

        if (type === ROLL_TYPE.ACTIVITY && message.isAuthor) {
            message.flags[MODULE_SHORT] = message.flags[MODULE_SHORT] || {};
            if (message.flags[MODULE_SHORT].quickRoll === undefined) {
                message.flags[MODULE_SHORT].quickRoll = !SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_VANILLA_ENABLED);
                message.flags[MODULE_SHORT].processed = false;

                const activity = ActivityUtility._getActivityFromMessage(message);
                if (activity) {
                    ActivityUtility.setRenderFlags(activity, message);
                }
            }
        }

        if (SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_VANILLA_ENABLED) && (!message.flags[MODULE_SHORT] || !message.flags[MODULE_SHORT].quickRoll)) {
            _processVanillaMessage(message);
            await $(html).addClass("rsr-hide");
        }

        if (!message.flags[MODULE_SHORT] || !message.flags[MODULE_SHORT].quickRoll) return;

        if (!message.flags[MODULE_SHORT].processed) {
            await $(html).addClass("rsr-hide");

            if (type == ROLL_TYPE.ACTIVITY && message.isAuthor) {
                if (message._rsrIsProcessing) return;
                message._rsrIsProcessing = true;

                if (CoreUtility.hasModule(MODULE_MIDI)) {
                    const activityType = ChatUtility.getActivityType(message);
                    if (activityType == ROLL_TYPE.ATTACK || (activityType == ROLL_TYPE.ABILITY_SAVE && message.flags[MODULE_SHORT].renderDamage)) {
                        message.flags[MODULE_SHORT].processed = true;
                    } else {
                        await ActivityUtility.runActivityActions(message);
                    }  
                } else {
                    await ActivityUtility.runActivityActions(message);
                }                
            }
            return;
        }

        // dnd5e 5.3.0: For usage (ACTIVITY) messages, ChatMessage5e.renderHTML() calls
        // this.system.getHTML() AFTER firing the renderChatMessageHTML hook. system.getHTML()
        // completely replaces .message-content innerHTML with the rendered usage-card template,
        // destroying any content RSR injects here. RSR's injection for usage cards is therefore
        // deferred to the dnd5e.renderChatMessage hook (via processUsageChatMessage), which
        // fires after system.getHTML() has finished and the DOM is stable.
        if (type === ROLL_TYPE.ACTIVITY) return;

        if (game.dice3d && game.dice3d.isEnabled() && message._dice3danimating) {
            await $(html).addClass("rsr-hide");
            await game.dice3d.waitFor3DAnimationByMessageID(message.id);
        }

        let content = $(html).find('.message-content');
        if (content.length === 0) content = $(html);
        
        if (message.isAuthor && SettingsUtility.getSettingValue(SETTING_NAMES.ALWAYS_ROLL_MULTIROLL) && !ChatUtility.isMessageMultiRoll(message)) {
            const newRolls = await _enforceDualRolls(message);

            if (message.flags[MODULE_SHORT].dual) {
                ChatUtility.updateChatMessage(message, {
                    flags: message.flags
                });
                return;
            }
        }

        await _injectContent(message, type, content);

        if (SettingsUtility.getSettingValue(SETTING_NAMES.OVERLAY_BUTTONS_ENABLED)) {
            let hoverSetupComplete = false;
            content.hover(async () => {
                if (!hoverSetupComplete) {
                    LogUtility.log("Injecting overlay hover buttons")
                    hoverSetupComplete = true;
                    await _injectOverlayButtons(message, content);
                    _onOverlayHover(message, content);
                }
            });
        }

        if (message.flags[MODULE_SHORT].processed) {
            await $(html).removeClass("rsr-hide");
        }
        
        ui.chat.scrollBottom();
    }

    /**
     * Process a usage (ACTIVITY) chat message after dnd5e's system.getHTML() has rewritten
     * the card content. Called from the dnd5e.renderChatMessage hook, which fires at the
     * end of ChatMessage5e.renderHTML() after system.getHTML() has stabilised the DOM.
     *
     * This is the correct injection point for usage cards in dnd5e 5.3.0. The
     * renderChatMessageHTML hook fires too early — dnd5e overwrites the DOM immediately
     * after it returns.
     *
     * @param {ChatMessage5e} message  The chat message being rendered.
     * @param {HTMLElement}   html     The rendered message element (plain HTMLElement in V14).
     */
    static async processUsageChatMessage(message, html) {
        if (!message || !html) return;

        const flags = message.flags?.[MODULE_SHORT];
        if (!flags?.quickRoll || !flags?.processed) return;

        const type = ChatUtility.getMessageType(message);
        if (type !== ROLL_TYPE.ACTIVITY) return;

        if (!message.isContentVisible) return;

        const $html = html instanceof HTMLElement ? $(html) : html;

        if (game.dice3d && game.dice3d.isEnabled() && message._dice3danimating) {
            await $html.addClass("rsr-hide");
            await game.dice3d.waitFor3DAnimationByMessageID(message.id);
        }

        let content = $html.find('.message-content');
        if (content.length === 0) content = $html;

        if (message.isAuthor && SettingsUtility.getSettingValue(SETTING_NAMES.ALWAYS_ROLL_MULTIROLL) && !ChatUtility.isMessageMultiRoll(message)) {
            await _enforceDualRolls(message);

            if (flags.dual) {
                ChatUtility.updateChatMessage(message, { flags: message.flags });
                return;
            }
        }

        await _injectContent(message, type, content);

        if (SettingsUtility.getSettingValue(SETTING_NAMES.OVERLAY_BUTTONS_ENABLED)) {
            let hoverSetupComplete = false;
            content.hover(async () => {
                if (!hoverSetupComplete) {
                    LogUtility.log("Injecting overlay hover buttons");
                    hoverSetupComplete = true;
                    await _injectOverlayButtons(message, content);
                    _onOverlayHover(message, content);
                }
            });
        }

        await $html.removeClass("rsr-hide");
        ui.chat.scrollBottom();
    }

    static async updateChatMessage(message, update = {}, context = {}) {
        if (message instanceof ChatMessage) {
            if (update.rolls && Array.isArray(update.rolls)) {
                update.rolls = update.rolls.map(r => (r && typeof r.toJSON === "function") ? r.toJSON() : r);
            }
            if (!update.flags) update.flags = message.flags;
            await message.update(update, context);
        }
    }

    static getMessageType(message) {
        const t = message.type;

        // dnd5e 5.3.0: usage messages have type "usage" (plain string).
        if (t === "usage" || t === "dnd5e.usage") return ROLL_TYPE.ACTIVITY;

        // Roll messages use type "roll" and store the specific roll type in flags.
        // message.system?.roll?.type is checked first as a future-proofing measure but
        // dnd5e 5.3.0 does not register a system data model for "roll" typed messages,
        // so flags.dnd5e.roll.type is the live path.
        if (t === "roll" || t === "dnd5e.roll") {
            return message.system?.roll?.type ?? message.flags?.dnd5e?.roll?.type ?? null;
        }

        // Legacy V12 fallbacks for messages created before dnd5e 4.x.
        if (message.flags?.dnd5e?.messageType === MESSAGE_TYPE.USAGE || !!message.flags?.dnd5e?.use) return ROLL_TYPE.ACTIVITY;
        if (message.flags?.dnd5e?.messageType === MESSAGE_TYPE.ROLL || !!message.flags?.dnd5e?.roll) {
            return message.flags?.dnd5e?.roll?.type ?? null;
        }
        
        return null;
    }

    static getActivityType(message) {
        // dnd5e 5.3.0: message.system.activity is a getter on UsageMessageData that calls
        // getAssociatedActivity(), so both paths return the same activity object.
        // flags.dnd5e.activity.type is the reliable stored path for all message versions.
        return message.flags?.dnd5e?.activity?.type ?? message.system?.activity?.type;
    }

    // dnd5e 5.3.0: getAssociatedActor() is now a native ChatMessage5e method. Use it as the
    // primary path for actor resolution. The manual speaker fallback is kept for edge cases
    // where the message is not a full ChatMessage5e instance (e.g. pre-create hooks).
    static getActorFromMessage(message) {
        if (typeof message.getAssociatedActor === "function") {
            const actor = message.getAssociatedActor();
            if (actor) return actor;
        }

        // Manual fallback using speaker data.
        if (message.speaker?.token && message.speaker?.scene) {
            const token = game.scenes.get(message.speaker.scene)?.tokens?.get(message.speaker.token);
            if (token?.actor) return token.actor;
        }
        if (message.speaker?.actor) {
            return game.actors.get(message.speaker.actor) ?? null;
        }
        return null;
    }

    static isMessageMultiRoll(message) {
        const firstRoll = ChatUtility.getMessageRolls(message)[0];
        return (message.flags[MODULE_SHORT].advantage || message.flags[MODULE_SHORT].disadvantage || message.flags[MODULE_SHORT].dual
            || (firstRoll && firstRoll.options?.advantageMode !== CONFIG.Dice.D20Roll.ADV_MODE.NORMAL)) ?? false;
    }

    static isMessageCritical(message) {
        return message.flags[MODULE_SHORT].isCritical ?? false;
    }
}

function _onOverlayHover(message, html) {
    const hasPermission = game.user.isGM || message?.isAuthor;
    const isItem = ChatUtility.getMessageType(message) === ROLL_TYPE.ACTIVITY;

    html.find('.rsr-overlay').show();
    html.find('.rsr-overlay-multiroll').toggle(hasPermission && !ChatUtility.isMessageMultiRoll(message));
    html.find('.rsr-overlay-crit').toggle(hasPermission && isItem && !ChatUtility.isMessageCritical(message));
}

function _onOverlayHoverEnd(html) {
    html.find(".rsr-overlay").attr("style", "display: none;");
}

function _onTooltipHover(message, html) {
    const controlled = SettingsUtility._applyDamageToSelected && canvas?.tokens?.controlled?.length > 0;
    const targeted = SettingsUtility._applyDamageToTargeted && game?.user?.targets?.size > 0;

    if (controlled || targeted) {
        html.find('.rsr-damage-buttons').show();
        html.find('.rsr-damage-buttons').removeAttr("style");
    }
}

function _onTooltipHoverEnd(html) {
    html.find(".rsr-damage-buttons").attr("style", "display: none;height: 0px");
}

function _onDamageHover(message, html) {
    const controlled = SettingsUtility._applyDamageToSelected && canvas?.tokens?.controlled?.length > 0;
    const targeted = SettingsUtility._applyDamageToTargeted && game?.user?.targets?.size > 0;

    if (controlled || targeted) {
        html.find('.rsr-damage-buttons-xl').show();
    }
}

function _onDamageHoverEnd(html) {
    html.find(".rsr-damage-buttons-xl").attr("style", "display: none;");
}

function _setupCardListeners(message, html) {
    if (SettingsUtility.getSettingValue(SETTING_NAMES.MANUAL_DAMAGE_MODE) > 0) {
        html.find('.card-buttons').find(`[data-action='rsr-${ROLL_TYPE.DAMAGE}']`).click(async event => {
            await _processDamageButtonEvent(message, event);
        });
    }
    
    if (SettingsUtility.getSettingValue(SETTING_NAMES.DAMAGE_BUTTONS_ENABLED)) {
        html.find('.rsr-damage-buttons button').click(async event => {
            await _processApplyButtonEvent(message, event);
        });

        html.find('.rsr-damage-buttons-xl button').click(async event => {
            await _processApplyTotalButtonEvent(message, event);
        });
    }

    html.find(`[data-action='rsr-${ROLL_TYPE.CONCENTRATION}']`).click(async event => {
        await _processBreakConcentrationButtonEvent(message, event);
    });
}

function _processVanillaMessage(message) {
    if (typeof message.updateSource === "function") {
        message.updateSource({
            [`flags.${MODULE_SHORT}`]: {
                quickRoll: true,
                processed: true,
                useConfig: false
            }
        });
    } else {
        message.flags[MODULE_SHORT] = {
            quickRoll: true,
            processed: true,
            useConfig: false
        };
    }
}

async function _enforceDualRolls(message) {
    let dual = false;
    let newRolls = ChatUtility.getMessageRolls(message);
    
    for (let i = 0; i < newRolls.length; i++) {
        if (newRolls[i] instanceof CONFIG.Dice.D20Roll || newRolls[i].class === "D20Roll") {
            newRolls[i] = await RollUtility.ensureMultiRoll(newRolls[i]);
            dual = true;
        }
    }
    
    message.flags[MODULE_SHORT].dual = dual;
    message.flags[MODULE_SHORT].rolls = newRolls.map(r => r.toJSON ? r.toJSON() : r);
    return newRolls;
}

function _safeInsert(sectionHTML, targetHTML) {
    if (targetHTML.is('.message-content') || targetHTML.hasClass('chat-message') || targetHTML.length === 0) {
        targetHTML.append(sectionHTML);
    } else {
        sectionHTML.insertBefore(targetHTML);
    }
}

async function _injectContent(message, type, html) {
    LogUtility.log("Injecting content into chat message");
    
    // dnd5e 5.3.0: getOriginatingMessage() is a native ChatMessage5e method that returns
    // the usage card a roll message was spawned from, or `this` when no link exists.
    // We only treat it as a real parent when it is a different message.
    let parent = null;
    if (typeof message.getOriginatingMessage === "function") {
        const origin = message.getOriginatingMessage();
        if (origin && origin !== message) parent = origin;
    }
    if (!parent && typeof message.getAssociatedMessage === "function") parent = message.getAssociatedMessage();
    if (!parent && message.flags?.dnd5e?.originatingMessage) parent = game.messages.get(message.flags.dnd5e.originatingMessage);
    if (!parent && message.system?.message) parent = game.messages.get(message.system.message);
    
    message.flags[MODULE_SHORT].displayChallenge = parent?.shouldDisplayChallenge ?? message.shouldDisplayChallenge;
    message.flags[MODULE_SHORT].displayAttackResult = game.user.isGM || (game.settings.get("dnd5e", "attackRollVisibility") !== "none");

    switch (type) {
        case ROLL_TYPE.DAMAGE:
            if (!message.flags?.dnd5e?.item?.id && !message.system?.item?.id) {
                const enricher = html.find('.dice-roll');
                
                html.parent().find('.flavor-text').text('');
                html.prepend('<div class="dnd5e2 chat-card"></div>');
                html.find('.chat-card').append(enricher);                        

                message.flags[MODULE_SHORT].renderDamage = true;
                
                const mRolls = ChatUtility.getMessageRolls(message);
                message.flags[MODULE_SHORT].isCritical = mRolls[0]?.isCritical;

                await _injectDamageRoll(message, enricher);

                if (SettingsUtility.getSettingValue(SETTING_NAMES.DAMAGE_BUTTONS_ENABLED)) {                
                    await _injectApplyDamageButtons(message, html);
                }
                enricher.remove();
                break;
            }
            // falls through to ATTACK when item id is present
        case ROLL_TYPE.ATTACK:
            if (parent && parent.flags[MODULE_SHORT] && message.isAuthor) {
                parent.flags.dnd5e ??= {};
                if (type === ROLL_TYPE.ATTACK) {
                    parent.flags[MODULE_SHORT].renderAttack = true;
                    // dnd5e 5.3.0: roll data lives in flags.dnd5e.roll; system.roll is
                    // undefined since there is no data model for "roll" typed messages.
                    parent.flags.dnd5e.roll = message.flags?.dnd5e?.roll ?? message.system?.roll;
                    // dnd5e 5.3.0: do NOT set parent.flags.dnd5e.originatingMessage to
                    // parent.id — that would make getOriginatingMessage() return the usage
                    // card itself for all future lookups, breaking the registry. The
                    // incoming roll message is deleted below, so there is no value in
                    // registering it with the MessageRegistry either.
                }

                if (type === ROLL_TYPE.DAMAGE) {
                    parent.flags[MODULE_SHORT].renderDamage = true;
                    
                    const mRolls = ChatUtility.getMessageRolls(message);
                    parent.flags[MODULE_SHORT].isCritical = mRolls[0]?.isCritical;
                    
                    const actType = message.flags?.dnd5e?.activity?.type ?? message.system?.activity?.type;
                    parent.flags[MODULE_SHORT].isHealing = actType === "heal";
                }

                parent.flags[MODULE_SHORT].quickRoll = true;                
                
                let newParentRolls = ChatUtility.getMessageRolls(parent);
                let newMsgRolls = ChatUtility.getMessageRolls(message);
                newParentRolls.push(...newMsgRolls);

                parent.flags[MODULE_SHORT].rolls = newParentRolls.map(r => r.toJSON ? r.toJSON() : r);

                ChatUtility.updateChatMessage(parent, {
                    flags: parent.flags,
                    flavor: "vanilla",
                });

                message.flags[MODULE_SHORT].processed = false;
                message.delete();
                return;
            }
            break;
        case ROLL_TYPE.SKILL:
        case ROLL_TYPE.ABILITY_SAVE:
        case ROLL_TYPE.ABILITY_TEST:
        case ROLL_TYPE.DEATH_SAVE:
        case ROLL_TYPE.TOOL:
            if (!message.isContentVisible) return;

            const roll = ChatUtility.getMessageRolls(message)[0];
            if (!roll) return;
            
            roll.options.displayChallenge = message.flags[MODULE_SHORT].displayChallenge;
            roll.options.forceSuccess = message.flags?.dnd5e?.roll?.forceSuccess ?? message.system?.roll?.forceSuccess;

            const render = await RenderUtility.render(TEMPLATE.MULTIROLL, { roll, key: type })
            html.find('.dice-total').replaceWith(render);
            html.find('.dice-tooltip').prepend(html.find('.dice-formula'));

            if (message.flags[MODULE_SHORT].isConcentration)
            {
                await _injectBreakConcentrationButton(message, html)
            }
            break;
        case ROLL_TYPE.ACTIVITY:
            if (!message.isContentVisible) return;

            let actions = html.find('.card-buttons');
            if (actions.length === 0) actions = html.find('.card-activities');
            if (actions.length === 0) actions = html.find('.dnd5e2.chat-card');
            if (actions.length === 0) actions = html;
            
            html.find('.dice-roll').remove();

            if (message.flags[MODULE_SHORT].renderAttack || message.flags[MODULE_SHORT].renderAttack === false) {
                html.find('[data-action=rollAttack], [data-action=attack]').remove();
                await _injectAttackRoll(message, actions);

                html.find('.rsr-section-attack').append(html.find('.supplement'));
                html.find('.supplement').removeClass('supplement').addClass('rsr-supplement');
            }
            
            if (message.flags[MODULE_SHORT].manualDamage || message.flags[MODULE_SHORT].renderDamage) {
                html.find('[data-action=rollDamage], [data-action=damage]').remove();
                html.find('[data-action=rollHealing], [data-action=heal]').remove();
            }

            if (message.flags[MODULE_SHORT].manualDamage) {
                await _injectDamageButton(message, actions);
            }

            if (message.flags[MODULE_SHORT].renderDamage) {
                await _injectDamageRoll(message, actions);
            }

            if (message.flags[MODULE_SHORT].renderFormula) {
                html.find('[data-action=rollFormula], [data-action=formula]').remove();
                await _injectFormulaRoll(message, actions);
            }

            if (SettingsUtility.getSettingValue(SETTING_NAMES.DAMAGE_BUTTONS_ENABLED)) {
                await _injectApplyDamageButtons(message, html);
            }

            html.find('.dnd5e2.chat-card').not('.activation-card, .usage-card').remove();
            const rootParent = html.closest('.message-content');
            if (rootParent.length) rootParent.find('> .dice-roll').remove(); 
            break;
        default:
            break;
    }

    _setupCardListeners(message, html);
}

async function _injectAttackRoll(message, html) {
    const ChatMessage5e = CONFIG.ChatMessage.documentClass;
    const rolls = ChatUtility.getMessageRolls(message);
    
    const roll = rolls.find(r => r instanceof CONFIG.Dice.D20Roll || r.class === "D20Roll" || r.constructor?.name === "D20Roll");

    if (!roll) return;
    
    RollUtility.resetRollGetters(roll);

    roll.options.displayChallenge = message.flags[MODULE_SHORT].displayAttackResult;

    // dnd5e 5.3.0: Use getAssociatedActor() instead of game.actors.get(speaker.actor) so
    // that token actors (which are not in game.actors) are correctly resolved. Previously
    // this always returned null for unlinked tokens, causing hideFinalAttack to silently
    // default to false for GMs viewing other players' rolls.
    const actor = ChatUtility.getActorFromMessage(message);
    roll.options.hideFinalAttack = SettingsUtility.getSettingValue(SETTING_NAMES.HIDE_FINAL_RESULT_ENABLED) && !actor?.isOwner;

    const render = await RenderUtility.render(TEMPLATE.MULTIROLL, { roll, key: ROLL_TYPE.ATTACK });
    const chatData = await roll.toMessage({}, { create: false });
    // Foundry V14 removed CONST.CHAT_MESSAGE_TYPES entirely. The previous workaround of
    // setting chatData.type to the numeric OOC value now coerces to the string "1", which
    // fails ChatMessage5e's strict type validation and throws a DataModelValidationError
    // before renderHTML() is ever reached. roll.toMessage() already sets type:"roll" which
    // is a valid Foundry V14 type, so we leave it alone.

    const rollHTML = $(await new ChatMessage5e(chatData).renderHTML()).find('.dice-roll');   
    rollHTML.find('.dice-total').replaceWith(render);
    rollHTML.find('.dice-tooltip').prepend(rollHTML.find('.dice-formula'));

    if (roll.options.hideFinalAttack) {
        rollHTML.find('.dice-tooltip').find('.tooltip-part.constant').remove();
        rollHTML.find('.dice-formula').text("1d20 + " + CoreUtility.localize(`${MODULE_SHORT}.chat.hide`));
    }   

    // dnd5e 5.3.0: getAssociatedActor() correctly resolves token actors.
    const ammo = ChatUtility.getActorFromMessage(message)?.items?.get(message.flags[MODULE_SHORT].ammunition)?.name;

    const sectionHTML = $(await RenderUtility.render(TEMPLATE.SECTION,
    {
        section: `rsr-section-${ROLL_TYPE.ATTACK}`,
        title: CoreUtility.localize("DND5E.Attack"),
        icon: "<dnd5e-icon src=\"systems/dnd5e/icons/svg/trait-weapon-proficiencies.svg\"></dnd5e-icon>",
        subtitle: ammo ? `${CoreUtility.localize("DND5E.CONSUMABLE.Type.Ammunition.Label")} - ${ammo}` : undefined
    }));
    
    $(sectionHTML).append(rollHTML);
    _safeInsert(sectionHTML, html);
}

async function _injectFormulaRoll(message, html) {
    const ChatMessage5e = CONFIG.ChatMessage.documentClass;
    const rolls = ChatUtility.getMessageRolls(message);
    
    const roll = rolls.find(r => r instanceof CONFIG.Dice.BasicRoll || r.class === "BasicRoll" || r.constructor?.name === "BasicRoll");

    if (!roll) return;

    const chatData = await roll.toMessage({}, { create: false });
    // Foundry V14: see comment in _injectAttackRoll. type:"roll" is set by toMessage().

    const rollHTML = $(await new ChatMessage5e(chatData).renderHTML()).find('.dice-roll');
    rollHTML.find('.dice-tooltip').prepend(rollHTML.find('.dice-formula'));

    const sectionHTML = $(await RenderUtility.render(TEMPLATE.SECTION,
    {
        section: `rsr-section-${ROLL_TYPE.FORMULA}`,
        title: message.flags[MODULE_SHORT].formulaName ?? CoreUtility.localize("DND5E.OtherFormula"),
        icon: "<i class=\"fas fa-dice\"></i>"
    }));
    
    $(sectionHTML).append(rollHTML);
    _safeInsert(sectionHTML, html);
}

async function _injectDamageRoll(message, html) {
    const ChatMessage5e = CONFIG.ChatMessage.documentClass;
    const rolls = ChatUtility.getMessageRolls(message).filter(r => r instanceof CONFIG.Dice.DamageRoll || r.class === "DamageRoll" || r.constructor?.name === "DamageRoll");

    if (!rolls || rolls.length === 0) return;

    const chatData = await CONFIG.Dice.DamageRoll.toMessage(rolls, {}, { create: false });
    // Foundry V14: see comment in _injectAttackRoll. type:"roll" is set by toMessage().

    const rollHTML = $(await new ChatMessage5e(chatData).renderHTML()).find('.dice-roll');
    rollHTML.find('.dice-tooltip').prepend(rollHTML.find('.dice-formula'));
    rollHTML.find('.dice-result').addClass('rsr-damage');

    const header = message.flags[MODULE_SHORT].isHealing
        ? {            
            section: `rsr-section-${ROLL_TYPE.DAMAGE}`,
            title: CoreUtility.localize("DND5E.Healing"),
            icon: "<dnd5e-icon src=\"systems/dnd5e/icons/svg/damage/healing.svg\"></dnd5e-icon>"
        } 
        : {
            section: `rsr-section-${ROLL_TYPE.DAMAGE}`,
            title: `${CoreUtility.localize("DND5E.Damage")} ${message.flags[MODULE_SHORT].versatile ? "(" + CoreUtility.localize("DND5E.Versatile") + ")": ""}`,
            icon: "<i class=\"fas fa-burst\"></i>",
            subtitle: message.flags[MODULE_SHORT].isCritical ? `${CoreUtility.localize("DND5E.CriticalHit")}!` : undefined,
            critical: message.flags[MODULE_SHORT].isCritical
        }

    const sectionHTML = $(await RenderUtility.render(TEMPLATE.SECTION, header));
    
    $(sectionHTML).append(rollHTML);
    _safeInsert(sectionHTML, html);
}

async function _injectDamageButton(message, html) {
    const button = message.flags[MODULE_SHORT].isHealing
        ? {
            title: CoreUtility.localize("DND5E.Healing"),
            icon: "<dnd5e-icon src=\"systems/dnd5e/icons/svg/damage/healing.svg\"></dnd5e-icon>"
        } 
        : {
            title: CoreUtility.localize("DND5E.Damage"),
            icon: "<i class=\"fas fa-burst\"></i>"
        }

    const render = await RenderUtility.render(TEMPLATE.BUTTON, 
    { 
        action: ROLL_TYPE.DAMAGE,
        ...button
    });

    html.prepend($(render));
}

async function _injectBreakConcentrationButton(message, html) {
    const button = {
        title: CoreUtility.localize("DND5E.ConcentrationBreak"),
        icon: "<i class=\"fas fa-xmark\"></i>"
    }

    const render = await RenderUtility.render(TEMPLATE.BUTTON, 
    { 
        action: ROLL_TYPE.CONCENTRATION,
        ...button
    });

    html.append($(render).addClass('rsr-concentration-buttons'));
}

async function _injectApplyDamageButtons(message, html) {
    const render = await RenderUtility.render(TEMPLATE.DAMAGE_BUTTONS, {});

    const tooltip = html.find('.rsr-damage .dice-tooltip .tooltip-part');

    if (tooltip.length > 1) {
        tooltip.append($(render));
    }

    const total = html.find('.rsr-damage');
    const renderXL = $(render);
    renderXL.removeClass('rsr-damage-buttons');
    renderXL.addClass('rsr-damage-buttons-xl');
    renderXL.find('.rsr-indicator').remove();
    total.append(renderXL);

    if (!SettingsUtility.getSettingValue(SETTING_NAMES.ALWAYS_SHOW_BUTTONS)) {
        tooltip.each((i, el) => {        
            $(el).find('.rsr-damage-buttons').attr("style", "display: none;height: 0px");
            $(el).hover(_onTooltipHover.bind(this, message, $(el)), _onTooltipHoverEnd.bind(this, $(el)));
        })

        _onDamageHoverEnd(total);
        total.hover(_onDamageHover.bind(this, message, total), _onDamageHoverEnd.bind(this, total));
    }
}

async function _injectOverlayButtons(message, html) {
    await _injectOverlayRetroButtons(message, html);
    await _injectOverlayHeaderButtons(message, html);   
    
    _onOverlayHoverEnd(html);
    html.hover(_onOverlayHover.bind(this, message, html), _onOverlayHoverEnd.bind(this, html));
}

async function _injectOverlayRetroButtons(message, html) {
    const overlayMultiRoll = await RenderUtility.render(TEMPLATE.OVERLAY_MULTIROLL, {});

    html.find('.rsr-multiroll .dice-total').append($(overlayMultiRoll));

    html.find(".rsr-overlay-multiroll div").click(async event => {
        await _processRetroAdvButtonEvent(message, event);
    });
    
    const overlayCrit = await RenderUtility.render(TEMPLATE.OVERLAY_CRIT, {});

    html.find('.rsr-damage .dice-total').append($(overlayCrit));

    html.find(".rsr-overlay-crit div").click(async event => {
        await _processRetroCritButtonEvent(message, event);
    });
}

async function _injectOverlayHeaderButtons(message, html) {

}

async function _processDamageButtonEvent(message, event) {
    event.preventDefault();
    event.stopPropagation();

    message.flags[MODULE_SHORT].manualDamage = false
    message.flags[MODULE_SHORT].renderDamage = true;  

    await ActivityUtility.runActivityAction(message, ROLL_TYPE.DAMAGE);
}

async function _processBreakConcentrationButtonEvent(message, event) {
    event.preventDefault();
    event.stopPropagation();

    const actor = ChatUtility.getActorFromMessage(message);

    if (actor) {
        const ActiveEffect5e = CONFIG.ActiveEffect.documentClass;
        ActiveEffect5e._manageConcentration(event, actor);
    }
}

async function _processApplyButtonEvent(message, event) {
    event.preventDefault();
    event.stopPropagation();
    
    const button = event.currentTarget;
    const action = button.dataset.action;
    const multiplier = button.dataset.multiplier;
    const dice = $(button).closest('.tooltip-part').find('.dice');

    if (action !== "rsr-apply-damage" && action !== "rsr-apply-temp") return;

    const targets = CoreUtility.getCurrentTargets();

    if (targets.size === 0) return;

    const isTempHP = action === "rsr-apply-temp";
    const damage = _getApplyDamage(message, dice, multiplier);

    await Promise.all(Array.from(targets).map(async t => {
        const target = t.actor;        
        return isTempHP ? await target.applyTempHP(damage.value) : await target.applyDamage([ damage ], { multiplier });
    }));

    setTimeout(() => {
        if (canvas.hud.token._displayState && canvas.hud.token._displayState !== 0) {
            canvas.hud.token.render();
        }
    }, 50);
}

async function _processApplyTotalButtonEvent(message, event) {
    event.preventDefault();
    event.stopPropagation();

    const button = event.currentTarget;
    const action = button.dataset.action;
    const multiplier = Number(button.dataset.multiplier);

    if (action !== "rsr-apply-damage" && action !== "rsr-apply-temp") return;

    const targets = CoreUtility.getCurrentTargets();

    if (targets.size === 0) return;
    
    const isTempHP = action === "rsr-apply-temp";
    const damages = [];

    const children = $(button).closest('.dice-roll').find('.rsr-damage .dice-tooltip .tooltip-part .dice');

    children.each((i, el) => {
        damages.push(_getApplyDamage(message, $(el), multiplier));
    })

    await Promise.all(Array.from(targets).map(async t => {
        const target = t.actor;        
        return isTempHP 
            ? await target.applyTempHP(damages.reduce((accumulator, currentValue) => accumulator + currentValue.value, 0)) 
            : await target.applyDamage(damages, { multiplier: Math.abs(multiplier) });
    }));

    setTimeout(() => {
        if (canvas.hud.token._displayState && canvas.hud.token._displayState !== 0) {
            canvas.hud.token.render();
        }
    }, 50);
}

function _getApplyDamage(message, dice, multiplier) {
    const total = dice.find('.total')
    const value = parseInt(total.find('.value').text());
    const type = total.find('.label').text().toLowerCase();

    const rolls = ChatUtility.getMessageRolls(message);
    const properties = new Set(rolls.find(r => r instanceof CONFIG.Dice.DamageRoll || r.class === "DamageRoll")?.options?.properties ?? []);
    return { value: value, type: multiplier < 0 ? 'healing' : type, properties: properties };
}

async function _processRetroAdvButtonEvent(message, event) {
    event.preventDefault();
    event.stopPropagation();

    const button = event.currentTarget;
    const action = button.dataset.action;
    const state = button.dataset.state;
    const key = $(button).closest('.rsr-multiroll')[0].dataset.key;

    if (action === "rsr-retro") {
        if (SettingsUtility.getSettingValue(SETTING_NAMES.CONFIRM_RETRO_ADV)) {        
            const dialogOptions = {
                width: 100,
                top: event ? event.clientY - 50 : null,
                left: window.innerWidth - 510
            }
    
            const target = state === ROLL_STATE.ADV ? CoreUtility.localize("DND5E.Advantage") : CoreUtility.localize("DND5E.Disadvantage");
            const confirmed = await DialogUtility.getConfirmDialog(CoreUtility.localize(`${MODULE_SHORT}.chat.prompts.retroAdv`, { target }), dialogOptions);
    
            if (!confirmed) return;
        }
        
        message.flags[MODULE_SHORT].advantage = state === ROLL_STATE.ADV;
        message.flags[MODULE_SHORT].disadvantage = state === ROLL_STATE.DIS;

        const originalRolls = ChatUtility.getMessageRolls(message);
        const rollIndex = originalRolls.findIndex(r => r instanceof CONFIG.Dice.D20Roll || r.class === "D20Roll");
        
        if (rollIndex > -1) {
            const upgradedRoll = await RollUtility.upgradeRoll(originalRolls[rollIndex], state);
            if (upgradedRoll) originalRolls[rollIndex] = upgradedRoll;
        }

        if (key !== ROLL_TYPE.ATTACK && key !== ROLL_TYPE.TOOL_CHECK && originalRolls[rollIndex]) {
            message.flavor += originalRolls[rollIndex].hasAdvantage 
                ? ` (${CoreUtility.localize("DND5E.Advantage")})` 
                : ` (${CoreUtility.localize("DND5E.Disadvantage")})`;
        }

        message.flags[MODULE_SHORT].rolls = originalRolls.map(r => r.toJSON ? r.toJSON() : r);

        ChatUtility.updateChatMessage(message, { 
            flags: message.flags,
            flavor: message.flavor
        });

        if (!game.dice3d || !game.dice3d.isEnabled()) {
            CoreUtility.playRollSound();
        }
    }
}

async function _processRetroCritButtonEvent(message, event) {
    event.preventDefault();
    event.stopPropagation();

    const button = event.currentTarget;
    const action = button.dataset.action;

    if (action === "rsr-retro") {
        if (SettingsUtility.getSettingValue(SETTING_NAMES.CONFIRM_RETRO_CRIT)) {        
            const dialogOptions = {
                width: 100,
                top: event ? event.clientY - 50 : null,
                left: window.innerWidth - 510
            }
    
            const confirmed = await DialogUtility.getConfirmDialog(CoreUtility.localize(`${MODULE_SHORT}.chat.prompts.retroCrit`), dialogOptions);
    
            if (!confirmed) return;
        }
        
        message.flags[MODULE_SHORT].isCritical = true;

        const originalRolls = ChatUtility.getMessageRolls(message);
        let newRolls = Array.from(originalRolls);

        const rolls = originalRolls.filter(r => r instanceof CONFIG.Dice.DamageRoll || r.class === "DamageRoll");
        const crits = await ActivityUtility.getDamageFromMessage(message);

        // Retain original behavior for MIDI users if required
        if (CoreUtility.hasModule(MODULE_MIDI)) {
            newRolls = originalRolls;
        }

        for (let i = 0; i < rolls.length; i++) {
            const baseRoll = rolls[i];
            const critRoll = crits[i]

            for (const [j, term] of baseRoll.terms.entries()) {
                if (!(term instanceof foundry.dice.terms.Die)) {
                    continue;
                }

                critRoll.terms[j].results.splice(0, term.results.length, ...term.results);
            }

            RollUtility.resetRollGetters(critRoll);
            newRolls[originalRolls.indexOf(baseRoll)] = critRoll;
        }

        await CoreUtility.tryRollDice3D(crits);

        message.flags[MODULE_SHORT].rolls = newRolls.map(r => r.toJSON ? r.toJSON() : r);

        ChatUtility.updateChatMessage(message, {
            flags: message.flags
        });

        if (!game.dice3d || !game.dice3d.isEnabled()) {
            CoreUtility.playRollSound();
        }
    }
}
