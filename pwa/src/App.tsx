import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AppHeader } from "./components/AppHeader";
import { BottomNav } from "./components/BottomNav";
import { MissionControl } from "./views/MissionControl";
import { Review } from "./views/Review";
import { Setup } from "./views/Setup";
import { Floorplan } from "./views/Floorplan";
import { applyTheme, usePreferences } from "./lib/preferences";
import "./styles/global.css";

export default function App() {
  const [prefs] = usePreferences();
  useEffect(() => {
    applyTheme(prefs.theme);
  }, [prefs.theme]);

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
    </BrowserRouter>
  );
}
