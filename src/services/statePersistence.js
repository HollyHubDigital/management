const { GitHubStore } = require("./githubStore");
const { SupabaseStore } = require("./supabaseStore");

function hasMeaningfulPersistedState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  return Object.entries(state).some(([key, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") return Object.keys(value).length > 0;
    return Boolean(value);
  });
}

class StatePersistence {
  constructor(env = {}) {
    this.supabase = new SupabaseStore(env);
    this.github = new GitHubStore(env);
    this.lastGithubJson = null;
  }

  enabled() {
    return this.supabase.enabled() || this.github.enabled();
  }

  async pullState() {
    if (this.supabase.enabled()) {
      const state = await this.supabase.pullState();
      if (state && !state.skipped) return state;
      return { skipped: true, reason: "Supabase returned no state" };
    }

    if (this.github.enabled()) {
      const state = await this.github.pullState();
      if (state && !state.skipped) return state;
    }

    return { skipped: true, reason: "No persistence configured" };
  }

  githubPartialState(state) {
    return {
      users: state.users || {},
      devices: state.devices || {}
    };
  }

  async pushState(state, message = "Update CP DEVICE state") {
    if (this.supabase.enabled()) {
      return this.supabase.pushState(state, message);
    }

    if (this.github.enabled()) {
      const json = JSON.stringify(state, null, 2);
      if (json === this.lastGithubJson) return { ok: true, reason: "GitHub state unchanged" };
      const result = await this.github.pushState(state, message);
      this.lastGithubJson = json;
      return result;
    }

    return { skipped: true, reason: "No persistence configured" };
  }
}

module.exports = { StatePersistence };
