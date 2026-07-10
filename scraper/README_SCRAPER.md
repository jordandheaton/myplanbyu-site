# myplanBYU Catalog Scraper

Pulls BYU's undergraduate **programs** (majors / minors / certificates), their
**degree requirements**, and the **master course list** straight from the
Coursedog JSON API that powers <https://catalog.byu.edu>, and writes them to
`data/catalog.json`.

No Selenium, no HTML parsing — just `requests` against Coursedog's backend.

---

## Quick start

```bash
cd "Portfolio/myplanBYU/scraper"
python -m venv .venv
# Windows PowerShell:
.\.venv\Scripts\Activate.ps1
# (macOS/Linux: source .venv/bin/activate)

pip install -r requirements.txt
python scraper.py
```

Output lands in `scraper/data/catalog.json`.

---

## ⚠️ Before your first run: confirm two values

Coursedog uses one uniform API across every school. The URL shape is always:

```
https://app.coursedog.com/api/v1/cm/<SCHOOL_ID>/<entity>/search/$filters?catalogId=<CATALOG_ID>&...
```

The script ships with best guesses (`SCHOOL_ID = "byu"`, auto-discovered
`CATALOG_ID`), but **you must verify BYU's real values** — Coursedog tenant ids
are not always the obvious short name. Here's exactly how to find them.

### Step-by-step: find the endpoint in Chrome DevTools

1. Open **<https://catalog.byu.edu>** in Chrome.
2. Press **F12** (or right-click → *Inspect*) to open DevTools.
3. Click the **Network** tab.
4. In the Network toolbar, click **Fetch/XHR** to filter out images/CSS/JS.
5. Check **Preserve log** (so requests survive page navigation).
6. Now **navigate the catalog** the way a student would:
   - Click into the **Programs** / **Majors** list.
   - Open a single program (e.g. *Information Systems, BS*) to load its
     requirements.
   - Open the **Courses** browser.
7. Watch the Network list. You're looking for requests to
   **`app.coursedog.com`**. The important ones look like:

   | What loads | Request URL (pattern) |
   |---|---|
   | Program list | `…/api/v1/cm/<SCHOOL_ID>/programs/search/$filters?catalogId=<CATALOG_ID>&skip=0&limit=…` |
   | One program's rules | `…/api/v1/cm/<SCHOOL_ID>/programs/<programId>?catalogId=<CATALOG_ID>` |
   | Course list | `…/api/v1/cm/<SCHOOL_ID>/courses/search/$filters?catalogId=<CATALOG_ID>&…` |
   | Catalog list | `…/api/v1/cm/<SCHOOL_ID>/catalogs` |

8. **Click one of those requests**, then:
   - **Headers** tab → copy the full **Request URL**. The path segment right
     after `/cm/` is your **`SCHOOL_ID`**; the `catalogId` query param is your
     **`CATALOG_ID`**.
   - **Response** (or **Preview**) tab → confirm it's clean JSON with the fields
     you expect (`name`, `code`, `credits`, `requirements`/`rules`, etc.).
9. **Right-click the request → Copy → Copy as cURL** if you want to replay it in
   a terminal or paste it to me for tuning.

> Tip: `catalog.byu.edu` may itself be a thin proxy. If you *don't* see
> `app.coursedog.com` calls, look for same-origin `catalog.byu.edu/api/…`
> requests instead and set `API_HOST = "https://catalog.byu.edu"` in
> `scraper.py`. The path after `/api/v1/cm/…` is usually identical.

### Then edit the config block at the top of `scraper.py`

```python
SCHOOL_ID  = "byu"          # <- the segment after /cm/ in the real URL
CATALOG_ID = None           # <- paste the catalogId string, or leave None to auto-discover
API_HOST   = "https://app.coursedog.com"
```

---

## What the script does

1. **Discovers the current catalog** via `…/catalogs` (skipped if you hard-code
   `CATALOG_ID`).
2. **Fetches all courses**, paging through `courses/search/$filters`
   (`skip`/`limit`), and normalizes each to
   `course_id`, `code`, `credit_hours`, `prerequisites`, …
3. **Fetches all programs**, filters to undergraduate majors/minors/
   certificates, then for **each program** pulls its full requirement rules
   (the "choose 3 of these 5" conditional logic lives in the `requirements` /
   `rules` block).
4. **Writes `data/catalog.json`** with a `meta` header plus `programs` and
   `courses` arrays. Each record keeps a `_raw_summary` of the original payload
   so nothing is lost for your RAG layer.

### Robustness built in
- Session-level **retry/backoff** on 429/5xx (`urllib3.Retry`).
- Every HTTP call is wrapped — a bad endpoint returns `None`, it doesn't crash.
- **Per-program `try/except`**: one malformed program is logged and skipped, the
  run continues.
- Handles Coursedog's inconsistent payload shapes (bare list vs `{"data": …}`
  vs id-keyed dict) via `as_records()`.
- Pagination safety valve so a misbehaving API can't loop forever.
- Polite `SLEEP_BETWEEN_CALLS` throttle + descriptive `User-Agent`.

---

## Tuning after the first run

The normalizers (`normalize_program`, `normalize_course`) guess at field names
because they vary slightly per tenant. After your first `catalog.json`:

1. Open it and look at a `_raw_summary` block.
2. If a field you want is empty (e.g. `credit_hours` is `null`), find its real
   key in `_raw_summary` and add it to the corresponding `normalize_*` function.
3. Tighten `is_undergrad_program()` once you see BYU's actual `type` /
   `degreeDesignation` values — right now it errs toward keeping everything.

---

## Notes / etiquette

- This hits a public, read-only catalog API for a personal educational project.
  Keep `SLEEP_BETWEEN_CALLS` non-zero and don't parallelize aggressively.
- If Coursedog ever requires an auth header, you'll see a `401`/`403` in the
  Network tab; copy the `Authorization` header from a real request into
  `session.headers` in `build_session()`.
- Re-run periodically to refresh; the `meta.scraped_at` timestamp records when.
```
