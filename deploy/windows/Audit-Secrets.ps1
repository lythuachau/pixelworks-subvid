[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location -LiteralPath $repoRoot

$patterns = [ordered]@{
    private_key = "-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"
    github_token = "\bgh[pousr]_[A-Za-z0-9_]{20,}\b"
    provider_key = "\b(?:gsk|AIza|sk)-[A-Za-z0-9_-]{20,}\b"
    aws_access_key = "\bAKIA[0-9A-Z]{16}\b"
}
$files = @(& git ls-files --cached --others --exclude-standard)
if ($LASTEXITCODE -ne 0) { throw "Cannot list Git files." }
$findings = [Collections.Generic.List[string]]::new()
foreach ($relativePath in $files) {
    $fullPath = Join-Path $repoRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { continue }
    try {
        $lineNumber = 0
        foreach ($line in [IO.File]::ReadLines($fullPath)) {
            $lineNumber++
            foreach ($entry in $patterns.GetEnumerator()) {
                if ($line -match $entry.Value) {
                    $findings.Add("$relativePath`:$lineNumber [$($entry.Key)]")
                }
            }
        }
    }
    catch { }
}
if ($findings.Count) {
    Write-Error ("Secret-like values found (values hidden):`n" + ($findings -join "`n"))
    exit 1
}
Write-Output "SECRET_AUDIT_OK Files=$($files.Count)"
