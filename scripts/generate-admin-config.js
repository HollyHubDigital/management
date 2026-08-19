const fs = require("fs");
const path = require("path");

const apiBaseUrl = (process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/$/, "");
const liveBaseUrl = (process.env.LIVE_BASE_URL || process.env.NEXT_PUBLIC_LIVE_BASE_URL || apiBaseUrl).replace(/\/$/, "");

const config = `window.CP_DEVICE_CONFIG = Object.freeze({\n  API_BASE_URL: ${JSON.stringify(apiBaseUrl)},\n  LIVE_BASE_URL: ${JSON.stringify(liveBaseUrl)}\n});\n`;

fs.writeFileSync(path.join(__dirname, "..", "public", "config.js"), config);
console.log(apiBaseUrl ? "Generated admin frontend config from environment." : "Generated admin frontend config without API_BASE_URL; frontend will use same-origin fallback.");
