(function () {
	"use strict";

	/*
	 * Staff Tags for Kettu / Vendetta.
	 *
	 * Adds OWNER / ADMIN / STAFF / MOD / VC Mod / Chat Mod / WEBHOOK tags to message rows, the member
	 * list and profile headers, and lets you change each tag's text, colour, gradient, icon and
	 * visibility from the plugin settings.
	 *
	 * The whole file is evaluated by Vendetta as `vendetta => { return <this file> }`, so it has to
	 * stay one expression that starts at the first character: no leading comment or blank line
	 * above the opening bracket (a newline after `return` ends the statement), and no trailing
	 * `//` comment on the last line.
	 */

	const TAG = "[StaffTags]";
	const { metro, patcher } = vendetta;
	const storage = vendetta.plugin.storage;

	function report(message, error) {
		try {
			console.error(TAG, message, error);
		} catch (_) {
			/* nothing sensible left to do */
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Small helpers. Everything Discord-shaped is looked up at call time, never at load: a lookup
	// that runs before the module exists just misses, and a render that runs before React is
	// ready must not take the app down.
	// ---------------------------------------------------------------------------------------------

	const R = () => metro.common.React;
	const RN = () => metro.common.ReactNative;
	const F = () => vendetta.ui.components.Forms;
	const h = (...args) => R().createElement(...args);
	/** cloneElement; `children`, when given, replaces the element's children. */
	const clone = (element, props, children) => R().cloneElement(element, props, ...(children ?? []));

	/**
	 * Resolves once and remembers a hit. A miss is retried at most every `retryMs`, because a
	 * lookup walks every Discord module and these run on every row Discord draws.
	 */
	function lazyFind(resolve, retryMs) {
		let value;
		let done = false;
		let last = 0;
		return () => {
			if (done) return value;
			const now = Date.now();
			if (now - last < (retryMs ?? 3000)) return undefined;
			last = now;
			try {
				value = resolve();
			} catch (_) {
				value = undefined;
			}
			if (value) done = true;
			return value;
		};
	}

	/** Every module the filter matches. Falls back to the first match on builds without findAll. */
	function findAllModules(filter) {
		try {
			if (typeof metro.findAll === "function") return metro.findAll(filter) || [];
			const one = metro.find(filter);
			return one ? [one] : [];
		} catch (_) {
			return [];
		}
	}

	/**
	 * Runs `cb` with whatever `find` returns, as soon as it returns something.
	 *
	 * Parts of the chat UI (the message row, the member list) are only initialised once their
	 * screen first renders, so on a cold start a lookup made from onLoad can come back empty.
	 * Keep asking, gently, for a few minutes before giving up. Returns a function that stops it.
	 */
	function waitFor(find, cb, label) {
		const INTERVAL = 2500;
		const MAX_TRIES = 72;
		let timer;
		let tries = 0;
		let stopped = false;

		const attempt = () => {
			if (stopped) return true;
			let found;
			try {
				found = find();
			} catch (_) {
				found = undefined;
			}
			if (!found) return false;
			try {
				cb(found);
			} catch (error) {
				report("could not patch " + label + ":", error);
			}
			return true;
		};

		if (!attempt()) {
			timer = setInterval(() => {
				tries++;
				if (attempt() || tries >= MAX_TRIES) {
					clearInterval(timer);
					timer = undefined;
					if (!stopped && tries >= MAX_TRIES) report("gave up looking for the " + label + " module", undefined);
				}
			}, INTERVAL);
		}

		return () => {
			stopped = true;
			if (timer) clearInterval(timer);
			timer = undefined;
		};
	}

	/** First match for `root` or anything under its `props.children`, like Vendetta's findInReactTree. */
	function findInReactTree(root, predicate, depth) {
		depth = depth || 0;
		if (!root || typeof root !== "object" || depth > 30) return undefined;
		if (predicate(root)) return root;

		const children = root.props?.children;
		if (Array.isArray(children)) {
			for (const child of children) {
				const found = findInReactTree(child, predicate, depth + 1);
				if (found) return found;
			}
		} else if (children && typeof children === "object") {
			return findInReactTree(children, predicate, depth + 1);
		}
		return undefined;
	}

	/**
	 * Copy of `root` with the first node matching `match` replaced by `replace(node)`, cloning only
	 * its ancestors. Discord caches rendered elements between renders, so editing them in place
	 * would apply the change again on every re-render.
	 */
	function replaceInTree(root, match, replace, depth) {
		depth = depth || 0;
		if (!root || typeof root !== "object" || depth > 30) return root;
		if (match(root)) return replace(root);

		const children = root.props?.children;
		if (Array.isArray(children)) {
			for (let i = 0; i < children.length; i++) {
				const next = replaceInTree(children[i], match, replace, depth + 1);
				if (next !== children[i]) {
					const copy = children.slice();
					copy[i] = next;
					return clone(root, {}, copy);
				}
			}
		} else if (children && typeof children === "object") {
			const next = replaceInTree(children, match, replace, depth + 1);
			if (next !== children) return clone(root, {}, [next]);
		}
		return root;
	}

	// ---------------------------------------------------------------------------------------------
	// Storage: { useRoleColor: boolean, tags: { [tagId]: TagOverride } }
	//
	// TagOverride (everything optional, absent means "as shipped"):
	//   enabled, text, icon, customSvg, iconOnly, useCustomColor, color, useGradient, gradientColor
	// ---------------------------------------------------------------------------------------------

	function ensureStorage() {
		if (typeof storage.useRoleColor !== "boolean") storage.useRoleColor = false;
		if (!storage.tags || typeof storage.tags !== "object") storage.tags = {};
	}

	/** One tag's changes, or an empty object when it has never been touched. */
	function overrideFor(id) {
		return (storage.tags && storage.tags[id]) || {};
	}

	/** Merges into one tag's entry, leaving every other tag alone. */
	function setOverride(id, patch) {
		try {
			ensureStorage();
			storage.tags[id] = Object.assign({}, storage.tags[id] || {}, patch);
		} catch (error) {
			report("could not save tag settings:", error);
		}
	}

	function resetOverride(id) {
		try {
			ensureStorage();
			storage.tags[id] = {};
		} catch (error) {
			report("could not reset tag:", error);
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Icons
	//
	// Each is one SVG path in a 24x24 box plus a text glyph, used where react-native-svg cannot be
	// resolved and in message rows (drawn by native code, which only takes a string).
	// ---------------------------------------------------------------------------------------------

	const CUSTOM_ICON = "custom";
	const MAX_CUSTOM_SVG_LENGTH = 20000;

	const ICONS = [
		{ id: "none", name: "No icon", path: "", fallback: "" },
		{ id: "star", name: "Star", path: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z", fallback: "★" },
		{ id: "crown", name: "Crown", path: "M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z", fallback: "♛" },
		{ id: "shield", name: "Shield", path: "M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z", fallback: "🛡" },
		{ id: "check", name: "Check", path: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z", fallback: "✓" },
		{ id: "bolt", name: "Bolt", path: "M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66.19-.34.05-.08.07-.12C8.48 10.94 11.07 6 13.5 6c.46 0 .85.33.96.79L15 10h3.5c.49 0 .64.32.45.66-.19.34-.05.08-.07.12C17.52 14.06 15.07 19 13 19l-1 2z", fallback: "⚡" },
		{ id: "flame", name: "Flame", path: "M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73 0-2.15.74-4.8.74-4.8C5.26 3.12 2 7.05 2 12c0 5.52 4.48 10 10 10s10-4.48 10-10c0-4.95-3.26-8.88-7.5-11.33z", fallback: "🔥" },
		{ id: "gem", name: "Gem", path: "M12 2l8 5-8 15-8-15 8-5z", fallback: "♦" },
		{ id: "heart", name: "Heart", path: "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z", fallback: "♥" },
		{ id: "lock", name: "Lock", path: "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z", fallback: "🔒" },
		{ id: "key", name: "Key", path: "M12.65 10a5.998 5.998 0 0 0-6.88-3.88c-2.29.46-4.15 2.29-4.63 4.58A6.006 6.006 0 0 0 7 18a5.99 5.99 0 0 0 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z", fallback: "🔑" },
		{ id: "eye", name: "Eye", path: "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z", fallback: "👁" },
		{ id: "bell", name: "Bell", path: "M18 16v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z", fallback: "🔔" },
		{ id: "flag", name: "Flag", path: "M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z", fallback: "⚑" },
		{ id: "tag", name: "Tag", path: "M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z", fallback: "🏷" },
		{ id: "robot", name: "Robot", path: "M20 9V7c0-1.1-.9-2-2-2h-3.2c-.5-1.9-2.2-3.3-4.2-3.3S7.9 3.1 7.4 5H4.2C3 5 2 6 2 7.2v9.6C2 18 3 19 4.2 19h.2v1c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-1h8v1c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-1h.2c1.2 0 2.2-1 2.2-2.2V9h-2zm-4 7H8v-2h8v2zm0-4H8V9h8v3z", fallback: "🤖" },
		{ id: "moon", name: "Moon", path: "M9 2c-1.05 0-2.05.16-3 .46 1.69 1.23 2.8 3.24 2.8 5.54 0 3.87-3.13 7-7 7-1.04 0-2.02-.23-2.9-.64C2.24 18.24 6.36 22 11.5 22c5.5 0 10-4.5 10-10S17 2 11.5 2c-.83 0-1.63.1-2.39.29C9.32 2.1 9.16 2 9 2z", fallback: "🌙" },
		{ id: "music", name: "Music", path: "M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z", fallback: "♪" },
		{ id: "gamepad", name: "Gamepad", path: "M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4-3c-.83 0-1.5-.67-1.5-1.5S18.67 9 19.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z", fallback: "🎮" },
		{ id: "leaf", name: "Leaf", path: "M17 8C8 10 5.9 16.17 3.82 21.34l1.89.66.95-2.3c.48.17.98.3 1.34.3C19 20 22 3 22 3c-1 2-3 5-5 5z", fallback: "🍃" },
		{ id: "anchor", name: "Anchor", path: "M12 2a3 3 0 0 0-1 5.83V10H8v2h3v6.92A7.01 7.01 0 0 1 5.08 13H7l-3-4-3 4h2.06A9.01 9.01 0 0 0 12 21a9.01 9.01 0 0 0 8.94-8H23l-3-4-3 4h1.92A7.01 7.01 0 0 1 13 18.92V12h3v-2h-3V7.83A3 3 0 0 0 12 2zm0 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2z", fallback: "⚓" },
	];

	function iconById(id) {
		if (!id || id === "none") return undefined;
		return ICONS.find(icon => icon.id === id);
	}

	/**
	 * react-native-svg, or undefined on a build that does not bundle it. Several modules carry the
	 * same export names, so keep going until one holds real components (a string handed to
	 * createElement is an unknown native view, which can take the renderer down).
	 */
	const svgModule = lazyFind(() => {
		const matches = findAllModules(m => {
			try {
				return typeof m.Path === "function" && (typeof m.Svg === "function" || typeof m.default === "function");
			} catch (_) {
				return false;
			}
		});
		for (const mod of matches) {
			const Svg = mod.default ?? mod.Svg;
			if (typeof Svg === "function" && typeof mod.Path === "function") return mod;
		}
		return undefined;
	});

	/** The `SvgXml` component, for pasted markup. */
	const svgXml = lazyFind(() => {
		for (const mod of findAllModules(m => {
			try {
				return typeof m.SvgXml === "function";
			} catch (_) {
				return false;
			}
		})) {
			if (typeof mod.SvgXml === "function") return mod.SvgXml;
		}
		return undefined;
	});

	/** react-native-linear-gradient. Optional: without it a gradient tag shows its first colour. */
	const linearGradient = lazyFind(() => {
		for (const mod of findAllModules(m => {
			try {
				return !!m.LinearGradient;
			} catch (_) {
				return false;
			}
		})) {
			const candidate = mod.LinearGradient ?? mod.default;
			if (typeof candidate === "function") return candidate;
		}
		return undefined;
	});

	/** Whether pasted markup is worth trying to draw. Checked before it is stored. */
	function isValidCustomSvg(markup) {
		const trimmed = markup?.trim();
		if (!trimmed || trimmed.length > MAX_CUSTOM_SVG_LENGTH || !/^<svg/i.test(trimmed)) return false;
		try {
			const parse = svgModule()?.parse;
			if (typeof parse === "function") parse(trimmed);
			return true;
		} catch (_) {
			return false;
		}
	}

	/** The little icon a tag can carry: a built-in path, pasted markup, or the glyph as a fallback. */
	function TagIcon(props) {
		const { Text } = RN();
		const { icon, customSvg, color } = props;
		const size = props.size || 12;

		if (!icon || icon === "none") return null;

		if (icon === CUSTOM_ICON) {
			const Xml = svgXml();
			if (typeof Xml === "function" && isValidCustomSvg(customSvg)) {
				return h(Xml, { xml: customSvg, width: size, height: size, color: color });
			}
			return null;
		}

		const def = iconById(icon);
		if (!def) return null;

		const svg = svgModule();
		const Svg = svg?.default ?? svg?.Svg;
		const Path = svg?.Path;
		if (typeof Svg !== "function" || typeof Path !== "function" || !def.path) {
			return def.fallback ? h(Text, { style: { color: color, fontSize: size, marginRight: 2 } }, def.fallback) : null;
		}

		return h(
			Svg,
			{ width: size, height: size, viewBox: "0 0 24 24", style: { marginRight: 2 } },
			h(Path, { d: def.path, fill: color }),
		);
	}

	// ---------------------------------------------------------------------------------------------
	// Which tag a person gets
	// ---------------------------------------------------------------------------------------------

	const findTagModule = () => metro.findByProps("getBotLabel");
	const tagModule = lazyFind(findTagModule);

	const store = name => lazyFind(() => metro.findByStoreName(name));
	const guildStore = store("GuildStore");
	const channelStore = store("ChannelStore");
	const selectedChannelStore = store("SelectedChannelStore");
	const guildMemberStore = store("GuildMemberStore");

	/** Whether a tag type maps to one of Discord's own labels (BOT, SYSTEM, ...). */
	function isBuiltInTag(type) {
		if (typeof type !== "number") return false;
		try {
			const label = tagModule()?.getBotLabel?.(type);
			return typeof label === "string" && label.length > 0;
		} catch (_) {
			return false;
		}
	}

	/**
	 * Whether a node is a Discord Tag element: it carries the component's static `Types`, or is the
	 * component itself (a patched function may not keep its statics).
	 */
	function isTagElement(node) {
		const type = node?.type;
		if (!type) return false;
		return !!type.Types || (typeof type === "function" && tagModule()?.default === type);
	}

	/** Perceived brightness (ITU-R BT.601) of a hex colour; dark backgrounds get white text. */
	function isDarkColor(hex) {
		const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})/i.exec(hex);
		if (!match) return true;
		const r = parseInt(match[1], 16);
		const g = parseInt(match[2], 16);
		const b = parseInt(match[3], 16);
		return (r * 299 + g * 587 + b * 114) / 1000 < 140;
	}

	/**
	 * Permission bit positions, hardcoded: they are part of Discord's public API and cannot change
	 * without breaking every bot on the platform. Only the ones this plugin tests are listed.
	 */
	const PERMISSION_BITS = {
		KICK_MEMBERS: 1,
		BAN_MEMBERS: 2,
		ADMINISTRATOR: 3,
		MANAGE_CHANNELS: 4,
		MANAGE_GUILD: 5,
		MANAGE_MESSAGES: 13,
		MUTE_MEMBERS: 22,
		DEAFEN_MEMBERS: 23,
		MOVE_MEMBERS: 24,
		MANAGE_ROLES: 28,
		MANAGE_WEBHOOKS: 29,
		MODERATE_MEMBERS: 40,
	};

	/** Bit test that works on a BigInt bitfield and, on older builds, a plain number. */
	function hasBit(permissions, bit) {
		if (typeof permissions === "bigint") return ((permissions >> BigInt(bit)) & BigInt(1)) === BigInt(1);
		if (typeof permissions === "number") return Math.floor(permissions / Math.pow(2, bit)) % 2 === 1;
		return false;
	}

	const TAGS = [
		{
			id: "webhook",
			text: "WEBHOOK",
			defaultColor: "#99AAB5",
			condition: (_guild, _channel, user) => (typeof user.isNonUserBot === "function" ? user.isNonUserBot() : false),
		},
		{
			id: "owner",
			text: "OWNER",
			defaultColor: "#F0B232",
			condition: (guild, _channel, user) => guild?.ownerId === user.id,
		},
		{ id: "admin", text: "ADMIN", defaultColor: "#F23F42", permissions: ["ADMINISTRATOR"] },
		{
			id: "staff",
			text: "STAFF",
			defaultColor: "#23A55A",
			permissions: ["MANAGE_GUILD", "MANAGE_CHANNELS", "MANAGE_ROLES", "MANAGE_WEBHOOKS"],
		},
		{
			id: "mod",
			text: "MOD",
			defaultColor: "#5865F2",
			permissions: ["MANAGE_MESSAGES", "KICK_MEMBERS", "BAN_MEMBERS"],
		},
		{
			id: "vc_mod",
			text: "VC Mod",
			defaultColor: "#1ABC9C",
			permissions: ["MOVE_MEMBERS", "MUTE_MEMBERS", "DEAFEN_MEMBERS"],
		},
		{ id: "chat_mod", text: "Chat Mod", defaultColor: "#9B59B6", permissions: ["MODERATE_MEMBERS"] },
	];

	/** Discord has renamed the permission helper across builds, so try the known names in order. */
	const computePermissionsFn = lazyFind(() => {
		const mod =
			metro.findByProps("computePermissionsForMember") ||
			metro.findByProps("computePermissions", "canEveryoneRole") ||
			metro.findByProps("computePermissions");
		const fn = mod?.computePermissionsForMember ?? mod?.computePermissions;
		return typeof fn === "function" ? fn : undefined;
	});

	// The helper's argument order isn't documented, so try the known call shapes once and remember
	// whichever answers. -1 means none work: permission tags are skipped rather than throwing on
	// every row.
	const callShapes = [
		(fn, guild, channel, user) => fn({ user: user, context: guild, overwrites: channel?.permissionOverwrites }),
		(fn, guild, channel, user) =>
			fn({ user: user, context: guild, overwrites: channel?.permissionOverwrites, checkElevated: false }),
		(fn, guild, channel, user) => fn(user, guild, channel),
		(fn, guild, channel, user) => fn(guild, channel, user),
	];
	let workingShape;

	function computePermissions(guild, channel, user) {
		const fn = computePermissionsFn();
		if (typeof fn !== "function") return undefined;

		const candidates = workingShape === undefined ? [0, 1, 2, 3] : workingShape === -1 ? [] : [workingShape];
		for (const index of candidates) {
			try {
				const result = callShapes[index](fn, guild, channel, user);
				if (typeof result === "bigint" || typeof result === "number") {
					workingShape = index;
					return result;
				}
			} catch (_) {
				/* wrong shape, try the next one */
			}
		}

		if (workingShape === undefined) workingShape = -1;
		return undefined;
	}

	let warnedPermissions = false;
	function warnIfPermissionsBroken(permissions) {
		if (warnedPermissions || permissions !== undefined) return;
		warnedPermissions = true;
		report(
			"could not compute permissions (helper=" +
				typeof computePermissionsFn() +
				", workingShape=" +
				workingShape +
				"). ADMIN/STAFF/MOD tags will not appear.",
			undefined,
		);
	}

	/** The tag this person should show, fully resolved (text, colours, icon), or undefined. */
	function getTag(guild, channel, user, useRoleColor) {
		if (!user) return undefined;

		let permissions;
		if (guild) {
			permissions = computePermissions(guild, channel, user);
			warnIfPermissionsBroken(permissions);
		}

		const hasPermission = name => {
			const bit = PERMISSION_BITS[name];
			return bit !== undefined && permissions !== undefined && hasBit(permissions, bit);
		};

		for (const tag of TAGS) {
			if (!(tag.condition?.(guild, channel, user) || (!user.bot && tag.permissions?.some(hasPermission)))) continue;

			// Read per call, not captured, so a settings change shows up on the next row Discord draws.
			const custom = overrideFor(tag.id);
			if (custom.enabled === false) continue;

			const roleColor = useRoleColor
				? guildMemberStore()?.getMember?.(guild?.id, user.id)?.colorString
				: undefined;
			// A colour the user picked wins over the role colour: they asked for that exact one.
			const chosenColor = custom.useCustomColor && custom.color ? custom.color : undefined;
			const backgroundColor = chosenColor || roleColor || tag.defaultColor || "#5865F2";
			const textColor = isDarkColor(backgroundColor) ? "#FFFFFF" : "#000000";
			const icon = custom.icon && custom.icon !== "none" ? custom.icon : undefined;

			return {
				id: tag.id,
				text: custom.text?.trim() || tag.text,
				textColor: textColor,
				backgroundColor: backgroundColor,
				gradientColor: custom.useGradient && custom.gradientColor ? custom.gradientColor : undefined,
				icon: icon,
				customSvg: custom.customSvg,
				iconOnly: !!custom.iconOnly,
				// Message rows are drawn by native code: a string and no components. The icon's glyph
				// is the only way an icon can show up there at all.
				iconGlyph: iconById(custom.icon)?.fallback,
				verified: false,
			};
		}

		return undefined;
	}

	/** The props a Discord Tag element is given for one of our tags. */
	function tagProps(tag) {
		return {
			staffTag: true,
			type: 0,
			text: tag.text,
			textColor: tag.textColor,
			backgroundColor: tag.backgroundColor,
			gradientColor: tag.gradientColor,
			icon: tag.icon,
			customSvg: tag.customSvg,
			iconOnly: tag.iconOnly,
			verified: tag.verified,
		};
	}

	// ---------------------------------------------------------------------------------------------
	// Surface 1: the Tag component itself. Paints our text, colours, icon and gradient onto any
	// Tag we asked for (marked with `staffTag`), and leaves every other tag alone.
	// ---------------------------------------------------------------------------------------------

	function paintTag(props, ret) {
		if (!props || !props.staffTag || !ret || typeof ret !== "object") return ret;

		const { text, textColor, backgroundColor, gradientColor, icon, customSvg, iconOnly } = props;
		const label = findInReactTree(ret, c => typeof c?.props?.children === "string");
		if (!label) return ret;

		const hasIcon = !!icon && icon !== "none";

		// New label (text and colour), cloned rather than edited: the original may be cached.
		let out = replaceInTree(
			ret,
			c => c === label,
			c =>
				clone(
					c,
					textColor ? { style: [c.props.style, { color: textColor }] } : {},
					[text ? (iconOnly && hasIcon ? "" : text) : c.props.children],
				),
		);

		const rootProps = {};
		if (backgroundColor) rootProps.style = [out.props.style, { backgroundColor: backgroundColor }];
		let children = out.props.children;
		children = Array.isArray(children) ? children : children == null ? [] : [children];

		// The icon goes in the tag's own row, not inside the label: an SVG nested in a Text does
		// not render on Android.
		if (hasIcon) {
			children = [
				h(TagIcon, { key: "staff-tags-icon", icon: icon, customSvg: customSvg, color: textColor || "#FFFFFF" }),
				...children,
			];
		}
		out = clone(out, rootProps, children);

		// A gradient replaces the tag's background, so the element has to become one that can draw
		// it. Same style and children, different host component.
		if (gradientColor && backgroundColor) {
			const Gradient = linearGradient();
			if (Gradient) {
				try {
					return h(
						Gradient,
						{
							colors: [backgroundColor, gradientColor],
							start: { x: 0, y: 0.5 },
							end: { x: 1, y: 0.5 },
							style: out.props.style,
						},
						...children,
					);
				} catch (_) {
					/* fall through to the solid tag below */
				}
			}
		}

		return out;
	}

	function patchTag() {
		let unpatch;
		const cancel = waitFor(findTagModule, Tag => {
			// Patching a missing `default` throws while the patch is built.
			if (typeof Tag?.default !== "function") return;
			unpatch = patcher.after("default", Tag, (args, ret) => {
				try {
					return paintTag(args?.[0], ret);
				} catch (error) {
					report("tag paint failed:", error);
					return ret;
				}
			});
		}, "tag");

		return () => {
			cancel();
			if (unpatch) unpatch();
		};
	}

	// ---------------------------------------------------------------------------------------------
	// Surface 2: message rows. Discord draws these natively from getTagProperties()'s result.
	// ---------------------------------------------------------------------------------------------

	function patchChat() {
		const unpatches = [];
		const cancel = waitFor(
			() => metro.findByName("getTagProperties", false),
			ns => {
				if (typeof ns?.default !== "function") return;
				unpatches.push(
					patcher.after("default", ns, (args, ret) => {
						try {
							const message = args?.[0]?.message;
							// A message that already carries a tag (bot, system, automod...) has a
							// non-empty tagText: leave those alone.
							if (ret?.tagText || !message?.author) return ret;

							const channel = channelStore()?.getChannel(message.channel_id);
							const guild = guildStore()?.getGuild(channel?.guild_id);
							const tag = getTag(guild, channel, message.author, !!storage.useRoleColor);
							if (!tag) return ret;

							// Native rows cannot host an icon component, so the glyph stands in for it.
							const glyph = tag.iconGlyph;
							const nativeText = glyph ? (tag.iconOnly ? glyph : glyph + " " + tag.text) : tag.text;
							const { processColor } = RN();

							return Object.assign({}, ret, {
								tagText: nativeText,
								tagTextColor: tag.textColor ? processColor(tag.textColor) : undefined,
								tagBackgroundColor: tag.backgroundColor ? processColor(tag.backgroundColor) : undefined,
								tagVerified: tag.verified,
								tagType: undefined,
							});
						} catch (error) {
							report("chat tag failed:", error);
							return ret;
						}
					}),
				);
			},
			"message row",
		);

		return () => {
			cancel();
			unpatches.reverse().forEach(unpatch => unpatch());
		};
	}

	// ---------------------------------------------------------------------------------------------
	// Surface 3: the member list (UserRow).
	// ---------------------------------------------------------------------------------------------

	/** Returns a copy of one rendered UserRow with the tag applied, or the row untouched. */
	function applyRowTag(res, props) {
		const { guildId, user } = props ?? {};
		const label = res?.props?.label;
		const nameContainer = findInReactTree(
			label,
			c =>
				Array.isArray(c?.props?.children) &&
				c.props.children.some(ch => typeof ch === "string" || typeof ch?.props?.children === "string"),
		);
		if (!nameContainer) return res;

		const existingTag = findInReactTree(nameContainer, isTagElement);
		if (existingTag && isBuiltInTag(existingTag.props.type)) return res;

		const tag = getTag(guildStore()?.getGuild(guildId), undefined, user, !!storage.useRoleColor);
		if (!tag) return res;

		let newLabel;
		if (existingTag) {
			newLabel = replaceInTree(
				label,
				c => c === existingTag,
				c => clone(c, tagProps(tag)),
			);
		} else {
			const TagModule = tagModule();
			if (typeof TagModule?.default !== "function") return res;

			const element = h(TagModule.default, Object.assign({ key: "staff-tag" }, tagProps(tag)));
			newLabel = replaceInTree(
				label,
				c => c === nameContainer,
				c => {
					const children = c.props.children;
					return clone(c, {}, [...(Array.isArray(children) ? children : [children]), element]);
				},
			);
		}

		return newLabel === label ? res : clone(res, { label: newLabel });
	}

	function patchDetails() {
		const unpatches = [];
		const patched = new Set();

		// React.memo(function UserRow(){...}) is a plain { $$typeof, type, compare } object with no
		// name of its own: the wrapped function's name is what says "UserRow".
		const isUserRow = m => {
			try {
				return typeof m?.type === "function" && m.type.name === "UserRow";
			} catch (_) {
				return false;
			}
		};

		const patchUserRow = UserRow => {
			if (typeof UserRow?.type !== "function" || patched.has(UserRow)) return;
			patched.add(UserRow);
			unpatches.push(
				patcher.after("type", UserRow, (args, res) => {
					try {
						return applyRowTag(res, args?.[0]);
					} catch (error) {
						report("member row tag failed:", error);
						return res;
					}
				}),
			);
		};

		const cancel = waitFor(
			() => {
				const all = findAllModules(isUserRow);
				return all.length ? all : undefined;
			},
			list => list.forEach(patchUserRow),
			"member list",
		);

		return () => {
			cancel();
			unpatches.forEach(unpatch => unpatch());
		};
	}

	// ---------------------------------------------------------------------------------------------
	// Surface 4: the profile header name. The module exports `default` (the whole header) and
	// `DisplayName` (name + bot tag row). The header renders DisplayName through its own scope, so
	// patching the export changes nothing: instead, after the header renders, swap the DisplayName
	// element for a wrapper that adds our tag to DisplayName's own output.
	// ---------------------------------------------------------------------------------------------

	function patchName() {
		const unpatches = [];

		/** The open channel, when it belongs to the profile's guild -- for channel-level mod roles. */
		const channelFor = guildId => {
			const channel = channelStore()?.getChannel?.(selectedChannelStore()?.getChannelId?.());
			return guildId && channel?.guild_id === guildId ? channel : undefined;
		};

		const addTag = (ret, props) => {
			const { guildId, user } = props ?? {};
			if (!user || !guildId) return ret;

			const tagComponent = findInReactTree(ret, isTagElement);
			if (tagComponent && isBuiltInTag(tagComponent.props.type)) return ret;

			const tag = getTag(guildStore()?.getGuild(guildId), channelFor(guildId), user, !!storage.useRoleColor);
			if (!tag) return ret;

			if (tagComponent) {
				return replaceInTree(
					ret,
					c => c === tagComponent,
					c => clone(c, tagProps(tag)),
				);
			}

			const TagModule = tagModule();
			if (typeof TagModule?.default !== "function") return ret;

			// Discord leaves the bot-tag slot (index 1) empty for people; use it so the tag sits right
			// after the name and before the chevron.
			const element = h(
				TagModule.default,
				Object.assign({ key: "staff-tag", style: { marginLeft: 0 } }, tagProps(tag)),
			);
			const isRow = c => Array.isArray(c?.props?.children) && c.props.children.length >= 2;
			return replaceInTree(ret, isRow, row => {
				const children = row.props.children.slice();
				if (!children[1]) children[1] = element;
				else children.splice(1, 0, element);
				return clone(row, {}, children);
			});
		};

		// One wrapper per DisplayName function, so React sees a stable component type.
		const wrappers = new WeakMap();
		const wrap = DisplayName => {
			let wrapper = wrappers.get(DisplayName);
			if (!wrapper) {
				wrapper = props => {
					const ret = DisplayName(props);
					try {
						return addTag(ret, props);
					} catch (error) {
						report("profile tag:", error);
						return ret;
					}
				};
				wrappers.set(DisplayName, wrapper);
			}
			return wrapper;
		};

		const cancel = waitFor(
			() =>
				metro.find(m => {
					try {
						return typeof m?.DisplayName === "function" && typeof m?.default === "function";
					} catch (_) {
						return false;
					}
				}),
			ns => {
				const DisplayName = ns.DisplayName;
				if (typeof ns.default !== "function" || typeof DisplayName !== "function") return;
				unpatches.push(
					patcher.after("default", ns, (_args, ret) => {
						try {
							const Wrapped = wrap(DisplayName);
							return replaceInTree(
								ret,
								c => c?.type === DisplayName,
								c => h(Wrapped, Object.assign({}, c.props, { key: c.key })),
							);
						} catch (error) {
							report("profile:", error);
							return ret;
						}
					}),
				);
			},
			"profile header",
		);

		return () => {
			cancel();
			unpatches.forEach(unpatch => unpatch());
		};
	}

	// ---------------------------------------------------------------------------------------------
	// Settings: a tag list, a per-tag editor and an icon picker. They are views inside one
	// component rather than separate routes, so no client-specific navigation is needed.
	// ---------------------------------------------------------------------------------------------

	const useStorage = () => vendetta.storage.useProxy(storage);

	/** TextInput events arrive as a string from Discord's form input and as an event elsewhere. */
	const textOf = value => (typeof value === "string" ? value : (value?.nativeEvent?.text ?? ""));

	/** Discord's FormInput when there is one, a bare TextInput otherwise. */
	function Input(props) {
		const { FormInput } = F();
		if (typeof FormInput === "function" || (FormInput && typeof FormInput === "object")) {
			return h(FormInput, {
				title: props.title,
				placeholder: props.placeholder,
				value: props.value,
				multiline: props.multiline,
				returnKeyType: "done",
				onChange: v => props.onChange(textOf(v)),
			});
		}
		const { TextInput } = RN();
		return h(TextInput, {
			placeholder: props.placeholder,
			value: props.value,
			multiline: props.multiline,
			onChangeText: v => props.onChange(textOf(v)),
		});
	}

	function Note(props) {
		const { FormText } = F();
		const { View, Text } = RN();
		return h(
			View,
			{ style: { paddingHorizontal: 16, paddingVertical: 8 } },
			h(FormText || Text, { style: props.style }, props.children),
		);
	}

	function Screen(props) {
		const { ScrollView } = RN();
		return h(
			ScrollView,
			{ style: { flex: 1 }, keyboardShouldPersistTaps: "handled", contentContainerStyle: { paddingBottom: 38 } },
			...props.children,
		);
	}

	const arrow = () => {
		const Arrow = F().FormRow?.Arrow;
		return Arrow ? h(Arrow) : undefined;
	};

	/** `#rrggbb` for anything recognisable (hex, 3-digit hex, "r, g, b"), otherwise undefined. */
	function parseColor(input) {
		const value = (input || "").trim();
		if (!value) return undefined;

		const hex = value.replace(/^#/, "");
		if (/^[0-9a-f]{6}$/i.test(hex)) return "#" + hex.toUpperCase();
		if (/^[0-9a-f]{3}$/i.test(hex))
			return (
				"#" +
				hex
					.split("")
					.map(c => c + c)
					.join("")
					.toUpperCase()
			);

		// The `rgb(` / `rgba(` prefix is optional: the field's own hint says "240, 178, 50".
		const rgb = value.match(/^(?:rgba?)?\(?\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/i);
		if (rgb) {
			const parts = [rgb[1], rgb[2], rgb[3]].map(n => parseInt(n, 10));
			if (parts.every(n => n >= 0 && n <= 255))
				return (
					"#" +
					parts
						.map(n => n.toString(16).padStart(2, "0"))
						.join("")
						.toUpperCase()
				);
		}

		return undefined;
	}

	/** A colour, typed as hex or RGB. Only writes when the value parses, so half-typed never lands. */
	function ColorInput(props) {
		const { View, Text } = RN();
		const [draft, setDraft] = R().useState(props.value || "");
		const parsed = parseColor(draft);
		const swatch = parsed || props.value || props.placeholder;

		return h(
			View,
			{ style: { paddingHorizontal: 16, paddingVertical: 8 } },
			h(
				View,
				{ style: { flexDirection: "row", alignItems: "center" } },
				h(View, { style: { width: 36, height: 36, borderRadius: 8, backgroundColor: swatch, marginRight: 12 } }),
				h(
					View,
					{ style: { flex: 1 } },
					h(Input, {
						title: props.label,
						placeholder: props.placeholder,
						value: draft,
						onChange: next => {
							setDraft(next);
							const colour = parseColor(next);
							// Empty means "back to the default", which is a valid thing to want.
							if (colour) props.onChange(colour);
							else if (!next.trim()) props.onChange("");
						},
					}),
				),
			),
			h(
				Text,
				{ style: { color: draft && !parsed ? "#ED4245" : "#80848E", fontSize: 12, marginTop: 4 } },
				draft && !parsed ? "That isn't a colour I can read" : "Hex like #F0B232, or RGB like 240, 178, 50",
			),
		);
	}

	function previewSwatch(id, defaultColor, size, iconSize) {
		const { View } = RN();
		const custom = overrideFor(id);
		const colour = custom.useCustomColor && custom.color ? custom.color : defaultColor;
		return h(
			View,
			{
				style: {
					width: size,
					height: size,
					borderRadius: 6,
					backgroundColor: colour,
					alignItems: "center",
					justifyContent: "center",
					opacity: custom.enabled === false ? 0.4 : 1,
				},
			},
			h(TagIcon, { icon: custom.icon, customSvg: custom.customSvg, color: "#FFFFFF", size: iconSize }),
		);
	}

	function describeTag(id, original) {
		const custom = overrideFor(id);
		if (custom.enabled === false) return "Hidden";
		const bits = [];
		if (custom.text?.trim() && custom.text.trim() !== original) bits.push("reads “" + custom.text.trim() + "”");
		if (custom.icon && custom.icon !== "none")
			bits.push(custom.icon === CUSTOM_ICON ? "own icon" : (iconById(custom.icon)?.name ?? "icon"));
		if (custom.useCustomColor && custom.color) bits.push(custom.color);
		if (custom.useGradient && custom.gradientColor) bits.push("gradient");
		return bits.length ? bits.join(", ") : "As it ships";
	}

	/** Every tag with what it currently looks like, each opening its own editor. */
	function TagList(props) {
		const { FormSection, FormRow, FormSwitchRow } = F();
		useStorage();

		return h(Screen, {
			children: [
				h(
					FormSection,
					{ key: "tags", title: "Tags — tap one to change it" },
					...TAGS.map(tag =>
						h(FormRow, {
							key: tag.id,
							label: tag.text,
							subLabel: describeTag(tag.id, tag.text),
							leading: previewSwatch(tag.id, tag.defaultColor, 28, 14),
							trailing: arrow(),
							onPress: () => props.open(tag.id),
						}),
					),
				),
				h(
					FormSection,
					{ key: "everywhere", title: "Everywhere" },
					h(FormSwitchRow, {
						label: "Use top role colour for tag backgrounds",
						subLabel: "A colour you set for a tag still wins over the role colour",
						value: !!storage.useRoleColor,
						onValueChange: value => {
							storage.useRoleColor = value;
						},
					}),
				),
				h(
					Note,
					{ key: "note" },
					"Icons and gradients show on profiles and member lists. Tags on message rows are drawn by Discord's native code, which takes text and one colour, so there an icon appears as its plain character.",
				),
			],
		});
	}

	/** Everything about one tag. */
	function TagEditor(props) {
		const { View, Text } = RN();
		const { FormSection, FormRow, FormSwitchRow } = F();
		useStorage();

		const id = props.id;
		const def = TAGS.find(tag => tag.id === id);
		const custom = overrideFor(id);
		const [svgDraft, setSvgDraft] = R().useState(custom.customSvg ?? "");
		const [revision, setRevision] = R().useState(0);

		if (!def) {
			return h(
				Screen,
				{ children: [h(FormRow, { key: "back", label: "← All tags", onPress: props.back }), h(Note, { key: "gone" }, "That tag no longer exists.")] },
			);
		}

		const enabled = custom.enabled !== false;
		const colour = custom.useCustomColor && custom.color ? custom.color : def.defaultColor;
		const label = custom.text?.trim() || def.text;
		const hasIcon = !!custom.icon && custom.icon !== "none";
		const svgOk = !svgDraft.trim() || isValidCustomSvg(svgDraft);

		const confirmReset = () => {
			vendetta.ui.alerts.showConfirmationAlert({
				title: "Reset " + def.text + "?",
				content: "Its text, colour and icon go back to how they ship.",
				confirmText: "Reset",
				cancelText: "Cancel",
				confirmColor: "red",
				onConfirm: () => {
					resetOverride(def.id);
					setSvgDraft("");
					setRevision(n => n + 1);
				},
			});
		};

		// What the tag will look like, built from the same pieces the real one uses.
		const chip = h(
			View,
			{
				style: {
					flexDirection: "row",
					alignItems: "center",
					paddingHorizontal: 6,
					paddingVertical: 3,
					borderRadius: 4,
					backgroundColor: colour,
				},
			},
			h(TagIcon, { icon: custom.icon, customSvg: custom.customSvg, color: "#FFFFFF" }),
			custom.iconOnly && hasIcon
				? null
				: h(Text, { style: { color: "#FFFFFF", fontSize: 10, fontWeight: "700" } }, label),
		);

		return h(Screen, {
			children: [
				h(FormRow, { key: "back", label: "← All tags", onPress: props.back }),

				h(
					FormSection,
					{ key: "preview", title: "Preview" },
					h(
						View,
						{ style: { paddingVertical: 16, alignItems: "center" } },
						chip,
						h(
							Text,
							{ style: { color: "#80848E", fontSize: 12, marginTop: 8, textAlign: "center", paddingHorizontal: 16 } },
							custom.useGradient && custom.gradientColor
								? "Gradients show on profiles and member lists; message rows use the first colour."
								: "Preview",
						),
					),
				),

				h(
					FormSection,
					{ key: "show" },
					h(FormSwitchRow, {
						label: "Show this tag",
						subLabel: enabled ? "Shown wherever it applies" : "Hidden everywhere",
						value: enabled,
						onValueChange: value => setOverride(def.id, { enabled: value }),
					}),
				),

				h(
					FormSection,
					{ key: "text", title: "Text" },
					h(Input, {
						placeholder: def.text,
						value: custom.text ?? "",
						onChange: value => setOverride(def.id, { text: value }),
					}),
					h(Note, null, "What the tag reads. Leave it empty for the original."),
				),

				h(
					FormSection,
					{ key: "icon", title: "Icon" },
					h(FormRow, {
						label: "Icon",
						subLabel: custom.icon === CUSTOM_ICON ? "Your own SVG" : (iconById(custom.icon)?.name ?? "None"),
						trailing: arrow(),
						onPress: props.openIcons,
					}),
					h(FormSwitchRow, {
						label: "Icon only",
						subLabel: "Drop the text and show just the icon",
						value: !!custom.iconOnly,
						onValueChange: value => setOverride(def.id, { iconOnly: value }),
					}),
					custom.icon === CUSTOM_ICON
						? h(
								View,
								{ key: "svg" },
								h(Input, {
									title: "Your own SVG",
									placeholder: "<svg viewBox='0 0 24 24'>…</svg>",
									value: svgDraft,
									multiline: true,
									onChange: value => {
										setSvgDraft(value);
										if (!value.trim()) setOverride(def.id, { customSvg: "" });
										else if (isValidCustomSvg(value)) setOverride(def.id, { customSvg: value });
									},
								}),
								h(
									Note,
									{ style: { color: svgOk ? "#80848E" : "#ED4245" } },
									svgOk
										? "Pasted markup, up to " + MAX_CUSTOM_SVG_LENGTH + " characters. Saved only when it parses."
										: "That is not SVG this can draw",
								),
							)
						: null,
				),

				h(
					FormSection,
					{ key: "colour", title: "Colour" },
					h(FormSwitchRow, {
						label: "Use my own colour",
						subLabel: "Off uses the tag's own " + def.defaultColor,
						value: !!custom.useCustomColor,
						onValueChange: value => setOverride(def.id, { useCustomColor: value }),
					}),
					custom.useCustomColor
						? h(ColorInput, {
								key: "bg" + revision,
								label: "Background",
								value: custom.color ?? "",
								placeholder: def.defaultColor,
								onChange: value => setOverride(def.id, { color: value }),
							})
						: null,
				),

				h(
					FormSection,
					{ key: "gradient", title: "Gradient" },
					h(FormSwitchRow, {
						label: "Fade into a second colour",
						subLabel: "Shown on profiles and member lists",
						value: !!custom.useGradient,
						onValueChange: value => setOverride(def.id, { useGradient: value }),
					}),
					custom.useGradient
						? h(ColorInput, {
								key: "grad" + revision,
								label: "Fades to",
								value: custom.gradientColor ?? "",
								placeholder: "#9B59B6",
								onChange: value => setOverride(def.id, { gradientColor: value }),
							})
						: null,
				),

				h(
					FormSection,
					{ key: "reset" },
					h(FormRow, {
						label: "Reset this tag",
						subLabel: "Back to its original text, colour and icon",
						onPress: confirmReset,
					}),
				),
			],
		});
	}

	/** One row per icon, each drawn in the tag's own colour so the choice is the preview. */
	function IconPicker(props) {
		const { View } = RN();
		const { FormSection, FormRow } = F();
		useStorage();

		const id = props.id;
		const def = TAGS.find(tag => tag.id === id);
		const custom = overrideFor(id);
		const colour = custom.useCustomColor && custom.color ? custom.color : (def?.defaultColor ?? "#5865F2");

		const choose = iconId => {
			setOverride(id, { icon: iconId });
			props.back();
		};

		const swatch = iconId =>
			h(
				View,
				{
					style: {
						width: 28,
						height: 28,
						borderRadius: 6,
						backgroundColor: colour,
						alignItems: "center",
						justifyContent: "center",
					},
				},
				h(TagIcon, { icon: iconId, customSvg: custom.customSvg, color: "#FFFFFF", size: 16 }),
			);

		return h(Screen, {
			children: [
				h(FormRow, { key: "back", label: "← Back to the tag", onPress: props.back }),
				h(
					FormSection,
					{ key: "icons", title: "Icons" },
					...ICONS.map(icon =>
						h(FormRow, {
							key: icon.id,
							label: icon.name,
							subLabel: (custom.icon || "none") === icon.id ? "Selected" : undefined,
							leading: icon.id === "none" ? undefined : swatch(icon.id),
							onPress: () => choose(icon.id),
						}),
					),
				),
				h(
					FormSection,
					{ key: "own", title: "Your own" },
					h(FormRow, {
						label: "Custom SVG",
						subLabel:
							custom.icon === CUSTOM_ICON
								? "Selected — paste the markup on the tag page"
								: "Paste your own markup on the tag page",
						leading: custom.customSvg ? swatch(CUSTOM_ICON) : undefined,
						onPress: () => choose(CUSTOM_ICON),
					}),
				),
				h(
					Note,
					{ key: "note" },
					"Icons show on profiles and member lists. Message rows are drawn by Discord's native code, which takes text only, so there the icon appears as its plain character.",
				),
			],
		});
	}

	function Settings() {
		const [nav, setNav] = R().useState({ view: "list", id: "" });
		useStorage();

		if (nav.view === "edit") {
			return h(TagEditor, {
				key: nav.id,
				id: nav.id,
				back: () => setNav({ view: "list", id: "" }),
				openIcons: () => setNav({ view: "icons", id: nav.id }),
			});
		}
		if (nav.view === "icons") {
			return h(IconPicker, { id: nav.id, back: () => setNav({ view: "edit", id: nav.id }) });
		}
		return h(TagList, { open: id => setNav({ view: "edit", id: id }) });
	}

	// ---------------------------------------------------------------------------------------------
	// Plugin lifecycle
	// ---------------------------------------------------------------------------------------------

	let cleanups = [];

	return {
		onLoad() {
			ensureStorage();

			// Apply each surface independently: a single moved Discord module must disable one
			// surface, not make the whole plugin impossible to enable.
			const apply = (name, patch) => {
				try {
					cleanups.push(patch());
				} catch (error) {
					report("failed to apply " + name + " patch:", error);
				}
			};

			apply("tag", patchTag);
			apply("chat", patchChat);
			apply("details", patchDetails);
			apply("name", patchName);
		},

		onUnload() {
			for (const cleanup of cleanups.reverse()) {
				try {
					cleanup();
				} catch (error) {
					report("cleanup failed:", error);
				}
			}
			cleanups = [];
		},

		settings: Settings,
	};
})()
