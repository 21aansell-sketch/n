(() => {
    const { registerCommand } = vendetta.commands;
    const { findByProps } = vendetta.metro;
    const { FluxDispatcher } = vendetta.metro.common;

    const MessageActions = findByProps("sendMessage", "receiveMessage");
    const Deleter = findByProps("deleteMessage", "startEditMessage") ?? MessageActions;

    const pending = new Set();
    let unregister;

    // Fast path: talk to Discord's REST API directly. This skips the client's send queue
    // and optimistic-message handling, so the delete fires the moment the server replies.
    const RestAPI = findByProps("getAPIBaseURL", "get");
    const restDelete = RestAPI && (RestAPI.del ?? RestAPI.delete);

    async function sendAndDeleteFast(channelId, content, delayMs, silent) {
        const res = await RestAPI.post({
            url: `/channels/${channelId}/messages`,
            body: {
                content,
                tts: false,
                nonce: String(Date.now()) + String(Math.floor(Math.random() * 1e6)),
                // 4096 = SUPPRESS_NOTIFICATIONS, the flag the app sets for "@silent"
                ...(silent ? { flags: 4096 } : {})
            }
        });
        const id = res?.body?.id;
        if (!id) throw new Error("no message id in response");
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        await restDelete.call(RestAPI, { url: `/channels/${channelId}/messages/${id}` });
    }

    function sendAndDelete(channelId, content, delayMs, silent) {
        if (RestAPI?.post && restDelete) {
            sendAndDeleteFast(channelId, content, delayMs, silent)
                .catch(e => console.error("[GhostPing] fast path failed", e));
            return;
        }
        return sendAndDeleteSlow(channelId, content, delayMs, silent);
    }

    function sendAndDeleteSlow(channelId, content, delayMs, silent) {
        const nonce = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
        let done = false;
        let timeout;

        const cleanup = () => {
            done = true;
            FluxDispatcher.unsubscribe("MESSAGE_CREATE", onCreate);
            clearTimeout(timeout);
            pending.delete(cleanup);
        };

        const remove = (id) => {
            if (done) return;
            cleanup();
            const doDelete = () => {
                try { Deleter.deleteMessage(channelId, id); } catch (e) { console.error("[GhostPing] delete failed", e); }
            };
            if (delayMs > 0) setTimeout(doDelete, delayMs); else doDelete();
        };

        // The confirmed (non-optimistic) message arrives via MESSAGE_CREATE with our nonce.
        function onCreate(event) {
            const m = event?.message;
            if (!m || event.optimistic || m.nonce !== nonce || m.state === "SENDING") return;
            remove(m.id);
        }

        FluxDispatcher.subscribe("MESSAGE_CREATE", onCreate);
        pending.add(cleanup);
        timeout = setTimeout(cleanup, 15000);

        const res = MessageActions.sendMessage(
            channelId,
            {
                // Discord turns a leading "@silent " into the suppress-notifications flag server-side
                content: silent ? `@silent ${content}` : content,
                invalidEmojis: [],
                tts: false,
                validNonShortcutEmojis: []
            },
            undefined,
            { nonce }
        );

        // Fallback: some versions resolve with the created message.
        Promise.resolve(res).then(r => {
            const id = r?.body?.id;
            if (id) remove(id);
        }).catch(() => {});
    }

    return {
        onLoad() {
            unregister = registerCommand({
                name: "ghostping",
                displayName: "ghostping",
                description: "Send a message and delete it right after (ghost ping)",
                displayDescription: "Send a message and delete it right after (ghost ping)",
                applicationId: "-1",
                inputType: 1,
                type: 1,
                options: [
                    {
                        name: "user",
                        displayName: "user",
                        description: "User to ping",
                        displayDescription: "harrass someone",
                        required: false,
                        type: 6
                    },
                    {
                        name: "message",
                        displayName: "message",
                        description: "Extra text (use <@userId> to ping more people)",
                        displayDescription: "say somthing they wont read or ping more people",
                        required: false,
                        type: 3
                    },
                    {
                        name: "delay",
                        displayName: "delay",
                        description: "Milliseconds to wait before deleting (default 0)",
                        displayDescription: "these are miliseleconds before deleting. its at 0.",
                        required: false,
                        type: 4
                    },
                    {
                        name: "silent",
                        displayName: "silent",
                        description: "Send as a silent message (no push/desktop notification)",
                        displayDescription: "Send as a silent message (no push/desktop notification)",
                        required: false,
                        type: 5
                    }
                ],
                execute(args, ctx) {
                    const get = (n) => args.find(a => a.name === n)?.value;
                    const user = get("user");
                    const text = get("message");
                    const delay = Math.max(0, Number(get("delay")) || 0);

                    const content = [user ? `<@${user}>` : "", text ?? ""].filter(Boolean).join(" ");
                    if (!content) return { content: "GhostPing: give me a user or a message." , ephemeral: true };

                    sendAndDelete(ctx.channel.id, content, delay, !!get("silent"));
                }
            });
        },
        onUnload() {
            unregister?.();
            for (const c of [...pending]) c();
        }
    };
})()
