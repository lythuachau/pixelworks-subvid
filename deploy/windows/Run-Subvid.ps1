[CmdletBinding()]
param(
    [string]$ServiceRoot = "C:\Services\Subvid",
    [string]$DataRoot = "C:\ServiceData\Subvid",
    [string]$EnvironmentFile = "C:\ServiceData\Subvid\secrets\subvid.env",
    [string]$ProtectedKeyFile = "C:\ServiceData\Subvid\secrets\subvid-config-key.dpapi"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Security

foreach ($path in @($EnvironmentFile, $ProtectedKeyFile)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required Subvid secret file is missing." }
}
foreach ($rawLine in Get-Content -LiteralPath $EnvironmentFile) {
    if ($rawLine -match '^\s*([^#=\s]+)\s*=\s*(.*)\s*$') {
        $name = $matches[1]
        $value = $matches[2].Trim()
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        Set-Item -Path "Env:$name" -Value $value
    }
}

# node-postgres currently treats sslmode=require as verify-full unless its
# libpq compatibility mode is explicit. Preserve the documented libpq/Aiven
# meaning of "require" (encrypted TLS without a project CA) for this URL.
if ($env:SUBVID_DATABASE_URL -match '(?i)([?&])sslmode=require(?:&|$)' -and
    $env:SUBVID_DATABASE_URL -notmatch '(?i)([?&])uselibpqcompat=') {
    $separator = if ($env:SUBVID_DATABASE_URL.Contains('?')) { '&' } else { '?' }
    $env:SUBVID_DATABASE_URL = "$($env:SUBVID_DATABASE_URL)${separator}uselibpqcompat=true"
}

$protected = [IO.File]::ReadAllBytes($ProtectedKeyFile)
$dataKey = $null
try {
    $dataKey = [Security.Cryptography.ProtectedData]::Unprotect(
        $protected,
        $null,
        [Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    if ($dataKey.Length -ne 32) { throw "Subvid DPAPI payload is not a 32-byte data key." }
    $env:SUBVID_CONFIG_DATA_KEY = [Convert]::ToBase64String($dataKey)
}
finally {
    if ($null -ne $dataKey) { [Array]::Clear($dataKey, 0, $dataKey.Length) }
    [Array]::Clear($protected, 0, $protected.Length)
}

$env:HOST = "127.0.0.1"
$env:PORT = "4321"
$env:NODE_ENV = "production"
$env:ASTRO_TELEMETRY_DISABLED = "1"
$env:PYTHON = "C:\Program Files\Python312\python.exe"
$env:PYTHON_PATH = $env:PYTHON
$env:FFMPEG_PATH = "C:\Tools\ffmpeg\bin\ffmpeg.exe"
$env:YTDLP_PATH = "C:\Tools\yt-dlp\yt-dlp.exe"
$env:TEMP = Join-Path $DataRoot "temp"
$env:TMP = $env:TEMP
$env:PATH = "C:\Tools\yt-dlp;C:\Tools\ffmpeg\bin;C:\Program Files\Python312;C:\Program Files\Python312\Scripts;$env:PATH"

$current = Join-Path $ServiceRoot "current"
$entry = Join-Path $current "dist\server\entry.mjs"
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw "Subvid server entry is missing." }
Set-Location -LiteralPath $current
try {
    & "C:\Program Files\nodejs\node.exe" $entry
    exit $LASTEXITCODE
}
finally {
    Remove-Item Env:\SUBVID_CONFIG_DATA_KEY -ErrorAction SilentlyContinue
}
