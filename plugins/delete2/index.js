(function () {
    // Auto Delete - automatically deletes your own messages in the DMs you pick.
    // NOTE: keep the file starting with "(function" - Kettu evaluates it as
    // `return <file>`, so anything (even a comment) before it breaks loading.
    const { findByProps, findByStoreName } = vendetta.metro;
    const { React, ReactNative, FluxDispatcher } = vendetta.metro.common;
    const { storage } = vendetta.plugin;
    const { useProxy } = vendetta.storage;
    const { Forms } = vendetta.ui.components;
    const { FormSection, FormRow, FormSwitch, FormInput, FormText } = Forms;
    const { ScrollView } = ReactNative;

    const RestAPI = findByProps("getAPIBaseURL", "get");
    const UserStore = findByStoreName("UserStore");
    const ChannelStore = findByStoreName("ChannelStore");

    const h = React.createElement;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ---- defaults -------------------------------------------------------
    storage.enabled ??= true;
    storage.delay ??= "5";       // seconds between deletes
    storage.variation ??= "50";  // +/- percent applied to the delay
    storage.channels ??= {};     // { [channelId]: true }
    storage.deleteOld ??= false; // also delete past messages when a DM is turned on

    // ---- delay helpers --------------------------------------------------
    function nextDelayMs() {
        const base = Math.max(0, parseFloat(storage.delay) || 0) * 1000;
        const v = Math.min(100, Math.max(0, parseFloat(storage.variation) || 0)) / 100;
        const jitter = (Math.random() * 2 - 1) * v; // -v .. +v
        // floor of 500ms so a bad setting can't hammer the API
        return Math.max(500, Math.round(base * (1 + jitter)));
    }

    // ---- delete queue ---------------------------------------------------
    const queue = [];
    let running = false;
    let stopped = false;

    async function work() {
        if (running) return;
        running = true;
        while (queue.length && !stopped) {
            const job = queue.shift();
            await sleep(nextDelayMs());
            if (stopped) break;
            try {
                await RestAPI.del({ url: `/channels/${job.channelId}/messages/${job.id}` });
            } catch (e) {
                const status = e?.status ?? e?.body?.status;
                if (status === 429) {
                    // rate limited: put it back and wait as long as Discord asks
                    const retry = (e?.body?.retry_after ?? 5) * 1000;
                    queue.unshift(job);
                    await sleep(retry + 500);
                } else if (status === 404 || status === 403) {
                    // already gone / not allowed - drop it
                } else {
                    job.tries = (job.tries ?? 0) + 1;
                    if (job.tries < 3) queue.push(job);
                }
            }
        }
        running = false;
    }

    // ---- delete old messages ---------------------------------------------
    // Walks a DM's history from newest to oldest, queues every one of your
    // deletable messages, and lets the normal queue (delay + variation) delete them.
    const purging = {}; // channelId -> true while a history scan is running
    const DELETABLE_TYPES = new Set([0, 19, 20]); // normal, reply, slash command

    async function purgeChannel(channelId) {
        if (purging[channelId]) return 0;
        purging[channelId] = true;
        const me = UserStore.getCurrentUser()?.id;
        let before;
        let found = 0;
        try {
            while (!stopped && purging[channelId]) {
                const url = `/channels/${channelId}/messages?limit=100` + (before ? `&before=${before}` : "");
                let res;
                try {
                    res = await RestAPI.get({ url });
                } catch (e) {
                    const status = e?.status ?? e?.body?.status;
                    if (status === 429) {
                        await sleep(((e?.body?.retry_after ?? 5) + 0.5) * 1000);
                        continue;
                    }
                    break; // no access / network error - give up on this scan
                }
                const msgs = res?.body ?? [];
                if (!msgs.length) break;

                for (const m of msgs) {
                    if (m.author?.id === me && DELETABLE_TYPES.has(m.type)) {
                        queue.push({ channelId, id: m.id });
                        found++;
                    }
                }
                work();

                before = msgs[msgs.length - 1].id;
                if (msgs.length < 100) break;
                await sleep(1000 + Math.random() * 1000); // be gentle with history fetches
            }
        } finally {
            delete purging[channelId];
        }
        return found;
    }

    // ---- message listener -----------------------------------------------
    function onMessageCreate(event) {
        try {
            if (!storage.enabled) return;
            if (event.optimistic || event.message?.state === "SENDING") return;
            const msg = event.message;
            if (!msg?.id || !event.channelId) return;
            if (!storage.channels[event.channelId]) return;
            if (msg.author?.id !== UserStore.getCurrentUser()?.id) return;

            queue.push({ channelId: event.channelId, id: msg.id });
            work();
        } catch (e) {
            console.error("[AutoDelete]", e);
        }
    }

    // ---- settings UI ----------------------------------------------------
    function channelLabel(ch) {
        if (ch.type === 1) {
            const u = UserStore.getUser(ch.recipients?.[0]);
            return u?.globalName ?? u?.username ?? "Unknown user";
        }
        if (ch.name) return ch.name;
        const names = (ch.recipients ?? [])
            .map((id) => {
                const u = UserStore.getUser(id);
                return u?.globalName ?? u?.username;
            })
            .filter(Boolean);
        return names.length ? names.join(", ") : "Group DM";
    }

    function Settings() {
        useProxy(storage);

        const privateChannels = (ChannelStore.getSortedPrivateChannels?.() ?? []).slice();

        return h(
            ScrollView,
            null,
            h(
                FormSection,
                { title: "General" },
                h(FormRow, {
                    label: "Enabled",
                    trailing: h(FormSwitch, {
                        value: storage.enabled,
                        onValueChange: (v) => {
                            storage.enabled = v;
                        },
                    }),
                }),
                h(FormRow, {
                    label: "Also delete past messages",
                    subLabel: "When a DM is turned on, delete your old messages there too",
                    trailing: h(FormSwitch, {
                        value: !!storage.deleteOld,
                        onValueChange: (v) => {
                            storage.deleteOld = v;
                        },
                    }),
                }),
                h(FormInput, {
                    title: "Delay between deletes (seconds)",
                    value: String(storage.delay),
                    keyboardType: "numeric",
                    onChange: (v) => {
                        storage.delay = v;
                    },
                }),
                h(FormInput, {
                    title: "Random variation (± %, 0-100)",
                    value: String(storage.variation),
                    keyboardType: "numeric",
                    onChange: (v) => {
                        storage.variation = v;
                    },
                }),
                h(
                    FormText,
                    { style: { paddingHorizontal: 16, paddingVertical: 8, opacity: 0.7 } },
                    "Each delete waits the delay plus or minus a random amount. Example: 5s with 50% variation waits anywhere from 2.5s to 7.5s. Minimum is 0.5s."
                )
            ),
            h(
                FormSection,
                { title: "DMs to auto-delete in" },
                privateChannels.length === 0
                    ? h(FormRow, { label: "No DMs found" })
                    : privateChannels.map((ch) =>
                          h(FormRow, {
                              key: ch.id,
                              label: channelLabel(ch),
                              subLabel: ch.type === 3 ? "Group DM" : undefined,
                              trailing: h(FormSwitch, {
                                  value: !!storage.channels[ch.id],
                                  onValueChange: (v) => {
                                      if (v) {
                                          storage.channels[ch.id] = true;
                                          if (storage.deleteOld) purgeChannel(ch.id);
                                      } else {
                                          delete storage.channels[ch.id];
                                          delete purging[ch.id];
                                          for (let i = queue.length - 1; i >= 0; i--) {
                                              if (queue[i].channelId === ch.id) queue.splice(i, 1);
                                          }
                                      }
                                  },
                              }),
                          })
                      )
            )
        );
    }

    // ---- slash command --------------------------------------------------
    // /autodelete action:<start|stop|stopall|status> [delay] [variation]
    // Run it inside the DM you want to control.
    let unregisterCommand = null;

    function opt(name, description, required, choices) {
        const o = {
            name,
            displayName: name,
            description,
            displayDescription: description,
            required,
            type: 3, // STRING
        };
        if (choices) {
            o.choices = choices.map((c) => ({ name: c, displayName: c, value: c }));
        }
        return o;
    }

    function summary(channelId) {
        const on = !!storage.channels[channelId];
        const count = Object.keys(storage.channels).length;
        return (
            `Auto Delete is ${on ? "ON" : "OFF"} in this DM ` +
            `(${count} DM${count === 1 ? "" : "s"} active in total).\n` +
            `Delay: ${storage.delay}s, variation: ±${storage.variation}%.`
        );
    }

    function runCommand(args, ctx) {
        const a = {};
        for (const x of args ?? []) a[x.name] = x.value;
        const channelId = ctx?.channel?.id;
        const action = String(a.action ?? "status").toLowerCase();

        if (a.delay !== undefined && a.delay !== "") {
            const d = parseFloat(a.delay);
            if (isNaN(d) || d < 0.5) {
                return { send: false, content: "Delay must be a number of seconds, at least 0.5." };
            }
            storage.delay = String(d);
        }
        if (a.variation !== undefined && a.variation !== "") {
            const v = parseFloat(a.variation);
            if (isNaN(v) || v < 0 || v > 100) {
                return { send: false, content: "Variation must be a percentage from 0 to 100." };
            }
            storage.variation = String(v);
        }

        if (action === "stopall") {
            storage.channels = {};
            queue.length = 0;
            for (const id of Object.keys(purging)) delete purging[id];
            return { send: false, content: "Auto Delete stopped in every DM." };
        }

        const ch = channelId ? ChannelStore.getChannel(channelId) : null;
        if (action === "status") {
            return { send: false, content: channelId ? summary(channelId) : "Open a DM first." };
        }
        if (!ch || (ch.type !== 1 && ch.type !== 3)) {
            return { send: false, content: "Run this inside the DM or group DM you want to control." };
        }

        if (action === "start") {
            storage.enabled = true;
            storage.channels[channelId] = true;
            if (storage.deleteOld) purgeChannel(channelId);
            return {
                send: false,
                content:
                    "Started. " +
                    summary(channelId) +
                    (storage.deleteOld ? "\nAlso deleting your past messages here." : ""),
            };
        }
        if (action === "purge") {
            if (purging[channelId]) {
                return { send: false, content: "Already scanning this DM for your old messages." };
            }
            purgeChannel(channelId);
            return {
                send: false,
                content:
                    "Deleting your past messages in this DM, newest first, using your delay and variation. " +
                    "Use /autodelete action:stop to cancel.",
            };
        }
        if (action === "stop") {
            delete storage.channels[channelId];
            delete purging[channelId];
            for (let i = queue.length - 1; i >= 0; i--) {
                if (queue[i].channelId === channelId) queue.splice(i, 1);
            }
            return { send: false, content: "Stopped. " + summary(channelId) };
        }
        return { send: false, content: "Unknown action. Use start, purge, stop, stopall or status." };
    }

    function registerSlashCommand() {
        try {
            unregisterCommand = vendetta.commands.registerCommand({
                name: "autodelete",
                displayName: "autodelete",
                description: "Start or stop auto-deleting your messages in this DM",
                displayDescription: "Start or stop auto-deleting your messages in this DM",
                options: [
                    opt("action", "start, purge, stop, stopall or status", true, ["start", "purge", "stop", "stopall", "status"]),
                    opt("delay", "Seconds between deletes (optional)", false),
                    opt("variation", "Random variation in percent, 0-100 (optional)", false),
                ],
                applicationId: "-1",
                inputType: 1,
                type: 1,
                execute: runCommand,
            });
        } catch (e) {
            console.error("[AutoDelete] could not register /autodelete", e);
        }
    }

    // ---- plugin object --------------------------------------------------
    return {
        default: {
            onLoad() {
                stopped = false;
                FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
                registerSlashCommand();
            },
            onUnload() {
                stopped = true;
                queue.length = 0;
                for (const id of Object.keys(purging)) delete purging[id];
                FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
                try {
                    unregisterCommand?.();
                } catch (e) {}
                unregisterCommand = null;
            },
            settings: Settings,
        },
    };
})()
