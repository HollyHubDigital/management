$ErrorActionPreference = "Continue"

$checks = @(
  @{ Name = "java"; Command = "java"; Args = @("-version") },
  @{ Name = "javac"; Command = "javac"; Args = @("-version") },
  @{ Name = "keytool"; Command = "keytool"; Args = @("-help") },
  @{ Name = "gradle"; Command = "gradle"; Args = @("-v") },
  @{ Name = "sdkmanager"; Command = "sdkmanager"; Args = @("--version") },
  @{ Name = "apksigner"; Command = "apksigner"; Args = @("--version") }
)

foreach ($check in $checks) {
  $cmd = Get-Command $check.Command -ErrorAction SilentlyContinue
  if ($cmd) {
    Write-Host "[OK] $($check.Name): $($cmd.Source)"
  } else {
    Write-Host "[MISSING] $($check.Name)"
  }
}

Write-Host ""
Write-Host "Expected minimum setup:"
Write-Host "- JDK 17+ on PATH: java, javac, keytool"
Write-Host "- Gradle 8+ on PATH: gradle"
Write-Host "- Android SDK command-line tools on PATH: sdkmanager, apksigner"
Write-Host "- ANDROID_HOME or ANDROID_SDK_ROOT points to the Android SDK directory"
