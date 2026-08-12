[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$EnvelopePath,
    [Parameter(Mandatory = $true)][string]$PrivateKeyPath,
    [Parameter(Mandatory = $true)][securestring]$PrivateKeyPassword,
    [Parameter(Mandatory = $true)][string]$OutputKeyPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Security
function Test-FixedTimeEqual([byte[]]$Left, [byte[]]$Right) {
    if ($null -eq $Left -or $null -eq $Right) { return $false }
    $difference = $Left.Length -bxor $Right.Length
    $length = [Math]::Min($Left.Length, $Right.Length)
    for ($index = 0; $index -lt $length; $index++) { $difference = $difference -bor ($Left[$index] -bxor $Right[$index]) }
    return $difference -eq 0
}
$envelopeFile = (Resolve-Path -LiteralPath $EnvelopePath).Path
$pfxFile = (Resolve-Path -LiteralPath $PrivateKeyPath).Path
$target = [IO.Path]::GetFullPath($OutputKeyPath)
if (Test-Path -LiteralPath $target) { throw "Refusing to overwrite existing key: $target" }
$parent = Split-Path -Parent $target
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw "Missing output directory: $parent" }
$payload = Get-Content -Raw -LiteralPath $envelopeFile | ConvertFrom-Json
if ($payload.version -ne 1 -or $payload.purpose -ne "subvid-config-data-key" -or $payload.algorithm -ne "RSA-OAEP-SHA256") {
    throw "Unsupported Subvid recovery envelope."
}
$flags = [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($pfxFile, $PrivateKeyPassword, $flags)
$sha256 = [Security.Cryptography.SHA256]::Create()
$hash = $sha256.ComputeHash($certificate.RawData)
$fingerprint = ([BitConverter]::ToString($hash) -replace "-", "").ToLowerInvariant()
$actual = [Text.Encoding]::ASCII.GetBytes($fingerprint)
$expected = [Text.Encoding]::ASCII.GetBytes([string]$payload.certificate_sha256)
if (-not (Test-FixedTimeEqual $actual $expected)) { throw "Envelope and PFX fingerprint do not match." }
$ciphertext = [Convert]::FromBase64String([string]$payload.ciphertext)
$dataKey = $null
$protected = $null
$verification = $null
$rsa = $null
$temporary = "$target.$([Guid]::NewGuid().ToString('N')).tmp"
try {
    $rsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
    if ($null -eq $rsa) { throw "Recovery PFX has no accessible private key." }
    $dataKey = $rsa.Decrypt($ciphertext, [Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
    if ($dataKey.Length -ne 32) { throw "Envelope did not contain a 32-byte Subvid key." }
    $protected = [Security.Cryptography.ProtectedData]::Protect($dataKey, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    [IO.File]::WriteAllBytes($temporary, $protected)
    $verification = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($temporary), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    if (-not (Test-FixedTimeEqual $dataKey $verification)) { throw "New DPAPI key verification failed." }
    Move-Item -LiteralPath $temporary -Destination $target
    Write-Output "SUBVID_RECOVERY_KEY_IMPORTED Path=$target"
}
finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    foreach ($buffer in @($hash, $actual, $expected, $ciphertext, $dataKey, $protected, $verification)) {
        if ($null -ne $buffer) { [Array]::Clear($buffer, 0, $buffer.Length) }
    }
    $sha256.Dispose()
    if ($null -ne $rsa) { $rsa.Dispose() }
    $certificate.Dispose()
}
