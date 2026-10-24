<#
  myplanBYU - headless solver test runner.

  Runs tests/index.html in headless Edge and writes the result to disk. No
  server needed: the page loads over file:// because every dependency is a
  <script src>, not a fetch.

    .\headless.ps1                  # curated cases, print summary, exit 1 on failure
    .\headless.ps1 -Mode sweep      # all 175 majors, invariants only
    .\headless.ps1 -Record          # re-record tests/goldens.js
    .\headless.ps1 -Json out.json   # also write the full report as JSON

  Exit code is 0 when every case passes, 1 otherwise - so this drops into a
  GitHub Actions step (windows-latest ships Edge) without further plumbing.

  NOTE: this file is deliberately ASCII-only. Windows PowerShell 5.1 reads
  BOM-less scripts as ANSI, and a stray em dash in a string becomes a parse
  error rather than a typo.
#>
[CmdletBinding()]
param(
  [ValidateSet("curated", "sweep", "taxonomy")] [string] $Mode = "curated",
  [switch] $Record,
  [string] $Json,
  [int] $LimitMajors = 0,
  [int] $TimeoutSec = 300
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) {
  throw "Microsoft Edge not found. Install it, or open tests/index.html in any browser instead."
}

if ($Record -and $Mode -ne "curated") {
  throw "Goldens are recorded from the curated cases only."
}
# the taxonomy crosses 175 majors with 4 student states - it needs the room
if ($Mode -eq "taxonomy" -and $TimeoutSec -lt 900) { $TimeoutSec = 900 }
$emit = if ($Record) { "goldens" } else { "report" }

# Spaces MUST be percent-encoded: Start-Process joins -ArgumentList without
# quoting, so a raw space in the path ("OneDrive - Brigham Young University")
# reaches Edge as several arguments and it refuses with
# "Multiple targets are not supported in headless mode."
$urlPath = ($here -replace '\\', '/') -replace ' ', '%20'
$url = "file:///" + $urlPath + "/index.html?run=" + $Mode + "&emit=" + $emit
if ($LimitMajors -gt 0) { $url = $url + "&limit=" + $LimitMajors }
$profileDir = Join-Path ([System.IO.Path]::GetTempPath()) ("myplan-tests-" + [guid]::NewGuid().ToString("N"))
$dump = [System.IO.Path]::GetTempFileName()
$errFile = [System.IO.Path]::GetTempFileName()

Write-Host "running $Mode cases in headless Edge..." -ForegroundColor Cyan
try {
  $edgeArgs = @(
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--allow-file-access-from-files",
    "--user-data-dir=$profileDir",
    "--virtual-time-budget=$($TimeoutSec * 1000)",
    "--dump-dom", $url
  )
  # stdout carries the DOM; Edge chatters on stderr, which we discard
  $proc = Start-Process -FilePath $edge -ArgumentList $edgeArgs -NoNewWindow -PassThru `
            -RedirectStandardOutput $dump -RedirectStandardError $errFile
  if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
    $proc.Kill()
    throw "timed out after $TimeoutSec seconds"
  }

  $html = Get-Content $dump -Raw -Encoding UTF8
  # -match, not -notmatch: only -match populates $Matches
  if (-not ($html -match '(?s)<pre id="emit"[^>]*>(.*?)</pre>')) {
    throw "the page did not finish - no #emit payload in the dumped DOM. Try a larger -TimeoutSec."
  }
  $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Matches[1].Trim()))

  if ($Record) {
    Set-Content -Path (Join-Path $here "goldens.js") -Value $payload -Encoding utf8 -NoNewline
    Write-Host "recorded goldens.js ($($payload.Length) bytes)" -ForegroundColor Green
    exit 0
  }

  if ($Json) { Set-Content -Path $Json -Value $payload -Encoding utf8 }

  if ($Mode -eq "taxonomy") {
    $sum = $payload | ConvertFrom-Json
    Write-Host ""
    Write-Host ("{0} of {1} combinations have a symptom ({2} clean) in {3} ms" -f `
      $sum.affected, $sum.combinations, $sum.clean, $sum.ms) -ForegroundColor Cyan
    Write-Host ""
    Write-Host "SYMPTOMS, worst first" -ForegroundColor White
    foreach ($s in $sum.symptoms) {
      $c = if ($s.weight -ge 30) { "Red" } elseif ($s.weight -ge 15) { "Yellow" } else { "Magenta" }
      Write-Host ("  {0,4}  {1}  ({2} majors)" -f $s.count, $s.title, $s.majors) -ForegroundColor $c
      foreach ($e in ($s.examples | Select-Object -First 3)) {
        Write-Host ("        - {0} ({1}): {2}" -f $e.major, $e.state, $e.detail) -ForegroundColor DarkGray
      }
    }
    Write-Host ""
    Write-Host "WORST COMBINATIONS" -ForegroundColor White
    foreach ($w in ($sum.worst | Select-Object -First 10)) {
      Write-Host ("  {0,4}  {1} ({2}) - {3}" -f $w.score, $w.major, $w.state, ($w.symptoms -join ", ")) `
        -ForegroundColor DarkGray
    }
    exit 0
  }

  $report = $payload | ConvertFrom-Json

  $t = $report.totals
  $color = if ($t.fail -eq 0) { "Green" } else { "Red" }
  Write-Host ""
  Write-Host ("{0}/{1} passed  ({2} failed, {3} known, {4} warnings) in {5} ms" -f `
    $t.pass, $t.cases, $t.fail, $t.known, $t.warn, $report.ms) -ForegroundColor $color

  foreach ($c in ($report.cases | Where-Object { $_.violations | Where-Object { $_.severity -eq "known" } })) {
    Write-Host ""
    Write-Host ("KNOWN  " + $c.name) -ForegroundColor Magenta
    foreach ($v in ($c.violations | Where-Object { $_.severity -eq "known" })) {
      Write-Host ("       " + $v.rule + ": " + $v.msg) -ForegroundColor Magenta
    }
  }

  foreach ($c in ($report.cases | Where-Object { -not $_.ok })) {
    Write-Host ""
    Write-Host ("FAIL  " + $c.name) -ForegroundColor Red
    if ($c.crash) {
      Write-Host ("      crashed: " + $c.crash.Split("`n")[0]) -ForegroundColor Red
    }
    if ($c.golden -eq "changed") {
      Write-Host "      plan changed vs golden:" -ForegroundColor Yellow
      $shown = 0
      foreach ($d in $c.goldenDiff) {
        if ($shown -ge 12) {
          Write-Host ("      ... and " + ($c.goldenDiff.Count - 12) + " more (open tests/index.html for the full diff)") -ForegroundColor DarkYellow
          break
        }
        Write-Host ("        " + $d) -ForegroundColor Yellow
        $shown++
      }
    }
    foreach ($v in ($c.violations | Where-Object { $_.severity -eq "fail" })) {
      Write-Host ("      " + $v.rule + ": " + $v.msg) -ForegroundColor Red
    }
  }

  if ($t.fail -eq 0) { exit 0 } else { exit 1 }
}
finally {
  Remove-Item $dump -ErrorAction SilentlyContinue
  Remove-Item $errFile -ErrorAction SilentlyContinue
  Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue
}
