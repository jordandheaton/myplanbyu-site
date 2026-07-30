# refresh_core.ps1 -- WEEKLY myplanBYU data refresh (Sunday 03:00).
# ============================================================================
# ASCII ONLY (PowerShell 5.1 reads a no-BOM script as ANSI).
#
# Replaces the old refresh_maps.ps1. Pulls the catalog, this term's academic
# dates, and any new/changed MAP sheet PDFs, regenerates the planner data, then
# publishes if the sanity gate passes.
#
#   .\refresh_core.ps1              # normal (scheduled) run
#   .\refresh_core.ps1 -NoPublish   # full pipeline, stop before git
#   .\refresh_core.ps1 -Force       # re-fetch every MAP sheet, not just changed
#
# STEP ORDER IS LOAD-BEARING: sources\maps.py reads data\catalog.json, and
# generate_data.py merges the MAP plans, so it runs after both.
#
# The MAP cache self-invalidates: when BYU uploads a new sheet its file path
# changes, so only that sheet re-downloads. -Force overrides that.
#
# Log: scraper\refresh_core.log   Status: scraper\data\_last_run.json

param(
  [switch]$Force,
  [switch]$NoPublish
)

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
. "$PSScriptRoot\_pipeline.ps1"

Start-RefreshRun -JobName "weekly-core" -LogFile "refresh_core.log"

try {
  $py = Initialize-ScraperEnv
} catch {
  exit (Stop-RefreshRunWithError -Message ("environment preflight failed: " + $_.Exception.Message))
}

$mapsArgs = @("sources\maps.py")
if ($Force) {
  $mapsArgs += "--force"
  Write-Log "maps: -Force set, re-fetching every sheet"
}

try {
  # Catalog first -- maps.py resolves MAP file refs out of catalog.json.
  Invoke-Step -Name "catalog"  -Arguments @("sources\catalog.py")        -Python $py -Fatal | Out-Null
  # Promoted to weekly: add/drop and withdraw deadlines are the most perishable
  # data in the set, and this is 8 documents off two pages.
  Invoke-Step -Name "dates"    -Arguments @("sources\academic_dates.py") -Python $py         | Out-Null
  Invoke-Step -Name "maps"     -Arguments $mapsArgs                      -Python $py -Fatal | Out-Null
  Invoke-Step -Name "generate" -Arguments @("generate_data.py")           -Python $py -Fatal | Out-Null
  Invoke-Step -Name "timeline" -Arguments @("generate_timeline.py")       -Python $py -Fatal | Out-Null
  # Class schedule LAST and NON-FATAL. It is the only step whose data is a
  # nice-to-have -- every plan is still correct without instructor names -- and
  # it depends on js\catalog_data.js, which the generate step above rewrites.
  # Weekly is the right cadence: sections are added, cancelled and reassigned
  # right through the registration window.
  Invoke-Step -Name "sections" -Arguments @("sources\class_schedule.py")  -Python $py         | Out-Null
  Invoke-Step -Name "schedule" -Arguments @("generate_schedule.py")        -Python $py         | Out-Null
} catch {
  exit (Stop-RefreshRunWithError -Message $_.Exception.Message)
}

exit (Complete-RefreshRun -Python $py -NoPublish:$NoPublish)
