import { vi } from "vitest";
import { JSDOM } from "jsdom";

let jqueryModule = null;
let sharedDom = null;

export async function setupFoundryEnv(options = {}) {
    sharedDom ??= new JSDOM("<!doctype html><html><body></body></html>");
    const dom = sharedDom;
    dom.window.document.body.innerHTML = "";
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.MutationObserver = dom.window.MutationObserver;

    jqueryModule ??= await import("jquery");
    globalThis.$ = jqueryModule.default;
    globalThis.jQuery = jqueryModule.default;

    const settings = {
        enableVanillaQuickRoll: false,
        enableActivityQuickRoll: true,
        enableAbilityQuickRoll: true,
        enableSkillQuickRoll: true,
        enableToolQuickRoll: true,
        manualDamageMode: 0,
        damageApplyMode: "rsr",
        alwaysRollMulti: false,
        enableOverlayButtons: false,
        enableHideFinalResult: false,
        hideNpcRollMode: "none",
        alwaysShowButtons: true,
        enableD20Icons: true,
        applyDamageTo: 0,
        rerollEveryone: true,
        rerollPlayers: false,
        fudgeGM: false,
        rerollSoundEnabled: true,
        rerollLogChat: true,
        ...options.settings
    };
    // Defaults for settings RSR reads from other modules' namespaces. Keyed by
    // "namespace.key" so game.settings.get("core", "rollMode") returns Foundry's real
    // default ("publicroll") rather than undefined. Override via options.foreignSettings.
    const foreignSettings = {
        "core.rollMode": "publicroll",
        ...options.foreignSettings
    };
    const registeredSettings = new Map();
    const registeredKeybindings = new Map();
    const activeModules = new Map(Object.entries(options.modules ?? {}));
    const hookCalls = [];
    const hookHandlers = new Map();
    const messages = new Map();

    class TestApplicationV2 {
        constructor(appOptions = {}) {
            Object.assign(this, appOptions);
            this.options = appOptions;
        }

        render() {
            this.rendered = true;
            return this;
        }
    }

    class TestRoll {
        constructor(formula = "1", data = {}, rollOptions = {}) {
            this.formula = formula;
            this.data = data;
            this.options = { ...rollOptions };
            this.class = this.constructor.name;
            this.terms = [];
            this.dice = [];
            this._total = Number.parseInt(formula, 10) || 0;
            this._evaluated = true;
        }

        // Real Foundry exposes `total` as a getter over `_total`, and production code
        // (reroll.js, bonus.js, chat.js) writes `roll._total = roll._evaluateTotal()`
        // after mutating die results expecting `roll.total` to follow. Model that
        // relationship faithfully so a regression that fails to fold a rerolled/fudged
        // die back into the total is actually caught instead of masked by a frozen value.
        get total() {
            return this._total;
        }

        set total(value) {
            this._total = value;
        }

        async evaluate() {
            this._evaluated = true;
            return this;
        }

        _evaluateTotal() {
            if (this.terms.length) {
                return this.terms.reduce((sum, term) => sum + (term.total ?? 0), 0);
            }
            return this._total;
        }

        resetFormula() {}

        toJSON() {
            return {
                class: this.constructor.name,
                formula: this.formula,
                total: this.total,
                options: this.options,
                terms: this.terms,
                dice: this.dice
            };
        }

        async toMessage() {
            return { type: "roll", rolls: [this], flags: {} };
        }

        static fromData(data) {
            const RollClass = rollClassForName(data?.class);
            const roll = new RollClass(data?.formula ?? "1", {}, data?.options ?? {});
            roll.total = data?.total ?? roll.total;
            roll._total = roll.total;
            roll.terms = data?.terms ?? roll.terms;
            roll.dice = data?.dice ?? roll.dice;
            return roll;
        }

        static fromTerms(terms) {
            const roll = new this("0");
            roll.terms = terms;
            roll.dice = terms.filter((term) => term.faces);
            roll.total = terms.reduce((total, term) => total + (term.total ?? sumResults(term.results)), 0);
            roll._total = roll.total;
            return roll;
        }
    }

    class D20Roll extends TestRoll {
        static ADV_MODE = { NORMAL: 0, ADVANTAGE: 1, DISADVANTAGE: 2 };

        get d20() {
            return this.terms.find((term) => term.faces === 20);
        }

        get isCritical() {
            return this.d20?.isCriticalSuccess;
        }

        get isFumble() {
            return this.d20?.isCriticalFailure;
        }
    }

    class DamageRoll extends TestRoll {
        static async toMessage(rolls) {
            return { type: "roll", rolls, flags: {} };
        }
    }

    class BasicRoll extends TestRoll {}

    class TestDie {
        constructor({ number = 1, faces = 20, results = [], modifiers = [], options = {} } = {}) {
            this.number = number;
            this.faces = faces;
            this.results = results;
            this.modifiers = modifiers;
            this.options = options;
        }

        // Recompute from the live results so an in-place mutation of a result
        // (reroll/fudge) is reflected in the die total, matching real Foundry.
        get total() {
            return sumResults(this.results);
        }

        get activeResults() {
            return this.results.filter((result) => result.active !== false && result.discarded !== true);
        }

        get isCriticalSuccess() {
            if (this.faces !== 20) return false;
            const threshold = this.options.criticalSuccess ?? 20;
            return this.activeResults.some((result) => Number(result.result) >= threshold);
        }

        get isCriticalFailure() {
            if (this.faces !== 20) return false;
            const threshold = this.options.criticalFailure ?? 1;
            return this.activeResults.some((result) => Number(result.result) <= threshold);
        }

        keep(modifier) {
            this.modifiers.push(modifier);
        }

        _evaluateModifiers() {
            const keepHigh = this.modifiers.some((modifier) => modifier.includes("kh"));
            const keepLow = this.modifiers.some((modifier) => modifier.includes("kl"));
            if (!keepHigh && !keepLow) return;

            const ordered = [...this.results].sort((a, b) => keepHigh ? b.result - a.result : a.result - b.result);
            const kept = ordered[0];
            this.results.forEach((result) => {
                result.discarded = result !== kept;
                result.active = result === kept;
            });
        }
    }

    class OperatorTerm {
        constructor({ operator }) {
            this.operator = operator;
            this.total = 0;
        }
    }

    class TestChatMessage {
        constructor(data = {}) {
            Object.assign(this, data);
            this.flags ??= {};
            this.rolls ??= data.rolls ?? [];
            this.type ??= data.type ?? "roll";
            this.id ??= data.id ?? `message-${messages.size + 1}`;
            // Persisted document source. A real ChatMessage rebuilds its live `flags`
            // from `_source` whenever updateSource() runs, so in-memory-only flag writes
            // that were never persisted to source are discarded at that point.
            this._source = {
                flags: foundry.utils.deepClone(this.flags),
                rolls: this.rolls.map((roll) => roll?.toJSON ? roll.toJSON() : foundry.utils.deepClone(roll))
            };
            messages.set(this.id, this);
        }

        toObject() {
            return foundry.utils.deepClone(this._source);
        }

        async renderHTML() {
            const rollHtml = this.rolls.map((roll) => renderRollHtml(roll)).join("");
            // dnd5e 5.3.1+ injects a native damage-application tray into any message
            // whose rolls contain DamageRolls (issue #37). Mirror that so synthetic
            // fragments rendered through this class carry the tray too.
            const tray = this.rolls.some((roll) => roll?.class === "DamageRoll")
                ? `<damage-application></damage-application>`
                : "";
            return `<article class="chat-message" data-message-id="${this.id}"><div class="message-content"><div class="dnd5e2 chat-card">${rollHtml}</div>${tray}</div></article>`;
        }

        async update(update = {}) {
            Object.assign(this, update);
            this.updatedWith = update;
            return this;
        }

        // Foundry applies an in-memory source update with flattened (dot-notation) keys
        // and no DB write / re-render, then re-initialises the live document from that
        // source. Mirror both halves: write changes into `_source`, then rebuild the live
        // `flags` from `_source` so in-memory-only flag writes (never persisted) are
        // dropped — exactly as a real ChatMessage behaves. Non-flag keys (e.g. rolls) are
        // applied to the live document in place so live Roll instances survive intact.
        // Does not touch `updatedWith` (which tracks persisted update() calls).
        updateSource(changes = {}) {
            for (const [key, value] of Object.entries(changes)) {
                const path = key.includes(".") ? key.split(".") : [key];
                let src = this._source;
                for (let i = 0; i < path.length - 1; i++) {
                    src[path[i]] ??= {};
                    src = src[path[i]];
                }
                src[path[path.length - 1]] = value;
            }

            // Re-initialise live flags from the persisted source (drops unpersisted writes).
            this.flags = foundry.utils.deepClone(this._source.flags);

            // Apply non-flag changes to the live document directly.
            for (const [key, value] of Object.entries(changes)) {
                if (key === "flags" || key.startsWith("flags.")) continue;
                const path = key.includes(".") ? key.split(".") : [key];
                let target = this;
                for (let i = 0; i < path.length - 1; i++) {
                    target[path[i]] ??= {};
                    target = target[path[i]];
                }
                target[path[path.length - 1]] = value;
            }
            return changes;
        }

        delete() {
            this.deleted = true;
        }

        static getSpeaker({ user } = {}) {
            return { user: user?.id };
        }

        static async create(data) {
            TestChatMessage.created.push(data);
            return data;
        }

        static getWhisperRecipients() {
            return [{ id: "gm" }];
        }
    }
    TestChatMessage.created = [];

    function rollClassForName(name) {
        if (name === "D20Roll") return D20Roll;
        if (name === "DamageRoll") return DamageRoll;
        if (name === "BasicRoll") return BasicRoll;
        return TestRoll;
    }

    function sumResults(results = []) {
        return results.reduce((total, result) => total + (result.active === false ? 0 : Number(result.result ?? 0)), 0);
    }

    function renderRollHtml(roll) {
        const total = roll.total ?? roll._total ?? 0;
        const damageConfig = CONFIG.DND5E.damageTypes[roll.options?.type] ?? CONFIG.DND5E.healingTypes[roll.options?.type];
        const damageTotal = damageConfig
            ? `<div class="total"><img src="${damageConfig.icon}" alt="${damageConfig.label}"><span class="label">${damageConfig.labelShort ?? damageConfig.label}</span><span class="value">${total}</span></div>`
            : `<div class="total"><span class="label">${roll.options?.type ?? ""}</span><span class="value">${total}</span></div>`;
        const dice = roll.dice?.length
            ? roll.dice.map((die) => {
                const rolls = die.results.map((result) => `<span class="roll die">${result.result}</span>`).join("");
                return `<section class="tooltip-part"><div class="dice">${rolls}${damageTotal}</div></section>`;
            }).join("")
            : `<section class="tooltip-part"><div class="dice"><span class="roll die">${total}</span>${damageTotal}</div></section>`;

        return `<div class="dice-roll"><div class="dice-result"><div class="dice-formula">${roll.formula}</div><div class="dice-total">${total}</div><div class="dice-tooltip"><div class="dice-rolls">${dice}</div></div></div></div>`;
    }

    globalThis.Roll = TestRoll;
    globalThis.ChatMessage = TestChatMessage;
    globalThis.CONFIG = {
        ChatMessage: { documentClass: TestChatMessage },
        Dice: {
            D20Roll,
            DamageRoll,
            BasicRoll,
            terms: { d: TestDie }
        },
        DND5E: {
            damageTypes: {
                slashing: {
                    label: "Slashing",
                    labelShort: "Slashing",
                    icon: "systems/dnd5e/icons/svg/damage/slashing.svg"
                }
            },
            healingTypes: {
                healing: {
                    label: "Healing",
                    labelShort: "Healing",
                    icon: "systems/dnd5e/icons/svg/damage/healing.svg"
                },
                temphp: {
                    label: "Temporary",
                    labelShort: "Temporary",
                    icon: "systems/dnd5e/icons/svg/damage/temphp.svg"
                },
                maximum: {
                    label: "Maximum",
                    labelShort: "Maximum",
                    icon: "systems/dnd5e/icons/svg/damage/maxhp.svg"
                }
            },
            aggregateDamageDisplay: true
        },
        sounds: { dice: "dice.wav" },
        ActiveEffect: { documentClass: { _manageConcentration: vi.fn() } }
    };

    globalThis.foundry = {
        applications: {
            api: {
                ApplicationV2: TestApplicationV2,
                DialogV2: { prompt: vi.fn() }
            },
            handlebars: {
                renderTemplate: vi.fn(async (template, data = {}) => renderTemplate(template, data))
            }
        },
        audio: { AudioHelper: { play: vi.fn() } },
        dice: { terms: { Die: TestDie, OperatorTerm } },
        helpers: {
            interaction: {
                KeyboardManager: {
                    MODIFIER_KEYS: { CONTROL: "Control", SHIFT: "Shift", ALT: "Alt" },
                    MODIFIER_CODES: {
                        Control: ["ControlLeft", "ControlRight", "MetaLeft", "MetaRight"],
                        Shift: ["ShiftLeft", "ShiftRight"],
                        Alt: ["AltLeft", "AltRight"]
                    }
                }
            }
        },
        utils: {
            deepClone: (value) => structuredClone(value),
            duplicate: (value) => structuredClone(value),
            mergeObject: (target, source) => ({ ...target, ...source }),
            // Mirrors Foundry's isEmpty: nullish, or an empty string/array/Set/Map/object.
            // Primitives are never "empty".
            isEmpty: (value) => {
                if (value === undefined || value === null) return true;
                if (typeof value === "string" || Array.isArray(value)) return value.length === 0;
                if (value instanceof Set || value instanceof Map) return value.size === 0;
                if (typeof value === "object") return Object.keys(value).length === 0;
                return false;
            },
            // Mirrors Foundry's isNewerVersion: dot-separated numeric comparison,
            // missing parts treated as 0; returns true when v1 > v0.
            isNewerVersion: (v1, v0) => {
                const parts = (v) => String(v).split(".").map((p) => parseInt(p, 10) || 0);
                const [a, b] = [parts(v1), parts(v0)];
                for (let i = 0; i < Math.max(a.length, b.length); i++) {
                    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
                }
                return false;
            },
            getProperty: (object, path) => path.split(".").reduce((value, key) => value?.[key], object),
            escapeHTML: (value) => String(value)
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
                .replaceAll('"', "&quot;")
                .replaceAll("'", "&#39;")
        }
    };
    globalThis.duplicate = globalThis.foundry.utils.duplicate;

    globalThis.CONST = {
        KEYBINDING_PRECEDENCE: { NORMAL: 0 }
    };

    globalThis.Hooks = {
        on: vi.fn((name, handler) => hookHandlers.set(name, handler)),
        once: vi.fn((name, handler) => hookHandlers.set(name, handler)),
        callAll: vi.fn((name, ...args) => hookCalls.push({ name, args }))
    };

    globalThis.game = {
        user: {
            id: "user-1",
            name: "Player <One>",
            isGM: false,
            targets: new Set(options.targets ?? [])
        },
        users: new Map(),
        keyboard: { downKeys: new Set(options.downKeys ?? []) },
        keybindings: {
            // Real Foundry returns [] for an action that was never registered. Defaulting
            // to a Shift binding would make every unregistered action look Shift-bound and
            // hide wrong-action / wrong-namespace lookups, so mirror the empty default.
            get: vi.fn((namespace, action) => registeredKeybindings.get(`${namespace}.${action}`) ?? []),
            register: vi.fn((namespace, action, config) => registeredKeybindings.set(`${namespace}.${action}`, config.editable ?? []))
        },
        settings: {
            // RSR settings live under the module namespace and are exposed flat via the
            // `settings` object tests mutate. Foreign namespaces (core/dnd5e) must NOT
            // resolve against that flat store — returning the RSR value for an unrelated
            // key masks bugs — so route them through realistic defaults instead.
            get: vi.fn((namespace, key) => {
                if (namespace === "rsreforged") return settings[key];
                return foreignSettings[`${namespace}.${key}`];
            }),
            register: vi.fn((namespace, key, config) => {
                registeredSettings.set(key, config);
                if (namespace === "rsreforged") settings[key] ??= config.default;
            }),
            set: vi.fn((namespace, key, value) => {
                if (namespace === "rsreforged") settings[key] = value;
            })
        },
        modules: {
            // options.modules entries are either booleans (active flag) or objects
            // ({ active, version }) when a test needs to pin a module version.
            get: vi.fn((name) => {
                const entry = activeModules.get(name);
                if (entry && typeof entry === "object") {
                    return { active: entry.active ?? true, version: entry.version ?? "test" };
                }
                return { active: entry ?? false, version: "test" };
            })
        },
        messages,
        actors: new Map(),
        scenes: new Map(),
        combats: [],
        combat: null,
        dice3d: null,
        i18n: {
            localize: vi.fn((key) => key),
            format: vi.fn((key, data) => `${key}:${JSON.stringify(data)}`)
        }
    };

    globalThis.canvas = {
        tokens: { controlled: options.controlled ?? [] },
        hud: { token: { _displayState: 0, render: vi.fn() } }
    };

    globalThis.ui = {
        chat: { scrollBottom: vi.fn(), isAtBottom: true },
        notifications: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        }
    };

    globalThis.fromUuidSync = vi.fn((uuid) => options.uuids?.[uuid] ?? null);

    return {
        dom,
        settings,
        registeredSettings,
        registeredKeybindings,
        hookCalls,
        hookHandlers,
        messages,
        classes: { TestRoll, D20Roll, DamageRoll, BasicRoll, TestDie, OperatorTerm, TestChatMessage }
    };
}

