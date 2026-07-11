# Restore Native Chat Tray State (Issue #33) Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix merged RSReforged quick-roll cards so dnd5e's Target and Apply trays open, close, and preserve manual state according to the user's existing dnd5e **Collapse Chat Card Trays** setting, resolving [issue #33](https://github.com/arrowedisgaming/RSReforged/issues/33).

**Architecture:** Keep dnd5e as the single owner of chat-tray policy. dnd5e 5.3.3 stores per-message tray state in `ChatMessage5e._trayStates` and applies the `autoCollapseChatTrays` client setting through `ChatMessage5e._collapseTrays(html)`. RSReforged rebuilds processed usage cards after dnd5e's normal render pipeline, which introduces or relocates Target (`.card-tray.targets-tray`) and Apply (`damage-application`) UI after the native tray-state pass. Once `_injectContent` has finished producing the final merged DOM, call the message's native `_collapseTrays` method on that final DOM. Guard the call because it is a dnd5e-specific compatibility method. Do not duplicate dnd5e's collapse algorithm and do not add an RSReforged setting.

**Tech Stack:** Foundry VTT v14 module, dnd5e 5.3.3+, vanilla ES modules, jQuery DOM handling, custom elements, Vitest with the jsdom-based Foundry harness in `tests/helpers/foundry-env.mjs`.

## Root Cause

1. `ChatUtility.processUsageChatMessage` waits until dnd5e has rendered a stable usage card, then calls `_injectContent` to combine attack and damage output into that card.
2. During that rewrite, RSReforged preserves the usage/activation card, removes obsolete roll-card wrappers, and injects new attack/damage content. In native damage-apply mode it moves dnd5e-rendered content, including the `damage-application` custom element, from a synthetic message fragment into the final card.
3. dnd5e normally applies tray state in `ChatMessage5e._collapseTrays`. Its rules come from the client-scoped `autoCollapseChatTrays` setting (`manual`, `never`, `older`, or `always`) and any saved `_trayStates` captured before a message update.
4. The RSReforged rewrite happens after the relevant native render work, but it never reapplies `_collapseTrays` to the final DOM. A Target tray can therefore retain its template's initial `collapsed` class, and an inserted Apply element can retain a missing `open` attribute, regardless of the user's dnd5e preference.

Upstream references:

