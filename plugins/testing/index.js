(() => {
    const { findByProps, findByStoreName } = vendetta.metro;
    const { registerCommand } = vendetta.commands;
    const { showToast } = vendetta.ui.toasts;
    const { storage } = vendetta.plugin;
    const log = vendetta.logger;

    const STRING = 3; // ApplicationCommandOptionType.STRING
    const MAX_DB = 30; // speech is already hard-clipped well before this, so more only adds distortion
    const OFF_WORDS = ["off", "reset", "none", "default", "clear", "0"];

    let MediaEngineStore, SelectedChannelStore, Actions;
    let timer;
    const unregisters = [];

    // Discord's input volume is a percentage where 100 is unchanged, so +20 dB = 1000%.
    const dbToPercent = db => 100 * Math.pow(10, db / 20);
    const engine = () => MediaEngineStore?.getMediaEngine?.() ?? null;
    const currentVolume = () => {
        try { return MediaEngineStore?.getInputVolume?.(); } catch (_) { return undefined; }
    };

    // Sets the volume straight on the audio engine. Discord's own store holds the input
    // volume at 100%, so going through it (the setInputVolume action) can't boost.
    function setEngineVolume(percent) {
        try {
            const e = engine();
            if (typeof e?.setInputVolume === "function") {
                e.setInputVolume(percent);
                return true;
            }
        } catch (err) {
            log.error("Mic Boost: engine.setInputVolume failed", err);
        }
        return false;
    }

    function applyBoost() {
        if (!(storage.db > 0)) return false;
        return setEngineVolume(dbToPercent(storage.db));
    }

    function restoreVolume() {
        const original = typeof storage.original === "number" ? storage.original : 100;
        const direct = setEngineVolume(original);
        try { Actions?.setInputVolume?.(original); } catch (_) { /* the store value was never changed */ }
        return direct;
    }

    function boostCommand() {
        const description = `Boost your microphone volume by this many dB (0 to ${MAX_DB}), or off to reset`;
        return {
            name: "micboost",
            displayName: "micboost",
            description,
            displayDescription: description,
            options: [{
                name: "db",
                displayName: "db",
                description: `Number of dB (0 to ${MAX_DB}), or off`,
                displayDescription: `Number of dB (0 to ${MAX_DB}), or off`,
                type: STRING,
                required: true
            }],
            execute(args) {
                const raw = args?.find(a => a?.name === "db")?.value;
                const value = typeof raw === "string" ? raw.trim().toLowerCase().replace(/db$/, "").trim() : "";

                if (OFF_WORDS.includes(value)) {
                    const ok = restoreVolume();
                    delete storage.db;
                    delete storage.original;
                    return void showToast(ok ? "Mic boost off, input volume restored" : "Mic boost off. Couldn't reach the audio engine, check /micdebug");
                }

                const parsed = parseFloat(value);
                if (!Number.isFinite(parsed) || parsed < 0) {
                    return void showToast(`Use /micboost <dB from 0 to ${MAX_DB}>, or /micboost off`);
                }
                const db = Math.min(parsed, MAX_DB);

                // Remember the normal volume the first time, so turning the boost off puts it back.
                if (typeof storage.original !== "number") {
                    const now = currentVolume();
                    storage.original = typeof now === "number" ? now : 100;
                }
                storage.db = db;

                if (!applyBoost()) {
                    return void showToast("Couldn't reach the audio engine's input volume. Run /micdebug and check the Kettu logs");
                }
                showToast(
                    `Mic boost ${db} dB (${Math.round(dbToPercent(db))}%) sent to the audio engine` +
                    (parsed > MAX_DB ? `, capped at ${MAX_DB}` : "")
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

    // Writes the volume-related functions Discord exposes to the Kettu logs.
    function debugCommand() {
        const description = "Log the microphone volume functions to the Kettu logs";
        return {
            name: "micdebug",
            displayName: "micdebug",
            description,
            displayDescription: description,
            options: [],
            execute() {
                const out = { storeInputVolume: currentVolume(), savedOriginal: storage.original, boostDb: storage.db };
                try {
                    const interesting = /volume|gain|input|agc|automatic/i;
                    const pick = obj => (obj ? methodsOf(obj).filter(n => interesting.test(n)) : null);
                    out.store = pick(MediaEngineStore);
                    out.actions = pick(Actions);
                    out.engine = pick(engine());
                } catch (e) {
                    out.error = String(e);
                }
                log.log("Mic Boost: debug", JSON.stringify(out));
                showToast("Details are in the Kettu logs");
            }
        };
    }

    return {
        onLoad() {
            MediaEngineStore = findByStoreName("MediaEngineStore");
            SelectedChannelStore = findByStoreName("SelectedChannelStore");
            Actions = findByProps("setInputVolume");

            applyBoost();
            // Discord pushes its own 100% back to the engine now and then (joining a call, for
            // example), so while you're in a call the boost is set again every few seconds.
            timer = setInterval(() => {
                if (storage.db > 0 && SelectedChannelStore?.getVoiceChannelId?.()) applyBoost();
            }, 3000);

            unregisters.push(registerCommand(boostCommand()));
            unregisters.push(registerCommand(debugCommand()));
        },
        onUnload() {
            clearInterval(timer);
            unregisters.splice(0).forEach(u => u?.());
            // Put the normal volume back; the saved boost comes back when the plugin is turned on again.
            if (storage.db > 0) restoreVolume();
        }
    };
})()
