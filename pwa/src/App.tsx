import { useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AcknowledgementGate } from "./components/AcknowledgementGate";
import { AppHeader } from "./components/AppHeader";
import { BottomNav } from "./components/BottomNav";
import { MissionControl } from "./views/MissionControl";
import { Review } from "./views/Review";
import { Setup } from "./views/Setup";
import { Floorplan } from "./views/Floorplan";
import { isPastCivilTwilight } from "./lib/sensors/civilTwilight";
import { applyTheme, setPreferences, usePreferences } from "./lib/preferences";
import "./styles/global.css";

export default function App() {
  const [prefs] = usePreferences();
  const civilTwilightChecked = useRef(false);

  useEffect(() => {
    applyTheme(prefs.theme, prefs.scotopicLevel);
  }, [prefs.theme, prefs.scotopicLevel]);

  // Civil-twilight auto-engage. Runs once on mount only — manual toggling
  // wins for the session.
  useEffect(() => {
    if (civilTwilightChecked.current) return;
    civilTwilightChecked.current = true;
    if (!prefs.scotopicAutoEngage || prefs.theme === "scotopic") return;
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    // Don't prompt — only proceed if the permission has already been granted.
    void (async () => {
      try {
        const status = await (navigator.permissions?.query?.({ name: "geolocation" as PermissionName }) ?? Promise.resolve({ state: "prompt" } as PermissionStatus));
        if (status.state !== "granted") return;
      } catch { return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (!isPastCivilTwilight(new Date(), pos.coords.latitude, pos.coords.longitude)) return;
          setPreferences({ theme: "scotopic", scotopicLevel: "mid" });
          applyTheme("scotopic", "mid");
        },
        () => { /* silent — no nag */ },
        { maximumAge: 600_000, timeout: 5000 },
      );
    })();
  }, [prefs.scotopicAutoEngage, prefs.theme]);

  return (
    <BrowserRouter>
      <AppHeader />
      <main>
        <Routes>
          <Route path="/" element={<MissionControl />} />
          <Route path="/review" element={<Review />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/floorplan" element={<Floorplan />} />
        </Routes>
      </main>
      <BottomNav />
      <AcknowledgementGate />
    </BrowserRouter>
  );
}