- [`ChatMessage5e._collapseTrays`](https://github.com/foundryvtt/dnd5e/blob/5.3.x/module/documents/chat-message.mjs) applies saved state and the configured collapse policy to `.card-tray`, `damage-application`, and `effect-application` elements.
- [`ChatLog5e.updateMessage`](https://github.com/foundryvtt/dnd5e/blob/5.3.x/module/applications/chat-log.mjs) snapshots tray state before replacing a rendered message.
- [`DamageApplicationElement`](https://github.com/foundryvtt/dnd5e/blob/5.3.x/module/applications/components/damage-application.mjs) uses its `open` attribute to build and display the per-target Apply tray.
- [`autoCollapseChatTrays`](https://github.com/foundryvtt/dnd5e/blob/5.3.x/module/settings.mjs) is already a client setting, so adding a world-scoped RSReforged equivalent would create conflicting sources of truth.

## Global Constraints

- Preserve Foundry VTT v14 and dnd5e 5.3+ compatibility.
- Do not add a new setting, migration, localization key, CSS rule, or template.
- Do not implement a parallel copy of dnd5e's `manual` / `never` / `older` / `always` policy.
- Saved manual state in `message._trayStates` must remain authoritative when dnd5e has recorded it.
- Only reapply tray state after the final usage-card DOM exists. Calling earlier would miss the native Apply element inserted by `_injectDamageRoll`.
- Keep non-dnd5e/test-double compatibility by checking that `_collapseTrays` exists before calling it.
- Do not alter roll merging, damage application, targeting, or card scrolling behavior.
- Add a Keep a Changelog entry under `[Unreleased]`.
- Test runner: `npx vitest run` (single run, no watch).
- No AI attribution in code, documentation, commits, or pull-request text.

---

## File Structure

- `tests/chat-behavior.test.mjs` — Add the issue #33 regression test around processed usage-card rendering. *(Modify)*
- `src/utils/chat.js` — Add a small guarded tray-state handoff and call it after `_injectContent` finishes. *(Modify)*
- `CHANGELOG.md` — Record the corrected Target/Apply tray behavior under `[Unreleased]`. *(Modify)*
- `tests/helpers/foundry-env.mjs` — No change expected; use a per-message `_collapseTrays` spy in the regression test instead of teaching the shared harness dnd5e's full policy. *(Reference only)*

---

## Task 1: Lock Down the Post-Rewrite Tray-State Contract

**Files:**

- Test: `tests/chat-behavior.test.mjs` (processed usage-card tests beginning near line 87)
- Reference: `tests/helpers/foundry-env.mjs` (`TestChatMessage`, near line 222)

**Contract under test:**

- A processed activity card delegates tray-state application to `message._collapseTrays` exactly once.
- Delegation happens after `_injectContent` has completed, so the callback sees the final merged attack/damage DOM.
- The DOM passed to dnd5e contains both the Target tray and native Apply element when present.
- The native callback can remove the Target tray's `collapsed` class and add `open` to `damage-application`; RSReforged does not overwrite those results afterward.

- [ ] **Step 1: Add a focused failing regression test**

Add a test beside `"renders processed usage cards after dnd5e has produced stable card HTML"`. Use native damage mode so the scenario matches the reported UI:

```javascript
    it("reapplies dnd5e tray state after rebuilding a merged usage card (issue #33)", async () => {
        env.settings.damageApplyMode = "dnd5e";

        const attack = makeRoll(env.classes.D20Roll, {
            formula: "1d20+5", total: 18, faces: 20, results: [13]
        });
        const damage = makeRoll(env.classes.DamageRoll, {
            formula: "1d8+3", total: 8, faces: 8, results: [5]
        });
        const actor = { isOwner: true, items: { get: vi.fn() } };
        const message = new env.classes.TestChatMessage({
            type: "usage",
            isAuthor: true,
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    renderAttack: true,
                    renderDamage: true,
                    rolls: [attack, damage]
                },
                dnd5e: { activity: { type: "attack" } }
            },
            getAssociatedActor: () => actor
        });
        const html = $(`
            <article class="chat-message">
                <div class="message-content">
                    <div class="dnd5e2 chat-card usage-card">
                        <div class="card-buttons">
                            <button data-action="rollAttack"></button>
                            <button data-action="rollDamage"></button>
                        </div>
                        <div class="card-tray targets-tray collapsible collapsed"></div>
                        <damage-application></damage-application>
                    </div>
                </div>
            </article>
        `);

        message._collapseTrays = vi.fn(root => {
            // Proves delegation runs after RSR has built the merged card.
            expect(root.querySelector(".rsr-section-attack")).not.toBeNull();
            expect(root.querySelector("[data-action=rollDamage]")).toBeNull();
            expect(env.hookCalls.some(call =>
                call.name === `${MODULE_SHORT}.renderRoll` && call.args[2] === "damage"
            )).toBe(true);

            root.querySelector(".targets-tray")?.classList.remove("collapsed");
            root.querySelector("damage-application")?.setAttribute("open", "");
        });

        await ChatUtility.processUsageChatMessage(message, html[0]);

        expect(message._collapseTrays).toHaveBeenCalledTimes(1);
        expect(message._collapseTrays).toHaveBeenCalledWith(html.find(".message-content")[0]);
        expect(html.find(".targets-tray").hasClass("collapsed")).toBe(false);
        expect(html.find("damage-application").attr("open")).not.toBeUndefined();
    });
```

If the exact native-damage fixture produced by the harness makes `.dice-roll` ambiguous, assert a stable post-injection marker such as `.rsr-section-attack` plus removal of `[data-action=rollDamage]`. Keep the essential assertion: `_collapseTrays` sees the DOM only after the rewrite.

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run:

```bash
npx vitest run tests/chat-behavior.test.mjs -t "reapplies dnd5e tray state"
```

Expected: FAIL because `message._collapseTrays` is never called; the Target tray remains collapsed and the Apply element remains closed.

- [ ] **Step 3: Confirm the existing usage-card tests remain unchanged**

Do not add `_collapseTrays` to the shared `TestChatMessage` class. Existing test doubles intentionally lack this dnd5e-specific method and will verify that the production guard is safe once implemented.

- [ ] **Step 4: Commit the red test only if the project workflow uses red/green commits**

Suggested commit message:

```text
test(chat): reproduce closed merged card trays
```

Otherwise keep the failing test uncommitted and proceed directly to Task 2.

---

## Task 2: Reapply dnd5e Tray State to the Final Usage-Card DOM

**Files:**

- Modify: `src/utils/chat.js` (`processUsageChatMessage`, immediately after `_injectContent`, currently near line 174)
- Modify: `src/utils/chat.js` (private helper area near `_scrollChatToBottom`, currently near line 296)
- Test: `tests/chat-behavior.test.mjs`

**Interface:**

```javascript
_applyDnd5eTrayState(message, html) -> void
```

The helper accepts the activity message and the jQuery content root. It is a no-op when no DOM root exists or when the message does not expose dnd5e's `_collapseTrays` method.

- [ ] **Step 1: Add the guarded helper**

Near `_scrollChatToBottom`, add:

```javascript
/**
 * Reapply dnd5e's native Target/Apply tray policy after RSR has rebuilt a
 * processed usage card. This preserves autoCollapseChatTrays and any manual
 * state captured in ChatMessage5e._trayStates without duplicating that logic.
 */
function _applyDnd5eTrayState(message, html) {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || typeof message?._collapseTrays !== "function") return;
    message._collapseTrays(root);
}
```

Keep this synchronous. dnd5e's `_collapseTrays` only mutates DOM attributes/classes and returns no promise.

- [ ] **Step 2: Call it at the correct lifecycle point**

In `ChatUtility.processUsageChatMessage`, immediately after:

```javascript
        await _injectContent(message, type, content);
```

add:

```javascript
        _applyDnd5eTrayState(message, content);
```

This placement is intentional:

- after `_injectDamageRoll`, so native `damage-application` has been inserted;
- after the RSReforged render integration hook fired from `_injectContent`, so trays added by that supported extension point are also covered;
- before hover overlays and card reveal, avoiding a visible closed-to-open flash;
- before scrolling, so the final expanded height is used.

- [ ] **Step 3: Run the focused regression test**

Run:

```bash
npx vitest run tests/chat-behavior.test.mjs -t "reapplies dnd5e tray state"
```

Expected: PASS.

- [ ] **Step 4: Run all chat behavior tests**

Run:

```bash
npx vitest run tests/chat-behavior.test.mjs
```

Expected: PASS. In particular, existing processed usage-card tests whose `TestChatMessage` lacks `_collapseTrays` must continue without error, proving the compatibility guard works.

- [ ] **Step 5: Review scope before committing**

Confirm the production diff:

- does not read `game.settings.get("dnd5e", "autoCollapseChatTrays")` directly;
- does not manipulate `.collapsed` or `open` itself;
- does not call `_collapseTrays` for ordinary non-activity roll messages;
- calls the native handler once per completed processed usage-card render;
- does not touch hidden/invisible messages because `processUsageChatMessage` already exits when `message.isContentVisible` is false.

- [ ] **Step 6: Commit the implementation and regression test**

Suggested commit message:

```text
fix(chat): restore native tray state on merged cards
```

---

## Task 3: Document and Verify the Fix

**Files:**

- Modify: `CHANGELOG.md`
- Verify: full repository test suite

- [ ] **Step 1: Add the changelog entry**

Under `## [Unreleased]`, add:

```markdown
### Fixed

- Merged quick-roll cards now honor dnd5e's **Collapse Chat Card Trays** preference and preserve manual state for the Target and native Apply trays, instead of forcing both trays closed after RSReforged rebuilds the card. Fixes [#33](https://github.com/arrowedisgaming/RSReforged/issues/33).
```

Do not add README or localization changes; the user-facing preference is dnd5e's existing setting.

- [ ] **Step 2: Run the full automated suite**

Run:

```bash
npm test
```

Expected: all Vitest files pass with no unhandled errors or rejected promises.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git diff --check
git diff -- src/utils/chat.js tests/chat-behavior.test.mjs CHANGELOG.md
git status --short
```

Expected:

- `git diff --check` produces no output;
- only the intended production, regression-test, changelog, and plan files are changed;
- no package-lock, generated listing, settings, translation, CSS, or template churn.

- [ ] **Step 4: Perform a Foundry VTT smoke-test matrix**

Use Foundry VTT v14.364 and dnd5e 5.3.3 with RSReforged activity quick rolls enabled. Set **Damage Apply UI** to **dnd5e Native Per-Target Tray**, target at least one token, and roll an attack with damage.

| dnd5e Collapse Chat Card Trays | Fresh merged card expectation | Re-render/update expectation |
| --- | --- | --- |
| Never | Target and Apply open | Both remain open unless manually changed and saved |
| Older | New card open; old cards follow dnd5e's five-minute rule | Native policy remains authoritative |
| Always | Target and Apply closed | Both remain closed |
| Manual | New card follows native default; user toggles are retained | Saved `_trayStates` wins on update |

Also verify:

- Target rows show the expected actor and hit/miss or AC information.
- Apply rows show the intended targeted/selected token before applying damage.
- Clicking the tray headers still toggles each tray.
- Applying damage still uses dnd5e's native workflow and does not duplicate the Apply tray.
- Switching **Damage Apply UI** to **RSReforged Quick Buttons** leaves quick buttons unchanged and does not create a native Apply tray; the Target tray still follows dnd5e policy.
- A card with no targets or no damage does not throw.
- Reloading the world or causing the message to re-render does not reset a manually preserved tray state.

- [ ] **Step 5: Commit documentation if it was not included with Task 2**

Suggested commit message:

```text
docs(changelog): note restored chat tray state
```

---

## Acceptance Criteria

- [ ] Issue #33's merged attack/damage card no longer forces Target and Apply closed.
- [ ] dnd5e's existing `autoCollapseChatTrays` client setting controls both trays.
- [ ] Saved manual state from `message._trayStates` survives message updates and re-renders.
- [ ] Native Apply is expanded only through dnd5e's own `open` handling, allowing its target list to build normally.
- [ ] RSReforged Quick Buttons mode remains behaviorally unchanged.
- [ ] Messages without `_collapseTrays` render safely.
- [ ] Focused and full automated tests pass.
- [ ] Manual Foundry checks pass for all four native collapse modes.
- [ ] `CHANGELOG.md` records the fix and references issue #33.

## Out of Scope

- Adding a separate “Always open Target/Apply” RSReforged setting.
- Changing dnd5e's five-minute definition of an “older” tray.
- Persisting tray state in RSReforged flags.
- Changing which tokens appear in Target or Apply rows.
- Changing attack hit/miss calculation or damage application.
- Addressing hidden-card information disclosure from issue #26.
- Addressing dice animation timing from issue #32.
