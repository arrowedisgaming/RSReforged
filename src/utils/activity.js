import { MODULE_SHORT } from "../module/const.js";
import { MODULE_MIDI } from "../module/integration.js";
import { ChatUtility } from "./chat.js";
import { CoreUtility } from "./core.js";
import { CRIT_TYPE, ROLL_TYPE, RollUtility } from "./roll.js";
import { SETTING_NAMES, SettingsUtility } from "./settings.js";

/**
 * Snapshots of the pending dnd5e roll-message configuration, keyed by the correlation
 * token RSR stamps into the configuration it hands to the roll workflow.
 *
 * Entries are written by captureRollMessageConfig (from the dnd5e postRollConfiguration
 * hook) and removed by _consumeRollCapture, which getAttackFromMessage calls on every
 * settle path so the map cannot grow unbounded.
 */
const _rollCaptures = new Map();
let _rollCaptureSequence = 0;

/**
 * Cards whose `flags.dnd5e.targets` was written by the roll capture on the current
 * quick-roll pass.
 *
 * Two writers touch that field on the quick-roll path and they must not race:
 * getAttackFromMessage applies the capture as the attack roll settles, and
 * runActivityActions calls _syncAttackTargets immediately afterwards. The capture is
 * strictly newer (it is the roll workflow's own view, taken after every listener that
 * adjusts a roll against its targets has run), so when it wrote, the second writer is
 * skipped outright rather than being asked to recognise the write after the fact —
 * `targets: []` is a decided answer that no `?.length` guard can distinguish from
 * "nothing here yet" (issue #38).
 *
 * Keyed weakly on the message document so a card that never reaches runActivityActions
 * (a cancelled roll, a direct getAttackFromMessage call) leaves nothing behind.
 */
const _captureWrittenCards = new WeakSet();

export class ActivityUtility {

    /**
     * Resolve the activity associated with a chat message.
     *
     * dnd5e 5.3.0: `getAssociatedActivity()` is now a native ChatMessage5e method
     * (line 69694 of dnd5e.mjs). It tries `fromUuidSync(flags.dnd5e.activity.uuid)`
     * first, then falls back to `getAssociatedItem()?.system.activities?.get(flags.dnd5e.activity.id)`.
     * We call it directly and only fall through to manual UUID/id resolution when the
     * message object is a plain data object (e.g. during preCreateChatMessage before the
     * document is instantiated) where the method may not exist.
     *
     * NOTE: `message.system.activity` is intentionally NOT used as a primary path.
     * In 5.3.0 it is a getter on UsageMessageData that itself calls
     * `this.parent.getAssociatedActivity()` — identical to calling the method directly,
     * but with the added risk of throwing when `message.system` is undefined (non-usage
     * messages) or when the system data model is not yet initialised (preCreate hooks).
     */
    static _getActivityFromMessage(message) {
        // Primary: native ChatMessage5e method available on instantiated documents.
        if (typeof message.getAssociatedActivity === "function") {
            const act = message.getAssociatedActivity();
            if (act) return act;
        }

        // Fallback A: resolve via item UUID + activity id (covers preCreate where the
        // document method above may not yet exist, or may return null because flags
        // haven't been saved to the database yet and fromUuidSync can't find the UUID).
        let item = null;
        if (typeof message.getAssociatedItem === "function") item = message.getAssociatedItem();
        if (!item && message.flags?.dnd5e?.item?.uuid) item = fromUuidSync(message.flags.dnd5e.item.uuid, { strict: false });
        if (!item && message.flags?.dnd5e?.use?.itemUuid) item = fromUuidSync(message.flags.dnd5e.use.itemUuid, { strict: false });

        const activityId = message.flags?.dnd5e?.activity?.id;
        if (item && activityId) {
            const act = item.system?.activities?.get(activityId);
            if (act) return act;
        }

        // Fallback B: resolve directly via activity UUID stored in flags.
        // dnd5e 5.3.0: the activity UUID is stored at flags.dnd5e.activity.uuid
        // (set by Activity#messageFlags getter, line 16711 of dnd5e.mjs).
        const activityUuid = message.flags?.dnd5e?.activity?.uuid;
        if (activityUuid) {
            const act = fromUuidSync(activityUuid, { strict: false });
            if (act) return act;
        }

        return null;
    }

    /**
     * Resolve the actor associated with a chat message.
     *
     * dnd5e 5.3.0: delegates to ChatUtility.getActorFromMessage which already uses the
     * native getAssociatedActor() method with a proper null-safe manual fallback.
     */
    static _getActorFromMessage(message) {
        return ChatUtility.getActorFromMessage(message);
    }

