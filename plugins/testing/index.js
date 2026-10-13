(() => {
    const { findByProps, findByStoreName } = vendetta.metro;
    const { FluxDispatcher } = vendetta.metro.common;
    const { registerCommand } = vendetta.commands;
    const { showToast } = vendetta.ui.toasts;
    const { storage } = vendetta.plugin;
    const log = vendetta.logger;

    const STRING = 3; // ApplicationCommandOptionType.STRING
    const MAX_DB = 60; // beyond this speech is already hard-clipped, so more changes nothing
    const OFF_WORDS = ["off", "reset", "none", "default", "clear", "0"];

    let MediaEngineStore, SelectedChannelStore, Actions;
    let timer;
    let lastChannel = null;
    const unregisters = [];

    // Discord's input volume is a percentage where 100 is unchanged, so +20 dB = 1000%.
    const dbToPercent = db => 100 * Math.pow(10, db / 20);
    const engine = () => MediaEngineStore?.getMediaEngine?.() ?? null;
    const currentVolume = () => {
        try { return MediaEngineStore?.getInputVolume?.(); } catch (_) { return undefined; }
    };

    // Tries the ways Discord sets the microphone input volume, and says which one it used.
    function writeVolume(percent) {
        try {
            if (typeof Actions?.setInputVolume === "function") {
                Actions.setInputVolume(percent);
                return "MediaEngineActions.setInputVolume";
            }
        } catch (e) {
            log.error("Mic Boost: setInputVolume action failed", e);
        }
        try {
            const e = engine();
            if (typeof e?.setInputVolume === "function") {
                e.setInputVolume(percent);
                return "engine.setInputVolume";
            }
        } catch (e) {
            log.error("Mic Boost: engine.setInputVolume failed", e);
        }
        try {
            if (FluxDispatcher?.dispatch) {
                FluxDispatcher.dispatch({ type: "AUDIO_SET_INPUT_VOLUME", volume: percent });
                return "AUDIO_SET_INPUT_VOLUME action (guess)";
            }
        } catch (e) {
            log.error("Mic Boost: dispatch failed", e);
        }
        return null;
    }

    function applyBoost() {
        if (!(storage.db > 0)) return null;
        return writeVolume(dbToPercent(storage.db));
    }

    function restoreVolume() {
        const original = typeof storage.original === "number" ? storage.original : 100;
        return writeVolume(original);
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
                    const used = restoreVolume();
                    delete storage.db;
                    delete storage.original;
                    return void showToast(used ? "Mic boost off, input volume restored" : "Mic boost off. Couldn't reach the input volume, check /micdebug");
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

                const percent = dbToPercent(db);
                const used = applyBoost();
                if (!used) return void showToast("Couldn't find a way to set the input volume. Run /micdebug and check the Kettu logs");

                showToast(`Mic boost ${db} dB (${Math.round(percent)}%)` + (parsed > MAX_DB ? `, capped at ${MAX_DB}` : ""));
                // Read it back, because Discord may have limited it to a lower value.
                setTimeout(() => {
                    const now = currentVolume();
                    if (typeof now === "number" && Math.abs(now - percent) > 1) {
                        showToast(`Discord kept the input volume at ${Math.round(now)}%`);
                    }
                }, 400);
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
                const out = { inputVolume: currentVolume(), savedOriginal: storage.original, boostDb: storage.db };
                try {
                    const interesting = /volume|gain|input|agc|automatic/i;
                    const pick = obj => (obj ? methodsOf(obj).filter(n => interesting.test(n)) : null);
                    const e = engine();
                    out.store = pick(MediaEngineStore);
                    out.actions = pick(Actions);
                    out.engine = pick(e);
                    out.engineAll = e ? methodsOf(e) : null;
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
            lastChannel = SelectedChannelStore?.getVoiceChannelId?.() ?? null;
            // Joining a call can reset the input volume, so apply the boost again when the call changes.
            timer = setInterval(() => {
                const id = SelectedChannelStore?.getVoiceChannelId?.() ?? null;
                if (id === lastChannel) return;
                lastChannel = id;
                if (id) setTimeout(applyBoost, 500);
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
