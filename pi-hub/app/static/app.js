let selectedId = null;
let pollTimer = null;
let toastTimer = null;
let pollingInFlight = false;
let selectionRequestId = 0;
let observationTypes = [];
let observationTypesAvailable = false;
let uploadsAvailable = true;
let cachedHardware = null;

const STORAGE_KEYS = {
  selectedId: "southernSignal.selectedInvestigationId",
  view: "southernSignal.selectedView",
};

const buttonLabels = new Map();
const busyButtons = new Set();
const elementLabels = new WeakMap();
const sessionButtonIds = new Set([
  "start",
  "stop",
  "capture",
  "export",
  "drawer-export",
  "export-panel-button",
  "marker-button",
  "contamination-button",
  "observation-button",
  "upload-audio-trigger",
  "upload-photo-trigger",
]);

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  try {
    const fetchOptions = { ...options };
    const headers = { ...(options.headers || {}) };
    if (!fetchOptions.body || typeof fetchOptions.body === "string") {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
    }
    fetchOptions.headers = headers;
    const response = await fetch(path, fetchOptions);
    if (!response.ok) {
      const body = await response.text();
      const error = new Error(formatApiError(body, response.statusText));
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    return response.text();
  } catch (error) {
    if (!options.quiet) {
      notify(error.message || "Request failed", "error");
    }
    throw error;
  }
}

function formatApiError(body, fallback) {
  if (!body) return fallback || "Request failed";
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.detail === "string") return parsed.detail;
    if (Array.isArray(parsed.detail)) {
      return parsed.detail.map((item) => item.msg || item.message || JSON.stringify(item)).join("; ");
    }
    return parsed.message || parsed.error || body;
  } catch {
    return body;
  }
}

function notify(message, tone = "info") {
  const toast = $("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast show ${tone}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = "toast";
  }, 3200);
}

function formatTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString();
}

function formatDateTime(value) {
  if (!value) return "Not started";
  return new Date(value).toLocaleString();
}

function parseJson(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function eventClass(event) {
  if (event.event_type === "contamination") return "event contamination";
  if (event.event_type === "marker") return "event marker";
  if (event.event_type === "observation") return "event observation";
  if (event.event_type && event.event_type.startsWith("session_")) return "event session-event";
  return "event";
}

function setView(viewName) {
  const view = document.querySelector(`[data-view-panel="${viewName}"]`) ? viewName : "mission";
  document.querySelectorAll(".nav-item, .bottom-nav-item").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  document.querySelectorAll(".view").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === view);
  });
  localStorage.setItem(STORAGE_KEYS.view, view);
  if (typeof window !== "undefined" && window.scrollTo) {
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }
}

function setSelectedControls(enabled) {
  [
    "start",
    "stop",
    "capture",
    "export",
    "drawer-export",
    "export-panel-button",
    "marker-button",
    "contamination-button",
  ].forEach((id) => {
    const control = $(id);
    if (control) control.disabled = !enabled || busyButtons.has(id);
  });

  const observationBtn = $("observation-button");
  if (observationBtn) {
    observationBtn.disabled = !enabled || !observationTypesAvailable || busyButtons.has("observation-button");
  }

  ["upload-audio-trigger", "upload-photo-trigger"].forEach((id) => {
    const button = $(id);
    if (button) button.disabled = !enabled || !uploadsAvailable || busyButtons.has(id);
  });

  if ($("contamination-type")) $("contamination-type").disabled = !enabled;
  if ($("observation-type")) $("observation-type").disabled = !enabled || !observationTypesAvailable;
  if ($("upload-observation-type")) $("upload-observation-type").disabled = !enabled || !observationTypesAvailable;

  document.querySelectorAll(".quick-tag").forEach((button) => {
    button.disabled = !enabled || button.dataset.busy === "true";
  });
}

function setButtonBusy(id, busy, busyText = "Working...") {
  const button = $(id);
  if (!button) return;
  if (!buttonLabels.has(id)) buttonLabels.set(id, button.textContent);
  if (busy) busyButtons.add(id);
  else busyButtons.delete(id);
  button.disabled = busy || (sessionButtonIds.has(id) && !selectedId);
  button.textContent = busy ? busyText : buttonLabels.get(id);
}

async function withButtonLoading(id, busyText, action) {
  setButtonBusy(id, true, busyText);
  try {
    return await action();
  } finally {
    setButtonBusy(id, false);
    setSelectedControls(Boolean(selectedId));
  }
}

function setElementBusy(element, busy, busyText = "Working...") {
  if (!element) return;
  if (!elementLabels.has(element)) elementLabels.set(element, element.textContent);
  element.disabled = busy;
  element.textContent = busy ? busyText : elementLabels.get(element);
}

