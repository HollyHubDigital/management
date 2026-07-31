class IosAgentRuntime {
  constructor({ mdmProvider, replayKitBridge }) {
    this.mdmProvider = mdmProvider;
    this.replayKitBridge = replayKitBridge;
  }

  async execute(command) {
    const handlers = {
      "mdm.device.info": () => this.mdmProvider.requestDeviceInformation(command.payload),
      "app.install": () => this.mdmProvider.installApplication(command.payload),
      "app.remove": () => this.mdmProvider.removeApplication(command.payload),
      "firmware.update": () => this.mdmProvider.scheduleOsUpdate(command.payload),
      "camera.stream.request": () => this.replayKitBridge.requestUserApprovedCameraSession(command.payload),
      "screen.share.request": () => this.replayKitBridge.requestUserApprovedScreenShare(command.payload)
    };
    if (!handlers[command.type]) throw new Error(`Unsupported iOS command: ${command.type}`);
    return handlers[command.type]();
  }
}

module.exports = { IosAgentRuntime };
