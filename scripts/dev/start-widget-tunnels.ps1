#Requires -Version 5.1
<#
.SYNOPSIS
    Start Cloudflare HTTPS quick tunnels for backend (5000) and widget (5174),
    then patch widget-injector-extension/widget-config.js with the generated URLs.
.NOTES
    Keep this terminal open — closing it stops the tunnels.
    Tunnel URLs change on every run; reload the Chrome extension each session.
#>

param()
$ErrorActionPreference = 'Stop'

# ── Paths ──────────────────────────────────────────────────────────────────────
$ProjectRoot = (Get-Item $PSScriptRoot).Parent.Parent.FullName
$ConfigPath  = Join-Path $ProjectRoot 'widget-injector-extension\widget-config.js'

if (-not (Test-Path $ConfigPath)) {
    Write-Error "widget-config.js not found: $ConfigPath"
    exit 1
}

# ── Temp log files ─────────────────────────────────────────────────────────────
$ApiLog    = Join-Path $env:TEMP 'atb-tunnel-api.log'
$WidgetLog = Join-Path $env:TEMP 'atb-tunnel-widget.log'

Set-Content $ApiLog    '' -Encoding utf8
Set-Content $WidgetLog '' -Encoding utf8

# ── Spawn tunnels ──────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '  Starting backend tunnel (http://localhost:5000) ...'
$ApiProc = Start-Process 'cmd.exe' `
    -ArgumentList "/c npx cloudflared tunnel --url http://localhost:5000 > `"$ApiLog`" 2>&1" `
    -PassThru -WindowStyle Hidden

Write-Host '  Starting widget tunnel  (http://localhost:5174) ...'
$WidgetProc = Start-Process 'cmd.exe' `
    -ArgumentList "/c npx cloudflared tunnel --url http://localhost:5174 > `"$WidgetLog`" 2>&1" `
    -PassThru -WindowStyle Hidden

# ── Poll for URLs (up to 90 s) ─────────────────────────────────────────────────
$UrlRe     = [regex]'https://[a-z0-9-]+\.trycloudflare\.com'
$ApiUrl    = $null
$WidgetUrl = $null
$Deadline  = (Get-Date).AddSeconds(90)

Write-Host ''
Write-Host '  Waiting for tunnel URLs' -NoNewline

while ((-not $ApiUrl -or -not $WidgetUrl) -and (Get-Date) -lt $Deadline) {
    Start-Sleep -Seconds 2
    Write-Host '.' -NoNewline

    if (-not $ApiUrl) {
        $text = Get-Content $ApiLog -Raw -ErrorAction SilentlyContinue
        if ($text) {
            $m = $UrlRe.Match($text)
            if ($m.Success) { $ApiUrl = $m.Value }
        }
    }
    if (-not $WidgetUrl) {
        $text = Get-Content $WidgetLog -Raw -ErrorAction SilentlyContinue
        if ($text) {
            $m = $UrlRe.Match($text)
            if ($m.Success) { $WidgetUrl = $m.Value }
        }
    }

    if ($ApiProc.HasExited -and -not $ApiUrl) {
        Write-Host ''
        Write-Error "Backend tunnel exited before URL appeared. Log: $ApiLog"
        exit 1
    }
    if ($WidgetProc.HasExited -and -not $WidgetUrl) {
        Write-Host ''
        Write-Error "Widget tunnel exited before URL appeared. Log: $WidgetLog"
        exit 1
    }
}

Write-Host ''

if (-not $ApiUrl -or -not $WidgetUrl) {
    $missing = @()
    if (-not $ApiUrl)    { $missing += 'backend (5000)' }
    if (-not $WidgetUrl) { $missing += 'widget  (5174)' }
    Write-Error ('Timed out (90 s) — no URL for: ' + ($missing -join ', ') + '. Ensure services are running and cloudflared can reach the internet.')
    exit 1
}

# ── Patch widget-config.js ─────────────────────────────────────────────────────
$raw = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8)
$raw = [regex]::Replace($raw, "(widgetUrl:\s*)'[^']*'", '$1' + "'$WidgetUrl'")
$raw = [regex]::Replace($raw, "(apiUrl:\s*)'[^']*'",    '$1' + "'$ApiUrl'")
[System.IO.File]::WriteAllText($ConfigPath, $raw, (New-Object System.Text.UTF8Encoding $false))

# ── Report ─────────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '  ========================================'
Write-Host '   ATB Widget Tunnels Ready'
Write-Host '  ========================================'
Write-Host "  Backend API tunnel:  $ApiUrl"
Write-Host "  Widget tunnel:       $WidgetUrl"
Write-Host ''
Write-Host '  widget-config.js updated.'
Write-Host ''
Write-Host '  Next:'
Write-Host '    1. Reload extension  →  chrome://extensions  →  Reload'
Write-Host '    2. Open demo         →  http://localhost:5000/dev/open-hosted-demo'
Write-Host ''
Write-Host '  Tunnels running. Press Ctrl+C to stop.'
Write-Host '  ========================================'
Write-Host ''

# ── Keep alive until Ctrl+C or a tunnel dies ───────────────────────────────────
try {
    while (-not $ApiProc.HasExited -and -not $WidgetProc.HasExited) {
        Start-Sleep -Seconds 5
    }
    Write-Host ''
    Write-Host '  A tunnel process exited unexpectedly.'
} finally {
    foreach ($proc in @($ApiProc, $WidgetProc)) {
        if ($null -ne $proc -and -not $proc.HasExited) {
            & taskkill /T /F /PID $proc.Id 2>$null | Out-Null
        }
    }
    Write-Host '  Tunnels stopped.'
}
