(function () {
    // Kettu/Vendetta evaluates this file as a single expression, so everything
    // lives inside this function.
    //
    // Goal: "/ba" must not turn into the closest command (e.g. /background),
    // including when you press the send button. A command should only be used
    // when you tap it, or when you typed its full name.
    //
    // I can't see Discord's current internals from here, so this version has
    // two parts:
    //  1. BLOCK: patches the likely command-matching functions (best guesses).
    //  2. PROBE: logs every command-related function that gets called with your
    //     text, so we can find the real one. Use it once, then send me the logs.
    const { metro, patcher, logger } = vendetta;
    const { findByProps } = metro;

    const BLOCK = true;
    const PROBE = true;
    const PROBE_TEXT = "ba"; // type "/ba" and press send, then check Settings > Debug logs

    const CANDIDATES = [
        [["getActiveCommand"], ["getActiveCommand"]],
        [["getCommandFromText"], ["getCommandFromText"]],
        [["getMatchingCommand"], ["getMatchingCommand"]],
        [["autocompleteCommand"], ["autocompleteCommand"]],
        [["getAutocompleteCommand"], ["getAutocompleteCommand"]],
        [["parseCommand", "queryCommands"], ["parseCommand"]],
    ];

    let unpatches = [];

    function typedName(args) {
        const text = args.find(a => typeof a === "string");
        if (!text || text[0] !== "/") return null;
        return text.slice(1).split(/\s/)[0].toLowerCase();
    }

    function cmdName(result) {
        const c = result && result.command ? result.command : result;
        return String((c && (c.displayName || c.name)) || "").toLowerCase();
    }

    function patchBlock(mod, fn) {
        unpatches.push(
            patcher.instead(fn, mod, (args, orig) => {
                const result = orig(...args);
                if (!result) return result;
                const typed = typedName(args);
                if (typed == null) return result;
                if (cmdName(result) === typed) return result;
                logger.log(`[NoCommandAutofill] blocked ${fn}: "${typed}" -> "${cmdName(result)}"`);
                return undefined;
            })
        );
    }

    function brief(v) {
        try {
            if (typeof v === "string") return JSON.stringify(v.slice(0, 60));
            if (v == null || typeof v !== "object") return String(v);
            const keys = Object.keys(v).slice(0, 8).join(",");
            const name = v.displayName || v.name || (v.command && (v.command.displayName || v.command.name));
            return `{${keys}}${name ? " name=" + name : ""}`;
        } catch (e) { return "?"; }
    }

    function mentions(v) {
        try {
            if (typeof v === "string") return v.toLowerCase().includes(PROBE_TEXT);
            if (v && typeof v === "object") {
                const n = String(v.displayName || v.name || (v.command && (v.command.displayName || v.command.name)) || v.content || v.text || "");
                return n.toLowerCase().includes(PROBE_TEXT);
            }
        } catch (e) {}
        return false;
    }

    function probe() {
        const mods = metro.modules || {};
        let count = 0;
        for (const id of Object.keys(mods)) {
            if (count >= 200) break;
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
                for (const k of keys) {
                    if (!/command/i.test(k)) continue;
                    let desc;
                    try { desc = Object.getOwnPropertyDescriptor(obj, k); } catch (e) { continue; }
                    if (!desc || typeof desc.value !== "function" || !desc.writable) continue;
                    count++;
                    try {
                        unpatches.push(
                            patcher.instead(k, obj, (args, orig) => {
                                const result = orig(...args);
                                if (args.some(mentions) || mentions(result)) {
                                    logger.log(`[NCA probe] ${k}(${args.map(brief).join(", ")}) -> ${brief(result)}`);
                                }
                                return result;
                            })
                        );
                    } catch (e) {}
                }
            }
        }
        logger.log(`[NCA probe] watching ${count} command-related functions`);
    }

    return {
        onLoad() {
            if (BLOCK) {
                for (const [props, fns] of CANDIDATES) {
                    let mod;
                    try { mod = findByProps(...props); } catch (e) {}
                    if (!mod) continue;
                    for (const fn of fns) {
                        if (typeof mod[fn] === "function") patchBlock(mod, fn);
                    }
                }
            }
            if (PROBE) {
                try { probe(); } catch (e) { logger.log("[NCA probe] failed: " + e); }
            }
        },
        onUnload() {
            for (const u of unpatches) { try { u(); } catch (e) {} }
            unpatches = [];
        },
    };
})();
