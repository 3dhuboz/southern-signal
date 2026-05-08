import { useCallback, useEffect, useMemo, useState } from "react";
import { recordEvent, recordSensorSample, startInvestigation, stopInvestigation } from "../lib/db/repo";
import { useSensors, type AnomalyTile } from "../lib/sensors/useSensors";
import { requestSensorPermissionsForUserGesture } from "../lib/sensors/permissions";
import { getCurrentPoint } from "../lib/sensors/geolocation";
import { setCurrent, setPermissionsGranted, useSession } from "../lib/session";
import { ensureTodayInvestigation } from "../lib/bootstrap";
import { OvilusTool } from "../components/OvilusTool";
import { SpiritBoxTool } from "../components/SpiritBoxTool";
import s from "./View.module.css";
import m from "./MissionControl.module.css";

function formatHMS(totalSeconds: number): string {
  const t = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(t / 3600).toString().padStart(2, "0");
  const mm = Math.floor((t % 3600) / 60).toString().padStart(2, "0");
  const ss = (t % 60).toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatNumber(n: number, digits = 2): string {
  if (!isFinite(n)) return "—";
  return n.toFixed(digits);
}

interface SensorTileProps {
  label: string;
  unit: string;
  tile: AnomalyTile | null;
  unavailable?: { reason: string };
  decimals?: number;
}

function SensorTile({ label, unit, tile, unavailable, decimals = 2 }: SensorTileProps) {
  return (
    <div className={`${m.tile} ${tile?.alert ? m.tileAlert : ""}`.trim()}>
      <div className={m.tileLabelRow}>
        <span className={m.tileLabel}>{label}</span>
        <span className={m.tileUnit}>{unit}</span>
      </div>
      {unavailable ? (
        <div className={m.tileUnavailable}>{unavailable.reason}</div>
      ) : (
        <>
          <div className={m.tileValue}>{tile ? formatNumber(tile.value, decimals) : "—"}</div>
          <div className={m.tileMeta}>
            {tile ? (
              <>
                <span>μ {formatNumber(tile.mean, decimals)}</span>
                <span>σ {formatNumber(tile.stdev, decimals)}</span>
                <span className={tile.alert ? m.zAlert : m.z}>z {formatNumber(tile.z, 1)}</span>
              </>
            ) : (
              <span>warming up…</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function MissionControl() {
  const session = useSession();
  const sensors = useSensors(session.permissionsGranted);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [statusMsg, setStatusMsg] = useState<string>("Tap Begin to grant sensor permissions and start.");

  // Local 1-second ticker for the timer when running.
  useEffect(() => {
    if (!running) return;
    const handle = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(handle);
  }, [running]);

  const elapsedSeconds = useMemo(() => {
    if (!running || !startedAt) return 0;
    void tick;
    return (Date.now() - startedAt) / 1000;
  }, [running, startedAt, tick]);

  const handleBegin = useCallback(async () => {
    setBusy(true);
    try {
      const perm = await requestSensorPermissionsForUserGesture();
      if (perm.motion === "denied" || perm.orientation === "denied") {
        setStatusMsg("Motion / orientation denied. Sensors won't work — re-add Southern Signal to your home screen and try again.");
        setBusy(false);
        return;
      }
      setPermissionsGranted(true);

      // Make sure we have a current investigation; create one for today if not.
      const inv = await ensureTodayInvestigation();
      setCurrent(inv);
      await startInvestigation(inv.id);
      await recordEvent({ investigation_id: inv.id, source: "system", event_type: "session_start", title: "Session started" });
      setRunning(true);
      setStartedAt(Date.now());
      setStatusMsg("Recording. Phone uploads work right now. Connect a Pi to add live sensor capture later.");
    } catch (err) {
      setStatusMsg(`Couldn't start: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const handleStop = useCallback(async () => {
    if (!session.current) return;
    setBusy(true);
    try {
      await stopInvestigation(session.current.id);
      await recordEvent({ investigation_id: session.current.id, source: "system", event_type: "session_stop", title: "Session ended" });
      setRunning(false);
      setStartedAt(null);
      setStatusMsg("Session stopped. Review evidence in the Review tab.");
    } finally {
      setBusy(false);
    }
  }, [session.current]);

  const handleMarker = useCallback(async () => {
    if (!session.current) return;
    const point = await getCurrentPoint().catch(() => null);
    await recordEvent({
      investigation_id: session.current.id,
      source: "user",
      event_type: "marker",
      title: "Marker",
      metadata: { geo: point },
    });
    setStatusMsg(point ? `Marker dropped (±${Math.round(point.accuracy ?? 0)} m).` : "Marker dropped.");
  }, [session.current]);

  const handleSensorAnomaly = useCallback(async (kind: string, tile: AnomalyTile) => {
    if (!session.current) return;
    await recordSensorSample({
      investigation_id: session.current.id,
      sensor_type: kind,
      value: tile.value,
      metadata: { mean: tile.mean, stdev: tile.stdev, z: tile.z, alert: tile.alert },
    });
  }, [session.current]);

  // Persist sensor anomalies to DB when alert flag flips on.
  useEffect(() => {
    if (sensors.emf?.alert) void handleSensorAnomaly("magnetometer", sensors.emf);
  }, [sensors.emf?.alert, handleSensorAnomaly, sensors.emf]);
  useEffect(() => {
    if (sensors.vibration?.alert) void handleSensorAnomaly("accelerometer", sensors.vibration);
  }, [sensors.vibration?.alert, handleSensorAnomaly, sensors.vibration]);
  useEffect(() => {
    if (sensors.compassAnomaly?.alert) void handleSensorAnomaly("compass", sensors.compassAnomaly);
  }, [sensors.compassAnomaly?.alert, handleSensorAnomaly, sensors.compassAnomaly]);

  const heading = sensors.snapshot.orientation?.heading;
  const headingLabel = heading != null ? `${Math.round(heading)}°` : "—";

  return (
    <section className={s.view}>
      {/* Hero */}
      <div className={m.hero}>
        <div className={m.heroTopRow}>
          <span className={`${m.recPill} ${running ? m.recPillActive : m.recPillIdle}`.trim()}>
            <span className={m.recPillDot} />
            <span>{running ? "RECORDING" : "STANDBY"}</span>
          </span>
          <span className={m.caseId}>
            {session.current ? `CASE ${session.current.id.slice(0, 8).toUpperCase()}` : "NO CASE"}
          </span>
        </div>
        <h1 className={m.heroTitle}>{session.current?.title ?? "Begin a session"}</h1>
        <p className={m.heroSub}>{statusMsg}</p>
        <div className={m.heroTimer}>{formatHMS(elapsedSeconds)}</div>
        <div className={m.heroTimerLabel}>ELAPSED</div>
        <div className={m.heroActions}>
          {!running ? (
            <button className={m.primaryAction} onClick={handleBegin} disabled={busy}>
              {busy ? "…" : "Begin session"}
            </button>
          ) : (
            <>
              <button className={m.dangerAction} onClick={handleStop} disabled={busy}>End session</button>
              <button className={m.secondaryAction} onClick={handleMarker} disabled={busy}>+ Marker</button>
            </>
          )}
        </div>
      </div>

      {/* Real-tools sensor tiles */}
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>Live sensors</span>
      </div>

      <div className={m.tilesGrid}>
        {sensors.magnetometerAvailable ? (
          <SensorTile label="EMF" unit="μT" tile={sensors.emf} decimals={2} />
        ) : (
          <SensorTile
            label="Compass-anomaly"
            unit="°/sample"
            tile={sensors.compassAnomaly}
            decimals={2}
          />
        )}
        <SensorTile label="Vibration" unit="m/s²" tile={sensors.vibration} decimals={3} />
        <SensorTile label="Heading" unit="°" tile={null} unavailable={{ reason: headingLabel }} />
        {sensors.lightAvailable ? (
          <SensorTile label="Ambient light" unit="lux" tile={sensors.lightAnomaly} decimals={1} />
        ) : (
          <SensorTile label="Ambient light" unit="lux" tile={null} unavailable={{ reason: "iOS: ALS unavailable. Camera fallback comes next." }} />
        )}
      </div>

      {!sensors.magnetometerAvailable && (
        <p className={m.platformNote}>
          Real magnetometer-based EMF is Android-only. iOS gets a compass-anomaly proxy here — it's labelled honestly so you know which signal you're seeing.
        </p>
      )}

      <SpiritBoxTool entropy={sensors.snapshot.magnetometer?.magnitude ?? sensors.snapshot.motion?.accelMagnitude ?? 0} />
      <OvilusTool entropy={sensors.snapshot.magnetometer?.magnitude ?? sensors.snapshot.orientation?.heading ?? 0} investigationId={session.current?.id ?? null} />
    </section>
  );
}
