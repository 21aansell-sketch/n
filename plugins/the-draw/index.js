(function () {
	"use strict";

	const { metro, patcher, ui, plugin, logger } = vendetta;
	const storage = plugin.storage;
	const { useProxy } = vendetta.storage;
	const { findByProps, findByName, findByStoreName, find } = metro;
	const { React, ReactNative: RN } = metro.common;
	const { Fragment, memo, useEffect, useMemo, useReducer, useRef, useState } = React;
	const h = React.createElement;
	const startTransition = React.startTransition || (fn => fn());
	const {
		Animated, Pressable, Text, TextInput, View, Image, ScrollView, FlatList,
		Platform, Dimensions, AppState, StyleSheet, LayoutAnimation, AccessibilityInfo,
	} = RN;

	// ---------------------------------------------------------------- basics

	const DEFAULTS = { dmOrder: [], layout: "grid", pullToMarkRead: false };
	function ensureDefaults() {
		for (const key in DEFAULTS)
			if (storage[key] === undefined)
				storage[key] = Array.isArray(DEFAULTS[key]) ? [] : DEFAULTS[key];
	}

	const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
	const need = (value, what) => {
		if (!value) throw new Error("Server Drawer: " + what + " is unavailable");
		return value;
	};
	const byComponent = name => m => {
		const d = m && m.default;
		return !!d && (d.name === name || (d.type && (d.type.name === name || (d.type.type && d.type.type.name === name))));
	};

	function reportError(error) {
		try { logger.error("[Server Drawer]", error); } catch (e) {}
	}
	function reportActionFailure(operation, error) {
		reportError(error);
		try {
			ui.toasts.showToast("Could not " + operation + ". Please try again.");
		} catch (e) {}
	}

	let reducedMotion = false;
	try {
		AccessibilityInfo.isReduceMotionEnabled().then(v => { reducedMotion = !!v; });
		AccessibilityInfo.addEventListener("reduceMotionChanged", v => { reducedMotion = !!v; });
	} catch (e) {}

	// ------------------------------------------------------------------ data

	const DOCK_PADDING = 40;
	const DOCK_ITEM_GAP = 10;
	const DOCK_REST_OFFSET = 6;

	function computeGuildDockSpecs(availableWidth) {
		const dockWidth = Math.max(
			80,
			Math.min(454, (Number.isFinite(availableWidth) ? Math.max(0, availableWidth) : 0) - 16),
		);
		const scaleFor = count => (dockWidth - DOCK_ITEM_GAP * (count - 1) - DOCK_PADDING) / (48 * count);
		const itemCount = [6, 7].reduce(
			(best, count) => (Math.abs(1 - scaleFor(count)) < Math.abs(1 - scaleFor(best)) ? count : best),
			5,
		);
		const itemSize = Math.max(1, Math.round(48 * scaleFor(itemCount)));
		return { dockHeight: itemSize + 32, dockWidth, itemCountNoExtras: itemCount - 2, itemSize };
	}

	function orderedDms(items, order) {
		const remaining = new Map(items.map(item => [item.id, item]));
		return [...(Array.isArray(order) ? order : []), ...remaining.keys()].flatMap(id => {
			const item = remaining.get(id);
			remaining.delete(id);
			return item ? [item] : [];
		});
	}

	function filteredItems(items, filter, query) {
		const search = query.trim().toLocaleLowerCase();
		if (!search && filter === "all") return items;
		const matches = item =>
			(!search || item.name.toLocaleLowerCase().includes(search)) && (filter === "all" || item.unread);
		return items.flatMap(item => {
			if (item.kind !== "folder") return matches(item) ? [item] : [];
			const children = item.children.filter(matches);
			return search ? children : children.length ? [{ ...item, children }] : [];
		});
	}

	function moveToSlot(moveBefore, siblings, source, target) {
		const from = siblings.indexOf(source);
		const forward = from >= 0 && from < siblings.indexOf(target);
		moveBefore(source, target);
		if (forward) moveBefore(target, source);
	}

	const initials = name =>
		name.trim().split(/\s+/u).slice(0, 2).map(piece => piece[0]).join("").toUpperCase() || "?";

	function hitsDropTarget(point, bounds) {
		if (
			!bounds ||
			![point.x, point.y, bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
			bounds.width <= 0 ||
			bounds.height <= 0
		)
			return false;
		return (
			point.x >= bounds.x - 8 &&
			point.x <= bounds.x + bounds.width + 8 &&
			point.y >= bounds.y - 8 &&
			point.y <= bounds.y + bounds.height + 8
		);
	}

	// ---------------------------------------------------------------- native

	const semanticColors = ui.semanticColors || {};
	const rawColors = ui.rawColors || {};
	const WHITE = rawColors.WHITE || "#ffffff";
	const BLACK = rawColors.BLACK || "#000000";
	const BRAND = rawColors.BRAND_500 || "#5865f2";
	const useToken = (findByProps("useToken") || {}).useToken;

	const COLOR_DEFS = {
		danger: ["STATUS_DANGER", "#da373c"],
		base: ["BACKGROUND_BASE_LOWEST", "#111214"],
		text: ["TEXT_DEFAULT", "#f2f3f5"],
		muted: ["TEXT_MUTED", "#80848e"],
		border: ["BORDER_SUBTLE", "#3f4147"],
		alt: ["BACKGROUND_SECONDARY_ALT", "#232428"],
		brand: ["TEXT_BRAND", "#a5b4fc"],
		lower: ["BACKGROUND_BASE_LOWER", "#1a1b1e"],
		folder: ["GUILD_FOLDER_BACKGROUND", "#2b2d31"],
	};
	const COLOR_KEYS = Object.keys(COLOR_DEFS);
	const CAN_TOKEN = {};
	for (const key of COLOR_KEYS) CAN_TOKEN[key] = !!useToken && !!semanticColors[COLOR_DEFS[key][0]];

	function useColors() {
		const out = {};
		for (const key of COLOR_KEYS) {
			const [semantic, fallback] = COLOR_DEFS[key];
			let value = fallback;
			if (CAN_TOKEN[key]) {
				const token = useToken(semanticColors[semantic]);
				if (typeof token === "string") value = token;
			}
			out[key] = value;
		}
		return out;
	}

	const BORDER_WIDTH = 1;
	const ICON_SIZE = 52;
	const ITEM_WIDTH = ICON_SIZE + 12;
	const ITEM_GAP = 12;
	const SIDE_PADDING = 16;
	const LONG_PRESS_MS = 500;
	const FLOATING_YOU_BAR = Platform.OS === "ios";
	const YOU_BAR_JOIN_DEPTH = FLOATING_YOU_BAR ? 0 : 24;
	const CENTER = { alignItems: "center", justifyContent: "center" };
	const ROW = { alignItems: "center", flexDirection: "row" };
	const FILL = { bottom: 0, left: 0, position: "absolute", right: 0, top: 0 };

	const FLOATING_PANEL_STYLE = FLOATING_YOU_BAR
		? {
				borderBottomLeftRadius: 24,
				borderBottomRightRadius: 24,
				borderBottomWidth: BORDER_WIDTH,
				boxShadow: "0px -6px 24px rgba(0, 0, 0, 0.28)",
			}
		: undefined;
	const FLOATING_FOLDER_STYLE = FLOATING_YOU_BAR
		? { boxShadow: "0px 12px 32px rgba(0, 0, 0, 0.4)" }
		: undefined;

	const EMPTY_SNAPSHOT = Object.freeze({ nodes: [], directMessages: [] });
	const STORE_NAMES = [
		"ChannelStore", "GuildReadStateStore", "GuildStore", "PrivateChannelSortStore",
		"ReadStateStore", "SelectedChannelStore", "SelectedGuildStore", "SortedGuildStore", "UserStore",
	];

	function makeStyles(c) {
		return {
			c,
			mentionBadge: {
				...CENTER,
				backgroundColor: c.danger,
				borderColor: c.base,
				borderRadius: 10,
				borderWidth: 2,
				paddingHorizontal: 4,
				position: "absolute",
			},
			unreadBadge: { backgroundColor: c.text, borderColor: c.base, borderRadius: 7, borderWidth: 2, position: "absolute" },
			compactSelection: { borderColor: c.muted, borderWidth: 3, bottom: -3, left: -3, position: "absolute", right: -3, top: -3 },
			listItem: { alignItems: "center", borderRadius: 12, flexDirection: "row", gap: 14, minHeight: 68, paddingHorizontal: 10, width: "100%" },
			gridItem: { alignItems: "center", minHeight: 82, width: ITEM_WIDTH },
			selectionRing: { ...CENTER, borderWidth: 3, height: 62, width: 62 },
			gridLabel: { marginTop: 4, textAlign: "center", width: 68 },
			previewFrame: {
				alignItems: "center",
				backgroundColor: c.alt,
				borderColor: c.border,
				borderWidth: 1,
				elevation: 18,
				shadowColor: BLACK,
				shadowOffset: { height: 8, width: 0 },
				shadowRadius: 12,
			},
			listPreview: { borderRadius: 14, flexDirection: "row", gap: 14, height: 68, paddingHorizontal: 10, shadowOpacity: 0.35 },
			gridPreview: { borderRadius: 20, minHeight: 82, paddingTop: 5, shadowOpacity: 0.4, width: ITEM_WIDTH },
			folderInput: { color: c.text, fontSize: 20, padding: 4, borderBottomWidth: 1, borderColor: c.brand },
			dmButton: { ...CENTER, backgroundColor: c.alt, borderRadius: 16 },
			dockDivider: { alignSelf: "center", backgroundColor: c.border, marginHorizontal: -5.5, width: 1 },
			dockRow: { ...ROW, gap: DOCK_ITEM_GAP, paddingHorizontal: DOCK_PADDING / 2 },
			emptyContainer: { ...CENTER, minHeight: 180, padding: 24 },
			header: { ...ROW, minHeight: 50, paddingHorizontal: 12 },
			searchRow: { gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
			searchInput: { backgroundColor: c.alt, borderRadius: 10, color: c.text, fontSize: 15, paddingHorizontal: 12, paddingVertical: 9 },
			viewTabs: { ...ROW, flex: 1 },
			viewTab: { ...CENTER, borderBottomWidth: 2, borderColor: "transparent", flex: 1, height: 44 },
			viewTabOn: { borderColor: c.brand },
			filterTabs: { ...ROW, backgroundColor: c.alt, borderRadius: 10, padding: 2 },
			filterTab: { ...CENTER, borderRadius: 8, flex: 1, paddingVertical: 6 },
			filterTabOn: { backgroundColor: c.border },
			handle: { ...CENTER, height: 16, width: "100%" },
			handleBar: { backgroundColor: c.muted, borderRadius: 3, height: 5, opacity: 0.5, width: 38 },
			exitTarget: { ...CENTER, width: 56, height: 56, position: "absolute", zIndex: 110, elevation: 65 },
			folderBackdrop: { ...FILL, alignItems: "center", justifyContent: "center", zIndex: 60 },
			folderPanel: { alignItems: "center", backgroundColor: c.alt, borderRadius: 40, elevation: 45, overflow: "hidden" },
			folderPage: { alignContent: "flex-start", ...ROW, flexWrap: "wrap", gap: 8, paddingBottom: 28, paddingHorizontal: 10, paddingTop: 52 },
			folderHeading: { position: "absolute", top: 8, left: 20, right: 20 },
			pageDots: { alignItems: "center", bottom: 8, flexDirection: "row", gap: 5, justifyContent: "center", position: "absolute" },
			pageDot: { borderRadius: 3, height: 7, marginHorizontal: 4, marginVertical: 10, width: 7 },
			dragPreview: { elevation: 60, position: "absolute", top: 0, zIndex: 100 },
			drawerBackdrop: { ...FILL, zIndex: 0 },
			drawerPanel: {
				backgroundColor: c.base,
				borderColor: c.border,
				borderTopLeftRadius: 24,
				borderTopRightRadius: 24,
				borderWidth: BORDER_WIDTH,
				borderBottomWidth: 0,
				elevation: 0,
				overflow: "hidden",
				position: "absolute",
				zIndex: 0,
			},
			compactFace: { backgroundColor: c.base, position: "absolute", top: 16, left: 0, right: 0, zIndex: 2 },
			expandedFace: { backgroundColor: c.base, position: "absolute", left: 0, right: 0, top: 16, zIndex: 1 },
			menuBackdrop: { ...FILL, backgroundColor: "rgba(0, 0, 0, 0.6)", justifyContent: "flex-end", zIndex: 150, elevation: 80 },
			menuPanel: { backgroundColor: c.alt, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 24, paddingTop: 8 },
			menuTitle: { color: c.muted, fontSize: 13, fontWeight: "700", paddingHorizontal: 20, paddingVertical: 10 },
			menuRow: { justifyContent: "center", minHeight: 48, paddingHorizontal: 20 },
		};
	}

	function useStyles() {
		const colors = useColors();
		const key = COLOR_KEYS.map(k => colors[k]).join("|");
		return useMemo(() => makeStyles(colors), [key]);
	}

	// ------------------------------------------------------------ controller

	function createController() {
		const stores = {};
		for (const name of STORE_NAMES) stores[name] = need(findByStoreName(name), name);
		const {
			ChannelStore, GuildReadStateStore, GuildStore, PrivateChannelSortStore,
			ReadStateStore, SelectedChannelStore, SelectedGuildStore, SortedGuildStore, UserStore,
		} = stores;

		const iconUtils = need(findByProps("getGuildIconURL", "getChannelIconURL"), "icon utilities");
		const actions = need(findByProps("moveById", "createGuildFolderLocal", "editGuildFolderLocal"), "folder actions");
		const folderSettings = need(findByProps("saveGuildFolders"), "folder sync");
		const channelNavigation = need(findByProps("transitionToChannel"), "channel navigation");
		const guildBarNavigation =
			(findByProps("transitionGuildsBarToGuildOrOpenSelectedChannel") || {}).transitionGuildsBarToGuildOrOpenSelectedChannel ||
			findByName("transitionGuildsBarToGuildOrOpenSelectedChannel", false) ||
			(findByProps("transitionToGuild") || {}).transitionToGuild;
		need(typeof guildBarNavigation === "function" && guildBarNavigation, "guild navigation");

		const persistFolders = async () => {
			try {
				await folderSettings.saveGuildFolders(
					SortedGuildStore.getGuildFolders().map(entry => ({ ...entry, guildIds: [...entry.guildIds] })),
				);
			} catch (error) {
				reportActionFailure("sync folder changes to your account", error);
			}
		};
		const mutate = action => {
			action();
			persistFolders();
		};
		const folder = id => SortedGuildStore.getGuildFolderById(Number(id));
		const editFolder = (current, guildIds = current.guildIds, name = current.folderName) =>
			mutate(() => actions.editGuildFolderLocal(current.folderId, guildIds, name));
		const guildExists = id => !!GuildStore.getGuild(id);
		const badge = (store, id) => ({ mentionCount: store.getMentionCount(id), unread: store.hasUnread(id) });

		const guildNode = (id, folderId) => {
			const guild = GuildStore.getGuild(id);
			if (!guild || !guild.name || !guild.name.trim()) return [];
			const state = badge(GuildReadStateStore, id);
			return [
				{
					id,
					kind: "guild",
					name: guild.name,
					folderId,
					avatarUri: guild.icon
						? iconUtils.getGuildIconURL({ id, icon: guild.icon, size: 128, canAnimate: false })
						: undefined,
					animatedAvatarUri:
						guild.icon && guild.icon.startsWith("a_")
							? iconUtils.getGuildIconURL({ id, icon: guild.icon, size: 128, canAnimate: true })
							: undefined,
					...state,
					unread: state.unread || state.mentionCount > 0,
				},
			];
		};

		const privateChannel = id => {
			const channel = ChannelStore.getChannel(id);
			return !channel || (channel.type !== 1 && channel.type !== 3) ? undefined : channel;
		};

		const userKey = id => {
			const user = UserStore.getUser(id);
			return user ? id + "." + (user.avatar || "") + "." + (user.globalName || user.username) : id;
		};
		const guildKey = id => {
			const guild = GuildStore.getGuild(id);
			if (!guild || !guild.name || !guild.name.trim()) return "";
			const state = badge(GuildReadStateStore, id);
			return id + "." + guild.name + "." + (guild.icon || "") + "." + state.mentionCount + "." + (state.unread ? 1 : 0);
		};
		const snapshotKey = () =>
			[
				SelectedGuildStore.getGuildId() || "",
				SelectedChannelStore.getChannelId() || "",
				...SortedGuildStore.getGuildFolders().map(
					f => (f.folderId == null ? "" : f.folderId) + "." + (f.folderName || "") + "." + (f.folderColor == null ? "" : f.folderColor) + "." + f.guildIds.map(guildKey).join(","),
				),
				...PrivateChannelSortStore.getPrivateChannelIds().map(id => {
					const channel = privateChannel(id);
					if (!channel) return "";
					const state = badge(ReadStateStore, id);
					return id + "." + (channel.name || "") + "." + (channel.icon || "") + "." + (channel.recipients || []).map(userKey).join(",") + "." + state.mentionCount + "." + (state.unread ? 1 : 0);
				}),
			].join("\u0000");

		const buildSnapshot = () => {
			const nodes = SortedGuildStore.getGuildFolders().flatMap(f => {
				const id = f.folderId == null ? undefined : String(f.folderId);
				const children = f.guildIds.flatMap(guild => guildNode(guild, id));
				if (id === undefined) return children;
				return [
					{
						id,
						kind: "folder",
						children,
						name: (f.folderName && f.folderName.trim()) || undefined,
						color: f.folderColor,
						mentionCount: children.reduce((total, guild) => total + guild.mentionCount, 0),
						unread: children.some(guild => guild.unread),
					},
				];
			});
			const directMessages = PrivateChannelSortStore.getPrivateChannelIds().flatMap(id => {
				const channel = privateChannel(id);
				if (!channel) return [];
				const users = (channel.recipients || []).map(r => UserStore.getUser(r)).filter(u => u !== undefined);
				const avatarUri =
					channel.type === 1
						? users[0] && users[0].getAvatarURL ? users[0].getAvatarURL(undefined, 128, false) : undefined
						: channel.icon
							? iconUtils.getChannelIconURL({ id, icon: channel.icon, size: 128 })
							: undefined;
				const animatedAvatarUri =
					channel.type === 1 && users[0] && users[0].avatar && users[0].avatar.startsWith("a_")
						? users[0].getAvatarURL(undefined, 128, true)
						: undefined;
				return [
					{
						id,
						avatarUri,
						animatedAvatarUri,
						...badge(ReadStateStore, id),
						name: channel.name || users.map(u => u.globalName || u.username).join(", ") || "Direct Message",
					},
				];
			});
			return {
				nodes,
				directMessages,
				selectedGuildId: SelectedGuildStore.getGuildId(),
				selectedPrivateChannelId: SelectedChannelStore.getChannelId(),
			};
		};

		let cached;
		let cachedKey;

		const guildMenuItems =
			(findByProps("getGuildsBarGuildMenuItems") || {}).getGuildsBarGuildMenuItems ||
			findByName("getGuildsBarGuildMenuItems", false);
		const folderMenuItems = (findByProps("getGuildFolderMenuItems") || {}).getGuildFolderMenuItems;

		return {
			stores,
			menuItems(item) {
				const fn = item.kind === "folder" ? folderMenuItems : guildMenuItems;
				if (typeof fn !== "function") return [];
				return fn(item.kind === "folder" ? Number(item.id) : item.id) || [];
			},

			markAllRead() {
				const markGuildsAsRead =
					(findByProps("markGuildsAsRead") || {}).markGuildsAsRead || findByName("markGuildsAsRead", false);
				const readActions = findByProps("bulkAck", "ackChannel");
				const ReadStateTypes = (findByProps("ReadStateTypes") || {}).ReadStateTypes;
				if (
					typeof markGuildsAsRead !== "function" ||
					!readActions ||
					typeof readActions.bulkAck !== "function" ||
					!ReadStateTypes ||
					typeof ReadStateTypes.CHANNEL !== "number" ||
					typeof ReadStateStore.lastMessageId !== "function"
				)
					throw new Error("Server Drawer: native mark read actions are unavailable");
				const channels = PrivateChannelSortStore.getPrivateChannelIds().map(channelId => ({
					channelId,
					readStateType: ReadStateTypes.CHANNEL,
					messageId: ReadStateStore.lastMessageId(channelId),
				}));
				markGuildsAsRead(SortedGuildStore.getGuildFolders().flatMap(f => f.guildIds), "ServerDrawer");
				if (channels.length) readActions.bulkAck(channels);
			},

			snapshot() {
				const key = snapshotKey();
				if (cached && key === cachedKey) return cached;
				cachedKey = key;
				return (cached = buildSnapshot());
			},

			selectGuild: id => (guildExists(id) ? guildBarNavigation(id) : false),
			selectPrivateChannel: id =>
				ChannelStore.getChannel(id) ? channelNavigation.transitionToChannel(id, {}) : false,

			commitDrop(sourceId, targetId, mode) {
				const target = folder(targetId);
				if (mode === "exit")
					return (
						!!target &&
						target.guildIds.includes(sourceId) &&
						editFolder(target, target.guildIds.filter(id => id !== sourceId))
					);
				const source = mode === "move" ? folder(sourceId) : undefined;
				if (sourceId === targetId || (!source && !guildExists(sourceId)) || (!target && !guildExists(targetId)))
					return false;

				if (mode === "move")
					return mutate(() => {
						const folders = SortedGuildStore.getGuildFolders();
						const found = folders.find(e => e.folderId !== undefined && e.guildIds.includes(sourceId));
						const siblings = found ? found.guildIds : folders.map(e => (e.folderId == null ? e.guildIds[0] : e.folderId));
						moveToSlot(
							(from, to) => actions.moveById(from, to),
							siblings,
							source ? source.folderId : sourceId,
							target ? target.folderId : targetId,
						);
					});
				return target
					? !target.guildIds.includes(sourceId) && editFolder(target, [...target.guildIds, sourceId])
					: mutate(() => actions.createGuildFolderLocal([targetId, sourceId], undefined));
			},

			renameFolder(id, name) {
				const current = folder(id);
				return !!current && editFolder(current, undefined, name.trim());
			},

			openCreateGuild() {
				const modal = findByProps("openCreateGuildModal");
				if (!modal) throw new Error("Server Drawer: create server action is unavailable");
				modal.openCreateGuildModal();
			},

			openCreateDm() {
				const navigation = findByProps("getRootNavigationRef");
				const navigator = navigation && navigation.getRootNavigationRef() && navigation.getRootNavigationRef().current;
				return navigator
					? navigator.navigate("friends", { screen: "new-message", params: { sourcePage: "NEW_MESSAGE_COMPOSER" } })
					: false;
			},

			animateNext: duration =>
				LayoutAnimation.configureNext({
					duration: duration || 110,
					update: { type: LayoutAnimation.Types.easeInEaseOut },
				}),
		};
	}

	// ---------------------------------------------------------------- motion

	function createMotion(Gesture) {
		const panels = findByProps("DEFAULT_PANELS_ANIMATION_CONFIG", "ANDROID_PANELS_ANIMATION_CONFIG");
		const native = panels
			? Platform.OS === "android" ? panels.ANDROID_PANELS_ANIMATION_CONFIG : panels.DEFAULT_PANELS_ANIMATION_CONFIG
			: undefined;
		const config = native || {
			nonSwipeSidePanelOpen: { duration: 250 },
			nonSwipeSidePanelClose: { duration: 200 },
			touchSlopForPanGesture: 10,
			minFlingVelocityX: 500,
		};
		const isTimingConfig = (panels && panels.isTimingConfig) || (c => c && typeof c.duration === "number");
		const subtleSpring = (findByProps("SUBTLE_SPRING", "springStandard") || {}).SUBTLE_SPRING || { mass: 1, stiffness: 300, damping: 30 };
		const timings = findByProps("timingStandard", "timingFast");
		const timingStandard = (timings && timings.timingStandard) || { duration: 300 };
		if (typeof Gesture.Pan !== "function") throw new Error("Server Drawer: native gestures are unavailable");

		const animate = (value, next, open, complete) => {
			const animation = open ? config.nonSwipeSidePanelOpen : config.nonSwipeSidePanelClose;
			if (reducedMotion) {
				value.stopAnimation();
				value.setValue(next);
				if (complete) complete({ finished: true });
				return;
			}
			if (isTimingConfig(animation)) {
				const easing = animation.easing && typeof animation.easing === "object" && animation.easing.factory
					? animation.easing.factory()
					: animation.easing;
				Animated.timing(value, { ...animation, easing, toValue: next, useNativeDriver: true }).start(complete);
			} else {
				Animated.spring(value, { ...animation, toValue: next, useNativeDriver: true }).start(complete);
			}
		};

		const spring = (value, next, velocity = 0) => {
			value.stopAnimation();
			if (reducedMotion) value.setValue(next);
			else Animated.spring(value, { ...subtleSpring, velocity, toValue: next, useNativeDriver: true }).start();
		};

		function useTranslation(next) {
			const [translate] = useState(() => new Animated.Value(next));
			const position = useRef(next);
			const target = useRef(next);
			const settle = (value, velocity = 0) => {
				target.current = value;
				spring(translate, value, velocity);
			};
			useEffect(() => {
				const listener = translate.addListener(({ value }) => { position.current = value; });
				return () => {
					translate.stopAnimation();
					translate.removeListener(listener);
				};
			}, [translate]);
			useEffect(() => {
				if (target.current !== next) settle(next);
			}, [next]);
			return { translate, position, target, settle };
		}

		function useDrawerMotion(expanded, minimum, maximum, listAtTop, dragging, onOpen, onMarkRead) {
			const distance = maximum - minimum;
			const { translate, position, target, settle } = useTranslation(expanded ? 0 : distance);
			const origin = useRef(0);
			const callback = useRef(onOpen);
			callback.current = onOpen;
			const markRead = useRef(onMarkRead);
			markRead.current = onMarkRead;
			const canPull = !expanded && !!onMarkRead;
			const flattenDistance = Math.max(1, minimum - 8);
			const slop = config.touchSlopForPanGesture;

			const gestures = useMemo(() => {
				const configure = () => {
					let active = false;
					let pulling;
					const pan = Gesture.Pan()
						.runOnJS(true)
						.shouldCancelWhenOutside(false)
						.enabled(!dragging && (!expanded || listAtTop))
						.activeOffsetY(canPull ? [-slop, slop] : expanded ? slop : -slop);
					if (!canPull) pan.failOffsetY(expanded ? -slop : slop);
					return pan
						.failOffsetX([-slop, slop])
						.onStart(event => {
							active = true;
							pulling = canPull ? undefined : false;
							translate.stopAnimation();
							origin.current = Math.max(0, Math.min(distance, position.current)) - event.translationY;
						})
						.onUpdate(event => {
							if (pulling === undefined && event.translationY !== 0) pulling = event.translationY > 0;
							position.current = pulling
								? distance + Math.min(flattenDistance, Math.max(0, event.translationY) * 0.75)
								: Math.max(0, Math.min(distance, origin.current + event.translationY));
							translate.setValue(position.current);
						})
						.onEnd((event, success) => {
							if (!success) return;
							if (pulling) {
								const complete = position.current >= distance + flattenDistance;
								settle(distance);
								if (complete && markRead.current) markRead.current();
								return;
							}
							const fling = Math.abs(event.velocityY) > config.minFlingVelocityX;
							const open = fling ? event.velocityY < 0 : position.current < distance / 2;
							settle(open ? 0 : distance, event.velocityY);
							callback.current(open);
						})
						.onFinalize((_event, success) => {
							if (active && !success) settle(target.current);
							active = false;
						});
				};
				return { gesture: configure(), overlayGesture: configure() };
			}, [expanded, distance, listAtTop, dragging, canPull, flattenDistance]);

			return {
				...gestures,
				panelStyle: { transform: [{ translateY: translate }] },
				compactStyle: { opacity: translate.interpolate({ inputRange: [0, distance], outputRange: [0, 1], extrapolate: "clamp" }) },
				expandedStyle: { opacity: translate.interpolate({ inputRange: [0, distance], outputRange: [1, 0], extrapolate: "clamp" }) },
			};
		}

		function usePageMotion(view, width, enabled, onView) {
			const { translate, position, settle } = useTranslation(view === "servers" ? 0 : -width);
			const callback = useRef(onView);
			callback.current = onView;
			const gesture = useMemo(() => {
				let active = false;
				let origin = 0;
				const finish = (next, velocity = 0) => {
					settle(next, velocity);
					callback.current(next === 0 ? "servers" : "dms");
				};
				const slop = config.touchSlopForPanGesture;
				return Gesture.Pan()
					.runOnJS(true)
					.shouldCancelWhenOutside(false)
					.enabled(enabled)
					.activeOffsetX([-slop, slop])
					.failOffsetY([-slop, slop])
					.onStart(event => {
						active = true;
						translate.stopAnimation();
						origin = Math.max(-width, Math.min(0, position.current)) - event.translationX;
					})
					.onUpdate(event => {
						position.current = Math.max(-width, Math.min(0, origin + event.translationX));
						translate.setValue(position.current);
					})
					.onEnd((event, success) => {
						if (!success) return;
						const dms = Math.abs(event.velocityX) > config.minFlingVelocityX
							? event.velocityX < 0
							: position.current <= -width / 2;
						finish(dms ? -width : 0, event.velocityX);
					})
					.onFinalize((_event, success) => {
						if (active && !success) finish(position.current <= -width / 2 ? -width : 0);
						active = false;
					});
			}, [enabled, width]);
			return { gesture, style: { transform: [{ translateX: translate }] } };
		}

		function useFolderPageMotion(folderId) {
			const [progress] = useState(() => new Animated.Value(folderId ? 1 : 0));
			const previous = useRef(folderId);
			useEffect(() => {
				if (previous.current === folderId) return;
				previous.current = folderId;
				spring(progress, folderId ? 1 : 0);
				return () => progress.stopAnimation();
			}, [folderId]);
			const interpolate = outputRange =>
				progress.interpolate({ inputRange: [0, 1], outputRange, extrapolate: "clamp" });
			return {
				rootStyle: { opacity: interpolate([1, 0]), transform: [{ translateY: interpolate([0, -24]) }] },
				folderStyle: { opacity: interpolate([0, 1]), transform: [{ translateY: interpolate([24, 0]) }] },
			};
		}

		function useFolderOverlayMotion(folderId) {
			const [retainedId, setRetainedId] = useState(folderId);
			const [progress] = useState(() => new Animated.Value(0));
			useEffect(() => {
				let cancelled = false;
				if (folderId) setRetainedId(folderId);
				animate(progress, folderId ? 1 : 0, !!folderId, ({ finished }) => {
					if (finished && !cancelled && !folderId) setRetainedId(undefined);
				});
				return () => {
					cancelled = true;
					progress.stopAnimation();
				};
			}, [folderId]);
			return {
				folderId: folderId || retainedId,
				backdropStyle: { opacity: progress },
				panelStyle: {
					transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [24, 0], extrapolate: "clamp" }) }],
				},
			};
		}

		return {
			touchSlop: config.touchSlopForPanGesture,
			AnimatedView: Animated.View,
			AnimatedPressable: Animated.createAnimatedComponent(Pressable),
			useDrawerMotion,
			usePageMotion,
			useFolderPageMotion,
			useFolderOverlayMotion,
			timingStandard,
		};
	}

	function createDragMotion(Gesture, GestureDetector, timingStandard) {
		function usePreview(width, grid) {
			const [x] = useState(() => new Animated.Value(0));
			const [y] = useState(() => new Animated.Value(0));
			const [scale] = useState(() => new Animated.Value(1));
			const style = useMemo(
				() => ({
					transform: [
						{ translateX: grid ? Animated.subtract(x, width / 2) : 0 },
						{ translateY: Animated.subtract(y, grid ? 48 : 41) },
						{ scale },
					],
				}),
				[x, y, scale, width, grid],
			);
			useEffect(() => () => scale.stopAnimation(), [scale]);
			return { x, y, scale, style };
		}

		function DragTarget(properties) {
			const callbacks = useRef(properties);
			callbacks.current = properties;
			const { x, y, scale } = properties.preview;
			const position = useRef(null);
			if (properties.offset && !position.current) position.current = new Animated.ValueXY();
			const offset = position.current;
			const style = useMemo(() => (offset ? { transform: offset.getTranslateTransform() } : undefined), [offset]);
			const previousOffset = useRef(properties.offset);

			useEffect(() => {
				const prev = previousOffset.current;
				const next = properties.offset;
				if ((prev && prev.x) === (next && next.x) && (prev && prev.y) === (next && next.y)) return;
				previousOffset.current = next;
				if (!offset) return;
				const animation = Animated.timing(offset, {
					duration: (timingStandard && timingStandard.duration) || 300,
					toValue: next || { x: 0, y: 0 },
					useNativeDriver: true,
				});
				animation.start();
				return () => animation.stop();
			}, [offset, properties.offset && properties.offset.x, properties.offset && properties.offset.y]);

			const gesture = useMemo(
				() =>
					Gesture.Pan()
						.runOnJS(true)
						.activateAfterLongPress(LONG_PRESS_MS)
						.shouldCancelWhenOutside(false)
						.onStart(event => {
							x.setValue(event.absoluteX);
							y.setValue(event.absoluteY);
							scale.stopAnimation();
							Animated.timing(scale, { ...timingStandard, toValue: 1.05, useNativeDriver: true }).start();
							callbacks.current.onStart({ x: event.absoluteX, y: event.absoluteY });
						})
						.onUpdate(event => {
							x.setValue(event.absoluteX);
							y.setValue(event.absoluteY);
							callbacks.current.onMove({ x: event.absoluteX, y: event.absoluteY });
						})
						.onEnd((event, success) => {
							if (success) callbacks.current.onDrop({ x: event.absoluteX, y: event.absoluteY });
						})
						.onFinalize((_event, success) => {
							scale.stopAnimation();
							scale.setValue(1);
							if (!success) callbacks.current.onCancel();
						}),
				[x, y, scale],
			);

			return h(GestureDetector, { gesture }, h(Animated.View, { collapsable: false, style }, properties.children));
		}

		return { DragTarget, usePreview };
	}

	// --------------------------------------------------------------- surface

	function createServerDrawer(session) {
		const controller = createController();
		const { stores, menuItems } = controller;
		const FluxUtils = need(findByProps("useStateFromStores"), "Flux hooks");
		const { useSafeAreaInsets } = need(findByProps("useSafeAreaInsets"), "safe area insets");
		const gestures = need(findByProps("Gesture", "GestureDetector"), "native gestures");
		const { Gesture, GestureDetector } = gestures;
		const backPress = findByProps("useNavigatorBackPressHandler");
		const getAsset = id => {
			try { return ui.assets.getAssetIDByName(id); } catch (e) { return undefined; }
		};

		const motion = createMotion(Gesture);
		const { touchSlop, AnimatedView, AnimatedPressable, useDrawerMotion, usePageMotion, useFolderPageMotion, useFolderOverlayMotion } = motion;
		const { DragTarget, usePreview } = createDragMotion(Gesture, GestureDetector, motion.timingStandard);

		const useBackPress = backPress
			? backPress.useNavigatorBackPressHandler
			: handler => {
					const ref = useRef(handler);
					ref.current = handler;
					useEffect(() => {
						const sub = RN.BackHandler.addEventListener("hardwareBackPress", () => ref.current());
						return () => sub.remove();
					}, []);
				};

		const GLYPHS = {
			ChatIcon: "\u{1F4AC}", GridSquareIcon: "\u25A6", ListViewIcon: "\u2630", PlusLargeIcon: "+",
			ArrowSmallLeftIcon: "\u2039", ChevronSmallRightIcon: "\u203A", UndoIcon: "\u21A9",
		};

		function Icon({ name, color, size = 24, label, onPress, buttonSize = 44 }) {
			const asset = getAsset(name);
			const image = asset
				? h(Image, { source: asset, style: { width: size, height: size, tintColor: color } })
				: h(Text, { style: { color, fontSize: size * 0.9, fontWeight: "700", textAlign: "center" } }, GLYPHS[name] || "?");
			return label
				? h(Pressable, { accessibilityLabel: label, accessibilityRole: "button", onPress, style: { ...CENTER, height: buttonSize, width: buttonSize } }, image)
				: image;
		}

		function getDrawerGeometry(width, height, layout) {
			const dockSpecs = computeGuildDockSpecs(width - 16);
			const grid = layout === "grid";
			const contentWidth = dockSpecs.dockWidth - SIDE_PADDING * 2;
			const columns = grid ? Math.max(3, Math.floor((contentWidth + ITEM_GAP) / (ITEM_WIDTH + ITEM_GAP))) : 1;
			const columnStep = grid ? Math.max(ITEM_WIDTH + ITEM_GAP, (contentWidth - ITEM_WIDTH) / (columns - 1)) : ITEM_WIDTH;
			const previewWidth = grid ? ITEM_WIDTH : Math.max(1, dockSpecs.dockWidth - 20);
			return {
				dockSpecs,
				grid,
				columns,
				columnStep,
				previewWidth,
				columnOffset: grid ? columnStep - (contentWidth - BORDER_WIDTH * 2) / columns : 0,
				drawerHeight: Math.max(dockSpecs.dockHeight, height - 32),
				panelLeft: Math.max(0, Math.round((width - dockSpecs.dockWidth) / 2)),
			};
		}

		const DrawerCell = memo(props => props.render.current(props));

		function Badge({ state, compact }) {
			const s = useStyles();
			if (state.mentionCount)
				return h(
					View,
					{ style: [s.mentionBadge, { bottom: compact ? -3 : -4, minHeight: compact ? 18 : 20, minWidth: compact ? 18 : 20, right: compact ? -4 : -5 }] },
					h(Text, { style: { color: WHITE, fontSize: compact ? 9 : 10, fontWeight: "800" } }, state.mentionCount > 99 ? "99+" : String(state.mentionCount)),
				);
			return state.unread
				? h(View, { style: [s.unreadBadge, { bottom: compact ? -2 : -3, height: compact ? 13 : 14, right: compact ? -2 : -3, width: compact ? 13 : 14 }] })
				: null;
		}

		const Artwork = memo(function Artwork({ item, size, badged, compact, selected, animate }) {
			const s = useStyles();
			const c = s.c;
			const folder = item.kind === "folder";
			const uri = folder ? undefined : item.avatarUri;
			const source = useMemo(() => (typeof uri === "number" ? uri : { uri }), [uri]);
			const animatedUri = !folder && animate && item.animatedAvatarUri !== uri ? item.animatedAvatarUri : undefined;
			const animatedSource = useMemo(() => ({ uri: animatedUri }), [animatedUri]);
			const radius = !item.kind ? size / 2 : size >= 44 ? 16 : folder ? 9 : Math.max(5, Math.round(size * 0.28));
			let fill = item.kind === "guild" ? BRAND : c.lower;
			if (folder) fill = item.color === undefined ? c.folder : "#" + item.color.toString(16).padStart(6, "0");

			return h(
				View,
				{ style: { ...CENTER, position: "relative", height: size, width: size, borderRadius: radius, backgroundColor: uri ? undefined : fill } },
				folder
					? item.children.slice(0, 4).map((guild, index) =>
							h(
								View,
								{ key: guild.id, style: { [index % 2 ? "right" : "left"]: 6, [index < 2 ? "top" : "bottom"]: 6, position: "absolute" } },
								h(Artwork, { item: guild, size: Math.floor(size * 0.34) }),
							),
						)
					: uri
						? h(
								Fragment,
								null,
								h(Image, { accessibilityIgnoresInvertColors: true, resizeMode: "cover", source, fadeDuration: 0, style: { borderRadius: radius, height: size, width: size } }),
								animatedUri
									? h(Image, { accessibilityIgnoresInvertColors: true, resizeMode: "cover", source: animatedSource, fadeDuration: 0, style: { position: "absolute", borderRadius: radius, height: size, width: size } })
									: null,
							)
						: h(Text, { numberOfLines: 1, style: { color: item.kind ? WHITE : c.text, fontSize: Math.max(10, Math.round(size * 0.34)), fontWeight: "700" } }, initials(item.name)),
				selected ? h(View, { pointerEvents: "none", style: [s.compactSelection, { borderRadius: size / 3 + 3 }] }) : null,
				badged ? h(Badge, { state: item, compact }) : null,
			);
		});

		function Item({ item, layout = "grid", selectedId, dragging, merging, onPress, onLongPress, compactSize, previewWidth, animate }) {
			const s = useStyles();
			const c = s.c;
			const touch = useRef(undefined);
			const moved = useRef(false);
			const press = {
				onTouchStart: ({ nativeEvent: event }) => {
					touch.current = { x: event.pageX, y: event.pageY };
					moved.current = false;
				},
				onTouchMove: ({ nativeEvent: event }) => {
					if (touch.current && Math.hypot(event.pageX - touch.current.x, event.pageY - touch.current.y) > touchSlop)
						moved.current = true;
				},
				onTouchCancel: () => { moved.current = false; },
				onPress: () => {
					const activate = !moved.current;
					moved.current = false;
					if (activate && onPress) onPress();
				},
			};
			const folder = item.kind === "folder";
			const selected = !folder && item.id === selectedId;
			const label = item.name != null ? item.name : compactSize ? "Server folder" : "Folder";
			const accessibilityLabel =
				label + (item.mentionCount > 0 ? ", " + item.mentionCount + " mentions" : item.unread ? ", unread" : "");
			const artwork = h(Artwork, { item, animate, size: compactSize || ICON_SIZE, badged: true, compact: !!compactSize, selected: !!compactSize && selected });

			if (compactSize)
				return h(
					Pressable,
					{
						...press,
						onLongPress,
						accessibilityRole: "button",
						accessibilityLabel: folder ? label : accessibilityLabel,
						accessibilityState: folder ? undefined : { selected },
						delayLongPress: LONG_PRESS_MS,
						style: { height: compactSize, width: compactSize },
					},
					artwork,
				);

			const list = layout === "list";
			const highlighted = selected || merging;
			const content = h(
				Fragment,
				null,
				list || previewWidth
					? artwork
					: h(View, { style: [s.selectionRing, { borderColor: highlighted ? c.brand : "transparent", borderRadius: item.kind ? 20 : 31 }] }, artwork),
				h(
					Text,
					{
						ellipsizeMode: list ? undefined : "tail",
						numberOfLines: 1,
						style: [
							list ? { flex: 1 } : s.gridLabel,
							{ color: selected ? c.brand : c.text, fontSize: list ? 16 : 12, fontWeight: selected || previewWidth ? "700" : "500" },
							previewWidth && !list ? { width: 60 } : undefined,
						],
					},
					label,
				),
				!previewWidth && list && folder ? h(Icon, { name: "ChevronSmallRightIcon", color: c.muted, size: 22 }) : null,
			);

			if (previewWidth)
				return h(View, { style: [s.previewFrame, list ? [s.listPreview, { width: previewWidth }] : s.gridPreview] }, content);

			return h(
				Pressable,
				{
					accessibilityLabel,
					accessibilityRole: "button",
					accessibilityState: { selected },
					cancelable: !dragging,
					delayLongPress: LONG_PRESS_MS,
					...press,
					pressRetentionOffset: { bottom: 4096, left: 4096, right: 4096, top: 4096 },
					style: [
						list ? s.listItem : s.gridItem,
						{ opacity: dragging ? 0.08 : 1 },
						list ? { backgroundColor: highlighted ? c.brand + "24" : "transparent" } : undefined,
					],
				},
				content,
			);
		}

		function FolderTitle({ folder, style }) {
			const s = useStyles();
			const c = s.c;
			const [editing, setEditing] = useState("idle");
			if (editing !== "idle")
				return h(
					View,
					{ style },
					h(TextInput, {
						accessibilityLabel: "Folder name",
						autoFocus: true,
						selectTextOnFocus: true,
						maxLength: 100,
						defaultValue: folder.name || "",
						returnKeyType: "done",
						style: s.folderInput,
						onEndEditing: ({ nativeEvent: { text } }) => {
							try {
								if (text.trim() !== (folder.name || "") && controller.renameFolder(folder.id, text) === false)
									throw new Error("Folder is no longer available");
								setEditing("idle");
							} catch (e) {
								setEditing("error");
							}
						},
					}),
					editing === "error" ? h(Text, { style: { color: c.text, fontSize: 12 } }, "Could not rename folder. Try again.") : null,
				);
			return h(
				Pressable,
				{ accessibilityRole: "button", accessibilityLabel: "Rename folder: " + (folder.name || "Folder"), onPress: () => setEditing("editing"), style },
				h(Text, { numberOfLines: 1, style: { color: c.text, fontSize: 20, fontWeight: "700" } }, folder.name || "Folder"),
			);
		}

		function Tabs({ options, value, onChange, filter }) {
			const s = useStyles();
			const c = s.c;
			return h(
				View,
				{ style: filter ? s.filterTabs : s.viewTabs },
				options.map(([id, label]) => {
					const on = id === value;
					return h(
						Pressable,
						{
							key: id,
							accessibilityRole: "tab",
							accessibilityState: { selected: on },
							onPress: () => { if (!on) onChange(id); },
							style: filter ? [s.filterTab, on && s.filterTabOn] : [s.viewTab, on && s.viewTabOn],
						},
						h(Text, { style: { color: on ? (filter ? c.text : c.brand) : c.muted, fontWeight: "700", fontSize: filter ? 13 : 15 } }, label),
					);
				}),
			);
		}

		function useDrawerData() {
			useProxy(storage);
			const layout = storage.layout === "list" ? "list" : "grid";
			const snapshot = FluxUtils.useStateFromStores(
				[
					stores.ChannelStore, stores.GuildReadStateStore, stores.GuildStore, stores.PrivateChannelSortStore,
					stores.ReadStateStore, stores.SelectedChannelStore, stores.SelectedGuildStore, stores.SortedGuildStore, stores.UserStore,
				],
				() => (session.aborted ? EMPTY_SNAPSHOT : controller.snapshot()),
			);
			const dmOrder = storage.dmOrder;
			const directMessages = useMemo(() => orderedDms(snapshot.directMessages, dmOrder), [snapshot.directMessages, dmOrder]);
			const directMessageBadge = useMemo(
				() =>
					directMessages.reduce(
						(total, channel) => ({ mentionCount: total.mentionCount + channel.mentionCount, unread: total.unread || channel.unread }),
						{ mentionCount: 0, unread: false },
					),
				[directMessages],
			);
			return { ...snapshot, layout, directMessages, directMessageBadge, pullToMarkRead: !!storage.pullToMarkRead };
		}

		function useReorder(directMessages) {
			const [, refresh] = useReducer(value => value + 1, 0);
			const reorder = useRef(undefined);
			const mergeTimer = useRef(undefined);
			const exitTarget = useRef(null);
			useEffect(() => () => clearTimeout(mergeTimer.current), []);
			const exitBounds = useRef(undefined);

			const measureExit = () => {
				const target = exitTarget.current;
				exitBounds.current = undefined;
				if (target && target.measureInWindow)
					target.measureInWindow((x, y, width, height) => {
						if (exitTarget.current === target) exitBounds.current = { x, y, width, height };
					});
			};

			const begin = (source, point, items, geometry, openMenu) => {
				const from = items.indexOf(source);
				if (from < 0) return;
				measureExit();
				clearTimeout(mergeTimer.current);
				reorder.current = { ...geometry, source, items, from, target: from, start: point, point, openMenu };
				refresh();
			};

			const move = ({ x, y }) => {
				const active = reorder.current;
				if (!active) return;
				const { source, from, columns, columnStep, rowStep, target: previousTarget, mergeSince, outside } = active;
				const dx = x - active.start.x;
				const dy = y - active.start.y;
				const grid = active.layout === "grid";

				active.point = { x, y };
				active.moved = active.moved || Math.hypot(dx, dy) > 10;
				active.outside =
					source.kind === "guild" && !!source.folderId && !!exitTarget.current && hitsDropTarget(active.point, exitBounds.current);
				active.target = active.outside
					? from
					: clamp(from + Math.round(dy / rowStep) * columns + (grid ? Math.round(dx / columnStep) : 0), 0, active.items.length - 1);

				const target = active.items[active.target];
				const row = Math.floor(active.target / columns) - Math.floor(from / columns);
				const column = (active.target % columns) - (from % columns);
				const centered =
					Math.abs(dy - row * rowStep) < (grid ? 22 : 20) && (!grid || Math.abs(dx - column * columnStep) < 22);
				const merge =
					source.kind === "guild" &&
					target.kind &&
					from !== active.target &&
					centered &&
					(target.kind === "folder" ? source.folderId !== target.id : !source.folderId || source.folderId !== target.folderId);
				active.mergeSince = merge
					? previousTarget === active.target ? (mergeSince || Date.now()) : Date.now()
					: undefined;
				if (mergeSince !== active.mergeSince) {
					clearTimeout(mergeTimer.current);
					active.mergeReady = false;
					if (active.mergeSince !== undefined)
						mergeTimer.current = setTimeout(() => {
							if (reorder.current !== active) return;
							active.mergeReady = true;
							refresh();
						}, 450);
				}
				if (outside !== active.outside || !!mergeSince !== !!active.mergeSince || previousTarget !== active.target) refresh();
			};

			const cancel = () => {
				if (!reorder.current) return;
				clearTimeout(mergeTimer.current);
				reorder.current = undefined;
				controller.animateNext(110);
				refresh();
			};

			const finish = (showMenu = false) => {
				const active = reorder.current;
				if (!active) return;
				cancel();
				const { source, items, target, from, outside, moved, mergeSince } = active;
				if (showMenu && !moved) return active.openMenu && active.openMenu();
				try {
					if (!source.kind) {
						const dmOrder = directMessages.map(item => item.id);
						const sourceIndex = dmOrder.indexOf(source.id);
						const targetIndex = dmOrder.indexOf(items[target].id);
						if (from === target || sourceIndex < 0 || targetIndex < 0) return;
						dmOrder.splice(targetIndex, 0, ...dmOrder.splice(sourceIndex, 1));
						storage.dmOrder = dmOrder;
					} else {
						const merge = mergeSince !== undefined && Date.now() - mergeSince >= 450;
						const exit = outside && source.kind === "guild" && source.folderId;
						if (!exit && from === target) return;
						if (controller.commitDrop(source.id, exit || items[target].id, exit ? "exit" : merge ? "merge" : "move") === false)
							throw new Error("Drop target is no longer available");
					}
				} catch (error) {
					reportActionFailure("move this item", error);
				}
			};

			const offset = id => {
				const active = reorder.current;
				if (!active || active.outside || active.mergeReady) return;
				const index = active.items.findIndex(item => item.id === id);
				const { from, target, columns, columnStep, rowStep } = active;
				if (index < 0 || index === from) return;
				const slot =
					from < target && index > from && index <= target
						? index - 1
						: target < from && index >= target && index < from ? index + 1 : index;
				return {
					x: ((slot % columns) - (index % columns)) * columnStep,
					y: (Math.floor(slot / columns) - Math.floor(index / columns)) * rowStep,
				};
			};

			return {
				reorder,
				exitTarget,
				measureExit,
				begin,
				finish,
				offset,
				handlers: {
					onMove: move,
					onCancel: cancel,
					onDrop: point => {
						move(point);
						finish(true);
					},
				},
			};
		}

		function FolderOverlay({ folder, width, height, closeFolder, renderItem, gesture, closing, backdropStyle, panelStyle }) {
			const s = useStyles();
			const c = s.c;
			const [folderPage, setFolderPage] = useState(0);
			const folderPager = useRef(null);
			const folderHeight = clamp(height - 64, 240, 360);
			const pageSize = 3 * Math.max(1, Math.floor((folderHeight - 78) / 90));
			const pages = Array.from({ length: Math.ceil(folder.children.length / pageSize) }, (_, index) =>
				folder.children.slice(index * pageSize, (index + 1) * pageSize),
			);
			const folderSize = clamp(width - 32, 240, 320);

			return h(
				GestureDetector,
				{ gesture },
				h(
					AnimatedPressable,
					{
						accessibilityLabel: "Close server folder",
						accessibilityRole: "button",
						collapsable: false,
						pointerEvents: closing ? "none" : "auto",
						onAccessibilityEscape: closeFolder,
						onPress: closeFolder,
						style: [s.folderBackdrop, backdropStyle, { backgroundColor: "rgba(0, 0, 0, 0.82)" }],
					},
					h(
						AnimatedPressable,
						{
							accessibilityLabel: folder.name || "Unnamed folder",
							onPress: event => event.stopPropagation(),
							accessibilityRole: "summary",
							style: [s.folderPanel, FLOATING_FOLDER_STYLE, panelStyle, { height: folderHeight, width: folderSize }],
						},
						h(
							ScrollView,
							{
								horizontal: true,
								pagingEnabled: true,
								ref: folderPager,
								showsHorizontalScrollIndicator: false,
								style: { height: folderHeight, width: folderSize },
								onMomentumScrollEnd: event =>
									setFolderPage(clamp(Math.round(event.nativeEvent.contentOffset.x / folderSize), 0, Math.max(0, pages.length - 1))),
							},
							pages.map((page, pageIndex) =>
								h(View, { key: "folder-page-" + pageIndex, style: [s.folderPage, { height: folderHeight, width: folderSize }] }, page.map(renderItem)),
							),
						),
						h(FolderTitle, { key: folder.id, folder, style: s.folderHeading }),
						pages.length > 1
							? h(
									View,
									{ pointerEvents: "box-none", style: s.pageDots },
									pages.map((_page, index) =>
										h(Pressable, {
											key: "folder-dot-" + index,
											accessibilityRole: "button",
											accessibilityLabel: "Folder page " + (index + 1),
											accessibilityState: { selected: index === folderPage },
											onPress: () => {
												setFolderPage(index);
												if (folderPager.current) folderPager.current.scrollTo({ animated: true, x: index * folderSize, y: 0 });
											},
											style: [s.pageDot, { backgroundColor: index === folderPage ? c.text : c.muted }],
										}),
									),
								)
							: null,
					),
				),
			);
		}

		const VIEW_OPTIONS = [["servers", "Servers"], ["dms", "Direct Messages"]];
		const FILTER_OPTIONS = [["all", "All"], ["unread", "Unreads"]];

		return function ServerDrawerSurface({ bottomInset, onWidthChange }) {
			const s = useStyles();
			const c = s.c;
			const [ui_, setUiState] = useState({ expanded: false, view: "servers", filter: "all", query: "" });
			const setUi = next => setUiState(previous => ({ ...previous, ...next }));
			const { expanded, view, filter, query, folderId, folderOverlayId } = ui_;
			const [menu, setMenu] = useState(undefined);
			const closeFolder = () => setUi({ folderOverlayId: undefined });
			const changeFolder = id =>
				startTransition(() => setUi({ folderId: id, ...(id ? { retainedFolderId: id } : {}) }));

			const [{ height: viewportHeight, width: viewportWidth }, setViewport] = useState(() => Dimensions.get("window"));
			const [listAtTop, setListAtTop] = useState(true);
			const data = useDrawerData();
			const [foreground, setForeground] = useState(AppState.currentState === "active");
			useEffect(() => {
				const subscription = AppState.addEventListener("change", state => setForeground(state === "active"));
				return () => subscription.remove();
			}, []);

			const insetTop = useSafeAreaInsets().top;
			const { dockSpecs, drawerHeight, panelLeft, grid, columns, columnStep, previewWidth, columnOffset } =
				getDrawerGeometry(viewportWidth, viewportHeight - bottomInset - insetTop, data.layout);

			const folderMotion = useFolderOverlayMotion(folderOverlayId);
			const folderPageStyle = useFolderPageMotion(folderId);
			const findFolder = id => data.nodes.find(node => node.kind === "folder" && node.id === id);
			const drawerFolder = findFolder(folderId);
			const retainedFolder = findFolder(ui_.retainedFolderId);
			const overlayFolder = findFolder(folderMotion.folderId);
			const visible = filteredItems(view === "servers" ? (drawerFolder ? drawerFolder.children : data.nodes) : data.directMessages, filter, query);
			const drag = useReorder(data.directMessages);
			const preview = usePreview(previewWidth, grid);
			const active = drag.reorder.current;

			const markAllRead = () => {
				if (session.aborted || !storage.pullToMarkRead) return;
				try {
					controller.markAllRead();
				} catch (error) {
					reportActionFailure("mark all as read", error);
				}
			};
			const resize = useDrawerMotion(
				expanded,
				dockSpecs.dockHeight - DOCK_REST_OFFSET,
				drawerHeight,
				listAtTop,
				!!active,
				setDrawerOpen,
				data.pullToMarkRead && !folderOverlayId ? markAllRead : undefined,
			);

			useEffect(() => {
				if (folderId && !drawerFolder) setUi({ folderId: undefined });
				if (folderOverlayId && !overlayFolder) setUi({ folderOverlayId: undefined });
			}, [drawerFolder, folderId, folderOverlayId, overlayFolder]);
			useEffect(() => { setListAtTop(true); }, [filter, folderId, data.layout, query]);

			useBackPress(() => {
				if (session.aborted || (!expanded && !folderId && !folderOverlayId && !menu)) return false;
				if (menu) setMenu(undefined);
				else if (folderOverlayId) closeFolder();
				else if (folderId) changeFolder();
				else setDrawerOpen(false, false);
				return true;
			});

			function setDrawerOpen(open, reset = true) {
				setUi({ expanded: open, ...(!open && reset ? { folderId: undefined, query: "" } : {}) });
				if (!open && reset) setListAtTop(true);
			}

			const open = (operation, action, close = true) => {
				try {
					if (action() !== false && close) setDrawerOpen(false);
				} catch (error) {
					reportActionFailure(operation, error);
				}
			};

			const selectItem = item => {
				if (item.kind) closeFolder();
				open("open this item", () => (item.kind ? controller.selectGuild(item.id) : controller.selectPrivateChannel(item.id)), expanded);
			};

			function changeView(next, openDrawer = false) {
				if (view === next && !openDrawer) return;
				drag.finish();
				setUi({ folderId: undefined, folderOverlayId: undefined, query: "", view: next, ...(openDrawer ? { filter: "all" } : {}) });
				if (openDrawer) setDrawerOpen(true);
			}

			const openItemMenu = item => {
				try {
					const items = menuItems(item);
					if (items.length) setMenu({ title: item.name || "Folder", items });
				} catch (error) {
					reportActionFailure("open this menu", error);
				}
			};

			const renderCell = ({ item, inFolder, compactSize, items, animate }) => {
				const openMenu = item.kind ? () => openItemMenu(item) : undefined;
				const content = h(Item, {
					item,
					onLongPress: openMenu,
					animate,
					compactSize,
					layout: inFolder ? "grid" : data.layout,
					dragging: !!active && active.source.id === item.id,
					merging: !inFolder && !!active && active.mergeReady === true && active.items[active.target].id === item.id,
					selectedId: item.kind ? data.selectedGuildId : data.selectedPrivateChannelId,
					onPress: () => {
						if (item.kind !== "folder") return selectItem(item);
						if (compactSize) setUi({ folderOverlayId: item.id });
						else changeFolder(item.id);
					},
				});
				const key = compactSize || inFolder ? item.id : undefined;
				if (compactSize) return h(Fragment, { key }, content);
				return h(
					DragTarget,
					{
						key,
						preview,
						offset: drag.offset(item.id),
						...drag.handlers,
						onStart: point =>
							drag.begin(
								item,
								point,
								inFolder ? overlayFolder.children : items,
								{
									columns: inFolder ? 3 : columns,
									columnStep: inFolder ? ITEM_WIDTH + 8 : columnStep,
									layout: inFolder ? "grid" : data.layout,
									rowStep: inFolder ? 90 : grid ? 82 + ITEM_GAP : 72,
								},
								openMenu,
							),
					},
					content,
				);
			};

			const cellRenderer = useRef(renderCell);
			cellRenderer.current = renderCell;
			const renderItem = (item, inFolder = false, compactSize, page = view, items = visible, visiblePage = true) => {
				const offset = drag.offset(item.id);
				const animated = item.kind !== "folder" && !!item.animatedAvatarUri && item.animatedAvatarUri !== item.avatarUri;
				return h(DrawerCell, {
					key: compactSize || inFolder ? item.id : undefined,
					render: cellRenderer,
					item,
					inFolder,
					compactSize,
					page,
					items,
					animate: animated && visiblePage && !compactSize && ((expanded && page === view) || !!folderOverlayId) && foreground,
					expanded,
					layout: data.layout,
					width: viewportWidth,
					selected: item.id === (item.kind ? data.selectedGuildId : data.selectedPrivateChannelId),
					dragging: !!active && active.source.id === item.id,
					merging: !inFolder && !!active && active.mergeReady === true && active.items[active.target].id === item.id,
					offsetX: offset && offset.x,
					offsetY: offset && offset.y,
				});
			};

			const pageWidth = dockSpecs.dockWidth;
			const pages = usePageMotion(view, pageWidth, expanded && !active && !folderOverlayId, changeView);

			const renderPage = page => {
				const servers = page === "servers";
				const viewLabel = servers ? "servers" : "direct messages";
				const folders = servers && retainedFolder ? [undefined, retainedFolder] : [undefined];
				return h(
					AnimatedView,
					{
						key: page,
						style: { width: pageWidth, height: "100%" },
						accessibilityElementsHidden: page !== view,
						importantForAccessibility: page === view ? "auto" : "no-hide-descendants",
					},
					h(
						View,
						{ style: s.searchRow },
						h(TextInput, {
							placeholder: "Search " + viewLabel,
							placeholderTextColor: c.muted,
							value: query,
							onChangeText: value => setUi({ query: value }),
							returnKeyType: "search",
							autoCorrect: false,
							style: s.searchInput,
						}),
						h(Tabs, { filter: true, value: filter, onChange: value => setUi({ filter: value }), options: FILTER_OPTIONS }),
					),
					h(
						View,
						{ style: { flex: 1 } },
						folders.map(folder => {
							const hidden = folder ? folder.id !== folderId : servers && !!drawerFolder;
							const items = filteredItems(
								servers ? (folder ? folder.children : data.nodes) : data.directMessages,
								filter,
								page === view ? query : "",
							);
							const motionStyle = servers ? folderPageStyle[folder ? "folderStyle" : "rootStyle"] : undefined;
							return h(
								AnimatedView,
								{
									key: folder ? folder.id : "root",
									pointerEvents: hidden ? "none" : "auto",
									accessibilityElementsHidden: hidden,
									importantForAccessibility: hidden ? "no-hide-descendants" : "auto",
									style: [StyleSheet.absoluteFill, motionStyle],
								},
								h(FlatList, {
									data: items,
									numColumns: columns,
									key: page + "-" + data.layout + "-" + columns,
									ListEmptyComponent: h(
										View,
										{ style: s.emptyContainer },
										h(
											Text,
											{ style: { color: c.text, fontSize: 16, fontWeight: "600", textAlign: "center" } },
											query.trim()
												? "No " + viewLabel + " match your search"
												: filter === "unread" ? "You're all caught up" : "No " + viewLabel + " to show",
										),
									),
									contentContainerStyle: { paddingBottom: 40, paddingHorizontal: grid ? SIDE_PADDING : 10, paddingTop: grid ? 14 : 10 },
									keyExtractor: item => page + ":" + item.id,
									onScroll: ({ nativeEvent: { contentOffset } }) => {
										if (hidden || page !== view) return;
										const atTop = contentOffset.y <= 0;
										setListAtTop(previous => (previous === atTop ? previous : atTop));
									},
									renderItem: ({ item, index }) =>
										h(
											View,
											{
												style: {
													marginLeft: (index % columns) * columnOffset,
													width: grid ? ITEM_WIDTH : "100%",
													paddingBottom: Math.floor(index / columns) < Math.floor((items.length - 1) / columns) ? (grid ? ITEM_GAP : 4) : 0,
												},
											},
											renderItem(item, false, undefined, page, items, !hidden),
										),
									initialNumToRender: 30,
									windowSize: 9,
									scrollEventThrottle: 16,
									scrollEnabled: !active,
									showsVerticalScrollIndicator: false,
									style: { flex: 1 },
								}),
							);
						}),
					),
				);
			};

			if (session.aborted) return null;

			const dmLabel =
				"Direct Messages" +
				(data.directMessageBadge.mentionCount > 0
					? ", " + data.directMessageBadge.mentionCount + " mentions"
					: data.directMessageBadge.unread ? ", unread" : "");

			return h(
				View,
				{
					onLayout: ({ nativeEvent: { layout } }) => {
						if (layout.width > 0 && layout.height > 0) setViewport(layout);
						if (layout.width > 0) onWidthChange(layout.width);
					},
					pointerEvents: "box-none",
					style: s.drawerBackdrop,
				},
				overlayFolder
					? h(FolderOverlay, {
							key: overlayFolder.id,
							folder: overlayFolder,
							width: viewportWidth,
							height: viewportHeight - bottomInset,
							closeFolder,
							renderItem: guild => renderItem(guild, true),
							gesture: resize.overlayGesture,
							closing: !folderOverlayId,
							backdropStyle: folderMotion.backdropStyle,
							panelStyle: folderMotion.panelStyle,
						})
					: null,
				h(
					View,
					{
						pointerEvents: "box-none",
						style: {
							position: "absolute",
							overflow: "hidden",
							bottom: bottomInset - YOU_BAR_JOIN_DEPTH,
							height: viewportHeight - bottomInset + YOU_BAR_JOIN_DEPTH,
							left: panelLeft,
							width: dockSpecs.dockWidth,
						},
					},
					h(
						GestureDetector,
						{ gesture: resize.gesture },
						h(
							AnimatedView,
							{
								collapsable: false,
								accessibilityLabel: expanded ? (view === "servers" ? "All servers drawer" : "Direct messages drawer") : "Server dock",
								accessibilityViewIsModal: expanded,
								importantForAccessibility: expanded ? "yes" : "auto",
								style: [
									s.drawerPanel,
									FLOATING_PANEL_STYLE,
									{ bottom: 0, height: drawerHeight + YOU_BAR_JOIN_DEPTH, width: dockSpecs.dockWidth },
									resize.panelStyle,
								],
							},
							h(
								View,
								{ style: { height: drawerHeight, overflow: "hidden" } },
								h(
									Pressable,
									{
										accessibilityRole: "button",
										accessibilityState: { expanded },
										accessibilityLabel: expanded ? "Collapse server drawer" : "Expand server drawer",
										hitSlop: { bottom: 14, left: 14, right: 14, top: 14 },
										onPress: () => setDrawerOpen(!expanded),
										style: s.handle,
									},
									h(View, { style: s.handleBar }),
								),
								h(
									AnimatedView,
									{
										pointerEvents: expanded ? "none" : "auto",
										accessibilityElementsHidden: expanded,
										importantForAccessibility: expanded ? "no-hide-descendants" : "auto",
										style: [s.compactFace, resize.compactStyle],
									},
									h(
										View,
										{ style: [s.dockRow, { height: dockSpecs.itemSize }] },
										Array.from({ length: dockSpecs.itemCountNoExtras }, (_, index) => {
											const node = data.nodes[index];
											if (!node || (node.kind === "folder" && !node.children.length))
												return h(View, {
													key: "spacer-" + index,
													accessibilityElementsHidden: true,
													importantForAccessibility: "no-hide-descendants",
													style: { height: dockSpecs.itemSize, opacity: 0, width: dockSpecs.itemSize },
												});
											return renderItem(node, false, dockSpecs.itemSize);
										}),
										h(View, { style: [s.dockDivider, { height: Math.round(dockSpecs.itemSize * 0.7) }] }),
										h(
											Pressable,
											{
												accessibilityRole: "button",
												onPress: () => changeView("dms", true),
												accessibilityLabel: dmLabel,
												style: [s.dmButton, { height: dockSpecs.itemSize, width: dockSpecs.itemSize }],
											},
											h(Icon, { name: "ChatIcon", color: c.text }),
											h(Badge, { state: data.directMessageBadge, compact: true }),
										),
										h(Icon, {
											label: "View all servers",
											onPress: () => setDrawerOpen(true),
											name: "GridSquareIcon",
											color: c.text,
											buttonSize: dockSpecs.itemSize,
											size: Math.max(10, Math.floor((dockSpecs.itemSize * 0.8 - 5) / 2)) * 2 + 5,
										}),
									),
								),
								h(
									AnimatedView,
									{
										pointerEvents: expanded ? "auto" : "none",
										accessibilityElementsHidden: !expanded,
										importantForAccessibility: expanded ? "auto" : "no-hide-descendants",
										style: [s.expandedFace, resize.expandedStyle],
									},
									h(
										View,
										{ style: { height: drawerHeight - 16 } },
										h(
											View,
											{ style: s.header },
											drawerFolder
												? h(
														Fragment,
														null,
														h(Icon, { label: "Back to all servers", onPress: () => changeFolder(), name: "ArrowSmallLeftIcon", color: c.text, size: 30 }),
														h(FolderTitle, { key: drawerFolder.id, folder: drawerFolder, style: { flex: 1, paddingVertical: 8 } }),
													)
												: h(Tabs, { options: VIEW_OPTIONS, value: view, onChange: changeView }),
											h(Icon, {
												label: "Switch to " + (grid ? "list" : "grid") + " view",
												onPress: () => { storage.layout = grid ? "list" : "grid"; },
												name: grid ? "ListViewIcon" : "GridSquareIcon",
												color: c.muted,
											}),
											h(Icon, {
												label: view === "servers" ? "Create a server" : "Start a direct message",
												onPress: () =>
													open("open creation", view === "servers" ? controller.openCreateGuild : controller.openCreateDm),
												name: "PlusLargeIcon",
												color: c.muted,
											}),
										),
										h(
											GestureDetector,
											{ gesture: pages.gesture },
											h(
												View,
												{ collapsable: false, style: { flex: 1, overflow: "hidden" } },
												h(
													AnimatedView,
													{ style: [{ width: pageWidth * 2, height: "100%", flexDirection: "row" }, pages.style] },
													renderPage("servers"),
													renderPage("dms"),
												),
											),
										),
									),
								),
							),
						),
					),
				),
				active
					? h(
							AnimatedView,
							{
								accessibilityLabel: "Dragging " + (active.source.name || "Folder"),
								accessibilityRole: "summary",
								pointerEvents: "none",
								style: [s.dragPreview, { left: grid ? 0 : panelLeft + 10, width: previewWidth }, preview.style],
							},
							h(Item, { item: active.source, layout: data.layout, previewWidth, animate: expanded && foreground }),
						)
					: null,
				active && active.source.kind === "guild" && active.source.folderId && (drawerFolder || overlayFolder)
					? h(
							View,
							{
								ref: drag.exitTarget,
								collapsable: false,
								onLayout: drag.measureExit,
								pointerEvents: "none",
								accessible: true,
								accessibilityRole: "image",
								accessibilityLabel: "Move server out of folder",
								accessibilityHint: "Drag a server onto this arrow and release to make it standalone",
								style: [s.exitTarget, { left: viewportWidth / 2 - 28, bottom: bottomInset + 24 }],
							},
							h(
								View,
								{ style: { height: 42, justifyContent: "center", transform: [{ scale: active.outside ? 1.15 : 1 }] } },
								h(Icon, { name: "UndoIcon", color: active.outside ? c.brand : c.text, size: 36 }),
							),
						)
					: null,
				menu
					? h(
							Pressable,
							{ accessibilityLabel: "Close menu", accessibilityRole: "button", onPress: () => setMenu(undefined), style: s.menuBackdrop },
							h(
								Pressable,
								{ onPress: event => event.stopPropagation(), style: [s.menuPanel, { paddingBottom: bottomInset + 24 }] },
								h(Text, { numberOfLines: 1, style: s.menuTitle }, menu.title),
								menu.items.map((item, index) =>
									h(
										Pressable,
										{
											key: index + ":" + item.label,
											accessibilityRole: "button",
											onPress: async () => {
												setMenu(undefined);
												try {
													await item.action();
												} catch (error) {
													reportActionFailure("complete this server action", error);
												}
											},
											style: s.menuRow,
										},
										h(Text, { style: { color: c.text, fontSize: 16, fontWeight: "500" } }, item.label),
									),
								),
							),
						)
					: null,
			);
		};
	}

	// ------------------------------------------------------------ panel hook

	function transformLeftPanelContent(rendered, dock, dockHeight) {
		const [rail, content] = rendered.props.children;
		return React.cloneElement(rendered, {
			children: [
				h(
					View,
					{
						key: "rail",
						accessibilityElementsHidden: true,
						importantForAccessibility: "no-hide-descendants",
						pointerEvents: "none",
						style: { height: 1, width: 1, position: "absolute", left: -10000, opacity: 0 },
					},
					rail,
				),
				React.cloneElement(content, {
					style: [content.props.style, { bottom: dockHeight, left: 0, right: 0, width: "100%", borderLeftWidth: 0 }],
				}),
				dock,
			],
		});
	}

	function isNativePanel(element) {
		return (
			React.isValidElement(element) &&
			Array.isArray(element.props.children) &&
			element.props.children.length === 2 &&
			React.isValidElement(element.props.children[1])
		);
	}

	function start(session, track) {
		const useActive = () => {
			const [, bump] = useReducer(x => x + 1, 0);
			useEffect(() => {
				session.listeners.add(bump);
				return () => { session.listeners.delete(bump); };
			}, []);
			return !session.aborted;
		};

		const icymi = findByProps("getICYMIEnabled", "useICYMIEnabled");
		if (icymi) {
			track(patcher.after("getICYMIEnabled", icymi, () => false));
			track(patcher.after("useICYMIEnabled", icymi, () => false));
		}

		const experiment = findByProps("MobileHomeDrawerExperiment");
		if (experiment && experiment.MobileHomeDrawerExperiment)
			for (const key of ["getConfig", "useConfig"])
				track(
					patcher.after(key, experiment.MobileHomeDrawerExperiment, (_args, config) => ({
						...config,
						enableHome: false,
						landOnHome: false,
						enablePeekHint: false,
					})),
				);

		const mainChannels = find(byComponent("MainChannels"));
		if (!mainChannels) throw new Error("Server Drawer: this Discord version has an unsupported home panel (MainChannels not found).");

		let Panel;
		let failed = false;

		const initialize = element => {
			if (failed || session.aborted) return element;
			if (!isNativePanel(element)) {
				failed = true;
				reportError(new Error("Server Drawer: unsupported left-panel content."));
				return element;
			}
			if (Panel) return h(Panel, { key: element.key, element });
			try {
				const inset = findByProps("useYouBarTotalHeight");
				const shade = find(byComponent("YouBarFloatingShade"));
				const channelWidth = find(m => m && m.default && m.default.name === "useChannelListWidth");
				const chatLayout = findByProps("getChatLayout");
				const constants = findByProps("DM_WIDTH");
				if (
					!inset ||
					!shade ||
					typeof shade.default.type !== "function" ||
					!channelWidth ||
					typeof channelWidth.default !== "function" ||
					!chatLayout ||
					!constants ||
					!mainChannels.default ||
					typeof mainChannels.default.type !== "function"
				)
					throw new Error("Server Drawer: this Discord version has an unsupported home panel.");

				const DrawerSurface = createServerDrawer(session);
				const useInset = () => {
					const height = inset.useYouBarTotalHeight();
					return Math.max(0, Number.isFinite(height) ? height : 0);
				};

				function YouBarBackdrop({ element: shadeElement }) {
					const height = useInset();
					const active = useActive();
					return active && Platform.OS !== "ios"
						? h(
								View,
								{ pointerEvents: "none", style: { position: "absolute", bottom: 0, left: 0, right: 0, height, overflow: "hidden" } },
								shadeElement,
							)
						: shadeElement;
				}

				function ServerDrawerLeftPanel({ element: panel }) {
					const active = useActive();
					const bottomInset = useInset();
					const [width, setWidth] = useState(() => Dimensions.get("window").width);
					return active
						? transformLeftPanelContent(
								panel,
								h(DrawerSurface, { key: "server-drawer", bottomInset, onWidthChange: setWidth }),
								computeGuildDockSpecs(width - 16).dockHeight - DOCK_REST_OFFSET,
							)
						: panel;
				}

				track(patcher.after("type", shade.default, (_args, ret) => h(YouBarBackdrop, { element: ret })));
				track(
					patcher.after("default", channelWidth, (_args, width) =>
						chatLayout.getChatLayout().isChatBesideChannelList ? width : width + constants.DM_WIDTH,
					),
				);
				const channelBackground = findByProps("ScreenAlignedThemedGradientSliding");
				if (channelBackground && typeof channelBackground.default === "function")
					track(
						patcher.before("default", channelBackground, args => {
							if (!chatLayout.getChatLayout().isChatBesideChannelList) args[0] = { ...args[0], offsetX: 0 };
							return args;
						}),
					);

				Panel = ServerDrawerLeftPanel;
				return h(Panel, { key: element.key, element });
			} catch (error) {
				failed = true;
				reportError(error);
				try { ui.toasts.showToast("Server Drawer failed to start: " + (error && error.message)); } catch (e) {}
				return element;
			}
		};

		const wrappers = new Map();
		const wrapPanel = node => {
			if (Array.isArray(node)) {
				const children = node.map(wrapPanel);
				return children.every((child, index) => child === node[index]) ? node : children;
			}
			if (!React.isValidElement(node)) return node;
			const type = node.type;
			const memoType = typeof type === "object" && type !== null && "type" in type ? type : undefined;
			const original = memoType ? memoType.type : type;
			if (typeof original === "function" && original.name === "NonCollapsableGestureDetector")
				return wrapPanel(node.props.children);
			if (
				typeof original === "function" &&
				(original.name === "LeftMenuTabsInner" || original.name === "LeftPanelHomeDrawerContainer" || original.name === "LeftPanelContent")
			) {
				let Wrapper = wrappers.get(type);
				if (!Wrapper) {
					const render = original;
					const Component =
						original.name === "LeftPanelContent"
							? function ServerDrawerLeftPanelContent(props) {
									const active = useActive();
									const rendered = render(active && "panelStyles" in props ? { ...props, panelStyles: undefined } : props);
									const [ready, setReady] = useState(false);
									useEffect(() => { setReady(true); }, []);
									return ready ? initialize(rendered) : rendered;
								}
							: function ServerDrawerPanelContainer(props) {
									const active = useActive();
									const rendered = render(props);
									return active ? wrapPanel(rendered) : rendered;
								};
					Wrapper = memoType ? memo(Component, memoType.compare) : Component;
					wrappers.set(type, Wrapper);
				}
				return h(Wrapper, { key: node.key, ...node.props });
			}
			const children = wrapPanel(node.props.children);
			return children === node.props.children ? node : React.cloneElement(node, { children });
		};

		track(patcher.after("type", mainChannels.default, (_args, ret) => wrapPanel(ret)));
	}

	// -------------------------------------------------------------- settings

	function Settings() {
		useProxy(storage);
		const { FormSection, FormSwitchRow, FormRow, FormSwitch } = ui.components.Forms;
		const label = "Pull down to mark all as read";
		const subLabel = "Pull the collapsed dock down until it is flat, then release to mark all servers and DMs as read.";
		return h(
			ScrollView,
			{ style: { flex: 1 } },
			h(
				FormSection,
				{ title: "Gestures" },
				FormSwitchRow
					? h(FormSwitchRow, { label, subLabel, value: !!storage.pullToMarkRead, onValueChange: v => { storage.pullToMarkRead = v; } })
					: h(FormRow, {
							label,
							subLabel,
							trailing: h(FormSwitch, { value: !!storage.pullToMarkRead, onValueChange: v => { storage.pullToMarkRead = v; } }),
						}),
			),
		);
	}

	// ---------------------------------------------------------------- plugin

	const unpatches = [];
	let session;

	return {
		onLoad() {
			ensureDefaults();
			session = { aborted: false, listeners: new Set() };
			try {
				start(session, unpatch => { unpatches.push(unpatch); return unpatch; });
			} catch (error) {
				reportError(error);
				try { ui.toasts.showToast("Server Drawer failed to start: " + (error && error.message)); } catch (e) {}
			}
		},
		onUnload() {
			if (session) {
				session.aborted = true;
				session.listeners.forEach(listener => { try { listener(); } catch (e) {} });
				session.listeners.clear();
			}
			while (unpatches.length) {
				try { unpatches.pop()(); } catch (e) {}
			}
		},
		settings: Settings,
	};
})()
