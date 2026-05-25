#!/usr/bin/env node
/**
 * Rollout lead for creator-facing Southern Signal releases.
 *
 * Modes:
 *   full        - run pnpm check:launch, then write go/no-go report.
 *   post-deploy - run deployed smoke only against the resolved Pages URL.
 *   report-only - write a report from existing dist artifacts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const outputDir = resolve("dist");
const reportJsonPath = resolve(outputDir, "rollout-go-no-go-report.json");
const reportMdPath = resolve(outputDir, "rollout-go-no-go-report.md");
const launchReportPath = resolve(outputDir, "launch-gates-report.json");
const pilotReportPath = resolve(outputDir, "pilot-readiness.json");
const cameraReportPath = resolve(outputDir, "camera-live-smoke.json");
const cameraScreenshotPath = resolve(outputDir, "camera-live-smoke.png");
const pagesDomain = process.env.ROLLOUT_PAGES_DOMAIN || "southern-signal.pages.dev";

function argValue(name) {
  const exact = args.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return null;
}

function hasArg(name) {
  return args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`));
}

function positionalUrl() {
  return args.find((arg) => /^https?:\/\//i.test(arg)) || null;
}

function normaliseUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function branchToUrl(branch) {
  if (!branch || branch === "master") return `https://${pagesDomain}`;
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
  return `https://${slug || "master"}.${pagesDomain}`;
}

function resolveBaseUrl() {
  const explicit = argValue("--base-url") || positionalUrl() || process.env.ROLLOUT_BASE_URL;
  if (explicit) return normaliseUrl(explicit);
  const branch = argValue("--branch") || process.env.ROLLOUT_BRANCH || gitValue(["rev-parse", "--abbrev-ref", "HEAD"]);
  return normaliseUrl(branchToUrl(branch));
}

function gitValue(gitArgs) {
  const result = spawnSync("git", gitArgs, {
    cwd: resolve(".."),
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function pnpmCommand(...pnpmArgs) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath) && npmExecPath.endsWith(".cjs")) {
    return [process.execPath, npmExecPath, ...pnpmArgs];
  }

  if (process.platform === "win32") {
    const pnpmCjs = process.env.APPDATA
      ? resolve(process.env.APPDATA, "npm", "node_modules", "pnpm", "bin", "pnpm.cjs")
      : null;
    if (pnpmCjs && existsSync(pnpmCjs)) return [process.execPath, pnpmCjs, ...pnpmArgs];
  }

  return ["pnpm", ...pnpmArgs];
}

function runCommand(id, label, command, commandArgs, env) {
  const started = Date.now();
  process.stdout.write(`\n[rollout-lead] RUN  ${label}\n`);
  process.stdout.write(`[rollout-lead] CMD  ${[command, ...commandArgs].join(" ")}\n`);
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const status = result.status === 0 ? "pass" : "fail";
  process.stdout.write(`[rollout-lead] ${status.toUpperCase()} ${label}\n`);

  return {
    id,
    label,
    status,
    exitCode: result.status,
    durationMs: Date.now() - started,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function extractJsonFromText(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function statusValue(name, fallback = "pending") {
  return argValue(`--${name}`) || process.env[`ROLLOUT_${name.toUpperCase().replaceAll("-", "_")}`] || fallback;
}

function isPass(value) {
  return /^(pass|passed|complete|completed|recorded|yes|true|1)$/i.test(String(value || ""));
}

function reportLine(label, value) {
  return `| ${label} | ${value || "pending"} |`;
}

function buildMarkdown(report) {
  const gateLines = report.automated.gates.length > 0
    ? report.automated.gates.map((gate) => `| ${gate.label} | ${gate.status.toUpperCase()} | ${gate.detail || ""} |`)
    : ["| No automated gates found | FAIL | Missing launch artifacts |"];

  const blockers = report.blockers.length > 0
    ? report.blockers.map((item) => `- ${item}`).join("\n")
    : "- None from automated checks.";

  return `# Southern Signal Rollout Go / No-Go Report

Generated: ${report.generatedAt}

## Decision

**${report.decision}**

${report.decisionNote}

## Target

| Field | Value |
| --- | --- |
${reportLine("Intent", report.intent)}
${reportLine("Base URL", report.baseUrl)}
${reportLine("Branch", report.branch)}
${reportLine("Commit", report.commit)}
${reportLine("Mode", report.mode)}

## Automated Gates

| Gate | Status | Detail |
| --- | --- | --- |
${gateLines.join("\n")}

## Operator Evidence

| Evidence | Status |
| --- | --- |
${reportLine("Real phone rehearsal", report.operatorEvidence.realPhoneRehearsal)}
${reportLine("Portrait overlay screenshot", report.operatorEvidence.portraitScreenshot)}
${reportLine("Landscape overlay screenshot", report.operatorEvidence.landscapeScreenshot)}
${reportLine("EVP through camera", report.operatorEvidence.evpThroughCamera)}
${reportLine("10-minute endurance", report.operatorEvidence.enduranceRun)}
${reportLine("Private live dry run", report.operatorEvidence.privateLiveDryRun)}
${reportLine("External Bayesian sign-off", report.operatorEvidence.externalBayesianSignoff)}
${reportLine("External acoustician sign-off", report.operatorEvidence.externalAcousticianSignoff)}

## Artifacts

| Artifact | Path |
| --- | --- |
${reportLine("Rollout JSON", report.artifacts.rolloutJson)}
${reportLine("Launch gates JSON", report.artifacts.launchGatesJson)}
${reportLine("Pilot readiness JSON", report.artifacts.pilotReadinessJson)}
${reportLine("Camera smoke JSON", report.artifacts.cameraSmokeJson)}
${reportLine("Camera smoke screenshot", report.artifacts.cameraSmokeScreenshot)}

## Blockers / Conditions

${blockers}

## Operator Note

Demo-ready means the deployed app and real shoot phone have both passed. A
public episode additionally needs the external Bayesian and acoustician
sign-offs recorded before air.
`;
}

function automatedGates(mode, commandResults, launchReport, pilotReport, cameraReport) {
  if (mode === "full" && launchReport?.gates?.length) {
    return launchReport.gates.map((gate) => ({
      label: gate.label,
      status: gate.status,
      detail: gate.exitCode === undefined ? "" : `exit ${gate.exitCode}`,
    }));
  }

  const gates = commandResults.map((item) => ({
    label: item.label,
    status: item.status,
    detail: item.exitCode === null || item.exitCode === undefined ? "" : `exit ${item.exitCode}`,
  }));

  if (pilotReport?.summary) {
    gates.push({
      label: "Pilot readiness summary",
      status: pilotReport.summary.status === "ready" ? "pass" : "fail",
      detail: `${pilotReport.summary.blockers || 0} blocker(s), ${pilotReport.summary.warnings || 0} warning(s)`,
    });
  }

  if (cameraReport?.result) {
    gates.push({
      label: "Camera smoke summary",
      status: cameraReport.result.readyOrRec && cameraReport.result.visibleMedia ? "pass" : "fail",
      detail: cameraReport.result.url,
    });
  }

  return gates;
}

async function main() {
  const mode = argValue("--mode") || process.env.ROLLOUT_MODE || (hasArg("--report-only") ? "report-only" : "full");
  const intent = statusValue("intent", "creator-demo");
  const baseUrl = resolveBaseUrl();
  const branch = argValue("--branch") || process.env.ROLLOUT_BRANCH || gitValue(["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = process.env.GITHUB_SHA || gitValue(["rev-parse", "HEAD"]);
  const env = {
    ...process.env,
    PILOT_BASE_URL: baseUrl,
    CAMERA_SMOKE_BASE_URL: baseUrl,
    ROLLOUT_BASE_URL: baseUrl,
  };

  mkdirSync(outputDir, { recursive: true });
  const commandResults = [];

  if (mode === "full") {
    const [command, ...commandArgs] = pnpmCommand("check:launch");
    commandResults.push(runCommand("launch", "Full launch gate", command, commandArgs, env));
  } else if (mode === "post-deploy") {
    const pilot = runCommand(
      "pilot",
      "Post-deploy pilot readiness",
      process.execPath,
      ["scripts/pilot-readiness.mjs", baseUrl, "--json"],
      env,
    );
    commandResults.push(pilot);
    const parsedPilot = extractJsonFromText(pilot.stdout);
    if (parsedPilot) writeJson(pilotReportPath, parsedPilot);

    commandResults.push(runCommand(
      "camera-live",
      "Post-deploy camera smoke",
      process.execPath,
      ["scripts/camera-live-smoke.mjs", baseUrl],
      env,
    ));
  } else if (mode !== "report-only") {
    throw new Error(`Unknown rollout mode: ${mode}`);
  }

  const launchReport = readJson(launchReportPath);
  const pilotReport = readJson(pilotReportPath) || extractJsonFromText(
    launchReport?.gates?.find((gate) => gate.id === "pilot")?.stdout || "",
  );
  const cameraReport = readJson(cameraReportPath);
  const gates = automatedGates(mode, commandResults, launchReport, pilotReport, cameraReport);
  const automatedPass = gates.length > 0 && gates.every((gate) => gate.status === "pass");
  const operatorEvidence = {
    realPhoneRehearsal: statusValue("real-phone-rehearsal"),
    portraitScreenshot: statusValue("portrait-screenshot"),
    landscapeScreenshot: statusValue("landscape-screenshot"),
    evpThroughCamera: statusValue("evp-through-camera"),
    enduranceRun: statusValue("endurance-run"),
    privateLiveDryRun: statusValue("private-live-dry-run"),
    externalBayesianSignoff: statusValue("external-bayesian-signoff"),
    externalAcousticianSignoff: statusValue("external-acoustician-signoff"),
  };

  const blockers = [];
  if (!automatedPass) blockers.push("Automated rollout gates are not all passing.");
  if (!isPass(operatorEvidence.realPhoneRehearsal)) blockers.push("Real phone rehearsal is still pending.");
  if (!isPass(operatorEvidence.evpThroughCamera)) blockers.push("EVP-through-camera proof is still pending.");
  if (!isPass(operatorEvidence.enduranceRun)) blockers.push("10-minute endurance proof is still pending.");
  if (!isPass(operatorEvidence.privateLiveDryRun)) blockers.push("Private live dry run is still pending.");
  if (/public/i.test(intent) && !isPass(operatorEvidence.externalBayesianSignoff)) {
    blockers.push("Public episode intent requires external Bayesian sign-off.");
  }
  if (/public/i.test(intent) && !isPass(operatorEvidence.externalAcousticianSignoff)) {
    blockers.push("Public episode intent requires external acoustician sign-off.");
  }

  const allDemoEvidencePass = [
    operatorEvidence.realPhoneRehearsal,
    operatorEvidence.evpThroughCamera,
    operatorEvidence.enduranceRun,
    operatorEvidence.privateLiveDryRun,
  ].every(isPass);
  const publicSignoffPass = [
    operatorEvidence.externalBayesianSignoff,
    operatorEvidence.externalAcousticianSignoff,
  ].every(isPass);

  let decision = "NO-GO";
  let decisionNote = "Automated rollout gates failed or required evidence is missing.";
  if (automatedPass && allDemoEvidencePass && (!/public/i.test(intent) || publicSignoffPass)) {
    decision = "GO";
    decisionNote = "Automated checks and required operator evidence are recorded.";
  } else if (automatedPass) {
    decision = "CONDITIONAL GO";
    decisionNote = "Automated checks passed. Complete the listed operator evidence before treating this as field-ready.";
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode,
    intent,
    baseUrl,
    branch,
    commit,
    decision,
    decisionNote,
    automated: {
      pass: automatedPass,
      gates,
    },
    operatorEvidence,
    blockers,
    artifacts: {
      rolloutJson: reportJsonPath,
      rolloutMarkdown: reportMdPath,
      launchGatesJson: launchReportPath,
      pilotReadinessJson: pilotReportPath,
      cameraSmokeJson: cameraReportPath,
      cameraSmokeScreenshot: cameraScreenshotPath,
    },
  };

  writeJson(reportJsonPath, report);
  writeFileSync(reportMdPath, buildMarkdown(report));
  process.stdout.write(`\n[rollout-lead] Decision: ${decision}\n`);
  process.stdout.write(`[rollout-lead] Markdown: ${reportMdPath}\n`);
  process.stdout.write(`[rollout-lead] JSON: ${reportJsonPath}\n`);

  if (!automatedPass) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`[rollout-lead] FAIL ${error.message}\n`);
  process.exit(1);
});
