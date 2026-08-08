let selectedDeviceIds = [];
let state = { devices: {}, commands: {} };
let terminalCommandIds = [];

const adminGate = document.getElementById("adminGate");
const adminApp = document.getElementById("adminApp");
const loginStatus = document.getElementById("loginStatus");
const adminLogout = document.getElementById("adminLogout");
const adminTokenInput = document.getElementById("adminToken");
const adminLogin = document.getElementById("adminLogin");
const adminPassword = document.getElementById("adminPassword");
const adminLoginButton = document.getElementById("adminLoginButton");
let adminToken = localStorage.getItem("cpAdminToken") || "";
const adminAuthPage = window.location.pathname.endsWith("admin-auth.html");
const adminDashboardPage = window.location.pathname.endsWith("index.html") || window.location.pathname === "/";
if (adminTokenInput && adminToken) adminTokenInput.value = adminToken;
const devices = document.getElementById("devices");
const log = document.getElementById("log");
const screen = document.getElementById("screen");
const screenText = document.getElementById("screenText");
const liveFrame = document.getElementById("liveFrame");
let liveSocket = null;
let livePollTimer = null;
let liveSocketFallbackTimer = null;
let lastLiveSocketFrameAt = 0;
let liveControlMode = "";
const targetBadge = document.getElementById("targetBadge");
const terminalForm = document.getElementById("terminalForm");
const terminalCommand = document.getElementById("terminalCommand");
const terminalOutput = document.getElementById("terminalOutput");
const focusTerminal = document.getElementById("focusTerminal");
const enrollDevice = document.getElementById("enrollDevice");
const enrollModal = document.getElementById("enrollModal");
const downloadAgent = document.getElementById("downloadAgent");
const browserEnrollOnly = document.getElementById("browserEnrollOnly");
const openAgent = document.getElementById("openAgent");
const enrollInstructions = document.getElementById("enrollInstructions");
const apkUrl = document.getElementById("apkUrl");
const apkFile = document.getElementById("apkFile");
const installApp = document.getElementById("installApp");
const browseFiles = document.getElementById("browseFiles");
const locateDevice = document.getElementById("locateDevice");
const lockDevice = document.getElementById("lockDevice");
const mobileDataOn = document.getElementById("mobileDataOn");
const lostLocate = document.getElementById("lostLocate");
const lostLock = document.getElementById("lostLock");
const lostRing = document.getElementById("lostRing");
const lostDisable = document.getElementById("lostDisable");
const lostMessageForm = document.getElementById("lostMessageForm");
const lostMessage = document.getElementById("lostMessage");
const deviceFiles = document.getElementById("deviceFiles");
const firmwareUrl = document.getElementById("firmwareUrl");
const firmwareUpgrade = document.getElementById("firmwareUpgrade");
const deviceInfoModal = document.getElementById("deviceInfoModal");
const deviceInfoTitle = document.getElementById("deviceInfoTitle");
const deviceInfoContent = document.getElementById("deviceInfoContent");
const refreshDeviceInfo = document.getElementById("refreshDeviceInfo");
let deviceInfoDeviceId = "";
const locationModal = document.getElementById("locationModal");
const locationText = document.getElementById("locationText");
const locationMapLink = document.getElementById("locationMapLink");
const frontCamera = document.getElementById("frontCamera");
const backCamera = document.getElementById("backCamera");
const startRecording = document.getElementById("startRecording");
const stopRecording = document.getElementById("stopRecording");
const saveRecording = document.getElementById("saveRecording");
const recordingStatus = document.getElementById("recordingStatus");
const recordingsList = document.getElementById("recordingsList");
let activeRecordingId = localStorage.getItem("cpActiveRecordingId") || "";
let pendingEnrollmentLink = "";

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text || `HTTP ${response.status}` };
  }
}