    /**
     * Ensure `flags.dnd5e.targets` is present on a merged quick-roll card so modules
     * such as wm5e can resolve the attacked actor from the chat message (e.g. Sap reads
     * `targets[0].uuid` via `fromUuidSync`). RSR rolls with `create: false`, so dnd5e's
     * attack-target enrichment on a discrete roll message never reaches the parent card
     * unless we copy it during child-merge or stamp it from the user's targeted tokens
     * at attack-roll time.
     *
     * Precedence, highest first:
     *   1. The pending roll-message configuration captured mid-workflow. That writer is
     *      NOT here — getAttackFromMessage applies it via _applyRollCapture before
     *      runActivityActions reaches this method, and runActivityActions skips this
     *      method entirely when it wrote (see _captureWrittenCards). It is listed
     *      because it is the source that outranks both of the two below.
     *   2. A child attack-roll message merged into the card (`sourceMessage`), which
     *      overwrites whatever is on the card — including with an empty list, which
     *      means "this roll had no targets" and not "nothing to offer".
     *   3. The user's currently targeted tokens, which are no fresher than the card's
     *      own descriptors and therefore never clobber them.
     *
     * @param {ChatMessage} message The activation card to stamp.
     * @param {ChatMessage} [sourceMessage] Optional child attack-roll message to copy from.
     */
    static _syncAttackTargets(message, sourceMessage = null) {
        if (!message) return;

        message.flags.dnd5e ??= {};

        // A child roll message wins outright. dnd5e's Activity#use stamps descriptors on
        // the usage card from getTargetDescriptors() before any roll happens, so whatever
        // is already on the card predates every target-dependent adjustment made during
        // the roll — cover bonuses, condition-driven AC changes. The child message was
        // created later in that same workflow and carries the adjusted values (#38).
        // Array.isArray, not `?.length`: a child message carrying `targets: []` rolled
        // against nothing, and that is an answer. Treating it as "no offer" would leave
        // the card advertising a target the roll never happened against, which is the
        // opposite of the contract published in docs/INTEGRATION.md.
        const fromSource = sourceMessage?.flags?.dnd5e?.targets;
        if (Array.isArray(fromSource)) {
            message.flags.dnd5e.targets = foundry.utils.deepClone(fromSource);
            return;
        }

        // No child message means the only other source is the user's current targets,
        // which are no fresher than what the card already holds — so never clobber here.
        //
        // Deliberately `?.length` rather than the Array.isArray used above: Activity#use
        // stamps `targets: []` on every card used with nothing targeted, and this fallback
        // exists precisely to fill that case in from the tokens the user has targeted by
        // attack-roll time. The writer that must be able to say "empty on purpose" is the
        // roll capture, and it never reaches this point — runActivityActions skips the
        // whole method when the capture wrote (see _captureWrittenCards).
        if (message.flags.dnd5e.targets?.length) return;

        const tokens = Array.from(game.user?.targets ?? []);
        if (!tokens.length) return;

        // Mirror dnd5e's getTargetDescriptors() shape exactly: a fully-covered
        // target reports ac:null (so the tray shows no hit/miss), a missing AC
        // coerces to null rather than undefined, the avatar img is carried, and
        // targets dedupe by uuid (two tokens of one actor collapse to one entry).
        const targets = new Map();
        for (const token of tokens) {
            const { name } = token;
            const { img, system, uuid, statuses } = token.actor ?? {};
            if (!uuid) continue;
            const ac = statuses?.has("coverTotal") ? null : system?.attributes?.ac?.value;
            targets.set(uuid, { name, img, uuid, ac: ac ?? null });
        }

        if (targets.size) message.flags.dnd5e.targets = Array.from(targets.values());
    }

    /**
     * Mint a correlation token for one roll issued by RSR.
     *
     * dnd5e's rollAttack merges the message configuration RSR passes into its OWN
     * defaults (foundry.utils.mergeObject mutates the first argument and returns it), so
     * the object every roll hook receives is not the object RSR handed over. RSR cannot
     * read its own reference back; it has to recognise its roll from inside the
     * workflow, which is what this token is for.
     */
    static _nextRollCaptureId() {
        _rollCaptureSequence += 1;
        return `${MODULE_SHORT}-capture-${_rollCaptureSequence}`;
    }

    /**
     * Snapshot a pending dnd5e roll-message configuration mid-workflow.
     *
     * dnd5e seeds `data.flags.dnd5e.targets` from getTargetDescriptors() inside
     * rollAttack, and modules that adjust a roll against its targets (cover, condition
     * automation) rewrite those entries during the preRoll hooks. Because RSR rolls with
     * `create: false`, dnd5e never turns the configuration into a message, so without
     * this snapshot every one of those adjustments is discarded and the card keeps the
     * descriptors Activity#use() stamped on it before the roll.
     *
     * Called from dnd5e's postRollConfiguration hook — the last of the three post-config
     * hooks an attack fires (postAttackRollConfiguration, postD20TestRollConfiguration,
     * postRollConfiguration; see BasicRoll.buildConfigure) — so every mutating listener
     * on any of them has already run.
     *
     * A missing `targets` array and an empty one mean different things and are recorded
     * differently: `null` for "this configuration never had a target list" (leave the
     * card alone), `[]` for "this roll had no targets" (clear the card's stale list).
     *
     * The descriptor entries are copied because the configuration keeps being mutated
     * after this point; the flags object itself is kept by reference — it outlives the
     * roll, and the capture is consumed before the roll's promise settles.
     *
     * @param {object} messageConfig The pending roll-message configuration.
     */
    static captureRollMessageConfig(messageConfig) {
        const flags = messageConfig?.data?.flags;
        const captureId = flags?.[MODULE_SHORT]?.captureId;
        if (!captureId) return;

        const targets = Array.isArray(flags.dnd5e?.targets)
            ? foundry.utils.deepClone(flags.dnd5e.targets)
            : null;

        // `flags` is intentionally unread today. It is the hook for the deferred
        // "carry third-party flag namespaces from the roll config onto the card" work
        // (see the roll-message-capture plan's deferred section) — keeping the live
        // reference here means that feature needs no change to the capture contract.
        _rollCaptures.set(captureId, { targets, flags });
    }

    /**
     * Read and remove a capture. Safe to call more than once for the same token, and
     * safe to call for a roll that was cancelled before the capture hook ran.
     *
     * @param {string} captureId The token minted by _nextRollCaptureId.
     * @returns {{targets: object[]|null, flags: object}|null}
     */
    static _consumeRollCapture(captureId) {
        if (!captureId) return null;
        const capture = _rollCaptures.get(captureId) ?? null;
        _rollCaptures.delete(captureId);
        return capture;
    }

