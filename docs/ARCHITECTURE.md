# CP DEVICE Production Architecture

CP DEVICE is a consent-based MDM control plane for enrolled Android and iOS devices.

## Security boundaries

- Devices must enroll with `CP_DEVICE_ENROLLMENT_SECRET` and explicit `ownerConsent: true`.
- Admin APIs require `Authorization: Bearer <CP_DEVICE_ADMIN_TOKEN>`.
- iOS cannot provide arbitrary silent shell access or full remote control through public MDM APIs.
- Android shell/control requires a managed device-owner app, OEM privileges, root, or an ADB-managed deployment.
- Camera and screen sessions must be user/owner approved unless the deployment is a lawful fully managed kiosk environment.

## Runtime pieces

- `src/server.js` serves the API and desktop-only dashboard.
- `src/services/deviceRegistry.js` manages enrollment, telemetry, batch commands, command completion, and audit entries.
- `src/services/githubStore.js` persists state to GitHub when `GITHUB_TOKEN`, `GITHUB_OWNER`, and `GITHUB_REPO` are configured.
- `src/device-agents/android-agent.js` is the Android agent runtime contract around a real native bridge.
- `src/device-agents/ios-agent.js` is the iOS MDM/ReplayKit runtime contract.

## Run

1. Copy `.env.example` to `.env` and replace both secrets.
2. Load environment variables into the shell.
3. Run `npm start`.
4. Open `https://admin-device-management.vercel.app` on a desktop browser.

## Enroll a device

`POST /api/enroll`

```json
{
  "enrollmentSecret": "secret",
  "platform": "android",
  "name": "Warehouse-01",
  "serial": "ABC123",
  "ownerConsent": true,
  "capabilities": {
    "screenControl": true,
    "camera": true,
    "shell": true
  }
}
```

The response returns `deviceId` and a one-time device token. Store that token only in the managed device agent secure storage.

## Production hardening still required

- Put the server behind HTTPS with a trusted certificate.
- Replace static admin bearer auth with SSO and role-based authorization.
- Store device tokens in HSM/KMS-backed secrets storage.
- Use WebRTC/SFU infrastructure for screen and camera media paths.
- Use APNs/Apple MDM protocol for iOS production enrollment and commands.
- Build signed native Android/iOS agents for device-side execution.

## Agent / BOT enrollment UX

The dashboard `Enroll` button opens a consent modal and then downloads the platform enrollment artifact:

- Android: `artifacts/cp-device-agent.apk`, served by `/api/enrollment/android-agent`.
- iOS: `artifacts/cp-device-enrollment.mobileconfig`, served by `/api/enrollment/ios-profile`.

A web page cannot silently install software, grant Device Admin, become Device Owner, read IMEI/serial, or obtain remote-control permissions. Production enrollment must use OS-approved flows:

- Android Enterprise QR enrollment, zero-touch enrollment, OEMConfig, managed Google Play, ADB provisioning, or user-approved APK install plus Device Admin where applicable.
- iOS/iPadOS Apple MDM enrollment using a signed `.mobileconfig`, Apple Business Manager/School Manager, APNs MDM certificate, and supervised-device enrollment for advanced controls.

The CP DEVICE web flow records browser-visible details immediately, then the downloaded signed agent/profile completes privileged enrollment after the user/organization approves it.
