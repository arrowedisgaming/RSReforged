# Changelog

All notable changes to RSReforged are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.1.2...HEAD
[4.1.2]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.1.1...release-4.1.2
[4.1.1]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.1.0...release-4.1.1
[4.1.0]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.0.0...release-4.1.0
[4.0.0]: https://github.com/arrowedisgaming/RSReforged/releases/tag/release-4.0.0
