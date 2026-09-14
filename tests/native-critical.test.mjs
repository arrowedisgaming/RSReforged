import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const capture = JSON.parse(readFileSync(new URL("./fixtures/dnd5e-6/native-6.0.1.json", import.meta.url), "utf8"));
const capturedPairs = new Map(capture.pairs.map(pair => [pair.formula, pair]));

let rolledValues;
let rollCount;

class FakeTerm {
    constructor(options = {}) {
        this.options = structuredClone(options);
        this._evaluated = false;
    }
}

class BasicDie extends FakeTerm {
    constructor({ number, faces, modifiers = [], results = [], options = {} }) {
        super(options);
        this.number = number;
        this.faces = faces;
        this.modifiers = [...modifiers];
        this.results = structuredClone(results);
        this._evaluated = results.length > 0;
    }

    get total() {
        return this.results.reduce((sum, result) => result.active === false ? sum : sum + result.result, 0);
    }

    async evaluate() {
        if (this._evaluated) throw new Error("BasicDie already evaluated");
        this._evaluated = true;
        while (this.results.length < this.number) {
            await this.roll();
        }
        if (this.modifiers.some(modifier => modifier.startsWith("kh"))) {
            const maximum = Math.max(...this.results.map(result => result.result));
            let kept = false;
            for (const result of this.results) {
                result.active = !kept && result.result === maximum;
                result.discarded = !result.active;
                kept ||= result.active;
            }
        }
        return this;
    }

    async roll() {
        rollCount += 1;
        const result = { result: rolledValues.shift(), active: true };
        this.results.push(result);
        return result;
    }
}

class CustomDamageDie extends BasicDie {}

class OperatorTerm extends FakeTerm {
    constructor(operator) {
        super();
        this.operator = operator;
        this._evaluated = true;
    }
}

class NumericTerm extends FakeTerm {
    constructor(number, options = {}) {
        super(options);
        this.number = number;
    }

    get total() {
        return this.number;
    }
}

class ParentheticalTerm extends FakeTerm {
    constructor(terms, options = {}) {
        super(options);
        this.roll = new FakeInnerRoll(terms);
    }

    get total() {
        return this.roll.total;
    }
}

class FakeInnerRoll {
    constructor(terms) {
        this.terms = terms;
        this._evaluated = false;
        this._total = undefined;
    }

    get total() {
        return this._total;
    }
}

class NativeDamageRoll {
    static definitions = new Map();
    static constructorCalls = [];

    constructor(formula, data = {}, options = {}) {
        this._formula = formula;
        this.data = data;
        this.options = structuredClone(options);
        this._evaluated = false;
        this._total = undefined;
        NativeDamageRoll.constructorCalls.push({ formula, data, options: structuredClone(options) });

        const definition = NativeDamageRoll.definitions.get(formula);
        if (!definition) throw new Error(`No native definition for ${formula}`);
        if (this.options.isCritical && definition.error) throw new Error(definition.error);
        this.terms = definition.build(this.options.isCritical === true);
    }

    get isCritical() {
        return this.options.isCritical === true;
    }

    get total() {
        return this._total;
    }

    get formula() {
        return this.options.isCritical
            ? NativeDamageRoll.definitions.get(this._formula).criticalFormula ?? this._formula
            : this._formula;
    }

    get dice() {
        return diceInTerms(this.terms);
    }

    async evaluate({ allowInteractive } = {}) {
        if (this._evaluated) throw new Error("NativeDamageRoll already evaluated");
        if (allowInteractive !== false) throw new Error("Critical additions must use digital evaluation");
        await evaluateTerms(this.terms);
        this._total = foldTerms(this.terms);
        this._evaluated = true;
        return this;
    }

    toJSON() {
        return {
            class: "NativeDamageRoll",
            formula: this._formula,
            options: structuredClone(this.options),
            terms: this.terms.map(serializeTerm),
            total: this.total,
            evaluated: this._evaluated
        };
    }

    static fromData(data) {
        const roll = new NativeDamageRoll(data.formula, {}, data.options);
        roll.terms = data.terms.map(deserializeTerm);
        roll._total = data.total;
        roll._evaluated = data.evaluated;
        return roll;
    }
}

function diceInTerms(terms) {
    return terms.flatMap(term => term instanceof BasicDie
        ? [term]
        : term instanceof ParentheticalTerm ? diceInTerms(term.roll.terms) : []);
}

