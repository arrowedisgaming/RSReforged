# dnd5e 6 fixture captures

These files are raw observations from disposable Foundry worlds populated only with synthetic actors, items, and targets. They are checked into the repository so tests never fetch mutable upstream data during CI.

## Capture procedure

1. Create the scenario in a disposable world and note the actor, item, target, and expected game semantics before rolling.
2. Set the scenario name and chat-message ID at the top of `scripts/capture-dnd5e-fixtures.mjs`.
3. Paste the complete script into a Foundry **Script macro** and run it. It is browser macro source, not a Node.js program.
4. Move the downloaded `<scenario>.json` into this directory without editing it.
5. Add the scenario setup and semantics below. If a stable ID is needed by a test, create and document a separate derived fixture instead of changing the raw capture.

The macro uses Foundry's documented `foundry.utils.saveDataToFile` helper. Each capture contains the message's raw `toObject()` data, serialized rolls, raw rendered `outerHTML`, Foundry/system/upstream provenance, browser and active-module versions, relevant chat/damage/critical settings, and independently evaluated native `CONFIG.Dice.DamageRoll` base/critical examples. Their recorded dice outcomes are frozen evidence for mapping tests; random totals are observations from that run and are never universal expected values.

Detached `outerHTML` preserves the template output for DOM tests, but it does not prove that custom elements completed their connected lifecycle. Component lifecycle behavior requires the connected live-DOM experiment in Task 3A.

## Recorded scenarios

### `native-6.0.1.json`

- Environment: Foundry 14.367, dnd5e 6.0.1, upstream commit `14037023a87372688bbb59be99f55fcd3a83318d`.
- Setup: synthetic actor **RSR Test Attacker** used synthetic weapon **RSR Test Sword** and its **Strike** attack activity against synthetic target **RSR Test Target** (recorded AC 10).
- Captured messages: the native `usage` parent and linked native `damage` child, including raw template HTML. The damage child records `system.origin` pointing to the parent, one native target descriptor, and a `1d8 + 3` slashing DamageRoll.
- Expected semantics: the child remains a real damage message associated with the usage parent; its native damage application resolves against the child message context.
- Damage-roll samples: `1d8 + 3`, `2d6kh1 + 3`, `(1d6 + 2) * 2`, and `1d8 - 1d4`. The parenthetical sample records the observed immutable-roll error from that capture rather than replacing it with invented output.
- Live component spike: the fixture records the target HP result and child ID observed by the capture harness. Treat these as scenario evidence, not general damage arithmetic expectations.
- Capture limitation: this first fixture's compact provenance does not include capture time, browser, active modules, `chatCardSummary`, damage UI mode, or critical settings. Refresh it with the macro before using those fields as test evidence.

## Refresh policy

Capture a new raw file whenever a supported dnd5e patch changes relevant chat templates, message schemas, dice code, or custom-element lifecycle. Keep each supported patch's capture alongside earlier samples with its own verified upstream commit. Compare old and new raw fixtures first, then review every expectation before updating a derived fixture or test. Never silently normalize raw totals or overwrite an earlier patch sample.

### `rsr-native-6.0.1.json`

A subsequent capture with the local RSReforged implementation enabled. Includes complete capture provenance/settings and the synthetic damage child after critical promotion (base total 7; promoted total 11). The fixture also records native sample formula outcomes, including the parenthetical-expression error. It supplements the original native-only fixture without replacing it. Connected component, player privacy, and reload checks are described in `docs/testing/dnd5e-6-local-testing.md`.
