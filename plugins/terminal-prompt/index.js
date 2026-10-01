(() => {
    const { findByProps, findByStoreName } = vendetta.metro;
    const { React } = vendetta.metro.common;
    const { after } = vendetta.patcher;
    const log = vendetta.logger;

    const MARK = "@discord:~";
    const DM = 1;
    const GROUP_DM = 3;

    let UserStore, ChannelStore, SelectedChannelStore;
    let reported = false;
    const unpatches = [];

    const nameOf = user => user?.username ?? user?.globalName ?? null;

    function currentChannel() {
        const id = SelectedChannelStore?.getChannelId?.();
        return id ? ChannelStore?.getChannel?.(id) ?? null : null;
    }

    // What goes after "~/": #channel, @user for DMs, or the group DM's name.
    function location(channel, original) {
        if (channel) {
            if (channel.type === DM) {
                const other = UserStore?.getUser?.(channel.recipients?.[0]);
                if (nameOf(other)) return `@${nameOf(other)}`;
            } else if (channel.type === GROUP_DM) {
                if (channel.name) return channel.name.replace(/\s+/g, "-");
            } else if (channel.name) {
                return `#${channel.name}`;
            }
        }
        const match = original.match(/[#@]\S.*$/);
        return match ? match[0] : "";
    }

    // The chat box placeholder names the channel ("Message #general"), so use
    // that to tell it apart from every other text input in the app.
    function isChatPlaceholder(placeholder, channel) {
        if (typeof placeholder !== "string" || !placeholder || placeholder.includes(MARK)) return false;
        const mentionsSomeone = /(^|\s)[#@]\S/.test(placeholder);
        if (!channel) return mentionsSomeone;
        if (channel.type === DM) {
            const other = UserStore?.getUser?.(channel.recipients?.[0]);
            // Friend nicknames can replace the name, so accept any "@name" as well.
            return mentionsSomeone || [other?.username, other?.globalName].some(n => n && placeholder.includes(n));
        }
        return !!channel.name && placeholder.includes(channel.name);
    }

    function rewrite(props) {
        const channel = currentChannel();
        if (!isChatPlaceholder(props.placeholder, channel)) return;

        const me = nameOf(UserStore?.getCurrentUser?.()) ?? "user";
        const where = location(channel, props.placeholder);
        props.placeholder = `${me}${MARK}${where ? "/" + where : ""}$`;

        if (!reported) {
            reported = true;
            log.log("Terminal Prompt: chat placeholder found and replaced");
        }
    }

    // Runs after every element is created, so keep the fast path tiny.
    function onElement(_, element) {
        const props = element?.props;
        if (props && typeof props.placeholder === "string") {
            try {
                rewrite(props);
            } catch (e) {
                log.error("Terminal Prompt:", e);
            }
        }
        return element;
    }

    return {
        onLoad() {
            UserStore = findByStoreName("UserStore");
            ChannelStore = findByStoreName("ChannelStore");
            SelectedChannelStore = findByStoreName("SelectedChannelStore");

            // Discord builds its UI with the JSX runtime (and createElement in older code),
            // so patching these catches the chat box wherever it lives in the tree.
            const jsxRuntime = findByProps("jsx", "jsxs");
            if (jsxRuntime) {
                unpatches.push(after("jsx", jsxRuntime, onElement));
                unpatches.push(after("jsxs", jsxRuntime, onElement));
            }
            if (React?.createElement) unpatches.push(after("createElement", React, onElement));

            if (!unpatches.length) log.error("Terminal Prompt: couldn't find the JSX runtime or React");
        },
        onUnload() {
            unpatches.splice(0).forEach(u => u());
        }
    };
})()
