# Changelog

All notable changes to RSReforged are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **CI: bumped workflow actions to Node.js 24-compatible majors.** `actions/checkout@v4` → `@v6` and `softprops/action-gh-release@v2` → `@v3`. Both majors ship `using: node24` in their `action.yml` and addressed GitHub's 2026-04 deprecation notice that Node.js 20 stops being the default Actions runtime on 2026-06-02 and is removed from runners on 2026-09-16. No parameter changes were required — the upgrade is a pure runtime bump for both actions; our no-config `actions/checkout` and core-option-only `softprops/action-gh-release` usage patterns are unaffected.

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
