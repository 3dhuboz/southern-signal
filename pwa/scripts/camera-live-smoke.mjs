#!/usr/bin/env node
/**
 * Live mobile-camera smoke test.
 *
 * Runs the production camera route in headless Chrome with fake camera/mic
 * devices, captures a mobile screenshot, and fails if the first-screen ghost
 * hunt workflow regresses. This is intentionally a browser-level check: unit
 * tests do not prove camera permissions, PWA shell, overlay visibility, or
 * console/autoplay behavior on the deployed Pages app.
 *
 * Usage:
 *   pnpm build
 *   pnpm check:camera-live
 *   pnpm check:camera-live https://preview.example.pages.dev
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const DEFAULT_BASE_URL = "https://southern-signal.pages.dev";
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2 };
const OUT_JSON = resolve("dist", "camera-live-smoke.json");
const OUT_PNG = resolve("dist", "camera-live-smoke.png");

const rawArgs = process.argv.slice(2);
const jsonMode = rawArgs.includes("--json");
const positional = rawArgs.filter((arg) => !arg.startsWith("--"));
const baseUrl = normaliseBaseUrl(positional[0] || process.env.CAMERA_SMOKE_BASE_URL || DEFAULT_BASE_URL);
const qaUrl = new URL("/camera?qa=camera-live-smoke", baseUrl);

function normaliseBaseUrl(value) {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    fail(`Invalid base URL: ${value}`);
  }
}

function readExpectedAssets() {
  const htmlPath = resolve("dist", "index.html");
  if (!existsSync(htmlPath)) {
    fail("dist/index.html is missing. Run `pnpm build` before `pnpm check:camera-live`.");
  }
  const html = readFileSync(htmlPath, "utf8");
  const js = html.match(/assets\/index-[^"']+\.js/)?.[0] ?? null;
  const css = html.match(/assets\/index-[^"']+\.css/)?.[0] ?? null;
  if (!js || !css) {
    fail("dist/index.html did not contain the expected index JS/CSS assets.");
  }
  return { js, css };
}

function findChrome() {
  const envPath = process.env.CHROME_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const candidates = process.platform === "win32"
    ? [
        join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      ]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];

  const chrome = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!chrome) {
    fail("Chrome executable not found. Set CHROME_PATH to run the live camera smoke test.");
  }
  return chrome;
}

function pickPort() {
  return 9200 + Math.floor(Math.random() * 600);
}

async function waitForDevtools(port) {
  const url = `http://127.0.0.1:${port}/json/version`;
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = await response.json();
        if (body.webSocketDebuggerUrl) return body;
      }
    } catch {
      await wait(200);
    }
  }
  fail("Chrome DevTools Protocol did not become ready.");
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ws.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (data.id && this.pending.has(data.id)) {
        const pending = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) pending.reject(new Error(JSON.stringify(data.error)));
        else pending.resolve(data.result || {});
        return;
      }
      if (data.method) this.events.push(data);
    };
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolvePromise, rejectPromise) => {
      this.ws.onopen = resolvePromise;
      this.ws.onerror = rejectPromise;
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        rejectPromise(new Error(`${method} timed out`));
      }, 20000);
    });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result?.value;
}

async function dispatchClick(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function fail(message) {
  process.stderr.write(`[camera-live-smoke] FAIL ${message}\n`);
  process.exit(1);
}

function assertCheck(condition, message) {
  if (!condition) throw new Error(message);
}

async function runSmoke() {
  const expected = readExpectedAssets();
  const chrome = findChrome();
  const port = pickPort();
  const userDataDir = mkdtempSync(join(tmpdir(), "ss-camera-smoke-"));
  const chromeArgs = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  const child = spawn(chrome, chromeArgs, { stdio: "ignore", windowsHide: true });

  let cdp;
  try {
    await waitForDevtools(port);
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const target = targets.find((item) => item.type === "page") || targets[0];
    if (!target?.webSocketDebuggerUrl) throw new Error("No Chrome page target found.");

    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: MOBILE.width,
      height: MOBILE.height,
      deviceScaleFactor: MOBILE.deviceScaleFactor,
      mobile: true,
      screenWidth: MOBILE.width,
      screenHeight: MOBILE.height,
      positionX: 0,
      positionY: 0,
    });
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Mobile Safari/537.36",
    });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        (() => {
          const now = new Date().toISOString();
          localStorage.setItem("ss-active-scene", "spirit_box_session");
          localStorage.setItem("ss-has-picked-scene", "1");
          localStorage.setItem("ss-onboarding-completed-v1", now);
          localStorage.setItem("ss-camera-welcome-seen-v0.7.0", String(Date.now()));
          localStorage.setItem("ss-preferences-v1", JSON.stringify({
            acknowledgementOfCountry: { accepted: true, acceptedAt: now, statement: null },
            globalCulturalSensitivityFlag: false,
            experienceMode: "simple",
            evp: { autoTranscribe: false },
            itcMonitor: false
          }));
          localStorage.setItem("ss-scene-overrides:spirit_box_session", JSON.stringify({
            audioMeter: true,
            caption: true,
            directionArrow: true,
            emfGalvanometer: true,
            kiiMeter: true,
            motionDetector: true,
            remPod: true,
            sensors: true
          }));
        })();
      `,
    });

    await cdp.send("Page.navigate", { url: qaUrl.toString() });
    await wait(6500);
    await evaluate(cdp, `
      (() => {
        const consent = [...document.querySelectorAll("button")]
          .find((button) => /accept|allow/i.test(button.innerText || ""));
        if (consent) consent.click();
        return document.body.innerText;
      })()
    `);
    await wait(1000);
    await dispatchClick(cdp, Math.round(MOBILE.width / 2), 625);
    await wait(5500);

    const result = await evaluate(cdp, `
      (() => {
        const body = document.body.innerText || "";
        const media = Array.from(document.querySelectorAll("video,canvas"))
          .map((el) => ({
            tag: el.tagName,
            w: el.clientWidth,
            h: el.clientHeight,
            readyState: el.readyState ?? null
          }));
        const scripts = Array.from(document.scripts).map((script) => script.src).filter(Boolean);
        const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
          .map((link) => link.href);
        return {
          url: location.href,
          title: document.title,
          latestJs: scripts.some((src) => src.includes(${JSON.stringify(expected.js)})),
          latestCss: links.some((href) => href.includes(${JSON.stringify(expected.css)})),
          readyOrRec: body.includes("READY") || body.includes("REC"),
          sceneVisible: body.includes("Spirit Box Session"),
          permissionRequired: body.includes("Allow camera") || body.includes("CAMERA PERMISSION REQUIRED"),
          staleClutterTextPresent: ["K-II EMF METER", "REM POD", "FIELD SENSORS", "MOTION", "OVILUS"]
            .some((label) => body.includes(label)),
          visibleMedia: media.some((item) => item.w > 100 && item.h > 100),
          media,
          bodySample: body.slice(0, 1000)
        };
      })()
    `);

    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    writeFileSync(OUT_PNG, Buffer.from(screenshot.data, "base64"));

    const logs = cdp.events
      .filter((event) => event.method === "Log.entryAdded" || event.method === "Runtime.exceptionThrown")
      .map((event) => event.params);
    const logText = logs
      .map((item) => item.entry?.text || item.exceptionDetails?.text || "")
      .join(" ");
    const fatalLogs = logs.filter((item) => item.entry?.level === "error" || item.exceptionDetails);
    const summary = {
      baseUrl: baseUrl.toString(),
      checkedAt: new Date().toISOString(),
      expected,
      result,
      logs,
      assertions: {
        audioContextWarning: /AudioContext was not allowed/.test(logText),
        fatalLogs: fatalLogs.length,
      },
      artifacts: {
        json: OUT_JSON,
        screenshot: OUT_PNG,
      },
    };

    assertCheck(result.latestJs, `Production is not serving ${expected.js}`);
    assertCheck(result.latestCss, `Production is not serving ${expected.css}`);
    assertCheck(result.readyOrRec, "Camera did not reach READY/REC state.");
    assertCheck(result.sceneVisible, "Spirit Box Session was not visible.");
    assertCheck(!result.permissionRequired, "Camera permission blocker stayed visible.");
    assertCheck(!result.staleClutterTextPresent, "Old noisy overlay labels were visible.");
    assertCheck(result.visibleMedia, "No visible camera media was found.");
    assertCheck(!summary.assertions.audioContextWarning, "AudioContext autoplay warning was logged.");
    assertCheck(summary.assertions.fatalLogs === 0, "Console/runtime errors were logged.");

    writeFileSync(OUT_JSON, `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  } finally {
    cdp?.close();
    if (!child.killed) child.kill("SIGKILL");
    await wait(500);
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Windows can hold Chrome's temp profile lock briefly after process
      // teardown. The OS temp cleaner can collect it later; the smoke result
      // should not fail on cleanup timing.
    }
  }
}

runSmoke()
  .then((summary) => {
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return;
    }
    process.stdout.write(`[camera-live-smoke] PASS ${summary.result.url}\n`);
    process.stdout.write(`Assets: ${summary.expected.js} / ${summary.expected.css}\n`);
    process.stdout.write(`Screenshot: ${summary.artifacts.screenshot}\n`);
    process.stdout.write(`JSON: ${summary.artifacts.json}\n`);
  })
  .catch((error) => {
    fail(error.message);
  });
