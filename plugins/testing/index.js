(() => {
    const { findByProps, findByStoreName } = vendetta.metro;
    const { FluxDispatcher: CommonDispatcher } = vendetta.metro.common;
    const { registerCommand } = vendetta.commands;
    const { showToast } = vendetta.ui.toasts;
    const { before } = vendetta.patcher;
    const { storage } = vendetta.plugin;
    const log = vendetta.logger;

    const STRING = 3; // ApplicationCommandOptionType.STRING
    const ON_WORDS = ["on", "true", "yes", "1", "enable"];
    const OFF_WORDS = ["off", "false", "no", "0", "disable"];

    let UserStore, MediaEngineStore;
    const unpatches = [];
    const unregisters = [];

    // Discord reports who is talking with a "SPEAKING" action that carries the user and a
    // speaking flag. Zeroing the flag for your own user stops the green ring on your side.
    function onDispatch([action]) {
        if (!storage.hide || action?.type !== "SPEAKING" || !action.speakingFlags) return;
        const me = UserStore?.getCurrentUser?.()?.id;
        if (me && action.userId === me) action.speakingFlags = 0;
    }

    function makeCommand() {
        return {
            name: "hidespeaking",
            displayName: "hidespeaking",
            description: "Hide your own speaking indicator. Optionally pass on or off",
            displayDescription: "Hide your own speaking indicator. Optionally pass on or off",
            options: [{
                name: "state",
                displayName: "state",
                description: "on or off (leave empty to toggle)",
                displayDescription: "on or off (leave empty to toggle)",
                type: STRING,
                required: false
            }],
            execute(args) {
                const raw = args?.find(a => a?.name === "state")?.value;
                const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";

                if (!value) storage.hide = !storage.hide;
                else if (ON_WORDS.includes(value)) storage.hide = true;
                else if (OFF_WORDS.includes(value)) storage.hide = false;
                else return void showToast("Use /hidespeaking on, /hidespeaking off, or just /hidespeaking to toggle");

                showToast(`Speaking indicator ${storage.hide ? "hidden" : "shown again"}`);
            }
        };
    }

    // Writes what the voice connection exposes to the Kettu logs, to help find a way
    // to stop the indicator for other people too.
    function debugConnections() {
        try {
            const engine = MediaEngineStore?.getMediaEngine?.();
            const conns = engine?.connections ? [...engine.connections] : [];
            const info = conns.map(c => {
                const names = new Set(Object.keys(c));
                for (let p = Object.getPrototypeOf(c); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
                    Object.getOwnPropertyNames(p).forEach(n => names.add(n));
                }
                return [...names].filter(n => typeof c[n] === "function").sort();
            });
            log.log("Hide Speaking: voice connections", JSON.stringify(info));
            showToast(`Found ${conns.length} voice connection(s), details are in the Kettu logs`);
        } catch (e) {
            log.error("Hide Speaking: debug failed", e);
            showToast("Debug failed, check the Kettu logs");
        }
    }

    return {
        onLoad() {
            UserStore = findByStoreName("UserStore");
            MediaEngineStore = findByStoreName("MediaEngineStore");
            if (storage.hide === undefined) storage.hide = true;

            const dispatcher = CommonDispatcher ?? findByProps("dispatch", "subscribe");
            if (dispatcher?.dispatch) {
                unpatches.push(before("dispatch", dispatcher, onDispatch));
            } else {
                log.error("Hide Speaking: couldn't find the Flux dispatcher");
            }

            unregisters.push(registerCommand(makeCommand()));
            unregisters.push(registerCommand({
                name: "speakingdebug",
                displayName: "speakingdebug",
                description: "Log the voice connection's functions to the Kettu logs",
                displayDescription: "Log the voice connection's functions to the Kettu logs",
                options: [],
                execute: debugConnections
            }));
        },
        onUnload() {
            unregisters.splice(0).forEach(u => u?.());
            unpatches.splice(0).forEach(u => u());
        }
    };
})()
