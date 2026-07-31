const https = require("https");

function requestJson(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        const json = data ? JSON.parse(data) : {};
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
    this.branch = env.GITHUB_BRANCH || "main";
    this.path = env.GITHUB_DATA_PATH || "cp-device/state.json";
  }

  enabled() {
    return Boolean(this.token && this.owner && this.repo);
  }

  async pushState(state, message = "Update CP DEVICE state") {
    if (!this.enabled()) return { skipped: true, reason: "GitHub storage is not configured" };
    const basePath = `/repos/${this.owner}/${this.repo}/contents/${this.path}`;
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cp-device-mdm",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    let sha;
    try {
      const existing = await requestJson({ hostname: "api.github.com", path: `${basePath}?ref=${this.branch}`, method: "GET", headers });
      sha = existing.sha;
    } catch (error) {
      if (!String(error.message).includes("Not Found")) throw error;
    }
    const content = Buffer.from(JSON.stringify(state, null, 2)).toString("base64");
    return requestJson(
      { hostname: "api.github.com", path: basePath, method: "PUT", headers: { ...headers, "Content-Type": "application/json" } },
      { message, content, branch: this.branch, sha }
    );
  }
}

module.exports = { GitHubStore };
