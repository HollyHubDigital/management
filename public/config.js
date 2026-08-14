const BACKEND_BASE_URL = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? window.location.origin
  : "https://shied.onrender.com";

window.CP_DEVICE_CONFIG = window.CP_DEVICE_CONFIG || {
  API_BASE_URL: BACKEND_BASE_URL,
  LIVE_BASE_URL: BACKEND_BASE_URL
};
