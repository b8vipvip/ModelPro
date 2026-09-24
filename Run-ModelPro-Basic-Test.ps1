param(
  [switch]$SkipNpmTest
)
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logDir = Join-Path $Root "logs\ModelPro-$stamp"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$mainLog = Join-Path $logDir "modelpro-basic-test.log"
$envLog = Join-Path $logDir "environment.log"
$jsonLog = Join-Path $logDir "modelpro-basic-test.json"

function Log([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $Message
  $line | Tee-Object -FilePath $mainLog -Append
}
function Run([string]$Name, [scriptblock]$Action) {
  Log "===== $Name ====="
  try {
    & $Action 2>&1 | ForEach-Object { Log "$_" }
    if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { throw "$Name exit code $LASTEXITCODE" }
    Log "PASS: $Name"
    return $true
  } catch {
    Log "FAIL: $Name :: $($_.Exception.Message)"
    return $false
  }
}

"ModelPro local basic test environment" | Out-File $envLog -Encoding utf8
"Time: $(Get-Date -Format o)" | Out-File $envLog -Append -Encoding utf8
"Computer: $env:COMPUTERNAME" | Out-File $envLog -Append -Encoding utf8
"OS:" | Out-File $envLog -Append -Encoding utf8
Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture | Format-List | Out-File $envLog -Append -Encoding utf8
"Node:" | Out-File $envLog -Append -Encoding utf8
try { node --version 2>&1 | Out-File $envLog -Append -Encoding utf8 } catch { "node not found" | Out-File $envLog -Append -Encoding utf8 }
"NPM:" | Out-File $envLog -Append -Encoding utf8
try { npm --version 2>&1 | Out-File $envLog -Append -Encoding utf8 } catch { "npm not found" | Out-File $envLog -Append -Encoding utf8 }
"Git:" | Out-File $envLog -Append -Encoding utf8
try { git --version 2>&1 | Out-File $envLog -Append -Encoding utf8 } catch { "git not found" | Out-File $envLog -Append -Encoding utf8 }
try { git rev-parse HEAD 2>&1 | Out-File $envLog -Append -Encoding utf8 } catch {}

Log "ModelPro Win10 basic test started"
Log "Root=$Root"
$nodeOk = $null -ne (Get-Command node -ErrorAction SilentlyContinue)
if (-not $nodeOk) {
  Log "FATAL: Node.js not found in PATH. Install Node.js 20+ or 22 LTS, reopen PowerShell, and run again."
  Copy-Item $envLog $logDir -ErrorAction SilentlyContinue
  exit 2
}

$results = [ordered]@{}
if (-not $SkipNpmTest) {
  $results.npm_test = Run "npm test" { npm test }
}
$results.local_harness = Run "Windows local harness" { node .\scripts\windows-basic-test.mjs --json "$jsonLog" }

$passed = ($results.Values | Where-Object { $_ -eq $true }).Count
$total = $results.Count
$failed = $total - $passed
Log "SUMMARY: passed=$passed failed=$failed total=$total"
Log "Logs: $logDir"

$summary = [ordered]@{
  generatedAt = (Get-Date).ToString("o")
  computer = $env:COMPUTERNAME
  passed = $passed
  failed = $failed
  total = $total
  results = $results
  logDirectory = $logDir
}
$summary | ConvertTo-Json -Depth 6 | Out-File (Join-Path $logDir "summary.json") -Encoding utf8

Write-Host ""
Write-Host "ModelPro basic test finished. Log folder:"
Write-Host $logDir
if ($failed -gt 0) { exit 1 }
exit 0
