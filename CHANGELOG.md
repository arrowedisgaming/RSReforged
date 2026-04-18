# Changelog

All notable changes to RSReforged are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.1.0...HEAD
[4.1.0]: https://github.com/arrowedisgaming/RSReforged/compare/release-4.0.0...release-4.1.0
[4.0.0]: https://github.com/arrowedisgaming/RSReforged/releases/tag/release-4.0.0
