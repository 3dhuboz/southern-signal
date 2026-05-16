import { lazy, Suspense, useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { AcknowledgementGate } from "./components/AcknowledgementGate";
import { OnboardingTour } from "./components/OnboardingTour";
import { AppHeader } from "./components/AppHeader";
import { BottomNav } from "./components/BottomNav";
import { CivilTwilightBanner } from "./components/CivilTwilightBanner";
import { InterruptedSessionBanner } from "./components/InterruptedSessionBanner";
import { ServiceWorkerUpdateBanner } from "./components/ServiceWorkerUpdateBanner";
import { CameraScreen } from "./views/CameraScreen";
import { sunAltitudeDeg } from "./lib/sensors/civilTwilight";
import { applyTheme, setPreferences, usePreferences } from "./lib/preferences";
import "./styles/global.css";

// Code-split secondary routes — CameraScreen is the entry screen (kept eager
// for fast first paint). Everything else loads on demand over field connections.
// MissionControl is demoted to `/lab` — kept available for pro users behind
// a Setup toggle, but the CameraScreen is the entire product surface.
const MissionControl = lazy(() => import("./views/MissionControl").then((m) => ({ default: m.MissionControl })));
const Review = lazy(() => import("./views/Review").then((m) => ({ default: m.Review })));
const Setup = lazy(() => import("./views/Setup").then((m) => ({ default: m.Setup })));
const EvpReview = lazy(() => import("./views/EvpReview").then((m) => ({ default: m.EvpReview })));
const HuntSetup = lazy(() => import("./views/HuntSetup").then((m) => ({ default: m.HuntSetup })));
const Estes = lazy(() => import("./views/Estes").then((m) => ({ default: m.Estes })));
const EvidenceBrief = lazy(() => import("./views/EvidenceBrief").then((m) => ({ default: m.EvidenceBrief })));
const Research = lazy(() => import("./views/Research").then((m) => ({ default: m.Research })));
const DossierPrint = lazy(() => import("./views/DossierPrint").then((m) => ({ default: m.DossierPrint })));
const CommunityMap = lazy(() => import("./views/CommunityMap").then((m) => ({ default: m.CommunityMap })));
const About = lazy(() => import("./views/About").then((m) => ({ default: m.About })));

function RouteFallback() {
  return (
    <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: 1.4, textTransform: "uppercase" }}>
      Loading…
    </div>
  );
}

/**
 * AppHeader is suppressed on the `/` camera route — the camera surface
 * mimics the system camera (Snapchat / iPhone-camera) and floats its
 * own corner pills directly over the live video. Every secondary route
 * (Setup, EVP, Review, Lab, etc.) keeps the standard sticky header so
 * navigation stays grounded outside the camera.
 */
function ChromeHeader() {
  const location = useLocation();
  if (location.pathname === "/") return null;
  return <AppHeader />;
}

export default function App() {
  const [prefs] = usePreferences();
  const civilTwilightChecked = useRef(false);

  useEffect(() => {
    applyTheme(prefs.theme, prefs.scotopicLevel);
  }, [prefs.theme, prefs.scotopicLevel]);

  // Time-of-day theme auto-engage. Runs once on mount only — manual
  // toggling wins for the session. Symmetric:
  //   sun altitude ≤ -6°  (past civil dusk)        → scotopic mid
  //   sun altitude ≥ +6°  (definitively daylight)  → daylight
  //   in between (civil twilight): leave the current theme alone
  // Only fires when the geolocation permission was previously granted —
  // never prompts, never nags.
  useEffect(() => {
    if (civilTwilightChecked.current) return;
    civilTwilightChecked.current = true;
    if (!prefs.scotopicAutoEngage) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    void (async () => {
      try {
        const status = await (navigator.permissions?.query?.({ name: "geolocation" as PermissionName }) ?? Promise.resolve({ state: "prompt" } as PermissionStatus));
        if (status.state !== "granted") return;
      } catch { return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const altDeg = sunAltitudeDeg(new Date(), pos.coords.latitude, pos.coords.longitude);
          if (altDeg <= -6 && prefs.theme !== "scotopic") {
            setPreferences({ theme: "scotopic", scotopicLevel: "mid" });
            applyTheme("scotopic", "mid");
          } else if (altDeg >= 6 && prefs.theme !== "daylight") {
            setPreferences({ theme: "daylight" });
            applyTheme("daylight");
          }
          // Civil twilight band (-6° < altitude < +6°): leave the existing
          // theme — operator's manual choice or the persisted default wins.
        },
        () => { /* silent — no nag */ },
        { maximumAge: 600_000, timeout: 5000 },
      );
    })();
  }, [prefs.scotopicAutoEngage, prefs.theme]);

  return (
    <BrowserRouter>
      <ChromeHeader />
      <ServiceWorkerUpdateBanner />
      <CivilTwilightBanner />
      <InterruptedSessionBanner />
      <main>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<CameraScreen />} />
            <Route path="/hunt-setup" element={<HuntSetup />} />
            {/* MissionControl now lives at /lab — Pro / Lab view, demoted from
                primary nav so the Camera screen is the entire default surface. */}
            <Route path="/lab" element={<MissionControl />} />
            {/* Back-compat alias so older bookmarks and in-app links keep working. */}
            <Route path="/investigate" element={<MissionControl />} />
            <Route path="/review" element={<Review />} />
            <Route path="/evp" element={<EvpReview />} />
            <Route path="/estes" element={<Estes />} />
            <Route path="/setup" element={<Setup />} />
            <Route path="/brief" element={<EvidenceBrief />} />
            <Route path="/brief/:investigationId" element={<EvidenceBrief />} />
            <Route path="/research" element={<Research />} />
            <Route path="/dossier/:id" element={<DossierPrint />} />
            <Route path="/community" element={<CommunityMap />} />
            <Route path="/about" element={<About />} />
          </Routes>
        </Suspense>
      </main>
      <BottomNav />
      <AcknowledgementGate />
      <OnboardingTour />
    </BrowserRouter>
  );
}
