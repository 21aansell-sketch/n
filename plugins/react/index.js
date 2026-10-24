(() => {
    const { findByProps } = vendetta.metro;
    const { React, ReactNative } = vendetta.metro.common;
    const { before, after } = vendetta.patcher;
    const { findInReactTree } = vendetta.utils;
    const { showToast } = vendetta.ui.toasts;
    const { getAssetIDByName } = vendetta.ui.assets;
    const { storage } = vendetta.plugin;
    const { useProxy } = vendetta.storage;
    const log = vendetta.logger;

    const MAX_REACTIONS = 20; // Discord's hard limit of unique reactions per message
    const DEFAULT_EMOJIS = "😂 💀 🔥 😭 👍 👎 ❤️ 😈 🤡 💯 👀 🙏 😎 🤔 🥶 🤯 😡 🎉 🫡 🗿";

    let RestAPI, ActionSheet, ReactionActions;
    const unpatches = [];
    let unpatchSheet;
    let running = false;
    let cancelled = false;

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // ---- Emoji parsing ------------------------------------------------------------

    // Accepts unicode emojis, <:name:id>, <a:name:id> or name:id, split on spaces/commas.
    function parseEmojis(raw) {
        const out = [];
        const seen = new Set();
        const tokens = String(raw ?? "").match(/<a?:\w+:\d+>|\w+:\d+|[^\s,]+/g) ?? [];
        for (const t of tokens) {
            const custom = t.match(/^<?a?:?(\w+):(\d+)>?$/);
            // Unicode emojis typed with no spaces between them ("😂💀🔥") are split apart here.
            const keys = custom ? [`${custom[1]}:${custom[2]}`] : /[^\x00-\x7F]/.test(t) ? splitEmoji(t) : [t];
            for (const key of keys) {
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(key);
                if (out.length >= MAX_REACTIONS) return out;
            }
        }
        return out;
    }

    // Splits a run of emojis into individual emojis, keeping skin tones, ZWJ sequences,
    // variation selectors, keycaps and flags together.
    function splitEmoji(str) {
        const cps = Array.from(str);
        const isMod = c => {
            const n = c.codePointAt(0);
            return n === 0xFE0F || n === 0xFE0E || n === 0x20E3
                || (n >= 0x1F3FB && n <= 0x1F3FF) || (n >= 0xE0020 && n <= 0xE007F);
        };
        const isFlag = c => {
            const n = c.codePointAt(0);
            return n >= 0x1F1E6 && n <= 0x1F1FF;
        };
        const out = [];
        let i = 0;
        while (i < cps.length) {
            let g = cps[i++];
            if (isFlag(g) && i < cps.length && isFlag(cps[i])) g += cps[i++];
            while (i < cps.length) {
                if (isMod(cps[i])) g += cps[i++];
                else if (cps[i] === "‍" && i + 1 < cps.length) { g += cps[i] + cps[i + 1]; i += 2; }
                else break;
            }
            out.push(g);
        }
        return out;
    }

    // ---- Reacting -----------------------------------------------------------------

    function addReaction(channelId, messageId, emoji) {
        return RestAPI.put({
            url: `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
            query: { location: "Message Reaction Picker", type: 0 }
        });
    }

    function errorStatus(e) {
        return e?.status ?? e?.statusCode ?? e?.response?.status ?? e?.body?.status;
    }

    function errorText(e) {
        const status = errorStatus(e);
        const msg = e?.body?.message ?? e?.message ?? (typeof e === "string" ? e : "");
        return [status, msg].filter(Boolean).join(" ") || "unknown error";
    }

    // Fallback: Discord's own reaction action, used only if the raw REST call fails.
    function toEmojiObject(key) {
        const m = key.match(/^(\w+):(\d+)$/);
        return m ? { id: m[2], name: m[1], animated: false } : { id: null, name: key, animated: false };
    }

    async function addReactionFallback(channelId, messageId, key) {
        if (!ReactionActions?.addReaction) throw new Error("no fallback available");
        await ReactionActions.addReaction(channelId, messageId, toEmojiObject(key), "Message Reaction Picker");
    }

    async function spam(message) {
        if (running) return showToast("Reaction spam already running");
        if (!RestAPI?.put) return showToast("Couldn't find Discord's REST API");

        const emojis = parseEmojis(storage.emojis);
        if (!emojis.length) return showToast("Add some emojis in the plugin settings first");

        const delay = Math.max(0, parseInt(storage.delay, 10) || 0);
        running = true;
        cancelled = false;
        let sent = 0;
        let failed = 0;
        let lastError = null;

        try {
            for (const emoji of emojis) {
                if (cancelled) break;
                try {
                    try {
                        await addReaction(message.channel_id, message.id, emoji);
                    } catch (e) {
                        const status = errorStatus(e);
                        if (status === 429 || status === 401 || status === 403) throw e;
                        log.error("Reaction Spam: REST add failed, trying fallback", emoji, e);
                        await addReactionFallback(message.channel_id, message.id, emoji).catch(() => { throw e; });
                    }
                    sent++;
                } catch (e) {
                    const status = errorStatus(e);
                    if (status === 429) {
                        showToast(`Rate limited (429), stopped after ${sent} reaction(s)`);
                        return;
                    }
                    if (status === 401 || status === 403) {
                        showToast(`No permission to react (${status}), stopped`);
                        return;
                    }
                    // Bad emoji or some other per-emoji failure: skip it and carry on.
                    failed++;
                    lastError = e;
                    log.error("Reaction Spam: failed to add", emoji, e);
                }
                if (delay) await sleep(delay);
            }
            if (cancelled) showToast(`Stopped after ${sent} reaction(s)`);
            else if (!sent && lastError) showToast(`Added 0, all ${failed} failed: ${errorText(lastError)}`);
            else showToast(`Added ${sent}/${emojis.length} reaction(s)${failed ? `, ${failed} failed (${errorText(lastError)})` : ""}`);
        } catch (e) {
            log.error("Reaction Spam:", e);
            showToast("Reaction spam failed, check logs");
        } finally {
            running = false;
        }
    }

    // ---- Long-press menu ----------------------------------------------------------

    const isRow = el => el?.props && typeof el.props.label === "string" && typeof el.props.onPress === "function";

    function makeRow(template, key, label, iconNames, onPress) {
        const props = { key, label, onPress };
        const iconId = iconNames.map(n => getAssetIDByName?.(n)).find(Boolean);
        const icon = template.props.icon;
        if (iconId && React.isValidElement(icon)) props.icon = React.cloneElement(icon, { source: iconId });
        else if (iconId && typeof icon === "number") props.icon = iconId;
        return React.cloneElement(template, props);
    }

    function addRow(tree, message) {
        const rows = findInReactTree(tree, x => Array.isArray(x) && x.some(isRow));
        if (!rows || rows.some(r => r?.key === "reaction-spam")) return;
        const template = rows.find(isRow);

        rows.push(makeRow(
            template,
            "reaction-spam",
            running ? "Stop Reaction Spam" : "Spam Reactions",
            ["ic_add_reaction_24px", "ReactionIcon", "EmojiNewIcon", "ic_emoji_24px"],
            () => {
                ActionSheet?.hideActionSheet?.();
                if (running) {
                    cancelled = true;
                    showToast("Stopping...");
                } else {
                    spam(message);
                }
            }
        ));
    }

    function patchSheet() {
        ActionSheet = findByProps("openLazy", "hideActionSheet");
        if (!ActionSheet) return log.error("Reaction Spam: couldn't find the action sheet module");

        unpatches.push(before("openLazy", ActionSheet, ([lazy, key]) => {
            if (unpatchSheet || typeof key !== "string" || !key.includes("MessageLongPress")) return;
            Promise.resolve(lazy).then(mod => {
                if (unpatchSheet || !mod) return;
                const [target, prop] = typeof mod.default === "function" ? [mod, "default"]
                    : typeof mod.default?.type === "function" ? [mod.default, "type"] : [];
                if (!target) return log.error("Reaction Spam: unexpected message menu shape");
                unpatchSheet = after(prop, target, ([props], tree) => {
                    try {
                        if (props?.message?.id) addRow(tree, props.message);
                    } catch (e) {
                        log.error("Reaction Spam: couldn't add menu button", e);
                    }
                });
            }).catch(e => log.error("Reaction Spam: action sheet error", e));
        }));
    }

    // ---- Settings -----------------------------------------------------------------

    function Settings() {
        useProxy(storage);
        const { ScrollView, View, Text, TextInput } = ReactNative;

        const label = { color: "#ffffff", fontSize: 16, fontWeight: "600", marginBottom: 6 };
        const hint = { color: "#b5bac1", fontSize: 13, marginTop: 6 };
        const input = {
            color: "#ffffff",
            backgroundColor: "#1e1f22",
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
            fontSize: 16
        };

        return React.createElement(ScrollView, { contentContainerStyle: { padding: 16, gap: 20 } },
            React.createElement(View, null,
                React.createElement(Text, { style: label }, "Emojis (max 20)"),
                React.createElement(TextInput, {
                    style: { ...input, minHeight: 80, textAlignVertical: "top" },
                    multiline: true,
                    value: storage.emojis ?? "",
                    placeholder: "😂 💀 🔥  or  <:name:id>",
                    placeholderTextColor: "#80848e",
                    onChangeText: v => { storage.emojis = v; }
                }),
                React.createElement(Text, { style: hint },
                    "Separate with spaces or commas. Custom emojis: <:name:id> or name:id. " +
                    "Discord only allows 20 unique reactions per message, so duplicates are removed and the list is capped at 20.")
            ),
            React.createElement(View, null,
                React.createElement(Text, { style: label }, "Delay between reactions (ms)"),
                React.createElement(TextInput, {
                    style: input,
                    value: String(storage.delay ?? ""),
                    placeholder: "400",
                    placeholderTextColor: "#80848e",
                    keyboardType: "numeric",
                    onChangeText: v => { storage.delay = v.replace(/[^0-9]/g, ""); }
                }),
                React.createElement(Text, { style: hint },
                    "Long press a message and tap Spam Reactions. It stops straight away on a 429. Raise the delay if you keep hitting it.")
            )
        );
    }

    return {
        onLoad() {
            storage.emojis ??= DEFAULT_EMOJIS;
            storage.delay ??= "400";
            RestAPI = findByProps("getAPIBaseURL", "get", "put") ?? findByProps("getAPIBaseURL", "put");
            if (!RestAPI) log.error("Reaction Spam: couldn't find the REST API module");
            ReactionActions = findByProps("addReaction", "removeReaction") ?? findByProps("addReaction");
            patchSheet();
        },
        onUnload() {
            cancelled = true;
            unpatchSheet?.();
            unpatchSheet = null;
            unpatches.splice(0).forEach(u => u());
        },
        settings: Settings
    };
})()
