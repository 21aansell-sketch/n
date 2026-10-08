// Device Indicator - shows which platform(s) a user is online on:
// PC, Mobile, Web, PS5 and VR.
//
//  - A small badge appears next to the user's name on their profile.
//  - /device <user> also prints the details in chat (only you see it).
//
// Discord only exposes this through presence data:
//  - client_status: { desktop, mobile, web, embedded }   -> PC / Mobile / Web / Console
//  - activities[].platform: "ps5", "ps4", "xbox", ...    -> which console
//  - VR has no official flag, so it is guessed from activity names.
(function () {
    const { findByProps, findByName, findByStoreName } = vendetta.metro;
    const { React, ReactNative } = vendetta.metro.common;
    const { registerCommand } = vendetta.commands;
    const { after } = vendetta.patcher;
    const { showToast } = vendetta.ui.toasts;

    const cleanups = [];

    const VR_HINTS = [
        "vrchat", "quest", "oculus", "meta quest", "steamvr", "vr", "rec room",
        "beat saber", "pavlov", "bonelab", "boneworks", "resonite", "neos",
        "chilloutvr", "half-life: alyx", "population: one", "gorilla tag",
        "blade & sorcery", "vivecraft", "virtual desktop", "bigscreen",
    ];

    function getStores() {
        return {
            presence: findByStoreName("PresenceStore"),
            users: findByStoreName("UserStore"),
        };
    }

    function looksLikeVR(activity) {
        const haystack = [activity.name, activity.platform, activity.details, activity.state]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
        return VR_HINTS.some((hint) => {
            if (hint === "vr") return /(^|[^a-z])vr([^a-z]|$)/.test(haystack);
            return haystack.includes(hint);
        });
    }

    // Returns { status, devices: [{ key, icon, label, detail }] }
    function detect(userId) {
        const { presence } = getStores();
        if (!presence || !userId) return { status: "offline", devices: [] };

        const status = presence.getStatus ? presence.getStatus(userId) : "offline";
        const client = (presence.getClientStatus && presence.getClientStatus(userId)) || {};
        const activities = (presence.getActivities && presence.getActivities(userId)) || [];
        const devices = [];

        if (client.desktop) devices.push({ key: "pc", icon: "🖥️", label: "PC", detail: client.desktop });
        if (client.mobile) devices.push({ key: "mobile", icon: "📱", label: "Mobile", detail: client.mobile });
        if (client.web) devices.push({ key: "web", icon: "🌐", label: "Web", detail: client.web });

        const platforms = new Set();
        for (const a of activities) {
            if (a && a.platform) platforms.add(String(a.platform).toLowerCase());
        }
        if (platforms.has("ps5")) devices.push({ key: "ps5", icon: "🎮", label: "PS5" });
        else if (platforms.has("ps4")) devices.push({ key: "ps4", icon: "🎮", label: "PS4" });
        if (platforms.has("xbox")) devices.push({ key: "xbox", icon: "🎮", label: "Xbox" });
        if (client.embedded && !devices.some((d) => ["ps5", "ps4", "xbox"].includes(d.key))) {
            devices.push({ key: "console", icon: "🎮", label: "Console" });
        }

        if (activities.some((a) => a && looksLikeVR(a))) {
            devices.push({ key: "vr", icon: "🥽", label: "VR", detail: "guessed" });
        }

        return { status, devices };
    }

    function format(user, info) {
        const name = user ? user.username : "that user";
        if (!info.devices.length || info.status === "offline") {
            return `**${name}** appears offline (or their presence is hidden), so no device is visible.`;
        }
        const list = info.devices.map((d) => (d.detail ? `${d.label} (${d.detail})` : d.label));
        return `**${name}** is on: ${list.join(", ")}\nStatus: ${info.status}`;
    }

    function reply(channelId, text) {
        const actions = findByProps("sendBotMessage");
        if (actions && channelId) actions.sendBotMessage(channelId, text);
        else showToast(text.replace(/\*\*/g, ""));
    }

    // Badge component: re-renders whenever presence changes.
    function DeviceBadge(props) {
        const [, force] = React.useReducer((x) => x + 1, 0);

        React.useEffect(() => {
            const { presence } = getStores();
            if (!presence || !presence.addChangeListener) return;
            presence.addChangeListener(force);
            return () => presence.removeChangeListener(force);
        }, []);

        const info = detect(props.userId);
        if (!info.devices.length || info.status === "offline") return null;

        const text = info.devices.map((d) => `${d.icon} ${d.label}`).join("  ");
        return React.createElement(
            ReactNative.View,
            { style: { marginLeft: 8, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, backgroundColor: "rgba(128,128,128,0.25)" } },
            React.createElement(ReactNative.Text, { style: { fontSize: 12, color: "#ccc" }, numberOfLines: 1 }, text)
        );
    }

    function patchProfileName() {
        // Try the profile name components used by different Discord builds.
        const candidates = ["UserProfileName", "ProfileName", "UserProfileHeaderName"];
        let patched = false;

        for (const name of candidates) {
            const mod = findByName(name, false);
            if (!mod || typeof mod.default !== "function") continue;

            const unpatch = after("default", mod, (args, ret) => {
                const p = (args && args[0]) || {};
                const userId = (p.user && p.user.id) || p.userId;
                if (!userId || !ret) return ret;

                return React.createElement(
                    ReactNative.View,
                    { style: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" } },
                    ret,
                    React.createElement(DeviceBadge, { userId })
                );
            });
            cleanups.push(unpatch);
            patched = true;
            break;
        }

        if (!patched) {
            showToast("Device Indicator: couldn't find the profile name component. /device still works.");
        }
    }

    function registerDeviceCommand() {
        cleanups.push(
            registerCommand({
                name: "device",
                displayName: "device",
                description: "See what device a user is on (PC, Mobile, Web, PS5, VR)",
                displayDescription: "See what device a user is on (PC, Mobile, Web, PS5, VR)",
                applicationId: "-1",
                inputType: 1,
                type: 1,
                options: [
                    {
                        name: "user",
                        displayName: "user",
                        description: "The user to check",
                        displayDescription: "The user to check",
                        type: 6,
                        required: true,
                    },
                ],
                execute(args, ctx) {
                    const opt = args.find((a) => a.name === "user");
                    const userId = opt && opt.value;
                    const { users } = getStores();
                    const user = users && users.getUser ? users.getUser(userId) : null;
                    reply(ctx && ctx.channel && ctx.channel.id, format(user, detect(userId)));
                },
            })
        );
    }

    return {
        onLoad() {
            try { registerDeviceCommand(); } catch (e) { console.error("[DeviceIndicator] command", e); }
            try { patchProfileName(); } catch (e) {
                showToast("Device Indicator: profile patch failed");
                console.error("[DeviceIndicator] patch", e);
            }
        },
        onUnload() {
            for (const c of cleanups) {
                try { c(); } catch (e) { /* ignore */ }
            }
            cleanups.length = 0;
        },
    };
})();
