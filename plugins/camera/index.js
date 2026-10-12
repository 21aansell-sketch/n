(function () {
    const { findByProps, findByStoreName } = vendetta.metro;
    const { before } = vendetta.patcher;
    const { registerCommand } = vendetta.commands;

    let unpatches = [];
    let enabled = true;

    function patchSocket() {
        const store = findByProps("getSocket");
        const socket = store?.getSocket?.();
        if (!socket) return false;

        const proto = Object.getPrototypeOf(socket);
        if (typeof proto.voiceStateUpdate !== "function") return false;

        unpatches.push(
            before("voiceStateUpdate", proto, (args) => {
                const state = args[0];
                if (enabled && state && state.channelId) state.selfVideo = true;
            })
        );
        return true;
    }

    function patchLocalView() {
        const dispatcher = findByProps("dispatch", "subscribe");
        const userStore = findByStoreName("UserStore");
        if (!dispatcher || !userStore) return false;

        unpatches.push(
            before("dispatch", dispatcher, (args) => {
                const event = args[0];
                if (!enabled || !event || event.type !== "VOICE_STATE_UPDATES") return;
                const myId = userStore.getCurrentUser?.()?.id;
                if (!myId || !Array.isArray(event.voiceStates)) return;
                for (const voiceState of event.voiceStates) {
                    if (voiceState.userId === myId) voiceState.selfVideo = false;
                }
            })
        );
        return true;
    }

    function reply(ctx, content) {
        const messages = findByProps("sendBotMessage");
        messages?.sendBotMessage?.(ctx.channel.id, content);
    }

    return {
        onLoad() {
            if (!patchSocket()) {
                console.warn("[FakeCamera] Could not find the gateway socket to patch.");
            }
            if (!patchLocalView()) {
                console.warn("[FakeCamera] Could not find the dispatcher to patch.");
            }

            unpatches.push(
                registerCommand({
                    name: "fakecamera",
                    displayName: "fakecamera",
                    description: "Toggle the fake camera icon in voice chat",
                    displayDescription: "Toggle the fake camera icon in voice chat",
                    options: [],
                    applicationId: "-1",
                    inputType: 1,
                    type: 1,
                    execute: (args, ctx) => {
                        enabled = !enabled;
                        reply(
                            ctx,
                            enabled
                                ? "Fake camera **on**. Rejoin the voice channel or toggle mute to apply."
                                : "Fake camera **off**. Rejoin the voice channel or toggle mute to apply."
                        );
                    },
                })
            );
        },
        onUnload() {
            for (const unpatch of unpatches) unpatch();
            unpatches = [];
        },
    };
})();
