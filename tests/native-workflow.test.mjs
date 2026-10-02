import { beforeEach, describe, it, expect } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

let workflow;

beforeEach(async () => {
    await setupFoundryEnv();
    ChatMessage.createDocumentCalls.length = 0;
    workflow = await import("../src/utils/native-workflow.js");
});

/**
 * Emulates a dnd5e 6 roll method called with `create:false`.
 *
 * Faithful to the real contract: dnd5e merges the caller's message configuration into
 * its OWN object (`foundry.utils.mergeObject({...}, message)`) and never mutates the
 * caller's. That internal object is what `dnd5e.postRollConfiguration` receives and what
 * BasicRoll.buildPost later assigns the fully prepared message source to.
 */
function nativeRollMethod(type, calls, makeRolls, { fireHook = true } = {}) {
    return async (config, dialog, message) => {
        calls.push([type, config, dialog, message]);
        const seed = foundry.utils.deepClone(message.data ?? {});
        const internal = { ...message, data: seed };
        const rolls = makeRolls(config);
        if (!rolls.length) return type === "attack" ? null : [];
        if (fireHook) workflow.captureNativeMessageConfig(internal); // dnd5e.postRollConfiguration
        internal.data = {
            type,
            sound: "sounds/dice.wav",
            speaker: { actor: "actor" },
            rolls: rolls.map((roll) => roll.toJSON()),
            system: { ...(seed.system ?? {}), deltas: null },
            flags: foundry.utils.deepClone(seed.flags ?? {}),
            whisper: seed.whisper ?? [],
            blind: seed.blind ?? false
        };
        return rolls;
    };
}

function fixture({ attackRolls, damageRolls } = {}) {
    const calls = [];
    const items = new Map();
    const actor = { id: "actor", items };
    const activity = {
        id: "a",
        type: "attack",
        item: {},
        actor,
        createConsumedFlag: () => ({ hd: "1d8" }),
        getDamageConfig: () => ({ rolls: [{}] })
    };
    const rollActivity = {
        ...activity,
        rollAttack: nativeRollMethod("attack", calls, attackRolls ?? (() => {
            const roll = new Roll("1d20");
            roll.isCritical = true;
            roll.options = { ammunition: "arrow", attackMode: "twoHanded", ability: "dex" };
            return [roll];
        })),
        rollDamage: nativeRollMethod("damage", calls, damageRolls ?? (() => [new Roll("1d8")]))
    };
    activity.item.clone = (data) => {
        calls.push(["clone", data]);
        return { system: { activities: new Map([["a", rollActivity]]) } };
    };
    activity.item.system = { ammunitionOptions: [] };
    const parent = {
        id: "parent",
        isAuthor: true,
        whisper: [],
        blind: false,
        flags: { rsreforged: { workflowVersion: 2, quickRoll: true } },
        system: { scaling: 2, deltas: { item: {} }, targets: [] },
        getAssociatedActor: () => actor,
        getAssociatedActivity: () => activity,
        getAssociatedRolls: () => [],
        update: async (data) => {
            for (const [key, value] of Object.entries(data)) {
                if (key.startsWith("flags.rsreforged.")) parent.flags.rsreforged[key.slice(17)] = value;
            }
            calls.push(["update", data]);
        }
    };
    game.messages.set(parent.id, parent);
    return { activity, parent, calls, rollActivity, actor, items };
}

const created = () => ChatMessage.createDocumentCalls;
const of = (calls, type) => calls.find((call) => call[0] === type);