async function evaluateTerms(terms) {
    for (const term of terms) {
        if (term instanceof ParentheticalTerm) {
            await evaluateTerms(term.roll.terms);
            term.roll._total = foldTerms(term.roll.terms);
            term.roll._evaluated = true;
            term._evaluated = true;
        } else if (!term._evaluated && typeof term.evaluate === "function") {
            await term.evaluate();
        } else {
            term._evaluated = true;
        }
    }
}

function foldTerms(terms) {
    if (!terms.length) return 0;
    let total = terms[0].total;
    for (let index = 1; index < terms.length; index += 2) {
        const operator = terms[index].operator;
        const value = terms[index + 1].total;
        if (operator === "+") total += value;
        else if (operator === "-") total -= value;
        else if (operator === "*") total *= value;
        else throw new Error(`Unsupported fake operator ${operator}`);
    }
    return total;
}

function fromCapturedTerm(term, { clearResults = false } = {}) {
    if (term.class === "BasicDie") return new BasicDie({
        ...term,
        results: clearResults ? [] : term.results
    });
    if (term.class === "OperatorTerm") return new OperatorTerm(term.operator);
    if (term.class === "NumericTerm") return new NumericTerm(term.number, term.options);
    throw new Error(`Unsupported captured term ${term.class}`);
}

function serializeTerm(term) {
    if (term instanceof BasicDie) return {
        class: term.constructor.name,
        number: term.number,
        faces: term.faces,
        modifiers: term.modifiers,
        results: term.results,
        options: term.options,
        evaluated: term._evaluated
    };
    if (term instanceof OperatorTerm) return { class: "OperatorTerm", operator: term.operator };
    if (term instanceof NumericTerm) return { class: "NumericTerm", number: term.number, options: term.options };
    if (term instanceof ParentheticalTerm) return {
        class: "ParentheticalTerm",
        terms: term.roll.terms.map(serializeTerm),
        options: term.options,
        evaluated: term._evaluated,
        total: term.total
    };
    throw new Error(`Cannot serialize ${term.constructor.name}`);
}

function deserializeTerm(term) {
    if (term.class === "BasicDie" || term.class === "CustomDamageDie") {
        const DieClass = term.class === "CustomDamageDie" ? CustomDamageDie : BasicDie;
        const die = new DieClass(term);
        die._evaluated = term.evaluated;
        return die;
    }
    if (term.class === "OperatorTerm") return new OperatorTerm(term.operator);
    if (term.class === "NumericTerm") return new NumericTerm(term.number, term.options);
    if (term.class === "ParentheticalTerm") {
        const parenthetical = new ParentheticalTerm(term.terms.map(deserializeTerm), term.options);
        parenthetical._evaluated = term.evaluated;
        parenthetical.roll._total = term.total;
        parenthetical.roll._evaluated = term.evaluated;
        return parenthetical;
    }
    throw new Error(`Cannot deserialize ${term.class}`);
}

function installCapturedPair(formula) {
    const pair = capturedPairs.get(formula);
    NativeDamageRoll.definitions.set(pair.base.formula, {
        criticalFormula: pair.critical.formula,
        build: isCritical => (isCritical ? pair.critical : pair.base).terms
            .map(term => fromCapturedTerm(term, { clearResults: isCritical }))
    });
    const base = new NativeDamageRoll(pair.base.formula, {}, pair.base.options);
    base.terms = pair.base.terms.map(term => fromCapturedTerm(term));
    base._total = pair.base.total;
    base._evaluated = true;
    return base;
}

function snapshot(roll) {
    return structuredClone({
        formula: roll.formula,
        options: roll.options,
        total: roll.total,
        terms: roll.terms.map(term => term instanceof BasicDie
            ? { class: term.constructor.name, number: term.number, faces: term.faces, modifiers: term.modifiers, results: term.results }
            : term instanceof OperatorTerm
                ? { class: "OperatorTerm", operator: term.operator }
                : { class: term.constructor.name, number: term.number })
    });
}

