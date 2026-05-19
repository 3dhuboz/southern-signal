/**
 * About — public-facing value prop, two-mode explainer, privacy posture,
 * and a beta-interest capture (V1: device-local only, honest fallback —
 * no marketing list, no backend, no third-party).
 *
 * Why this exists: southern-signal.pages.dev currently lands directly
 * in MissionControl, which assumes you already know what the app is.
 * First-time visitors (linked from a YouTube show, social post, etc.)
 * have nowhere to read what the thing does, what stays on the device,
 * or how to flag interest as a beta tester.
 */

import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import s from "./About.module.css";

const STORAGE_KEY = "ss-beta-interest-v1";

interface BetaInterestRecord {
  email: string;
  team_name: string | null;
  ts: string;
}

function readInterest(): BetaInterestRecord | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as BetaInterestRecord;
  } catch {
    return null;
  }
}

function writeInterest(rec: BetaInterestRecord): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rec));
}

export function About() {
  const [email, setEmail] = useState("");
  const [teamName, setTeamName] = useState("");
  const [saved, setSaved] = useState<BetaInterestRecord | null>(() => readInterest());

  const handleSave = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return;
    const rec: BetaInterestRecord = {
      email: trimmed,
      team_name: teamName.trim() || null,
      ts: new Date().toISOString(),
    };
    writeInterest(rec);
    setSaved(rec);
  }, [email, teamName]);

  const handleClear = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setSaved(null);
    setEmail("");
    setTeamName("");
  }, []);

  return (
    <article className={s.page}>
      <header className={s.hero}>
        {/* Schematic hero illustration: a phone-as-instrument framed by a faint
            doorway silhouette. Pure line + dot SVG, currentColor only, so it
            tints to var(--accent-strong) and reads on every theme. Matches the
            OnboardingTour cue idiom + the Crux Posterior logo language. */}
        <svg
          viewBox="0 0 240 180"
          className={s.heroSvg}
          aria-hidden="true"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Faint doorway silhouette behind the phone — sets the 'investigation' tone. */}
          <g stroke="currentColor" strokeWidth="0.8" fill="none" opacity="0.18" strokeLinecap="round">
            <path d="M 30 20 V 175" />
            <path d="M 210 20 V 175" />
            <path d="M 30 20 Q 120 4 210 20" />
            {/* Door edge inside the frame */}
            <path d="M 60 36 V 175" opacity="0.55" />
          </g>

          {/* Dotted "field line" arcs — subtle EMF / sound propagation hint */}
          <g stroke="currentColor" strokeWidth="0.8" fill="none" opacity="0.25" strokeDasharray="2 5">
            <path d="M 16 90 Q 50 60 96 88" />
            <path d="M 224 90 Q 190 60 144 88" />
          </g>

          {/* Phone body — rounded rectangle */}
          <rect
            x="84" y="22" width="72" height="138" rx="12"
            fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.85"
          />
          {/* Phone notch / speaker */}
          <rect x="112" y="28" width="16" height="2" rx="1" fill="currentColor" opacity="0.55" />

          {/* Activity dial inside the phone — same arc the ActivityDial component draws */}
          <g transform="translate(120 70)">
            {/* Outer ring */}
            <circle r="20" fill="none" stroke="currentColor" strokeWidth="0.8" opacity="0.25" />
            {/* 3/4 arc — opens at the bottom */}
            <path
              d="M -14.14 14.14 A 20 20 0 1 1 14.14 14.14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              opacity="0.95"
            />
            {/* Sector tick marks */}
            {[0, 60, 120, 180, 240, 300].map((a) => {
              const r1 = 18;
              const r2 = 22;
              const rad = (a - 90) * (Math.PI / 180);
              return (
                <line
                  key={a}
                  x1={r1 * Math.cos(rad)} y1={r1 * Math.sin(rad)}
                  x2={r2 * Math.cos(rad)} y2={r2 * Math.sin(rad)}
                  stroke="currentColor"
                  strokeWidth="0.8"
                  opacity="0.45"
                />
              );
            })}
            {/* Dial label dot — the current "posterior" position */}
            <circle cx="0" cy="-20" r="2.5" fill="currentColor" />
            {/* Center dot */}
            <circle r="2" fill="currentColor" opacity="0.8" />
          </g>

          {/* Spectrum strip below the dial */}
          <g transform="translate(96 110)">
            {[3, 6, 10, 14, 9, 5, 8, 13, 17, 12, 7, 4].map((h, i) => (
              <rect
                key={i}
                x={i * 4}
                y={20 - h}
                width="2.4"
                height={h}
                rx="0.8"
                fill="currentColor"
                opacity={0.35 + (h / 30)}
              />
            ))}
          </g>

          {/* Timer line */}
          <g transform="translate(96 142)" opacity="0.7">
            <text
              x="0" y="0"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              fontSize="9"
              fontWeight="700"
              fill="currentColor"
              letterSpacing="0.6"
            >
              00:08:42 · CASE A1
            </text>
          </g>
        </svg>

        <span className={s.eyebrow}>SOUTHERN SIGNAL · ABOUT</span>
        <h1 className={s.title}>Forensic-grade paranormal field tools that fit in a phone.</h1>
        <p className={s.lede}>
          Built for investigators who want their evidence to survive a hostile reviewer. Bayesian posterior,
          hash-chained audit log, sector-accurate acoustics, and a printable case brief — all running on the
          device, with a "stay local" privacy posture and an Acknowledgement of Country gate before any
          recording starts.
        </p>
        <div className={s.heroActions}>
          <Link to="/" className={`btn btn-primary ${s.heroSize}`}>Open Camera →</Link>
          <Link to="/review" className={`btn btn-ghost ${s.heroSize}`}>See your cases</Link>
        </div>
      </header>

      <section className={s.section}>
        <h2 className={s.sectionTitle}>What it does</h2>
        <ul className={s.valueProp}>
          <li>
            <strong>A live posterior, not a vibe meter.</strong> Every anomaly contributes a bounded log
            likelihood ratio (capped at ±4 per increment so a single chatty channel can't pile-on). The
            result is a Bayesian probability with full attribution per channel — nothing claims certainty.
          </li>
          <li>
            <strong>The audit chain is the product.</strong> Every posterior update, marker, contamination
            tag, and disposition is hash-chained with SHA-256 and Merkle-rooted on export. A reviewer can
            walk the chain offline using the bundled <code>verify.html</code> file — no trust in us required.
          </li>
          <li>
            <strong>Sector-accurate acoustic direction.</strong> A 3-of-3 calibration ritual locks direction
            to ±60° (not bearing — six sectors). Anything more precise would be theatre on phone-grade mics.
          </li>
          <li>
            <strong>Live broadcast with sensor overlays.</strong> Camera + mic + posterior + sector + caption
            composited into one stream at 30fps. Record locally to OPFS, push to WHIP (Cloudflare, Mux,
            Restream, Dolby, custom) — including a one-click Cloudflare → Facebook Live relay setup.
          </li>
          <li>
            <strong>Honest disclaimers, baked in.</strong> Posterior is a model estimate, never a
            measurement of presence. AHT eliminates explanations; it never confirms causes. When AI fails
            to generate plausible mundane explanations, we render INCONCLUSIVE — never "confirmed."
          </li>
        </ul>
      </section>

      <section className={s.section}>
        <h2 className={s.sectionTitle}>Two modes, one set of data</h2>
        <div className={s.modeGrid}>
          <div className={s.mode}>
            <span className={s.modeBadge}>SIMPLE</span>
            <h3 className={s.modeTitle}>For amateurs &amp; first-timers</h3>
            <p>Plain-English event feed. One big Begin / End button. The dial shows activity, not a posterior. Math is hidden but still running underneath.</p>
          </div>
          <div className={s.mode}>
            <span className={`${s.modeBadge} ${s.modeBadgePro}`}>PRO</span>
            <h3 className={s.modeTitle}>For serious operators</h3>
            <p>Posterior bar, log-LR per channel, Merkle root, calibration ritual, Estes-method dual-phone pairing, bait-tone tools, sector indicator, evidence ledger.</p>
          </div>
        </div>
        <p className={s.modeNote}>
          Switch in the header at any time. The data captured is identical — only the presentation changes.
        </p>
      </section>

      <section className={s.section}>
        <h2 className={s.sectionTitle}>Privacy posture</h2>
        <ul className={s.privacy}>
          <li><strong>On-device first.</strong> SQLite-WASM in OPFS. Sensors, audio, video, and the audit chain all live on your phone unless you opt into cloud sync.</li>
          <li><strong>Cloud AI is opt-in and gated.</strong> Cultural-sensitivity flag (per-case OR device-wide) hard-blocks all cloud AI calls and all sync uploads. No exceptions.</li>
          <li><strong>No analytics, no telemetry, no third-party JS.</strong> First-party only.</li>
          <li><strong>Live broadcast destination is yours.</strong> Cloudflare Stream, Mux, Restream, Dolby, Eyevinn, or your own WHIP endpoint. Your stream key, your account.</li>
        </ul>
      </section>

      <section className={s.section}>
        <h2 className={s.sectionTitle}>External review &amp; sign-off</h2>
        <p className={s.review}>
          V1 ships with eight standing disclaimers and a public commitment: before a TV-grade premiere
          using this tool, an external Bayesian and an external acoustician will sign off on the
          methodology. Reviewer shortlist is private until contact is made; the sign-off itself will be
          published with the release.
        </p>
        <p className={s.review}>
          This tool has not been peer-reviewed. It ships with public commitments to external sign-off by a
          Bayesian statistician and an acoustician before any premiere; until that lands, treat any model
          output as a working hypothesis, not a conclusion.
        </p>
      </section>

      <section className={s.section}>
        <h2 className={s.sectionTitle}>Beta interest</h2>
        <p className={s.betaNote}>
          We're not making a marketing list — we're making a list to ship to. Saved <strong>locally on
          this device only</strong>. No backend, no third party, no email blast. Tell us who you are and
          we'll reach out when V1 ships.
        </p>
        {saved ? (
          <div className={s.betaSaved}>
            <p>
              <strong>Saved on this device.</strong>
              {" "}<code>{saved.email}</code>
              {saved.team_name ? <> · <em>{saved.team_name}</em></> : null}
              {" "}· <span className={s.muted}>{new Date(saved.ts).toLocaleString()}</span>
            </p>
            <button type="button" className={s.linkButton} onClick={handleClear}>Clear my interest record</button>
          </div>
        ) : (
          <form className={s.betaForm} onSubmit={handleSave}>
            <label className={s.betaField}>
              <span className={s.betaLabel}>Email</span>
              <input
                type="email"
                className={s.betaInput}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
              />
            </label>
            <label className={s.betaField}>
              <span className={s.betaLabel}>Team or channel name (optional)</span>
              <input
                type="text"
                className={s.betaInput}
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="e.g. YEP The Boys, Solo investigator…"
                autoComplete="organization"
              />
            </label>
            <button type="submit" className={s.betaSubmit} disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())}>
              Save my interest (locally)
            </button>
          </form>
        )}
      </section>

      <footer className={s.footer}>
        <p>Southern Signal · v0.1.0 · open source forthcoming · built on Vite + sqlite-wasm + Cloudflare Pages</p>
      </footer>
    </article>
  );
}
