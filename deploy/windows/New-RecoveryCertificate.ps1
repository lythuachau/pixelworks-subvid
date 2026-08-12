[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PublicCertificatePath,
    [Parameter(Mandatory = $true)][string]$PrivateKeyPath,
    [Parameter(Mandatory = $true)][securestring]$PrivateKeyPassword,
    [ValidateRange(30, 3650)][int]$ValidDays = 3650
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$publicTarget = [IO.Path]::GetFullPath($PublicCertificatePath)
$privateTarget = [IO.Path]::GetFullPath($PrivateKeyPath)
foreach ($target in @($publicTarget, $privateTarget)) {
    if (Test-Path -LiteralPath $target) { throw "Refusing to overwrite: $target" }
    $parent = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw "Missing output directory: $parent" }
}
$rsa = [Security.Cryptography.RSA]::Create()
$rsa.KeySize = 3072
$request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=Subvid Offline Recovery $([Guid]::NewGuid().ToString('N'))",
    $rsa,
    [Security.Cryptography.HashAlgorithmName]::SHA256,
    [Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$certificate = $request.CreateSelfSigned((Get-Date).AddMinutes(-5), (Get-Date).AddDays($ValidDays))
$passwordPointer = [IntPtr]::Zero
$publicBytes = $null
$privateBytes = $null
try {
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($PrivateKeyPassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $publicBytes = $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)
    $privateBytes = $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pkcs12, $plainPassword)
    [IO.File]::WriteAllBytes($publicTarget, $publicBytes)
    [IO.File]::WriteAllBytes($privateTarget, $privateBytes)
    if (-not (Test-Path -LiteralPath $publicTarget -PathType Leaf) -or -not (Test-Path -LiteralPath $privateTarget -PathType Leaf)) {
        throw "Recovery certificate export did not create both files."
    }
    Write-Output "SUBVID_RECOVERY_CERT_CREATED Public=$publicTarget Private=$privateTarget Thumbprint=$($certificate.Thumbprint)"
}
finally {
    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer) }
    foreach ($buffer in @($publicBytes, $privateBytes)) { if ($null -ne $buffer) { [Array]::Clear($buffer, 0, $buffer.Length) } }
    if ($null -ne $certificate) { $certificate.Dispose() }
    if ($null -ne $rsa) { $rsa.Dispose() }
}
