(() => {
  const { findByProps, findByStoreName } = vendetta.metro;
  const { registerCommand } = vendetta.commands;
  const { showConfirmationAlert } = vendetta.ui.alerts;
  const { showToast } = vendetta.ui.toasts;

  const RestAPI = findByProps("getAPIBaseURL", "get");
  const ChannelStore = findByStoreName("ChannelStore");
  const UserStore = findByStoreName("UserStore");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toast = (msg) => showToast(msg);

  async function kick(channelId, userId) {
    const url = `/channels/${channelId}/recipients/${userId}`;
    try {
      await RestAPI.del({ url });
    } catch (e) {
      // Respect rate limits: wait the time Discord asks for, then retry once
      if (e?.status === 429) {
        const wait = ((e.body?.retry_after ?? 2) * 1000) + 250;
        await sleep(wait);
        await RestAPI.del({ url });
      } else {
        throw e;
      }
    }
  }

  async function purge(channelId, targets) {
    let done = 0;
    toast(`Removing ${targets.length} people...`);
    for (const id of targets) {
      try {
        await kick(channelId, id);
        done++;
      } catch (e) {
        console.error("[GroupPurge] failed for", id, e);
        toast(`Stopped after ${done}/${targets.length} (error ${e?.status ?? "?"})`);
        return;
      }
      await sleep(1500); // stay well under rate limits
    }
    toast(`Done — removed ${done} people.`);
  }

  let unregister;

  return {
    onLoad() {
      unregister = registerCommand({
        name: "purge-gc",
        displayName: "purge-gc",
        description: "Remove everyone except you from this group DM",
        displayDescription: "Remove everyone except you from this group DM",
        options: [],
        applicationId: "-1",
        inputType: 1,
        type: 1,
        execute(_args, ctx) {
          const channel = ChannelStore.getChannel(ctx.channel.id);
          const me = UserStore.getCurrentUser().id;

          if (!channel || channel.type !== 3) return toast("Run this inside a group DM.");
          if (channel.ownerId !== me) return toast("You're not the owner of this group, so you can't remove people.");

          const targets = (channel.recipients ?? []).filter((id) => id !== me);
          if (!targets.length) return toast("Nobody else is in this group.");

          showConfirmationAlert({
            title: "Remove everyone?",
            content: `This will remove ${targets.length} member(s) from "${channel.name || "this group"}". They'll see a removal notice in the chat. This can't be undone (you'd have to re-add them).`,
            confirmText: "Remove all",
            confirmColor: "red",
            cancelText: "Cancel",
            onConfirm: () => purge(channel.id, targets),
          });
          // return nothing so no message gets sent
        },
      });
    },
    onUnload() {
      unregister?.();
    },
  };
})()