async function loginAdmin() {
  const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login: adminLogin.value, password: adminPassword.value }) });
  const body = await readJsonResponse(response);
  if (!response.ok || !body.user || body.user.role !== "admin") throw new Error(body.error || "Admin login failed");
  adminToken = body.token;
  if (adminTokenInput) adminTokenInput.value = adminToken;
  localStorage.setItem("cpAdminToken", adminToken);

  // Wait until the backend confirms the session is available via /api/auth/me
  const start = Date.now();
  const timeoutMs = 5000; // total wait time
  const intervalMs = 250; // retry interval
  while (Date.now() - start < timeoutMs) {
    try {
      const me = await api("/api/auth/me");
      if (me && me.user && me.user.role === "admin") return redirectToAdminDashboard();
    } catch (err) {
      // ignore and retry
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  // If we couldn't confirm the session, clear token and show message instead of redirecting.
  adminToken = "";
  localStorage.removeItem("cpAdminToken");
  if (adminTokenInput) adminTokenInput.value = "";
  throw new Error("Unable to confirm admin session. Please try again.");
}
function redirectToAdminAuth() {
  if (window.location.pathname.endsWith("admin-auth.html")) return;
  window.location.href = "admin-auth.html";
}

function redirectToAdminDashboard() {
  if (window.location.pathname.endsWith("index.html") || window.location.pathname === "/") return;
  window.location.href = "index.html";
}

function showAdminGate(message = "") {
  if (adminGate) adminGate.classList.remove("hidden");
  if (adminApp) adminApp.classList.add("hidden");
  if (loginStatus) loginStatus.textContent = message;
}

function showAdminApp() {
  if (adminGate) adminGate.classList.add("hidden");
  if (adminApp) adminApp.classList.remove("hidden");
  if (loginStatus) loginStatus.textContent = "";
}

function setAdminAuthFlashMessage(message) {
  localStorage.setItem("cpAdminAuthMessage", message);
}

function showAdminAuthFlashMessage() {
  const message = localStorage.getItem("cpAdminAuthMessage");
  if (!message) return;
  showAdminGate(message);
  localStorage.removeItem("cpAdminAuthMessage");
}

async function verifyAdminSession() {
  if (!adminToken) {
    if (adminDashboardPage) {
      setAdminAuthFlashMessage("Please login as admin.");
      return redirectToAdminAuth();
    }
    return showAdminGate("Please login as admin.");
  }

  try {
    const response = await api("/api/auth/me");
    if (!response.user || response.user.role !== "admin") {
      throw new Error("Admin session required");
    }

    if (adminDashboardPage) {
      showAdminApp();
      // Do not let refresh errors log the user out
      try {
        await refresh();
      } catch (refreshError) {
        console.warn("Admin refresh failed:", refreshError);
        if (log) log.textContent = refreshError.message || "Failed to load admin data";
      }
    } else {
      redirectToAdminDashboard();
    }
  } catch (error) {
    adminToken = "";
    localStorage.removeItem("cpAdminToken");
    if (adminTokenInput) adminTokenInput.value = "";
    if (adminDashboardPage) {
      setAdminAuthFlashMessage("Session expired or invalid. Please login again.");
      return redirectToAdminAuth();
    }
    showAdminGate("Session expired or invalid. Please login again.");
  }
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}`, ...(options.headers || {}) }
  });
  const body = await readJsonResponse(response);
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function detectPlatform() {
  const platform = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (/iphone|ipad|ipod|ios|macintosh/.test(platform) && navigator.maxTouchPoints > 1) return "ios";
  if (/android/.test(platform)) return "android";
  return /iphone|ipad|ipod/.test(platform) ? "ios" : "android";
}

async function browserFingerprint() {
  const source = JSON.stringify({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    languages: navigator.languages,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    maxTouchPoints: navigator.maxTouchPoints,
    screen: { width: screen.width, height: screen.height, colorDepth: screen.colorDepth, pixelRatio: window.devicePixelRatio },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  });
  const data = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24).toUpperCase();
}

async function collectBrowserDeviceDetails() {
  const platform = detectPlatform();
  const serial = `WEB-${await browserFingerprint()}`;
  const userAgentData = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(["architecture", "bitness", "model", "platform", "platformVersion", "uaFullVersion"]).catch(() => ({})) : {};
  return {
    platform,
    name: userAgentData.model || `${platform.toUpperCase()} Browser Device`,
    serial,
    ownerConsent: true,
    capabilities: {
      browserEnrollment: true,
      shell: false,
      screenControl: false,
      camera: Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      nativeAgentRequired: true
    },
    info: {
      userAgent: navigator.userAgent,
      browserPlatform: navigator.platform,
      language: navigator.language,
      screen: `${screen.width}x${screen.height}`,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      pixelRatio: window.devicePixelRatio,
      touchPoints: navigator.maxTouchPoints,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      userAgentData
    }
  };
}

async function enrollCurrentDevice() {
  if (!adminToken) throw new Error("Enter Admin Token first, then tap Enroll");
  const details = await collectBrowserDeviceDetails();
  const enrollment = await api("/api/admin/enroll-browser", { method: "POST", body: JSON.stringify(details) });
  selectedDeviceIds = [enrollment.deviceId];
  pendingEnrollmentLink = buildAgentEnrollmentLink(enrollment);
  await refresh();
  screenText.textContent = `${details.name} enrolled. Install Shield Device Agent, then tap Open Agent to approve Device Admin.`;
  return { details, enrollment, enrollmentLink: pendingEnrollmentLink };
}

function buildAgentEnrollmentLink(enrollment) {
  const serverUrl = `${location.protocol}//${location.host}`;
  const params = new URLSearchParams({ serverUrl, deviceId: enrollment.deviceId, token: enrollment.token });
  return `cpdevice://enroll?${params.toString()}`;
}

function selectedDevices() {
  return selectedDeviceIds.map((id) => state.devices[id]).filter(Boolean);
}

function targetDevice() {
  const selected = selectedDevices();
  return selected.length === 1 ? selected[0] : null;
}

function commandGateMessage(device, type) {
  if (!device) return "Select a device first.";
  const capabilities = device.capabilities || {};
  if (capabilities.browserEnrollment && !capabilities.nativeAgent && !capabilities.appleMdm) return "Install the native agent or complete Apple MDM enrollment first.";
  if (device.platform === "android") {
    if (type === "shell" && !capabilities.deviceOwner && !capabilities.oemPrivileged) return "Requires Android Device Owner or OEM/system privileges.";
    if (type === "screen.tap" && !capabilities.accessibility) return "Requires Shield Device Agent Accessibility service.";
    if (["camera.stream.request", "camera.switch"].includes(type) && !capabilities.camera) return "Requires camera permission in the Android agent.";
    if (type === "lock.device" && !capabilities.deviceAdmin && !capabilities.deviceOwner) return "Requires Android Device Admin or Device Owner.";
    if (type === "mobile.data.on" && !capabilities.oemPrivileged) return "Requires OEM/system privileges.";
    if (type === "firmware.update" && !capabilities.deviceOwner && !capabilities.oemPrivileged) return "Requires Device Owner system-update policy or OEM/system updater integration.";
  }
  if (device.platform === "ios") {
    if (!capabilities.appleMdm) return "Requires completed Apple MDM/APNs enrollment.";
    if (type === "locate.device" && !capabilities.supervised) return "Requires supervised iPhone Lost Mode support.";
    if (["firmware.update", "app.install", "app.remove"].includes(type) && !capabilities.supervised) return "Requires a supervised Apple MDM device.";
    if (["shell", "screen.control.request", "camera.stream.request", "camera.switch", "file.list", "file.pull", "mobile.data.on"].includes(type)) return "Not supported by public Apple MDM APIs.";
  }
  return "";
}

function setButtonGate(button, message) {
  button.disabled = Boolean(message);
  button.title = message || "Available for selected device";
}

