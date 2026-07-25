# setup_schedule.ps1 -- registers the two myplanBYU refresh tasks.
# ============================================================================
# ASCII ONLY (PowerShell 5.1 reads a no-BOM script as ANSI).
#
# Run ONCE (re-running is safe -- /F overwrites):
#   .\setup_schedule.ps1
#
#   .\setup_schedule.ps1 -Remove    # unregister both tasks
#   .\setup_schedule.ps1 -Status    # show state + last result of both tasks
#
# Tasks created, under the Task Scheduler folder "myplanBYU":
#   myplanBYU\weekly core refresh    Sunday 03:00        -> refresh_core.ps1
#   myplanBYU\monthly full refresh   1st Sunday 04:00    -> refresh_full.ps1
#
# WHY TASK XML instead of Register-ScheduledTask: PowerShell 5.1's
# New-ScheduledTaskTrigger cannot express "first Sunday of the month" (it has
# -Once/-Daily/-Weekly only). XML also makes every setting below explicit and
# reviewable rather than relying on defaults.
#
# WHY IT RUNS LOGGED-ON ONLY (InteractiveToken, not a stored password):
#   - 'git push' needs Windows Credential Manager, which wants the user session
#   - scraper\.env (Pinecone / Anthropic keys) lives in the user profile
#   - the failure toast needs a desktop session to appear on
# Trade-off, accepted at design time: refreshes fire only when you are logged
# in. StartWhenAvailable below means a run missed while the PC was off happens
# on next wake rather than being skipped entirely.

param(
  [switch]$Remove,
  [switch]$Status
)

$ErrorActionPreference = "Stop"

$here     = $PSScriptRoot
$folder   = "myplanBYU"
$coreName = "$folder\weekly core refresh"
$fullName = "$folder\monthly full refresh"
$user     = "$env:USERDOMAIN\$env:USERNAME"

function Esc([string]$s) {
  # XML-escape a value going into the task definition.
  return $s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;")
}

if ($Status) {
  foreach ($n in @($coreName, $fullName)) {
    Write-Host ""
    Write-Host ("=== {0} ===" -f $n)
    & schtasks /Query /TN $n /FO LIST /V 2>&1 |
      Select-String -Pattern "TaskName|Status|Last Run Time|Last Result|Next Run Time|Scheduled Task State" |
      ForEach-Object { Write-Host ("  " + $_.Line.Trim()) }
  }
  Write-Host ""
  $lastRun = Join-Path $here "data\_last_run.json"
  if (Test-Path $lastRun) {
    $s = Get-Content $lastRun -Raw | ConvertFrom-Json
    Write-Host ("last pipeline run: {0} -- {1} ({2}) published={3}" -f `
                $s.job, $s.outcome, $s.ended, $s.published)
  } else {
    Write-Host "last pipeline run: none recorded yet (data\_last_run.json absent)"
  }
  exit 0
}

if ($Remove) {
  foreach ($n in @($coreName, $fullName)) {
    & schtasks /Delete /TN $n /F 2>&1 | ForEach-Object { Write-Host $_ }
  }
  exit 0
}

# --- sanity: the scripts the tasks will point at must exist ------------------
foreach ($f in @("refresh_core.ps1", "refresh_full.ps1", "_pipeline.ps1", "_sanity_check.py")) {
  if (-not (Test-Path (Join-Path $here $f))) {
    throw ("missing {0} -- run this from the scraper folder" -f $f)
  }
}

# StartBoundary needs a concrete first-occurrence date. Task Scheduler rolls it
# forward by the recurrence pattern, so the next matching Sunday is enough.
$nextSunday = (Get-Date).Date
while ($nextSunday.DayOfWeek -ne [DayOfWeek]::Sunday) { $nextSunday = $nextSunday.AddDays(1) }
$coreStart = $nextSunday.AddHours(3).ToString("yyyy-MM-ddTHH:mm:ss")
$fullStart = $nextSunday.AddHours(4).ToString("yyyy-MM-ddTHH:mm:ss")

function New-TaskXml {
  param(
    [string]$Description,
    [string]$ScriptName,
    [string]$StartBoundary,
    [string]$TriggerXml,
    [string]$TimeLimit      # ISO 8601 duration, e.g. PT2H
  )
  $ps1 = Join-Path $here $ScriptName
  # Not $args -- that is a PowerShell automatic variable.
  $argStr = '-ExecutionPolicy Bypass -NoProfile -NonInteractive -File "{0}"' -f $ps1

  return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>$(Esc $Description)</Description>
    <Author>$(Esc $user)</Author>
  </RegistrationInfo>
  <Triggers>
$TriggerXml
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$(Esc $user)</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <!-- Allowed on battery: a skipped run is another way to go silently stale. -->
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>$TimeLimit</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>$(Esc $argStr)</Arguments>
      <WorkingDirectory>$(Esc $here)</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
}

$coreTrigger = @"
    <CalendarTrigger>
      <StartBoundary>$coreStart</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByWeek>
        <DaysOfWeek><Sunday /></DaysOfWeek>
        <WeeksInterval>1</WeeksInterval>
      </ScheduleByWeek>
    </CalendarTrigger>
"@

$fullTrigger = @"
    <CalendarTrigger>
      <StartBoundary>$fullStart</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByMonthDayOfWeek>
        <Weeks><Week>1</Week></Weeks>
        <DaysOfWeek><Sunday /></DaysOfWeek>
        <Months>
          <January /><February /><March /><April /><May /><June />
          <July /><August /><September /><October /><November /><December />
        </Months>
      </ScheduleByMonthDayOfWeek>
    </CalendarTrigger>
"@

$tasks = @(
  @{
    Name    = $coreName
    Xml     = New-TaskXml -Description "myplanBYU weekly data refresh: catalog, academic dates, MAP sheets, regenerate planner data, publish if the sanity gate passes." `
                          -ScriptName "refresh_core.ps1" -StartBoundary $coreStart `
                          -TriggerXml $coreTrigger -TimeLimit "PT2H"
  },
  @{
    Name    = $fullName
    Xml     = New-TaskXml -Description "myplanBYU monthly full refresh: all sources, flowchart extraction, regenerate, re-embed to Pinecone, publish if the sanity gate passes." `
                          -ScriptName "refresh_full.ps1" -StartBoundary $fullStart `
                          -TriggerXml $fullTrigger -TimeLimit "PT6H"
  }
)

foreach ($t in $tasks) {
  # Task XML must be UTF-16 (the declaration says so and schtasks enforces it).
  $tmp = Join-Path $env:TEMP ("myplan-task-" + [guid]::NewGuid().ToString("N") + ".xml")
  $t.Xml | Out-File -FilePath $tmp -Encoding unicode
  try {
    $out = & schtasks /Create /TN $t.Name /XML $tmp /F 2>&1
    $out | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
      throw ("schtasks /Create failed for '{0}' (exit {1})" -f $t.Name, $LASTEXITCODE)
    }
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ""
Write-Host "Registered:"
Write-Host ("  {0}   Sunday 03:00" -f $coreName)
Write-Host ("  {0}  first Sunday 04:00" -f $fullName)
Write-Host ""
Write-Host "Verify with:  .\setup_schedule.ps1 -Status"
Write-Host "Test now:     schtasks /Run /TN `"$coreName`""
