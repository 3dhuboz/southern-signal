/**
 * DeploymentHealth — Setup-page tile that fetches /api/health and
 * shows which server features the current deployment has configured.
 * Lets the operator tell at a glance whether AI research / sync /
 * live-relay / cloud transcribe will actually work.
 *
 * Never exposes any credential value — the endpoint only returns
 * booleans and the model slug.
 */

import { useCallback, useEffect, useState } from "react";
import s from "./DeploymentHealth.module.css";

interface Health {
  ok: boolean;
  timestamp: string;
  features: {
    ai_research: { configured: boolean; model: string; rate_limit_kv: boolean };
    ai_transcribe: { configured: boolean };
    sync: { configured: boolean; has_kv_token: boolean; has_d1: boolean; has_r2: boolean };
    radio_proxy: { ok: boolean };
    live_relay: { configured: boolean };
  };
}

interface Status {
  state: "idle" | "loading" | "ok" | "error";
  data?: Health;
  errorMessage?: string;
}

export function DeploymentHealth() {
  const [status, setStatus] = useState<Status>({ state: "idle" });

  const refresh = useCallback(async () => {
    setStatus({ state: "loading" });
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) throw new Error(`Health endpoint returned ${res.status}`);
      const data = await res.json() as Health;
      setStatus({ state: "ok", data });
    } catch (err) {
      setStatus({ state: "error", errorMessage: (err as Error).message });
    }
  }, []);

  // Fetch once on mount. Cheap call (just env-presence checks), but
  // not auto-refreshed — operator hits the button if they want a re-check.
  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className={s.wrap}>
      <div className={s.headRow}>
        <p className={s.lede}>
          Reports which server-side features are configured on this deployment. Toggle the
          underlying secrets in the Cloudflare Pages dashboard — this panel never exposes a
          credential, only whether one's wired up.
        </p>
        <button
          type="button"
          className={s.refreshBtn}
          onClick={() => void refresh()}
          disabled={status.state === "loading"}
        >
          {status.state === "loading" ? "Checking…" : "Re-check"}
        </button>
      </div>

      {status.state === "error" && (
        <p className={s.error}>Couldn't fetch /api/health: {status.errorMessage}</p>
      )}

      {status.state === "ok" && status.data && (
        <ul className={s.list}>
          <FeatureRow
            label="AI Investigator (research)"
            ok={status.data.features.ai_research.configured}
            detail={`Model: ${status.data.features.ai_research.model.replace(/^.*\//, "")}${status.data.features.ai_research.rate_limit_kv ? " · KV rate-limit on" : " · KV rate-limit OFF"}`}
            envHint="OPENROUTER_API_KEY (+ optional AI_RATE_LIMIT KV binding)"
          />
          <FeatureRow
            label="EVP cloud transcribe"
            ok={status.data.features.ai_transcribe.configured}
            detail={status.data.features.ai_transcribe.configured ? "Whisper available off-device." : "Local Whisper still works regardless."}
            envHint="OPENAI_API_KEY"
          />
          <FeatureRow
            label="Cloud sync"
            ok={status.data.features.sync.configured}
            detail={[
              status.data.features.sync.has_kv_token ? "token ✓" : "token ✗",
              status.data.features.sync.has_d1 ? "D1 ✓" : "D1 ✗",
              status.data.features.sync.has_r2 ? "R2 ✓" : "R2 ✗",
            ].join(" · ")}
            envHint="SYNC_TOKEN + SYNC_DB (D1) + MEDIA_BUCKET (R2)"
          />
          <FeatureRow
            label="Radio CORS proxy"
            ok={status.data.features.radio_proxy.ok}
            detail="Spirit-box Radio mode CORS shim — no env needed."
            envHint={null}
          />
          <FeatureRow
            label="Live broadcast relay (WHIP)"
            ok={status.data.features.live_relay.configured}
            detail={status.data.features.live_relay.configured ? "WHIP relay endpoint configured." : "Local recording still works. WHIP broadcast skipped."}
            envHint="WHIP_RELAY_TOKEN + WHIP_RELAY_ENDPOINT"
          />
        </ul>
      )}

      {status.state === "ok" && status.data && (
        <p className={s.timestamp}>
          Checked {new Date(status.data.timestamp).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

function FeatureRow({ label, ok, detail, envHint }: {
  label: string;
  ok: boolean;
  detail: string;
  envHint: string | null;
}) {
  return (
    <li className={`${s.row} ${ok ? s.rowOk : s.rowOff}`.trim()}>
      <span className={s.dot} aria-hidden="true" />
      <div className={s.rowBody}>
        <span className={s.rowLabel}>{label}</span>
        <span className={s.rowDetail}>{detail}</span>
        {envHint && !ok && <code className={s.rowEnvHint}>{envHint}</code>}
      </div>
      <span className={s.rowStatus}>{ok ? "ON" : "OFF"}</span>
    </li>
  );
}