function refreshCapabilityGates() {
  const target = targetDevice();
  document.querySelectorAll("[data-live-command]").forEach((button) => {
    const type = target && target.platform === "ios" && button.dataset.liveCommand === "screen.control.request" ? "screen.share.request" : button.dataset.liveCommand;
    setButtonGate(button, commandGateMessage(target, type));
  });
  setButtonGate(frontCamera, commandGateMessage(target, "camera.switch"));
  setButtonGate(backCamera, commandGateMessage(target, "camera.switch"));
  setButtonGate(focusTerminal, commandGateMessage(target, "shell"));
  setButtonGate(browseFiles, commandGateMessage(target, "file.list"));
  setButtonGate(installApp, commandGateMessage(target, "app.install"));
  setButtonGate(firmwareUpgrade, commandGateMessage(target, "firmware.update"));
  setButtonGate(locateDevice, commandGateMessage(target, "locate.device"));
  setButtonGate(lockDevice, commandGateMessage(target, "lock.device"));
  setButtonGate(mobileDataOn, commandGateMessage(target, "mobile.data.on"));
  setButtonGate(lostLocate, commandGateMessage(target, "locate.device"));
  setButtonGate(lostLock, commandGateMessage(target, "lock.device"));
  setButtonGate(lostRing, commandGateMessage(target, "lost.ring"));
  setButtonGate(lostDisable, commandGateMessage(target, "lost.disable"));
  if (lostMessageForm) {
    const submit = lostMessageForm.querySelector('button[type="submit"]');
    if (submit) setButtonGate(submit, commandGateMessage(target, "lost.message"));
  }
}
function appendTerminal(message) {
  const current = terminalOutput.textContent.includes("Terminal output will appear") ? "" : terminalOutput.textContent;
  terminalOutput.textContent = `${current}${current ? "\n" : ""}${message}`;
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function renderTerminalResults() {
  const lines = [];
  for (const commandId of terminalCommandIds) {
    const command = state.commands[commandId];
    if (!command) continue;
    lines.push(`$ ${command.payload.command}`);
    for (const [deviceId, result] of Object.entries(command.results || {})) {
      const device = state.devices[deviceId];
      lines.push(`[${device ? device.name : deviceId}] ${result.ok ? "OK" : "ERROR"}`);
      if (result.output !== undefined) lines.push(String(result.output));
      if (result.error) lines.push(result.error);
    }
    if (!Object.keys(command.results || {}).length) lines.push("queued: waiting for device agent...");
  }
  if (lines.length) terminalOutput.textContent = lines.join("\n");
}

function render() {
  const list = Object.values(state.devices).filter((device) => !device.pendingRemoval);
  selectedDeviceIds = selectedDeviceIds.filter((id) => state.devices[id] && !state.devices[id].pendingRemoval);
  devices.innerHTML = list.length ? "" : "<p>No enrolled devices yet.</p>";
  for (const device of list) {
    const card = document.createElement("div");
    card.className = `device-card ${selectedDeviceIds.includes(device.id) ? "active" : ""}`;
    const subtitle = formatDeviceDisplayVersion(device);
    card.innerHTML = `<div class="device-main"><span><strong>${escapeHtml(formatDeviceDisplayName(device))}</strong>${subtitle ? `<small>${escapeHtml(subtitle)}</small>` : ""}</span><i class="status ${device.status}"></i></div>`;
    const controls = document.createElement("div");
    controls.className = "device-controls";
    const selectBtn = document.createElement("button");
    selectBtn.textContent = selectedDeviceIds.includes(device.id) ? "Deselect" : "Select";
    selectBtn.onclick = (e) => {
      e.stopPropagation();
      selectedDeviceIds = selectedDeviceIds.includes(device.id) ? selectedDeviceIds.filter((id) => id !== device.id) : [device.id];
      const target = targetDevice();
      screenText.textContent = target ? `${target.name} selected. Remote desktop/camera/terminal commands will target this device.` : "Select one enrolled device for real-time control";
      render();
    };
    const overrideButton = document.createElement("button");
    overrideButton.textContent = device.subscriptionOverride && device.subscriptionOverride.active ? "Unsubscribe Device" : "Subscribe Device";
    overrideButton.title = device.subscriptionOverride && device.subscriptionOverride.active ? "Remove admin subscription override for this device" : "Grant paid-device access override";
    overrideButton.onclick = async (e) => {
      e.stopPropagation();
      try {
        const active = !(device.subscriptionOverride && device.subscriptionOverride.active);
        await api(`/api/devices/${encodeURIComponent(device.id)}/subscription-override`, {
          method: "POST",
          body: JSON.stringify({ active })
        });
        await refresh();
      } catch (err) { log.textContent = err.message; }
    };
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "Delete";
    del.title = "Permanently remove this device";
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete device ${device.name}? This cannot be undone.`)) return;
      try {
        await api(`/api/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
        selectedDeviceIds = selectedDeviceIds.filter((id) => id !== device.id);
        if (screenText) screenText.textContent = "Device deletion queued. It is hidden from the dashboard while the enrolled agent releases management.";
        await refresh();
      } catch (err) { log.textContent = err.message; }
    };
    controls.appendChild(selectBtn);
    controls.appendChild(overrideButton);
    controls.appendChild(del);
    if (device.subscriptionOverride && device.subscriptionOverride.active) {
      const badge = document.createElement("span");
      badge.className = "device-badge";
      badge.textContent = "Admin override";
      card.appendChild(badge);
    }
    card.appendChild(controls);
    card.onclick = () => openDeviceInfoModal(device.id);
    devices.appendChild(card);
  }
  const target = targetDevice();
  targetBadge.textContent = target ? `${target.name} � ${target.status}` : "No target";
  renderAlerts();
  renderTerminalResults();
  renderDeviceFileBrowser();
  renderLocationResults();
  renderRecordings();
  refreshCapabilityGates();
}

function escapeHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatDeviceDisplayName(device) {
  const info = device.info || {};
  const manufacturer = (info.manufacturer || "").trim();
  const model = (info.model || "").trim();
  const name = device.name || "";
  const candidate = `${manufacturer} ${model}`.trim();
  return candidate || name || device.serial || device.id;
}

function formatDeviceDisplayVersion(device) {
  const info = device.info || {};
  if (info.androidVersion) return `Android ${info.androidVersion}`;
  if (info.iosVersion) return `iPhone ${info.iosVersion}`;
  if (info.systemVersion) return info.systemVersion;
  if (device.version) return device.version;
  return device.platform ? device.platform.charAt(0).toUpperCase() + device.platform.slice(1) : "Device";
}


function latestDeviceInfo(device) {
  const refreshCommand = Object.values(state.commands || {})
    .filter((command) => command.type === "device.info.refresh" && command.deviceIds.includes(device.id) && command.results && command.results[device.id])
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  const output = refreshCommand && refreshCommand.results[device.id] && refreshCommand.results[device.id].output;
  return { ...(device.deviceDetails || {}), ...(output && typeof output === "object" ? output : {}) };
}