async function withElementLoading(element, busyText, action) {
  setElementBusy(element, true, busyText);
  try {
    return await action();
  } finally {
    setElementBusy(element, false);
    setSelectedControls(Boolean(selectedId));
  }
}

function setUploadBusy(button, busy, busyText) {
  if (!button) return;
  const strong = button.querySelector(".upload-text strong");
  const small = button.querySelector(".upload-text small");
  if (busy) {
    if (!elementLabels.has(button)) {
      elementLabels.set(button, {
        strong: strong ? strong.textContent : "",
        small: small ? small.textContent : "",
      });
    }
    if (strong) strong.textContent = busyText;
    if (small) small.textContent = "Uploading...";
    button.classList.add("is-busy");
    button.disabled = true;
  } else {
    button.classList.remove("is-busy");
    const original = elementLabels.get(button);
    if (original) {
      if (strong) strong.textContent = original.strong;
      if (small) small.textContent = original.small;
    }
    button.disabled = !selectedId || !uploadsAvailable;
  }
}

function emptyState(title, detail) {
  return `
    <div class="empty-state">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(detail)}</span>
    </div>
  `;
}

async function refreshHealth() {
  try {
    const health = await api("/api/health", { quiet: true });
    const label = health.status === "ok" ? "Hub online" : "Hub unknown";
    const cls = "status online";
    setHealth(label, cls);
  } catch {
    setHealth("Hub offline", "status offline");
  }
}

function setHealth(label, cls) {
  const main = $("health");
  const drawer = $("drawer-health");
  if (main) {
    main.textContent = label;
    main.className = cls;
  }
  if (drawer) {
    drawer.textContent = label;
    drawer.className = cls;
  }
}

async function refreshAppState() {
  const state = await api("/api/app-state", { quiet: true });
  const providerLabel = pickFriendlyProviderLabel(state, cachedHardware);
  const html = `
    <div>
      <strong>${escapeHtml(state.app_version)}</strong>
      <span>version</span>
    </div>
    <div>
      <strong>${state.investigation_count}</strong>
      <span>cases</span>
    </div>
    <div>
      <strong>${state.running_investigation_count}</strong>
      <span>running</span>
    </div>
    <div>
      <strong>${escapeHtml(providerLabel)}</strong>
      <span>mode</span>
    </div>
  `;
  const main = $("app-state");
  const drawer = $("drawer-app-state");
  if (main) main.innerHTML = html;
  if (drawer) drawer.innerHTML = html;
}

function pickFriendlyProviderLabel(state, hardware) {
  if (hardware && hardware.mode_label) return hardware.mode_label;
  if (hardware && hardware.friendly_label) return hardware.friendly_label;
  if (hardware && hardware.mode === "pi") return "Raspberry Pi";
  if (hardware && hardware.mode === "standalone") return "Mobile / standalone";
  const provider = (state && state.active_hardware_provider) || (hardware && hardware.active_provider) || "";
  if (!provider || provider === "mock") return "Mobile / standalone";
  return provider;
}

async function refreshHardware() {
  let hardware;
  try {
    hardware = await api("/api/hardware", { quiet: true });
  } catch (error) {
    cachedHardware = null;
    if ($("hardware")) {
      $("hardware").innerHTML = emptyState(
        "Hardware status unavailable",
        "Standalone mode is active. Phone uploads and observations work right now.",
      );
    }
    updateModeBadge(null);
    return;
  }

  cachedHardware = hardware;
  updateModeBadge(hardware);

  const providerLabel = pickFriendlyProviderLabel(null, hardware);
  const friendlyDescription =
    hardware.mode_description ||
    hardware.friendly_description ||
    (hardware.mode === "pi"
      ? "Raspberry Pi sensors are connected and providing live capture."
      : "Phone uploads and observations are live. Connect a Raspberry Pi to add live sensor capture.");

  const providersHtml = (hardware.providers || [])
    .map((provider) => {
      const detail = friendlyProviderDetail(provider, hardware);
      const stateLabel = provider.available ? "Ready" : provider.status_label || "Add a Pi";
      return `
        <article class="hardware-provider ${provider.available ? "available" : "missing"}">
          <div>
            <strong>${escapeHtml(provider.friendly_label || provider.label || provider.id || "Sensor")}</strong>
            <p>${escapeHtml(detail)}</p>
          </div>
          <span>${escapeHtml(stateLabel)}</span>
        </article>
      `;
    })
    .join("");

  const target = $("hardware");
  if (!target) return;
  target.innerHTML = `
    <div class="hardware-summary">
      <strong>Mode</strong>
      <span>${escapeHtml(providerLabel)}</span>
    </div>
    <p class="hint subtle-hint">${escapeHtml(friendlyDescription)}</p>
    <div class="hardware-list">${providersHtml}</div>
  `;
}

