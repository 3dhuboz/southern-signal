# Southern Signal — methodology & math doc

**Draft skeleton for external reviewer pack — 2026-05-20.**

This is the document the 5 first-wave reviewers (Drovandi, Grant,
Cabrera, Howard, Biddle) will receive as an attachment. It defines the
math the on-screen Site Posterior Bar is computing, the named channel
likelihood ratios that feed it, and the places we know our assumptions
are softest. **Honest about soft spots is the whole point** — the panel
note is that reviewers can smell hand-waving inside a paragraph and the
fastest way to lose them is to dress up an assumption that we can't
defend.

Steve to convert this markdown to PDF before sending. Suggested tooling:
Pandoc with `--pdf-engine=tectonic` for clean LaTeX-style equation
rendering, OR Typst if you want something faster. The math here uses
fenced display blocks with TeX so either path works without reformatting.

---

## 0. Scope and what this doc does not claim

Southern Signal is a paranormal-investigation PWA that runs an event-rate
Bayesian inference loop on consumer phone hardware. The headline on-screen
indicator is the **Site Posterior Bar** — a log-odds-scale bar charting
the running posterior probability that the current site is producing
anomalous physical signals, conditional on three explicitly named and
sourced likelihood ratios (LRs) from the phone's instruments.

This document defines what we compute and why. **It does not claim:**

- That the LRs prove ghosts. The LRs encode the conditional probability
  of the observed sensor pattern given a generic "site producing anomalous
  signal" model vs. a "mundane baseline" model. The interpretation of the
  posterior, given the prior, is outside the scope of the math; the math
  just composes evidence.
- That the priors are calibrated against any peer-reviewed dataset of
  paranormal investigations (no such dataset exists). The prior is a
  declared assumption (see §2) and the on-screen posterior is presented
  as relative-to-this-prior, not as an absolute claim.
- That the SRP-PHAT bearing indicator is a continuous bearing. It is
  not. It is a **6-sector** indicator (60° per sector, FRONT/REAR ×
  L/C/R) gated by magnitude-squared-coherence. See §5.

---

## 1. Notation

- $\theta \in \{0, 1\}$ — latent "site is producing anomalous signal"
  flag for the current room/site. $\theta = 1$ is the alternative
  hypothesis, $\theta = 0$ is the mundane null.
- $\ell(t)$ — running posterior log-odds at time $t$:
  $\ell(t) = \log \frac{P(\theta=1 \mid e_{\leq t})}{P(\theta=0 \mid e_{\leq t})}$
- $\ell_0$ — prior log-odds (constant, see §2).
- $e_i = (c_i, t_i, \lambda_i)$ — the $i$-th evidence emission: channel
  identifier $c_i$, timestamp $t_i$, log-LR contribution $\lambda_i$.
- $\tau$ — exponential decay time constant ($\tau = 1200$ s = 20 min,
  see §3).
- $\Lambda_{\max}$ — symmetric per-emission cap on $|\lambda_i|$
  ($\Lambda_{\max} = 4$, see §4).

---

## 2. Prior

**Declared prior:** $P(\theta = 1) = 0.05$, so $\ell_0 = \log(0.05 / 0.95) \approx -2.944$.

**Source / rationale:** Declared. Not derived from a reference dataset
(no published prior on "anomalous-physical-signal site rate" exists in
peer-reviewed paranormal-investigation literature; see §10 for why this
is honest rather than weak).

The on-screen presentation is robust to the prior choice in the regime
we operate in: a typical hunt accumulates $|\ell(t) - \ell_0| < 4$ before
the bar exits its centre band, so the prior shifts the bar's resting
position but does not dominate the steady-state reading once two or more
channels have fired.

**Soft spot to call out to a reviewer:** the choice of $0.05$ versus
$0.01$ or $0.10$ has no empirical anchor. A reviewer-suggested calibration
study (e.g., reporting posterior distribution over a corpus of N=10+
documented hunts vs. N=10+ control sites with no reported activity)
would supersede this declared prior.

---

