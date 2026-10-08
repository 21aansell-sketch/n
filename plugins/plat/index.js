// Device Indicator - shows which platform(s) a user is online on:
// Mobile, PC (desktop app), Web, PS5 and VR.
//
// Usage: type /device and pick a user. Also exposes a toast helper in settings.
//
// Discord only exposes this through presence data:
//  - client_status: { desktop, mobile, web, embedded }   -> PC / Mobile / Web / Console
//  - activities[].platform: "ps5", "ps4", "xbox", ...    -> which console
//  - VR has no official flag, so it is guessed from activity platform/app names.
(function () {
    const { findByProps, findByStoreName } = vendetta.metro;
    const { registerCommand } = vendetta.commands;
    const { showToast } = vendetta.ui.toasts;

    const unregisters = [];

    // Names / platform strings that suggest the user is in VR.
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

    function detect(userId) {
        const { presence } = getStores();
        if (!presence) return { error: "PresenceStore not found." };

        const status = presence.getStatus ? presence.getStatus(userId) : "offline";
        const client = (presence.getClientStatus && presence.getClientStatus(userId)) || {};
        const activities = (presence.getActivities && presence.getActivities(userId)) || [];

        const found = [];

        if (client.desktop) found.push(`PC (${client.desktop})`);
        if (client.mobile) found.push(`Mobile (${client.mobile})`);
        if (client.web) found.push(`Web (${client.web})`);

        // Console / "embedded" clients and activity platforms.
        const platforms = new Set();
        for (const a of activities) {
            if (a && a.platform) platforms.add(String(a.platform).toLowerCase());
        }
        if (platforms.has("ps5")) found.push("PS5");
        else if (platforms.has("ps4")) found.push("PS4");
        if (platforms.has("xbox")) found.push("Xbox");
        if (client.embedded && !platforms.has("ps5") && !platforms.has("ps4") && !platforms.has("xbox")) {
            found.push("Console (PS5/Xbox/other)");
        }

        if (activities.some((a) => a && looksLikeVR(a))) found.push("VR (guessed from activity)");

        return { status, found, activities };
    }

    function format(user, info) {
        const name = user ? user.username : "that user";
        if (info.error) return info.error;
        if (!info.found.length || info.status === "offline") {
            return `**${name}** appears offline (or their presence is hidden), so no device is visible.`;
        }
        return `**${name}** is on: ${info.found.join(", ")}\nStatus: ${info.status}`;
    }

    function reply(channelId, text) {
        const actions = findByProps("sendBotMessage");
        if (actions && channelId) {
            actions.sendBotMessage(channelId, text);
        } else {
            showToast(text.replace(/\*\*/g, ""));
        }
    }

    return {
        onLoad() {
            try {
                unregisters.push(
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
            } catch (e) {
                showToast("Device Indicator failed to register /device");
                console.error("[DeviceIndicator]", e);
            }
        },
        onUnload() {
            for (const u of unregisters) {
                try { u(); } catch (e) { /* ignore */ }
            }
            unregisters.length = 0;
        },
    };
})();
