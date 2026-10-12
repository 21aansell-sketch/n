(() => {
    const { findByProps, findByStoreName } = vendetta.metro;
    const { registerCommand } = vendetta.commands;
    const { showToast } = vendetta.ui.toasts;
    const { before } = vendetta.patcher;
    const { storage } = vendetta.plugin;
    const log = vendetta.logger;

    const STRING = 3; // ApplicationCommandOptionType.STRING
    const ON_WORDS = ["on", "true", "yes", "1", "enable"];
    const OFF_WORDS = ["off", "false", "no", "0", "disable"];

    let GatewayConnectionStore, MediaEngineStore, SelectedChannelStore, ChannelStore;
    const unpatches = [];
    const unregisters = [];

    const getSocket = () => GatewayConnectionStore?.getSocket?.() ?? null;

    // Reports video as enabled to Discord without starting local camera capture.
    function onVoiceStateUpdate([state]) {
        if (!state || typeof state !== "object" || !storage.fakeVideo) return;
        return [{ ...state, selfVideo: true }];
    }

    // Re-send the current voice state so the reported video flag updates immediately.
    function resend() {
        const socket = getSocket();
        const channelId = SelectedChannelStore?.getVoiceChannelId?.();
        if (!socket?.voiceStateUpdate || !channelId) return false;

        const channel = ChannelStore?.getChannel?.(channelId);
        try {
            socket.voiceStateUpdate({
                guildId: channel?.guild_id ?? channel?.guildId ?? null,
                channelId,
                selfMute: !!MediaEngineStore?.isSelfMute?.(),
                selfDeaf: !!MediaEngineStore?.isSelfDeaf?.(),
                selfVideo: !!MediaEngineStore?.isVideoEnabled?.() || !!storage.fakeVideo
            });
            return true;
        } catch (e) {
            log.error("Fake Video: failed to resend voice state", e);
            return false;
        }
    }

    function makeCommand() {
        return {
            name: "fakevideo",
            displayName: "fakevideo",
            description: "Toggle fake video. Optionally pass on or off",
            displayDescription: "Toggle fake video. Optionally pass on or off",
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

                let next;
                if (!value) next = !storage.fakeVideo;
                else if (ON_WORDS.includes(value)) next = true;
                else if (OFF_WORDS.includes(value)) next = false;
                else return void showToast("Use /fakevideo on, /fakevideo off, or just /fakevideo to toggle");

                storage.fakeVideo = next;
                const sent = resend();
                const inCall = !!SelectedChannelStore?.getVoiceChannelId?.();

                showToast(
                    `Fake video ${next ? "on" : "off"}` +
                    (!inCall ? ". Applies next time you join a call" : sent ? "" : ". Couldn't refresh now, it applies on your next voice-state update")
                );
            }
        };
    }

    return {
        onLoad() {
            GatewayConnectionStore = findByStoreName("GatewayConnectionStore");
            MediaEngineStore = findByStoreName("MediaEngineStore");
            SelectedChannelStore = findByStoreName("SelectedChannelStore");
            ChannelStore = findByStoreName("ChannelStore");

            if (!GatewayConnectionStore) {
                GatewayConnectionStore = findByProps("getSocket") ?? null;
            }

            const socket = getSocket();
            // Patch the prototype so it keeps working after the gateway reconnects with a new socket.
            const proto = socket ? Object.getPrototypeOf(socket) : null;
            if (proto && typeof proto.voiceStateUpdate === "function") {
                unpatches.push(before("voiceStateUpdate", proto, onVoiceStateUpdate));
            } else if (socket && typeof socket.voiceStateUpdate === "function") {
                unpatches.push(before("voiceStateUpdate", socket, onVoiceStateUpdate));
            } else {
                log.error("Fake Video: couldn't find the gateway voiceStateUpdate function");
            }

            unregisters.push(registerCommand(makeCommand()));
        },
        onUnload() {
            unregisters.splice(0).forEach(u => u?.());
            unpatches.splice(0).forEach(u => u());
            if (storage.fakeVideo) {
                storage.fakeVideo = false;
                resend();
            }
        }
    };
})()
