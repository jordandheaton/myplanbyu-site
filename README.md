# myplanBYU

A MyMAP-inspired **degree sequence optimizer** for BYU students, live at
**[myplan.jordanheaton.com](https://myplan.jordanheaton.com)**. Pick any of
170+ majors, up to two minors, and certificates — an in-browser constraint
solver builds an optimized semester-by-semester plan around prerequisites,
cohort blocks, Fall/Winter-only offerings, credit caps, pinned courses, and
five user-weighted priorities (speed, cost, GPA protection, workload, life).

**Run it:** open `index.html` (no build, no server, no dependencies), then
build a plan in the wizard: pick a major, add any minors and certificates,
enter completed coursework, and say when you want to be done.

## What's where

| Path | What it is |
|---|---|
| `index.html`, `css/`, `js/` | The site. `js/solver.js` (bucket cover → greedy seed → weighted hill-climbing → flags), `js/app.js` (MyMAP-style UI), `js/*_data.js` (generated data) |
| `scraper/` | The data pipeline: BYU sources → generated `js/*_data.js`, behind a sanity gate. See [`scraper/REFRESH.md`](scraper/REFRESH.md) |
| `worker/` | The Cloudflare Worker behind the AI advisor, live seat counts, and feedback. See [`worker/README.md`](worker/README.md) |
| `tests/` | Solver regression harness (runs in the browser or headless Edge). See [`tests/README.md`](tests/README.md) |
| `docs/` | `ARCHITECTURE.md` (design write-up), `TUNING.md`, `solver_reference.py` (OR-Tools CP-SAT reference model) |
| `build_site.py` | Assembles the deployable site into `_site/` with cache-busting stamps |
| `.github/workflows/` | `deploy.yml` (Pages), `refresh.yml` (weekly data refresh), `byu-host-probe.yml` (diagnostic) |

## How it stays current

- **Weekly**, on GitHub Actions: catalog, academic dates (BYU API), MAP sheets,
  class schedule → gate → commit → deploy. No PC involved.
- **Monthly**, on Jordan's PC: the slow sources (study abroad, tuition, transfer
  guides, language certificates, flowcharts…) whose BYU sites block GitHub's
  servers, plus the Pinecone re-embed for the advisor.

Secrets never live in the repo: `scraper/.env` locally (gitignored), GitHub
Actions secrets (`BYU_CLIENT_ID` / `BYU_CLIENT_SECRET`), and Cloudflare Worker
secrets.

## History

Split out of Jordan's portfolio repo (`jordandheaton.github.io`, where it lived
under `myplanBYU/`) on 2026-10-24, with full history. Before that, this repo was
a deploy-only mirror for the subdomain; that history is tagged `mirror-archive`.
The old copy at jordanheaton.com/myplanBYU is frozen.

Independent student project — not affiliated with or endorsed by BYU. Course
data is an illustrative snapshot; verify everything with official MyMAP and an
advisor.
