(function (exports, metro, patcher, plugin) {
    "use strict";

    const { findByProps, findByStoreName } = metro;
    const { storage } = plugin;

    // Gain in decibels. 100 dB = 10^(100/20) = 100,000x amplitude.
    const DEFAULT_GAIN_DB = 100;
    // Discord's input volume is a percentage where 100 = unity gain (1x).
    const dbToVolume = (db) => 100 * Math.pow(10, db / 20);

    let unpatches = [];
    let previousVolume = 100;

    function getGainDb() {
        const v = Number(storage.gainDb);
        return Number.isFinite(v) ? v : DEFAULT_GAIN_DB;
    }

    function getEngine() {
        try {
            const store = findByStoreName("MediaEngineStore");
            return store?.getMediaEngine?.() ?? null;
        } catch {
            return null;
        }
    }

    function applyBoost() {
        const volume = dbToVolume(getGainDb());
        const engine = getEngine();
        if (engine?.setInputVolume) {
            engine.setInputVolume(volume);
        } else {
            const actions = findByProps("setInputVolume");
            actions?.setInputVolume?.(volume);
        }
    }

    function restore() {
        const engine = getEngine();
        if (engine?.setInputVolume) {
            engine.setInputVolume(previousVolume);
        } else {
            const actions = findByProps("setInputVolume");
            actions?.setInputVolume?.(previousVolume);
        }
    }

    var index = {
        onLoad() {
            if (storage.gainDb === undefined) storage.gainDb = DEFAULT_GAIN_DB;

            try {
                const store = findByStoreName("MediaEngineStore");
                const current = store?.getInputVolume?.();
                if (typeof current === "number" && current > 0 && current <= 100) {
                    previousVolume = current;
                }
            } catch {}

            // Keep the boost applied when Discord or the user sets the input volume.
            const actions = findByProps("setInputVolume");
            if (actions) {
                unpatches.push(
                    patcher.before("setInputVolume", actions, (args) => {
                        const requested = args[0];
                        if (typeof requested === "number" && requested <= 100) {
                            previousVolume = requested;
                        }
                        args[0] = dbToVolume(getGainDb());
                        return args;
                    })
                );
            }

            applyBoost();
        },
        onUnload() {
            for (const unpatch of unpatches) unpatch();
            unpatches = [];
            restore();
        }
    };

    exports.default = index;
    Object.defineProperty(exports, "__esModule", { value: true });
    return exports;
})({}, vendetta.metro, vendetta.patcher, vendetta.plugin);