    /**
     * Write a capture onto the RSR card.
     *
     * This OVERWRITES `flags.dnd5e.targets`, including with an empty list. dnd5e's
     * Activity#use already stamped descriptors on the usage card from
     * getTargetDescriptors() before the attack roll ran, so the existing entries are the
     * stale pre-roll set that produces both the wrong AC and the wrong hit/miss verdict
     * in the target tray (issue #38; the tray derives its per-row verdict from the
     * descriptor AC — dnd5e chat-message.mjs:462). The captured set has the identical
     * shape and is produced later in the same workflow.
     *
     * @param {object} message The RSR card to write to.
     * @param {{targets: object[]|null, flags: object}|null} capture
     * @returns {boolean} Whether anything was written.
     */
    static _applyRollCapture(message, capture) {
        const targets = capture?.targets;
        if (!message || !Array.isArray(targets)) return false;

        message.flags ??= {};
        message.flags.dnd5e ??= {};
        message.flags.dnd5e.targets = targets;
        return true;
    }

    /**
     * Read and clear the "the capture already decided this card's targets" marker set by
     * getAttackFromMessage. Consumed by runActivityActions to decide whether
     * _syncAttackTargets should run at all on this pass.
     *
     * @param {object} message The RSR card.
     * @returns {boolean} Whether the capture wrote this card's descriptors.
     */
    static _consumeCaptureWrite(message) {
        if (!message || !_captureWrittenCards.has(message)) return false;
        _captureWrittenCards.delete(message);
        return true;
    }

    /**
     * Extract Roll instances from the raw return value of rollAttack / rollDamage /
     * rollFormula. In dnd5e 5.3.0 all three methods return Roll[] directly when
     * messageConfig.create is false, so the array branch is hit in the normal case.
     * The other branches are kept for defensive compatibility.
     */
    static _extractRolls(result) {
        let extracted = [];
        if (!result) return extracted;
        const items = Array.isArray(result) ? result : [result];
        for (const item of items) {
            if (!item) continue;
            if (item instanceof Roll) {
                extracted.push(item);
            } else if (item.rolls && Array.isArray(item.rolls)) {
                extracted.push(...item.rolls);
            } else if (item.roll && item.roll instanceof Roll) {
                extracted.push(item.roll);
            } else if (item.class && item.formula) {
                try { extracted.push(Roll.fromData(item)); } catch(e) {}
            }
        }
        return extracted;
    }

    /**
     * Read dnd5e critical state from either a live roll or serialized roll data.
     * Foundry's live `isCritical` getter can disappear after round-tripping through
     * Roll.fromData, so this derives the answer from the underlying roll data instead.
     *
     * Attack (d20) rolls defer to RollUtility.getCritTypeForDie — the SAME crit logic
     * that drives the rendered crit styling (see render.js) — so the doubled damage
     * dice and the "Critical Hit!" card can never disagree. That path honours
     * forceSuccess, the roll-level criticalSuccess threshold, and rerolled/discarded
     * exclusion, none of which a raw `result >= 20` scan handles.
     *
     * Detection is by roll CLASS (not "has a 20-faced die") so a damage formula that
     * happens to contain a d20 term is not mistaken for an attack roll; such damage
     * rolls fall through to their own stored critical flag below.
     */
    static isCriticalRoll(roll) {
        if (!roll) return false;

        if (RollUtility.isRollOfType(roll, CONFIG.Dice.D20Roll)) {
            const d20 = roll.d20
                ?? roll.terms?.find?.(term => term?.faces === 20)
                ?? roll.dice?.find?.(term => term?.faces === 20);
            if (d20) {
                const critType = RollUtility.getCritTypeForDie(d20, {
                    critThreshold: roll.options?.criticalSuccess,
                    forceSuccess: roll.options?.forceSuccess,
                    ignoreDiscarded: true
                });
                return critType === CRIT_TYPE.SUCCESS || critType === CRIT_TYPE.MIXED;
            }
        }

        // Damage / non-d20 rolls: read the roll's own critical flag. dnd5e stores damage
        // crit under options.critical; RSR and midi-qol pass options.isCritical.
        return roll.isCritical === true
            || roll.options?.isCritical === true
            || roll.options?.critical === true;
    }

    /**
     * Derive RSR render flags (renderAttack / renderDamage / renderFormula / isHealing /
     * formulaName) from an activity's capabilities and write them onto the given RSR
     * flags object. Mutates `flags` in place; a no-op unless `flags.quickRoll` is set.
     *
     * Single source of truth for creation-time render-flag derivation: called from the
     * preCreateChatMessage hook (hooks.js) after the base quickRoll/processed flags are
     * seeded. Deliberately NOT called during chat re-render — legacy usage messages that
     * were never stamped at creation must stay passive rather than be pulled into the
     * quick-roll pipeline retroactively (see issue #15). The one exception is the
     * guarded retry at the top of runActivityActions, which only fires for messages
     * RSR itself claimed at creation (quickRoll set, not yet processed) whose activity
     * could not be resolved during preCreate.
     *
     * @param {object} activity The dnd5e activity resolved for the message.
     * @param {object} flags    The message's `flags[MODULE_SHORT]` object to mutate.
     */
    static setRenderFlags(activity, flags) {
        if (!activity || !flags || !flags.quickRoll) return;

        const hasAttack  = activity.type === "attack"  || !!activity.attack   || activity.hasOwnProperty(ROLL_TYPE.ATTACK);
        const hasDamage  = activity.type === "damage"  || !!activity.damage   || activity.type === "attack" || activity.type === "save" || activity.hasOwnProperty(ROLL_TYPE.DAMAGE);
        const hasHealing = activity.type === "heal"    || !!activity.healing  || activity.hasOwnProperty(ROLL_TYPE.HEALING);
        const hasFormula = activity.type === "utility" || !!activity.roll     || activity.hasOwnProperty(ROLL_TYPE.FORMULA);

        if (hasAttack) {
            flags.renderAttack = true;
        }

        const manualDamageMode = SettingsUtility.getSettingValue(SETTING_NAMES.MANUAL_DAMAGE_MODE);

        if (hasDamage) {
            flags.manualDamage = (manualDamageMode === 2 || (manualDamageMode === 1 && hasAttack));
            flags.renderDamage = !flags.manualDamage;
        }

        if (hasHealing) {
            flags.isHealing = true;
            flags.renderDamage = true;
        }

        if (hasFormula) {
            flags.renderFormula = true;
            const fName = activity.roll?.name || activity[ROLL_TYPE.FORMULA]?.name;
            if (fName && fName !== "") {
                flags.formulaName = fName;
            }
        }
    }

