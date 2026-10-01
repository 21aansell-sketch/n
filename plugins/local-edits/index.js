(() => {
    const { findByProps, findByStoreName } = vendetta.metro;
    const { React, FluxDispatcher } = vendetta.metro.common;
    const { before, after } = vendetta.patcher;
    const { findInReactTree } = vendetta.utils;
    const { registerCommand } = vendetta.commands;
    const { showToast } = vendetta.ui.toasts;
    const { getAssetIDByName } = vendetta.ui.assets;
    const { storage } = vendetta.plugin;
    const log = vendetta.logger;

    const STRING = 3;
    const BOOLEAN = 5;

    storage.hidden ??= {}; // messageId -> channelId
    storage.edits ??= {};  // messageId -> { channelId, content, original }

    let MessageStore, SelectedChannelStore, PendingReplyStore, MessageActions, ActionSheet;
    const unpatches = [];
    let unpatchSheet;
    let active = false; // cached so the per-event check stays cheap

    const refresh = () => {
        active = Object.keys(storage.hidden).length > 0 || Object.keys(storage.edits).length > 0;
    };
    const later = fn => setTimeout(() => {
        try { fn(); } catch (e) { log.error("Local Edits:", e); }
    }, 0);

    // ---- Applying changes to what Discord shows -------------------------------

    function dispatchDelete(id, channelId) {
        FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", id, channelId, __localEdits: true });
    }

    function dispatchContent(id, channelId, content) {
        FluxDispatcher.dispatch({
            type: "MESSAGE_UPDATE",
            message: { id, channel_id: channelId, content },
            __localEdits: true
        });
    }

    function withEdit(message) {
        const edit = message?.id && storage.edits[message.id];
        return edit ? { ...message, content: edit.content } : message;
    }

    // Swap in edited text, and note hidden messages so they can be removed once
    // Discord has stored them. Removing them from the list itself would make Discord
    // think it had reached the start of the channel and stop loading history.
    function processList(list, toHide) {
        return list.map(item => {
            if (Array.isArray(item)) return processList(item, toHide);
            if (item?.id && storage.hidden[item.id]) toHide.push([item.id, item.channel_id ?? storage.hidden[item.id]]);
            return withEdit(item);
        });
    }

    function interceptor(action) {
        if (!active || !action?.type || action.__localEdits) return false;
        try {
            const message = action.message;
            if (message?.id && (action.type === "MESSAGE_UPDATE" || action.type === "MESSAGE_CREATE")) {
                if (storage.hidden[message.id]) return true; // drop it entirely
                if (storage.edits[message.id]) action.message = withEdit(message);
            }
            if (Array.isArray(action.messages)) {
                const toHide = [];
                action.messages = processList(action.messages, toHide);
                // Re-check: a restore may have happened before this runs.
                if (toHide.length) later(() => toHide.forEach(([id, ch]) => storage.hidden[id] && dispatchDelete(id, ch)));
            }
        } catch (e) {
            log.error("Local Edits: interceptor failed", e);
        }
        return false;
    }

    // For messages that were already on screen before the plugin started.
    function applyToLoaded() {
        for (const [id, channelId] of Object.entries(storage.hidden)) {
            if (MessageStore?.getMessage?.(channelId, id)) dispatchDelete(id, channelId);
        }
        for (const [id, edit] of Object.entries(storage.edits)) {
            if (MessageStore?.getMessage?.(edit.channelId, id)) dispatchContent(id, edit.channelId, edit.content);
        }
    }

    // ---- Actions ----------------------------------------------------------------

    function hide(message) {
        storage.hidden[message.id] = message.channel_id;
        delete storage.edits[message.id];
        refresh();
        dispatchDelete(message.id, message.channel_id);
    }

    function edit(message, content) {
        const previous = storage.edits[message.id];
        storage.edits[message.id] = {
            channelId: message.channel_id,
            content,
            original: previous ? previous.original : message.content ?? null
        };
        refresh();
        dispatchContent(message.id, message.channel_id, content);
    }

    // Hidden messages are gone from Discord's memory, so load them back from the server.
    function reloadAround(channelId, messageId) {
        try {
            if (MessageActions?.fetchMessages) {
                MessageActions.fetchMessages({ channelId, limit: 50, jump: { messageId, flash: true } });
                return true;
            }
            if (MessageActions?.jumpToMessage) {
                MessageActions.jumpToMessage({ channelId, messageId, flash: true });
                return true;
            }
        } catch (e) {
            log.error("Local Edits: couldn't reload messages", e);
        }
        return false;
    }

    // Returns false when a hidden message needs a restart to come back.
    function restore(id) {
        let ok = true;
        const edited = storage.edits[id];
        if (edited) {
            delete storage.edits[id];
            if (edited.original != null) dispatchContent(id, edited.channelId, edited.original);
            else ok = reloadAround(edited.channelId, id) && ok;
        }
        const channelId = storage.hidden[id];
        if (channelId) {
            delete storage.hidden[id];
            ok = reloadAround(channelId, id) && ok;
        }
        refresh();
        return ok;
    }

    // Kettu's showInputAlert uses an alert component newer Discord no longer has (it crashes),
    // so build the dialog from the same pieces Kettu's own "install plugin" box uses.
    const EDITOR_KEY = "LocalEditsEditor";
    const { View } = vendetta.metro.common.ReactNative;

    // Looked up directly rather than through Kettu's lazy wrappers, so a missing
    // component shows up as undefined here instead of crashing when drawn.
    const single = prop => vendetta.metro.find(m => m?.[prop] && Object.keys(m).length === 1)?.[prop];

    function editorParts() {
        const modal = findByProps("AlertModal", "AlertActions") ?? {};
        const alerts = findByProps("openAlert", "dismissAlert") ?? {};
        return {
            AlertModal: modal.AlertModal,
            AlertActionButton: modal.AlertActionButton,
            TextInput: single("TextInput"),
            Button: single("Button"),
            openAlert: alerts.openAlert,
            dismissAlert: alerts.dismissAlert,
            // Older Discord versions have no extraContent, so the input goes into content instead.
            hasExtraContent: !!globalThis.bunny?.metro?.findByFilePath?.("modules/forwarding/native/ForwardFailedAlertModal.tsx")
        };
    }

    function EditorAlert({ parts, message, initial }) {
        const { AlertModal, AlertActionButton, TextInput, Button, dismissAlert, hasExtraContent } = parts;
        const [value, setValue] = React.useState(initial);
        const [error, setError] = React.useState("");

        const save = () => {
            if (!value || !value.trim()) return setError("Message can't be empty; use Hide instead");
            edit(message, value);
            dismissAlert(EDITOR_KEY);
        };

        const input = React.createElement(TextInput, {
            autoFocus: true,
            isClearable: true,
            value,
            onChange: v => {
                setValue(typeof v === "string" ? v : v?.text ?? "");
                if (error) setError("");
            },
            returnKeyType: "done",
            onSubmitEditing: save,
            state: error ? "error" : undefined,
            errorMessage: error || undefined
        });

        const actions = React.createElement(View, { style: { gap: 8 } },
            Button
                ? React.createElement(Button, { text: "Save", variant: "primary", onPress: save })
                : React.createElement(AlertActionButton, { text: "Save", variant: "primary", onPress: save }),
            React.createElement(AlertActionButton, { text: "Cancel", variant: "secondary" })
        );

        return hasExtraContent
            ? React.createElement(AlertModal, { title: "Edit locally", content: "New text for this message:", extraContent: input, actions })
            : React.createElement(AlertModal, { title: "Edit locally", content: React.createElement(View, { style: { gap: 16 } }, input), actions });
    }

    function openEditor(message) {
        const parts = editorParts();
        const missing = ["AlertModal", "AlertActionButton", "TextInput", "openAlert", "dismissAlert"].filter(k => !parts[k]);
        if (missing.length) {
            log.error("Local Edits: edit dialog unavailable, missing", missing.join(", "));
            return void showToast("Edit box unavailable here. Reply to the message and use /ledit instead");
        }
        const initial = storage.edits[message.id]?.content ?? message.content ?? "";
        parts.openAlert(EDITOR_KEY, React.createElement(EditorAlert, { parts, message, initial }));
    }

    // ---- Long-press menu ---------------------------------------------------------

    const isRow = el => el?.props && typeof el.props.label === "string" && typeof el.props.onPress === "function";

    function makeRow(template, key, label, iconName, onPress) {
        const props = { key, label, onPress };
        const iconId = getAssetIDByName?.(iconName);
        const icon = template.props.icon;
        if (iconId && React.isValidElement(icon)) props.icon = React.cloneElement(icon, { source: iconId });
        else if (iconId && typeof icon === "number") props.icon = iconId;
        return React.cloneElement(template, props);
    }

    function addRows(tree, message) {
        const rows = findInReactTree(tree, x => Array.isArray(x) && x.some(isRow));
        if (!rows || rows.some(r => r?.key === "local-edits-edit")) return;
        const template = rows.find(isRow);
        const close = () => ActionSheet?.hideActionSheet?.();

        rows.push(makeRow(template, "local-edits-edit", "Edit locally", "PencilIcon", () => {
            close();
            openEditor(message);
        }));
        rows.push(makeRow(template, "local-edits-hide", "Hide locally", "EyeSlashIcon", () => {
            close();
            hide(message);
        }));
        if (storage.edits[message.id]) {
            rows.push(makeRow(template, "local-edits-restore", "Restore original", "RetryIcon", () => {
                close();
                restore(message.id);
            }));
        }
    }

    function patchSheet() {
        ActionSheet = findByProps("openLazy", "hideActionSheet");
        if (!ActionSheet) return log.error("Local Edits: couldn't find the action sheet module, use the commands instead");

        unpatches.push(before("openLazy", ActionSheet, ([lazy, key]) => {
            if (unpatchSheet || typeof key !== "string" || !key.includes("MessageLongPress")) return;
            Promise.resolve(lazy).then(mod => {
                if (unpatchSheet || !mod) return;
                const [target, prop] = typeof mod.default === "function" ? [mod, "default"]
                    : typeof mod.default?.type === "function" ? [mod.default, "type"] : [];
                if (!target) return log.error("Local Edits: unexpected message menu shape");
                unpatchSheet = after(prop, target, ([props], tree) => {
                    try {
                        if (props?.message?.id) addRows(tree, props.message);
                    } catch (e) {
                        log.error("Local Edits: couldn't add menu buttons", e);
                    }
                });
            });
        }));
    }

    // ---- Commands (fallback if the menu buttons don't show up) -------------------

    const arg = (args, name) => args?.find(a => a?.name === name)?.value;

    // Accepts a message link, a bare message ID, or falls back to the message you're replying to.
    function targetMessage(args, ctx) {
        const channelId = ctx?.channel?.id ?? SelectedChannelStore?.getChannelId?.();
        const ref = typeof arg(args, "message") === "string" ? arg(args, "message").trim() : "";
        if (ref) {
            const link = ref.match(/channels\/(?:\d+|@me)\/(\d+)\/(\d+)/);
            const [ch, id] = link ? [link[1], link[2]] : [channelId, ref.match(/^\d+$/)?.[0]];
            if (!id) return null;
            return MessageStore?.getMessage?.(ch, id) ?? { id, channel_id: ch, content: null };
        }
        return PendingReplyStore?.getPendingReply?.(channelId)?.message ?? null;
    }

    const messageOption = {
        name: "message",
        displayName: "message",
        description: "Message link or ID (or reply to the message instead)",
        displayDescription: "Message link or ID (or reply to the message instead)",
        type: STRING,
        required: false
    };

    const commands = [
        {
            name: "lhide",
            description: "Hide a message on your phone only",
            options: [messageOption],
            execute(args, ctx) {
                const message = targetMessage(args, ctx);
                if (!message) return void showToast("Reply to a message, or pass a message link or ID");
                hide(message);
                showToast("Hidden locally");
            }
        },
        {
            name: "ledit",
            description: "Change a message's text on your phone only",
            options: [
                { name: "text", displayName: "text", description: "New text", displayDescription: "New text", type: STRING, required: true },
                messageOption
            ],
            execute(args, ctx) {
                const message = targetMessage(args, ctx);
                const text = arg(args, "text");
                if (!message) return void showToast("Reply to a message, or pass a message link or ID");
                if (!text || !String(text).trim()) return void showToast("Give the new text");
                edit(message, String(text));
                showToast("Edited locally");
            }
        },
        {
            name: "lrestore",
            description: "Undo local edits and hides (one message, this channel, or everything)",
            options: [
                messageOption,
                { name: "all", displayName: "all", description: "Restore everything, in every channel", displayDescription: "Restore everything, in every channel", type: BOOLEAN, required: false }
            ],
            execute(args, ctx) {
                const channelId = ctx?.channel?.id ?? SelectedChannelStore?.getChannelId?.();
                const one = targetMessage(args, ctx);
                const ids = arg(args, "all")
                    ? [...Object.keys(storage.hidden), ...Object.keys(storage.edits)]
                    : one ? [one.id]
                    : [
                        ...Object.keys(storage.hidden).filter(id => storage.hidden[id] === channelId),
                        ...Object.keys(storage.edits).filter(id => storage.edits[id].channelId === channelId)
                    ];
                const unique = [...new Set(ids)];
                if (!unique.length) return void showToast("Nothing to restore");
                const ok = unique.map(restore).every(Boolean);
                showToast(ok
                    ? `Restored ${unique.length} message${unique.length === 1 ? "" : "s"}`
                    : "Restored. Some hidden messages come back after a restart");
            }
        }
    ];

    return {
        onLoad() {
            MessageStore = findByStoreName("MessageStore");
            SelectedChannelStore = findByStoreName("SelectedChannelStore");
            PendingReplyStore = findByStoreName("PendingReplyStore");
            MessageActions = findByProps("fetchMessages", "sendMessage") ?? findByProps("jumpToMessage");

            if (FluxDispatcher) {
                (FluxDispatcher._interceptors ??= []).unshift(interceptor);
                unpatches.push(() => {
                    if (FluxDispatcher._interceptors) FluxDispatcher._interceptors = FluxDispatcher._interceptors.filter(i => i !== interceptor);
                });
            } else {
                log.error("Local Edits: couldn't find FluxDispatcher");
            }

            refresh();
            patchSheet();
            for (const command of commands) unpatches.push(registerCommand({ displayName: command.name, displayDescription: command.description, ...command }));
            applyToLoaded();
        },
        onUnload() {
            // Show the real text again while the plugin is off; the saved edits come back when it's on.
            for (const [id, e] of Object.entries(storage.edits)) {
                if (e.original != null && MessageStore?.getMessage?.(e.channelId, id)) dispatchContent(id, e.channelId, e.original);
            }
            unpatchSheet?.();
            unpatchSheet = null;
            unpatches.splice(0).forEach(u => u());
        }
    };
})()
