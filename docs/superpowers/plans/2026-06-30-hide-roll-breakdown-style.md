# Hide Roll Breakdown Style (Issue #23) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a presentation option so a hidden NPC roll can show its final *total* to players while masking the natural die value and all modifiers (the inverse of today's "show die, hide total" behavior), fulfilling GitHub issue #23.

**Architecture:** Reuse the existing NPC-roll-hiding pipeline end-to-end (`shouldHideNpcRollForActor` → `roll.options.hideFinalResult` → multiroll template + `_applyHiddenRollPresentation`). Add a new world setting `hideNpcRollStyle` with two values — `total` (current: mask the total, reveal the d20) and `breakdown` (new: reveal the total, mask the d20 and modifiers). The chosen style is stamped onto `roll.options.hideRollStyle` at the single existing visibility chokepoint (`_configureRollVisibility`) and consumed by the renderer and the hidden-presentation DOM pass. No persistence, no chat-flow, and no damage-application code changes.

**Tech Stack:** Foundry VTT v14 module, vanilla ES modules, Handlebars templates, jQuery DOM, Vitest (jsdom-style harness in `tests/helpers/foundry-env.mjs`).

## Global Constraints

- Foundry compatibility: minimum/verified/maximum major version **14** (`module.json`) — do not use APIs removed in V14 (e.g. `CONST.CHAT_MESSAGE_TYPES`, `CONST.DICE_ROLL_MODES` numeric coercions).
- dnd5e system **5.3+**.
- No AI attribution anywhere in committed code, commit messages, or docs (no `Co-Authored-By`, no "Generated with", no AI-evidence footers).
- New world settings must be `scope: "world"`, `config: true`, and `requiresReload: true` to match every other rendering-affecting setting in `SettingsUtility.registerSettings`.
- All user-facing strings go through `CoreUtility.localize` and live in `lang/en.json` (and should be added to `lang/pt-BR.json` if an equivalent key set exists there; English is the source of truth).
- Back-compatibility: the default style MUST be `total` so existing worlds see zero behavior change after upgrade.
- CHANGELOG: every change set is recorded in `CHANGELOG.md` using Keep a Changelog format.
- After ANY edit to `README.md`, regenerate `docs/foundry-listing.html` by running `scripts/generate-foundry-listing.sh` and commit the regenerated HTML in the same commit.
- Test runner: `npx vitest run` (single run, no watch).

---

## File Structure

- `src/utils/settings.js` — Add the `HIDE_NPC_ROLL_STYLE` setting key, the `HIDE_NPC_ROLL_STYLES` enum, the setting registration, and a `getHideNpcRollStyle()` accessor. *(Modify)*
- `src/utils/chat.js` — Stamp `roll.options.hideRollStyle` in `_configureRollVisibility`; branch `_applyHiddenRollPresentation` on the style. *(Modify)*
- `src/utils/render.js` — In `_renderMultiRoll`, when hiding in `breakdown` style, reveal the total and suppress the d20 die icon. *(Modify)*
- `lang/en.json` — Setting name/hint + choice labels. *(Modify)*
- `tests/settings-core.test.mjs` — Registration + `getHideNpcRollStyle` default/behavior tests. *(Modify)*
- `tests/chat-behavior.test.mjs` — Rendering tests for the `breakdown` style. *(Modify)*
- `CHANGELOG.md` — Unreleased entry. *(Modify)*
- `README.md` + `docs/foundry-listing.html` — Document the new setting; regenerate listing. *(Modify)*

---

## Task 1: Add the `hideNpcRollStyle` setting, enum, and accessor

**Files:**
- Modify: `src/utils/settings.js` (SETTING_NAMES block ~line 9-37; enums ~line 44-48; registration ~line 175-189; accessors near `shouldHideNpcRollForActor` ~line 288)
- Modify: `lang/en.json` (settings block; choices block ~line 74-78)
- Test: `tests/settings-core.test.mjs`

**Interfaces:**
- Produces:
  - `SETTING_NAMES.HIDE_NPC_ROLL_STYLE` === `"hideNpcRollStyle"`
  - `HIDE_NPC_ROLL_STYLES` === `{ TOTAL: "total", BREAKDOWN: "breakdown" }` (exported)
  - `SettingsUtility.getHideNpcRollStyle()` → `string` returning the configured style value (defaults to `"total"`)

- [ ] **Step 1: Write the failing test**

Add to `tests/settings-core.test.mjs`. The file already imports `HIDE_NPC_ROLL_MODES` in `beforeEach` (line 17) — extend that destructure to also pull `HIDE_NPC_ROLL_STYLES`, then add the test.

