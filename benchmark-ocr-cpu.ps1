$ErrorActionPreference = "Stop"

$ApiUrl = "http://localhost:8000/agent/analyze-vision-document"
$ImageDir = "C:\laragon\www\atb-general-resources\images"
$CpuReport = ".\ocr-cpu-samples.csv"
$OcrReport = ".\ocr-benchmark-results.csv"
$SummaryReport = ".\ocr-benchmark-summary.txt"

function Get-MimeType($file) {
  $ext = [IO.Path]::GetExtension($file).ToLower()
  switch ($ext) {
    ".jpg"  { "image/jpeg" }
    ".jpeg" { "image/jpeg" }
    ".png"  { "image/png" }
    ".webp" { "image/webp" }
    default { "application/octet-stream" }
  }
}

function Invoke-OcrImage($filePath) {
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($filePath))

  $payload = [ordered]@{
    userRole = "client"
    message = "Extract all readable text and all visible fields from this image. Use OCR only."
    fileName = [IO.Path]::GetFileName($filePath)
    mimeType = Get-MimeType $filePath
    pdfBase64 = $b64
    goal = "resource_qa"
  }

  $body = $payload | ConvertTo-Json -Depth 10 -Compress

  Invoke-RestMethod `
    -Uri $ApiUrl `
    -Method Post `
    -Body $body `
    -ContentType "application/json" `
    -TimeoutSec 300
}

Write-Host "Checking AI service runtime..."
$p = (Get-NetTCPConnection -LocalPort 8000 -State Listen).OwningProcess
$pythonPath = (Get-Process -Id $p).Path
Write-Host "AI service Python: $pythonPath"

if ($pythonPath -notmatch "\\ai-service-python\\.venv\\Scripts\\python.exe") {
  Write-Host "ERROR: AI service is not running from .venv Python." -ForegroundColor Red
  exit 1
}

$files = Get-ChildItem $ImageDir -File -Include *.png,*.jpg,*.jpeg,*.webp -Recurse

if ($files.Count -eq 0) {
  Write-Host "No images found in $ImageDir" -ForegroundColor Red
  exit 1
}

Write-Host "Found $($files.Count) images."
Write-Host "Starting CPU sampler..."

$cpuJob = Start-Job -ScriptBlock {
  param($CpuReport)

  "timestamp,totalCpuPercent" | Out-File -Encoding UTF8 $CpuReport

  while ($true) {
    try {
      $sample = (Get-Counter '\Processor(_Total)\% Processor Time').CounterSamples.CookedValue
      $line = "$(Get-Date -Format o),$([math]::Round($sample,2))"
      Add-Content -Encoding UTF8 $CpuReport $line
      Start-Sleep -Milliseconds 500
    }
    catch {
      Start-Sleep -Milliseconds 500
    }
  }
} -ArgumentList $CpuReport

Start-Sleep -Seconds 2

$results = @()
$i = 0

foreach ($file in $files) {
  $i++
  Write-Host "[$i/$($files.Count)] OCR: $($file.Name)"

  $sw = [System.Diagnostics.Stopwatch]::StartNew()

  try {
    $response = Invoke-OcrImage $file.FullName
    $sw.Stop()

    $data = $response.data
    $assistant = [string]$data.assistantMessage
    $fieldsJson = $data.extractedFields | ConvertTo-Json -Depth 20 -Compress

    $isFallback =
      ($data.source -eq "ocr_only_fallback") -or
      ($assistant -match "could not read this image clearly")

    $status = if ($isFallback) { "FAIL" } else { "PASS" }

    $results += [pscustomobject]@{
      file = $file.Name
      status = $status
      source = $data.source
      durationMs = $sw.ElapsedMilliseconds
      assistantMessage = $assistant
      extractedFields = $fieldsJson
    }
  }
  catch {
    $sw.Stop()

    $results += [pscustomobject]@{
      file = $file.Name
      status = "ERROR"
      source = ""
      durationMs = $sw.ElapsedMilliseconds
      assistantMessage = $_.Exception.Message
      extractedFields = ""
    }
  }
}

Stop-Job $cpuJob -ErrorAction SilentlyContinue | Out-Null
Receive-Job $cpuJob -ErrorAction SilentlyContinue | Out-Null
Remove-Job $cpuJob -Force -ErrorAction SilentlyContinue | Out-Null

$results | Export-Csv -NoTypeInformation -Encoding UTF8 $OcrReport

$cpuSamples = Import-Csv $CpuReport
$cpuValues = $cpuSamples | ForEach-Object { [double]$_.totalCpuPercent }

$avgCpu = [math]::Round(($cpuValues | Measure-Object -Average).Average, 2)
$maxCpu = [math]::Round(($cpuValues | Measure-Object -Maximum).Maximum, 2)

$sorted = $cpuValues | Sort-Object
$p95Index = [math]::Floor($sorted.Count * 0.95)
if ($p95Index -ge $sorted.Count) { $p95Index = $sorted.Count - 1 }
$p95Cpu = [math]::Round($sorted[$p95Index], 2)

$passCount = ($results | Where-Object status -eq "PASS").Count
$failCount = ($results | Where-Object status -eq "FAIL").Count
$errorCount = ($results | Where-Object status -eq "ERROR").Count

$avgDuration = [math]::Round((($results | Measure-Object durationMs -Average).Average), 2)
$maxDuration = ($results | Measure-Object durationMs -Maximum).Maximum

$summary = @"
OCR CPU Benchmark Summary
=========================

AI Python:
$pythonPath

Image folder:
$ImageDir

Images tested:
$($files.Count)

OCR results:
PASS  : $passCount
FAIL  : $failCount
ERROR : $errorCount

Latency:
Average response time : $avgDuration ms
Max response time     : $maxDuration ms

CPU usage during OCR benchmark:
Average total CPU : $avgCpu %
P95 total CPU     : $p95Cpu %
Max total CPU     : $maxCpu %

Target:
CPU should stay below 50% during OCR-only testing.

Reports:
CPU samples : $CpuReport
OCR results : $OcrReport
"@

$summary | Out-File -Encoding UTF8 $SummaryReport

Write-Host ""
Write-Host $summary
