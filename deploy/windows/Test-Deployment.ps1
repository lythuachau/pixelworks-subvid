[CmdletBinding()]
param(
    [string]$Domain = "subvid.choulee.indevs.in",
    [ValidateRange(1024,65535)][int]$AppPort = 4321,
    [switch]$SkipPublic
)

$ErrorActionPreference = "Stop"
$service = Get-CimInstance Win32_Service -Filter "Name='subvid-web'"
$local = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$AppPort/health/ready" -TimeoutSec 15
$listeners = @(Get-NetTCPConnection -LocalPort $AppPort -State Listen -ErrorAction SilentlyContinue)
$result = [ordered]@{
    service_state = $service.State
    service_start_mode = $service.StartMode
    service_account = $service.StartName
    local_health_status = [int]$local.StatusCode
    loopback_listener_count = @($listeners | Where-Object LocalAddress -in @('127.0.0.1','::1')).Count
    non_loopback_listener_count = @($listeners | Where-Object LocalAddress -notin @('127.0.0.1','::1')).Count
}
if (-not $SkipPublic) {
    $public = Invoke-WebRequest -UseBasicParsing -Uri "https://$Domain/health/ready" -TimeoutSec 20 -MaximumRedirection 5 -SkipHttpErrorCheck
    $result.public_health_status = [int]$public.StatusCode
}
$result | ConvertTo-Json
if ($service.State -ne 'Running' -or $service.StartMode -ne 'Auto' -or $local.StatusCode -ne 200) { exit 1 }
if ($result.loopback_listener_count -ne 1 -or $result.non_loopback_listener_count -ne 0) { exit 1 }
if (-not $SkipPublic -and $result.public_health_status -notin @(200,302,303)) { exit 1 }
