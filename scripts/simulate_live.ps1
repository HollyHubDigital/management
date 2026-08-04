$ErrorActionPreference = 'Stop'
$resp = Invoke-RestMethod -Method Post -Uri 'http://localhost:8080/api/enroll' -Body '{"enrollmentSecret":"testsecret","platform":"android","name":"Sim Device","serial":"SIM123","ownerConsent":true}' -ContentType 'application/json'
Write-Host "ENROLL_RESPONSE: $($resp | ConvertTo-Json -Compress)"
$deviceId = $resp.deviceId
$token = $resp.token
Write-Host "DEVICEID=$deviceId"
Write-Host "TOKEN=$token"
[System.IO.File]::WriteAllBytes('frame.jpg',[byte[]](0..255))
Write-Host "WROTE frame.jpg"
$headers = @{ 'Authorization' = "Bearer $token" }
$upload = Invoke-RestMethod -Uri "http://localhost:8080/api/device/$deviceId/live-frame" -Method Post -InFile 'frame.jpg' -ContentType 'image/jpeg' -Headers $headers
Write-Host "UPLOAD_RESPONSE: $($upload | ConvertTo-Json -Compress)"
Invoke-RestMethod -Uri "http://localhost:8080/api/live/$deviceId/frame" -Method Get -Headers @{ 'Authorization' = 'Bearer admintoken' } -OutFile 'got.jpg'
Write-Host "SAVED got.jpg"
