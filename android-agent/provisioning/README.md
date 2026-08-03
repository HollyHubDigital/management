# Device Owner / OEM / System Privileges

## Device Owner

Android Device Owner is not a runtime permission. It must be provisioned before normal user setup, commonly by:

- Android Enterprise QR enrollment during factory reset setup
- Zero-touch enrollment
- NFC provisioning
- ADB provisioning on a freshly reset/test device

ADB test command after installing the APK on a fresh device:

```powershell
adb shell dpm set-device-owner com.cpdevice.agent/.CpDeviceAdminReceiver
```

If successful, CP DEVICE Agent can detect `DevicePolicyManager.isDeviceOwnerApp()` and use supported enterprise policies such as lock, app policy management, and system update policy where Android/OEM allows.

## OEM/System privileges

OEM/system privileges cannot be added from Java/Kotlin application code. They require one of:

- Preinstall as a privileged system app under `/system/priv-app`
- Platform certificate signing by the firmware vendor
- OEM Device Management SDK integration
- Custom ROM/vendor firmware integration

## Mobile data toggle

Modern Android does not allow normal apps or Device Admin apps to turn mobile data on/off. This requires OEM/system-level privileges. CP DEVICE reports this limitation instead of pretending it succeeded.

## What can be automated in this repo

This repository can provide the signed APK, the Android Enterprise QR payload, ADB test command, and runtime detection of Device Owner/OEM capability.

This repository cannot grant Device Owner after a normal APK install, vendor-sign the app, install it as `/system/priv-app`, or unlock mobile-data toggles from public Android APIs. Those require Android Enterprise provisioning, OEM/vendor cooperation, or system image integration.