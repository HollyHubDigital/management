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
      current.results[deviceId] = { ...result, completedAt: new Date().toISOString() };
      current.status = current.deviceIds.every((id) => current.results[id]) ? "completed" : "running";
      return current;
    });
    return command;
  }

  async sync(message) {
    return this.persistenceStore.pushState(this.store.state, message);
  }
}

module.exports = { DeviceRegistry };
