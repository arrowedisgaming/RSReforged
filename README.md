# RSReforged

> A maintained fork of **Ready Set Roll for D&D 5e**, targeting Foundry VTT v14+.

![Latest Release](https://img.shields.io/badge/dynamic/json.svg?url=https%3A%2F%2Fraw.githubusercontent.com%2Farrowedisgaming%2FRSReforged%2Fmaster%2Fmodule.json&label=Latest%20Release&prefix=v&query=$.version&colorB=blue&style=for-the-badge)
![Foundry Versions](https://img.shields.io/endpoint?url=https%3A%2F%2Ffoundryshields.com%2Fversion%3Fstyle%3Dfor-the-badge%26url%3Dhttps%3A%2F%2Fraw.githubusercontent.com%2Farrowedisgaming%2FRSReforged%2Fmaster%2Fmodule.json&color=ff601e&label=Foundry)
![dnd5e](https://img.shields.io/badge/dnd5e-5.3%2B-red?style=for-the-badge)
![License](https://img.shields.io/badge/license-GPL--3.0-green?style=for-the-badge)

## Lineage and credit

RSReforged stands on the shoulders of two prior projects, both of which deserve full credit:

- **[Ready Set Roll for D&D5e](https://github.com/MangoFVTT/fvtt-ready-set-roll-5e)** by **[MangoFVTT](https://github.com/MangoFVTT)** — the modern rewrite that this fork inherits the vast majority of its codebase from. RSR was developed and maintained from 2023 through mid-2025, and is the direct ancestor of every line in `src/`.
- **[Better Rolls for 5e](https://github.com/RedReign/FoundryVTT-BetterRolls5e)** by **[RedReign](https://github.com/RedReign)** — the original quick-roll module for Foundry's dnd5e system, of which RSR (and therefore RSReforged) is a complete rewrite and modernisation.

The Foundry v14 + dnd5e 5.3 compatibility work in this v4.0.0 release originated almost entirely in [PR #619](https://github.com/MangoFVTT/fvtt-ready-set-roll-5e/pull/619) by **[maxobremer](https://github.com/maxobremer)**, who did the investigation and patches on a fork of upstream RSR. Huge thanks.

## Why this fork exists

Upstream RSR became incompatible with Foundry v14 and dnd5e 5.3.0 when those releases shipped in early 2026 (see upstream issues [#617](https://github.com/MangoFVTT/fvtt-ready-set-roll-5e/issues/617) and [#618](https://github.com/MangoFVTT/fvtt-ready-set-roll-5e/issues/618)). The maintainer's bandwidth was constrained, and PR #619 — which fixed the breakage — sat unreviewed. RSReforged exists so the community has a maintained module to point at while upstream catches up.

This fork's goals are narrow:

1. Stay current with Foundry and dnd5e releases.
2. Land high-quality community contributions that would otherwise stall.
3. Keep the diff with upstream small enough that fixes can flow back if Mango wants them.

## Compatibility

| | Minimum | Verified |
|---|---|---|
| Foundry VTT | **14** | 14.539 |
| dnd5e system | **5.3.0** | 5.3.0 |

**RSReforged is not compatible with Foundry v13** or **dnd5e 5.0–5.2**. If you're on those versions, stay on [upstream RSR v3.5.0](https://github.com/MangoFVTT/fvtt-ready-set-roll-5e/releases/tag/release-3.5.0) until you upgrade.

As with upstream RSR, RSReforged is **not compatible with other modules that overhaul the dnd5e roll pipeline** — most notably [Midi-QOL](https://gitlab.com/tposney/midi-qol). They will fight each other in unpredictable ways. Pick one.

## Installation

In Foundry's *Add-on Modules → Install Module* dialog, paste this into the **Manifest URL** field:

```
https://raw.githubusercontent.com/arrowedisgaming/RSReforged/master/module.json
```

Click *Install*. Foundry will download the latest release and add RSReforged to your module list.

## Features

### Quick rolls

Skill checks, ability checks, saving throws, tool checks, and item activities all output directly to chat without the standard dnd5e roll dialog. Each roll category can be toggled independently in the module settings, and the dnd5e *Skip Dialog* key modifier still bypasses RSReforged for one-off rolls when you want the full dialog.

Holding the dnd5e *Advantage* / *Disadvantage* modifier keys while clicking will roll with that mode immediately, including any extra dice required by features like Elven Accuracy. The kept die is highlighted in the chat card.

### Multirolls (always-on)

A setting can force rolls to always show two d20s (three with Elven Accuracy) even when you don't have advantage or disadvantage. You can still hold modifiers to designate one as the kept die.

### Retroactive roll editing

Quick rolls can be upgraded *after* the fact: turn a flat roll into advantage or disadvantage, promote a hit to a critical, or change which die is kept. The chat card live-edits to show the new state next to the old.

### Per-target damage application

Damage and healing fields in a quick-roll chat card each get their own apply buttons (overlay on hover, or always-on per setting). You can apply each damage type to selected or targeted tokens independently — useful for "this 1d8 is fire and that 1d4 is cold and only one of them resists".

### Retroactive Bonus Manager *(new in 4.0.0)*

A `+` icon in roll headers opens a dialog to add a bonus to an already-rolled check, save, attack, or damage roll. Bonuses can be:

- A **custom formula** entered ad hoc (e.g. `1d4`, `+2`, `1d6 + @prof`).
- A **pre-defined bonus** registered via an Active Effect on the actor.

To register a pre-defined bonus, add an Active Effect change on the actor (or an item that grants one) with:

| Field | Value |
|---|---|
| Attribute Key | `flags.rsreforged.bonus` |
| Change Mode | *Custom* |
| Effect Value | A semicolon-delimited string (see below) |

Effect Value format:

```
<formula>; type:<roll-type[,roll-type...]>; consume:<origin|item-id|item-name>; once
```

| Token | Meaning |
|---|---|
| `<formula>` | A Roll formula. May reference `@actor.system.*` etc. |
| `type:check` | Applies to ability/skill/tool/initiative checks |
| `type:save` | Applies to saves (incl. death saves and concentration) |
| `type:attack`, `type:damage`, `type:initiative` | Applies only to that roll type |
| `type:any` (default) | Applies to any roll type |
| `consume:origin` | Consume one charge of the originating item when applied |
| `consume:<id-or-name>` | Consume one charge of a different item |
| `once` | Delete the effect after a single use |

Examples:

- **Bless:** `1d4; type:check, save, attack` (no consumption — Bless is a duration spell)
- **Bardic Inspiration (d8):** `1d8; type:any; consume:origin; once`
- **Guidance:** `1d4; type:check; consume:origin; once`

### Interactive Dice *(new in 4.0.0)*

Once enabled, every die rendered in a chat tooltip becomes clickable:

- **Left-click** any die in a roll you made (or any die at all, if you're the GM) to **reroll** that single die in place. The chat card recalculates and updates.
- **Right-click** any die (GM only, when *Allow GM Dice Fudging* is enabled) to **manually set** its value via a prompt. Useful for narrative course-correction.

Three module settings gate the feature:

- **Enable Interactive Dice (Master Switch)** — kill switch for the whole feature
- **Allow Players to Reroll Their Own Dice** — players can left-click their own dice
- **Allow GM Dice Fudging** — GM gets the right-click "set value" affordance

## Configuration

All settings are under *Configure Settings → Module Settings → RSReforged*. The most useful ones to know about:

- **Quick Roll for {Skills, Abilities, Tools, Activities}** — toggle each category independently
- **Always Roll Multiple Dice** — show two d20s on every roll, not just advantage/disadvantage
- **Hide Final Result** — hide the rolled total until the GM reveals it (good for blind checks)
- **Manual Damage Mode** — require explicit click to roll damage instead of auto-rolling on hit
- **Apply Damage Options** — selected vs. targeted tokens, with priority modes
- **Confirm Retroactive {Advantage, Crits}** — gate the retroactive roll edits behind a confirm dialog

## Known issues

- **Dice So Nice integration** has not been re-verified for v4.0.0; it worked through upstream v3.5.0 and the changes in this fork should be compatible, but please file an issue if you see breakage.
- **Typed Damage Splitting** (separate visual chips for `1d8[fire] + 1d4[cold]`) was *intended* to ship in PR #619 but the implementation file was missing from that PR. It is therefore not in v4.0.0. May land in a future release.
- See the [issue tracker](https://github.com/arrowedisgaming/RSReforged/issues) for everything else.

## Contributing

Issues and PRs welcome at [github.com/arrowedisgaming/RSReforged](https://github.com/arrowedisgaming/RSReforged).

If you're submitting a fix that's also relevant upstream, please consider opening it against [MangoFVTT/fvtt-ready-set-roll-5e](https://github.com/MangoFVTT/fvtt-ready-set-roll-5e) too — keeping the codebases close benefits everyone.

A read-only snapshot of the upstream v3.5.0 source we forked from is kept in [`docs/upstream-v3.5.0-snapshot/`](docs/upstream-v3.5.0-snapshot/) for reference and diffing.

## License

RSReforged is licensed under **GPL-3.0**, inherited from upstream RSR. Any derivative works must remain GPL-3.0. See [`LICENSE`](LICENSE) for the full text.
