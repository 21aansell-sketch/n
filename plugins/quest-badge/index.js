// Quest Badges - locally adds 6 "Completed a Quest" badges to YOUR profile.
// Client-side only: nobody else sees them, and nothing is sent to Discord.
// Evaluated by Kettu as an expression with `vendetta` in scope.
(() => {
    const { after } = vendetta.patcher;
    const { findByStoreName, findByProps } = vendetta.metro;

    const COUNT = 6;
    const ID_PREFIX = "kettu_quest_badge_";
    // Icon hash for Discord's "Completed a Quest" badge:
    // https://cdn.discordapp.com/badge-icons/<hash>.png
    const QUEST_ICON = "7d9ae358c8c5e118768335dbe68b4fb8";

    const makeBadges = () =>
        Array.from({ length: COUNT }, (_, i) => ({
            id: `${ID_PREFIX}${i + 1}`,
            description: "Completed a Quest",
            icon: QUEST_ICON,
        }));

    let patches = [];

    const log = (...a) => console.log("[QuestBadges]", ...a);

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
                    const me = UserStore?.getCurrentUser?.();
                    if (!me || userId !== me.id) return profile;

                    const existing = Array.isArray(profile.badges) ? profile.badges : [];
                    // Drop any of our badges first so re-renders never stack duplicates.
                    const base = existing.filter(b => !String(b?.id).startsWith(ID_PREFIX));
                    // Return a copy so the store's own data is never mutated.
                    return { ...profile, badges: [...base, ...makeBadges()] };
                };

                patches.push(
                    after("getUserProfile", UserProfileStore, ([userId], profile) => addTo(userId, profile))
                );

                // Some profile screens read through this helper instead.
                const getProfile = findByProps("getUserProfile", "getGuildMemberProfile");
                if (getProfile && getProfile !== UserProfileStore) {
                    patches.push(
                        after("getUserProfile", getProfile, ([userId], profile) => addTo(userId, profile))
                    );
                }

                // Nudge the UI so open profiles refresh.
                UserProfileStore.emitChange?.();
                log("loaded");
            } catch (e) {
                log("failed to load", e);
            }
        },

        onUnload() {
            for (const unpatch of patches) unpatch();
            patches = [];
            try {
                findByStoreName("UserProfileStore")?.emitChange?.();
            } catch {}
        },
    };
})()
