/**
 * usePwaInstall — capture the browser's `beforeinstallprompt` event and
 * surface an imperative `prompt()` for the UI to call.
 *
 * Browser support is uneven:
 *   • Android Chrome / Edge: fires beforeinstallprompt when criteria are met.
 *   • Desktop Chrome / Edge: same.
 *   • iOS Safari: does NOT fire — operators must use the Share → Add to Home
 *     Screen flow manually. The hook returns `iosManualOnly: true` so the UI
 *     can show iOS-specific instructions instead of an inert button.
 *   • Firefox: no install API; hook just returns `unavailable: true`.
 *
 * The standalone check (`display-mode: standalone`) suppresses the prompt
 * surface entirely once the operator HAS installed — otherwise a "Install"
 * button persists on the already-installed app forever.
 */

import { useCallback, useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type PwaInstallStatus =
  | { kind: "ready"; prompt: () => Promise<"accepted" | "dismissed"> }
  | { kind: "installed" }
  | { kind: "ios-manual" }
  | { kind: "unavailable" };

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(display-mode: standalone)")?.matches) return true;
  // iOS exposes a non-standard navigator.standalone bit on the home-screen build.
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !("MSStream" in window);
}

export function usePwaInstall(): PwaInstallStatus {
  const [stash, setStash] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(isStandalone);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      // Prevent the browser's mini-infobar so we own the surface.
      e.preventDefault();
      setStash(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => { setInstalled(true); setStash(null); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const prompt = useCallback(async (): Promise<"accepted" | "dismissed"> => {
    if (!stash) return "dismissed";
    try {
      await stash.prompt();
      const choice = await stash.userChoice;
      setStash(null);
      return choice.outcome;
    } catch {
      return "dismissed";
    }
  }, [stash]);

  if (installed) return { kind: "installed" };
  if (stash) return { kind: "ready", prompt };
  if (isIos()) return { kind: "ios-manual" };
  return { kind: "unavailable" };
}
