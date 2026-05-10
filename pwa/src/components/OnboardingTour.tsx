/**
 * OnboardingTour — first-run skippable tour, runs after AcknowledgementGate.
 *
 * Four steps: what the app is, calibration ritual, broadcast/record with
 * sensor overlays, and the privacy posture. Skip and final-step Done both
 * persist completion to localStorage so the tour does not re-appear.
 *
 * Storage is intentionally raw localStorage — preferences.ts is a high-traffic
 * file owned by another worker for this iteration, so we keep this orthogonal.
 */

import { useEffect, useState, type ReactElement } from "react";
import { usePreferences } from "../lib/preferences";
import s from "./OnboardingTour.module.css";

const COMPLETION_KEY = "ss-onboarding-completed-v1";

type Step = {
  eyebrow: string;
  title: string;
  body: string;
  cue: ReactElement;
};

// Schematic SVG cues — abstract, not literal. Match the dim/luminous aesthetic.
// Opacity levels are tuned so the cues read on all three themes, including
// daylight (where `currentColor` resolves to a darker green ~5:1 on white;
// values below ~0.5 fade out against the bright bg).
const cueWelcome = (
  <svg viewBox="0 0 64 64" aria-hidden="true" className={s.cueSvg}>
    <circle cx="32" cy="32" r="22" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5" />
    <circle cx="32" cy="32" r="14" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.7" />
    <circle cx="32" cy="32" r="6" fill="currentColor" opacity="0.95" />
  </svg>
);

const cueCalibrate = (
  <svg viewBox="0 0 64 64" aria-hidden="true" className={s.cueSvg}>
    <circle cx="32" cy="32" r="22" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5" strokeDasharray="3 4" />
    <path d="M32 32 L32 12" stroke="currentColor" strokeWidth="1.5" opacity="0.95" />
    <path d="M32 32 L49 42" stroke="currentColor" strokeWidth="1.5" opacity="0.75" />
    <path d="M32 32 L15 42" stroke="currentColor" strokeWidth="1.5" opacity="0.75" />
    <circle cx="32" cy="32" r="2.5" fill="currentColor" />
  </svg>
);

const cueBroadcast = (
  <svg viewBox="0 0 64 64" aria-hidden="true" className={s.cueSvg}>
    <rect x="10" y="18" width="44" height="28" rx="3" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.7" />
    <circle cx="48" cy="22" r="2" fill="currentColor" />
    <path d="M16 40 L22 32 L28 38 L36 28 L48 42" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.95" />
    <path d="M14 50 L50 50" stroke="currentColor" strokeWidth="1" opacity="0.55" strokeDasharray="2 3" />
  </svg>
);

const cuePrivacy = (
  <svg viewBox="0 0 64 64" aria-hidden="true" className={s.cueSvg}>
    <path d="M32 10 L48 18 V34 C48 44 40 50 32 54 C24 50 16 44 16 34 V18 Z" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.7" />
    <rect x="26" y="28" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.95" />
    <path d="M28 28 V24 A4 4 0 0 1 36 24 V28" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.95" />
  </svg>
);

const STEPS: Step[] = [
  {
    eyebrow: "Step 1 of 4",
    title: "Welcome to Southern Signal",
    body: "A phone-first paranormal investigation tool that fuses sensor data, transparent statistics, and on-device storage into a defensible record. Begin a session in Mission Control, or flip Switch to Pro if you want the math exposed.",
    cue: cueWelcome,
  },
  {
    eyebrow: "Step 2 of 4",
    title: "Calibrate before you trust direction",
    body: "Run the 3-of-3 sector calibration ritual at the start of each session — it locks acoustic direction to within plus or minus 60 degrees. Simple mode hides the calibration UI; Pro exposes it with the underlying angles.",
    cue: cueCalibrate,
  },
  {
    eyebrow: "Step 3 of 4",
    title: "Broadcast or record with sensor overlays",
    body: "Camera, mic, posterior bar, sector readout, and captions composited at 30fps. Record to disk or push WHIP live to Cloudflare, Mux, Restream, or Facebook through a relay.",
    cue: cueBroadcast,
  },
  {
    eyebrow: "Step 4 of 4",
    title: "Your data stays here",
    body: "Cases live in SQLite-WASM in OPFS on this device. Cloud AI is opt-in. The cultural-sensitivity flag, set per-case or device-wide, hard-blocks all cloud calls and sync uploads.",
    cue: cuePrivacy,
  },
];

function isCompleted(): boolean {
  try {
    return localStorage.getItem(COMPLETION_KEY) !== null;
  } catch {
    // If localStorage is unavailable (private mode quirks etc.), do not
    // pester the user — treat as already completed.
    return true;
  }
}

function markCompleted(): void {
  try {
    localStorage.setItem(COMPLETION_KEY, new Date().toISOString());
  } catch {
    // Best-effort; ignore quota or access errors.
  }
}

export function OnboardingTour() {
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [prefs] = usePreferences();
  const aocAccepted = prefs.acknowledgementOfCountry.accepted;

  // The AcknowledgementGate is the ethical floor and must clear FIRST on
  // a fresh device. Without this gate, the tour rendered over the AoC
  // (higher z-index) and visually buried it. Sequence: AoC accepted →
  // tour can open. The same `isCompleted()` guard still applies; once
  // the operator finishes (or skips) the tour, it never re-opens.
  useEffect(() => {
    if (!aocAccepted) return;
    if (!isCompleted()) setOpen(true);
  }, [aocAccepted]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const finish = () => {
    markCompleted();
    setOpen(false);
  };

  const back = () => setStepIndex((i) => Math.max(0, i - 1));
  const next = () => {
    if (stepIndex >= STEPS.length - 1) {
      finish();
    } else {
      setStepIndex((i) => i + 1);
    }
  };

  if (!open) return null;

  const step = STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  return (
    <div className={s.overlay} role="dialog" aria-modal="true" aria-labelledby="ss-onboarding-title">
      <div className={s.panel}>
        <div className={s.cue} aria-hidden="true">{step.cue}</div>

        <div className={s.eyebrow}>{step.eyebrow}</div>
        <h2 id="ss-onboarding-title" className={s.title}>{step.title}</h2>
        <p className={s.body}>{step.body}</p>

        <div className={s.dots} role="presentation">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={i === stepIndex ? `${s.dot} ${s.dotActive}` : s.dot}
            />
          ))}
        </div>

        <div className={s.actions}>
          <button type="button" className={s.skip} onClick={finish}>
            Skip
          </button>
          <div className={s.actionsRight}>
            <button
              type="button"
              className={s.secondary}
              onClick={back}
              disabled={isFirst}
            >
              Back
            </button>
            <button type="button" className={`btn btn-primary ${s.primarySize}`} onClick={next}>
              {isLast ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
