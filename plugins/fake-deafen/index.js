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

    // Overwrites what Discord tells the server about your mute/deafen state.
    // Your real state is untouched, so you keep hearing and (for mute) can keep talking locally.
    function onVoiceStateUpdate([state]) {
        if (!state || typeof state !== "object") return;
        if (!storage.fakeMute && !storage.fakeDeafen) return;

        const selfDeaf = !!state.selfDeaf || !!storage.fakeDeafen;
        // Being deafened always shows as muted too, same as the real thing.
        const selfMute = !!state.selfMute || !!storage.fakeMute || selfDeaf;
        return [{ ...state, selfMute, selfDeaf }];
    }

    // Sends the current voice state again so the change shows up right away,
    // instead of waiting until the next time you really mute/unmute.
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
                selfVideo: !!MediaEngineStore?.isVideoEnabled?.()
            });
            return true;
        } catch (e) {
            log.error("Fake Voice State: failed to resend voice state", e);
            return false;
        }
    }

    function makeCommand(name, key, label) {
        return {
            name,
            displayName: name,
            description: `Toggle ${label}. Optionally pass on or off`,
            displayDescription: `Toggle ${label}. Optionally pass on or off`,
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
                if (!value) next = !storage[key];
                else if (ON_WORDS.includes(value)) next = true;
                else if (OFF_WORDS.includes(value)) next = false;
                else return void showToast(`Use /${name} on, /${name} off, or just /${name} to toggle`);

                storage[key] = next;
                const sent = resend();
                const inCall = !!SelectedChannelStore?.getVoiceChannelId?.();

                showToast(
                    `${label[0].toUpperCase()}${label.slice(1)} ${next ? "on" : "off"}` +
                    (!inCall ? ". Applies next time you join a call" : sent ? "" : ". Couldn't refresh now, it applies on your next mute/unmute")
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
                const fallback = findByProps("getSocket");
                GatewayConnectionStore = fallback ?? null;
            }

            const socket = getSocket();
            // Patch the prototype so it keeps working after the gateway reconnects with a new socket.
            const proto = socket ? Object.getPrototypeOf(socket) : null;
            if (proto && typeof proto.voiceStateUpdate === "function") {
                unpatches.push(before("voiceStateUpdate", proto, onVoiceStateUpdate));
            } else if (socket && typeof socket.voiceStateUpdate === "function") {
                unpatches.push(before("voiceStateUpdate", socket, onVoiceStateUpdate));
            } else {
                log.error("Fake Voice State: couldn't find the gateway voiceStateUpdate function");
            }

            unregisters.push(registerCommand(makeCommand("fakemute", "fakeMute", "fake mute")));
            unregisters.push(registerCommand(makeCommand("fakedeafen", "fakeDeafen", "fake deafen")));
        },
        onUnload() {
            unregisters.splice(0).forEach(u => u?.());
            unpatches.splice(0).forEach(u => u());
            // With the patch gone this sends your real state, so you don't stay stuck looking muted.
            if (storage.fakeMute || storage.fakeDeafen) resend();
        }
    };
})()