export function makeRoll(RollClass, { formula = "1", total = 1, faces = null, results = [], type = null, properties = [], dieOptions = {}, rollOptions = {} } = {}) {
    const roll = new RollClass(formula);
    roll.total = total;
    roll._total = total;
    if (type) roll.options.type = type;
    if (properties.length) roll.options.properties = properties;
    Object.assign(roll.options, rollOptions);
    if (faces) {
        const die = new foundry.dice.terms.Die({
            number: results.length || 1,
            faces,
            results: results.map((result) => typeof result === "number"
                ? { result, active: true, discarded: false }
                : { active: true, discarded: false, ...result }),
            modifiers: [],
            options: dieOptions
        });
        roll.dice = [die];
        roll.terms = [die];
    }
    return roll;
}

function renderTemplate(template, data = {}) {
    if (template.endsWith("rsr-section.html")) {
        return `<section class="card-header description ${data.critical ? "critical" : ""} ${data.section ?? ""}"><div class="rsr-header"><div class="rsr-title">${data.icon ?? ""}${data.title ?? ""}</div>${data.subtitle ? `<div class="rsr-subtitle">${data.subtitle}</div>` : ""}</div></section>`;
    }

    if (template.endsWith("rsr-button.html")) {
        return `<button type="button" data-action="rsr-${data.action}">${data.icon ?? ""}${data.title ?? ""}</button>`;
    }

    if (template.endsWith("rsr-damage-buttons.html")) {
        return `<div class="rsr-damage-buttons"><button data-action="rsr-apply-damage" data-multiplier="-1"></button><button data-action="rsr-apply-temp" data-multiplier="1"></button><button data-action="rsr-apply-damage" data-multiplier="1"></button><div class="rsr-indicator"></div></div>`;
    }

    if (template.endsWith("rsr-multiroll.html")) {
        return `<span class="rsr-multiroll">${data.key ?? ""}</span>`;
    }

    if (template.endsWith("rsr-damage.html")) {
        return `<span class="rsr-damage-total">${data.total ?? ""}</span>`;
    }

    if (template.endsWith("rsr-overlay-multiroll.html")) {
        return `<div class="rsr-overlay-multiroll"><div></div></div>`;
    }

    if (template.endsWith("rsr-overlay-crit.html")) {
        return `<div class="rsr-overlay-crit"><div></div></div>`;
    }

    return "";
}
