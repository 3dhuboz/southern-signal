#!/usr/bin/env node
/**
 * Pilot readiness gate for the phone-first ghost-hunt workflow.
 *
 * This checks the deployed Cloudflare Pages health endpoints and exits non-zero
 * when the production-critical launch path is blocked. It deliberately reads
 * only public boolean health data; it never asks for or prints secret values.
 */

const DEFAULT_BASE_URL = "https://southern-signal.pages.dev";

const args = new Set(process.argv.slice(2));
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const baseInput = positional[0] || process.env.PILOT_BASE_URL || DEFAULT_BASE_URL;
const jsonMode = args.has("--json");

function normaliseBaseUrl(value) {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    throw new Error(`Invalid base URL: ${value}`);
  }
}

async function fetchJson(baseUrl, path) {
  const url = new URL(path, baseUrl);
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch (error) {
    throw new Error(`${url.toString()} could not be reached: ${error.message}`);
  }

  const elapsedMs = Date.now() - started;
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new Error(`${url.toString()} returned HTTP ${response.status}`);
  }

  return { body, elapsedMs, url: url.toString() };
}

async function fetchText(baseUrl, path) {
  const url = new URL(path, baseUrl);
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch (error) {
    throw new Error(`${url.toString()} could not be reached: ${error.message}`);
  }

  const elapsedMs = Date.now() - started;
  const text = await response.text().catch(() => "");

  if (!response.ok) {
    throw new Error(`${url.toString()} returned HTTP ${response.status}`);
  }

  return { text, elapsedMs, url: url.toString(), contentType: response.headers.get("content-type") ?? "" };
}

function check(id, label, status, detail, blocker = false) {
  return { id, label, status, detail, blocker };
}

function statusFromConfigured(configured, blocker) {
  if (configured) return "pass";
  return blocker ? "fail" : "warn";
}

function detailFromBooleans(parts) {
  return Object.entries(parts)
    .map(([label, value]) => `${label}:${value ? "yes" : "no"}`)
    .join(" ");
}

async function main() {
  const baseUrl = normaliseBaseUrl(baseInput);
  const result = {
    baseUrl: baseUrl.toString(),
    checkedAt: new Date().toISOString(),
    checks: [],
  };

  let health;
  let sync;

  try {
    const app = await fetchText(baseUrl, "/camera");
    const hasRoot = app.text.includes('id="root"') || app.text.includes("id='root'");
    const hasBundle = /<script\b[^>]+src=["']\/assets\/[^"']+\.js/i.test(app.text);
    result.checks.push(check(
      "app-shell",
      "Camera app shell",
      hasRoot && hasBundle ? "pass" : "fail",
      hasRoot && hasBundle
        ? `HTML ok in ${app.elapsedMs}ms`
        : "HTML did not include the React root and module bundle",
      true,
    ));
  } catch (error) {
    result.checks.push(check("app-shell", "Camera app shell", "fail", error.message, true));
  }

  try {
    const manifest = await fetchJson(baseUrl, "/manifest.webmanifest");
    result.checks.push(check(
      "manifest",
      "PWA manifest",
      manifest.body?.start_url === "/camera" ? "pass" : "fail",
      `start_url:${manifest.body?.start_url ?? "missing"} name:${manifest.body?.name ?? "missing"}`,
      true,
    ));
  } catch (error) {
    result.checks.push(check("manifest", "PWA manifest", "fail", error.message, true));
  }

  try {
    const sw = await fetchText(baseUrl, "/sw.js");
    result.checks.push(check(
      "service-worker",
      "Service worker",
      sw.text.includes("ss-pwa-") ? "pass" : "fail",
      sw.text.includes("ss-pwa-") ? `SW ok in ${sw.elapsedMs}ms` : "SW script missing Southern Signal cache marker",
      true,
    ));
  } catch (error) {
    result.checks.push(check("service-worker", "Service worker", "fail", error.message, true));
  }

  try {
    health = await fetchJson(baseUrl, "/api/health");
    result.checks.push(check(
      "health",
      "Deployment health endpoint",
      "pass",
      `HTTP ok in ${health.elapsedMs}ms`,
      true,
    ));
  } catch (error) {
    result.checks.push(check("health", "Deployment health endpoint", "fail", error.message, true));
  }

  try {
    sync = await fetchJson(baseUrl, "/api/sync/status");
  } catch (error) {
    result.checks.push(check("sync-status", "Sync status endpoint", "fail", error.message, true));
  }

  const features = health?.body?.features ?? {};
  const syncFeature = features.sync ?? {};
  const syncStatus = sync?.body ?? {};
  const syncConfigured = Boolean(syncFeature.configured && syncStatus.configured);

  if (health?.body) {
    result.checks.push(check(
      "ai-research",
      "AI research",
      statusFromConfigured(Boolean(features.ai_research?.configured), false),
      detailFromBooleans({
        key: features.ai_research?.has_model_key,
        rate_limit: features.ai_research?.rate_limit_kv,
      }),
    ));

    result.checks.push(check(
      "ai-transcribe",
      "EVP cloud transcribe",
      statusFromConfigured(Boolean(features.ai_transcribe?.configured), true),
      `provider:${features.ai_transcribe?.provider ?? "none"} openrouter_audio:${features.ai_transcribe?.openrouter_audio_allowed ? "yes" : "no"}`,
      true,
    ));

    result.checks.push(check(
      "sync",
      "Cloud sync and media durability",
      statusFromConfigured(syncConfigured, true),
      detailFromBooleans({
        token: syncFeature.has_kv_token && syncStatus.has_token,
        d1: syncFeature.has_d1 && syncStatus.has_d1,
        r2: syncFeature.has_r2 && syncStatus.has_r2,
        signed_auth: syncFeature.signed_auth_kv && syncStatus.signed_auth_kv,
      }),
      true,
    ));

    result.checks.push(check(
      "live-relay",
      "Live relay / WHIP output",
      statusFromConfigured(Boolean(features.live_relay?.configured), true),
      features.live_relay?.configured
        ? "WHIP relay endpoint configured"
        : "Missing WHIP_RELAY_TOKEN or WHIP_RELAY_ENDPOINT",
      true,
    ));

    result.checks.push(check(
      "fb-connector",
      "Facebook connector",
      statusFromConfigured(Boolean(features.fb_connector?.configured), false),
      detailFromBooleans({
        token: features.fb_connector?.has_token,
        account: features.fb_connector?.has_account,
        stream: features.fb_connector?.has_stream_token,
        state: features.fb_connector?.has_state_d1,
      }),
    ));
  }

  if (sync?.body?.counts) {
    const counts = sync.body.counts;
    result.syncCounts = counts;
  }

  const blockers = result.checks.filter((item) => item.blocker && item.status === "fail");
  const warnings = result.checks.filter((item) => item.status === "warn");
  result.summary = {
    status: blockers.length === 0 ? "ready" : "blocked",
    blockers: blockers.length,
    warnings: warnings.length,
  };

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`[pilot-readiness] ${result.summary.status.toUpperCase()} ${baseUrl.toString()}\n`);
    for (const item of result.checks) {
      const mark = item.status === "pass" ? "PASS" : item.status === "warn" ? "WARN" : "FAIL";
      process.stdout.write(`${mark.padEnd(4)} ${item.label} - ${item.detail}\n`);
    }
    process.stdout.write(`Summary: ${result.summary.blockers} blocker(s), ${result.summary.warnings} warning(s).\n`);
  }

  if (blockers.length > 0) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`[pilot-readiness] FAIL ${error.message}\n`);
  process.exit(1);
});
