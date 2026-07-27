# RSReforged Integration API

RSReforged rewrites chat-message DOM and triggers full re-renders to deliver its quick-roll UI. That conflicts with any other module that also decorates chat cards by hooking Foundry's `renderChatMessageHTML` or `dnd5e.renderChatMessage` directly — hook order is non-deterministic, and RSR's `.remove()` / `.replaceWith()` calls can clobber another module's work.

This document describes the `rsreforged.*` hook surface RSR emits so third-party modules can decorate RSR-rendered cards at deterministic points in the lifecycle.

The hooks listed here are **public API**. They follow [Semantic Versioning](https://semver.org/) — breaking changes require a major-version bump and a changelog entry. See the [Versioning](#versioning) section below for the full bump-rule table.

---

## The Three Rules

Before you write a listener, accept these constraints.

### 1. Synchronous only

`Hooks.callAll` does not await listeners. If your handler is `async`, RSR will not wait for the promise to settle. By the time your async work completes, the next re-render may have already replaced the DOM you were holding a reference to. Do synchronous DOM work inside the hook; defer anything else (network, sheet rendering, dialog) outside the hook with your own coordination.

### 2. Must be idempotent

`message.update()` calls inside RSR re-fire the entire render hook chain on the new HTML. Your listener will run again on the same logical message, against new DOM nodes. Listeners that inject content must:

- Check for their own marker class / data attribute before inserting, OR
- Replace the existing instance instead of appending a duplicate, OR
- Use stable IDs and `replaceWith()` on re-fire.

```js
// Wrong — produces N copies after N rerolls
Hooks.on("rsreforged.renderChatMessageContent", (msg, html) => {
    html.find('.rsr-section-attack').append('<div class="my-decoration">…</div>');
});

// Right — idempotent
Hooks.on("rsreforged.renderChatMessageContent", (msg, html) => {
    html.find('.my-decoration').remove(); // or .find('.my-decoration').length && return
    html.find('.rsr-section-attack').append('<div class="my-decoration">…</div>');
});
```

### 3. `preRender` without `render` is possible

RSR's `_injectContent` can detect that a roll message is a child of a parent activity card, merge the roll into the parent via `message.update()`, then `message.delete()` the child. In that case:

- `rsreforged.preRenderChatMessageContent` fires for the child message.
- `rsreforged.renderChatMessageContent` does **not** fire for the child (it was deleted).
- The parent message receives its own full lifecycle on the resulting re-render.

Treat `preRender` and `render` as independent events that may or may not be paired. Do not stash state across the pair expecting a guaranteed teardown.

---

## Hook Reference

All hook names use the `rsreforged.` prefix. All call `Hooks.callAll` (so listener errors are swallowed, return values are ignored).

### `rsreforged.preRenderChatMessageContent`

Fires at the top of RSR's `_injectContent`, **before any DOM is removed**. This is your only chance to read the dnd5e-native chat card before RSR strips it.

| Arg | Type | Description |
| --- | ---- | ----------- |
| `message` | `ChatMessage5e` | The message being rendered |
| `html` | `jQuery` | The content node RSR was passed (usually `.message-content`) |
| `type` | `string` | RSR's roll-type enum (literal string values, from `src/utils/roll.js` `ROLL_TYPE`): `"attack"`, `"damage"`, `"roll"` (formula), `"skill"`, `"ability"` (ability check), `"save"`, `"death"` (death save), `"tool"`, `"activity"` |

**Use case:** wm5e snapshotting `<a class="wm5e-mastery-reference">` anchors before RSR removes the dnd5e card that contains them, so they can be re-attached in the post hook.

### `rsreforged.renderChatMessageContent`

Fires at the bottom of `_injectContent`, after `_setupCardListeners`. RSR has finished its DOM rewrite; this is the primary decoration point.

Signature identical to `preRenderChatMessageContent`.

**Use case:** AC5E attaching `data-tooltip` attributes to save/check buttons. The attribute survives until the next re-render, at which point this hook fires again and AC5E reapplies it.

### `rsreforged.renderRoll`

Fires at the end of each section render — once per attack roll, once per damage roll, once per formula roll. For damage, fires from both the RSR-mode path and the native-mode early-return path.

| Arg | Type | Description |
| --- | ---- | ----------- |
| `message` | `ChatMessage5e` | The message being rendered |
| `html` | `jQuery` | The content node RSR was passed |
| `type` | `string` | One of `"attack"`, `"damage"`, `"roll"` (the formula section — value matches `ROLL_TYPE.FORMULA` in `src/utils/roll.js`) |
| `sectionHtml` | `jQuery` | The just-inserted section node (e.g. `.rsr-section-attack`, or the native damage card when `mode === "native"`) |

`sectionHtml` is provided so listeners don't have to query the whole card to find what RSR just inserted.

Note: in native damage-apply mode, `sectionHtml` only contains a `<damage-application>` tray on dnd5e versions that don't inject one into the usage card themselves (pre-5.3.1) — on newer dnd5e the system's own tray is kept and the fragment's duplicate is stripped, so query the card (`html`), not `sectionHtml`, when you need the tray.

**Use case:** decorating only attack-roll sections (e.g. wm5e mastery links live on attack rolls, so a listener can early-return on other types).

### `rsreforged.renderApplyDamageButtons`

Fires at the end of `_injectApplyDamageButtons` when RSR's damage-apply UI (`×2 / ÷2 / temp HP / heal / etc.`) is wired up.

| Arg | Type | Description |
| --- | ---- | ----------- |
| `message` | `ChatMessage5e` | The message being rendered |
| `html` | `jQuery` | The content node |
| `buttonsHtml` | `jQuery` | The `.rsr-damage` container the apply-damage buttons were appended to |

**Use case:** adding custom damage-apply variants (e.g. resistance/vulnerability toggles).

---

## Lifecycle

```
Roll message created
  ↓
Foundry: renderChatMessageHTML fires
  ↓
RSR's listener calls processChatMessage(message, html)
  ↓
  ├─ activity message? → _injectContent(message, "activity", html)
  │     ↓
  │   rsreforged.preRenderChatMessageContent  ← fires here
  │     ↓
  │   [RSR removes .dice-roll, .dnd5e2.chat-card, [data-action=…]]
  │     ↓
  │   [_injectAttackRoll]  → rsreforged.renderRoll ("attack")
  │   [_injectDamageRoll]  → rsreforged.renderRoll ("damage")
  │   [_injectFormulaRoll] → rsreforged.renderRoll ("roll")
  │   [_injectApplyDamageButtons] → rsreforged.renderApplyDamageButtons
  │     ↓
  │   _setupCardListeners
  │     ↓
  │   rsreforged.renderChatMessageContent  ← fires here
  │
  └─ other roll types → _injectContent fires the same hooks
                        (skill/save/check rolls fire pre + post only;
                         renderRoll fires only for attack/damage/formula sections)
```

When RSR calls `message.update()` (re-roll for advantage, damage application, etc.), Foundry re-fires `renderChatMessageHTML`, which restarts this entire chain on the new HTML.

---

## Worked Example 1: Re-attach mastery links after RSR re-render

Mirrors the wm5e use case from [RSReforged #13](https://github.com/arrowedisgaming/RSReforged/issues/13). Mastery links live inside the dnd5e attack chat card, which RSR removes.

**The critical wrinkle:** in the quick-roll path, `preRender` fires on a *child* roll message that RSR then merges into a parent activity card and deletes. The matching `renderRoll("attack")` fires later on the *parent* — a different `ChatMessage` instance. A `WeakMap` (or any map) keyed by the message you see in `preRender` will miss in `renderRoll`.

Resolve the merge target in `preRender` using the same lookup RSR uses internally (`getOriginatingMessage`, `getAssociatedMessage`, `flags.dnd5e.originatingMessage`), and key the snapshot by the parent's id when a parent exists.

```js
// In your module's init:
const snapshots = new Map(); // keyed by parent id when merging, else by message id

function resolveTargetId(message) {
    // Mirrors src/utils/chat.js _injectContent parent resolution. When a child
    // attack/damage roll will be merged into a parent activity card, the post
    // hooks fire on the parent — so we have to key under the parent's id here.
    // All four fallbacks must match RSR's resolution order, including the final
    // message.system.message case used by dnd5e versions that expose the parent
    // only through the system data model.
    const origin = message.getOriginatingMessage?.();
    if (origin && origin !== message) return origin.id;
    const associated = message.getAssociatedMessage?.();
    if (associated && associated !== message) return associated.id;
    const originId = message.flags?.dnd5e?.originatingMessage;
    if (originId) return originId;
    const systemMessageId = message.system?.message;
    if (systemMessageId) return systemMessageId;
    return message.id;
}

Hooks.on("rsreforged.preRenderChatMessageContent", (message, html, type) => {
    if (type !== "activity" && type !== "attack") return;
    const links = html.find('a.wm5e-mastery-reference').detach();
    if (!links.length) return;
    snapshots.set(resolveTargetId(message), links);
});

Hooks.on("rsreforged.renderRoll", (message, html, rollType, sectionHtml) => {
    if (rollType !== "attack") return;
    const links = snapshots.get(message.id);
    if (!links?.length) return;
    // Re-attach inside the RSR attack section, idempotently.
    sectionHtml.find('a.wm5e-mastery-reference').remove();
    sectionHtml.append(links.clone(true));
});
```

Why `Map` instead of `WeakMap`: in the merge path, the key is a string id, not the child message object (which gets garbage-collected after `message.delete()`). Cloning with `true` preserves event handlers. The `.remove()` before `.append()` is the idempotency guard for re-renders.

**When does the merge case actually fire?** Quick-roll attacks and damage rolls on activities that RSR is handling. Plain skill checks, saves, and tool checks don't merge — `preRender` and `renderRoll` (if it fires) run on the same message, so the parent-resolution helper returns `message.id` and the code path collapses to the simple case.

**`.supplement` preservation (4.7.1+).** RSR now keeps dnd5e's `<p class="supplement">` wrappers across the rebuild — including the mastery anchors, damage-on-save notes, and legendary-resistance flags that `_enrichAttackTargets` and friends attach. Surviving and rescued supplements end up under `.rsr-section-attack` carrying *both* `.supplement` (original) and `.rsr-supplement` (for RSR's own styling). Modules that previously had to walk the inner anchors individually (as the snapshot/re-attach example above does) can now also query `.supplement` directly on the rebuilt DOM. The example above still works and is more defensive than relying on the wrapper — keep using it if you want belt-and-braces preservation, especially for module-specific decorations that live alongside dnd5e's content inside the supplement.

---

## Worked Example 2: Re-apply tooltips on save buttons

Mirrors the AC5E use case from [RSReforged #3](https://github.com/arrowedisgaming/RSReforged/issues/3). AC5E annotates `[data-action=rollSave]` / `[data-action=rollCheck]` buttons with computed `data-tooltip` attributes. RSR doesn't usually remove those buttons (only the attack/damage/formula ones), but a re-render still rebuilds the DOM, stripping the attribute.

```js
function applyAc5eTooltip(message, html) {
    const tooltip = message.flags?.['automated-conditions-5e']?.tooltipObj?.save;
    if (!tooltip) return;
    html.find('button[data-action=rollSave], button[data-action=rollCheck]')
        .attr('data-tooltip', tooltip)
        .removeAttr('title');
}

Hooks.on("rsreforged.renderChatMessageContent", applyAc5eTooltip);
```

Single post hook is enough. Listener is naturally idempotent — `.attr()` overwrites rather than appends.

---

## Target descriptors on RSR cards

dnd5e's `Activity#use()` stamps `flags.dnd5e.targets` onto the usage card from
`getTargetDescriptors()` *before* any attack roll happens. Those descriptors predate
anything your module does during the roll. RSR therefore treats them as provisional and
replaces them with the roll's own view, from whichever of these is available:

- **A real attack-roll message** merged into the card. RSR copies its descriptors over
  the card's.
- **The pending roll-message configuration**, on RSR's quick-roll path. RSR rolls with
  `create: false`, so dnd5e never turns that configuration into a message and everything
  written into it would otherwise be discarded. RSR captures
  `data.flags.dnd5e.targets` from it at `dnd5e.postRollConfiguration` and copies the
  result onto the card.

If your module adjusts target descriptors during an attack roll (cover bonuses,
condition-driven AC changes), write them the way you would for a native dnd5e roll and
RSR will pick them up:

```js
Hooks.on("dnd5e.preRollAttack", (config, dialog, message) => {
    for ( const target of message.data?.flags?.dnd5e?.targets ?? [] ) {
        if ( target.uuid === myTargetUuid ) target.ac = myAdjustedAC;
    }
});
```

Constraints:

- **Write during or before `dnd5e.postRollConfiguration`.** That is the last of the
  three post-configuration hooks an attack fires (`postAttackRollConfiguration`,
  `postD20TestRollConfiguration`, `postRollConfiguration`) and is where RSR captures.
  `dnd5e.rollAttack` and `dnd5e.postRollAttack` are both too late.
- **Mutate the descriptor entries in place, or replace the `targets` array on the
  configuration.** RSR reads whatever is on `message.data.flags.dnd5e.targets` at
  capture time.
- **The captured set replaces what is on the card, including with an empty list.** An
  attack rolled against no targets clears the card's descriptors rather than leaving
  the pre-roll set showing.
- **Only attack rolls are captured.** Damage and formula rolls are not.

This is not an RSR-specific API — it is RSR declining to discard the dnd5e workflow's
own data. A module written against native dnd5e needs no RSR-specific code to benefit.

---

## Versioning

Hook names, argument positions, and argument types listed in this document are stable. Changes will follow [Keep a Changelog](https://keepachangelog.com/) conventions:

- **Patch bump**: bug fixes that don't change the hook contract.
- **Minor bump**: adding a new hook, adding a new optional trailing argument to an existing hook.
- **Major bump**: removing a hook, renaming a hook, reordering or changing the type of existing arguments. Old hooks will continue to fire for at least one minor cycle before removal.

If you ship a module that depends on these hooks, pin the minimum RSR version in your `module.json` (`relationships.requires[].compatibility.minimum`). The introducing version is recorded in [`CHANGELOG.md`](../CHANGELOG.md) under the release entry that lists the Integration API addition.

## Troubleshooting

- **My hook fires multiple times per roll.** Expected. `message.update()` re-renders. Make your listener idempotent.
- **My hook fires for the wrong message.** RSR may merge child roll messages into parents and delete the child. Filter on `message.flags?.rsreforged?.renderAttack` (or similar) if you only want to act on the merged parent.
- **My async work runs after RSR's next re-render.** Don't do async work inside the hook — `Hooks.callAll` doesn't await. Synchronously snapshot what you need; defer work.
- **My listener never fires.** Confirm you're on the RSR version that introduced the Integration API (see [`CHANGELOG.md`](../CHANGELOG.md)). Add a one-line log: `Hooks.on("rsreforged.renderChatMessageContent", (m,h,t) => console.log("rsr", t));`. Make a roll. If you see nothing, file an issue.
