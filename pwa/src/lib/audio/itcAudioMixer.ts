/**
 * itcAudioMixer — single Web Audio mixer for all ITC tool output (Spirit Box,
 * Ovilus, future EVP-style synths).
 *
 * # Why this exists
 *
 * The previous flow routed `speechSynthesis.speak(...)` straight to the device
 * speakers. With `echoCancellation: false` on the camera mic (required for
 * forensic EVP work), the speaker output was re-captured by the mic and baked
 * straight into the WAV/WebM recordings as a feedback loop. The text was also
 * audible to anyone in the room, undercutting the "operator-only headphone
 * cue" pattern most paranormal productions use.
 *
 * # What this does
 *
 * The mixer wires:
 *
 *     [tool A GainNode] ─┐
 *     [tool B GainNode] ─┼─► [master GainNode] ─► [destination]
 *     [tool C GainNode] ─┘
 *
 * `destination` is a `MediaStreamAudioDestinationNode`, so the mixed output
 * lives inside a `MediaStream` we can attach as an additional audio track on
 * the composite stream consumed by MediaRecorder + WHIP. Critically, that
 * stream is NOT connected to `ctx.destination`, so nothing reaches the device
 * speakers — the operator hears the tones only when they're monitoring the
 * preview/recording through headphones, and the room mic never re-captures
 * them.
 *
 * Master gain is exposed for the push-to-talk hook to duck ITC tones while
 * the operator is speaking, so what they say lands cleanly on the recording.
 *
 * # Autoplay policy
 *
 * AudioContext construction outside a user gesture is rejected by every
 * mobile browser. `getItcMixer()` is therefore lazy + wrapped in try/catch —
 * the first caller MUST be in a gesture, and downstream callers should be
 * prepared for the singleton to throw. The Spirit-Box / Ovilus hooks already
 * sit behind a user toggle, so by the time their effect fires we're inside
 * the gesture chain.
 */

export interface ItcMixer {
  context: AudioContext;
  destination: MediaStreamAudioDestinationNode;
  /** Per-tool gain stage. Same tool id returns the same node every call. */
  getGainNode(toolId: "spiritBox" | "ovilus"): GainNode;
  /** Smoothly ramp the master gain. rampMs defaults to 50ms. */
  setMasterGain(value: number, rampMs?: number): void;
  /** The mixed MediaStream containing one synthetic audio track. */
  getStream(): MediaStream;
}

let cached: ItcMixer | null = null;

/**
 * Lazy-init the singleton mixer. Returns null callers can shortcut on if
 * AudioContext construction failed (very rare — only happens on a closed
 * window or browsers that hard-disable Web Audio in private mode).
 *
 * Implementation throws on failure so the call-site can decide whether to
 * silently no-op (tool hooks) or surface an error.
 */
export function getItcMixer(): ItcMixer {
  if (cached) return cached;

  // Construct lazily; wrap in try so a hostile environment doesn't crash the
  // whole React tree. Callers are expected to handle thrown errors.
  const Ctor = (window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctor) throw new Error("Web Audio unavailable");

  const context = new Ctor();
  // First resume — no-op on Chromium desktop, important on iOS/in-app browsers.
  void context.resume();

  const destination = context.createMediaStreamDestination();

  const master = context.createGain();
  master.gain.value = 1.0;
  master.connect(destination);

  const gains = new Map<"spiritBox" | "ovilus", GainNode>();

  const ensureGain = (toolId: "spiritBox" | "ovilus"): GainNode => {
    const existing = gains.get(toolId);
    if (existing) return existing;
    const node = context.createGain();
    // Per-tool starting volume — kept modest so a tool toggling on doesn't
    // pin the headphone signal. Tools can adjust their own GainNode further
    // if they want a different baseline.
    node.gain.value = toolId === "spiritBox" ? 0.6 : 0.8;
    node.connect(master);
    gains.set(toolId, node);
    return node;
  };

  cached = {
    context,
    destination,
    getGainNode(toolId) {
      return ensureGain(toolId);
    },
    setMasterGain(value, rampMs = 50) {
      const now = context.currentTime;
      const target = Math.max(0, Math.min(1, value));
      const seconds = Math.max(0, rampMs) / 1000;
      // cancelScheduledValues drops any in-flight ramp; setValueAtTime
      // anchors the ramp's start at the current gain (queried via .value).
      try {
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(master.gain.value, now);
        master.gain.linearRampToValueAtTime(target, now + seconds);
      } catch {
        // Some browsers throw on cancelScheduledValues for unusual states.
        // Hard fallback — set the value directly.
        master.gain.value = target;
      }
    },
    getStream() {
      return destination.stream;
    },
  };

  return cached;
}

/** Test-only helper. Drops the cached singleton so a fresh getItcMixer() call
 *  rebuilds with a different AudioContext (e.g. when JSDOM re-stubs it).  */
export function __resetItcMixerForTests(): void {
  if (cached) {
    try { cached.context.close(); } catch { /* ignore */ }
  }
  cached = null;
}
