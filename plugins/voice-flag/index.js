(() => {
    const { findByStoreName } = vendetta.metro;
    const { registerCommand } = vendetta.commands;
    const { showToast } = vendetta.ui.toasts;
    const { before } = vendetta.patcher;
    const { storage } = vendetta.plugin;
    const log = vendetta.logger;

    // Voice gateway speaking flags (documented): 1 = microphone, 2 = soundshare
    // (context audio, no speaking indicator), 4 = priority speaker.
    const FLAG_MIC = 1 << 0;
    const FLAG_SOUNDSHARE = 1 << 1;

    // Voice websocket hosts look like wss://<region>.discord.media/?v=8
    const VOICE_HOST = /^wss?:\/\/[^/]*\.discord\.media(:\d+)?\//i;
    // Cheap prefilter so only frames that might be op 5 get parsed.
    const OP5 = /"op"\s*:\s*5\b/;

    const unpatches = [];
    const unregisters = [];
    let toasted = false;
    // hosts/voiceOps are diagnostics only: hostnames and op numbers, never frame contents.
    const stats = { voiceFramesSeen: 0, speakingRewritten: 0, hosts: {}, voiceOps: {} };

    // storage.mode: "soundshare" (default) | "off" | "passthrough"
    //   soundshare  : mic flag -> soundshare flag (still flagged as sending audio, no indicator)
    //   off         : mic flag cleared entirely (EXPERIMENTAL, receivers may drop audio)
    //   passthrough : leave frames alone (useful for A/B testing)
    // storage.hideLocal: false disables hiding your own speaking ring on this device
    const getMode = () => storage.mode ?? "soundshare";

    // Takes a raw websocket frame and returns the (possibly rewritten) frame.
    function rewriteSpeakingFrame(raw, mode) {
        if (typeof raw !== "string" || mode === "passthrough") return raw;
        if (!OP5.test(raw)) return raw;
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return raw;
        }
        if (!msg || msg.op !== 5 || !msg.d || typeof msg.d.speaking !== "number") return raw;
        const flags = msg.d.speaking;
        if (!(flags & FLAG_MIC)) return raw; // not speaking, or not a mic frame
        const cleared = flags & ~FLAG_MIC;
        msg.d.speaking = mode === "off" ? cleared : cleared | FLAG_SOUNDSHARE;
        return JSON.stringify(msg);
    }

    function patchVoiceSend() {
        unpatches.push(before("send", WebSocket.prototype, function (args) {
            try {
                if (typeof this?.url !== "string") return;
                const host = /^wss?:\/\/([^/:?#]+)/i.exec(this.url)?.[1];
                if (host) stats.hosts[host] = (stats.hosts[host] ?? 0) + 1;
                if (!VOICE_HOST.test(this.url)) return;
                stats.voiceFramesSeen++;
                if (typeof args[0] === "string") {
                    const op = /"op"\s*:\s*(\d+)/.exec(args[0])?.[1];
                    if (op) stats.voiceOps[op] = (stats.voiceOps[op] ?? 0) + 1;
                }
                const out = rewriteSpeakingFrame(args[0], getMode());
                if (out === args[0]) return;
                stats.speakingRewritten++;
                if (!toasted) {
                    toasted = true;
                    log.log("Speaking Flag Rewrite: rewrote first speaking frame", args[0], "->", out);
                    showToast("Speaking Flag Rewrite: working");
                }
                return [out, ...args.slice(1)];
            } catch (e) {
                // never break the socket because of this plugin
                log.error("Speaking Flag Rewrite: send patch failed", e);
            }
        }));
    }

    // UNVERIFIED: hides only your own speaking ring on this device. The event name and
    // shape come from how Discord's desktop client dispatches SPEAKING, so it may do
    // nothing on mobile. The voice-frame rewrite above is what others see.
    function patchLocalRing() {
        if (storage.hideLocal === false) return;
        const UserStore = findByStoreName("UserStore");
        const FluxDispatcher = vendetta.metro.common?.FluxDispatcher;
        if (!UserStore || !FluxDispatcher) return;
        unpatches.push(before("dispatch", FluxDispatcher, function (args) {
            try {
                const ev = args[0];
                if (ev?.type !== "SPEAKING") return;
                const me = UserStore.getCurrentUser?.()?.id;
                if (me && ev.userId === me && ev.speakingFlags) {
                    return [{ ...ev, speakingFlags: 0 }, ...args.slice(1)];
                }
            } catch (e) {
                log.error("Speaking Flag Rewrite: local ring patch failed", e);
            }
        }));
    }

    // Lists export names containing "speak" from loaded modules, to find JS-side
    // entry points for the speaking signal if the voice socket turns out to be native.
    function scanSpeakingNames() {
        const found = new Set();
        try {
            const mods = vendetta.metro.modules;
            for (const id in mods) {
                try {
                    const m = mods[id];
                    if (!m?.isInitialized) continue;
                    const ex = m.publicModule?.exports;
                    if (!ex || (typeof ex !== "object" && typeof ex !== "function")) continue;
                    for (const target of [ex, ex.default]) {
                        if (!target || (typeof target !== "object" && typeof target !== "function")) continue;
                        for (const k of Object.keys(target)) {
                            if (/speak/i.test(k)) found.add(k);
                        }
                    }
                } catch {}
                if (found.size >= 80) break;
            }
        } catch (e) {
            log.error("Speaking Flag Rewrite: module scan failed", e);
        }
        return [...found];
    }

    const probeCommand = {
        name: "voiceprobe",
        displayName: "voiceprobe",
        description: "Show what Speaking Flag Rewrite has seen on your voice connection",
        displayDescription: "Show what Speaking Flag Rewrite has seen on your voice connection",
        options: [],
        execute() {
            const names = scanSpeakingNames();
            log.log("Speaking Flag Rewrite probe:", JSON.stringify({ ...stats, speakingNames: names }));
            const hosts = Object.keys(stats.hosts);
            showToast(
                `Voice frames seen: ${stats.voiceFramesSeen}, rewritten: ${stats.speakingRewritten}. ` +
                `Voice ops: ${JSON.stringify(stats.voiceOps)}. Sockets: ${hosts.length}. Full details in debug logs`
            );
        }
    };

    return {
        onLoad() {
            // Each step is isolated so one failing patch can't stop the plugin enabling.
            for (const step of [patchVoiceSend, patchLocalRing]) {
                try {
                    step();
                } catch (e) {
                    log.error("Speaking Flag Rewrite: " + step.name + " failed", e);
                }
            }
            try {
                unregisters.push(registerCommand(probeCommand));
            } catch (e) {
                log.error("Speaking Flag Rewrite: couldn't register /voiceprobe", e);
            }
            log.log("Speaking Flag Rewrite: loaded, mode =", getMode());
        },
        onUnload() {
            unregisters.splice(0).forEach(u => u?.());
            unpatches.splice(0).forEach(u => u());
            toasted = false;
            log.log("Speaking Flag Rewrite: unloaded", stats);
        }
    };
})()
