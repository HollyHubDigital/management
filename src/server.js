const http = require("http");
const crypto = require("crypto");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { JsonStore } = require("./lib/store");
const { parseJsonBody, requireEnv, verifyAdmin, hashPassword, verifyPassword, randomId, bearerToken } = require("./lib/security");
const { StatePersistence } = require("./services/statePersistence");
const { DeviceRegistry } = require("./services/deviceRegistry");
const { RealtimeHub } = require("./services/realtimeHub");

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || (process.env.VERCEL ? "/tmp/cp-device-data" : ".cp-device-data");
const DATA_ROOT = path.isAbsolute(DATA_DIR) ? DATA_DIR : path.join(process.env.VERCEL ? "/tmp" : process.cwd(), DATA_DIR);
const FILE_DIR = path.join(DATA_ROOT, "files");
const RECORDING_DIR = path.join(DATA_ROOT, "recordings");
fs.mkdirSync(FILE_DIR, { recursive: true });
fs.mkdirSync(RECORDING_DIR, { recursive: true });
const store = new JsonStore(path.join(DATA_ROOT, "state.json"));
store.load();

const persistenceStore = new StatePersistence(process.env);
const registry = new DeviceRegistry(store, persistenceStore, requireEnv("CP_DEVICE_ENROLLMENT_SECRET", "change-this-long-random-enrollment-secret"));
let hydratePromise = null;
let hydratedAt = 0;

function hasMeaningfulPersistedState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  return Object.entries(state).some(([key, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") return Object.keys(value).length > 0;
    return Boolean(value);
  });
}


function mergeActiveLocalSessions(persistedState, localState) {
  const now = Date.now();
  const merged = { ...(persistedState || {}) };
  const persistedSessions = merged.sessions || {};
  const localSessions = localState.sessions || {};
  merged.sessions = { ...persistedSessions };
  for (const [token, session] of Object.entries(localSessions)) {
    if (!session || Date.parse(session.expiresAt) < now) continue;
    if (!merged.sessions[token]) merged.sessions[token] = session;
  }
  return merged;
}
async function hydrateStore(force = false) {
  if (!persistenceStore.enabled()) return;
  if (!force && hydratePromise && Date.now() - hydratedAt < 1500) return hydratePromise;
  hydratePromise = persistenceStore.pullState()
    .then((state) => {
      if (state && !state.skipped && hasMeaningfulPersistedState(state)) {
        store.replaceState(mergeActiveLocalSessions(state, store.state));
      } else if (state && state.skipped) {
        store.save();
      }
      hydratedAt = Date.now();
    })
    .catch((error) => {
      hydratedAt = Date.now();
      store.state.audit.push({ at: new Date().toISOString(), type: "supabase.hydrate.failed", error: error.message });
    });
  await hydratePromise;
}

async function persistStateBestEffort(message) {
  try {
    return await persistState(message);
  } catch (error) {
    store.state.audit.push({ at: new Date().toISOString(), type: "persistence.best_effort.failed", error: error.message, message });
    store.save();
    return { skipped: true, reason: error.message };
  }
}

async function persistState(message) {
  store.save();
  try {
    const result = await persistenceStore.pushState(store.state, message);
    if (persistenceStore.enabled() && result && result.skipped) throw new Error(result.reason || "Persistence skipped");
    return result;
  } catch (error) {
    store.state.audit.push({ at: new Date().toISOString(), type: "supabase.persist.failed", error: error.message, message });
    store.save();
    throw new Error(`Persistent storage failed: ${error.message}`);
  }
}

new RealtimeHub(registry).startOfflineSweep();


const liveViewers = new Map();
const liveFrames = new Map();
const activeRecordings = new Map();

function websocketAccept(key) {
  return crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

function wsFrame(payload, opcode = 2) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = [];
  header.push(0x80 | opcode);
  if (data.length < 126) header.push(data.length);
  else if (data.length < 65536) header.push(126, data.length >> 8, data.length & 255);
  else header.push(127, 0, 0, 0, 0, (data.length / 16777216) & 255, (data.length / 65536) & 255, (data.length / 256) & 255, data.length & 255);
  return Buffer.concat([Buffer.from(header), data]);
}

function readWsFrames(socket, chunk, onMessage) {
  let offset = 0;
  while (offset + 2 <= chunk.length) {
    const first = chunk[offset++];
    const second = chunk[offset++];
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    if (length === 126) { if (offset + 2 > chunk.length) return; length = chunk.readUInt16BE(offset); offset += 2; }
    if (length === 127) { if (offset + 8 > chunk.length) return; length = Number(chunk.readBigUInt64BE(offset)); offset += 8; }
    const masked = Boolean(second & 0x80);
    const mask = masked ? chunk.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (offset + length > chunk.length) return;
    const payload = Buffer.from(chunk.subarray(offset, offset + length));
    offset += length;
    if (mask) for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
    if (opcode === 8) socket.end();
    if (opcode === 1 || opcode === 2) onMessage(payload, opcode);
  }
}

