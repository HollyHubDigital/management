let selectedDeviceIds = [];
let state = { devices: {}, commands: {} };
let terminalCommandIds = [];

const adminGate = document.getElementById("adminGate");
const adminApp = document.getElementById("adminApp");
const loginStatus = document.getElementById("loginStatus");
const adminLogout = document.getElementById("adminLogout");
const adminToken = document.getElementById("adminToken");
const adminLogin = document.getElementById("adminLogin");
const adminPassword = document.getElementById("adminPassword");
const adminLoginButton = document.getElementById("adminLoginButton");
const devices = document.getElementById("devices");
const log = document.getElementById("log");
const screen = document.getElementById("screen");
const screenText = document.getElementById("screenText");
const liveFrame = document.getElementById("liveFrame");
let liveSocket = null;
let livePollTimer = null;
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
const deviceFiles = document.getElementById("deviceFiles");
const firmwareUrl = document.getElementById("firmwareUrl");
const firmwareUpgrade = document.getElementById("firmwareUpgrade");
const locationModal = document.getElementById("locationModal");
const locationText = document.getElementById("locationText");
const locationMapLink = document.getElementById("locationMapLink");
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
  adminToken.value = body.token;
  sessionStorage.setItem("cpAdminToken", body.token);
  showAdminApp();
  await refresh();
}
function showAdminGate(message = "") {
  adminGate.classList.remove("hidden");
  adminApp.classList.add("hidden");
  loginStatus.textContent = message;
}

function showAdminApp() {
  adminGate.classList.add("hidden");
  adminApp.classList.remove("hidden");
  loginStatus.textContent = "";
}

async function verifyAdminSession() {
  if (!adminToken.value) return showAdminGate();
  try {
    const response = await api("/api/auth/me");
    if (!response.user || response.user.role !== "admin") throw new Error("Admin session required");
    showAdminApp();
    await refresh();
  } catch {
    adminToken.value = "";
    sessionStorage.removeItem("cpAdminToken");
    showAdminGate("Please login as admin.");
  }
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken.value}`, ...(options.headers || {}) }
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
  if (!adminToken.value) throw new Error("Enter Admin Token first, then tap Enroll");
  const details = await collectBrowserDeviceDetails();
  const enrollment = await api("/api/admin/enroll-browser", { method: "POST", body: JSON.stringify(details) });
  selectedDeviceIds = [enrollment.deviceId];
  pendingEnrollmentLink = buildAgentEnrollmentLink(enrollment);
  await refresh();
  screenText.textContent = `${details.name} enrolled. Install CP DEVICE Agent, then tap Open Agent to approve Device Admin.`;
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
    if (type === "screen.tap" && !capabilities.accessibility) return "Requires CP DEVICE Accessibility service.";
    if (type === "camera.stream.request" && !capabilities.camera) return "Requires camera permission in the Android agent.";
    if (type === "lock.device" && !capabilities.deviceAdmin && !capabilities.deviceOwner) return "Requires Android Device Admin or Device Owner.";
    if (type === "mobile.data.on" && !capabilities.oemPrivileged) return "Requires OEM/system privileges.";
    if (type === "firmware.update" && !capabilities.deviceOwner && !capabilities.oemPrivileged) return "Requires Device Owner system-update policy or OEM/system updater integration.";
  }
  if (device.platform === "ios") {
    if (!capabilities.appleMdm) return "Requires completed Apple MDM/APNs enrollment.";
    if (type === "locate.device" && !capabilities.supervised) return "Requires supervised iPhone Lost Mode support.";
    if (["firmware.update", "app.install", "app.remove"].includes(type) && !capabilities.supervised) return "Requires a supervised Apple MDM device.";
    if (["shell", "screen.control.request", "camera.stream.request", "file.list", "file.pull", "mobile.data.on"].includes(type)) return "Not supported by public Apple MDM APIs.";
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
  setButtonGate(focusTerminal, commandGateMessage(target, "shell"));
  setButtonGate(browseFiles, commandGateMessage(target, "file.list"));
  setButtonGate(installApp, commandGateMessage(target, "app.install"));
  setButtonGate(firmwareUpgrade, commandGateMessage(target, "firmware.update"));
  setButtonGate(locateDevice, commandGateMessage(target, "locate.device"));
  setButtonGate(lockDevice, commandGateMessage(target, "lock.device"));
  setButtonGate(mobileDataOn, commandGateMessage(target, "mobile.data.on"));
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
  const list = Object.values(state.devices);
  devices.innerHTML = list.length ? "" : "<p>No enrolled devices yet.</p>";
  for (const device of list) {
    const card = document.createElement("button");
    card.className = `device-card ${selectedDeviceIds.includes(device.id) ? "active" : ""}`;
    card.innerHTML = `<span><strong>${device.name}</strong><br><small>${device.platform} � ${device.serial}</small></span><i class="status ${device.status}"></i>`;
    card.onclick = () => {
      selectedDeviceIds = selectedDeviceIds.includes(device.id) ? selectedDeviceIds.filter((id) => id !== device.id) : [device.id];
      const target = targetDevice();
      screenText.textContent = target ? `${target.name} selected. Remote desktop/camera/terminal commands will target this device.` : "Select one enrolled device for real-time control";
      render();
    };
    devices.appendChild(card);
  }
  const target = targetDevice();
  targetBadge.textContent = target ? `${target.name} � ${target.status}` : "No target";
  log.textContent = JSON.stringify({ devices: list, commands: state.commands }, null, 2);
  renderTerminalResults();
  renderDeviceFileBrowser();
  renderLocationResults();
  refreshCapabilityGates();
}

async function refresh() {
  if (!adminToken.value) return;
  state = await api("/api/state");
  render();
}

async function uploadFile(file) {
  const response = await fetch("/api/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken.value}`, "Content-Type": file.type || "application/octet-stream", "X-File-Name": file.name },
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
  deviceFiles.innerHTML = `<p>Browse requested. Waiting for ${target.name}...</p>`;
  await refresh();
  setTimeout(refresh, 2500);
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
  locationText.textContent = `${deviceName}: ${location.lat}, ${location.lng}${location.accuracy ? ` ? accuracy ${Math.round(location.accuracy)}m` : ""}`;
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

