import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearItcChannel,
  getItcChannels,
  resetItcChannels,
  setEvpEmission,
  setOvilusEmission,
  setSpiritBoxEmission,
  subscribeItcChannels,
} from "./itcChannels";

describe("itcChannels store", () => {
  beforeEach(() => {
    resetItcChannels();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    resetItcChannels();
  });

  it("starts empty", () => {
    expect(getItcChannels()).toEqual({ spiritBox: null, ovilus: null, evp: null });
  });

  it("captures the latest Spirit Box emission with a wall-clock timestamp", () => {
    setSpiritBoxEmission("OAK");
    const state = getItcChannels();
    expect(state.spiritBox).toEqual({ text: "OAK", timestamp: Date.parse("2026-05-15T12:00:00Z") });
    expect(state.ovilus).toBeNull();
    expect(state.evp).toBeNull();
  });

  it("ignores empty / whitespace / placeholder emissions", () => {
    setSpiritBoxEmission("");
    setSpiritBoxEmission("   ");
    setSpiritBoxEmission("—");
    expect(getItcChannels().spiritBox).toBeNull();
  });

  it("trims whitespace from emissions", () => {
    setOvilusEmission("  WINDOW  ");
    expect(getItcChannels().ovilus?.text).toBe("WINDOW");
  });

  it("replaces previous emission on each call (latest-wins)", () => {
    setOvilusEmission("DOOR");
    const t1 = getItcChannels().ovilus?.timestamp;
    vi.advanceTimersByTime(5_000);
    setOvilusEmission("BRIDGE");
    const state = getItcChannels();
    expect(state.ovilus?.text).toBe("BRIDGE");
    expect(state.ovilus?.timestamp).toBe((t1 ?? 0) + 5_000);
  });

  it("clears a single channel without affecting others", () => {
    setSpiritBoxEmission("HALL");
    setOvilusEmission("WINDOW");
    setEvpEmission("hello is anyone there");
    clearItcChannel("ovilus");
    const state = getItcChannels();
    expect(state.spiritBox?.text).toBe("HALL");
    expect(state.ovilus).toBeNull();
    expect(state.evp?.text).toBe("hello is anyone there");
  });

  it("clearItcChannel is idempotent — no-op when already null does not publish", () => {
    const listener = vi.fn();
    const unsub = subscribeItcChannels(listener);
    clearItcChannel("evp");
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it("publishes to subscribers on each emission", () => {
    const listener = vi.fn();
    const unsub = subscribeItcChannels(listener);
    setSpiritBoxEmission("OAK");
    setOvilusEmission("DOOR");
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    setEvpEmission("after unsub");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("resetItcChannels notifies subscribers with the empty state", () => {
    setSpiritBoxEmission("OAK");
    const listener = vi.fn();
    const unsub = subscribeItcChannels(listener);
    resetItcChannels();
    expect(listener).toHaveBeenCalledWith({ spiritBox: null, ovilus: null, evp: null });
    unsub();
  });

  it("keeps independent state per channel — three sources never trample each other", () => {
    setSpiritBoxEmission("OAK");
    setOvilusEmission("WINDOW");
    setEvpEmission("did you say my name");
    const state = getItcChannels();
    expect(state.spiritBox?.text).toBe("OAK");
    expect(state.ovilus?.text).toBe("WINDOW");
    expect(state.evp?.text).toBe("did you say my name");
  });
});
