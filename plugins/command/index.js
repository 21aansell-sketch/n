(function () {
    // Kettu/Vendetta evaluates this file as a single expression, so no `export`
    // or top-level statements: everything lives inside this function.
    // Stops "/ba" from silently turning into the closest command. A command is
    // only used when you tap it, or when what you typed is the full name.
    //
    // Written without access to Discord's current internals, so the module
    // lookups below are best guesses. Set DEBUG = true and check the logs if
    // nothing seems to change.
    const { metro, patcher, logger } = vendetta;
    const { findByProps } = metro;

    const DEBUG = false;

    // [props used to find the module, function names to patch]
    const CANDIDATES = [
        [["getActiveCommand"], ["getActiveCommand"]],
        [["getCommandFromText"], ["getCommandFromText"]],
        [["getMatchingCommand"], ["getMatchingCommand"]],
        [["autocompleteCommand"], ["autocompleteCommand"]],
        [["getAutocompleteCommand"], ["getAutocompleteCommand"]],
        [["parseCommand", "queryCommands"], ["parseCommand"]],
    ];

    let unpatches = [];

    // The command name the user actually typed: text after "/" up to the first space.
    function typedName(args) {
        const text = args.find(a => typeof a === "string");
        if (!text || text[0] !== "/") return null;
        return text.slice(1).split(/\s/)[0].toLowerCase();
    }

    function cmdName(result) {
        const c = result && result.command ? result.command : result;
        return String((c && (c.displayName || c.name)) || "").toLowerCase();
    }

    function patchFn(mod, fn) {
        // `instead` so we can really return nothing (an `after` patch can't).
        unpatches.push(
            patcher.instead(fn, mod, (args, orig) => {
                const result = orig(...args);
                if (!result) return result;
                const typed = typedName(args);
                if (typed == null) return result; // not typed text, e.g. user tapped a command
                if (cmdName(result) === typed) return result; // full name typed, allow
                if (DEBUG) logger.log(`[NoCommandAutofill] blocked ${fn}: "${typed}" -> "${cmdName(result)}"`);
                return undefined;
            })
        );
    }

    return {
        onLoad() {
            for (const [props, fns] of CANDIDATES) {
                let mod;
                try { mod = findByProps(...props); } catch (e) {}
                if (!mod) continue;
                for (const fn of fns) {
                    if (typeof mod[fn] !== "function") continue;
                    if (DEBUG) logger.log(`[NoCommandAutofill] patching ${fn}`);
                    patchFn(mod, fn);
                }
            }
            if (DEBUG && !unpatches.length) logger.log("[NoCommandAutofill] no candidate modules found");
        },
        onUnload() {
            for (const u of unpatches) u();
            unpatches = [];
        },
    };
})();
