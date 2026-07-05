$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$extensionPath = Join-Path $projectRoot "widget-injector-extension"

$chromePath = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"

if (-not (Test-Path $chromePath)) {
  $chromePath = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
}

if (-not (Test-Path $chromePath)) {
  throw "Chrome not found. Please update chromePath manually."
}

if (-not (Test-Path $extensionPath)) {
  throw "Extension folder not found: $extensionPath"
}

$profilePath = "C:\temp\atb-browser-agent-profile"
New-Item -ItemType Directory -Path $profilePath -Force | Out-Null

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "ATB Agent Chrome.lnk"

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)

$shortcut.TargetPath = $chromePath
$shortcut.Arguments = "--remote-debugging-port=9222 --user-data-dir=`"$profilePath`" --load-extension=`"$extensionPath`" --no-first-run --no-default-browser-check"
$shortcut.WorkingDirectory = Split-Path $chromePath
$shortcut.IconLocation = "$chromePath,0"
$shortcut.Description = "Chrome for ATB browser agent demo with CDP and widget extension"
$shortcut.Save()

Write-Host "Shortcut created: $shortcutPath"
Write-Host "Open this shortcut, type https://atb.tn, and use the widget."
Write-Host "Browser-use will connect through CDP on port 9222."