    /**
     * Execute all pending roll actions for a usage message (attack, damage, formula)
     * and persist the resulting rolls back to the message flags.
     */
    static async runActivityActions(message) {
        const flags = message.flags[MODULE_SHORT] ?? (message.flags[MODULE_SHORT] = {});

        // Render-time retry for preCreate resolution failures. preCreate sees the
        // message before it is persisted, so the UUID fallbacks in
        // _getActivityFromMessage can miss and the message arrives here claimed
        // (quickRoll set by processActivity, which already suppressed dnd5e's
        // subsequentActions) but without render flags — and would otherwise be
        // marked processed with zero rolls. By now the message is a full document
        // with getAssociatedActivity available, so resolution that failed at
        // preCreate normally succeeds. Legacy messages (issue #15) cannot reach
        // this: runActivityActions only runs when quickRoll is set and the message
        // is unprocessed. If the activity has no rollable parts, setRenderFlags is
        // an idempotent no-op and the message stays passive as before.
        if (!flags.renderAttack && !flags.renderDamage && !flags.renderFormula && !flags.manualDamage) {
            const activity = ActivityUtility._getActivityFromMessage(message);
            if (activity) {
                ActivityUtility.setRenderFlags(activity, flags);
            }
        }

        let currentRolls = Array.from(flags.rolls || []);
        const newRolls = [];
        // Raw source rolls from before _registerCardAsAttack temporarily preloads the
        // attack. Restoring this snapshot just before the final update lets modern DSN
        // observe every new roll in one appended batch (#32).
        let rollSourceBeforeAttackRegistration = null;

        if (message.flags[MODULE_SHORT].renderAttack) {
            const rawAttack = await ActivityUtility.getAttackFromMessage(message);
            const attackRolls = ActivityUtility._extractRolls(rawAttack);

            if (attackRolls.length > 0) {
                currentRolls = RollUtility.mergeRollsByType(currentRolls, attackRolls, CONFIG.Dice.D20Roll);
                newRolls.push(...attackRolls);
                // dnd5e builds every D20 roll in this attack from one ammunition
                // config, so the first roll is canonical (matching critical handling).
                const ammunition = attackRolls[0]?.options?.ammunition;
                if (ammunition) {
                    message.flags[MODULE_SHORT].ammunition = ammunition;
                } else {
                    delete message.flags[MODULE_SHORT].ammunition;
                }
                // dual flag means a multi-roll was enforced by ALWAYS_ROLL_MULTIROLL;
                // in that case isCritical is determined later during rendering.
                message.flags[MODULE_SHORT].isCritical = message.flags[MODULE_SHORT].dual
                    ? false
                    : ActivityUtility.isCriticalRoll(attackRolls[0]);
            } else {
                message.flags[MODULE_SHORT].isCritical = false;
            }

            // Only when the roll capture did not already decide this card's descriptors.
            // The capture is the roll workflow's own view and is strictly newer than
            // anything _syncAttackTargets can offer here, so letting both writers run
            // would let the current-targets fallback re-stamp a set the capture just
            // cleared on purpose (#38).
            if (!ActivityUtility._consumeCaptureWrite(message)) {
                ActivityUtility._syncAttackTargets(message);
            }

            // Register this card as its own "attack" roll message so condition
            // modules (AC5e) and dnd5e's native attack->damage association can find
            // the attack roll via dnd5e.registry.messages.get(<cardId>, "attack").
            // RSR rolls with create:false and emits no discrete attack message, so
            // the registry would otherwise have no attack entry for this card. Must
            // run BEFORE the damage roll below so the lookup resolves during the
            // damage roll's hooks on the quick-roll (attack+damage) path.
            const sourceRolls = message._source?.rolls ?? message.toObject?.().rolls ?? [];
            const sourceRollSnapshot = foundry.utils.deepClone(sourceRolls);
            if (ActivityUtility._registerCardAsAttack(message, currentRolls)) {
                rollSourceBeforeAttackRegistration = sourceRollSnapshot;
            }
        }

        if (message.flags[MODULE_SHORT].renderDamage) {
            const rawDamage = await ActivityUtility.getDamageFromMessage(message);
            const damageRolls = ActivityUtility._extractRolls(rawDamage);

            if (damageRolls.length > 0) {
                currentRolls = RollUtility.mergeRollsByType(currentRolls, damageRolls, CONFIG.Dice.DamageRoll);
                newRolls.push(...damageRolls);
            }
        }

        if (message.flags[MODULE_SHORT].renderFormula) {
            const rawFormula = await ActivityUtility.getFormulaFromMessage(message);
            const formulaRolls = ActivityUtility._extractRolls(rawFormula);

            if (formulaRolls.length > 0) {
                currentRolls = RollUtility.mergeRollsByType(currentRolls, formulaRolls, CONFIG.Dice.BasicRoll);
                newRolls.push(...formulaRolls);
            }
        }

        await _provideNewRollFeedback(newRolls, message);

        message.flags[MODULE_SHORT].processed = true;
        const serializedRolls = CoreUtility.serializeRolls(currentRolls);
        message.flags[MODULE_SHORT].rolls = serializedRolls;

        const attackRoll = currentRolls.find(r => r instanceof CONFIG.Dice.D20Roll || r.class === "D20Roll" || r.constructor?.name === "D20Roll");
        if (attackRoll) {
            message.flags.dnd5e ??= {};
            message.flags.dnd5e.roll = {
                ...(message.flags.dnd5e.roll ?? {}),
                type: ROLL_TYPE.ATTACK,
                ...(attackRoll.options?.mastery ? { mastery: attackRoll.options.mastery } : {})
            };
            // Persist the self-link so dnd5e's ChatMessage5e#prepareData ->
            // MessageRegistry.track re-registers this card under the "attack" hook on
            // every load. Pairs with the chat.js _injectContent guard that stops a
            // self-referencing card from being treated as its own merge parent.
            message.flags.dnd5e.originatingMessage = message.id;
        }

        if (rollSourceBeforeAttackRegistration !== null) {
            ActivityUtility._restoreRollSource(message, rollSourceBeforeAttackRegistration);
        }

        await ChatUtility.updateChatMessage(message, {
            flags: message.flags,
            rolls: serializedRolls
        });
    }

