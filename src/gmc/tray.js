import { MODULE_SHORT, CoreUtility, LogUtility } from "./shim.js";

/**
 * Facelift for dnd5e 6's native <damage-application> tray
 * (applications/components/damage-application.mjs, DamageApplicationElement).
 *
 * The component builds its multiplier split-button from a module-private MULTIPLIERS list
 * through the public DamageApplicationElement#buildMultiplierButtons, and its frame once per
 * element in connectedCallback (which calls #buildTargetContainer after the multiplier row
 * exists). Custom-element lifecycle callbacks are captured at define time, so the prototype
 * methods those callbacks call are wrapped instead:
 *  - buildMultiplierButtons: "-1" shows a heart (apply as healing), "2" keeps its label with
 *    a faded burst icon behind it, every button gets a tooltip;
 *  - buildTargetContainer: adds an hourglass "temp HP" mode right after the heart. In that
 *    mode the tray treats the whole roll as temporary hit points: the target pills preview the
 *    temp HP each target would get and Apply grants it (dnd5e's own "temphp" damage type, so
 *    Actor5e#applyDamage keeps the higher of the current and the new temp HP);
 *  - getMergedOptions: on RSR usage cards of save activities, pre-selects the on-save
 *    multiplier for targets whose summarized save succeeded (what dnd5e does for its own
 *    damage messages through the private #saveMultiplier).
 * Applies to every tray, RSR's cards and native damage messages alike.
 */
export class TrayUtility {
    static patchDamageApplication() {
        const cls = customElements.get("damage-application");
        if (!cls) {
            LogUtility.logWarning("dnd5e <damage-application> element not found; tray facelift disabled.", { ui: false });
            return;
        }
        const proto = cls.prototype;
        if (proto._rsrPatched) return;

        const buildMultiplierButtons = proto.buildMultiplierButtons;
        proto.buildMultiplierButtons = function (active) {
            const buttons = buildMultiplierButtons.call(this, active);
            try {
                for (const button of buttons) TrayUtility._decorateMultiplierButton(this, button);
            } catch (err) {
                console.warn("RSReforged | tray facelift failed", err);
            }
            return buttons;
        };

        const buildTargetContainer = proto.buildTargetContainer;
        proto.buildTargetContainer = function () {
            const list = buildTargetContainer.call(this);
            try {
                TrayUtility._appendTempHpButton(this);
                list.addEventListener("recorded-targets:change", () => { this._rsrDirty = false; });
            } catch (err) {
                console.warn("RSReforged | tray temp HP button failed", err);
            }
            return list;
        };

        const onChangeMultiplier = proto._onChangeMultiplier;
        proto._onChangeMultiplier = function (event) {
            if (event?.target?.closest?.(".multiplier-button")) {
                this._rsrDirty = true;
                this._rsrTemp = false;
            }
            const result = onChangeMultiplier.call(this, event);
            TrayUtility._refreshTempButton(this);
            return result;
        };

        const getMergedOptions = proto.getMergedOptions;
        proto.getMergedOptions = function (uuid) {
            const merged = getMergedOptions.call(this, uuid);
            try {
                if (!this._rsrDirty && (this.getTargetOptions(uuid).multiplier === undefined)) {
                    const multiplier = TrayUtility._usageSaveMultiplier(this.chatMessage, uuid);
                    if (multiplier !== null) merged.multiplier = multiplier;
                }
                if (this._rsrTemp && (merged.multiplier !== 0)) merged.multiplier = 1;
            } catch (err) {
                LogUtility.debug("save multiplier lookup failed", err);
            }
            return merged;
        };

        // Temp HP mode: evaluate and apply the roll as dnd5e "temphp" damage.
        const calculateDamage = proto.calculateDamage;
        proto.calculateDamage = function (actor, options) {
            if (!this._rsrTemp) return calculateDamage.call(this, actor, options);
            const damages = this.damages;
            this.damages = TrayUtility._asTempHp(damages);
            try {
                return calculateDamage.call(this, actor, options);
            } finally {
                this.damages = damages;
            }
        };

        const onApplyDamage = proto._onApplyDamage;
        proto._onApplyDamage = async function (event) {
            if (!this._rsrTemp) return onApplyDamage.call(this, event);
            const damages = this.damages;
            this.damages = TrayUtility._asTempHp(damages);
            try {
                return await onApplyDamage.call(this, event);
            } finally {
                this.damages = damages;
            }
        };

        const refreshMultiplier = proto.refreshMultiplier;
        proto.refreshMultiplier = function () {
            const result = refreshMultiplier.call(this);
            try { TrayUtility._refreshTempButton(this); } catch (err) { LogUtility.debug("temp HP refresh failed", err); }
            return result;
        };

        proto._rsrPatched = true;
        LogUtility.log("Patched dnd5e damage application tray");
    }

