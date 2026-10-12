(function () {
    "use strict";

    const { after } = vendetta.patcher;
    const { findByName, findByStoreName } = vendetta.metro;
    const { React, ReactNative } = vendetta.metro.common;
    const { storage } = vendetta.plugin;
    const { useProxy } = vendetta.storage;
    const { FormSection, FormRow, FormSwitchRow, FormInput } = vendetta.ui.components.Forms;

    const OFFSET_RE = /^([+-])(\d{2}):(\d{2})$/;

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
        const match = offset.match(OFFSET_RE);
        if (!match) return null;
        const [, sign, h, m] = match;
        return (sign === "-" ? -1 : 1) * (Number(h) * 60 + Number(m));
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
        const minutes = offsetToMinutes(getOffsets()[userId]);
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
                return `Bad offset for ${id}: use +05:30 or -08:00`;
            }
        }
        return `OK (${Object.keys(parsed).length} user${Object.keys(parsed).length === 1 ? "" : "s"})`;
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
                { title: "Timezones" },
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
                    subLabel: "Long-press a user > Copy ID to get their ID (needs Developer Mode on).",
                })
            )
        );
    }

    let unpatch = null;

    return {
        onLoad() {
            storage.format ??= "12h";
            storage.showSeconds ??= false;
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
        },

        settings: Settings,
    };
})()