    /**
     * Execute a single on-demand roll action (currently only ROLL_TYPE.DAMAGE, triggered
     * by the manual damage button) and persist the result.
     */
    static async runActivityAction(message, action) {
        let currentRolls = Array.from(message.flags[MODULE_SHORT]?.rolls || []);
        const newRolls = [];

        switch (action) {
            case ROLL_TYPE.DAMAGE: {
                const rawDamage = await ActivityUtility.getDamageFromMessage(message);
                const damageRolls = ActivityUtility._extractRolls(rawDamage);

                if (damageRolls.length > 0) {
                    currentRolls = RollUtility.mergeRollsByType(currentRolls, damageRolls, CONFIG.Dice.DamageRoll);
                    newRolls.push(...damageRolls);
                }
                break;
            }
        }

        await _provideNewRollFeedback(newRolls, message);

        const serializedRolls = CoreUtility.serializeRolls(currentRolls);
        message.flags[MODULE_SHORT].rolls = serializedRolls;

        await ChatUtility.updateChatMessage(message, {
            flags: message.flags,
            rolls: serializedRolls
        });
    }

    /**
     * Register the activation card as its own "attack" roll message in dnd5e's
     * MessageRegistry, so dnd5e.registry.messages.get(<cardId>, "attack") resolves to
     * this card and its stored attack D20Roll. RSR rolls with create:false and emits no
     * discrete attack message, so without this the registry has no attack entry and
     * condition modules (AC5e) / dnd5e's native attack->damage association cannot
     * recover the attack roll's advantage state.
     *
     * Exposes the attack roll + self-link on the live document in-memory (updateSource:
     * no DB write, no re-render) so the registry lookup resolves to a card whose
     * `.rolls[0]` is the attack D20 and whose `flags.dnd5e.roll.mastery` is set during
     * the immediately following damage roll. This MUST be the live document, not a
     * detached copy: dnd5e's MessageRegistry.get() resolves stored ids back through
     * game.messages.get() (registry.mjs), so condition/mastery modules that read
     * `attackMessage.rolls[0]` (AC5e advantage recovery) or `roll.mastery` (WM5E auto
     * masteries) only ever see this live card. runActivityActions persists the final
     * state afterwards.
     *
     * Dice So Nice consequence: preloading the attack here would make modern DSN treat
     * it as pre-existing and animate only later-appended damage. The caller snapshots
     * and restores the card's raw roll source after all dependent hooks have run, so
     * DSN observes the complete attack-and-damage batch in the final message update.
     *
     * Safe despite the self-referential originatingMessage: chat.js _injectContent
     * guards against treating a self-referencing card as its own merge parent.
     * @param {ChatMessage} message The activation card.
     * @param {Array<Roll|object>} currentRolls Rolls gathered so far (must include the attack).
     * @returns {Boolean} Whether the card was registered (and its rolls preloaded).
     */
    static _registerCardAsAttack(message, currentRolls) {
        const attackRoll = (currentRolls ?? []).find(r => RollUtility.isRollOfType(r, CONFIG.Dice.D20Roll));
        if (!attackRoll || !message?.id) return false;

        const rollFlag = {
            ...(message.flags?.dnd5e?.roll ?? {}),
            type: ROLL_TYPE.ATTACK,
            ...(attackRoll.options?.mastery ? { mastery: attackRoll.options.mastery } : {})
        };

        // In-memory only: expose the attack roll + self-link on the live document so
        // both the registry lookup and AC5e's rolls[0] / WM5E's roll.mastery reads
        // resolve during the immediately following damage roll. runActivityActions
        // persists the final state afterwards.
        //
        // updateSource() re-initialises the document and rebuilds message.flags from
        // _source, which DROPS any in-memory-only RSR flag writes (e.g. isCritical, and
        // render flags set at render time on the preCreate-retry path) — they were never
        // persisted to source. Capture the live RSR flags first and restore them after,
        // so the crit state and render flags survive into the damage roll below. Without
        // this, a crit's damage dice were never doubled (#25, #28).
        //
        // `flags.dnd5e.targets` is in-memory-only for exactly the same reason and needs
        // the same treatment: the roll workflow's target descriptors are written onto the
        // live card by _applyRollCapture (quick-roll capture) or _syncAttackTargets just
        // before this call, while source still holds the stale pre-roll set Activity#use
        // stamped. Without carrying them across, the rebuild reverts every roll-time AC
        // adjustment and the final persisted update saves the stale set — the exact
        // symptom of issue #38, on the path that was supposed to fix it.
        const moduleFlags = message.flags?.[MODULE_SHORT];
        const targetDescriptors = message.flags?.dnd5e?.targets;
        message.updateSource({
            rolls: CoreUtility.serializeRolls(currentRolls),
            "flags.dnd5e.roll": rollFlag,
            "flags.dnd5e.originatingMessage": message.id
        });
        if (moduleFlags) {
            message.flags ??= {};
            message.flags[MODULE_SHORT] = moduleFlags;
        }
        if (targetDescriptors !== undefined) {
            message.flags ??= {};
            message.flags.dnd5e ??= {};
            message.flags.dnd5e.targets = targetDescriptors;
        }

        try {
            dnd5e.registry?.messages?.track?.(message);
        } catch (err) {
            console.warn("RSReforged | failed to register card as attack roll message:", err);
        }

        return true;
    }

