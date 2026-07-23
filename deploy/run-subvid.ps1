$ErrorActionPreference = "Stop"

$root = "C:\AI\subvid.app"
$node = "C:\Program Files\nodejs\node.exe"
$astro = Join-Path $root "node_modules\astro\bin\astro.mjs"
$stdout = Join-Path $root ".service.out.log"
$stderr = Join-Path $root ".service.err.log"

$env:LOCAL_STATIC = "1"
$env:NODE_ENV = "development"
$env:PYTHON = "C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe"
$env:PYTHON_PATH = $env:PYTHON
$env:FFMPEG_PATH = "C:\Users\Administrator\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe"

# Astro/Vite keeps .env.local out of process.env for server plugins. Load only
# the local service secrets needed by Python helpers before Node starts.
$localEnv = Join-Path $root ".env.local"
if (Test-Path -LiteralPath $localEnv) {
    foreach ($line in Get-Content -LiteralPath $localEnv) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) {
            continue
        }
        $key, $value = $trimmed.Split("=", 2)
        $key = $key.Trim()
        $value = $value.Trim().Trim('"').Trim("'")
        if ($key -in @("HF_TOKEN", "HUGGINGFACE_TOKEN") -and $value) {
            Set-Item -Path "Env:$key" -Value $value
        }
    }
}
Set-Location -LiteralPath $root

while ($true) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort 4321 -ErrorAction SilentlyContinue
    if ($listener) {
        Start-Sleep -Seconds 5
        continue
    }

    $process = Start-Process `
        -FilePath $node `
        -ArgumentList @($astro, "dev", "--host", "::1", "--port", "4321") `
        -WorkingDirectory $root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru

    $process.WaitForExit()
    Start-Sleep -Seconds 3
}
