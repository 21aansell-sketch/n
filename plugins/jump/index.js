(function () {
    const { metro, patcher, ui } = vendetta;
    const { React, ReactNative } = metro.common;
    const { findByProps, findByStoreName } = metro;
    const { View, Pressable, Text, ScrollView } = ReactNative;

    const RestAPI = findByProps("getAPIBaseURL", "get");
    const MessageActions = findByProps("jumpToMessage");
    const SelectedChannelStore = findByStoreName("SelectedChannelStore");

    const unpatches = [];
    let busy = false;
    let report = []; // lines shown on the settings page

    // Strong match: what we expect the jump-to-bottom button to be called.
    const STRONG_RE = /jump.{0,12}(present|bottom|latest|recent|new)|scroll.{0,12}(bottom|present|latest|end)|(bottom|present|latest).{0,12}(jump|scroll)/i;
    // Weak match: only used to show candidates on the settings page.
    const WEAK_RE = /jump|scroll.?to|to.?(bottom|present|latest)|present|latest/i;

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
        if (!x || (typeof x !== "function" && typeof x !== "object")) return "";
        try {
            return x.displayName || x.name || x.type?.displayName || x.type?.name || x.render?.displayName || x.render?.name || "";
        } catch {
            return "";
        }
    }

    // Every initialized module's exports, its default export, and its named exports.
    function scan() {
        const out = [];
        const mods = metro.modules ?? {};
        for (const id in mods) {
            try {
                const m = mods[id];
                if (!m?.isInitialized) continue;
                const exp = m.publicModule?.exports;
                if (!exp) continue;

                const check = (holder, prop, target, via) => {
                    const n = nameOf(target);
                    if (n && WEAK_RE.test(n)) out.push({ holder, prop, target, name: n, via, id });
                };

                if (typeof exp === "function" || (typeof exp === "object" && (exp.type || exp.render))) {
                    check({ exp }, "exp", exp, "module");
                }
                if (exp.default) check(exp, "default", exp.default, "default");

                if (typeof exp === "object") {
                    const keys = Object.keys(exp);
                    if (keys.length <= 60) {
                        for (const k of keys) {
                            if (k === "default") continue;
                            if (WEAK_RE.test(k)) check(exp, k, exp[k], "named:" + k);
                        }
                    }
                }
            } catch {}
        }
        return out;
    }

    function wrap(ret) {
        if (!ret) return ret;
        return React.createElement(React.Fragment, null, ret, React.createElement(TopButton));
    }

    function tryPatch(c) {
        const { holder, prop, target } = c;
        try {
            if (typeof target === "function" && prop !== "exp") {
                unpatches.push(patcher.after(prop, holder, (_a, ret) => wrap(ret)));
                return true;
            }
            if (target && typeof target.type === "function") {
                unpatches.push(patcher.after("type", target, (_a, ret) => wrap(ret))); // React.memo
                return true;
            }
            if (target && typeof target.render === "function") {
                unpatches.push(patcher.after("render", target, (_a, ret) => wrap(ret))); // forwardRef
                return true;
            }
        } catch (e) {
            console.error("[JumpToTop] patch failed for " + c.name, e);
        }
        return false;
    }

    function Settings() {
        return React.createElement(
            ScrollView,
            { style: { flex: 1, padding: 16 } },
            React.createElement(Text, { style: { color: "#fff", fontWeight: "bold", marginBottom: 8 } }, "Jump to Top debug"),
            ...report.map((line, i) =>
                React.createElement(Text, { key: i, selectable: true, style: { color: "#ccc", marginBottom: 4, fontSize: 12 } }, line)
            )
        );
    }

    return {
        onLoad() {
            const found = scan();
            const strong = found.filter(c => STRONG_RE.test(c.name));

            report = [
                `strong matches: ${strong.length}`,
                ...strong.map(c => `  ${c.name} (${c.via}, module ${c.id})`),
                `weak matches: ${found.length}`,
                ...found.slice(0, 80).map(c => `  ${c.name} (${c.via}, module ${c.id})`)
            ];
            console.log("[JumpToTop]\n" + report.join("\n"));

            let patched = null;
            for (const c of strong) {
                if (tryPatch(c)) {
                    patched = c.name;
                    break;
                }
            }

            ui.toasts.showToast(
                patched
                    ? "Jump to Top: patched " + patched
                    : `Jump to Top: no jump button found (${found.length} weak matches, see plugin settings)`
            );
        },
        onUnload() {
            for (const unpatch of unpatches) unpatch();
            unpatches.length = 0;
        },
        settings: Settings
    };
})()
