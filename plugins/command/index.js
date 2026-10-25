(function () {
    // Kettu/Vendetta evaluates this file as a single expression, so everything
    // lives inside this function.
    //
    // Stops Discord from autofilling the closest slash command when you press
    // send with partial text like "/ba". Logs showed the autofill is called
    // from sendCommand/handleSend/handlePressSend. Tapping a suggestion doesn't
    // go through those, and typing a full command name is allowed.
    //
    // v5: blocking setActiveCommand alone wasn't enough (the text still got
    // rewritten), so this also guards sendCommand/setCommand, and SEND_PROBE
    // logs every text/draft/command function called during a send so the real
    // text-setter can be found if this still isn't enough.
    const { metro, patcher, logger } = vendetta;

    const SEND_PROBE = true;

    // Command-object functions: block only when the command isn't fully typed.
    const GUARDED = ["setActiveCommand", "toDraftCommand", "trackCommandSelected"];
    // Whole-function guards: block during a send when the text isn't a valid command yet.
    const LOWLEVEL = ["sendCommand", "setCommand"];
    // Only watched, to know what is in the text box.
    const WATCHED = ["resolveDraftCommand", "isDraftCommandValidForText"];

    let unpatches = [];
    let lastText = "";
    let lastResolved = false;

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

    function guardLow(obj, name) {
        unpatches.push(
            patcher.instead(name, obj, (args, orig) => {
                if (lastText[0] === "/" && !lastResolved && sendInStack()) {
                    logger.log(`[NCA] blocked ${name}: typed "${lastText}"`);
                    return undefined;
                }
                return orig(...args);
            })
        );
    }

    function watch(obj, name) {
        unpatches.push(
            patcher.instead(name, obj, (args, orig) => {
                const r = orig(...args);
                if (typeof args[1] === "string") lastText = args[1];
                if (name === "resolveDraftCommand") lastResolved = !!r;
                return r;
            })
        );
    }

    function brief(v) {
        try {
            if (typeof v === "string") return JSON.stringify(v.slice(0, 40));
            if (v == null || typeof v !== "object") return String(v);
            return "{" + Object.keys(v).slice(0, 5).join(",") + "}";
        } catch (e) { return "?"; }
    }

    function probeSend(obj, name) {
        unpatches.push(
            patcher.instead(name, obj, (args, orig) => {
                if (lastText[0] === "/" && sendInStack()) {
                    logger.log(`[NCA send] ${name}(${args.map(brief).join(", ")})`);
                }
                return orig(...args);
            })
        );
    }

    function install() {
        const mods = metro.modules || {};
        const known = GUARDED.concat(LOWLEVEL, WATCHED);
        const done = [];
        let probed = 0;
        const found = {};
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
                let keys;
                try { keys = Object.keys(obj); } catch (e) { continue; }
                for (const name of keys) {
                    const isKnown = known.indexOf(name) !== -1;
                    const wantProbe = SEND_PROBE && probed < 400 && !isKnown &&
                        /command|draft|text|autocomplete|send|submit|content/i.test(name) &&
                        !/^(get|is|has|should|use)/.test(name);
                    if (!isKnown && !wantProbe) continue;
                    let desc;
                    try { desc = Object.getOwnPropertyDescriptor(obj, name); } catch (e) { continue; }
                    if (!desc || typeof desc.value !== "function" || !desc.writable) continue;
                    if (!once(obj, name)) continue;
                    try {
                        if (GUARDED.indexOf(name) !== -1) guard(obj, name);
                        else if (LOWLEVEL.indexOf(name) !== -1) guardLow(obj, name);
                        else if (WATCHED.indexOf(name) !== -1) watch(obj, name);
                        else { probeSend(obj, name); probed++; }
                        if (isKnown) found[name] = (found[name] || 0) + 1;
                    } catch (e) {}
                }
            }
        }
        logger.log(`[NCA] patched ${unpatches.length} functions (probing ${probed}); found: ${JSON.stringify(found)}`);
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
