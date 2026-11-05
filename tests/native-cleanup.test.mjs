import { beforeEach, expect, it, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

// Issue #48: deleting an RSR usage card deletes the rolls folded into it, across clients.

const USERS = {
    player: { id: "player", isGM: false },
    other: { id: "other", isGM: false },
    gm: { id: "gm", isGM: true }
};

let world;

beforeEach(async () => {
    vi.resetModules();
    await setupFoundryEnv();
    world = createWorld();
});

/**
 * A server and its connected clients. Each client has its own module instance, its own
 * message collection and its own user, and shares nothing with the others but the server.
 * Deletion follows Foundry: the whole batch leaves every collection, then each client
 * fires its delete hook per document with the requesting user's ID.
 */
function createWorld() {
    const sources = new Map();
    const clients = [];
    const deletions = [];
    const updates = [];

    function documentFor(source) {
        return {
            ...structuredClone(source),
            canUserModify: (user, action) => action === "delete" && (user.isGM || user.id === source.author)
        };
    }

    async function connect(userKey) {
        vi.resetModules();
        const cleanup = await import("../src/utils/native-cleanup.js");
        const user = USERS[userKey];
        const users = new Map(Object.values(USERS).map(u => [u.id, u]));
        const client = { user, cleanup, connected: true };
        client.game = {
            ...globalThis.game,
            user,
            users,
            messages: new Map([...sources].map(([id, source]) => [id, documentFor(source)]))
        };
        Object.defineProperty(users, "activeGM", {
            get: () => clients.find(c => c.connected && c.user.isGM) ? { isSelf: client.user.isGM } : null
        });
        clients.push(client);
        return client;
    }

    function as(client) {
        globalThis.game = client.game;
        return client;
    }

    async function deleteDocuments(ids, requester) {
        deletions.push({ by: requester.id, ids: [...ids] });
        // A round trip: requests sent at the same time all leave before any is applied.
        await Promise.resolve();
        for (const id of ids) {
            if (!sources.has(id)) throw new Error(`ChatMessage ${id} does not exist`);
            const source = sources.get(id);
            if (!requester.isGM && source.author !== requester.id) throw new Error(`${requester.id} may not delete ${id}`);
        }
        const deleted = ids.map(id => sources.get(id));
        ids.forEach(id => sources.delete(id));
        for (const client of clients) {
            for (const id of ids) client.game.messages.delete(id);
        }
        const pending = [];
        for (const client of clients.filter(c => c.connected && c.deliver !== false)) {
            for (const source of deleted) {
                as(client);
                pending.push(client.cleanup.cascadeUsageDeletion(documentFor(source), requester.id));
            }
        }
        await Promise.all(pending);
    }

    globalThis.ChatMessage = {
        implementation: {
            deleteDocuments: async ids => deleteDocuments(ids, globalThis.game.user),
            // Recorded only: cleanup must never write to existing messages.
            updateDocuments: async (changes, options) => {
                updates.push({ by: globalThis.game.user.id, changes, options });
            }
        }
    };

    return {
        sources, clients, deletions, updates, connect, as,
        add(source) {
            sources.set(source.id, { flags: {}, system: {}, ...source });
            for (const client of clients) client.game.messages.set(source.id, documentFor(sources.get(source.id)));
        },
        /** A user deletes documents through their own client. */
        async remove(client, ids) {
            as(client);
            await globalThis.ChatMessage.implementation.deleteDocuments(ids);
        }
    };
}

const rsrUsage = (id, author) => ({ id, author, type: "usage", flags: { rsreforged: { workflowVersion: 2, quickRoll: true } } });
const vanillaUsage = (id, author) => ({ id, author, type: "usage" });
/** A roll created by this version from an RSR card. */
const folded = (id, parent, author, type = "damage") => ({
    id, author, type, system: { origin: parent }, flags: { rsreforged: { workflowVersion: 2, parentId: parent, deleteWithParent: true } }
});
/** A quick roll created before this version: linked, but never deleted without its card. */
const oldFolded = (id, parent, author, type = "damage") => ({
    id, author, type, system: { origin: parent }, flags: { rsreforged: { workflowVersion: 2, parentId: parent } }
});
const unlinked = (id, parent, author, type = "damage") => ({ id, author, type, system: { origin: parent } });

it("the deleting player removes its own rolls and the GM independently removes the rest, with no shared state", async () => {
    const [player, gm] = [await world.connect("player"), await world.connect("gm")];
    world.add(rsrUsage("card", "player"));
    world.add(folded("attack", "card", "player", "attack"));
    world.add(folded("gm-damage", "card", "gm"));

    await world.remove(player, ["card"]);

    expect(world.sources.size).toBe(0);
    expect(world.deletions).toEqual([
        { by: "player", ids: ["card"] },
        { by: "player", ids: ["attack"] },
        { by: "gm", ids: ["gm-damage"] }
    ]);
    expect(player.game.messages.size + gm.game.messages.size).toBe(0);
});

it("leaves rolls it may not delete for the next GM when none is online, who removes them at ready", async () => {
    const player = await world.connect("player");
    world.add(rsrUsage("card", "player"));
    world.add(folded("attack", "card", "player", "attack"));
    world.add(folded("other-damage", "card", "other"));

    await world.remove(player, ["card"]);
    expect([...world.sources.keys()]).toEqual(["other-damage"]);
    world.as(player);
    expect(player.cleanup.isOrphanedRoll(player.game.messages.get("other-damage"))).toBe(true);

    const gm = world.as(await world.connect("gm"));
    await gm.cleanup.deleteOrphanedRolls();
    expect(world.sources.size).toBe(0);
    expect(world.deletions.at(-1)).toEqual({ by: "gm", ids: ["other-damage"] });
});

it("recovers when the deleting client disconnects before its cascade: the GM removes the rest, then the remainder at its next ready", async () => {
    const [player, gm] = [await world.connect("player"), await world.connect("gm")];
    world.add(rsrUsage("card", "player"));
    world.add(folded("attack", "card", "player", "attack"));
    world.add(folded("gm-damage", "card", "gm"));
    player.deliver = false;

    await world.remove(player, ["card"]);
    // The GM never deletes what the player could, so the two never race.
    expect([...world.sources.keys()]).toEqual(["attack"]);

    world.as(gm);
    await gm.cleanup.deleteOrphanedRolls();
    expect(world.sources.size).toBe(0);
});

it("does nothing more after a cleared log, where every roll left with its card", async () => {
    const gm = await world.connect("gm");
    await world.connect("player");
    world.add(rsrUsage("card", "player"));
    world.add(folded("attack", "card", "player", "attack"));
    world.add(folded("damage", "card", "player"));

    await world.remove(gm, ["card", "attack", "damage"]);

    expect(world.deletions).toEqual([{ by: "gm", ids: ["card", "attack", "damage"] }]);
});

it("tolerates two sessions of the same user deleting the same rolls at once", async () => {
    const [tab, otherTab] = [await world.connect("player"), await world.connect("player")];
    world.add(rsrUsage("card", "player"));
    world.add(folded("attack", "card", "player", "attack"));
    const warn = vi.spyOn((await import("../src/utils/log.js")).LogUtility, "logWarning");

    await world.remove(tab, ["card"]);

    expect(world.sources.size).toBe(0);
    expect(otherTab.game.messages.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
});

it("never deletes rolls without evidence of belonging to the deleted RSR card", async () => {
    const [player, gm] = [await world.connect("player"), await world.connect("gm")];
    world.add(rsrUsage("card", "player"));
    world.add(vanillaUsage("vanilla", "gm"));
    // A GM's vanilla roll, its card deleted long ago, with no RSR link.
    world.add(unlinked("old-vanilla", "gone", "gm"));
    // Linked to the deleted card, but its native origin names another card.
    world.add({ ...folded("mismatch", "card", "gm"), system: { origin: "vanilla" } });
    // A vanilla card's own roll.
    world.add(unlinked("vanilla-damage", "vanilla", "gm"));
    // A player's link on their own message can only affect that message.
    world.add(folded("self-linked", "card", "player"));

    await world.remove(player, ["card"]);
    world.as(gm);
    await gm.cleanup.deleteOrphanedRolls();

    expect([...world.sources.keys()].sort()).toEqual(["mismatch", "old-vanilla", "vanilla", "vanilla-damage"]);
    world.as(player);
    expect(player.cleanup.isOrphanedRoll(player.game.messages.get("old-vanilla"))).toBe(false);
    expect(player.cleanup.isOrphanedRoll(player.game.messages.get("mismatch"))).toBe(false);
});

it("deletes rolls made before this version with their card, matching an older Damage-button roll by its native origin", async () => {
    const [player, gm] = [await world.connect("player"), await world.connect("gm")];
    world.add(rsrUsage("card", "player"));
    world.add(vanillaUsage("vanilla", "gm"));
    world.add(oldFolded("old-quick", "card", "player", "attack"));
    world.add(unlinked("old-manual", "card", "player"));
    world.add(unlinked("gm-old-manual", "card", "gm"));
    world.add(unlinked("vanilla-damage", "vanilla", "gm"));

    await world.remove(player, ["card"]);

    expect([...world.sources.keys()].sort()).toEqual(["vanilla", "vanilla-damage"]);
    expect(world.deletions).toEqual([
        { by: "player", ids: ["card"] },
        { by: "player", ids: ["old-quick", "old-manual"] },
        { by: "gm", ids: ["gm-old-manual"] }
    ]);
    expect(world.updates).toEqual([]);
});

it("lets only the active GM run the ready cleanup", async () => {
    const player = world.as(await world.connect("player"));
    world.add(folded("orphan", "gone", "player"));

    await player.cleanup.deleteOrphanedRolls();

    expect(world.sources.has("orphan")).toBe(true);
    expect(world.deletions).toEqual([]);
});

it("links a roll made from an RSR card at creation, and nothing else", async () => {
    const player = world.as(await world.connect("player"));
    world.add(rsrUsage("card", "player"));
    world.add(vanillaUsage("vanilla", "player"));
    const pending = (type, origin, flags = {}) => ({ type, flags, system: { origin }, updateSource: vi.fn() });

    const manual = pending("damage", "card");
    const vanilla = pending("damage", "vanilla");
    const quick = pending("damage", "card", { rsreforged: { parentId: "card" } });
    const save = pending("save", "card");
    [manual, vanilla, quick, save].forEach(player.cleanup.stampRsrParent);

    expect(manual.updateSource).toHaveBeenCalledWith({ "flags.rsreforged.parentId": "card", "flags.rsreforged.deleteWithParent": true });
    expect(vanilla.updateSource).not.toHaveBeenCalled();
    expect(quick.updateSource).not.toHaveBeenCalled();
    expect(save.updateSource).not.toHaveBeenCalled();
});

it("leaves rolls whose card was deleted before this version as they are, on every client, and writes nothing", async () => {
    // Before this version, deleting a card restored its quick rolls as standalone cards on purpose.
    world.add(oldFolded("old-attack", "gone", "player", "attack"));
    world.add(oldFolded("old-damage", "gone", "other"));
    world.add(unlinked("old-manual", "gone", "player"));
    const player = world.as(await world.connect("player"));
    for (const id of ["old-attack", "old-damage", "old-manual"]) {
        expect(player.cleanup.isOrphanedRoll(player.game.messages.get(id))).toBe(false);
    }

    const gm = world.as(await world.connect("gm"));
    await gm.cleanup.deleteOrphanedRolls();

    expect([...world.sources.keys()].sort()).toEqual(["old-attack", "old-damage", "old-manual"]);
    expect(world.deletions).toEqual([]);
    expect(world.updates).toEqual([]);
});
