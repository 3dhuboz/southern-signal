import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./lib/registerServiceWorker.ts";
import { startSyncWorker } from "./lib/sync/syncWorker";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Kick off background sync worker after first paint. Failures are logged but
// never block app boot — the worker re-tries on visibility/online events.
void startSyncWorker().catch((err) => console.warn("[sync] startSyncWorker failed", err));