function infoValueHtml(value) {
  if (Array.isArray(value)) {
    if (!value.length) return '<span class="muted">Unavailable</span>';
    return `<ul class="info-list">${value.map((item) => `<li>${infoValueHtml(item)}</li>`).join("")}</ul>`;
  }
  if (value && typeof value === "object") {
    return `<div class="info-grid">${Object.entries(value).map(([key, inner]) => `<div class="info-row"><b>${escapeHtml(labelize(key))}</b><span>${infoValueHtml(inner)}</span></div>`).join("")}</div>`;
  }
  return escapeHtml(value || "Unavailable");
}

function labelize(key) {
  return String(key || "").replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}

function renderDeviceInfoModal(device) {
  if (!deviceInfoContent) return;
  const details = latestDeviceInfo(device);
  const rows = {
    "IMEI": details.imei,
    "MAC Addresses": details.macAddresses,
    "SIM Cards": details.simCards,
    "Phone Numbers": details.phoneNumbers,
    "Last 5 Call Logs": details.lastCallLogs,
    "Updated At": details.updatedAt || details.collectedAt,
    "Factory Reset Blocked In Settings": device.operation && device.operation.factoryResetBlockedInSettings ? "Yes" : "No � requires Device Owner",
    "Recovery Mode Factory Reset": "Cannot be guaranteed blocked by a normal APK; requires OEM/enterprise FRP support"
  };
  deviceInfoContent.innerHTML = `<div class="info-grid">${Object.entries(rows).map(([key, value]) => `<div class="info-row"><b>${escapeHtml(key)}</b><span>${infoValueHtml(value)}</span></div>`).join("")}</div>`;
}

function openDeviceInfoModal(deviceId) {
  const device = state.devices[deviceId];
  if (!device || !deviceInfoModal) return;
  deviceInfoDeviceId = deviceId;
  if (deviceInfoTitle) deviceInfoTitle.textContent = `${formatDeviceDisplayName(device)} Info`;
  renderDeviceInfoModal(device);
  if (typeof deviceInfoModal.showModal === "function" && !deviceInfoModal.open) deviceInfoModal.showModal();
}

async function refreshSelectedDeviceInfo() {
  const device = state.devices[deviceInfoDeviceId];
  if (!device) throw new Error("Select a device first");
  await createCommand([device.id], "device.info.refresh", { requestedAt: new Date().toISOString() });
  if (deviceInfoContent) deviceInfoContent.innerHTML = '<p class="modal-note">Refresh queued. Waiting for the enrolled device agent...</p>';
  setTimeout(refresh, 1200);
}
function friendlyCommandLabel(type) {
  const map = {
    "locate.device": "Locate device",
    "file.list": "Browse files",
    "file.pull": "Export file",
    "screen.control.request": "Start remote screen",
    "camera.stream.request": "Start live camera",
    "camera.switch": "Switch camera",
    "lock.device": "Lock device",
    "lost.ring": "Lost Mode ring",
    "lost.message": "Lost Mode message",
    "lost.disable": "Disable live sessions",
    "mobile.data.on": "Turn on mobile data",
    "device.info.refresh": "Refresh device info",
    "shell": "Execute shell command",
    "app.install": "Install app",
    "firmware.update": "Firmware update"
  };
  return map[type] || type.replace(/\./g, " ");
}

function renderCommandResultText(command, result) {
  if (!result) return "Queued: waiting for device agent...";
  if (result.error) return `Failed: ${String(result.error)}`;
  if (command.type === "locate.device") {
    const loc = typeof result.output === "object" ? result.output : null;
    if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) return `Location found: ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}${loc.accuracy ? ` (±${Math.round(loc.accuracy)}m)` : ""}`;
  }
  if (command.type === "file.list") {
    if (result.files && Array.isArray(result.files)) return `Listed ${result.files.length} items.`;
    const listed = typeof result.output === "object" ? result.output : null;
    if (listed && Array.isArray(listed.files)) return `Listed ${listed.files.length} items.`;
    return "File list available.";
  }
  if (command.type === "file.pull") {
    if (result.files && Array.isArray(result.files)) return `Exported ${result.files.length} file(s).`;
    if (result.output && typeof result.output === "string") return result.output;
    return "File export completed.";
  }
  if (command.type === "screen.control.request" || command.type === "camera.stream.request") {
    return result.ok ? "Live session started." : "Live session requested.";
  }
  if (command.type === "lock.device") return result.ok ? "Lock command sent." : "Lock command requested.";
  if (["lost.ring", "lost.message", "lost.disable"].includes(command.type)) return result.output && typeof result.output === "string" ? result.output : "Lost Mode command completed.";
  if (command.type === "mobile.data.on") return result.ok ? "Mobile data toggle requested." : "Mobile data request queued.";
  if (result.output && typeof result.output === "string") return result.output;
  if (result.output && typeof result.output === "object") {
    const keys = Object.keys(result.output);
    if (keys.length) return `Result: ${keys.join(", ")}`;
  }
  return result.ok ? "Command completed." : "Command returned result.";
}

function openFilesForCommand(commandId, deviceId) {
  selectedDeviceIds = [deviceId];
  render();
  renderDeviceFileBrowser(commandId);
  const modal = document.getElementById("deviceFilesModal");
  if (modal && typeof modal.showModal === "function" && !modal.open) modal.showModal();
}

