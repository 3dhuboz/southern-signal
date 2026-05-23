import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FB_CONNECT_TOKEN_LEGACY_KEY,
  FB_STREAM_KEY_SESSION_KEY,
  WHIP_BEARER_KEY,
  WHIP_PROVIDER_KEY,
  WHIP_URL_KEY,
  clearWhipBroadcastConfig,
  readStoredWhipBearer,
  readStoredWhipUrl,
  saveWhipBroadcastConfig,
} from "./whipStorage";

function makeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => { data.delete(key); },
    setItem: (key: string, value: string) => { data.set(key, value); },
  } as Storage;
}

describe("WHIP broadcast storage", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeStorage());
    vi.stubGlobal("sessionStorage", makeStorage());
  });

  it("keeps bearer tokens in sessionStorage and removes legacy localStorage copies", () => {
    localStorage.setItem(WHIP_BEARER_KEY, "legacy-secret");
    expect(readStoredWhipBearer()).toBe("legacy-secret");
    expect(sessionStorage.getItem(WHIP_BEARER_KEY)).toBe("legacy-secret");
    expect(localStorage.getItem(WHIP_BEARER_KEY)).toBeNull();

    saveWhipBroadcastConfig({ provider: "cloudflare", url: "https://example.com/webrtc/publish", bearer: "next-secret" });
    expect(sessionStorage.getItem(WHIP_BEARER_KEY)).toBe("next-secret");
    expect(localStorage.getItem(WHIP_BEARER_KEY)).toBeNull();
  });

  it("does not persist stream-key WHIP URLs for providers where the URL itself is secret", () => {
    saveWhipBroadcastConfig({ provider: "mux", url: "https://global-live.mux.com/api/whip/secret-key", bearer: "" });
    expect(sessionStorage.getItem(WHIP_URL_KEY)).toBe("https://global-live.mux.com/api/whip/secret-key");
    expect(localStorage.getItem(WHIP_URL_KEY)).toBeNull();
    expect(readStoredWhipUrl("mux")).toBe("https://global-live.mux.com/api/whip/secret-key");
  });

  it("allows tokenless Cloudflare WHIP URLs to persist for one-tap relaunch", () => {
    saveWhipBroadcastConfig({ provider: "cloudflare", url: "https://customer.example/webrtc/publish", bearer: "" });
    expect(localStorage.getItem(WHIP_PROVIDER_KEY)).toBe("cloudflare");
    expect(localStorage.getItem(WHIP_URL_KEY)).toBe("https://customer.example/webrtc/publish");
  });

  it("does not persist Facebook relay WHIP URLs beyond the current session", () => {
    saveWhipBroadcastConfig({ provider: "fb_live_via_cloudflare", url: "https://customer.example/webrtc/publish", bearer: "" });
    expect(sessionStorage.getItem(WHIP_URL_KEY)).toBe("https://customer.example/webrtc/publish");
    expect(localStorage.getItem(WHIP_URL_KEY)).toBeNull();
  });

  it("clears active-session and legacy Facebook connector secrets", () => {
    sessionStorage.setItem(FB_STREAM_KEY_SESSION_KEY, "fb-stream");
    localStorage.setItem(FB_STREAM_KEY_SESSION_KEY, "legacy-fb-stream");
    localStorage.setItem(FB_CONNECT_TOKEN_LEGACY_KEY, "legacy-token");
    clearWhipBroadcastConfig();
    expect(sessionStorage.getItem(FB_STREAM_KEY_SESSION_KEY)).toBeNull();
    expect(localStorage.getItem(FB_STREAM_KEY_SESSION_KEY)).toBeNull();
    expect(localStorage.getItem(FB_CONNECT_TOKEN_LEGACY_KEY)).toBeNull();
  });
});