describe("native usage orchestration", () => {
    it("rolls attack and damage without creating, then creates both documents in one batch", async () => {
        const { activity, parent, calls } = fixture();

        await workflow.runNativeUsage(activity, {}, { message: parent });

        expect(of(calls, "clone")[1]).toEqual({ "flags.dnd5e": { consumed: { hd: "1d8" }, scaling: 2 } });
        expect(of(calls, "attack")[3]).toMatchObject({ create: false, data: { system: { origin: "parent" } } });
        expect(of(calls, "attack")[2]).toEqual({ configure: false });
        expect(of(calls, "damage")[3]).toMatchObject({ create: false, data: { system: { origin: "parent" } } });

        expect(created()).toHaveLength(1);
        const [attack, damage] = created()[0].dataArray;
        expect(attack).toMatchObject({ type: "attack", system: { origin: "parent" }, flags: { rsreforged: { workflowVersion: 2, parentId: "parent" } } });
        expect(damage).toMatchObject({ type: "damage", system: { origin: "parent" }, flags: { rsreforged: { workflowVersion: 2, parentId: "parent" } } });
        expect(parent.flags.rsreforged.workflowState).toBe("complete");
    });

    it("keeps the dice sound on the first created message only", async () => {
        const { activity, parent } = fixture();

        await workflow.runNativeUsage(activity, {}, { message: parent });

        const [attack, damage] = created()[0].dataArray;
        expect(attack.sound).toBe("sounds/dice.wav");
        // Foundry's ChatMessage#_preCreate restores the dice sound on any roll message
        // whose data lacks a `sound` KEY, so silence needs an explicit null, not a delete.
        expect("sound" in damage).toBe(true);
        expect(damage.sound).toBeNull();
    });

    it("derives the damage configuration from the evaluated attack roll", async () => {
        const { activity, parent, calls, items } = fixture();
        const arrow = { id: "arrow", name: "Arrow" };
        items.set("arrow", arrow);

        await workflow.runNativeUsage(activity, {}, { message: parent });

        expect(of(calls, "damage")[1]).toMatchObject({ isCritical: true, attackMode: "twoHanded", ability: "dex", ammunition: arrow });
    });

    it("stores a destroyed ammunition snapshot on the attack data and uses it for damage", async () => {
        const { activity, parent, calls, rollActivity, actor } = fixture();
        const snapshot = { _id: "arrow", name: "Last arrow", system: { quantity: 0 } };
        const built = [];
        globalThis.Item = { implementation: class { constructor(data, options) { built.push([data, options]); this.snapshot = data; } } };
        rollActivity.rollAttack = async (config, dialog, message) => {
            // dnd5e fires the attack hook before deleting the final ammunition unit.
            workflow.recordAmmunitionSnapshot(rollActivity, { id: "arrow", quantity: 0, destroy: true }, () => snapshot);
            return nativeRollMethod("attack", calls, () => {
                const roll = new Roll("1d20");
                roll.options = { ammunition: "arrow" };
                return [roll];
            })(config, dialog, message);
        };

        await workflow.runNativeUsage(activity, {}, { message: parent });

        const [attack] = created()[0].dataArray;
        expect(attack.system.deltas.deleted).toEqual([snapshot]);
        expect(built[0]).toEqual([snapshot, { parent: actor }]);
        expect(of(calls, "damage")[1].ammunition.snapshot).toBe(snapshot);
    });

    it("runs once when repeated lifecycle callbacks overlap", async () => {
        const f = fixture();

        await Promise.all([
            workflow.runNativeUsage(f.activity, {}, { message: f.parent }),
            workflow.runNativeUsage(f.activity, {}, { message: f.parent })
        ]);

        expect(f.calls.filter((c) => c[0] === "attack")).toHaveLength(1);
        expect(created()).toHaveLength(1);
    });

    it("does not execute from observers, unpersisted data or historical cards", async () => {
        const f = fixture();
        f.parent.isAuthor = false;
        await workflow.runNativeUsage(f.activity, {}, { message: f.parent });
        f.parent.isAuthor = true;
        game.messages.delete(f.parent.id);
        await workflow.runNativeUsage(f.activity, {}, { message: f.parent });
        game.messages.set(f.parent.id, f.parent);
        delete f.parent.flags.rsreforged.workflowVersion;
        await workflow.runNativeUsage(f.activity, {}, { message: f.parent });

        expect(f.calls).toEqual([]);
        expect(created()).toHaveLength(0);
    });

    it("honors manual damage mode by creating the attack alone", async () => {
        await setupFoundryEnv({ settings: { manualDamageMode: 1 } });
        const f = fixture();

        await workflow.runNativeUsage(f.activity, {}, { message: f.parent });

        expect(f.calls.filter((c) => c[0] === "damage")).toHaveLength(0);
        expect(created()[0].dataArray.map((d) => d.type)).toEqual(["attack"]);
        expect(f.parent.flags.rsreforged.workflowState).toBe("complete");
    });

    it("does not replay interrupted work on reload", async () => {
        const f = fixture();
        f.parent.flags.rsreforged.workflowState = "running";

        await workflow.runNativeUsage(f.activity, {}, { message: f.parent });

        expect(f.calls).toEqual([]);
    });

    it("forwards exact privacy without applying a new global roll mode", async () => {
        const f = fixture();
        f.parent.whisper = ["gm"];
        f.parent.blind = true;

        await workflow.runNativeUsage(f.activity, {}, { message: f.parent });

        expect(of(f.calls, "attack")[3]).toMatchObject({ rollMode: false, data: { whisper: ["gm"], blind: true } });
        const [attack, damage] = created()[0].dataArray;
        expect(attack).toMatchObject({ whisper: ["gm"], blind: true });
        expect(damage).toMatchObject({ whisper: ["gm"], blind: true });
    });

    it("creates nothing and records cancelled when the attack is vetoed", async () => {
        const f = fixture({ attackRolls: () => [] });

        await workflow.runNativeUsage(f.activity, {}, { message: f.parent });

        expect(created()).toHaveLength(0);
        expect(f.calls.filter((c) => c[0] === "damage")).toHaveLength(0);
        expect(f.parent.flags.rsreforged.workflowState).toBe("cancelled");
    });

    it("creates the attack alone and records partial when damage is vetoed", async () => {
        const f = fixture({ damageRolls: () => [] });

        await workflow.runNativeUsage(f.activity, {}, { message: f.parent });

        expect(created()[0].dataArray.map((d) => d.type)).toEqual(["attack"]);
        expect(f.parent.flags.rsreforged.workflowState).toBe("partial");
        await workflow.runNativeUsage(f.activity, {}, { message: f.parent });
        expect(f.calls.filter((c) => c[0] === "attack")).toHaveLength(1);
    });

    it("creates the attack alone and records partial when damage throws", async () => {
        const f = fixture();
        f.rollActivity.rollDamage = async () => { throw new Error("damage veto"); };

        await expect(workflow.runNativeUsage(f.activity, {}, { message: f.parent })).rejects.toThrow("damage veto");

        expect(created()[0].dataArray.map((d) => d.type)).toEqual(["attack"]);
        expect(f.parent.flags.rsreforged.workflowState).toBe("partial");
    });

    it("preserves distinct token target snapshots and an authoritative empty array", async () => {
        const f = fixture();
        f.parent.system.targets = [
            { actor: "Actor.a", token: "Scene.s.Token.a", ac: null },
            { actor: "Actor.a", token: "Scene.s.Token.b", ac: 18 }
        ];
        await workflow.runNativeUsage(f.activity, {}, { message: f.parent });
        expect(of(f.calls, "attack")[3].data.system.targets).toEqual(f.parent.system.targets);

        const empty = fixture();
        empty.parent.system.targets = [];
        await workflow.runNativeUsage(empty.activity, {}, { message: empty.parent });
        expect(of(empty.calls, "attack")[3].data.system.targets).toEqual([]);
    });

    it("creates documents from dnd5e's prepared message, never from the caller's seed", async () => {
        const { activity, parent, calls } = fixture();

        await workflow.runNativeUsage(activity, {}, { message: parent });

        // The object RSR passed in is still only a seed: dnd5e did not write to it.
        expect(of(calls, "attack")[3].data.type).toBeUndefined();
        expect(of(calls, "attack")[3].data.rolls).toBeUndefined();
        for (const data of created()[0].dataArray) {
            expect(data.speaker).toEqual({ actor: "actor" });
            expect(data.rolls).toHaveLength(1);
            expect(["attack", "damage"]).toContain(data.type);
            expect(data.flags.rsreforged.nativeCaptureId).toBeUndefined();
        }
    });

    it("creates nothing when dnd5e's prepared message was never captured", async () => {
        const f = fixture();
        f.rollActivity.rollAttack = nativeRollMethod("attack", f.calls, () => [new Roll("1d20")], { fireHook: false });

        await expect(workflow.runNativeUsage(f.activity, {}, { message: f.parent })).rejects.toThrow(/prepared/i);

        expect(created()).toHaveLength(0);
        expect(f.parent.flags.rsreforged.workflowState).toBe("failed");
    });

    it("retains an explicit null attack target for total cover", async () => {
        const f = fixture();
        f.parent.system.targets = [{ actor: "Actor.a", token: "Scene.s.Token.a", ac: null }];

        await workflow.runNativeUsage(f.activity, {}, { message: f.parent });

        expect(of(f.calls, "attack")[1]).toHaveProperty("target", null);
    });
});

describe("release review fixes", () => {
    it("never creates the batch twice when only the completion update fails", async () => {
        const f = fixture();
        const update = f.parent.update;
        f.parent.update = async (data) => {
            if (data["flags.rsreforged.workflowState"] === "complete") throw new Error("socket dropped");
            return update(data);
        };

        await expect(workflow.runNativeUsage(f.activity, {}, { message: f.parent })).rejects.toThrow("socket dropped");

        // One batch of attack + damage, not a second copy from the error path.
        expect(created()).toHaveLength(1);
        expect(created()[0].dataArray.map((d) => d.type)).toEqual(["attack", "damage"]);
    });
});
