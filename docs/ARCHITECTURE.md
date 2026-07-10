# myplanBYU — Architecture

A multi-objective degree-sequencing optimizer for BYU students. Unlike a static
checklist planner, it treats a degree as a **constrained set-cover + sequencing
problem**: pick which courses fill which requirements, then order them across
semesters around hard rules and user-weighted priorities.

## Stack decision

| | V1 (shipped) | V2 (reference) |
|---|---|---|
| Frontend | Vanilla HTML/CSS/JS, MyMAP-style UI | React/Next.js |
| Solver | `js/solver.js` — greedy seed + hill-climbing, in-browser | Python + OR-Tools CP-SAT (`docs/solver_reference.py`) |
| Data | `js/data.js` — manually curated snapshot | Postgres + catalog ingestion |
| Deploy | Static (GitHub Pages, with the portfolio) | Vercel + Python API host |

V1 is client-side on purpose: the problem size (~60 course instances × ~24
terms) solves in 10–50 ms in the browser, dial changes re-optimize instantly,
and a static site deploys with the rest of the portfolio. The CP-SAT reference
shows the exact same model solved *optimally* for when scale demands it.

## Data model (flexible placeholder architecture)

- **Course** — `id, credits, tags[], prerequisites (AND of OR-groups), offered
  seasons, difficulty (1-10), load factor (real time cost), demand, rare,
  test-out note, repeatMax` (repeatable R-courses expand into sequenced
  instances `DANCE 484R#1..#3`).
- **Requirement Bucket** — `pick: all | N credits | N courses`, filled from
  explicit options ∪ tag matches. Optional `block` (cohort), `perCourseMax`.
- **Program** — major / minor / cert / university-core = list of buckets.
  Programs without hand-entered data **generate deterministic placeholder
  chains** (intro → core → advanced, with a critical-path spine and one
  rarely-offered course), so all 170+ catalog programs are plannable now and
  refinable later without touching code.
- **Profile** — programs (1 major, ≤2 minors, any certs), completed courses,
  start term, pins, housing contract, scholarship flag, credit caps, dials.

**Double-counting**: a course may fill buckets in multiple programs
(`DANCE 260` = Arts GE + Ballroom theory; `SPAN 320` = Spanish cert + Global
Business language). Shared credits are tracked against a global cap
(default 15) during bucket cover.

## Solver pipeline (`js/solver.js`)

1. **expand** — bucket cover: mandatory buckets take all options; choose-type
   buckets rank options by (already completed → double-count synergy → lower
   difficulty → not rare), respecting the double-count cap; prerequisite
   closure pulls in unmet prereqs; electives pad to 120 UG credits (+24 grad
   for the integrated MISM track).
2. **seed** — hard-constraints-only construction: cohort blocks placed as
   atomic units in dependency order (IS Junior Core Fall → Winter → MISM Fall
   → Winter), pins placed exactly (e.g. IS 303 → Winter 2027), remaining
   courses greedy by critical-path depth, then electives lift Fall/Winter
   terms to the full-time floor.
3. **improve** — ~1,600 iterations of seeded hill-climbing: random legal move
   (respecting prereqs, seasons, caps, dependents) kept iff the weighted
   objective improves. Deterministic per profile; "Try an alternative"
   reseeds.
4. **analyze** — flags + progress-report data.

### Objective = Σ (dial/5) × component

- **speed** — makespan + number of enrolled terms.
- **cost** — part-time Fall/Winter terms waste the flat 12–18cr tuition band;
  Spring/Summer credits cost extra tuition *unless* a 12-month lease already
  covers housing (weight drops ~75%); later graduation costs more.
- **risk** — quadratic penalty for stacking 3+ difficulty≥7 courses per term.
- **load** — stdev of credits×load-factor across Fall/Winter terms (a
  1-credit technique class ≠ 1 credit of real time).
- **life** — near-cap terms, 3+ consecutive heavy semesters, religion-pacing
  gaps.

### Hard constraints (never traded)

Prerequisite chains & repeat sequencing · season availability · per-term caps
· cohort blocks · pins · enabled terms only. Full-time minimums and religion
pacing are enforced via padding + heavy penalty and honestly flagged when
violated rather than silently "fixed".

### Informational flags

Bottleneck (high-demand course × late registration window, proxied by earned
credits) · single point of failure (rarely offered on the critical path) ·
AP/CLEP/test-out suggestions · finals-collision (3+ hard courses) ·
scholarship part-time warnings · lease-utilization hint · cohort lock and
MISM application gate notices · anything the solver could not schedule.

## V2 roadmap

Section-level data (times, professors, seats) → real time-conflict
constraints, MWF/TTh and chronotype preferences, cross-campus travel times;
registration-priority simulation per term; probabilistic offering risk;
transfer credit; catalog ingestion pipeline replacing the manual snapshot.
