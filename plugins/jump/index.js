(function () {
    const { metro, patcher, ui } = vendetta;
    const { React, ReactNative } = metro.common;
    const { findByProps, findByName, findByStoreName } = metro;
    const { View, Pressable, Text } = ReactNative;

    const RestAPI = findByProps("getAPIBaseURL", "get");
    const MessageActions = findByProps("jumpToMessage");
    const SelectedChannelStore = findByStoreName("SelectedChannelStore");

    const unpatches = [];
    let busy = false;

    async function jumpToTop() {
        if (busy) return;
        busy = true;
        try {
            const channelId = SelectedChannelStore.getChannelId();
            if (!channelId) return;

            // after=0 returns the very first message in the channel / DM
            const res = await RestAPI.get({
                url: `/channels/${channelId}/messages`,
                query: { after: "0", limit: 1 }
            });
            const first = res?.body?.[0];
            if (!first) {
                ui.toasts.showToast("No messages found");
                return;
            }

            MessageActions.jumpToMessage({
                channelId,
                messageId: first.id,
                flash: true,
                jumpType: "ANIMATED"
            });
        } catch (e) {
            console.error("[JumpToTop]", e);
            ui.toasts.showToast("Couldn't jump to the top");
        } finally {
            busy = false;
        }
    }

    function TopButton() {
        return React.createElement(
            View,
            {
                pointerEvents: "box-none",
                style: { position: "absolute", right: 12, bottom: 56 }
            },
            React.createElement(
                Pressable,
                {
                    onPress: jumpToTop,
                    hitSlop: 8,
                    style: {
                        width: 40,
                        height: 40,
                        borderRadius: 20,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: "#5865F2",
                        elevation: 4,
                        shadowColor: "#000",
                        shadowOpacity: 0.3,
                        shadowRadius: 4,
                        shadowOffset: { width: 0, height: 2 }
                    }
                },
                React.createElement(Text, { style: { color: "#fff", fontSize: 20, fontWeight: "bold" } }, "\u2191")
            )
        );
    }

    // Component names the "jump to bottom" bar has gone by; the first one found gets patched.
    const CANDIDATES = ["JumpToPresentBar", "ChannelJumpToPresent", "JumpToPresentButton", "JumpToBottom"];

    return {
        onLoad() {
            for (const name of CANDIDATES) {
                const mod = findByName(name, false);
                if (!mod || typeof mod.default !== "function") continue;

                unpatches.push(
                    patcher.after("default", mod, (_args, ret) => {
                        // Only add our button while the jump-to-bottom button is actually showing
                        if (!ret) return ret;
                        return React.createElement(React.Fragment, null, ret, React.createElement(TopButton));
                    })
                );
                console.log("[JumpToTop] patched " + name);
                return;
            }
            console.error("[JumpToTop] couldn't find the jump-to-bottom component");
            ui.toasts.showToast("Jump to Top: couldn't find the jump button");
        },
        onUnload() {
            for (const unpatch of unpatches) unpatch();
            unpatches.length = 0;
        }
    };
})()
