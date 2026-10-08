(function () {
    // NOTE: nothing may come before this line (the loader does `return <code>`).
    //
    // Platform indicators (PC / Mobile / Web / PS5+console / VR) on status dots, DM list,
    // DM header and profiles, plus a /device command.
    // Ported from k1ngop's "platform-indicators" Revenge plugin to the Vendetta/Kettu API.
    // The "Revenge shims" section below maps the revenge.* calls the original used onto vendetta.*.
    const V = vendetta;
    const { React, ReactNative } = V.metro.common;
    const { findByProps, findByStoreName } = V.metro;
    const showToast = V.ui.toasts.showToast;

    const noop = () => {};
    const cleanups = [];
    const cleanup = (fn) => { if (typeof fn === "function") cleanups.push(fn); return fn; };
    const safely = (fn) => { try { fn(); } catch (e) {} };

    // ---------------------------------------------------------------- Revenge shims

    const Fragment = React.Fragment;
    function jsx(type, props, key) {
        return React.createElement(type, key === undefined ? props : Object.assign({}, props, { key: key }));
    }
    const jsxs = jsx;

    // Walks element trees through `props` and `children` (arrays included).
    function findInTree(node, test, depth) {
        depth = depth || 0;
        if (!node || typeof node !== "object" || depth > 80) return undefined;
        let ok = false;
        try { ok = test(node); } catch (e) {}
        if (ok) return node;
        if (Array.isArray(node)) {
            for (const child of node) {
                const r = findInTree(child, test, depth + 1);
                if (r) return r;
            }
            return undefined;
        }
        if (node.props) {
            const r = findInTree(node.props, test, depth + 1);
            if (r) return r;
        }
        return node.children ? findInTree(node.children, test, depth + 1) : undefined;
    }

    // revenge: patcher.after(parent, key, (result) => result)
    //          patcher.instead(parent, key, (args, orig) => result)
    const patcher = {
        after(parent, key, cb) {
            return V.patcher.after(key, parent, (args, ret) => cb(ret, args));
        },
        instead(parent, key, cb) {
            return V.patcher.instead(key, parent, (args, orig) => cb(args, orig));
        },
    };

    // Finds already-loaded modules matching `test` and calls `cb(module)` for each.
    // Re-scans after a few seconds to catch modules that load lazily.
    function getModules(test, cb) {
        const seen = new Set();
        function scan() {
            const mods = V.metro.modules || window.modules;
            if (!mods) return;
            for (const id in mods) {
                if (seen.has(id)) continue;
                try {
                    const m = mods[id];
                    if (!m || !m.isInitialized) continue;
                    const ex = m.publicModule && m.publicModule.exports;
                    if (!ex || (typeof ex !== "object" && typeof ex !== "function")) continue;
                    if (!test(ex)) continue;
                    seen.add(id);
                    cb(ex);
                } catch (e) {}
            }
        }
        scan();
        const timers = [setTimeout(scan, 3000), setTimeout(scan, 10000)];
        return () => timers.forEach(clearTimeout);
    }

    const storeCache = {};
    function getStore(name) {
        if (!storeCache[name]) {
            try { storeCache[name] = findByStoreName(name); } catch (e) {}
        }
        return storeCache[name];
    }
    const Stores = {
        get PresenceStore() { return getStore("PresenceStore"); },
        get SessionsStore() { return getStore("SessionsStore"); },
        get SelfPresenceStore() { return getStore("SelfPresenceStore"); },
        get UserStore() { return getStore("UserStore"); },
    };

    function onFluxEventDispatched(name, cb) {
        const d = V.metro.common.FluxDispatcher || findByProps("subscribe", "dispatch");
        if (!d || typeof d.subscribe !== "function") return noop;
        d.subscribe(name, cb);
        return () => d.unsubscribe(name, cb);
    }

    function useReRender() {
        const [, force] = React.useReducer((x) => x + 1, 0);
        return force;
    }

    let tokensModule;
    function getTokens() {
        if (tokensModule === undefined) {
            try { tokensModule = findByProps("unsafe_rawColors", "colors") || null; } catch (e) { tokensModule = null; }
        }
        return tokensModule;
    }

    function getAssetId(name) {
        try { return V.ui.assets.getAssetIDByName(name); } catch (e) { return undefined; }
    }

    function getDesign() {
        let row, group;
        try { row = findByProps("TableSwitchRow"); } catch (e) {}
        try { group = findByProps("TableRowGroup"); } catch (e) {}
        return {
            TableSwitchRow: row && row.TableSwitchRow,
            TableRowGroup: group && group.TableRowGroup,
        };
    }

    // ---------------------------------------------------------------- Module filters

    const getName = (m) => m?.name || m?.default?.name || m?.type?.name || m?.default?.type?.name || m?.render?.name || m?.default?.render?.name;
    const withExactName = (n) => (m) => getName(m) === n;
    const withDisplayNameFn = (m) => typeof m?.DisplayName === "function";
    const withStatusAvatarBundle = (m) => !!m && typeof m.Status === "function" && typeof m.Avatar !== "undefined" && typeof m.BADGE_SIZE === "number";

    function patchTarget(m) {
        if (typeof m?.default === "function") return { parent: m, key: "default" };
        if (typeof m?.default?.type === "function") return { parent: m.default, key: "type" };
        if (typeof m?.default?.render === "function") return { parent: m.default, key: "render" };
        if (typeof m?.type === "function") return { parent: m, key: "type" };
        if (typeof m?.render === "function") return { parent: m, key: "render" };
        return null;
    }

    // ---------------------------------------------------------------- Settings

    const DEFAULTS = {
        legacyEnabled: false,
        dmTopBar: false,
        userList: false,
        profileUsername: false,
        fallbackColors: false,
        experimentalStatusDot: true,
        dotYouBar: true,
        statusDotInlineRemaining: true,
    };

    const store = (V.plugin && V.plugin.storage) || {};
    for (const k in DEFAULTS) {
        if (store[k] === undefined) store[k] = DEFAULTS[k];
    }

    const listeners = new Set();
    const settings = {
        get cache() { return store; },
        use() {
            const [, force] = React.useReducer((x) => x + 1, 0);
            React.useEffect(() => {
                listeners.add(force);
                return () => listeners.delete(force);
            }, []);
            return store;
        },
    };

    const SECTION_GAP = 16;

    function set(patch) {
        const next = Object.assign({}, patch);
        if (next.legacyEnabled === true) next.experimentalStatusDot = false;
        if (next.experimentalStatusDot === true) next.legacyEnabled = false;
        Object.assign(store, next);
        listeners.forEach((f) => f());
        showToast("Reload Kettu to apply this change");
    }

    function SettingsPage() {
        const s = settings.use();
        const Design = getDesign();
        if (!Design.TableRowGroup || !Design.TableSwitchRow) {
            return jsx(ReactNative.Text, { style: { padding: 16, color: "#ccc" }, children: "Settings UI isn't available in this Kettu version." });
        }

        const dotRows = [
            ["dotYouBar", "Show platform icon in you bar status dot"],
        ];

        const legacyRows = [
            ["dmTopBar", "Show icons on the DM top bar"],
            ["userList", "Show icons on the users and DMs list"],
            ["profileUsername", "Show icons on user profiles"],
        ];

        const section = (key, props) => jsx(ReactNative.View, {
            style: { marginBottom: SECTION_GAP },
            children: jsx(Design.TableRowGroup, props),
        }, key);

        return jsxs(ReactNative.ScrollView, {
            contentContainerStyle: { paddingTop: SECTION_GAP, paddingBottom: SECTION_GAP * 2 },
            children: [
                section("dots", {
                    title: "Status Dot Indicators",
                    description: "Display platform icons directly on user status dots.",
                    children: [
                        jsx(Design.TableSwitchRow, {
                            label: "Enable status dots indicators",
                            subLabel: "Replace status dots with platform icons (Needs a reload)",
                            value: s?.experimentalStatusDot ?? true,
                            onValueChange: (v) => set({ experimentalStatusDot: v }),
                        }, "enable"),
                        ...dotRows.map(([key, label, subLabel]) =>
                            jsx(Design.TableSwitchRow, {
                                label,
                                subLabel,
                                value: s?.[key] ?? true,
                                disabled: !s?.experimentalStatusDot,
                                onValueChange: (v) => set({ [key]: v }),
                            }, key),
                        ),
                        jsx(Design.TableSwitchRow, {
                            label: "Show remaining platform icon inline with username",
                            subLabel: "Show additional platform indicators beside usernames",
                            value: s?.statusDotInlineRemaining ?? true,
                            disabled: !s?.experimentalStatusDot,
                            onValueChange: (v) => set({ statusDotInlineRemaining: v }),
                        }, "inline"),
                    ],
                }),
                section("legacy", {
                    title: "Legacy Platform Indicators",
                    description: "Show platform icons next to usernames.",
                    children: [
                        jsx(Design.TableSwitchRow, {
                            label: "Enable legacy platform indicators",
                            value: s?.legacyEnabled ?? false,
                            onValueChange: (v) => set({ legacyEnabled: v }),
                        }, "legacy"),
                        ...legacyRows.map(([key, label]) =>
                            jsx(Design.TableSwitchRow, {
                                label,
                                value: s?.[key] ?? false,
                                disabled: !s?.legacyEnabled,
                                onValueChange: (v) => set({ [key]: v }),
                            }, key),
                        ),
                    ],
                }),
                section("appearance", {
                    title: "Appearance",
                    children: [
                        jsx(Design.TableSwitchRow, {
                            label: "Theme compatibility mode",
                            value: s?.fallbackColors ?? false,
                            onValueChange: (v) => set({ fallbackColors: v }),
                        }, "fallback"),
                    ],
                }),
            ],
        });
    }

    // ---------------------------------------------------------------- Colors, assets, status data

    const FALLBACK_COLORS = { online: "#23a55a", dnd: "#f23f43", idle: "#f0b232", offline: "#80848e" };
    const STATUS_TOKENS = { online: "STATUS_ONLINE", dnd: "STATUS_DANGER", idle: "STATUS_WARNING", offline: "STATUS_OFFLINE" };

    function statusColor(status, useFallback) {
        if (useFallback) return FALLBACK_COLORS[status] ?? FALLBACK_COLORS.offline;
        try {
            const token = getTokens()?.colors?.[STATUS_TOKENS[status]];
            if (typeof token === "string") return token;
            if (typeof token?.resolve === "function") {
                const v = token.resolve();
                if (typeof v === "string") return v;
            }
        } catch (e) {}
        return FALLBACK_COLORS[status] ?? FALLBACK_COLORS.offline;
    }

    const SURFACE_TOKEN_CANDIDATES_BY_CONTEXT = {
        profile: ["BACKGROUND_FLOATING", "BACKGROUND_PRIMARY", "BACKGROUND_SECONDARY"],
        youBar: ["BACKGROUND_MOBILE_PRIMARY", "BACKGROUND_PRIMARY", "BACKGROUND_SECONDARY"],
        memberList: ["BACKGROUND_SECONDARY", "BACKGROUND_MOBILE_PRIMARY", "BACKGROUND_PRIMARY"],
        dmList: ["BACKGROUND_MOBILE_PRIMARY", "BACKGROUND_SECONDARY", "BACKGROUND_PRIMARY"],
        dmHeader: ["BACKGROUND_MOBILE_PRIMARY", "BACKGROUND_PRIMARY", "BACKGROUND_SECONDARY"],
        other: ["BACKGROUND_SECONDARY", "BACKGROUND_MOBILE_PRIMARY", "BACKGROUND_PRIMARY"],
    };
    const SURFACE_FALLBACK = { dmHeader: "#313338", dmList: "#232428", memberList: "#2b2d31", profile: "#111214", youBar: "#0e0e10" };

    function surfaceColor(context) {
        const candidates = SURFACE_TOKEN_CANDIDATES_BY_CONTEXT[context] ?? SURFACE_TOKEN_CANDIDATES_BY_CONTEXT.other;
        for (const name of candidates) {
            try {
                const token = getTokens()?.colors?.[name];
                const v = typeof token === "string" ? token : token?.resolve?.();
                if (typeof v === "string") return v;
            } catch (e) {}
        }
        return SURFACE_FALLBACK[context] ?? "#242429";
    }

    const ASSET_NAMES = {
        mobile: ["MobilePhoneIcon"],
        desktop: ["ic_monitor"],
        web: ["GlobeEarthIcon"],
        embedded: ["GameControllerIcon", "ic_playstation_device_ps5_32px"],
        vr: ["VrHeadsetIcon"],
    };

    const DOT_ASSET_NAMES = {
        mobile: ["StatusMobileOnline", ...ASSET_NAMES.mobile],
        vr: ["StatusVROnline", ...ASSET_NAMES.vr],
    };

    // Used when no icon asset can be found, so something visible still shows up.
    const EMOJI = { mobile: "📱", desktop: "🖥️", web: "🌐", embedded: "🎮", vr: "🥽" };

    function normalizePlatform(p) {
        p = String(p || "").toLowerCase();
        if (p === "ios" || p === "android") return "mobile";
        if (p === "oculus" || p === "quest" || p === "samsung_gear_vr") return "vr";
        return p;
    }

    const warnedMissingAssets = new Set();

    function findAsset(platform, forDot) {
        const key = normalizePlatform(platform);
        const names = (forDot && DOT_ASSET_NAMES[key]) || ASSET_NAMES[key] || [];
        for (const name of names) {
            const id = getAssetId(name);
            if (id) return id;
        }
        const warnKey = `${key}:${forDot ? "dot" : "inline"}`;
        if (!warnedMissingAssets.has(warnKey)) {
            warnedMissingAssets.add(warnKey);
            console.warn(`[Platform Indicators] no icon asset found for "${platform}" (tried: ${names.join(", ") || "none"}), using fallback`);
        }
    }

    function PlatformIcon({ platform, color, iconSize = 16, width = iconSize, height = iconSize, forDot = false }) {
        const assetId = findAsset(platform, forDot);
        if (!assetId) {
            const emoji = EMOJI[normalizePlatform(platform)];
            if (emoji) return jsx(ReactNative.Text, { style: { fontSize: iconSize * 0.8, marginLeft: 2 }, children: emoji });
            return jsx(ReactNative.View, { children: jsx(ReactNative.View, { style: { width: iconSize, height: iconSize, borderRadius: 100, backgroundColor: color } }) });
        }
        return jsx(ReactNative.View, { children: jsx(ReactNative.Image, { style: { width, height, tintColor: color, resizeMode: "contain" }, source: assetId }) });
    }

    let myId;

    function getOwnStatus() {
        return Stores.SelfPresenceStore?.getStatus?.() ?? Stores.PresenceStore?.getStatus?.(myId) ?? null;
    }

    function getStatuses(userId) {
        if (myId === undefined || myId === null) myId = Stores.UserStore?.getCurrentUser?.()?.id;

        if (userId === myId) {
            const sessions = Stores.SessionsStore?.getSessions?.() ?? {};
            const ownStatus = getOwnStatus();
            return Object.values(sessions).reduce((acc, s) => {
                const client = s?.clientInfo?.client;
                if (!client || client === "unknown") return acc;
                acc[normalizePlatform(client)] = ownStatus ?? s.status;
                return acc;
            }, {});
        }
        const presence = Stores.PresenceStore;
        return presence?.getState?.()?.clientStatuses?.[userId] ?? presence?.getClientStatus?.(userId);
    }

    const DOT_PRIORITY = ["desktop", "mobile", "web", "embedded", "vr"];
    const FALLBACK_ASPECT = { mobile: 0.62, vr: 1.75, desktop: 1.15, web: 1, embedded: 1.3 };
    const ART_FILL = { mobile: [0.92, 0.94], web: [0.84, 0.84] };
    const ART_GLYPH = {
        desktop: { w: 0.78, h: 0.757, dx: -0.04, dy: 0.01 },
        embedded: { w: 0.82, h: 0.79, dx: -0.028, dy: -0.02 },
        vr: { w: 0.96, aspect: 1.58, dx: 0, dy: 0 },
    };
    const RING_THICKNESS = 2;
    const CONTEXT_SHIFT = { youBar: [0, 3], memberList: [0, 3], profile: [0, 3] };
    const PLATFORM_SHIFT = { desktop: [0, 2] };
    const PLATFORM_LIST_SHIFT = { desktop: -2, embedded: -2 };
    const CONTEXT_SCALE = { profile: 1.3 };

    function pickDotPlatform(statuses) {
        return DOT_PRIORITY.find((p) => statuses[p]) ?? null;
    }

    function assetAspect(assetId, platform) {
        try {
            const { width, height } = ReactNative.Image.resolveAssetSource(assetId);
            if (width && height) return width / height;
        } catch (e) {}
        return FALLBACK_ASPECT[platform] ?? 1;
    }

    function resolveContext(size) {
        if (typeof size !== "string") return "other";
        if (size.startsWith("youBar")) return "youBar";
        if (size === "xxlarge") return "profile";
        if (size === "refreshMedium32") return "memberList";
        return "other";
    }

    function dotAllowedForContext(context) {
        if (context === "youBar") return settings.cache?.dotYouBar ?? true;
        return true;
    }

    function inlineIconsAllowed(legacyKey) {
        if (settings.cache?.legacyEnabled) return !!settings.cache?.[legacyKey];
        if (settings.cache?.experimentalStatusDot) return settings.cache?.statusDotInlineRemaining ?? true;
        return false;
    }

    function useStatusRerender(userId) {
        const rerender = useReRender();
        React.useEffect(() => {
            let mounted = true;
            let last = JSON.stringify(getStatuses(userId) ?? {});

            const refresh = () => {
                if (!mounted) return;
                const next = JSON.stringify(getStatuses(userId) ?? {});
                if (next === last) return;
                last = next;
                rerender();
            };
            const later = () => setTimeout(refresh, 0);

            const stores = [Stores.PresenceStore, Stores.SessionsStore, Stores.SelfPresenceStore].filter((s) => typeof s?.addChangeListener === "function");
            stores.forEach((s) => s.addChangeListener(refresh));

            const offEvents = ["PRESENCE_UPDATES", "PRESENCES_REPLACE", "SESSIONS_REPLACE"].map((name) =>
                onFluxEventDispatched(name, (p) => { later(); return p; }),
            );

            return () => {
                mounted = false;
                stores.forEach((s) => s.removeChangeListener(refresh));
                offEvents.forEach((off) => off());
            };
        }, [rerender, userId]);
    }

    function StatusIcons({ userId, size = 16 }) {
        useStatusRerender(userId);
        const statuses = getStatuses(userId) ?? {};
        const dotPlatform = settings.cache?.experimentalStatusDot ? pickDotPlatform(statuses) : null;
        return jsx(Fragment, {
            children: Object.keys(statuses).filter((p) => p !== dotPlatform).map((p) =>
                jsx(PlatformIcon, { platform: p, color: statusColor(statuses[p], settings.cache?.fallbackColors), iconSize: size }, p),
            ),
        });
    }

    function plateShapes(kind, artWidth, artHeight, ringWidth, ringHeight) {
        const t = RING_THICKNESS;
        const part = (left, top, width, height, borderRadius) => ({ left, top, width, height, borderRadius });

        switch (kind) {
            case "mobile":
                return [part(0, 0, ringWidth, ringHeight, artWidth * 0.14 + t)];
            case "embedded":
                return [part(0, 0, ringWidth, ringHeight, artHeight * 0.2 + t)];
            case "desktop": {
                const bodyHeight = artHeight * 0.77;
                const footWidth = artWidth * 0.48 + t * 2;
                return [
                    part(0, 0, ringWidth, bodyHeight + t * 2, artWidth * 0.12 + t),
                    part((ringWidth - footWidth) / 2, bodyHeight, footWidth, ringHeight - bodyHeight, t),
                ];
            }
            case "vr": {
                const earWidth = artWidth * 0.175 + t * 2;
                const earTop = artHeight * 0.28;
                const earHeight = artHeight * 0.52 + t * 2;
                const earRadius = artHeight * 0.12 + t;
                return [
                    part(artWidth * 0.125, 0, artWidth * 0.75 + t * 2, ringHeight, artHeight * 0.24 + t),
                    part(0, earTop, earWidth, earHeight, earRadius),
                    part(ringWidth - earWidth, earTop, earWidth, earHeight, earRadius),
                ];
            }
            default:
                return [part(0, 0, ringWidth, ringHeight, Math.min(ringWidth, ringHeight) / 2)];
        }
    }

    function StatusDot({ userId, original, size }) {
        useStatusRerender(userId);
        const location = resolveContext(size);
        if (!dotAllowedForContext(location)) return original;

        const statuses = getStatuses(userId) ?? {};
        const platform = pickDotPlatform(statuses);
        if (!platform) return original;
        const kind = normalizePlatform(platform);

        const assetId = findAsset(platform, true);
        if (!assetId) return original;

        const dotSize = typeof original.props.size === "number" ? original.props.size : 16;
        const box = (dotSize + (dotSize <= 20 ? 4 : 3)) * (CONTEXT_SCALE[location] ?? 1);
        const fit = kind === "vr" ? box * 1.1 : box;
        const aspect = assetAspect(assetId, kind);
        const width = aspect >= 1 ? fit : fit * aspect;
        const height = aspect >= 1 ? fit / aspect : fit;

        const glyph = ART_GLYPH[kind];
        const [fillWidth, fillHeight] = ART_FILL[kind] ?? [1, 1];
        const artWidth = glyph ? glyph.w * fit : width * fillWidth;
        const artHeight = glyph ? (glyph.h ? glyph.h * fit : artWidth / glyph.aspect) : height * fillHeight;
        const offsetX = (glyph?.dx ?? 0) * fit;
        const offsetY = (glyph?.dy ?? 0) * fit;
        const ringWidth = artWidth + RING_THICKNESS * 2;
        const ringHeight = artHeight + RING_THICKNESS * 2;
        const plate = plateShapes(kind, artWidth, artHeight, ringWidth, ringHeight);

        const style = ReactNative.StyleSheet.flatten(original.props.style) ?? {};
        const [ctxShiftX, ctxShiftY] = CONTEXT_SHIFT[location] ?? [0, 0];
        const [platShiftX, platShiftY] = PLATFORM_SHIFT[kind] ?? [0, 0];
        const inListContext = location === "memberList" || location === "dmList";
        const listExtra = inListContext ? (PLATFORM_LIST_SHIFT[kind] ?? 0) : 0;
        const shiftX = ctxShiftX + platShiftX;
        const shiftY = ctxShiftY + platShiftY + listExtra;
        const right = (typeof style.right === "number" ? style.right : -3) + box / 2 - ringWidth / 2 + shiftX;
        const bottom = (typeof style.bottom === "number" ? style.bottom : -3) + box / 2 - ringHeight / 2 + shiftY;

        const backgroundColor = style.backgroundColor ?? surfaceColor(location);

        return jsxs(ReactNative.View, {
            style: { position: "absolute", right, bottom, width: ringWidth, height: ringHeight },
            children: [
                ...plate.map((shape, i) => jsx(ReactNative.View, {
                    style: { position: "absolute", backgroundColor, ...shape, left: shape.left + offsetX, top: shape.top + offsetY },
                }, i)),
                jsx(ReactNative.View, {
                    style: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", transform: [{ translateX: offsetX }, { translateY: offsetY }] },
                    children: jsx(PlatformIcon, {
                        platform,
                        color: statusColor(statuses[platform], settings.cache?.fallbackColors),
                        width,
                        height,
                        forDot: true,
                    }),
                }, "icon"),
            ],
        });
    }

    const hasUser = (n) => n?.props?.user?.id !== undefined;

    // ---------------------------------------------------------------- /device command

    function reply(channelId, text) {
        const actions = findByProps("sendBotMessage");
        if (actions && channelId) actions.sendBotMessage(channelId, text);
        else showToast(text.replace(/\*\*/g, ""));
    }

    function registerDeviceCommand() {
        const LABELS = { desktop: "PC", mobile: "Mobile", web: "Web", embedded: "Console (PS5/Xbox)", vr: "VR" };
        cleanup(V.commands.registerCommand({
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
                const statuses = getStatuses(userId) || {};
                const list = Object.keys(statuses).map((p) => {
                    const key = normalizePlatform(p);
                    return `${LABELS[key] || p} (${statuses[p]})`;
                });
                const user = Stores.UserStore?.getUser?.(userId);
                const name = user ? user.username : "that user";
                const text = list.length
                    ? `**${name}** is on: ${list.join(", ")}`
                    : `**${name}** appears offline (or their presence is hidden), so no device is visible.`;
                reply(ctx && ctx.channel && ctx.channel.id, text);
            },
        }));
    }

    // ---------------------------------------------------------------- Patches

    function start() {
        cleanup(getModules(withExactName("ChannelHeader"), (mod) => {
            const target = patchTarget(mod);
            if (!target) return;
            cleanup(patcher.after(target.parent, target.key, (result) => {
                safely(() => {
                    if (result?.type?.type?.name !== "PrivateChannelHeader") return;
                    cleanup(patcher.after(result.type, "type", (header) => {
                        safely(() => {
                            const userId = findInTree(header, hasUser)?.props?.user?.id;
                            if (!userId || !inlineIconsAllowed("dmTopBar")) return;

                            const container = findInTree(header, (n) => n?.key === "DMTabsV2HeaderIcons");
                            if (container) { container.props.children = jsx(StatusIcons, { userId }); return; }

                            const inner = header.props?.children?.props?.children?.props?.children?.[1];
                            if (inner && typeof inner.type === "function") {
                                const unpatch = patcher.after(inner, "type", (r) => {
                                    unpatch();
                                    safely(() => {
                                        if (!findInTree(r, (n) => n?.key === "DMTabsV2Header-v2")) {
                                            r.props.children[0]?.props?.children?.push(jsx(StatusIcons, { userId }, "DMTabsV2Header-v2"));
                                        }
                                    });
                                    return r;
                                });
                                cleanup(unpatch);
                            }
                        });
                        return header;
                    }));
                });
                return result;
            }));
        }));

        cleanup(getModules(withExactName("UserProfileContent"), (mod) => {
            const target = patchTarget(mod);
            if (!target) return;
            cleanup(patcher.after(target.parent, target.key, (result) => {
                safely(() => {
                    const primary = findInTree(result, (n) => n?.type?.name === "PrimaryInfo");
                    if (!primary) return;
                    cleanup(patcher.after(primary, "type", (a) => {
                        safely(() => {
                            if (a?.type?.name !== "UserProfilePrimaryInfo") return;
                            cleanup(patcher.after(a, "type", (b) => {
                                safely(() => {
                                    const name = findInTree(b, (n) => n?.type?.name === "DisplayName");
                                    if (!name) return;
                                    cleanup(patcher.after(name, "type", (c) => {
                                        safely(() => {
                                            const userId = name.props?.user?.id;
                                            if (userId && inlineIconsAllowed("profileUsername")) c?.props?.children?.push(jsx(StatusIcons, { userId }, "UserProfileIcons"));
                                        });
                                        return c;
                                    }));
                                });
                                return b;
                            }));
                        });
                        return a;
                    }));
                });
                return result;
            }));
        }));

        cleanup(getModules(withDisplayNameFn, (mod) => {
            cleanup(patcher.instead(mod, "DisplayName", (args, orig) => {
                const result = orig(...args);
                safely(() => {
                    const user = args[0]?.user;
                    const children = result.props?.children?.props?.children?.[0]?.props?.children;
                    if (user?.id && Array.isArray(children) && inlineIconsAllowed("profileUsername")) {
                        if (children.some((c) => c?.key === "DisplayNameIcons")) return;
                        children.push(jsx(StatusIcons, { userId: user.id }, "DisplayNameIcons"));
                    }
                });
                return result;
            }));
        }));

        cleanup(getModules(withExactName("UserRow"), (mod) => {
            const target = patchTarget(mod);
            if (!target) return;
            cleanup(patcher.instead(target.parent, target.key, ([props], orig) => {
                const result = orig(props);
                safely(() => {
                    const user = props?.user;
                    if (!user?.id || !inlineIconsAllowed("userList")) return;
                    if (findInTree(result?.props?.label, (n) => n?.key === "TabsV2MemberListStatusIconsView")) return;

                    result.props.label = jsxs(ReactNative.View, {
                        style: { justifyContent: "flex-start", flexDirection: "row", alignItems: "center" },
                        children: [
                            result.props.label,
                            jsx(ReactNative.View, { style: { flexDirection: "row" }, children: jsx(StatusIcons, { userId: user.id }) }, "TabsV2MemberListStatusIconsView"),
                        ],
                    }, "TabsV2MemberListStatusIconsView");
                });
                return result;
            }));
        }));

        cleanup(getModules(withExactName("MessagesItemChannelContent"), (mod) => {
            const target = patchTarget(mod);
            if (!target) return;
            cleanup(patcher.instead(target.parent, target.key, ([props], orig) => {
                const result = orig(props);
                safely(() => {
                    if (props?.channel?.recipients?.length !== 1 || !inlineIconsAllowed("userList")) return;
                    const recipientId = props.channel.recipients[0];
                    const titleNode = findInTree(result, (n) => n?.props?.children?.[0]?.props?.variant?.includes?.("channel-title"));
                    if (titleNode && !findInTree(titleNode, (n) => n?.key === "TabsV2RedesignDMListIcons")) {
                        titleNode.props?.children?.push(jsx(ReactNative.View, { style: { flexDirection: "row" }, children: jsx(StatusIcons, { userId: recipientId }) }, "TabsV2RedesignDMListIcons"));
                    }
                });
                return result;
            }));
        }));

        cleanup(getModules(withStatusAvatarBundle, (mod) => {
            const target = typeof mod.Avatar?.type === "function" ? { parent: mod.Avatar, key: "type" }
                : typeof mod.Avatar === "function" ? { parent: mod, key: "Avatar" }
                : null;
            if (!target) return;

            cleanup(patcher.instead(target.parent, target.key, ([props], orig) => {
                const result = orig(props);
                if (!settings.cache?.experimentalStatusDot) return result;
                try {
                    const kids = result?.props?.children;
                    if (!Array.isArray(kids)) return result;

                    const isStatusLike = (c) => c?.props && typeof c.props.status === "string" && typeof c.props.streaming === "boolean";
                    const index = kids.findIndex((c) => (c?.type?.name ?? c?.type?.displayName) === "Status" || isStatusLike(c));
                    if (index === -1) return result;

                    const userId = props?.user?.id ?? kids.find((c) => c?.props?.user?.id)?.props?.user?.id;
                    if (!userId) return result;

                    const original = kids[index];
                    const statuses = getStatuses(userId) ?? {};
                    const hasIcon = dotAllowedForContext(resolveContext(props?.size)) && !!pickDotPlatform(statuses);
                    const children = kids.map((kid, i) => {
                        if (i === index) return jsx(StatusDot, { userId, original, size: props?.size }, original.key ?? "StatusDot");
                        if (hasIcon && kid?.props?.cutout != null) return { ...kid, props: { ...kid.props, cutout: undefined } };
                        return kid;
                    });
                    return { ...result, props: { ...result.props, children } };
                } catch (e) {
                    return result;
                }
            }));
        }));
    }

    return {
        onLoad() {
            try { registerDeviceCommand(); } catch (e) { console.error("[Platform Indicators] command", e); }
            try { start(); } catch (e) {
                showToast("Platform Indicators failed to start");
                console.error("[Platform Indicators] start", e);
            }
        },
        onUnload() {
            for (const c of cleanups) {
                try { c(); } catch (e) {}
            }
            cleanups.length = 0;
        },
        settings: SettingsPage,
    };
})();
