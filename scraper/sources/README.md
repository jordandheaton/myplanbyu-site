# Data sources

Each file here scrapes **one** BYU source and writes a JSON file into `../data/`.
`../embed_and_load.py` (the ingest step) reads all of them, embeds them locally,
and upserts into the same Pinecone index — every record tagged with a `source`
so the advisor can mix and cite them.

## Sources

| Script | Source | What it pulls | Output | Refresh |
|---|---|---|---|---|
| `catalog.py` | Coursedog catalog (`catalog.byu.edu`) | All courses + program requirements | `data/catalog.json` | each semester |
| `marriott_business.py` | `marriott.byu.edu/mba/academics/minors-certificates` | Business emphases / minors / certificates (incl. **Global Business Certificate**) + track-sheet PDFs | `data/marriott_business.json` | yearly |
| `language_certs.py` | `cls.byu.edu/programs/certificate/courseoptions` | 21 language certificates (Language / Civilization / Literature course options) | `data/language_certs.json` | yearly |
| `kennedy_scraper.py` | `kennedy.byu.edu/find-your-program` | All 130 Kennedy Center ISP programs (study abroad, internships, direct enrollment): locations, term, cost, courses, deadlines | `data/study_abroad.json` | each semester |
| `policy_scraper.py` | `enrollment.byu.edu` + `marriott.byu.edu/financialaid` + `experience.byu.edu` + `careers.byu.edu` | University & Marriott scholarship rules/deadlines (`type=scholarship`), internship & experiential-learning policies (`type=policy`) | `data/policies.json` | each semester (deadlines change every term) |
| `academic_dates.py` | `academiccalendar.byu.edu` + registrar pages | Per-term add/drop & withdraw deadlines, registration dates, dropping/deferring rules (`type=deadline`) | `data/academic_dates.json` | each semester |
| `research_grants.py` | per-college grant pages (HUM Grants, Economics ELG, CFAC) | Undergraduate mentored-research funding (`type=opportunity`); curated PAGES list — add colleges as found | `data/research_grants.json` | yearly |
| `clubs.py` | `clubs.byu.edu` (Mendix app — no static HTML) | All ~374 student clubs w/ meeting times (`type=club`), via the Mendix /xas/ protocol; see MAINTENANCE NOTE in the file if it breaks | `data/clubs.json` | each semester |
| `transfer_credit.py` | `enrollment.byu.edu` AP/IB + transfer-guide hubs | AP & IB exam equivalency tables (2020–2027, PDFs), 29 feeder-school transfer guides (PDFs), associate-degree GE waiver rules (`type=transfer_credit`) | `data/transfer_credit.json` | yearly (new AP guide each spring) |
| `tuition_graduation.py` | `enrollment.byu.edu` tuition + graduation pages | Tuition & fee rates, cost of attendance (`type=policy`); graduation application deadlines per cycle, how-to-apply, cum laude rules (`type=deadline`) | `data/tuition_graduation.json` | each semester |
| `flowcharts.py` | department hub pages (all 8 Marriott business programs + 5 Fulton engineering) | Official major flowchart PDFs — the recommended semester-by-semester sequence, junior-core envelopes, lecture-series choices (`type=flowchart`); hub-crawled so year rollovers self-heal; add a CONFIG entry per new department | `data/flowcharts.json` | yearly |
| `maps.py` | coursedog `majorAcademicPlan` file refs (via the catalog's signedUrl endpoint) | Official **MAP sheets** — the college advisement centers' 8-semester plans, published for ~123 majors (`type=map_sheet`). Parsed DETERMINISTICALLY (regex, no LLM) into `data/maps_plans.json` for solver sequencing hints | `data/maps.json` + `data/maps_plans.json` | yearly |

**Sequencing → solver pipeline**: three layers merge in
`generate_data.attach_flowchart_plans`, weakest → strongest:
1. **MAP sheets** (`sources/maps.py`, ~123 majors) — per-course year+season
   hints only (a MAP's specific electives are examples, never force-included);
2. **department flowcharts** (`flowcharts.py` → `extract_flowchart_plans.py`,
   Claude at temperature 0, newest sheet per program) — hints **plus**
   force-included courses (business core) and RIGID junior-core envelopes;
3. **hand-verified overrides** (`data/flowchart_overrides.json`) — corrections
   for charts whose PDF text scrambles too badly (e.g. Accounting envelopes).
Level-pacing is the fallback where no layer covers a course. Full refresh:
`flowcharts.py` → `extract_flowchart_plans.py` → `sources/maps.py` →
`generate_data.py` → `embed_and_load.py --only-sources flowcharts,maps`.

Course offering patterns ("Fall and Winter", "Winter Even Years", ...) come
from the catalog itself: every course's `_raw_summary.courseTypicallyOffered`
is baked into its embedded text by `embed_and_load.py` ("Typically offered:").

**True per-semester section history is auth-walled.** Coursedog's
`/api/v1/byu/sections/{year}/{semester}` returns 401 and BYU disabled the
catalog-side sections view (403). Real empirical schedules would need a BYU
api.byu.edu (WSO2) subscription key — a future upgrade, not scriptable
anonymously.

Planned: `public_health_certs.py`. (McKay Education grants page is
JS-rendered — skipped by `research_grants.py` until they publish static HTML.)

Note: Kennedy's server rate-limits bursts with 403s — `kennedy_scraper.py`
paces itself (0.7 s between pages) and retries, so a full run takes ~3 min.

## Output format

`catalog.py` writes a structured object (`{meta, programs, courses}`) — ingest
special-cases it. **Every other source** writes a plain JSON **list of
documents**, and ingest handles them generically:

```json
[
  {
    "id":     "marriott_business::global-business-certificate",
    "source": "marriott_business",
    "type":   "certificate",
    "name":   "Global Business Certificate",
    "url":    "https://marriott.byu.edu/...",
    "text":   "readable description + any PDF track-sheet text"
  }
]
```

Rules for a new source:
- `id` must be globally unique — prefix it with the source name (`source::slug`).
- Put everything the advisor should read into `text` (that's what gets embedded).
- Keep `text` well under ~35 KB (Pinecone caps metadata at 40 KB/vector).
- HTML pages → `beautifulsoup4`; linked PDFs → `pypdf` (see `marriott_business.py`).

## Running

```powershell
# from the scraper/ folder, using the venv Python
.\.venv\Scripts\python.exe sources\catalog.py            # refresh the catalog
.\.venv\Scripts\python.exe sources\marriott_business.py  # refresh Marriott
.\.venv\Scripts\python.exe embed_and_load.py             # embed everything -> Pinecone
```

The scheduled job just runs the source scripts on their cadence, then
`embed_and_load.py`. Upserts overwrite by ID, so re-running refreshes cleanly.