function renderAlerts() {
  const commands = Object.values(state.commands || {});
  if (!commands.length) { log.innerHTML = '<p>No operations yet.</p>'; return; }
  const sorted = commands.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  log.innerHTML = "";
  for (const command of sorted) {
    for (const deviceId of command.deviceIds || []) {
      const device = state.devices[deviceId] || { id: deviceId, name: deviceId };
      const result = command.results && command.results[deviceId];
      const item = document.createElement("div");
      item.className = "alert-item";
      const title = document.createElement("div");
      title.className = "alert-title";
      title.textContent = `${formatDeviceDisplayName(device)} — ${friendlyCommandLabel(command.type)}`;
      item.appendChild(title);
      const detail = document.createElement("div");
      detail.className = "alert-detail";
      if (!result) {
        detail.textContent = "Queued: waiting for device agent...";
      } else {
        detail.textContent = renderCommandResultText(command, result);
      }
      item.appendChild(detail);
      if (command.type === "file.list" && result) {
        const actions = document.createElement("div");
        actions.className = "alert-actions";
        const browseBtn = document.createElement("button");
        browseBtn.textContent = "Browse files";
        browseBtn.onclick = () => openFilesForCommand(command.id, deviceId);
        actions.appendChild(browseBtn);
        item.appendChild(actions);
      }
      if (command.type === "locate.device" && result && result.output && typeof result.output === "object") {
        const loc = result.output;
        if (Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
          const mapLink = document.createElement("a");
          mapLink.href = `https://www.google.com/maps?q=${encodeURIComponent(`${loc.lat},${loc.lng}`)}`;
          mapLink.target = "_blank";
          mapLink.rel = "noopener";
          mapLink.textContent = "View location";
          mapLink.className = "alert-link";
          item.appendChild(mapLink);
        }
      }
      log.appendChild(item);
    }
  }
}

const deviceFilesModal = document.getElementById("deviceFilesModal");
const deviceFilesContent = document.getElementById("deviceFilesContent");

async function refresh() {
  if (!adminToken) return;
  state = await api("/api/state");
  render();
}

async function uploadFile(file) {
  const response = await fetch("/api/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": file.type || "application/octet-stream", "X-File-Name": file.name },
    body: await file.arrayBuffer()
  });
  const body = await readJsonResponse(response);
  if (!response.ok) throw new Error(body.error || "Upload failed");
  return body;
}

async function installSelectedApp() {
  const target = targetDevice();
  if (!target) throw new Error("Select exactly one Android device");
  let payload = { requestedAt: new Date().toISOString() };
  if (apkFile.files[0]) {
    const uploaded = await uploadFile(apkFile.files[0]);
    payload.fileId = uploaded.id;
    payload.apkUrl = `${location.protocol}//${location.host}/api/files/${uploaded.id}`;
    payload.fileName = uploaded.name;
  } else if (apkUrl.value.trim()) {
    payload.apkUrl = apkUrl.value.trim();
  } else {
    throw new Error("Provide APK URL or upload APK file");
  }
  await createCommand([target.id], "app.install", payload);
  await refresh();
}

async function browseDeviceFiles() {
  const target = targetDevice();
  if (!target) throw new Error("Select exactly one Android device");
  const command = await createCommand([target.id], "file.list", { path: "/sdcard", requestedAt: new Date().toISOString() });
  const modal = deviceFilesModal || document.getElementById("deviceFilesModal");
  const content = deviceFilesContent || document.getElementById("deviceFilesContent");
  if (content) content.innerHTML = `<p>Browse requested. Waiting for ${escapeHtml(formatDeviceDisplayName(target))}...</p>`;
  if (modal && typeof modal.showModal === "function" && !modal.open) modal.showModal();
  await pollAdminFileCommand(command.id, target.id, `Browsing /sdcard on ${formatDeviceDisplayName(target)}...`);
  renderDeviceFileBrowser(command.id);
  return command;
}

function parseLocationOutput(output) {
  try {
    const parsed = typeof output === "string" ? JSON.parse(output) : output;
    if (Number.isFinite(parsed.lat) && Number.isFinite(parsed.lng)) return parsed;
  } catch {}
  return null;
}

function showLocationModal(location, deviceName) {
  const link = `https://www.google.com/maps?q=${encodeURIComponent(`${location.lat},${location.lng}`)}`;
  locationText.textContent = `${deviceName}: ${location.lat}, ${location.lng}${location.accuracy ? ` - accuracy ${Math.round(location.accuracy)}m` : ""}`;
  locationMapLink.href = link;
  locationMapLink.textContent = link;
  locationModal.showModal();
}

function renderLocationResults() {
  const target = targetDevice();
  if (!target || !locationModal) return;
  const locateCommands = Object.values(state.commands || {}).filter((command) => command.type === "locate.device" && command.deviceIds.includes(target.id));
  const latest = locateCommands[locateCommands.length - 1];
  const result = latest && latest.results && latest.results[target.id];
  const location = result && parseLocationOutput(result.output);
  if (location && latest.id !== locationModal.dataset.commandId) {
    locationModal.dataset.commandId = latest.id;
    showLocationModal(location, target.name);
  }
}

function parseFileListResult(result) {
  if (!result) return null;
  if (Array.isArray(result.files)) return result;
  if (result.output && typeof result.output === "object") return result.output;
  if (typeof result.output === "string") {
    try { return JSON.parse(result.output); } catch { return null; }
  }
  return null;
}

function renderExportedFiles(target, content) {
  const exported = Object.values(state.files || {}).filter((file) => file.sourceDeviceId === target.id);
  for (const file of exported) {
    const row = document.createElement("div");
    row.className = "file-row";
    const type = file.contentType || "application/octet-stream";
    row.innerHTML = `<span><strong>${escapeHtml(file.name)}</strong><small>exported - ${escapeHtml(type)} - ${file.size} bytes</small></span><a href="/api/files/${encodeURIComponent(file.id)}" target="_blank" rel="noopener">View / Download</a>`;
    content.appendChild(row);
  }
}

async function pollAdminFileCommand(commandId, deviceId, statusText) {
  const content = deviceFilesContent || deviceFiles;
  if (content && statusText) content.innerHTML = `<p>${escapeHtml(statusText)}</p>`;
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await refresh();
    const command = state.commands && state.commands[commandId];
    const result = command && command.results && command.results[deviceId];
    if (result) return result;
  }
  if (content) content.innerHTML = "<p>Still waiting for the enrolled device agent. Try again if the device is offline.</p>";
  return null;
}

