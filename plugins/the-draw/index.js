(function () {
    "use strict";

    const TAG = "[Server Drawer]";
    const { metro, patcher, ui } = vendetta;
    const storage = vendetta.plugin.storage;
    const { useProxy } = vendetta.storage;
    const { React, ReactNative: Native } = metro.common;
    const h = React.createElement;
    const { Fragment, memo, useEffect, useMemo, useReducer, useRef, useState } = React;
    const startTransition = React.startTransition || (fn => fn());
    const { Animated, Image, Pressable, ScrollView, Text, TextInput, View } = Native;

    const reportError = error => console.error(TAG, error);
    const safe = (fn, fallback) => {
        try {
            return fn();
        } catch {
            return fallback;
        }
    };
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    const props = (...names) => safe(() => metro.findByProps(...names));
    const store = name => safe(() => metro.findByStoreName(name));
    const named = (name, defaultExport = true) => safe(() => metro.findByName(name, defaultExport));

    const unwrap = (mod, key) => {
        if (mod == null) return undefined;
        if (mod[key] !== undefined) return mod;
        if (mod.default && mod.default[key] !== undefined) return mod.default;
        return undefined;
    };
    const lookup = (...names) => unwrap(props(...names), names[0]);
    const member = (lib, name, ...alsoRequire) => {
        if (lib && lib[name] !== undefined) return lib[name];
        if (!alsoRequire.length) return undefined;
        const found = unwrap(props(name, ...alsoRequire), name);
        return found ? found[name] : undefined;
    };

    function toast(text) {
        safe(() => ui.toasts.showToast(text, safe(() => ui.assets.getAssetIDByName("CircleXIcon-primary"))));
    }

    function reportActionFailure(operation, error) {
        reportError(error);
        toast(`Could not ${operation}. Please try again.`);
    }

    function createAbort() {
        const listeners = new Set();
        const signal = {
            aborted: false,
            addEventListener(type, fn) {
                if (type === "abort") listeners.add(fn);
            },
            removeEventListener(type, fn) {
                listeners.delete(fn);
            },
        };
        return {
            signal,
            abort() {
                if (signal.aborted) return;
                signal.aborted = true;
                for (const fn of [...listeners]) {
                    try {
                        fn();
                    } catch (error) {
                        reportError(error);
                    }
                }
            },
        };
    }

    function eachExport(visit) {
        const registry = metro.modules || globalThis.modules;
        if (!registry) return undefined;
        for (const id in registry) {
            const record = registry[id];
            if (!record || !record.isInitialized) continue;
            let exports;
            try {
                exports = record.publicModule && record.publicModule.exports;
            } catch {
                continue;
            }
            if (!exports || (typeof exports !== "object" && typeof exports !== "function")) continue;
            try {
                const hit = visit(exports);
                if (hit) return hit;
            } catch {
            }
        }
        return undefined;
    }

    function holderFor(holder, key, name) {
        const value = holder[key];
        if (!value) return undefined;
        if (typeof value === "function") {
            if (key === name || value.name === name || value.displayName === name) return { target: holder, key };
            return undefined;
        }
        if (typeof value === "object") {
            if (typeof value.type === "function" && (value.type.name === name || value.displayName === name || value.type.displayName === name))
                return { target: value, key: "type" };
            if (typeof value.render === "function" && (value.render.name === name || value.displayName === name))
                return { target: value, key: "render" };
            if (typeof value.type === "object" && value.type && typeof value.type.render === "function" && value.type.render.name === name)
                return { target: value.type, key: "render" };
        }
        return undefined;
    }

    function locateComponent(name) {
        return eachExport(exports => {
            for (const key of ["default", ...Object.keys(exports)]) {
                let hit;
                try {
                    hit = holderFor(exports, key, name);
                } catch {
                    continue;
                }
                if (hit) return hit;
            }
            return undefined;
        });
    }

    function describeCandidates(pattern) {
        const seen = new Set();
        eachExport(exports => {
            for (const key of ["default", ...Object.keys(exports)]) {
                let value;
                try {
                    value = exports[key];
                } catch {
                    continue;
                }
                const fn = typeof value === "function" ? value : value && (value.type || value.render);
                const label = (typeof fn === "function" && fn.name) || (typeof value === "function" ? "" : value && value.displayName) || key;
                if (typeof label === "string" && pattern.test(label)) seen.add(`${key}:${label}`);
            }
            return undefined;
        });
        return [...seen].slice(0, 40);
    }

    function waitFor(find, callback, onTimeout, { interval = 400, attempts = 50 } = {}) {
        let stopped = false;
        let tries = 0;
        let timer;
        const run = () => {
            if (stopped) return true;
            const found = safe(find);
            if (found) {
                callback(found);
                return true;
            }
            if (++tries >= attempts) {
                if (onTimeout) onTimeout();
                return true;
            }
            return false;
        };
        if (!run()) {
            timer = setInterval(() => {
                if (run()) clearInterval(timer);
            }, interval);
        }
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }

    function ensureDefaults() {
        if (!Array.isArray(storage.dmOrder)) storage.dmOrder = [];
        if (storage.layout !== "list" && storage.layout !== "grid") storage.layout = "grid";
        if (typeof storage.pullToMarkRead !== "boolean") storage.pullToMarkRead = false;
    }

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

        return {
            dockHeight: itemSize + 32,
            dockWidth,
            itemCountNoExtras: itemCount - 2,
            itemSize,
        };
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

    let nativeCache;
    function getNative() {
        if (nativeCache) return nativeCache;

        const tokensModule = props("unsafe_rawColors");
        const tokens =
            tokensModule && (tokensModule.default && tokensModule.default.colors ? tokensModule.default : tokensModule);
        const semanticColors = (tokens && tokens.colors) || safe(() => ui.semanticColors) || {};
        const rawColors = (tokens && tokens.unsafe_rawColors) || safe(() => ui.rawColors) || {};

        const found = props("TableRowGroup");
        const lib = (found && (found.TableRowGroup ? found : found.default)) || {};
        const design = {
            createStyles: member(lib, "createStyles", "createStyles"),
            ContextMenu: member(lib, "ContextMenu"),
            Text: lib.Text || Text,
            TableRowGroup: lib.TableRowGroup,
            TableSwitchRow: lib.TableSwitchRow,
            SegmentedControl: member(lib, "SegmentedControl"),
            Tabs: member(lib, "Tabs"),
            useSegmentedControlState: member(lib, "useSegmentedControlState", "useSegmentedControlState"),
        };

        const names = [
            "ChannelStore",
            "GuildReadStateStore",
            "GuildStore",
            "PrivateChannelSortStore",
            "ReadStateStore",
            "SelectedChannelStore",
            "SelectedGuildStore",
            "SortedGuildStore",
            "UserGuildSettingsStore",
            "UserStore",
        ];
        const stores = {};
        for (const name of names) {
            stores[name] = store(name);
            if (!stores[name]) throw new Error(`Server Drawer: ${name} is unavailable`);
        }

        const fluxUtils = lookup("useStateFromStores");
        if (!fluxUtils) throw new Error("Server Drawer: useStateFromStores is unavailable");
        const tokenHook = lookup("useToken");

        nativeCache = {
            design,
            semanticColors,
            rawColors,
            stores,
            useStateFromStores: fluxUtils.useStateFromStores,
            useToken: tokenHook && tokenHook.useToken,
            contextMenu: lookup("ContextMenuStore", "hideContextMenu"),
            accessibility: store("AccessibilityStore"),
        };
        return nativeCache;
    }

    function makeStyles(sheet, design) {
        if (typeof design.createStyles === "function") return design.createStyles(sheet);
        const themed =
            safe(() => metro.common.stylesheet.createThemedStyleSheet(sheet)) || Native.StyleSheet.create(sheet);
        return () => themed;
    }

    function createDragMotion({ Gesture, GestureDetector }, longPressMs) {
        const timings = lookup("timingStandard", "timingFast");
        const timingStandard = (timings && timings.timingStandard) || { duration: 300 };

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
            const style = useMemo(
                () => (offset ? { transform: offset.getTranslateTransform() } : undefined),
                [offset],
            );
            const previousOffset = useRef(properties.offset);

            useEffect(() => {
                if (
                    previousOffset.current?.x === properties.offset?.x &&
                    previousOffset.current?.y === properties.offset?.y
                )
                    return;
                previousOffset.current = properties.offset;
                if (!offset) return;
                const animation = Animated.timing(offset, {
                    duration: timingStandard?.duration ?? 300,
                    toValue: properties.offset ?? { x: 0, y: 0 },
                    useNativeDriver: true,
                });
                animation.start();

                return () => animation.stop();
            }, [offset, properties.offset?.x, properties.offset?.y]);

            const gesture = useMemo(
                () =>
                    Gesture.Pan()
                        .runOnJS(true)
                        .activateAfterLongPress(longPressMs)
                        .shouldCancelWhenOutside(false)
                        .onStart(event => {
                            x.setValue(event.absoluteX);
                            y.setValue(event.absoluteY);
                            scale.stopAnimation();
                            Animated.timing(scale, {
                                ...timingStandard,
                                toValue: 1.05,
                                useNativeDriver: true,
                            }).start();
                            callbacks.current.onStart({
                                x: event.absoluteX,
                                y: event.absoluteY,
                            });
                        })
                        .onUpdate(event => {
                            x.setValue(event.absoluteX);
                            y.setValue(event.absoluteY);
                            callbacks.current.onMove({ x: event.absoluteX, y: event.absoluteY });
                        })
                        .onEnd((event, success) => {
                            if (success)
                                callbacks.current.onDrop({
                                    x: event.absoluteX,
                                    y: event.absoluteY,
                                });
                        })
                        .onFinalize((_event, success) => {
                            scale.stopAnimation();
                            scale.setValue(1);
                            if (!success) callbacks.current.onCancel();
                        }),
                [x, y, scale],
            );

            return h(
                GestureDetector,
                { gesture },
                h(Animated.View, { collapsable: false, style }, properties.children),
            );
        }

        return { DragTarget, usePreview };
    }

    function createDrawerMotion(Gesture, native) {
        const panels = unwrap(
            props("DEFAULT_PANELS_ANIMATION_CONFIG", "ANDROID_PANELS_ANIMATION_CONFIG"),
            "DEFAULT_PANELS_ANIMATION_CONFIG",
        );
        const springs = unwrap(props("SUBTLE_SPRING", "springStandard"), "SUBTLE_SPRING");
        const subtleSpring = (springs && springs.SUBTLE_SPRING) || { mass: 1, stiffness: 260, damping: 26 };
        const accessibility = native.accessibility;
        const fallbackConfig = {
            nonSwipeSidePanelOpen: { duration: 250 },
            nonSwipeSidePanelClose: { duration: 200 },
            touchSlopForPanGesture: 10,
            minFlingVelocityX: 500,
        };
        const config =
            (panels && (Native.Platform.OS === "android" ? panels.ANDROID_PANELS_ANIMATION_CONFIG : panels.DEFAULT_PANELS_ANIMATION_CONFIG)) ||
            fallbackConfig;
        const isTimingConfig =
            panels && typeof panels.isTimingConfig === "function"
                ? panels.isTimingConfig
                : animation => !!animation && animation.duration !== undefined;

        if (typeof Gesture?.Pan !== "function") throw new Error("Server Drawer: native gestures are unavailable");

        const reducedMotion = () => !!(accessibility && accessibility.useReducedMotion);

        const animate = (value, next, open, complete) => {
            const animation = open ? config.nonSwipeSidePanelOpen : config.nonSwipeSidePanelClose;

            if (reducedMotion()) {
                value.stopAnimation();
                value.setValue(next);
                complete?.({ finished: true });
                return;
            }

            if (isTimingConfig(animation)) {
                const easing = typeof animation.easing === "object" ? animation.easing.factory() : animation.easing;
                Animated.timing(value, {
                    ...animation,
                    easing,
                    toValue: next,
                    useNativeDriver: true,
                }).start(complete);
            } else {
                Animated.spring(value, {
                    ...animation,
                    toValue: next,
                    useNativeDriver: true,
                }).start(complete);
            }
        };

        const spring = (value, next, velocity = 0) => {
            value.stopAnimation();
            if (reducedMotion()) value.setValue(next);
            else
                Animated.spring(value, {
                    ...subtleSpring,
                    velocity,
                    toValue: next,
                    useNativeDriver: true,
                }).start();
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
                const listener = translate.addListener(({ value }) => {
                    position.current = value;
                });

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

            const gestures = useMemo(() => {
                const configure = () => {
                    let active = false;
                    let pulling;

                    const pan = Gesture.Pan()
                        .runOnJS(true)
                        .shouldCancelWhenOutside(false)
                        .enabled(!dragging && (!expanded || listAtTop))
                        .activeOffsetY(
                            canPull
                                ? [-config.touchSlopForPanGesture, config.touchSlopForPanGesture]
                                : expanded
                                  ? config.touchSlopForPanGesture
                                  : -config.touchSlopForPanGesture,
                        );

                    if (!canPull)
                        pan.failOffsetY(
                            expanded ? -config.touchSlopForPanGesture : config.touchSlopForPanGesture,
                        );

                    return pan
                        .failOffsetX([-config.touchSlopForPanGesture, config.touchSlopForPanGesture])
                        .onStart(event => {
                            active = true;
                            pulling = canPull ? undefined : false;
                            translate.stopAnimation();
                            origin.current =
                                Math.max(0, Math.min(distance, position.current)) - event.translationY;
                        })
                        .onUpdate(event => {

                            if (pulling === undefined && event.translationY !== 0)
                                pulling = event.translationY > 0;
                            position.current = pulling
                                ? distance +
                                  Math.min(flattenDistance, Math.max(0, event.translationY) * 0.75)
                                : Math.max(0, Math.min(distance, origin.current + event.translationY));
                            translate.setValue(position.current);
                        })
                        .onEnd((event, success) => {
                            if (!success) return;
                            if (pulling) {
                                const complete = position.current >= distance + flattenDistance;
                                settle(distance);
                                if (complete) markRead.current?.();
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
                compactStyle: {
                    opacity: translate.interpolate({
                        inputRange: [0, distance],
                        outputRange: [0, 1],
                        extrapolate: "clamp",
                    }),
                },
                expandedStyle: {
                    opacity: translate.interpolate({
                        inputRange: [0, distance],
                        outputRange: [1, 0],
                        extrapolate: "clamp",
                    }),
                },
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
                        const dms =
                            Math.abs(event.velocityX) > config.minFlingVelocityX
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
                progress.interpolate({
                    inputRange: [0, 1],
                    outputRange,
                    extrapolate: "clamp",
                });

            return {
                rootStyle: {
                    opacity: interpolate([1, 0]),
                    transform: [{ translateY: interpolate([0, -24]) }],
                },
                folderStyle: {
                    opacity: interpolate([0, 1]),
                    transform: [{ translateY: interpolate([24, 0]) }],
                },
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
                folderId: folderId ?? retainedId,
                backdropStyle: { opacity: progress },
                panelStyle: {
                    transform: [
                        {
                            translateY: progress.interpolate({
                                inputRange: [0, 1],
                                outputRange: [24, 0],
                                extrapolate: "clamp",
                            }),
                        },
                    ],
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
        };
    }

    const VIEW_OPTIONS = [
        ["servers", "Servers"],
        ["dms", "Direct Messages"],
    ];
    const FILTER_OPTIONS = [
        ["all", "All"],
        ["unread", "Unreads"],
    ];

    function createServerDrawer(signal) {
        const native = getNative();
        const {
            design,
            semanticColors,
            rawColors,
            stores,
            useStateFromStores,
            useToken,
            contextMenu,
        } = native;
        const {
            ChannelStore,
            GuildReadStateStore,
            GuildStore,
            PrivateChannelSortStore,
            ReadStateStore,
            SelectedChannelStore,
            SelectedGuildStore,
            SortedGuildStore,
            UserGuildSettingsStore,
            UserStore,
        } = stores;
        const DText = design.Text;
        const FlashList = (lookup("FlashList") || {}).FlashList;
        const List = FlashList || Native.FlatList;

        const BORDER_WIDTH = 1;
        const ICON_SIZE = 52;
        const ITEM_WIDTH = ICON_SIZE + 12;
        const ITEM_GAP = 12;
        const SIDE_PADDING = 16;

        const FLOATING_YOU_BAR = Native.Platform.OS === "ios";
        const YOU_BAR_JOIN_DEPTH = FLOATING_YOU_BAR ? 0 : 24;

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

        const LONG_PRESS_MS = 500;
        const CENTER = { alignItems: "center", justifyContent: "center" };
        const ROW = { alignItems: "center", flexDirection: "row" };
        const EMPTY_SNAPSHOT = Object.freeze({
            nodes: [],
            directMessages: [],
        });

        const useColor = (name, fallback) => {
            const token = semanticColors[name];
            const value = token !== undefined && useToken ? useToken(token) : undefined;
            return value !== undefined && value !== null ? value : fallback;
        };

        const useStyles = makeStyles(
            {
                mentionBadge: {
                    ...CENTER,
                    backgroundColor: semanticColors.STATUS_DANGER,
                    borderColor: semanticColors.BACKGROUND_BASE_LOWEST,
                    borderRadius: 10,
                    borderWidth: 2,
                    paddingHorizontal: 4,
                    position: "absolute",
                },
                unreadBadge: {
                    backgroundColor: semanticColors.TEXT_DEFAULT,
                    borderColor: semanticColors.BACKGROUND_BASE_LOWEST,
                    borderRadius: 7,
                    borderWidth: 2,
                    position: "absolute",
                },
                compactSelection: {
                    borderColor: semanticColors.TEXT_MUTED,
                    borderWidth: 3,
                    bottom: -3,
                    left: -3,
                    position: "absolute",
                    right: -3,
                    top: -3,
                },
                listItem: {
                    alignItems: "center",
                    borderRadius: 12,
                    flexDirection: "row",
                    gap: 14,
                    minHeight: 68,
                    paddingHorizontal: 10,
                    width: "100%",
                },
                gridItem: { alignItems: "center", minHeight: 82, width: ITEM_WIDTH },
                selectionRing: { ...CENTER, borderWidth: 3, height: 62, width: 62 },
                gridLabel: { marginTop: 4, textAlign: "center", width: 68 },
                previewFrame: {
                    alignItems: "center",
                    backgroundColor: semanticColors.BACKGROUND_SECONDARY_ALT,
                    borderColor: semanticColors.BORDER_SUBTLE,
                    borderWidth: 1,
                    elevation: 18,
                    shadowColor: rawColors.BLACK,
                    shadowOffset: { height: 8, width: 0 },
                    shadowRadius: 12,
                },
                listPreview: {
                    borderRadius: 14,
                    flexDirection: "row",
                    gap: 14,
                    height: 68,
                    paddingHorizontal: 10,
                    shadowOpacity: 0.35,
                },
                gridPreview: {
                    borderRadius: 20,
                    minHeight: 82,
                    paddingTop: 5,
                    shadowOpacity: 0.4,
                    width: ITEM_WIDTH,
                },
                folderInput: {
                    color: semanticColors.TEXT_DEFAULT,
                    fontSize: 20,
                    padding: 4,
                    borderBottomWidth: 1,
                    borderColor: semanticColors.TEXT_BRAND,
                },
                dmButton: {
                    ...CENTER,
                    backgroundColor: semanticColors.BACKGROUND_SECONDARY_ALT,
                    borderRadius: 16,
                },
                dockDivider: {
                    alignSelf: "center",
                    backgroundColor: semanticColors.BORDER_SUBTLE,
                    marginHorizontal: -5.5,
                    width: 1,
                },
                dockRow: {
                    ...ROW,
                    gap: DOCK_ITEM_GAP,
                    paddingHorizontal: DOCK_PADDING / 2,
                },
                emptyContainer: { ...CENTER, minHeight: 180, padding: 24 },
                header: { ...ROW, minHeight: 50, paddingHorizontal: 12 },
                searchRow: { gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
                searchField: {
                    ...ROW,
                    backgroundColor: semanticColors.BACKGROUND_SECONDARY_ALT,
                    borderRadius: 10,
                    gap: 8,
                    height: 40,
                    paddingHorizontal: 10,
                },
                searchInput: { flex: 1, fontSize: 16, padding: 0 },
                fallbackTabs: { ...ROW, gap: 6 },
                fallbackTab: { ...CENTER, borderRadius: 10, flex: 1, minHeight: 36, paddingHorizontal: 10 },
                handle: { ...CENTER, height: 16, width: "100%" },
                handleBar: {
                    backgroundColor: semanticColors.TEXT_MUTED,
                    borderRadius: 3,
                    height: 5,
                    opacity: 0.5,
                    width: 38,
                },
                exitTarget: {
                    ...CENTER,
                    width: 56,
                    height: 56,
                    position: "absolute",
                    zIndex: 110,
                    elevation: 65,
                },
                folderBackdrop: {
                    alignItems: "center",
                    bottom: 0,
                    justifyContent: "center",
                    left: 0,
                    position: "absolute",
                    right: 0,
                    top: 0,
                    zIndex: 60,
                },
                folderPanel: {
                    alignItems: "center",
                    backgroundColor: semanticColors.BACKGROUND_SECONDARY_ALT,
                    borderRadius: 40,
                    elevation: 45,
                    overflow: "hidden",
                },
                folderPage: {
                    alignContent: "flex-start",
                    ...ROW,
                    flexWrap: "wrap",
                    gap: 8,
                    paddingBottom: 28,
                    paddingHorizontal: 10,
                    paddingTop: 52,
                },
                folderHeading: { position: "absolute", top: 8, left: 20, right: 20 },
                pageDots: {
                    alignItems: "center",
                    bottom: 8,
                    flexDirection: "row",
                    gap: 5,
                    justifyContent: "center",
                    position: "absolute",
                },
                pageDot: {
                    borderRadius: 3,
                    height: 7,
                    marginHorizontal: 4,
                    marginVertical: 10,
                    width: 7,
                },
                dragPreview: { elevation: 60, position: "absolute", top: 0, zIndex: 100 },
                drawerBackdrop: {
                    bottom: 0,
                    left: 0,
                    position: "absolute",
                    right: 0,
                    top: 0,
                    zIndex: 0,
                },
                drawerPanel: {
                    backgroundColor: semanticColors.BACKGROUND_BASE_LOWEST,
                    borderColor: semanticColors.BORDER_SUBTLE,
                    borderTopLeftRadius: 24,
                    borderTopRightRadius: 24,
                    borderWidth: BORDER_WIDTH,
                    borderBottomWidth: 0,
                    elevation: 0,
                    overflow: "hidden",
                    position: "absolute",
                    zIndex: 0,
                },
                compactFace: {
                    backgroundColor: semanticColors.BACKGROUND_BASE_LOWEST,
                    position: "absolute",
                    top: 16,
                    left: 0,
                    right: 0,
                    zIndex: 2,
                },
                expandedFace: {
                    backgroundColor: semanticColors.BACKGROUND_BASE_LOWEST,
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: 16,
                    zIndex: 1,
                },
            },
            design,
        );

        function getDrawerGeometry(width, height, layout) {
            const dockSpecs = computeGuildDockSpecs(width - 16);
            const grid = layout === "grid";
            const contentWidth = dockSpecs.dockWidth - SIDE_PADDING * 2;
            const columns = grid
                ? Math.max(3, Math.floor((contentWidth + ITEM_GAP) / (ITEM_WIDTH + ITEM_GAP)))
                : 1;
            const columnStep = grid
                ? Math.max(ITEM_WIDTH + ITEM_GAP, (contentWidth - ITEM_WIDTH) / (columns - 1))
                : ITEM_WIDTH;
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

        function Icon({ name, color, size = 24, label, onPress, buttonSize = 44 }) {
            const asset = safe(() => ui.assets.getAssetIDByName(name));
            const image = asset
                ? h(Image, { source: asset, style: { width: size, height: size, tintColor: color } })
                : h(View, { style: { width: size, height: size } });

            return label
                ? h(
                      Pressable,
                      {
                          accessibilityLabel: label,
                          accessibilityRole: "button",
                          onPress,
                          style: { ...CENTER, height: buttonSize, width: buttonSize },
                      },
                      image,
                  )
                : image;
        }

        const initials = name =>
            name
                .trim()
                .split(/\s+/u)
                .slice(0, 2)
                .map(piece => piece[0])
                .join("")
                .toUpperCase() || "?";

        function createController() {
            const iconUtils = lookup("getGuildIconURL", "getChannelIconURL");
            const actions = lookup("moveById", "createGuildFolderLocal", "editGuildFolderLocal");
            const folderSettings = lookup("saveGuildFolders");
            const channelNavigation = lookup("transitionToChannel");
            const guildBarNavigation =
                named("transitionGuildsBarToGuildOrOpenSelectedChannel") ||
                (() => {
                    const nav = lookup("transitionToGuild");
                    return nav ? id => nav.transitionToGuild(id) : undefined;
                })();

            const nativeActions = [
                actions?.moveById,
                actions?.createGuildFolderLocal,
                actions?.editGuildFolderLocal,
                guildBarNavigation,
                channelNavigation?.transitionToChannel,
                folderSettings?.saveGuildFolders,
            ];
            if (
                !iconUtils ||
                !actions ||
                !folderSettings ||
                !channelNavigation ||
                !guildBarNavigation ||
                nativeActions.some(action => typeof action !== "function")
            )
                throw new Error("Server Drawer: a native guild, navigation or account sync action is unavailable");

            const persistFolders = async () => {
                try {

                    await folderSettings.saveGuildFolders(
                        SortedGuildStore.getGuildFolders().map(entry => ({
                            ...entry,
                            guildIds: [...entry.guildIds],
                        })),
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

            const badge = (readStore, id) => ({
                mentionCount: readStore.getMentionCount(id),
                unread: readStore.hasUnread(id),
            });

            const guildNode = (id, folderId) => {
                const guild = GuildStore.getGuild(id);
                if (!guild?.name?.trim()) return [];
                const state = badge(GuildReadStateStore, id);

                return [
                    {
                        id,
                        kind: "guild",
                        name: guild.name,
                        folderId,
                        avatarUri: guild.icon
                            ? iconUtils.getGuildIconURL({
                                  id,
                                  icon: guild.icon,
                                  size: 128,
                                  canAnimate: false,
                              })
                            : undefined,
                        animatedAvatarUri: guild.icon?.startsWith("a_")
                            ? iconUtils.getGuildIconURL({
                                  id,
                                  icon: guild.icon,
                                  size: 128,
                                  canAnimate: true,
                              })
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

                return user ? `${id}.${user.avatar ?? ""}.${user.globalName || user.username}` : id;
            };

            const guildKey = id => {
                const guild = GuildStore.getGuild(id);
                if (!guild?.name?.trim()) return "";
                const state = badge(GuildReadStateStore, id);

                return `${id}.${guild.name}.${guild.icon ?? ""}.${state.mentionCount}.${state.unread ? 1 : 0}`;
            };

            const snapshotKey = () =>
                [
                    SelectedGuildStore.getGuildId() ?? "",
                    SelectedChannelStore.getChannelId() ?? "",
                    ...SortedGuildStore.getGuildFolders().map(
                        entry =>
                            `${entry.folderId ?? ""}.${entry.folderName ?? ""}.${entry.folderColor ?? ""}.${entry.guildIds.map(guildKey).join(",")}`,
                    ),
                    ...PrivateChannelSortStore.getPrivateChannelIds().map(id => {
                        const channel = privateChannel(id);
                        if (!channel) return "";
                        const state = badge(ReadStateStore, id);

                        return `${id}.${channel.name ?? ""}.${channel.icon ?? ""}.${(channel.recipients ?? []).map(userKey).join(",")}.${state.mentionCount}.${state.unread ? 1 : 0}`;
                    }),
                ].join("\u0000");

            const buildSnapshot = () => {
                const nodes = SortedGuildStore.getGuildFolders().flatMap(entry => {
                    const id = entry.folderId == null ? undefined : String(entry.folderId);
                    const children = entry.guildIds.flatMap(guild => guildNode(guild, id));
                    if (id === undefined) return children;

                    return [
                        {
                            id,
                            kind: "folder",
                            children,
                            name: entry.folderName?.trim() || undefined,
                            color: entry.folderColor,
                            mentionCount: children.reduce((total, guild) => total + guild.mentionCount, 0),
                            unread: children.some(guild => guild.unread),
                        },
                    ];
                });

                const directMessages = PrivateChannelSortStore.getPrivateChannelIds().flatMap(id => {
                    const channel = privateChannel(id);
                    if (!channel) return [];

                    const users = (channel.recipients ?? [])
                        .map(recipient => UserStore.getUser(recipient))
                        .filter(user => user !== undefined);
                    const avatarUri =
                        channel.type === 1
                            ? users[0]?.getAvatarURL?.(undefined, 128, false)
                            : channel.icon
                              ? iconUtils.getChannelIconURL({
                                    id,
                                    icon: channel.icon,
                                    size: 128,
                                })
                              : undefined;

                    const animatedAvatarUri =
                        channel.type === 1 && users[0]?.avatar?.startsWith("a_")
                            ? users[0].getAvatarURL(undefined, 128, true)
                            : undefined;

                    return [
                        {
                            id,
                            avatarUri,
                            animatedAvatarUri,
                            ...badge(ReadStateStore, id),
                            name:
                                channel.name ||
                                users.map(user => user.globalName || user.username).join(", ") ||
                                "Direct Message",
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

            return {
                markAllRead() {
                    const markGuildsAsRead = named("markGuildsAsRead");
                    const readActions = lookup("bulkAck", "ackChannel");
                    const readTypes = lookup("ReadStateTypes");
                    const ReadStateTypes = readTypes?.ReadStateTypes;

                    if (
                        typeof markGuildsAsRead !== "function" ||
                        typeof readActions?.bulkAck !== "function" ||
                        typeof ReadStateTypes?.CHANNEL !== "number" ||
                        typeof ReadStateStore.lastMessageId !== "function"
                    ) {
                        throw new Error("Server Drawer: native mark read actions are unavailable");
                    }

                    const channels = PrivateChannelSortStore.getPrivateChannelIds().map(channelId => ({
                        channelId,
                        readStateType: ReadStateTypes.CHANNEL,
                        messageId: ReadStateStore.lastMessageId(channelId),
                    }));
                    markGuildsAsRead(
                        SortedGuildStore.getGuildFolders().flatMap(entry => entry.guildIds),
                        "ServerDrawer",
                    );
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
                            !!target?.guildIds.includes(sourceId) &&
                            editFolder(
                                target,
                                target.guildIds.filter(id => id !== sourceId),
                            )
                        );
                    const source = mode === "move" ? folder(sourceId) : undefined;
                    if (
                        sourceId === targetId ||
                        (!source && !guildExists(sourceId)) ||
                        (!target && !guildExists(targetId))
                    )
                        return false;

                    if (mode === "move")
                        return mutate(() => {
                            const folders = SortedGuildStore.getGuildFolders();
                            const siblings =
                                folders.find(
                                    entry => entry.folderId !== undefined && entry.guildIds.includes(sourceId),
                                )?.guildIds ?? folders.map(entry => entry.folderId ?? entry.guildIds[0]);
                            moveToSlot(
                                (from, to) => actions.moveById(from, to),
                                siblings,
                                source?.folderId ?? sourceId,
                                target?.folderId ?? targetId,
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
                    const modal = lookup("openCreateGuildModal");
                    if (!modal) throw new Error("Server Drawer: create server action is unavailable");
                    modal.openCreateGuildModal();
                },

                openCreateDm() {
                    const navigation = lookup("getRootNavigationRef");
                    const navigator = navigation?.getRootNavigationRef()?.current;

                    return navigator
                        ? navigator.navigate("friends", {
                              screen: "new-message",
                              params: { sourcePage: "NEW_MESSAGE_COMPOSER" },
                          })
                        : false;
                },

                animateNext: duration =>
                    Native.LayoutAnimation.configureNext({
                        duration: duration ?? 110,
                        update: { type: Native.LayoutAnimation.Types.easeInEaseOut },
                    }),
            };
        }

        function createGuildMenu(menuSignal, folder = false) {
            const getItems = folder
                ? lookup("getGuildFolderMenuItems")?.getGuildFolderMenuItems
                : named("getGuildsBarGuildMenuItems");
            const ContextMenu = design.ContextMenu;

            if (typeof getItems !== "function" || !ContextMenu)
                return function GuildMenu({ children }) {
                    return children({});
                };

            const wrap = item => ({
                ...item,
                async action() {
                    try {
                        await item.action();
                    } catch (error) {
                        reportActionFailure("complete this server action", error);
                    }
                },
            });

            return function GuildMenu({ guild, children }) {

                const id = folder ? Number(guild.id) : guild.id;

                const labels = useStateFromStores(
                    [GuildStore, UserGuildSettingsStore],
                    () =>
                        getItems(id)
                            .map(item => item.label)
                            .join("\u0000"),
                    [guild.id],
                );
                const items = useMemo(() => getItems(id).map(wrap), [guild.id, labels]);
                useEffect(() => {
                    const close = () => {
                        if (contextMenu?.ContextMenuStore.getState().menu?.items === items)
                            contextMenu.hideContextMenu();
                    };
                    menuSignal.addEventListener("abort", close);

                    return () => {
                        menuSignal.removeEventListener("abort", close);
                        close();
                    };
                }, [items]);

                return h(
                    ContextMenu,
                    { items, title: guild.name, triggerOnLongPress: true, disableGesture: true },
                    children,
                );
            };
        }

        function createServerDrawerSurface(controller, surfaceSignal) {
            const GuildMenu = createGuildMenu(surfaceSignal);
            const FolderMenu = createGuildMenu(surfaceSignal, true);
            const useSafeAreaInsets =
                lookup("useSafeAreaInsets")?.useSafeAreaInsets || (() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
            const backPress = lookup("useNavigatorBackPressHandler");
            const useNavigatorBackPressHandler = backPress
                ? backPress.useNavigatorBackPressHandler
                : handler => {
                      useEffect(() => {
                          const sub = Native.BackHandler.addEventListener("hardwareBackPress", handler);
                          return () => sub.remove();
                      });
                  };
            const gestures = lookup("Gesture", "GestureDetector");
            if (!gestures) throw new Error("Server Drawer: native gestures are unavailable");
            const { Gesture, GestureDetector } = gestures;
            const {
                touchSlop,
                AnimatedView,
                AnimatedPressable,
                useDrawerMotion,
                usePageMotion,
                useFolderPageMotion,
                useFolderOverlayMotion,
            } = createDrawerMotion(Gesture, native);

            const { DragTarget, usePreview } = createDragMotion({ Gesture, GestureDetector }, LONG_PRESS_MS);

            const DrawerCell = memo(cellProps => cellProps.render.current(cellProps));

            function Badge({ state, compact }) {
                const styles = useStyles();

                if (state.mentionCount)
                    return h(
                        View,
                        {
                            style: [
                                styles.mentionBadge,
                                {
                                    bottom: compact ? -3 : -4,
                                    minHeight: compact ? 18 : 20,
                                    minWidth: compact ? 18 : 20,
                                    right: compact ? -4 : -5,
                                },
                            ],
                        },
                        h(
                            Text,
                            {
                                style: {
                                    color: rawColors.WHITE,
                                    fontSize: compact ? 9 : 10,
                                    fontWeight: "800",
                                },
                            },
                            state.mentionCount > 99 ? "99+" : state.mentionCount,
                        ),
                    );

                return state.unread
                    ? h(View, {
                          style: [
                              styles.unreadBadge,
                              {
                                  bottom: compact ? -2 : -3,
                                  height: compact ? 13 : 14,
                                  right: compact ? -2 : -3,
                                  width: compact ? 13 : 14,
                              },
                          ],
                      })
                    : null;
            }

            const Artwork = memo(function Artwork({ item, size, badged, compact, selected, animate }) {
                const styles = useStyles();
                const background = useColor("BACKGROUND_BASE_LOWER", "#1e1f22");
                const foreground = useColor("TEXT_DEFAULT", "#ffffff");
                const folderBackground = useColor("GUILD_FOLDER_BACKGROUND", "#2b2d31");
                const folder = item.kind === "folder";
                const uri = folder ? undefined : item.avatarUri;
                const source = useMemo(() => (typeof uri === "number" ? uri : { uri }), [uri]);
                const animatedUri =
                    !folder && animate && item.animatedAvatarUri !== uri ? item.animatedAvatarUri : undefined;
                const animatedSource = useMemo(() => ({ uri: animatedUri }), [animatedUri]);
                const radius = !item.kind
                    ? size / 2
                    : size >= 44
                      ? 16
                      : folder
                        ? 9
                        : Math.max(5, Math.round(size * 0.28));
                let fill = item.kind === "guild" ? rawColors.BRAND_500 : background;
                if (folder)
                    fill =
                        item.color === undefined
                            ? folderBackground
                            : `#${item.color.toString(16).padStart(6, "0")}`;

                let body;
                if (folder) {
                    body = item.children.slice(0, 4).map((guild, index) =>
                        h(
                            View,
                            {
                                key: guild.id,
                                style: {
                                    [index % 2 ? "right" : "left"]: 6,
                                    [index < 2 ? "top" : "bottom"]: 6,
                                    position: "absolute",
                                },
                            },
                            h(Artwork, { item: guild, size: Math.floor(size * 0.34) }),
                        ),
                    );
                } else if (uri) {
                    body = h(
                        Fragment,
                        null,
                        h(Image, {
                            accessibilityIgnoresInvertColors: true,
                            resizeMode: "cover",
                            source,
                            fadeDuration: 0,
                            style: { borderRadius: radius, height: size, width: size },
                        }),
                        animatedUri
                            ? h(Image, {
                                  accessibilityIgnoresInvertColors: true,
                                  resizeMode: "cover",
                                  source: animatedSource,
                                  fadeDuration: 0,
                                  style: {
                                      position: "absolute",
                                      borderRadius: radius,
                                      height: size,
                                      width: size,
                                  },
                              })
                            : null,
                    );
                } else {
                    body = h(
                        Text,
                        {
                            numberOfLines: 1,
                            style: {
                                color: item.kind ? rawColors.WHITE : foreground,
                                fontSize: Math.max(10, Math.round(size * 0.34)),
                                fontWeight: "700",
                            },
                        },
                        initials(item.name),
                    );
                }

                return h(
                    View,
                    {
                        style: {
                            ...CENTER,
                            position: "relative",
                            height: size,
                            width: size,
                            borderRadius: radius,
                            backgroundColor: uri ? undefined : fill,
                        },
                    },
                    body,
                    selected
                        ? h(View, {
                              pointerEvents: "none",
                              style: [styles.compactSelection, { borderRadius: size / 3 + 3 }],
                          })
                        : null,
                    badged ? h(Badge, { state: item, compact }) : null,
                );
            });

            function Item({
                item,
                layout = "grid",
                selectedId,
                dragging,
                merging,
                onPress,
                menu,
                compactSize,
                previewWidth,
                animate,
            }) {
                const styles = useStyles();
                const touch = useRef(undefined);
                const moved = useRef(false);
                const press = {
                    onTouchStart: ({ nativeEvent: event }) => {
                        touch.current = { x: event.pageX, y: event.pageY };
                        moved.current = false;
                    },
                    onTouchMove: ({ nativeEvent: event }) => {
                        if (
                            touch.current &&
                            Math.hypot(event.pageX - touch.current.x, event.pageY - touch.current.y) > touchSlop
                        )
                            moved.current = true;
                    },
                    onTouchCancel: () => {
                        moved.current = false;
                    },
                    onPress: () => {

                        const activate = !moved.current;
                        moved.current = false;
                        if (activate) onPress?.();
                    },
                };
                const foreground = useColor("TEXT_DEFAULT", "#ffffff");
                const brand = useColor("TEXT_BRAND", "#5865f2");
                const muted = useColor("TEXT_MUTED", "#949ba4");
                const folder = item.kind === "folder";
                const selected = !folder && item.id === selectedId;
                const label = item.name ?? (compactSize ? "Server folder" : "Folder");
                const accessibilityLabel =
                    label +
                    (item.mentionCount > 0 ? `, ${item.mentionCount} mentions` : item.unread ? ", unread" : "");
                const artwork = h(Artwork, {
                    item,
                    animate,
                    size: compactSize ?? ICON_SIZE,
                    badged: true,
                    compact: !!compactSize,
                    selected: !!compactSize && selected,
                });

                if (compactSize)
                    return h(
                        Pressable,
                        {
                            ...menu,
                            ...press,
                            accessibilityRole: "button",
                            accessibilityLabel: folder ? label : accessibilityLabel,
                            accessibilityState: folder ? undefined : { selected },
                            accessibilityHint: folder ? undefined : "Long press for server actions",
                            delayLongPress: folder ? undefined : LONG_PRESS_MS,
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
                        : h(
                              View,
                              {
                                  style: [
                                      styles.selectionRing,
                                      {
                                          borderColor: highlighted ? brand : "transparent",
                                          borderRadius: item.kind ? 20 : 31,
                                      },
                                  ],
                              },
                              artwork,
                          ),
                    h(
                        DText,
                        {
                            ellipsizeMode: list ? undefined : "tail",
                            numberOfLines: 1,
                            variant: `${list ? "text-md" : "text-xs"}/${selected || previewWidth ? "bold" : "medium"}`,
                            style: [
                                list ? { flex: 1 } : styles.gridLabel,
                                { color: selected ? brand : foreground },
                                previewWidth && !list ? { width: 60 } : undefined,
                            ],
                        },
                        label,
                    ),
                    !previewWidth && list && folder
                        ? h(Icon, { name: "ChevronSmallRightIcon", color: muted, size: 22 })
                        : null,
                );

                if (previewWidth)
                    return h(
                        View,
                        {
                            style: [
                                styles.previewFrame,
                                list ? [styles.listPreview, { width: previewWidth }] : styles.gridPreview,
                            ],
                        },
                        content,
                    );

                return h(
                    Pressable,
                    {
                        ref: menu?.ref,
                        accessibilityActions: menu?.accessibilityActions,
                        onAccessibilityAction: menu?.onAccessibilityAction,
                        accessibilityLabel,
                        accessibilityRole: "button",
                        accessibilityState: { selected },
                        cancelable: !dragging,
                        delayLongPress: LONG_PRESS_MS,
                        ...press,
                        pressRetentionOffset: { bottom: 4096, left: 4096, right: 4096, top: 4096 },
                        style: [
                            list ? styles.listItem : styles.gridItem,
                            { opacity: dragging ? 0.08 : 1 },
                            list ? { backgroundColor: highlighted ? `${brand}24` : "transparent" } : undefined,
                        ],
                    },
                    content,
                );
            }

            function FolderTitle({ folder, style }) {
                const styles = useStyles();
                const TEXT_DEFAULT = useColor("TEXT_DEFAULT", "#ffffff");
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
                            defaultValue: folder.name ?? "",
                            returnKeyType: "done",
                            style: styles.folderInput,
                            onEndEditing: ({ nativeEvent: { text } }) => {
                                try {
                                    if (
                                        text.trim() !== (folder.name ?? "") &&
                                        controller.renameFolder(folder.id, text) === false
                                    )
                                        throw new Error("Folder is no longer available");
                                    setEditing("idle");
                                } catch {
                                    setEditing("error");
                                }
                            },
                        }),
                        editing === "error"
                            ? h(
                                  Text,
                                  { style: { color: TEXT_DEFAULT, fontSize: 12 } },
                                  "Could not rename folder. Try again.",
                              )
                            : null,
                    );

                return h(
                    Pressable,
                    {
                        accessibilityRole: "button",
                        accessibilityLabel: `Rename folder: ${folder.name ?? "Folder"}`,
                        onPress: () => setEditing("editing"),
                        style,
                    },
                    h(DText, { numberOfLines: 1, variant: "heading-lg/bold" }, folder.name || "Folder"),
                );
            }

            function FallbackTabs({ options, value, onChange, filter = false }) {
                const styles = useStyles();
                const foreground = useColor("TEXT_DEFAULT", "#ffffff");
                const muted = useColor("TEXT_MUTED", "#949ba4");
                const brand = useColor("TEXT_BRAND", "#5865f2");

                return h(
                    View,
                    { style: [styles.fallbackTabs, filter ? undefined : { flex: 1 }] },
                    options.map(([id, label]) =>
                        h(
                            Pressable,
                            {
                                key: id,
                                accessibilityRole: "button",
                                accessibilityState: { selected: id === value },
                                onPress: () => id !== value && onChange(id),
                                style: [
                                    styles.fallbackTab,
                                    { backgroundColor: id === value ? `${brand}33` : "transparent" },
                                ],
                            },
                            h(
                                DText,
                                {
                                    numberOfLines: 1,
                                    variant: "text-sm/semibold",
                                    style: { color: id === value ? foreground : muted },
                                },
                                label,
                            ),
                        ),
                    ),
                );
            }

            function NativeTabs({ options, value, onChange, filter = false }) {
                const items = useMemo(() => options.map(([id, label]) => ({ id, label })), [options]);
                const index = items.findIndex(item => item.id === value);
                const state = design.useSegmentedControlState({
                    items,
                    pageWidth: 0,
                    defaultIndex: index,
                    onSetActiveIndex: next => {
                        if (items[next].id !== value) onChange(items[next].id);
                    },
                });
                useEffect(() => {
                    state.setActiveIndex(index, false, true);
                }, [index]);
                return h(
                    View,
                    { style: filter ? undefined : { flex: 1 } },
                    filter
                        ? h(design.SegmentedControl, { state })
                        : h(design.Tabs, { state }),
                );
            }

            const Tabs =
                design.useSegmentedControlState && design.SegmentedControl && design.Tabs ? NativeTabs : FallbackTabs;

            function SearchField({ value, onChange, placeholder }) {
                const styles = useStyles();
                const foreground = useColor("TEXT_DEFAULT", "#ffffff");
                const muted = useColor("TEXT_MUTED", "#949ba4");

                return h(
                    View,
                    { style: styles.searchField },
                    h(Icon, { name: "MagnifyingGlassIcon", color: muted, size: 20 }),
                    h(TextInput, {
                        accessibilityLabel: placeholder,
                        autoCapitalize: "none",
                        autoCorrect: false,
                        placeholder,
                        placeholderTextColor: muted,
                        returnKeyType: "search",
                        value,
                        onChangeText: onChange,
                        style: [styles.searchInput, { color: foreground }],
                    }),
                    value
                        ? h(Icon, {
                              name: "XSmallIcon",
                              label: "Clear search",
                              color: muted,
                              size: 20,
                              buttonSize: 28,
                              onPress: () => onChange(""),
                          })
                        : null,
                );
            }

            function useDrawerData() {
                const stored = useProxy(storage);
                const layout = stored.layout === "list" ? "list" : "grid";

                const snapshot = useStateFromStores(
                    [
                        ChannelStore,
                        GuildReadStateStore,
                        GuildStore,
                        PrivateChannelSortStore,
                        ReadStateStore,
                        SelectedChannelStore,
                        SelectedGuildStore,
                        SortedGuildStore,
                        UserStore,
                    ],
                    () => (surfaceSignal.aborted ? EMPTY_SNAPSHOT : controller.snapshot()),
                );

                const directMessages = useMemo(
                    () => orderedDms(snapshot.directMessages, stored.dmOrder),
                    [snapshot.directMessages, stored.dmOrder],
                );

                const directMessageBadge = useMemo(
                    () =>
                        directMessages.reduce(
                            (total, channel) => ({
                                mentionCount: total.mentionCount + channel.mentionCount,
                                unread: total.unread || channel.unread,
                            }),
                            { mentionCount: 0, unread: false },
                        ),
                    [directMessages],
                );

                return {
                    ...snapshot,
                    layout,
                    directMessages,
                    directMessageBadge,
                    pullToMarkRead: !!stored.pullToMarkRead,
                };
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
                    target?.measureInWindow((x, y, width, height) => {
                        if (exitTarget.current === target) exitBounds.current = { x, y, width, height };
                    });
                };

                const begin = (source, point, items, geometry, openMenu) => {
                    const from = items.indexOf(source);
                    if (from < 0) return;
                    measureExit();
                    clearTimeout(mergeTimer.current);
                    reorder.current = {
                        ...geometry,
                        source,
                        items,
                        from,
                        target: from,
                        start: point,
                        point,
                        openMenu,
                    };
                    refresh();
                };

                const move = ({ x, y }) => {
                    const active = reorder.current;
                    if (!active) return;

                    const {
                        source,
                        from,
                        columns,
                        columnStep,
                        rowStep,
                        target: previousTarget,
                        mergeSince,
                        outside,
                    } = active;
                    const dx = x - active.start.x,
                        dy = y - active.start.y;
                    const grid = active.layout === "grid";

                    active.point = { x, y };
                    active.moved ||= Math.hypot(dx, dy) > 10;

                    active.outside =
                        source.kind === "guild" &&
                        !!source.folderId &&
                        !!exitTarget.current &&
                        hitsDropTarget(active.point, exitBounds.current);
                    active.target = active.outside
                        ? from
                        : clamp(
                              from +
                                  Math.round(dy / rowStep) * columns +
                                  (grid ? Math.round(dx / columnStep) : 0),
                              0,
                              active.items.length - 1,
                          );

                    const target = active.items[active.target];
                    const row = Math.floor(active.target / columns) - Math.floor(from / columns);
                    const column = (active.target % columns) - (from % columns);
                    const centered =
                        Math.abs(dy - row * rowStep) < (grid ? 22 : 20) &&
                        (!grid || Math.abs(dx - column * columnStep) < 22);
                    const merge =
                        source.kind === "guild" &&
                        target.kind &&
                        from !== active.target &&
                        centered &&
                        (target.kind === "folder"
                            ? source.folderId !== target.id
                            : !source.folderId || source.folderId !== target.folderId);
                    active.mergeSince = merge
                        ? previousTarget === active.target
                            ? (mergeSince ?? Date.now())
                            : Date.now()
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

                    if (
                        outside !== active.outside ||
                        !!mergeSince !== !!active.mergeSince ||
                        previousTarget !== active.target
                    )
                        refresh();
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
                    if (showMenu && !moved) return active.openMenu?.();

                    try {
                        if (!source.kind) {
                            const dmOrder = directMessages.map(item => item.id);
                            const sourceIndex = dmOrder.indexOf(source.id),
                                targetIndex = dmOrder.indexOf(items[target].id);
                            if (from === target || sourceIndex < 0 || targetIndex < 0) return;
                            dmOrder.splice(targetIndex, 0, ...dmOrder.splice(sourceIndex, 1));
                            storage.dmOrder = dmOrder;
                        } else {
                            const merge = mergeSince !== undefined && Date.now() - mergeSince >= 450;
                            const exit = outside && source.kind === "guild" && source.folderId;
                            if (!exit && from === target) return;
                            if (
                                controller.commitDrop(
                                    source.id,
                                    exit || items[target].id,
                                    exit ? "exit" : merge ? "merge" : "move",
                                ) === false
                            )
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
                            : target < from && index >= target && index < from
                              ? index + 1
                              : index;

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

            function FolderOverlay({
                folder,
                width,
                height,
                closeFolder,
                renderItem,
                gesture,
                closing,
                backdropStyle,
                panelStyle,
            }) {
                const styles = useStyles();
                const TEXT_DEFAULT = useColor("TEXT_DEFAULT", "#ffffff");
                const TEXT_MUTED = useColor("TEXT_MUTED", "#949ba4");
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
                            style: [styles.folderBackdrop, backdropStyle, { backgroundColor: "rgba(0, 0, 0, 0.82)" }],
                        },
                        h(
                            AnimatedPressable,
                            {
                                accessibilityLabel: folder.name ?? "Unnamed folder",
                                onPress: event => event.stopPropagation(),
                                accessibilityRole: "summary",
                                style: [
                                    styles.folderPanel,
                                    FLOATING_FOLDER_STYLE,
                                    panelStyle,
                                    { height: folderHeight, width: folderSize },
                                ],
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
                                        setFolderPage(
                                            clamp(
                                                Math.round(event.nativeEvent.contentOffset.x / folderSize),
                                                0,
                                                Math.max(0, pages.length - 1),
                                            ),
                                        ),
                                },
                                pages.map((page, pageIndex) =>
                                    h(
                                        View,
                                        {
                                            key: `folder-page-${pageIndex}`,
                                            style: [styles.folderPage, { height: folderHeight, width: folderSize }],
                                        },
                                        page.map(guild => renderItem(guild)),
                                    ),
                                ),
                            ),
                            h(FolderTitle, { key: folder.id, folder, style: styles.folderHeading }),
                            pages.length > 1
                                ? h(
                                      View,
                                      { pointerEvents: "box-none", style: styles.pageDots },
                                      pages.map((_page, index) =>
                                          h(Pressable, {
                                              key: `folder-dot-${index}`,
                                              accessibilityRole: "button",
                                              accessibilityLabel: `Folder page ${index + 1}`,
                                              accessibilityState: { selected: index === folderPage },
                                              onPress: () => {
                                                  setFolderPage(index);
                                                  folderPager.current?.scrollTo({
                                                      animated: true,
                                                      x: index * folderSize,
                                                      y: 0,
                                                  });
                                              },
                                              style: [
                                                  styles.pageDot,
                                                  {
                                                      backgroundColor:
                                                          index === folderPage ? TEXT_DEFAULT : TEXT_MUTED,
                                                  },
                                              ],
                                          }),
                                      ),
                                  )
                                : null,
                        ),
                    ),
                );
            }

            return function ServerDrawerSurface({ bottomInset, onWidthChange }) {
                const styles = useStyles();
                const TEXT_MUTED = useColor("TEXT_MUTED", "#949ba4");
                const TEXT_DEFAULT = useColor("TEXT_DEFAULT", "#ffffff");
                const TEXT_BRAND = useColor("TEXT_BRAND", "#5865f2");
                const [uiState, setUiState] = useState({
                    expanded: false,
                    view: "servers",
                    filter: "all",
                    query: "",
                });
                const setUi = next => setUiState(previous => ({ ...previous, ...next }));
                const { expanded, view, filter, query, folderId, folderOverlayId } = uiState;
                const closeFolder = () => setUi({ folderOverlayId: undefined });
                const changeFolder = nextFolderId =>
                    startTransition(() =>
                        setUi({
                            folderId: nextFolderId,
                            ...(nextFolderId ? { retainedFolderId: nextFolderId } : {}),
                        }),
                    );

                const [{ height: viewportHeight, width: viewportWidth }, setViewport] = useState(() =>
                    Native.Dimensions.get("window"),
                );

                const [listAtTop, setListAtTop] = useState(true);
                const data = useDrawerData();
                const [foreground, setForeground] = useState(Native.AppState.currentState === "active");

                useEffect(() => {
                    const subscription = Native.AppState.addEventListener("change", state =>
                        setForeground(state === "active"),
                    );

                    return () => subscription.remove();
                }, []);

                const {
                    dockSpecs,
                    drawerHeight,
                    panelLeft,
                    grid,
                    columns,
                    columnStep,
                    previewWidth,
                    columnOffset,
                } = getDrawerGeometry(viewportWidth, viewportHeight - bottomInset - useSafeAreaInsets().top, data.layout);

                const folderMotion = useFolderOverlayMotion(folderOverlayId);
                const folderPageStyle = useFolderPageMotion(folderId);
                const drawerFolder = data.nodes.find(node => node.kind === "folder" && node.id === folderId);
                const retainedFolder = data.nodes.find(
                    node => node.kind === "folder" && node.id === uiState.retainedFolderId,
                );
                const overlayFolder = data.nodes.find(
                    node => node.kind === "folder" && node.id === folderMotion.folderId,
                );
                const visible = filteredItems(
                    view === "servers" ? (drawerFolder?.children ?? data.nodes) : data.directMessages,
                    filter,
                    query,
                );
                const drag = useReorder(data.directMessages);
                const preview = usePreview(previewWidth, grid);
                const active = drag.reorder.current;
                const markAllRead = () => {
                    if (surfaceSignal.aborted || !storage.pullToMarkRead) return;
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

                useEffect(() => {
                    setListAtTop(true);
                }, [filter, folderId, data.layout, query]);

                useNavigatorBackPressHandler(() => {
                    if (surfaceSignal.aborted || (!expanded && !folderId && !folderOverlayId)) return false;
                    if (folderOverlayId) closeFolder();
                    else if (folderId) changeFolder();
                    else setDrawerOpen(false, false);

                    return true;
                });

                function setDrawerOpen(open, reset = true) {
                    setUi({
                        expanded: open,
                        ...(!open && reset ? { folderId: undefined, query: "" } : {}),
                    });
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
                    open(
                        "open this item",
                        () =>
                            item.kind ? controller.selectGuild(item.id) : controller.selectPrivateChannel(item.id),
                        expanded,
                    );
                };

                function changeView(next, openDrawer = false) {
                    if (view === next && !openDrawer) return;
                    drag.finish();
                    setUi({
                        folderId: undefined,
                        folderOverlayId: undefined,
                        query: "",
                        view: next,
                        ...(openDrawer ? { filter: "all" } : {}),
                    });
                    if (openDrawer) setDrawerOpen(true);
                }

                const renderCell = ({ item, inFolder, compactSize, items, animate }) => {
                    const render = menu => {
                        const content = h(Item, {
                            item,
                            menu,
                            animate,
                            compactSize,
                            layout: inFolder ? "grid" : data.layout,
                            dragging: active?.source.id === item.id,
                            merging:
                                !inFolder && active?.mergeReady === true && active.items[active.target].id === item.id,
                            selectedId: item.kind ? data.selectedGuildId : data.selectedPrivateChannelId,
                            onPress: () => {
                                if (item.kind !== "folder") return selectItem(item);
                                if (compactSize) setUi({ folderOverlayId: item.id });
                                else changeFolder(item.id);
                            },
                        });

                        return compactSize
                            ? content
                            : h(
                                  DragTarget,
                                  {
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
                                              menu?.onLongPress,
                                          ),
                                  },
                                  content,
                              );
                    };

                    const Menu = item.kind === "folder" ? FolderMenu : GuildMenu;
                    const key = compactSize || inFolder ? item.id : undefined;
                    return item.kind
                        ? h(Menu, { key, guild: item }, render)
                        : h(Fragment, { key }, render());
                };

                const cellRenderer = useRef(renderCell);
                cellRenderer.current = renderCell;
                const renderItem = (
                    item,
                    inFolder = false,
                    compactSize = undefined,
                    page = view,
                    items = visible,
                    visiblePage = true,
                ) => {
                    const offset = drag.offset(item.id);
                    const animated =
                        item.kind !== "folder" && !!item.animatedAvatarUri && item.animatedAvatarUri !== item.avatarUri;

                    return h(DrawerCell, {
                        key: compactSize || inFolder ? item.id : undefined,
                        render: cellRenderer,
                        item,
                        inFolder,
                        compactSize,
                        page,
                        items,
                        animate:
                            animated &&
                            visiblePage &&
                            !compactSize &&
                            ((expanded && page === view) || !!folderOverlayId) &&
                            foreground,
                        expanded,
                        layout: data.layout,
                        width: viewportWidth,
                        selected: item.id === (item.kind ? data.selectedGuildId : data.selectedPrivateChannelId),
                        dragging: active?.source.id === item.id,
                        merging:
                            !inFolder && active?.mergeReady === true && active.items[active.target].id === item.id,
                        offsetX: offset?.x,
                        offsetY: offset?.y,
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
                            { style: styles.searchRow },
                            h(SearchField, {
                                placeholder: `Search ${viewLabel}`,
                                value: query,
                                onChange: value => setUi({ query: value }),
                            }),
                            h(Tabs, {
                                filter: true,
                                value: filter,
                                onChange: value => setUi({ filter: value }),
                                options: FILTER_OPTIONS,
                            }),
                        ),
                        h(
                            View,
                            { style: { flex: 1 } },
                            folders.map(folder => {
                                const hidden = folder ? folder.id !== folderId : servers && !!drawerFolder;
                                const items = filteredItems(
                                    servers ? (folder?.children ?? data.nodes) : data.directMessages,
                                    filter,
                                    page === view ? query : "",
                                );

                                const motion = servers
                                    ? folderPageStyle[folder ? "folderStyle" : "rootStyle"]
                                    : undefined;

                                return h(
                                    AnimatedView,
                                    {
                                        key: folder?.id ?? "root",
                                        pointerEvents: hidden ? "none" : "auto",
                                        accessibilityElementsHidden: hidden,
                                        importantForAccessibility: hidden ? "no-hide-descendants" : "auto",
                                        style: [Native.StyleSheet.absoluteFill, motion],
                                    },
                                    h(List, {
                                        data: items,
                                        numColumns: columns,
                                        ListEmptyComponent: h(
                                            View,
                                            { style: styles.emptyContainer },
                                            h(
                                                DText,
                                                { variant: "text-md/semibold", style: { textAlign: "center" } },
                                                query.trim()
                                                    ? `No ${viewLabel} match your search`
                                                    : filter === "unread"
                                                      ? "You're all caught up"
                                                      : `No ${viewLabel} to show`,
                                            ),
                                        ),
                                        contentContainerStyle: {
                                            paddingBottom: 40,
                                            paddingHorizontal: grid ? SIDE_PADDING : 10,
                                            paddingTop: grid ? 14 : 10,
                                        },
                                        key: `${page}-${data.layout}-${columns}`,
                                        ...(FlashList
                                            ? {
                                                  maintainVisibleContentPosition: { disabled: true },
                                                  getItemType: item => item.kind ?? "dm",
                                              }
                                            : {}),
                                        keyExtractor: item => `${page}:${item.id}`,
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
                                                        paddingBottom:
                                                            Math.floor(index / columns) <
                                                            Math.floor((items.length - 1) / columns)
                                                                ? grid
                                                                    ? ITEM_GAP
                                                                    : 4
                                                                : 0,
                                                    },
                                                },
                                                renderItem(item, false, undefined, page, items, !hidden),
                                            ),
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

                if (surfaceSignal.aborted) return null;

                const dockItems = Array.from({ length: dockSpecs.itemCountNoExtras }, (_, index) => {
                    const node = data.nodes[index];
                    if (!node || (node.kind === "folder" && !node.children.length))
                        return h(View, {
                            key: `spacer-${index}`,
                            accessibilityElementsHidden: true,
                            importantForAccessibility: "no-hide-descendants",
                            style: {
                                height: dockSpecs.itemSize,
                                opacity: 0,
                                width: dockSpecs.itemSize,
                            },
                        });

                    return renderItem(node, false, dockSpecs.itemSize);
                });

                return h(
                    View,
                    {
                        onLayout: ({ nativeEvent: { layout } }) => {
                            if (layout.width > 0 && layout.height > 0) setViewport(layout);
                            if (layout.width > 0) onWidthChange(layout.width);
                        },
                        pointerEvents: "box-none",
                        style: styles.drawerBackdrop,
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
                                    accessibilityLabel: expanded
                                        ? view === "servers"
                                            ? "All servers drawer"
                                            : "Direct messages drawer"
                                        : "Server dock",
                                    accessibilityViewIsModal: expanded,
                                    importantForAccessibility: expanded ? "yes" : "auto",
                                    style: [
                                        styles.drawerPanel,
                                        FLOATING_PANEL_STYLE,
                                        {
                                            bottom: 0,
                                            height: drawerHeight + YOU_BAR_JOIN_DEPTH,
                                            width: dockSpecs.dockWidth,
                                        },
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
                                            accessibilityActions: [
                                                { label: expanded ? "Collapse" : "Expand", name: "activate" },
                                            ],
                                            accessibilityLabel: expanded
                                                ? "Collapse server drawer"
                                                : "Expand server drawer",
                                            hitSlop: { bottom: 14, left: 14, right: 14, top: 14 },
                                            onAccessibilityAction: () => setDrawerOpen(!expanded),
                                            onPress: () => setDrawerOpen(!expanded),
                                            style: styles.handle,
                                        },
                                        h(View, { style: styles.handleBar }),
                                    ),
                                    h(
                                        AnimatedView,
                                        {
                                            pointerEvents: expanded ? "none" : "auto",
                                            accessibilityElementsHidden: expanded,
                                            importantForAccessibility: expanded ? "no-hide-descendants" : "auto",
                                            style: [styles.compactFace, resize.compactStyle],
                                        },
                                        h(
                                            View,
                                            { style: [styles.dockRow, { height: dockSpecs.itemSize }] },
                                            ...dockItems,
                                            h(View, {
                                                style: [
                                                    styles.dockDivider,
                                                    { height: Math.round(dockSpecs.itemSize * 0.7) },
                                                ],
                                            }),
                                            h(
                                                Pressable,
                                                {
                                                    accessibilityRole: "button",
                                                    onPress: () => changeView("dms", true),
                                                    accessibilityLabel: `Direct Messages${
                                                        data.directMessageBadge.mentionCount > 0
                                                            ? `, ${data.directMessageBadge.mentionCount} mentions`
                                                            : data.directMessageBadge.unread
                                                              ? ", unread"
                                                              : ""
                                                    }`,
                                                    style: [
                                                        styles.dmButton,
                                                        { height: dockSpecs.itemSize, width: dockSpecs.itemSize },
                                                    ],
                                                },
                                                h(Icon, { name: "ChatIcon", color: TEXT_DEFAULT }),
                                                h(Badge, { state: data.directMessageBadge, compact: true }),
                                            ),
                                            h(Icon, {
                                                label: "View all servers",
                                                onPress: () => setDrawerOpen(true),
                                                name: "GridSquareIcon",
                                                color: TEXT_DEFAULT,
                                                buttonSize: dockSpecs.itemSize,
                                                size:
                                                    Math.max(10, Math.floor((dockSpecs.itemSize * 0.8 - 5) / 2)) * 2 +
                                                    5,
                                            }),
                                        ),
                                    ),

                                    h(
                                        AnimatedView,
                                        {
                                            pointerEvents: expanded ? "auto" : "none",
                                            accessibilityElementsHidden: !expanded,
                                            importantForAccessibility: expanded ? "auto" : "no-hide-descendants",
                                            style: [styles.expandedFace, resize.expandedStyle],
                                        },
                                        h(
                                            View,
                                            { style: { height: drawerHeight - 16 } },
                                            h(
                                                View,
                                                { style: styles.header },
                                                drawerFolder
                                                    ? h(
                                                          Fragment,
                                                          null,
                                                          h(Icon, {
                                                              label: "Back to all servers",
                                                              onPress: () => changeFolder(),
                                                              name: "ArrowSmallLeftIcon",
                                                              color: TEXT_DEFAULT,
                                                              size: 30,
                                                          }),
                                                          h(FolderTitle, {
                                                              key: drawerFolder.id,
                                                              folder: drawerFolder,
                                                              style: { flex: 1, paddingVertical: 8 },
                                                          }),
                                                      )
                                                    : h(Tabs, {
                                                          options: VIEW_OPTIONS,
                                                          value: view,
                                                          onChange: changeView,
                                                      }),
                                                h(Icon, {
                                                    label: `Switch to ${grid ? "list" : "grid"} view`,
                                                    onPress: () => {
                                                        storage.layout = grid ? "list" : "grid";
                                                    },
                                                    name: grid ? "ListViewIcon" : "GridSquareIcon",
                                                    color: TEXT_MUTED,
                                                }),
                                                h(Icon, {
                                                    label:
                                                        view === "servers"
                                                            ? "Create a server"
                                                            : "Start a direct message",
                                                    onPress: () =>
                                                        open(
                                                            "open creation",
                                                            view === "servers"
                                                                ? controller.openCreateGuild
                                                                : controller.openCreateDm,
                                                        ),
                                                    name: "PlusLargeIcon",
                                                    color: TEXT_MUTED,
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
                                                        {
                                                            style: [
                                                                {
                                                                    width: pageWidth * 2,
                                                                    height: "100%",
                                                                    flexDirection: "row",
                                                                },
                                                                pages.style,
                                                            ],
                                                        },
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
                                  accessibilityLabel: `Dragging ${active.source.name ?? "Folder"}`,
                                  accessibilityRole: "summary",
                                  pointerEvents: "none",
                                  style: [
                                      styles.dragPreview,
                                      { left: grid ? 0 : panelLeft + 10, width: previewWidth },
                                      preview.style,
                                  ],
                              },
                              h(Item, {
                                  item: active.source,
                                  layout: data.layout,
                                  previewWidth,
                                  animate: expanded && foreground,
                              }),
                          )
                        : null,
                    active?.source.kind === "guild" && active.source.folderId && (drawerFolder || overlayFolder)
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
                                  style: [
                                      styles.exitTarget,
                                      { left: viewportWidth / 2 - 28, bottom: bottomInset + 24 },
                                  ],
                              },
                              h(
                                  View,
                                  {
                                      style: {
                                          height: 42,
                                          justifyContent: "center",
                                          transform: [{ scale: active?.outside ? 1.15 : 1 }],
                                      },
                                  },
                                  h(Icon, {
                                      name: "UndoIcon",
                                      color: active?.outside ? TEXT_BRAND : TEXT_DEFAULT,
                                      size: 36,
                                  }),
                              ),
                          )
                        : null,
                );
            };
        }

        return createServerDrawerSurface(createController(), signal);
    }

    function isNativePanel(element) {
        return (
            React.isValidElement(element) &&
            Array.isArray(element.props.children) &&
            element.props.children.length === 2 &&
            React.isValidElement(element.props.children[1])
        );
    }

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
                        style: {
                            height: 1,
                            width: 1,
                            position: "absolute",
                            left: -10000,
                            opacity: 0,
                        },
                    },
                    rail,
                ),
                React.cloneElement(content, {
                    style: [
                        content.props.style,
                        {
                            bottom: dockHeight,
                            left: 0,
                            right: 0,
                            width: "100%",
                            borderLeftWidth: 0,
                        },
                    ],
                }),
                dock,
            ],
        });
    }

    function start() {
        const abort = createAbort();
        const { signal } = abort;
        const patches = [];
        const stops = [];
        const patch = (kind, key, target, callback) => {
            try {
                patches.push(patcher[kind](key, target, callback));
            } catch (error) {
                reportError(error);
            }
        };

        const subscribe = listener => {
            signal.addEventListener("abort", listener);
            return () => signal.removeEventListener("abort", listener);
        };
        const getActive = () => !signal.aborted;
        const useActive = () => React.useSyncExternalStore(subscribe, getActive);

        ensureDefaults();

        const icymi = lookup("getICYMIEnabled", "useICYMIEnabled");
        if (icymi) {
            patch("after", "getICYMIEnabled", icymi, () => false);
            patch("after", "useICYMIEnabled", icymi, () => false);
        }

        const experiment = lookup("MobileHomeDrawerExperiment")?.MobileHomeDrawerExperiment;
        if (experiment) {
            for (const key of ["getConfig", "useConfig"])
                if (typeof experiment[key] === "function")
                    patch("after", key, experiment, (_args, config) => ({
                        ...config,
                        enableHome: false,
                        landOnHome: false,
                        enablePeekHint: false,
                    }));
        }

        const chatLayout = lookup("getChatLayout");
        const constants = lookup("DM_WIDTH");
        if (chatLayout && constants) {
            const channelWidth = locateComponent("useChannelListWidth");
            if (channelWidth)
                patch("after", channelWidth.key, channelWidth.target, (_args, width) =>
                    chatLayout.getChatLayout().isChatBesideChannelList ? width : width + constants.DM_WIDTH,
                );
            else reportError("Server Drawer: could not find the channel list width hook. Candidates: " + describeCandidates(/ChannelListWidth|ListWidth/i).join(", "));

            const channelBackground = lookup("ScreenAlignedThemedGradientSliding");
            if (channelBackground && typeof channelBackground.default === "function")
                patch("before", "default", channelBackground, args => {

                    if (!chatLayout.getChatLayout().isChatBesideChannelList)
                        args[0] = { ...args[0], offsetX: 0 };
                    return args;
                });
        } else reportError("Server Drawer: unsupported channel list layout.");

        const patchMainChannels = located => {
            if (signal.aborted) return;
            let Panel;
            let failed = false;

            const initialize = element => {
                if (failed || signal.aborted) return element;
                if (!isNativePanel(element)) {
                    failed = true;
                    reportError(new Error("Server Drawer: unsupported left-panel content."));
                    toast("Server Drawer: this Discord version has an unsupported home panel.");
                    return element;
                }
                if (Panel) return h(Panel, { key: element.key, element });
                try {
                    const inset = lookup("useYouBarTotalHeight");
                    const shade = locateComponent("YouBarFloatingShade");
                    if (!inset) throw new Error("Server Drawer: the You bar height hook is unavailable.");

                    const DrawerSurface = createServerDrawer(signal);
                    const useInset = () => {
                        const height = inset.useYouBarTotalHeight();
                        return Math.max(0, Number.isFinite(height) ? height : 0);
                    };
                    function YouBarBackdrop({ element: shadeElement }) {
                        const height = useInset();
                        const active = useActive();
                        return active && Native.Platform.OS !== "ios"
                            ? h(
                                  View,
                                  {
                                      pointerEvents: "none",
                                      style: {
                                          position: "absolute",
                                          bottom: 0,
                                          left: 0,
                                          right: 0,
                                          height,
                                          overflow: "hidden",
                                      },
                                  },
                                  shadeElement,
                              )
                            : shadeElement;
                    }
                    function ServerDrawerLeftPanel({ element: panel }) {
                        const active = useActive();
                        const bottomInset = useInset();
                        const [width, setWidth] = React.useState(() => Native.Dimensions.get("window").width);
                        return active
                            ? transformLeftPanelContent(
                                  panel,
                                  h(DrawerSurface, {
                                      key: "server-drawer",
                                      bottomInset,
                                      onWidthChange: setWidth,
                                  }),
                                  computeGuildDockSpecs(width - 16).dockHeight - DOCK_REST_OFFSET,
                              )
                            : panel;
                    }
                    if (shade) patch("after", shade.key, shade.target, (_args, shadeElement) => h(YouBarBackdrop, { element: shadeElement }));
                    else reportError("Server Drawer: could not find the You bar shade; continuing without it.");

                    Panel = ServerDrawerLeftPanel;
                    return h(Panel, { key: element.key, element });
                } catch (error) {
                    failed = true;
                    reportError(error);
                    toast("Server Drawer failed to start. Check the debug logs.");
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
                const original = memoType?.type ?? type;

                if (typeof original === "function" && original.name === "NonCollapsableGestureDetector")
                    return wrapPanel(node.props.children);
                if (
                    typeof original === "function" &&
                    (original.name === "LeftMenuTabsInner" ||
                        original.name === "LeftPanelHomeDrawerContainer" ||
                        original.name === "LeftPanelContent")
                ) {
                    let Wrapper = wrappers.get(type);
                    if (!Wrapper) {
                        const render = original;

                        const Component =
                            original.name === "LeftPanelContent"
                                ? function ServerDrawerLeftPanelContent(componentProps) {
                                      const active = useActive();
                                      const rendered = render(
                                          active && "panelStyles" in componentProps
                                              ? { ...componentProps, panelStyles: undefined }
                                              : componentProps,
                                      );
                                      const [ready, setReady] = React.useState(false);

                                      React.useEffect(() => {
                                          setReady(true);
                                      }, []);
                                      return ready ? initialize(rendered) : rendered;
                                  }
                                : function ServerDrawerPanelContainer(componentProps) {
                                      const active = useActive();
                                      const rendered = render(componentProps);
                                      return active ? wrapPanel(rendered) : rendered;
                                  };
                        Wrapper = memoType ? React.memo(Component, memoType.compare) : Component;
                        wrappers.set(type, Wrapper);
                    }
                    return h(Wrapper, { key: node.key, ...node.props });
                }
                const children = wrapPanel(node.props.children);
                return children === node.props.children ? node : React.cloneElement(node, { children });
            };

            if (typeof located.target[located.key] !== "function") {
                reportError(new Error("Server Drawer: this Discord version has an unsupported home panel."));
                return;
            }
            patch("after", located.key, located.target, (_args, rendered) => wrapPanel(rendered));
        };

        stops.push(
            waitFor(
                () => locateComponent("MainChannels"),
                patchMainChannels,
                () => {
                    reportError("Server Drawer: could not find the home panel (MainChannels). Candidates: " + describeCandidates(/MainChannels|LeftPanel|LeftMenuTabs|HomeDrawer/i).join(", "));
                    toast("Server Drawer: could not find the home panel. Is this Discord version supported?");
                },
            ),
        );

        return {
            stop() {
                abort.abort();
                for (const stopWaiting of stops.splice(0)) safe(stopWaiting);
                for (const unpatch of patches.splice(0)) safe(unpatch);
            },
        };
    }

    const SETTING_LABEL = "Pull down to mark all as read";
    const SETTING_DESCRIPTION =
        "Pull the collapsed dock down until it is flat, then release to mark all servers and DMs as read.";

    function Settings() {
        const stored = useProxy(storage);
        const value = !!stored.pullToMarkRead;
        const onValueChange = next => {
            storage.pullToMarkRead = next;
        };
        const design = safe(() => getNative().design, {});
        const forms = safe(() => ui.components.Forms);

        let body = null;
        if (design.TableRowGroup && design.TableSwitchRow)
            body = h(
                design.TableRowGroup,
                { title: "Gestures" },
                h(design.TableSwitchRow, {
                    label: SETTING_LABEL,
                    subLabel: SETTING_DESCRIPTION,
                    value,
                    onValueChange,
                }),
            );
        else if (forms && forms.FormSection && forms.FormSwitchRow)
            body = h(
                forms.FormSection,
                { title: "Gestures" },
                h(forms.FormSwitchRow, {
                    label: SETTING_LABEL,
                    subLabel: SETTING_DESCRIPTION,
                    value,
                    onValueChange,
                }),
            );

        return h(ScrollView, { style: { flex: 1 }, contentContainerStyle: { padding: 16 } }, body);
    }

    let runtime;

    return {
        onLoad() {
            try {
                runtime = start();
            } catch (error) {
                reportError(error);
                toast("Server Drawer failed to start. Check the debug logs.");
            }
        },
        onUnload() {
            if (runtime) runtime.stop();
            runtime = undefined;
            toast("Server Drawer disabled. Restart Discord to fully restore the default layout.");
        },
        settings: Settings,
    };
})();
