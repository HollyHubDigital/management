$ErrorActionPreference = "Stop"

$gradle = Get-Command gradle -ErrorAction SilentlyContinue
if (-not $gradle) { throw "gradle was not found. Install Gradle and ensure it is on PATH, or build from Android Studio." }

Push-Location android-agent
try {
  if (-not (Test-Path "app/release.keystore")) {
    Pop-Location
    ./scripts/create-android-keystore.ps1
    Push-Location android-agent
  }
  $env:CP_DEVICE_KEYSTORE = "release.keystore"
  $env:CP_DEVICE_KEYSTORE_PASSWORD = "changeit"
  $env:CP_DEVICE_KEY_ALIAS = "cp-device"
  $env:CP_DEVICE_KEY_PASSWORD = "changeit"
  & $gradle.Source clean assembleRelease
}
finally {
  Pop-Location
}

$apk = "android-agent/app/build/outputs/apk/release/app-release.apk"
if (-not (Test-Path $apk)) { throw "Release APK was not produced at $apk" }
Copy-Item $apk "artifacts/cp-device-agent.apk" -Force
Write-Host "Signed APK copied to artifacts/cp-device-agent.apk"