function renderDeviceFileBrowser(commandId = "") {
  const target = targetDevice();
  const content = deviceFilesContent || deviceFiles;
  if (!target || !content) return;
  let command = commandId && state.commands ? state.commands[commandId] : null;
  if (!command) {
    const fileListCommands = Object.values(state.commands || {}).filter((item) => item.type === "file.list" && item.deviceIds.includes(target.id));
    command = [...fileListCommands].reverse().find((item) => item.results && item.results[target.id]);
  }
  const result = command && command.results && command.results[target.id];
  const listed = parseFileListResult(result);
  content.innerHTML = "";
  if (!listed || !Array.isArray(listed.files)) {
    content.innerHTML = "<p>No file list is ready yet. Waiting for the enrolled device agent...</p>";
    renderExportedFiles(target, content);
    return;
  }
  const currentPath = command && command.payload && command.payload.path ? command.payload.path : "/sdcard";
  const heading = document.createElement("p");
  heading.className = "modal-note";
  heading.textContent = `Browsing ${currentPath} on ${formatDeviceDisplayName(target)}`;
  content.appendChild(heading);
  for (const file of listed.files) {
    const row = document.createElement("div");
    row.className = "file-row";
    const type = file.directory ? "folder" : (file.contentType || "file");
    row.innerHTML = `<span><strong>${escapeHtml(file.name || file.path || "Item")}</strong><small>${escapeHtml(file.path || "")} - ${escapeHtml(type)}${file.directory ? "" : ` - ${file.size || 0} bytes`}</small></span>`;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = file.directory ? "Open" : "Export";
    button.onclick = async () => {
      const commandType = file.directory ? "file.list" : "file.pull";
      const queued = await createCommand([target.id], commandType, { path: file.path, requestedAt: new Date().toISOString() });
      const result = await pollAdminFileCommand(queued.id, target.id, file.directory ? `Opening ${file.path}...` : `Exporting ${file.path}...`);
      if (commandType === "file.list" && result) renderDeviceFileBrowser(queued.id);
      if (commandType === "file.pull") { await refresh(); renderDeviceFileBrowser(command && command.id); }
    };
    row.appendChild(button);
    content.appendChild(row);
  }
  renderExportedFiles(target, content);
}

function renderRecordings() {
  if (!recordingsList) return;
  const recordings = Object.values(state.recordings || {}).sort((a, b) => new Date(b.createdAt || b.updatedAt || 0) - new Date(a.createdAt || a.updatedAt || 0));
  recordingsList.innerHTML = recordings.length ? "" : '<p>No saved recordings yet.</p>';
  for (const recording of recordings) {
    const row = document.createElement("div");
    row.className = "file-row";
    const device = state.devices && state.devices[recording.deviceId];
    const label = recording.name || `${device ? formatDeviceDisplayName(device) : recording.deviceId || "Device"} recording`;
    row.innerHTML = `<span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(recording.status || "recording")} � ${recording.frameCount || 0} frames � ${recording.size || 0} bytes</small></span>`;
    const actions = document.createElement("span");
    actions.className = "device-controls";
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "Download";
    download.onclick = () => downloadRecording(recording.id);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "Delete";
    del.onclick = () => deleteRecording(recording.id).catch((error) => (log.textContent = error.message));
    actions.appendChild(download);
    actions.appendChild(del);
    row.appendChild(actions);
    recordingsList.appendChild(row);
  }
}

async function startLiveRecording() {
  const target = targetDevice();
  if (!target) throw new Error("Select exactly one target device before recording");
  const body = await api("/api/recordings/start", { method: "POST", body: JSON.stringify({ deviceId: target.id }) });
  activeRecordingId = body.recording && body.recording.id;
  if (activeRecordingId) localStorage.setItem("cpActiveRecordingId", activeRecordingId);
  if (recordingStatus) recordingStatus.textContent = `Recording ${formatDeviceDisplayName(target)}...`;
  await refresh();
}

async function stopLiveRecording() {
  if (!activeRecordingId) throw new Error("No active recording to stop");
  const body = await api(`/api/recordings/${encodeURIComponent(activeRecordingId)}/stop`, { method: "POST", body: "{}" });
  if (recordingStatus) recordingStatus.textContent = `Recording stopped: ${body.recording ? body.recording.id : activeRecordingId}`;
  await refresh();
}

async function saveLiveRecording() {
  if (!activeRecordingId) throw new Error("No active recording to save");
  const body = await api(`/api/recordings/${encodeURIComponent(activeRecordingId)}/save`, { method: "POST", body: "{}" });
  localStorage.removeItem("cpActiveRecordingId");
  activeRecordingId = "";
  if (recordingStatus) recordingStatus.textContent = body.github && body.github.skipped ? `Saved locally: ${body.github.reason}` : "Recording saved.";
  await refresh();
}

async function downloadRecording(recordingId) {
  const response = await fetch(`/api/recordings/${encodeURIComponent(recordingId)}/download`, { headers: { Authorization: `Bearer ${adminToken}` } });
  if (!response.ok) {
    const body = await readJsonResponse(response);
    throw new Error(body.error || "Recording download failed");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${recordingId}.mjpeg`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function deleteRecording(recordingId) {
  if (!confirm("Delete this recording permanently?")) return;
  await api(`/api/recordings/${encodeURIComponent(recordingId)}`, { method: "DELETE" });
  if (activeRecordingId === recordingId) {
    activeRecordingId = "";
    localStorage.removeItem("cpActiveRecordingId");
  }
  await refresh();
}
async function createCommand(deviceIds, type, payload) {
  return api("/api/commands", { method: "POST", body: JSON.stringify({ deviceIds, type, payload }) });
}

async function sendLostModeCommand(type, payload = {}) {
  const target = targetDevice();
  if (!target) throw new Error("Select exactly one target device for Lost Mode");
  const body = { requestedAt: new Date().toISOString(), mode: "lost-mode", ...payload };
  const command = await createCommand([target.id], type, body);
  if (log) log.textContent = friendlyCommandLabel(type) + " queued for " + formatDeviceDisplayName(target) + ".";
  await refresh();
  return command;
}

async function sendCommand(type) {
  if (!selectedDeviceIds.length) throw new Error("Select at least one device");
  const payloadText = document.getElementById("payload").value.trim();
  const payload = payloadText ? JSON.parse(payloadText) : {};
  await createCommand(selectedDeviceIds, type, payload);
  await refresh();
}

async function sendTerminalCommand(commandText) {
  const target = targetDevice();
  if (!target) throw new Error("Select exactly one target device for remote terminal control");
  if (target.platform !== "android") throw new Error("Remote shell is only available for Android managed agents. iOS uses MDM commands, not shell.");
  if (!commandText.trim()) throw new Error("Enter a command to send");
  const command = await createCommand([target.id], "shell", { command: commandText.trim(), requestedAt: new Date().toISOString() });
  terminalCommandIds.push(command.id);
  appendTerminal(`$ ${commandText.trim()}\nqueued: waiting for ${target.name} agent...`);
  terminalCommand.value = "";
  await refresh();
}


async function fetchLiveFrame(deviceId) {
  const response = await fetch(`/api/live/${encodeURIComponent(deviceId)}/frame?t=${Date.now()}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    cache: "no-store"
  });
  if (!response.ok) throw new Error(response.status === 404 ? "No live frame yet. Start Live Screen in the Android agent, or Start Live Camera from the dashboard after camera permission is allowed." : "Live frame unavailable");
  const blob = await response.blob();
  const previous = liveFrame.src;
  liveFrame.src = URL.createObjectURL(blob);
  screen.classList.add("streaming");
  screenText.textContent = "";
  if (previous.startsWith("blob:")) URL.revokeObjectURL(previous);
}

