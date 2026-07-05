$ErrorActionPreference = "Stop"

$rootPath = Resolve-Path (Join-Path $PSScriptRoot "..")

Write-Host ""
Write-Host "ATB AI Banking Agent - Local Development" -ForegroundColor Cyan
Write-Host "Backend:  http://localhost:5000"
Write-Host "AI:       http://localhost:8000"
Write-Host "Frontend: http://localhost:5173"
Write-Host "Widget:   http://localhost:5174"
Write-Host ""

function Start-DevWindow {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Title,

        [Parameter(Mandatory = $true)]
        [string] $RelativePath,

        [Parameter(Mandatory = $true)]
        [string] $Command
    )

    $workingDirectory = Join-Path $rootPath $RelativePath

    if (-not (Test-Path $workingDirectory)) {
        throw "Directory not found: $workingDirectory"
    }

    $windowCommand = @"
`$Host.UI.RawUI.WindowTitle = "$Title"
Set-Location -LiteralPath "$workingDirectory"
$Command
"@

    Start-Process powershell.exe -ArgumentList @(
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        $windowCommand
    )
}

Start-DevWindow `
    -Title "ATB Backend" `
    -RelativePath "backend-node" `
    -Command "npm run dev"

Start-DevWindow `
    -Title "ATB AI Service" `
    -RelativePath "ai-service-python" `
    -Command "if (Test-Path '.\.venv\Scripts\Activate.ps1') { .\.venv\Scripts\Activate.ps1 } elseif (Test-Path '.\venv\Scripts\Activate.ps1') { .\venv\Scripts\Activate.ps1 } else { Write-Error 'No venv found. Run: python -m venv .venv' }; python -m uvicorn app.main:app --reload --port 8000"

Start-DevWindow `
    -Title "ATB Frontend" `
    -RelativePath "web-client" `
    -Command "npm run dev"

Start-DevWindow `
    -Title "ATB Widget" `
    -RelativePath "widget-agent" `
    -Command "npm run dev"
