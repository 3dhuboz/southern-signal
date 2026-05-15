/**
 * ControlSessionPanel — Sham/Control Sessions (Tier 3 #1).
 *
 * When the investigation is an active session:
 *   - Lists paired control sessions
 *   - Offers "Add Control Session" inline form
 *
 * When the investigation is a control session:
 *   - Shows a prominent info banner linking back to the paired active session
 *   - Renders a side-by-side SVG bar chart comparing mean sensor values
 *     (active = signal/teal, control = amber)
 */

import { useCallback, useEffect, useState } from "react";
import type { Investigation, SensorSample } from "../lib/db/schema";
import {
  createControlSession,
  getPairedInvestigation,
  listControlSessions,
  listRecentSensorSamples,
} from "../lib/db/repo";
import s from "./ControlSessionPanel.module.css";

// ── Types ─────────────────────────────────────────────────────────────────

interface ControlSessionPanelProps {
  investigation: Investigation;
  allInvestigations: Investigation[];
  onSelectInvestigation: (id: string) => void;
}

/** Mean sensor value keyed by sensor_type. */
type SensorMeans = Record<string, number>;

// ── Helpers ───────────────────────────────────────────────────────────────

function computeMeans(samples: SensorSample[]): SensorMeans {
  const sums: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const sample of samples) {
    if (sample.value === null) continue;
    const type = sample.sensor_type;
    sums[type] = (sums[type] ?? 0) + sample.value;
    counts[type] = (counts[type] ?? 0) + 1;
  }
  const means: SensorMeans = {};
  for (const type of Object.keys(sums)) {
    const count = counts[type];
    // count is always > 0 here because we only populate sums when value !== null
    if (count > 0) {
      means[type] = (sums[type] ?? 0) / count;
    }
  }
  return means;
}

/** Absolute-value mean (useful for magnetometer/motion which may go negative). */
function absMeans(means: SensorMeans): SensorMeans {
  const out: SensorMeans = {};
  for (const [k, v] of Object.entries(means)) {
    out[k] = Math.abs(v);
  }
  return out;
}

// ── Sub-component: sensor comparison chart ───────────────────────────────

interface SensorChartProps {
  activeMeans: SensorMeans;
  controlMeans: SensorMeans;
}

const CHART_BAR_W = 18;
const CHART_BAR_GAP = 4;
const CHART_GROUP_GAP = 24;
const CHART_H = 120;
const CHART_LABEL_H = 22;
const CHART_PAD_LEFT = 44;
const CHART_PAD_RIGHT = 12;
const CHART_COLOR_ACTIVE = "#5df2c7";
const CHART_COLOR_CONTROL = "#f0b429";