In the `beforeEach` import line (currently):
```javascript
        ({ SettingsUtility, SETTING_NAMES, HIDE_NPC_ROLL_MODES } = await import("../src/utils/settings.js"));
```
change to:
```javascript
        ({ SettingsUtility, SETTING_NAMES, HIDE_NPC_ROLL_MODES, HIDE_NPC_ROLL_STYLES } = await import("../src/utils/settings.js"));
```
and declare `let HIDE_NPC_ROLL_STYLES;` alongside the existing `let HIDE_NPC_ROLL_MODES;` (line 10).

Add this test (place it after the existing `HIDE_NPC_ROLL_MODE` registration test near line 44):
```javascript
    it("registers hideNpcRollStyle as a world choice setting defaulting to total", () => {
        expect(env.registeredSettings.get(SETTING_NAMES.HIDE_NPC_ROLL_STYLE)).toMatchObject({
            scope: "world",
            config: true,
            type: String,
            default: HIDE_NPC_ROLL_STYLES.TOTAL
        });
    });

    it("getHideNpcRollStyle returns the configured style and defaults to total", () => {
        env.settings.hideNpcRollStyle = HIDE_NPC_ROLL_STYLES.BREAKDOWN;
        expect(SettingsUtility.getHideNpcRollStyle()).toBe(HIDE_NPC_ROLL_STYLES.BREAKDOWN);

        env.settings.hideNpcRollStyle = HIDE_NPC_ROLL_STYLES.TOTAL;
        expect(SettingsUtility.getHideNpcRollStyle()).toBe(HIDE_NPC_ROLL_STYLES.TOTAL);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings-core.test.mjs`
Expected: FAIL — `env.registeredSettings.get(...)` returns `undefined` and `SettingsUtility.getHideNpcRollStyle is not a function`.

- [ ] **Step 3: Add the setting key and the style enum**

In `src/utils/settings.js`, in `SETTING_NAMES`, add the key directly after `HIDE_NPC_ROLL_MODE: "hideNpcRollMode",`:
```javascript
    HIDE_NPC_ROLL_MODE: "hideNpcRollMode",
    HIDE_NPC_ROLL_STYLE: "hideNpcRollStyle",
```

After the existing `HIDE_NPC_ROLL_MODES` enum (the `{ NONE, ATTACKS, ALL }` block ~line 44-48), add:
```javascript
export const HIDE_NPC_ROLL_STYLES = {
    // Mask the modified total (show "???") while revealing the natural d20. Original behavior.
    TOTAL: "total",
    // Reveal the modified total while masking the natural d20 value and all modifiers (issue #23).
    BREAKDOWN: "breakdown"
}
```

- [ ] **Step 4: Register the setting**

In `src/utils/settings.js`, directly after the `game.settings.register(MODULE_NAME, SETTING_NAMES.HIDE_NPC_ROLL_MODE, {...})` block (ends ~line 189), add:
```javascript
        game.settings.register(MODULE_NAME, SETTING_NAMES.HIDE_NPC_ROLL_STYLE, {
            name: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.HIDE_NPC_ROLL_STYLE}.name`),
            hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.HIDE_NPC_ROLL_STYLE}.hint`),
            scope: "world",
            config: true,
            type: String,
            default: HIDE_NPC_ROLL_STYLES.TOTAL,
            requiresReload: true,
            choices: {
                [HIDE_NPC_ROLL_STYLES.TOTAL]: CoreUtility.localize(`${MODULE_SHORT}.choices.hideNpcRollStyle.${HIDE_NPC_ROLL_STYLES.TOTAL}`),
                [HIDE_NPC_ROLL_STYLES.BREAKDOWN]: CoreUtility.localize(`${MODULE_SHORT}.choices.hideNpcRollStyle.${HIDE_NPC_ROLL_STYLES.BREAKDOWN}`)
            }
        });
```

- [ ] **Step 5: Add the accessor**

In `src/utils/settings.js`, add a static method to `SettingsUtility` immediately after `shouldHideNpcRollForActor` (~line 290):
```javascript
    /**
     * The configured presentation style for hidden NPC rolls.
     * "total" masks the modified total and shows the natural d20 (original behavior).
     * "breakdown" reveals the modified total and masks the d20 value + modifiers (issue #23).
     * @returns {string} One of HIDE_NPC_ROLL_STYLES.
     */
    static getHideNpcRollStyle() {
        return SettingsUtility.getSettingValue(SETTING_NAMES.HIDE_NPC_ROLL_STYLE);
    }
```

- [ ] **Step 6: Add i18n strings**

In `lang/en.json`, in the `settings` object (alongside `hideNpcRollMode.name`/`.hint` ~line 22-23), add:
```json
            "hideNpcRollStyle.name": "Hidden Roll Style",
            "hideNpcRollStyle.hint": "Controls what is masked when an NPC roll is hidden (see Hide NPC Roll Results). 'Hide Total' masks the modified total and shows the natural d20. 'Hide Breakdown' reveals the final total but masks the natural d20 value and all modifiers.",
```

