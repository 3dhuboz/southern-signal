import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AppHeader } from "./components/AppHeader";
import { BottomNav } from "./components/BottomNav";
import { MissionControl } from "./views/MissionControl";
import { Review } from "./views/Review";
import { Setup } from "./views/Setup";
import { Export } from "./views/Export";
import "./styles/global.css";

export default function App() {
  return (
    <BrowserRouter>
      <AppHeader />
      <main>
        <Routes>
          <Route path="/" element={<MissionControl />} />
          <Route path="/review" element={<Review />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/export" element={<Export />} />
        </Routes>
      </main>
      <BottomNav />
    </BrowserRouter>
  );
}
