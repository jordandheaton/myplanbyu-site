# myplanBYU — solver tests

Regression tests for `js/solver.js`. No build step, no dependencies, no Node —
`tests/index.html` loads the **same script tags the real app loads**, so the code
under test is byte-for-byte what ships.

> **Committed, never deployed.** This was local-only while myplanBYU lived inside
> the portfolio repo; it is tracked since the project got its own repo
> (2026-10-24). `build_site.py` copies only the site, so tests/ is never served.

## Running

### Headless (fastest, and what CI would use)

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File tests/headless.ps1
```

Runs the curated cases in headless Edge over `file://` — no server, no Node, no
install. Prints a summary, exits 0 when everything passes and 1 otherwise.

```
.\headless.ps1                     # curated cases (~7 s)
.\headless.ps1 -Mode sweep         # all 175 majors, invariants only (~46 s)
.\headless.ps1 -Mode taxonomy      # 700 major x student-state combos (~5 min)
.\headless.ps1 -Mode taxonomy -LimitMajors 25   # scoped, ~35 s
.\headless.ps1 -Record             # re-record goldens.js in place
.\headless.ps1 -Json out.json      # also dump the full report
```

### In a browser

Start the static server, then visit <http://localhost:8130/tests/index.html>:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/serve.ps1
```

Click **Run curated cases** and click any row to expand its findings. Use this when
you want to read a full plan diff rather than the first twelve lines of one.

- **Run curated cases** — the 23 profiles in `cases.js`, checked against invariants
  *and* recorded goldens. This is the regression net.
- **Sweep all majors** — all 175 majors on default settings, invariants only, no
  goldens. This is the wide net: it answers "did this change break a major I never
  look at?"
- **Record goldens** — downloads a fresh `goldens.js` to move into `tests/`. The
  `-Record` flag on `headless.ps1` writes it in place instead, which is easier.

## The three modes

| Mode | Question it answers | Needs rules written in advance? |
| --- | --- | --- |
| Curated cases | Did my change break something, or move a plan? | Yes |
| Sweep | Did it break a major I never look at? | Yes |
| Failure taxonomy | Where is the output *bad* rather than *illegal*? | **No** |

The first two are the regression net. The taxonomy ([taxonomy.js](taxonomy.js)) is
the discovery net: it crosses every major with four student states (freshman,
sophomore with 30 credits, plus a business minor, year-round), then ranks the 700
resulting plans by symptoms a student would notice — unscheduled courses, terms
above BYU's registration cap, semesters below full-time, elective padding, plans
running past ten semesters. Nothing it reports is illegal. It is looking for plans
someone opens and closes.

Symptom weights live in one place at the top of `taxonomy.js`, deliberately visible
so they can be argued with and retuned.

## The two layers

**Invariants** (`invariants.js`) are rules every plan must obey — prerequisite
order, season availability, credit caps, no duplicate enrollment, repeat
sequencing, the double-count cap, no course in a disabled term. They fail on their
own merit and need no baseline.

They deliberately mirror `solver.js`'s own semantics rather than an idealized
reading of the catalog. Where the solver documents a legitimate exception, the same
exception is encoded here and the finding is downgraded to a warning:

| Exception | Why it is only a warning |
| --- | --- |
| MAP-sheet placements bypass prereq and season checks | Documented, intentional: the sheet outranks the catalog. A hit means the *sheet and catalog disagree* — real signal about the data, not a solver bug. |
| Cohort blocks may exceed the credit ceiling | `solver.js` calls this a "forced exception". |
| A prerequisite absent from the plan entirely | BYU satisfies many by exam (MATH 110 has an ACT 22+ test-out). Present-but-scheduled-later stays a failure — that plan cannot be registered. |

A suite that cries wolf gets muted, so the exceptions are encoded rather than
argued with. Repeat sequencing is the one place a MAP-locked placement still fails —
see the comment in `invariants.js` for why.

**Goldens** (`goldens.js`, generated) are recorded plan snapshots. A golden never
says a plan is *good*, only that it is **unchanged**. Any solver edit that moves a
course produces a readable diff:

```
~ IS 401: Fall 2028 -> Winter 2029
+ MATH 112 in Fall 2026
- STAT 121 was in Winter 2027
```

Identical placements with a different score report as `score only` — worth seeing,
not worth failing.

Goldens are a **baseline, not an oracle**. Known-bad output (an error flag the
solver itself raises) is recorded as known; a run fails only when something *new*
appears. Fixing a known problem shows as `error-flag-resolved` and asks you to
re-record. A permanently red suite teaches you to ignore it.

The same reasoning covers understood-but-unfixed bugs: a case can declare
`knownIssues: { rules: [...], note: "..." }` in `cases.js`, and those rules report
as **KNOWN** rather than **FAIL**. The note is mandatory in spirit — a bare
allowlist becomes a place failures go to be forgotten. Delete the entry when the
bug is fixed; the rule will simply stop firing.

## Workflow

1. Change `solver.js`.
2. Run the curated cases. Any `FAIL` or `plan changed` row is your change's blast
   radius.
3. If the change was intended, **Record goldens** and commit `goldens.js` alongside
   it. In review, the goldens diff *is* the description of what the change did.
4. Before anything user-facing, run the sweep — the curated list only covers 23 of
   175 majors.

## Adding a case

Append to `CURATED` in `cases.js`, run, then record goldens. A case with no golden
reports `not recorded` rather than failing.

```js
{ id: "my-case", name: "Human-readable name", majorId: "major-...",
  minorIds: [], certIds: [], completed: ["WRTG 150"],
  settings: { allowSpring: true } }