    /**
     * Undo only the temporary native-roll preload performed by
     * _registerCardAsAttack. The dnd5e registry flags written by that method remain in
     * source, while an exact snapshot of the live flags and the prepared Roll instances
     * are retained across Foundry's updateSource re-initialisation. This keeps registry consumers
     * able to read the attack d20 while the immediately-following persisted update is
     * pending, even though toObject().rolls exposes the restored raw source to DSN.
     *
     * @param {ChatMessage} message The activation card whose raw rolls should be restored.
     * @param {object[]} sourceRolls Deep-cloned raw roll data captured before registration.
     */
    static _restoreRollSource(message, sourceRolls) {
        const liveFlags = foundry.utils.deepClone(message.flags);
        const liveRolls = message.rolls;
        message.updateSource({ rolls: foundry.utils.deepClone(sourceRolls) });

        // updateSource rebuilds flags from source. Clear that rebuilt object before
        // restoring the snapshot so a namespace deleted by a damage hook is not
        // resurrected and persisted by the immediately-following update.
        for (const key of Object.keys(message.flags)) delete message.flags[key];
        Object.assign(message.flags, liveFlags);
        message.rolls = liveRolls;
    }

    /**
     * Resolve ammunition for a quick attack without replacing dnd5e's picker or
     * remembered-choice flag.
     *
     * Precedence: configured consumption target, first usable equipped option,
     * usable remembered choice, then first usable option in dnd5e's order.
     *
     * @param {Activity} activity The attack activity being rolled.
     * @param {ChatMessage} message The combined usage card.
     * @returns {string|undefined} Item ID, an empty string for no usable ammo, or
     * undefined when the weapon has no ammunition options.
     */
    static _resolveQuickRollAmmunition(activity, message) {
        const captured = message.flags?.[MODULE_SHORT]?.ammunition;
        if (captured) return captured;

        const options = activity.item?.system?.ammunitionOptions ?? [];
        if (!options.length) return undefined;

        const usable = options.filter(option => {
            if (!option?.value || option.disabled === true) return false;
            return (option.item?.system?.quantity ?? 1) > 0;
        });

        const equipped = usable.find(option => option.item?.system?.equipped === true);
        if (equipped) return equipped.value;

        const remembered = activity.item?.getFlag?.(
            "dnd5e",
            `last.${activity.id}.ammunition`
        );
        if (usable.some(option => option.value === remembered)) return remembered;

        return usable[0]?.value ?? "";
    }

    /**
     * Roll the attack for the activity associated with this message.
     *
     * dnd5e 5.3.0: rollAttack() merges our config object into its own rollConfig via
     * foundry.utils.mergeObject, then passes config.advantage / config.disadvantage
     * into D20Roll.applyKeybindings() (line 78549), which sets roll.options.advantageMode.
     * Passing them at the top level of the config object is therefore the correct approach.
     *
     * rollAttack() looks up the resolved ammunition item internally; passing its ID
     * in config means it reaches roll.options.ammunition for damage and card state.
     */
    static getAttackFromMessage(message) {
        const activity = ActivityUtility._getActivityFromMessage(message);
        if (!activity || typeof activity.rollAttack !== "function") return null;

        const attackMode = message.flags[MODULE_SHORT].attackMode;
        const ammunition = ActivityUtility._resolveQuickRollAmmunition(activity, message);
        const actor = ActivityUtility._getActorFromMessage(message) ?? activity.actor;
        const ammunitionItem = ammunition ? actor?.items?.get(ammunition) : undefined;
        // dnd5e deletes quantity-one autoDestroy ammunition before rollAttack resolves.
        // Snapshot it up front so the immediately-following damage roll can still merge
        // ammunition-specific damage and properties if the live Item disappears.
        const ammunitionData = ammunitionItem?.toObject?.();
        const config = {
            advantage:    message.flags[MODULE_SHORT].advantage    ?? false,
            disadvantage: message.flags[MODULE_SHORT].disadvantage ?? false,
            ...(ammunition !== undefined ? { ammunition } : {}),
            ...(attackMode ? { attackMode } : {})
        };

        // Correlation token for the capture hook (see captureRollMessageConfig). It goes
        // in data.flags only — the top-level flags block is what dnd5e copies onto the
        // roll message itself, and RSR's internal bookkeeping has no business there.
        const captureId = ActivityUtility._nextRollCaptureId();

        const dialogConfig  = { configure: false };
        const messageConfig = { create: false, data: { flags: {} }, flags: {} };
        messageConfig.data.flags[MODULE_SHORT] = { quickRoll: true, captureId };
        messageConfig.flags[MODULE_SHORT]      = { quickRoll: true };

        let attackResult;
        try {
            attackResult = activity.rollAttack(config, dialogConfig, messageConfig);
        } catch (err) {
            // A synchronous throw (only reachable if something wraps rollAttack) skips
            // the promise chain below, so the capture has to be released here too.
            ActivityUtility._consumeRollCapture(captureId);
            throw err;
        }

        return Promise.resolve(attackResult)
            .then(rolls => {
                if (ammunitionData && !actor?.items?.get(ammunition)) {
                    message.flags.dnd5e ??= {};
                    message.flags.dnd5e.roll ??= {};
                    message.flags.dnd5e.roll.ammunitionData = ammunitionData;
                }
                // Carry the roll workflow's own view of the targets onto the card, and
                // record that it happened. runActivityActions calls _syncAttackTargets
                // right after this and would otherwise re-derive the descriptors from the
                // user's current targets whenever the capture wrote an EMPTY list — the
                // one case a `?.length` guard there cannot tell apart from "no targets
                // written yet". The marker makes the capture the final word instead (#38).
                if (ActivityUtility._applyRollCapture(message, ActivityUtility._consumeRollCapture(captureId))) {
                    _captureWrittenCards.add(message);
                }
                return rolls;
            })
            .finally(() => { ActivityUtility._consumeRollCapture(captureId); });
    }