describe("setNativeCritical", () => {
    let setNativeCritical;

    beforeEach(async () => {
        rolledValues = [];
        rollCount = 0;
        NativeDamageRoll.definitions.clear();
        NativeDamageRoll.constructorCalls = [];
        ({ setNativeCritical } = await import("../src/utils/native-critical.js"));
    });

    it("matches the recorded simple structure while preserving the base result and evaluating one added die", async () => {
        const base = installCapturedPair("1d8+3");
        const before = snapshot(base);
        rolledValues = [4];

        const critical = await setNativeCritical(base, true);

        expect(critical.formula).toBe(capturedPairs.get("1d8+3").critical.formula);
        expect(critical.terms.map(term => term.constructor.name)).toEqual(["BasicDie", "OperatorTerm", "NumericTerm"]);
        expect(critical.dice[0].results).toEqual([{ result: 7, active: true }, { result: 4, active: true }]);
        expect(critical.total).toBe(14);
        expect(rollCount).toBe(1);
        expect(snapshot(base)).toEqual(before);
    });

    it("does not count inactive reroll history as an added critical die", async () => {
        const base = installCapturedPair("1d8+3");
        base.dice[0].results = [
            { result: 1, active: false, rerolled: true },
            { result: 7, active: true }
        ];
        rolledValues = [4];

        const critical = await setNativeCritical(base, true);

        expect(critical.dice[0].results).toEqual([
            { result: 1, active: false, rerolled: true },
            { result: 7, active: true },
            { result: 4, active: true }
        ]);
        expect(critical.total).toBe(14);
        expect(rollCount).toBe(1);
    });

    it("matches the recorded modified-die clone structure and rolls only the clone", async () => {
        const base = installCapturedPair("2d6kh1+3");
        const originalResults = structuredClone(base.dice[0].results);
        rolledValues = [5, 2];

        const critical = await setNativeCritical(base, true);

        expect(critical.formula).toBe(capturedPairs.get("2d6kh1+3").critical.formula);
        expect(critical.dice).toHaveLength(2);
        expect(critical.dice[0].results).toEqual(originalResults);
        expect(critical.dice[1].results).toEqual([
            { result: 5, active: true, discarded: false },
            { result: 2, active: false, discarded: true }
        ]);
        expect(rollCount).toBe(2);
    });

    it("preserves nominal modified dice with inactive reroll history before evaluating the native clone", async () => {
        NativeDamageRoll.definitions.set("1d8r<3 + 3", {
            criticalFormula: "1d8r<3 + 1d8r<3 + 3",
            build: isCritical => [
                new BasicDie({ number: 1, faces: 8, modifiers: ["r<3"] }),
                ...(isCritical
                    ? [new OperatorTerm("+"), new BasicDie({ number: 1, faces: 8, modifiers: ["r<3"] })]
                    : []),
                new OperatorTerm("+"),
                new NumericTerm(3)
            ]
        });
        const base = new NativeDamageRoll("1d8r<3 + 3");
        base.dice[0].results = [
            { result: 1, active: false, rerolled: true },
            { result: 6, active: true }
        ];
        base.dice[0]._evaluated = true;
        base._evaluated = true;
        base._total = 9;
        rolledValues = [7];

        const critical = await setNativeCritical(base, true);

        expect(critical.dice).toHaveLength(2);
        expect(critical.dice[0].results).toEqual(base.dice[0].results);
        expect(critical.dice[1].results).toEqual([{ result: 7, active: true }]);
        expect(critical.total).toBe(16);
        expect(rollCount).toBe(1);
    });

    it("matches the recorded subtraction structure and retains both original prefixes", async () => {
        const base = installCapturedPair("1d8-1d4");
        rolledValues = [3, 4];

        const critical = await setNativeCritical(base, true);

        expect(critical.formula).toBe(capturedPairs.get("1d8-1d4").critical.formula);
        expect(critical.dice[0].results.slice(0, 1)).toEqual(base.dice[0].results);
        expect(critical.dice[1].results.slice(0, 1)).toEqual(base.dice[1].results);
        expect(critical.total).toBe(4);
        expect(rollCount).toBe(2);
    });

    it("preserves a custom die subclass and evaluates multiplier bonus dice in the altered term", async () => {
        NativeDamageRoll.definitions.set("1dcustom + 3", {
            criticalFormula: "3dcustom + 3",
            build: isCritical => [
                new CustomDamageDie({ number: isCritical ? 3 : 1, faces: 8 }),
                new OperatorTerm("+"),
                new NumericTerm(3)
            ]
        });
        const base = new NativeDamageRoll("1dcustom + 3", {}, {
            critical: { multiplier: 2, bonusDice: 1 },
            configured: true,
            preprocessed: true
        });
        base.terms[0].results = [{ result: 7, active: true }];
        base.terms[0]._evaluated = true;
        base._evaluated = true;
        base._total = 10;
        rolledValues = [5, 6];

        const critical = await setNativeCritical(base, true);

        expect(critical.dice[0]).toBeInstanceOf(CustomDamageDie);
        expect(critical.dice[0].results.map(result => result.result)).toEqual([7, 5, 6]);
        expect(rollCount).toBe(2);
        expect(NativeDamageRoll.constructorCalls.at(-1).options).toMatchObject({
            isCritical: true,
            critical: { multiplier: 2, bonusDice: 1 }
        });
        expect(NativeDamageRoll.constructorCalls.at(-1).options).not.toHaveProperty("configured");
        expect(NativeDamageRoll.constructorCalls.at(-1).options).not.toHaveProperty("preprocessed");
    });

    it("keeps the original die and native powerful-critical numeric addition without rolling again", async () => {
        NativeDamageRoll.definitions.set("1d8 + 3", {
            criticalFormula: "1d8 + 8 + 3",
            build: isCritical => isCritical
                ? [new BasicDie({ number: 1, faces: 8 }), new OperatorTerm("+"), new NumericTerm(8), new OperatorTerm("+"), new NumericTerm(3)]
                : [new BasicDie({ number: 1, faces: 8 }), new OperatorTerm("+"), new NumericTerm(3)]
        });
        const base = new NativeDamageRoll("1d8 + 3", {}, { critical: { powerfulCritical: true } });
        base.dice[0].results = [{ result: 7, active: true }];
        base.dice[0]._evaluated = true;
        base._evaluated = true;
        base._total = 10;

        const critical = await setNativeCritical(base, true);

        expect(critical.dice[0].results).toEqual([{ result: 7, active: true }]);
        expect(critical.total).toBe(18);
        expect(rollCount).toBe(0);
    });

    it("retains base dice when native critical configuration multiplies numeric terms", async () => {
        NativeDamageRoll.definitions.set("1d8 + 3", {
            criticalFormula: "2d8 + 6",
            build: isCritical => [
                new BasicDie({ number: isCritical ? 2 : 1, faces: 8 }),
                new OperatorTerm("+"),
                new NumericTerm(isCritical ? 6 : 3)
            ]
        });
        const base = new NativeDamageRoll("1d8 + 3", {}, { critical: { multiplyNumeric: true } });
        base.dice[0].results = [{ result: 7, active: true }];
        base.dice[0]._evaluated = true;
        base._evaluated = true;
        base._total = 10;
        rolledValues = [4];

        const critical = await setNativeCritical(base, true);

        expect(critical.dice[0].results.map(result => result.result)).toEqual([7, 4]);
        expect(critical.terms[2].number).toBe(6);
        expect(critical.total).toBe(17);
    });

    it("supports a native zero-copy critical configuration without rolling again", async () => {
        NativeDamageRoll.definitions.set("2d6kh1", {
            criticalFormula: "2d6kh1",
            build: () => [new BasicDie({ number: 2, faces: 6, modifiers: ["kh1"] })]
        });
        const base = new NativeDamageRoll("2d6kh1", {}, { critical: { multiplier: 1, bonusDice: 0 } });
        base.dice[0].results = [
            { result: 2, active: false, discarded: true },
            { result: 5, active: true, discarded: false }
        ];
        base.dice[0]._evaluated = true;
        base._evaluated = true;
        base._total = 5;

        const critical = await setNativeCritical(base, true);

        expect(critical.dice).toHaveLength(1);
        expect(critical.dice[0].results).toEqual(base.dice[0].results);
        expect(critical.total).toBe(5);
        expect(rollCount).toBe(0);
    });

    it("preserves nested modified base results while evaluating only the added nested clone", async () => {
        NativeDamageRoll.definitions.set("(2d6kh1) * 2", {
            criticalFormula: "(2d6kh1 + 2d6kh1) * 2",
            build: isCritical => [
                new ParentheticalTerm(isCritical
                    ? [new BasicDie({ number: 2, faces: 6, modifiers: ["kh1"] }), new OperatorTerm("+"), new BasicDie({ number: 2, faces: 6, modifiers: ["kh1"] })]
                    : [new BasicDie({ number: 2, faces: 6, modifiers: ["kh1"] })]),
                new OperatorTerm("*"),
                new NumericTerm(2)
            ]
        });
        const base = new NativeDamageRoll("(2d6kh1) * 2");
        base.dice[0].results = [
            { result: 1, active: false, discarded: true },
            { result: 4, active: true, discarded: false }
        ];
        base.dice[0]._evaluated = true;
        base.terms[0].roll._total = 4;
        base.terms[0].roll._evaluated = true;
        base.terms[0]._evaluated = true;
        base._evaluated = true;
        base._total = 8;
        rolledValues = [6, 2];

        const critical = await setNativeCritical(base, true);

        expect(critical.dice[0].results).toEqual(base.dice[0].results);
        expect(critical.dice[1].results.map(result => result.result)).toEqual([6, 2]);
        expect(critical.total).toBe(20);
        expect(rollCount).toBe(2);
    });

    it("returns the stored original base roll when critical is switched off", async () => {
        const base = installCapturedPair("1d8+3");
        rolledValues = [4];
        const critical = await setNativeCritical(base, true);

        expect(await setNativeCritical(critical, false)).toBe(base);
        expect(await setNativeCritical(base, false)).toBe(base);
    });

    it("restores the serialized base after the promoted roll is rehydrated", async () => {
        const base = installCapturedPair("1d8+3");
        rolledValues = [4];
        const critical = await setNativeCritical(base, true);

        expect(critical.options.rsreforgedCriticalBase).toMatchObject({
            class: "NativeDamageRoll",
            formula: base.formula,
            total: base.total,
            evaluated: true
        });
        expect(critical.options.rsreforgedCriticalBase.options).not.toHaveProperty("rsreforgedCriticalBase");

        const rehydratedCritical = NativeDamageRoll.fromData(structuredClone(critical.toJSON()));
        const restored = await setNativeCritical(rehydratedCritical, false);

        expect(restored).not.toBe(base);
        expect(snapshot(restored)).toEqual(snapshot(base));
        expect(restored.options).not.toHaveProperty("rsreforgedCriticalBase");
    });

    it("fails closed with the recorded native parenthetical immutability error", async () => {
        const pair = capturedPairs.get("(1d6+2)*2");
        NativeDamageRoll.definitions.set(pair.formula, {
            error: pair.error,
            build: () => [new ParentheticalTerm([new BasicDie({ number: 1, faces: 6 }), new OperatorTerm("+"), new NumericTerm(2)]), new OperatorTerm("*"), new NumericTerm(2)]
        });
        const base = new NativeDamageRoll(pair.formula);
        base.dice[0].results = [{ result: 5, active: true }];
        base.dice[0]._evaluated = true;
        base._evaluated = true;
        base._total = 14;
        const before = snapshot(base);

        await expect(setNativeCritical(base, true)).rejects.toThrow(
            `Cannot safely set critical damage for "${pair.formula}": ${pair.error}`
        );
        expect(snapshot(base)).toEqual(before);
    });

    it("fails closed when the native critical structure cannot contain all base dice", async () => {
        NativeDamageRoll.definitions.set("2d8", {
            criticalFormula: "1d8",
            build: isCritical => [new BasicDie({ number: isCritical ? 1 : 2, faces: 8 })]
        });
        const base = new NativeDamageRoll("2d8");
        base.dice[0].results = [{ result: 3, active: true }, { result: 7, active: true }];
        base.dice[0]._evaluated = true;
        base._evaluated = true;
        base._total = 10;
        const before = snapshot(base);

        await expect(setNativeCritical(base, true)).rejects.toThrow(/cannot map base die 1/i);
        expect(snapshot(base)).toEqual(before);
    });

    it("fails closed when asked to downgrade a rehydrated critical without its stored base", async () => {
        const base = installCapturedPair("1d8+3");
        rolledValues = [4];
        const critical = await setNativeCritical(base, true);
        const rehydrated = new NativeDamageRoll(base.formula, {}, { isCritical: true });
        rehydrated.terms = critical.terms;
        rehydrated._evaluated = true;
        rehydrated._total = critical.total;

        await expect(setNativeCritical(rehydrated, false)).rejects.toThrow(/original base roll is unavailable/i);
    });
});
