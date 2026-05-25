#!/usr/bin/env node
/**
 * Full launch gate for a creator-facing Southern Signal rehearsal.
 *
 * This wraps the checks that can be automated from the laptop. It does not
 * replace the real-phone field rehearsal in docs/the-boys-field-rehearsal-
 * checklist-2026-05-25.md; it proves the deployed app and production bundle
 * are sane before an operator spends time testing on location.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const reportPath = resolve("dist", "launch-gates-report.json");
const maxOutputChars = 12000;

function pnpmCommand(...args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath) && npmExecPath.endsWith(".cjs")) {
    return [process.execPath, npmExecPath, ...args];
  }

  if (process.platform === "win32") {
    const pnpmCjs = process.env.APPDATA
      ? resolve(process.env.APPDATA, "npm", "node_modules", "pnpm", "bin", "pnpm.cjs")
      : null;
    if (pnpmCjs && existsSync(pnpmCjs)) return [process.execPath, pnpmCjs, ...args];
  }

  return ["pnpm", ...args];
}

const gates = [
  {
    id: "lint",
    label: "Static lint",
    command: pnpmCommand("lint"),
  },
  {
    id: "build",
    label: "Production build",
    command: pnpmCommand("build"),
  },
  {
    id: "bundle",
    label: "Bundle budget",
    command: pnpmCommand("check:bundle"),
    dependsOn: ["build"],
  },
  {
    id: "pilot",
    label: "Production pilot readiness",
    command: pnpmCommand("check:pilot", "--", "--json"),
  },
  {
    id: "camera-live",
    label: "Live mobile camera smoke",
    command: pnpmCommand("check:camera-live"),
    dependsOn: ["build", "bundle"],
  },
];

function tail(value) {
  if (value.length <= maxOutputChars) return value;
  return value.slice(value.length - maxOutputChars);
}

function runGate(gate) {
  const [cmd, ...args] = gate.command;
  const started = Date.now();
  process.stdout.write(`\n[launch-gates] RUN  ${gate.label}\n`);
  process.stdout.write(`[launch-gates] CMD  ${[cmd, ...args].join(" ")}\n`);

  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: process.cwd(),
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolvePromise({
        id: gate.id,
        label: gate.label,
        status: "fail",
        exitCode: null,
        durationMs: Date.now() - started,
        stdout: "",
        stderr: error.message,
      });
      return;
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", (error) => {
      resolvePromise({
        id: gate.id,
        label: gate.label,
        status: "fail",
        exitCode: null,
        durationMs: Date.now() - started,
        stdout: tail(stdout),
        stderr: tail(`${stderr}\n${error.message}`.trim()),
      });
    });

    child.on("close", (exitCode) => {
      resolvePromise({
        id: gate.id,
        label: gate.label,
        status: exitCode === 0 ? "pass" : "fail",
        exitCode,
        durationMs: Date.now() - started,
        stdout: tail(stdout),
        stderr: tail(stderr),
      });
    });
  });
}

async function main() {
  const report = {
    checkedAt: new Date().toISOString(),
    cwd: process.cwd(),
    gates: [],
    artifacts: {
      launchReport: reportPath,
      cameraSmokeJson: resolve("dist", "camera-live-smoke.json"),
      cameraSmokeScreenshot: resolve("dist", "camera-live-smoke.png"),
    },
  };

  const completed = new Map();

  for (const gate of gates) {
    const missingDependency = gate.dependsOn?.find((id) => completed.get(id)?.status !== "pass");
    if (missingDependency) {
      const skipped = {
        id: gate.id,
        label: gate.label,
        status: "skipped",
        reason: `Skipped because ${missingDependency} did not pass.`,
      };
      report.gates.push(skipped);
      completed.set(gate.id, skipped);
      process.stdout.write(`\n[launch-gates] SKIP ${gate.label} - ${skipped.reason}\n`);
      continue;
    }

    const result = await runGate(gate);
    report.gates.push(result);
    completed.set(gate.id, result);

    const mark = result.status === "pass" ? "PASS" : "FAIL";
    process.stdout.write(`[launch-gates] ${mark} ${gate.label} (${result.durationMs}ms)\n`);
  }

  const failed = report.gates.filter((gate) => gate.status === "fail");
  const skipped = report.gates.filter((gate) => gate.status === "skipped");
  report.summary = {
    status: failed.length === 0 && skipped.length === 0 ? "ready" : "blocked",
    passed: report.gates.filter((gate) => gate.status === "pass").length,
    failed: failed.length,
    skipped: skipped.length,
  };

  mkdirSync(resolve("dist"), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(`\n[launch-gates] ${report.summary.status.toUpperCase()}\n`);
  process.stdout.write(`[launch-gates] Report: ${reportPath}\n`);

  if (report.summary.status !== "ready") {
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`[launch-gates] FAIL ${error.message}\n`);
  process.exit(1);
});