function friendlyProviderDetail(provider, hardware) {
  if (provider.friendly_description) return provider.friendly_description;
  if (provider.detail) return provider.detail;
  const id = (provider.id || provider.label || "").toLowerCase();
  if (provider.available) return "Connected and active.";
  if (id.includes("camera")) {
    return "Capture-ready when you connect a Pi camera. Phone photo uploads work right now.";
  }
  if (id.includes("audio") || id.includes("mic")) {
    return "Capture-ready when you connect a Pi microphone. Phone audio uploads work right now.";
  }
  if (id.includes("sensor") || id.includes("imu") || id.includes("pi")) {
    return "Synthetic sensor — connect a Pi to enable live capture.";
  }
  return "Connect a Raspberry Pi to add live sensor capture.";
}

function updateModeBadge(hardware) {
  const badge = $("mode-badge");
  const label = $("mode-badge-label");
  const modalTitle = $("mode-modal-title");
  const modalBody = $("mode-modal-description");
  const modalHint = $("mode-modal-hint");
  if (!badge || !label) return;

  const mode = hardware && hardware.mode ? hardware.mode : "standalone";
  const isPi = mode === "pi";
  badge.classList.toggle("has-pi", isPi);

  const fallbackLabel = isPi ? "Pi connected" : "Standalone mode";
  const modeLabel = (hardware && (hardware.mode_label || hardware.friendly_label)) || fallbackLabel;
  label.textContent = modeLabel;
  if (modalTitle) modalTitle.textContent = modeLabel;

  const fallbackDescription = isPi
    ? "A Raspberry Pi is connected. You're getting live sensor capture alongside phone uploads, contamination tagging, and the full review and export workflow."
    : "You can run a full investigation right now from your phone — log observations, upload audio and photos, mark contamination, and export evidence bundles. The hub generates synthetic sensor data so the workflow stays end-to-end.";
  if (modalBody) {
    modalBody.textContent =
      (hardware && (hardware.mode_description || hardware.friendly_description)) || fallbackDescription;
  }

  if (modalHint) {
    if (isPi) {
      modalHint.textContent = "Tip: phone uploads still work alongside Pi capture for moments you catch off-device.";
    } else {
      const piHint =
        (hardware && hardware.pi_hint) ||
        "Connect a Raspberry Pi to add live sensor capture, microphone audio, and camera stills alongside your phone uploads.";
      modalHint.textContent = piHint;
    }
  }

  const captureHint = $("capture-hint");
  if (captureHint) {
    captureHint.textContent = isPi
      ? "Pi capture is online. Phone uploads remain available too."
      : "Phone uploads work right now. Connect a Raspberry Pi to add live sensor capture.";
  }

  const readingsHint = $("readings-hint");
  if (readingsHint) {
    readingsHint.textContent = isPi
      ? "Live sensor stream from the connected Pi."
      : "Synthetic sensor — connect a Pi to enable live capture.";
  }
}

async function refreshSessions() {
  const sessions = await api("/api/investigations", { quiet: true });
  refreshAppState().catch((error) => console.warn("App state refresh failed", error));
  if (selectedId && !sessions.some((session) => session.id === selectedId)) {
    clearSelectedInvestigation();
  }
  $("sessions").innerHTML = sessions.length
    ? sessions
        .map(
          (session) => `
            <button class="session ${session.id === selectedId ? "active" : ""}" data-id="${escapeHtml(session.id)}">
              <span>${escapeHtml(session.title)}</span>
              <small><b class="status-pill ${escapeHtml(session.status)}">${escapeHtml(session.status)}</b>${formatDateTime(session.started_at || session.created_at)}</small>
            </button>
          `,
        )
        .join("")
    : emptyState("No investigations yet", "Create one from Setup to begin — works on phone alone.");

  document.querySelectorAll(".session").forEach((button) => {
    button.addEventListener("click", () => selectInvestigation(button.dataset.id));
  });
  return sessions;
}

async function refreshProtocols() {
  const protocols = await api("/api/protocols", { quiet: true });
  $("protocols").innerHTML = protocols
    .map(
      (protocol) => `
        <article class="protocol">
          <strong>${escapeHtml(protocol.title)}</strong>
          <p>${escapeHtml(protocol.description)}</p>
          <small>${protocol.step_count} steps - ${Math.round(protocol.duration_seconds / 60)} min</small>
        </article>
      `,
    )
    .join("");
}

