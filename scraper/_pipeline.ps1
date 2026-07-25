# _pipeline.ps1 -- shared library for the scheduled myplanBYU refresh jobs.
# ============================================================================
# ASCII ONLY. PowerShell 5.1 reads a no-BOM script as ANSI, so smart quotes and
# dashes break string parsing. No '&&', no ternary, no '??' either -- 5.1 has
# none of them.
#
# Dot-source this; it defines functions and does nothing on load:
#   . "$PSScriptRoot\_pipeline.ps1"
#
# Consumers: refresh_core.ps1 (weekly), refresh_full.ps1 (monthly).

# Deliberately NO Set-StrictMode: version 2.0 throws on any reference to a
# missing property, which would turn an absent metric (e.g. health_findings on a
# run where the report was not regenerated) into a false "run failed" alert.
# These scripts are short and exercised end to end instead.

# --- configuration ----------------------------------------------------------
$VENV_PATH   = "C:\Users\jorda\venvs\myplan-scraper"
$VENV_PY     = Join-Path $VENV_PATH "Scripts\python.exe"
# The venv lives OUTSIDE OneDrive on purpose: a torch-sized venv inside a synced
# folder is what corrupted the old scraper\.venv and hit the 260-char path cap.
$SYSTEM_PY   = "C:\Users\jorda\AppData\Local\Programs\Python\Python312\python.exe"
$REPO_ROOT   = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$SCRAPER_DIR = $PSScriptRoot
$DATA_DIR    = Join-Path $PSScriptRoot "data"

# Logs live OUTSIDE OneDrive, for the same reason the venv does.
#
# This is not hypothetical. A run whose log sits in the synced folder loses the
# ENTIRE log the moment anything else holds the file open -- OneDrive's own sync,
# an editor, a 'tail -f' -- because Add-Content cannot open it for write. The
# result is a log containing the first two lines and no verdict, which is
# precisely what refresh_maps.log showed after the 2026-07-22 run and what a
# verification run reproduced on 2026-07-24. Losing the log defeats the whole
# point of scheduling: the failure becomes invisible.
$LOG_DIR = Join-Path $env:LOCALAPPDATA "myplanBYU\logs"

# Files the jobs are allowed to commit. Explicit list, never 'git add -A' --
# the working tree routinely holds unrelated in-progress portfolio work.
$PUBLISH_PATHS = @(
  "myplanBYU/js/catalog_data.js",
  "myplanBYU/js/timeline_data.js",
  "myplanBYU/scraper/refresh_baseline.json"
)
# Tracked source JSON is added by wildcard expansion at commit time.
$PUBLISH_GLOB = "myplanBYU/scraper/data"

# --- module state -----------------------------------------------------------
$script:LogPath  = $null
$script:JobName  = $null
$script:Steps    = @()
$script:StartedAt = $null
# Lines not yet on disk. Never dropped: a blocked write leaves them queued and
# the next successful write drains them in order. See Flush-LogQueue.
$script:Pending  = New-Object System.Collections.Generic.List[string]

function Start-RefreshRun {
  <#
    Opens a run: sets the log file, records the start, resets step state.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$JobName,
    [Parameter(Mandatory = $true)][string]$LogFile
  )
  $script:JobName = $JobName
  if (-not (Test-Path $LOG_DIR)) {
    New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
  }
  # ONE FILE PER RUN, stamped. Appending to a single long-lived log is what made
  # the log loseable: whatever was watching or syncing it held the handle. A name
  # that did not exist a moment ago has no other readers, so there is nothing to
  # contend with. It also makes each run individually inspectable.
  $stamp = (Get-Date -Format "yyyyMMdd-HHmmss")
  $base  = [System.IO.Path]::GetFileNameWithoutExtension($LogFile)
  $script:LogPath   = Join-Path $LOG_DIR ("{0}-{1}.log" -f $base, $stamp)
  $script:Steps     = @()
  $script:StartedAt = Get-Date
  $script:Pending   = New-Object System.Collections.Generic.List[string]
  Remove-OldLogs -BaseName $base
  Write-Log ("=== {0} run started ===" -f $JobName)
  Write-Log ("log: {0}" -f $script:LogPath)
}

