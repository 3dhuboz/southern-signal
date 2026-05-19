/**
 * ProtocolWizard — pre-registered hypothesis form (Tier 2 #4).
 *
 * 4-step flow:
 *  1. Hypothesis statement (free text, ≥ 30 chars).
 *  2. Expected signal types (multi-select checkboxes + optional "other" field).
 *  3. Zones, time windows, and stop-rule.
 *  4. Review & lock (SHA-256 on canonical JSON; shown read-only once locked).
 *
 * When `lockedHash` prop is set the entire wizard renders in read-only mode
 * without going through the steps — useful for viewing a past protocol.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { saveProtocol, lockProtocol } from "../lib/db/protocolRepo";
import type { InvestigationProtocol } from "../lib/db/schema";
import { useFocusTrap } from "../hooks/useFocusTrap";
import s from "./ProtocolWizard.module.css";

// ── Constants ────────────────────────────────────────────────────────────────

const SIGNAL_OPTIONS = [
  { key: "acoustic",     label: "Acoustic anomaly" },
  { key: "emf",         label: "EMF fluctuation" },
  { key: "thermal",     label: "Temperature differential" },
  { key: "motion",      label: "Motion / vibration" },
  { key: "light",       label: "Light change" },
  { key: "infrasound",  label: "Infrasound (< 20 Hz)" },
  { key: "visual",      label: "Visual / shadow" },
  { key: "other",       label: "Other" },
] as const;

const DURATION_OPTIONS = [15, 20, 30, 45, 60, 90] as const;
const TOTAL_STEPS = 4;
const MIN_HYPOTHESIS = 30;
const MIN_STOP_CONDITION = 20;

// ── Types ─────────────────────────────────────────────────────────────────────

interface WindowDraft {
  label: string;
  start_iso: string;   // <input type="time"> gives HH:MM — we convert on save
  duration_min: number;
}

export interface ProtocolWizardProps {
  investigationId: string;
  /** If set the protocol is locked and the wizard opens in read-only mode. */
  lockedHash?: string | null;
  /** Draft protocol to pre-populate (only used in edit mode). */
  initialProtocol?: InvestigationProtocol | null;
  onSave?: (protocol: InvestigationProtocol) => void;
  onLock?: (hash: string) => void;
  onClose?: () => void;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

