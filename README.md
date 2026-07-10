# myplanBYU

A MyMAP-inspired **degree sequence optimizer** for BYU students. Pick any of
170+ majors, up to two minors, and certificates — an in-browser constraint
solver builds an optimized semester-by-semester plan around prerequisites,
cohort blocks, Fall/Winter-only offerings, credit caps, pinned courses, and
five user-weighted priorities (speed, cost, GPA protection, workload, life).

**Run it:** open `index.html` (no build, no server, no dependencies).
Click *"Load the demo"* for the seeded test case: Information Systems BS +
integrated MISM, Ballroom Dance minor, Spanish + Global Business certificates,
IS 303 pinned to Winter 2027, 12-month off-campus lease.

- `js/data.js` — curated course/program snapshot (placeholder-bucket architecture)
- `js/solver.js` — bucket cover → greedy seed → weighted hill-climbing → flags
- `js/app.js` / `css/styles.css` — MyMAP-style UI (board, progress report, plans, wizard)
- `docs/ARCHITECTURE.md` — full design write-up
- `docs/solver_reference.py` — OR-Tools CP-SAT reference model for a V2 backend

Independent student project — not affiliated with BYU. Course data is an
illustrative snapshot; verify everything with official MyMAP and an advisor.
