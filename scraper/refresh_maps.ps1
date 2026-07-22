# refresh_maps.ps1 -- one-shot MAP-sheet refresh pipeline (ASCII only: PS 5.1
# reads no-BOM scripts as ANSI, and smart punctuation breaks string parsing).
# ============================================================================
# Re-pulls the BYU catalog, fetches any NEW/CHANGED MAP sheet PDFs (the cache
# self-invalidates: when BYU uploads a new sheet its file path changes, and
# only that sheet re-downloads), re-parses them, and regenerates the app data.
#
#   .\refresh_maps.ps1              # incremental (recommended)
#   .\refresh_maps.ps1 -Force       # re-fetch every sheet
#
# Log: scraper\refresh_maps.log (appended, timestamped per run)
# When proven reliable, schedule weekly via Task Scheduler:
#   schtasks /Create /SC WEEKLY /D SUN /ST 03:00 /TN "myplanBYU MAP refresh"
#     /TR "powershell -ExecutionPolicy Bypass -File '<full path>\refresh_maps.ps1'"

param([switch]$Force)

$ErrorActionPreference = "Continue"
$here = Split-Path $MyInvocation.MyCommand.Path -Parent
$py = "C:\Users\jorda\venvs\myplan-scraper\Scripts\python.exe"
$log = Join-Path $here "refresh_maps.log"

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding utf8
}

Set-Location $here
Log "=== MAP refresh run started (force=$Force) ==="

$mapsArgs = @("sources\maps.py")
if ($Force) { $mapsArgs += "--force" }
$steps = @(
  @{ name = "catalog";  args = @("sources\catalog.py") },
  @{ name = "maps";     args = $mapsArgs },
  @{ name = "generate"; args = @("generate_data.py") }
)

$failed = $false
foreach ($s in $steps) {
  Log ("step: {0} ..." -f $s.name)
  $out = & $py $s.args 2>&1
  $out | ForEach-Object { Add-Content -Path $log -Value ("    {0}" -f $_) -Encoding utf8 }
  if ($LASTEXITCODE -ne 0) {
    Log ("step {0} FAILED (exit {1}) -- aborting run" -f $s.name, $LASTEXITCODE)
    $failed = $true
    break
  }
  Log ("step {0} OK" -f $s.name)
}

if (-not $failed) {
  # surface the health report so regressions are visible in the log
  $health = Join-Path $here "data\_health_report.txt"
  if (Test-Path $health) {
    $n = (Get-Content $health | Measure-Object -Line).Lines
    Log ("health report: {0} findings (data\_health_report.txt)" -f $n)
  }
  Log "=== MAP refresh completed OK ==="
} else {
  Log "=== MAP refresh FAILED -- js/catalog_data.js unchanged past the failing step ==="
}