async function refreshContaminationTags() {
  const tags = await api("/api/contamination-tags", { quiet: true });
  $("contamination-type").innerHTML = tags
    .map((tag) => `<option value="${escapeHtml(tag.id)}">${escapeHtml(tag.label)} (${escapeHtml(tag.group)})</option>`)
    .join("");
  const fastTags = tags.filter((tag) => ["footstep", "speech", "breath", "phone_movement", "wind", "door"].includes(tag.id));
  $("quick-tags").innerHTML = fastTags
    .map((tag) => `<button type="button" class="quick-tag" data-tag="${escapeHtml(tag.id)}" disabled>${escapeHtml(tag.label)}</button>`)
    .join("");
  document.querySelectorAll(".quick-tag").forEach((button) => {
    button.addEventListener("click", () => addContamination(button.dataset.tag, button.textContent));
  });
  setSelectedControls(Boolean(selectedId));
}

async function refreshObservationTypes() {
  try {
    const types = await api("/api/observation-types", { quiet: true });
    if (!Array.isArray(types) || types.length === 0) {
      observationTypesAvailable = false;
      observationTypes = [];
      renderObservationTypeSelects();
      return;
    }
    observationTypes = types;
    observationTypesAvailable = true;
  } catch (error) {
    observationTypesAvailable = false;
    observationTypes = [];
    if (error && error.status && error.status !== 404) {
      console.warn("Observation types unavailable", error);
    }
  }
  renderObservationTypeSelects();
  setSelectedControls(Boolean(selectedId));
}

function renderObservationTypeSelects() {
  const targets = ["observation-type", "upload-observation-type"];
  if (!observationTypesAvailable) {
    targets.forEach((id) => {
      const sel = $(id);
      if (sel) sel.innerHTML = '<option value="">Observations coming online...</option>';
    });
    const helper = $("observation-helper");
    if (helper) helper.textContent = "Observation library is loading. Try again in a moment.";
    return;
  }
  const grouped = observationTypes.reduce((acc, type) => {
    const category = type.category || "general";
    if (!acc[category]) acc[category] = [];
    acc[category].push(type);
    return acc;
  }, {});

  const html = Object.entries(grouped)
    .map(([category, items]) => {
      const options = items
        .map((item) => {
          const desc = item.description ? escapeHtml(item.description) : "";
          return `<option value="${escapeHtml(item.id)}" title="${desc}" data-default-intensity="${escapeHtml(item.default_intensity ?? 3)}">${escapeHtml(item.label)}</option>`;
        })
        .join("");
      return `<optgroup label="${escapeHtml(category)}">${options}</optgroup>`;
    })
    .join("");

  targets.forEach((id) => {
    const sel = $(id);
    if (sel) sel.innerHTML = html;
  });
  refreshObservationHelper();
}

function refreshObservationHelper() {
  const sel = $("observation-type");
  const helper = $("observation-helper");
  if (!sel || !helper) return;
  const option = sel.options[sel.selectedIndex];
  if (!option) {
    helper.textContent = "Choose what you noticed. Strength = how unmistakable it was.";
    return;
  }
  const desc = option.title || option.getAttribute("title") || "";
  helper.textContent = desc || "Choose what you noticed. Strength = how unmistakable it was.";

  const intensity = option.dataset && option.dataset.defaultIntensity;
  if (intensity) {
    const slider = $("observation-intensity");
    const valueLabel = $("observation-intensity-value");
    if (slider) slider.value = intensity;
    if (valueLabel) valueLabel.textContent = intensity;
  }
}

async function selectInvestigation(id) {
  if (!id) return;
  const requestId = ++selectionRequestId;
  selectedId = id;
  localStorage.setItem(STORAGE_KEYS.selectedId, id);
  setSelectedControls(true);

  const session = await api(`/api/investigations/${id}`);
  if (requestId !== selectionRequestId) return;
  $("selected").innerHTML = `
    <strong>${escapeHtml(session.title)}</strong>
    <span>${escapeHtml(session.location_name || "No location")} - <b class="status-pill ${escapeHtml(session.status)}">${escapeHtml(session.status)}</b></span>
    <small>${session.sample_count} samples - ${session.event_count} events - ${session.media_count} media</small>
  `;
  $("case-strip").innerHTML = `
    <span><b>${escapeHtml(session.status)}</b> status</span>
    <span><b>${session.sample_count}</b> samples</span>
    <span><b>${session.event_count}</b> events</span>
    <span><b>${session.media_count}</b> media</span>
  `;
  await Promise.all([
    refreshSessions(),
    refreshEvents(),
    refreshMedia(),
    refreshAnomalies(),
    refreshReport(),
    refreshLive(),
  ]);
  startPolling();
}

