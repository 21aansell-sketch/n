(function () {
    const { registerCommand } = vendetta.commands;
    const { findByProps, findByStoreName } = vendetta.metro;
    const { showConfirmationAlert } = vendetta.ui.alerts;
    const { showToast } = vendetta.ui.toasts;

    const ChannelStore = findByStoreName("ChannelStore");
    const UserStore = findByStoreName("UserStore");
    const RestAPI = findByProps("getAPIBaseURL", "get");

    const GROUP_DM = 3;
    const DELAY_MS = 1200; // stay under Discord's rate limit
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const toast = msg => showToast(msg);

    async function removeAll(channelId, ids) {
        let ok = 0;
        let failed = 0;
        for (const id of ids) {
            try {
                await RestAPI.del({ url: `/channels/${channelId}/recipients/${id}` });
                ok++;
            } catch (e) {
                failed++;
                // 429 = rate limited: wait longer and retry once
                if (e?.status === 429) {
                    await sleep((e?.body?.retry_after ?? 3) * 1000 + 500);
                    try {
                        await RestAPI.del({ url: `/channels/${channelId}/recipients/${id}` });
                        ok++;
                        failed--;
                    } catch {}
                }
            }
            await sleep(DELAY_MS);
        }
        toast(`Removed ${ok} member(s)${failed ? `, ${failed} failed` : ""}.`);
    }

    const unregister = registerCommand({
        name: "clearchat",
        displayName: "clearchat",
        description: "Remove everyone else from this group chat (owner only)",
        displayDescription: "Remove everyone else from this group chat (owner only)",
        options: [],
        applicationId: "-1",
        inputType: 1,
        type: 1,
        execute(_args, ctx) {
            const channel = ChannelStore.getChannel(ctx.channel.id);
            const me = UserStore.getCurrentUser()?.id;

            if (!channel || channel.type !== GROUP_DM) {
                toast("This only works in a group chat.");
                return;
            }
            if (channel.ownerId !== me) {
                toast("You must be the owner of this group chat.");
                return;
            }

            const targets = (channel.recipients ?? []).filter(id => id !== me);
            if (!targets.length) {
                toast("There is nobody else in this group chat.");
                return;
            }

            showConfirmationAlert({
                title: "Remove everyone?",
                content: `This will remove ${targets.length} member(s) from this group chat.`,
                confirmText: "Remove all",
                confirmColor: "red",
                cancelText: "Cancel",
                onConfirm: () => removeAll(channel.id, targets),
            });
        },
    });

    return {
        onUnload() {
            unregister();
        },
    };
})()
