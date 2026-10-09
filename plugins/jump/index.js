(function () {
    const { metro, patcher, ui } = vendetta;
    const { React, ReactNative } = metro.common;
    const { findByProps, findByStoreName } = metro;
    const { View, Pressable, Text, ScrollView, StyleSheet } = ReactNative;

    const RestAPI = findByProps("getAPIBaseURL", "get");
    const MessageActions = findByProps("jumpToMessage");
    const SelectedChannelStore = findByStoreName("SelectedChannelStore");

    const unpatches = [];
    let busy = false;
    let inside = false; // guards against re-entering our own element creation
    let announced = false;
    const seen = new Map(); // debug: label -> info about elements with jump-ish labels

    const OUR_LABEL = "Go to first message";
    // The jump-to-bottom button's accessibility label (English UI).
    const STRONG_RE = /(jump|go|scroll|back).{0,10}(to )?.{0,6}(present|bottom|latest|newest|recent|end)/i;
    const WEAK_RE = /jump|bottom|present|latest|scroll|newest/i;
    const BUTTON_SIZE = 40;
    const GAP = 12;

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

    function makeButton(extraStyle) {
        return React.createElement(
            Pressable,
            {
                onPress: jumpToTop,
                hitSlop: 8,
                accessibilityLabel: OUR_LABEL,
                accessibilityRole: "button",
                style: [
                    {
                        width: BUTTON_SIZE,
                        height: BUTTON_SIZE,
                        borderRadius: BUTTON_SIZE / 2,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: "#5865F2",
                        elevation: 4,
                        shadowColor: "#000",
                        shadowOpacity: 0.3,
                        shadowRadius: 4,
                        shadowOffset: { width: 0, height: 2 }
                    },
                    extraStyle
                ]
            },
            React.createElement(Text, { style: { color: "#fff", fontSize: 20, fontWeight: "bold" } }, "↑")
        );
    }

    function flatStyle(style) {
        try {
            return StyleSheet.flatten(style) || {};
        } catch {
            return {};
        }
    }

    function record(label, el) {
        if (seen.size >= 40 && !seen.has(label)) return;
        const s = flatStyle(el.props.style);
        const info = seen.get(label) ?? { count: 0 };
        info.count++;
        info.type = typeof el.type === "string" ? el.type : el.type?.displayName || el.type?.name || "anonymous";
        info.style = JSON.stringify({ position: s.position, top: s.top, bottom: s.bottom, left: s.left, right: s.right, w: s.width, h: s.height });
        seen.set(label, info);
    }

    // Wrap the jump-to-bottom element so our button sits right above it.
    function addButton(el) {
        const s = flatStyle(el.props.style);
        let ours;
        if (s.position === "absolute") {
            // The original floats at a fixed spot: put ours at the same spot, one step further up.
            const offset = BUTTON_SIZE + GAP;
            const pos = { position: "absolute" };
            if (s.right != null) pos.right = s.right;
            if (s.left != null) pos.left = s.left;
            if (typeof s.bottom === "number") pos.bottom = s.bottom + offset;
            else if (typeof s.top === "number") pos.top = s.top - offset;
            else pos.bottom = offset;
            ours = makeButton(pos);
        } else {
            // In normal flow: stack above the original; its container grows upward.
            ours = makeButton({ alignSelf: "center", marginBottom: GAP });
        }
        return React.createElement(React.Fragment, null, ours, el);
    }

    function onElement(_args, el) {
        if (inside || !el || typeof el !== "object" || !el.props) return el;
        const p = el.props;
        const label = p.accessibilityLabel ?? p["aria-label"];
        if (typeof label !== "string" || label === OUR_LABEL) return el;

        if (WEAK_RE.test(label)) record(label, el);
        if (!STRONG_RE.test(label)) return el;

        inside = true;
        try {
            if (!announced) {
                announced = true;
                ui.toasts.showToast('Jump to Top: found "' + label + '"');
            }
            return addButton(el);
        } catch (e) {
            console.error("[JumpToTop] wrap failed", e);
            return el;
        } finally {
            inside = false;
        }
    }

    function Settings() {
        const lines = [...seen.entries()].map(
            ([label, i]) => `"${label}" x${i.count} <${i.type}> ${i.style}`
        );
        return React.createElement(
            ScrollView,
            { style: { flex: 1, padding: 16 } },
            React.createElement(Text, { style: { color: "#fff", fontWeight: "bold", marginBottom: 8 } }, "Jump to Top debug"),
            React.createElement(
                Text,
                { style: { color: "#ccc", marginBottom: 8, fontSize: 12 } },
                "Elements seen with jump/bottom/scroll-style labels (open a channel and scroll up first, then reopen this page):"
            ),
            lines.length
                ? lines.map((line, i) =>
                      React.createElement(Text, { key: i, selectable: true, style: { color: "#ccc", marginBottom: 4, fontSize: 12 } }, line)
                  )
                : React.createElement(Text, { style: { color: "#ccc", fontSize: 12 } }, "(none seen yet)")
        );
    }

    return {
        onLoad() {
            const targets = [];
            const runtime = findByProps("jsx", "jsxs");
            if (runtime) {
                targets.push([runtime, "jsx"], [runtime, "jsxs"]);
                if (runtime.jsxDEV) targets.push([runtime, "jsxDEV"]);
            }
            targets.push([React, "createElement"]);

            for (const [obj, name] of targets) {
                try {
                    unpatches.push(patcher.after(name, obj, onElement));
                } catch (e) {
                    console.error("[JumpToTop] couldn't hook " + name, e);
                }
            }
            ui.toasts.showToast(`Jump to Top: hooked ${unpatches.length} render function(s). Open a channel and scroll up.`);
        },
        onUnload() {
            for (const unpatch of unpatches) unpatch();
            unpatches.length = 0;
        },
        settings: Settings
    };
})()
