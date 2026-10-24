// No Command Autofill
// Stops "/ba" (or "/ba ") from silently turning into the closest command.
// A command is only used when you tap it in the list, or when what you typed
// matches the full command name exactly.
//
// NOTE: written without access to Discord's current internals, so the module
// lookups below are best guesses. Turn on "debug" by setting DEBUG = true and
// check the logs if nothing seems to change.

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

const unpatches = [];

// The command name the user actually typed: text after "/" up to the first space.
function typedName(args) {
    const text = args.find(a => typeof a === "string");
    if (!text || text[0] !== "/") return null;
    return text.slice(1).split(/\s/)[0].toLowerCase();
}

function cmdName(result) {
    const c = result?.command ?? result;
    return (c?.displayName ?? c?.name ?? "").toLowerCase();
}

function patchFn(mod, fn) {
    unpatches.push(
        patcher.after(fn, mod, (args, result) => {
            if (!result) return result;
            const typed = typedName(args);
            if (typed == null) return result; // not typed text, e.g. user tapped a command
            if (cmdName(result) === typed) return result; // full name typed, allow
            if (DEBUG) logger.log(`[NoCommandAutofill] blocked ${fn}: "${typed}" -> "${cmdName(result)}"`);
            return undefined;
        })
    );
}

export default {
    onLoad() {
        for (const [props, fns] of CANDIDATES) {
            let mod;
            try { mod = findByProps(...props); } catch {}
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
        for (const u of unpatches.splice(0)) u();
    },
};