function liveTapPayload(event, imageElement) {
  if (!imageElement || !imageElement.naturalWidth || !imageElement.naturalHeight) return null;
  const rect = imageElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const xRatio = (event.clientX - rect.left) / rect.width;
  const yRatio = (event.clientY - rect.top) / rect.height;
  if (xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) return null;
  return {
    x: Math.round(xRatio * imageElement.naturalWidth),
    y: Math.round(yRatio * imageElement.naturalHeight),
    xRatio: Number(xRatio.toFixed(6)),
    yRatio: Number(yRatio.toFixed(6)),
    frameWidth: imageElement.naturalWidth,
    frameHeight: imageElement.naturalHeight,
    requestedAt: new Date().toISOString()
  };
}

function startLivePolling(deviceId, intervalMs = 350) {
  if (livePollTimer) clearInterval(livePollTimer);
  const poll = () => fetchLiveFrame(deviceId).catch((error) => {
    if (!screen.classList.contains("streaming")) screenText.textContent = error.message;
  });
  poll();
  livePollTimer = setInterval(poll, intervalMs);
}

function startLiveFallbackPolling(deviceId) {
  if (!livePollTimer) startLivePolling(deviceId, 350);
}

function openLiveViewer(deviceId, mode = "screen") {
  liveControlMode = mode;
  if (liveSocket) liveSocket.close();
  if (livePollTimer) clearInterval(livePollTimer);
  if (liveSocketFallbackTimer) clearTimeout(liveSocketFallbackTimer);
  livePollTimer = null;
  liveSocketFallbackTimer = null;
  lastLiveSocketFrameAt = 0;
  if (location.hostname.endsWith("vercel.app")) {
    startLivePolling(deviceId, 350);
    return;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  liveSocket = new WebSocket(`${protocol}//${location.host}/ws/live?deviceId=${encodeURIComponent(deviceId)}&adminToken=${encodeURIComponent(adminToken)}`);
  liveSocket.binaryType = "blob";
  liveSocket.onopen = () => {
    if (livePollTimer) clearInterval(livePollTimer);
    livePollTimer = null;
  };
  liveSocket.onmessage = (event) => {
    lastLiveSocketFrameAt = Date.now();
    const previous = liveFrame.src;
    liveFrame.src = URL.createObjectURL(event.data);
    screen.classList.add("streaming");
    screenText.textContent = mode === "camera" ? "Live camera stream active." : "Live screen stream active. Click on the preview to send taps.";
    if (previous.startsWith("blob:")) URL.revokeObjectURL(previous);
  };
  liveSocket.onerror = () => {
    startLiveFallbackPolling(deviceId);
    if (screenText) screenText.textContent = "Live websocket unavailable; retrying with frame polling.";
  };
  liveSocket.onclose = () => startLiveFallbackPolling(deviceId);
  liveSocketFallbackTimer = setTimeout(() => {
    if (!lastLiveSocketFrameAt) startLiveFallbackPolling(deviceId);
  }, 1200);
}

if (screen) {
  screen.addEventListener("pointerdown", (event) => {
    const target = targetDevice();
    if (!target || !screen.classList.contains("streaming") || liveControlMode !== "screen") return;
    const payload = liveTapPayload(event, liveFrame);
    if (!payload) return;
    event.preventDefault();
    createCommand([target.id], "screen.tap", payload).catch((error) => (log.textContent = error.message));
  });
}
async function sendLiveControl(type, options = {}) {
  const target = targetDevice();
  if (!target) throw new Error("Select exactly one target device for live control");
  const commandType = target.platform === "ios" && type === "screen.control.request" ? "screen.share.request" : type;
  const payload = { requestedAt: new Date().toISOString(), mode: "admin-control-session" };
  if (commandType === "camera.stream.request") payload.facing = options.facing || "back";
  await createCommand([target.id], commandType, payload);
  if (["screen.control.request", "camera.stream.request"].includes(commandType)) openLiveViewer(target.id, commandType === "camera.stream.request" ? "camera" : "screen");
  if (screenText) {
    screenText.textContent = commandType === "screen.control.request" ? `Live viewer opened for ${target.name}. If no frame appears, tap Start Live Screen inside the Android agent to approve screen capture.` : `${payload.facing === "front" ? "Front" : "Back"} camera stream requested for ${target.name}. Camera view is read-only; screen taps are disabled in camera mode.`;
  }
  await refresh();
}

async function switchCamera(facing) {
  const target = targetDevice();
  if (!target) throw new Error("Select exactly one target device for camera switching");
  const normalizedFacing = facing === "front" ? "front" : "back";
  await createCommand([target.id], "camera.switch", { facing: normalizedFacing, requestedAt: new Date().toISOString(), mode: "admin-control-session" });
  openLiveViewer(target.id, "camera");
  if (screenText) screenText.textContent = `${normalizedFacing === "front" ? "Front" : "Back"} camera switch requested for ${target.name}.`;
  await refresh();
}

if (terminalForm && terminalCommand) {
  terminalForm.addEventListener("submit", (event) => {
    event.preventDefault();
    sendTerminalCommand(terminalCommand.value).catch((error) => appendTerminal(`ERROR: ${error.message}`));
  });
}

if (focusTerminal && terminalCommand) {
  focusTerminal.addEventListener("click", () => terminalCommand.focus());
}

if (enrollDevice) {
  enrollDevice.addEventListener("click", () => {
    if (enrollInstructions) {
      enrollInstructions.textContent = "Click Download to install Shield Device Agent. After Android installs it, provision Shield Device Agent as Android Device Owner for theft-resistant protection, then open the agent to finish permissions.";
    }
    if (enrollModal) enrollModal.showModal();
  });
}

if (browserEnrollOnly && enrollModal) {
  browserEnrollOnly.addEventListener("click", () => {
    enrollModal.close();
    enrollCurrentDevice().catch((error) => (log.textContent = error.message));
  });
}

if (downloadAgent) {
  downloadAgent.addEventListener("click", async () => {
    if (!adminToken) {
      log.textContent = "Enter Admin Token first, then tap Enroll > Download";
      return;
    }
    const { details } = await enrollCurrentDevice();
    const downloadUrl = details.platform === "ios" ? "/api/enrollment/ios-profile" : "/api/enrollment/android-agent";
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = details.platform === "ios" ? "cp-device-enrollment.mobileconfig" : "cp-device-agent.apk";
    document.body.appendChild(link);
    link.click();
    link.remove();
    if (enrollInstructions) {
      enrollInstructions.textContent = details.platform === "android"
        ? "After Android installs Shield Device Agent, provision it as Android Device Owner for theft-resistant protection, then tap Open Agent to finish enrollment and permissions."
        : "Install the downloaded iOS profile in Settings to complete MDM enrollment.";
    }
  });
}

if (openAgent) {
  openAgent.addEventListener("click", () => {
    if (!pendingEnrollmentLink) {
      log.textContent = "Download/enroll the device first, then tap Open Agent.";
      return;
    }
    location.href = pendingEnrollmentLink;
  });
}

if (installApp) installApp.addEventListener("click", () => installSelectedApp().catch((error) => (log.textContent = error.message)));
if (browseFiles) browseFiles.addEventListener("click", () => browseDeviceFiles().catch((error) => (log.textContent = error.message)));
if (locateDevice) {
  locateDevice.addEventListener("click", async () => {
    const target = targetDevice();
    if (!target) return (log.textContent = "Select exactly one target device");
    await createCommand([target.id], "locate.device", { requestedAt: new Date().toISOString() });
    await refresh();
  });
}
if (lockDevice) {
  lockDevice.addEventListener("click", async () => {
    const target = targetDevice();
    if (!target) return (log.textContent = "Select exactly one target device");
    await createCommand([target.id], "lock.device", { requestedAt: new Date().toISOString() });
    await refresh();
  });
}
if (lostLocate) lostLocate.addEventListener("click", () => sendLostModeCommand("locate.device").catch((error) => (log.textContent = error.message)));
if (lostLock) lostLock.addEventListener("click", () => sendLostModeCommand("lock.device").catch((error) => (log.textContent = error.message)));
if (lostRing) lostRing.addEventListener("click", () => sendLostModeCommand("lost.ring").catch((error) => (log.textContent = error.message)));
if (lostDisable) lostDisable.addEventListener("click", () => sendLostModeCommand("lost.disable").catch((error) => (log.textContent = error.message)));
if (lostMessageForm) {
  lostMessageForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = lostMessage && lostMessage.value.trim() ? lostMessage.value.trim() : "This device is lost. Please contact the owner.";
    sendLostModeCommand("lost.message", { message }).catch((error) => (log.textContent = error.message));
  });
}
if (frontCamera) frontCamera.addEventListener("click", () => switchCamera("front").catch((error) => (log.textContent = error.message)));
if (backCamera) backCamera.addEventListener("click", () => switchCamera("back").catch((error) => (log.textContent = error.message)));
if (startRecording) startRecording.addEventListener("click", () => startLiveRecording().catch((error) => (log.textContent = error.message)));
if (stopRecording) stopRecording.addEventListener("click", () => stopLiveRecording().catch((error) => (log.textContent = error.message)));
if (saveRecording) saveRecording.addEventListener("click", () => saveLiveRecording().catch((error) => (log.textContent = error.message)));

