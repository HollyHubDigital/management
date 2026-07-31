const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { JsonStore } = require("../src/lib/store");
const { GitHubStore } = require("../src/services/githubStore");
const { DeviceRegistry } = require("../src/services/deviceRegistry");

const dataDir = path.join(process.cwd(), ".cp-device-data-test");
fs.rmSync(dataDir, { recursive: true, force: true });
const store = new JsonStore(path.join(dataDir, "state.json"));
store.load();
const registry = new DeviceRegistry(store, new GitHubStore({}), "secret");

const enrollment = registry.enroll({ platform: "android", name: "A1", serial: "S1", ownerConsent: true });
assert.ok(enrollment.deviceId);
assert.ok(registry.authenticate(enrollment.deviceId, enrollment.token));
registry.heartbeat(enrollment.deviceId, { info: { battery: 88 }, operation: { cpu: 12 }, alerts: [] });
const command = registry.createCommand([enrollment.deviceId], "shell", { command: "id" });
assert.strictEqual(registry.pullCommands(enrollment.deviceId).length, 1);
registry.completeCommand(enrollment.deviceId, command.id, { ok: true, output: "done" });
assert.strictEqual(registry.pullCommands(enrollment.deviceId).length, 0);
assert.strictEqual(store.state.commands[command.id].status, "completed");
fs.rmSync(dataDir, { recursive: true, force: true });
console.log("All tests passed");
