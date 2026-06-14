import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Source-level assertions on src/utils/chat.js. These catch the regression class
// the integration API was introduced to prevent: a render function gaining a new
// early-return path without a matching Hooks.callAll emit, silently leaving
// third-party listeners (wm5e, AC5E) un-notified for that branch.
//
// A behavioural test would need a full Foundry/dnd5e/jQuery shim to drive
// _injectContent end-to-end; the failure mode we care about — "the emit is in
// the wrong function or after a return" — is fully observable at the source
// level. Keeping the test source-only also means it stays green if RSR's DOM
// internals are refactored, as long as the public contract holds.

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHAT_JS = readFileSync(resolve(__dirname, "../src/utils/chat.js"), "utf8");
const ACTIVITY_JS = readFileSync(resolve(__dirname, "../src/utils/activity.js"), "utf8");

function extractFunctionBody(source, signature) {
    const start = source.indexOf(signature);
    if (start === -1) throw new Error(`Function not found in chat.js: ${signature}`);
    // Skip past the parameter list to the function body's opening brace.
    // The signature may contain destructured defaults like `{ mode = "rsr" } = {}`
    // so we can't just take the first `{` after start — we need the one after
    // the matching `)` that closes the parameter list.
    let i = source.indexOf("(", start);
    let parenDepth = 0;
    for (; i < source.length; i++) {
        if (source[i] === "(") parenDepth++;
        else if (source[i] === ")") {
            parenDepth--;
            if (parenDepth === 0) { i++; break; }
        }
    }
    const bodyStart = source.indexOf("{", i);
    let depth = 0;
    for (i = bodyStart; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") {
            depth--;
            if (depth === 0) return source.slice(bodyStart, i + 1);
        }
    }
    throw new Error(`Unbalanced braces in ${signature}`);
}

