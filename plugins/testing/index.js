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
    let timer;
    let rtcConn = null; // the JS voice connection for the current call
    let rtcUndo = [];
    const unpatches = [];
    const unregisters = [];
    const logged = new Map();

    const myId = () => UserStore?.getCurrentUser?.()?.id;

    // Logs a method's arguments its first few times it is called, so the real
    // signatures show up in the Kettu logs.
    function logOnce(name, args) {
        const n = logged.get(name) ?? 0;
        if (n >= 3) return;
        logged.set(name, n + 1);
        try {
            log.log(`Hide Speaking: ${name} called with`, JSON.stringify(args).slice(0, 300));
        } catch (_) {
            log.log(`Hide Speaking: ${name} called (args not printable)`);
        }
    }

    // YOUR SCREEN. Discord reports who is talking with a "SPEAKING" action that carries
    // the user and a flag. Zeroing it for your own user stops the ring on your side.
    function onDispatch([action]) {
        if (!storage.hide || action?.type !== "SPEAKING" || !action.speakingFlags) return;
        const me = myId();
        if (me && action.userId === me) action.speakingFlags = 0;
    }

    // OTHER PEOPLE (experimental). The JS voice connection's sendSpeaking tells the voice
    // server you're talking. Testing showed that sending 0 hides your ring but also stops
    // other people hearing you, so the default is 1 (unchanged). /speakingvalue lets you try
    // other values (2 = soundshare, 4 = priority). A "stopped speaking" 0 is never changed.
    function rewriteSpeaking(args) {
        const value = Number.isInteger(storage.value) ? storage.value : 1;
        if (value === 1) return;
        const first = args[0];
        if (typeof first === "number") {
            if (first !== 0) args[0] = value;
        } else if (typeof first === "boolean") {
            if (first && value === 0) args[0] = false;
        } else if (first && typeof first === "object" && "speaking" in first) {
            if (first.speaking) first.speaking = value;
        }
    }

    function patchRtc(rtc) {
        const undo = [];
        if (typeof rtc.sendSpeaking === "function") {
            undo.push(before("sendSpeaking", rtc, args => {
                logOnce("sendSpeaking", args);
                rewriteSpeaking(args);
            }));
        }
        rtcConn = rtc;
        rtcUndo = undo;
        log.log(`Hide Speaking: patched the RTC connection (sendSpeaking ${typeof rtc.sendSpeaking})`);
    }

    function currentRtc() {
        const store = findByStoreName("RTCConnectionStore");
        const channelId = findByStoreName("SelectedChannelStore")?.getVoiceChannelId?.();
        let rtc = null;
        try { rtc = store?.getRTCConnection?.(channelId); } catch (_) { /* try without an id */ }
        if (!rtc) {
            try { rtc = store?.getRTCConnection?.(); } catch (_) { /* not in a call */ }
        }
        return rtc && typeof rtc === "object" ? rtc : null;
    }

    // The voice connection only exists while you're in a call, so keep checking for a new one.
    function scan() {
        try {
            const rtc = currentRtc();
            if (rtc === rtcConn) return;
            rtcUndo.forEach(u => u());
            rtcUndo = [];
            rtcConn = null;
            if (rtc) patchRtc(rtc);
        } catch (e) {
            log.error("Hide Speaking: scan failed", e);
        }
    }

    function hideCommand() {
        const description = "Hide your speaking ring on your own screen. Optionally pass on or off";
        return {
            name: "hidespeaking",
            displayName: "hidespeaking",
            description,
            displayDescription: description,
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

                showToast(storage.hide ? "Speaking ring hidden on your screen" : "Speaking ring shown again on your screen");
            }
        };
    }

    function valueCommand() {
        const description = "Experimental: what other people see when you talk. 1 is normal, 0 hides it but cuts your audio";
        return {
            name: "speakingvalue",
            displayName: "speakingvalue",
            description,
            displayDescription: description,
            options: [{
                name: "value",
                displayName: "value",
                description: "0 to 7, or reset",
                displayDescription: "0 to 7, or reset",
                type: STRING,
                required: true
            }],
            execute(args) {
                const raw = args?.find(a => a?.name === "value")?.value;
                const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";

                if (value === "reset") storage.value = 1;
                else if (/^[0-7]$/.test(value)) storage.value = Number(value);
                else return void showToast("Use /speakingvalue 2, /speakingvalue 4, or /speakingvalue reset");

                scan();
                showToast(
                    storage.value === 1
                        ? "Other people see your ring normally"
                        : `Sending speaking value ${storage.value} to others. Applies the next time you talk` +
                          (rtcConn ? "" : ". Not in a call yet")
                );
            }
        };
    }

    function methodsOf(obj) {
        const names = new Set(Object.keys(obj));
        for (let p = Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
            Object.getOwnPropertyNames(p).forEach(n => names.add(n));
        }
        return [...names].filter(n => {
            try { return typeof obj[n] === "function"; } catch (_) { return false; }
        }).sort();
    }

    // Writes the JS voice connection's function names to the Kettu logs.
    function debugRtc() {
        const out = {};
        try {
            const rtc = currentRtc();
            if (rtc) {
                out.connection = methodsOf(rtc);
                out.connectionKeys = Object.keys(rtc);
            }
            out.patched = !!rtcConn;
        } catch (e) {
            out.error = String(e);
        }
        log.log("Hide Speaking: rtc debug", JSON.stringify(out));
        showToast(out.connection
            ? "Found the RTC connection, details are in the Kettu logs"
            : "No RTC connection found, details are in the Kettu logs");
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

            unregisters.push(registerCommand(hideCommand()));
            unregisters.push(registerCommand(valueCommand()));
            const text = "Log the voice RTC connection's functions to the Kettu logs";
            unregisters.push(registerCommand({
                name: "rtcdebug", displayName: "rtcdebug", description: text, displayDescription: text,
                options: [], execute: debugRtc
            }));
        },
        onUnload() {
            clearInterval(timer);
            rtcUndo.forEach(u => u());
            rtcUndo = [];
            rtcConn = null;
            unregisters.splice(0).forEach(u => u?.());
            unpatches.splice(0).forEach(u => u());
        }
    };
})()
