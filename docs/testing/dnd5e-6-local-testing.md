# Local dnd5e 6 testing branch

> **Superseded.** This describes the September 2026 "base case" (dnd5e's own markup folded into the usage card, no RSReforged controls), and its screenshot shows an earlier text-button prototype. RSReforged 6.0.0 instead renders the RSReforged card from dnd5e 6's native messages and restores the card controls; see the 6.0.0 entry in `CHANGELOG.md`. Kept for the implementation history and the fixture notes.

Branch: `codex/dnd5e-6-compatibility`

Starting commit: `c3ba388`

Installed test environment: Foundry **14.367**, dnd5e **6.0.1**, Dice So Nice **6.2.9**

Status: release candidate for **RSReforged 6.0.0**, which requires dnd5e 6.0 or newer. RSReforged 4.13.4 remains the release for dnd5e 5.3.x.

## Use your Foundry installation

Your Foundry module directory already links to this checkout:

`~/Library/Application Support/FoundryVTT/Data/modules/rsreforged` → `/Users/oneill/Documents/coding/RSReforged`

1. Leave this repository on `codex/dnd5e-6-compatibility`.
2. Open Foundry and load a test world using dnd5e 6.0.1. Enable RSReforged if needed.
3. Reload the browser after changing branches. No build or module reinstall is required.
4. Begin with only RSReforged enabled, then test your usual modules together.

All implementation changes are local. The existing `.gitignore` edit is preserved separately. The module version and manifest verification fields are unchanged; this is not a release.

To compare with the previous code, close/reload Foundry around switching back to your previous branch. Avoid switching while a workflow is running. The implementation commit can be revisited without losing the testing branch.

## Scope: the base case

The first implementation (`e4d7df1`) shipped the full feature set from the plan. After live
feedback on 2026-09-17 it was cut back to a base case so the core behaviour can be verified
on its own. RSReforged's own controls return later, one at a time, following the deferred
list kept alongside the plan documents.

What the base case does on dnd5e 6:

- A quick activity use suppresses dnd5e's follow-up rolls, then, after usage finalization,
  rolls the attack and damage through dnd5e's own `rollAttack` and `rollDamage` on the
  consumed/scaled activity clone dnd5e itself would use.
- Both rolls are prepared with `create: false` and the resulting native messages are created
  in **one batch**. Dice So Nice merges throws queued in the same tick, so attack and damage
  animate as a single throw and both cards stay hidden until the dice land.
- The native attack, damage, healing, and formula children are folded into the usage card by
  moving their live rendered nodes, tagged with their real message IDs. The standalone child
  cards are hidden while the fold-in represents them. The combined block reveals when Dice So
  Nice reports the throw complete.
- Everything inside the card is dnd5e's own markup: its roll button and breakdown popover,
  target rows, damage tray, and usage buttons. RSReforged only hides each child's duplicated
  speaker line and item title.
- If the final unit of auto-destroying ammunition is consumed, the deleted item snapshot dnd5e
  would have stored on the attack message is captured from the `dnd5e.rollAttack` hook and
  written into the attack data, so the damage roll and later lookups still resolve it.
- Manual damage mode defers damage; dnd5e's own Damage button on the card rolls it and the
  result folds in through its origin.
- The clickable-dice reroll listener is switched off on dnd5e 6. dnd5e 6 kept core's
  `.dice-tooltip .dice-rolls .roll` classes inside its breakdown, so the listener still
  matched there and would have logged rerolls that never changed the card.
- The 5.3 code path is still in the source but is no longer supported or tested by this
  release. Foundry only warns on an unmet system requirement, so a 5.3 world that accepts the
  update falls back to that path.

What the base case does **not** do on dnd5e 6 (deferred on purpose): apply-damage buttons,
damage type icons or cycling, retroactive advantage/disadvantage, critical promotion, add
bonus, rerolls and fudge on folded dice, hidden NPC rolls, aggregate totals, extra d20
seeding, and save/check summary decoration.

## Verified locally

Automated: **343 tests across 24 files** pass (`npm test`). Coverage includes compatibility
classification, safe flag initialization, batched native creation with origin and privacy
forwarding, the ammunition snapshot, manual damage mode, cancellation and partial states,
target snapshots including null AC, the fold-in leaving native markup untouched, hidden
originals, the Dice So Nice reveal wait, and the roll-only parent refresh. The full existing
5.3-oriented suite remains included.

Live checks from the full implementation (`e4d7df1`, disposable data directory, synthetic
actors) that still apply to the base case because the mechanism is unchanged:

| Check | Observed result |
|---|---|
| Quick weapon use | One usage, one native attack, one native damage child; workflow completed |
| Target identity | Actor and token UUIDs retained separately on attack and damage |
| Native damage component | Correct child ID; one connected component; Apply changed HP 100 → 93 for 7 damage |
| Component reconnection | Applied 10 damage once, then half damage once after moving the component again |
| Privacy | GM/blind/self children matched parent whisper/blind fields; a separate player session showed no private GM parent cards or child results |
| Reload | Message count stayed 20; completed workflow remained unchanged |

Live checks of the base case itself (2026-09-18, Foundry 14.367, dnd5e 6.0.1, Dice So Nice 6.2.9):

| Check | Observed result |
|---|---|
| Quick weapon attack | One Dice So Nice throw; one combined card with attack and damage |
| Parity with vanilla | The combined card shows the same content as dnd5e with RSReforged disabled, reached in fewer clicks |

## Live checks pending for the base case

Run these on the 6.0.1 world before treating the base case as done:

1. Quick-roll a weapon attack with Dice So Nice enabled: **one** throw containing the d20 and
   the damage dice, and the combined card reveals after the dice land.
2. Quick-roll with Dice So Nice disabled: attack and damage appear together, one dice sound.
3. The combined card shows dnd5e's attack button, breakdown popover, target row, and damage
   tray; Apply on the tray changes HP once.
4. Manual damage mode: attack only, then dnd5e's Damage button rolls damage and it folds in.
5. Fire the last unit of an auto-destroying ammunition stack: the attack still shows the
   ammunition and the damage roll includes its bonus.
6. A second client sees the same single combined card and no stray standalone child cards.
7. A 5.3 world still behaves as before.
