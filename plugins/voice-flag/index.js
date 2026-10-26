import { before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { logger } from "@vendetta";
import { showToast } from "@vendetta/ui/toasts";
import { findByStoreName } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";

// Voice gateway speaking flags (documented): 1 = microphone, 2 = soundshare
// (context audio, no speaking indicator), 4 = priority speaker.
const FLAG_MIC = 1 << 0;
const FLAG_SOUNDSHARE = 1 << 1;

// Voice websocket hosts look like wss://<region>.discord.media/?v=8
const VOICE_HOST = /^wss?:\/\/[^/]*\.discord\.media(:\d+)?\//i;
// Cheap prefilter so we only JSON.parse frames that might be op 5.
const OP5 = /"op"\s*:\s*5\b/;

let unpatches = [];
let toastedRewrite = false;
let stats = { voiceFramesSeen: 0, speakingRewritten: 0 };

// storage.mode: "soundshare" (default) | "off" | "passthrough"
//   soundshare  : mic flag -> soundshare flag (audio still flagged as sent, no indicator)
//   off         : mic flag cleared entirely (EXPERIMENTAL, receivers may drop audio)
//   passthrough : leave frames alone (useful for A/B testing)
// storage.hideLocal: also hide your own speaking ring on this device
function getMode() {
  return storage.mode ?? "soundshare";
}

// Pure function: takes a raw websocket frame, returns the (possibly rewritten) frame.
export function rewriteSpeakingFrame(raw, mode) {
  if (typeof raw !== "string" || mode === "passthrough") return raw;
  if (!OP5.test(raw)) return raw;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!msg || msg.op !== 5 || !msg.d || typeof msg.d.speaking !== "number") return raw;
  const flags = msg.d.speaking;
  if (!(flags & FLAG_MIC)) return raw; // not speaking, or already not a mic frame
  const cleared = flags & ~FLAG_MIC;
  msg.d.speaking = mode === "off" ? cleared : cleared | FLAG_SOUNDSHARE;
  return JSON.stringify(msg);
}

function patchVoiceSend() {
  unpatches.push(
    before("send", WebSocket.prototype, function (args) {
      try {
        if (typeof this?.url !== "string" || !VOICE_HOST.test(this.url)) return;
        stats.voiceFramesSeen++;
        const out = rewriteSpeakingFrame(args[0], getMode());
        if (out === args[0]) return;
        stats.speakingRewritten++;
        if (!toastedRewrite) {
          toastedRewrite = true;
          logger.log("[SpeakingFlagRewrite] rewrote first speaking frame:", args[0], "->", out);
          showToast("Speaking Flag Rewrite: working");
        }
        return [out, ...args.slice(1)];
      } catch (e) {
        // never break the socket because of this plugin
        logger.error("[SpeakingFlagRewrite] send patch failed", e);
      }
    })
  );
}

// UNVERIFIED: local-only hiding of your own speaking ring. The event name and
// shape come from how Discord's desktop client dispatches SPEAKING; confirm it
// in the Outbound Inspector / flux logs before relying on it.
function patchLocalRing() {
  if (storage.hideLocal === false) return;
  const UserStore = findByStoreName("UserStore");
  if (!UserStore || !FluxDispatcher) return;
  unpatches.push(
    before("dispatch", FluxDispatcher, function (args) {
      try {
        const ev = args[0];
        if (ev?.type !== "SPEAKING") return;
        const me = UserStore.getCurrentUser?.()?.id;
        if (me && ev.userId === me && ev.speakingFlags) {
          return [{ ...ev, speakingFlags: 0 }, ...args.slice(1)];
        }
      } catch (e) {
        logger.error("[SpeakingFlagRewrite] local ring patch failed", e);
      }
    })
  );
}

export default {
  onLoad() {
    patchVoiceSend();
    patchLocalRing();
    logger.log("[SpeakingFlagRewrite] loaded, mode =", getMode());
  },
  onUnload() {
    for (const u of unpatches) u();
    unpatches = [];
    toastedRewrite = false;
    logger.log("[SpeakingFlagRewrite] unloaded", stats);
  },
};
