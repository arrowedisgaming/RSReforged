const ORIGINAL_BASE_ROLLS = new WeakMap();

/**
 * Build a native critical DamageRoll while retaining every result already rolled
 * by the base expression. Native construction owns critical term generation; this
 * function only maps base dice onto the original members of the emitted structure
 * before evaluating its additions.
 *
 * @param {DamageRoll} roll Evaluated native damage roll.
 * @param {boolean} isCritical Whether the returned roll should be critical.
 * @returns {Promise<DamageRoll>} The promoted roll, stored base roll, or unchanged base.
 */
export async function setNativeCritical(roll, isCritical) {
    if (!roll || typeof roll !== "object") {
        throw new Error("Cannot safely set critical damage: an evaluated damage roll is required");
    }

    const currentState = roll.isCritical === true || roll.options?.isCritical === true;
    if (isCritical === currentState) return roll;

    if (!isCritical) {
        const base = ORIGINAL_BASE_ROLLS.get(roll);
        if (base) return base;
        const snapshot = roll.options?.rsreforgedCriticalBase;
        if (snapshot) {
            const RollClass = roll.constructor;
            if (typeof RollClass?.fromData !== "function") {
                throw new Error("Cannot safely remove critical damage: the native roll deserializer is unavailable");
            }
            return RollClass.fromData(_clone(snapshot));
        }
        throw new Error("Cannot safely remove critical damage: the original base roll is unavailable");
    }

    const formula = roll._formula ?? roll.formula ?? "unknown formula";
    try {
        const baseSnapshot = _snapshotBaseRoll(roll);
        const RollClass = roll.constructor;
        if (typeof RollClass !== "function") throw new Error("the native roll constructor is unavailable");

        const options = _clone(roll.options ?? {});
        delete options.configured;
        delete options.preprocessed;
        options.isCritical = true;

        // Constructing DamageRoll is the public dnd5e configuration boundary. Its
        // constructor preprocesses and configures the critical expression using the
        // system's active rules and options; no private configureDamage method is used.
        const criticalRoll = new RollClass(formula, roll.data ?? {}, options);
        await _preserveBaseDice(roll, criticalRoll);
        _assertEvaluableTree(criticalRoll);
        await criticalRoll.evaluate({ allowInteractive: false });

        criticalRoll.options.rsreforgedCriticalBase = baseSnapshot;
        ORIGINAL_BASE_ROLLS.set(criticalRoll, roll);
        return criticalRoll;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot safely set critical damage for "${formula}": ${reason}`, { cause: error });
    }
}

function _snapshotBaseRoll(roll) {
    if (typeof roll.toJSON !== "function") throw new Error("the base roll cannot be serialized");
    const snapshot = _clone(roll.toJSON());
    snapshot.options ??= {};
    delete snapshot.options.rsreforgedCriticalBase;
    return snapshot;
}

async function _preserveBaseDice(baseRoll, criticalRoll) {
    const baseDice = _walkDice(baseRoll);
    const criticalDice = _walkDice(criticalRoll);
    const critical = criticalRoll.options?.critical ?? {};
    let cursor = 0;

    for (let baseIndex = 0; baseIndex < baseDice.length; baseIndex++) {
        const baseEntry = baseDice[baseIndex];
        let matchIndex = -1;
        for (let index = cursor; index < criticalDice.length; index++) {
            if (_canRetainResults(baseEntry.term, criticalDice[index].term)) {
                matchIndex = index;
                break;
            }
        }

        if (matchIndex < 0) throw new Error(`cannot map base die ${baseIndex + 1} into the native critical expression`);

        const targetEntry = criticalDice[matchIndex];
        const target = targetEntry.term;
        target.results = _clone(baseEntry.term.results);

        const baseCount = Math.abs(_resolvedNumber(baseEntry.term));
        const targetCount = Math.abs(_resolvedNumber(target));
        const additions = targetCount - baseCount;
        if (additions > 0) {
            if (typeof target.roll !== "function") {
                throw new Error(`native critical die ${baseIndex + 1} cannot evaluate additions independently`);
            }
            for (let index = 0; index < additions; index++) await target.roll({});
        }
        target._evaluated = true;

        cursor = matchIndex + 1;

        // A modified top-level die is emitted as the retained original followed
        // by its native clones. Advance over that known group so a later identical
        // base term cannot be confused with an added clone. Nested complex terms
        // are grouped by their parenthetical wrapper and retain depth-first order.
        if (baseEntry.path.length === 1 && baseEntry.term.modifiers?.length && !critical.powerfulCritical) {
            const randomCount = baseEntry.term._number && typeof baseEntry.term._number === "object"
                && baseEntry.term._number.isDeterministic === false;
            if (!randomCount) {
                const multiplier = Number.isFinite(critical.multiplier) ? critical.multiplier : 2;
                const bonusDice = baseIndex === 0 && Number.isFinite(critical.bonusDice) ? critical.bonusDice : 0;
                const copies = Math.max(0, multiplier - 1) + bonusDice;
                const end = cursor + copies;
                if (end > criticalDice.length) {
                    throw new Error(`native critical clone group for base die ${baseIndex + 1} is incomplete`);
                }
                for (let index = cursor; index < end; index++) {
                    if (!_sameDieShape(baseEntry.term, criticalDice[index].term)) {
                        throw new Error(`native critical clone group for base die ${baseIndex + 1} is ambiguous`);
                    }
                }
                cursor = end;
            }
        }
    }
}

function _walkDice(roll) {
    const entries = [];
    const visit = (terms, prefix) => {
        for (let index = 0; index < (terms ?? []).length; index++) {
            const term = terms[index];
            const path = [...prefix, index];
            if (_isDie(term)) entries.push({ path, term });
            else if (term?.roll?.terms) visit(term.roll.terms, [...path, "roll"]);
            else if (Array.isArray(term?.terms)) visit(term.terms, [...path, "terms"]);
        }
    };
    visit(roll?.terms, []);
    return entries;
}

function _canRetainResults(base, target) {
    if (!_sameDieShape(base, target)) return false;

    const baseCount = Math.abs(_resolvedNumber(base));
    const targetCount = Math.abs(_resolvedNumber(target));
    if (!Number.isFinite(baseCount) || !Number.isFinite(targetCount)) return false;
    if (targetCount < baseCount) return false;

    // Let an altered unmodified die grow around its result prefix. Applying a
    // modifier again to a partly evaluated result list could change the base
    // keep/reroll state, so modified terms must retain their original count.
    if (targetCount > baseCount && base.modifiers?.length) return false;
    return true;
}

function _sameDieShape(base, target) {
    return _isDie(base)
        && _isDie(target)
        && _termClass(base) === _termClass(target)
        && _resolvedFaces(base) === _resolvedFaces(target)
        && _sameArray(base.modifiers, target.modifiers);
}

function _isDie(term) {
    return Array.isArray(term?.results) && term?.faces !== undefined;
}

function _termClass(term) {
    return term?.constructor?.name ?? term?.class ?? null;
}

function _resolvedNumber(term) {
    return typeof term?.number === "number" ? term.number : NaN;
}

function _resolvedFaces(term) {
    return typeof term?.faces === "number" ? term.faces : term?.faces;
}

function _sameArray(left = [], right = []) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function _assertEvaluableTree(roll) {
    const visit = (terms) => {
        for (const term of terms ?? []) {
            if (!term?.roll?.terms) continue;
            const hasPendingDice = _walkDice(term.roll).some(({ term: die }) => !die._evaluated);
            if (term._evaluated && hasPendingDice) {
                throw new Error("native critical expression contains an immutable wrapper around unevaluated additions");
            }
            visit(term.roll.terms);
        }
    };
    visit(roll?.terms);
}

function _clone(value) {
    if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}
