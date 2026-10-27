(function () {
    const { metro, plugin, storage: vstorage, logger, ui } = vendetta;
    const { React, ReactNative: RN, FluxDispatcher } = metro.common;
    const { findByProps } = metro;
    const { storage } = plugin;
    const { useProxy } = vstorage;
    const { Forms } = ui.components;
    const { FormInput, FormSwitchRow, FormSection, FormText } = Forms;
    const { View, Text, TouchableOpacity, ScrollView } = RN;
    const h = React.createElement;

    const TAG = "[Multi RPC]";
    const DEFAULT_APP_ID = "1054951789318909972";
    const sessionStart = Date.now();
    const TYPES = [
        { label: "Playing", value: 0 },
        { label: "Listening", value: 2 },
        { label: "Watching", value: 3 },
        { label: "Competing", value: 5 },
    ];

    const assetManager = findByProps("getAssetIds");

    function uid() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    function newActivity(overrides) {
        return Object.assign(
            {
                id: uid(),
                enabled: false,
                type: 0,
                name: "New activity",
                application_id: DEFAULT_APP_ID,
                details: "",
                state: "",
                large_image: "",
                large_text: "",
                small_image: "",
                small_text: "",
                use_timestamps: false,
                start: 0,
                length_min: 0,
            },
            overrides
        );
    }

    if (!Array.isArray(storage.activities)) {
        storage.activities = [
            newActivity({ name: "A game", type: 0 }),
            newActivity({ name: "A song", type: 2, use_timestamps: true, length_min: 3 }),
            newActivity({ name: "A show", type: 3, use_timestamps: true }),
        ];
    }

    const live = new Map();
    let runId = 0;

    function send(socketId, pid, activity) {
        FluxDispatcher.dispatch({
            type: "LOCAL_ACTIVITY_UPDATE",
            activity,
            pid,
            socketId,
        });
    }

    async function resolveAssets(appId, keys) {
        const out = {};
        const present = keys.filter(k => k.value);
        if (!present.length || !assetManager) {
            for (const k of present) out[k.field] = k.value;
            return out;
        }
        const raw = present.map(k => k.value);
        try {
            let ids = assetManager.getAssetIds(appId, raw);
            if (!ids || !ids.length) ids = await assetManager.fetchAssetIds(appId, raw);
            present.forEach((k, i) => {
                out[k.field] = (ids && ids[i]) || k.value;
            });
        } catch (e) {
            logger.error(TAG, "asset resolve failed", e);
            for (const k of present) out[k.field] = k.value;
        }
        return out;
    }

    async function buildActivity(a) {
        const appId = String(a.application_id || DEFAULT_APP_ID);
        const act = {
            name: (a.name || "").trim() || "Discord",
            type: Number(a.type) || 0,
            application_id: appId,
            flags: 0,
        };
        if ((a.details || "").trim()) act.details = a.details.trim();
        if ((a.state || "").trim()) act.state = a.state.trim();

        if (a.use_timestamps) {
            const start = Number(a.start) > 0 ? Number(a.start) : sessionStart;
            act.timestamps = { start };
            const len = Number(a.length_min);
            if (len > 0) act.timestamps.end = start + len * 60000;
        }

        const resolved = await resolveAssets(appId, [
            { field: "large_image", value: (a.large_image || "").trim() },
            { field: "small_image", value: (a.small_image || "").trim() },
        ]);
        const assets = Object.assign({}, resolved);
        if (resolved.large_image && (a.large_text || "").trim()) assets.large_text = a.large_text.trim();
        if (resolved.small_image && (a.small_text || "").trim()) assets.small_text = a.small_text.trim();
        if (Object.keys(assets).length) act.assets = assets;

        return act;
    }

    async function apply() {
        const my = ++runId;
        const list = (storage.activities || []).filter(a => a && a.enabled);
        const built = [];
        for (let i = 0; i < list.length; i++) {
            try {
                built.push({
                    socketId: "MultiRPC-" + list[i].id + "@Kettu",
                    pid: 1700 + i,
                    activity: await buildActivity(list[i]),
                });
            } catch (e) {
                logger.error(TAG, "failed to build activity", e);
            }
        }
        if (my !== runId) return;

        const keep = new Set(built.map(b => b.socketId));
        for (const [sid, pid] of live) {
            if (!keep.has(sid)) {
                send(sid, pid, null);
                live.delete(sid);
            }
        }
        for (const b of built) {
            send(b.socketId, b.pid, b.activity);
            live.set(b.socketId, b.pid);
        }
        logger.log(TAG, "applied " + built.length + " activities");
    }

    function clearAll() {
        runId++;
        for (const [sid, pid] of live) send(sid, pid, null);
        live.clear();
    }

    let reconnectTimer = null;
    function onReconnect() {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            live.clear();
            apply().catch(e => logger.error(TAG, e));
        }, 2000);
    }

    function Button({ label, onPress, color }) {
        return h(
            TouchableOpacity,
            {
                onPress,
                style: {
                    backgroundColor: color || "#5865F2",
                    paddingVertical: 12,
                    paddingHorizontal: 14,
                    borderRadius: 8,
                    alignItems: "center",
                    marginBottom: 10,
                },
            },
            h(Text, { style: { color: "#fff", fontWeight: "600" } }, label)
        );
    }

    function Chip({ label, selected, onPress }) {
        return h(
            TouchableOpacity,
            {
                onPress,
                style: {
                    paddingVertical: 8,
                    paddingHorizontal: 12,
                    borderRadius: 16,
                    marginRight: 8,
                    marginBottom: 8,
                    backgroundColor: selected ? "#5865F2" : "#4f545c",
                },
            },
            h(Text, { style: { color: "#fff" } }, label)
        );
    }

    function ActivityCard({ a, onRemove }) {
        useProxy(a);
        const text = (title, key, placeholder, extra) =>
            h(FormInput, Object.assign({
                key,
                title,
                placeholder,
                value: String(a[key] ?? ""),
                onChange: v => { a[key] = v; },
            }, extra || {}));

        return h(
            View,
            {
                style: {
                    marginHorizontal: 12,
                    marginBottom: 16,
                    paddingBottom: 8,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: "#4f545c",
                    overflow: "hidden",
                },
            },
            h(FormSwitchRow, {
                label: (a.name || "Activity") + " (" + (TYPES.find(t => t.value === a.type)?.label ?? "Playing") + ")",
                value: !!a.enabled,
                onValueChange: v => { a.enabled = v; },
            }),
            h(
                View,
                { style: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 16, paddingTop: 8 } },
                TYPES.map(t =>
                    h(Chip, {
                        key: t.value,
                        label: t.label,
                        selected: a.type === t.value,
                        onPress: () => { a.type = t.value; },
                    })
                )
            ),
            text("Name", "name", "Spotify"),
            text("Details", "details", "Top line"),
            text("State", "state", "Bottom line"),
            text("Application ID", "application_id", DEFAULT_APP_ID, { keyboardType: "numeric" }),
            text("Large image", "large_image", "asset key or URL"),
            text("Large image text", "large_text", "hover text"),
            text("Small image", "small_image", "asset key or URL"),
            text("Small image text", "small_text", "hover text"),
            h(FormSwitchRow, {
                label: "Show timestamps",
                value: !!a.use_timestamps,
                onValueChange: v => { a.use_timestamps = v; },
            }),
            h(FormInput, {
                title: "Start (ms, 0 = when plugin loaded)",
                placeholder: "0",
                value: String(a.start || ""),
                disabled: !a.use_timestamps,
                keyboardType: "numeric",
                onChange: v => { a.start = Number(v) || 0; },
            }),
            h(FormInput, {
                title: "Length in minutes (0 = elapsed timer, >0 = progress bar)",
                placeholder: "0",
                value: String(a.length_min || ""),
                disabled: !a.use_timestamps,
                keyboardType: "numeric",
                onChange: v => { a.length_min = Number(v) || 0; },
            }),
            h(
                View,
                { style: { paddingHorizontal: 16, paddingTop: 8 } },
                h(Button, { label: "Start timer from now", color: "#4f545c", onPress: () => { a.start = Date.now(); } }),
                h(Button, { label: "Remove activity", color: "#ed4245", onPress: onRemove })
            )
        );
    }

    function Settings() {
        useProxy(storage);
        const activities = storage.activities || [];

        return h(
            ScrollView,
            { style: { flex: 1 } },
            h(
                View,
                { style: { padding: 16 } },
                h(FormText, { style: { marginBottom: 12 } },
                    "Toggle the activities you want, edit them, then press Apply. Each enabled activity is sent as its own presence."),
                h(Button, { label: "Apply presence", onPress: () => apply().catch(e => logger.error(TAG, e)) }),
                h(Button, { label: "Clear all presence", color: "#4f545c", onPress: () => clearAll() }),
                h(Button, {
                    label: "Add activity",
                    color: "#3ba55d",
                    onPress: () => { storage.activities = [...activities, newActivity()]; },
                })
            ),
            activities.map(a =>
                h(ActivityCard, {
                    key: a.id,
                    a,
                    onRemove: () => { storage.activities = activities.filter(x => x.id !== a.id); },
                })
            ),
            h(View, { style: { height: 48 } })
        );
    }

    return {
        onLoad() {
            FluxDispatcher.subscribe("CONNECTION_OPEN", onReconnect);
            apply().catch(e => logger.error(TAG, e));
        },
        onUnload() {
            FluxDispatcher.unsubscribe("CONNECTION_OPEN", onReconnect);
            clearTimeout(reconnectTimer);
            clearAll();
        },
        settings: Settings,
    };
})()
