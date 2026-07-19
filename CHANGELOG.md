# Changelog

All notable changes to RSReforged are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.13.2] — 2026-07-19

### Fixed

- **Quick-roll damage cards no longer show two damage-application trays on dnd5e 5.3.1+.** dnd5e 5.3.1 started injecting its own `<damage-application>` tray into any usage card whose rolls contain damage rolls, duplicating the apply UI RSReforged adds — one tray above the weapon properties and one below. With the *RSReforged quick buttons* apply mode the system tray is now removed (RSR's buttons are the apply UI); with the *dnd5e tray* apply mode the system's own tray is kept as the single tray and RSReforged's duplicate is dropped. Behavior on dnd5e 5.3.0 is unchanged, and tray collapse-state restoration (issue #33) targets the surviving tray. Verified compatibility bumped to dnd5e 5.3.3. Fixes [#37](https://github.com/arrowedisgaming/RSReforged/issues/37).

## [4.13.1] — 2026-07-18

### Fixed

- **Weapons without ammunition (melee and thrown weapons) roll again.** 4.13.0's equipped-ammunition support can rebuild deleted auto-destroy ammunition from a snapshot stored on the card, but for a weapon with no ammunition at all the rebuild guard compared two undefined values as equal and constructed an invalid Item — aborting the entire quick roll with a validation error: no rolls, no chat card. Ammunition weapons were unaffected. Fixes [#36](https://github.com/arrowedisgaming/RSReforged/issues/36).

## [4.13.0] — 2026-07-17

### Added

- **Quick weapon attacks now prefer equipped ammunition.** RSReforged chooses an available equipped option first; when none is equipped, it reuses the last usable ammunition used for that weapon's attack and then falls back to the first available option. The chosen item remains consistent through attack consumption, ammunition-added damage, and the chat-card label. Hold the dnd5e **Skip Dialog** modifier to choose a different type for one attack; dnd5e records it as the last-used option. Implements [#35](https://github.com/arrowedisgaming/RSReforged/issues/35).

## [4.12.0] — 2026-07-15

### Added

- **Damage types can now be changed on the chat card for activities that offer more than one.** Activities whose damage part lists several types (Pact of the Blade, Empowered Strikes, and similar) previously had their type auto-picked by dnd5e, because quick rolls skip the damage dialog where that choice normally lives — leaving no way to change it short of turning quick rolls off. The type label on such a damage part is now clickable and cycles through the available types. Nothing is re-rolled, so the total is untouched; only the type changes, and applying damage honors the new type's resistances and immunities. The choice sticks to the card, surviving a retroactive crit or a manual damage roll, and is limited to the GM and the card's author. Parts with a single fixed type are unchanged. Requires the **Damage Apply UI** setting to be *RSReforged quick buttons* — the dnd5e tray renders its own damage card, which RSReforged does not decorate. Implements [#27](https://github.com/arrowedisgaming/RSReforged/issues/27).
- **A damage type picked on a card now becomes the activity's default for later rolls**, matching what dnd5e does when the choice is made in its own damage dialog — so a feature like Empowered Strikes, whose description promises the choice is remembered, no longer resets on every quick roll. As in dnd5e, the default is only recorded for an owned item that is still on the actor and not in a compendium.

## [4.11.5] — 2026-07-14

### Fixed

- **Weapons that consume a resource via a "Consume Resource" target now spend the correct amount on a quick roll.** RSReforged was adding one unit back to dnd5e's already-computed consumption payload, which cancelled a unit of consumption for quantity-backed material targets — a vehicle cannon set to consume one cannonball consumed zero (and two consumed one), and the standalone **Consume Resource** button did nothing. The restore is now applied only to genuine weapon ammunition that dnd5e's attack roll consumes a second time, so material targets keep their full decrement while ammo still avoids double-counting. Fixes [#34](https://github.com/arrowedisgaming/RSReforged/issues/34).

## [4.11.4] — 2026-07-13

### Fixed

- **Quick-roll attack and damage dice no longer have an RSR-imposed animation delay with Dice So Nice.** The attack d20 is still preloaded temporarily so dnd5e's message registry and condition/mastery modules can resolve it while damage hooks run, but RSReforged now restores the card's raw pre-registration roll source immediately before the final update. Modern Dice So Nice therefore receives the complete attack-and-damage batch through its normal message-update integration instead of waiting for a separately broadcast d20 animation to finish first. Fixes [#32](https://github.com/arrowedisgaming/RSReforged/issues/32).

## [4.11.3] — 2026-07-11

### Fixed

- Merged quick-roll cards now honor dnd5e's **Collapse Chat Card Trays** preference and preserve manual state for the Target and native Apply trays, instead of forcing both trays closed after RSReforged rebuilds the card. Fixes [#33](https://github.com/arrowedisgaming/RSReforged/issues/33).

## [4.11.2] — 2026-07-03

### Fixed

- The activity usage dialog now shows for features whose consumption allows scaling (e.g. **Lay on Hands**), so players can choose how much of a resource to spend instead of the full amount being consumed silently on a quick roll. Fixes [#30](https://github.com/arrowedisgaming/RSReforged/issues/30).

## [4.11.1] — 2026-07-03

### Fixed

- Chat no longer force-scrolls every player to the newest roll on each quick-roll render or update. RSReforged now only re-pins the chat log when the user is already at the bottom (matching Foundry core behavior), so scrolling back through history is no longer interrupted. Fixes [#31](https://github.com/arrowedisgaming/RSReforged/issues/31).

## [4.11.0] — 2026-07-01

### Added

- **Hidden Roll Style** setting for hidden NPC rolls (issue #23). Choose **Hide Total** (mask the modified total, show the natural d20 — original behavior) or **Hide Breakdown** (show the final total while masking the natural d20 value and all modifiers). Defaults to Hide Total, so existing worlds are unchanged.

- French (`fr`) and Brazilian Portuguese (`pt-BR`) translations for the Hidden Roll Style setting and its choices.

### Fixed

- Hide Breakdown style now collapses advantage/disadvantage rolls to the single final total, so the discarded die no longer reveals that advantage was in play.
- Hide Breakdown style no longer tags the revealed total with a success/failure crit class, closing a residual leak of a natural 20/1 to players inspecting the chat card.

## [4.10.2] — 2026-06-29

### Fixed
- **Quick-roll critical hits now pass the real dnd5e critical state into damage rolls again.** Serialized attack rolls can lose the live `D20Roll.isCritical` getter after being rebuilt from stored roll data, so RSR now derives critical state from the underlying d20 term before rolling damage. Critical detection runs through the same crit logic that drives the rendered "Critical Hit!" styling (`RollUtility.getCritTypeForDie`), so the doubled damage dice and the card styling can no longer disagree: forced criticals, improved-critical thresholds (crit on 19/18), and rerolled or discarded dice (e.g. Halfling Luck, advantage/disadvantage) are all handled consistently. Damage detection is gated on the d20 roll class, so a damage formula that happens to contain a d20 die is no longer mistaken for a critical attack. Additionally, the freshly-detected critical state previously survived to the damage roll only by accident: anchoring the card as its own attack-roll message (for AC5e/WM5E) calls `message.updateSource()`, which re-initialises the document and rebuilds its flags from the persisted source — silently dropping the in-memory `isCritical` (and, on the preCreate-retry path, the render flags), so a confirmed critical still rolled un-doubled damage. RSR now preserves its module flags across that re-initialisation. This restores dnd5e's own critical dice doubling and max-critical-dice handling without changing damage formulas in RSR. Fixes [#25](https://github.com/arrowedisgaming/RSReforged/issues/25) and [#28](https://github.com/arrowedisgaming/RSReforged/issues/28).

## [4.10.1] — 2026-06-15

### Fixed
- **The attack d20 now animates under Dice So Nice on quick rolls.** To let condition/mastery modules (AC5e, WM5E) read the attack during the immediately following damage roll, RSR exposes the attack roll on the card in-memory before rolling damage — but that put the roll into the document source, so modern DSN's update watcher (which only animates rolls *appended* by the update) treated the attack d20 as pre-existing and animated only the damage; an attack-only quick roll animated nothing at all. RSR now rolls the preloaded attack die itself while DSN continues to animate the appended damage, so each die animates exactly once with no double roll. The attack roll stays on the live card, so AC5e advantage recovery and WM5E auto-masteries (which resolve the card through dnd5e's `MessageRegistry`, i.e. the live document) keep working.

## [4.10.0] — 2026-06-14

### Added
- **Retroactive bonus damage types.** Bonus Active Effects (`flags.rsreforged.bonus`) now accept damage-type keywords that take effect on damage rolls: a bare dnd5e type (e.g. `fire`) fixes the bonus to that type with no prompt, `random:<type,…>` picks one of the listed types at random each time the bonus is applied, and `choice:<type,…>` adds a dropdown to the bonus dialog for the player to choose. With no formula a damage-type token contributes `0` of that type (a pure tag); on any non-damage roll the bonus is added untyped. Via [#22](https://github.com/arrowedisgaming/RSReforged/pull/22).
- **Automated Conditions 5e (AC5e) compatibility on merged quick-roll cards.** RSR rolls with `create: false` and emits no discrete attack message, so dnd5e's `MessageRegistry` held no attack entry for a quick-roll card and condition modules could not recover the attack's advantage state for the following damage roll. RSR now self-registers the activation card under the registry's `attack` hook — persisted via `flags.dnd5e.originatingMessage` so it re-registers on reload — and anchors damage rolls back to the card, while guarding the chat-card merge logic against treating a self-referencing card as its own parent. Via [#22](https://github.com/arrowedisgaming/RSReforged/pull/22). Tested on Foundry VTT v14.363, dnd5e 5.3.3, AC5e v14.533.4.1.

### Fixed
- **wm5e mastery actions (Sap, Slow, Vex, etc.) no longer throw when clicked on merged quick-roll cards.** wm5e resolves the attacked actor from `flags.dnd5e.targets[0].uuid`; RSR's `create: false` attack path never copied that enrichment onto the parent card. Targets are now stamped from the child attack message during merge, or from the user's targeted tokens at quick-roll attack time when no child message exists. The token fallback mirrors dnd5e's own target-descriptor shape — a fully-covered target carries `ac: null` (no false hit/miss in the card's target tray), a missing AC coerces to `null` rather than `undefined`, and multiple tokens of one actor collapse to a single entry.
- **Retroactive advantage and attack-targeted bonuses now re-register the upgraded attack roll with dnd5e's `MessageRegistry`.** RSR stores authoritative rolls in flags and renders from them, but AC5e reads the native `message.rolls` through the registry; without a re-sync, declaring advantage (or applying a bonus to the attack) *after* the initial roll left AC5e resolving the pre-upgrade roll on a subsequent damage roll. The card now refreshes its registry entry in-memory after any attack-roll mutation, so advantage-conditioned effects evaluate against the current roll.
- **Invalid damage types in `random:`/`choice:` bonus lists are dropped with a console warning** instead of passing through to the roll as free-text flavor and producing silently miscategorized damage that skips target resistances; a list left with no valid types degrades to an untyped bonus.

### Changed
- **Bonus-dialog damage-type labels are localized** (en / fr / pt-BR) and render dnd5e's own damage-type names, so the random/choice/fixed type chrome follows the active language.

## [4.9.0] — 2026-06-13

### Added
- **Hide NPC Roll Results setting** — replaces the legacy attack-only toggle with a scope dropdown (Off / NPC attacks only / All NPC d20 rolls except damage). Fixes [#17](https://github.com/arrowedisgaming/RSReforged/issues/17). For quick rolls by actors a player does not own, players see only the natural d20 result and `???` instead of the modified total, tooltip modifiers, and DC pass/fail icons; damage and healing totals remain fully visible. GMs and actor owners always see full results; if a roll's actor cannot be resolved, the total is hidden from players rather than leaked. Worlds that had the old **Hide Result of NPC Attacks** boolean enabled migrate to **NPC attacks only** the first time a GM loads the world (one-shot — setting the mode back to Off afterwards sticks).

### Fixed
- **NPC attack totals stay hidden during the post-upgrade migration window.** The legacy→mode migration is GM-only and runs at `ready`, so a non-GM client (or any client before a GM has loaded the upgraded world) could briefly render with `hideNpcRollMode` still at its `none` default while the old `enableHideFinalResult` flag was still set. `shouldHideNpcRollTotal` now honors that legacy flag as attack-only hiding (its original behavior) until the migration clears it — a read-only fallback, no write from non-GM clients.
- **The heart/healing button now restores max HP from a `maximum`-type damage card, instead of reducing it.** The healing intent is read from the button (the heart carries the negative multiplier) rather than only from the message's activity type, so clicking the heart on a max-HP-reduction roll applies it as max-HP healing.
- **Hidden NPC d20 rolls no longer leak bonus dice such as Bless or Guidance.** A masked roll's tooltip previously stripped only flat modifiers; a bonus die rendered as its own (non-constant) tooltip part, exposing both the buff and its rolled value. `_applyHiddenRollPresentation` now keeps only the natural d20 part and removes every other tooltip part (flat modifiers and bonus dice alike), so a non-owner sees just the natural die as the setting promises.
- **Damage application now resolves the damage type from the authoritative roll data instead of falling back to a raw label that matches no system key.** When neither the rendered damage icon nor the localized label maps to a known `CONFIG.DND5E` damage/healing type, `_getApplyDamageType` now prefers the type carried on the message's `DamageRoll.options` over the lowercased label string — so a multi-type damage component on a non-English world (or after a dnd5e UI revision) no longer silently applies as an unrecognized type that skips target resistances, immunities, and vulnerabilities.
- **Temp-HP rolls apply as temporary hit points from the healing button, not just the dedicated temp button.** `_getApplyDamage` no longer rewrites a `temphp` type to `healing` when the negative-multiplier healing button is used, so `_shouldApplyAsTempHP` detects it regardless of which apply button a user clicks; the temp-HP branch now also respects the button multiplier rather than silently discarding it.
- **The legacy `enableHideFinalResult` flag is no longer reload-flagged**, so the one-shot migration that clears it on first post-upgrade load doesn't pop Foundry's "reload required" prompt for an internal setting that is never shown in the UI and never affects rendering directly.
- **Concentration saves stamped with the dedicated `concentration` roll type are now routed through the NPC-hide path**, matching the roll types `D20_NPC_ROLL_TYPES` already declares as hideable (dnd5e currently stamps them as `save`; this keeps coverage correct if a future system version stamps them directly).
- **Aid-style max-HP (`maximum`) rolls applied via the heart/healing button now raise max HP instead of dealing damage.** `_getApplyDamage` no longer collapses a `maximum` type to `healing` on the negative-multiplier button, so the type survives to `applyDamage` and dnd5e's `only: "healing"` path applies it correctly — previously clicking the intuitive heart button (rather than the x1 button) stripped the type and dealt damage. Both the single-line and apply-total buttons now pass the multiplier magnitude to `applyDamage` (heal-vs-damage direction is carried by the type / `only` option, not the multiplier sign), so the per-line healing button heals rather than damaging.
- **A non-numeric or empty damage total no longer writes `NaN` into a target's HP.** `_getApplyDamage` fails the parsed value safe to a `0` no-op instead of propagating `NaN` through `applyDamage`/`applyTempHP`.

### Changed
- **Damage-apply internals** deserialize the message rolls once per apply click and reuse them across every damage die (previously each die re-deserialized the roll collection up to three times), hoist the target-invariant apply options / temp-HP value / temp-vs-damage decision out of the per-target loop (previously recomputed once per targeted token), share a single `_isDamageRoll` predicate instead of duplicating the `DamageRoll` detection inline, cache the damage-label→type reverse map (rebuilt only if the registered type set changes size) instead of rebuilding the merged damage/healing map on every lookup, drop a dead single-type tier from `_getApplyDamageType` that the multi-type fallback already covered, and drop an unused parameter from `_configureRollVisibility`.

## [4.8.2] — 2026-06-04

### Fixed
- **Weapon-mastery attack quick rolls no longer throw dnd5e's `.flavor-text.remove()` error, duplicate the item header, or double-animate the attack d20 in Dice So Nice.** Fixes [#18](https://github.com/arrowedisgaming/RSReforged/issues/18). Processed quick usage cards keep `flags.dnd5e.roll.mastery` for mastery consumers, but RSR now hides `flags.dnd5e.roll` during dnd5e's usage-card enrichment and restores it before RSR renders the rebuilt card; the suppression also self-heals at the start of each render pass, so a render chain interrupted by another module's error can never leave the flag missing across later renders. Child attack and damage roll merges replace existing same-type rolls instead of appending, so a weapon attack card ends with one attack `D20Roll` while preserving existing damage rolls — and a child whose rolls fail to deserialize leaves the parent's rolls untouched rather than evicting them with no replacement. RSR's internal dice fragment renders still strip `flags.dnd5e.item` from cloned `roll.toMessage()` payloads. Activity roll persistence lets Dice So Nice animate the `ChatMessage.update({ rolls })` itself instead of manually calling `showForRoll` first; DSN versions older than 5.1.0 (which only animate on message creation) still get the manual 3D roll, and the dice-sound fallback plays when no enabled DSN is present.
- **Standalone damage quick rolls clear the duplicated flavor text in the chat-message header again.** Foundry renders a roll message's `.flavor-text` inside `.message-header` — a sibling of `.message-content` — so the clear now climbs to the `.chat-message` root instead of searching only within the message body, while staying scoped to the one message so it can never blank flavor text of neighbouring cards.

## [4.8.1] — 2026-06-03

### Fixed
- **A quick-rolled activity whose message activity can't be resolved during `preCreateChatMessage` no longer produces an empty, roll-less card.** On the quick path `RollUtility.processActivity` suppresses dnd5e's own follow-up rolls (`usageConfig.subsequentActions = false`) and seeds `flags.rsreforged.quickRoll` before the message exists; if `_getActivityFromMessage` then failed in preCreate (UUID lookups can miss on a not-yet-persisted document), the message reached `ActivityUtility.runActivityActions` with no render flags and was marked `processed` with zero rolls — losing the roll entirely. `runActivityActions` now retries activity resolution at render time, when the persisted document's `getAssociatedActivity` is available, and derives render flags via `setRenderFlags` before rolling. The retry is guarded (`quickRoll` set, unprocessed, no render flags present) so legacy pre-RSR usage messages stay passive per [#15](https://github.com/arrowedisgaming/RSReforged/issues/15); the preCreate failure now logs a warning instead of an error since it is recoverable.
- **Enabling RSReforged no longer rerolls existing usage chat messages.** Fixes [#15](https://github.com/arrowedisgaming/RSReforged/issues/15). `ChatUtility.processChatMessage` no longer stamps `flags.rsreforged` on author-owned usage cards that lack them at render time; only messages claimed during creation (`preCreateChatMessage`, `RollUtility.processActivity`) enter the quick-roll pipeline, so module enable or chat re-render leaves pre-RSR history passive.
- **Disabling "Enable Quick Roll for Activities" now actually stops activities from being quick-rolled.** The removed render-time stamping path had ignored the `enableActivityQuickRoll` setting, so newly used activities were still pulled into the quick-roll pipeline (and re-rolled on top of dnd5e's own rolls) even with the toggle off. Activity rendering now respects the setting consistently with every other quick-roll hook, matching the setting's documented behavior of falling back to the normal dnd5e dialog.

### Removed
- **`docs/upstream-v3.5.0-snapshot/`** — the vendored read-only copy of the upstream RSR v3.5.0 source. The upstream [`release-3.5.0` tag](https://github.com/MangoFVTT/fvtt-ready-set-roll-5e/releases/tag/release-3.5.0) serves the same reference/diffing purpose without bloating the repo, and the snapshot remains available in git history (last present at `f59b91e`). `README.md` and `docs/foundry-listing.html` now point at the upstream tag instead.

## [4.8.0] — 2026-06-03

### Added
- **jsdom + jQuery-backed unit test harness** (`tests/helpers/foundry-env.mjs`) that mocks the Foundry/dnd5e global environment, now tracked alongside the `jsdom` / `jquery` / `@vitest/coverage-v8` dev-dependencies that imply it (previously the harness, `vitest.config.mjs`, and most test files were untracked, so the green suite could not be reproduced from a clean clone). Adds `vitest.config.mjs` with v8 coverage gating (statements 45 / branches 40 / functions 50 / lines 48) wired through `test:watch` and `test:coverage` scripts. The suite now covers the activity flow, chat rendering, critical/reroll/bonus paths, settings, and module-entry hook wiring (98 tests).

### Changed
- **Test harness now models roll-total recomputation faithfully** so interactive-dice regressions are caught instead of masked: `Roll.total` is a getter over `_total`, `Die.total` recomputes from its live results, and `Roll._evaluateTotal()` re-sums its terms. The reroll keep-high/keep-low tests were rewritten to drive the real `RerollManager._recalculateModifiers` delegation (instead of a stubbed `_evaluateModifiers`) and assert the refolded total. `game.settings.get` is now namespace-aware (foreign namespaces such as `core.rollMode` resolve to realistic defaults rather than leaking RSR values), `game.keybindings.get` returns `[]` for unregistered actions to match Foundry, the `applyDamageTo` targeting tests now exercise the real registered default (selected-only), and `module-entry.test.mjs` verifies the real init/ready hook wiring rather than a mocked call count.

## [4.7.2] — 2026-06-03

### Fixed
- **Weapon-mastery supplements now survive the quick-roll merge that deletes the child attack message.** Follow-up to [#13](https://github.com/arrowedisgaming/RSReforged/issues/13): the 4.7.1 fix preserved `.supplement` content on standalone cards, but on a quick-rolled activity the attack roll arrives as a *separate* dnd5e message whose mastery anchor RSR merges into the parent activity card before deleting the child — so the supplement (and the roll itself) were lost on the way over. RSR now snapshots the child's rendered `.supplement` HTML onto `flags.rsreforged.supplements[type]` before the merge (`_storeSupplementsForMerge` / `_snapshotSupplements` in `src/utils/chat.js`), then re-hydrates it under the matching `.rsr-section-attack` / `.rsr-section-damage` host on the parent's next render (`_restoreStoredSupplements`). Restored nodes carry `data-rsr-restored-supplement` and are cleared-then-rebuilt each render so repeated `message.update()` re-renders stay idempotent. When mastery metadata is present but no supplement survived, RSR generates a native-style mastery content-link as a fallback (`_restoreMasterySupplement`), running *after* the live supplement placement pass and de-duplicating by `data-uuid` / `data-tooltip` so it never doubles up an anchor dnd5e already rendered; the link label is resolved through `CONFIG.DND5E.weaponMasteries[...].label` and localized so `fr` / `pt-BR` installs match dnd5e's native display.
- **Merged quick-activity rolls are now synced onto the parent `ChatMessage.rolls` collection** on both the quick-roll path (`ActivityUtility.runActivityActions`) and the manual damage-button path (`ActivityUtility.runActivityAction`) in `src/utils/activity.js`, so the rolls collection no longer goes stale relative to `flags.rsreforged.rolls` after a manual damage click. The attack roll's `mastery` is also copied onto `flags.dnd5e.roll`, so wm5e's click handlers resolve the mastery off the merged card instead of the deleted child.

## [4.7.1] — 2026-06-02

### Fixed
- **dnd5e `.supplement` content (mastery anchors, damage-on-save notes, legendary-resistance flags) now survives RSR's chat-card rebuild.** Fixes [#13](https://github.com/arrowedisgaming/RSReforged/issues/13). Three stacked regressions are addressed in `src/utils/chat.js`: (1) the strip block that removed plain `.dnd5e2.chat-card` wrappers to avoid duplicate damage UIs would take any `<p class="supplement">` dnd5e's `_enrichAttackTargets` had appended down with it, deleting the supplement before the post-inject rescue could relocate it — RSR now detaches surviving supplements off doomed cards before `remove()` runs; (2) the existing rescue moved supplements under `.rsr-section-attack` but renamed `.supplement` → `.rsr-supplement`, breaking downstream queries by wm5e and dnd5e's own re-walking enrichers — the rename is now additive, so rebuilt supplements carry **both** classes (`.supplement` for compatibility, `.rsr-supplement` for RSR styling); (3) the placement step was gated on `renderAttack`, so save-only or formula-only activities (e.g. a `SaveActivity` with damage-on-save) had supplements detached but never re-placed — placement now runs after all injects with a `.rsr-section-attack` → `.rsr-section-damage` → `.rsr-section-formula` fallback chain. Spotted by [@thatlonelybugbear](https://github.com/thatlonelybugbear) on the wm5e thread; `tests/integration-hooks.test.mjs` gains three source-level assertions that lock the contract in.

## [4.7.0] — 2026-06-02

### Fixed
- **`SaveActivity` with no damage parts no longer crashes the chat handler.** Activities such as Faerie Fire or Bane previously threw `TypeError: Cannot read properties of undefined (reading 'class')` from `DamageRoll._evaluateASTAsync` when RSR called `activity.rollDamage()` on them — `getDamageConfig` returns `{ rolls: [] }` in that case, and the empty rolls array tripped the dnd5e roll builder. `ActivityUtility.getDamageFromMessage` now short-circuits to `null` when the resolved damage config produces zero rolls (checked after RSR builds the same `config` object it passes to `rollDamage`, so ammo-driven attacks whose damage comes entirely from the ammunition aren't false-negatived by `AttackActivity#getDamageConfig`'s ammo-merge contract). Surfaced and fixed by [@thatlonelybugbear](https://github.com/thatlonelybugbear) in [#14](https://github.com/arrowedisgaming/RSReforged/pull/14) while integrating AC5E.

### Changed
- **RSReforged now listens on the non-`V2` dnd5e pre-roll hooks** (`dnd5e.preRollAbilityCheck`, `preRollSavingThrow`, `preRollSkill`, `preRollTool`, `preRollAttack`, `preRollDamage`). In dnd5e 5.3.x both `preRoll<Name>` and `preRoll<Name>V2` are emitted from `basic-roll.mjs:101-104` with the same `(config, dialog, message)` signature, so this is behaviourally a no-op — but it puts RSR in the same hook lane as other modules (notably automated-conditions-5e) that listen on the non-`V2` names, which makes cross-module ordering predictable. The `QUICK_ABILITY_ENABLED` defer guard for skill / tool checks in `registerRollHooks` is unchanged since the `hookNames` fan-out applies to both name variants. Contributed by [@thatlonelybugbear](https://github.com/thatlonelybugbear) in [#14](https://github.com/arrowedisgaming/RSReforged/pull/14).

## [4.6.0] — 2026-05-28

### Fixed
- **RSR's damage-apply click handlers no longer hijack foreign buttons.** Two listeners — `_setupCardListeners` in `src/utils/chat.js` and the `click.rsrFix` propagation-stopper in `BonusManager.init` (`src/utils/bonus.js`) — previously bound to the broad `.rsr-damage-buttons button` / `.rsr-damage-buttons-xl button` selectors. The `chat.js` handlers called `preventDefault()` and `stopPropagation()` unconditionally before checking `data-action`, and `BonusManager`'s handler called `stopPropagation()` on every match. Together they silently swallowed clicks on any third-party button injected into the same containers (e.g. via the new `rsreforged.renderApplyDamageButtons` hook). Both selectors are now narrowed to `[data-action="rsr-apply-damage"], [data-action="rsr-apply-temp"]` — exactly the two actions the RSR templates emit — so foreign buttons can coexist without being intercepted.
- **`rsreforged.renderRoll` now passes the outer message-content node as its `html` argument**, matching the contract the docs already advertised. Previously the inject functions forwarded their own insertion-target argument (which on activity cards is `.card-buttons` / `.card-activities` / `.dnd5e2.chat-card`, and on standalone damage rolls is the detached `.dice-roll` enricher), so consumers querying `html` for sibling card content would have missed most of the card. The three inject helpers (`_injectAttackRoll`, `_injectDamageRoll`, `_injectFormulaRoll`) now accept an optional `contentHtml` parameter that defaults to their insertion-target arg; `_injectContent` threads its own `html` through that option so the hook sees the full content node. A source-level test (`tests/integration-hooks.test.mjs`) locks this in so the contract can't regress silently.

### Added
- **Integration API for third-party modules** ([`docs/INTEGRATION.md`](docs/INTEGRATION.md)). Addresses [#3 (AC5E)](https://github.com/arrowedisgaming/RSReforged/issues/3) and [#13 (wm5e)](https://github.com/arrowedisgaming/RSReforged/issues/13), and the structural concern raised in [thatlonelybugbear/wm5e #25](https://github.com/thatlonelybugbear/wm5e/issues/25) that earlier versions of Ready Set Roll re-rendered chat messages "without any surface that would allow for other modules to work together." RSReforged now emits four public hooks at deterministic points in its chat-render lifecycle, all via `Hooks.callAll` (synchronous, swallow listener errors): `rsreforged.preRenderChatMessageContent` (before any DOM removal — last chance to snapshot the dnd5e card), `rsreforged.renderChatMessageContent` (after `_setupCardListeners` — primary decoration point), `rsreforged.renderRoll` (after each attack / damage / formula section is inserted; emitted on every successful return of the inject functions including the native-mode early-return in `_injectDamageRoll`, and the just-inserted section node is passed as `sectionHtml` so listeners don't have to grep the card), and `rsreforged.renderApplyDamageButtons` (after the apply-damage UI is wired). Three rules apply to consumers and are spelled out in the docs: hooks are synchronous (`Hooks.callAll` doesn't await), listeners must be idempotent because `message.update()` re-renders re-fire the chain on new HTML, and `preRender` may fire without a matching `render` when RSR merges a child roll message into a parent and deletes the child. Two worked examples ship with the docs — re-attaching wm5e's `.wm5e-mastery-reference` anchors after RSR strips the dnd5e card, and re-applying AC5E's `data-tooltip` annotations on save/check buttons after every re-render. The hook names, argument positions, and types are now public API and follow SemVer: breaking changes require a major-version bump and a deprecation cycle of at least one minor release before removal.

## [4.5.0] — 2026-05-27

### Added
- **Hold V to roll a Versatile weapon two-handed.** Fixes [#12](https://github.com/arrowedisgaming/RSReforged/issues/12). A new RSReforged keybind, *Use Versatile Two-Handed* (default `KeyV`, rebindable in *Configure Controls*), is read at click time on activity use: if the weapon is Versatile and the key is held, `attackMode: "twoHanded"` is stamped onto the message flags before rolls fire. Both `rollAttack` and `rollDamage` receive it, so dnd5e's `AttackActivity.rollDamage` swaps to the versatile damage formula automatically (dnd5e.mjs:28327-28328) — RSR doesn't touch the formula, just passes the mode through. The card's existing "(Versatile)" damage label, which had no writer until now, lights up on a two-handed roll. Plain click is unchanged (one-handed); no dialogs, no added clicks, no per-weapon configuration to forget. Non-Versatile weapons — daggers, greatswords, longbows, shortbows, etc. — are unaffected since their damage die does not change between attack modes. Shift-click continues to drop into dnd5e's full vanilla flow, which surfaces the system's native attack-mode dropdown (including modes RSR's quick-roll path doesn't expose, like off-hand and thrown variants) and writes the same `flags.dnd5e.last.<activityId>.attackMode` it always did. Activities routed through Midi-QOL bypass RSR's pipeline; Midi has its own equivalent V keybind, so behaviour there is unchanged.

## [4.4.2] — 2026-05-21

### Fixed
- **Shift-click on an activity now invokes dnd5e's full vanilla flow end-to-end (usage dialog, then attack/damage/healing/formula dialog, then roll).** Previously the usage dialog appeared but the downstream damage/attack dialog was silently skipped, because the original click event with `shiftKey: true` propagated through `_triggerSubsequentActions` into `rollDamage`, where dnd5e's `applyKeybindings` reads `shiftKey` as "skip dialog" — the opposite of RSR's "force dialog" convention. RSR now strips `usageConfig.event` on the slow-roll path so dnd5e's downstream keybinding checks see no modifier and default to showing their dialogs. The quick-roll path is unaffected; the event is preserved (so dialog positioning still works) on normal clicks.
- **Features that consume spell slots (Divine Smite and other smite-like abilities) now open dnd5e's usage dialog so the player can choose which slot to spend.** Fixes [#10](https://github.com/arrowedisgaming/RSReforged/issues/10). The 4.4.0 dialog rule narrowed preservation to leveled spells and order activities to stop cantrips from prompting on quick rolls. That was too narrow: smite-like features are non-spell items, and dnd5e seeds `usageConfig.scaling = 0` for them just as it does for cantrips, so they fell into the quick-roll path and the system silently consumed the lowest available slot. The dialog rule now additionally preserves the dialog when the activity's static `consumption.targets` includes an entry of type `spellSlots`, or when an upcast delta has already been seeded (`usageConfig.scaling > 0`). The discriminator is the `spellSlots` consumption target rather than `consumption.spellSlot` — the latter defaults to `true` for every activity in the dnd5e schema and would force the dialog on unrelated feature quick-rolls. Cantrip suppression is unchanged because cantrips have no `spellSlots` consumption target.

## [4.4.1] — 2026-05-13

### Fixed
- **The Foundry package browser and "Check for updates" flow now install the current release.** The 4.4.0 manifest declared `version: 4.4.0` but its `download` URL still pointed at the 4.3.0 release artifact, so Foundry installed the 4.3.0 zip — whose bundled `module.json` re-identified the install as 4.3.0 — and every subsequent update check reported `4.3.0 → 4.3.0` in a loop. The download URL is now version-aligned, and the release workflow now validates both `version` and `download` against the tag so this can't ship again.

## [4.4.0] — 2026-05-13

### Changed
- **The *Use Vanilla Rolls with RSReforged Styling* setting now sits at the top of the quick-roll section.** Its hint labels it as the master switch for quick-roll behavior, and each per-category hint notes that it has no effect when the master switch is enabled. Settings UI now reads top-down: pick vanilla mode first, then opt into per-category quick rolls.
- **`RollUtility.processActivity` now receives the dnd5e activity as its first argument.** The public helper signature is now `processActivity(activity, usageConfig, dialogConfig, messageConfig)` so the leveled-spell and order-activity dialog rules can live beside the rest of the quick-roll policy instead of being duplicated in the hook.

### Fixed
- **Shift-click now reliably opens the roll or activity usage dialog.** Fixes [#8](https://github.com/arrowedisgaming/RSReforged/issues/8).
  - dnd5e 5.3 initializes `dialog.configure` before RSReforged's pre-roll hooks run, so RSReforged now explicitly overwrites that boolean with its skip-dialog decision instead of using nullish assignment. This means RSReforged intentionally takes precedence over an earlier `dialog.configure` value when quick-roll settings are enabled.
  - Quick-roll category checkboxes now take effect immediately instead of only controlling which hooks are registered at Foundry startup. Disabling *Quick Roll for Skills*, for example, now returns skill clicks to the normal dnd5e dialog without requiring a reload.
  - Disabling *Quick Roll for Skills* or *Quick Roll for Tool Checks* while *Quick Roll for Abilities* remained enabled previously had no effect, because dnd5e fires `preRollAbilityCheckV2` for skill and tool checks too and RSReforged's ability handler was claiming them. The ability handler now defers to the more specific skill/tool handlers so each category controls its own roll path.
  - The *Use Vanilla Rolls with RSReforged Styling* setting now also forces dnd5e's normal dialogs globally for skill checks, ability checks, saving throws, and tool checks, matching its existing activity-roll behavior.
  - Activity usage messages preserve `quickRoll: false` from the pre-use hook so `preCreateChatMessage` no longer clobbers slow-roll decisions or auto-fires activity rolls before the dialog completes.
  - Shift-clicking an item activity now lets dnd5e's `_triggerSubsequentActions` fire the follow-up attack/damage/healing/formula rolls after the usage dialog closes. RSReforged previously suppressed `usageConfig.subsequentActions` unconditionally, so slow-roll activity clicks opened the dialog and then dropped the actual rolls. Suppression is now scoped to the quick-roll path that fires those rolls itself.
  - Cantrips and other zero-level scalable activities no longer pop the usage configuration dialog on a no-shift quick roll. The activity dialog rule no longer treats dnd5e's `usageConfig.scaling = 0` sentinel as a "show dialog" signal; only an actual leveled spell or order activity preserves the dialog.

## [4.3.0] — 2026-05-12

### Added
- **Reroll feedback: sound, Dice So Nice animation, and public chat log.** Left-clicking a die to reroll it was previously silent — only the clicker saw a `ui.notifications` toast, and the rest of the table had no audio or visual indication. `_handleReroll` now (1) routes the freshly evaluated `1d{faces}` Roll through the existing `CoreUtility.tryRollDice3D` so Dice So Nice animates the single rerolled die in 3D when installed, falling back to `CoreUtility.playRollSound` when DSN is absent, and (2) posts a `ChatMessage` reading *"{user} rerolled a d{faces}: {old} → {new}"*, sourcing whisper/blind/rollMode from `CoreUtility.getWhisperData` so the log respects the current roll mode (public/whisper/blind/self). The toast is preserved as a low-noise local confirmation. GM fudging (right-click) remains silent by design.
- **Two opt-out settings under *Interactive Dice*.** *Reroll Sound & Dice So Nice* and *Log Rerolls to Chat*, both default-on. Disabling the sound setting suppresses both DSN and the audio fallback; disabling the log setting suppresses only the chat message. The reroll itself and its `ui.notifications` confirmation still work with both off.

## [4.2.0] — 2026-05-11

### Added
- **New *Damage Apply UI* setting picks between dnd5e's per-target damage tray and RSReforged's quick apply buttons.** Replaces the single-purpose *Enable Damage Apply Buttons* boolean with an explicit two-option dropdown so the choice surfaces at the settings screen instead of being buried in a checkbox, and so future damage-apply UIs can be added as additional options rather than as parallel booleans. Defaults to *RSReforged Quick Buttons*, matching the prior default behavior — existing worlds that left *Enable Damage Apply Buttons* on (the prior default) see no UI change on upgrade. The legacy `enableDamageButtons` setting is preserved in world storage (registered with `config: false`) so worlds with the value persisted do not lose data, but no code path consumes it anymore — `damageApplyMode` is the single source of truth.
- **Two paired settings narrowed to *RSReforged Quick Buttons* mode.** *Always Show Apply Buttons* (renamed *Always Show RSReforged Apply Buttons*) and *Apply Damage Options* (renamed *RSReforged Apply Button Targets*) only take effect when *Damage Apply UI* is set to *RSReforged Quick Buttons*; their localized hints now state this explicitly so the dependency is visible without trial-and-error.

### Changed
- **Vanilla-roll setting renamed and clarified.** *Enable Content on Vanilla Rolls* → *Use Vanilla Rolls with RSReforged Styling*. The original name described the implementation ("apply module content to vanilla rolls"); the new name describes the user-facing trade-off. Hint rewritten to spell out both branches: enabled keeps dnd5e's vanilla workflow (including automatic attack and damage rolls for item activities) and layers RSReforged styling on top, disabled hands enabled quick rolls to RSReforged which rolls attack, damage, healing, and formulas on the quick-roll card. French and Portuguese translations updated for parity.
- **README and Foundry listing HTML updated** to describe *Damage Apply UI* and *RSReforged Apply Button Targets* in place of the now-removed *Apply Damage Options* bullet, so the settings overview matches the actual panel.

### Note for upgraders
- If you previously *disabled* *Enable Damage Apply Buttons*, the new *Damage Apply UI* setting defaults to *RSReforged Quick Buttons* on first load of this version, which restores those buttons. Set *Damage Apply UI* to *dnd5e Native Per-Target Tray* under *Configure Settings → Module Settings → RSReforged* to opt back out.

## [4.1.5] — 2026-05-10

### Fixed
- **Native damage UI now renders correctly when *Enable Apply Damage Buttons* is disabled.** With the setting off, activity rolls that produced damage rendered both the original Foundry `.dice-roll` DOM and a freshly injected native dnd5e damage card, leaving two damage UIs stacked in the same chat message; in some cases an empty `.dnd5e2.chat-card` wrapper was also left behind after the inner dice-roll was stripped. `_injectDamageRoll` now accepts a `mode` parameter (`"rsr" | "native"`) so the activity render path can request the native dnd5e damage card when RSR's custom UI is opted out, and the activity-card cleanup in `_injectContent` now strips the pre-existing dice-roll *and* its non-usage chat-card wrapper before injecting either render — so the message ends up with exactly one damage UI in either mode.

## [4.1.4] — 2026-05-06

### Fixed
- **Foundry in-app updates now download the correct version.** `4.1.3` shipped with a manifest whose `version` was `4.1.3` but whose `download` URL still pointed at the `4.1.2` zip, causing updates to loop `4.1.2 → 4.1.2` or otherwise fail to reach `4.1.3`. `4.1.4` corrects the release zip URL in `module.json` so Foundry can fetch the right distribution.

## [4.1.3] — 2026-05-03

### Added
- **Foundry package-listing HTML artifact and generator.** `scripts/generate-foundry-listing.sh` converts `README.md` to `docs/foundry-listing.html` via `npx --yes marked --gfm` (no local install), then applies three cleanup filters on top of the raw output: strips the duplicated `<h1>RSReforged</h1>` (Foundry shows the package name above the description already), strips the shields.io badges paragraph (Foundry surfaces version/compatibility/license through its own UI), and rewrites the `#setting-up-pre-defined-bonuses` in-page anchor to an absolute github.com URL (marked does not emit `id=` attributes on headings, so the bare anchor would be dead on Foundry's page). The artifact is committed so the paste-ready HTML for `foundryvtt.com/packages/rsreforged` stays in version control — Foundry's description field has no public API, so the listing has to be hand-edited via the admin form. Regenerate (`./scripts/generate-foundry-listing.sh`) and commit `docs/foundry-listing.html` in the same commit as any README change so the two can't drift.
- **Screenshots at the top of the README** and declared in `module.json` via the Manifest+ `media` array. Images live in `assets/screenshots/` and are referenced with absolute `raw.githubusercontent.com` URLs so they render in GitHub, Foundry's in-app README pane, and The Forge's Bazaar listing. Foundry's own package listing at foundryvtt.com does not consume `media` and has no public API for media uploads, so the cover/screenshot gallery there still requires a manual edit via the package admin form on foundryvtt.com.

### Changed
- **README restructured for non-technical readability.** A "What it does" intro with three-bullet highlights now sits directly under the screenshots, replacing the lineage / why-fork preamble that previously led the document; that history compresses into a two-paragraph "Credits" section at the bottom, retaining attribution to MangoFVTT, RedReign, and maxobremer. Section order is now "What it does" → Compatibility → Install → Features → Configuration → Setting up pre-defined bonuses → Known issues → Contributing → Credits → License, so readers verify their Foundry / dnd5e versions *before* they paste the manifest URL. Feature headings rephrased in user-facing language (for instance, "Retroactive Bonus Manager" becomes "Add a bonus after the roll", "Multirolls (always-on)" becomes "Always roll two dice", "Per-target damage application" becomes "Apply damage per target"). The Active Effect configuration table that previously lived inside the Bonus Manager feature blurb is pulled out into a dedicated optional "Setting up pre-defined bonuses" section so non-technical readers aren't interrupted mid-features by a config reference. Known issues updated for current state: the stale "Dice So Nice integration not re-verified for v4.0.0" bullet is removed (v4.1.0 restored DSN animation for sheet rolls and retro-crits), and the typed-damage-splitting bullet drops its version-specific framing.
- **CI: bumped workflow actions to Node.js 24-compatible majors.** `actions/checkout@v4` → `@v6` and `softprops/action-gh-release@v2` → `@v3`. Both majors ship `using: node24` in their `action.yml` and addressed GitHub's 2026-04 deprecation notice that Node.js 20 stops being the default Actions runtime on 2026-06-02 and is removed from runners on 2026-09-16. No parameter changes were required — the upgrade is a pure runtime bump for both actions; our no-config `actions/checkout` and core-option-only `softprops/action-gh-release` usage patterns are unaffected.

### Fixed
- **Bastion facility Orders no longer crash with *Quick Activity Rolls* enabled.** The `dnd5e.preUseActivity` hook was suppressing the usage-configuration dialog for every non-leveled-spell activity, but `OrderUsageDialog` is the only path that populates `usageConfig.costs / craft / trade`. With the dialog skipped, dnd5e's `OrderActivity._prepareUsageScaling` wrote `undefined` into the message flags and `_usageChatContext` then crashed reading `costs.days`, breaking the *Bastion Turn* button and `game.dnd5e.bastion.advanceAllFacilities()`. The hook now preserves the dialog for `activity.type === "order"` alongside the existing leveled-spell carve-out, so order resolution can read its costs/craft/trade payload as intended. Fixes [#2](https://github.com/arrowedisgaming/RSReforged/issues/2); thanks to @Gregory-Jagermeister for the report and verified fix.

## [4.1.2] — 2026-04-20

### Added
- **Automatic publishing to the Foundry VTT package browser.** After `release-X.Y.Z` creates the GitHub Release, the workflow POSTs the new version to Foundry's [Package Release API](https://foundryvtt.com/article/package-release-api/) so it appears in Foundry's in-app *Install Module* browser without a manual click-through on foundryvtt.com. The payload's `release.manifest` URL is pinned to the version-specific `module.json` attached to each release (not the moving `master/` URL) so Foundry records a stable pointer per version; the `compatibility` block is pulled live from `module.json` via `jq` so the API value can't drift from the manifest's declared support window. Gated on a `FOUNDRY_RELEASE_TOKEN` repo secret so forks without it fall back to a GitHub-release-only flow with a skip notice. `4.1.2` is the first version to appear in the Foundry browser; earlier releases — including `4.1.1`, which was tagged before this capability was added — remain installable via manifest URL.

## [4.1.1] — 2026-04-18

### Changed
- Healing roll section headers now render a `fa-heart` FontAwesome icon and the localized "Healing" label, matching the `fa-burst` + "Damage" pattern used for damage sections. The previous `<dnd5e-icon>` reference to `systems/dnd5e/icons/svg/damage/healing.svg` wasn't rendering in the section template, and the `DND5E.Healing` i18n key was moved into the `DND5E.HEAL` block in dnd5e 5.3 (its old root-level entry now resolves to "Hit Points" under `DND5E.HEAL.Type.Healing`), so headers displayed the raw key uppercased by `.rsr-title`'s `text-transform`. Headers now call `DND5E.HEAL.HealingButton`, which resolves to "Healing".

### Fixed
- Spells now apply scaling correctly when *Enable Content on Vanilla Rolls* is disabled. Two related regressions from the v4.0.0 port — one per scaling mode:
  - **Upcasting leveled spells.** `dnd5e.preUseActivity` was suppressing `dialogConfig.configure` for every activity, so leveled spells never got the usage dialog that writes `message.system.scaling`. The hook now preserves the dialog for leveled spells only (cantrips have no slot choice and are handled below), letting players pick a higher slot and letting dnd5e populate the upcast delta on the message.
  - **Cantrip damage scaling.** `ActivityUtility.getDamageFromMessage` was passing `scaling: 0` in the rollDamage config for cantrips. In `dnd5e.mjs:12545` that value is nullish-coalesced with `rollData.scaling` (`rollConfig.scaling ?? rollData.scaling`), so `0` won over the auto-computed `Scaling` instance that `SpellData#scalingIncrease` derives from `actor.cantripLevel` — cantrips always rolled at base dice regardless of character level. The config now omits `scaling` unless there's an actual upcast delta (`scaling > 0`), letting rollData drive cantrip scaling. Same fix applied to `getFormulaFromMessage` for utility-activity consistency.
  - Fixes [#1](https://github.com/arrowedisgaming/RSReforged/issues/1).

## [4.1.0] — 2026-04-18

### Added
- `module.json` now declares Dice So Nice as a recommended module, so Foundry's module browser surfaces the integration to users installing RSReforged.

### Changed
- Sheet-roll chat messages now serialise their d20 term as `BasicDie` rather than the legacy `Die` class. Aligns RSR-processed messages with Foundry V14's canonical dice class — the one `/r d20` already uses — so the stored representation is consistent across entry points. `BasicDie extends Die`, so all dnd5e-specific behaviour (advantage mode, elven accuracy, halfling lucky, crit/fumble thresholds) is preserved; the swap only affects the class name in the serialised form.

### Fixed
- Dice So Nice 3D dice now animate for attack, damage, and utility formula rolls rolled from character sheets. The activity pipeline passes `create: false` to `activity.rollAttack/rollDamage/rollFormula`, which suppresses the `ChatMessage.create` that DSN hooks; `ActivityUtility.runActivityActions` / `runActivityAction` now trigger `game.dice3d.showForRoll()` explicitly and fall back to the dice sound when DSN is absent.
- Retro-crit DSN animation now passes the message id to `showForRoll` so the wait-for-animation synchronisation in `ChatUtility.processChatMessage` can coordinate with it.

## [4.0.0] — 2026-04-17

The first RSReforged release. Forked from [MangoFVTT/fvtt-ready-set-roll-5e@v3.5.0](https://github.com/MangoFVTT/fvtt-ready-set-roll-5e/releases/tag/release-3.5.0). Restores Foundry v14 + dnd5e 5.3 compatibility (which upstream lost) and adds two new features inherited from [community PR #619](https://github.com/MangoFVTT/fvtt-ready-set-roll-5e/pull/619) by maxobremer.

### Added
- **Retroactive Bonus Manager.** A `+` icon in roll headers opens a dialog to apply bonuses (custom formulas or Active-Effect–registered bonuses like Bless or Bardic Inspiration) to a roll after it's been made. Active Effects target the `flags.rsreforged.bonus` change key with a `<formula>; type:<roll-type>; consume:<origin|item>; once` value string.
- **Interactive Dice.** Left-click any die in a chat tooltip (your own roll, or any roll if you're the GM) to reroll that die in place. GMs can additionally right-click to manually set a die's value, gated behind the *Allow GM Dice Fudging* setting.
- Three new module settings: *Enable Interactive Dice (Master Switch)*, *Allow Players to Reroll Their Own Dice*, *Allow GM Dice Fudging*.
- Tag-triggered GitHub Actions release workflow that builds the distribution zip and updates the manifest+download URLs in the release artifact.
- `docs/upstream-v3.5.0-snapshot/` — read-only reference of the upstream RSR source the fork is based on, for future diffing.

### Changed
- **Forked from MangoFVTT/fvtt-ready-set-roll-5e@v3.5.0** and re-identified as RSReforged (id: `rsreforged`, was `ready-set-roll-5e`).
- **Foundry minimum is now 14** (verified 14.539, max 14). v13 is no longer supported.
- **dnd5e relationship bumped to 5.3.0+**. Versions 5.0–5.2 are no longer supported.
- Module title: *Ready Set Roll for D&D5e* → *RSReforged*. ESM entry filename `src/ready-set-roll.js` → `src/rsreforged.js`. Stylesheet `css/ready-set-roll.css` → `css/rsreforged.css`. i18n root key `rsr5e.*` → `rsreforged.*`. CSS class prefixes (`.rsr-*`) and template filenames (`templates/rsr-*.html`) intentionally retained as a readable lineage marker.
- **Activity-use hook overhauled**: replaced the legacy `setTimeout(15000, () => Hooks.on("dnd5e.postUseActivity", ...))` race-condition workaround with `usageConfig.subsequentActions = false` set in `dnd5e.preUseActivity` — works correctly under dnd5e 5.3, where the old hook only gates `_triggerSubsequentActions` and not message creation.
- **Chat-render hook split**: non-usage messages still paint on `renderChatMessageHTML`, but usage (activity) messages now paint on `dnd5e.renderChatMessage` because dnd5e 5.3's `ChatMessage5e.renderHTML()` calls `system.getHTML()` *after* `renderChatMessageHTML` and would otherwise wipe the injection.
- **RSR flags now stamped during `preCreateChatMessage`** so they're present from the moment the message is saved, not raced into existence afterward.
- Manifest, download, bugs, and readme URLs in `module.json` repointed to `github.com/arrowedisgaming/RSReforged`.
- Authors block in `module.json` now lists arrowedisgaming alongside MangoFVTT (original RSR) and RedReign (Better Rolls 5e ancestor).

### Removed
- **Foundry v13 compatibility.** Removed the `setTimeout` race workaround, deprecated dialog API shims, legacy ChatMessage type validation, and the `dnd5e.postUseActivity` blocker hook — all only existed to support pre-5.3 dnd5e.
- **dnd5e 5.0–5.2 compatibility.** New code paths assume `getAssociatedActivity()` / `getAssociatedActor()` exist on `ChatMessage`, that `updates.item` (not `updates.items`) carries ammo info on `dnd5e.activityConsumption`, and that `usageConfig.subsequentActions` is honored.

### Fixed
- **Foundry v14 / dnd5e 5.3 incompatibility** — RSR cards no longer get blank-slated by `system.getHTML()`. (Resolves the issue tracked in upstream [#617](https://github.com/MangoFVTT/fvtt-ready-set-roll-5e/issues/617) and [#618](https://github.com/MangoFVTT/fvtt-ready-set-roll-5e/issues/618).)
- **Sneaky Reroll race** where attack and damage rolls re-evaluated immediately on creation; missing `await`s have been added so the async order is correct.
- **Unlinked-token actor resolution** silently failed in v3.5.0; now resolves correctly via `ChatUtility.getActorFromMessage`.
- **Dialog API deprecation** — internal prompts upgraded from `Dialog` to `foundry.applications.api.DialogV2`.

### Deferred (not shipping in 4.0.0)
- **Typed Damage Splitting.** PR #619 imports `splitTypedBonusDamage` from `./typed-bonus-split.js` in `src/utils/hooks.js`, but the implementation file was never committed to the PR (verified via `gh pr view 619 --files` — the PR's 9 files do not include any `typed-bonus-split*`). The import and call site were dropped here so the module loads cleanly. dnd5e 5.3 already provides per-type damage rendering natively, so the user-visible regression vs the PR's intent is small. To be revisited in a future release.

### Credits
- **maxobremer** — authored [PR #619](https://github.com/MangoFVTT/fvtt-ready-set-roll-5e/pull/619), the source of the v14/5.3 compatibility work and the Bonus/Interactive Dice features in this release.
- **MangoFVTT** — author and maintainer of upstream Ready Set Roll for D&D5e (the direct ancestor of this fork).
- **RedReign** — author of the original [Better Rolls for 5e](https://github.com/RedReign/FoundryVTT-BetterRolls5e), which RSR is a rewrite of.

[Unreleased]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.13.0...HEAD
[4.13.0]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.12.0...release-4.13.0
[4.12.0]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.11.5...release-4.12.0
[4.11.5]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.11.4...release-4.11.5
[4.11.4]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.11.3...release-4.11.4
[4.11.3]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.11.2...release-4.11.3
[4.6.0]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.5.0...release-4.6.0
[4.5.0]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.4.2...release-4.5.0
[4.4.2]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.4.1...release-4.4.2
[4.4.1]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.4.0...release-4.4.1
[4.4.0]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.3.0...release-4.4.0
[4.3.0]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.2.0...release-4.3.0
[4.2.0]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.1.4...release-4.2.0
[4.1.4]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.1.3...release-4.1.4
[4.1.3]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.1.2...release-4.1.3
[4.1.2]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.1.1...release-4.1.2
[4.1.1]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.1.0...release-4.1.1
[4.1.0]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.0.0...release-4.1.0
[4.0.0]: https://github.com/arrowedisgaming/RSReforged/releases/tag/release-4.0.0
