(() => {
    // NOTE: nothing may come before this "(" - Kettu evaluates the file as
    // `return <file>`, so a leading comment makes it return undefined.
    //
    // Quest Badges - shows "Completed a Quest" badges from a registry YOU host.
    // Registry format matches Equicord's GlobalBadges (`GET <base>/users`):
    //   { "users": { "<userId>": [{ "mod": "kettu", "tooltip": "...", "badge": "<icon url>" }] } }
    const { after } = vendetta.patcher;
    const { findByStoreName, findByProps } = vendetta.metro;

    // TODO: set this to where your dist/ is hosted (must end with "/").
    // build.mjs publishes api/users at <base>api/users.
    const REGISTRY_BASE = "https://YOUR-USERNAME.github.io/YOUR-REPO/api/";
    const REFRESH_MS = 30 * 60 * 1000;

    // Local fallback so your own profile works before the registry is set up.
    const LOCAL_COUNT = 6;
    const LOCAL_ID = "kettu_quest_badge_";
    const QUEST_ICON = "7d9ae358c8c5e118768335dbe68b4fb8";
    const REG_ID = "kettu_registry_badge_";

    const log = (...a) => console.log("[QuestBadges]", ...a);

    let registry = {}; // userId -> badge[]
    let patches = [];
    let timer;

    // Discord builds badge icon URLs from a hash on its own CDN, so reduce
    // registry URLs like .../badge-icons/<hash>.png to just the hash.
    const toIcon = src => {
        const m = /badge-icons\/([a-f0-9]+)\./i.exec(String(src ?? ""));
        return m ? m[1] : src;
    };

    async function loadRegistry() {
        try {
            const res = await fetch(REGISTRY_BASE + "users", { cache: "no-cache" });
            const json = await res.json();
            const next = {};
            for (const [uid, list] of Object.entries(json?.users ?? {})) {
                if (!Array.isArray(list)) continue;
                next[uid] = list
                    .filter(b => b?.mod && b?.badge)
                    .map((b, i) => ({
                        id: `${REG_ID}${i}`,
                        description: String(b.tooltip ?? "Badge"),
                        icon: toIcon(b.badge),
                    }));
            }
            registry = next;
            findByStoreName("UserProfileStore")?.emitChange?.();
            log("registry loaded for", Object.keys(next).length, "user(s)");
        } catch (e) {
            log("registry fetch failed (is REGISTRY_BASE set?)", e);
        }
    }

    const localBadges = () =>
        Array.from({ length: LOCAL_COUNT }, (_, i) => ({
            id: `${LOCAL_ID}${i + 1}`,
            description: "Completed a Quest",
            icon: QUEST_ICON,
        }));

    return {
        onLoad() {
            try {
                const UserStore = findByStoreName("UserStore");
                const UserProfileStore = findByStoreName("UserProfileStore");
                if (!UserProfileStore?.getUserProfile) {
                    log("UserProfileStore.getUserProfile not found; nothing patched");
                    return;
                }

                const addTo = (userId, profile) => {
                    if (!profile) return profile;
                    const existing = Array.isArray(profile.badges) ? profile.badges : [];
                    const base = existing.filter(b => {
                        const id = String(b?.id);
                        return !id.startsWith(LOCAL_ID) && !id.startsWith(REG_ID);
                    });

                    let extra = registry[userId];
                    if (!extra) {
                        const me = UserStore?.getCurrentUser?.();
                        if (me && userId === me.id) extra = localBadges();
                    }
                    if (!extra?.length) return profile;

                    // Copy so the store's own data is never mutated.
                    return { ...profile, badges: [...base, ...extra] };
                };

                patches.push(after("getUserProfile", UserProfileStore, ([userId], p) => addTo(userId, p)));

                const alt = findByProps("getUserProfile", "getGuildMemberProfile");
                if (alt && alt !== UserProfileStore) {
                    patches.push(after("getUserProfile", alt, ([userId], p) => addTo(userId, p)));
                }

                loadRegistry();
                timer = setInterval(loadRegistry, REFRESH_MS);
                log("loaded");
            } catch (e) {
                log("failed to load", e);
            }
        },

        onUnload() {
            clearInterval(timer);
            for (const unpatch of patches) unpatch();
            patches = [];
            registry = {};
            try {
                findByStoreName("UserProfileStore")?.emitChange?.();
            } catch {}
        },
    };
})()
