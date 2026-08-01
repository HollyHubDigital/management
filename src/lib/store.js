const fs = require("fs");
const path = require("path");

function defaultState() {
  return { devices: {}, commands: {}, audit: [], files: {}, apps: {}, firmware: {}, users: {}, sessions: {}, payments: {}, subscriptions: {} };
}

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = defaultState();
  }

  normalize() {
    this.state = { ...defaultState(), ...(this.state || {}) };
    this.state.devices ||= {};
    this.state.commands ||= {};
    this.state.audit ||= [];
    this.state.files ||= {};
    this.state.apps ||= {};
    this.state.firmware ||= {};
    this.state.users ||= {};
    this.state.sessions ||= {};
    this.state.payments ||= {};
    this.state.subscriptions ||= {};
    return this.state;
  }

  replaceState(nextState) {
    this.state = { ...defaultState(), ...(nextState || {}) };
    this.normalize();
    this.save();
    return this.state;
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (fs.existsSync(this.filePath)) {
      this.state = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.normalize();
    } else {
      this.save();
    }
    return this.state;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.normalize(), null, 2));
    if (fs.existsSync(this.filePath)) fs.rmSync(this.filePath, { force: true });
    fs.renameSync(tempPath, this.filePath);
  }

  transaction(mutator) {
    const result = mutator(this.state);
    this.save();
    return result;
  }
}

module.exports = { JsonStore, defaultState };