```

Profiles are always built from `DATA.defaultProfile`, so a change to the app's own
defaults flows into the tests instead of drifting away from them.

## Known state

Measured from a full sweep of all 175 majors on default settings — **0 crashes**,
**12 majors with a hard failure**, 27 failures and 291 warnings in total.

| Finding | Occurrences | Majors |
| --- | ---: | ---: |
| `prereq-missing` — prereq in neither plan nor completed work (often a test-out) | 94 | 63 |
| `solver-error-flag` — the app already shows the student an error | 78 | 56 |
| `prereq-order (MAP-locked)` — sheet schedules a prereq after the course needing it | 50 | 32 |
| `season (MAP-locked)` — sheet puts a course in a season it isn't offered | 45 | 29 |
| `repeat-sequence (MAP-locked)` — repeatable course stacked into one term | 25 | 11 |
| `unscheduled` — a required course could not be placed at all | 13 | 13 |
| `credit-cap (cohort/MAP term)` — term over the ceiling | 11 | 10 |
| `prereq-order` / `season` — illegal placement with **no** MAP-sheet excuse | 2 | 1 |

Three things worth acting on:

1. **IS/MISM places `IS 404` illegally with no excuse.** The Winter-only course lands
   in Fall 2028, before its own prerequisite `IS 414` (Winter 2029), because cohort
   block `jcf` bypasses both the season and prereq checks in `canPlace()`. No error
   flag is raised — the student is told to register for a class that isn't offered.
   Tracked as a `knownIssues` entry on the `is-mism-nomap` case.
2. **11 majors stack a repeatable course into a single semester** — American Studies
   puts all six `IAS 399R` enrollments in Winter 2029; Portuguese Studies stacks
   `PORT 493` ten deep. **6 of those are religion slots**, which `solver.js` states
   are "strictly one per semester (BYU pacing)" — so the plan breaks a rule the
   solver believes it is enforcing.
3. **32 majors carry a sequencing or season problem the UI shows no warning for.**
   The app surfaces error flags on 56 majors, but 60 have an ordering or season
   problem — so roughly half of them are silent.

These are pre-existing. The suite measures them; it did not cause them. `prereq-missing`
is the noisiest rule and the weakest signal — BYU satisfies many prerequisites by exam —
so treat it as a data question, not a solver bug.

### FIXED: the envelope-as-prerequisite bug

`generate_data.py` now routes envelope co-members to `pc` (concurrent, before-or-same
term) instead of `p` (strict prerequisite). Regenerating `js/catalog_data.js` changed
**exactly two courses** out of 7,123 — programs, GE and co-requisites came out
byte-identical:

```
IS 404  p: [["IS 414"]]              ->  pc: [["IS 414"]]
IS 413  p: [["IS 403"],["IS 414"]]   ->  p: [["IS 403"]], pc: [["IS 414"]]
```

`IS 403` correctly stayed strict on IS 413 — that one comes from the structured
requisites, not the envelope text. Sweep effect, no collateral damage anywhere else:

| | before | after |
| --- | ---: | ---: |
| `prereq-order` (illegal, no MAP excuse) | 1 | **0** |
| `prereq-order (MAP-locked)` | 50 | 48 |
| `solver-error-flag` | 78 | 77 |
| every other rule | — | unchanged |

In the app, eight IS cases were showing students a red *"Pinned course IS 404 sits
before its prerequisites"* banner. That banner is gone, and **no plan moved** — the
goldens all still match, so the fix removed a false error without disturbing a single
schedule.

### Resolved: why IS 404 looked Winter-only

Traced to the raw scrape (`scraper/data/catalog.json`), and it is **not** a scraper
transcription error. BYU's own course record for IS 404 says:

- `courseTypicallyOffered: "Winter."` — while the MAP sheet puts IS 404 in the **Fall**
  envelope. BYU's two sources contradict each other. (`lastSyncd` on that record is
  Dec 2023; IS 401 has the mirror-image conflict — record says Fall, sheet says Winter.)
- `nonEnforcedPrerequisites: "IS 414; Acceptance into the Information Systems major;
  enrollment in an IS Core envelope"`