## 3. Temporal decay

The posterior log-odds decays exponentially toward the prior with time
constant $\tau$:

$$
\ell(t + \Delta t) = \ell_0 + (\ell(t) - \ell_0) \cdot e^{-\Delta t / \tau}
$$

**Implementation:** `pwa/src/lib/posterior/posterior.ts` lines 104–110.
The decay is applied to the **aggregate** logit (not per-channel) at
every `getPosterior` call; per-channel cumulative contributions are
tracked separately in `channelContribution` but do not decay independently.

**Rationale for $\tau = 1200$ s:**

- A typical hunt segment lasts 20–40 minutes; $\tau$ at 20 min means a
  burst of evidence at the start of a segment has decayed by $e^{-1} \approx 0.37$
  by the end of that segment if no new evidence accumulates. This
  prevents a stale spike from dragging the bar through the rest of the
  segment unchallenged.
- Shorter $\tau$ (e.g. 5 min) would make the bar chase recent evidence
  and lose context; longer $\tau$ (e.g. 60 min) would mean a spike at
  the start of a hunt persists through the entire session, which a
  forensic reviewer would reasonably criticise as "too sticky."

**Soft spot:** the choice of $\tau = 1200$ s versus, say, $900$ s or
$1800$ s has no empirical anchor either — it was reasoned-about, not
fit. A reviewer-suggested experiment (vary $\tau$ across a corpus of
hunts and report posterior trajectories) would supersede.

---

## 4. Per-emission cap

Every evidence emission's contribution is hard-clamped:

$$
\lambda_i^{(capped)} = \max(-\Lambda_{\max}, \min(\Lambda_{\max}, \lambda_i)),
\quad \Lambda_{\max} = 4
$$

**Implementation:** `pwa/src/lib/posterior/posterior.ts` lines 27–34, 140–141.

**Rationale (from the in-code comment):** "Hard ceiling at log(LR) = ±4
per increment (i.e. LR_max = $e^4 \approx 54.6$). Anything bigger means
the channel's likelihood model is wrong, not that the evidence is
overwhelming."

The cap is **symmetric** and **per-emission**, not per-channel-cumulative.
A single channel that fires repeatedly can still accumulate $|\lambda| \gg 4$
in $\ell(t)$ via successive emissions.

**Soft spot:** the cap is a defensive limiter against "future bad
likelihood model" rather than a calibrated bound. The channels we
currently emit (§5–7) all produce LRs below the cap in their normal
operating range — the cap is purely insurance against a new channel
shipping with a runaway likelihood model. A reviewer who wants a more
defensible bound could propose a calibration-based cap (e.g., 99.5th
percentile of $\lambda$ observed across N test events).

---

## 5. Channel 1 — EMF (magnetometer)

**Sensor:** browser Generic Sensor API `Magnetometer`. Sample rate
10–60 Hz depending on platform; we use the platform default. Returns
3-axis magnetic field in microteslas (µT).

**Feature:** running z-score of magnitude $|B(t)| = \sqrt{B_x^2 + B_y^2 + B_z^2}$
against an exponentially-weighted Welford running baseline maintained
in `pwa/src/lib/sensors/baseline.ts` (lines 1–97). Welford's algorithm
is the standard one-pass formulation; we use the exponentially-weighted
variant so the baseline tracks slow environmental drift without unbounded
memory.

**Trigger condition:** $|z| > 3$ sustained for $\geq 200$ ms.

**LR mapping** (from `pwa/src/lib/posterior/likelihoods.ts` lines 179–246):

- Base emission: $\lambda_{\text{EMF}} = 2.6$ (LR $\approx 13.5$).
- Bonus if $|B(t)|$ exceeds the running site-baseline maximum:
  $\lambda_{\text{EMF}} = 2.6 + 0.5 = 3.1$ (LR $\approx 22.2$).

