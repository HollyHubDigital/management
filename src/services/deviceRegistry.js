const { hashToken, randomId, signPayload } = require("../lib/security");

class DeviceRegistry {
  constructor(store, persistenceStore, enrollmentSecret) {
    this.store = store;
    this.persistenceStore = persistenceStore;
    this.enrollmentSecret = enrollmentSecret;
  }

  persist(message) {
    this.persistenceStore.pushState(this.store.state, message).catch(() => {});
  }

  enroll(input) {
    const required = ["platform", "name", "serial", "ownerConsent"];
    for (const key of required) if (!input[key]) throw new Error(`Missing ${key}`);
    if (!["android", "ios"].includes(input.platform)) throw new Error("Unsupported platform");
    if (input.ownerConsent !== true) throw new Error("Owner consent is required");
    const deviceId = randomId("dev");
    const token = randomId("tok");
    const now = new Date().toISOString();
    const device = {
      id: deviceId,
      platform: input.platform,
      name: input.name,
      serial: input.serial,
      enrolledAt: now,
      lastSeenAt: now,
      status: "online",
      capabilities: input.capabilities || {},
      tokenHash: hashToken(token),
      info: input.info || {},
      alerts: []
    };
    this.store.transaction((state) => {
      state.devices[deviceId] = device;
      state.audit.push({ at: now, type: "device.enrolled", deviceId, platform: input.platform });
    });
    return { deviceId, token, signature: signPayload({ deviceId, serial: input.serial }, this.enrollmentSecret) };
  }

  authenticate(deviceId, token) {
    const device = this.store.state.devices[deviceId];
    return Boolean(device && device.tokenHash === hashToken(token));
  }

  heartbeat(deviceId, telemetry) {
    const now = new Date().toISOString();
    const device = this.store.transaction((state) => {
      const current = state.devices[deviceId];
      if (!current) throw new Error("Unknown device");
      current.lastSeenAt = now;
      current.status = "online";
      current.info = { ...current.info, ...(telemetry.info || {}) };
      if (telemetry.deviceDetails && typeof telemetry.deviceDetails === "object") current.deviceDetails = { ...(current.deviceDetails || {}), ...telemetry.deviceDetails, updatedAt: now };
      current.ownerUserId ||= current.userId || current.user_id || current.ownerId;
      current.userId ||= current.ownerUserId;
      current.user_id ||= current.ownerUserId;
      const manufacturer = current.info.manufacturer || "";
      const model = current.info.model || "";
      if (manufacturer || model) current.name = `${manufacturer} ${model}`.trim();
      if (current.info.androidVersion) current.version = `Android ${current.info.androidVersion}`;
      current.capabilities = { ...(current.capabilities || {}), ...(telemetry.capabilities || {}) };
      current.operation = telemetry.operation || current.operation || {};
      current.alerts = telemetry.alerts || [];
      return current;
    });
    return device;
  }

  createCommand(deviceIds, type, payload) {
    const commandId = randomId("cmd");
    const now = new Date().toISOString();
    const command = this.store.transaction((state) => {
      for (const deviceId of deviceIds) if (!state.devices[deviceId]) throw new Error(`Unknown device ${deviceId}`);
      state.commands[commandId] = { id: commandId, deviceIds, type, payload, status: "queued", results: {}, createdAt: now };
      state.audit.push({ at: now, type: "command.queued", commandId, commandType: type, deviceIds });
      return state.commands[commandId];
    });
    return command;
  }

  pullCommands(deviceId) {
    return Object.values(this.store.state.commands).filter((command) => {
      return command.deviceIds.includes(deviceId) && !command.results[deviceId];
    });
  }

  completeCommand(deviceId, commandId, result) {
    const command = this.store.transaction((state) => {
      const current = state.commands[commandId];
      if (!current || !current.deviceIds.includes(deviceId)) throw new Error("Unknown command");
      // Normalize result.output if it's a JSON string so UI gets consistent shapes
      const normalized = { ...result };
      if (typeof normalized.output === "string") {
        try {
          const parsed = JSON.parse(normalized.output);
          normalized.output = parsed;
        } catch (e) {
          // leave as string if it's not valid JSON
        }
      }
      // If the agent returned a files list inside output, normalize to top-level files
      if (normalized.output && Array.isArray(normalized.output.files) && !normalized.files) {
        normalized.files = normalized.output.files;
      }

      // Additional normalization for locate.device: accept variations
      try {
        const cmdType = current.type;
        if (cmdType === 'locate.device' && normalized.output) {
          const o = normalized.output;
          const out = {};
          // common shapes: {lat,lng}, {latitude,longitude}, {coords:{lat,lon}}, string "lat,lng"
          if (typeof o === 'string') {
            const m = o.match(/([-+]?\d+\.?\d*)[, ]+([-+]?\d+\.?\d*)/);
            if (m) { out.lat = parseFloat(m[1]); out.lng = parseFloat(m[2]); }
          } else if (typeof o === 'object') {
            if (Number.isFinite(o.lat) && Number.isFinite(o.lng)) { out.lat = o.lat; out.lng = o.lng; out.accuracy = o.accuracy; }
            else if (Number.isFinite(o.latitude) && Number.isFinite(o.longitude)) { out.lat = o.latitude; out.lng = o.longitude; out.accuracy = o.accuracy; }
            else if (o.coords && (Number.isFinite(o.coords.lat) || Number.isFinite(o.coords.latitude))) {
              out.lat = o.coords.lat || o.coords.latitude; out.lng = o.coords.lng || o.coords.longitude || o.coords.lon; out.accuracy = o.coords.accuracy || o.accuracy;
            }
          }
          if (Number.isFinite(out.lat) && Number.isFinite(out.lng)) normalized.output = out;
        }
      } catch (e) {
        // ignore normalization errors
      }

      normalized.completedAt = new Date().toISOString();
      if (current.type === "device.info.refresh" && normalized.output && typeof normalized.output === "object") {
        const device = state.devices[deviceId];
        if (device) device.deviceDetails = { ...(device.deviceDetails || {}), ...normalized.output, updatedAt: new Date().toISOString() };
      }
      current.results[deviceId] = normalized;
      current.status = current.deviceIds.every((id) => current.results[id]) ? "completed" : "running";
      // Log unexpected output shapes for later inspection
      if (normalized.output && typeof normalized.output !== 'object') {
        current.audit = current.audit || [];
        current.audit.push({ at: new Date().toISOString(), deviceId, note: 'agent.output-not-object', sample: String(normalized.output).slice(0, 200) });
      }
      return current;
    });
    return command;
  }

  async sync(message) {
    return this.persistenceStore.pushState(this.store.state, message);
  }
}

module.exports = { DeviceRegistry };
