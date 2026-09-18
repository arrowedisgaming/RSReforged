import { beforeEach, it, expect, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

let RerollManager;

beforeEach(async () => {
    vi.resetModules();
    await setupFoundryEnv({ settings: { rerollEveryone: true, rerollPlayers: true } });
    $(document).off("mousedown");
    game.user.isGM = true;
    ({ RerollManager } = await import("../src/utils/reroll.js"));
    RerollManager.registerGlobalListener();
});

/** dnd5e 6 keeps core's tooltip classes inside its roll breakdown popover. */
function nativeBreakdownDie() {
    const message = document.createElement("li");
    message.className = "chat-message message";
    message.dataset.messageId = "attack";
    message.innerHTML = `
        <div class="message-content">
            <button class="dice-roll"><span class="total">17</span></button>
            <div class="roll-breakdown" popover>
                <div class="dice-tooltip-collapser"><div class="dice-tooltip">
                    <section class="tooltip-part"><div class="dice">
                        <ol class="dice-rolls"><li class="roll die d20">11</li></ol>
                    </div></section>
                </div></div>
            </div>
        </div>`;
    document.body.append(message);
    game.messages.set("attack", { id: "attack", isAuthor: true, rolls: [], flags: {} });
    return message.querySelector(".roll");
}

function click(die) {
    $(die).trigger($.Event("mousedown", { button: 0 }));
}

function useDnd5e(version) {
    game.system = { version };
    CONFIG.ChatMessage.dataModels = version.startsWith("6")
        ? Object.fromEntries(["attack", "damage", "healing", "check", "save", "generic"].map((t) => [t, {}]))
        : {};
}

it("still rerolls a clicked die on the legacy workflow", () => {
    useDnd5e("5.3.3");
    const reroll = vi.spyOn(RerollManager, "_handleReroll").mockImplementation(() => {});

    click(nativeBreakdownDie());

    expect(reroll).toHaveBeenCalledOnce();
});

it("ignores dice in dnd5e 6 breakdowns until native rerolls are restored", () => {
    useDnd5e("6.0.1");
    const reroll = vi.spyOn(RerollManager, "_handleReroll").mockImplementation(() => {});
    const fudge = vi.spyOn(RerollManager, "_handleFudge").mockImplementation(() => {});
    const die = nativeBreakdownDie();

    click(die);
    $(die).trigger($.Event("mousedown", { button: 2 }));

    expect(reroll).not.toHaveBeenCalled();
    expect(fudge).not.toHaveBeenCalled();
});
