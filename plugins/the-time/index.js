(function () {
    "use strict";

    const { after } = vendetta.patcher;
    const { findByName, findByStoreName } = vendetta.metro;
    const { React, ReactNative } = vendetta.metro.common;
    const { storage } = vendetta.plugin;
    const { useProxy } = vendetta.storage;
    const { FormSection, FormRow, FormSwitchRow, FormInput } = vendetta.ui.components.Forms;

    const OFFSET_RE = /^([+-])?(\d{1,2})(?::(\d{2}))?$/;
    const BULK_URL = "https://timezonedb.catvibers.me/api/user/bulk";
    const USER_AGENT = "Kettu-ShowMeYourTime/1.0";
    const CACHE_MS = 60 * 60 * 1000;
    const RETRY_MS = 5 * 60 * 1000;
    const CHUNK_SIZE = 50;

    const lookups = new Map();
    const pending = new Set();
    const inflight = new Set();
    let timer = null;

    let cacheRaw = null;
    let cacheParsed = {};

    function getOffsets() {
        const raw = storage.timezones;
        if (raw === cacheRaw) return cacheParsed;
        cacheRaw = raw;
        try {
            const parsed = JSON.parse(raw);
            cacheParsed = parsed && typeof parsed === "object" ? parsed : {};
        } catch {
            cacheParsed = {};
        }
        return cacheParsed;
    }

    function offsetToMinutes(offset) {
        if (typeof offset !== "string") return null;
        const match = offset.trim().match(OFFSET_RE);
        if (!match) return null;
        const [, sign, h, m] = match;
        return (sign === "-" ? -1 : 1) * (Number(h) * 60 + Number(m ?? 0));
    }

    function fetchChunk(ids) {
        ids.forEach(id => inflight.add(id));
        const done = () => ids.forEach(id => inflight.delete(id));

        fetch(BULK_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            },
            body: JSON.stringify(ids),
        })
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then(data => {
                const expires = Date.now() + CACHE_MS;
                for (const id of ids) {
                    const entry = data?.[id];
                    lookups.set(id, { minutes: entry ? offsetToMinutes(entry.timezone) : null, expires });
                }
                done();
            })
            .catch(e => {
                const expires = Date.now() + RETRY_MS;
                for (const id of ids) {
                    const old = lookups.get(id);
                    lookups.set(id, { minutes: old ? old.minutes : null, expires });
                }
                done();
                console.error("ShowMeYourTime: timezone lookup failed", e);
            });
    }

    function flush() {
        timer = null;
        const ids = Array.from(pending);
        pending.clear();
        for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            fetchChunk(ids.slice(i, i + CHUNK_SIZE));
        }
    }

    function queueLookup(userId) {
        if (pending.has(userId) || inflight.has(userId)) return;
        pending.add(userId);
        if (!timer) timer = setTimeout(flush, 300);
    }

    function getMinutesForUser(userId) {
        const manual = offsetToMinutes(getOffsets()[userId]);
        if (manual !== null) return manual;

        if (!storage.autoLookup) return null;

        const entry = lookups.get(userId);
        if (!entry || entry.expires < Date.now()) queueLookup(userId);
        return entry ? entry.minutes : null;
    }

    function formatTime(date) {
        const is12h = storage.format !== "24h";
        const hours = is12h ? date.getUTCHours() % 12 || 12 : date.getUTCHours();
        const m = date.getUTCMinutes().toString().padStart(2, "0");
        const s = storage.showSeconds ? `:${date.getUTCSeconds().toString().padStart(2, "0")}` : "";
        const ampm = is12h ? ` ${date.getUTCHours() >= 12 ? "PM" : "AM"}` : "";
        return `${hours}:${m}${s}${ampm}`;
    }

    function getLocalTimeForUser(userId) {
        const minutes = getMinutesForUser(userId);
        if (minutes === null) return null;
        return formatTime(new Date(Date.now() + minutes * 60 * 1000));
    }

    function validateTimezones(raw) {
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return "Invalid JSON";
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return 'Must be an object like {"userID":"-05:00"}';
        }
        for (const [id, offset] of Object.entries(parsed)) {
            if (offsetToMinutes(offset) === null) {
                return `Bad offset for ${id}: use +5:30 or -08:00`;
            }
        }
        return `OK (${Object.keys(parsed).length} override${Object.keys(parsed).length === 1 ? "" : "s"})`;
    }

    function Settings() {
        useProxy(storage);

        return React.createElement(
            ReactNative.ScrollView,
            null,
            React.createElement(
                FormSection,
                { title: "Display" },
                React.createElement(FormSwitchRow, {
                    label: "24-hour time",
                    subLabel: "Off = 12-hour (2:30 PM), on = 24-hour (14:30)",
                    value: storage.format === "24h",
                    onValueChange: v => {
                        storage.format = v ? "24h" : "12h";
                    },
                }),
                React.createElement(FormSwitchRow, {
                    label: "Show seconds",
                    subLabel: "Only updates when a message re-renders",
                    value: !!storage.showSeconds,
                    onValueChange: v => {
                        storage.showSeconds = v;
                    },
                })
            ),
            React.createElement(
                FormSection,
                { title: "Automatic lookup" },
                React.createElement(FormSwitchRow, {
                    label: "Look up timezones online",
                    subLabel:
                        "Sends the IDs of people whose messages you see to timezonedb.catvibers.me. Only people who registered there show a time. Times appear after messages re-render (scroll or reopen the channel).",
                    value: !!storage.autoLookup,
                    onValueChange: v => {
                        storage.autoLookup = v;
                    },
                })
            ),
            React.createElement(
                FormSection,
                { title: "Manual overrides (optional)" },
                React.createElement(FormInput, {
                    title: "Offsets (JSON)",
                    placeholder: '{"userID":"-05:00"}',
                    value: storage.timezones,
                    onChange: v => {
                        storage.timezones = v;
                    },
                }),
                React.createElement(FormRow, {
                    label: validateTimezones(storage.timezones),
                    subLabel: "Overrides beat the online lookup. Long-press a user > Copy ID (needs Developer Mode on).",
                })
            )
        );
    }

    let unpatch = null;

    return {
        onLoad() {
            storage.format ??= "12h";
            storage.showSeconds ??= false;
            storage.autoLookup ??= true;
            storage.timezones ??= "{}";

            const StreamerModeStore = findByStoreName("StreamerModeStore");
            const RowManager = findByName("RowManager");

            unpatch = after("generate", RowManager.prototype, ([data], row) => {
                if (data?.rowType !== 1) return;
                if (StreamerModeStore?.enabled) return;

                const message = row?.message;
                if (!message || typeof message.timestamp !== "string") return;

                const userId = data.message?.author?.id ?? data.message?.authorId;
                if (!userId) return;

                const time = getLocalTimeForUser(userId);
                if (!time) return;

                const suffix = ` (${time})`;
                if (!message.timestamp.endsWith(suffix)) message.timestamp += suffix;
            });
        },

        onUnload() {
            unpatch?.();
            unpatch = null;
            if (timer) clearTimeout(timer);
            timer = null;
            pending.clear();
            inflight.clear();
            lookups.clear();
        },

        settings: Settings,
    };
})()
