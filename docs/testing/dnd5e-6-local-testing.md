# Local dnd5e 6 testing branch

Branch: `codex/dnd5e-6-compatibility`

Starting commit: `c3ba388`

Installed test environment: Foundry **14.367**, dnd5e **6.0.1**

Status: local test candidate, not a published or fully certified release.

## Use your Foundry installation

Your Foundry module directory already links to this checkout:

`~/Library/Application Support/FoundryVTT/Data/modules/rsreforged` → `/Users/oneill/Documents/coding/RSReforged`

1. Leave this repository on `codex/dnd5e-6-compatibility`.
2. Open Foundry and load a test world using dnd5e 6.0.1. Enable RSReforged if needed.
3. Reload the browser after changing branches. No build or module reinstall is required.
4. Begin with only RSReforged enabled, then test your usual modules together.

All implementation changes are local. The existing `.gitignore` edit is preserved separately. The module version and manifest verification fields are unchanged; this is not a release.

To compare with the previous code, close/reload Foundry around switching back to your previous branch. Avoid switching while a workflow is running. The implementation commit can be revisited without losing the testing branch.

## What changed

- dnd5e 6 gets real native attack, damage, healing, and formula messages linked to a usage card. The 5.3 workflow remains separate.
- Follow-up quick rolls start after usage finalization. Rendering and reloading do not trigger resource consumption or replay partially completed work.
- Consumed resources, scaling, ammunition, attack ability/mode, target snapshots, and message privacy travel with the workflow.
- Combined cards retain native child identity. Save/check summaries and editable dice resolve to their own source messages.
- Advantage, bonuses, damage-type changes, rerolls, and critical promotion update native rolls. Damage uses either the native tray or RSR buttons according to settings.
- Critical promotion retains the original dice and rolls only additions. Its original snapshot survives serialization for safe downgrade. Later edits invalidate downgrade rather than silently discarding those edits.

## Verified locally

The live checks used a **disposable data directory**, copied dnd5e installation, and synthetic actors/items. Your campaign data was not changed.

| Check | Observed result |
|---|---|
| Quick weapon use | One usage, one native attack, one native damage child; workflow completed |
| Target identity | Actor and token UUIDs retained separately on attack and damage |
| Retroactive advantage | Original d20 retained; native `D20Die` class retained; attack updated from 11 to 18 |
| Bonus | Native attack increased from 18 to 20; no authoritative flag-roll cache |
| Native damage component | Correct child ID; one connected component; Apply changed HP 100 → 93 for 7 damage |
| Component reconnection | Initial separate experiment applied 10 damage once, then half damage once after moving the component again |
| RSR damage | Half of 11 damage changed HP 100 → 95 using native actor calculation |
| Critical persistence | Original d8 result 4 retained; total 7 → 11; serialized downgrade returned 7 |
| Always Roll Multiple Dice | Primary 17 + 3 stayed 20; saved extra d20 15 was reused for retroactive advantage |
| Save summary | Summary stamped with saving-throw child ID and its own advantage/bonus controls |
| Damage UI setting | RSR controls present and native component absent in RSR mode; native component exercised separately |
| Privacy | GM/blind/self children matched parent whisper/blind fields; separate player session showed no private GM parent cards or child results |
| Reload | Message count stayed 20; completed workflow and edited totals remained unchanged |
| Narrow chat | Card visually inspected at 292px width; no nested roll buttons |

Automated regression coverage includes compatibility classification, safe flags, workflow cancellation/partial failures, target snapshots including null AC, native privacy forwarding, source routing, damage aggregation/save multipliers, and critical structures. The full existing 5.3-oriented test suite remains included. Final automated run: **348 tests passed across 25 files**. Syntax checks passed. Diff whitespace was checked with `core.whitespace=cr-at-eol` to retain the existing CRLF style in two files without unrelated formatting changes.

Raw synthetic observations are in `tests/fixtures/dnd5e-6/`. The newer `rsr-native-6.0.1.json` includes timestamp, browser, active modules, settings, source document, serialized rolls, and native critical sample outcomes. The older native-only fixture is retained unchanged.

## Priorities for your testing

1. Normal attack; Shift/dialog path; advantage/disadvantage shortcuts; manual damage modes; damage-only/healing/formula activities.
2. Both damage UI modes, multiple damage types, changing a type, adding a bonus, and rerolling a die in the second damage part.
3. Save activity with multiple targets; successful half/no-damage saves; same actor represented by two tokens; target changes while rolling.
4. Final ammunition consumption, versatile weapons, upcasting, scaled healing, and features using `@consumed.hd`.
5. Public/GM/blind/self rolls as GM and player, NPC hiding styles, old chat history, deleting a parent/child, chat pagination and popouts.
6. Your normal cover, mastery, and Dice So Nice combinations. Midi-QOL remains outside the supported workflow combination.

## Remaining release gates and known limits

- The full live version matrix (5.3.0/5.3.3/6.0.0/6.0.1), complex resources, third-party integrations, and every activity type have **not** been certified. Automated tests are not a replacement for those checks.
- The native renderer keeps individual damage parts available for editing beneath optional aggregate totals. “Always Roll Multiple Dice” stores supplementary d20 outcomes separately so the native normal-roll total remains authoritative; retroactive advantage consumes those saved outcomes.
- Naturally critical native rolls have no saved noncritical result, so they do not offer downgrade. Unsupported critical expressions fail without changing the original roll. `(1d6 + 2) * 2` also triggered an immutable-roll error in the native system with RSReforged disabled; the fixture records that upstream behavior.
- A workflow left `running`, `partial`, `cancelled`, or `failed` is never automatically replayed. Inspect its existing children and use the card's manual/native actions as appropriate.
- Native post-use hooks are not awaited by the system. A later module's post-use veto cannot undo quick-roll work already dispatched; integration coordination still requires live verification.

Report the activity/item, roll mode, module combination, expected result, observed result, and console error when something differs. Do not attach campaign exports to the synthetic fixture directory.
