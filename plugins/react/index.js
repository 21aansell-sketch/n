(() => {
    const { metro, patcher, storage: pluginStorage, plugin, ui, utils } = vendetta;
    const { findByProps } = metro;
    const { React, ReactNative } = metro.common;
    const { before, after } = patcher;
    const { showToast } = ui.toasts;
    const { Forms } = ui.components;
    const { useProxy } = vendetta.storage;
    const { findInReactTree } = utils;

    const MAX_REACTIONS = 20; // Discord's hard limit of unique reactions per message
    const DEFAULT_EMOJIS = "😂 💀 🔥 😭 👍 👎 ❤️ 😈 🤡 💯 👀 🙏 😎 🤔 🥶 🤯 😡 🎉 🫡 🗿";

    const RestAPI = findByProps("getAPIBaseURL", "get", "put");
    const ActionSheet = findByProps("openLazy", "hideActionSheet");
    const ActionSheetRow = findByProps("ActionSheetRow")?.ActionSheetRow;
    const ButtonRow = ActionSheetRow ?? Forms.FormRow;

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const unpatches = [];
    let running = false;
    let cancelled = false;

    const store = () => plugin.storage;

    // Accepts: unicode emojis, <:name:id>, <a:name:id>, or name:id. Split on whitespace/commas.
    function parseEmojis(raw) {
        const out = [];
        const seen = new Set();
        const tokens = String(raw ?? "").match(/<a?:\w+:\d+>|\w+:\d+|[^\s,]+/g) ?? [];
        for (const t of tokens) {
            const custom = t.match(/^<?a?:?(\w+):(\d+)>?$/);
            const key = custom ? `${custom[1]}:${custom[2]}` : t;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(key);
            if (out.length >= MAX_REACTIONS) break;
        }
        return out;
    }

    async function addReaction(channelId, messageId, emoji) {
        await RestAPI.put({
            url: `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
            query: { location: "Message Reaction Picker", type: 0 }
        });
    }

    function errorStatus(e) {
        return e?.status ?? e?.statusCode ?? e?.response?.status ?? e?.body?.status;
    }

    async function spam(message) {
        if (running) return showToast("Reaction spam already running");
        if (!RestAPI?.put) return showToast("RestAPI not found, can't react");

        const emojis = parseEmojis(store().emojis);
        if (!emojis.length) return showToast("Add some emojis in plugin settings first");

        const delay = Math.max(0, parseInt(store().delay, 10) || 0);
        running = true;
        cancelled = false;
        let sent = 0;

        try {
            for (const emoji of emojis) {
                if (cancelled) break;
                try {
                    await addReaction(message.channel_id, message.id, emoji);
                    sent++;
                } catch (e) {
                    const status = errorStatus(e);
                    if (status === 429) {
                        showToast(`Rate limited (429) - stopped after ${sent} reaction(s)`);
                        return;
                    }
                    if (status === 403 || status === 401) {
                        showToast(`No permission to react (${status}) - stopped`);
                        return;
                    }
                    // Bad/unknown emoji or other per-emoji failure: skip it and carry on
                    console.warn("[ReactionSpam] failed to add", emoji, e);
                }
                if (delay) await sleep(delay);
            }
            showToast(cancelled ? `Stopped after ${sent} reaction(s)` : `Added ${sent} reaction(s)`);
        } catch (e) {
            console.error("[ReactionSpam]", e);
            showToast("Reaction spam failed, check logs");
        } finally {
            running = false;
        }
    }

    function patchActionSheet() {
        if (!ActionSheet?.openLazy) return;

        unpatches.push(
            before("openLazy", ActionSheet, ([component, key, ctx]) => {
                const message = ctx?.message;
                if (key !== "MessageLongPressActionSheet" || !message) return;

                component.then(instance => {
                    const unpatch = after("default", instance, (_, comp) => {
                        React.useEffect(() => () => { unpatch(); }, []);
                        try {
                            const rows = findInReactTree(comp, x =>
                                Array.isArray(x) && x.some(c => {
                                    const n = c?.type?.name ?? c?.type?.displayName;
                                    return n === "ButtonRow" || n === "ActionSheetRow";
                                })
                            );
                            if (!rows || rows.some(r => r?.key === "reaction-spam")) return;

                            const props = {
                                key: "reaction-spam",
                                label: running ? "Stop Reaction Spam" : "Spam Reactions",
                                onPress: () => {
                                    ActionSheet.hideActionSheet?.();
                                    if (running) cancelled = true;
                                    else spam(message);
                                }
                            };
                            if (ActionSheetRow) props.icon = undefined;
                            else props.leading = undefined;
                            rows.unshift(React.createElement(ButtonRow, props));
                        } catch (e) {
                            console.error("[ReactionSpam] failed to add button", e);
                        }
                    });
                }).catch(e => console.error("[ReactionSpam] action sheet error", e));
            })
        );
    }

    function Settings() {
        useProxy(plugin.storage);
        const { FormSection, FormInput, FormText } = Forms;
        const { ScrollView } = ReactNative;
        return React.createElement(ScrollView, null,
            React.createElement(FormSection, { title: "Reaction Spam", android_noDivider: true },
                React.createElement(FormInput, {
                    title: "Emojis (max 20)",
                    placeholder: "😂 💀 🔥  or  <:name:id>",
                    value: plugin.storage.emojis,
                    onChange: v => { plugin.storage.emojis = v; },
                    multiline: true
                }),
                React.createElement(FormText, null,
                    "Separate with spaces or commas. Custom emojis: <:name:id> or name:id. " +
                    "Discord only allows 20 unique reactions per message, so duplicates are removed and the list is capped at 20."),
                React.createElement(FormInput, {
                    title: "Delay between reactions (ms)",
                    placeholder: "400",
                    value: String(plugin.storage.delay ?? ""),
                    onChange: v => { plugin.storage.delay = v.replace(/[^0-9]/g, ""); },
                    keyboardType: "numeric"
                }),
                React.createElement(FormText, null,
                    "Long press a message and tap Spam Reactions. It stops immediately on a 429 rate limit. Raise the delay if you keep hitting it.")
            )
        );
    }

    return {
        onLoad() {
            plugin.storage.emojis ??= DEFAULT_EMOJIS;
            plugin.storage.delay ??= "400";
            try {
                patchActionSheet();
            } catch (e) {
                console.error("[ReactionSpam] failed to load", e);
                showToast("Reaction Spam failed to load");
            }
        },
        onUnload() {
            cancelled = true;
            for (const u of unpatches) {
                try { u(); } catch {}
            }
            unpatches.length = 0;
        },
        settings: Settings
    };
})()