function clearSelectedInvestigation() {
  selectedId = null;
  selectionRequestId += 1;
  localStorage.removeItem(STORAGE_KEYS.selectedId);
  stopPolling();
  $("selected").textContent = "No investigation selected";
  $("case-strip").innerHTML = "<span>No case loaded</span>";
  $("readings").innerHTML = "";
  $("events").innerHTML = emptyState("No investigation selected", "Choose or create an investigation to view the timeline.");
  if ($("recent-observations")) {
    $("recent-observations").innerHTML = emptyState(
      "No observations yet",
      "Log what you notice — observations work without a Pi.",
    );
  }
  $("media").innerHTML = emptyState("No investigation selected", "Media assets will appear after a session is selected.");
  $("media-export").innerHTML = $("media").innerHTML;
  $("anomalies").innerHTML = emptyState("No investigation selected", "Anomaly detection starts once a session is selected.");
  $("review-windows").innerHTML = emptyState("No investigation selected", "Replay windows will appear after review data exists.");
  $("report").innerHTML = emptyState("No report yet", "Select an investigation to calculate evidence confidence.");
  setSelectedControls(false);
}

function renderObservationCard(event) {
  const meta = parseJson(event.metadata_json);
  const intensity = meta.intensity || event.intensity;
  return `
    <article class="event observation">
      <time>${formatTime(event.timestamp)}</time>
      <div>
        <strong>${escapeHtml(event.title || meta.observation_label || "Observation")}</strong>
        <p>${escapeHtml(event.description || meta.observation_label || event.event_type || "")}</p>
        ${intensity ? `<div class="observation-meta"><span class="intensity-pip">Strength ${escapeHtml(intensity)}/5</span></div>` : ""}
      </div>
    </article>
  `;
}

async function refreshEvents() {
  if (!selectedId) return;
  const events = await api(`/api/investigations/${selectedId}/events`, { quiet: true });
  $("events").innerHTML = events.length
    ? events
        .map(
          (event) => `
            <article class="${eventClass(event)}">
              <time>${formatTime(event.timestamp)}</time>
              <div>
                <strong>${escapeHtml(event.title)}</strong>
                <p>${escapeHtml(event.description || event.event_type)}</p>
              </div>
            </article>
          `,
        )
        .join("")
    : emptyState("No timeline events yet", "Log an observation, add a marker, or upload audio to build the case file.");

  const recentTarget = $("recent-observations");
  if (recentTarget) {
    const observations = events.filter((event) => event.event_type === "observation").slice(-6).reverse();
    recentTarget.innerHTML = observations.length
      ? observations.map(renderObservationCard).join("")
      : emptyState("No observations yet", "Log what you notice — observations work without a Pi.");
  }
}

async function refreshMedia() {
  if (!selectedId) return;
  const media = await api(`/api/investigations/${selectedId}/media`, { quiet: true });
  const html = media.length
    ? media
        .map((asset) => {
          const metadata = parseJson(asset.metadata_json);
          const recorder = metadata.recorder || asset.media_type;
          const placeholder = metadata.placeholder || String(recorder).includes("placeholder");
          const sourceLabel = metadata.source === "phone_upload" ? " - phone upload" : "";
          return `
            <article class="event">
              <time>${formatTime(asset.timestamp_start)}</time>
              <div>
                <strong>${escapeHtml(asset.media_type)} - ${escapeHtml(recorder)}${escapeHtml(sourceLabel)}</strong>
                <p>${escapeHtml(asset.file_path)}${placeholder ? " - placeholder" : ""}</p>
              </div>
            </article>
          `;
        })
        .join("")
    : emptyState("No media assets yet", "Upload audio or a photo from your phone, or capture a still with a connected Pi.");
  $("media").innerHTML = html;
  $("media-export").innerHTML = html;
}

async function refreshAnomalies() {
  if (!selectedId) return;
  const anomalies = await api(`/api/investigations/${selectedId}/anomalies`, { quiet: true });
  $("anomalies").innerHTML = anomalies.length
    ? anomalies
        .map(
          (anomaly) => `
            <article class="event anomaly ${escapeHtml(anomaly.severity)}">
              <time>${formatTime(anomaly.timestamp)}</time>
              <div>
                <strong>${escapeHtml(anomaly.sensor_type)} - ${escapeHtml(anomaly.severity)}</strong>
                <p>${escapeHtml(anomaly.reason)}</p>
              </div>
            </article>
          `,
        )
        .join("")
    : emptyState("No anomalies detected", "Run longer sessions to build a local baseline.");
}

