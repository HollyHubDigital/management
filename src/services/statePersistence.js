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
      try {
        const state = await this.supabase.pullState();
        if (state && !state.skipped && hasMeaningfulPersistedState(state)) {
          return state;
        }
      } catch (error) {
        // Fall through to GitHub fallback if available.
      }
    }

    if (this.github.enabled()) {
      const state = await this.github.pullState();
      if (state && !state.skipped) {
        return state;
      }
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
    let primaryResult = null;

    if (this.supabase.enabled()) {
      try {
        primaryResult = await this.supabase.pushState(state, message);
      } catch (error) {
        primaryResult = { skipped: true, reason: `Supabase persistence failed: ${error.message}` };
      }
    }

    if (this.github.enabled()) {
      const payload = this.supabase.enabled() ? this.githubPartialState(state) : state;
      const json = JSON.stringify(payload, null, 2);
      if (json !== this.lastGithubJson) {
        try {
          primaryResult = await this.github.pushState(payload, this.supabase.enabled() ? `GitHub backup: ${message}` : message);
          this.lastGithubJson = json;
        } catch (error) {
          if (!primaryResult) primaryResult = { skipped: true, reason: `GitHub persistence failed: ${error.message}` };
          else primaryResult.githubError = error.message;
        }
      } else if (!primaryResult) {
        primaryResult = { ok: true, reason: "GitHub state unchanged" };
      }
    }

    if (primaryResult) return primaryResult;
    return { skipped: true, reason: "No persistence configured" };
  }
}

module.exports = { StatePersistence };