In the `choices` object, directly after the `hideNpcRollMode` block (~line 74-78), add:
```json
            "hideNpcRollStyle": {
                "total": "Hide Total (show natural d20)",
                "breakdown": "Hide Breakdown (show final total)"
            }
```
Note: add a comma after the closing brace of the `hideNpcRollMode` choices block so the JSON stays valid.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/settings-core.test.mjs`
Expected: PASS (all tests, including the two new ones).

Also validate JSON: `node -e "require('./lang/en.json'); console.log('en.json OK')"`
Expected: `en.json OK`

- [ ] **Step 8: Commit**

```bash
git add src/utils/settings.js lang/en.json tests/settings-core.test.mjs
git commit -m "feat(settings): add hideNpcRollStyle option (total | breakdown)"
```

---

## Task 2: Stamp the style onto the roll at the visibility chokepoint

**Files:**
- Modify: `src/utils/chat.js` (`_configureRollVisibility`, ~line 808-817)
- Test: `tests/chat-behavior.test.mjs`

**Interfaces:**
- Consumes: `SettingsUtility.getHideNpcRollStyle()`, `HIDE_NPC_ROLL_STYLES` (from Task 1)
- Produces: `roll.options.hideRollStyle` is set to the configured style string **whenever** `roll.options.hideFinalResult` is `true`; it is left untouched otherwise.

- [ ] **Step 1: Write the failing test**

In `tests/chat-behavior.test.mjs`, confirm `HIDE_NPC_ROLL_STYLES` is importable. The file imports settings symbols near the top; add `HIDE_NPC_ROLL_STYLES` to that import from `../src/utils/settings.js` (match the existing import style in the file — search for `from "../src/utils/settings.js"`).

Add this test next to the existing "hides NPC skill roll totals when hideNpcRollMode is all" test (~line 544):
```javascript
    it("stamps hideRollStyle onto a hidden roll from the hideNpcRollStyle setting", async () => {
        env.settings.hideNpcRollMode = "all";
        env.settings.hideNpcRollStyle = HIDE_NPC_ROLL_STYLES.BREAKDOWN;

        const skillRoll = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 18, faces: 20, results: [13] });
        const renderSpy = vi.spyOn(RenderUtility, "render").mockImplementation(async (template, data) => {
            if (template === TEMPLATE.MULTIROLL) {
                return `<span class="rsr-multiroll" data-key="${data.key}"></span>`;
            }
            return "";
        });

        const message = new env.classes.TestChatMessage({
            type: "roll",
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: { quickRoll: true, processed: true, displayChallenge: true },
                dnd5e: { roll: { type: "skill", target: 15 } }
            },
            rolls: [skillRoll],
            getAssociatedActor: () => ({ isOwner: false })
        });
        const html = $(`
            <article><div class="message-content">
                <div class="dice-roll">
                    <div class="dice-total">18</div>
                    <div class="dice-tooltip">
                        <div class="dice-formula">1d20 + 5</div>
                        <div class="tooltip-part constant">+5</div>
                    </div>
                </div>
            </div></article>
        `);

        await ChatUtility.processChatMessage(message, html);

        const multiRollCall = renderSpy.mock.calls.find(([template]) => template === TEMPLATE.MULTIROLL);
        expect(multiRollCall?.[1]?.roll?.options?.hideFinalResult).toBe(true);
        expect(multiRollCall?.[1]?.roll?.options?.hideRollStyle).toBe(HIDE_NPC_ROLL_STYLES.BREAKDOWN);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/chat-behavior.test.mjs -t "stamps hideRollStyle"`
Expected: FAIL — `hideRollStyle` is `undefined`.

- [ ] **Step 3: Implement the stamp**

In `src/utils/chat.js`, update `_configureRollVisibility` (current body):
```javascript
function _configureRollVisibility(roll, rollType, actor) {
    roll.options.hideFinalResult = SettingsUtility.shouldHideNpcRollForActor(actor, rollType);
    if (roll.options.hideFinalResult) {
        // Suppress everything that would reveal the outcome of a hidden roll:
        // the DC pass/fail icon and forced-success crit styling.
        roll.options.displayChallenge = false;
        roll.options.forceSuccess = false;
    }
}
```
to:
```javascript
function _configureRollVisibility(roll, rollType, actor) {
    roll.options.hideFinalResult = SettingsUtility.shouldHideNpcRollForActor(actor, rollType);
    if (roll.options.hideFinalResult) {
        // Suppress everything that would reveal the outcome of a hidden roll:
        // the DC pass/fail icon and forced-success crit styling.
        roll.options.displayChallenge = false;
        roll.options.forceSuccess = false;
        // Record which presentation style the renderer + DOM pass should use.
        roll.options.hideRollStyle = SettingsUtility.getHideNpcRollStyle();
    }
}
```

Confirm `HIDE_NPC_ROLL_STYLES` is imported in `chat.js` if you reference it elsewhere; this step does not need the enum import (it stores the raw string), but the test file does.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/chat-behavior.test.mjs -t "stamps hideRollStyle"`
Expected: PASS

