# publish_site.ps1 -- mirror the myplanBYU SITE (and only the site) into the
# standalone deploy repo that serves myplan.jordanheaton.com.
# ============================================================================
# ASCII ONLY (PowerShell 5.1 reads a no-BOM script as ANSI).
#
# WHY THIS EXISTS. myplanBYU shares jordanheaton.com with Jordan's portfolio
# (face photos, resume). For a broader audience he wants a URL that does not
# put the portfolio one path-trim away, and GitHub Pages allows exactly one
# custom domain per repo -- so the subdomain needs its own repo. Moving the
# whole working tree there would have broken the scheduled tasks, the
# Scholarship Matcher path that generate_timeline.py reads, and the ~10 early
# testers whose plans live in jordanheaton.com localStorage. So the working
# tree STAYS where it is and this script mirrors the deployable files out.
#
# The deploy repo only ever sees: index.html, css/, js/, the favicons, CNAME.
# It never sees scraper/ -- which is where .env (API keys) and feedback.jsonl
# (student text) live -- so a leak there is structurally impossible, not just
# gitignored. tests/ and HANDOFF.md stay local for the same reason as ever.
#
# Called at the end of refresh_core.ps1 (weekly, non-fatal) and by hand:
#   powershell -File publish_site.ps1              # copy + commit + push
#   powershell -File publish_site.ps1 -NoPush      # copy + commit only

param(
  [string]$DeployRepo = "C:\Users\jorda\repos\myplanbyu-site",
  [switch]$NoPush
)
$ErrorActionPreference = "Stop"
$src = Split-Path -Parent $PSScriptRoot     # ...\Portfolio\myplanBYU

if (-not (Test-Path (Join-Path $DeployRepo ".git"))) {
  Write-Host "deploy repo not found at $DeployRepo -- run the one-time setup first" -ForegroundColor Red
  exit 1
}

# mirror the site files; -Force overwrites, stale css/js are pruned below
foreach ($f in @("index.html", "favicon.ico", "favicon.svg", "apple-touch-icon.png")) {
  Copy-Item (Join-Path $src $f) $DeployRepo -Force
}
foreach ($d in @("css", "js")) {
  $dst = Join-Path $DeployRepo $d
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  Copy-Item (Join-Path $src $d) $dst -Recurse
}
# the custom domain lives IN the pages branch
Set-Content -Path (Join-Path $DeployRepo "CNAME") -Value "myplan.jordanheaton.com" -Encoding ascii

Set-Location $DeployRepo
& git add -A | Out-Null
$dirty = (& git status --porcelain) -join ""
if (-not $dirty) { Write-Host "publish_site: nothing changed"; exit 0 }
& git commit -m "sync site from working tree ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))" | Out-Null
if ($NoPush) { Write-Host "publish_site: committed (push skipped)"; exit 0 }
& git push origin main
if ($LASTEXITCODE -ne 0) { Write-Host "publish_site: PUSH FAILED" -ForegroundColor Red; exit 1 }
Write-Host "publish_site: pushed to myplan.jordanheaton.com" -ForegroundColor Green