async function refreshReport() {
  if (!selectedId) return;
  const report = await api(`/api/investigations/${selectedId}/evidence-report`, { quiet: true });
  $("report").innerHTML = `
    <div class="report-grid">
      <article>
        <strong>${report.confidence.score}/100</strong>
        <span>${escapeHtml(report.confidence.label)} confidence</span>
      </article>
      <article>
        <strong>${report.counts.anomalies}</strong>
        <span>anomalies</span>
      </article>
      <article>
        <strong>${report.counts.media}</strong>
        <span>media</span>
      </article>
      <article>
        <strong>${report.counts.samples}</strong>
        <span>samples</span>
      </article>
    </div>
    <ul>${report.review_next_steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ul>
  `;
  $("review-windows").innerHTML = report.review_windows.length
    ? report.review_windows
        .map(
          (window) => `
            <article class="event review-window ${escapeHtml(window.severity || "")}">
              <time>${formatTime(window.timestamp)}</time>
              <div>
                <strong>${escapeHtml(window.title)}</strong>
                <p>${escapeHtml(window.reason || "Review this window against the timeline.")}</p>
                <small>${formatTime(window.start)} - ${formatTime(window.end)} - ${window.events.length} events - ${window.media.length} media</small>
              </div>
            </article>
          `,
        )
        .join("")
    : emptyState("No replay windows yet", "Anomalies and events will become review windows here.");
}

async function refreshLive() {
  if (!selectedId) return;
  const live = await api(`/api/investigations/${selectedId}/live`, { quiet: true });
  $("readings").innerHTML = live.readings
    .map((reading) => {
      const value = reading.value === undefined || reading.value === null ? "" : reading.value.toFixed(2);
      const axes = ["x", "y", "z"]
        .filter((axis) => reading[axis] !== undefined && reading[axis] !== null)
        .map((axis) => `${axis.toUpperCase()} ${reading[axis].toFixed(2)}`)
        .join(" - ");
      return `
        <article class="reading">
          <strong>${escapeHtml(reading.sensor_type)}</strong>
          <span>${escapeHtml(value)} ${escapeHtml(reading.unit || "")}</span>
          <small>${escapeHtml(axes)}</small>
        </article>
      `;
    })
    .join("");
}

async function scoreEvidence(kind) {
  const payload =
    kind === "strong"
      ? {
          audio_spike: true,
          sensor_correlation_count: 3,
          media_support: true,
          unattended_room: true,
          blind_reviewer_agreement_count: 2,
          contamination_count: 0,
          calibration_ok: true,
          sync_confidence: 0.9,
        }
      : {
          audio_spike: true,
          sensor_correlation_count: 0,
          media_support: false,
          unattended_room: false,
          blind_reviewer_agreement_count: 0,
          contamination_count: 2,
          calibration_ok: false,
          sync_confidence: 0.35,
        };
  const result = await api("/api/evidence/score", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  $("score").innerHTML = `
    <strong>${result.score}/100 - ${escapeHtml(result.label)}</strong>
    <ul>${result.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
  `;
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!selectedId || pollingInFlight) return;
    pollingInFlight = true;
    try {
      await Promise.all([refreshLive(), refreshEvents(), refreshAnomalies(), refreshReport()]);
    } catch (error) {
      console.warn("Background refresh failed", error);
    } finally {
      pollingInFlight = false;
    }
  }, 1500);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  pollingInFlight = false;
}

/* ---------- Event handlers ---------- */

$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await withElementLoading(event.submitter, "Creating...", async () => {
    const investigation = await api("/api/investigations", {
      method: "POST",
      body: JSON.stringify({
        title: $("title").value,
        location_name: $("location").value,
        notes: $("notes").value,
      }),
    });
    await refreshSessions();
    await selectInvestigation(investigation.id);
    await refreshAppState();
    setView("mission");
    notify("Investigation created");
  });
});

$("start").addEventListener("click", async () => {
  await withButtonLoading("start", "Starting...", async () => {
    await api(`/api/investigations/${selectedId}/start`, { method: "POST" });
    await selectInvestigation(selectedId);
    await refreshAppState();
    notify("Recording started", "success");
  });
});

$("stop").addEventListener("click", async () => {
  await withButtonLoading("stop", "Stopping...", async () => {
    await api(`/api/investigations/${selectedId}/stop`, { method: "POST" });
    await selectInvestigation(selectedId);
    await refreshAppState();
    notify("Recording stopped");
  });
});

$("capture").addEventListener("click", async () => {
  if (!selectedId) return;
  await withButtonLoading("capture", "Capturing...", async () => {
    await api(`/api/investigations/${selectedId}/camera/still`, { method: "POST" });
    await selectInvestigation(selectedId);
    notify("Still image captured", "success");
  });
});