if (mobileDataOn) {
  mobileDataOn.addEventListener("click", async () => {
    const target = targetDevice();
    if (!target) return (log.textContent = "Select exactly one target device");
    await createCommand([target.id], "mobile.data.on", { requestedAt: new Date().toISOString() });
    await refresh();
  });
}
if (firmwareUpgrade) {
  firmwareUpgrade.addEventListener("click", async () => {
    const target = targetDevice();
    if (!target) return (log.textContent = "Select exactly one Android device");
    if (!firmwareUrl.value.trim()) return (log.textContent = "Enter firmware/OEM update URL");
    await createCommand([target.id], "firmware.update", { updateUrl: firmwareUrl.value.trim(), requestedAt: new Date().toISOString() });
    await refresh();
  });
}

const liveCommandButtons = document.querySelectorAll("[data-live-command]");
if (liveCommandButtons.length) {
  liveCommandButtons.forEach((button) => {
    button.addEventListener("click", () => sendLiveControl(button.dataset.liveCommand, { facing: button.dataset.cameraFacing }).catch((error) => (log.textContent = error.message)));
  });
}

if (adminLoginButton) {
  adminLoginButton.addEventListener("click", () => loginAdmin().catch((error) => showAdminGate(error.message)));
}
if (adminLogout) {
  adminLogout.addEventListener("click", async () => {
    const token = adminToken;
    adminToken = "";
    localStorage.removeItem("cpAdminToken");
    state = { devices: {}, commands: {} };
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    } catch { }
    setAdminAuthFlashMessage("Logged out.");
    redirectToAdminAuth();
  });
}
showAdminAuthFlashMessage();
verifyAdminSession();
setInterval(() => refresh().catch(() => {}), 2000);










if (refreshDeviceInfo) {
  refreshDeviceInfo.addEventListener("click", () => refreshSelectedDeviceInfo().catch((error) => { if (log) log.textContent = error.message; }));
}