    static _decorateMultiplierButton(tray, button) {
        const value = Number(button.value);
        const label = TrayUtility._multiplierLabel(value);
        if (label) {
            button.dataset.tooltip = label;
            button.setAttribute("aria-label", label);
        }

        if (value === -1) {
            button.classList.add("rsr-mult-healing");
            button.innerHTML = '<i class="fa-solid fa-heart" inert></i>';
        } else if (value === 2) {
            button.classList.add("rsr-mult-double");
            button.insertAdjacentHTML("afterbegin", '<i class="fa-fw fa-solid fa-burst rsr-mult-bg" inert></i>');
        }
    }

    static _multiplierLabel(value) {
        const key = {
            "-1": "healing", "0": "none", "0.25": "quarter", "0.5": "half", "1": "full", "2": "double"
        }[String(value)];
        return key ? CoreUtility.localize(`${MODULE_SHORT}.chat.tray.${key}`) : null;
    }

    static _appendTempHpButton(tray) {
        const row = tray.querySelector(".multiplier-row .damage-multipliers");
        if (!row || row.querySelector(".rsr-temphp-button")) return;
        const button = document.createElement("button");
        button.type = "button";
        button.classList.add("split-control", "rsr-temphp-button");
        button.ariaPressed = "false";
        const label = CoreUtility.localize(`${MODULE_SHORT}.chat.tray.tempHp`);
        button.dataset.tooltip = label;
        button.setAttribute("aria-label", label);
        button.innerHTML = '<i class="fa-solid fa-hourglass-half" inert></i>';
        button.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            TrayUtility.toggleTempHp(tray);
        });
        // Right after the heart (healing), before "0".
        const healing = row.querySelector('.multiplier-button[value="-1"]');
        if (healing) healing.after(button);
        else row.prepend(button);
    }

    /**
     * Switch a tray in or out of temp HP mode and rebuild its target previews.
     * @param {HTMLElement} tray A <damage-application> element.
     * @param {boolean} [state] Force a state; toggles when omitted.
     */
    static toggleTempHp(tray, state) {
        tray._rsrTemp = state ?? !tray._rsrTemp;
        if (tray._rsrTemp) tray.multiplier = 1;
        tray.targetList?.buildTargetsList();
        try { tray.refreshMultiplier(); } catch (err) { TrayUtility._refreshTempButton(tray); }
    }

    static _refreshTempButton(tray) {
        const button = tray.querySelector(".multiplier-row .rsr-temphp-button");
        if (!button) return;
        button.ariaPressed = `${!!tray._rsrTemp}`;
        if (!tray._rsrTemp) return;
        for (const b of tray.querySelectorAll(".multiplier-row .multiplier-button")) b.ariaPressed = "false";
    }

    /**
     * The tray's damage descriptions re-typed as temporary hit points.
     * @param {object[]} damages
     * @returns {object[]}
     */
    static _asTempHp(damages) {
        const total = (damages ?? []).reduce((sum, d) => sum + (Number(d?.value) || 0), 0);
        return [{ type: "temphp", value: Math.max(0, Math.floor(total)), properties: new Set() }];
    }

    /**
     * On-save multiplier for a target of an RSR usage card whose activity is a save.
     * @param {ChatMessage} message The tray's message.
     * @param {string} uuid Target token UUID.
     * @returns {number|null}
     */
    static _usageSaveMultiplier(message, uuid) {
        if (message?.type !== "usage" || !message.flags?.[MODULE_SHORT]?.quickRoll) return null;
        if (message.flags[MODULE_SHORT].workflowVersion === 2) return null; // RSReforged-engine card
        const activity = message.getAssociatedActivity?.();
        if (activity?.type !== "save") return null;
        if (message.system?.outcomes?.get?.(uuid) !== "success") return null;
        switch (activity.damage?.onSave) {
            case "full": return 1;
            case "half": return .5;
            case "none": return 0;
        }
        return null;
    }
}
