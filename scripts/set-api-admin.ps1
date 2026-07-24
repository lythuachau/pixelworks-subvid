param(
    [string]$Config = (Join-Path $PSScriptRoot "..\wrangler.jsonc")
)

$ErrorActionPreference = "Stop"

$username = (Read-Host "Tai khoan quan tri Subvid moi").Trim()
if (-not $username) {
    throw "Tai khoan khong duoc de trong."
}

$passwordSecure = Read-Host "Mat khau quan tri Subvid moi" -AsSecureString
$confirmSecure = Read-Host "Nhap lai mat khau" -AsSecureString
$passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($passwordSecure)
$confirmPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($confirmSecure)

try {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
    $confirm = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($confirmPtr)
    if (-not $password -or $password -ne $confirm) {
        throw "Mat khau trong hoac hai lan nhap khong khop."
    }

    $salt = New-Object byte[] 16
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($salt)
    $rng.Dispose()

    $derive = [Security.Cryptography.Rfc2898DeriveBytes]::new(
        $password,
        $salt,
        100000,
        [Security.Cryptography.HashAlgorithmName]::SHA256
    )
    $digest = $derive.GetBytes(32)
    $derive.Dispose()

    $b64Salt = [Convert]::ToBase64String($salt).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    $b64Digest = [Convert]::ToBase64String($digest).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    $passwordHash = "pbkdf2-sha256`$100000`$$b64Salt`$$b64Digest"

    $username |
        npx wrangler secret put SUBVID_API_ADMIN_USER --config $Config
    if ($LASTEXITCODE -ne 0) {
        throw "Khong cap nhat duoc username tren Cloudflare."
    }

    $passwordHash |
        npx wrangler secret put SUBVID_API_ADMIN_PASSWORD_HASH --config $Config
    if ($LASTEXITCODE -ne 0) {
        throw "Khong cap nhat duoc password hash tren Cloudflare."
    }

    Write-Host "Da cap nhat tai khoan quan tri API cua Subvid."
    Write-Host "Cac phien quan tri cu da mat hieu luc."
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($confirmPtr)
    Remove-Variable password, confirm, passwordHash -ErrorAction SilentlyContinue
}