/** Convert a time-picker value (HH:MM) to today's ISO string. */
function timeToIso(hhmm: string): string {
  if (!hhmm) return new Date().toISOString();
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

/** Format an ISO string back to HH:MM for a time-picker. */
function isoToTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

// ── Read-only view ────────────────────────────────────────────────────────────

function ReadOnlyView({
  protocol,
  hash,
  onClose,
}: {
  protocol: InvestigationProtocol;
  hash: string;
  onClose?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  // a11y: trap focus inside the read-only view. Escape calls onClose if
  // provided — when omitted, the view is embedded and Escape is a no-op.
  const trapRef = useFocusTrap<HTMLDivElement>(true, {
    onEscape: () => onClose?.(),
  });

  const handleCopy = async () => {
    await navigator.clipboard.writeText(hash).catch(() => { /* ignore */ });
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className={s.backdrop} role="dialog" aria-modal="true" aria-label="Locked protocol" ref={trapRef} tabIndex={-1}>
      <div className={s.card}>
        <div className={s.header}>
          <span className={s.headerIcon}>🔒</span>
          <div className={s.headerText}>
            <h2 className={s.headerTitle}>Pre-registered Protocol</h2>
            <p className={s.headerSub}>Locked — read only</p>
          </div>
          {onClose && (
            <button type="button" className={s.closeBtn} onClick={onClose} aria-label="Close">×</button>
          )}
        </div>

        <div className={s.readOnlyBody}>
          <div>
            <div className={s.lockedBadge}>
              <span className={s.lockedDot} aria-hidden="true" />
              LOCKED · SHA-256: {hash.slice(0, 16)}…
            </div>
          </div>

          <div className={s.hashBlock}>
            <p className={s.hashLabel}>Full SHA-256 hash</p>
            <div className={s.hashCode}>
              <span>{hash}</span>
              <button type="button" className={s.copyBtn} onClick={handleCopy}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <ReviewSections protocol={protocol} />
        </div>

        <div className={s.footer}>
          {onClose && (
            <button type="button" className={s.btnBack} onClick={onClose}>Close</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Review sections (shared between Step 4 and ReadOnlyView) ──────────────────

function ReviewSections({ protocol }: { protocol: InvestigationProtocol }) {
  return (
    <>
      <div className={s.reviewSection}>
        <p className={s.reviewLabel}>Hypothesis</p>
        <div className={s.reviewValue}>{protocol.hypothesis}</div>
      </div>

      <div className={s.reviewSection}>
        <p className={s.reviewLabel}>Expected signals</p>
        <div className={s.reviewPills}>
          {protocol.predicted_signals.length === 0 ? (
            <span className={s.reviewPill}>None specified</span>
          ) : (
            protocol.predicted_signals.map((sig) => (
              <span key={sig} className={s.reviewPill}>{sig}</span>
            ))
          )}
        </div>
      </div>

      {protocol.zones.length > 0 && (
        <div className={s.reviewSection}>
          <p className={s.reviewLabel}>Zones to monitor</p>
          <div className={s.reviewPills}>
            {protocol.zones.map((z) => (
              <span key={z} className={s.reviewPill}>{z}</span>
            ))}
          </div>
        </div>
      )}

      {protocol.windows.length > 0 && (
        <div className={s.reviewSection}>
          <p className={s.reviewLabel}>Investigation windows</p>
          {protocol.windows.map((w, i) => (
            <div key={i} className={s.reviewValue} style={{ marginBottom: "4px" }}>
              {w.label ? `${w.label} · ` : ""}{new Date(w.start_iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} for {w.duration_min} min
            </div>
          ))}
        </div>
      )}

      <div className={s.reviewSection}>
        <p className={s.reviewLabel}>Stop condition</p>
        <div className={s.reviewValue}>{protocol.stop_condition}</div>
      </div>

      <div className={s.reviewSection}>
        <p className={s.reviewLabel}>Authored at</p>
        <div className={s.reviewValue}>
          {new Date(protocol.authored_at).toLocaleString()}
        </div>
      </div>
    </>
  );
}

// ── Zone tag input ────────────────────────────────────────────────────────────

function ZoneTagInput({
  zones,
  onChange,
}: {
  zones: string[];
  onChange: (zones: string[]) => void;
}) {
  const [raw, setRaw] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addZone = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || zones.includes(trimmed)) return;
      onChange([...zones, trimmed]);
      setRaw("");
    },
    [zones, onChange],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addZone(raw);
    } else if (e.key === "Backspace" && raw === "" && zones.length > 0) {
      onChange(zones.slice(0, -1));
    }
  };

  return (
    <div
      className={s.tagInput}
      onClick={() => inputRef.current?.focus()}
    >
      {zones.map((z) => (
        <span key={z} className={s.tag}>
          {z}
          <button
            type="button"
            className={s.tagRemove}
            onClick={(e) => { e.stopPropagation(); onChange(zones.filter((x) => x !== z)); }}
            aria-label={`Remove zone ${z}`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        className={s.tagRawInput}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (raw.trim()) addZone(raw); }}
        placeholder={zones.length === 0 ? "Type a zone name, press Enter to add…" : "Add another…"}
        aria-label="Add zone"
      />
    </div>
  );
}

// ── Main wizard ───────────────────────────────────────────────────────────────

export function ProtocolWizard({
  investigationId,
  lockedHash,
  initialProtocol,
  onSave,
  onLock,
  onClose,
}: ProtocolWizardProps) {
  // ── State ──
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [locking, setLocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedHashState, setLockedHashState] = useState<string | null>(lockedHash ?? null);

  // Step 1
  const [hypothesis, setHypothesis] = useState(initialProtocol?.hypothesis ?? "");

  // Step 2
  const [signals, setSignals] = useState<Set<string>>(
    () => new Set(initialProtocol?.predicted_signals ?? []),
  );
  const [otherSignal, setOtherSignal] = useState("");

  // Step 3
  const [zones, setZones] = useState<string[]>(initialProtocol?.zones ?? []);
  const [windows, setWindows] = useState<WindowDraft[]>(
    initialProtocol?.windows.map((w) => ({
      label: w.label,
      start_iso: isoToTime(w.start_iso),
      duration_min: w.duration_min,
    })) ?? [],
  );
  const [stopCondition, setStopCondition] = useState(initialProtocol?.stop_condition ?? "");

  // a11y: trap focus inside the wizard while it's mounted. Escape forwards
  // to onClose when provided; the parent owns mount/unmount otherwise.
  const trapRef = useFocusTrap<HTMLDivElement>(true, {
    onEscape: () => onClose?.(),
  });

  // Derive the protocol object from current state for preview / saving
  const buildProtocol = useCallback((): InvestigationProtocol => {
    const allSignals = Array.from(signals);
    if (signals.has("other") && otherSignal.trim()) {
      // Replace "other" placeholder with the user's custom text
      const idx = allSignals.indexOf("other");
      allSignals[idx] = otherSignal.trim();
    }
    return {
      hypothesis: hypothesis.trim(),
      predicted_signals: allSignals,
      zones,
      windows: windows
        .filter((w) => w.start_iso)
        .map((w) => ({
          label: w.label.trim(),
          start_iso: timeToIso(w.start_iso),
          duration_min: w.duration_min,
        })),
      stop_condition: stopCondition.trim(),
      authored_at: initialProtocol?.authored_at ?? new Date().toISOString(),
    };
  }, [hypothesis, signals, otherSignal, zones, windows, stopCondition, initialProtocol]);

  // ── If already locked on mount, go straight to read-only ──
  useEffect(() => {
    if (lockedHash) setLockedHashState(lockedHash);
  }, [lockedHash]);

  // ── If locked, render the read-only view ──
  if (lockedHashState && initialProtocol) {
    return (
      <ReadOnlyView
        protocol={initialProtocol}
        hash={lockedHashState}
        onClose={onClose}
      />
    );
  }

  // ── Validation per step ──
  const step1Valid = hypothesis.trim().length >= MIN_HYPOTHESIS;
  const step2Valid = signals.size > 0;
  const step3Valid = stopCondition.trim().length >= MIN_STOP_CONDITION;

  // ── Step navigation ──
  const canAdvance =
    (step === 1 && step1Valid) ||
    (step === 2 && step2Valid) ||
    (step === 3 && step3Valid) ||
    step === 4;

  const handleNext = async () => {
    if (step < TOTAL_STEPS) {
      // Auto-save the draft after step 3 transitions to step 4
      if (step === 3) {
        setSaving(true);
        setError(null);
        try {
          const protocol = buildProtocol();
          await saveProtocol(investigationId, protocol);
          onSave?.(protocol);
        } catch (err) {
          setError((err as Error).message);
          setSaving(false);
          return;
        }
        setSaving(false);
      }
      setStep((n) => n + 1);
    }
  };

  const handleBack = () => {
    if (step > 1) setStep((n) => n - 1);
  };

  const handleSaveDraft = async () => {
    setSaving(true);
    setError(null);
    try {
      const protocol = buildProtocol();
      await saveProtocol(investigationId, protocol);
      onSave?.(protocol);
      onClose?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleLock = async () => {
    setLocking(true);
    setError(null);
    try {
      // Persist the latest draft first (in case user edited on step 4)
      const protocol = buildProtocol();
      await saveProtocol(investigationId, protocol);
      const hash = await lockProtocol(investigationId);
      setLockedHashState(hash);
      onLock?.(hash);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLocking(false);
    }
  };

  const toggleSignal = (key: string) => {
    setSignals((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const addWindow = () => {
    if (windows.length >= 3) return;
    setWindows((prev) => [...prev, { label: "", start_iso: "", duration_min: 30 }]);
  };

  const removeWindow = (idx: number) => {
    setWindows((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateWindow = (idx: number, patch: Partial<WindowDraft>) => {
    setWindows((prev) => prev.map((w, i) => (i === idx ? { ...w, ...patch } : w)));
  };

  // ── If locked after user locks in this session ──
  if (lockedHashState) {
    const protocol = buildProtocol();
    return (
      <ReadOnlyView
        protocol={protocol}
        hash={lockedHashState}
        onClose={onClose}
      />
    );
  }

  return (
    <div className={s.backdrop} role="dialog" aria-modal="true" aria-label="Protocol wizard" ref={trapRef} tabIndex={-1}>
      <div className={s.card}>
        {/* Header */}
        <div className={s.header}>
          <span className={s.headerIcon}>📋</span>
          <div className={s.headerText}>
            <h2 className={s.headerTitle}>Pre-registered Hypothesis</h2>
            <p className={s.headerSub}>Step {step} of {TOTAL_STEPS}</p>
          </div>
          {onClose && (
            <button
              type="button"
              className={s.closeBtn}
              onClick={onClose}
              aria-label="Close wizard"
            >
              ×
            </button>
          )}
        </div>

        {/* Progress */}
        <div className={s.progress} role="progressbar" aria-valuenow={step} aria-valuemin={1} aria-valuemax={TOTAL_STEPS}>
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
            <div
              key={i}
              className={
                `${s.progressPip} ${i + 1 < step ? s.progressPipDone : ""} ${i + 1 === step ? s.progressPipActive : ""}`.trim()
              }
            />
          ))}
        </div>

        {/* Body */}
        <div className={s.body}>
          {step === 1 && (
            <>
              <p className={s.stepLabel}>Step 1 — Hypothesis statement</p>

              <div className={s.field}>
                <label className={s.fieldLabel} htmlFor="hyp-textarea">
                  What is your hypothesis?
                </label>
                <textarea
                  id="hyp-textarea"
                  className={`${s.textarea} ${hypothesis.length > 0 && hypothesis.trim().length < MIN_HYPOTHESIS ? s.invalid : ""}`.trim()}
                  rows={5}
                  value={hypothesis}
                  onChange={(e) => setHypothesis(e.target.value)}
                  placeholder="Describe in plain English what you think is happening at this location and what you expect to observe."
                  aria-describedby="hyp-helper hyp-count"
                />
                <p id="hyp-helper" className={s.fieldHelper}>
                  Write this before you enter the location. This will be cryptographically locked when the session starts.
                </p>
                <p
                  id="hyp-count"
                  className={`${s.charCount} ${hypothesis.trim().length === 0 ? "" : hypothesis.trim().length < MIN_HYPOTHESIS ? s.charCountWarn : s.charCountOk}`.trim()}
                >
                  {hypothesis.trim().length} / {MIN_HYPOTHESIS} min chars
                </p>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className={s.stepLabel}>Step 2 — Expected signals</p>

              <div className={s.field}>
                <span className={s.fieldLabel}>Which sensor channels do you expect to show activity if the hypothesis is true?</span>
                <div className={s.signalGrid}>
                  {SIGNAL_OPTIONS.map(({ key, label }) => (
                    <label
                      key={key}
                      className={`${s.signalChip} ${signals.has(key) ? s.signalChipSelected : ""}`.trim()}
                    >
                      <input
                        type="checkbox"
                        checked={signals.has(key)}
                        onChange={() => toggleSignal(key)}
                        aria-label={label}
                      />
                      {label}
                    </label>
                  ))}
                </div>

                {signals.has("other") && (
                  <div className={s.field} style={{ marginTop: "8px" }}>
                    <label className={s.fieldLabel} htmlFor="other-signal">
                      Describe the "other" signal type
                    </label>
                    <input
                      id="other-signal"
                      className={s.input}
                      value={otherSignal}
                      onChange={(e) => setOtherSignal(e.target.value)}
                      placeholder="e.g. Olfactory anomaly, pressure change…"
                    />
                  </div>
                )}

                {signals.size === 0 && (
                  <p className={s.fieldHelper} style={{ color: "var(--warning)", fontStyle: "normal" }}>
                    Select at least one expected signal to continue.
                  </p>
                )}
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <p className={s.stepLabel}>Step 3 — Zones, windows and stop rule</p>

              <div className={s.field}>
                <span className={s.fieldLabel}>Zones to monitor</span>
                <ZoneTagInput zones={zones} onChange={setZones} />
                <p className={s.fieldHelper}>
                  Type a zone name and press Enter to add. E.g. Hallway, Kitchen, Bedroom.
                </p>
              </div>

              <div className={s.field}>
                <span className={s.fieldLabel}>Investigation windows (up to 3)</span>
                {windows.length > 0 && (
                  <div className={s.windowList}>
                    <div className={`${s.windowRow} ${s.windowRowHeader}`}>
                      <span>Label</span>
                      <span>Start time</span>
                      <span>Duration</span>
                      <span />
                    </div>
                    {windows.map((w, i) => (
                      <div key={i} className={s.windowRow}>
                        <input
                          className={s.input}
                          value={w.label}
                          onChange={(e) => updateWindow(i, { label: e.target.value })}
                          placeholder={`Window ${i + 1}`}
                          aria-label={`Window ${i + 1} label`}
                        />
                        <input
                          type="time"
                          className={s.input}
                          value={w.start_iso}
                          onChange={(e) => updateWindow(i, { start_iso: e.target.value })}
                          aria-label={`Window ${i + 1} start time`}
                        />
                        <select
                          className={s.select}
                          value={w.duration_min}
                          onChange={(e) => updateWindow(i, { duration_min: Number(e.target.value) })}
                          aria-label={`Window ${i + 1} duration`}
                        >
                          {DURATION_OPTIONS.map((d) => (
                            <option key={d} value={d}>{d} min</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className={s.removeWindowBtn}
                          onClick={() => removeWindow(i)}
                          aria-label={`Remove window ${i + 1}`}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {windows.length < 3 && (
                  <button type="button" className={s.addWindowBtn} onClick={addWindow}>
                    + Add time window
                  </button>
                )}
              </div>

              <div className={s.field}>
                <label className={s.fieldLabel} htmlFor="stop-textarea">
                  Stop condition
                </label>
                <textarea
                  id="stop-textarea"
                  className={`${s.textarea} ${stopCondition.length > 0 && stopCondition.trim().length < MIN_STOP_CONDITION ? s.invalid : ""}`.trim()}
                  rows={3}
                  value={stopCondition}
                  onChange={(e) => setStopCondition(e.target.value)}
                  placeholder="If this condition is not met, record the session as null-result."
                  aria-describedby="stop-helper"
                />
                <p id="stop-helper" className={s.fieldHelper}>
                  Pre-commit to stopping. e.g. "If the posterior does not exceed 0.5 by 02:00, the session is inconclusive."
                </p>
                {stopCondition.trim().length > 0 && stopCondition.trim().length < MIN_STOP_CONDITION && (
                  <p className={s.charCount + " " + s.charCountWarn}>
                    {stopCondition.trim().length} / {MIN_STOP_CONDITION} min chars
                  </p>
                )}
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <p className={s.stepLabel}>Step 4 — Review and lock</p>

              <ReviewSections protocol={buildProtocol()} />

              <div className={s.lockWarning}>
                <span className={s.lockWarningIcon}>⚠️</span>
                <p className={s.lockWarningText}>
                  <strong>Once locked, this protocol cannot be edited.</strong> The SHA-256 hash will be recorded in the audit chain to prove this hypothesis was written before any evidence was gathered. A new investigation must be created to register a different hypothesis.
                </p>
              </div>
            </>
          )}

          {error && <p className={s.error} role="alert">{error}</p>}
        </div>

        {/* Footer */}
        <div className={s.footer}>
          {step > 1 && step < TOTAL_STEPS && (
            <button type="button" className={s.btnBack} onClick={handleBack}>
              Go back
            </button>
          )}
          {step === TOTAL_STEPS && (
            <button type="button" className={s.btnBack} onClick={handleBack}>
              Go back
            </button>
          )}

          {/* Save draft and close — available on step 3 only after stop condition filled */}
          {step === 3 && step3Valid && (
            <button
              type="button"
              className={s.btnBack}
              onClick={handleSaveDraft}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save draft"}
            </button>
          )}

          {step < TOTAL_STEPS ? (
            <button
              type="button"
              className={s.btnNext}
              onClick={handleNext}
              disabled={!canAdvance || saving}
            >
              {saving ? "Saving…" : "Continue →"}
            </button>
          ) : (
            <button
              type="button"
              className={s.btnLock}
              onClick={handleLock}
              disabled={locking}
            >
              {locking ? "Locking…" : "🔒 Lock Protocol"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
