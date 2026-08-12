[CmdletBinding()]
param(
    [string]$OutputKeyPath = "C:\ServiceData\Subvid\secrets\subvid-config-key.dpapi"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Security
$target = [IO.Path]::GetFullPath($OutputKeyPath)
if (Test-Path -LiteralPath $target) { throw "Refusing to overwrite existing key: $target" }
$parent = Split-Path -Parent $target
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$dataKey = [byte[]]::new(32)
$protected = $null
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($dataKey)
    $protected = [Security.Cryptography.ProtectedData]::Protect(
        $dataKey, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    [IO.File]::WriteAllBytes($target, $protected)
    Write-Output "SUBVID_DPAPI_KEY_CREATED Path=$target"
}
finally {
    $rng.Dispose()
    [Array]::Clear($dataKey, 0, $dataKey.Length)
    if ($null -ne $protected) { [Array]::Clear($protected, 0, $protected.Length) }
}
