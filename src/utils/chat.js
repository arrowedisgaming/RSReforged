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

    static suppressDnd5eEnrichedRollFlavor(message) {
        if (!message) return;
        if (ChatUtility.getMessageType(message) !== ROLL_TYPE.ACTIVITY) return;
        if (!message.flags?.[MODULE_SHORT]?.quickRoll || !message.flags?.[MODULE_SHORT]?.processed) return;
        if (!message.flags?.dnd5e?.item || !message.flags?.dnd5e?.roll) return;
        if (message._rsrSuppressedDnd5eRoll) return;

        message._rsrSuppressedDnd5eRoll = message.flags.dnd5e.roll;
        delete message.flags.dnd5e.roll;
    }

    static restoreDnd5eEnrichedRollFlavor(message) {
        if (!message?._rsrSuppressedDnd5eRoll) return;

        message.flags ??= {};
        message.flags.dnd5e ??= {};
        message.flags.dnd5e.roll ??= message._rsrSuppressedDnd5eRoll;
        delete message._rsrSuppressedDnd5eRoll;
    }

    static async processChatMessage(message, html) {
        if (!message || !html) return;
        
        if (!message.flags) message.flags = {};

        const type = ChatUtility.getMessageType(message);

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
                update.rolls = CoreUtility.serializeRolls(update.rolls);
            }
            if (!update.flags) update.flags = message.flags;
            await message.update(update, context);
        }
    }

    /**
     * Re-register a self-anchored attack card in dnd5e's MessageRegistry after its
     * attack roll was mutated post-creation (retroactive advantage/disadvantage, or a
     * bonus applied to the attack roll).
     *
     * RSR keeps authoritative rolls in flags.rsreforged.rolls and renders from them, but
     * condition modules (AC5e) and dnd5e's native attack->damage association read the
     * native message.rolls through the registry. Without this re-sync they would resolve
     * the *pre-mutation* attack roll (e.g. the flat d20 from before retro advantage),
     * silently mis-evaluating advantage-conditioned effects on a later damage roll.
     *
     * No-ops unless the card self-registered under the "attack" hook
     * (flags.dnd5e.originatingMessage === its own id), so it is safe to call after any
     * roll mutation. Mirrors ActivityUtility._registerCardAsAttack: refresh the live
     * document's rolls in-memory via updateSource (no DB write, no native re-render of
     * RSR's custom card), then re-track. The in-memory roll sync is intentionally not
     * persisted — the registry is rebuilt from flags on reload via prepareData -> track,
     * and the fix only needs to hold for the live session (mutate -> damage) workflow.
     * @param {ChatMessage} message The activation card whose attack roll changed.
     */
    static resyncAttackRegistry(message) {
        if (!message?.id || message.flags?.dnd5e?.originatingMessage !== message.id) return;

        try {
            const rolls = ChatUtility.getMessageRolls(message);
            message.updateSource({ rolls: CoreUtility.serializeRolls(rolls) });
            dnd5e.registry?.messages?.track?.(message);
        } catch (err) {
            console.warn("RSReforged | failed to re-sync attack roll registry:", err);
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
    
    if (SettingsUtility._useRsrDamageApplyButtons) {
        // Narrow to RSR's own action attributes so foreign buttons injected by
        // third-party modules via the rsreforged.renderApplyDamageButtons hook
        // (see docs/INTEGRATION.md) don't get their clicks swallowed by RSR's
        // unconditional preventDefault()/stopPropagation() in the handlers.
        const rsrApplyActions = '[data-action="rsr-apply-damage"], [data-action="rsr-apply-temp"]';
        html.find('.rsr-damage-buttons').find(rsrApplyActions).click(async event => {
            await _processApplyButtonEvent(message, event);
        });

        html.find('.rsr-damage-buttons-xl').find(rsrApplyActions).click(async event => {
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
    message.flags[MODULE_SHORT].rolls = CoreUtility.serializeRolls(newRolls);
    return newRolls;
}

function _safeInsert(sectionHTML, targetHTML) {
    if (targetHTML.is('.message-content') || targetHTML.hasClass('chat-message') || targetHTML.length === 0) {
        targetHTML.append(sectionHTML);
    } else {
        sectionHTML.insertBefore(targetHTML);
    }
}

/**
 * Render dnd5e dice markup from roll.toMessage() data without triggering the full
 * enriched-roll-flavor path. dnd5e's _enrichChatCard removes .message-header
 * .flavor-text when the synthetic message resolves an item + roll; toMessage()
 * payloads often omit that node, causing the same null.remove() failure.
 *
 * @param {object} chatData  Data returned by Roll#toMessage / DamageRoll.toMessage.
 * @returns {Promise<JQuery>} Rendered message root (caller typically .find('.dice-roll')).
 */
async function _renderDnd5eDiceFragment(chatData) {
    const ChatMessage5e = CONFIG.ChatMessage.documentClass;
    const prepared = foundry.utils.deepClone(chatData);
    prepared.flags ??= {};
    if (prepared.flags.dnd5e) {
        delete prepared.flags.dnd5e.item;
    }
    return $(await new ChatMessage5e(prepared).renderHTML());
}

function _snapshotSupplements(html) {
    return html.find('.supplement').map((_, element) => element.outerHTML).get().filter(Boolean);
}

function _storeSupplementsForMerge(parent, type, html) {
    parent.flags[MODULE_SHORT].supplements ??= {};
    parent.flags[MODULE_SHORT].supplements[type] = _snapshotSupplements(html);
}

function _getRollMastery(message) {
    const roll = ChatUtility.getMessageRolls(message).find(r => r instanceof CONFIG.Dice.D20Roll || r.class === "D20Roll" || r.constructor?.name === "D20Roll");
    const activity = ActivityUtility._getActivityFromMessage(message);
    const mastery = message.flags?.dnd5e?.roll?.mastery ?? message.system?.roll?.mastery ?? roll?.options?.mastery ?? activity?.item?.system?.mastery;
    return typeof mastery === "string" ? mastery.toLowerCase() : "";
}

function _getMasteryLabel(mastery) {
    const label = CONFIG.DND5E?.weaponMasteries?.[mastery]?.label;
    if (label) return CoreUtility.localize(label);
    if (!mastery) return "";
    return `${mastery[0].toUpperCase()}${mastery.slice(1)}`;
}

function _getMasteryReference(mastery) {
    const reference = CONFIG.DND5E?.weaponMasteries?.[mastery];
    return reference?.reference ?? reference?.uuid ?? "";
}

function _createMasterySupplement({ mastery, label, uuid }) {
    if (!label || !uuid) return null;

    const docType = uuid.startsWith('JournalEntryPage.') ? 'JournalEntryPage' : 'JournalEntry';
    const supplement = $('<p class="supplement"></p>');
    supplement.append($('<strong></strong>').text('Mastery: '));

    const link = $('<a class="content-link"></a>');
    link.attr({
        draggable: "true",
        "data-link": "",
        "data-type": docType,
        "data-uuid": uuid,
        "data-tooltip": label,
        "data-tooltip-direction": "UP",
        "aria-label": `${label} weapon mastery`
    });
    link.text(label);
    supplement.append(link);

    return supplement[0].outerHTML;
}

function _restoreMasterySupplement(message, host) {
    if (!host?.length) return;

    const mastery = _getRollMastery(message);
    const label = _getMasteryLabel(mastery);
    const uuid = _getMasteryReference(mastery);
    if (!label || !uuid) return;

    const existing = host.find('.supplement a').filter((_, element) => {
        return element.dataset?.tooltip === label || element.dataset?.uuid === uuid;
    });
    if (existing.length) return;

    const supplement = $(_createMasterySupplement({ mastery, label, uuid }));
    supplement.attr('data-rsr-generated-mastery', mastery);
    supplement.addClass('rsr-supplement');
    host.append(supplement);
}

function _restoreStoredSupplements(message, html) {
    const supplements = message.flags?.[MODULE_SHORT]?.supplements ?? {};

    html.find('[data-rsr-restored-supplement], [data-rsr-generated-mastery]').remove();

    const hosts = {
        [ROLL_TYPE.ATTACK]: html.find('.rsr-section-attack'),
        [ROLL_TYPE.DAMAGE]: html.find('.rsr-section-damage')
    };

    for (const [type, snippets] of Object.entries(supplements)) {
        const host = hosts[type];
        if (!host?.length || !Array.isArray(snippets) || snippets.length === 0) continue;

        const restored = $(snippets.join(""));
        restored.attr('data-rsr-restored-supplement', type);
        restored.addClass('rsr-supplement');
        host.append(restored);
    }
}

async function _injectContent(message, type, html) {
    LogUtility.log("Injecting content into chat message");

    // Integration surface — fires before any DOM removal so third-party modules
    // (wm5e, automated-conditions-5e, etc.) can snapshot the dnd5e-rendered card
    // before RSR strips it. See docs/INTEGRATION.md.
    Hooks.callAll(`${MODULE_SHORT}.preRenderChatMessageContent`, message, html, type);

    // dnd5e 5.3.0: getOriginatingMessage() is a native ChatMessage5e method that returns
    // the usage card a roll message was spawned from, or `this` when no link exists.
    // We only treat it as a real parent when it is a different message.
    let parent = null;
    if (typeof message.getOriginatingMessage === "function") {
        const origin = message.getOriginatingMessage();
        if (origin && origin !== message) parent = origin;
    }
    if (!parent && typeof message.getAssociatedMessage === "function") parent = message.getAssociatedMessage();
    // Ignore a self-referential originatingMessage: RSR stamps the card's own id as
    // its originatingMessage so dnd5e's MessageRegistry tracks it under the "attack"
    // hook (letting condition modules resolve the attack roll for damage). Such a card
    // is the root, not a child — resolving it here would make it its own merge parent.
    if (!parent && message.flags?.dnd5e?.originatingMessage
        && message.flags.dnd5e.originatingMessage !== message.id) {
        parent = game.messages.get(message.flags.dnd5e.originatingMessage);
    }
    if (!parent && message.system?.message) parent = game.messages.get(message.system.message);
    
    message.flags[MODULE_SHORT].displayChallenge = parent?.shouldDisplayChallenge ?? message.shouldDisplayChallenge;
    message.flags[MODULE_SHORT].displayAttackResult = game.user.isGM || (game.settings.get("dnd5e", "attackRollVisibility") !== "none");

    switch (type) {
        case ROLL_TYPE.DAMAGE:
            if (!message.flags?.dnd5e?.item?.id && !message.system?.item?.id) {
                const useRsrDamageButtons = SettingsUtility._useRsrDamageApplyButtons;

                message.flags[MODULE_SHORT].renderDamage = true;

                const mRolls = ChatUtility.getMessageRolls(message);
                message.flags[MODULE_SHORT].isCritical = mRolls[0]?.isCritical;

                if (useRsrDamageButtons) {
                    const enricher = html.find('.dice-roll');
                    // Foundry core renders a roll message's flavor as .flavor-text inside
                    // .message-header — a SIBLING of the .message-content node that `html`
                    // is here — so the clear must climb to the message root to reach it.
                    // Scoping to .chat-message (rather than .parent()) keeps the clear from
                    // leaking into other messages when `html` is a fallback root with no
                    // .message-content wrapper.
                    const messageRoot = html.closest('.chat-message');
                    (messageRoot.length ? messageRoot : html).find('.flavor-text').text('');
                    html.prepend('<div class="dnd5e2 chat-card"></div>');
                    html.find('.chat-card').append(enricher);

                    await _injectDamageRoll(message, enricher, { contentHtml: html });
                    await _injectApplyDamageButtons(message, html);
                    enricher.remove();
                }

                break;
            }
            // falls through to ATTACK when item id is present
        case ROLL_TYPE.ATTACK:
            if (parent && parent.flags[MODULE_SHORT] && message.isAuthor) {
                parent.flags.dnd5e ??= {};
                _storeSupplementsForMerge(parent, type, html);

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
                const cleanType = type === ROLL_TYPE.ATTACK
                    ? CONFIG.Dice.D20Roll
                    : type === ROLL_TYPE.DAMAGE
                        ? CONFIG.Dice.DamageRoll
                        : null;
                newParentRolls = RollUtility.mergeRollsByType(newParentRolls, newMsgRolls, cleanType);

                const serializedRolls = CoreUtility.serializeRolls(newParentRolls);
                parent.flags[MODULE_SHORT].rolls = serializedRolls;

                ChatUtility.updateChatMessage(parent, {
                    flags: parent.flags,
                    rolls: serializedRolls,
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
        // dnd5e currently stamps concentration saves as "save", but route the
        // dedicated type here too so D20_NPC_ROLL_TYPES coverage is honored if a
        // future system version stamps them directly.
        case ROLL_TYPE.CONCENTRATION:
            if (!message.isContentVisible) return;

            const roll = ChatUtility.getMessageRolls(message)[0];
            if (!roll) return;

            // Wire the display options first; _configureRollVisibility overrides
            // them when the roll should be hidden from this user.
            roll.options.displayChallenge = message.flags[MODULE_SHORT].displayChallenge;
            roll.options.forceSuccess = message.flags?.dnd5e?.roll?.forceSuccess ?? message.system?.roll?.forceSuccess;

            const checkActor = ChatUtility.getActorFromMessage(message);
            _configureRollVisibility(roll, type, checkActor);

            const render = await RenderUtility.render(TEMPLATE.MULTIROLL, { roll, key: type })
            html.find('.dice-total').replaceWith(render);
            html.find('.dice-tooltip').prepend(html.find('.dice-formula'));

            if (roll.options.hideFinalResult) {
                _applyHiddenRollPresentation(html, roll);
            }

            if (message.flags[MODULE_SHORT].isConcentration)
            {
                await _injectBreakConcentrationButton(message, html)
            }
            break;
        case ROLL_TYPE.ACTIVITY: {
            if (!message.isContentVisible) return;
            const useRsrDamageButtons = SettingsUtility._useRsrDamageApplyButtons;

            let actions = html.find('.card-buttons');
            if (actions.length === 0) actions = html.find('.card-activities');
            if (actions.length === 0) actions = html.find('.dnd5e2.chat-card');
            if (actions.length === 0) actions = html;

            // Strip pre-existing dice-roll DOM and the (now-empty) non-usage
            // chat-card wrappers that contained them, before we inject our own
            // render. Applies to both RSR and native modes — otherwise the
            // message ends up with duplicate damage UIs (RSR) or empty card
            // shells next to the new native damage card (native).
            if (useRsrDamageButtons
                || message.flags[MODULE_SHORT].renderAttack
                || message.flags[MODULE_SHORT].renderFormula
                || message.flags[MODULE_SHORT].renderDamage) {
                // Rescue dnd5e-injected supplements (mastery anchors, damage-on-save
                // notes, legendary-resistance flags from _enrichAttackTargets et al.)
                // off chat-cards we're about to remove, before the strip. Parked at
                // html root so the post-inject rescue below can move them under
                // .rsr-section-attack alongside supplements that survived the strip
                // in their original location.
                const doomed = html.find('.dnd5e2.chat-card').not('.activation-card, .usage-card');
                doomed.find('.supplement').appendTo(html);
                html.find('.dice-roll').remove();
                doomed.remove();
            }

            if (message.flags[MODULE_SHORT].renderAttack || message.flags[MODULE_SHORT].renderAttack === false) {
                html.find('[data-action=rollAttack], [data-action=attack]').remove();
                await _injectAttackRoll(message, actions, { contentHtml: html });
            }

            if (message.flags[MODULE_SHORT].manualDamage || message.flags[MODULE_SHORT].renderDamage) {
                html.find('[data-action=rollDamage], [data-action=damage]').remove();
                html.find('[data-action=rollHealing], [data-action=heal]').remove();
            }

            if (message.flags[MODULE_SHORT].manualDamage) {
                await _injectDamageButton(message, actions);
            }

            if (message.flags[MODULE_SHORT].renderDamage) {
                await _injectDamageRoll(message, actions, { mode: useRsrDamageButtons ? "rsr" : "native", contentHtml: html });
            }

            if (message.flags[MODULE_SHORT].renderFormula) {
                html.find('[data-action=rollFormula], [data-action=formula]').remove();
                await _injectFormulaRoll(message, actions, { contentHtml: html });
            }

            if (useRsrDamageButtons) {
                await _injectApplyDamageButtons(message, html);
                const rootParent = html.closest('.message-content');
                if (rootParent.length) rootParent.find('> .dice-roll').remove();
            }

            // Place surviving + rescued dnd5e supplements (mastery anchors,
            // damage-on-save notes, legendary-resistance flags) into the most
            // specific RSR section that exists for this card. Runs after all
            // injects so we have a complete picture of which sections were
            // created. Add .rsr-supplement for RSR's own styling
            // (css/rsreforged.css) but keep the original .supplement class so
            // downstream modules and dnd5e's own enrichers continue to find
            // them. The host-narrowed selector on the addClass step prevents
            // double-tagging supplements inside surviving .activation-card /
            // .usage-card subtrees that RSR's strip explicitly preserves.
            _restoreStoredSupplements(message, html);

            let supplementHost = html.find('.rsr-section-attack');
            if (!supplementHost.length) supplementHost = html.find('.rsr-section-damage');
            if (!supplementHost.length) supplementHost = html.find('.rsr-section-formula');
            if (supplementHost.length) {
                // Sweep loose supplements into the host, but leave restored
                // snapshots where _restoreStoredSupplements already placed them
                // (e.g. damage-on-save notes under .rsr-section-damage) — otherwise
                // this attack-preferring sweep would relocate them to the wrong section.
                supplementHost.append(html.find('.supplement').not(supplementHost.find('.supplement')).not('[data-rsr-restored-supplement]'));
                supplementHost.find('.supplement').addClass('rsr-supplement');
                _restoreMasterySupplement(message, supplementHost);
            }
            break;
        }
        default:
            break;
    }

    _setupCardListeners(message, html);

    // Integration surface — fires after RSR has finished its DOM rewrite. Primary
    // decoration point for third-party modules. See docs/INTEGRATION.md.
    Hooks.callAll(`${MODULE_SHORT}.renderChatMessageContent`, message, html, type);
}

async function _injectAttackRoll(message, html, { contentHtml = html } = {}) {
    const rolls = ChatUtility.getMessageRolls(message);
    
    const roll = rolls.find(r => r instanceof CONFIG.Dice.D20Roll || r.class === "D20Roll" || r.constructor?.name === "D20Roll");

    if (!roll) return;
    
    RollUtility.resetRollGetters(roll);

    roll.options.displayChallenge = message.flags[MODULE_SHORT].displayAttackResult;

    // dnd5e 5.3.0: Use getAssociatedActor() instead of game.actors.get(speaker.actor) so
    // that token actors (which are not in game.actors) are correctly resolved. Previously
    // this always returned null for unlinked tokens, causing hideFinalResult to silently
    // default to false for GMs viewing other players' rolls.
    const actor = ChatUtility.getActorFromMessage(message);
    _configureRollVisibility(roll, ROLL_TYPE.ATTACK, actor);

    const render = await RenderUtility.render(TEMPLATE.MULTIROLL, { roll, key: ROLL_TYPE.ATTACK });
    const chatData = await roll.toMessage({}, { create: false });
    // Foundry V14 removed CONST.CHAT_MESSAGE_TYPES entirely. The previous workaround of
    // setting chatData.type to the numeric OOC value now coerces to the string "1", which
    // fails ChatMessage5e's strict type validation and throws a DataModelValidationError
    // before renderHTML() is ever reached. roll.toMessage() already sets type:"roll" which
    // is a valid Foundry V14 type, so we leave it alone.

    const rollHTML = (await _renderDnd5eDiceFragment(chatData)).find('.dice-roll');
    rollHTML.find('.dice-total').replaceWith(render);
    rollHTML.find('.dice-tooltip').prepend(rollHTML.find('.dice-formula'));

    if (roll.options.hideFinalResult) {
        _applyHiddenRollPresentation(rollHTML, roll);
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

    Hooks.callAll(`${MODULE_SHORT}.renderRoll`, message, contentHtml, ROLL_TYPE.ATTACK, sectionHTML);
}

function _configureRollVisibility(roll, rollType, actor) {
    roll.options.hideFinalResult = SettingsUtility.shouldHideNpcRollForActor(actor, rollType);
    if (roll.options.hideFinalResult) {
        // Suppress everything that would reveal the outcome of a hidden roll:
        // the DC pass/fail icon and forced-success crit styling.
        roll.options.displayChallenge = false;
        roll.options.forceSuccess = false;
    }
}

function _applyHiddenRollPresentation(rollHTML, roll) {
    if (!roll?.options?.hideFinalResult) return;

    // Reveal only the natural d20. Removing flat modifiers (.tooltip-part.constant)
    // is not enough: bonus dice such as Bless or Guidance render as their own
    // non-constant tooltip part (li.roll.die.dN) and would otherwise leak both the
    // buff and the rolled value. Drop every tooltip part that is not a d20 die.
    rollHTML.find('.dice-tooltip .tooltip-part').each((_i, el) => {
        const part = $(el);
        if (part.find('.roll.d20').length === 0) part.remove();
    });
    rollHTML.find('.dice-formula').text("1d20 + " + CoreUtility.localize(`${MODULE_SHORT}.chat.hide`));
}

async function _injectFormulaRoll(message, html, { contentHtml = html } = {}) {
    const rolls = ChatUtility.getMessageRolls(message);
    
    const roll = rolls.find(r => r instanceof CONFIG.Dice.BasicRoll || r.class === "BasicRoll" || r.constructor?.name === "BasicRoll");

    if (!roll) return;

    const chatData = await roll.toMessage({}, { create: false });
    // Foundry V14: see comment in _injectAttackRoll. type:"roll" is set by toMessage().

    const rollHTML = (await _renderDnd5eDiceFragment(chatData)).find('.dice-roll');
    rollHTML.find('.dice-tooltip').prepend(rollHTML.find('.dice-formula'));

    const sectionHTML = $(await RenderUtility.render(TEMPLATE.SECTION,
    {
        section: `rsr-section-${ROLL_TYPE.FORMULA}`,
        title: message.flags[MODULE_SHORT].formulaName ?? CoreUtility.localize("DND5E.OtherFormula"),
        icon: "<i class=\"fas fa-dice\"></i>"
    }));
    
    $(sectionHTML).append(rollHTML);
    _safeInsert(sectionHTML, html);

    Hooks.callAll(`${MODULE_SHORT}.renderRoll`, message, contentHtml, ROLL_TYPE.FORMULA, sectionHTML);
}

async function _injectDamageRoll(message, html, { mode = "rsr", contentHtml = html } = {}) {
    const rolls = _getDamageRolls(message);

    if (!rolls || rolls.length === 0) return;

    const chatData = await CONFIG.Dice.DamageRoll.toMessage(rolls, {}, { create: false });
    // Foundry V14: see comment in _injectAttackRoll. type:"roll" is set by toMessage().

    const renderedHTML = await _renderDnd5eDiceFragment(chatData);

    if (mode === "native") {
        let nativeHTML = renderedHTML.find('.message-content').children();
        if (!nativeHTML.length) nativeHTML = renderedHTML.find('.dnd5e2.chat-card').not('.activation-card, .usage-card');
        if (!nativeHTML.length) nativeHTML = renderedHTML.find('.dice-roll').closest('.dnd5e2.chat-card');
        if (!nativeHTML.length) nativeHTML = renderedHTML.find('.dice-roll');

        // The RSR-mode branch below builds its own section title and tags it with
        // "(Versatile)" via flags.versatile. dnd5e's native damage card has no such
        // header — it just shows the formula. Append the tag to the formula row so
        // the player gets the same signal regardless of Damage Apply UI choice.
        if (message.flags[MODULE_SHORT].versatile) {
            const label = CoreUtility.localize("DND5E.Versatile");
            const tag = `<span class="rsr-versatile-tag">(${label})</span>`;
            const formula = nativeHTML.find('.dice-formula').first();
            if (formula.length) formula.append(` ${tag}`);
        }

        _safeInsert(nativeHTML, html);

        Hooks.callAll(`${MODULE_SHORT}.renderRoll`, message, contentHtml, ROLL_TYPE.DAMAGE, nativeHTML);
        return;
    }

    const rollHTML = renderedHTML.find('.dice-roll');
    rollHTML.find('.dice-tooltip').prepend(rollHTML.find('.dice-formula'));
    rollHTML.find('.dice-result').addClass('rsr-damage');

    const header = message.flags[MODULE_SHORT].isHealing
        ? {            
            section: `rsr-section-${ROLL_TYPE.DAMAGE}`,
            title: CoreUtility.localize("DND5E.HEAL.HealingButton"),
            icon: "<i class=\"fas fa-heart\"></i>"
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

    Hooks.callAll(`${MODULE_SHORT}.renderRoll`, message, contentHtml, ROLL_TYPE.DAMAGE, sectionHTML);
}

async function _injectDamageButton(message, html) {
    const button = message.flags[MODULE_SHORT].isHealing
        ? {
            title: CoreUtility.localize("DND5E.HEAL.HealingButton"),
            icon: "<i class=\"fas fa-heart\"></i>"
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

    Hooks.callAll(`${MODULE_SHORT}.renderApplyDamageButtons`, message, html, total);
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
    const multiplier = Number(button.dataset.multiplier);
    const dice = $(button).closest('.tooltip-part').find('.dice');

    if (action !== "rsr-apply-damage" && action !== "rsr-apply-temp") return;

    const targets = CoreUtility.getCurrentTargets();

    if (targets.size === 0) return;

    const damage = _getApplyDamage(message, dice, multiplier);

    // These are invariant across targets — compute once instead of per-token. The
    // multiplier MAGNITUDE is what applyDamage scales by; heal-vs-damage direction
    // is carried by the damage type / the only:"healing" option, not the sign (the
    // total-button path already passes the magnitude, so the two paths now match).
    const applyAsTempHP = _shouldApplyAsTempHP(action, [damage]);
    const tempHPValue = Math.floor(damage.value * Math.abs(multiplier));
    const applyOptions = _getApplyDamageOptions(message, [damage], Math.abs(multiplier), multiplier < 0);

    await Promise.all(Array.from(targets).map(async t => {
        const target = t.actor;
        return applyAsTempHP
            ? await target.applyTempHP(tempHPValue)
            : await target.applyDamage([ damage ], applyOptions);
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
    
    const damages = [];

    // Deserialize the message rolls once for the whole loop instead of re-fetching
    // (and re-deserializing) them inside _getApplyDamage for every damage die.
    const damageRolls = _getDamageRolls(message);
    const children = $(button).closest('.dice-roll').find('.rsr-damage .dice-tooltip .tooltip-part .dice');

    children.each((i, el) => {
        damages.push(_getApplyDamage(message, $(el), multiplier, damageRolls));
    })

    // Invariant across targets — compute once instead of per-token.
    const applyAsTempHP = _shouldApplyAsTempHP(action, damages);
    const tempHPValue = Math.floor(damages.reduce((accumulator, currentValue) => accumulator + currentValue.value, 0) * Math.abs(multiplier));
    const applyOptions = _getApplyDamageOptions(message, damages, Math.abs(multiplier), multiplier < 0);

    await Promise.all(Array.from(targets).map(async t => {
        const target = t.actor;
        return applyAsTempHP
            ? await target.applyTempHP(tempHPValue)
            : await target.applyDamage(damages, applyOptions);
    }));

    setTimeout(() => {
        if (canvas.hud.token._displayState && canvas.hud.token._displayState !== 0) {
            canvas.hud.token.render();
        }
    }, 50);
}

function _getApplyDamage(message, dice, multiplier, damageRolls = _getDamageRolls(message)) {
    const total = dice.find('.total')
    const parsed = parseInt(total.find('.value').text());
    // A non-numeric/empty total would otherwise propagate NaN into applyDamage /
    // applyTempHP and write NaN into the target's HP; fail safe to a 0 no-op.
    const value = Number.isFinite(parsed) ? parsed : 0;
    const type = _getApplyDamageType(damageRolls, total);

    const properties = new Set(
        (damageRolls.find(r => r.options?.type === type) ?? damageRolls[0])?.options?.properties ?? []
    );
    // A negative multiplier comes from the "apply as healing" button. Temp-HP and
    // max-HP ("maximum") rolls carry their own application semantics (applyTempHP /
    // dnd5e's only:"healing" path), so keep their type intact instead of collapsing
    // it to 'healing' — otherwise the heart button would strip the type those paths
    // key on (e.g. an Aid max-HP roll would be dealt as damage).
    const resolvedType = (multiplier < 0 && type !== "temphp" && type !== "maximum") ? 'healing' : type;
    return { value: value, type: resolvedType, properties: properties };
}

function _shouldApplyAsTempHP(action, damages) {
    return action === "rsr-apply-temp" || (damages.length > 0 && damages.every(d => d.type === "temphp"));
}

function _getApplyDamageOptions(message, damages, multiplier, healingIntent = false) {
    const options = { multiplier };

    // dnd5e treats "maximum" as max-HP reduction unless the application is explicitly
    // healing. Route it to max-HP restoration when the source is a healing activity
    // (e.g. Aid) OR when the user clicked the heart/healing button — the heart is an
    // explicit "apply as healing" signal, so it must restore max HP, not reduce it.
    if (damages.some(d => d.type === "maximum") && (healingIntent || _isHealingApplyMessage(message))) {
        options.only = "healing";
    }

    return options;
}

function _isHealingApplyMessage(message) {
    return message.flags?.[MODULE_SHORT]?.isHealing === true
        || ChatUtility.getActivityType(message) === "heal"
        || message.flags?.dnd5e?.roll?.type === ROLL_TYPE.HEALING
        || message.system?.roll?.type === ROLL_TYPE.HEALING;
}

function _getApplyDamageType(damageRolls, total) {
    const iconType = _getDamageTypeFromIcon(total.find('img').attr('src'));
    if (iconType) return iconType;

    const labelType = _getDamageTypeFromLabel(total.find('.label').text());
    if (labelType) return labelType;

    // No DOM signal matched a known type. Prefer an authoritative roll type (so
    // applyDamage still honors resistances/immunities) over a raw label string,
    // which on a multi-type roll would not match any CONFIG.DND5E damage key. When
    // exactly one roll type exists this returns it; with several it picks the first,
    // which the previous explicit single-type tier resolved to identically.
    return damageRolls.find(r => r.options?.type)?.options?.type
        ?? total.find('.label').text().trim().toLowerCase();
}

function _getDamageTypeFromIcon(src = "") {
    const iconType = src.match(/\/damage\/([^/.]+)\./)?.[1];
    if (!iconType) return null;
    if (iconType === "maxhp") return "maximum";
    if (CONFIG.DND5E.damageTypes?.[iconType] || CONFIG.DND5E.healingTypes?.[iconType]) return iconType;
    return null;
}

let _damageLabelToTypeCache = null;

/**
 * Lazily-built, cached reverse map of normalized damage/healing labels (plus the
 * type keys and short labels) to their dnd5e type key. Rebuilding the merged map
 * on every apply click was wasted work, but the cache is rebuilt if the registered
 * type set changes size (e.g. a module adds damage/healing types after first use)
 * so it cannot go stale against late registrations.
 */
function _getDamageLabelToTypeMap() {
    const entries = {
        ...(CONFIG.DND5E.damageTypes ?? {}),
        ...(CONFIG.DND5E.healingTypes ?? {})
    };
    const typeCount = Object.keys(entries).length;
    if (_damageLabelToTypeCache?.typeCount === typeCount) return _damageLabelToTypeCache.map;

    const map = new Map();
    for (const [type, config] of Object.entries(entries)) {
        for (const value of [type, config?.label, config?.labelShort]) {
            if (value) map.set(String(value).trim().toLowerCase(), type);
        }
    }
    _damageLabelToTypeCache = { typeCount, map };
    return map;
}

function _getDamageTypeFromLabel(label = "") {
    const normalized = label.trim().toLowerCase();
    if (!normalized) return null;
    return _getDamageLabelToTypeMap().get(normalized) ?? null;
}

function _isDamageRoll(roll) {
    return roll instanceof CONFIG.Dice.DamageRoll
        || roll.class === "DamageRoll"
        || roll.constructor?.name === "DamageRoll";
}

function _getDamageRolls(message) {
    return ChatUtility.getMessageRolls(message).filter(_isDamageRoll);
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

        message.flags[MODULE_SHORT].rolls = CoreUtility.serializeRolls(originalRolls);

        await ChatUtility.updateChatMessage(message, {
            flags: message.flags,
            flavor: message.flavor
        });

        // The attack D20 roll just changed; re-register it in dnd5e's MessageRegistry so
        // AC5e resolves the upgraded roll on a subsequent damage roll. Runs after the
        // persist so it wins over dnd5e's prepareData -> track (which would re-read the
        // stale native rolls). No-ops for non-attack cards.
        ChatUtility.resyncAttackRegistry(message);

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

        const rolls = originalRolls.filter(_isDamageRoll);
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

        await CoreUtility.tryRollDice3D(crits, message.id);

        message.flags[MODULE_SHORT].rolls = CoreUtility.serializeRolls(newRolls);

        ChatUtility.updateChatMessage(message, {
            flags: message.flags
        });

        if (!game.dice3d || !game.dice3d.isEnabled()) {
            CoreUtility.playRollSound();
        }
    }
}
