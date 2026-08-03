param(
  [string]$KeystorePath = "android-agent/app/release.keystore",
  [string]$Alias = "cp-device",
  [string]$StorePassword = "changeit",
  [string]$KeyPassword = "changeit"
)

$keytool = Get-Command keytool -ErrorAction SilentlyContinue
if (-not $keytool) { throw "keytool was not found. Install JDK and ensure JAVA_HOME/bin is on PATH." }

if (-not (Test-Path $KeystorePath)) {
  & $keytool.Source -genkeypair -v -keystore $KeystorePath -alias $Alias -keyalg RSA -keysize 4096 -validity 10000 -storepass $StorePassword -keypass $KeyPassword -dname "CN=CP DEVICE, OU=MDM, O=CP DEVICE, L=Lagos, ST=Lagos, C=NG"
}

Write-Host "Keystore ready: $KeystorePath"
