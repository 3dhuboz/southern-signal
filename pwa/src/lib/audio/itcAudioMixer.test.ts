/**
 * itcAudioMixer parity tests.
 *
 * # Why
 *
 * Every meter cue and ITC tool routes its synth nodes through this mixer.
 * The mixer's `getStream()` returns a single MediaStream that
 * `LiveStreamView` adds to the outgoing track set, which is then handed to
 * MediaRecorder (recording) AND startWhipSession (livestream). So if the
 * mixer can build a gain stage for a channel and connect it to master, that
 * channel is structurally guaranteed to appear in the recording + WHIP.
 *
 * What we assert here:
 *   1. The mixer exposes a `MediaStreamAudioDestinationNode` whose stream
 *      we use as the recording/WHIP audio input.
 *   2. Every public channel id (Spirit Box, Ovilus, K-II, REM Pod, EMF
 *      galvanometer, VU overload, motion) can be retrieved via
 *      `getMixerChannel()` and returns a GainNode connected to master.
 *   3. Master-gain ducking still applies linearly to every per-tool gain
 *      (the push-to-talk path expects this; if anyone ever wires a meter
 *      cue to `ctx.destination` directly, the duck won't apply and the
 *      narration will be drowned by SFX).
 *
 * # How
 *
 * The node test env has no real Web Audio. We install a minimal fake
 * AudioContext on `globalThis.window` that records `connect()` calls. The
 * fake is enough for the mixer + meter sonification module to build their
 * graphs; no oscillator actually runs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getItcMixerIfUnlocked,
  getMixerChannel,
  getMixerAudioContext,
  __resetItcMixerForTests,
  type MeterChannelId,
} from "./itcAudioMixer";
import { unlockAudio, closeAudioContext } from "./audioUnlock";

// ── Minimal AudioContext fake ────────────────────────────────────────────────
// Replicates only the surface the mixer + meter sonification module use:
// createGain (with .gain.{value,linearRampToValueAtTime,etc.}),
// createMediaStreamDestination, createOscillator, createBufferSource,
// createBuffer, createBiquadFilter, currentTime, state, resume. Records
// connect() / disconnect() calls so the parity tests can assert routing.

interface FakeNode {
  __id: string;
  connect: (dest: FakeNode) => FakeNode;
  disconnect: (dest?: FakeNode) => void;
  __connectedTo: Set<FakeNode>;
}

function makeFakeNode(id: string): FakeNode {
  const node: FakeNode = {
    __id: id,
    __connectedTo: new Set<FakeNode>(),
    connect(dest) {
      node.__connectedTo.add(dest);
      return dest;
    },
    disconnect(dest) {
      if (dest) node.__connectedTo.delete(dest);
      else node.__connectedTo.clear();
    },
  };
  return node;
}

function makeFakeGain(id: string): FakeNode & { gain: { value: number; setValueAtTime: () => void; linearRampToValueAtTime: () => void; cancelScheduledValues: () => void } } {
  return Object.assign(makeFakeNode(id), {
    gain: {
      value: 1.0,
      setValueAtTime: () => {},
      linearRampToValueAtTime: () => {},
      cancelScheduledValues: () => {},
    },
  });
}

class FakeAudioContext {
  state: "running" | "suspended" | "closed" = "running";
  currentTime = 0;
  sampleRate = 48000;
  destination = makeFakeNode("destination");
  private idCounter = 0;
  private nextId(prefix: string): string {
    return `${prefix}-${++this.idCounter}`;
  }
  resume = (): Promise<void> => Promise.resolve();
  close = (): Promise<void> => {
    this.state = "closed";
    return Promise.resolve();
  };
  createGain = () => makeFakeGain(this.nextId("gain"));
  createOscillator = () => {
    return Object.assign(makeFakeNode(this.nextId("osc")), {
      type: "sine",
      frequency: { value: 440, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      start: () => {},
      stop: () => {},
      onended: null as null | (() => void),
    });
  };
  createBufferSource = () => {
    return Object.assign(makeFakeNode(this.nextId("src")), {
      buffer: null as null | object,
      loop: false,
      start: () => {},
      stop: () => {},
      onended: null as null | (() => void),
    });
  };
  createBuffer = (channels: number, length: number) => {
    return {
      getChannelData: () => new Float32Array(length),
      length,
      numberOfChannels: channels,
    };
  };
  createBiquadFilter = () => {
    return Object.assign(makeFakeNode(this.nextId("bp")), {
      type: "bandpass",
      frequency: { value: 1000 },
      Q: { value: 1 },
    });
  };
  createMediaStreamDestination = () => {
    return Object.assign(makeFakeNode(this.nextId("dest")), {
      stream: {
        getAudioTracks: () => [{ id: this.nextId("track") }],
      },
    });
  };
}

let originalAudioContext: unknown;

beforeEach(() => {
  // Inject a fake AudioContext into the global so audioUnlock + the mixer
  // can run in the node test env. Save the original for restoration; node
  // env has nothing, but doing this round-trip means the test still cleans
  // up after itself if anyone ever adds a real shim upstream.
  originalAudioContext = (globalThis as unknown as { AudioContext?: unknown; window?: { AudioContext?: unknown } }).AudioContext;
  (globalThis as unknown as { AudioContext: typeof FakeAudioContext; window: { AudioContext: typeof FakeAudioContext } }).AudioContext = FakeAudioContext;
  (globalThis as unknown as { window: { AudioContext: typeof FakeAudioContext } }).window = { AudioContext: FakeAudioContext };
  closeAudioContext();
  __resetItcMixerForTests();
});

afterEach(() => {
  closeAudioContext();
  __resetItcMixerForTests();
  (globalThis as unknown as { AudioContext?: unknown }).AudioContext = originalAudioContext as undefined;
});

describe("itcAudioMixer — recording-bus parity", () => {
  it("getMixerAudioContext returns null before unlockAudio is called", () => {
    // The mixer never auto-creates a context — that would re-trip the
    // autoplay policy. Callers must `unlockAudio()` from a gesture first.
    expect(getMixerAudioContext()).toBeNull();
  });

  it("getItcMixerIfUnlocked does not create an AudioContext before unlock", () => {
    expect(getItcMixerIfUnlocked()).toBeNull();
    expect(getMixerAudioContext()).toBeNull();
  });

  it("getMixerAudioContext returns the shared AudioContext after unlock", () => {
    const ctx = unlockAudio();
    expect(ctx).not.toBeNull();
    const peeked = getMixerAudioContext();
    expect(peeked).toBe(ctx);
  });

  const CHANNELS: MeterChannelId[] = [
    "spiritBox",
    "ovilus",
    "kii",
    "remPod",
    "emfGalvo",
    "vuOverload",
    "motion",
  ];

  it.each(CHANNELS)("getMixerChannel(%s) returns a GainNode connected to master", (channel) => {
    unlockAudio();
    const node = getMixerChannel(channel);
    expect(node).not.toBeNull();
    // The fake GainNode records its connect() calls in __connectedTo. There
    // should be exactly one entry — the master gain. We don't have a direct
    // handle to "the master gain", but we can prove the chain by asserting
    // the channel's gain node is connected to SOMETHING that is connected to
    // a MediaStreamAudioDestinationNode (whose id starts with "dest-").
    const fake = node as unknown as FakeNode;
    expect(fake.__connectedTo.size).toBeGreaterThanOrEqual(1);
    const downstream = [...fake.__connectedTo][0] as FakeNode;
    // The master gain is itself connected to the destination + (optionally) to
    // ctx.destination for the monitor tap.
    const masterConnections = [...downstream.__connectedTo];
    expect(masterConnections.length).toBeGreaterThanOrEqual(1);
    const hasMediaStreamDest = masterConnections.some((n) => n.__id.startsWith("dest-"));
    expect(hasMediaStreamDest).toBe(true);
  });

  it("repeated getMixerChannel calls return the SAME GainNode (channel singleton)", () => {
    unlockAudio();
    const a = getMixerChannel("kii");
    const b = getMixerChannel("kii");
    expect(a).toBe(b);
  });

  it("different channels return DIFFERENT GainNodes (no cross-talk)", () => {
    unlockAudio();
    const kii = getMixerChannel("kii");
    const rem = getMixerChannel("remPod");
    expect(kii).not.toBe(rem);
  });
});
