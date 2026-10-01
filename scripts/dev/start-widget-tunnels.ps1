#Requires -Version 5.1
# Start only the remote backend. The frontend is packaged in the extension.
param()
$ErrorActionPreference = 'Stop'
$ProjectRoot = (Get-Item $PSScriptRoot).Parent.Parent.FullName
$ConfigPath = Join-Path $ProjectRoot 'widget-injector-extension\widget-config.js'
$ApiLog = Join-Path $env:TEMP 'atb-tunnel-api.log'
Set-Content -LiteralPath $ApiLog -Value '' -Encoding utf8
$ApiProc = Start-Process 'cmd.exe' -ArgumentList "/c npx cloudflared tunnel --url http://localhost:5000 > `"$ApiLog`" 2>&1" -WorkingDirectory $ProjectRoot -PassThru -WindowStyle Hidden
try {
    $ApiUrl = $null
    $Deadline = (Get-Date).AddSeconds(90)
    while (-not $ApiUrl -and (Get-Date) -lt $Deadline) {
        Start-Sleep -Seconds 2
        $text = Get-Content -LiteralPath $ApiLog -Raw -ErrorAction SilentlyContinue
        if ($text -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $ApiUrl = $Matches[0] }
        if ($ApiProc.HasExited) { throw "Backend tunnel exited. See $ApiLog" }
    }
    if (-not $ApiUrl) { throw "Timed out waiting for backend tunnel. See $ApiLog" }
    $raw = [IO.File]::ReadAllText($ConfigPath)
    $raw = [regex]::Replace($raw, "(apiUrl:\s*)'[^']*'", '$1' + "'$ApiUrl'")
    [IO.File]::WriteAllText($ConfigPath, $raw, (New-Object Text.UTF8Encoding $false))
    $configJson = @{ apiUrl = $ApiUrl } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $ProjectRoot '.tunnel-urls.json'), $configJson, (New-Object Text.UTF8Encoding $false))
    Write-Host "Backend API: $ApiUrl"
    Write-Host 'Build with npm run build:extension. Reload the extension, then refresh https://atb.tn.'
    Write-Host 'Press Ctrl+C to stop the backend tunnel.'
    while (-not $ApiProc.HasExited) { Start-Sleep -Seconds 5 }
} finally {
    if (-not $ApiProc.HasExited) { & taskkill /T /F /PID $ApiProc.Id 2>$null | Out-Null }
}
