(() => {
    const { registerCommand } = vendetta.commands;
    const { showToast } = vendetta.ui.toasts;
    const themeApi = vendetta.themes;
    const { storage } = vendetta.plugin;
    const log = vendetta.logger;

    const STRING = 3; // ApplicationCommandOptionType.STRING
    const RESET_WORDS = ["", "null", "none", "empty", "default", "reset", "clear", "off"];
    const EMITTER = Symbol.for("vendetta.storage.emitter");

    let unregister;
    let unsubscribe;
    let applying = false;
    let queued = false;

    const currentTheme = () => Object.values(themeApi.themes).find(t => t?.selected) ?? null;

    // Bunny themes (spec 3) keep the background under `main`, older formats at the top level.
    const backgroundHolder = theme => (theme.data?.spec === 3 ? theme.data.main : theme.data);

    // Puts the saved link on the selected theme. Kettu re-downloads themes on every
    // launch, which wipes it, so this runs again whenever the themes storage changes.
    function apply() {
        const url = storage.url;
        const theme = currentTheme();
        if (!url || !theme || applying) return false;

        const holder = backgroundHolder(theme);
        if (!holder) return false;
        if (holder.background?.url === url) return true;

        applying = true;
        try {
            // Keep the theme's own blur/opacity, only swap the image.
            holder.background = { ...(holder.background ?? {}), url };
            Promise.resolve(themeApi.selectTheme(theme.id))
                .catch(e => log.error("Background Switcher: failed to save theme", e));
        } catch (e) {
            log.error("Background Switcher: failed to apply background", e);
            return false;
        } finally {
            applying = false;
        }
        return true;
    }

    // Re-downloads the selected theme, which brings back whatever background it ships with.
    async function restoreDefault() {
        const theme = currentTheme();
        if (!theme) return true;
        try {
            await themeApi.fetchTheme(theme.id, true);
            return true;
        } catch (e) {
            log.error("Background Switcher: failed to restore theme background", e);
            return false;
        }
    }

    function onThemesChanged() {
        if (applying || queued) return;
        queued = true;
        setTimeout(() => {
            queued = false;
            apply();
        }, 0);
    }

    async function execute(args) {
        const raw = args?.find(a => a?.name === "url")?.value;
        const value = typeof raw === "string" ? raw.trim() : "";

        if (RESET_WORDS.includes(value.toLowerCase())) {
            const hadOverride = !!storage.url;
            delete storage.url;
            if (!hadOverride) return void showToast("No custom background set; already using the theme's default");
            const ok = await restoreDefault();
            showToast(ok
                ? "Background reset to the theme's default"
                : "Couldn't reach the theme, the default comes back on next restart");
            return;
        }

        if (!/^https?:\/\/\S+$/i.test(value)) {
            return void showToast("That doesn't look like a link. Use /background <image url>, or /background none to reset");
        }

        storage.url = value;

        if (!currentTheme()) {
            return void showToast("Saved. Select a theme in Kettu to see the background");
        }
        if (!apply()) {
            return void showToast("Couldn't apply the background, check the Kettu logs");
        }
        showToast(/cdn\.discordapp\.com\/attachments|media\.discordapp\.net\/attachments/i.test(value)
            ? "Background set. Discord upload links expire after about a day"
            : "Background set");
    }

    return {
        onLoad() {
            unregister = registerCommand({
                name: "background",
                displayName: "background",
                description: "Set the chat background. Leave empty, or use none, to go back to the theme's default",
                displayDescription: "Set the chat background. Leave empty, or use none, to go back to the theme's default",
                options: [{
                    name: "url",
                    displayName: "url",
                    description: "Image link, or none/null to reset",
                    displayDescription: "Image link, or none/null to reset",
                    type: STRING,
                    required: false
                }],
                execute
            });

            vendetta.storage.awaitSyncWrapper(themeApi.themes).then(() => {
                const emitter = themeApi.themes[EMITTER];
                if (emitter) {
                    emitter.on("SET", onThemesChanged);
                    unsubscribe = () => emitter.off("SET", onThemesChanged);
                }
                apply();
            }).catch(e => log.error("Background Switcher: themes storage unavailable", e));
        },
        onUnload() {
            unregister?.();
            unsubscribe?.();
            // Disabling the plugin puts the theme's own background back,
            // but keeps the saved link for when it's turned on again.
            if (storage.url) restoreDefault();
        }
    };
})()
