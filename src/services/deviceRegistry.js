const { hashToken, randomId, signPayload } = require("../lib/security");

class DeviceRegistry {
  constructor(store, githubStore, enrollmentSecret) {
    this.store = store;
    this.githubStore = githubStore;
    this.enrollmentSecret = enrollmentSecret;
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
    this.sync("Enroll device").catch(() => {});
    return { deviceId, token, signature: signPayload({ deviceId, serial: input.serial }, this.enrollmentSecret) };
  }

  authenticate(deviceId, token) {
    const device = this.store.state.devices[deviceId];
    return Boolean(device && device.tokenHash === hashToken(token));
  }

  heartbeat(deviceId, telemetry) {
    const now = new Date().toISOString();
    return this.store.transaction((state) => {
      const device = state.devices[deviceId];
      if (!device) throw new Error("Unknown device");
      device.lastSeenAt = now;
      device.status = "online";
      device.info = { ...device.info, ...(telemetry.info || {}) };
      device.operation = telemetry.operation || device.operation || {};
      device.alerts = telemetry.alerts || [];
      return device;
    });
  }

  createCommand(deviceIds, type, payload) {
    const commandId = randomId("cmd");
    const now = new Date().toISOString();
    return this.store.transaction((state) => {
      for (const deviceId of deviceIds) if (!state.devices[deviceId]) throw new Error(`Unknown device ${deviceId}`);
      state.commands[commandId] = { id: commandId, deviceIds, type, payload, status: "queued", results: {}, createdAt: now };
      state.audit.push({ at: now, type: "command.queued", commandId, commandType: type, deviceIds });
      return state.commands[commandId];
    });
  }

  pullCommands(deviceId) {
    return Object.values(this.store.state.commands).filter((command) => {
      return command.deviceIds.includes(deviceId) && !command.results[deviceId];
    });
  }

  completeCommand(deviceId, commandId, result) {
    return this.store.transaction((state) => {
      const command = state.commands[commandId];
      if (!command || !command.deviceIds.includes(deviceId)) throw new Error("Unknown command");
      command.results[deviceId] = { ...result, completedAt: new Date().toISOString() };
      command.status = command.deviceIds.every((id) => command.results[id]) ? "completed" : "running";
      return command;
    });
  }

  async sync(message) {
    return this.githubStore.pushState(this.store.state, message);
  }
}

module.exports = { DeviceRegistry };
