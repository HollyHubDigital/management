const { createClient } = require('@supabase/supabase-js');

function compactStateForPersistence(state) {
  const latestCommands = Object.fromEntries(Object.entries(state.commands || {}).slice(-25));
  const latestFiles = Object.fromEntries(Object.entries(state.files || {}).slice(-40).map(([id, file]) => [id, { ...file, contentBase64: undefined }]));
  return {
    devices: state.devices || {},
    commands: latestCommands,
    audit: (state.audit || []).slice(-20),
    files: latestFiles,
    apps: state.apps || {},
    firmware: state.firmware || {},
    users: state.users || {},
    // sessions are now primarily stored in the dedicated "sessions" table
    // we keep a small copy here only as backup
    sessions: state.sessions || {},
    payments: state.payments || {},
    subscriptions: state.subscriptions || {}
  };
}

class SupabaseStore {
  constructor(env = {}) {
    this.supabase = null;
    this.lastError = null;

    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_ROLE_KEY;

    if (url && key) {
      try {
        this.supabase = createClient(url, key);
      } catch (error) {
        this.lastError = error;
      }
    }
  }

  enabled() {
    return Boolean(this.supabase);
  }

  // ======================
  // EXISTING STATE METHODS
  // ======================

  async pullState() {
    if (!this.enabled()) return { skipped: true, reason: 'Supabase storage is not configured' };

    try {
      const { data, error } = await this.supabase
        .from('app_state')
        .select('*')
        .eq('key', 'state')
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data?.value || {};
    } catch (error) {
      if (String(error.message).includes('does not exist') || String(error.message).includes('relation')) {
        return {};
      }
      throw error;
    }
  }

  async pushState(state, message = 'Update CP DEVICE state') {
    if (!this.enabled()) return { skipped: true, reason: 'Supabase storage is not configured' };

    try {
      const payload = {
        key: 'state',
        value: compactStateForPersistence(state),
        updated_at: new Date().toISOString(),
        message
      };

      const { data: updated, error: updateError } = await this.supabase
        .from('app_state')
        .update({ value: payload.value, updated_at: payload.updated_at, message: payload.message })
        .eq('key', payload.key)
        .select()
        .maybeSingle();

      if (updateError) throw updateError;
      if (updated) return updated;

      const { data: inserted, error: insertError } = await this.supabase
        .from('app_state')
        .insert(payload)
        .select()
        .single();

      if (insertError) throw insertError;
      return inserted;
    } catch (error) {
      if (String(error.message).includes('does not exist') || String(error.message).includes('relation')) {
        const deviceEntries = Object.values(state.devices || {});
        for (const device of deviceEntries) {
          try {
            await this.upsertDevice(device);
          } catch (deviceError) {
            // Ignore individual device persistence failures
          }
        }
        return { skipped: true, reason: error.message };
      }
      throw error;
    }
  }

  // ======================
  // DEVICE METHODS (unchanged)
  // ======================

  async getAllDevices() {
    if (!this.enabled()) return [];

    const { data, error } = await this.supabase
      .from('devices')
      .select('*')
      .order('last_heartbeat', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async getDevice(deviceId) {
    if (!this.enabled()) return null;

    const { data, error } = await this.supabase
      .from('devices')
      .select('*')
      .eq('device_id', deviceId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  }

  async upsertDevice(device) {
    if (!this.enabled()) return null;

    const { data, error } = await this.supabase
      .from('devices')
      .upsert(
        {
          device_id: device.device_id || device.id,
          platform: device.platform,
          name: device.name,
          serial: device.serial,
          status: device.status || 'online',
          last_heartbeat: device.last_seen_at || device.lastHeartbeat || device.lastSeenAt || device.last_heartbeat || new Date().toISOString(),
          enrolled_at: device.enrolled_at || device.enrolledAt || new Date().toISOString(),
          token_hash: device.token_hash || device.tokenHash,
          info: device.info || {},
          capabilities: device.capabilities || {},
          alerts: device.alerts || [],
          user_id: device.user_id || device.userId || device.ownerUserId || null,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'device_id' }
      )
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateHeartbeat(deviceId, telemetry = {}) {
    if (!this.enabled()) return null;

    const { data, error } = await this.supabase
      .from('devices')
      .update({
        status: 'online',
        last_heartbeat: new Date().toISOString(),
        info: telemetry.info || undefined,
        capabilities: telemetry.capabilities || undefined,
        alerts: telemetry.alerts || undefined,
        updated_at: new Date().toISOString()
      })
      .eq('device_id', deviceId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  // ======================
  // NEW SESSION METHODS
  // ======================

  async createSession({ token, userId, role = 'user', expiresAt }) {
    if (!this.enabled()) return null;

    const { data, error } = await this.supabase
      .from('sessions')
      .upsert(
        {
          token,
          user_id: userId,
          role,
          created_at: new Date().toISOString(),
          expires_at: expiresAt
        },
        { onConflict: 'token' }
      )
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async getSession(token) {
    if (!this.enabled() || !token) return null;

    const { data, error } = await this.supabase
      .from('sessions')
      .select('*')
      .eq('token', token)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return null;

    // Check if expired
    if (data.expires_at && Date.parse(data.expires_at) < Date.now()) {
      // Optionally clean up expired session
      await this.deleteSession(token).catch(() => {});
      return null;
    }

    return data;
  }

  async deleteSession(token) {
    if (!this.enabled() || !token) return false;

    const { error } = await this.supabase
      .from('sessions')
      .delete()
      .eq('token', token);

    if (error) throw error;
    return true;
  }

  async deleteSessionsByUser(userId) {
    if (!this.enabled() || !userId) return false;

    const { error } = await this.supabase
      .from('sessions')
      .delete()
      .eq('user_id', userId);

    if (error) throw error;
    return true;
  }
}

module.exports = { SupabaseStore };