**Rationale for the magnitudes** (from in-code comment at lines
185–190): $P(|z| > 3 \mid \text{mundane}) \approx 0.05$ per 60s window
(by the empirical rule for a Gaussian baseline with N samples);
$P(|z| > 3 \mid \text{anomaly}) \approx 0.65$ (declared assumption
based on hand-collected calibration sessions). LR = $0.65 / 0.05 = 13$,
so $\lambda \approx \log(13) \approx 2.56$, rounded to $2.6$.

**Soft spots to call out to a reviewer:**

- The $P(|z|>3 \mid \text{anomaly}) \approx 0.65$ figure is the
  weakest single number in the EMF chain. It's based on small-N hand
  calibration during early development, not a registered protocol.
- The 200 ms sustain window is intended to suppress single-sample
  noise; the actual debounce state machine isn't co-located with the
  LR comment — it's in the sensor's rolling-window logic. Verify
  matches the stated window before signing off.
- Magnetometer permission flow on iOS Safari returns no readings —
  the EMF channel is **suppressed entirely** on iOS (the row in the
  Sensor HUD doesn't render). This is documented in
  `BroadcastSensorHud.tsx`. iOS hunts are EMF-blind by design — not
  a bug, but a reviewer needs to know.

---

## 6. Channel 2 — Directional acoustic (SRP-PHAT with MSC)

**Sensor:** phone's stereo microphone via `getUserMedia({ audio: { ... } })`
with the platform's default sample rate (typically 48 kHz).

**Feature:** Magnitude-Squared Coherence (MSC) over per-band cross-spectra,
quantised to 6 discrete sectors. This is **not** GCC-PHAT continuous
bearing estimation — we explicitly do not publish a degrees-resolution
bearing because the in-room reverberant acoustic environment makes
continuous bearing estimates from a phone's mic-pair geometry brittle.
The 6-sector representation is what we believe we can defend.

**Implementation:** `pwa/src/lib/audio/sectorIndicator.ts` lines 1–183.

**MSC computation:** for each 1/3-octave band $b$,
$$
\text{MSC}_b = \min\left(1, \frac{|G_{LR,b}|^2}{G_{LL,b} \cdot G_{RR,b}}\right)
$$
where $G_{LR,b}$ is the cross-power between left and right channels in
band $b$, and $G_{LL,b}, G_{RR,b}$ are the auto-powers.

**Gate** (declared as constants, lines 48–50):

- $\text{MSC}_b \geq 0.7$ in at least 3 bands.
- The 3 passing bands must be **non-adjacent** (this is the defensive
  guard against a tonal source that gates a single contiguous band-block
  and games the gate; non-adjacent passing bands require a broadband
  source, which is what a real directional event looks like).

**Sector quantisation:** the inter-channel time-difference (ITD)
derived from the GCC peak is signed and normalised to $[-1, 1]$,
then mapped to one of $\{ \text{FRONT}, \text{REAR} \} \times \{\text{L}, \text{C}, \text{R}\}$.
Front/back ambiguity (inherent in a 2-mic array) is resolved by a
caller-passed `frontProbability` heuristic (the device orientation +
last known source position).

**LR mapping:** `SectorReading.trustworthy: boolean` is the only
signal published into the posterior chain. The channel emits a positive
$\lambda$ when `trustworthy === true` and the sector indicator picks
up a new direction, and a negative $\lambda$ (contamination) when
trustworthy is false but the indicator otherwise would have fired.
Magnitudes are declared in `likelihoods.ts`.

**Soft spots:**

- The non-adjacent-band rule is heuristic, not derived. A determined
  hostile tone (e.g. a multi-tone signal at 200 Hz, 800 Hz, 3.2 kHz)
  could still trigger the gate. We accept this — the threat model
  assumes the room is not adversarial. A reviewer who wants a stricter
  gate could propose adding a sustain time.
- `frontProbability` is a fudge. The 2-mic array cannot resolve
  front/back without external information; we use device orientation
  + last-known source as a prior. A reviewer is welcome to call this
  out as the weakest part of the spatial chain.
- We do not publish a continuous bearing on-screen. The 6-sector
  presentation is an editorial choice to match what we can defend, not
  what the underlying math could output if pushed.

---

## 7. Channel 3 — AGC-envelope infrasound

**Sensor:** phone microphone.

**Feature:** dB-envelope of audio RMS, bandpassed in the infrasound
range, with a sustained-peak detector.

**Implementation:** `pwa/src/lib/audio/infrasound.ts` lines 1–181.

**Signal chain:**

1. Compute per-frame audio RMS, convert to dB.
2. Apply an **8th-order Butterworth bandpass** centred at 9 Hz with
   17 Hz bandwidth (so the passband is approximately 0.5–18 Hz).
3. Track a $\sim$30 s exponentially-smoothed baseline of the bandpassed
   envelope ($\alpha = 1 / (100 \cdot 30)$ per frame at the framing rate).

**Trigger condition (all of):**

- Narrowband peak in the 7–19 Hz subrange.
- Peak amplitude $\geq +6$ dB above the running baseline.
- Sustained $\geq 10$ s.
- Rate-limited to one fire per 30 s (anti-doublecount).

**LR mapping:** declared in `likelihoods.ts` (see source).

**Soft spots:**

- The +6 dB threshold is empirical, set against ambient floors in
  early field testing on Android Pixel hardware. A reviewer with
  signal-processing expertise (Howard) is being asked specifically
  to scrutinise this.
- The phone's mic anti-aliasing filter typically rolls off below
  20 Hz — we are sampling **what the codec lets through** in the
  infrasound band, which is platform-dependent. We document this as
  a known limitation. The channel is most defensible on Android
  hardware with relaxed low-frequency filters; iOS is more aggressive
  and the channel will have a higher noise floor (and therefore a
  higher effective threshold) on iOS.
- The 10 s sustain window is the second weakest number in the chain
  (after the EMF base LR). It was chosen to suppress transient
  low-frequency events (door slams, traffic) without dropping plausible
  sustained anomalies. A reviewer-suggested empirical anchor would
  supersede.

---

## 8. Posterior update

Given the prior, decay, and cap defined above, the update equation
per evidence emission is:

$$
\ell(t_i^+) = \left[\ell_0 + (\ell(t_{i-1}^+) - \ell_0) \cdot e^{-(t_i - t_{i-1})/\tau}\right] + \lambda_i^{(capped)}
$$

The bracketed term is the decayed prior-relative log-odds at the
moment of the new evidence; the addition is the bounded contribution
from the new emission. Implementation: `posterior.ts` line 143
(`logitAfter = decayedLogit + cappedLogLr`).

The posterior probability shown on-screen is
$P(\theta=1 \mid e_{\leq t_i}) = \sigma(\ell(t_i^+))$ where $\sigma$
is the logistic function.

**Audit trail:** every update appends to the audit log
(`pwa/src/lib/posterior/siteSession.ts` lines 26–49) with the
before-state logit, after-state logit, channel ID, raw $\lambda$, and
capped $\lambda$. This means a reviewer's after-the-fact analysis can
reconstruct exactly what happened on a hunt without trusting our
real-time math — the same trail is also Ed25519 + COSE_Sign1 + RFC
3161 TSA timestamped so the chain is tamper-evident.

---

## 9. Cultural-sensitivity gate (architectural, not statistical)

Not part of the posterior math, but reviewers should know it exists.

The PWA enforces a **fail-closed routing refusal** for any cloud LLM
call when the active investigation is flagged culturally sensitive,
or when the device-wide cultural-sensitivity preference is enabled,
or when any of those flags can't be confirmed. The check is in
`pwa/src/lib/ai/cloudAi.ts` (lines 69–91) with adversarial tests in
`pwa/src/security/cultural-sensitivity.adversarial.test.ts`.

This is an **ethical floor**, not a statistical contribution. The
posterior is not affected by the gate; the gate only blocks cloud-side
data egress. We document this here so a reviewer who notices the
flag doesn't waste time looking for it in the posterior math.

---

## 10. Honest gaps — where we know our assumptions are softest

In order from "most likely to surface in reviewer feedback" to "least
likely":

1. **Anomaly conditional probabilities** ($P(\text{signal} \mid \theta=1)$
   for each channel). These are the strongest assumptions in the LR
   computation and are based on small-N hand calibration. EMF:
   $P(|z|>3 \mid \theta=1) \approx 0.65$. Infrasound: implied by the
   +6 dB threshold + 10 s sustain choice. Acoustic: implied by the
   MSC≥0.7-in-3-non-adjacent-bands gate. A registered calibration
   protocol (e.g., $N \geq 20$ documented hunts vs. control sites with
   pre-registered analysis) would supersede.

2. **Prior choice** ($P(\theta=1) = 0.05$). See §2.

3. **Decay constant** ($\tau = 1200$ s). See §3.

4. **Per-emission cap** ($\Lambda_{\max} = 4$). See §4.

5. **Sector indicator's `frontProbability` heuristic.** See §6.

6. **iOS platform-dependent suppression of EMF and partial suppression
   of infrasound.** Documented as a known limitation; the bar's
   read-out is implicitly conditional on the platform's sensor
   availability and we display per-sensor "unavailable" indicators
   on-screen, but a reviewer might reasonably ask "what's the worst
   case where 2 of 3 channels are platform-blind?" and we don't have
   a calibration answer.

7. **30 s anti-doublecount rate limit on infrasound.** Documented but
   not justified against an event-rate analysis.

We are sharing this list deliberately. The panel note is that hostile
reviewers will find the gaps either way; we'd rather they find them in
this section than in our likelihood code.

---

## 11. What we're asking each reviewer to sign off on

**Bayesian / statistical reviewers (Drovandi, Grant):** the composition
math in §§3, 4, 8 — specifically, that additive log-odds with
exponential decay and a symmetric per-emission cap is a defensible
event-rate posterior update, given that each channel's $\lambda_i$ is
well-defined. Plus the prior + decay + cap rationale and the soft-spot
acknowledgements in §10.

**Acoustic reviewers (Cabrera, Howard):** the channel-level signal
chains in §§6, 7 — specifically, that the SRP-PHAT-with-MSC sector
indicator is a defensible coarse-resolution direction-finder for an
in-room reverberant environment with a 2-mic phone array, and that
the AGC-envelope infrasound detector is a defensible narrowband
sustained-peak detector at consumer phone hardware noise floors.

**Skeptic reviewer (Biddle):** the framing — specifically, that the
on-screen Site Posterior Bar communicates **relative-to-stated-prior
log-odds** and not "ghost probability"; that the on-screen sensor
HUD reports raw values and not derived/processed claims; and that the
documentation here is honest about its soft spots and accurately
describes what the software does.

All reviewers retain the right to publicly disagree on air if their
final view doesn't match what we ship.

---

## 12. Reproducibility / what a reviewer can re-run

Source: `https://github.com/3dhuboz/southern-signal` (private — Steve
to grant collaborator access by email request).

Specific files for the reviewer pack:

- `pwa/src/lib/posterior/posterior.ts` — composition
- `pwa/src/lib/posterior/likelihoods.ts` — channel LR magnitudes
- `pwa/src/lib/audio/sectorIndicator.ts` — SRP-PHAT-MSC
- `pwa/src/lib/audio/infrasound.ts` — infrasound detector
- `pwa/src/lib/sensors/baseline.ts` — Welford running statistics
- `pwa/src/security/cultural-sensitivity.adversarial.test.ts` —
  fail-closed contract enforcement
- `pwa/src/lib/posterior/siteSession.ts` — audit chain

Every public function in the math pipeline has tests; the integration
test `pwa/src/integration/forensic-pipeline.integration.test.ts` runs
the full chain with adversarial mutations and asserts the tamper-evident
audit chain catches them.

Live PWA: `https://southern-signal.pages.dev` — guest preset available
on request.

---

*Document version: 2026-05-20-skeleton-v1. Conversion to PDF
recommended via `pandoc --pdf-engine=tectonic`.*