async function exportSelected(buttonId) {
  if (!selectedId) return;
  await withButtonLoading(buttonId, "Preparing...", async () => {
    await refreshMedia();
    await refreshReport();
  });
  window.location.href = `/api/investigations/${selectedId}/export/download`;
}

$("export").addEventListener("click", () => exportSelected("export"));
$("export-panel-button").addEventListener("click", () => exportSelected("export-panel-button"));
const drawerExportBtn = $("drawer-export");
if (drawerExportBtn) drawerExportBtn.addEventListener("click", () => exportSelected("drawer-export"));

$("marker-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedId || !$("marker-title").value.trim()) return;
  await withButtonLoading("marker-button", "Adding...", async () => {
    await api(`/api/investigations/${selectedId}/markers`, {
      method: "POST",
      body: JSON.stringify({
        title: $("marker-title").value,
        description: $("marker-description").value,
      }),
    });
    $("marker-title").value = "";
    $("marker-description").value = "";
    await refreshEvents();
    notify("Marker added", "success");
  });
});

$("contamination-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedId) return;
  await withButtonLoading("contamination-button", "Tagging...", async () => {
    await addContamination($("contamination-type").value, $("contamination-description").value);
    $("contamination-description").value = "";
  });
});

async function addContamination(tagId, description = "") {
  if (!selectedId || !tagId) return;
  await api(`/api/investigations/${selectedId}/contamination`, {
    method: "POST",
    body: JSON.stringify({
      tag_id: tagId,
      description,
    }),
  });
  await refreshEvents();
  await refreshReport();
  notify("Ordinary cause tagged", "success");
}

/* ---------- Observation form ---------- */

const observationForm = $("observation-form");
if (observationForm) {
  observationForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selectedId) {
      notify("Select an investigation first", "error");
      return;
    }
    if (!observationTypesAvailable) {
      notify("Observations are not available yet", "error");
      return;
    }
    const typeSelect = $("observation-type");
    const type = typeSelect ? typeSelect.value : "";
    if (!type) {
      notify("Pick an observation type", "error");
      return;
    }
    const intensity = parseInt($("observation-intensity").value, 10) || 3;
    const title = $("observation-title").value.trim();
    const description = $("observation-description").value.trim();

    await withButtonLoading("observation-button", "Logging...", async () => {
      try {
        await api(`/api/investigations/${selectedId}/observations`, {
          method: "POST",
          body: JSON.stringify({
            observation_type: type,
            intensity,
            title: title || undefined,
            description: description || undefined,
            timestamp: new Date().toISOString(),
          }),
        });
        $("observation-title").value = "";
        $("observation-description").value = "";
        await refreshEvents();
        await refreshReport();
        notify("Observation logged", "success");
      } catch (error) {
        if (error && error.status === 404) {
          observationTypesAvailable = false;
          renderObservationTypeSelects();
          setSelectedControls(Boolean(selectedId));
        }
        throw error;
      }
    });
  });
}

const observationSelect = $("observation-type");
if (observationSelect) {
  observationSelect.addEventListener("change", refreshObservationHelper);
}

const intensitySlider = $("observation-intensity");
if (intensitySlider) {
  intensitySlider.addEventListener("input", () => {
    const valueLabel = $("observation-intensity-value");
    if (valueLabel) valueLabel.textContent = intensitySlider.value;
  });
}

/* ---------- Uploads ---------- */

const uploadAttachToggle = $("upload-attach-observation");
if (uploadAttachToggle) {
  uploadAttachToggle.addEventListener("change", () => {
    const row = $("upload-observation-row");
    if (row) row.classList.toggle("hidden", !uploadAttachToggle.checked);
  });
}

const uploadAudioTrigger = $("upload-audio-trigger");
const uploadPhotoTrigger = $("upload-photo-trigger");
const uploadAudioInput = $("upload-audio-input");
const uploadPhotoInput = $("upload-photo-input");

if (uploadAudioTrigger && uploadAudioInput) {
  uploadAudioTrigger.addEventListener("click", () => {
    if (!selectedId || !uploadsAvailable) return;
    uploadAudioInput.value = "";
    uploadAudioInput.click();
  });
}

if (uploadPhotoTrigger && uploadPhotoInput) {
  uploadPhotoTrigger.addEventListener("click", () => {
    if (!selectedId || !uploadsAvailable) return;
    uploadPhotoInput.value = "";
    uploadPhotoInput.click();
  });
}

if (uploadAudioInput) {
  uploadAudioInput.addEventListener("change", (event) => handleUpload(event, uploadAudioTrigger, "audio"));
}
if (uploadPhotoInput) {
  uploadPhotoInput.addEventListener("change", (event) => handleUpload(event, uploadPhotoTrigger, "photo"));
}

