[CmdletBinding()]
param(
    [string]$ServiceRoot = "C:\Services\Subvid",
    [string]$DataRoot = "C:\ServiceData\Subvid",
    [string]$EnvironmentFile = "C:\ServiceData\Subvid\secrets\subvid.env",
    [string]$ProtectedKeyFile = "C:\ServiceData\Subvid\secrets\subvid-config-key.dpapi",
    [string]$WinSWPath = "C:\Tools\winsw\winsw.exe"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$serviceId = "subvid-web"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Run elevated." }
if (Get-Service -Name $serviceId -ErrorAction SilentlyContinue) { throw "$serviceId already exists." }
if (-not (Test-Path -LiteralPath (Join-Path $ServiceRoot "current\dist\server\entry.mjs"))) {
    throw "Deploy a release before preparing the service."
}
foreach ($path in @($WinSWPath, $EnvironmentFile, $ProtectedKeyFile)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required file is missing: $path" }
}

$bin = Join-Path $ServiceRoot "bin"
$shared = Join-Path $ServiceRoot "shared"
$secretRoot = Split-Path -Parent $EnvironmentFile
$logs = Join-Path $DataRoot "logs"
$temp = Join-Path $DataRoot "temp"
foreach ($path in @($bin, $shared, $DataRoot, $secretRoot, $logs, $temp)) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Run-Subvid.ps1") -Destination (Join-Path $shared "Run-Subvid.ps1") -Force
$wrapper = Join-Path $bin "$serviceId.exe"
$xml = Join-Path $bin "$serviceId.xml"
Copy-Item -LiteralPath $WinSWPath -Destination $wrapper -Force
$content = [IO.File]::ReadAllText((Join-Path $PSScriptRoot "subvid-web.xml.template"))
$content = $content.Replace("{{SERVICE_ROOT}}", $ServiceRoot).Replace("{{DATA_ROOT}}", $DataRoot).Replace("{{ENV_FILE}}", $EnvironmentFile).Replace("{{KEY_FILE}}", $ProtectedKeyFile)
[IO.File]::WriteAllText($xml, $content, (New-Object Text.UTF8Encoding($false)))

& $wrapper install
if ($LASTEXITCODE -ne 0) { throw "WinSW service installation failed." }
& sc.exe sidtype $serviceId unrestricted | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Service SID configuration failed." }
& sc.exe config $serviceId obj= "NT SERVICE\$serviceId" start= demand | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Virtual service account configuration failed." }

& icacls.exe $ServiceRoot /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' "NT SERVICE\${serviceId}:(OI)(CI)RX" | Out-Null
& icacls.exe (Join-Path $ServiceRoot '*') /reset /T /C | Out-Null
& icacls.exe $DataRoot /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' "NT SERVICE\${serviceId}:(OI)(CI)RX" | Out-Null
foreach ($path in @($logs, $temp)) {
    & icacls.exe $path /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' "NT SERVICE\${serviceId}:(OI)(CI)M" | Out-Null
    & icacls.exe (Join-Path $path '*') /reset /T /C | Out-Null
}
& icacls.exe $secretRoot /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' "NT SERVICE\${serviceId}:(OI)(CI)RX" | Out-Null
foreach ($path in @($EnvironmentFile, $ProtectedKeyFile)) {
    & icacls.exe $path /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' "NT SERVICE\${serviceId}:R" | Out-Null
}
foreach ($path in @("C:\Program Files\nodejs", "C:\Program Files\Python312", "C:\Tools\ffmpeg", "C:\Tools\yt-dlp")) {
    & icacls.exe $path /grant "NT SERVICE\${serviceId}:(OI)(CI)RX" /T /C | Out-Null
}
foreach ($path in @("C:\Tools\ffmpeg\bin\ffmpeg.exe", "C:\Tools\ffmpeg\bin\ffprobe.exe")) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required media tool is missing: $path" }
    & icacls.exe $path /grant "NT SERVICE\${serviceId}:RX" /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Media tool ACL failed: $path" }
}

$service = Get-CimInstance Win32_Service -Filter "Name='$serviceId'"
if ($service.State -ne "Stopped" -or $service.StartMode -ne "Manual") { throw "Prepared service is not Manual/Stopped." }
Write-Output "SUBVID_SERVICE_PREPARED State=Stopped StartMode=Manual Account=$($service.StartName)"
