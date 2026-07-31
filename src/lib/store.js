const fs = require("fs");
const path = require("path");

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { devices: {}, commands: {}, audit: [], files: {}, apps: {}, firmware: {}, users: {}, sessions: {}, payments: {}, subscriptions: {} };
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (fs.existsSync(this.filePath)) {
      this.state = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.state.users ||= {};
      this.state.sessions ||= {};
      this.state.payments ||= {};
      this.state.subscriptions ||= {};
    } else {
      this.save();
    }
    return this.state;
  }

  save() {
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2));
    fs.renameSync(tempPath, this.filePath);
  }

  transaction(mutator) {
    const result = mutator(this.state);
    this.save();
    return result;
  }
}

module.exports = { JsonStore };