function renderDeviceFileBrowser() {
  const target = targetDevice();
  if (!target) return;
  const fileListCommands = Object.values(state.commands || {}).filter((command) => command.type === "file.list" && command.deviceIds.includes(target.id));
  const latest = fileListCommands[fileListCommands.length - 1];
  const result = latest && latest.results && latest.results[target.id];
  if (!result) return;
  const listed = Array.isArray(result.files) ? result : (() => { try { return JSON.parse(result.output || "{}"); } catch { return {}; } })();
  if (!Array.isArray(listed.files)) return;
  deviceFiles.innerHTML = "";
  for (const file of listed.files) {
    const row = document.createElement("div");
    row.className = "file-row";
    row.innerHTML = `<span><strong>${file.name}</strong><small>${file.path} � ${file.directory ? "folder" : file.size + " bytes"}</small></span>`;
    const button = document.createElement("button");
    button.textContent = file.directory ? "Open" : "Export";
    button.onclick = async () => {
      const commandType = file.directory ? "file.list" : "file.pull";
      await createCommand([target.id], commandType, { path: file.path, requestedAt: new Date().toISOString() });
      await refresh();
      setTimeout(refresh, 2500);
    };
    row.appendChild(button);
    deviceFiles.appendChild(row);
  }
  const exported = Object.values(state.files || {}).filter((file) => file.sourceDeviceId === target.id);
  for (const file of exported) {
    const row = document.createElement("div");
    row.className = "file-row";
    row.innerHTML = `<span><strong>${file.name}</strong><small>exported � ${file.size} bytes</small></span><a href="/api/files/${file.id}" target="_blank">Download</a>`;
    deviceFiles.prepend(row);
  }
}
async function createCommand(deviceIds, type, payload) {
  return api("/api/commands", { method: "POST", body: JSON.stringify({ deviceIds, type, payload }) });
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
    headers: { Authorization: `Bearer ${adminToken.value}` },
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

function startLivePolling(deviceId) {
  if (livePollTimer) clearInterval(livePollTimer);
  const poll = () => fetchLiveFrame(deviceId).catch((error) => {
    if (!screen.classList.contains("streaming")) screenText.textContent = error.message;
  });
  poll();
  livePollTimer = setInterval(poll, 1200);
}

function openLiveViewer(deviceId) {
  if (liveSocket) liveSocket.close();
  if (livePollTimer) clearInterval(livePollTimer);
  startLivePolling(deviceId);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  liveSocket = new WebSocket(`${protocol}//${location.host}/ws/live?deviceId=${encodeURIComponent(deviceId)}&adminToken=${encodeURIComponent(adminToken.value)}`);
  liveSocket.binaryType = "blob";
  liveSocket.onmessage = (event) => {
    const previous = liveFrame.src;
    liveFrame.src = URL.createObjectURL(event.data);
    screen.classList.add("streaming");
    screenText.textContent = "";
    if (previous.startsWith("blob:")) URL.revokeObjectURL(previous);
  };
  liveSocket.onclose = () => {};
  liveSocket.onerror = () => {};
}

screen.addEventListener("click", (event) => {
  const target = targetDevice();
  if (!target || !screen.classList.contains("streaming")) return;
  const rect = screen.getBoundingClientRect();
  const x = Math.round(((event.clientX - rect.left) / rect.width) * 720);
  const y = Math.round(((event.clientY - rect.top) / rect.height) * 1280);
  createCommand([target.id], "screen.tap", { x, y }).catch((error) => (log.textContent = error.message));
});
async function sendLiveControl(type) {
  const target = targetDevice();
  if (!target) throw new Error("Select exactly one target device for live control");
  const commandType = target.platform === "ios" && type === "screen.control.request" ? "screen.share.request" : type;
  await createCommand([target.id], commandType, { requestedAt: new Date().toISOString(), mode: "admin-control-session" });
  if (["screen.control.request", "camera.stream.request"].includes(commandType)) openLiveViewer(target.id);
  screenText.textContent = commandType === "screen.control.request" ? `Live viewer opened for ${target.name}. If no frame appears, tap Start Live Screen inside the Android agent to approve screen capture.` : `Camera stream requested for ${target.name}. Waiting for camera frames from the agent.`;
  await refresh();
}

terminalForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendTerminalCommand(terminalCommand.value).catch((error) => appendTerminal(`ERROR: ${error.message}`));
});

