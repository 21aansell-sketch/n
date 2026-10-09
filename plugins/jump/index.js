(function () {
    const { metro, patcher, ui } = vendetta;
    const { React, ReactNative } = metro.common;
    const { findByProps, findByStoreName } = metro;
    const { View, Pressable, Text } = ReactNative;

    const RestAPI = findByProps("getAPIBaseURL", "get");
    const MessageActions = findByProps("jumpToMessage");
    const SelectedChannelStore = findByStoreName("SelectedChannelStore");

    const unpatches = [];
    let busy = false;

    const NAME_RE = /jump.{0,12}(present|bottom|latest|recent)|(present|bottom).{0,12}jump/i;

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
                React.createElement(Text, { style: { color: "#fff", fontSize: 20, fontWeight: "bold" } }, "↑")
            )
        );
    }

    function nameOf(x) {
        if (!x) return "";
        return x.displayName || x.name || x.type?.displayName || x.type?.name || x.render?.displayName || x.render?.name || "";
    }

    // Scan every loaded Discord module for something named like a jump-to-bottom button.
    function findJumpComponents() {
        const found = [];
        const mods = metro.modules ?? {};
        for (const id in mods) {
            try {
                const m = mods[id];
                if (!m?.isInitialized) continue;
                const exp = m.publicModule?.exports;
                if (!exp) continue;
                for (const key of ["default", null]) {
                    const holder = key ? exp : { [""]: exp };
                    const prop = key ?? "";
                    const target = holder[prop];
                    const n = nameOf(target);
                    if (n && NAME_RE.test(n)) found.push({ holder, prop, name: n, target });
                }
            } catch {}
        }
        return found;
    }

    function wrap(ret) {
        if (!ret) return ret;
        return React.createElement(React.Fragment, null, ret, React.createElement(TopButton));
    }

    return {
        onLoad() {
            const candidates = findJumpComponents();
            console.log("[JumpToTop] candidates: " + candidates.map(c => c.name).join(", "));

            let patched = null;
            for (const c of candidates) {
                const { holder, prop, target } = c;
                try {
                    if (typeof target === "function" && key(holder, prop)) {
                        unpatches.push(patcher.after(prop, holder, (_a, ret) => wrap(ret)));
                        patched = c.name;
                    } else if (target?.type && typeof target.type === "function") {
                        // React.memo wrapper
                        unpatches.push(patcher.after("type", target, (_a, ret) => wrap(ret)));
                        patched = c.name;
                    } else if (typeof target?.render === "function") {
                        // React.forwardRef wrapper
                        unpatches.push(patcher.after("render", target, (_a, ret) => wrap(ret)));
                        patched = c.name;
                    }
                } catch (e) {
                    console.error("[JumpToTop] patch failed for " + c.name, e);
                }
                if (patched) break;
            }

            if (patched) {
                ui.toasts.showToast("Jump to Top: patched " + patched);
            } else {
                ui.toasts.showToast(
                    candidates.length
                        ? "Jump to Top: found " + candidates.map(c => c.name).join(", ") + " but couldn't patch"
                        : "Jump to Top: no jump button component found"
                );
            }
        },
        onUnload() {
            for (const unpatch of unpatches) unpatch();
            unpatches.length = 0;
        }
    };

    function key(holder, prop) {
        return holder && prop in holder && prop !== "";
    }
})()
