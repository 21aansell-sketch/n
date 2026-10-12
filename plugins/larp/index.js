(function () {
  "use strict";

  // Larp Tool - Kettu/Vendetta port. Client side only.
  // NOTE: this file is evaluated as `vendetta => { return <this expression> }`,
  // so it must stay a single expression (no leading comments before the IIFE).

  var vd = vendetta;
  var React = vd.metro.common.React;
  var RN = vd.metro.common.ReactNative;
  var FluxDispatcher = vd.metro.common.FluxDispatcher;
  var h = React.createElement;
  var Forms = vd.ui.components.Forms;
  var storage = vd.plugin.storage;
  var useProxy = vd.storage.useProxy;
  var patcher = vd.patcher;
  var metro = vd.metro;
  var toast = vd.ui.toasts.showToast;

  var UserStore = metro.findByStoreName("UserStore");
  var UserProfileStore = metro.findByStoreName("UserProfileStore");
  var RestAPI = metro.findByProps("getAPIBaseURL", "get");

  var unpatches = [];
  var origGetCurrentUser = null;
  var origGetUserProfile = null;
  var ownId = "";
  var gen = 0;
  var refreshTimer = null;

  // ---------------------------------------------------------------- defaults

  function clone(v) {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
  }

  var DEFAULTS = {
    enabled: true,
    customUsername: "",
    customJoinDate: "",
    hiddenBadges: [],
    addedBadges: [],
    connectionOverrides: {},
    hiddenConnections: [],
    customConnections: [],
    avatarDecoration: null,
    profileEffect: null,
    nameplate: null,
    hideAvatarDecoration: false,
    hideProfileEffect: false,
    hideNameplate: false
  };

  function initStorage() {
    Object.keys(DEFAULTS).forEach(function (k) {
      if (storage[k] === undefined) storage[k] = clone(DEFAULTS[k]);
    });
  }

  function resetAll() {
    Object.keys(DEFAULTS).forEach(function (k) {
      storage[k] = clone(DEFAULTS[k]);
    });
    refresh();
  }

  // ------------------------------------------------------------------ badges

  var BASE = "https://cdn.jsdelivr.net/gh/mezotv/discord-badges@main/assets/";
  var BASE_FALLBACK = "https://raw.githubusercontent.com/mezotv/discord-badges/main/assets/";
  var CDN = "https://cdn.discordapp.com/";

  var NITRO = ["bronze", "silver", "gold", "platinum", "diamond", "emerald", "ruby", "opal"];
  var GIFT = ["patron", "champion", "luminary", "icon", "hero", "legend"];
  var BOOST_LABELS = ["1 month", "2 months", "3 months", "6 months", "9 months", "12 months", "15 months", "18 months", "24+ months"];

  var KNOWN = {};
  function known(id, description, icon) {
    KNOWN[id] = { description: description, icon: icon };
  }
  known("staff", "Discord Staff", "discordstaff.svg");
  known("partner", "Partnered Server Owner", "discordpartner.svg");
  known("certified_moderator", "Moderator Programs Alumni", "discordmod.svg");
  known("hypesquad", "HypeSquad Events", "hypesquadevents.svg");
  known("hypesquad_house_1", "HypeSquad Bravery", "hypesquadbravery.svg");
  known("hypesquad_house_2", "HypeSquad Brilliance", "hypesquadbrilliance.svg");
  known("hypesquad_house_3", "HypeSquad Balance", "hypesquadbalance.svg");
  known("bug_hunter_level_1", "Discord Bug Hunter", "discordbughunter1.svg");
  known("bug_hunter_level_2", "Discord Bug Hunter (Gold)", "discordbughunter2.svg");
  known("active_developer", "Active Developer", "activedeveloper.svg");
  known("verified_developer", "Early Verified Bot Developer", "discordbotdev.svg");
  known("early_supporter", "Early Supporter", "discordearlysupporter.svg");
  known("premium", "Discord Nitro (Bronze)", "subscriptions/badges/bronze.png");
  NITRO.forEach(function (t) {
    known("premium_" + t, "Nitro " + t.charAt(0).toUpperCase() + t.slice(1), "subscriptions/badges/" + t + ".png");
  });
  BOOST_LABELS.forEach(function (label, i) {
    known("guild_booster_lvl" + (i + 1), "Server Booster (" + label + ")", "boosts/discord-boost-" + (i + 1) + ".svg");
  });
  known("quest_completed", "Quest Completed", "quest.png");
  known("legacy_username", "Legacy Username Badge", "username.png");
  known("automod", "AutoMod", "automod.svg");
  known("orb", "Orb", "orb.svg");
  GIFT.forEach(function (t) {
    known("gifting_" + t, "Gifting " + t.charAt(0).toUpperCase() + t.slice(1), "gifting/" + t + ".png");
  });

  // discord cdn icon hashes (render natively, and let us match runtime badges)
  var HASHES = {
    active_developer: "6bdc42827a38498929a4920da12695d9",
    bug_hunter_level_1: "2717692c7dca7289b35297368a940dd0",
    bug_hunter_level_2: "848f79194d4be5ff5f81505cbd0ce1e6",
    certified_moderator: "fee1624003e2fee35cb398e125dc479b",
    staff: "5e74e9b61934fc1f67c65515d1f7e60d",
    discord_employee: "5e74e9b61934fc1f67c65515d1f7e60d",
    hypesquad: "bf01d1073931f921909045f3a39fd264",
    hypesquad_house_1: "8a88d63823d8a71cd5e390baa45efa02",
    hypesquad_house_2: "011940fd013da3f7fb926e4a1cd2e618",
    hypesquad_house_3: "3aa41de486fa12454c3761e8e223442e",
    partner: "3f9748e53446a137a052f3454e2de41e",
    premium: "2ba85e8026a8614b640c2837bcdfe21b",
    premium_bronze: "2ba85e8026a8614b640c2837bcdfe21b",
    early_supporter: "7060786766c9c840eb3019e725d2b358",
    premium_early_supporter: "7060786766c9c840eb3019e725d2b358",
    verified_developer: "6df5892e0f35b051f8b61eace34f4967"
  };

  var ALIAS_GROUPS = [
    ["quest_completed", "quest"],
    ["staff", "discord_employee"],
    ["premium", "premium_bronze", "premium_subscriber"],
    ["early_supporter", "premium_early_supporter"],
    ["hypesquad_house_1", "hypesquad_online_house_1"],
    ["hypesquad_house_2", "hypesquad_online_house_2"],
    ["hypesquad_house_3", "hypesquad_online_house_3"],
    ["verified_developer", "verified_bot_developer"],
    ["bug_hunter_level_1", "bug_hunter"],
    ["bug_hunter_level_2", "bug_hunter_gold"]
  ];

  // [bit, badge id] - public flag bits
  var FLAG_BADGES = [
    [1, "staff"], [2, "partner"], [4, "hypesquad"], [8, "bug_hunter_level_1"],
    [64, "hypesquad_house_1"], [128, "hypesquad_house_2"], [256, "hypesquad_house_3"],
    [512, "early_supporter"], [16384, "bug_hunter_level_2"], [131072, "verified_developer"],
    [262144, "certified_moderator"], [4194304, "active_developer"]
  ];

  function canon(id) {
    for (var i = 0; i < ALIAS_GROUPS.length; i++) {
      if (ALIAS_GROUPS[i].indexOf(id) >= 0) return ALIAS_GROUPS[i][0];
    }
    return id;
  }

  function isHash(s) {
    return typeof s === "string" && /^[a-f0-9]{32}$/.test(s);
  }

  function exclusiveGroup(id) {
    if (id.indexOf("guild_booster_lvl") === 0) return "boost";
    if (id.indexOf("hypesquad") === 0) return "hypesquad";
    return null;
  }

  function badgeUrls(id, rawIcon) {
    var c = canon(id);
    var urls = [];
    var hash = HASHES[id] || HASHES[c] || (isHash(rawIcon) ? rawIcon : null);
    if (hash) urls.push(CDN + "badge-icons/" + hash + ".png?size=96");
    if (typeof rawIcon === "string" && rawIcon.indexOf("http") === 0) urls.push(rawIcon);
    var kn = KNOWN[c] || KNOWN[id];
    if (kn && kn.icon) {
      urls.push(BASE + kn.icon, BASE_FALLBACK + kn.icon);
      if (/\.png$/i.test(kn.icon)) {
        var webp = kn.icon.replace(/\.png$/i, ".webp");
        urls.push(BASE + webp, BASE_FALLBACK + webp);
      }
    }
    return urls;
  }

  function hiddenSet() {
    var s = {};
    (storage.hiddenBadges || []).forEach(function (id) {
      s[canon(id)] = 1;
      var hh = HASHES[id];
      if (hh) s["#" + hh] = 1;
    });
    return s;
  }

  function isHiddenBadge(b) {
    var s = hiddenSet();
    var id = b.id || b.key || "";
    if (id && s[canon(id)]) return true;
    if (isHash(b.icon) && s["#" + b.icon]) return true;
    return false;
  }

  function badgePresent(list, id) {
    var c = canon(id);
    var hash = HASHES[id];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (canon(b.id || b.key || "") === c) return true;
      if (hash && b.icon === hash) return true;
    }
    return false;
  }

  function buildBadge(id) {
    var kn = KNOWN[id];
    var urls = badgeUrls(id);
    var hash = HASHES[id];
    return {
      id: id,
      key: id,
      description: kn ? kn.description : id.replace(/_/g, " "),
      icon: hash || urls[0] || "",
      userId: ownId
    };
  }

  function mergeBadges(list) {
    var out = [];
    (list || []).forEach(function (b) {
      if (b && !isHiddenBadge(b)) out.push(b);
    });
    (storage.addedBadges || []).forEach(function (id) {
      if (badgePresent(out, id)) return;
      var g = exclusiveGroup(id);
      if (g) {
        for (var i = 0; i < out.length; i++) {
          if (exclusiveGroup(out[i].id || out[i].key || "") === g) return;
        }
      }
      out.push(buildBadge(id));
    });
    return out;
  }

  function ownedBadgeEntries() {
    var seen = {};
    var out = [];
    function add(id, description, icon) {
      if (!id) return;
      var c = canon(id);
      if (seen[c]) return;
      seen[c] = 1;
      var kn = KNOWN[c];
      out.push({ id: c, description: description || (kn && kn.description) || c.replace(/_/g, " "), icon: icon });
    }
    var uid = getOwnId();
    var prof = uid && origGetUserProfile ? origGetUserProfile(uid) : null;
    ((prof && prof.badges) || []).forEach(function (b) {
      add(b.id || b.key, b.description, b.icon);
    });
    var user = origGetCurrentUser ? origGetCurrentUser() : null;
    if (user) {
      var flags = Number(user.publicFlags || user.flags || 0);
      FLAG_BADGES.forEach(function (fb) {
        if (flags & fb[0]) add(fb[1]);
      });
      if (user.premiumType) add("premium");
    }
    out.sort(function (a, b) { return a.description.localeCompare(b.description); });
    return out;
  }

  function isOwnedVisible(id) {
    var c = canon(id);
    return !(storage.hiddenBadges || []).some(function (x) { return canon(x) === c; });
  }

  function setOwnedVisible(id, visible) {
    var c = canon(id);
    var hidden = (storage.hiddenBadges || []).filter(function (x) { return canon(x) !== c; });
    if (!visible) hidden.push(c);
    storage.hiddenBadges = hidden;
    refresh();
  }

  function setAddedVisible(id, visible) {
    var added = (storage.addedBadges || []).filter(function (x) { return x !== id; });
    if (visible) {
      var g = exclusiveGroup(id);
      if (g) added = added.filter(function (x) { return exclusiveGroup(x) !== g; });
      added.push(id);
    }
    storage.addedBadges = added;
    refresh();
  }

  // ------------------------------------------------------------- connections

  var CONN_TYPES = [
    "amazon-music", "battlenet", "bluesky", "bungie", "crunchyroll", "domain", "ebay", "epicgames",
    "facebook", "github", "instagram", "leagueoflegends", "mastodon", "paypal", "playstation",
    "reddit", "riotgames", "roblox", "samsung", "skype", "soundcloud", "spotify", "steam",
    "tiktok", "twitch", "twitter", "xbox", "youtube"
  ];

  function connLabel(type) {
    return type.split(/[-_]/).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(" ");
  }

  function normalizeDomain(input) {
    if (!input) return "";
    return input.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  }

  function connKey(c) {
    return c.type + ":" + c.id;
  }

  function buildFakeConnection(c) {
    var id = c.id || "larp-" + c.type;
    if (c.type === "domain") {
      var d = normalizeDomain(c.name);
      return d ? { type: "domain", id: id, name: d, verified: true } : null;
    }
    var handle = (c.name || "").trim();
    return handle ? { type: c.type, id: id, name: handle, verified: true } : null;
  }

  function applyConnections(connections) {
    var base = connections || [];
    var overrides = storage.connectionOverrides || {};
    var hidden = storage.hiddenConnections || [];
    var custom = storage.customConnections || [];
    var used = {};
    base.forEach(function (c) { used[c.type] = 1; });

    var mapped = [];
    base.forEach(function (c) {
      var key = connKey(c);
      if (hidden.indexOf(key) >= 0) return;
      var o = overrides[key] || overrides[c.type];
      var name = o && o.name && o.name.trim();
      if (!name) { mapped.push(c); return; }
      var copy = {};
      for (var k in c) copy[k] = c[k];
      copy.name = name;
      mapped.push(copy);
    });
    custom.forEach(function (cc) {
      if (!cc.type || used[cc.type]) return;
      var built = buildFakeConnection(cc);
      if (!built) return;
      mapped.push(built);
      used[cc.type] = 1;
    });
    return mapped;
  }

  // --------------------------------------------------------------- join date

  function parseJoinDate(raw) {
    var m = String(raw || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var date = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
    return date;
  }

  function joinMs() {
    if (!storage.enabled) return null;
    var d = parseJoinDate(storage.customJoinDate);
    return d ? d.getTime() : null;
  }

  function formatJoinInput(raw) {
    var digits = String(raw || "").replace(/\D/g, "").slice(0, 8);
    if (digits.length <= 4) return digits;
    if (digits.length <= 6) return digits.slice(0, 4) + "-" + digits.slice(4);
    return digits.slice(0, 4) + "-" + digits.slice(4, 6) + "-" + digits.slice(6);
  }

  // ------------------------------------------------------- collectibles shop

  var VALID_PALETTES = ["berry", "bubble_gum", "clover", "cobalt", "crimson", "forest", "lemon", "sky", "teal", "violet", "white"];
  var SHOP_MS = 30 * 60 * 1000;
  var shop = null;
  var shopPromise = null;

  function normPalette(p) {
    var v = p && String(p).trim().toLowerCase();
    return v && VALID_PALETTES.indexOf(v) >= 0 ? v : "crimson";
  }

  function absUrl(u) {
    if (!u) return "";
    if (u.indexOf("http") === 0) return u;
    if (u.indexOf("//") === 0) return "https:" + u;
    if (u.charAt(0) === "/") return CDN.replace(/\/$/, "") + u;
    return u;
  }

  function avatarPreview(asset) {
    return CDN + "avatar-decoration-presets/" + asset + ".png?size=96&passthrough=false";
  }

  function plateAssetPath(asset) {
    return asset.replace(/^\/+/, "").replace(/\/?$/, "/");
  }

  function platePreview(asset) {
    if (asset.indexOf("http") === 0) return asset;
    return CDN + "assets/collectibles/" + plateAssetPath(asset) + "static.png";
  }

  function resolveType(item, p) {
    if (typeof item.type === "number") return item.type;
    if (typeof p.type === "number" && p.type !== 1000) return p.type;
    if (Array.isArray(item.effects) || item.thumbnailPreviewSrc || item.staticFrameSrc || item.reducedMotionSrc) return 1;
    if (typeof item.asset === "string" && typeof item.palette === "string") return 2;
    if (typeof item.asset === "string") return 0;
    return undefined;
  }

  function collect(p, out) {
    if (!p || p.type === 1000) return;
    var items = p.items && p.items.length ? p.items : typeof p.type === "number" ? [p] : [];
    items.forEach(function (item) {
      if (item.type === 1000) return;
      var sku = String(p.sku_id || item.sku_id || "");
      if (!sku) return;
      var t = resolveType(item, p);

      if (t === 0 && typeof item.asset === "string") {
        out.avatar.push({
          skuId: sku,
          asset: item.asset,
          label: String(item.label || p.name || "Avatar decoration"),
          name: String(p.name || item.label || "Avatar decoration"),
          preview: avatarPreview(item.asset)
        });
      } else if (t === 1) {
        var name = String(item.title || p.name || "Profile effect");
        var thumb = absUrl(String(item.thumbnailPreviewSrc || item.staticFrameSrc || item.reducedMotionSrc || ""));
        out.effect.push({
          skuId: sku,
          name: name,
          preview: thumb,
          effect: {
            skuId: sku,
            id: typeof item.id === "string" ? item.id : sku,
            title: name,
            description: item.description,
            accessibilityLabel: item.accessibilityLabel,
            animationType: item.animationType,
            thumbnailPreviewSrc: item.thumbnailPreviewSrc ? absUrl(item.thumbnailPreviewSrc) : undefined,
            reducedMotionSrc: item.reducedMotionSrc ? absUrl(item.reducedMotionSrc) : undefined,
            staticFrameSrc: item.staticFrameSrc ? absUrl(item.staticFrameSrc) : undefined,
            effects: Array.isArray(item.effects) ? item.effects : undefined,
            type: 1
          }
        });
      } else if (t === 2 && typeof item.asset === "string") {
        out.plate.push({
          skuId: sku,
          asset: item.asset,
          label: String(item.label || p.name || "Nameplate"),
          name: String(p.name || item.label || "Nameplate"),
          palette: typeof item.palette === "string" ? item.palette : undefined,
          preview: platePreview(item.asset)
        });
      }
    });
    (p.variants || []).forEach(function (v) { collect(v, out); });
  }

  function dedupe(list) {
    var seen = {};
    return list.filter(function (i) {
      if (seen[i.skuId]) return false;
      seen[i.skuId] = 1;
      return true;
    });
  }

  function fetchShop(force) {
    if (!force && shop && Date.now() - shop.t < SHOP_MS) return Promise.resolve(shop);
    if (shopPromise) return shopPromise;

    var out = { avatar: [], effect: [], plate: [], t: Date.now() };
    function tryUrl(url) {
      return RestAPI.get({ url: url, query: { variants_return_style: 1 } }).then(function (res) {
        var cats = (res && res.body && res.body.categories) || [];
        cats.forEach(function (c) {
          (c.products || []).forEach(function (p) { collect(p, out); });
        });
      });
    }

    shopPromise = tryUrl("/collectibles-categories/v2")
      .catch(function () {})
      .then(function () {
        if (out.avatar.length || out.effect.length || out.plate.length) return;
        return tryUrl("/collectibles-shop").catch(function () {});
      })
      .then(function () {
        out.avatar = dedupe(out.avatar);
        out.effect = dedupe(out.effect);
        out.plate = dedupe(out.plate);
        shop = out;
        shopPromise = null;
        return out;
      });
    return shopPromise;
  }

  function equipAvatar(item) {
    storage.hideAvatarDecoration = false;
    storage.avatarDecoration = item ? { skuId: item.skuId, asset: item.asset, label: item.label } : null;
    refresh();
  }

  function equipEffect(item) {
    storage.hideProfileEffect = false;
    storage.profileEffect = item ? clone(item.effect) : null;
    refresh();
  }

  function equipPlate(item) {
    storage.hideNameplate = false;
    storage.nameplate = item
      ? { skuId: item.skuId, asset: item.asset, label: item.label, palette: normPalette(item.palette) }
      : null;
    refresh();
  }

  function effectObj() {
    var e = storage.profileEffect;
    if (!e || !e.skuId) return null;
    var o = {};
    Object.keys(e).forEach(function (k) { o[k] = e[k]; });
    o.id = e.id || e.skuId;
    o.skuId = e.skuId;
    o.expiresAt = null;
    return o;
  }

  function plateObj() {
    var p = storage.nameplate;
    if (!p || !p.skuId || !p.asset) return null;
    return {
      asset: p.asset,
      skuId: p.skuId,
      label: p.label || "",
      palette: normPalette(p.palette),
      expiresAt: null,
      type: 2
    };
  }

  function decoObj() {
    var d = storage.avatarDecoration;
    if (!d || !d.skuId || !d.asset) return null;
    return { asset: d.asset, skuId: d.skuId, expiresAt: null };
  }

  // ------------------------------------------------------------ user spoofing

  function getOwnId() {
    if (ownId) return ownId;
    var u = origGetCurrentUser ? origGetCurrentUser() : null;
    if (u && u.id) ownId = u.id;
    return ownId;
  }

  function copyProps(obj) {
    var o = {};
    if (!obj) return o;
    for (var k in obj) o[k] = obj[k];
    return o;
  }

  var userCache = new WeakMap();
  var profileCache = new WeakMap();

  function spoofUser(user) {
    if (!user || !storage.enabled || user.id !== getOwnId()) return user;
    var c = userCache.get(user);
    if (c && c.g === gen) return c.p;

    var uname = (storage.customUsername || "").trim();
    var ms = joinMs();

    var p = new Proxy(user, {
      get: function (t, prop) {
        if (prop === "username" && uname) return uname;
        if (prop === "avatarDecorationData" || prop === "avatarDecoration") {
          if (storage.hideAvatarDecoration) return null;
          var d = decoObj();
          if (d) return d;
        }
        if (prop === "nameplate") {
          if (storage.hideNameplate) return null;
          var pl = plateObj();
          if (pl) return pl;
        }
        if (prop === "collectibles") {
          if (storage.hideNameplate) {
            var stripped = copyProps(t.collectibles);
            delete stripped.nameplate;
            return stripped;
          }
          var pl2 = plateObj();
          if (pl2) {
            var merged = copyProps(t.collectibles);
            merged.nameplate = pl2;
            return merged;
          }
        }
        if (prop === "createdAt" && ms != null) return new Date(ms);
        if (prop === "getCreatedAt" && ms != null) return function () { return new Date(ms); };
        var v = Reflect.get(t, prop, t);
        return typeof v === "function" ? v.bind(t) : v;
      }
    });

    userCache.set(user, { g: gen, p: p });
    return p;
  }

  function spoofProfile(profile, userId) {
    if (!profile || !storage.enabled || userId !== getOwnId()) return profile;
    var c = profileCache.get(profile);
    if (c && c.g === gen) return c.p;

    var ms = joinMs();
    var badges = mergeBadges(profile.badges);
    var accounts = applyConnections(profile.connectedAccounts);
    var effect = storage.hideProfileEffect ? null : effectObj();

    var p = new Proxy(profile, {
      get: function (t, prop) {
        if (prop === "badges") return badges;
        if (prop === "connectedAccounts") return accounts;
        if (prop === "profileEffect") {
          if (storage.hideProfileEffect) return null;
          if (effect) return effect;
        }
        if (prop === "profileEffectId") {
          if (storage.hideProfileEffect) return null;
          if (effect) return effect.id;
        }
        if (prop === "profileEffectExpiresAt") {
          if (storage.hideProfileEffect || effect) return null;
        }
        if (prop === "createdAt" && ms != null) return new Date(ms).toISOString();
        var v = Reflect.get(t, prop, t);
        return typeof v === "function" ? v.bind(t) : v;
      }
    });

    profileCache.set(profile, { g: gen, p: p });
    return p;
  }

  // Bumps the cache generation and nudges the stores so components re-read.
  // Never dispatches spoofed objects, so nothing fake is written into the real stores.
  function refresh() {
    gen++;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      var emitted = false;
      try { if (UserStore.emitChange) { UserStore.emitChange(); emitted = true; } } catch (e) {}
      try { if (UserProfileStore.emitChange) { UserProfileStore.emitChange(); emitted = true; } } catch (e) {}
      if (!emitted && origGetCurrentUser) {
        try { FluxDispatcher.dispatch({ type: "USER_UPDATE", user: origGetCurrentUser() }); } catch (e) {}
      }
    }, 100);
  }

  // ---------------------------------------------------------------------- UI

  function BadgeImg(props) {
    var urls = badgeUrls(props.id, props.icon);
    var s = React.useState(0);
    var i = s[0];
    var size = props.size || 28;
    if (!urls[i]) return h(RN.View, { style: { width: size, height: size } });
    return h(RN.Image, {
      source: { uri: urls[i] },
      style: { width: size, height: size },
      resizeMode: "contain",
      onError: function () { if (i + 1 < urls.length) s[1](i + 1); }
    });
  }

  function leadingImg(uri, w, hgt) {
    if (!uri) return null;
    return h(RN.Image, { source: { uri: uri }, style: { width: w || 36, height: hgt || 36 }, resizeMode: "contain" });
  }

  function Chips(props) {
    return h(RN.ScrollView, {
      horizontal: true,
      showsHorizontalScrollIndicator: false,
      style: { flexGrow: 0 },
      contentContainerStyle: { paddingHorizontal: 12, paddingVertical: 10 }
    }, props.items.map(function (label, i) {
      var sel = props.value === i;
      return h(RN.TouchableOpacity, {
        key: String(i),
        onPress: function () { props.onChange(i); },
        style: {
          paddingHorizontal: 14,
          paddingVertical: 8,
          marginRight: 8,
          borderRadius: 16,
          backgroundColor: sel ? "rgba(88,101,242,0.95)" : "rgba(127,127,127,0.55)"
        }
      }, h(RN.Text, { style: { color: "#fff", fontWeight: "600" } }, label));
    }));
  }

  function SwitchRow(props) {
    return h(Forms.FormRow, {
      label: props.label,
      subLabel: props.subLabel,
      leading: props.leading,
      trailing: h(Forms.FormSwitch, {
        value: !!props.value,
        disabled: !!props.disabled,
        onValueChange: props.onChange
      })
    });
  }

  function UsernameTab() {
    return h(Forms.FormSection, { title: "Custom username" },
      h(Forms.FormInput, {
        title: "USERNAME",
        placeholder: "Your @username",
        value: storage.customUsername || "",
        onChange: function (v) {
          storage.customUsername = String(v || "").slice(0, 32);
          refresh();
        }
      }),
      h(Forms.FormText, { style: { paddingHorizontal: 16, paddingTop: 8 } },
        "Shown as your @handle on your profile. Leave empty to use your real one.")
    );
  }

  function JoinedTab() {
    var s = React.useState(formatJoinInput(storage.customJoinDate || ""));
    var draft = s[0];
    var complete = /^\d{4}-\d{2}-\d{2}$/.test(draft);
    var valid = !complete || parseJoinDate(draft) != null;
    return h(Forms.FormSection, { title: "Member since" },
      h(Forms.FormInput, {
        title: "DATE (YYYY-MM-DD)",
        placeholder: "YYYY-MM-DD",
        value: draft,
        keyboardType: "number-pad",
        onChange: function (v) {
          var next = formatJoinInput(v);
          s[1](next);
          var ok = /^\d{4}-\d{2}-\d{2}$/.test(next) && parseJoinDate(next) != null;
          if (!next || ok) {
            storage.customJoinDate = next;
            refresh();
          }
        }
      }),
      complete && !valid ? h(Forms.FormText, { style: { paddingHorizontal: 16, paddingTop: 8 } }, "That date isn't valid.") : null,
      h(Forms.FormText, { style: { paddingHorizontal: 16, paddingTop: 8 } },
        "Overrides the date on your profile. Leave empty for the real one.")
    );
  }

  function BadgesTab() {
    var owned = ownedBadgeEntries();
    var ownedIds = {};
    owned.forEach(function (b) { ownedIds[b.id] = 1; });
    var addedIds = {};
    (storage.addedBadges || []).forEach(function (id) { addedIds[id] = 1; });

    var spoofed = Object.keys(addedIds).filter(function (id) { return !ownedIds[canon(id)]; });
    var addable = Object.keys(KNOWN).filter(function (id) {
      return !ownedIds[canon(id)] && !addedIds[id];
    }).sort(function (a, b) { return KNOWN[a].description.localeCompare(KNOWN[b].description); });

    function blocked(id) {
      var g = exclusiveGroup(id);
      if (!g) return false;
      var active = (storage.addedBadges || []).filter(function (x) { return exclusiveGroup(x) === g; })[0];
      if (active && active !== id) return true;
      return owned.some(function (b) { return exclusiveGroup(b.id) === g && isOwnedVisible(b.id); });
    }

    return h(React.Fragment, null,
      h(Forms.FormSection, { title: "Your badges (" + owned.length + ")" },
        owned.length ? owned.map(function (b) {
          return h(SwitchRow, {
            key: "o" + b.id,
            label: b.description,
            leading: h(BadgeImg, { id: b.id, icon: b.icon, size: 28 }),
            value: isOwnedVisible(b.id),
            onChange: function (v) { setOwnedVisible(b.id, v); }
          });
        }) : h(Forms.FormText, { style: { padding: 16 } }, "No badges found.")
      ),
      spoofed.length ? h(Forms.FormSection, { title: "Added badges" },
        spoofed.map(function (id) {
          return h(SwitchRow, {
            key: "s" + id,
            label: KNOWN[id] ? KNOWN[id].description : id,
            leading: h(BadgeImg, { id: id, size: 28 }),
            value: true,
            onChange: function () { setAddedVisible(id, false); }
          });
        })
      ) : null,
      h(Forms.FormSection, { title: "Add badges" },
        addable.map(function (id) {
          var lock = blocked(id);
          return h(SwitchRow, {
            key: "a" + id,
            label: KNOWN[id].description,
            subLabel: lock ? "Exclusive - another one is active" : undefined,
            leading: h(BadgeImg, { id: id, size: 28 }),
            value: false,
            disabled: lock,
            onChange: function (v) { if (v) setAddedVisible(id, true); }
          });
        })
      )
    );
  }

  function DecorationsTab() {
    var subState = React.useState(0);
    var sub = subState[0];
    var qState = React.useState("");
    var q = qState[0];
    var shopState = React.useState(shop);
    var data = shopState[0];

    React.useEffect(function () {
      var alive = true;
      fetchShop().then(function (s) { if (alive) shopState[1](s); });
      return function () { alive = false; };
    }, []);

    var cfg = [
      { key: "avatar", list: data && data.avatar, sel: storage.avatarDecoration, hide: "hideAvatarDecoration", slot: "avatarDecoration", equip: equipAvatar, noun: "avatar decoration", wide: false },
      { key: "effect", list: data && data.effect, sel: storage.profileEffect, hide: "hideProfileEffect", slot: "profileEffect", equip: equipEffect, noun: "profile effect", wide: false },
      { key: "plate", list: data && data.plate, sel: storage.nameplate, hide: "hideNameplate", slot: "nameplate", equip: equipPlate, noun: "nameplate", wide: true }
    ][sub];

    var needle = q.trim().toLowerCase();
    var items = (cfg.list || []).filter(function (i) {
      if (!needle) return true;
      return i.name.toLowerCase().indexOf(needle) >= 0 || (i.label && i.label.toLowerCase().indexOf(needle) >= 0);
    });
    var total = items.length;
    items = items.slice(0, 60);
    var selSku = cfg.sel && cfg.sel.skuId;

    return h(React.Fragment, null,
      h(Chips, { items: ["Avatar", "Banner", "Nameplate"], value: sub, onChange: function (i) { subState[1](i); qState[1](""); } }),
      h(Forms.FormSection, { title: "Current" },
        h(SwitchRow, {
          label: "Hide my real " + cfg.noun,
          value: !!storage[cfg.hide],
          onChange: function (v) {
            storage[cfg.hide] = v;
            if (v) storage[cfg.slot] = null;
            refresh();
          }
        }),
        cfg.sel ? h(Forms.FormRow, {
          label: "Remove spoofed " + cfg.noun,
          subLabel: cfg.sel.label || cfg.sel.title || selSku,
          onPress: function () { cfg.equip(null); }
        }) : null
      ),
      h(Forms.FormSection, { title: "Browse" },
        h(Forms.FormInput, {
          title: "SEARCH",
          placeholder: "Search " + cfg.noun + "s...",
          value: q,
          onChange: function (v) { qState[1](String(v || "")); }
        }),
        !data ? h(Forms.FormText, { style: { padding: 16 } }, "Loading shop...") :
          !items.length ? h(Forms.FormText, { style: { padding: 16 } }, needle ? "Nothing matches." : "Couldn't load the shop (are you online?).") :
            items.map(function (it) {
              var picked = selSku === it.skuId;
              return h(Forms.FormRow, {
                key: cfg.key + it.skuId,
                label: it.name,
                leading: leadingImg(it.preview, cfg.wide ? 72 : 40, cfg.wide ? 24 : 40),
                trailing: picked ? h(Forms.FormText, null, "✓") : null,
                onPress: function () { picked ? cfg.equip(null) : cfg.equip(it); }
              });
            }),
        total > 60 ? h(Forms.FormText, { style: { padding: 16 } }, "Showing 60 of " + total + ". Search to narrow it down.") : null
      )
    );
  }

  function ConnectionsTab() {
    var typeState = React.useState(null);
    var nameState = React.useState("");
    var qState = React.useState("");
    var pickType = typeState[0];

    var uid = getOwnId();
    var prof = uid && origGetUserProfile ? origGetUserProfile(uid) : null;
    var real = (prof && prof.connectedAccounts) || [];
    var overrides = storage.connectionOverrides || {};
    var hidden = storage.hiddenConnections || [];
    var custom = storage.customConnections || [];

    var used = {};
    real.forEach(function (c) { if (hidden.indexOf(connKey(c)) < 0) used[c.type] = 1; });
    custom.forEach(function (c) { used[c.type] = 1; });
    var needle = qState[0].trim().toLowerCase();
    var available = CONN_TYPES.filter(function (t) {
      return !used[t] && (!needle || connLabel(t).toLowerCase().indexOf(needle) >= 0);
    }).slice(0, 8);

    function setOverride(key, v) {
      var next = {};
      Object.keys(overrides).forEach(function (k) { next[k] = overrides[k]; });
      if (!String(v || "").trim()) delete next[key];
      else next[key] = { name: v };
      storage.connectionOverrides = next;
      refresh();
    }

    function addCustom() {
      if (!pickType) return;
      var name = pickType === "domain" ? normalizeDomain(nameState[0]) : nameState[0].trim();
      if (!name) {
        toast(pickType === "domain" ? "Enter a domain" : "Enter a handle");
        return;
      }
      storage.customConnections = custom.concat([{ id: "larp-" + pickType + "-" + Date.now(), type: pickType, name: name }]);
      typeState[1](null);
      nameState[1]("");
      qState[1]("");
      refresh();
    }

    return h(React.Fragment, null,
      h(Forms.FormSection, { title: "Linked accounts" },
        !real.length && !custom.length ? h(Forms.FormText, { style: { padding: 16 } }, "No linked accounts yet. Add one below.") : null,
        real.map(function (c) {
          var key = connKey(c);
          var isHidden = hidden.indexOf(key) >= 0;
          var o = overrides[key] || overrides[c.type];
          return h(React.Fragment, { key: key },
            h(SwitchRow, {
              label: connLabel(c.type) + (isHidden ? " (hidden)" : ""),
              subLabel: c.name,
              value: !isHidden,
              onChange: function (v) {
                storage.hiddenConnections = v ? hidden.filter(function (k) { return k !== key; }) : hidden.concat([key]);
                refresh();
              }
            }),
            !isHidden ? h(Forms.FormInput, {
              title: "DISPLAY NAME",
              placeholder: c.name,
              value: (o && o.name) || "",
              onChange: function (v) { setOverride(key, v); }
            }) : null
          );
        }),
        custom.map(function (cc) {
          return h(React.Fragment, { key: cc.id },
            h(Forms.FormRow, {
              label: connLabel(cc.type),
              subLabel: "Added by you - tap to remove",
              onPress: function () {
                storage.customConnections = custom.filter(function (c) { return c.id !== cc.id; });
                refresh();
              }
            }),
            h(Forms.FormInput, {
              title: cc.type === "domain" ? "DOMAIN" : "HANDLE",
              value: cc.name,
              onChange: function (v) {
                storage.customConnections = custom.map(function (c) {
                  return c.id === cc.id ? { id: c.id, type: c.type, name: c.type === "domain" ? normalizeDomain(v) : v } : c;
                });
                refresh();
              }
            })
          );
        })
      ),
      h(Forms.FormSection, { title: "Add connection" },
        h(Forms.FormInput, {
          title: "PLATFORM",
          placeholder: "Search platforms...",
          value: qState[0],
          onChange: function (v) { qState[1](String(v || "")); }
        }),
        available.map(function (t) {
          return h(Forms.FormRow, {
            key: t,
            label: connLabel(t),
            trailing: pickType === t ? h(Forms.FormText, null, "✓") : null,
            onPress: function () { typeState[1](t); nameState[1](""); }
          });
        }),
        pickType ? h(React.Fragment, null,
          h(Forms.FormInput, {
            title: pickType === "domain" ? "DOMAIN" : "HANDLE",
            placeholder: pickType === "domain" ? "example.com" : "Handle",
            value: nameState[0],
            onChange: function (v) { nameState[1](String(v || "")); }
          }),
          h(Forms.FormRow, { label: "Add " + connLabel(pickType), onPress: addCustom })
        ) : null
      )
    );
  }

  function AboutTab() {
    return h(Forms.FormSection, { title: "Larp Tool" },
      h(SwitchRow, {
        label: "Enabled",
        value: !!storage.enabled,
        onChange: function (v) { storage.enabled = v; refresh(); }
      }),
      h(Forms.FormRow, {
        label: "Reset everything",
        subLabel: "Clears username, badges, decorations, join date and connections",
        onPress: function () {
          RN.Alert.alert("Reset all larp settings?", "This can't be undone.", [
            { text: "Cancel", style: "cancel" },
            { text: "Reset", style: "destructive", onPress: function () { resetAll(); toast("All settings reset"); } }
          ]);
        }
      }),
      h(Forms.FormText, { style: { padding: 16 } },
        "Client side only - nobody else sees any of this. Restart the app if something looks stale.")
    );
  }

  var TABS = [
    ["Username", UsernameTab],
    ["Badges", BadgesTab],
    ["Decorations", DecorationsTab],
    ["Joined", JoinedTab],
    ["Connections", ConnectionsTab],
    ["About", AboutTab]
  ];

  function Settings() {
    useProxy(storage);
    var s = React.useState(0);
    var Body = TABS[s[0]][1];
    return h(RN.ScrollView, { style: { flex: 1 }, contentContainerStyle: { paddingBottom: 48 }, keyboardShouldPersistTaps: "handled" },
      h(Chips, { items: TABS.map(function (t) { return t[0]; }), value: s[0], onChange: s[1] }),
      h(Body, { key: s[0] })
    );
  }

  // ----------------------------------------------------------------- patches

  function safe(label, fn) {
    try { fn(); } catch (e) { console.warn("[larp-tool] " + label + " failed", e); }
  }

  function installPatches() {
    safe("user store", function () {
      unpatches.push(patcher.after("getCurrentUser", UserStore, function (args, res) { return spoofUser(res); }));
      unpatches.push(patcher.after("getUser", UserStore, function (args, res) { return spoofUser(res); }));
    });

    safe("profile store", function () {
      unpatches.push(patcher.after("getUserProfile", UserProfileStore, function (args, res) {
        return spoofProfile(res, args[0]);
      }));
    });

    // The mobile profile screen builds its badge row through the useBadges hook
    safe("useBadges", function () {
      var mod = metro.findByName("useBadges", false);
      if (!mod) return;
      unpatches.push(patcher.after("default", mod, function (args, res) {
        var u = args[0];
        var id = u && (u.userId || u.id);
        if (!storage.enabled || !id || id !== getOwnId() || !Array.isArray(res)) return res;
        return mergeBadges(res);
      }));
    });

    // Our added badges may carry a full URL instead of a Discord icon hash
    safe("getBadgeAsset", function () {
      var mod = metro.findByProps("getBadgeAsset");
      if (!mod) return;
      unpatches.push(patcher.after("getBadgeAsset", mod, function (args, res) {
        if (typeof args[0] === "string" && args[0].indexOf("http") === 0) return { uri: args[0] };
        return res;
      }));
    });

    // "Member since" is derived from the snowflake
    safe("extractTimestamp", function () {
      var mod = metro.findByProps("extractTimestamp");
      if (!mod) return;
      unpatches.push(patcher.after("extractTimestamp", mod, function (args, res) {
        var ms = joinMs();
        if (ms != null && String(args[0]) === getOwnId()) return ms;
        return res;
      }));
    });
  }

  // ---------------------------------------------------------------- commands

  var botMsg = null;
  function reply(ctx, text) {
    try {
      if (!botMsg) botMsg = metro.findByProps("sendBotMessage");
      if (botMsg && ctx && ctx.channel) { botMsg.sendBotMessage(ctx.channel.id, String(text)); return; }
    } catch (e) {}
    toast(String(text).slice(0, 120));
  }

  function argMap(args) {
    var m = {};
    (args || []).forEach(function (a) { m[a.name] = a.value; });
    return m;
  }

  function choices(list) {
    return list.map(function (v) { return { name: v, displayName: v, value: v }; });
  }

  function opt(name, description, extra) {
    var o = { name: name, displayName: name, description: description, displayDescription: description, required: false, type: 3 };
    if (extra) for (var k in extra) o[k] = extra[k];
    return o;
  }

  // run() returns a string (or a promise of one) that is shown to you locally, not sent to the channel
  function defineCommand(name, description, options, run) {
    unpatches.push(vd.commands.registerCommand({
      name: name,
      displayName: name,
      description: description,
      displayDescription: description,
      options: options,
      applicationId: "-1",
      inputType: 1,
      type: 1,
      execute: function (args, ctx) {
        function fail(e) { reply(ctx, "Error: " + ((e && e.message) || e)); }
        try {
          var r = run(argMap(args), ctx);
          if (r && typeof r.then === "function") r.then(function (t) { if (t) reply(ctx, t); }).catch(fail);
          else if (r) reply(ctx, r);
        } catch (e) { fail(e); }
      }
    }));
  }

  function badgeCatalog() {
    var map = {};
    ownedBadgeEntries().forEach(function (b) { map[b.id] = { id: b.id, description: b.description, owned: true }; });
    Object.keys(KNOWN).forEach(function (id) {
      if (!map[id] && !map[canon(id)]) map[id] = { id: id, description: KNOWN[id].description, owned: false };
    });
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  function findBadges(list, q) {
    q = q.trim().toLowerCase();
    var exact = list.filter(function (b) {
      return b.id === q || b.id === canon(q) || b.description.toLowerCase() === q;
    });
    if (exact.length) return exact;
    return list.filter(function (b) {
      return b.id.indexOf(q) >= 0 || b.description.toLowerCase().indexOf(q) >= 0;
    });
  }

  function pickOne(matches, q) {
    if (!q || !q.trim()) return { err: "Give a badge name or id with the badge option." };
    if (!matches.length) return { err: "No badge matches \"" + q + "\"." };
    if (matches.length > 1) {
      return { err: "Be more specific. Matches: " + matches.slice(0, 8).map(function (b) { return b.description + " (" + b.id + ")"; }).join(", ") };
    }
    return { item: matches[0] };
  }

  function normType(q) {
    var s = String(q || "").trim().toLowerCase().replace(/[\s_-]/g, "");
    if (!s) return "";
    for (var i = 0; i < CONN_TYPES.length; i++) {
      if (CONN_TYPES[i].replace(/-/g, "") === s || connLabel(CONN_TYPES[i]).toLowerCase().replace(/\s/g, "") === s) return CONN_TYPES[i];
    }
    return null;
  }

  function defineDecoCommand(name, label, cfg) {
    defineCommand(name, "Manage your spoofed " + label,
      [
        opt("action", "What to do", { required: true, choices: choices(["list", "set", "clear", "hide", "show"]) }),
        opt("query", "Name to search for or set")
      ],
      function (a) {
        var act = a.action;
        if (act === "clear") { cfg.equip(null); return "Spoofed " + label + " removed."; }
        if (act === "hide" || act === "show") {
          storage[cfg.hide] = act === "hide";
          if (act === "hide") storage[cfg.slot] = null;
          refresh();
          return act === "hide" ? "Your real " + label + " is now hidden." : "Your real " + label + " is visible again.";
        }
        return fetchShop().then(function (s) {
          var all = s[cfg.key] || [];
          if (!all.length) return "Couldn't load the shop (are you online?).";
          var q = (a.query || "").trim().toLowerCase();
          var m = all.filter(function (i) {
            return !q || i.name.toLowerCase().indexOf(q) >= 0 || (i.label && i.label.toLowerCase().indexOf(q) >= 0);
          });
          if (act === "list") {
            if (!m.length) return "No " + label + " matches.";
            return m.length + " match(es): " + m.slice(0, 15).map(function (i) { return i.name; }).join(", ") + (m.length > 15 ? " ..." : "");
          }
          if (act === "set") {
            if (!q) return "Give a name with the query option.";
            var exact = m.filter(function (i) { return i.name.toLowerCase() === q; });
            var pick = exact.length === 1 ? exact[0] : m.length === 1 ? m[0] : null;
            if (!pick) {
              return m.length
                ? "Be more specific. Matches: " + m.slice(0, 8).map(function (i) { return i.name; }).join(", ")
                : "No " + label + " matches \"" + a.query + "\".";
            }
            cfg.equip(pick);
            return "Equipped " + pick.name + ".";
          }
          return "Unknown action.";
        });
      });
  }

  function registerCommands() {
    if (!vd.commands || !vd.commands.registerCommand) {
      console.warn("[larp-tool] vendetta.commands is unavailable, skipping slash commands");
      return;
    }

    defineCommand("larp-help", "List all Larp Tool commands", [], function () {
      return [
        "/larp-status - show your current settings",
        "/larp-toggle - turn the plugin on or off",
        "/larp-username - set or clear your @username",
        "/larp-joined - set or clear your member-since date",
        "/larp-badge - list, hide, show, add, remove, clear badges",
        "/larp-avatar - list, set, clear, hide, show avatar decoration",
        "/larp-banner - list, set, clear, hide, show profile effect",
        "/larp-nameplate - list, set, clear, hide, show nameplate",
        "/larp-connection - list, hide, show, rename, add, remove, clear connections",
        "/larp-reset - reset everything (needs confirm: yes)"
      ].join("\n");
    });

    defineCommand("larp-status", "Show your current Larp Tool settings", [], function () {
      var d = storage.avatarDecoration, e = storage.profileEffect, p = storage.nameplate;
      return [
        "Plugin: " + (storage.enabled ? "on" : "off"),
        "Username: " + (storage.customUsername || "(real)"),
        "Joined: " + (storage.customJoinDate || "(real)"),
        "Hidden badges: " + ((storage.hiddenBadges || []).join(", ") || "none"),
        "Added badges: " + ((storage.addedBadges || []).join(", ") || "none"),
        "Avatar decoration: " + (storage.hideAvatarDecoration ? "hidden" : d ? (d.label || d.skuId) : "(real)"),
        "Banner effect: " + (storage.hideProfileEffect ? "hidden" : e ? (e.title || e.skuId) : "(real)"),
        "Nameplate: " + (storage.hideNameplate ? "hidden" : p ? (p.label || p.skuId) : "(real)"),
        "Hidden connections: " + (storage.hiddenConnections || []).length,
        "Added connections: " + (storage.customConnections || []).length
      ].join("\n");
    });

    defineCommand("larp-toggle", "Turn Larp Tool on or off",
      [opt("state", "on or off", { required: true, choices: choices(["on", "off"]) })],
      function (a) {
        storage.enabled = a.state === "on";
        refresh();
        return "Larp Tool is now " + a.state + ".";
      });

    defineCommand("larp-username", "Set or clear your spoofed @username",
      [opt("name", "New username (leave empty to clear)")],
      function (a) {
        var n = (a.name || "").trim().slice(0, 32);
        storage.customUsername = n;
        refresh();
        return n ? "Username set to @" + n + "." : "Username spoof cleared.";
      });

    defineCommand("larp-joined", "Set or clear your member-since date",
      [opt("date", "YYYY-MM-DD (leave empty to clear)")],
      function (a) {
        var v = (a.date || "").trim();
        if (!v) { storage.customJoinDate = ""; refresh(); return "Join date spoof cleared."; }
        if (!parseJoinDate(v)) return "That isn't a valid date. Use YYYY-MM-DD.";
        storage.customJoinDate = v;
        refresh();
        return "Member since set to " + v + ".";
      });

    defineCommand("larp-badge", "Manage profile badges",
      [
        opt("action", "What to do", { required: true, choices: choices(["list", "catalog", "hide", "show", "add", "remove", "clear"]) }),
        opt("badge", "Badge name or id")
      ],
      function (a) {
        var act = a.action;
        var cat = badgeCatalog();
        var added = storage.addedBadges || [];

        if (act === "list") {
          var own = cat.filter(function (b) { return b.owned; }).map(function (b) {
            return b.description + " (" + b.id + ")" + (isOwnedVisible(b.id) ? "" : " [hidden]");
          });
          var extra = added.map(function (id) { return (KNOWN[id] ? KNOWN[id].description : id) + " (" + id + ")"; });
          return "Your badges: " + (own.join(", ") || "none") + "\nAdded: " + (extra.join(", ") || "none");
        }
        if (act === "catalog") {
          return "Badges you can add: " + cat.filter(function (b) {
            return !b.owned && added.indexOf(b.id) < 0;
          }).map(function (b) { return b.id; }).join(", ");
        }
        if (act === "clear") {
          storage.hiddenBadges = [];
          storage.addedBadges = [];
          refresh();
          return "Badge changes cleared.";
        }

        var q = a.badge || "";
        var pool = act === "hide" || act === "show" ? cat.filter(function (b) { return b.owned; })
          : act === "add" ? cat.filter(function (b) { return !b.owned; })
            : cat.filter(function (b) { return added.indexOf(b.id) >= 0; });
        var r = pickOne(findBadges(pool, q), q);
        if (r.err) return r.err;
        var b = r.item;

        if (act === "hide") { setOwnedVisible(b.id, false); return "Hid " + b.description + "."; }
        if (act === "show") { setOwnedVisible(b.id, true); return "Showing " + b.description + "."; }
        if (act === "add") { setAddedVisible(b.id, true); return "Added " + b.description + "."; }
        if (act === "remove") { setAddedVisible(b.id, false); return "Removed " + b.description + "."; }
        return "Unknown action.";
      });

    defineDecoCommand("larp-avatar", "avatar decoration", { key: "avatar", slot: "avatarDecoration", hide: "hideAvatarDecoration", equip: equipAvatar });
    defineDecoCommand("larp-banner", "banner effect", { key: "effect", slot: "profileEffect", hide: "hideProfileEffect", equip: equipEffect });
    defineDecoCommand("larp-nameplate", "nameplate", { key: "plate", slot: "nameplate", hide: "hideNameplate", equip: equipPlate });

    defineCommand("larp-connection", "Manage linked accounts",
      [
        opt("action", "What to do", { required: true, choices: choices(["list", "hide", "show", "rename", "add", "remove", "clear"]) }),
        opt("type", "Platform, e.g. github, steam, domain"),
        opt("name", "Handle, domain or display name")
      ],
      function (a) {
        var act = a.action;
        var uid = getOwnId();
        var prof = uid && origGetUserProfile ? origGetUserProfile(uid) : null;
        var real = (prof && prof.connectedAccounts) || [];
        var hidden = storage.hiddenConnections || [];
        var custom = storage.customConnections || [];
        var overrides = storage.connectionOverrides || {};

        if (act === "list") {
          var lines = real.map(function (c) {
            var o = overrides[connKey(c)] || overrides[c.type];
            return connLabel(c.type) + ": " + ((o && o.name) || c.name) + (hidden.indexOf(connKey(c)) >= 0 ? " [hidden]" : "");
          }).concat(custom.map(function (c) { return connLabel(c.type) + ": " + c.name + " [added]"; }));
          return lines.length ? lines.join("\n") : "No linked accounts.";
        }
        if (act === "clear") {
          storage.hiddenConnections = [];
          storage.customConnections = [];
          storage.connectionOverrides = {};
          refresh();
          return "Connection changes cleared.";
        }

        var t = normType(a.type);
        if (t === null) return "Unknown platform. Options: " + CONN_TYPES.join(", ");
        if (!t) return "Give a platform with the type option.";
        var name = (a.name || "").trim();
        var rc = real.filter(function (c) { return c.type === t; })[0];
        var cc = custom.filter(function (c) { return c.type === t; })[0];

        if (act === "add") {
          if (!name) return "Give a handle with the name option.";
          if ((rc && hidden.indexOf(connKey(rc)) < 0) || cc) return "You already have a " + connLabel(t) + " connection.";
          storage.customConnections = custom.concat([{ id: "larp-" + t + "-" + Date.now(), type: t, name: t === "domain" ? normalizeDomain(name) : name }]);
          refresh();
          return "Added " + connLabel(t) + ": " + name + ".";
        }
        if (act === "hide") {
          if (!rc) return "You have no real " + connLabel(t) + " connection. Use remove for added ones.";
          if (hidden.indexOf(connKey(rc)) < 0) storage.hiddenConnections = hidden.concat([connKey(rc)]);
          refresh();
          return "Hid " + connLabel(t) + ".";
        }
        if (act === "show") {
          if (!rc) return "You have no real " + connLabel(t) + " connection.";
          storage.hiddenConnections = hidden.filter(function (k) { return k !== connKey(rc); });
          refresh();
          return "Showing " + connLabel(t) + ".";
        }
        if (act === "rename") {
          if (cc) {
            if (!name) return "Give the new name with the name option.";
            storage.customConnections = custom.map(function (c) {
              return c === cc || c.id === cc.id ? { id: c.id, type: c.type, name: t === "domain" ? normalizeDomain(name) : name } : c;
            });
          } else if (rc) {
            var next = {};
            Object.keys(overrides).forEach(function (k) { next[k] = overrides[k]; });
            if (name) next[connKey(rc)] = { name: name }; else delete next[connKey(rc)];
            storage.connectionOverrides = next;
          } else {
            return "You have no " + connLabel(t) + " connection.";
          }
          refresh();
          return name ? "Renamed " + connLabel(t) + " to " + name + "." : "Display name for " + connLabel(t) + " reset.";
        }
        if (act === "remove") {
          if (!cc) return "No added " + connLabel(t) + " connection. Use hide for real ones.";
          storage.customConnections = custom.filter(function (c) { return c.id !== cc.id; });
          refresh();
          return "Removed " + connLabel(t) + ".";
        }
        return "Unknown action.";
      });

    defineCommand("larp-reset", "Reset every Larp Tool setting",
      [opt("confirm", "Choose yes to confirm", { required: true, choices: choices(["yes", "no"]) })],
      function (a) {
        if (a.confirm !== "yes") return "Reset cancelled.";
        resetAll();
        return "All settings reset.";
      });
  }

  return {
    onLoad: function () {
      initStorage();
      safe("commands", registerCommands);
      origGetCurrentUser = UserStore.getCurrentUser.bind(UserStore);
      origGetUserProfile = UserProfileStore.getUserProfile.bind(UserProfileStore);
      getOwnId();
      installPatches();
      refresh();
      fetchShop().catch(function () {});
    },
    onUnload: function () {
      unpatches.splice(0).forEach(function (fn) { try { fn(); } catch (e) {} });
      gen++;
      refresh();
    },
    settings: Settings
  };
})()