describe("Integration API: rsreforged.* hook emissions in chat.js", () => {
    // Structural smoke check only — it counts call sites in source text, so a refactor
    // that moves an emit behind a dead guard would keep the count at 7. The behavioral
    // guarantees (each emit fires on the correct branch, in the correct order) live in
    // the per-emit tests below; this guard just catches an accidental add/drop of a site.
    it("emits exactly seven Hooks.callAll sites (one pre, one post, three roll types with damage emitting twice, one apply-damage)", () => {
        const matches = CHAT_JS.match(/Hooks\.callAll/g) ?? [];
        expect(matches.length).toBe(7);
    });

    it("emits preRenderChatMessageContent once, at the top of _injectContent", () => {
        const body = extractFunctionBody(CHAT_JS, "async function _injectContent(message, type, html)");
        const calls = body.match(/Hooks\.callAll\(`\$\{MODULE_SHORT\}\.preRenderChatMessageContent`/g) ?? [];
        expect(calls.length).toBe(1);
        // Must precede the destructive removes — assert it comes before any html.find().remove() call.
        const callIdx = body.indexOf("preRenderChatMessageContent");
        const firstRemoveIdx = body.search(/html\.find\([^)]+\)\.remove\(\)/);
        expect(callIdx).toBeGreaterThan(-1);
        expect(firstRemoveIdx === -1 || callIdx < firstRemoveIdx).toBe(true);
    });

    it("emits renderChatMessageContent once, after _setupCardListeners", () => {
        const body = extractFunctionBody(CHAT_JS, "async function _injectContent(message, type, html)");
        const calls = body.match(/Hooks\.callAll\(`\$\{MODULE_SHORT\}\.renderChatMessageContent`/g) ?? [];
        expect(calls.length).toBe(1);
        const setupIdx = body.indexOf("_setupCardListeners(message, html)");
        const callIdx = body.indexOf("renderChatMessageContent");
        expect(setupIdx).toBeGreaterThan(-1);
        expect(callIdx).toBeGreaterThan(setupIdx);
    });

    it("emits renderRoll inside _injectAttackRoll with ROLL_TYPE.ATTACK", () => {
        const body = extractFunctionBody(CHAT_JS, "async function _injectAttackRoll(message, html");
        const calls = body.match(/Hooks\.callAll\(`\$\{MODULE_SHORT\}\.renderRoll`[^)]*ROLL_TYPE\.ATTACK/g) ?? [];
        expect(calls.length).toBe(1);
    });

    it("emits renderRoll inside _injectFormulaRoll with ROLL_TYPE.FORMULA", () => {
        const body = extractFunctionBody(CHAT_JS, "async function _injectFormulaRoll(message, html");
        const calls = body.match(/Hooks\.callAll\(`\$\{MODULE_SHORT\}\.renderRoll`[^)]*ROLL_TYPE\.FORMULA/g) ?? [];
        expect(calls.length).toBe(1);
    });

    it("emits renderRoll TWICE inside _injectDamageRoll — once for native-mode early return, once for the rsr-mode tail", () => {
        const body = extractFunctionBody(CHAT_JS, "async function _injectDamageRoll(message, html");
        const calls = body.match(/Hooks\.callAll\(`\$\{MODULE_SHORT\}\.renderRoll`[^)]*ROLL_TYPE\.DAMAGE/g) ?? [];
        expect(calls.length).toBe(2);

        // Verify the native-mode emit comes BEFORE the `return;` that exits the native branch.
        // Brace-match the `if (mode === "native") { … }` block so we don't accidentally
        // capture only up to the nested `if (... versatile) { ... }` block's closing brace.
        const ifStart = body.indexOf('if (mode === "native")');
        expect(ifStart).toBeGreaterThan(-1);
        let braceStart = body.indexOf("{", ifStart);
        let depth = 0;
        let braceEnd = -1;
        for (let i = braceStart; i < body.length; i++) {
            if (body[i] === "{") depth++;
            else if (body[i] === "}") {
                depth--;
                if (depth === 0) { braceEnd = i; break; }
            }
        }
        expect(braceEnd).toBeGreaterThan(braceStart);
        const nativeBranch = body.slice(braceStart, braceEnd + 1);
        const emitIdx = nativeBranch.indexOf("Hooks.callAll");
        const returnIdx = nativeBranch.indexOf("return;");
        expect(emitIdx).toBeGreaterThan(-1);
        expect(returnIdx).toBeGreaterThan(-1);
        expect(emitIdx).toBeLessThan(returnIdx);
    });

    it("emits renderApplyDamageButtons once at the end of _injectApplyDamageButtons", () => {
        const body = extractFunctionBody(CHAT_JS, "async function _injectApplyDamageButtons(message, html)");
        const calls = body.match(/Hooks\.callAll\(`\$\{MODULE_SHORT\}\.renderApplyDamageButtons`/g) ?? [];
        expect(calls.length).toBe(1);
    });

    it("uses the MODULE_SHORT template-literal namespace for every emit (so hook names track the module ID)", () => {
        const totalCalls = (CHAT_JS.match(/Hooks\.callAll\(/g) ?? []).length;
        const namespacedCalls = (CHAT_JS.match(/Hooks\.callAll\(`\$\{MODULE_SHORT\}\./g) ?? []).length;
        expect(namespacedCalls).toBe(totalCalls);
    });

    it("does NOT emit any hook from updateChatMessage (re-renders re-fire the chain via the render hook; double-emit would break idempotency contracts)", () => {
        const body = extractFunctionBody(CHAT_JS, "static async updateChatMessage(message, update = {}, context = {})");
        const calls = body.match(/Hooks\.callAll/g) ?? [];
        expect(calls.length).toBe(0);
    });

    it("passes contentHtml (the outer message-content node) to renderRoll — not the insertion target — so consumers can query sibling card content", () => {
        // The hook's documented `html` arg is the message content node, NOT the
        // .card-buttons / .dnd5e2.chat-card insertion target. Each inject function
        // accepts a `contentHtml` option (defaulting to its `html` arg) and forwards
        // it to the hook. _injectContent passes its own outer html via that option
        // so listeners get the full card, not the narrow insertion slot.
        const sigs = [
            "async function _injectAttackRoll(message, html",
            "async function _injectFormulaRoll(message, html",
            "async function _injectDamageRoll(message, html",
        ];
        for (const sig of sigs) {
            // Function signature must destructure { contentHtml = html } so callers
            // can override and consumers see the outer content node.
            const sigStart = CHAT_JS.indexOf(sig);
            expect(sigStart).toBeGreaterThan(-1);
            const sigLine = CHAT_JS.slice(sigStart, CHAT_JS.indexOf("\n", sigStart));
            expect(sigLine).toMatch(/contentHtml\s*=\s*html/);

            const body = extractFunctionBody(CHAT_JS, sig);
            // All renderRoll emits inside the function pass contentHtml as the 2nd
            // positional arg (after message), not `html`.
            const emits = body.match(/Hooks\.callAll\(`\$\{MODULE_SHORT\}\.renderRoll`[^;]*?;/g) ?? [];
            expect(emits.length).toBeGreaterThan(0);
            for (const emit of emits) {
                expect(emit).toMatch(/message,\s*contentHtml,\s*ROLL_TYPE\./);
            }
        }
        // _injectContent's call sites must thread its own `html` through.
        const injectContent = extractFunctionBody(CHAT_JS, "async function _injectContent(message, type, html)");
        expect(injectContent).toMatch(/_injectAttackRoll\([^)]*contentHtml:\s*html/);
        expect(injectContent).toMatch(/_injectDamageRoll\([^)]*contentHtml:\s*html/);
        expect(injectContent).toMatch(/_injectFormulaRoll\([^)]*contentHtml:\s*html/);
    });

    it("rescues dnd5e .supplement elements from doomed chat-cards BEFORE the strip — preserves mastery anchors, damage-on-save notes, and legendary-resistance flags for standalone attack-roll cards", () => {
        // Regression for #13. dnd5e's _enrichAttackTargets appends a <p class="supplement">
        // (mastery anchor + others) to .dnd5e2.chat-card. For standalone attack-roll cards
        // (no .activation-card / .usage-card class), RSR's strip would remove the supplement
        // along with the card. The rescue must detach .supplement OUT of the doomed cards
        // before remove() runs.
        const body = extractFunctionBody(CHAT_JS, "async function _injectContent(message, type, html)");

        // Locate the strip block — the assignment that captures doomed cards.
        const doomedIdx = body.search(/const\s+doomed\s*=\s*html\.find\(\s*['"`]\.dnd5e2\.chat-card['"`]\s*\)\.not\(/);
        expect(doomedIdx).toBeGreaterThan(-1);

        // The detach + appendTo must happen on `doomed` and precede `doomed.remove()`.
        const detachIdx = body.indexOf("doomed.find('.supplement').appendTo(html)", doomedIdx);
        const removeIdx = body.indexOf("doomed.remove()", doomedIdx);
        expect(detachIdx).toBeGreaterThan(doomedIdx);
        expect(removeIdx).toBeGreaterThan(detachIdx);
    });

    it("snapshots child roll supplements onto the parent before deleting the child message", () => {
        // Regression for #13 quick-roll activity cards. The attack roll message can carry
        // the native dnd5e mastery supplement, then RSR merges its roll into the parent
        // activity card and deletes the child before the normal supplement placement runs.
        const body = extractFunctionBody(CHAT_JS, "async function _injectContent(message, type, html)");
        const mergeIdx = body.indexOf("if (parent && parent.flags[MODULE_SHORT] && message.isAuthor)");
        const storeIdx = body.indexOf("_storeSupplementsForMerge(parent, type, html)", mergeIdx);
        const deleteIdx = body.indexOf("message.delete()", mergeIdx);

        expect(mergeIdx).toBeGreaterThan(-1);
        expect(storeIdx).toBeGreaterThan(mergeIdx);
        expect(deleteIdx).toBeGreaterThan(storeIdx);
    });

    it("stores supplement HTML under flags.rsreforged.supplements[type] without parsing mastery text", () => {
        const storeBody = extractFunctionBody(CHAT_JS, "function _storeSupplementsForMerge(parent, type, html)");
        expect(storeBody).toMatch(/parent\.flags\[MODULE_SHORT\]\.supplements\s*\?\?=/);
        expect(storeBody).toMatch(/parent\.flags\[MODULE_SHORT\]\.supplements\[type\]\s*=\s*_snapshotSupplements\(html\)/);

        const snapshotBody = extractFunctionBody(CHAT_JS, "function _snapshotSupplements(html)");
        expect(snapshotBody).toMatch(/html\.find\(\s*['"`]\.supplement['"`]\s*\)/);
        expect(snapshotBody).toMatch(/element\.outerHTML/);
    });

    it("places supplements into .rsr-section-attack with .rsr-section-damage and .rsr-section-formula as fallbacks — non-attack activity cards (save-only damage, formula-only) get supplements placed and styled, not orphaned at html root", () => {
        // Regression for the case where damage-on-save or legendary-resistance
        // supplements ride a SaveActivity that has renderDamage but no renderAttack.
        // Pre-fix the placement was inside `if (renderAttack)` so those activities
        // had their supplements detached but never re-placed under any RSR section.
        const body = extractFunctionBody(CHAT_JS, "async function _injectContent(message, type, html)");
        expect(body).toMatch(/supplementHost\s*=\s*html\.find\(\s*['"`]\.rsr-section-attack['"`]\s*\)/);
        expect(body).toMatch(/supplementHost\s*=\s*html\.find\(\s*['"`]\.rsr-section-damage['"`]\s*\)/);
        expect(body).toMatch(/supplementHost\s*=\s*html\.find\(\s*['"`]\.rsr-section-formula['"`]\s*\)/);
    });

    it("restores stored supplements under the matching RSR section and marks restored nodes for idempotent rerenders", () => {
        const restoreBody = extractFunctionBody(CHAT_JS, "function _restoreStoredSupplements(message, html)");

        expect(restoreBody).toMatch(/html\.find\(\s*['"`]\[data-rsr-restored-supplement\],\s*\[data-rsr-generated-mastery\]['"`]\s*\)\.remove\(\)/);
        expect(restoreBody).toMatch(/\[ROLL_TYPE\.ATTACK\]:\s*html\.find\(\s*['"`]\.rsr-section-attack['"`]\s*\)/);
        expect(restoreBody).toMatch(/\[ROLL_TYPE\.DAMAGE\]:\s*html\.find\(\s*['"`]\.rsr-section-damage['"`]\s*\)/);
        expect(restoreBody).toMatch(/restored\.attr\(\s*['"`]data-rsr-restored-supplement['"`],\s*type\s*\)/);
        expect(restoreBody).toMatch(/restored\.addClass\(\s*['"`]rsr-supplement['"`]\s*\)/);
        expect(restoreBody).toMatch(/host\.append\(restored\)/);
    });

    it("restores stored supplements before the existing live supplement placement pass", () => {
        const body = extractFunctionBody(CHAT_JS, "async function _injectContent(message, type, html)");
        const restoreIdx = body.indexOf("_restoreStoredSupplements(message, html)");
        const placementIdx = body.indexOf("supplementHost.append(html.find('.supplement').not(supplementHost.find('.supplement'))");

        expect(restoreIdx).toBeGreaterThan(-1);
        expect(placementIdx).toBeGreaterThan(restoreIdx);
    });

    it("excludes already-restored snapshots from the attack-preferring placement sweep so damage supplements stay in their section", () => {
        // Regression: _restoreStoredSupplements routes saved damage supplements under
        // .rsr-section-damage, but the placement sweep below prefers .rsr-section-attack.
        // Without the exclusion it would relocate the restored damage notes to the wrong host.
        const body = extractFunctionBody(CHAT_JS, "async function _injectContent(message, type, html)");
        expect(body).toMatch(/supplementHost\.append\(html\.find\('\.supplement'\)\.not\(supplementHost\.find\('\.supplement'\)\)\.not\('\[data-rsr-restored-supplement\]'\)\)/);
    });

    it("syncs ChatMessage.rolls on the manual damage-button path too, not only the initial quick roll", () => {
        // Regression: runActivityAction (manual damage button) must keep ChatMessage.rolls
        // in step with flags.rsreforged.rolls so modules reading the collection don't go stale.
        const body = extractFunctionBody(ACTIVITY_JS, "static async runActivityAction(message, action)");
        expect(body).toMatch(/const\s+serializedRolls\s*=\s*CoreUtility\.serializeRolls\(currentRolls\)/);
        expect(body).toMatch(/message\.flags\[MODULE_SHORT\]\.rolls\s*=\s*serializedRolls/);
        expect(body).toMatch(/rolls:\s*serializedRolls/);
    });

    it("generates fallback mastery supplements after live supplements have been folded into the final host", () => {
        const body = extractFunctionBody(CHAT_JS, "async function _injectContent(message, type, html)");
        const placementIdx = body.indexOf("supplementHost.append(html.find('.supplement').not(supplementHost.find('.supplement'))");
        const generatedIdx = body.indexOf("_restoreMasterySupplement(message, supplementHost)", placementIdx);

        expect(placementIdx).toBeGreaterThan(-1);
        expect(generatedIdx).toBeGreaterThan(placementIdx);
    });

    it("generates a native-style mastery action supplement when quick-roll metadata has mastery but no saved supplement", () => {
        const createBody = extractFunctionBody(CHAT_JS, "function _createMasterySupplement({ mastery, label, uuid })");
        expect(createBody).toMatch(/<p class="supplement"><\/p>/);
        expect(createBody).toMatch(/<a class="content-link"><\/a>/);
        expect(createBody).toMatch(/"data-tooltip":\s*label/);
        expect(createBody).toMatch(/"data-uuid":\s*uuid/);
        expect(createBody).not.toMatch(/wm5e-mastery-reference/);
    });

    it("uses the dnd5e mastery label when generating fallback mastery links", () => {
        const labelBody = extractFunctionBody(CHAT_JS, "function _getMasteryLabel(mastery)");
        expect(labelBody).toMatch(/CONFIG\.DND5E\?\.weaponMasteries\?\.\[mastery\]\?\.label/);
        expect(labelBody).toMatch(/CoreUtility\.localize\(label\)/);
    });

    it("can derive generated mastery links from the associated activity item, not only roll options", () => {
        const masteryBody = extractFunctionBody(CHAT_JS, "function _getRollMastery(message)");
        expect(masteryBody).toMatch(/ActivityUtility\._getActivityFromMessage\(message\)/);
        expect(masteryBody).toMatch(/activity\?\.item\?\.system\?\.mastery/);
    });

    it("does not generate a duplicate mastery supplement when an existing supplement already has the same tooltip or uuid", () => {
        const restoreBody = extractFunctionBody(CHAT_JS, "function _restoreMasterySupplement(message, host)");
        expect(restoreBody).toMatch(/host\.find\(\s*['"`]\.supplement a['"`]\s*\)\.filter/);
        expect(restoreBody).toMatch(/element\.dataset\?\.tooltip\s*===\s*label/);
        expect(restoreBody).toMatch(/element\.dataset\?\.uuid\s*===\s*uuid/);
        expect(restoreBody).toMatch(/if\s*\(existing\.length\)\s*return/);
    });

    it("does not generate fallback mastery supplements inside the stored-supplement restore helper", () => {
        const restoreBody = extractFunctionBody(CHAT_JS, "function _restoreStoredSupplements(message, html)");
        expect(restoreBody).not.toMatch(/_restoreMasterySupplement/);
    });

    it("syncs quick activity rolls onto the parent ChatMessage rolls collection for wm5e click handlers", () => {
        const body = extractFunctionBody(ACTIVITY_JS, "static async runActivityActions(message)");
        expect(body).toMatch(/const\s+serializedRolls\s*=\s*CoreUtility\.serializeRolls\(currentRolls\)/);
        expect(body).toMatch(/message\.flags\[MODULE_SHORT\]\.rolls\s*=\s*serializedRolls/);
        expect(body).toMatch(/rolls:\s*serializedRolls/);
    });

    it("copies attack mastery onto flags.dnd5e.roll for merged quick activity cards", () => {
        const body = extractFunctionBody(ACTIVITY_JS, "static async runActivityActions(message)");
        expect(body).toMatch(/message\.flags\.dnd5e\s*\?\?=/);
        expect(body).toMatch(/type:\s*ROLL_TYPE\.ATTACK/);
        expect(body).toMatch(/attackRoll\.options\?\.mastery\s*\?\s*\{\s*mastery:\s*attackRoll\.options\.mastery\s*\}/);
    });

    it("stamps flags.dnd5e.targets during child attack merge and quick-roll attack execution for wm5e", () => {
        const mergeBody = extractFunctionBody(CHAT_JS, "async function _injectContent(message, type, html)");
        expect(mergeBody).toMatch(/ActivityUtility\._syncAttackTargets\(parent,\s*message\)/);

        const activityBody = extractFunctionBody(ACTIVITY_JS, "static async runActivityActions(message)");
        expect(activityBody).toMatch(/ActivityUtility\._syncAttackTargets\(message\)/);
    });

    it("does NOT removeClass('supplement') anywhere in chat.js — downstream modules and dnd5e enrichers must continue to find .supplement after the rebuild", () => {
        // Regression for #13. The pre-fix rescue at chat.js:504 renamed
        // .supplement -> .rsr-supplement, breaking any module querying for the
        // original class. The fix is additive: keep .supplement, add .rsr-supplement
        // for RSR's own styling.
        expect(CHAT_JS).not.toMatch(/removeClass\(\s*['"`]supplement['"`]\s*\)/);
        // And the additive class must still be applied so RSR's CSS hits.
        expect(CHAT_JS).toMatch(/addClass\(\s*['"`]rsr-supplement['"`]\s*\)/);
    });

    it("renders synthetic roll dice via _renderDnd5eDiceFragment in all inject helpers — avoids item-flavor enrichment on cloned roll fragments", () => {
        expect(CHAT_JS).toMatch(/async function _renderDnd5eDiceFragment\(chatData\)/);
        const fragmentBody = extractFunctionBody(CHAT_JS, "async function _renderDnd5eDiceFragment(chatData)");
        expect(fragmentBody).toMatch(/foundry\.utils\.deepClone\(chatData\)/);
        expect(fragmentBody).toMatch(/delete prepared\.flags\.dnd5e\.item/);
        expect(fragmentBody).toMatch(/delete prepared\.flags\.dnd5e\.roll/);

        for (const signature of [
            "async function _injectAttackRoll(message, html, { contentHtml = html } = {})",
            "async function _injectFormulaRoll(message, html, { contentHtml = html } = {})",
            "async function _injectDamageRoll(message, html, { mode = \"rsr\", contentHtml = html } = {})"
        ]) {
            const body = extractFunctionBody(CHAT_JS, signature);
            expect(body).toMatch(/_renderDnd5eDiceFragment\(chatData\)/);
            expect(body).not.toMatch(/new ChatMessage5e\(chatData\)\.renderHTML\(\)/);
        }

        expect(CHAT_JS).not.toMatch(/new ChatMessage5e\(chatData\)\.renderHTML\(\)/);
    });

    it("scopes standalone damage flavor clearing to the message root — Foundry renders .flavor-text in .message-header, a sibling of .message-content", () => {
        // `html` at the clearing site is the .message-content node, so the selector
        // must climb to the .chat-message root to reach the header flavor while never
        // leaking into other messages (which a bare .parent().find() could when the
        // content fallback makes `html` the message root itself).
        const body = extractFunctionBody(CHAT_JS, "async function _injectContent(message, type, html)");
        expect(body).toMatch(/html\.closest\(['"`]\.chat-message['"`]\)/);
        expect(body).toMatch(/\.find\(['"`]\.flavor-text['"`]\)\.text\(''\)/);
        expect(body).not.toMatch(/html\.parent\(\)\.find\(['"`]\.flavor-text['"`]\)/);
        expect(body).not.toMatch(/html\.closest\(['"`]\.message-content['"`]\)\.find\(['"`]\.flavor-text['"`]\)/);
    });

    it("emits preRenderChatMessageContent BEFORE the child-merge return path — locks in the contract the wm5e worked example relies on", () => {
        // The child-merge path inside _injectContent (ATTACK / DAMAGE fall-through cases)
        // calls message.delete(); return; — at which point renderChatMessageContent and
        // renderRoll never fire for the child. The wm5e worked example in docs/INTEGRATION.md
        // depends on preRender having already fired by then so the listener can snapshot
        // the dnd5e card's mastery links. If preRender ever moves below the merge return,
        // the example silently breaks for the exact case it was written to handle.
        const body = extractFunctionBody(CHAT_JS, "async function _injectContent(message, type, html)");
        const preRenderIdx = body.indexOf("preRenderChatMessageContent");
        const mergeReturnIdx = body.search(/message\.delete\(\);\s*\n\s*return;/);
        expect(preRenderIdx).toBeGreaterThan(-1);
        expect(mergeReturnIdx).toBeGreaterThan(-1);
        expect(preRenderIdx).toBeLessThan(mergeReturnIdx);
    });
});
