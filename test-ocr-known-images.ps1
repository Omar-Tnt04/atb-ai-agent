$ErrorActionPreference = "Stop"

$ApiUrl = "http://localhost:8000/agent/analyze-vision-document"
$ImageDir = "C:\laragon\www\atb-general-resources\images"

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

function Invoke-OcrImageTest($filePath, $question) {
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($filePath))

  $payload = [ordered]@{
    userRole = "client"
    message = $question
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

function Test-KnownImage($name, $file, $expected) {
  $path = Join-Path $ImageDir $file

  if (!(Test-Path $path)) {
    Write-Host "FAIL - $name - file not found: $file" -ForegroundColor Red
    return $false
  }

  $question = "Extract all visible text and all visible fields from this image. Answer only from OCR text."
  $response = Invoke-OcrImageTest $path $question
  $data = $response.data

  $haystack = @(
    $data.source
    $data.assistantMessage
    ($data.extractedFields | ConvertTo-Json -Depth 20)
    ($data | ConvertTo-Json -Depth 20)
  ) -join "`n"

  $missing = @()

  foreach ($item in $expected) {
    if ($haystack -notmatch [regex]::Escape($item)) {
      $missing += $item
    }
  }

  $badFallback =
    ($data.source -eq "ocr_only_fallback") -or
    ($data.assistantMessage -match "could not read this image clearly") -or
    ($data.assistantMessage -match "not found")

  if ($missing.Count -eq 0 -and -not $badFallback) {
    Write-Host "PASS - $name - source=$($data.source)" -ForegroundColor Green
    return $true
  }

  Write-Host "FAIL - $name - source=$($data.source)" -ForegroundColor Red
  if ($missing.Count -gt 0) {
    Write-Host "  Missing expected text:" -ForegroundColor Yellow
    $missing | ForEach-Object { Write-Host "   - $_" -ForegroundColor Yellow }
  }
  Write-Host "  Assistant: $($data.assistantMessage)" -ForegroundColor DarkYellow
  return $false
}

Write-Host "`n=== OCR KNOWN RESOURCE TESTS ===`n"

$knownTests = @(
  @{
    name = "QR Merchant Payment Receipt"
    file = "01_qr_merchant_payment_receipt.png"
    expected = @(
      "QR-PAY-2026-301",
      "Carthage",
      "acc_001",
      "18.500 TND",
      "2026-06-01",
      "18:42",
      "Completed"
    )
  },
  @{
    name = "IBAN Certificate Preview"
    file = "02_iban_certificate_preview.jpg"
    expected = @(
      "IBAN-CERT-2026-044",
      "Omar Tentouch",
      "acc_001",
      "TN59",
      "9012",
      "Tunis Centre",
      "2026-06-02",
      "Ready"
    )
  },
  @{
    name = "Debit Card Activation Notice"
    file = "03_card_activation_notice.jpeg"
    expected = @(
      "CARD-ACT-2026-052",
      "4455",
      "Debit",
      "ATM or ATB Connect",
      "05/29",
      "Pending activation",
      "Activate before first purchase"
    )
  },
  @{
    name = "Account Overdraft Alert"
    file = "04_overdraft_alert.png"
    expected = @(
      "OD-ALERT-2026-063",
      "acc_002",
      "500.000 TND",
      "420.250 TND",
      "2026-06-04",
      "Attention required",
      "Review upcoming debits"
    )
  },
  @{
    name = "Monthly E-Statement Summary"
    file = "05_estatement_summary.jpg"
    expected = @(
      "ESTMT-2026-005",
      "acc_001",
      "2026-05-01",
      "2026-05-31",
      "1240.000 TND",
      "2100.000 TND",
      "980.500 TND",
      "2359.500 TND"
    )
  },
  @{
    name = "Account Fee Notice"
    file = "06_account_fee_notice.jpeg"
    expected = @(
      "FEE-NOTICE-2026-071",
      "acc_001",
      "Monthly account package",
      "7.000 TND",
      "2026-06-05",
      "Scheduled",
      "Included in package conditions"
    )
  },
  @{
    name = "Savings Goal Progress"
    file = "07_savings_goal_progress.png"
    expected = @(
      "SAVE-GOAL-2026-018",
      "Laptop Fund",
      "3500.000 TND",
      "2240.000 TND",
      "64%",
      "2026-09-30",
      "On track"
    )
  },
  @{
    name = "Branch Queue Ticket"
    file = "08_branch_queue_ticket.jpg"
    expected = @(
      "QUEUE-TN-2026-088",
      "SME support",
      "B-42",
      "14 minutes",
      "2026-06-06",
      "10:18",
      "Waiting"
    )
  }
)

$passed = 0
$failed = 0

foreach ($test in $knownTests) {
  $ok = Test-KnownImage $test.name $test.file $test.expected
  if ($ok) { $passed++ } else { $failed++ }
}

Write-Host "`nKnown image result: $passed passed, $failed failed`n"

if ($failed -gt 0) {
  exit 1
}

Write-Host "All known OCR image tests passed." -ForegroundColor Green