function SensorComparisonChart({ activeMeans, controlMeans }: SensorChartProps) {
  // Only chart sensor types that appear in at least one session.
  const allTypes = Array.from(
    new Set([...Object.keys(activeMeans), ...Object.keys(controlMeans)]),
  ).sort();

  if (allTypes.length === 0) {
    return <p className={s.chartEmpty}>No sensor data recorded for either session yet.</p>;
  }

  const absActive = absMeans(activeMeans);
  const absControl = absMeans(controlMeans);

  // Y-axis: find global max.
  const allVals: number[] = [];
  for (const type of allTypes) {
    if (absActive[type] !== undefined) allVals.push(absActive[type] as number);
    if (absControl[type] !== undefined) allVals.push(absControl[type] as number);
  }
  // Non-null assertion is safe: allVals is guaranteed non-empty because
  // allTypes is non-empty and each type has at least one value in one of the maps.
  const maxVal = Math.max(...allVals, 1); // floor at 1 to avoid divide-by-zero

  // SVG dimensions.
  const groupW = CHART_BAR_W * 2 + CHART_BAR_GAP;
  const totalW =
    CHART_PAD_LEFT +
    CHART_PAD_RIGHT +
    allTypes.length * groupW +
    (allTypes.length - 1) * CHART_GROUP_GAP;
  const totalH = CHART_H + CHART_LABEL_H + 4;

  const barY = (val: number) => CHART_H - (val / maxVal) * CHART_H;
  const barHeight = (val: number) => (val / maxVal) * CHART_H;

  // Y-axis labels (3 ticks).
  const yTicks = [0, maxVal / 2, maxVal].map((v, i) => ({
    val: v,
    y: CHART_H - (v / maxVal) * CHART_H,
    label: i === 0 ? "0" : v.toFixed(2),
  }));

  return (
    <svg
      viewBox={`0 0 ${totalW} ${totalH}`}
      width={totalW}
      height={totalH}
      style={{ display: "block", overflow: "visible" }}
      aria-label="Sensor comparison: active vs control session means"
      role="img"
    >
      {/* Y-axis gridlines + labels */}
      {yTicks.map((t) => (
        <g key={t.label}>
          <line
            x1={CHART_PAD_LEFT}
            y1={t.y}
            x2={totalW - CHART_PAD_RIGHT}
            y2={t.y}
            stroke="var(--border-subtle)"
            strokeWidth={0.6}
            strokeDasharray={t.val === 0 ? undefined : "3 3"}
          />
          <text
            x={CHART_PAD_LEFT - 4}
            y={t.y + 4}
            textAnchor="end"
            fontSize={8}
            fill="var(--text-muted)"
            fontFamily="var(--font-mono)"
          >
            {t.label}
          </text>
        </g>
      ))}

      {/* Bars per sensor type */}
      {allTypes.map((type, gi) => {
        const groupX = CHART_PAD_LEFT + gi * (groupW + CHART_GROUP_GAP);
        const activeVal = absActive[type] ?? 0;
        const controlVal = absControl[type] ?? 0;

        return (
          <g key={type}>
            {/* Active bar */}
            <rect
              x={groupX}
              y={barY(activeVal)}
              width={CHART_BAR_W}
              height={Math.max(barHeight(activeVal), 1)}
              fill={CHART_COLOR_ACTIVE}
              opacity={0.88}
              rx={2}
            />
            {/* Control bar */}
            <rect
              x={groupX + CHART_BAR_W + CHART_BAR_GAP}
              y={barY(controlVal)}
              width={CHART_BAR_W}
              height={Math.max(barHeight(controlVal), 1)}
              fill={CHART_COLOR_CONTROL}
              opacity={0.88}
              rx={2}
            />
            {/* Sensor label */}
            <text
              x={groupX + groupW / 2}
              y={CHART_H + CHART_LABEL_H - 2}
              textAnchor="middle"
              fontSize={9}
              fill="var(--text-muted)"
              fontFamily="var(--font-mono)"
            >
              {type.slice(0, 8)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export function ControlSessionPanel({
  investigation,
  onSelectInvestigation,
}: ControlSessionPanelProps) {
  const isControl = investigation.session_type === "control";

  // ---- Active session state ----
  const [controlSessions, setControlSessions] = useState<Investigation[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [formTitle, setFormTitle] = useState("");
  const [formLocation, setFormLocation] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // ---- Control session state ----
  const [pairedInvestigation, setPairedInvestigation] = useState<Investigation | null>(null);
  const [pairedLoading, setPairedLoading] = useState(false);
  const [activeMeans, setActiveMeans] = useState<SensorMeans>({});
  const [controlMeans, setControlMeans] = useState<SensorMeans>({});
  const [chartLoading, setChartLoading] = useState(false);

  const loadControlSessions = useCallback(async () => {
    if (isControl) return;
    const sessions = await listControlSessions(investigation.id);
    setControlSessions(sessions);
  }, [investigation.id, isControl]);

  useEffect(() => {
    void loadControlSessions();
  }, [loadControlSessions]);

  useEffect(() => {
    if (!isControl) return;
    setPairedLoading(true);
    void getPairedInvestigation(investigation.id)
      .then((inv) => setPairedInvestigation(inv))
      .finally(() => setPairedLoading(false));
  }, [investigation.id, isControl]);

  // Load sensor data for the chart (control-session view only).
  useEffect(() => {
    if (!isControl || !investigation.paired_investigation_id) return;
    setChartLoading(true);
    const activeId = investigation.paired_investigation_id;
    const controlId = investigation.id;
    void Promise.all([
      listRecentSensorSamples(activeId, 500),
      listRecentSensorSamples(controlId, 500),
    ])
      .then(([activeSamples, controlSamples]) => {
        setActiveMeans(computeMeans(activeSamples));
        setControlMeans(computeMeans(controlSamples));
      })
      .finally(() => setChartLoading(false));
  }, [investigation.id, investigation.paired_investigation_id, isControl]);

  const handleOpenAddForm = () => {
    setFormTitle(`Control — ${investigation.title}`);
    setFormLocation(investigation.location_name ?? "");
    setFormNotes("");
    setFormError(null);
    setShowAddForm(true);
  };

  const handleCancelAddForm = () => {
    setShowAddForm(false);
    setFormError(null);
  };

  const handleCreateControl = async () => {
    const title = formTitle.trim();
    if (!title) {
      setFormError("Title is required.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await createControlSession(investigation.id, {
        title,
        location_name: formLocation.trim() || undefined,
        notes: formNotes.trim() || undefined,
      });
      setShowAddForm(false);
      await loadControlSessions();
    } catch (err) {
      setFormError(`Failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  // ── Control session view ──────────────────────────────────────────────

  if (isControl) {
    return (
      <div className={s.section}>
        <div className={s.controlBanner}>
          <span className={s.controlBannerIcon} aria-hidden="true">⊘</span>
          <p className={s.controlBannerText}>
            <strong>Control session</strong>
            Run under matched conditions with intentional null stimuli — no
            prompts, no rituals, just the ambient environment.
            {pairedLoading && " Loading paired investigation…"}
            {!pairedLoading && pairedInvestigation && (
              <>
                {" "}
                <button
                  type="button"
                  className={s.pairedLink}
                  onClick={() => onSelectInvestigation(pairedInvestigation.id)}
                >
                  Back to: {pairedInvestigation.title}
                </button>
              </>
            )}
            {!pairedLoading && !pairedInvestigation && investigation.paired_investigation_id && (
              <>{" "}(Paired investigation not found.)</>
            )}
          </p>
        </div>

        {/* Sensor comparison */}
        {investigation.paired_investigation_id && (
          <div className={s.chartSection}>
            <p className={s.chartTitle}>Sensor comparison — active vs control mean values</p>
            {chartLoading ? (
              <p className={s.chartEmpty}>Loading sensor data…</p>
            ) : (
              <div className={s.chartWrap}>
                <SensorComparisonChart
                  activeMeans={activeMeans}
                  controlMeans={controlMeans}
                />
                <div className={s.chartLegend}>
                  <span className={s.legendItem}>
                    <span className={`${s.legendSwatch} ${s.legendSwatchActive}`} />
                    Active
                  </span>
                  <span className={s.legendItem}>
                    <span className={`${s.legendSwatch} ${s.legendSwatchControl}`} />
                    Control
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Active session view ───────────────────────────────────────────────

  return (
    <div className={s.section}>
      <div className={s.sectionHead}>
        <p className={s.eyebrow}>
          Control Sessions ({controlSessions.length})
        </p>
        {!showAddForm && (
          <button type="button" className={s.addBtn} onClick={handleOpenAddForm}>
            + Add Control Session
          </button>
        )}
      </div>

      {/* Inline add form */}
      {showAddForm && (
        <div className={s.addForm}>
          <label className={s.field}>
            <span className={s.fieldLabel}>Title</span>
            <input
              className={s.input}
              value={formTitle}
              autoFocus
              onChange={(e) => setFormTitle(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              placeholder="Control session title"
            />
          </label>
          <label className={s.field}>
            <span className={s.fieldLabel}>Location (optional)</span>
            <input
              className={s.input}
              value={formLocation}
              onChange={(e) => setFormLocation(e.target.value)}
              placeholder={investigation.location_name ?? "Same as active session"}
            />
          </label>
          <label className={s.field}>
            <span className={s.fieldLabel}>Notes (optional)</span>
            <textarea
              className={s.textarea}
              rows={3}
              value={formNotes}
              onChange={(e) => setFormNotes(e.target.value)}
              placeholder="Conditions, time of night, equipment used…"
            />
          </label>
          {formError && <p className={s.error}>{formError}</p>}
          <div className={s.formActions}>
            <button
              type="button"
              className={s.btnPrimary}
              onClick={handleCreateControl}
              disabled={saving}
            >
              {saving ? "Creating…" : "Create control session"}
            </button>
            <button type="button" className={s.btnGhost} onClick={handleCancelAddForm}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Paired control sessions list */}
      {controlSessions.length === 0 && !showAddForm ? (
        <p className={s.empty}>
          No control sessions yet. Add one to establish a baseline.
        </p>
      ) : (
        <ul className={s.list}>
          {controlSessions.map((ctrl) => (
            <li key={ctrl.id}>
              <button
                type="button"
                className={s.listItem}
                onClick={() => onSelectInvestigation(ctrl.id)}
              >
                <span className={s.listItemTitle}>{ctrl.title}</span>
                <span className={s.listItemMeta}>
                  {new Date(ctrl.created_at).toLocaleString()}
                </span>
                <span className={s.statusChip} data-status={ctrl.status}>
                  {ctrl.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
