[CmdletBinding()]
param(
    [string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [string]$ServiceRoot = "C:\Services\Subvid",
    [string]$PnpmPath = "pnpm.cmd"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot "package.json"))) { throw "Invalid source root." }
$pnpm = (Get-Command $PnpmPath -CommandType Application -ErrorAction Stop).Source
$releases = Join-Path $ServiceRoot "releases"
$shared = Join-Path $ServiceRoot "shared"
foreach ($path in @($ServiceRoot, $releases, $shared)) { New-Item -ItemType Directory -Path $path -Force | Out-Null }

$commit = (& git -C $SourceRoot rev-parse --short=12 HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $commit) { throw "Could not resolve source commit." }
$releaseId = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$commit"
$release = Join-Path $releases $releaseId
if (Test-Path -LiteralPath $release) { throw "Release already exists." }
New-Item -ItemType Directory -Path $release | Out-Null

$null = robocopy.exe $SourceRoot $release /E /XD .git node_modules dist .astro .cache /XF .env .env.local *.log
if ($LASTEXITCODE -gt 7) { throw "Release copy failed with exit code $LASTEXITCODE." }
Push-Location $release
try {
    & $pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed." }
    & $pnpm build
    if ($LASTEXITCODE -ne 0) { throw "Subvid build failed." }
    if (-not (Test-Path -LiteralPath ".\dist\server\entry.mjs")) { throw "Built server entry is missing." }
}
finally { Pop-Location }

$current = Join-Path $ServiceRoot "current"
$previousTarget = $null
if (Test-Path -LiteralPath $current) {
    $item = Get-Item -LiteralPath $current -Force
    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "$current is not a junction; refusing to replace it."
    }
    $previousTarget = [string]$item.Target
    [IO.Directory]::Delete($item.FullName)
}
try { New-Item -ItemType Junction -Path $current -Target $release | Out-Null }
catch {
    if ($previousTarget -and -not (Test-Path -LiteralPath $current)) {
        New-Item -ItemType Junction -Path $current -Target $previousTarget | Out-Null
    }
    throw
}
Write-Output "SUBVID_RELEASE_PREPARED Id=$releaseId"
