const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { JsonStore } = require("../src/lib/store");
const { GitHubStore } = require("../src/services/githubStore");
const { DeviceRegistry } = require("../src/services/deviceRegistry");
const { hashPassword, verifyPassword } = require("../src/lib/security");

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

const userStore = new JsonStore(path.join(dataDir, "user-state.json"));
userStore.load();
const savedUser = { id: "usr_test", email: "user@example.com", username: "tester", phone: "+15551234567", passwordHash: hashPassword("old-pass"), role: "user" };
userStore.transaction((state) => {
  state.users[savedUser.id] = savedUser;
  state.subscriptions[savedUser.id] = { plan: "free", expiresAt: null };
});
const snapshot = JSON.parse(JSON.stringify(userStore.state));
const coldStore = new JsonStore(path.join(dataDir, "cold-state.json"));
coldStore.replaceState(snapshot);
const restored = Object.values(coldStore.state.users).find((user) => user.email === "user@example.com" || user.username === "tester");
assert.ok(restored, "user should restore from persisted state");
assert.ok(verifyPassword("old-pass", restored.passwordHash), "old password should verify after restore");
coldStore.transaction((state) => { state.users[restored.id].passwordHash = hashPassword("new-pass"); });
assert.ok(verifyPassword("new-pass", coldStore.state.users[restored.id].passwordHash), "new password should replace old password");
assert.ok(!verifyPassword("old-pass", coldStore.state.users[restored.id].passwordHash), "old password should stop working after reset");

fs.rmSync(dataDir, { recursive: true, force: true });
console.log("All tests passed");