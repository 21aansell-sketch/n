(function () {
    // Kettu/Vendetta evaluates this file as a single expression, so everything
    // lives inside this function.
    //
    // Stops Discord from autofilling the closest slash command when you press
    // send with partial text like "/ba". Found via logs: that autofill goes
    // trackCommandSelected -> setActiveCommand -> toDraftCommand, all called
    // from sendCommand/handleSend/handlePressSend. Tapping a suggestion doesn't
    // go through those, so it is left alone, and so is typing a full command name.
    const { metro, patcher, logger } = vendetta;

    // Functions to guard. The first three are the autofill itself; the last two
    // are only watched to know what text is currently in the box.
    const GUARDED = ["setActiveCommand", "toDraftCommand", "trackCommandSelected"];
    const WATCHED = ["resolveDraftCommand", "isDraftCommandValidForText"];

    let unpatches = [];
    let lastText = "";

    function sendInStack() {
        try {
            return /sendCommand|handleSend|handlePressSend/.test(String(new Error().stack));
        } catch (e) {
            return false;
        }
    }

    function nameOf(args) {
        try {
            let c = args[0];
            if (c && c.command) c = c.command;
            if (!c || typeof c !== "object") return "";
            return String(c.displayName || c.name || c.untranslatedName || "").toLowerCase();
        } catch (e) {
            return "";
        }
    }

    // Did the user type the full command name (optionally followed by options)?
    function fullyTyped(name) {
        const typed = lastText.replace(/^\//, "").trim().toLowerCase();
        return typed === name || typed.indexOf(name + " ") === 0;
    }

    function guard(obj, name) {
        unpatches.push(
            patcher.instead(name, obj, (args, orig) => {
                if (lastText[0] === "/" && sendInStack()) {
                    const cmd = nameOf(args);
                    if (cmd && !fullyTyped(cmd)) {
                        logger.log(`[NCA] blocked ${name}: typed "${lastText}" -> "${cmd}"`);
                        return name === "toDraftCommand" ? null : undefined;
                    }
                }
                return orig(...args);
            })
        );
    }

    function watch(obj, name) {
        unpatches.push(
            patcher.instead(name, obj, (args, orig) => {
                if (typeof args[1] === "string") lastText = args[1];
                return orig(...args);
            })
        );
    }

    function install() {
        const mods = metro.modules || {};
        const done = [];
        function once(obj, name) {
            for (const d of done) if (d[0] === obj && d[1] === name) return false;
            done.push([obj, name]);
            return true;
        }
        for (const id of Object.keys(mods)) {
            let exp;
            try {
                const m = mods[id];
                if (!m || !m.isInitialized) continue;
                exp = m.publicModule && m.publicModule.exports;
            } catch (e) { continue; }
            if (!exp || typeof exp !== "object") continue;
            const targets = [exp];
            try { if (exp.default && typeof exp.default === "object") targets.push(exp.default); } catch (e) {}
            for (const obj of targets) {
                for (const name of GUARDED.concat(WATCHED)) {
                    let desc;
                    try { desc = Object.getOwnPropertyDescriptor(obj, name); } catch (e) { continue; }
                    if (!desc || typeof desc.value !== "function" || !desc.writable) continue;
                    if (!once(obj, name)) continue;
                    try {
                        if (GUARDED.indexOf(name) !== -1) guard(obj, name);
                        else watch(obj, name);
                    } catch (e) {}
                }
            }
        }
        logger.log(`[NCA] patched ${unpatches.length} functions`);
    }

    return {
        onLoad() {
            try { install(); } catch (e) { logger.log("[NCA] install failed: " + e); }
        },
        onUnload() {
            for (const u of unpatches) { try { u(); } catch (e) {} }
            unpatches = [];
        },
    };
})();
