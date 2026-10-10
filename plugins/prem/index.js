(function () {
    const { findByProps, findByName, findByStoreName } = vendetta.metro;
    const { after, before } = vendetta.patcher;
    const { React, ReactNative } = vendetta.metro.common;
    const { findInReactTree } = vendetta.utils;
    const { getAssetIDByName } = vendetta.ui.assets;
    const { showToast } = vendetta.ui.toasts;

    const h = React.createElement;
    const { View, Text, Image } = ReactNative;

    const patches = [];
    const GROUP_KEY = "permission-viewer-group";
    const MENU_LABEL = "User Permissions";

    // ---------------------------------------------------------------------
    // Permissions (Discord's documented bit positions)
    // ---------------------------------------------------------------------
    const PERMISSIONS = [
        ["Create Invite", 0], ["Kick Members", 1], ["Ban Members", 2], ["Administrator", 3],
        ["Manage Channels", 4], ["Manage Server", 5], ["Add Reactions", 6], ["View Audit Log", 7],
        ["Priority Speaker", 8], ["Video", 9], ["View Channels", 10], ["Send Messages", 11],
        ["Send Text-to-Speech Messages", 12], ["Manage Messages", 13], ["Embed Links", 14],
        ["Attach Files", 15], ["Read Message History", 16], ["Mention @everyone, @here, and All Roles", 17],
        ["Use External Emoji", 18], ["View Server Insights", 19], ["Connect", 20], ["Speak", 21],
        ["Mute Members", 22], ["Deafen Members", 23], ["Move Members", 24], ["Use Voice Activity", 25],
        ["Change Nickname", 26], ["Manage Nicknames", 27], ["Manage Roles", 28], ["Manage Webhooks", 29],
        ["Manage Expressions", 30], ["Use Application Commands", 31], ["Request to Speak", 32],
        ["Manage Events", 33], ["Manage Threads", 34], ["Create Public Threads", 35],
        ["Create Private Threads", 36], ["Use External Stickers", 37], ["Send Messages in Threads", 38],
        ["Use Activities", 39], ["Timeout Members", 40], ["View Creator Monetization Analytics", 41],
        ["Use Soundboard", 42], ["Create Expressions", 43], ["Create Events", 44],
        ["Use External Sounds", 45], ["Send Voice Messages", 46], ["Create Polls", 49],
        ["Use External Apps", 50],
    ].map(([name, bit]) => ({ name, flag: BigInt(1) << BigInt(bit) }));

    const hasFlag = (flags, flag) => (BigInt(flags ?? 0) & flag) === flag;
    const namesFor = flags => PERMISSIONS.filter(p => hasFlag(flags, p.flag)).map(p => p.name);

    function resolveOverwrite(overwrite) {
        return { allow: namesFor(overwrite.allow), deny: namesFor(overwrite.deny) };
    }

    const isRoleOverwrite = o => o.type === 0 || o.type === "role";
    const isMemberOverwrite = o => o.type === 1 || o.type === "member";

    // ---------------------------------------------------------------------
    // Lazily resolved modules (filled in by onLoad)
    // ---------------------------------------------------------------------
    let Design, LazyActionSheet, ChannelStore, GuildRoleStore, GuildMemberStore, UserStore;
    let useStateFromStores, UserActions;

    function openSheet(Component, key, props, stack) {
        LazyActionSheet.openLazy(
            Promise.resolve({ default: Component }),
            key,
            props,
            stack ? "stack" : undefined,
        );
    }

    // ---------------------------------------------------------------------
    // Components
    // ---------------------------------------------------------------------
    function PermissionRow({ label, enabled }) {
        const icon = h(Image, {
            source: getAssetIDByName(enabled ? "Check" : "ic_close_16px"),
            style: { width: 20, height: 20 },
            tintColor: enabled ? "#43b581" : "#f04747",
        });
        return h(Design.TableRow, { label, trailing: icon });
    }

    function Sheet({ title, leading, children }) {
        return h(
            Design.ActionSheet,
            null,
            h(Design.BottomSheetTitleHeader, { title, leading }),
            children,
        );
    }

    function avatarIcon(user, guildId) {
        let uri;
        try {
            uri = user.getAvatarURL?.(guildId, 32);
        } catch {}
        if (!uri) return undefined;
        return h(Image, {
            source: { uri },
            style: { width: 24, height: 24, borderRadius: 12 },
        });
    }

    function roleColor(role) {
        return role?.color ? `#${role.color.toString(16).padStart(6, "0")}` : "#99aab5";
    }

    function RoleChip({ role }) {
        const color = roleColor(role);
        return h(
            View,
            {
                style: {
                    flexDirection: "row",
                    alignItems: "center",
                    borderWidth: 1,
                    borderColor: color,
                    borderRadius: 8,
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                },
            },
            h(Text, { style: { color, fontSize: 12 } }, role.name),
        );
    }

    function OverwriteRows({ overwrite }) {
        const { allow, deny } = resolveOverwrite(overwrite);
        return h(
            Design.ActionSheetRow.Group,
            { title: "Overwrites" },
            allow.map(p => h(PermissionRow, { key: `a-${p}`, label: p, enabled: true })),
            deny.map(p => h(PermissionRow, { key: `d-${p}`, label: p, enabled: false })),
            allow.length === 0 && deny.length === 0
                ? h(Design.ActionSheetRow, { label: "No overwrites." })
                : null,
        );
    }

    function ServerRolesSheet({ guild }) {
        const roles = GuildRoleStore.getSortedRoles(guild.id);
        return h(
            Sheet,
            { title: `Roles for ${guild.name}` },
            h(
                Design.ActionSheetRow.Group,
                null,
                roles.map(role =>
                    h(Design.ActionSheetRow, {
                        key: role.id,
                        label: role.name,
                        onPress: () =>
                            openSheet(RolePermissionsSheet, `role-permissions-${role.id}`, { role }, true),
                    }),
                ),
            ),
        );
    }

    function RolePermissionsSheet({ role }) {
        const names = namesFor(role.permissions);
        return h(
            Sheet,
            { title: `Added Permissions for ${role.name}` },
            h(
                Design.ActionSheetRow.Group,
                null,
                names.length > 0
                    ? names.map(p => h(PermissionRow, { key: p, label: p, enabled: true }))
                    : h(Design.ActionSheetRow, { label: "This role adds no permissions." }),
            ),
        );
    }

    function RoleOverwritesSheet({ role, overwrite }) {
        return h(
            Sheet,
            { title: `Permission Overwrites for ${role.name}` },
            h(OverwriteRows, { overwrite }),
        );
    }

    function MemberOverwritesSheet({ name, overwrite }) {
        return h(
            Sheet,
            { title: `Permission Overwrites for ${name}` },
            h(OverwriteRows, { overwrite }),
        );
    }

    function ChannelOverwritesSheet({ channelId }) {
        const channel = ChannelStore.getChannel(channelId);
        const guildId = channel.guild_id;

        const roleById = {};
        for (const role of GuildRoleStore.getSortedRoles(guildId)) roleById[role.id] = role;

        const overwrites = Object.values(channel.permissionOverwrites ?? {});
        const roleOverwrites = overwrites.filter(isRoleOverwrite);
        const memberOverwrites = overwrites.filter(isMemberOverwrite);

        const users = useStateFromStores(
            [UserStore, GuildMemberStore],
            () => memberOverwrites.map(o => UserStore.getUser(o.id)),
            [channelId],
            (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
        );

        React.useEffect(() => {
            for (const o of memberOverwrites) {
                if (!UserStore.getUser(o.id)) {
                    try {
                        UserActions?.getUser?.(o.id)?.catch?.(() => {});
                    } catch {}
                }
            }
        }, [channelId]);

        const nameOf = (user, id) => {
            const member = GuildMemberStore.getMember(guildId, id);
            return member?.nick ?? user.globalName ?? user.username;
        };

        const loaded = memberOverwrites
            .map((overwrite, i) => ({ overwrite, user: users[i] }))
            .filter(x => x.user);

        return h(
            Sheet,
            { title: `Permission Overwrites for ${channel.name}` },
            overwrites.length === 0
                ? h(
                      Design.ActionSheetRow.Group,
                      null,
                      h(Design.ActionSheetRow, {
                          label: "No permission overwrites",
                          subLabel: "This channel uses this server's default permissions.",
                      }),
                  )
                : null,
            roleOverwrites.length > 0
                ? h(
                      Design.ActionSheetRow.Group,
                      { title: "Role Overwrites" },
                      roleOverwrites.map(overwrite => {
                          const role = roleById[overwrite.id];
                          if (!role) return null;
                          return h(Design.ActionSheetRow, {
                              key: overwrite.id,
                              label: role.name,
                              onPress: () =>
                                  openSheet(
                                      RoleOverwritesSheet,
                                      `role-overwrites-${role.id}`,
                                      { role, overwrite },
                                      true,
                                  ),
                          });
                      }),
                  )
                : null,
            memberOverwrites.length > 0
                ? h(
                      Design.ActionSheetRow.Group,
                      { title: "Member Overwrites" },
                      loaded.map(({ overwrite, user }) => {
                          const name = nameOf(user, overwrite.id);
                          return h(Design.ActionSheetRow, {
                              key: overwrite.id,
                              icon: avatarIcon(user, guildId),
                              label: name,
                              onPress: () =>
                                  openSheet(
                                      MemberOverwritesSheet,
                                      `member-overwrites-${user.id}`,
                                      { overwrite, name },
                                      true,
                                  ),
                          });
                      }),
                      loaded.length < memberOverwrites.length
                          ? h(Design.ActionSheetRow, { label: "Loading members..." })
                          : null,
                  )
                : null,
        );
    }

    function UserPermissionsSheet({ user, guildId }) {
        const member = GuildMemberStore.getMember(guildId, user.id);
        if (!member) {
            return h(
                Sheet,
                { title: user.globalName ?? user.username },
                h(
                    Design.ActionSheetRow.Group,
                    null,
                    h(Design.ActionSheetRow, { label: "This user isn't a member of this server." }),
                ),
            );
        }

        const name = member.nick ?? user.globalName ?? user.username;
        const roles = [guildId, ...member.roles]
            .map(id => GuildRoleStore.getRole(guildId, id))
            .filter(Boolean);

        let combined = BigInt(0);
        for (const role of roles) combined |= BigInt(role.permissions ?? 0);

        return h(
            Sheet,
            { title: name, leading: avatarIcon(user, guildId) },
            h(
                View,
                { style: { flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 16 } },
                roles.map(role => h(RoleChip, { key: role.id, role })),
            ),
            h(
                Design.ActionSheetRow.Group,
                null,
                PERMISSIONS.map(p =>
                    h(PermissionRow, { key: p.name, label: p.name, enabled: hasFlag(combined, p.flag) }),
                ),
            ),
        );
    }

    // ---------------------------------------------------------------------
    // Patches
    // ---------------------------------------------------------------------
    const DEBUG = true;
    const log = (...a) => console.log("[PermissionViewer]", ...a);
    const toast = msg => {
        try {
            showToast(`Permission Viewer: ${msg}`, getAssetIDByName("Small"));
        } catch {}
    };

    const isElement = n => !!n && typeof n === "object" && !!n.$$typeof;
    const nameOf = n => n?.type?.displayName ?? n?.type?.name ?? "";

    function looksLikeGroup(item) {
        if (!isElement(item)) return false;
        const t = item.type;
        if (t && (t === Design.ActionSheetRow?.Group || t === Design.TableRowGroup)) return true;
        return /Group/.test(nameOf(item));
    }

    // Depth-first walk over a React element tree. visit(array, element) is called
    // with the array for arrays and the element for elements; return true to stop.
    function walkTree(node, visit, seen = new Set(), depth = 0) {
        if (!node || typeof node !== "object" || depth > 40 || seen.has(node)) return false;
        seen.add(node);
        if (Array.isArray(node)) {
            if (visit(node, null)) return true;
            return node.some(c => walkTree(c, visit, seen, depth + 1));
        }
        if (!isElement(node)) return false;
        if (visit(null, node)) return true;
        const props = node.props ?? {};
        for (const key of Object.keys(props)) {
            const v = props[key];
            if (v && typeof v === "object" && walkTree(v, visit, seen, depth + 1)) return true;
        }
        return false;
    }

    function outline(node, depth = 0) {
        if (depth > 5 || node == null) return "";
        const pad = "  ".repeat(depth);
        if (Array.isArray(node)) {
            return `${pad}[array ${node.length}]\n` + node.map(c => outline(c, depth + 1)).join("");
        }
        if (!isElement(node)) return `${pad}${typeof node}\n`;
        return `${pad}<${nameOf(node) || typeof node.type}>\n` + outline(node.props?.children, depth + 1);
    }

    // Returns true when the group was inserted (or was already present).
    function insertGroup(res, group) {
        let done = false;

        // 1) An array of action-row groups: put ours first.
        walkTree(res, arr => {
            if (arr && arr.length && arr.some(looksLikeGroup)) {
                if (!arr.some(c => c?.key === GROUP_KEY)) arr.unshift(group);
                return (done = true);
            }
            return false;
        });
        if (done) return true;

        // 2) The ActionSheet element itself: prepend to its children.
        walkTree(res, (_, el) => {
            if (el && el.type === Design.ActionSheet) {
                const kids = el.props.children;
                const arr = Array.isArray(kids) ? kids : kids == null ? [] : [kids];
                if (arr.some(c => c?.key === GROUP_KEY)) return (done = true);
                try {
                    el.props.children = [group, ...arr];
                    done = true;
                } catch {}
                return done;
            }
            return false;
        });
        if (done) return true;

        // 3) Any View with array children.
        const container = findInReactTree(
            res,
            n => n?.type?.displayName === "View" && Array.isArray(n?.props?.children),
        );
        if (container) {
            const children = container.props.children;
            if (!children.some(c => c?.key === GROUP_KEY)) children.unshift(group);
            return true;
        }

        return false;
    }

    // Pull a render function out of a function / forwardRef / memo component type.
    function renderFnOf(type) {
        if (typeof type === "function") return type.prototype?.isReactComponent ? null : type;
        if (type && typeof type === "object") {
            if (typeof type.render === "function") return type.render;
            if (type.type) return renderFnOf(type.type);
        }
        return null;
    }

    const wrapCache = new WeakMap();

    // Try to insert `group` into `res`. If the sheet's real content is rendered one
    // component deeper, wrap that component so we can edit what it returns.
    // Returns the tree to render, or null if nothing worked.
    function inject(res, group, depth = 0) {
        if (!res) return null;
        if (insertGroup(res, group)) return res;
        if (depth >= 5 || !isElement(res)) return null;

        const render = renderFnOf(res.type);
        if (!render) return null;

        let Wrapped = wrapCache.get(res.type);
        if (!Wrapped) {
            Wrapped = function PermissionViewerWrapped(allProps) {
                const { __pvGroup, __pvDepth, ...rest } = allProps;
                const out = render(rest, null);
                const injected = inject(out, __pvGroup, __pvDepth);
                return injected ?? out;
            };
            wrapCache.set(res.type, Wrapped);
        }

        return h(Wrapped, { ...res.props, key: res.key, __pvGroup: group, __pvDepth: depth + 1 });
    }

    const SHEET_RULES = [
        {
            match: /^GuildActionSheet/,
            build(props) {
                const guild = props?.guild;
                if (!guild) return null;
                return h(
                    Design.ActionSheetRow.Group,
                    { key: GROUP_KEY },
                    h(Design.ActionSheetRow, {
                        label: "Server Roles",
                        onPress: () =>
                            openSheet(ServerRolesSheet, `guild-roles-${guild.id}`, { guild }, true),
                    }),
                );
            },
        },
        {
            match: /^ChannelLongPress/,
            build(props) {
                const channelId = props?.channelId;
                const channel = channelId && ChannelStore.getChannel(channelId);
                if (!channel || channel.isDM?.() || !channel.guild_id) return null;
                return h(
                    Design.ActionSheetRow.Group,
                    { key: GROUP_KEY },
                    h(Design.ActionSheetRow, {
                        label: "Channel Permissions",
                        icon: h(Design.TableRowIcon ?? View, {
                            source: getAssetIDByName("ShieldIcon") ?? getAssetIDByName("ic_shield"),
                        }),
                        onPress: () =>
                            openSheet(
                                ChannelOverwritesSheet,
                                `channel-overwrites-${channelId}`,
                                { channelId },
                                true,
                            ),
                    }),
                );
            },
        },
    ];

    function patchActionSheets() {
        const patched = new WeakSet();

        patches.push(
            before("openLazy", LazyActionSheet, ([component, key]) => {
                if (!component || typeof component.then !== "function") return;

                component
                    .then(instance => {
                        if (!instance?.default || patched.has(instance)) return;

                        const name = instance.default.displayName ?? instance.default.name ?? "";
                        const rule = SHEET_RULES.find(r => r.match.test(String(key)) || r.match.test(name));
                        if (!rule) return;

                        if (DEBUG) log("matched sheet", key, name);
                        patched.add(instance);
                        patches.push(
                            after("default", instance, ([props], res) => {
                                try {
                                    const group = rule.build(props);
                                    if (!group) return;

                                    const out = inject(res, group);
                                    if (out) {
                                        if (DEBUG) log(`sheet "${key}" patched`);
                                        return out;
                                    }

                                    log("no insertion point; tree outline:\n" + outline(res));
                                    toast(`couldn't add button (root: ${nameOf(res) || typeof res?.type})`);
                                } catch (e) {
                                    console.error("[PermissionViewer] sheet patch failed", e);
                                    toast(`error patching sheet: ${e?.message ?? e}`);
                                }
                            }),
                        );
                    })
                    .catch(() => {});
            }),
        );
    }

    function patchUserProfileMenu() {
        const mod = findByName("UserProfileOverflowMenu", false);
        if (!mod) return console.warn("[PermissionViewer] UserProfileOverflowMenu not found");

        patches.push(
            after("default", mod, ([props], res) => {
                try {
                    if (!props?.channel) return;
                    const user = props.user;
                    const guildId = props.displayProfile?.guildId ?? props.channel.guild_id;
                    if (!user || !guildId) return;

                    const menu = findInReactTree(res, n => n?.props?.items);
                    const items = menu?.props?.items?.[0];
                    if (!Array.isArray(items) || items.some(i => i?.label === MENU_LABEL)) return;

                    items.push({
                        label: MENU_LABEL,
                        action() {
                            openSheet(UserPermissionsSheet, `user-permissions-${user.id}`, { user, guildId });
                        },
                    });
                } catch (e) {
                    console.error("[PermissionViewer] profile patch failed", e);
                }
            }),
        );
    }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------
    return {
        onLoad() {
            try {
                Design =
                    findByProps("ActionSheetRow", "BottomSheetTitleHeader") ??
                    findByProps("ActionSheetRow", "ActionSheet") ??
                    findByProps("ActionSheetRow");
                LazyActionSheet = findByProps("openLazy", "hideActionSheet");
                ChannelStore = findByStoreName("ChannelStore");
                GuildRoleStore = findByStoreName("GuildRoleStore");
                GuildMemberStore = findByStoreName("GuildMemberStore");
                UserStore = findByStoreName("UserStore");
                useStateFromStores = findByProps("useStateFromStores")?.useStateFromStores;
                UserActions = findByProps("fetchProfile", "getUser");

                const missing = Object.entries({
                    Design,
                    LazyActionSheet,
                    ChannelStore,
                    GuildRoleStore,
                    GuildMemberStore,
                    UserStore,
                    useStateFromStores,
                })
                    .filter(([, v]) => !v)
                    .map(([k]) => k);

                if (missing.length) {
                    log("missing modules:", missing.join(", "));
                    toast(`missing modules: ${missing.join(", ")}`);
                    return;
                }

                if (DEBUG) {
                    log("Design exports:", Object.keys(Design).join(", "));
                }

                patchActionSheets();
                patchUserProfileMenu();
                toast("loaded");
            } catch (e) {
                console.error("[PermissionViewer] onLoad failed", e);
                toast(`failed to load: ${e?.message ?? e}`);
            }
        },

        onUnload() {
            for (const unpatch of patches.splice(0)) {
                try {
                    unpatch();
                } catch {}
            }
        },
    };
})()
