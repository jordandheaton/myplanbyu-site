<#
  Start the myplanBYU AI Advisor backend.

    .\run_advisor.ps1                 # localhost only (local development)
    .\run_advisor.ps1 -Origin https://jordandheaton.github.io -Proxies 1
                                      # behind a tunnel, for the live site

  The planner itself is a static site and needs no server. This is only the
  advisor: it retrieves grounded BYU data from Pinecone and answers with Claude,
  so it costs real money per question and ships with a per-visitor quota plus a
  monthly spend cap (see advisor_limits.py).

  Keys come from scraper/.env (PINECONE_API_KEY, ANTHROPIC_API_KEY) -- this
  script never handles them.

  ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less scripts as ANSI,
  so a stray em dash in a string is a parse error rather than a typo.
#>
[CmdletBinding()]
param(
  # Public origin allowed to call the API (your deployed site). Omit for local
  # work: the server then accepts localhost pages only, which is the safe default.
  [string] $Origin = "",
  # Reverse-proxy / tunnel hops to trust for X-Forwarded-For. Leave 0 locally;
  # set to 1 behind a single tunnel or every visitor shares one quota bucket.
  [int] $Proxies = 0,
  [int] $Port = 5000,
  # Questions each visitor gets per 24h (server default 10). With -Proxies set
  # correctly this counts REAL visitors; without it, everyone behind the tunnel
  # shares one bucket and a feedback round runs out almost immediately.
  # The monthly spend cap, not this, is the real money guard.
  [int] $Questions = 0,
  # Monthly SPEND CAP in USD (server default 5.00). This is the real money
  # guard -- and it is NOT your Anthropic account balance. Topping up the
  # account does nothing on its own: the guard pauses the advisor once this
  # many dollars of questions have been answered in the calendar month, and
  # it resets on the 1st while the balance does not. Leave headroom below the
  # balance for the monthly refresh, which uses the same key for flowchart
  # extraction.
  [double] $Budget = 0,
  # Stop an instance already holding the port and start a fresh one. Needed
  # whenever settings change: -Origin, -Proxies and the Python code itself are
  # all read ONLY at startup, so an already-running server silently keeps the
  # old behaviour. Without this the script just says "already running" and does
  # nothing, which reads as "it didn't work".
  [switch] $Restart
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$py = "C:\Users\jorda\venvs\myplan-scraper\Scripts\python.exe"
if (-not (Test-Path $py)) {
  throw "Advisor venv not found at $py. See scraper/README_SCRAPER.md to create it."
}
if (-not (Test-Path (Join-Path $here ".env"))) {
  throw "scraper/.env not found -- it must define PINECONE_API_KEY and ANTHROPIC_API_KEY."
}

# Already running? Starting a second instance just fails to bind the port.
$running = $false
try {
  $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3 -UseBasicParsing
  if ($probe.StatusCode -eq 200) { $running = $true }
} catch { }   # not running, which is the normal case

if ($running -and -not $Restart) {
  Write-Host "Advisor is ALREADY RUNNING on port $Port -- nothing started." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "If you changed -Origin, -Proxies, or any Python code, that running" -ForegroundColor Yellow
  Write-Host "server is still using the OLD settings: they are read once, at startup." -ForegroundColor Yellow
  Write-Host "Re-run with -Restart to stop it and start a fresh one:" -ForegroundColor Yellow
  Write-Host "  .\run_advisor.ps1 -Restart$(if ($Origin) { " -Origin $Origin" })$(if ($Proxies) { " -Proxies $Proxies" })" -ForegroundColor Cyan
  exit 0
}

if ($running -and $Restart) {
  Write-Host "Stopping the instance on port $Port ..." -ForegroundColor Yellow
  $pids = @()
  try {
    $pids = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess -Unique
  } catch {
    # Get-NetTCPConnection is absent on some builds; fall back to netstat.
    $pids = (netstat -ano | Select-String ":$Port\s.*LISTENING") -replace '.*\s(\d+)$', '$1' | Sort-Object -Unique
  }
  foreach ($procId in $pids) {
    try { Stop-Process -Id $procId -Force -ErrorAction Stop; Write-Host "  stopped PID $procId" -ForegroundColor DarkGray }
    catch { Write-Host "  could not stop PID ${procId}: $_" -ForegroundColor Red }
  }
  # Wait for the socket to actually free up, or the new server fails to bind.
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 250
    try { Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 -UseBasicParsing | Out-Null }
    catch { break }
  }
}

if ($Origin) { $env:ADVISOR_ALLOWED_ORIGINS = $Origin }
if ($Questions -gt 0) { $env:ADVISOR_QUESTIONS_PER_IP = "$Questions" }
if ($Budget -gt 0) { $env:ADVISOR_MONTHLY_BUDGET_USD = ("{0:F2}" -f $Budget) }
$env:ADVISOR_TRUSTED_PROXIES = "$Proxies"
$env:ADVISOR_PORT = "$Port"

Write-Host "Starting advisor on http://127.0.0.1:$Port/api ..." -ForegroundColor Cyan
if ($Origin) { Write-Host "  CORS: localhost + $Origin" -ForegroundColor DarkGray }
else { Write-Host "  CORS: localhost only (pass -Origin to allow your live site)" -ForegroundColor DarkGray }
Write-Host "  First start loads the embedding model and can take ~30s." -ForegroundColor DarkGray

Set-Location $here
& $py advisor_server.py
