# read_feedback.ps1 -- print feedback reports from the advisor Worker's D1.
# ============================================================================
# Feedback used to land in scraper\data\feedback.jsonl on this PC; the Worker
# writes it to the myplan-advisor D1 database instead. This prints each report
# in the same shape as the old file, newest last.
#
#   .\read_feedback.ps1              # all reports
#   .\read_feedback.ps1 -Last 5     # just the newest five

param([int]$Last = 0)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path", "User")

$sql = "SELECT body FROM feedback ORDER BY at"
$raw = npx wrangler d1 execute myplan-advisor --remote --json --command $sql 2>$null
# wrangler returns pretty-printed JSON, which PowerShell hands back as an ARRAY
# OF LINES. Piping that straight into ConvertFrom-Json parses line-by-line and
# silently yields nothing -- the reader reported "0 report(s)" with three rows
# sitting in the table. Join first.
$rows = @((($raw -join "`n") | ConvertFrom-Json)[0].results)
if (-not $rows -or $rows.Count -eq 0) { Write-Host "No reports (or the query failed)."; exit 0 }
if ($Last -gt 0 -and $rows.Count -gt $Last) { $rows = $rows | Select-Object -Last $Last }
foreach ($r in $rows) {
    $b = $r.body | ConvertFrom-Json
    Write-Host ("=== {0}  [{1}]  {2}" -f $b.at, ($b.kind, "general" | Where-Object { $_ })[0], $b.email) -ForegroundColor Cyan
    if ($b.where) { Write-Host ("where: " + $b.where) }
    Write-Host $b.what
    if ($b.expected) { Write-Host ("expected: " + $b.expected) -ForegroundColor DarkGray }
    Write-Host ""
}
Write-Host ("{0} report(s)." -f $rows.Count)