`generate_data.py` (~line 1543) promotes the leading course code of that free-text field
to a **strict** prerequisite. But the field is *non-enforced*, and the same record carries
`note: "To register for the IS Core, choose 'Add an envelope of classes.'"` — IS 414 is a
co-member of the envelope, taken alongside IS 404, not before it. Two courses that are
both Winter-only cannot be a real sequence anyway; that would force them a year apart.

Scope is contained: **only IS 404 and IS 413** hit this, both extracting IS 414.

Two separate fixes, neither applied yet:

1. In `generate_data.py`, skip strict-prereq promotion when the non-enforced text mentions
   an envelope (2 courses affected).
2. Decide which source wins on season for the IS core. The MAP sheet is what advisors hand
   out, and `solver.js` already states "the sheet wins" for IS 401 — so the course records
   look stale, and `courseTypicallyOffered` should probably not override a sheet placement.

### A detector that measured the wrong thing

Worth recording, because the same mistake is easy to repeat. The first taxonomy run
reported "padded with generic electives" as the top symptom — 252 hits across 114
majors. It was matching `/^ELECTIVE\+?\s/`, which catches two unrelated things that
both render as "ELECTIVE" in the UI:

- `ELECTIVE 1..n` — open elective **hours the degree genuinely requires**
  ([solver.js:677](../js/solver.js:677)). A General Studies BGS with 18 of them is
  correct. This is a property of the degree, not a defect.
- `ELECTIVE+ t.n` — **floor padding** injected to drag a term up to the 14-credit
  minimum ([solver.js:1883](../js/solver.js:1883)), described as "disposable" in its
  own source. This is the solver admitting it had nothing real to schedule.

The split was 247 to 13. The detector now matches `ELECTIVE+` only, at a threshold of
3 slots and a low weight — a couple of filler slots at the tail is ordinary, and at
≥2 it fired on 150 of 175 majors, which ranks everything and therefore ranks nothing.
Its real value is as a co-symptom: it lands together with `unscheduled` in 14 of the
worst 25 combinations.

### From the taxonomy: Elementary Education's 25-credit semester

The taxonomy surfaced something the invariants only logged as a low-key warning:
Elementary Education schedules **25 credits in Fall 2027**, entirely from the MAP sheet's
own printed total. BYU's registration cap is 18. Animation has an 18.5-credit Fall 2026 by
the same route. A student cannot register for either semester.
