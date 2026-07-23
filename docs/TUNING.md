# myplanBYU — Data & Solver Tuning Log

Working log of the accuracy-tuning process: how plans are audited, what the
data pipeline gets wrong, what was fixed, and what's still open. Keep this
updated every tuning session so the workflow context is never lost.

## Source-of-truth hierarchy

When sources disagree, trust in this order:

1. **Department flowcharts** (2-D PDF grids; Marriott + Engineering publish
   these) — richest: cohort envelopes, forced courses, semester placement.
   Newest sheet wins. *Proven point: ACC 410/411/504 are on the current
   Accounting flowchart but not yet on catalog course pages — the flowchart
   was right.*
2. **MAP sheets** (official 8-semester plans on most catalog program pages) —
   authoritative sequencing/pacing + admission timing ("Apply to the program
   during this semester").
3. **Catalog program pages** (coursedog freeform requirement HTML) — the
   requirement structure (buckets/choices), but lags flowcharts.
4. Catalog course pages — credits/prereqs/offerings; can lag too.

## Audit workflow (repeatable)

1. Serve the app (`.claude/serve.ps1`, port 8127) and drive it headlessly via
   the browser console: `Solver.solve(profile)` for a spread of majors
   (prioritize popular ones + limited-enrollment programs).
2. Instrument each plan for: per-term credits vs caps, ≥3 hard-course stacks,
   prerequisite ordering (independent recheck, not the solver's own flags),
   admission gating (`result.state.admitGate`), unscheduled leftovers,
   first-semester load.
3. Data-quality sweeps across all programs: corrupt credit totals
   (plausible band 10–130), "Complete N" vs available options, programs with
   ~0 real courses.
4. Cross-reference suspicious results against the live catalog/advisement
   pages (web agents), remembering the hierarchy above — catalog pages saying
   a flowchart course "doesn't exist" is NOT disproof.
5. Fix scraper → regenerate → re-run the same instrumented audit → diff.

## Audit findings — 2026-07-18 (10 popular majors)

Majors: Exercise Science, Psychology, Nursing, CS, Accounting, Finance,
Mechanical Engineering, Elementary Education, Biology, Marketing.

Verified-good: prereq ordering (0 violations), business junior-core cohorts,
over-18-credit warnings, Accounting hard-stack warning (reality: the junior
core is that brutal), Fall-only Accounting start captured.

Problems found (✔ = fixed this session):

| # | Problem | Root cause | Fix |
|---|---------|-----------|-----|
| 1 | Limited-enrollment admission never enforced (NURS 294 sophomore fall, EL ED 400R **freshman winter**) | admission notes captured as prose only; `admitGate` derived only from junior-core cohort blocks (business/eng) | ✔ scraper emits `admit` (year + dept) from MAP "apply" anchors + admission-language notes; solver gates professional courses & makes MAP year-hints hard minimums for gated programs |
| 2 | MAP parser dropped most courses on many sheets (Psychology 6, Elem Ed 15 captured) | regex too strict: `*` markers, trailing `v` credits, "A or B" choice lines, missing "1st Semester" header after "FRESHMAN YEAR" | ✔ parser rewrite in `sources/maps.py` + `--reparse` mode (re-parses cached text, no re-download) |
| 3 | EL ED 400R (student teaching, 12 cr) scheduled freshman winter | its MAP line is "EL ED 400R or 496R 12.0" → dropped by the or-filter → no year hint → floated | ✔ or-choice lines now emit hints for each alternative |
| 4 | Corrupt program credit totals (English Teaching 3668, English 3645, Family Life:HD 210, BioSci Ed 153, MES/Arabic 142) | `credit_hours` from catalog payload trusted verbatim | ✔ sanity clamp: outside 10–130 → use computed bucket total |
| 5 | 17 buckets "Complete N Courses" with N > resolved options (Nursing 28 vs 27 — the 28 is right, data missed one) | scrape misses a link/course occasionally | ✔ generation-time health report logs each mismatch (fix data as flagged) |
| 6 | Nursing/Elem Ed modeled as free-floating courses (no cohort, no gate) | only flowchart programs get cohorts; MAP programs got soft hints only | ✔ gate + hard year-hints (full cohort blocks for MAP programs: future work) |
| 7 | First freshman semester overloaded (Marketing 18 cr / 8 classes) | optimizer packs term 1 like any term; MAPs pace freshmen ~13–15 | ✔ first-term cap (default 15) for true freshmen (no completed credits) |
| 8 | Elem Ed curriculum uses retired EL ED prefixes (catalog moved to ECSE/FDTN) | data snapshot lags a curriculum transition | open — re-scrape when catalog.json refreshed |

## Results — verified 2026-07-18 (post-fix re-audit, same 10 majors)

| Metric | Before | After |
|---|---|---|
| MAP courses parsed (123 sheets) | sparse (Psych 6, ElemEd 15) | 2,142 total (Psych 12, ElemEd 27) + 14 admission anchors |
| EL ED 400R (student teaching) | **freshman Winter 2027** | senior Fall 2029 (12-hr slot), whole EL ED sequence Y3–Y4 per MAP |
| Nursing gate | none; NURS 294 ungated | `admit {y:2, dept:NURS}`; 0 NURS courses in year 1; lock-flag shown |
| Admission gates active | Acc/Fin/Mktg only (cohort side-effect) | + Nursing, Elem Ed, English Teaching + any major with an early MAP "apply" anchor |
| First freshman term | up to 18 cr / 8 classes | 14–15 cr across all 10 (settings.firstTermCap, default 15) |
| English (BA) credits | 3645 | 51 |
| English Teaching credits | 3668 | 74 |
| Prereq violations | 0 | 0 (unchanged ✓) |
| Demo (IS/MISM+minors+certs) | solves | solves, 0 unscheduled (no regression) |

Remaining >130-credit computed totals (BioSciEd 153, MES/Arabic 142,
FamilyLife:HD 210) are flagged in `data/_health_report.txt` (23 findings) —
requirement-parse suspects to fix individually.

## Session 2 — 2026-07-18 (embedded-logic + pacing)

| # | Problem | Root cause | Fix |
|---|---------|-----------|-----|
| A | **Missing prereqs** (MATH 290 concurrent w/ 112; 113/213/215 crammed) | BYU stores most real prereqs in `nonEnforcedPrerequisites` FREE TEXT, which the scraper ignored | ✔ `parse_nep_prereqs` → strict merged into `p`, "or concurrent" → new `pc` (before-or-same). Prereq chains 1921→**2507** (1129 from nonenforced). Solver: `preCo` in `prereqSatisfied` + closure |
| B | Semesters too hard | default cap 18 | ✔ default `maxCreditsFW` 18→**16** (cohort envelopes still exempt). All 11 test majors now ≤16 except locked cohorts |
| C | **Year-restricted courses** not modeled (capstones any year) | no signal used | ✔ `minY` from "Senior/Junior standing" text + capstone names → **114 courses**. Solver hard-gates `course.minY`; 48/80 majors' capstones now all land year 4+. UI flag added |
| D | **Track "Frankenstein"** (Family Studies pulls BOTH tracks) | `flatten_group` collapsed a nested option ("Complete 3 Requirements" = 9+3+6 hr) to `take="all"` → one track pulled its whole 58-course pool | ✔ `subtree_requirement` sizes the option (→18 cr). Family Studies now picks ONE track (11 SFL, 0 SOC W); credits 77→49 |
| E | Math MAP "marketing program" text | BYU copy-pasted Marriott recruiting boilerplate into the Math PDF | ✔ `sanitize_map_text` strips it (RAG-only; needs a Pinecone re-embed to reach the live advisor) |

Verified: 0 prereq-order violations (except Accounting's intra-cohort concurrency, correctly exempt — 0 user warnings), demo solves clean, no console errors.

**Known trade-off:** the 16-cap stretched the MISM demo showcase 10→12 FW terms (it's a bachelor's+integrated-master's + 2 minors + 2 certs). Decide whether the demo profile keeps an 18-cap.
**Catalog-permitted, not forced:** "X or concurrent enrollment" allows same-term (MATH 290 sits with 112). `pc` only blocks the dependency landing strictly later. Flip to strict-before if desired.

### F & G — done 2026-07-18

| # | Problem | Fix | Verified |
|---|---------|-----|----------|
| F | ChemE Req 4 sub-parts (12 ENG / 4 EMSB / 3–6 EPSEL) have **no course links** → parser dropped them entirely; only 4.1 (chem lab) survived | Capture node body prose (`node["note"]`) + body-stated hours; `MIN_HOURS_RE` detects a credit floor over attribute pools → consolidate into ONE credit bucket sized to the floor (15, not 2+12+4=18) with every component rule in the note. Solver: tightened the "pool ≈ need → take all" heuristic (only when `poolCr ≥ n−2.5`) so a 3-cr pool toward 15 cr falls through to slots; under-enumerated credit buckets size slots at 3 cr | ChemE shows "Complete technical electives (15 hours min)" = 5×3cr slots, 100% plannable, EPSEL rule visible in the progress note. Fires on exactly 1 major |
| G | Math Req 3 ("cannot double count in Requirement 2") — solver let a course fill two buckets of the same program | `NODBL_RE` sets `noDbl` on flagged buckets (**12** across the catalog); solver `take()` blocks intra-program sharing when either bucket is `noDbl` (cross-program GE double-count unaffected) | Math: 0 overlap between Req 2 and Req 3 claims |

Full 176-major re-sweep after F & G: 0 crashes, 0 over-cap, 0 prereq/year violations, no runaway credits. Only 2 pre-existing data-thin majors leave >3 electives unscheduled (Communications: Advertising, Portuguese Secondary Major — data gaps, not F/G).

## Session 3 — 2026-07-18 (term/credit balance: 8-10 terms, ~16 cr, 17 OK)

Goal: plans stay in 8-10 F/W semesters at ~16 credits, allowing 17 when it
buys a semester. The old hard-16 cap couldn't express that trade (a 166-cr
double degree was FORCED into 11-12 terms).

| Change | Where | Effect |
|---|---|---|
| Hard ceiling 16 → **17**; scoring penalizes every credit over 16 (0.8/cr) so 17s stay rare | `data.js` `maxCreditsFW`, existing life penalty | "sometimes 17" |
| Term budget **clamps to 10** before spilling to an 11th semester (unless credits > 10×cap) | `solver.js` termBudget | 8-10 shape |
| **+6/active-semester marginal price** in the cost objective — the missing exchange rate that lets `compact()` term-emptying moves actually win | `scorePlan` cost | plans compact instead of smearing into the budget |
| **Variable-credit repeat ladders compress**: scraper exports `vx` (max per-term credits, 993 courses); solver raises per-term enrollment so e.g. CPSE 486R "12 hours" is 4×3cr, not 12 sequential 1-cr semesters. Ladder window scales with course level | `generate_data.py`, `data.js`, `expand()` | Special Ed 12→8, Music BMs 11-12→8-9 |
| **courseLevel regex bug**: `\b` failed on R-suffixes — every repeatable (460R, 486R, 496R) leveled as 2 and paced like freshman work | `courseLevel()` | correct level pacing for all R-courses |
| Demo profile opts into **Spring terms** (12-mo lease makes them ~free; its 173.5 cr can't fit 10 F/W × 17) | `data.js` demo settings | demo: 12 F/W terms → **10 F/W + 4 light Springs, ends Winter 2031** (a year earlier) |
| MAT (Master of Athletic Training) leaked into undergrad majors | `GRAD_DESIGS` | removed (175 majors) |
| Dev server sent no cache headers — stale solver.js silently masked edits | `.claude/serve.ps1` `Cache-Control: no-store` | tooling fix |

**Final sweep (176 majors):** 98% in 8-10 terms (119@8 / 29@9 / 24@10), **0 terms over 17**, over-16 on 17.6% of terms, 0 crashes / prereq / year violations.
Remaining outliers (documented): BioSciEd 12 (corrupt requirement parse, health-flagged), Civil Eng 11 (season-locked CE chains + MAP hints — candidate for a future look), Portuguese Secondary 12 (thin data, 10 unscheduled — health-flagged).

## Session 4 — 2026-07-19 (MAP-FIRST OVERHAUL)

**Architecture pivot:** every draft plan now STARTS from the official MAP
sheet instead of being derived algorithmically. The optimizer's job changed
from author to adaptor — "deviate minimally from the advisor-authored plan."

| Piece | What it does |
|---|---|
| Full-fidelity MAP parse (`sources/maps.py`) | EVERY sheet line captured per semester: coded courses, or-choices, GE/religion/elective/major slots w/ credits, Spring/Summer blocks, declared Total Hours. 118/123 sheets full-fidelity; 85% of 949 terms sum within 1.5 cr of their printed total |
| `mapPlan` baked into programs (`generate_data.py`) | 116 majors carry the resolved sheet (`{y, s, items, total}`) |
| Solver MAP mode | Sheet-coded courses HARD-PINNED to their exact semesters (bypasses season/prereq checks — sheet is authority; issues surface as warnings). Sheet terms capped near printed totals (F/W may stretch to 16 within the fixed policy; overflow evicts to the LATEST term with room, never freshman fall). Elective filler targets the sheet's own total, not a flat 120. Sheet-required Spring blocks auto-enable Spring. MAP terms below 14 cr are the sheet's own pacing — never padded |
| Provenance flags | MAP-backed: "follows the official X MAP sheet". No sheet: "algorithmically generated — verify with your advisement center" |
| Sliders removed | Wizard is 3 steps; Priorities modal → "Plan constraints" (policy note + hard constraints only). Fixed policy: 14–16 cr (17 OK), 8–10 semesters, `minCreditsFW` 14 |
| Phantom-prereq fix | Mixed and/or prereq text ("ENGL 291, 292, and 293; or ENGL 291 and 294") now parses as ONE or-group — kills the ENGL 294 phantom that forced both survey tracks |
| `refresh_maps.ps1` | catalog → maps → generate with logging; cache self-invalidates on new sheet uploads. NOT scheduled yet (validate first, then `schtasks` line in the header) |

**Verified (175-major sweep):** 0 crashes, MAP mode active on 115, 0 terms >17,
**96% in 8–10 semesters**, 85 majors fully sheet-faithful (every term ≤ printed
total +2). English follows the sheet exactly (291/292/293 track only, capstone
senior year); Chinese language chain consecutive by construction (101→102→201→…);
Elem Ed mirrors its sheet term-for-term incl. Spring blocks. No console errors.

Known gaps (v1): slot-level fidelity is approximate (sheet slots shape capacity
rather than mapping 1:1 to named cards); 7 majors still 11–12 sems (licensure
programs + health-flagged data); 5 flat-text sheets (incl. Mathematics) fall
back to the labeled optimizer; MAP slots for minors/certs share generic backfill.

## Session 5 — 2026-07-19 (labeled slots + sheet-fidelity audit vs real PDFs)

Jordan supplied 6 downloaded 2025-26 MAP PDFs (IS, Nursing, PoliSci, Econ,
English, ANES Greek NT) with one known bug: IS 401 planned Fall when the
sheet says Winter.

**Fixes:**
1. **Sheet outranks every cohort source.** Sheet-coded courses now leave
   hand-defined blocks (IS junior core), flowchart envelopes, AND co-req
   blocks — the IS 401 bug's root cause was the older flowchart's fall
   envelope overriding the 2025-26 sheet's fall/winter core split.
2. **Labeled slot cards (board reads like the printed sheet).** Every
   non-coded sheet line ("Religion Cornerstone course", "GE - American
   Heritage", "PSYCH elective (req 7)") is matched to a planner instance of
   the same kind, pinned to its sheet term, and carries the sheet's label on
   the card. Multi-credit lines ("General Education courses 9.0") consume
   several slots.
3. **Emphasis majors fetch their MAPs** (maps.py now includes type=EMPHASIS):
   +71 sheets → **194 MAP plans, 155 programs** with full sheets (was 116).
   Covers ANES: Greek New Testament.
4. Hand IS_BS grafts the catalog's mapPlan (it replaces the catalog record
   for cohort data and was silently opting out of MAP mode). IS_BS_MISM
   deliberately does NOT (5-year integrated shape is hand-designed).
5. Repeatable sheet courses survive noDbl buckets (GREEK 411R ×2 semesters).

**Audit protocol (repeatable):** parse the downloaded PDFs with the SAME
parser (verified byte-equal to pipeline cache — same source files), then per
sheet-coded course assert plan term == sheet term (year+season).

**Results:** the 6 user majors + Sociology/History/ExSci: **all 9 = 100%
sheet-exact** (incl. IS 401 → Winter, GREEK 101→102→201→302→311→411R×2 ladder).
Full catalog: **2,656/2,656 sheet-coded placements exact (100%) across all
155 MAP majors**; 0 crashes; demo unaffected. No console errors.

Notes: ~14 terms show >17 credits because the SHEETS print those loads
(Nursing 19-cr fall; Dance 19) — sheet authority beats the credit policy by
design. Known cosmetic nit: an either/or GE line ("First-Year Writing or
A HTG") can label the sibling category's slot. 11 majors at 11-12 sems
(sheet-less or health-flagged data).

## Session 6 — 2026-07-19 (MAP slots → real catalog buckets)

Feedback: GE labels mismatched (Global&Cultural card showing "American
Heritage"); religion cornerstones pre-assigned instead of choosable; ChemE
sheet's CHEM-lab / EMSB / EPSEL / Engineering electives missing or unmatched;
ME "Technical Elective" showing only CS 111; "CS 110 or 111" should be a bucket.

**Root architecture change:** each non-coded MAP slot now binds to the REAL
catalog requirement it represents (by bucket-key), placed in its sheet term
with the sheet label — so the "choose ▾" dropdown shows that requirement's
actual option pool AND the board reads like the printed sheet.

| Fix | Where |
|---|---|
| GE slot → the correct GE category bucket (`GE_MAP` keyword→id); unrecognized specific labels (First-Year Writing) no longer grab a random category | solver `slotKeys` |
| Religion cornerstone → **choose-1-of-4 bucket** (was 4 concrete courses); religion elective → choose-any. Gated to MAP majors | `expand` (skip "N-of-N = all" for religion) |
| ChemE Req 4 **un-consolidated** back into 4.1 lab / 4.2 ENG / 4.3 EMSB / 4.4 EPSEL buckets; childless "approved-elective" credit reqs now emit real buckets | `generate_data` walk() |
| **Attribute pools built by rule**: 4.2/4.3/4.4 filled with 300+ courses from the named colleges (`college` metadata), EXCLUDING the program's own required courses (catalog rule + fixed the "auto-satisfied → no slots" bug). ~120 opts each | `enrich_attr_pools` |
| Major elective slot → its bucket by "(req N)" or keyword (name+note+**option course names**); tie-break by largest credit pool (Engineering→12-cr ENG, not 2-cr lab). Notes attached to choice/credit buckets for matching | solver `bucketByKeyword` + `generate_data` |
| "A or B" sheet line → the "Complete 1 of N" catalog bucket (CS 110/111), not a force-pinned CS 111 | parser skips or-choice force-include; solver binds the choice bucket |
| Two-pass binding: specific categories before generic "General Education courses" lines | solver |

**Verified:** ChemE board shows "CHEM Lab elective — choose ▾" (Winter 2028),
"EMSB elective" (120 opts), "EPSEL elective", "Engineering elective" all in
their sheet terms; ME "Technical Elective" (321-opt Req 9) + "CS 110 or 111"
bucket bind; English/PoliSci GE cards bind to correct categories; religion is
choosable. **Full sweep: 175 solved, 0 crashes, coded fidelity 2530/2530 (100%),
92% in 8-10 sems, demo 10 sems.** No console errors.

Residual (cosmetic): either/or GE lines ("Civ2/Arts") bind one category and
leave the sibling as a correct-but-unlabeled GE card; a couple of over-
provisioned ENG slots float unlabeled. catalog_data.js grew to ~1.9 MB (notes +
attribute pools) — fine for one-time load, revisit if it matters.

## Session 7 — bucket-option fidelity + over-provisioning diagnosis

**Reported:** Civil Eng "Requirement 5" (CE Breadth) dropdown showed only
CCE 304 + CE 351; catalog lists 7 (CCE 304/306, CE 321/331/341/351/361).
"How accurate are the buckets? Find out why."

**Root cause (reported symptom):** the DATA is correct — `civil-engineering-5`
carries all 7 options with right credits/off/prereqs. The loss was in the
**dropdown picker** (`app.js openBucketPicker`): it hid any option that was
(a) already on the board or (b) not taught in that slot's season. Five of the 7
breadth courses were already in the plan — pulled in as **prerequisites** of
design courses chosen for *other* requirements (CE Breadth's 7-course pool is a
strict subset of the 70-course Technical Elective pool) — so only the 2
un-scheduled ones survived the filter.

| Fix | Where |
|---|---|
| Picker now shows the **full requirement pool**: `opts` (taught this term, pickable) + `alts` (taught another term — always shown now, picking moves the slot) + **`inPlanPool`** (already scheduled — shown greyed "✓ in plan", non-clickable so it can't be double-added). Header reads "N options for this requirement" | `app.js` openBucketPicker |
| New styles `.bp-grouphdr`, `.bp-inplan` | `css/styles.css` |

**Verified:** CE Breadth dropdown renders all 7 (2 pickable + 5 "in plan"),
real DOM. 566 bucket slots across 25 majors: 0 exceptions, no console errors.

**Discovered (bigger, NOT yet fixed — flagged for user):** heavy elective
majors over-provision credits. Total placed credits vs. a healthy ~120:
Civil 168.5 / 11 terms, ChemE 190.5 / 12, Chem-Ed 167.5, Biochem 153.5,
Dance 157.5. "Normal" majors are fine (Econ 120 / 8). Two distinct mechanisms:
1. **Prereq-pulled pool courses aren't credited to their choose-bucket.** CE 321
   etc. get pulled as prereqs, satisfy CE Breadth in real life, but the bucket
   still provisions its full 12 hrs of placeholders on top → ~13.5 cr of pure
   duplication (Civil), 17.5 (Dance, 13 pulls), 9 (Biochem). `expand()` only
   credits `completed` / `_preRequired`, not courses the scheduler pulls later.
2. **Floor-padding of light tail terms** (`ELECTIVE+` / `electives::floor`,
   solver ~L1635/1702): heavy majors spread across too many terms, and each
   under-12-cr term gets padded to the full-time floor → ChemE +30 cr of filler
   across 12 terms. (The separate toward-120 `ELECTIVE` pass is legit — Econ's
   27 cr of it is correct.)
Both are solver surgery that touches the green 175-major sweep + product intent
(auto-credit prereqs to buckets removes user choice; aggressive term-compaction
fights recommended-year placement) — held for user direction.

### Duplication fix SHIPPED (cause #1) — `solver.js expand()` Pass 3.4

User picked "fix duplication first." Added a reconciliation pass after prereq
closure: a course dragged in ONLY as a prereq (`buckets ⊆ {prereq::closure,
electives::extra}`) that sits in a choose-bucket's pool is **reassigned** to
credit that requirement (single-count), and the bucket's placeholders rebuild for
the reduced remainder. Specific requirements (smaller pools) claim before generic
ones so CE Breadth (7) wins over Technical Elective (70).

**Result: correct but credit-neutral in isolation — cause #1 and #2 are
entangled.** Civil bucket-placeholders dropped 79→65.5 cr and prereq-pulls
16.5→3 cr (breadth now credited), BUT floor-padding rose 3→18 cr to refill the
freed term space → net 168.5→170. Dance did drop (157.5→147.5). The credit win
from #1 only materializes once #2 (floor-padding of over-long plans) stops
back-filling. Sweep after fix: **175 solved, 0 crashes, MAP fidelity intact
(civil 25/25, dance 19/19).** Kept the fix (it's semantically correct and a
prerequisite for #2); recommend #2 next to realize the savings.

## Session 7b — full 175-major cross-examination audit

Automated audit (`__audit2` in-browser): solve every major, flag prereq-order
violations, season violations (split: MAP-coded = sheet-authoritative vs free
placement = real), over-cap terms. **0 crashes; MAP coded fidelity 100%.**

**Findings by class (counts approximate, across 175 majors):**
- **Season data incompleteness (~45, MAP-coded):** a sheet places a coded course
  in a season its scraped `off` omits (IS 401 sheet=Winter but `off:F`; IS 404
  sheet=Fall but `off:W` — they look swapped; LATIN, CHEM 468/489, etc.). The
  sheet is authoritative, so the PLAN is right and `off` is wrong/partial. This
  also degrades the new picker (it filters options by `off`). **Recommended fix:
  in `generate_data.py`, union each mapPlan coded course's sheet season INTO its
  `off` (monotonic widen, never narrow).** Low-risk, high-value, but regenerates
  the 1.9 MB `catalog_data.js` — HELD for review (not done autonomously).
- **Season, free placement (~5 only):** genuine solver mis-seasons — LATIN 301
  (F/off:W), LATIN 302 (W/off:F), IS 404, BIO 194, CHIN 321. Almost all trace to
  the same `off`-data gap, not a scheduler bug.
- **Prereq-order (~140 raw, ~75% benign):** benign = major skips a low catalog
  prereq via AP/placement (MATH 112←nothing, CHEM 111←MATH 110) + repeatable
  lesson ladders (MUSIC 294/296/298, R-courses). **Genuinely actionable:**
  - `FIN 201 ← ECON 110` across ALL business majors: FIN 201 pinned early by a
    flowchart hint (Y2/Y3 F) while ECON 110 (also a Social-Science-GE candidate)
    floats one term later. Real cross-bucket ordering gap — a prereq that also
    fills a GE isn't forced before its dependent. Solver fix, medium risk. HELD.
  - `HRM 391 ← HRM 401` across business majors: **almost certainly a bad scrape**
    — 391 (core, `off:FWU`) "requires" 401 (`off:F`, no prereqs itself), and every
    sheet schedules 391 without 401 first. Recommend dropping this prereq (verify
    against live catalog first). HELD.
    - `IS 404 ← IS 414` / `IS 413 ← IS 414`: IS senior sequence placed slightly
    out of order; tied to the IS 401/404 `off` swap above.
- **Buckets:** the "empty bucket" flags were an AUDIT false positive — GROUP
  buckets keep options in `groups[].options`, not `options`; the picker resolves
  them correctly (american-studies-6 has 33/45/64/45; verified). No real empty
  choose-slots found.

Net: the solver is robust (0 crashes, 100% MAP fidelity, most plans season- and
sequence-correct). The real accuracy gaps are (a) incomplete `off` season data
vs. the authoritative sheets, and (b) a handful of scrape-error prereqs (HRM 391)
and cross-bucket ordering (FIN 201). All HELD for user review — none are risky
enough to guess at while unattended, per "don't ship a bad product."

## Session 8 — slot→requirement binding by course codes + MAP parser overhaul

User feedback: Neuroscience "Applied Neuroscience requirement" (Req 7) bound the
Req 9 bucket; "NEURO 316, WRTG 315 or 316" (the AWOC GE) also bound Req 9.
Dietetics (Gemini audit): anatomy missing, NDFS 100 in senior year, CELL 305
timing, dup GE slots. Family Life: HD "didn't see a MAP sheet." "Rescan every
major for a MAP sheet."

**Solver — `bucketByCodes` (solver.js, MAP skeleton):** explicit course codes in
a sheet label are now the STRONGEST binding signal, beating keywords. Codes are
parsed with dept inheritance ("NEURO 316, WRTG 315 or 316" → NEURO 316, WRTG
315, WRTG 316; bare numbers inherit the previous dept), then the bucket — major
OR univ-core — containing the most of them wins (tie → smaller pool). Fixes:
Applied Neuroscience→Req 7, NEURO 316/WRTG→AWOC GE, Dietetics "CELL 210 or
220"→Req 2 anatomy, "PSYCH 111 or ANTHRO 101 or SOC 113"→Req 7.

**maps.py parser overhaul** (then `--reparse`, no network needed):
| Fix | Symptom it cured |
|---|---|
| `reflow_map_text`: line breaks before/after YEAR / "Nth Semester" / Total Hours headers + after decimal credit tokens | Mathematics (BS), Graphic Design, Illustration, Photo-&-Lens, Interdisciplinary Design sheets were flowed onto ~4 long lines -> only legacy `terms`, never a full `map` |
| wrapped-line JOIN (no trailing credit + next line starts lowercase) | "CHEM 101 or equivalent … from / high school or junior college 3.0" split -> junk slot + lost entry |
| strip `*`/`+` footnote markers glued to codes | Dietetics "NDFS 100*+", "CELL 305+", "CHEM 285+" never coded -> NDFS 100 drifted to SENIOR year (admission gate held the unpinned course), CELL 305 missed its sheet term |
| SLOT_RE accepts range credits ("3-4.0", lower bound) | "CELL 210 or 220 3-4.0" (the anatomy requirement!) vanished entirely |
| junk guards: integer-only "credits" rejected, dangling-conjunction labels rejected, "should be taken/once in semester" prose | "NEURO 455R should be taken twice; once in semester 3…" became two phantom slots worth 3+6 cr |
| GE_RE accepts "Global and Cultural" (with "and") | classified as major slot, dropped |

**generate_data.py attach fixes:** plans keyed by designation-PRESERVING norm
(was stripping "(BS)" → Chemistry BA/BS and Dance BA/BFA collided; one program
got a Frankenstein-merged sheet, the other none); majors-first fallback index
(minor "Mathematics" was shadowing the BS major). Childless quantifier nodes
with NO attribute rule (Dietetics "Req 4 — Complete 1 Options" = admission
policy prose) demote to program notes instead of forever-empty buckets.

**MAP coverage: 155 → 162 majors.** Gained: Chemistry (BS), Dance (BFA),
Mathematics (BS), Graphic Design, Illustration, Photo- & Lens-, Interdisciplinary
Design. The 13 without sheets are LEGITIMATE: 8 BGS distance degrees (no
semester table on the sheet), Tax (BS) + SpEd: Severe (BYU publishes none),
Asian Studies umbrella (per-emphasis sheets only), German (BA) legacy record
(sheet lives under German Studies (BA), which has it), IS-MISM (hand-curated).

**Verified:** 175/175 solve, 0 crashes, MAP coded fidelity 100%, demo 13 terms
0 warnings. Neuro/ChemE/ME bindings all correct. Dietetics: WRTG 150 + NDFS 100
freshman fall, CELL 305 Winter Y2 (before the Fall Y3 professional sequence),
anatomy + Req-7 + CHEM-101 slots bound and labeled.

**Found & documented (not yet fixed):**
- FL:HD (BS): sheet exists + parses; the real issue is the catalog EMPHASIS tree
  ("1 of 2 Options" each "Complete 4 Requirements") flattens to ONE 51-cr credit
  pool — the 12-course HD core isn't forced. Needs subtree_requirement to emit
  real per-rule buckets for the chosen option. (Its sheet is also unusually
  generic — SFL coded courses only in Y3.)
- Dietetics "NDFS 374 NDFS 405 2.0" (two codes one line) stays a slot; NDFS 374
  scheduled via Req 5 anyway.
- GE double-count optimization (SOC 113 covering Global&Cultural AND Req 7
  simultaneously) — the plan provisions both slots; picking SOC 113 in one
  leaves the other. Design decision needed (auto-merge vs student choice).

## Session 9 — headroom weaving (leftover tail classes) + track-aware parsing

User approved "option 1 with option 2 folded in": fold post-MAP leftover terms
into the sheet's own semesters.

**`weaveTail(state)`** (solver.js, runs after enforceMapCaps, then a re-run of
`topUpFloor`): tail terms (beyond the last sheet term) are processed last-first,
**all-or-nothing** — either every item finds an earlier home (term dies, its
ELECTIVE+ floor-padding evaporates) or the term is left untouched, so no
half-drained sub-12 semester. Deepest prerequisite chains move first into the
EARLIEST legal term. Ceiling 16 first, 17 retried ("sometimes 17 is fine").
A course whose seasons block every direct home may SWAP with a flexible
placeholder (donor term floor-guarded ≥12; religion slots and sheet-labeled
cards never bumped; swaps revert via closure stack if the term can't die).
Result: light tails (≤ sheet headroom) die — biodiversity/biophysics/business
9→8 terms; heavy tails (Accounting 144 cr > 8×16=128) correctly survive.
Iteration found+fixed: swap could drain a donor below 12 (0.5-cr course
replacing a 3-cr slot) → donor floor guard; failed terms leaked swaps → revert
closures; surviving light tails re-padded by a second `topUpFloor`.

**Parser (maps.py), found while verifying weave:**
- `SEM_RE` now $-anchored: prose mentioning a semester ("…1st Semester
  professional sequence to start fall…", "(taken 3rd semester) 3.0") was
  RESTARTING the term counter — truncated Dietetics to 4 terms.
- Header pre-scan: ONE numbering restart = alternate-track grid (language
  sheets' "start in 201" tracks) → keep the FIRST grid; TWO+ descents =
  interleaved two-column PDF (German Studies extracts 1,5,2,6,3,7,4,8 — content
  scrambled beyond line repair) → skip the full map (honest labeled fallback)
  instead of baking a 29-item/69-cr Franken-semester. German (3 emphases) +
  Asian Studies (3 emphases) fell back; MAP coverage 162→161 majors, all
  now trustworthy.

**Verified (final build):** 175/175 solve, 0 crashes, MAP coded fidelity 100%,
demo 13 terms/0 warnings, avg ~9.0 terms. Floor violations reduced to
pre-existing artifacts (Portuguese SECONDARY major is part-time by design;
archaeology/genetics single mid-plan 11.0 = old fillLight artifact). No weave-
created >17 terms; the few heavy first terms (animation 18.5, wildlife 21) are
the sheets' OWN printed ranged-GE lines (data-polish item: ranged
"General Education courses 3-9.0" slots take the LOWER bound but takeSlot can
still stack; revisit slot-budget splitting).

## Session 10 — catalog prerequisites on the class-detail card

User: "On each class detail add what the prerequisites are, found on the
catalog." The modal already showed code chips from the ENFORCED `pre`; added the
catalog's readable prerequisite LINE.

- `generate_data.py`: new `render_requisites_text()` walks a course's full
  `requisitesSimple` for DISPLAY — handles `completedAllOf` (AND of value-groups)
  AND `anyOf`/`subRules` (BIO 350 "CELL 120 or BIO 130 or MMBIO 121"), which the
  enforcement parser skips. `prereq_text()` prepends that to the non-enforced
  free text verbatim ("Acceptance into the Information Systems major", "Math
  112.") since NEP carries NON-course requirements (standing/admission/consent)
  that never become codes. Pure-OR chains dedupe overlapping alt-tracks. New
  per-course field `pt` (4325/7126 courses). Enforced `pre` UNCHANGED (no solver
  perturbation).
- `data.js`: hydrate `e.pt` -> `course.preText`.
- `app.js` course modal: "Prerequisites · per catalog" shows the `preText` line
  + the existing code chips; "None listed." when the catalog has none. New CSS
  `.cm-pretext` / `.cm-seclabel-src` / `.cm-chips`.

Verified: modal renders (CE 321 "CCE 203 and CCE 270", BIO 350 anyOf, IS 414
admission text); 175/175 solve, 0 crashes, MAP fidelity 100%, no console errors.
Note: FIN 201 shows "None listed" — its catalog requisites ARE empty (the
ACC 200/ECON 110 it schedules come from a non-catalog source); honest per the
catalog. Follow-up (not done): the enforcement parser (`course_prereq_groups`)
still skips `anyOf`, so those prereqs display but aren't solver-enforced.

## Session 11 — 15 random plans (major+minor+cert) audit + AND-list fix

Generated 15 seeded-random combos incl. minors/certs; audited difficulty, term
count, prereq order, MAP-slot→bucket binding.

**Real bug found + FIXED — AND-list sheet lines mis-bind.** A sheet line naming
REQUIRED courses joined by `&`/commas ("CHEM 106 & 107 4.0", "MUSIC 193, 195,
197 (FSp) 4.5") was parsed as ONE choose-slot. That slot mis-bound to an
unrelated ELECTIVE bucket (Exercise Sci CHEM→Req 6 cell-bio; Commercial Music
MUSIC→Req 3.2 music history) via bucketByKeyword, AND the real required courses
lost their sheet pin — Exercise Sci CHEM 106/107 drifted from sheet Winter Y1 to
Fall 2029 (senior year). Fix: `maps.py ANDLIST_RE` + `andlist_codes()` split an
and-list into coded courses (bare numbers inherit the prior dept), each pinned
to its sheet term; "or" lines still route to OR_RE (choices). +187 coded courses
across all sheets. Verified: CHEM 106/107 → Winter Y1, MUSIC 193/195/197 → Fall
Y1, phantom slots gone; 175/175 solve, 0 crashes, MAP fidelity 100%, demo intact.

**Not bugs (checker false-positives):** GE slots with a parenthetical rec
("Languages of Learning GE (STAT 121 recommended)") bind the category correctly;
OR-choice slots binding their choice bucket ("MUSIC 303 or 304…"→Req 3.2) are
correct.

**Found, NOT fixed (documented):**
- Some choice-bucket pools carry UNRESOLVED course-NAME strings instead of codes
  ("History of Western Music*" in commercial-music-3-2) — a `*`-footnote breaks
  name→code resolution in the scraper. Schedulable (synthesized) but ugly; the
  real codes (MUSIC 304/305/306) never resolve.
- **Certificate language sequences place out of order** (VIET 330 in first term
  w/o VIET 202; CREOL 340 years before CREOL 330). Language-cert courses carry
  weak/no prereq data, so the solver floats them. Low impact (cert electives).
- Term-count inflation with minors/certs: 1-2 minors + a cert pushes most plans
  to 11-12 terms / 150-192 cr — same floor-padding root as cause #2 (deferred).
  No-extras baseline is healthy (Plant & Landscape Systems 8 terms / 118 cr).
- Difficulty: only ChemE+minor+cert genuinely brutal (5 hard terms, 6 hard
  courses one term); everything else 0-2 hard terms.
- Recurring known prereq flags resurfaced: FIN 201←ECON 110, HRM 391←HRM 401
  (bad scrape), CHEM 111←MATH 110 (AP-skipped low course).

## Session 12 — cause #2: term compaction / floor-padding (partial, safe)

Re-diagnosed the heavy-major overshoot (healthy majors have total≈sheet-total;
heavy ones overshot the sheet by 49-59 cr). Two root mechanisms found + fixed:

1. **Self-justifying floor padding.** `compact()` targets `round(totalFW/15.5)`
   terms — but `totalFW` INCLUDED the ELECTIVE+ floor fillers, so the padding
   inflated the count that justified its own extra terms. Fix: strip ELECTIVE+
   BEFORE the final `compact()` so it sizes term-count from REAL content, then
   compact/closeGaps collapse the freed terms, then topUpFloor re-guarantees ≥12.
   IMPORTANT ordering: this runs BEFORE enforceMapCaps+weaveTail (putting it
   LAST reshuffled some minor/cert plans into a worse local optimum — Math+Art
   History+Creole regressed 10->11 terms; moving it earlier fixed that).
2. **Spurious prereq pulls stranding tail terms.** ChemE places out of MATH 110
   (AP calc) but prereq-closure pulled it for CHEM 111; its dependent CHEM 111
   sits in term 0, so `depLimit` froze MATH 110 in the senior-year tail,
   anchoring an extra term. Fix (`expand` Pass 3): for MAP majors, don't pull a
   sheet-coded course's prereq when the SHEET omits it — the sheet's sequence is
   authoritative (assumes AP/placement/transfer). `mapCoded` set gate.

**Results (solo):** ChemEd 179.5/12 -> 150/10, Civil 170/11 -> 155/10, Biochem
153.5/10 -> 138.5/9, ChemE 190.5/12 -> 175.5/11. Healthy majors unchanged
(Econ 120/8, English 121.5/8, Plant 117.5/8). **15 random minor/cert combos:
all improved or neutral, ZERO regressions** — Early Childhood -2t/-28cr, Chem Ed
-2t/-30cr, ChemE -1t/-15cr, Exercise Sci -1t/-9cr. Sweep: 175/175, 0 crashes,
MAP fidelity 100%, demo 13t/0 warn, no new light terms (3 pre-existing 11.0
artifacts remain: archaeology/genetics/molecular-bio).

**Residual (NOT fixed — needs a product decision, flagged):** the heaviest
majors still exceed their sheet total (ChemE 175 vs 131). The excess is now
almost entirely **unbound GE over-provisioning** — the either/or GE lines
("Civ2/Arts", "Letters/Global") that engineering sheets COMBINE but the catalog
counts as separate 3-cr requirements, plus genuine prereq chains in overflow
electives. Closing it means TRUSTING the sheet's reduced GE over the catalog's
full GE bucket (trim unbound GE placeholders to the sheet total). That risks
dropping a GE a student genuinely needs, so it's HELD for user sign-off rather
than guessed at ("don't ship a bad product"). This is the same either/or-GE item
open since Session 6-7.

## Session 13 — cause #2 finished: GE right-sizing (reduced-GE majors)

User pushback on the earlier "trust the sheet, trim GE" framing led to the real
answer: engineering majors have a **reduced General Education distribution**, not
pre-completed GEs. Evidence — same Civ/Arts/Letters space across sheets:
Psychology lists `CIV 1`, `CIV 2`, `Arts or Letters`, `Letters` (4 courses);
Mech/Chem Eng list just `Civ 2/Letters`, `Arts or Civ 1` (2 "pick one"
courses). BYU trims GE for ABET engineering. Plus Global & Cultural Awareness is
an OVERLAY (the scraped University Core says it's fulfilled "through any of the
American Heritage options" — rides on another course), and major math/science
covers Quantitative/Physical Science. The app applied the FULL 12-category
University Core to EVERY major, over-provisioning reduced-GE majors by ~12 cr.

**Fix (`solve`, after `seed`): GE right-sizing.** For a MAP major whose sheet
ENUMERATES GE (no generic "General Education courses" / "University Core
elective" catch-all), the sheet's BOUND GE slots ARE the requirement — drop the
unbound universal-GE placeholders the sheet never slots. Two guards make it
safe:
- **Budget guard:** never trim below the sheet's own credit total (sum of
  printed term totals). american-studies (light BA, plan==sheet==120) drops
  NOTHING; ChemE (plan 175 » sheet 131) drops its 4 excess GE. This alone fixed
  the american-studies 102-cr regression.
- **budget >= 100** skips secondary/double majors (37-cr sheets that never
  carried University Core).
Removed buckets are deleted from `expandRes.chosen` too, so no phantom GE-gap.

**Also (`seed` 4b):** the "Pinned course X sits before its prerequisites" error
now fires ONLY when the prereq is in the plan but LATE (a real ordering bug) —
not when it's absent (AP/placement/transfer the sheet assumes). Killed the
false alarms on CHEM 111←MATH 110 etc. across the reduced-GE plans.

**Results (solo):** Chem Ed 179/12 -> **120/8**, Civil 170/11 -> **140/9**,
Biochem 153/10 -> **136/9**, Mech Eng -> **145/9**, ChemE 190/12 -> **176/11**
(still the outlier — a CHEM 351->467 Fall-only prereq chain in the overflow
resists compaction; its freed GE space just re-pads). Humanities/light majors
UNCHANGED and fully GE'd (american-studies 120 w/ 12 GE categories, Psych 119,
English 122). 15 combos: further wins (Geology 161->140, Construction 182->164,
Chem Ed 150->120, Math 149->134), zero regressions. **Sweep: 175/175, 0 crashes,
MAP fidelity 100%, 0 under-provisioned (budget guard), demo 13t/0 warn, avg
~8.5 terms.**

Remaining outlier: ChemE 176/11 — the last stubborn case, a genuine Fall-only
prereq chain, not over-provisioning. Everything else lands at/near its true
degree size.

## Session 14 — First-Year Writing slot mis-binding

User: Mech Eng "First Year Writing Elective" bound American Heritage instead of
WRTG 150. Root cause: `GE_MAP` had no First-Year Writing entry, so the label
matched nothing, fell through to the generic "…elective" catch-all, and grabbed
the first available GE category (American Heritage). WRTG 150 then floated to
senior year. Fix: added `[/first[\s-]?year\s+writing|\bfyw\b/i, "fyw"]` as the
FIRST GE_MAP entry (First-Year Writing is its OWN requirement, not a GE
distribution category, and distinct from Advanced Written & Oral). Verified:
ME binds WRTG 150 to freshman fall; American Heritage still covered by the sheet's
coded A HTG 100 (the old binding was a spurious double-count the fix removed).
**Full GE-binding audit across all 175 majors: 0 label-vs-category mismatches**
(this was the only one). "First Year Writing or A HTG 100" sheets still cover
BOTH FYW and American Heritage. 175/175 solve, 0 crashes, fidelity 100%.

## Session 15 — major-matched opportunities in the AI advisor

Goal: the RAG advisor should give ACCURATE opportunities (study abroad,
scholarships, research, clubs) for a student's major. Finding: the opportunity
docs were ALREADY embedded (embed_and_load `load_source_records`), but carried
NO structured college/program tag — so major-matching was weak semantic luck.

**Data side (`sources/opportunity_tags.py` + `embed_and_load.py`):** tag each
opportunity with the BYU colleges it's relevant to, using the STRONGEST signal
per source (verbose-prose keyword matching over-tagged — a Greek myth trip read
as "engineering"):
- study abroad -> the actual COURSE CODES in its "Courses:" section (ARTHC/CL CV
  credit => Humanities), + Kennedy Center by nature. 130/130 tagged.
- research grants -> the explicit "College of X" in the text.
- clubs -> the club NAME only (bodies are identical boilerplate). 168/374 tagged;
  the rest are social/cultural (correctly left general).
Subject->college is authoritative from each `course._raw_summary.college` (NOT
the colleges of programs that merely require the subject). `source_doc_to_record`
now adds a `colleges` metadata field AND folds "Relevant to students in: <college>"
INTO the embedded text so semantic retrieval ranks them for that college too.
301 docs tagged; realistic spread (study abroad skews Humanities/Kennedy, clubs
even across colleges, STEM study-abroad genuinely sparse).

**Retrieval side (`advisor_server.py`):** program->college map built at startup
(432 programs, from `program.college`). When a plan is shared AND the question is
opportunity-flavored (`_OPP_RE`: study abroad/scholarship/club/research/grant/…),
`student_colleges(plan_context)` maps the major(s) to college(s) and folds them
into the RETRIEVAL query ("… for students in College of Life Sciences") so the
tagged docs surface. Non-opportunity questions untouched. Verified offline:
Neuroscience+Psych -> Life Sciences+FHSS; ME -> Engineering; plural detection
(scholarships/clubs) fixed.

**ACTIVATED 2026-07-20** (user authorized). Ran `embed_and_load.py --only-sources
study_abroad,clubs,research_grants`: 507 vectors upserted (index now 8362 total,
catalog untouched — upserts overwrite by ID). Restarted `advisor_server.py`; it
loaded the 432-program->college map at startup. Live-verified: a Neuroscience plan
+ "study abroad?" query biases retrieval to College of Life Sciences (surfaced
Life-Sciences study abroad + programs); internals confirm Neuroscience->Life
Sciences, ME->Engineering, Accounting->Business, plural opp-detection (scholarships/
clubs) matching. NOTE: relaunch the server with the venv Python
(`C:\Users\jorda\venvs\myplan-scraper\Scripts\python.exe advisor_server.py`) — the
system Python312 it was on lacks `requests` in a clean env.

## Session 16 — decision log ("why is this class here?")

The solver knew every placement reason but threw it away. New `explain(state,
expandRes, programs)` in solver.js runs post-hoc after all passes (so it can
never drift from actual placement logic) and emits per-course `why` arrays +
plan-level `planNotes`. Signals: sheet-coded placement (mapCodes+pinned),
sheet-slot line (mapLabels), user pin, woven-tail (weaveTail now records
`state.woven`), prereq-only pull (buckets all prereq::/electives::), strict
dependents ("must come before X" — only when the course is the SOLE
planned/completed satisfier of a prereq group, never ambiguous alternatives),
single-FW-season lock, admission gate (professional phase starts Year g+1,
apply Year g), hardMinYear lock-step, ≥4-deep prereq chains (real courses
only — repeatable placeholders inflate computeDepth via instance sequencing),
religion pacing, ELECTIVE+ padding, flexible slots. planNotes: term-count math
(actual vs round(totalFW/15.5) ideal), MAP skeleton, woven count, gates, hard
rules. Consumers: (1) course modal "Why it's here" section (.cm-why, green);
(2) App.planSummary() "WHY THE PLAN LOOKS THIS WAY" + up to 14 load-bearing
per-course notes for the AI (slice 5800→7800; server MAX_PLAN_CHARS 6000→8000,
restarted). reanalyze() refreshes why after manual moves. Verified: 175/175
majors solve, 0 crashes, 94.3% of placements carry ≥1 why; live advisor answer
for "why is ME EN 340 senior fall?" correctly cited the ME EN 321 chain + the
Fall-only offering from the log. ALSO: dev server port 8127 landed in a Windows
excluded-port range — serve.ps1 + launch.json moved to 8130.

## Session 17 — mid-degree replanning (completed courses actually adapt the plan)

The wizard's History step already captured completed courses and the solver
already skipped them (instances, prereqs, sheet rows, bucket slot deduction) —
but a junior still got a 4-year-shaped plan: remaining sheet Y3/Y4 rows stayed
pinned at PLAN years 3/4 (CS junior test: 8 terms to Winter 2030). Two changes:

1. **Standing offset**: solve() computes `terms.yearOffset = min(3,
   floor(earnedCredits/30))` (matches BYU's real class-standing bands) and
   `acadYearIdx()` adds it. Every year-keyed rule reads through acadYearIdx, so
   the one offset re-aligns MAP-sheet term binding (sheet Y3 → plan year 1),
   flowchart-hint pacing, level pacing, senior minY, admission gates, and
   hardMinYear. Freshman path (offset 0) is structurally identical — ME
   baseline byte-matched. CS junior: 8 terms → 6 (Fall 2026–Winter 2029).
2. **Mid-degree pin guard**: the sheet's authoritative pin assumes years 1–2
   happened. With offset > 0, a coded row whose prereq group has NO satisfier
   among completed courses or earlier-bound sheet rows is NOT pinned — prereq-
   ordered seeding places it (CompE: EC EN 340 pinned into term 0 before MATH
   213; now correctly Fall 2028). Still in mapCodes, so Pass-3 suppression is
   unchanged.

Also: planSummary() now sends "Already completed: N courses / ~M credits
(list)" + the Mid-degree planNote to the advisor (live-verified: AI answered
"6 semesters left, graduate Winter 2029" from a shared junior plan).

Verified: 161 MAP majors solved as simulated mid-degree students (Y1-2 coded +
8 common GE done): 0 crashes, terms centered on 6 (121 majors), prereq-warning
majors 50 → 8 after the pin guard, remaining warnings are pre-existing sheet-vs-
catalog conflicts that also fire for freshmen (ACC 402/405/409 need ACC 407 the
sheet co-schedules — warning by design). Known edges: IT (BS) 12 terms is a
PRE-EXISTING data bug ("Obtain confirmation" bucket explodes into ~20 slots —
spawned as its own task); SFL 315→SFL 290 single warning appears under some
completion sets via slot binding (offset 0, honest warning, low priority).

## Session 18 — timeline/deadline layer (gates, dates, scholarships, study abroad)

New baked layer: `scraper/generate_timeline.py` → `js/timeline_data.js`
(`TIMELINE` global; all sources local, no network):
- **academicDates** (4): term start/end + add-drop/withdraw from academic_dates.json.
- **admitNotes** (26 majors): limited-enrollment admission sentences extracted
  from catalog.json requirement text (HTML stripped; phrase regex "students
  must apply / acceptance into / by application / …"). PRE-MAJOR fallback:
  criteria often live on the premajor page (Nursing) — attached to the
  matching undergrad major id.
- **programColleges** (352): program id → canonical college (same vocabulary
  as opportunity_tags), so scholarships/study abroad match client-side.
- **studyAbroad** (130, 104 college-tagged): name/url/colleges/term-cost line.
- **scholarships** (39, 37 with deadlines): parsed from the BYU Scholarship
  Matcher's curated data.js (../BYU Scholarship Matcher) — regex block parse;
  college keys → canonical names; {month,day} deadlines, notes, urls.

BUG FIXED in generate_data.py: plan keys are display names ("Nursing (BS)")
but LIMITED_ENROLLMENT keys are bare slugs ("nursing") — the curated Nursing
gate NEVER merged. Normalized the lookup; re-baked catalog_data.js (+35 bytes,
only the nursing admit). Nursing now fully gates: admitGate {major-nursing-bs:
1}, all 30 NURS courses held past freshman year, flag + why-log consistent.

App layer (app.js buildTimeline/renderTimeline, defensive if TIMELINE absent):
- Per-term board chips (.col-event): 🔒 "Apply to <major>" on the Winter of
  the pre-professional year (client acadYearOf replicates solver acadYearIdx
  incl. the mid-degree yearOffset), 💰 aggregated scholarship deadlines on
  terms containing the due month (audience filter drops incoming-freshman-only
  + transfer-only awards), ✈ study-abroad count on Winter terms of plan years
  1-3 (college-matched), 🗓 add/drop for terms with real calendar data.
- Left-panel "Deadlines & opportunities" chronological list (gate first, BYU
  scholarships before national, study abroad with urls).
- planSummary(): "DEADLINES & OPPORTUNITIES" block (top 12) → the AI cites
  real terms/dates. Live-verified: Nursing plan + "when do I apply / which
  scholarship deadlines?" → advisor answered "apply Winter 2027" with the
  catalog admission note, advisement-center contact, and a deadline table.

Verified after the catalog re-bake: 175/175 majors solve, 0 crashes; Nursing
gate chip on Winter 2027 with real admission text. Refresh flow: re-run
`generate_timeline.py` whenever academic_dates/study_abroad/catalog rescrape
or the Scholarship Matcher data.js changes.

## Session 19 — panel redesign: dropdowns + Recommended

User feedback on Session 18: scholarship deadlines dominated the panel/board.
Restructured buildTimeline() to return {byTerm, deadlines, recs, schols,
abroad} instead of a flat list:
- Board chips now ONLY 🔒 admission + 🗓 add/drop (scholarship/abroad chips
  removed — they live in the panel).
- Panel: deadlines on top, then a **Recommended** box (rule-based, from THIS
  plan's shape), then two native `<details>` accordions: "Relevant
  scholarships (N)" (college-specific first w/ "your college" badge, then
  BYU-wide, then national-badged; award · GPA · deadline · link) and "Study
  abroad for your college (N)".
- **Recommended rules**: (a) Spring/Summer-ONLY required courses while Sp/Su
  disabled — fires on real data: BYU Nursing's NURS 404 clinical is
  Spring-only ("off":"S"); (b) Spring as pressure valve when the plan is ≥9 FW
  terms or has ≥2 17-credit terms and ≥3 planned classes are also taught
  Spring; (c) ≥6 cr of open electives + no minor → "room for a minor with no
  extra semesters"; (d) 17-cr terms easing (when Sp/Su already allowed);
  (e) full-time-scholarship reassurance/nudge.
- planSummary(): sections KEY DEADLINES / PLANNER RECOMMENDATIONS (advisor
  told to refine, not contradict) / RELEVANT SCHOLARSHIPS (top 6) / STUDY
  ABROAD (top 4 of N). Live-verified: Spanish (BA) plan → advisor listed the
  Humanities college award first with GPA cutoffs and Feb 1 deadline, and
  matched Spain study abroads.

## Session 20 — what-if comparisons (switch-cost math)

New in app.js: `openWhatIf(preset?)` + `#whatifModal` (index.html). Modes:
add_minor / add_cert / switch_major / remove_minor / enable_spsu.
- `whatIfProfile(mod)`: deep-clone active profile + mutation (switch_major
  clears pins/fills/excluded — they referenced the old major's plan).
- Solve the alternative, `planMetrics()` both, diff REAL courses by courseId
  (placeholders/ELECTIVE+ excluded): carries-over count+credits, "Newly
  required (N)" and "No longer needed (N)" chip lists, FW-semester and credit
  deltas (badged +/-), graduation term. Because a new minor mostly arrives as
  choose-slots (not coded courses), the carry-over line also reports flexible
  slot credits (A→B cr) and "N cr of open electives convert into real
  requirements" so a ±0-semester result is explained, not mysterious.
- Actions: "Save as a new plan" (newPlanFromProfile — current plan untouched)
  or keep current. Entry: Plan Options → "What if…".
Verified: Spanish+Business minor → ±0 semesters, −2 cr (6 cr of electives
converted — matches the Recommended box's headroom call); Spanish→CS switch →
+1 semester, 18 newly required / 7 dropped, grad Winter 2030→2031; save-as-new
created "Spanish test + Computer Science" and re-rendered clean.

## Session 21 — AI actions (advisor proposes, one click compares)

advisor_server.py PLAN_PROMPT_ADDON now defines a PROPOSED-ACTIONS protocol:
when (and only when) the answer concretely proposes adding/dropping a
minor/cert, switching majors, or enabling Sp/Su, the model appends one final
line `ACTION_JSON: {"type": ..., "program": ...}` (told NOT to claim exact
semester counts — the comparison computes them). chat.js strips the line from
the shown text (stores stripped text in history so the pattern doesn't echo),
resolves the program name fuzzily against DATA.majors/minors/certs (paren
designations stripped; unmatched → silently no button), and renders a "Try it
— compare adding X" button that calls App.openWhatIf({type, programId}).
User stays in the loop: nothing changes unless they save the alternative.
Live-verified: "Should I add a Business minor?" → answer + button, no JSON
leak → click → compare modal with real numbers. Server restarted.

## Session 21b — grade-distribution feasibility (analysis only, NOT built)

Question: can we get per-course grade distributions for BYU? **No public
source exists.** Public universities (Wisconsin/Madgrades, Indiana, Berkeley,
Missouri, VT, U of U) publish or FOIA-release them; BYU is PRIVATE — no
open-records obligation, no official dataset (Assessment & Planning publishes
only institution-level Common Data Set), no student-built scraper/dataset on
GitHub, no aggregator coverage found. Options if ever wanted: (a) ask BYU
Assessment & Planning for a custom report (manual, uncertain), (b) crowdsource
via a feedback feature, (c) RateMyProfessors difficulty as a weak proxy (TOS +
quality concerns). Recommendation: keep the current curated difficulty
heuristic; revisit only if an official source appears.

## Session 22 — opt-in Spring (no silent constraint changes) + clean print

User feedback: the solver was ADDING Spring terms against their setting.
Cause: solve()'s mapNeedsSpring auto-enable (sheets that schedule Spring
work — Elem Ed practica, Nursing's NURS 404 clinical) silently overrode
allowSpring=false. REMOVED. New behavior: the student's setting is always
respected; Spring-schedulable courses re-sequence into F/W when offered
there (Elem Ed: clean 8-term plan), Spring-ONLY courses surface honestly as
unscheduled + a warn flag ("see Recommended") + state.mapWantsSpring flag.

**Recommended is now actionable** (the pattern: recommend, never do):
each rec can carry an `act` rendered as a one-click button — "Add a Spring
term" (sets allowSpring and/or allowSummer per what the stranded courses
actually need, saves, re-solves), "Compare adding a minor…" (routes to
what-if), "Guarantee full-time status" (sets scholarshipFullTime). New rec
5a2: sheet-uses-Spring-but-plan-resequenced (restore-pacing opt-in). 5a's
filter refined: a course counts as stranded only if ALL its offered seasons
are disabled. Panel renamed "Recommended & opportunities". Verified: Nursing
w/ Spring off → NURS 404 unscheduled + "Add a Spring term" button → one
click → allowSpring true (summer untouched), NURS 404 lands Spring 2029,
unscheduled empty.

**Clean print**: Plan Options → Print/PDF no longer window.print()s the app
shell (which cut off the scrolling board). New printPlan() writes a
dedicated document into a hidden iframe: plan title + programs + MAP-sheet
provenance, stats strip (semesters/credits/completed/graduation), ALL
semesters in a 2-column wrapping grid of clean tables (break-inside:avoid),
▾/📌 legend, key deadlines, top warnings, verify-with-MyMAP footer, then
prints the iframe. Verified: 12/12 terms present incl. Springs, 58 course
rows, deadlines listed. Regression: 175/175 majors, 0 crashes.

## Session 23 — transcript import + source links + prereq-chain visual

**Transcript import (wizard History step):** paste box + PDF upload above the
quick-add chips. `scanTranscript(text)` (exported on App) scans line-by-line
with a course-code regex; DATA.courses membership is the junk filter (UVU
4-digit codes fail the \d{3}\b boundary naturally). Handles BOTH formats:
official transcript preview ("DANCE 484R 001 … 1.00 A", same-line hours+grade)
and new MyMAP ("DANCE 484R - Name" with hours/grade on following lines —
look-ahead ≤6 lines, skipping blanks + the hours line). "Equivalent Course:
CHEM 102" transfer lines count as completed; AP lines carry P grades. Three
buckets: graded/transfer/AP (auto-checked), no-grade-yet (UNchecked — MyMAP
lists FUTURE "projected" semesters; hint says check only what finishes before
the plan starts), withdrawn/failed (never counted). Known-subject unknown
numbers (PHIL 215 — discontinued) surface as a note instead of vanishing.
PDF path: pdf.js 3.11.174 lazy-loaded from cdnjs ONLY when a PDF is chosen;
text rebuilt into visual lines by Y-position (two-column transcripts merge
rows — each code's own hours/grade still lead its row). BUG FOUND+FIXED: the
greedy two-word-subject match ate real codes preceded by another word in
merged columns ("BYU COURSE WORK MATH 110" → "WORK MATH 110" consumed MATH
110) — on a two-word miss the scanner rewinds to the second word. Verified
E2E with Jordan's real transcript PDF via the actual file input: 17/17 graded
(incl. AP MATH 110/112), MSB 430 (current enrollment) in the unchecked group,
PHIL 215 flagged; Add → wizard done-list 19 → generated plan starts at Year 2
standing.

**Source links in AI answers:** advisor_server sources (+forced_context meta)
now carry `url` from Pinecone metadata; chat.js renders "Grounded in" entries
as target=_blank links. Live-verified (academiccalendar.byu.edu, Kennedy
Center program pages). Server restarted.

**Prereq-chain visual (course modal):** `chainHtml()` renders what-unlocks →
THIS → what-it-unlocks against the ACTUAL plan: per prereq group the satisfier
the plan uses (green ✓ completed / term label / red "not planned"; ambiguous
alt-groups show "X (or N more)"), downstream = placed courses listing it as a
prereq (≤5 + count), pure HTML/CSS. Verified: FIN 201 ← ACC 200+ECON 110;
IS 303 ← IS 201 ✓done (from the imported transcript) → IS 401/402/403/415.

## Session 24 — "completed courses don't leave the schedule" investigation

User report: courses a student marks completed stay in the plan. COULD NOT
reproduce at the solver level — verified removal in every path: raw
Solver.solve, fresh wizard, edit-existing-plan (ACC 200 marked done → gone,
plan updated in place), repeatable courses (DANCE 484R/488R), MAP majors (CS,
GSCM), GE-filling courses (BIO 100 → Biological Science slot clears), and the
user's exact Business transcript into a GSCM major (11 completed → 0 on board).
`buildInstances` skips `completed.has(id)`, and Pass-3 prereq closure guards
`completed.has(g)` — completed courses can never become board cards.

Root cause is therefore at INPUT time, not the solver. Most likely real cause:
a recognized course landing in the transcript importer's UNCHECKED "No grade
yet" group. FIX: scanTranscript now uses the official transcript's "CURRENT
ENROLLMENT" boundary — when that header exists, courses BEFORE it are the
completed region, so a real course row (has an hours decimal) whose grade
token didn't parse is still classed completed (grade "—") instead of stranding
unchecked. Courses AFTER the boundary stay in-progress. MyMAP (no boundary)
keeps the grade-lookahead heuristic, so its future/"Projected Hours" semesters
still correctly land unchecked. Verified: grade-miss row recovered (IS 110:—);
MyMAP projected ACC 200/WRTG 150 still unchecked (no regression); full UI E2E
import→generate leaves 0 completed courses on the board; no console errors.
Other plausible user causes noted for the reply: not checking in-progress
courses they've actually finished, or using the board's per-semester "Add a
class" search (which ADDS extras) instead of the History-step completed list.

## Session 25 — polish pass + share-readiness check

Visual QA across the session's feature additions. Found + fixed a real mobile
defect: the topbar had NO small-screen handling (responsive breakpoint only
stacked panels at 1180px), so at ≤400px the "AI Advisor" pill collided with
the wrapping "degree sequence optimizer" tagline. Added `@media (max-width:
640px)`: hide the decorative tagline, tighten topbar padding/gap, widen board
columns to 78vw (one readable semester), pull the chat panel to the edge.
Desktop unaffected (tagline still `block`, topbar 46px one line). Verified
empty state, loaded-demo state, and 3-panel desktop layout all clean; only
console output is the intended dev data-quality warning (thin-data cert in the
demo). `@media print` block kept as the Ctrl+P fallback (the Print button uses
the iframe printPlan()).

SHARE-READINESS (answer to "would a shared link work?"): the whole planner is
static/client-side (solver, board, transcript import incl. CDN pdf.js, what-if,
decision log, prereq chain, timeline/recommended/scholarships/study-abroad from
baked catalog_data.js + timeline_data.js, print) — works for anyone once the
site is DEPLOYED (GitHub Pages: push main). The ONLY backend-dependent piece is
the AI Advisor chat (Flask advisor_server.py :5000 + Pinecone + Anthropic key),
which includes the source-links and AI-action buttons; on a deployed static
site chat.js falls back to the graceful "AI Advisor is offline" card (API
defaults to 127.0.0.1:5000, override via window.MYPLAN_ADVISOR_API). Sharing a
localhost link reaches nobody — must deploy. Nothing committed/pushed yet (per
standing "don't ship until it looks good").

## Session 26 — user-feedback fixes from the live EE plan (pre-persona-sweep)

Jordan used the LIVE site (EE BS + CS minor, 10 semesters/153cr printout) and
filed 10+ issues. Fixed so far, each browser-verified:

1. **CHEM 105 + Req 2.1 double-count** (course pinned Winter Y1 AND a 4-cr
   "CHEM 105 or 111" slot in the tail): MAP-coded courses now join
   `_preRequired` before bucket expansion, so choice buckets count them as
   covered. Plus TWO follow-on fixes the first exposed: (a) coverage is CAPPED
   at the bucket's need — the EE sheet codes PHSCS 121 AND CHEM 105, both sat
   in the 1-course Physical Science GE and burned the double-count budget;
   (b) take() no longer spends the double-count budget on SAME-program key
   pairs (Requirement 1 + ::map are one enrollment) — the 15-cr cap now meters
   only real cross-program sharing.
2. **Pass order** (root of "2 extra semesters of electives + one class"):
   topUpFloor ran BEFORE weaveTail, padding receiver terms to ≥12 and eating
   exactly the headroom the tail needed to fold forward. Now: strip padding →
   compact → closeGaps → enforceMapCaps → weaveTail → closeGaps → topUpFloor.
   EE+CS: 12-cr GE-slot tail term dissolved; padding 24cr→3cr; interior-gap
   closed. Regression: 175/175, 0 crashes, 133 majors at 8 terms, avg 123 cr.
3. **Stability on picks** ("it was re-optimizing still"): solveActive passes
   the previous uid→term assignment on same-plan re-solves; seed places each
   course at its previous term first (when legal), scorePlan charges 9/moved
   course. Explicit Re-optimize / Try-an-alternative / plan switch start
   clean ({fresh:true}).
4. **Lab ↔ lecture pairing** (EC EN 224 Fall / 225 Winter): conservative
   pairing (≤1.5cr + "Lab" name + same subject + adjacent number + real
   lecture in plan) — seeded together + 7/split scorePlan penalty. EC EN
   224+225 now share Fall 2027. Sheet-pinned splits (Biology PHSCS 106/107 —
   the sheet itself splits them) are respected but WARNED on the lab's card.
5. **Slot sizing** ("recommend 2 4-credit classes"): credit buckets pick the
   slot credit that completes the requirement in the FEWEST classes among
   credit sizes with a real choice (≥3 options or ≥25% of pool), tie-broken
   by least overshoot. EC EN Req 3 AND Req 4 ("8 hours"): two 4-cr slots each
   (Req 4 was 3+3+2 because 3 was the mode).
6. **Excessive-credit warnings**: ≥7cr of open electives → tuition-cost warn
   with what-if pointer; >135 total (completed+planned) → over-need warn.
7. **UI**: homepage demo button removed (New plan only); left/right panels
   collapse to 34px rails (persisted, myplanbyu.ui); limited-enrollment
   "Apply to X" chip is now a DROPDOWN listing the admission note + the
   program's pre-admission courses with their terms (Nursing: NDFS 100,
   CHEM 285 ✓).

NEXT (task #47): 10-persona end-to-end sweep — build plan, make bucket picks
like a real user (fills+pins via the UI flow), re-solve repeatedly; hunt
redundant slots, drift, tail bloat, stuck 8-term floors for transfer
students. Fix what surfaces; full report to Jordan afterwards.

## Session 27 — 10-persona sweep: findings + fixes

Simulated 10 students end-to-end IN the app's own flow (generate → pick
bucket classes exactly as openBucketPicker does — fills + manual pins →
re-solve like solveActive, incl. stability). Personas: EE+CSminor fresh (5
picks), Psych+Business AP, Nursing fresh, Accounting ~29cr, Bio+Chem minor,
MechE junior transfer, English+Editing, ExSci sophomore 34cr, CS+Math fresh,
CS senior ~95cr.

FOUND + FIXED during the sweep:
- **compact()'s hard 8-term floor** (`ideal = max(8, cr/15.5)`) — Jordan's
  exact suspicion. Removed (max(1,…)). Fresh 120-cr majors still compute to
  8; transfer/senior plans now compress: ExSci sophomore 7t, MechE junior 5t,
  **CS senior 4t (Winter 2028 grad)**. Only 1 fresh major lands under 8
  (Geography Global Studies 7t/104cr — honest credit math).
- **Moved-pick target selection** (openBucketPicker data-move): was
  nearest-term-with-room-≤18 ANYWHERE — could mint a 9th semester and pin it
  (Psych ARTHC, Bio WRTG 316, MechE AFRIK +25cr explosion). Now: within the
  plan's span at the sheet-aware ceiling (mapCap stretched to 16 on F/W)
  first, then span at hard cap, then beyond (with a heads-up toast).
- **Stability must never COST a semester**: if the prevAssign re-solve ends
  with MORE active terms than before the edit, solveActive re-solves fresh
  and keeps the tighter plan (stability was blocking re-compaction in
  slot-heavy plans — Bio+Chem 8→9 case; now holds 8).

VERDICT after fixes (final state per persona): P1 EE+CS 8t/124cr through all
5 picks, 0 padding (the live-site version of this same flow degraded to
10t/153cr); P5 Bio+Chem 8t held; P6 MechE junior 5t/68cr held; P8 ExSci
sophomore 7t; P9 CS+Math 8t through 5 picks; P10 CS senior 4t. Regression:
175/175, 0 crashes, 138@8t, avg 123cr.

KNOWN LIMITS (documented, deliberate):
- <30 earned credits = freshman standing (offset 0): the full 8-term sheet
  skeleton stays, terms run lighter (Accounting w/ 29cr: 8t/107cr). Standing
  thresholds are BYU's real 30/60/90 bands.
- Slot-heavy majors (English+Editing) can drift to 9t after many picks
  (~13cr avg — loose but honest); placeholder-dominated plans churn more on
  re-solve since slots are interchangeable.
- Pre-existing sheet-vs-catalog concurrent-prereq warnings (ACC 402/405/409
  need ACC 407 the sheet co-schedules) still surface — by design.
- Nursing fresh: 10t/140cr with Spring off (sheet uses Spring; Recommended
  offers the one-click opt-in; NURS 404 honestly unscheduled until then).
- The picker already sinks + labels unmet-prereq options ("needs AFRIK 101
  first") — a student who picks one anyway gets the prereq chain added and
  a pin warning; that's informed choice, not a silent trap.

NOT YET DEPLOYED — awaiting Jordan's review of this batch.

## Session 28 — curated admission requirements + IS-core prereq wall

**Admission requirements (replaces the inferred "have these done" list).**
New `ADMISSION_REQS` dict in generate_timeline.py — transcribed from each
program's OWN admission page (web-researched 2026-07-22), keyed by RUNTIME id
(catalog "major-<slug>" + hand-curated "is-bs"/"is-bs-mism"). Baked to
`TIMELINE.admissionReqs`. 7 curated: Nursing, IS (both tracks), Dietetics,
Elementary Education, Accounting, Finance — each with exact `prereqs`,
`criteria` (GPA/grades/deadline/experience), and the source `url`. The
apply-chip dropdown now: curated → prereqs with ✓ (completed OR planned before
the apply term) + criteria + "Full admission requirements" link; no curated
entry → the catalog note + "confirm with the department" pointer (NOT a
guessed course list). Curated-but-ungated majors (IS, Accounting) now get an
apply chip too, attached to the F/W term before their first ≥300 major course.
planSummary() feeds the curated reqs to the AI. Verified: Nursing shows
Jordan's exact list (CHEM 285✓, NDFS 100✓, CELL 220/210, SFL 210/PSYCH 220 +
16 core hrs); MISM shows the IS criteria (3.0 prereq GPA, B-min in IS 201/303);
Advertising (uncurated) shows the note+pointer. 175/175 solve, 0 crashes.

**IS-core "missing a whole bunch of prerequisites".** Root cause: a bucket
picker for a requirement with an upper-level-heavy pool (Languages of Learning
53/60, any 400-level elective slot placed early) rendered EVERY option's
"needs X first" as a flat wall. Fix: split options into ready vs
needs-prerequisite; the needs ones collapse behind a `<details>` "N more need
a prerequisite you haven't planned yet" toggle (Languages now shows 7 clean +
50 tucked). Also fixed a chain-visual false alarm: HRM 391→HRM 401 (sheet
places the course without the prereq — AP/transfer assumed) now shows grey
"assumed met" instead of red "not planned", matching the solver's stance.

Deployed to GitHub Pages with the Session 26–27 tweaks (double-count slot fix,
pass-order tail integration, pick stability + never-grow, lab pairing, slot
sizing, credit warnings, no-8-term-floor, collapsible panels, no-demo home).

## Session 29 — prereq accuracy + full scraper audit (Jordan: "scrapers are
## the most important part")

**FIN 201/ECON 110 (the named bug).** Verified live: FIN 201 has NO enforced
prereqs (ACC 200 is "Recommended" only). Root cause: data.js's merge used
hand-entered `pre` as a FALLBACK whenever the scrape had none — but the
scrape's absence is authoritative. Audited all 31 hand-`pre` courses: 26
conflicted with the current catalog, incl. the whole 2024-era IS-core chain
(the 2026 catalog resequenced it: IS 404 now requires IS 414 — hand had the
REVERSE). Fix: merged courses use ONLY scraped p/pc; hand `pre` survives only
for hand-only courses (SPAN 339 etc.); FIN 201's hand line now carries just
preText "Recommended: ACC 200." (add() learned preText). MISM demo: 0 prereq
warnings, cohorts intact, envelope still overrides the catalog's intra-core
ordering.

**Requisite parser: 390 courses were silently unenforced.** Coursedog stores
structured requisites under BOTH `requisites` AND `prerequisites` (BIO/ANES/
ACC-440 style uses the latter with nested anyOf→subRules→completedAllOf).
course_prereq_groups read only the first field and only flat rules. New
recursive `_rule_prereq_groups` walks both fields + nesting; anyOf of
singleton branches → one OR-group (exact); OR-of-ANDs (unrepresentable in
CNF) deliberately stays text-only. Result: 2,805 courses with enforced chains
(+~800); remaining 108 "text-only" cases are all soft escapes ("or
equivalent", "instructor's consent") — correctly unenforced. Spot checks:
BIO 220 [[CELL 120|BIO 130|MMBIO 121]], ANES 310 [[HIST 238|239]], ANTHR 499
5-way OR; FIN 201 still clean.

**analyze() aligned with sheet doctrine.** New chains exposed sheet-pinned
courses whose prereqs are ENTIRELY absent (Music's per-instrument ladders,
Dietetics "Chem 101 or equivalent") — those now get a calm info note ("the
department assumes it's covered"), matching canPlace/seed-4b/the chain
visual. Warn only when the prereq is PRESENT but late. Census: 140 warns in
83 majors → 46 in 31 (all genuine, e.g. ACC core co-scheduling).

**All 12 scrapers run live, clean** (2026-07-22): academic_dates 8,
tuition_graduation 5, research_grants 3 (1 thin page correctly skipped),
marriott_business 9, language_certs 21, transfer_credit 41, policies 23 (±2
churn upstream), clubs 373 (-1 upstream), kennedy/study_abroad 131 (+1 new),
flowcharts 28, catalog full re-pull + maps via refresh_maps.ps1 (6 min,
completed OK; incremental PDF cache worked — no sheet re-downloads).
Validation harness (scratchpad/validate_scrapes.py): counts stable, 0
replacement chars (earlier "�" was cp1252 console rendering, data is clean
UTF-8), catalog "dup ids" = multi-catalog-year entries (handled by
dedup_latest). MAP parse audit: 180/194 sheets full-fidelity (14 known
interleaved-column fallbacks), ALL real terms within 3.5cr of printed totals
(flagged rows were inert y=None residue blocks the app never binds).
NOTE: refresh_maps.log couldn't append while my tail -f monitor held it
(Windows file lock) — harmless, but don't tail the log during a run.

Post-refresh: 175/175 solve, 0 crashes, 138@8t. generate_timeline re-run
(admissionReqs preserved, 107 college-tagged study abroad). Advisor synced:
targeted re-embed of study_abroad/clubs/policies/academic_dates/
transfer_credit (576 vectors, index 8365) + server restart. NOT yet pushed —
awaiting Jordan's go.

## Pipeline map (who produces what)

- `sources/*.py` → `data/*.json` raw scrapes (`catalog.json`, `maps.json` +
  `maps_plans.json`, `flowcharts.json`, ...)
- `extract_flowchart_plans.py` → `data/flowchart_plans.json` (LLM reads the
  2-D grids; cached per sheet URL)
- `generate_data.py` → `js/catalog_data.js` (courses + programs + baked
  flowchart/MAP hints/cohorts/gates)
- `js/data.js` — hand-curated demo layer (IS/MISM etc.)
- `js/solver.js` — consumes `flowchartPlan` {y,s,f} hints, `flowchartCohorts`,
  `admit` gates

## Open items

- Full cohort-block treatment for Nursing/Elem Ed professional sequences
  (currently: gate + hard year minimums; envelopes need MAP term-grouping)
- Re-scrape transitioned curricula (Elem Ed → ECSE/FDTN)
- Fill the flagged "Complete N > options" data gaps (health report lists them)
- Family Life: Human Development (BS) — near-empty requirement data
- Advisor hosting (advisor works locally; `window.MYPLAN_ADVISOR_API` is the
  one-line switch when hosted)