function handleWebSocket(req, socket) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const accept = websocketAccept(req.headers["sec-websocket-key"] || "");
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));

  if (url.pathname === "/ws/live") {
    const adminToken = url.searchParams.get("adminToken") || "";
    const deviceId = url.searchParams.get("deviceId") || "";
    const session = store.state.sessions[adminToken];
    const sessionUserId = session && Date.parse(session.expiresAt) > Date.now() ? session.userId : null;
    const device = store.state.devices[deviceId];
    const allowed = device && (adminToken === process.env.CP_DEVICE_ADMIN_TOKEN || (session && session.role === "admin") || (sessionUserId && deviceOwnerId(device) === sessionUserId));
    if (!allowed) return socket.end();
    if (!liveViewers.has(deviceId)) liveViewers.set(deviceId, new Set());
    liveViewers.get(deviceId).add(socket);
    socket.on("close", () => liveViewers.get(deviceId)?.delete(socket));
    socket.on("error", () => liveViewers.get(deviceId)?.delete(socket));
    return;
  }

  if (url.pathname.startsWith("/ws/device/")) {
    const deviceId = url.pathname.split("/").pop();
    const token = url.searchParams.get("token") || "";
    if (!registry.authenticate(deviceId, token)) return socket.end();
    socket.on("data", (chunk) => readWsFrames(socket, chunk, (payload) => {
      liveFrames.set(deviceId, { frame: Buffer.from(payload), contentType: "image/jpeg", updatedAt: new Date().toISOString() });
      const viewers = liveViewers.get(deviceId) || new Set();
      const frame = wsFrame(payload, 2);
      for (const viewer of viewers) if (!viewer.destroyed) viewer.write(frame);
    }));
    return;
  }

  socket.end();
}
const commandPolicy = {
  android: new Set(["heartbeat", "shell", "file.list", "file.pull", "file.push", "app.install", "app.remove", "firmware.update", "camera.stream.request", "camera.switch", "screen.control.request", "screen.tap", "locate.device", "lock.device", "mobile.data.on", "device.info.refresh", "agent.unenroll"]),
  ios: new Set(["heartbeat", "mdm.device.info", "app.install", "app.remove", "firmware.update", "screen.share.request", "locate.device", "lock.device"])
};

function commandCapabilityError(device, type) {
  const capabilities = device.capabilities || {};
  if (capabilities.browserEnrollment && !capabilities.nativeAgent && !capabilities.appleMdm) return "Install the native agent or complete Apple MDM enrollment before using this command.";
  if (device.platform === "android") {
    if (["shell"].includes(type) && !capabilities.deviceOwner && !capabilities.oemPrivileged) return "Android shell/admin commands require Device Owner or OEM/system privileges.";
    if (type === "screen.tap" && !capabilities.accessibility) return "Android remote touch control requires the CP DEVICE Accessibility service.";
    if (type === "camera.stream.request" && !capabilities.camera) return "Android camera streaming requires camera permission in the agent.";
    if (type === "lock.device" && !capabilities.deviceAdmin && !capabilities.deviceOwner) return "Android lock requires Device Admin or Device Owner.";
    if (type === "mobile.data.on" && !capabilities.oemPrivileged) return "Mobile data toggle requires OEM/system privileges.";
    if (type === "firmware.update" && !capabilities.deviceOwner && !capabilities.oemPrivileged) return "Firmware update requires Device Owner system-update policy or OEM/system updater integration.";
  }
  if (device.platform === "ios") {
    if (!capabilities.appleMdm) return "iPhone commands require completed Apple MDM/APNs enrollment.";
    if (type === "locate.device" && !capabilities.supervised) return "iPhone location requires supervised device Lost Mode MDM support.";
    if (["firmware.update", "app.install", "app.remove"].includes(type) && !capabilities.supervised) return "This iPhone command requires a supervised Apple MDM device.";
  }
  return "";
}

function assertCommandAllowed(device, type) {
  const platformPolicy = commandPolicy[device.platform] || new Set();
  if (!platformPolicy.has(type)) return `${type} is not supported on ${device.platform}`;
  return commandCapabilityError(device, type);
}
function allowedOrigin(origin) {
  const allowed = new Set([
    process.env.USER_INTERFACE_ORIGIN || "https://android-device-management.vercel.app",
    process.env.ADMIN_ORIGIN || "https://admin-device-management.vercel.app"
  ].filter(Boolean));
  return allowed.has(origin) ? origin : "";
}

function corsHeaders(req) {
  const origin = allowedOrigin(req.headers.origin || "");
  return origin ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-File-Name,X-Command-Id",
    "Vary": "Origin"
  } : {};
}
function publicUser(user) {
  if (!user) return null;
  const subscription = store.state.subscriptions[user.id] || { plan: "free", expiresAt: null };
  return { id: user.id, email: user.email, username: user.username, phone: user.phone, role: user.role || "user", subscription };
}

function validPhone(phone) {
  return /^\+[1-9]\d{7,14}$/.test(String(phone || "").replace(/\s+/g, ""));
}

function findUser(login) {
  const key = String(login || "").toLowerCase().trim();
  const normalizedPhone = key.replace(/\s+/g, "");
  return Object.values(store.state.users).find((user) => {
    if (user.email.toLowerCase() === key) return true;
    if (user.username.toLowerCase() === key) return true;
    if (String(user.phone || "").replace(/\s+/g, "") === normalizedPhone) return true;
    return false;
  });
}

function createSession(userId, role = "user") {
  const token = randomId("sess");
  store.transaction((state) => {
    // Admin sessions remain short-lived; user sessions are long-lived (persisted) so clients can "remember me".
    const expiresAt = role === "admin" ? new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString() : new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 10).toISOString();
    state.sessions[token] = { token, userId, role, createdAt: new Date().toISOString(), expiresAt };
  });
  return token;
}

function sessionUser(req) {
  const session = store.state.sessions[bearerToken(req)];
  if (!session || Date.parse(session.expiresAt) < Date.now()) return null;
  return store.state.users[session.userId] || (session.role === "admin" ? { id: "admin", role: "admin", email: "admin", username: "admin", phone: "" } : null);
}

function isAdminRequest(req) {
  const user = sessionUser(req);
  return verifyAdmin(req) || (user && user.role === "admin");
}