    /**
     * Roll damage for the activity associated with this message.
     *
     * dnd5e 5.3.0: scaling is stored in message.system.scaling (a NumberField on
     * UsageMessageData, written at line 17085 of dnd5e.mjs). The legacy path
     * message.flags?.dnd5e?.scaling is kept as a fallback for older persisted messages.
     *
     * Scaling is applied two ways:
     *   1. usageConfig.scaling   → used by getDamageConfig → _processDamagePart via
     *                              `rollConfig.scaling ?? rollData.scaling` (line 12494).
     *   2. activity.item.flags.dnd5e.scaling → populates rollData.scaling through
     *                              getRollData() on the item clone, which is the path
     *                              `rollData.scaling` in _processDamagePart falls back to.
     *
     * Both paths remain necessary: (1) is authoritative when the activity is called
     * outside a full use() workflow (as RSR does), and (2) ensures the item's own
     * formula variables resolve correctly for cantrips and other scaling modes that
     * read rollData rather than rollConfig.
     *
     * midiOptions is not part of the dnd5e 5.3.0 API but is read by midi-qol from the
     * config object when that module is active; it is left in place.
     */
    static getDamageFromMessage(message) {
        const activity = ActivityUtility._getActivityFromMessage(message);
        const actor    = ActivityUtility._getActorFromMessage(message);

        if (!activity || !actor || typeof activity.rollDamage !== "function") return null;

        // Resolve scaling from system data (5.3.0 canonical) with flags fallback.
        const scaling = message.system?.scaling ?? message.flags?.dnd5e?.scaling ?? 0;

        // Stamp scaling onto the item clone so rollData.scaling is populated correctly
        // for formula resolution (see getDamageConfig → getRollData path).
        activity.item.flags.dnd5e ??= {};
        if (scaling > 0 && activity.item.flags.dnd5e.scaling !== scaling) {
            activity.item.flags.dnd5e.scaling = scaling;
        }

        const attackMode = message.flags[MODULE_SHORT].attackMode;
        const ammunitionId = message.flags[MODULE_SHORT].ammunition;
        const storedAmmunition = message.flags?.dnd5e?.roll?.ammunitionData;
        const storedAmmunitionId = storedAmmunition?._id ?? storedAmmunition?.id;
        const ammunition = actor.items?.get(ammunitionId)
            ?? (ammunitionId && storedAmmunitionId === ammunitionId && globalThis.Item?.implementation
                ? new Item.implementation(storedAmmunition, { parent: actor })
                : undefined);
        const config = {
            isCritical: message.flags[MODULE_SHORT].isCritical ?? false,
            // Pass the live Item document, or dnd5e-style reconstructed data when the
            // final autoDestroy unit was deleted, so rollDamage can read ammo properties.
            ammunition,
            // Only override rollConfig.scaling when there's an upcast delta. For
            // cantrips and base-level casts, leave scaling undefined so dnd5e's
            // _processDamagePart falls through to rollData.scaling (the Scaling
            // instance auto-computed by Item5e#scalingIncrease → SpellData, which
            // applies Math.floor((cantripLevel + 1) / 6) for cantrips). Passing
            // scaling: 0 forces scaledFormula(0) because rollConfig.scaling is
            // nullish-coalesced with rollData.scaling at dnd5e.mjs:12545.
            ...(scaling > 0 ? { scaling } : {}),
            // dnd5e's AttackActivity.rollDamage swaps the base damage formula for
            // the versatile formula when attackMode === "twoHanded" && item.isVersatile
            // (dnd5e.mjs:28327-28328), and clamps the mod for *-offhand modes
            // (dnd5e.mjs:28343). Forwarding attackMode is therefore enough — no
            // formula manipulation needed on our side.
            ...(attackMode ? { attackMode } : {}),
            midiOptions: CoreUtility.hasModule(MODULE_MIDI)
                ? {
                    isCritical: message.flags[MODULE_SHORT].isCritical ?? false,
                    ...(attackMode ? { attackMode } : {})
                }
                : undefined
        };

        // Skip activities that resolve to zero damage parts under the resolved config
        // (e.g. SaveActivity for Faerie Fire / Bane). Passing the same `config`
        // rollDamage will use keeps ammo-driven attacks alive — AttackActivity.getDamageConfig
        // only merges ammunition damage when config.ammunition is set
        // (dnd5e.mjs AttackActivity#getDamageConfig), so calling it with `{}` would
        // false-negative on weapons whose damage comes entirely from the ammo.
        if (typeof activity.getDamageConfig === "function" && !activity.getDamageConfig(config).rolls?.length) return null;

        const dialogConfig  = { configure: false };
        const messageConfig = { create: false, data: { flags: {} }, flags: {} };
        messageConfig.data.flags[MODULE_SHORT] = { quickRoll: true };
        messageConfig.flags[MODULE_SHORT]      = { quickRoll: true };
        // Anchor this damage roll to its card so condition modules (AC5e) resolve the
        // originating attack via dnd5e.registry.messages.get(<cardId>, "attack"). AC5e
        // reads flags.dnd5e.originatingMessage off the message config's `data` (the
        // dot-notation key first, then the nested object), so set both shapes.
        messageConfig.data["flags.dnd5e.originatingMessage"] = message.id;
        messageConfig.data.flags.dnd5e = { originatingMessage: message.id };
        messageConfig.flags.dnd5e      = { originatingMessage: message.id };

        // Chained rather than awaited so the guards above stay synchronous — marking this
        // method async would turn each of their early `null` returns into a Promise.
        return Promise.resolve(activity.rollDamage(config, dialogConfig, messageConfig))
            .then(rolls => _applyDamageTypeOverrides(message, rolls));
    }

