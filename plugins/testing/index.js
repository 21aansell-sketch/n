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
    const VOICE_FLAG = 1; // speaking flags: 1 = voice, 2 = soundshare, 4 = priority

    let UserStore, MediaEngineStore;
    let timer;
    const unpatches = [];
    const unregisters = [];
    const connPatches = new Map(); // voice connection -> its unpatch functions
    const logged = new Set();

    const myId = () => UserStore?.getCurrentUser?.()?.id;

    // Logs the arguments of a method the first time it is called, so the real
    // signatures show up in the Kettu logs.
    function logOnce(name, args) {
        if (logged.has(name)) return;
        logged.add(name);
        try {
            log.log(`Hide Speaking: ${name} called with`, JSON.stringify(args).slice(0, 300));
        } catch (_) {
            log.log(`Hide Speaking: ${name} called (args not printable)`);
        }
    }

    // Your own screen: Discord reports who is talking with a "SPEAKING" action that
    // carries the user and a flag. Zeroing it for your own user stops the green ring.
    function onDispatch([action]) {
        if (!storage.hide || action?.type !== "SPEAKING" || !action.speakingFlags) return;
        const me = myId();
        if (me && action.userId === me) action.speakingFlags = 0;
    }

    // Other people: the voice connection tells the server which speaking flags you use.
    // Setting them to 0 means the server never marks you as speaking.
    function zeroFlags(args) {
        if (typeof args[0] === "number") args[0] = 0;
        else if (typeof args[1] === "number" && args[0] === myId()) args[1] = 0;
    }

    function setFlags(conn, flags) {
        try {
            conn.setSpeakingFlags?.(flags);
        } catch (e) {
            log.error("Hide Speaking: setSpeakingFlags failed", e);
        }
    }

    function patchConnection(conn) {
        if (!conn || connPatches.has(conn)) return;
        const undo = [];
        const hook = (name, fn) => {
            if (typeof conn[name] === "function") undo.push(before(name, conn, fn));
        };
        hook("setSpeakingFlags", args => {
            logOnce("setSpeakingFlags", args);
            if (storage.hide) zeroFlags(args);
        });
        hook("handleSpeakingNative", args => logOnce("handleSpeakingNative", args));
        hook("handleSpeakingFlags", args => logOnce("handleSpeakingFlags", args));
        connPatches.set(conn, undo);
        log.log("Hide Speaking: patched a voice connection");
        if (storage.hide) setFlags(conn, 0);
    }

    // Voice connections only exist while you're in a call, so keep checking for new ones.
    function scan() {
        try {
            const conns = MediaEngineStore?.getMediaEngine?.()?.connections;
            if (conns) for (const c of conns) patchConnection(c);
            for (const [c, undo] of connPatches) {
                if (conns?.has?.(c)) continue;
                undo.forEach(u => u());
                connPatches.delete(c);
            }
        } catch (e) {
            log.error("Hide Speaking: scan failed", e);
        }
    }

    function makeCommand() {
        return {
            name: "hidespeaking",
            displayName: "hidespeaking",
            description: "Hide your speaking indicator. Optionally pass on or off",
            displayDescription: "Hide your speaking indicator. Optionally pass on or off",
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

                scan();
                for (const conn of connPatches.keys()) setFlags(conn, storage.hide ? 0 : VOICE_FLAG);

                showToast(
                    `Speaking indicator ${storage.hide ? "hidden" : "shown again"}` +
                    (connPatches.size ? "" : ". Not in a call, applies when you join one")
                );
            }
        };
    }

    // Writes the voice connection's function names to the Kettu logs.
    function debugConnections() {
        try {
            scan();
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
            showToast(`${conns.length} voice connection(s), ${connPatches.size} patched. Details are in the Kettu logs`);
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

            scan();
            timer = setInterval(scan, 2000);

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
            clearInterval(timer);
            unregisters.splice(0).forEach(u => u?.());
            unpatches.splice(0).forEach(u => u());
            for (const [conn, undo] of connPatches) {
                undo.forEach(u => u());
                if (storage.hide) setFlags(conn, VOICE_FLAG);
            }
            connPatches.clear();
        }
    };
})()
