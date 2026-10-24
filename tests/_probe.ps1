<#
  myplanBYU - solver PROBE driver (local-only diagnostic, not the test suite).

  headless.ps1 runs the suite and tells you pass/fail. This runs _probe.html
  and hands you the raw measurements behind the taxonomy, as JSON.

    .\_probe.ps1 -Out rows.json
    .\_probe.ps1 -Out rows.json -Limit 25
    .\_probe.ps1 -Mode board -Major major-elementary-education-bs -Out board.json
    .\_probe.ps1 -Mode board -Major major-art-bfa -Completed -Out board.json

  ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less scripts as
  ANSI, so an em dash in a string is a parse error, not a typo.
#>
[CmdletBinding()]
param(
  [ValidateSet("rows", "board", "gradstress")] [string] $Mode = "rows",
  [string] $Out = "probe.json",
  [string] $Major = "",
  [switch] $Completed,
  [switch] $Minor,
  [string] $Target = "",
  [int] $Limit = 0,
  [int] $TimeoutSec = 900
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge not found." }
if ($Mode -eq "board" -and -not $Major) { throw "-Mode board needs -Major <majorId>" }

# spaces MUST be percent-encoded - see headless.ps1
$urlPath = ($here -replace '\\', '/') -replace ' ', '%20'
$url = "file:///" + $urlPath + "/_probe.html?mode=" + $Mode
if ($Major)     { $url = $url + "&major=" + $Major }
if ($Target)    { $url = $url + "&target=" + $Target }
if ($Completed) { $url = $url + "&completed=1" }
if ($Minor)     { $url = $url + "&minor=1" }
if ($Limit -gt 0) { $url = $url + "&limit=" + $Limit }

$profileDir = Join-Path ([System.IO.Path]::GetTempPath()) ("myplan-probe-" + [guid]::NewGuid().ToString("N"))
$dump = [System.IO.Path]::GetTempFileName()
$errFile = [System.IO.Path]::GetTempFileName()
try {
  $edgeArgs = @(
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--allow-file-access-from-files", "--user-data-dir=$profileDir",
    "--virtual-time-budget=$($TimeoutSec * 1000)", "--dump-dom", $url
  )
  $proc = Start-Process -FilePath $edge -ArgumentList $edgeArgs -NoNewWindow -PassThru `
            -RedirectStandardOutput $dump -RedirectStandardError $errFile
  if (-not $proc.WaitForExit($TimeoutSec * 1000)) { $proc.Kill(); throw "timed out after $TimeoutSec seconds" }
  $html = Get-Content $dump -Raw -Encoding UTF8
  if (-not ($html -match '(?s)<pre id="emit"[^>]*>(.*?)</pre>')) {
    throw "the page did not finish - no #emit payload. Try a larger -TimeoutSec."
  }
  $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Matches[1].Trim()))
  Set-Content -Path $Out -Value $payload -Encoding utf8 -NoNewline
  Write-Host ("wrote {0} ({1} bytes)" -f $Out, $payload.Length) -ForegroundColor Green
}
finally {
  Remove-Item $dump, $errFile -ErrorAction SilentlyContinue
  Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue
}
