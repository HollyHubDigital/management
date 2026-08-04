const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'audit.log');
fs.mkdirSync(LOG_DIR, { recursive: true });

function appendAudit(entry) {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {
    // best-effort
    console.error('Failed to write audit log', e.message);
  }
}

module.exports = { appendAudit };