function Remove-OldLogs {
  # Keep the last 30 runs of each job; they are a few KB each.
  param([Parameter(Mandatory = $true)][string]$BaseName)
  try {
    Get-ChildItem -Path $LOG_DIR -Filter ($BaseName + "-*.log") -File -ErrorAction Stop |
      Sort-Object LastWriteTime -Descending |
      Select-Object -Skip 30 |
      ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
  } catch {
    # Never let log housekeeping affect a run.
  }
}

function Flush-LogQueue {
  <#
    Drains $script:Pending to disk, in order, stopping at the first line that
    cannot be written so ordering is preserved and nothing is lost.

    Retries alone are NOT enough -- a verification run on 2026-07-24 proved it:
    against a handle held open for the whole run, every line written during the
    lock was lost and the log ended up with two lines and no verdict, the same
    signature as 2026-07-22. Queueing is what actually guarantees delivery: the
    lines simply wait for the lock to clear.

    -Final raises the effort for the last flush of a run and, if the log is still
    unreachable, spills to a fallback file so a verdict is never lost to a lock.
  #>
  param([switch]$Final)
  if (-not $script:LogPath) { return }

  $attempts = 3
  if ($Final) { $attempts = 12 }

  while ($script:Pending.Count -gt 0) {
    $line = $script:Pending[0]
    $wrote = $false
    for ($i = 0; $i -lt $attempts; $i++) {
      try {
        # FileShare.ReadWrite so our handle never blocks a reader in turn.
        $fs = New-Object System.IO.FileStream(
                $script:LogPath, [System.IO.FileMode]::Append,
                [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
        try {
          $sw = New-Object System.IO.StreamWriter($fs, [System.Text.Encoding]::UTF8)
          try { $sw.WriteLine($line) } finally { $sw.Dispose() }
        } finally { $fs.Dispose() }
        $wrote = $true
        break
      } catch {
        if ($Final) { Start-Sleep -Milliseconds 250 }
      }
    }
    if (-not $wrote) { break }
    $script:Pending.RemoveAt(0)
  }

  if ($Final -and $script:Pending.Count -gt 0) {
    # Last resort: a file nothing could possibly have open yet.
    $fallback = [System.IO.Path]::ChangeExtension($script:LogPath, $null) +
                ("fallback-{0}.log" -f (Get-Date -Format "HHmmssfff"))
    try {
      [System.IO.File]::WriteAllLines($fallback, $script:Pending,
                                      [System.Text.Encoding]::UTF8)
      Write-Host ("NOTE: log was locked; {0} line(s) spilled to {1}" -f `
                  $script:Pending.Count, $fallback)
      $script:Pending.Clear()
    } catch {
      Write-Host ("WARNING: {0} log line(s) could not be written anywhere; " +
                  "the console transcript above is the only record." -f $script:Pending.Count)
    }
  }
}

function Write-Log {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Write-Host $line
  $script:Pending.Add($line)
  Flush-LogQueue
}

function Write-LogDetail {
  # Indented child lines: a step's captured stdout/stderr.
  param([AllowEmptyString()][string[]]$Lines)
  if (-not $Lines) { return }
  foreach ($l in $Lines) { $script:Pending.Add("    " + $l) }
  Flush-LogQueue
}

function Initialize-ScraperEnv {
  <#
    Verifies the venv can actually run the pipeline, rebuilding it if not.

    This exists because the 2026-07-22 run died with the interpreter path
    missing and reported nothing. Preflight makes that condition loud and
    self-healing instead of silent.

    Returns the interpreter path on success; throws on unrecoverable failure so
    the caller aborts BEFORE any data is touched.
  #>
  $needed = "import requests, bs4, pypdf, sentence_transformers, pinecone"

  if (Test-Path $VENV_PY) {
    $probe = & $VENV_PY -c $needed 2>&1
    if ($LASTEXITCODE -eq 0) {
      Write-Log "env: venv OK"
      return $VENV_PY
    }
    Write-Log "env: venv present but imports FAILED -- rebuilding"
    Write-LogDetail $probe
  } else {
    Write-Log ("env: interpreter missing at {0} -- rebuilding" -f $VENV_PY)
  }

  if (-not (Test-Path $SYSTEM_PY)) {
    throw ("cannot rebuild venv: system Python not found at {0}" -f $SYSTEM_PY)
  }

  Write-Log "env: creating venv (this takes a few minutes -- torch is ~2GB)"
  $mk = & $SYSTEM_PY -m venv $VENV_PATH 2>&1
  Write-LogDetail $mk
  if (-not (Test-Path $VENV_PY)) {
    throw "venv creation did not produce an interpreter"
  }

  $req = Join-Path $SCRAPER_DIR "requirements.txt"
  $pip = & $VENV_PY -m pip install --upgrade pip 2>&1
  Write-LogDetail $pip
  $inst = & $VENV_PY -m pip install -r $req 2>&1
  Write-LogDetail $inst
  if ($LASTEXITCODE -ne 0) {
    throw "pip install -r requirements.txt failed (see log)"
  }

  $probe2 = & $VENV_PY -c $needed 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-LogDetail $probe2
    throw "venv rebuilt but imports still fail (see log)"
  }
  Write-Log "env: venv rebuilt OK"
  return $VENV_PY
}

function Invoke-Step {
  <#
    Runs one Python script and records the outcome.

    THE BUG THIS FIXES: 'refresh_maps.ps1' did

        $out = & $py $s.args 2>&1
        if ($LASTEXITCODE -ne 0) { ... }

    When the interpreter itself cannot be launched, PowerShell raises an error
    and never sets $LASTEXITCODE -- so a stale 0 from an earlier command read as
    success. Here the call is wrapped, and "no exit code produced" is a failure.

    -Fatal        stop the run if this step fails (generate/embed steps)
    (default)     log and continue (individual sources -- Kennedy's rate
                  limiting must not cost us the clubs refresh)
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Python,
    [switch]$Fatal
  )

  Write-Log ("step: {0} ..." -f $Name)
  $stepStart = Get-Date
  $exit = $null
  $out = $null

  try {
    $global:LASTEXITCODE = $null
    $out = & $Python $Arguments 2>&1
    $exit = $LASTEXITCODE
  } catch {
    Write-Log ("step {0} could not launch: {1}" -f $Name, $_.Exception.Message)
    $exit = $null
  }

  Write-LogDetail $out
  $secs = [int]((Get-Date) - $stepStart).TotalSeconds

  if ($null -eq $exit) {
    # Launch failure -- the exact silent-death mode from 2026-07-22.
    $ok = $false
    Write-Log ("step {0} FAILED: no exit code (interpreter or script did not run)" -f $Name)
  } elseif ($exit -ne 0) {
    $ok = $false
    Write-Log ("step {0} FAILED (exit {1}, {2}s)" -f $Name, $exit, $secs)
  } else {
    $ok = $true
    Write-Log ("step {0} OK ({1}s)" -f $Name, $secs)
  }

  $script:Steps += [pscustomobject]@{
    name    = $Name
    ok      = $ok
    exit    = $exit
    seconds = $secs
    fatal   = [bool]$Fatal
  }

  if (-not $ok -and $Fatal) {
    throw ("fatal step '{0}' failed -- aborting run" -f $Name)
  }
  return $ok
}

function Test-DataSanity {
  <#
    Runs _sanity_check.py. Returns a PSCustomObject:
      Ok       [bool]   safe to publish
      Reasons  [array]  why not, when Ok is false
      Metrics  [object] the measured counts
  #>
  param([Parameter(Mandatory = $true)][string]$Python)

  Write-Log "gate: checking data sanity ..."
  $raw = & $Python (Join-Path $SCRAPER_DIR "_sanity_check.py") 2>&1
  $exit = $LASTEXITCODE
  $joined = $raw -join "`n"

  # Slice out the JSON object rather than parsing the whole stream: stderr is
  # merged in above (so warnings land in the log), and a single Python
  # DeprecationWarning would otherwise make the verdict unparseable and fail an
  # otherwise healthy refresh.
  $verdict = $null
  $first = $joined.IndexOf("{")
  $last = $joined.LastIndexOf("}")
  if ($first -ge 0 -and $last -gt $first) {
    try { $verdict = $joined.Substring($first, $last - $first + 1) | ConvertFrom-Json } catch { $verdict = $null }
  }

  if ($null -eq $verdict) {
    Write-Log "gate: could not parse verdict -- treating as FAILED"
    Write-LogDetail $raw
    return [pscustomobject]@{
      Ok = $false; Reasons = @("sanity check produced no parseable verdict"); Metrics = $null
    }
  }

  if ($verdict.ok -and $exit -eq 0) {
    $c = $verdict.metrics.js_courses
    $p = $verdict.metrics.js_programs
    $h = $verdict.metrics.health_findings
    Write-Log ("gate: PASSED ({0} courses, {1} programs, {2} health findings)" -f $c, $p, $h)
    return [pscustomobject]@{ Ok = $true; Reasons = @(); Metrics = $verdict.metrics }
  }

  Write-Log "gate: FAILED -- refresh will NOT be published"
  foreach ($r in $verdict.reasons) { Write-Log ("  reason: {0}" -f $r) }
  return [pscustomobject]@{ Ok = $false; Reasons = $verdict.reasons; Metrics = $verdict.metrics }
}

function Save-RejectedOutput {
  <#
    Preserves gate-rejected output for inspection, then restores the tracked
    files so the working tree is clean for the next run (and for the user).
  #>
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $dest = Join-Path $DATA_DIR ("_rejected\" + $stamp)
  New-Item -ItemType Directory -Force -Path $dest | Out-Null

  foreach ($f in @("catalog_data.js", "timeline_data.js")) {
    $src = Join-Path (Join-Path $SCRAPER_DIR "..") ("js\" + $f)
    if (Test-Path $src) { Copy-Item $src (Join-Path $dest $f) -Force }
  }
  Get-ChildItem -Path $DATA_DIR -Filter "*.json" -File |
    Where-Object { $_.Name -ne "catalog.json" } |   # 69MB build input, skip
    ForEach-Object { Copy-Item $_.FullName (Join-Path $dest $_.Name) -Force }
  $health = Join-Path $DATA_DIR "_health_report.txt"
  if (Test-Path $health) { Copy-Item $health (Join-Path $dest "_health_report.txt") -Force }

  Write-Log ("gate: rejected output saved to data\_rejected\{0}" -f $stamp)

  # Restore the tracked outputs to their last committed state.
  Push-Location $REPO_ROOT
  try {
    $restore = & git restore -- "myplanBYU/js" "myplanBYU/scraper/data" 2>&1
    Write-LogDetail $restore
    Write-Log "gate: tracked files restored to last committed state"
  } finally {
    Pop-Location
  }
  return $dest
}

function Publish-Refresh {
  <#
    Commits and pushes ONLY the generated data files.

    Guards, in order:
      1. abort if the index already holds staged changes (never sweep the
         user's in-progress work into an automated commit)
      2. no-op on an empty diff (most weekly runs)
      3. rebase onto origin/main; abort the rebase on conflict rather than
         resolving anything unattended

    Returns a PSCustomObject: Published [bool], Reason [string], Sha [string]
  #>
  param([Parameter(Mandatory = $true)]$Metrics)

  Push-Location $REPO_ROOT
  try {
    $staged = & git diff --cached --name-only 2>&1
    if ($LASTEXITCODE -ne 0) {
      return [pscustomobject]@{ Published = $false; Reason = "git diff --cached failed"; Sha = $null }
    }
    if ($staged) {
      Write-Log "publish: SKIPPED -- the index already has staged changes:"
      Write-LogDetail $staged
      Write-Log "publish: refusing to mix an automated commit into your staged work"
      return [pscustomobject]@{ Published = $false; Reason = "index not clean"; Sha = $null }
    }

    $paths = @()
    $paths += $PUBLISH_PATHS
    $paths += $PUBLISH_GLOB
    $add = & git add -- $paths 2>&1
    Write-LogDetail $add

    $pending = & git diff --cached --name-only 2>&1
    if (-not $pending) {
      Write-Log "publish: no data changes -- nothing to commit"
      return [pscustomobject]@{ Published = $false; Reason = "no changes"; Sha = $null }
    }
    Write-Log ("publish: staging {0} file(s)" -f @($pending).Count)
    Write-LogDetail $pending

    $msg = "myplanBYU: scheduled data refresh ({0} courses, {1} programs, {2} health findings)" -f `
           $Metrics.js_courses, $Metrics.js_programs, $Metrics.health_findings
    $commit = & git commit -m $msg 2>&1
    Write-LogDetail $commit
    if ($LASTEXITCODE -ne 0) {
      return [pscustomobject]@{ Published = $false; Reason = "commit failed"; Sha = $null }
    }

    $fetch = & git fetch origin main 2>&1
    Write-LogDetail $fetch
    $rebase = & git rebase origin/main 2>&1
    Write-LogDetail $rebase
    if ($LASTEXITCODE -ne 0) {
      Write-Log "publish: rebase onto origin/main CONFLICTED -- aborting rebase, not pushing"
      $abort = & git rebase --abort 2>&1
      Write-LogDetail $abort
      return [pscustomobject]@{ Published = $false; Reason = "rebase conflict"; Sha = $null }
    }

    $push = & git push origin main 2>&1
    Write-LogDetail $push
    if ($LASTEXITCODE -ne 0) {
      Write-Log "publish: push FAILED (commit is local; it will go out next run)"
      return [pscustomobject]@{ Published = $false; Reason = "push failed"; Sha = $null }
    }

    $sha = (& git rev-parse --short HEAD 2>&1) -join ""
    Write-Log ("publish: pushed {0} to origin/main -- Pages will redeploy" -f $sha)
    return [pscustomobject]@{ Published = $true; Reason = "ok"; Sha = $sha }
  } finally {
    Pop-Location
  }
}

function Update-SanityBaseline {
  # Ratchet the known-good numbers forward. Called only after a real publish, so
  # the baseline always describes what is actually live.
  param([Parameter(Mandatory = $true)][string]$Python)
  $out = & $Python (Join-Path $SCRAPER_DIR "_sanity_check.py") "--update" 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Log "baseline: updated to this run's metrics"
  } else {
    Write-Log "baseline: update FAILED (non-fatal)"
    Write-LogDetail $out
  }
}

function Write-RunStatus {
  <#
    Overwrites data\_last_run.json -- the one place to look to answer "did it
    run, did it work, did it ship?".
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Outcome,   # ok | gate_failed | failed
    [AllowEmptyString()][string]$Detail = "",
    $Metrics = $null,
    $Publish = $null
  )
  $ended = Get-Date
  $status = [ordered]@{
    job          = $script:JobName
    outcome      = $Outcome
    detail       = $Detail
    started      = $script:StartedAt.ToString("yyyy-MM-dd HH:mm:ss")
    ended        = $ended.ToString("yyyy-MM-dd HH:mm:ss")
    duration_min = [math]::Round(($ended - $script:StartedAt).TotalMinutes, 1)
    steps        = $script:Steps
    published    = $false
    commit       = $null
    publish_note = $null
    metrics      = $Metrics
  }
  if ($Publish) {
    $status.published    = $Publish.Published
    $status.commit       = $Publish.Sha
    $status.publish_note = $Publish.Reason
  }
  $json = $status | ConvertTo-Json -Depth 6
  # Written to both places on purpose: data\ is where you look while working in
  # the repo, and the log dir is outside OneDrive so it survives a sync lock.
  # Retried for the same reason Write-Log is -- this is the run's verdict, and a
  # verdict lost to a file lock is the failure mode this whole system exists to
  # eliminate.
  $targets = @((Join-Path $DATA_DIR "_last_run.json"),
               (Join-Path $LOG_DIR  "_last_run.json"))
  foreach ($path in $targets) {
    $written = $false
    for ($i = 0; $i -lt 5; $i++) {
      try {
        [System.IO.File]::WriteAllText($path, $json, [System.Text.Encoding]::UTF8)
        $written = $true
        break
      } catch {
        Start-Sleep -Milliseconds (100 * ($i + 1))
      }
    }
    if (-not $written) { Write-Host ("WARNING: could not write " + $path) }
  }
  Write-Log ("status: wrote _last_run.json (outcome={0})" -f $Outcome)
}

function Send-FailureToast {
  <#
    Windows toast on failure. Success stays silent -- a notification you get
    every week is a notification you stop reading.

    Uses the WinRT toast API, falling back to a message box if that is
    unavailable (it needs a desktop session, which the task has because it runs
    logged-on only).
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Message
  )
  try {
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
             [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $tpl.GetElementsByTagName("text")
    $texts.Item(0).AppendChild($tpl.CreateTextNode($Title)) | Out-Null
    $texts.Item(1).AppendChild($tpl.CreateTextNode($Message)) | Out-Null
    $toast = [Windows.UI.Notifications.ToastNotification]::new($tpl)
    # PowerShell's own AppUserModelID -- registered on every Windows box, so the
    # toast is guaranteed to have a valid shortcut identity.
    $appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    Write-Log "alert: failure toast sent"
    return
  } catch {
    Write-Log ("alert: toast unavailable ({0}) -- falling back to message box" -f $_.Exception.Message)
  }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($Message, $Title) | Out-Null
  } catch {
    Write-Log "alert: message box also unavailable -- log and status file only"
  }
}

function Complete-RefreshRun {
  <#
    Single exit path for both jobs: gate, publish, baseline, status, alert.
    Returns the process exit code the job should use.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Python,
    [switch]$NoPublish
  )

  $gate = Test-DataSanity -Python $Python

  if (-not $gate.Ok) {
    $dest = Save-RejectedOutput
    Write-RunStatus -Outcome "gate_failed" `
                    -Detail (($gate.Reasons -join "; ") + " | rejected copy: " + $dest) `
                    -Metrics $gate.Metrics
    Send-FailureToast -Title ("myplanBYU refresh blocked (" + $script:JobName + ")") `
                      -Message (($gate.Reasons | Select-Object -First 2) -join "; ")
    Write-Log "=== run FAILED the sanity gate -- live site unchanged ==="
    Flush-LogQueue -Final
    return 2
  }

  $failedSteps = @($script:Steps | Where-Object { -not $_.ok })
  if ($failedSteps.Count -gt 0) {
    Write-Log ("note: {0} non-fatal step(s) failed: {1}" -f `
               $failedSteps.Count, (($failedSteps | ForEach-Object { $_.name }) -join ", "))
  }

  if ($NoPublish) {
    Write-Log "publish: skipped (-NoPublish)"
    Write-RunStatus -Outcome "ok" -Detail "gate passed; publish skipped (-NoPublish)" `
                    -Metrics $gate.Metrics
    Write-Log "=== run completed OK (not published) ==="
    Flush-LogQueue -Final
    return 0
  }

  # Baseline BEFORE publish, so the new known-good numbers ride in the same
  # commit as the data they describe. Updating it afterwards would leave
  # refresh_baseline.json permanently dirty in the working tree and always one
  # run behind the data it is supposed to describe.
  # When the data did not change, the rewritten file is byte-identical, so this
  # adds nothing to the diff and the run still no-ops.
  Update-SanityBaseline -Python $Python

  $pub = Publish-Refresh -Metrics $gate.Metrics

  Write-RunStatus -Outcome "ok" -Detail "gate passed" -Metrics $gate.Metrics -Publish $pub
  Write-Log "=== run completed OK ==="
  Flush-LogQueue -Final
  return 0
}

function Stop-RefreshRunWithError {
  # Fatal-path exit: a step threw, or preflight failed.
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Log ("ABORTED: {0}" -f $Message)
  Write-RunStatus -Outcome "failed" -Detail $Message
  Send-FailureToast -Title ("myplanBYU refresh FAILED (" + $script:JobName + ")") `
                    -Message $Message
  Write-Log "=== run FAILED ==="
  Flush-LogQueue -Final
  return 1
}