function deviceOwnerId(device) {
  return device && (device.ownerUserId || device.userId || device.user_id || device.ownerId || "");
}

function ownsDevice(userId, deviceId) {
  return Boolean(store.state.devices[deviceId] && deviceOwnerId(store.state.devices[deviceId]) === userId);
}

function removeDeviceFromState(state, deviceId, audit = {}) {
  delete state.devices[deviceId];
  for (const command of Object.values(state.commands)) command.deviceIds = command.deviceIds.filter((id) => id !== deviceId);
  state.audit.push({ at: new Date().toISOString(), ...audit, deviceId });
}

function queueDeviceRemoval(deviceId, actor) {
  const device = store.state.devices[deviceId];
  if (!device) return { removed: false, queued: false };
  const hasNativeAgent = Boolean(device.capabilities && device.capabilities.nativeAgent);
  if (!hasNativeAgent) {
    store.transaction((state) => removeDeviceFromState(state, deviceId, { type: `${actor}.device.removed` }));
    return { removed: true, queued: false };
  }
  const command = registry.createCommand([deviceId], "agent.unenroll", { requestedAt: new Date().toISOString(), actor });
  store.transaction((state) => {
    if (state.devices[deviceId]) {
      state.devices[deviceId].pendingRemoval = true;
      state.devices[deviceId].pendingRemovalCommandId = command.id;
      state.audit.push({ at: new Date().toISOString(), type: `${actor}.device.unenroll.queued`, deviceId, commandId: command.id });
    }
  });
  return { removed: false, queued: true, command };
}

function canViewLiveFrame(req, deviceId) {
  if (isAdminRequest(req)) return Boolean(store.state.devices[deviceId]);
  const user = sessionUser(req);
  return Boolean(user && user.role === "user" && ownsDevice(user.id, deviceId));
}

const subscriptionPlans = { monthly: { amount: 7, days: 30 }, six_months: { amount: 35, days: 180 }, yearly: { amount: 60, days: 365 } };

function activateSubscription(userId, plan, paymentId) {
  const selected = subscriptionPlans[plan];
  if (!selected) throw new Error("Invalid plan");
  const now = Date.now();
  const current = store.state.subscriptions[userId];
  const base = current && Date.parse(current.expiresAt) > now ? Date.parse(current.expiresAt) : now;
  const expiresAt = new Date(base + selected.days * 24 * 60 * 60 * 1000).toISOString();
  store.transaction((state) => {
    state.subscriptions[userId] = { plan, expiresAt, paymentId, updatedAt: new Date().toISOString() };
    state.payments[paymentId].status = "successful";
    state.payments[paymentId].successfulAt = new Date().toISOString();
  });
  return store.state.subscriptions[userId];
}

function hasPaidAccess(userId) {
  const subscription = store.state.subscriptions[userId];
  return Boolean(subscription && subscription.plan !== "free" && Date.parse(subscription.expiresAt) > Date.now());
}

function devicePaidAccessAllowed(userId, device) {
  if (hasPaidAccess(userId)) return true;
  return Boolean(device && device.subscriptionOverride && device.subscriptionOverride.active);
}

