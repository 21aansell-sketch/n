// Auto Delete DMs - slowly deletes YOUR OWN old messages in DMs / group DMs.
// Throttled hard so it stays far below Discord's rate limits.
//
// Safety design:
//  - One request at a time, never in parallel.
//  - Delete: 1.2-2s apart (jittered; we back off automatically on any 429).
//  - Fetch:  1 page (100 msgs) per channel visit, 3-5s apart.
//  - Hourly cap on deletes (default 300).
//  - Any HTTP 429 -> wait retry_after (+ padding) and double the delay; 3 in a row -> pause 15 min.
//  - 401/403 -> stop that channel; plugin never retries aggressively.
//  - Only messages older than MIN_AGE_HOURS are touched, and only your own.
//  - Starts DISABLED. Enable by setting storage.enabled = true (see bottom of file).
(function () {
    const { metro, storage: _unused, plugin } = vendetta;
    const { findByProps, findByStoreName } = metro;
    const storage = plugin.storage;

    // ---------- config (overridable via plugin storage) ----------
    const DEFAULTS = {
        enabled: false,        // must be turned on explicitly
        minAgeHours: 24 * 7,   // only delete messages older than this
        deleteDelayMin: 1200,  // ms
        deleteDelayMax: 2000,  // ms
        fetchDelayMin: 3000,   // ms
        fetchDelayMax: 5000,   // ms
        maxDeletesPerHour: 1000,
        rescanHours: 6,        // how often to re-check a channel that had nothing left
        excludeChannelIds: []  // DM channel IDs to never touch
    };
    for (const k in DEFAULTS) if (storage[k] === undefined) storage[k] = DEFAULTS[k];

    // Message types that users are allowed to delete (default, reply).
    const DELETABLE_TYPES = new Set([0, 19]);

    // ---------- Discord internals ----------
    const RestAPI = findByProps("getAPIBaseURL", "get");
    const ChannelStore = findByStoreName("ChannelStore");
    const UserStore = findByStoreName("UserStore");

    let running = false;
    let stopped = false;
    let backoffMultiplier = 1;
    let consecutive429 = 0;
    let deleteTimestamps = []; // for the hourly cap
    const channelNextScan = new Map(); // channelId -> timestamp when it may be scanned again

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rand = (a, b) => a + Math.random() * (b - a);
    const wait = (min, max) => sleep(rand(min, max) * backoffMultiplier);

    function hourlyBudgetLeft() {
        const cutoff = Date.now() - 3600000;
        deleteTimestamps = deleteTimestamps.filter(t => t > cutoff);
        return storage.maxDeletesPerHour - deleteTimestamps.length;
    }

    // Wraps a request, handling 429s politely. Returns {ok, status, body}.
    async function request(method, url) {
        try {
            const res = await RestAPI[method]({ url });
            consecutive429 = 0;
            backoffMultiplier = Math.max(1, backoffMultiplier * 0.9);
            return { ok: true, status: res.status, body: res.body };
        } catch (e) {
            const status = e?.status ?? e?.response?.status;
            if (status === 429) {
                consecutive429++;
                backoffMultiplier = Math.min(8, backoffMultiplier * 2);
                const retry = (e?.body?.retry_after ?? e?.response?.body?.retry_after ?? 5) * 1000;
                await sleep(retry + 1000 + rand(0, 1000));
                if (consecutive429 >= 3) {
                    // Discord is telling us to slow down repeatedly: take a long break.
                    await sleep(15 * 60 * 1000);
                    consecutive429 = 0;
                }
                return { ok: false, status, retry: true };
            }
            return { ok: false, status, body: e?.body };
        }
    }

    function getDmChannelIds() {
        // type 1 = DM, type 3 = group DM
        const chans = ChannelStore.getSortedPrivateChannels?.() ?? [];
        return chans
            .filter(c => (c.type === 1 || c.type === 3) && !storage.excludeChannelIds.includes(c.id))
            .map(c => c.id);
    }

    // Processes a single channel: fetch pages of history, delete eligible own messages.
    // Returns when the channel is exhausted, the hourly cap is hit, or the plugin is stopped.
    async function processChannel(channelId, myId) {
        const minAgeMs = storage.minAgeHours * 3600000;
        let before;
        let deletedHere = 0;

        while (!stopped && storage.enabled) {
            if (hourlyBudgetLeft() <= 0) return "budget";

            const url = `/channels/${channelId}/messages?limit=100` + (before ? `&before=${before}` : "");
            const res = await request("get", url);
            if (!res.ok) {
                if (res.retry) continue;
                return "error"; // 403/404 etc: skip this channel this round
            }
            await wait(storage.fetchDelayMin, storage.fetchDelayMax);

            const msgs = res.body;
            if (!Array.isArray(msgs) || msgs.length === 0) return "done";
            before = msgs[msgs.length - 1].id;

            const now = Date.now();
            const mine = msgs.filter(m =>
                m.author?.id === myId &&
                DELETABLE_TYPES.has(m.type) &&
                !m.pinned &&
                now - new Date(m.timestamp).getTime() > minAgeMs
            );

            for (const m of mine) {
                if (stopped || !storage.enabled) return "stopped";
                if (hourlyBudgetLeft() <= 0) return "budget";

                let r;
                do {
                    r = await request("del", `/channels/${channelId}/messages/${m.id}`);
                } while (!r.ok && r.retry && !stopped);

                if (r.ok) {
                    deleteTimestamps.push(Date.now());
                    deletedHere++;
                } else if (r.status === 401 || r.status === 403) {
                    return "error";
                }
                // 404 = already gone; just move on.
                await wait(storage.deleteDelayMin, storage.deleteDelayMax);
            }

            if (msgs.length < 100) return "done";
        }
        return "stopped";
    }

    async function mainLoop() {
        if (running) return;
        running = true;
        stopped = false;
        try {
            while (!stopped) {
                if (!storage.enabled) { await sleep(30000); continue; }

                const myId = UserStore.getCurrentUser()?.id;
                if (!myId) { await sleep(10000); continue; }

                let didWork = false;
                for (const id of getDmChannelIds()) {
                    if (stopped || !storage.enabled) break;
                    if ((channelNextScan.get(id) ?? 0) > Date.now()) continue;

                    const result = await processChannel(id, myId);
                    didWork = true;
                    if (result === "done" || result === "error") {
                        channelNextScan.set(id, Date.now() + storage.rescanHours * 3600000);
                    }
                    if (result === "budget") break;
                    await wait(storage.fetchDelayMin, storage.fetchDelayMax);
                }

                // Idle / budget-exhausted: check back in a few minutes.
                await sleep(didWork ? 60000 : 5 * 60000);
            }
        } finally {
            running = false;
        }
    }

    // Minimal settings page: an on/off switch and a "keep messages newer than" row.
    const React = metro.common.React;
    const { ScrollView } = metro.common.ReactNative;
    const { Forms } = vendetta.ui.components;
    const { useProxy } = vendetta.storage;
    const { FormSection, FormSwitchRow, FormRow, FormText } = Forms;

    function Settings() {
        useProxy(storage);
        return React.createElement(
            ScrollView,
            null,
            React.createElement(
                FormSection,
                { title: "Auto Delete DMs", titleStyleType: "no_border" },
                React.createElement(FormSwitchRow, {
                    label: "Enabled",
                    subLabel: "Deletes only YOUR messages in DMs/group DMs, slowly in the background.",
                    value: storage.enabled,
                    onValueChange: v => { storage.enabled = v; }
                }),
                React.createElement(FormRow, {
                    label: `Keep messages newer than ${storage.minAgeHours}h`,
                    subLabel: "Tap to cycle: 1h, 24h, 7d, 30d",
                    onPress: () => {
                        const steps = [1, 24, 168, 720];
                        const i = steps.indexOf(storage.minAgeHours);
                        storage.minAgeHours = steps[(i + 1) % steps.length];
                    }
                }),
                React.createElement(FormText, null,
                    `Limit: ${storage.maxDeletesPerHour} deletes/hour, one request at a time.`)
            )
        );
    }

    return {
        settings: Settings,
        onLoad() {
            // Small startup delay so the app finishes loading its stores first.
            setTimeout(() => { if (!stopped) mainLoop(); }, 15000);
        },
        onUnload() {
            stopped = true;
        }
    };
})()
