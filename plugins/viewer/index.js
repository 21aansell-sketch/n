(function () {
    const { findByProps, findByStoreName } = vendetta.metro;
    const { after } = vendetta.patcher;
    const { findInReactTree } = vendetta.utils;
    const { showConfirmationAlert } = vendetta.ui.alerts;
    const { getAssetIDByName } = vendetta.ui.assets;
    const { React } = vendetta.metro.common;

    const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
    const ActionSheetRow = findByProps("ActionSheetRow")?.ActionSheetRow;
    const TableRow = findByProps("TableRow")?.TableRow;
    const Row = ActionSheetRow ?? TableRow;

    const ChannelStore = findByStoreName("ChannelStore");
    const GuildStore = findByStoreName("GuildStore");

    const B = (v) => {
        try { return BigInt(v ?? 0); } catch (e) { return BigInt(0); }
    };
    const ADMIN = B(8);
    const VIEW = B(1024);          // VIEW_CHANNEL (1 << 10)
    const SEND = B(2048);          // SEND_MESSAGES (1 << 11)
    const CONNECT = B(1048576);    // CONNECT (1 << 20)
    const SEND_THREAD = B(274877906944); // SEND_MESSAGES_IN_THREADS (1 << 38)

    const THREAD_TYPES = [10, 11, 12];
    const VOICE_TYPES = [2, 13];
    const CATEGORY = 4;

    const applyOverwrite = (p, o) => (o ? (p & ~B(o.deny)) | B(o.allow) : p);

    function analyze(channel) {
        const guildId = channel.guild_id;
        const isThread = THREAD_TYPES.includes(channel.type);
        // Threads inherit permissions from their parent channel
        const source = isThread ? ChannelStore.getChannel(channel.parent_id) ?? channel : channel;

        const guild = GuildStore.getGuild?.(guildId);
        const roles = GuildStore.getRoles?.(guildId) ?? guild?.roles ?? {};
        const everyone = roles[guildId];

        const roleOverwrites = new Map();
        const memberOverwrites = [];
        for (const o of Object.values(source.permissionOverwrites ?? {})) {
            if (o.type === 0 || o.type === "role") roleOverwrites.set(o.id, o);
            else memberOverwrites.push(o);
        }

        const isVoice = VOICE_TYPES.includes(channel.type);
        const isCategory = channel.type === CATEGORY;
        const sendBit = isVoice ? CONNECT : isThread ? SEND_THREAD : SEND;
        const sendLabel = isVoice ? "Connect" : "Send messages";

        const check = (role) => {
            let p = B(everyone?.permissions);
            if (role.id !== guildId) p |= B(role.permissions);
            if (p & ADMIN) return { view: true, send: true, admin: true };
            p = applyOverwrite(p, roleOverwrites.get(guildId));
            if (role.id !== guildId) p = applyOverwrite(p, roleOverwrites.get(role.id));
            const view = (p & VIEW) !== B(0);
            const send = view && (p & sendBit) !== B(0);
            return { view, send, admin: false };
        };

        const list = Object.values(roles)
            .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
            .map((role) => ({ role, ...check(role) }));

        const everyoneRes = list.find((r) => r.role.id === guildId) ?? { view: false, send: false };

        let memberView = 0, memberSend = 0, memberViewDeny = 0, memberSendDeny = 0;
        for (const o of memberOverwrites) {
            const allow = B(o.allow), deny = B(o.deny);
            if (allow & VIEW) memberView++;
            if (deny & VIEW) memberViewDeny++;
            if (allow & sendBit) memberSend++;
            if (deny & sendBit) memberSendDeny++;
        }

        return {
            guildId, list, everyoneRes, sendLabel, isCategory,
            members: { memberView, memberSend, memberViewDeny, memberSendDeny }
        };
    }

    const name = (r) => (r.role.id === r.role.guild_id || r.role.name === "@everyone" ? "@everyone" : r.role.name) + (r.role.managed ? " (bot)" : "");

    function section(title, key, data) {
        const { list, everyoneRes } = data;
        const MAX = 25;
        let out = `${title}\n`;
        if (everyoneRes[key]) {
            out += "• @everyone (any member)\n";
            const blocked = list.filter((r) => !r[key]);
            if (blocked.length) {
                out += `Blocked for: ${blocked.slice(0, MAX).map(name).join(", ")}${blocked.length > MAX ? `, +${blocked.length - MAX} more` : ""}\n`;
            }
            return out;
        }
        const allowed = list.filter((r) => r[key]);
        if (!allowed.length) return out + "• No roles\n";
        for (const r of allowed.slice(0, MAX)) {
            out += `• ${name(r)}${r.admin ? " (Administrator)" : ""}\n`;
        }
        if (allowed.length > MAX) out += `…and ${allowed.length - MAX} more\n`;
        return out;
    }

    function showPermissions(channel) {
        const data = analyze(channel);
        let content = section("👁 Can VIEW this channel:", "view", data);
        if (!data.isCategory) {
            content += "\n" + section(`💬 Can ${data.sendLabel.toUpperCase()}:`, "send", data);
        }
        const m = data.members;
        if (m.memberView + m.memberViewDeny + m.memberSend + m.memberSendDeny > 0) {
            content += `\nMember-specific overrides: view +${m.memberView}/-${m.memberViewDeny}`;
            if (!data.isCategory) content += `, ${data.sendLabel.toLowerCase()} +${m.memberSend}/-${m.memberSendDeny}`;
            content += "\n";
        }
        content += "\nAdministrator always bypasses channel overrides. Server owner not shown.";

        showConfirmationAlert({
            title: `Permissions: ${channel.name ?? "channel"}`,
            content,
            confirmText: "Close",
            cancelText: "Dismiss",
            onConfirm: () => {}
        });
    }

    const unpatches = [];

    function makeRow(channel) {
        const props = {
            label: "View Permissions",
            onPress: () => {
                try { LazyActionSheet.hideActionSheet(); } catch (e) {}
                setTimeout(() => showPermissions(channel), 250);
            }
        };
        try {
            const id = getAssetIDByName("ic_lock") ?? getAssetIDByName("ic_locked");
            if (id != null) {
                props.icon = ActionSheetRow
                    ? React.createElement(ActionSheetRow.Icon, { source: id })
                    : React.createElement(React.Fragment, null);
                if (!ActionSheetRow) delete props.icon;
            }
        } catch (e) {}
        return React.createElement(Row, props);
    }

    return {
        onLoad() {
            if (!LazyActionSheet || !Row) {
                console.error("[ChannelPermissions] Could not find action sheet modules");
                return;
            }
            unpatches.push(
                after("openLazy", LazyActionSheet, ([component, key, sheetProps]) => {
                    const k = String(key);
                    console.log("[ChannelPermissions] sheet opened:", k, Object.keys(sheetProps ?? {}));
                    if (!/channel/i.test(k) || /message|thread|voice-?user|member|user/i.test(k.replace(/channel/gi, ""))) return;
                    component.then((instance) => {
                        const unpatch = after("default", instance, (_, res) => {
                            try { React.useEffect(() => () => { unpatch(); }, []); } catch (e) {}

                            const channel =
                                sheetProps?.channel ??
                                ChannelStore.getChannel(sheetProps?.channelId ?? sheetProps?.channel?.id);
                            if (!channel?.guild_id) return; // DMs have no roles

                            const isRow = (c) =>
                                c?.props?.label !== undefined ||
                                c?.props?.children !== undefined && c?.type === Row ||
                                c?.type === ActionSheetRow ||
                                c?.type === TableRow;

                            const rows = findInReactTree(res, (x) => Array.isArray(x) && x.some(isRow));
                            const row = React.cloneElement(makeRow(channel), { key: "channel-permissions-viewer" });

                            if (rows) {
                                if (rows.some((r) => r?.key === "channel-permissions-viewer")) return;
                                rows.push(row);
                                return;
                            }

                            // Fallback: append to the root's children
                            const children = res?.props?.children;
                            if (Array.isArray(children)) {
                                if (!children.some((r) => r?.key === "channel-permissions-viewer")) children.push(row);
                            } else if (res?.props) {
                                res.props.children = [children, row];
                            }
                        });
                    });
                })
            );
        },
        onUnload() {
            for (const u of unpatches) u();
            unpatches.length = 0;
        }
    };
})()
