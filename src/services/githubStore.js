const https = require("https");

function requestJson(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let json = {};
        try { json = data ? JSON.parse(data) : {}; } catch { json = { message: data || `GitHub HTTP ${res.statusCode}` }; }
        if (res.statusCode >= 400) return reject(new Error(json.message || `GitHub HTTP ${res.statusCode}`));
        resolve(json);
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

class GitHubStore {
  constructor(env) {
    this.token = env.GITHUB_TOKEN;
    this.owner = env.GITHUB_OWNER;
    this.repo = env.GITHUB_REPO;
    if (this.repo && this.repo.includes("/")) {
      const [repoOwner, repoName] = this.repo.split("/");
      this.owner ||= repoOwner;
      this.repo = repoName;
    }
    this.branch = env.GITHUB_BRANCH || "main";
    this.path = env.GITHUB_DATA_PATH || "cp-device/state.json";
  }

  enabled() {
    return Boolean(this.token && this.owner && this.repo);
  }

  headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cp-device-mdm",
      "X-GitHub-Api-Version": "2022-11-28"
    };
  }

  contentPath() {
    return `/repos/${this.owner}/${this.repo}/contents/${this.path}`;
  }

  contentPathFor(filePath) {
    const normalized = String(filePath || "").replace(/^\/+/, "");
    return `/repos/${this.owner}/${this.repo}/contents/${normalized}`;
  }

  async pullState() {
    if (!this.enabled()) return { skipped: true, reason: "GitHub storage is not configured" };
    try {
      const existing = await requestJson({ hostname: "api.github.com", path: `${this.contentPath()}?ref=${this.branch}`, method: "GET", headers: this.headers() });
      const raw = Buffer.from(existing.content || "", "base64").toString("utf8");
      return raw ? JSON.parse(raw) : {};
    } catch (error) {
      if (String(error.message).includes("Not Found")) return {};
      throw error;
    }
  }

  async pushState(state, message = "Update Shield Device Agent state") {
    if (!this.enabled()) return { skipped: true, reason: "GitHub storage is not configured" };
    const headers = this.headers();
    let sha;
    try {
      const existing = await requestJson({ hostname: "api.github.com", path: `${this.contentPath()}?ref=${this.branch}`, method: "GET", headers });
      sha = existing.sha;
    } catch (error) {
      if (!String(error.message).includes("Not Found")) throw error;
    }
    const content = Buffer.from(JSON.stringify(state, null, 2)).toString("base64");
    return requestJson(
      { hostname: "api.github.com", path: this.contentPath(), method: "PUT", headers: { ...headers, "Content-Type": "application/json" } },
      { message, content, branch: this.branch, sha }
    );
  }

  async pushFile(filePath, data, message = "Store Shield Device Agent file") {
    if (!this.enabled()) return { skipped: true, reason: "GitHub storage is not configured" };
    const headers = this.headers();
    const apiPath = this.contentPathFor(filePath);
    let sha;
    try {
      const existing = await requestJson({ hostname: "api.github.com", path: `${apiPath}?ref=${this.branch}`, method: "GET", headers });
      sha = existing.sha;
    } catch (error) {
      if (!String(error.message).includes("Not Found")) throw error;
    }
    const content = Buffer.from(data).toString("base64");
    return requestJson(
      { hostname: "api.github.com", path: apiPath, method: "PUT", headers: { ...headers, "Content-Type": "application/json" } },
      { message, content, branch: this.branch, sha }
    );
  }

  async deleteFile(filePath, message = "Delete Shield Device Agent file") {
    if (!this.enabled()) return { skipped: true, reason: "GitHub storage is not configured" };
    const headers = this.headers();
    const apiPath = this.contentPathFor(filePath);
    const existing = await requestJson({ hostname: "api.github.com", path: `${apiPath}?ref=${this.branch}`, method: "GET", headers });
    return requestJson(
      { hostname: "api.github.com", path: apiPath, method: "DELETE", headers: { ...headers, "Content-Type": "application/json" } },
      { message, branch: this.branch, sha: existing.sha }
    );
  }
}

module.exports = { GitHubStore };