async function handleUpload(event, button, kind) {
  if (!selectedId) return;
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const status = $("upload-status");
  setUploadBusy(button, true, kind === "audio" ? "Uploading audio..." : "Uploading photo...");
  if (status) status.textContent = `Uploading ${file.name}...`;

  const formData = new FormData();
  formData.append("file", file);
  formData.append("timestamp_start", new Date().toISOString());
  if (uploadAttachToggle && uploadAttachToggle.checked) {
    const observationType = $("upload-observation-type") ? $("upload-observation-type").value : "";
    if (observationType) {
      formData.append("create_observation", "true");
      formData.append("observation_type", observationType);
    }
  }

  try {
    const response = await fetch(`/api/investigations/${selectedId}/uploads`, {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      const body = await response.text();
      const error = new Error(formatApiError(body, response.statusText));
      error.status = response.status;
      throw error;
    }
    if (status) status.textContent = `${file.name} uploaded`;
    notify(kind === "audio" ? "Audio uploaded" : "Photo uploaded", "success");
    await Promise.allSettled([refreshMedia(), refreshEvents(), refreshReport()]);
  } catch (error) {
    if (error && error.status === 404) {
      uploadsAvailable = false;
      if (status) status.textContent = "Phone upload endpoint isn't online yet — try again shortly.";
      notify("Phone upload not available yet", "error");
      setSelectedControls(Boolean(selectedId));
    } else {
      if (status) status.textContent = `Upload failed: ${error.message || "unknown error"}`;
      notify(error.message || "Upload failed", "error");
    }
  } finally {
    setUploadBusy(button, false);
    event.target.value = "";
  }
}

$("score-weak").addEventListener("click", () => withButtonLoading("score-weak", "Scoring...", () => scoreEvidence("weak")));
$("score-strong").addEventListener("click", () => withButtonLoading("score-strong", "Scoring...", () => scoreEvidence("strong")));

document.querySelectorAll(".nav-item, .bottom-nav-item").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

/* ---------- Drawer ---------- */

const drawer = $("app-info-drawer");
const drawerToggle = $("drawer-toggle");
const drawerInfoToggle = $("app-info-toggle");

function openDrawer() {
  if (!drawer) return;
  drawer.hidden = false;
  if (drawerToggle) drawerToggle.setAttribute("aria-expanded", "true");
  if (drawerInfoToggle) drawerInfoToggle.setAttribute("aria-expanded", "true");
}

function closeDrawer() {
  if (!drawer) return;
  drawer.hidden = true;
  if (drawerToggle) drawerToggle.setAttribute("aria-expanded", "false");
  if (drawerInfoToggle) drawerInfoToggle.setAttribute("aria-expanded", "false");
}

if (drawerToggle) drawerToggle.addEventListener("click", openDrawer);
if (drawerInfoToggle) drawerInfoToggle.addEventListener("click", openDrawer);
if (drawer) {
  drawer.querySelectorAll("[data-drawer-close]").forEach((node) => {
    node.addEventListener("click", closeDrawer);
  });
}

/* ---------- Mode modal ---------- */

const modeBadge = $("mode-badge");
const modeModal = $("mode-modal");

function openModeModal() {
  if (!modeModal) return;
  modeModal.hidden = false;
}

function closeModeModal() {
  if (!modeModal) return;
  modeModal.hidden = true;
}

if (modeBadge) modeBadge.addEventListener("click", openModeModal);
if (modeModal) {
  modeModal.querySelectorAll("[data-modal-close]").forEach((node) => {
    node.addEventListener("click", closeModeModal);
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (modeModal && !modeModal.hidden) closeModeModal();
  if (drawer && !drawer.hidden) closeDrawer();
});

/* ---------- Initialization ---------- */

async function initializeApp() {
  setSelectedControls(false);
  setView(localStorage.getItem(STORAGE_KEYS.view) || "mission");
  const results = await Promise.allSettled([
    refreshHealth(),
    refreshHardware(),
    refreshAppState(),
    refreshProtocols(),
    refreshContaminationTags(),
    refreshObservationTypes(),
    refreshSessions(),
  ]);

  results
    .filter((result) => result.status === "rejected")
    .forEach((result) => console.warn("Initial refresh failed", result.reason));

  const sessionsResult = results[results.length - 1];
  const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value : [];
  const storedId = localStorage.getItem(STORAGE_KEYS.selectedId);
  if (storedId && sessions.some((session) => session.id === storedId)) {
    await selectInvestigation(storedId);
  } else {
    clearSelectedInvestigation();
  }
}

initializeApp().catch((error) => {
  console.error("App initialization failed", error);
  notify("App initialization failed", "error");
});