async function submitWeb3Forms(user) {
  if (!process.env.WEB3FORMS_ACCESS_KEY) return { skipped: true, reason: "WEB3FORMS_ACCESS_KEY not configured" };
  const body = JSON.stringify({ access_key: process.env.WEB3FORMS_ACCESS_KEY, subject: "CP DEVICE Signup", email: user.email, username: user.username, phone: user.phone });
  return new Promise((resolve) => {
    const request = https.request({ hostname: "api.web3forms.com", path: "/submit", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (response) => {
      let data = ""; response.on("data", (chunk) => data += chunk); response.on("end", () => resolve({ status: response.statusCode, data }));
    });
    request.on("error", (error) => resolve({ error: error.message }));
    request.write(body); request.end();
  });
}
function safeFileName(name) {
  return String(name || "file.bin").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file.bin";
}

function readRawBody(req, limitBytes = 200_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) { reject(new Error("Upload too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}


function recordingFilePath(recordingId) {
  return path.join(RECORDING_DIR, `${safeFileName(recordingId)}.mjpeg`);
}

function appendRecordingFrame(deviceId, frame, contentType) {
  const active = activeRecordings.get(deviceId);
  if (!active || active.stoppedAt) return;
  const boundary = `--cp-device-frame\r\nContent-Type: ${contentType || "image/jpeg"}\r\nContent-Length: ${frame.length}\r\n\r\n`;
  fs.appendFileSync(active.filePath, Buffer.concat([Buffer.from(boundary), frame, Buffer.from("\r\n")]));
  active.frameCount += 1;
  active.size += Buffer.byteLength(boundary) + frame.length + 2;
  active.updatedAt = new Date().toISOString();
}

async function persistRecordingToGithub(recording) {
  const github = persistenceStore.github;
  if (!github || !github.enabled()) return { skipped: true, reason: "GitHub recording storage is not configured" };
  const data = fs.readFileSync(recording.filePath);
  return github.pushFile(recording.githubPath, data, `Store CP DEVICE recording ${recording.id}`);
}

function canAccessRecording(req, recording) {
  if (!recording) return false;
  if (isAdminRequest(req)) return true;
  const queryToken = new URL(req.url, `http://${req.headers.host}`).searchParams.get("token");
  const previousAuth = req.headers.authorization;
  if (queryToken && !previousAuth) req.headers.authorization = `Bearer ${queryToken}`;
  const user = sessionUser(req);
  if (queryToken && !previousAuth) delete req.headers.authorization;
  return Boolean(user && user.role === "user" && recording.ownerUserId === user.id);
}

function serveStoredFile(res, fileId) {
  const meta = store.state.files[fileId];
  if (!meta) return send(res, 404, { error: "File not found" });
  const filePath = path.join(FILE_DIR, fileId);
  if (!fs.existsSync(filePath)) return send(res, 404, { error: "File data not found" });
  res.writeHead(200, {
    "Content-Type": meta.contentType || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${safeFileName(meta.name)}"`,
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}
function sendError(res, error) {
  const message = error && error.message ? error.message : "Server error";
  const status = ["Invalid JSON body", "Request body too large"].includes(message) ? 400 : message.startsWith("Persistent storage failed:") || message.startsWith("GitHub persistence failed:") ? 503 : 500;
  send(res, status, { error: message });
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function serveDownload(res, filePath, downloadName, contentType) {
  if (!fs.existsSync(filePath)) {
    return send(res, 404, {
      error: "Enrollment artifact is not configured",
      expectedFile: filePath,
      nextStep: "Build and place the signed Android APK or signed iOS MDM profile in the artifacts directory."
    });
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${downloadName}"`,
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}
function serveStatic(req, res) {
  const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const fileName = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const filePath = path.join(process.cwd(), "public", fileName);
  if (!filePath.startsWith(path.join(process.cwd(), "public")) || !fs.existsSync(filePath)) return false;
  const type = filePath.endsWith(".css") ? "text/css" : filePath.endsWith(".js") ? "text/javascript" : "text/html";
  res.writeHead(200, { "Content-Type": type, "X-Frame-Options": "DENY", "Cache-Control": "no-store" });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cors = corsHeaders(req);
  for (const [key, value] of Object.entries(cors)) res.setHeader(key, value);
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }
  await hydrateStore();
    if (["POST", "PUT"].includes(req.method) && (url.pathname === "/api/mdm/checkin" || url.pathname === "/api/mdm/connect")) {
      return send(res, 501, {
        error: "Apple MDM is not configured",
        requiredEnvironment: ["APPLE_MDM_APNS_TOPIC", "APPLE_MDM_PUSH_CERTIFICATE", "APPLE_MDM_PUSH_PRIVATE_KEY"],
        nextStep: "Configure Apple Business/School Manager, APNs MDM certificate, signed enrollment profile, and MDM command processing before production iPhone remote management."
      });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/live/") && url.pathname.endsWith("/frame")) {
      const deviceId = url.pathname.split("/")[3];
      if (!canViewLiveFrame(req, deviceId)) return send(res, 401, { error: "Live frame access denied" });
      const frame = liveFrames.get(deviceId);
      if (!frame) return send(res, 404, { error: "No live frame received yet. Start Live Screen or Camera in the enrolled agent." });
      res.writeHead(200, { "Content-Type": frame.contentType, "Cache-Control": "no-store", "X-Frame-Updated-At": frame.updatedAt });
      return res.end(frame.frame);
    }

    if (req.method === "GET" && url.pathname === "/api/auth/check-availability") {
      const field = (url.searchParams.get("field") || "").toLowerCase();
      const value = String(url.searchParams.get("value") || "").trim();
      if (!field || !value || !["email", "username", "phone"].includes(field)) return send(res, 400, { error: "field and value are required", available: false });
      const normalized = field === "phone" ? value.replace(/\s+/g, "") : value.toLowerCase();
      const exists = Object.values(store.state.users).some((user) => {
        if (field === "email") return user.email.toLowerCase() === normalized;
        if (field === "username") return user.username.toLowerCase() === normalized;
        if (field === "phone") return String(user.phone || "").replace(/\s+/g, "") === normalized;
        return false;
      });
      return send(res, 200, { available: !exists });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/signup") {
      const body = await parseJsonBody(req);
      for (const field of ["email", "username", "password", "phone"]) if (!body[field]) return send(res, 400, { error: `${field} is required` });
      if (!validPhone(body.phone)) return send(res, 400, { error: "Phone must include country code, e.g. +12345678900" });
      if (findUser(body.email)) return send(res, 409, { error: "Email already exists" });
      if (findUser(body.username)) return send(res, 409, { error: "Username already exists" });
      if (Object.values(store.state.users).some((user) => String(user.phone || "").replace(/\s+/g, "") === String(body.phone).replace(/\s+/g, ""))) return send(res, 409, { error: "Phone already exists" });
      const userId = randomId("usr");
      const user = { id: userId, email: body.email, username: body.username, phone: String(body.phone).replace(/\s+/g, ""), passwordHash: hashPassword(body.password), role: "user", createdAt: new Date().toISOString() };
      store.transaction((state) => { state.users[userId] = user; state.subscriptions[userId] = { plan: "free", expiresAt: null, updatedAt: new Date().toISOString() }; });
      await persistState("Create CP DEVICE user");
      submitWeb3Forms(user).catch(() => {});
      return send(res, 201, { ok: true, user: publicUser(user) });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await parseJsonBody(req);
      const adminUsername = process.env.CP_DEVICE_ADMIN_USERNAME || "admin";
      const adminPassword = process.env.CP_DEVICE_ADMIN_PASSWORD;
      if (!adminPassword) {
        return send(res, 500, { error: "Admin password is not configured on the server." });
      }
      if (body.login === adminUsername && body.password === adminPassword) {
        const token = createSession("admin", "admin");
        await persistState("Create admin session");
        return send(res, 200, { token, user: { id: "admin", role: "admin", username: "admin", email: "admin" } });
      }
      const user = findUser(body.login);
      if (!user || !verifyPassword(body.password, user.passwordHash)) return send(res, 401, { error: "Invalid credentials" });
      const token = createSession(user.id);
      await persistState("Create user session");
      return send(res, 200, { token, user: publicUser(user) });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/reset-password") {
      const body = await parseJsonBody(req);
      const user = findUser(body.login);
      if (!user || !verifyPassword(body.currentPassword, user.passwordHash)) return send(res, 401, { error: "Current password is incorrect" });
      if (!body.newPassword || body.newPassword !== body.confirmNewPassword) return send(res, 400, { error: "New passwords do not match" });
      store.transaction((state) => { state.users[user.id].passwordHash = hashPassword(body.newPassword); });
      // Invalidate all sessions for this user so they must re-authenticate after a password change
      store.transaction((state) => {
        for (const [token, session] of Object.entries(state.sessions || {})) {
          if (session && session.userId === user.id) delete state.sessions[token];
        }
      });
      await persistState("Reset CP DEVICE user password and invalidate sessions");
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      const token = bearerToken(req);
      store.transaction((state) => { if (state.sessions[token]) delete state.sessions[token]; });
      await persistState("User logout");
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      const user = sessionUser(req);
      if (!user) return send(res, 401, { error: "Login required" });
      return send(res, 200, { user: publicUser(user) || user });
    }
    if (req.method === "POST" && url.pathname === "/api/user/enroll-browser") {
      const user = sessionUser(req);
      if (!user || user.role !== "user") return send(res, 401, { error: "User login required" });
      const body = await parseJsonBody(req);
      const enrollment = registry.enroll({ platform: body.platform, name: body.name, serial: body.serial, ownerConsent: true, capabilities: body.capabilities || {}, info: body.info || {} });
      store.transaction((state) => { state.devices[enrollment.deviceId].ownerUserId = user.id; state.devices[enrollment.deviceId].userId = user.id; state.devices[enrollment.deviceId].user_id = user.id; });
      await persistState("Assign device owner");
      return send(res, 201, enrollment);
    }

    if (req.method === "GET" && url.pathname === "/api/user/devices") {
      const user = sessionUser(req);
      if (!user || user.role !== "user") return send(res, 401, { error: "User login required" });
      const ownedDeviceIds = new Set(Object.values(store.state.devices).filter((device) => deviceOwnerId(device) === user.id).map((device) => device.id));
      return send(res, 200, {
        devices: Object.values(store.state.devices).filter((device) => deviceOwnerId(device) === user.id && !device.pendingRemoval),
        files: Object.values(store.state.files).filter((file) => ownsDevice(user.id, file.sourceDeviceId)),
        commands: Object.values(store.state.commands).filter((command) => command.deviceIds.some((deviceId) => ownedDeviceIds.has(deviceId)))
      });
    }

    // Allow a user to update capabilities for devices they own (owner-only, for testing/agent handshake flows)
    if (req.method === "POST" && url.pathname.startsWith("/api/user/devices/") && url.pathname.endsWith("/capabilities")) {
      const user = sessionUser(req);
      if (!user || user.role !== "user") return send(res, 401, { error: "User login required" });
      const parts = url.pathname.split("/");
      const deviceId = parts[4];
      if (!ownsDevice(user.id, deviceId)) return send(res, 403, { error: "Device not found or not owned by user" });
      const body = await parseJsonBody(req);
      const caps = body.capabilities || body;
      store.transaction((state) => {
        const d = state.devices[deviceId];
        if (!d) throw new Error("Unknown device");
        d.capabilities = { ...(d.capabilities || {}), ...(caps || {}) };
        state.audit.push({ at: new Date().toISOString(), type: "user.update.device.capabilities", deviceId, userId: user.id, changes: Object.keys(caps || {}) });
      });
      await persistState("User update device capabilities");
      return send(res, 200, { ok: true, device: store.state.devices[deviceId] });
    }

    if (req.method === "POST" && url.pathname === "/api/user/commands") {
      const user = sessionUser(req);
      if (!user || user.role !== "user") return send(res, 401, { error: "User login required" });
      const body = await parseJsonBody(req);
      const featureType = body.type || "";
      const freeAllowed = new Set(["screen.control.request", "screen.share.request", "device.info.refresh"]);
      const deviceIds = Array.isArray(body.deviceIds) ? body.deviceIds : [];
      if (!deviceIds.length || deviceIds.some((deviceId) => !ownsDevice(user.id, deviceId))) return send(res, 403, { error: "Device is not owned by this user" });
      const requestedDevices = deviceIds.map((deviceId) => store.state.devices[deviceId]);
      const targetHasPaidAccess = requestedDevices.every((device) => devicePaidAccessAllowed(user.id, device));
      if (!targetHasPaidAccess && !freeAllowed.has(featureType)) return send(res, 402, { error: "Subscription required", subscriptionRequired: true });
      for (const device of requestedDevices) {
        const capabilityError = assertCommandAllowed(device, featureType);
        if (capabilityError) return send(res, 400, { error: capabilityError });
      }
      const command = registry.createCommand(deviceIds, featureType, body.payload || {});
      await persistStateBestEffort("Queue user device command");
      return send(res, 201, command);
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/user/devices/")) {
      const user = sessionUser(req);
      if (!user || user.role !== "user") return send(res, 401, { error: "User login required" });
      const deviceId = url.pathname.split("/").pop();
      if (!ownsDevice(user.id, deviceId)) return send(res, 404, { error: "Device not found" });
      const removal = queueDeviceRemoval(deviceId, `user.${user.id}`);
      await persistStateBestEffort(removal.queued ? "Queue user device unenroll" : "Remove user device");
      return send(res, 200, { ok: true, ...removal, message: removal.queued ? "Authorized unenroll queued. The agent will release Device Owner/Admin restrictions, then the dashboard record will be removed." : "Device removed." });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/user/files/")) {
      const user = sessionUser(req);
      if (!user || user.role !== "user") return send(res, 401, { error: "User login required" });
      const fileId = url.pathname.split("/").pop();
      const meta = store.state.files[fileId];
      if (!meta || !ownsDevice(user.id, meta.sourceDeviceId)) return send(res, 404, { error: "File not found" });
      return serveStoredFile(res, fileId);
    }

    if (req.method === "POST" && url.pathname === "/api/payments/init") {
      const user = sessionUser(req);
      if (!user || user.role !== "user") return send(res, 401, { error: "User login required" });
      const body = await parseJsonBody(req);
      if (!subscriptionPlans[body.plan]) return send(res, 400, { error: "Invalid plan" });
      const paymentId = body.paymentId || randomId("pay");
      const existing = store.state.payments[paymentId];
      if (existing && existing.userId === user.id) return send(res, existing.status === "successful" ? 409 : 200, { error: existing.status === "successful" ? "Payment id already successful" : undefined, payment: existing });
      if (existing) return send(res, 409, { error: "Payment id already belongs to another user" });
      const payment = { id: paymentId, userId: user.id, plan: body.plan, amount: subscriptionPlans[body.plan].amount, provider: body.provider, status: "pending", createdAt: new Date().toISOString() };
      store.transaction((state) => { state.payments[paymentId] = payment; });
      await persistState("Initialize CP DEVICE payment");
      return send(res, 200, { payment, checkout: { configured: false, reason: "Provider secret keys/webhook verification must be configured in Vercel env before real charges are accepted." } });
    }

    if (req.method === "POST" && url.pathname === "/api/payments/activate") {
      if (!isAdminRequest(req)) return send(res, 401, { error: "Admin login required" });
      const body = await parseJsonBody(req);
      const payment = store.state.payments[body.paymentId];
      if (!payment) return send(res, 404, { error: "Payment not found" });
      if (payment.status === "successful") return send(res, 200, { payment, subscription: store.state.subscriptions[payment.userId], idempotent: true });
      const subscription = activateSubscription(payment.userId, payment.plan, payment.id);
      await persistState("Activate CP DEVICE subscription");
      return send(res, 200, { payment: store.state.payments[payment.id], subscription });
    }
  try {
    if (req.method === "GET" && url.pathname === "/api/enrollment/android-agent") {
      return serveDownload(res, path.join(process.cwd(), "artifacts", "cp-device-agent.apk"), "cp-device-agent.apk", "application/vnd.android.package-archive");
    }

    if (req.method === "GET" && url.pathname === "/api/enrollment/ios-profile") {
      return serveDownload(res, path.join(process.cwd(), "artifacts", "cp-device-enrollment.mobileconfig"), "cp-device-enrollment.mobileconfig", "application/x-apple-aspen-config");
    }
    if (req.method === "POST" && url.pathname === "/api/enroll") {
      const body = await parseJsonBody(req);
      if (body.enrollmentSecret !== process.env.CP_DEVICE_ENROLLMENT_SECRET) return send(res, 401, { error: "Invalid enrollment secret" });
      const enrollment = registry.enroll(body);
      await persistState("Enroll device");
      return send(res, 201, enrollment);
    }

    if (url.pathname.startsWith("/api/device/")) {
      const [, , , deviceId, action] = url.pathname.split("/");
      const token = (req.headers.authorization || "").replace("Bearer ", "");
      if (!registry.authenticate(deviceId, token)) return send(res, 401, { error: "Invalid device token" });
      if (req.method === "POST" && action === "heartbeat") {
        const device = registry.heartbeat(deviceId, await parseJsonBody(req));
        await persistState("Update device heartbeat");
        return send(res, 200, device);
      }
      if (req.method === "POST" && action === "live-frame") {
        const contentType = req.headers["content-type"] || "image/jpeg";
        const frame = await readRawBody(req, 2 * 1024 * 1024);
        liveFrames.set(deviceId, { frame, contentType, updatedAt: new Date().toISOString() });
        appendRecordingFrame(deviceId, frame, contentType);
        return send(res, 200, { ok: true, size: frame.length });
      }
      if (req.method === "GET" && action === "commands") {
        await hydrateStore(true);
        return send(res, 200, { commands: registry.pullCommands(deviceId) });
      }
      if (req.method === "POST" && action === "files") {
        const fileName = safeFileName(req.headers["x-file-name"] || "device-file.bin");
        const commandId = req.headers["x-command-id"] || "manual";
        const contentType = req.headers["content-type"] || "application/octet-stream";
        const data = await readRawBody(req);
        const fileId = `file_${crypto.randomBytes(12).toString("hex")}`;
        fs.writeFileSync(path.join(FILE_DIR, fileId), data);
        store.transaction((state) => {
          state.files[fileId] = { id: fileId, name: fileName, size: data.length, contentType, sourceDeviceId: deviceId, commandId, createdAt: new Date().toISOString() };
        });
        await persistState("Store exported device file metadata");
        return send(res, 201, store.state.files[fileId]);
      }
      if (req.method === "POST" && action === "commands") {
        const body = await parseJsonBody(req);
        // If agent returned files inline (base64), persist them as exported files so UI can list/download
        const result = body.result || {};
        if (Array.isArray(result.files) && result.files.length) {
          for (const f of result.files) {
            try {
              if (f.contentBase64) {
                const data = Buffer.from(f.contentBase64, 'base64');
                const fileId = `file_${crypto.randomBytes(12).toString('hex')}`;
                fs.writeFileSync(path.join(FILE_DIR, fileId), data);
                store.transaction((state) => {
                  state.files[fileId] = { id: fileId, name: f.name || f.path || fileId, size: data.length, contentType: f.contentType || 'application/octet-stream', sourceDeviceId: deviceId, commandId: body.commandId || 'manual', createdAt: new Date().toISOString() };
                });
                // attach id back to result so UI can show download link
                f.id = fileId;
              }
            } catch (e) {
              store.state.audit.push({ at: new Date().toISOString(), type: 'device.file.persist.failed', deviceId, error: e.message });
              try { require('../src/lib/logger').appendAudit({ type: 'device.file.persist.failed', deviceId, error: e.message }); } catch {}
            }
          }
        }
        const command = registry.completeCommand(deviceId, body.commandId, result);
        if (command && command.type === "agent.unenroll" && result && result.ok !== false) {
          store.transaction((state) => removeDeviceFromState(state, deviceId, { type: "device.unenrolled", commandId: body.commandId }));
          await persistState("Complete device unenroll");
          return send(res, 200, { ...command, deviceRemoved: true });
        }
        await persistState("Complete device command");
        return send(res, 200, command);
      }
    }

    if (!url.pathname.startsWith("/api/recordings") && !isAdminRequest(req)) return send(res, 401, { error: "Admin login required" });


    if (req.method === "GET" && url.pathname === "/api/recordings") {
      const recordings = Object.values(store.state.recordings || {}).filter((recording) => canAccessRecording(req, recording));
      return send(res, 200, { recordings });
    }

    if (req.method === "POST" && url.pathname === "/api/recordings/start") {
      const body = await parseJsonBody(req);
      const deviceId = body.deviceId;
      const device = store.state.devices[deviceId];
      if (!device) return send(res, 404, { error: "Device not found" });
      if (!isAdminRequest(req)) {
        const user = sessionUser(req);
        if (!user || !ownsDevice(user.id, deviceId) || !devicePaidAccessAllowed(user.id, device)) return send(res, 403, { error: "Active subscription required" });
      }
      const existing = activeRecordings.get(deviceId);
      if (existing && !existing.stoppedAt) return send(res, 200, { recording: existing });
      const recordingId = randomId("rec");
      const filePath = recordingFilePath(recordingId);
      fs.writeFileSync(filePath, Buffer.from(""));
      const ownerUserId = deviceOwnerId(device);
      const recording = { id: recordingId, deviceId, ownerUserId, name: `${device.name || deviceId} live recording`, status: "recording", contentType: "multipart/x-mixed-replace; boundary=cp-device-frame", filePath, githubPath: `cp-device/recordings/${recordingId}.mjpeg`, size: 0, frameCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      activeRecordings.set(deviceId, recording);
      store.transaction((state) => { state.recordings[recordingId] = { ...recording, filePath: undefined }; });
      await persistStateBestEffort("Start live recording metadata");
      return send(res, 201, { recording: store.state.recordings[recordingId] });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/recordings/") && url.pathname.endsWith("/stop")) {
      const recordingId = url.pathname.split("/")[3];
      const meta = store.state.recordings[recordingId];
      if (!canAccessRecording(req, meta)) return send(res, 404, { error: "Recording not found" });
      const active = activeRecordings.get(meta.deviceId);
      if (active && active.id === recordingId) { active.stoppedAt = new Date().toISOString(); active.status = "stopped"; }
      store.transaction((state) => { if (state.recordings[recordingId]) { state.recordings[recordingId].status = "stopped"; state.recordings[recordingId].stoppedAt = new Date().toISOString(); } });
      await persistStateBestEffort("Stop live recording metadata");
      return send(res, 200, { recording: store.state.recordings[recordingId] });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/recordings/") && url.pathname.endsWith("/save")) {
      const recordingId = url.pathname.split("/")[3];
      const meta = store.state.recordings[recordingId];
      if (!canAccessRecording(req, meta)) return send(res, 404, { error: "Recording not found" });
      const active = activeRecordings.get(meta.deviceId);
      const filePath = active && active.id === recordingId ? active.filePath : recordingFilePath(recordingId);
      if (active && !active.stoppedAt) { active.stoppedAt = new Date().toISOString(); active.status = "saved"; }
      const fullMeta = { ...meta, ...(active || {}), filePath };
      const githubResult = await persistRecordingToGithub(fullMeta);
      store.transaction((state) => { if (state.recordings[recordingId]) Object.assign(state.recordings[recordingId], { status: "saved", savedAt: new Date().toISOString(), size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0, frameCount: active ? active.frameCount : state.recordings[recordingId].frameCount, githubPath: fullMeta.githubPath, githubSaved: !githubResult.skipped, githubReason: githubResult.reason || null }); });
      activeRecordings.delete(meta.deviceId);
      await persistStateBestEffort("Save live recording metadata");
      return send(res, 200, { recording: store.state.recordings[recordingId], github: githubResult });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/recordings/") && url.pathname.endsWith("/download")) {
      const recordingId = url.pathname.split("/")[3];
      const recording = store.state.recordings[recordingId];
      if (!canAccessRecording(req, recording)) return send(res, 404, { error: "Recording not found" });
      const filePath = recordingFilePath(recordingId);
      if (!fs.existsSync(filePath)) return send(res, 404, { error: "Recording file is not available on this server instance. Check GitHub recording path.", githubPath: recording.githubPath });
      res.writeHead(200, { "Content-Type": recording.contentType || "multipart/x-mixed-replace; boundary=cp-device-frame", "Content-Disposition": `attachment; filename="${safeFileName(recording.name || recording.id)}.mjpeg"`, "Cache-Control": "no-store" });
      return fs.createReadStream(filePath).pipe(res);
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/recordings/")) {
      const recordingId = url.pathname.split("/").pop();
      const recording = store.state.recordings[recordingId];
      if (!canAccessRecording(req, recording)) return send(res, 404, { error: "Recording not found" });
      const github = persistenceStore.github;
      if (github && github.enabled() && recording.githubPath) { try { await github.deleteFile(recording.githubPath, `Delete CP DEVICE recording ${recording.id}`); } catch (error) { store.state.audit.push({ at: new Date().toISOString(), type: "recording.github.delete.failed", error: error.message }); } }
      const filePath = recordingFilePath(recordingId);
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
      activeRecordings.delete(recording.deviceId);
      store.transaction((state) => { delete state.recordings[recordingId]; });
      await persistStateBestEffort("Delete live recording metadata");
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, store.state);

    if (req.method === "POST" && url.pathname.startsWith("/api/devices/") && url.pathname.endsWith("/subscription-override")) {
      const parts = url.pathname.split("/");
      const deviceId = parts[3];
      const device = store.state.devices[deviceId];
      if (!device) return send(res, 404, { error: "Device not found" });
      const body = await parseJsonBody(req);
      const active = body.active === true;
      store.transaction((state) => {
        const d = state.devices[deviceId];
        if (!d) throw new Error("Unknown device");
        if (active) {
          d.subscriptionOverride = { active: true, grantedBy: "admin", updatedAt: new Date().toISOString() };
          state.audit.push({ at: new Date().toISOString(), type: "admin.device.subscription.override", deviceId, details: "enabled" });
        } else {
          delete d.subscriptionOverride;
          state.audit.push({ at: new Date().toISOString(), type: "admin.device.subscription.override", deviceId, details: "disabled" });
        }
      });
      await persistState("Update admin device subscription override");
      return send(res, 200, { ok: true, device: store.state.devices[deviceId] });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/devices/")) {
      const deviceId = url.pathname.split("/").pop();
      if (!store.state.devices[deviceId]) return send(res, 404, { error: "Device not found" });
      const removal = queueDeviceRemoval(deviceId, "admin");
      await persistStateBestEffort(removal.queued ? "Queue admin device unenroll" : "Remove admin device");
      return send(res, 200, { ok: true, ...removal, message: removal.queued ? "Authorized unenroll queued. The agent will release Device Owner/Admin restrictions, then the dashboard record will be removed." : "Device removed." });
    }

    if (req.method === "POST" && url.pathname === "/api/files") {
      const fileName = safeFileName(req.headers["x-file-name"] || "upload.bin");
      const contentType = req.headers["content-type"] || "application/octet-stream";
      const data = await readRawBody(req);
      const fileId = `file_${crypto.randomBytes(12).toString("hex")}`;
      fs.writeFileSync(path.join(FILE_DIR, fileId), data);
      store.transaction((state) => {
        state.files[fileId] = { id: fileId, name: fileName, size: data.length, contentType, sourceDeviceId: null, createdAt: new Date().toISOString() };
      });
      await persistState("Store admin uploaded file metadata");
      return send(res, 201, store.state.files[fileId]);
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/files/")) {
      return serveStoredFile(res, url.pathname.split("/").pop());
    }
    if (req.method === "POST" && url.pathname === "/api/admin/enroll-browser") {
      const body = await parseJsonBody(req);
      const enrollment = registry.enroll({
        platform: body.platform,
        name: body.name,
        serial: body.serial,
        ownerConsent: body.ownerConsent === true,
        capabilities: body.capabilities || {},
        info: {
          ...(body.info || {}),
          enrollmentMode: "browser-assisted",
          enrollmentLimit: "Browser enrollment captures web-visible device details only. Native MDM profile or agent is required for serial, admin shell, remote screen, camera, app, and firmware control."
        }
      });
      await persistState("Admin browser enroll device");
      return send(res, 201, enrollment);
    }

    if (req.method === "POST" && url.pathname === "/api/commands") {
      const body = await parseJsonBody(req);
      const deviceIds = Array.isArray(body.deviceIds) ? body.deviceIds : [];
      const devices = deviceIds.map((id) => store.state.devices[id]);
      if (!devices.length || devices.some((device) => !device)) return send(res, 400, { error: "Valid deviceIds are required" });
      for (const device of devices) {
        const capabilityError = assertCommandAllowed(device, body.type);
        if (capabilityError) return send(res, 400, { error: capabilityError });
      }
      const command = registry.createCommand(deviceIds, body.type, body.payload || {});
      await persistStateBestEffort("Queue admin device command");
      return send(res, 201, command);
    }

    if (req.method === "POST" && url.pathname === "/api/sync/github") {
      return send(res, 200, await registry.sync("Manual CP DEVICE sync"));
    }

    send(res, 404, { error: "Not found" });
  } catch (error) {
    sendError(res, error);
  }
}

function requestHandler(req, res) {
  try {
    if (req.url.startsWith("/api/")) {
      return Promise.resolve(handleApi(req, res)).catch((error) => sendError(res, error));
    }
    if (!serveStatic(req, res)) send(res, 404, { error: "Not found" });
  } catch (error) {
    sendError(res, error);
  }
}

const server = http.createServer(requestHandler);

server.on("upgrade", (req, socket) => {
  if (req.url.startsWith("/ws/")) return handleWebSocket(req, socket);
  socket.end();
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`CP DEVICE MDM listening on port ${PORT}`);
  });
}

module.exports = requestHandler;