- [ ] **Step 5: Run the full chat-behavior suite to check for regressions**

Run: `npx vitest run tests/chat-behavior.test.mjs`
Expected: PASS (existing `total`-style hiding tests still green — they don't set `hideNpcRollStyle`, so it defaults to `total`).

- [ ] **Step 6: Commit**

```bash
git add src/utils/chat.js tests/chat-behavior.test.mjs
git commit -m "feat(chat): record hideRollStyle on hidden rolls"
```

---

## Task 3: Reveal the total and hide the d20 icon for `breakdown` style (renderer)

**Files:**
- Modify: `src/utils/render.js` (`_renderMultiRoll`, the `entries.push({...})` block ~line 84-99)
- Test: `tests/chat-behavior.test.mjs`

**Interfaces:**
- Consumes: `roll.options.hideRollStyle` (from Task 2), `HIDE_NPC_ROLL_STYLES` (from Task 1)
- Produces: for each multiroll entry, when `hideFinalResult` is true AND style is `breakdown`: `hideTotal === false` and `d20Result === null`. For style `total` (or unset): unchanged (`hideTotal === true`, `d20Result` per the `D20_ICONS_ENABLED` setting).

- [ ] **Step 1: Write the failing test**

`render.js` is currently exercised in chat-behavior via the `RenderUtility.render` spy, but for this entry-shaping logic we test `_renderMultiRoll`'s output data directly. Add a focused test to `tests/chat-behavior.test.mjs` (or a new `describe` block) that calls the real renderer. Add near the other hidden-roll tests:

```javascript
    it("breakdown style reveals total and drops the d20 icon in multiroll entries", async () => {
        // Real renderer (no spy). Capture the data passed to the underlying template.
        const tmplSpy = vi
            .spyOn(foundry.applications.handlebars, "renderTemplate")
            .mockImplementation(async (_path, data) => JSON.stringify(data));

        env.settings.enableD20Icons = true; // would normally produce a d20Result

        const roll = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 18, faces: 20, results: [13] });
        roll.options.hideFinalResult = true;
        roll.options.hideRollStyle = HIDE_NPC_ROLL_STYLES.BREAKDOWN;

        await RenderUtility.render(TEMPLATE.MULTIROLL, { roll, key: "skill" });

        const call = tmplSpy.mock.calls.find(([p]) => String(p).includes("rsr-multiroll"));
        const data = JSON.parse(call[1]);
        expect(data.entries[0].hideTotal).toBe(false);
        expect(data.entries[0].d20Result).toBeNull();
        expect(data.entries[0].total).toBe(18);

        tmplSpy.mockRestore();
    });

    it("total style (default) keeps the total masked and shows the d20 icon", async () => {
        const tmplSpy = vi
            .spyOn(foundry.applications.handlebars, "renderTemplate")
            .mockImplementation(async (_path, data) => JSON.stringify(data));

        env.settings.enableD20Icons = true;

        const roll = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 18, faces: 20, results: [13] });
        roll.options.hideFinalResult = true;
        roll.options.hideRollStyle = HIDE_NPC_ROLL_STYLES.TOTAL;

        await RenderUtility.render(TEMPLATE.MULTIROLL, { roll, key: "skill" });

        const call = tmplSpy.mock.calls.find(([p]) => String(p).includes("rsr-multiroll"));
        const data = JSON.parse(call[1]);
        expect(data.entries[0].hideTotal).toBe(true);
        expect(data.entries[0].d20Result).toBe(13);

        tmplSpy.mockRestore();
    });
```

Note: confirm the harness exposes `foundry.applications.handlebars.renderTemplate` (it is called in `render.js` `_renderModuleTemplate`). If the test harness stubs templates differently, adapt the spy target to whatever `tests/helpers/foundry-env.mjs` provides for `renderTemplate`; the assertions on `entries[0]` stay the same. Inspect `tests/helpers/foundry-env.mjs` before writing this step and match its stubbing convention.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/chat-behavior.test.mjs -t "breakdown style reveals total"`
Expected: FAIL — `hideTotal` is `true` and `d20Result` is `13` (current behavior ignores style).

- [ ] **Step 3: Implement the entry shaping**

In `src/utils/render.js`, add the import for the style enum at the top alongside the existing settings import:
```javascript
import { SETTING_NAMES, SettingsUtility, HIDE_NPC_ROLL_STYLES } from "./settings.js";
```

In `_renderMultiRoll`, replace the current `hideTotal`/entry block:
```javascript
        const total = baseRoll.total + (bonusRoll?.total ?? 0);
        const hideTotal = roll.options.hideFinalResult;

        entries.push({
			roll: baseRoll,
			total: total,
			ignored: tmpResults.some(r => r.discarded) ? true : undefined,
            // Hidden rolls already have displayChallenge and forceSuccess cleared
            // by _configureRollVisibility, so no extra suppression is needed here.
            critType: RollUtility.getCritTypeForDie(baseTerm, critOptions),
            d20Result: SettingsUtility.getSettingValue(SETTING_NAMES.D20_ICONS_ENABLED) ? d20Rolls.results[i].result : null,
            hideTotal,
            dcResult: !critOptions.displayChallenge || isNaN(roll.options.target)
                ? undefined
                : (roll.options.forceSuccess || total >= roll.options.target ? "fas fa-check" : "fas fa-xmark")
		});
```
with:
```javascript
        const total = baseRoll.total + (bonusRoll?.total ?? 0);

        // Two hidden-roll presentations (issue #23):
        //  - "total" (default): mask the modified total, reveal the natural d20.
        //  - "breakdown": reveal the modified total, mask the natural d20 value.
        const isHidden = roll.options.hideFinalResult;
        const isBreakdown = isHidden && roll.options.hideRollStyle === HIDE_NPC_ROLL_STYLES.BREAKDOWN;
        const hideTotal = isHidden && !isBreakdown;
        const showD20Icon = SettingsUtility.getSettingValue(SETTING_NAMES.D20_ICONS_ENABLED) && !isBreakdown;

        entries.push({
			roll: baseRoll,
			total: total,
			ignored: tmpResults.some(r => r.discarded) ? true : undefined,
            // Hidden rolls already have displayChallenge and forceSuccess cleared
            // by _configureRollVisibility, so no extra suppression is needed here.
            critType: RollUtility.getCritTypeForDie(baseTerm, critOptions),
            d20Result: showD20Icon ? d20Rolls.results[i].result : null,
            hideTotal,
            dcResult: !critOptions.displayChallenge || isNaN(roll.options.target)
                ? undefined
                : (roll.options.forceSuccess || total >= roll.options.target ? "fas fa-check" : "fas fa-xmark")
		});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/chat-behavior.test.mjs -t "style"`
Expected: PASS (both the breakdown and total-style entry tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/render.js tests/chat-behavior.test.mjs
git commit -m "feat(render): reveal total and hide d20 icon for breakdown style"
```

---

## Task 4: Mask the d20 die in the tooltip for `breakdown` style (DOM pass)

**Files:**
- Modify: `src/utils/chat.js` (`_applyHiddenRollPresentation`, ~line 826-840)
- Test: `tests/chat-behavior.test.mjs`

**Interfaces:**
- Consumes: `roll.options.hideRollStyle` (from Task 2), `HIDE_NPC_ROLL_STYLES`
- Produces: for `breakdown` style, `_applyHiddenRollPresentation` removes **every** tooltip part (including the natural d20 part), so the breakdown shows no individual dice or modifiers; for `total` style it keeps current behavior (drop non-d20 parts, keep the d20). In both styles the formula text is replaced with the masked string.

- [ ] **Step 1: Write the failing test**

Add to `tests/chat-behavior.test.mjs`, mirroring the existing "strips bonus dice ... keeping only the natural d20" test but for breakdown:
```javascript
    it("breakdown style strips ALL tooltip parts including the natural d20", async () => {
        env.settings.hideNpcRollMode = "all";
        env.settings.hideNpcRollStyle = HIDE_NPC_ROLL_STYLES.BREAKDOWN;

        const skillRoll = makeRoll(env.classes.D20Roll, { formula: "1d20+5+1d4", total: 21, faces: 20, results: [13] });
        const renderSpy = vi.spyOn(RenderUtility, "render").mockImplementation(async (template, data) => {
            if (template === TEMPLATE.MULTIROLL) {
                return `<span class="rsr-multiroll" data-key="${data.key}"></span>`;
            }
            return "";
        });

        const message = new env.classes.TestChatMessage({
            type: "roll",
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: { quickRoll: true, processed: true, displayChallenge: true },
                dnd5e: { roll: { type: "skill", target: 15 } }
            },
            rolls: [skillRoll],
            getAssociatedActor: () => ({ isOwner: false })
        });
        const html = $(`
            <article><div class="message-content">
                <div class="dice-roll">
                    <div class="dice-total">21</div>
                    <div class="dice-tooltip">
                        <div class="dice-formula">1d20 + 5 + 1d4</div>
                        <section class="tooltip-part"><div class="dice"><ol class="dice-rolls"><li class="roll die d20">13</li></ol></div></section>
                        <section class="tooltip-part"><div class="dice"><ol class="dice-rolls"><li class="roll die d4">3</li></ol></div></section>
                        <div class="tooltip-part constant">+5</div>
                    </div>
                </div>
            </div></article>
        `);

        await ChatUtility.processChatMessage(message, html);

        // Breakdown style: NOTHING in the tooltip survives — no d20, no bonus die, no flat mod.
        expect(html.find(".tooltip-part").length).toBe(0);
        expect(html.find(".dice-formula").text()).not.toBe("1d20 + 5 + 1d4");
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/chat-behavior.test.mjs -t "breakdown style strips ALL"`
Expected: FAIL — the natural d20 `.tooltip-part` survives (`length` is `1`, not `0`).

- [ ] **Step 3: Implement the style branch**

In `src/utils/chat.js`, make sure the style enum is imported at the top (add `HIDE_NPC_ROLL_STYLES` to the existing `from "./settings.js"` import). Then update `_applyHiddenRollPresentation`:
```javascript
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
```
to:
```javascript
function _applyHiddenRollPresentation(rollHTML, roll) {
    if (!roll?.options?.hideFinalResult) return;

    const isBreakdown = roll.options.hideRollStyle === HIDE_NPC_ROLL_STYLES.BREAKDOWN;

    if (isBreakdown) {
        // Breakdown style (issue #23): the total is shown, so the entire dice
        // breakdown must be masked — natural d20 included. Drop every tooltip part.
        rollHTML.find('.dice-tooltip .tooltip-part').remove();
    } else {
        // Total style: reveal only the natural d20. Removing flat modifiers
        // (.tooltip-part.constant) is not enough: bonus dice such as Bless or
        // Guidance render as their own non-constant tooltip part (li.roll.die.dN)
        // and would otherwise leak both the buff and the rolled value. Drop every
        // tooltip part that is not a d20 die.
        rollHTML.find('.dice-tooltip .tooltip-part').each((_i, el) => {
            const part = $(el);
            if (part.find('.roll.d20').length === 0) part.remove();
        });
    }

    rollHTML.find('.dice-formula').text("1d20 + " + CoreUtility.localize(`${MODULE_SHORT}.chat.hide`));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/chat-behavior.test.mjs`
Expected: PASS (the new breakdown DOM test plus all existing total-style tests).

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (entire suite green).

- [ ] **Step 6: Commit**

```bash
git add src/utils/chat.js tests/chat-behavior.test.mjs
git commit -m "feat(chat): mask full dice breakdown for breakdown hide style"
```

---

## Task 5: Documentation, changelog, and Foundry listing regeneration

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md` (settings list, ~line 122)
- Modify: `docs/foundry-listing.html` (regenerated, not hand-edited)

**Interfaces:**
- Consumes: nothing (docs only)
- Produces: user-facing documentation of the `Hidden Roll Style` setting.

- [ ] **Step 1: Add the CHANGELOG entry**

In `CHANGELOG.md`, under the top `## [Unreleased]` section (create the section with `### Added` if it does not exist; follow the existing Keep a Changelog formatting in the file):
```markdown
### Added

- **Hidden Roll Style** setting for hidden NPC rolls (issue #23). Choose **Hide Total** (mask the modified total, show the natural d20 — original behavior) or **Hide Breakdown** (show the final total while masking the natural d20 value and all modifiers). Defaults to Hide Total, so existing worlds are unchanged.
```
If a Keep-a-Changelog comparison-link footer exists at the bottom of the file, leave it as-is (it is updated at release time by `/shipit`).

- [ ] **Step 2: Document the setting in the README**

In `README.md`, directly after the existing line 122 (`- **Hide NPC Roll Results** — ...`), add:
```markdown
- **Hidden Roll Style** — when a roll is hidden (see above), choose whether to mask the total and show the natural d20 (**Hide Total**, default) or show the final total while masking the die value and modifiers (**Hide Breakdown**)
```

- [ ] **Step 3: Regenerate the Foundry listing HTML**

Run: `bash scripts/generate-foundry-listing.sh`
Expected: regenerates `docs/foundry-listing.html` from `README.md` with no errors.

Verify it changed: `git status --short docs/foundry-listing.html`
Expected: `M docs/foundry-listing.html`

- [ ] **Step 4: Sanity-check JSON and run the full suite once more**

Run: `node -e "require('./lang/en.json'); console.log('en.json OK')" && npx vitest run`
Expected: `en.json OK` then full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md README.md docs/foundry-listing.html
git commit -m "docs: document Hidden Roll Style setting and regenerate Foundry listing"
```

---

## Task 6: Collapse breakdown hidden rolls to the single kept total (adv/disadv leak fix)

**Files:**
- Modify: `src/utils/render.js` (`_renderMultiRoll`, the per-entry block added in Task 3)
- Test: `tests/chat-behavior.test.mjs`

**Context:** The final whole-branch review found that in `breakdown` style an advantage/disadvantage (or "Always Roll Multiple Dice") hidden roll emits one entry per d20 result, so the discarded die's total renders alongside the kept one. To a non-owner that leaks (a) that adv/disadv was in play and (b) the numeric gap between the two natural d20s (the modifier is constant, so `T_kept − T_ignored = d_kept − d_ignored`). Absolute die values and modifiers stay masked, but for a privacy feature this relative leak should be closed. Fix: in `breakdown` style, skip discarded entries so only the final used total is shown. This must NOT change `total` style (adv/disadv still shows both, one greyed) or any non-hidden roll.

**Interfaces:**
- Consumes: `roll.options.hideFinalResult`, `roll.options.hideRollStyle`, `HIDE_NPC_ROLL_STYLES.BREAKDOWN` (already imported in render.js from Tasks 1-3).
- Produces: in `_renderMultiRoll`, when `hideFinalResult` is true AND style is `breakdown`, entries whose dice are discarded are not pushed — so a multi-d20 breakdown roll yields exactly one entry (the kept result). `total` style and non-hidden rolls are unchanged (still one entry per d20 result).

- [ ] **Step 1: Write the failing tests**

Add to `tests/chat-behavior.test.mjs`, next to the Task 3 renderer tests (which spy on `foundry.applications.handlebars.renderTemplate` and read the data object from `call[1]`). Use the established advantage fixture shape (`results: [{ result, active, discarded }]`):

```javascript
    it("breakdown style renders only the kept total for an advantage hidden roll", async () => {
        const tmplSpy = vi
            .spyOn(foundry.applications.handlebars, "renderTemplate")
            .mockImplementation(async (_path, data) => data);

        // Advantage: discarded 4 (active:false) + kept 17 (active:true).
        const roll = makeRoll(env.classes.D20Roll, {
            formula: "2d20kh1", total: 17, faces: 20,
            results: [
                { result: 4, active: false, discarded: true },
                { result: 17, active: true, discarded: false }
            ]
        });
        roll.options.hideFinalResult = true;
        roll.options.hideRollStyle = HIDE_NPC_ROLL_STYLES.BREAKDOWN;

        await RenderUtility.render(TEMPLATE.MULTIROLL, { roll, key: "skill" });

        const call = tmplSpy.mock.calls.find(([p]) => String(p).includes("rsr-multiroll"));
        const data = call[1];
        expect(data.entries).toHaveLength(1);
        expect(data.entries[0].ignored).toBeUndefined();
        expect(data.entries[0].hideTotal).toBe(false);
        expect(data.entries[0].total).toBe(17);

        tmplSpy.mockRestore();
    });

    it("total style still renders both entries for an advantage hidden roll", async () => {
        const tmplSpy = vi
            .spyOn(foundry.applications.handlebars, "renderTemplate")
            .mockImplementation(async (_path, data) => data);

        const roll = makeRoll(env.classes.D20Roll, {
            formula: "2d20kh1", total: 17, faces: 20,
            results: [
                { result: 4, active: false, discarded: true },
                { result: 17, active: true, discarded: false }
            ]
        });
        roll.options.hideFinalResult = true;
        roll.options.hideRollStyle = HIDE_NPC_ROLL_STYLES.TOTAL;

        await RenderUtility.render(TEMPLATE.MULTIROLL, { roll, key: "skill" });

        const call = tmplSpy.mock.calls.find(([p]) => String(p).includes("rsr-multiroll"));
        const data = call[1];
        expect(data.entries).toHaveLength(2);
        expect(data.entries.some(e => e.ignored === true)).toBe(true);

        tmplSpy.mockRestore();
    });
```

Note: confirm the spy target / data-capture mechanism matches the Task 3 renderer tests already in this file; reuse whatever convention they settled on. The assertions above (entry counts, `ignored`, `hideTotal`, `total`) must stay as written.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/chat-behavior.test.mjs -t "advantage hidden roll"`
Expected: the breakdown test FAILS — `data.entries` has length 2 (current code pushes the discarded entry too). The total-style test should already pass (it asserts current behavior).

- [ ] **Step 3: Implement the skip**

In `src/utils/render.js` `_renderMultiRoll`, the Task 3 block currently reads:
```javascript
        const total = baseRoll.total + (bonusRoll?.total ?? 0);

        // Two hidden-roll presentations (issue #23):
        //  - "total" (default): mask the modified total, reveal the natural d20.
        //  - "breakdown": reveal the modified total, mask the natural d20 value.
        const isHidden = roll.options.hideFinalResult;
        const isBreakdown = isHidden && roll.options.hideRollStyle === HIDE_NPC_ROLL_STYLES.BREAKDOWN;
        const hideTotal = isHidden && !isBreakdown;
        const showD20Icon = SettingsUtility.getSettingValue(SETTING_NAMES.D20_ICONS_ENABLED) && !isBreakdown;

        entries.push({
			roll: baseRoll,
			total: total,
			ignored: tmpResults.some(r => r.discarded) ? true : undefined,
```
Change it to compute `isIgnored` once, add the skip guard, and reuse `isIgnored` in the push:
```javascript
        const total = baseRoll.total + (bonusRoll?.total ?? 0);

        // Two hidden-roll presentations (issue #23):
        //  - "total" (default): mask the modified total, reveal the natural d20.
        //  - "breakdown": reveal the modified total, mask the natural d20 value.
        const isHidden = roll.options.hideFinalResult;
        const isBreakdown = isHidden && roll.options.hideRollStyle === HIDE_NPC_ROLL_STYLES.BREAKDOWN;
        const hideTotal = isHidden && !isBreakdown;
        const showD20Icon = SettingsUtility.getSettingValue(SETTING_NAMES.D20_ICONS_ENABLED) && !isBreakdown;
        const isIgnored = tmpResults.some(r => r.discarded);

        // In breakdown style only the final used total is shown. Rendering the
        // discarded advantage/disadvantage die's total too would leak that
        // adv/disadv was in play and the gap between the two natural d20s, so
        // skip discarded entries entirely in this style.
        if (isBreakdown && isIgnored) continue;

        entries.push({
			roll: baseRoll,
			total: total,
			ignored: isIgnored ? true : undefined,
```
Leave the remaining fields (`critType`, `d20Result`, `hideTotal`, `dcResult`) exactly as they are.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/chat-behavior.test.mjs -t "advantage hidden roll"`
Expected: both PASS.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (all prior tests still green — `total` style and non-hidden rolls unaffected).

- [ ] **Step 6: Update CHANGELOG and commit**

Add a one-line note under the existing `## [Unreleased]` → `### Added` (or a `### Fixed` subsection) in `CHANGELOG.md`, e.g.:
```markdown
- Hide Breakdown style now collapses advantage/disadvantage rolls to the single final total, so the discarded die no longer reveals that advantage was in play.
```
This is a CHANGELOG-only doc touch (no README wording change), so the Foundry listing does not need regenerating. Then commit:
```bash
git add src/utils/render.js tests/chat-behavior.test.mjs CHANGELOG.md
git commit -m "fix(render): collapse breakdown adv/disadv hidden rolls to single total"
```

---

## Self-Review

**Spec coverage (issue #23 + comments):**
- "see only the result of check/attack/damage, but without seeing the die value or modifiers" → Tasks 3 + 4 (reveal total; mask d20 icon + every tooltip part). ✅
- Applies to check/attack/etc. → reuses `D20_NPC_ROLL_TYPES` via the existing `hideNpcRollMode` gating; the new style affects all roll types the existing mode already hides. ✅
- **Deferred / out of scope (call out to the user):**
  - *DSN "ghost dice"* (comment): controlling Dice So Nice 3D dice presentation is a separate integration touching `CoreUtility.getWhisperData`/`game.dice3d.showForRoll` in `core.js`; not included here. Note in handoff.
  - *Hide in any chat/roll mode* and *hide GM-controlled PC rolls too* (issue #17 / comments): these change the *gating* (who/what is hidden), not the *style*. They belong with #17's `shouldHideNpcRollForActor` logic, not this presentation change. Out of scope for this plan.
  - *Replace "???" with a dice icon* (comment): a `total`-style tweak to `lang/en.json` `chat.hide` / the multiroll template; independent of #23's core ask. Out of scope.

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N" — all steps contain concrete code and exact commands. ✅

**Type consistency:** `HIDE_NPC_ROLL_STYLES` / `SETTING_NAMES.HIDE_NPC_ROLL_STYLE` / `getHideNpcRollStyle()` / `roll.options.hideRollStyle` used identically across Tasks 1-4. Renderer reads `roll.options.hideRollStyle === HIDE_NPC_ROLL_STYLES.BREAKDOWN`; chat DOM pass uses the same comparison; both default safely to `total` when unset. ✅

**Harness caveats flagged:** Task 3 Step 1 instructs the implementer to confirm the `renderTemplate` stub convention in `tests/helpers/foundry-env.mjs` before finalizing the spy target. ✅
