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
                                      if (v) storage.channels[ch.id] = true;
                                      else delete storage.channels[ch.id];
                                  },
                              }),
                          })
                      )
            )
        );
    }

    // ---- plugin object --------------------------------------------------
    return {
        default: {
            onLoad() {
                stopped = false;
                FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
            },
            onUnload() {
                stopped = true;
                queue.length = 0;
                FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
            },
            settings: Settings,
        },
    };
})()
