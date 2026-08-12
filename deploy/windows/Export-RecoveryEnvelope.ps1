[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ProtectedKeyPath,
    [Parameter(Mandatory = $true)][string]$PublicCertificatePath,
    [Parameter(Mandatory = $true)][string]$EnvelopePath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Security
$keyPath = (Resolve-Path -LiteralPath $ProtectedKeyPath).Path
$certificatePath = (Resolve-Path -LiteralPath $PublicCertificatePath).Path
$target = [IO.Path]::GetFullPath($EnvelopePath)
if (Test-Path -LiteralPath $target) { throw "Refusing to overwrite envelope: $target" }
$parent = Split-Path -Parent $target
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw "Missing output directory: $parent" }
$protected = [IO.File]::ReadAllBytes($keyPath)
$dataKey = $null
$ciphertext = $null
$certificate = $null
$rsa = $null
$sha256 = $null
$certificateHash = $null
try {
    $dataKey = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    if ($dataKey.Length -ne 32) { throw "DPAPI payload is not a 32-byte Subvid key." }
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($certificatePath)
    $rsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($certificate)
    if ($null -eq $rsa -or $rsa.KeySize -lt 3072) { throw "Recovery certificate must use RSA >= 3072 bits." }
    $ciphertext = $rsa.Encrypt($dataKey, [Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    $certificateHash = $sha256.ComputeHash($certificate.RawData)
    $fingerprint = ([BitConverter]::ToString($certificateHash) -replace "-", "").ToLowerInvariant()
    $payload = [ordered]@{
        version = 1
        purpose = "subvid-config-data-key"
        algorithm = "RSA-OAEP-SHA256"
        certificate_sha256 = $fingerprint
        ciphertext = [Convert]::ToBase64String($ciphertext)
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($target, $payload + "`n", [Text.Encoding]::ASCII)
    Write-Output "SUBVID_RECOVERY_ENVELOPE_CREATED Path=$target"
}
finally {
    foreach ($buffer in @($protected, $dataKey, $ciphertext, $certificateHash)) {
        if ($null -ne $buffer) { [Array]::Clear($buffer, 0, $buffer.Length) }
    }
    if ($null -ne $sha256) { $sha256.Dispose() }
    if ($null -ne $rsa) { $rsa.Dispose() }
    if ($null -ne $certificate) { $certificate.Dispose() }
}
