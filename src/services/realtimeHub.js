class RealtimeHub {
  constructor(registry) {
    this.registry = registry;
  }

  startOfflineSweep(intervalMs = 30000, offlineAfterMs = 90000) {
    setInterval(() => {
      const now = Date.now();
      this.registry.store.transaction((state) => {
        for (const device of Object.values(state.devices)) {
          if (now - Date.parse(device.lastSeenAt || 0) > offlineAfterMs) device.status = "offline";
        }
      });
    }, intervalMs).unref();
  }
}

module.exports = { RealtimeHub };
