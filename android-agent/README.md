# Android Agent Build

This directory contains the native CP DEVICE Android agent project.

## Build a signed APK

Requirements:

- JDK 17+
- Gradle 8+
- Android SDK with API 35 build tools
- Network access for the first Gradle dependency resolve, unless dependencies are already cached

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-android-agent.ps1
```

The script:

1. Creates `android-agent/app/release.keystore` if missing.
2. Runs `gradle clean assembleRelease`.
3. Copies `android-agent/app/build/outputs/apk/release/app-release.apk` to `artifacts/cp-device-agent.apk`.

## Current limits

The app is a real Android APK project with Device Admin enrollment and polling against the CP DEVICE control server. Android does not allow a normal APK to silently install itself, silently become Device Owner/Admin, or gain root shell. Device Owner provisioning must be completed through Android Enterprise, QR/zero-touch, ADB provisioning, OEM enrollment, or user-approved Device Admin activation.