    /**
     * Record the chosen damage types as the activity's defaults, so the next roll starts
     * from them (issue #27).
     *
     * This is dnd5e's own flag: Activity#rollDamage writes it after every damage build
     * (not only dialog rolls), and Activity#_processDamagePart reads it back as `lastType`.
     * A quick roll therefore already records a type — but only the one dnd5e auto-picked,
     * because the card click that changes it never goes through rollDamage. Without this
     * write, a feature like Empowered Strikes — whose dnd5e description promises the
     * choice is remembered — would reset to the auto-pick on every roll.
     *
     * Keyed by damage-roll index to match dnd5e's own write. The guards mirror
     * Activity#rollDamage: a compendium, unowned, or off-actor item must not be written to.
     *
     * @param {ChatMessage} message The card the choice was made on.
     * @param {Roll[]} damageRolls The card's damage rolls, in order.
     */
    static async rememberDamageTypes(message, damageRolls) {
        const activity = ActivityUtility._getActivityFromMessage(message);
        const item = activity?.item;

        if (!item?.isOwner || item.inCompendium) return;
        if (!activity.actor?.items?.has(item.id)) return;

        const lastDamageTypes = damageRolls.reduce((types, roll, index) => {
            if (roll.options?.type) types[index] = roll.options.type;
            return types;
        }, {});

        if (foundry.utils.isEmpty(lastDamageTypes)) return;

        await item.setFlag("dnd5e", `last.${activity.id}.damageType`, lastDamageTypes);
    }

    /**
     * Roll the utility formula for the activity associated with this message.
     *
     * dnd5e 5.3.0: UtilityActivity.rollFormula() uses rollConfig.scaling (passed via
     * getRollData / scaledFormula) but does not explicitly consume a scaling field from
     * config the way rollDamage does. Passing it anyway is harmless and future-proof.
     */
    static getFormulaFromMessage(message) {
        const activity = ActivityUtility._getActivityFromMessage(message);
        if (!activity || typeof activity.rollFormula !== "function") return null;

        const scaling = message.system?.scaling ?? message.flags?.dnd5e?.scaling ?? 0;

        activity.item.flags.dnd5e ??= {};
        if (scaling > 0 && activity.item.flags.dnd5e.scaling !== scaling) {
            activity.item.flags.dnd5e.scaling = scaling;
        }

        // See getDamageFromMessage for rationale — only pass scaling when > 0 so
        // cantrips fall through to rollData.scaling for auto-computation.
        const config        = scaling > 0 ? { scaling } : {};
        const dialogConfig  = { configure: false };
        const messageConfig = { create: false, data: { flags: {} }, flags: {} };
        messageConfig.data.flags[MODULE_SHORT] = { quickRoll: true };
        messageConfig.flags[MODULE_SHORT]      = { quickRoll: true };

        return activity.rollFormula(config, dialogConfig, messageConfig);
    }
}

/**
 * Re-apply the damage types the user picked on the card (issue #27).
 *
 * rollDamage() re-runs dnd5e's _processDamagePart, which re-picks the default type
 * (lastType ?? types.first()). Without this, every path that re-derives damage —
 * retroactive crit, manual damage — would silently discard the user's choice.
 *
 * Overrides are keyed by index into the damage rolls, matching the array rollDamage
 * returns. A saved type is ignored unless the roll still offers it, so an activity
 * edited between rolls cannot resurrect a type it no longer has.
 *
 * @param {ChatMessage} message The card carrying the saved choices.
 * @param {Roll[]} rolls The freshly derived damage rolls.
 * @returns {Roll[]} The same rolls, with any saved types re-applied.
 */
function _applyDamageTypeOverrides(message, rolls) {
    const overrides = message.flags?.[MODULE_SHORT]?.damageTypes;
    if (!overrides || !Array.isArray(rolls)) return rolls;

    for (const [index, type] of Object.entries(overrides)) {
        const roll = rolls[Number(index)];
        if (!roll?.options?.types?.includes(type)) continue;

        roll.options.type = type;
    }

    return rolls;
}

/**
 * Provide any roll feedback that must happen before the final ChatMessage update.
 * Modern Dice So Nice intentionally does nothing here because it watches that update
 * and owns animation of the complete appended roll batch; manually calling showForRoll
 * would double-animate the dice (#18). Older DSN versions ignore update-appended rolls,
 * so animate them manually. With no enabled DSN, play the dice sound fallback.
 *
 * @param {Roll[]} newRolls The rolls added in this action.
 * @param {ChatMessage} message The message the rolls are persisted to.
 */
async function _provideNewRollFeedback(newRolls, message) {
    if (newRolls.length === 0) return;

    if (!game.dice3d || !game.dice3d.isEnabled()) {
        CoreUtility.playRollSound();
        return;
    }

    if (!CoreUtility.dice3dAnimatesRollUpdates()) {
        // Legacy DSN ignores update-appended rolls entirely: animate every new roll.
        await CoreUtility.tryRollDice3D(newRolls, message.id);
    }
}
