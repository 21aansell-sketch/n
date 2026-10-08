(function () {
    // NOTE: no comments before this line (the loader does `return <code>`).
    //
    // Device Indicator: shows PC / Mobile / Web / PS5 / VR next to names.
    //  - Chat: appended to the author name of each message.
    //  - Profile: badge next to the name on the profile screen.
    //  - /device <user>: details in chat. /devicedebug: shows what got patched.
    // Data comes from presence: client_status (desktop/mobile/web/embedded) and
    // activities[].platform (ps5/xbox...). VR is guessed from activity names.
    const { findByProps, findByName, findByStoreName } = vendetta.metro;
    const { React, ReactNative } = vendetta.metro.common;
    const { registerCommand } = vendetta.commands;
    const { before, after } = vendetta.patcher;
    const { showToast } = vendetta.ui.toasts;

    const cleanups = [];
    const report = { chat: "not patched", profile: "not patched", profileMatches: [] };

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
            .filter(Boolean).join(" ").toLowerCase();
        return VR_HINTS.some((hint) => {
            if (hint === "vr") return /(^|[^a-z])vr([^a-z]|$)/.test(haystack);
            return haystack.includes(hint);
        });
    }

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

    function iconsFor(userId) {
        const info = detect(userId);
        if (!info.devices.length || info.status === "offline") return "";
        return info.devices.map((d) => d.icon).join("");
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

    // Finds already-loaded modules whose default export is a function with a matching name.
    function scan(re) {
        const out = [];
        const mods = vendetta.metro.modules || {};
        for (const id in mods) {
            try {
                const m = mods[id];
                if (!m || !m.isInitialized) continue;
                const ex = m.publicModule && m.publicModule.exports;
                if (!ex) continue;
                const def = ex.default;
                if (typeof def !== "function") continue;
                const n = def.displayName || def.name;
                if (n && re.test(n)) out.push({ id, name: n, ex });
            } catch (e) { /* skip */ }
        }
        return out;
    }

    // ---------- Profile badge ----------
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

    function userIdFromProps(p) {
        if (!p) return null;
        return (p.user && p.user.id) || p.userId || (p.author && p.author.id) || null;
    }

    function patchProfile() {
        const exact = ["UserProfileName", "ProfileName", "UserProfileHeaderName"];
        const targets = [];

        for (const n of exact) {
            try {
                const mod = findByName(n, false);
                if (mod && typeof mod.default === "function") targets.push({ name: n, ex: mod });
            } catch (e) { /* skip */ }
        }

        const found = scan(/Profile.*(Name|PrimaryInfo|Title)|(Name|Title).*Profile/i);
        report.profileMatches = found.map((f) => f.name);
        found.sort((a, b) => (/Name$/.test(b.name) ? 1 : 0) - (/Name$/.test(a.name) ? 1 : 0));
        for (const f of found) targets.push(f);

        for (const t of targets) {
            try {
                const unpatch = after("default", t.ex, (args, ret) => {
                    const userId = userIdFromProps(args && args[0]);
                    if (!userId || !ret) return ret;
                    return React.createElement(
                        ReactNative.View,
                        { style: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" } },
                        ret,
                        React.createElement(DeviceBadge, { userId })
                    );
                });
                cleanups.push(unpatch);
                report.profile = "patched " + t.name;
                return;
            } catch (e) { /* try the next one */ }
        }
    }

    // ---------- Chat names ----------
    function patchChat() {
        const RowManager = findByName("RowManager");
        if (!RowManager || !RowManager.prototype || typeof RowManager.prototype.generate !== "function") {
            report.chat = "RowManager not found";
            return;
        }

        const unpatch = before("generate", RowManager.prototype, (args) => {
            try {
                const row = args && args[0];
                const msg = row && row.message;
                if (!msg) return;

                const userId = msg.authorId || (msg.author && msg.author.id);
                if (!userId) return;

                const key = msg.nick ? "nick" : "username";
                if (typeof msg[key] !== "string") return;

                if (!msg.__diOrig) msg.__diOrig = {};
                if (msg.__diOrig[key] === undefined) msg.__diOrig[key] = msg[key];

                const icons = iconsFor(userId);
                msg[key] = icons ? `${msg.__diOrig[key]} ${icons}` : msg.__diOrig[key];
            } catch (e) { /* never break chat rendering */ }
        });
        cleanups.push(unpatch);
        report.chat = "patched RowManager.generate";
    }

    // ---------- Commands ----------
    function registerCommands() {
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

        cleanups.push(
            registerCommand({
                name: "devicedebug",
                displayName: "devicedebug",
                description: "Show which Device Indicator patches are active",
                displayDescription: "Show which Device Indicator patches are active",
                applicationId: "-1",
                inputType: 1,
                type: 1,
                options: [],
                execute(args, ctx) {
                    const lines = [
                        "**Device Indicator debug**",
                        "Chat: " + report.chat,
                        "Profile: " + report.profile,
                        "Profile-like components found: " + (report.profileMatches.join(", ") || "none"),
                    ];
                    reply(ctx && ctx.channel && ctx.channel.id, lines.join("\n"));
                },
            })
        );
    }

    return {
        onLoad() {
            try { registerCommands(); } catch (e) { console.error("[DeviceIndicator] commands", e); }
            try { patchChat(); } catch (e) { report.chat = "error: " + e; console.error("[DeviceIndicator] chat", e); }
            try { patchProfile(); } catch (e) { report.profile = "error: " + e; console.error("[DeviceIndicator] profile", e); }

            if (report.chat.startsWith("patched") && report.profile.startsWith("patched")) return;
            showToast("Device Indicator: some patches failed. Run /devicedebug");
        },
        onUnload() {
            for (const c of cleanups) {
                try { c(); } catch (e) { /* ignore */ }
            }
            cleanups.length = 0;
        },
    };
})();
