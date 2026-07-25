# refresh_full.ps1 -- MONTHLY myplanBYU data refresh (first Sunday 04:00).
# ============================================================================
# ASCII ONLY (PowerShell 5.1 reads a no-BOM script as ANSI).
#
# Everything refresh_core.ps1 does, plus the nine slower-moving sources, the
# Claude-assisted flowchart extraction, and the Pinecone re-embed that keeps the
# RAG advisor's index current.
#
#   .\refresh_full.ps1              # normal (scheduled) run
#   .\refresh_full.ps1 -NoPublish   # full pipeline, stop before git
#   .\refresh_full.ps1 -SkipEmbed   # skip Pinecone (no API spend / offline)
#
# FAILURE POLICY differs by step class, on purpose:
#   - a single SOURCE failing is logged and skipped. Kennedy's server answers
#     bursts with 403s and clubs.py rides the Mendix /xas/ protocol, which BYU
#     can change without notice -- neither should cost us the other sources.
#   - a GENERATE or EMBED step failing is fatal, because those produce what
#     actually ships.
#
# Log: scraper\refresh_full.log   Status: scraper\data\_last_run.json

param(
  [switch]$Force,
  [switch]$NoPublish,
  [switch]$SkipEmbed
)

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
. "$PSScriptRoot\_pipeline.ps1"

Start-RefreshRun -JobName "monthly-full" -LogFile "refresh_full.log"

try {
  $py = Initialize-ScraperEnv
} catch {
  exit (Stop-RefreshRunWithError -Message ("environment preflight failed: " + $_.Exception.Message))
}

# Non-fatal, order-independent. Kennedy paces itself at 0.7s/page (~3 min).
$sources = @(
  @{ name = "marriott";    script = "sources\marriott_business.py" },
  @{ name = "languages";   script = "sources\language_certs.py" },
  @{ name = "studyabroad"; script = "sources\kennedy_scraper.py" },
  @{ name = "policies";    script = "sources\policy_scraper.py" },
  @{ name = "dates";       script = "sources\academic_dates.py" },
  @{ name = "grants";      script = "sources\research_grants.py" },
  @{ name = "clubs";       script = "sources\clubs.py" },
  @{ name = "transfer";    script = "sources\transfer_credit.py" },
  @{ name = "tuition";     script = "sources\tuition_graduation.py" },
  @{ name = "flowcharts";  script = "sources\flowcharts.py" }
)

$mapsArgs = @("sources\maps.py")
if ($Force) {
  $mapsArgs += "--force"
  Write-Log "maps: -Force set, re-fetching every sheet"
}

try {
  # Catalog first -- maps.py resolves MAP file refs out of catalog.json.
  Invoke-Step -Name "catalog" -Arguments @("sources\catalog.py") -Python $py -Fatal | Out-Null

  foreach ($s in $sources) {
    Invoke-Step -Name $s.name -Arguments @($s.script) -Python $py | Out-Null
  }

  # Depends on flowcharts.py output; uses claude-haiku-4-5 at temperature 0.
  # Non-fatal: a hiccup here leaves the previous, still-valid flowchart_plans.json
  # in place, and generate_data.py falls back through MAP hints and level pacing.
  Invoke-Step -Name "flowchart-plans" -Arguments @("extract_flowchart_plans.py") -Python $py | Out-Null

  Invoke-Step -Name "maps"     -Arguments $mapsArgs                -Python $py -Fatal | Out-Null
  Invoke-Step -Name "generate" -Arguments @("generate_data.py")     -Python $py -Fatal | Out-Null
  Invoke-Step -Name "timeline" -Arguments @("generate_timeline.py") -Python $py -Fatal | Out-Null

  if ($SkipEmbed) {
    Write-Log "embed: skipped (-SkipEmbed)"
  } else {
    # Upserts overwrite by ID, so re-running is idempotent. Needs
    # PINECONE_API_KEY in scraper\.env.
    Invoke-Step -Name "embed" -Arguments @("embed_and_load.py") -Python $py -Fatal | Out-Null
  }
} catch {
  exit (Stop-RefreshRunWithError -Message $_.Exception.Message)
}

exit (Complete-RefreshRun -Python $py -NoPublish:$NoPublish)