focusTerminal.addEventListener("click", () => terminalCommand.focus());

enrollDevice.addEventListener("click", () => {
  enrollInstructions.textContent = "Click Download to install CP DEVICE Agent. After Android installs it, tap Open Agent here or open CP DEVICE Agent from your apps; Android will ask you to approve Device Admin access.";
  enrollModal.showModal();
});

browserEnrollOnly.addEventListener("click", () => {
  enrollModal.close();
  enrollCurrentDevice().catch((error) => (log.textContent = error.message));
});

downloadAgent.addEventListener("click", async () => {
  if (!adminToken.value) {
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
  enrollInstructions.textContent = details.platform === "android"
    ? "After Android installs CP DEVICE Agent, tap Open Agent. The app will auto-fill enrollment and Android will ask for Device Admin permission."
    : "Install the downloaded iOS profile in Settings to complete MDM enrollment.";
});

openAgent.addEventListener("click", () => {
  if (!pendingEnrollmentLink) {
    log.textContent = "Download/enroll the device first, then tap Open Agent.";
    return;
  }
  location.href = pendingEnrollmentLink;
});

installApp.addEventListener("click", () => installSelectedApp().catch((error) => (log.textContent = error.message)));
browseFiles.addEventListener("click", () => browseDeviceFiles().catch((error) => (log.textContent = error.message)));
locateDevice.addEventListener("click", async () => {
  const target = targetDevice();
  if (!target) return (log.textContent = "Select exactly one target device");
  await createCommand([target.id], "locate.device", { requestedAt: new Date().toISOString() });
  await refresh();
});
lockDevice.addEventListener("click", async () => {
  const target = targetDevice();
  if (!target) return (log.textContent = "Select exactly one target device");
  await createCommand([target.id], "lock.device", { requestedAt: new Date().toISOString() });
  await refresh();
});
mobileDataOn.addEventListener("click", async () => {
  const target = targetDevice();
  if (!target) return (log.textContent = "Select exactly one target device");
  await createCommand([target.id], "mobile.data.on", { requestedAt: new Date().toISOString() });
  await refresh();
});
firmwareUpgrade.addEventListener("click", async () => {
  const target = targetDevice();
  if (!target) return (log.textContent = "Select exactly one Android device");
  if (!firmwareUrl.value.trim()) return (log.textContent = "Enter firmware/OEM update URL");
  await createCommand([target.id], "firmware.update", { updateUrl: firmwareUrl.value.trim(), requestedAt: new Date().toISOString() });
  await refresh();
});

document.querySelectorAll("[data-live-command]").forEach((button) => {
  button.addEventListener("click", () => sendLiveControl(button.dataset.liveCommand).catch((error) => (log.textContent = error.message)));
});

adminLoginButton.addEventListener("click", () => loginAdmin().catch((error) => showAdminGate(error.message)));
adminLogout.addEventListener("click", () => {
  adminToken.value = "";
  sessionStorage.removeItem("cpAdminToken");
  state = { devices: {}, commands: {} };
  showAdminGate("Logged out.");
});
adminToken.value = sessionStorage.getItem("cpAdminToken") || "";
verifyAdminSession();
setInterval(() => refresh().catch(() => {}), 2000);









