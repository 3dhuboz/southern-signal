# Southern Signal Rollout Lead Runbook

Date: 2026-05-25

This is the lead-operator lane for moving Southern Signal from code changes to
a creator-facing rehearsal. It complements the real-phone field checklist; it
does not replace it.

## Roles

- Rollout lead: owns the go/no-go call and evidence packet.
- CI worker: builds, tests, deploys, and runs post-deploy smoke on GitHub
  Actions.
- Field operator: performs the real-phone rehearsal, overlay layout checks,
  EVP-through-camera proof, endurance run, and private live dry run.
- External reviewers: Bayesian and acoustician sign off before a public
  episode.

## Automatic Path

On push to `master` or `dev`, `.github/workflows/deploy.yml` now:

- Installs with pnpm.
- Runs lint, build, bundle budget, and tests.
- Deploys to Cloudflare Pages with Wrangler.
- Resolves the target Pages URL.
- Runs `pnpm rollout:lead -- --mode post-deploy`.
- Uploads the rollout evidence artifact.

The uploaded artifact should contain:

- `rollout-go-no-go-report.md`
- `rollout-go-no-go-report.json`
- `pilot-readiness.json`
- `camera-live-smoke.json`
- `camera-live-smoke.png`
- `launch-gates-report.json` when present

## Manual Lead Run

Run from `pwa/`:

```bash
pnpm install
pnpm rollout:lead -- --mode full --base-url https://southern-signal.pages.dev --intent creator-demo
```

For a post-deploy smoke where lint, build, bundle, and tests already passed:

```bash
pnpm rollout:lead -- --mode post-deploy --base-url https://southern-signal.pages.dev --branch master
```

To mark real-world proof as recorded:

```bash
pnpm rollout:lead -- --mode report-only --base-url https://southern-signal.pages.dev --branch master --real-phone-rehearsal pass --evp-through-camera pass --endurance-run pass --private-live-dry-run pass
```

For public-episode intent, also record both external sign-offs:

```bash
pnpm rollout:lead -- --mode report-only --intent public-episode --external-bayesian-signoff recorded --external-acoustician-signoff recorded
```

## Decision Rules

- `NO-GO`: any automated rollout gate fails.
- `CONDITIONAL GO`: automated gates pass, but field evidence or public-episode
  sign-offs are still pending.
- `GO`: automated gates pass and the required operator evidence for the
  selected intent is recorded.

## Handoff Standard

The lead report is the single handoff artifact. Do not present the app as
field-ready from screenshots alone; the report must include the deployed smoke
results and the real-phone evidence status.
