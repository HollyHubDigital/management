# Managed Google Play / Android Enterprise Deployment

CP DEVICE Agent should be distributed as an enterprise-managed app, not as an anonymous browser sideload, because it requests high-risk management permissions for authorized device administration.

## Recommended production path

1. Create a stable release signing key and keep it private.
2. Publish the APK as a Managed Google Play private app in Google Play Console.
3. Complete Play Console Data Safety and permissions declarations honestly:
   - Accessibility is used for user-approved remote touch/control sessions.
   - Camera is used for user-approved live camera sessions.
   - Screen capture is started only after Android MediaProjection consent.
   - Location is used for requested device location.
   - Files access is used for requested file transfer.
   - Device Admin is used for supported device lock actions.
4. Enroll company devices with Android Enterprise:
   - QR provisioning for Device Owner during setup.
   - Zero-touch enrollment through a reseller for fleet deployment.
   - ADB `dpm set-device-owner` only for lab/test devices before user setup.
5. Configure your EMM/MDM policy to install CP DEVICE Agent from Managed Google Play.
6. Keep the backend URL on HTTPS only: `https://admin-device-management.vercel.app`.

## What this does not do

This does not bypass Google Play Protect. It reduces false-positive risk by using the approved enterprise distribution model, removing unused Device Admin policies, using HTTPS-only traffic, and showing clear consent disclosures.

## Current Device Admin policies

The app declares only:

- `force-lock`

Unused high-risk policies such as wipe, reset password, disable camera, and encrypted-storage are intentionally not declared because current CP DEVICE logic does not use them.

## Privacy policy starter text

Use this as a starting point for your public privacy policy page and adapt it to your company/legal requirements:

CP DEVICE Agent is an enterprise device management app used only on devices owned by the user or organization and enrolled with consent. The app may collect device identifiers, model/version information, online status, operational telemetry, location when requested, files selected/requested for transfer, camera stream data during active sessions, and screen capture data during active sessions. Data is sent securely to the configured CP DEVICE management server for authorized dashboard access. Remote control features require explicit Android permissions such as Device Admin, Accessibility, Camera, Files, Location, and MediaProjection screen-capture consent. Users or administrators can remove the app/enrollment according to the organization's device policy.