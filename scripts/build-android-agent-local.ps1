$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$jbr = "C:\Program Files\Android\Android Studio\jbr"
$temurin = "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.8-hotspot"
$sdk = "C:\Users\holly\AppData\Local\Android\Sdk"

if (Test-Path $jbr) { $env:JAVA_HOME = $jbr } elseif (Test-Path $temurin) { $env:JAVA_HOME = $temurin } else { throw "No JDK found. Install JDK 17+." }
if (-not (Test-Path $sdk)) { throw "Android SDK not found at $sdk" }
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:PATH = "$env:JAVA_HOME\bin;$sdk\build-tools\36.0.0;$sdk\platform-tools;$env:PATH"

$keytool = Join-Path $env:JAVA_HOME "bin\keytool.exe"
if (-not (Test-Path $keytool)) { throw "keytool not found at $keytool" }

$keystore = Join-Path $repo "android-agent\app\release.keystore"
if (-not (Test-Path $keystore)) {
  & $keytool -genkeypair -v -keystore $keystore -alias "cp-device" -keyalg RSA -keysize 4096 -validity 10000 -storepass "changeit" -keypass "changeit" -dname "CN=CP DEVICE, OU=MDM, O=CP DEVICE, L=Lagos, ST=Lagos, C=NG"
}

Push-Location (Join-Path $repo "android-agent")
try {
  $env:CP_DEVICE_KEYSTORE = "release.keystore"
  $env:CP_DEVICE_KEYSTORE_PASSWORD = "changeit"
  $env:CP_DEVICE_KEY_ALIAS = "cp-device"
  $env:CP_DEVICE_KEY_PASSWORD = "changeit"
  .\gradlew.bat clean assembleRelease
}
finally {
  Pop-Location
}

$apk = Join-Path $repo "android-agent\app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path $apk)) { throw "Release APK was not produced at $apk" }
Copy-Item $apk (Join-Path $repo "artifacts\cp-device-agent.apk") -Force
Write-Host "Signed APK copied to artifacts/cp-device-agent.apk"
