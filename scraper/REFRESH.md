# Scheduled data refresh

myplanBYU's data comes from BYU sources that change on BYU's calendar. Two
Windows scheduled tasks keep it current and push the result to the live site.

## Setup (once)

```powershell
cd "C:\Users\jorda\OneDrive - Brigham Young University\Portfolio\myplanBYU\scraper"
.\setup_schedule.ps1
```

That registers both tasks. Re-running is safe — it overwrites.

```powershell
.\setup_schedule.ps1 -Status    # state, last run time, last result
.\setup_schedule.ps1 -Remove    # unregister both
```

## The two jobs

| Task | When | Script | Steps |
|---|---|---|---|
| `myplanBYU\weekly core refresh` | Sunday 03:00 | `refresh_core.ps1` | catalog → academic dates → MAP sheets → `generate_data` → `generate_timeline` |
| `myplanBYU\monthly full refresh` | 1st Sunday 04:00 | `refresh_full.ps1` | catalog → 10 sources → flowchart extraction → MAP sheets → generate → `embed_and_load` (Pinecone) |

Both accept:

- `-NoPublish` — run the whole pipeline, stop before git. Use this to test.
- `-Force` — re-fetch every MAP sheet instead of only changed ones.
- `-SkipEmbed` (full only) — skip Pinecone, so no API spend.

**Step order is load-bearing.** `sources/maps.py` reads `data/catalog.json`, and
`generate_data.py` merges the MAP and flowchart plans, so it runs after both.

**Failure policy differs by step class.** In the monthly run a single *source*
failing is logged and skipped — Kennedy's server answers bursts with 403s, and
`clubs.py` rides the Mendix `/xas/` protocol that BYU can change without notice;
neither should cost you the other sources. A *generate* or *embed* step failing
is fatal, because those produce what ships.

## The publish gate

Nothing reaches the live site unless `_sanity_check.py` approves it. It compares
the fresh scrape against the last known-good numbers in
`refresh_baseline.json` and blocks the push if:

- a generated file doesn't parse, or `courses` / `programs` is empty;
- course or program count fell more than **5%**;
- any source JSON went from >0 records to **0** — the signature of a scraper
  that broke silently rather than loudly;
- health findings rose by more than **8** (a requirement-parser regression, not
  eight programs edited in one week).

On rejection: the output is copied to `data/_rejected/<timestamp>/`, the tracked
files are restored to their last committed state, a toast fires, and the site is
left alone.

Run the gate by hand any time:

```powershell
& "C:\Users\jorda\venvs\myplan-scraper\Scripts\python.exe" _sanity_check.py
# exit 0 = would publish, 2 = blocked (reasons in the JSON), 1 = check broke
```

`refresh_baseline.json` ratchets forward only when the refresh is actually going
to publish — the branch and index are checked first — so it always describes what
is live. A run on a feature branch refreshes the data and leaves the baseline
alone.

## Publishing

The repo is a GitHub Pages site, so a push to `main` *is* the deploy. The job:

- **only publishes from `main`.** On any other branch it refreshes the data and
  stops — otherwise a run firing while you're on a feature branch would commit
  the refresh there and then rebase and push *that* branch onto main;
- adds **explicit paths only** — never `git add -A`, because the working tree
  routinely holds unrelated in-progress portfolio work;
- **aborts if the index already has staged changes**, rather than sweeping your
  work into an automated commit;
- no-ops on an empty diff, which is most weekly runs. That only holds because
  the generated output is **date-stable**: `generate_data.py` keeps the previous
  `generated` date when nothing else changed, and the baseline omits
  `catalog_scraped_at`. Without both, the embedded dates alone would be a real
  diff and every single run would commit and redeploy the site, burying the
  weeks BYU actually changed something;
- rebases onto `origin/main` first, and aborts rather than resolving a conflict
  unattended;
- writes the counts into the message:
  `myplanBYU: scheduled data refresh (7130 courses, 313 programs, 24 health findings)`.

## Checking on it

```powershell
.\setup_schedule.ps1 -Status
Get-Content data\_last_run.json | ConvertFrom-Json
Get-Content "$env:LOCALAPPDATA\myplanBYU\logs\refresh_core.log" -Tail 40
```

`_last_run.json` is the single answer to "did it run, did it work, did it ship?"
— outcome, per-step results, counts, and the commit SHA if it pushed. It is
written to **both** `data/` (convenient while working in the repo) and the log
directory (survives a sync lock). Failures raise a Windows toast; success is
deliberately silent, because a weekly notification is one you stop reading.

### Logs live outside OneDrive

`%LOCALAPPDATA%\myplanBYU\logs\` — deliberately, for the same reason the venv
does. A log inside the synced folder gets locked the moment anything else opens
it (OneDrive's own sync, an editor, a `tail -f`), `Add-Content` then throws, and
**the run loses its entire log** — you get the first two lines and no verdict.

That is exactly what `refresh_maps.log` showed after the 2026-07-22 run, and a
verification run reproduced it on 2026-07-24: the pipeline itself succeeded and
the gate passed, but the log recorded nothing past line two. A scheduled job
whose log can vanish is a job that fails invisibly, which is the whole thing
this setup exists to prevent. Writes are also retried on a transient lock.

## Why it runs logged-on only

The tasks use `InteractiveToken` (no stored password) because `git push` needs
Windows Credential Manager, `.env` (Pinecone / Anthropic keys) lives in the user
profile, and the failure toast needs a desktop session. The trade-off: refreshes
fire only when you're logged in. `StartWhenAvailable` is set, so a run missed
while the PC was off happens on next wake instead of being skipped.

## Environment

The venv lives at `C:\Users\jorda\venvs\myplan-scraper` — deliberately **outside**
OneDrive, since a torch-sized venv in a synced folder corrupted the old
`scraper\.venv` and hit Windows' 260-char path limit.

Every run preflights it: interpreter present, and
`import requests, bs4, pypdf, sentence_transformers, pinecone` succeeds. If not,
it rebuilds from `requirements.txt` and continues; if the rebuild fails it aborts
**before touching any data** and toasts.

This preflight exists for a reason. On 2026-07-22 a run died with the venv
interpreter missing and reported nothing at all — `refresh_maps.log` holds two
lines and no verdict. The old script checked `$LASTEXITCODE`, which is never set
when the interpreter itself can't launch, so a stale `0` read as success.
`Invoke-Step` now treats "no exit code produced" as failure.

## Files

| File | Role |
|---|---|
| `_pipeline.ps1` | Shared library: preflight, step runner, gate, publish, status, toast |
| `refresh_core.ps1` | Weekly job |
| `refresh_full.ps1` | Monthly job |
| `setup_schedule.ps1` | Task registration / `-Status` / `-Remove` |
| `_sanity_check.py` | The publish gate |
| `refresh_baseline.json` | Last known-good metrics (tracked) |
| `data/_last_run.json` | Last run's outcome (local only; mirrored to the log dir) |
| `%LOCALAPPDATA%\myplanBYU\logs\*.log` | Appended run logs — outside OneDrive on purpose |

The `.ps1` files are **ASCII-only** on purpose: PowerShell 5.1 reads a no-BOM
script as ANSI, so a smart quote or em dash breaks string parsing.
