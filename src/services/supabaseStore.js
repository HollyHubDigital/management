const { createClient } = require('@supabase/supabase-js');

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
        value: state,
        updated_at: new Date().toISOString(),
        message
      };

      const { data, error } = await this.supabase
        .from('app_state')
        .upsert(payload, { onConflict: 'key' })
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      if (String(error.message).includes('does not exist') || String(error.message).includes('relation')) {
        const deviceEntries = Object.values(state.devices || {});
        for (const device of deviceEntries) {
          try {
            await this.upsertDevice(device);
          } catch (deviceError) {
            // Ignore individual device persistence failures and keep the local JSON store authoritative.
          }
        }
        return { skipped: true, reason: error.message };
      }
      throw error;
    }
  }

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
          user_id: device.user_id || null,
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
}

module.exports = { SupabaseStore };