(function () {
    const { metro, patcher, commands, plugin, ui } = vendetta;
    const { findByProps } = metro;
    const { FluxDispatcher } = metro.common;
    const { before } = patcher;
    const storage = plugin.storage;

    const MORSE = {
        a: ".-", b: "-...", c: "-.-.", d: "-..", e: ".", f: "..-.", g: "--.", h: "....",
        i: "..", j: ".---", k: "-.-", l: ".-..", m: "--", n: "-.", o: "---", p: ".--.",
        q: "--.-", r: ".-.", s: "...", t: "-", u: "..-", v: "...-", w: ".--", x: "-..-",
        y: "-.--", z: "--..",
        0: "-----", 1: ".----", 2: "..---", 3: "...--", 4: "....-", 5: ".....",
        6: "-....", 7: "--...", 8: "---..", 9: "----.",
        ".": ".-.-.-", ",": "--..--", "?": "..--..", "'": ".----.", "!": "-.-.--",
        "(": "-.--.", ")": "-.--.-", "&": ".-...", ":": "---...", ";": "-.-.-.",
        "=": "-...-", "+": ".-.-.", "-": "-....-", '"': ".-..-.", "@": ".--.-.",
    };
    // "/" is reserved as the word separator, so it is not part of the alphabet
    const REVERSE = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));

    // mentions, custom emoji, channel links and URLs are left untouched
    const PRESERVE = /(<[^>\s]+>|https?:\/\/\S+)/g;
    const MAX_LENGTH = 2000;

    function encodeChunk(text) {
        const words = text
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
        return words
            .map(word => [...word].map(ch => MORSE[ch]).filter(Boolean).join(" "))
            .filter(Boolean)
            .join(" / ");
    }

    function encode(text) {
        return text
            .split(PRESERVE)
            .map((part, i) => (i % 2 === 1 ? part : encodeChunk(part)))
            .filter(Boolean)
            .join(" ");
    }

    function decode(text) {
        const clean = text
            .replace(/[\u00b7\u2022]/g, ".")
            .replace(/[\u2013\u2014\u2212]/g, "-")
            .trim();
        if (!clean || !/^[.\-\/\s]+$/.test(clean) || !/[.\-]/.test(clean)) return null;

        const words = clean.split(/\s*\/\s*|\s{3,}/).filter(Boolean);
        const out = [];
        let tokenCount = 0;
        for (const word of words) {
            let decoded = "";
            for (const token of word.split(/\s+/).filter(Boolean)) {
                const ch = REVERSE[token];
                if (ch === undefined) return null;
                decoded += ch;
                tokenCount++;
            }
            out.push(decoded);
        }
        // a lone "..." or "-" is far more likely an ellipsis or dash than morse
        if (tokenCount < 2) return null;
        return out.join(" ");
    }

    function rewrite(message) {
        if (!message || typeof message.content !== "string") return;
        const decoded = decode(message.content);
        if (decoded) message.content = `${decoded}\n-# \u{1F4E1} ${message.content}`;
    }

    function onDispatch(args) {
        if (!storage.decodeIncoming) return;
        const event = args[0];
        if (!event) return;
        switch (event.type) {
            case "MESSAGE_CREATE":
            case "MESSAGE_UPDATE":
                rewrite(event.message);
                break;
            case "LOAD_MESSAGES_SUCCESS":
            case "LOAD_MESSAGES_SUCCESS_CACHED":
                if (Array.isArray(event.messages)) event.messages.forEach(rewrite);
                break;
        }
    }

    const unpatches = [];
    let unregisterCommand = null;

    function status() {
        return `Morse sending: **${storage.enabled ? "ON" : "OFF"}**\nDecoding incoming morse: **${storage.decodeIncoming ? "ON" : "OFF"}**`;
    }

    return {
        onLoad() {
            if (storage.enabled === undefined) storage.enabled = true;
            if (storage.decodeIncoming === undefined) storage.decodeIncoming = true;

            // Outgoing: encode what you send
            const MessageActions = findByProps("sendMessage", "receiveMessage");
            if (MessageActions) {
                unpatches.push(
                    before("sendMessage", MessageActions, args => {
                        const message = args[1];
                        if (!storage.enabled || !message || typeof message.content !== "string") return;
                        const encoded = encode(message.content);
                        if (!encoded) return;
                        if (encoded.length > MAX_LENGTH) {
                            ui.toasts.showToast("Morse version is too long, sent as normal text");
                            return;
                        }
                        message.content = encoded;
                    })
                );
            }

            // Incoming: decode morse from everyone
            unpatches.push(before("dispatch", FluxDispatcher, onDispatch));

            // /morse command
            const choice = (value) => ({ name: value, displayName: value, value });
            unregisterCommand = commands.registerCommand({
                name: "morse",
                displayName: "morse",
                description: "Control the Morse Code plugin",
                displayDescription: "Control the Morse Code plugin",
                applicationId: "-1",
                inputType: 1,
                type: 1,
                options: [
                    {
                        name: "action",
                        displayName: "action",
                        description: "toggle (default), on, off, incoming (toggle decoding), status",
                        displayDescription: "toggle (default), on, off, incoming (toggle decoding), status",
                        type: 3,
                        required: false,
                        choices: ["toggle", "on", "off", "incoming", "status"].map(choice),
                    },
                ],
                execute(args) {
                    const action = (args.find(a => a.name === "action")?.value ?? "toggle").toString();
                    switch (action) {
                        case "on": storage.enabled = true; break;
                        case "off": storage.enabled = false; break;
                        case "incoming": storage.decodeIncoming = !storage.decodeIncoming; break;
                        case "status": break;
                        default: storage.enabled = !storage.enabled;
                    }
                    return { send: false, content: status() };
                },
            });
        },

        onUnload() {
            for (const unpatch of unpatches.splice(0)) unpatch();
            if (unregisterCommand) unregisterCommand();
            unregisterCommand = null;
        },
    };
})()
