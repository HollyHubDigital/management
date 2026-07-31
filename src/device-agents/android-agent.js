const http = require("http");
const https = require("https");
const { URL } = require("url");

function requestJson(baseUrl, path, token, method = "GET", body) {
  const url = new URL(path, baseUrl);
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(url, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        const json = data ? JSON.parse(data) : {};
        if (res.statusCode >= 400) return reject(new Error(json.error || `HTTP ${res.statusCode}`));
        resolve(json);
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

class AndroidAgentRuntime {
  constructor({ serverUrl, deviceId, token, nativeBridge }) {
    this.serverUrl = serverUrl;
    this.deviceId = deviceId;
    this.token = token;
    this.nativeBridge = nativeBridge;
  }

  async heartbeat() {
    const info = await this.nativeBridge.getDeviceInfo();
    return requestJson(this.serverUrl, `/api/device/${this.deviceId}/heartbeat`, this.token, "POST", {
      info,
      operation: await this.nativeBridge.getOperationData(),
      alerts: await this.nativeBridge.getAlerts()
    });
  }

  async execute(command) {
    const handlers = {
      shell: () => this.nativeBridge.runManagedShell(command.payload.command),
      "file.pull": () => this.nativeBridge.pullFile(command.payload.path),
      "file.push": () => this.nativeBridge.pushFile(command.payload.path, command.payload.contentBase64),
      "app.install": () => this.nativeBridge.installPackage(command.payload.apkUrl, command.payload.sha256),
      "app.remove": () => this.nativeBridge.removePackage(command.payload.packageName),
      "firmware.update": () => this.nativeBridge.installSystemUpdate(command.payload.updateUrl, command.payload.sha256),
      "camera.stream.request": () => this.nativeBridge.requestCameraStream(command.payload),
      "screen.control.request": () => this.nativeBridge.requestScreenControl(command.payload)
    };
    if (!handlers[command.type]) throw new Error(`Unsupported Android command: ${command.type}`);
    return handlers[command.type]();
  }

  async pollOnce() {
    await this.heartbeat();
    const { commands } = await requestJson(this.serverUrl, `/api/device/${this.deviceId}/commands`, this.token);
    for (const command of commands) {
      try {
        const output = await this.execute(command);
        await requestJson(this.serverUrl, `/api/device/${this.deviceId}/commands`, this.token, "POST", { commandId: command.id, result: { ok: true, output } });
      } catch (error) {
        await requestJson(this.serverUrl, `/api/device/${this.deviceId}/commands`, this.token, "POST", { commandId: command.id, result: { ok: false, error: error.message } });
      }
    }
  }
}

module.exports = { AndroidAgentRuntime };
