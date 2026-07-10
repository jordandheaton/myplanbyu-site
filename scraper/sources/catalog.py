#!/usr/bin/env python3
"""
myplanBYU catalog scraper
=========================

Pulls undergraduate programs (majors / minors / certificates), their degree
requirements, and the master course list from BYU's Coursedog-backed catalog
(https://catalog.byu.edu) by talking directly to the Coursedog JSON API instead
of scraping HTML.

Output: data/catalog.json

Coursedog exposes a fairly uniform public REST API for every school that runs on
it. The two values you MUST confirm for BYU before running this are SCHOOL_ID and
CATALOG_ID (see README_SCRAPER.md -> "Finding the API endpoint"). Everything else
below follows Coursedog's standard URL shape.

Author: Jordan Heaton
"""

from __future__ import annotations

import json
import logging
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import requests
from requests.adapters import HTTPAdapter

try:
    # urllib3 ships with requests; import path is stable across recent versions
    from urllib3.util.retry import Retry
except ImportError:  # pragma: no cover - very old urllib3
    from requests.packages.urllib3.util.retry import Retry  # type: ignore


# ---------------------------------------------------------------------------
# Configuration  --  EDIT THESE TWO VALUES FOR BYU (see README_SCRAPER.md)
# ---------------------------------------------------------------------------

# The Coursedog tenant/school id. For BYU this appears in the request URL your
# browser makes on catalog.byu.edu, e.g. .../api/v1/cm/<SCHOOL_ID>/... .
# Confirm it via the Chrome Network tab before trusting it.
SCHOOL_ID: str = "byu"

# The specific catalog snapshot id (Coursedog keeps one per academic year).
# Also visible as the `catalogId` query param in the Network tab. Leave as None
# to let the script auto-discover the newest catalog via the /catalogs endpoint.
CATALOG_ID: Optional[str] = "HnfDzpVHnQ1aSVFes2j0"

# Coursedog API host. This is the same for every Coursedog school.
API_HOST: str = "https://app.coursedog.com"

# Which program types we care about. Coursedog labels these on each program
# record; we keep the filter loose and normalize below.
UNDERGRAD_KEYWORDS = ("major", "minor", "certificate", "bachelor", "emphasis")

# Networking politeness / robustness
PAGE_SIZE = 100          # records per paginated request
REQUEST_TIMEOUT = 30     # seconds per HTTP call
SLEEP_BETWEEN_CALLS = 0.25  # be a good citizen; don't hammer the API

# Output location: ../data/catalog.json (this script now lives in sources/)
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "catalog.json"


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("byu-scraper")


# ---------------------------------------------------------------------------
# HTTP session with retries
# ---------------------------------------------------------------------------

def build_session() -> requests.Session:
    """A requests.Session with automatic retry/backoff on transient errors."""
    session = requests.Session()
    retry = Retry(
        total=5,
        connect=5,
        read=5,
        backoff_factor=1.5,             # 0s, 1.5s, 3s, 6s, 12s ...
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET", "POST"),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update(
        {
            # A browser-ish UA keeps some CDNs happy; nothing sneaky.
            "User-Agent": (
                "myplanBYU-scraper/1.0 (+educational; contact jordandheaton@gmail.com)"
            ),
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://catalog.byu.edu",
            "Referer": "https://catalog.byu.edu/",
        }
    )
    return session


def get_json(
    session: requests.Session,
    url: str,
    params: Optional[Dict[str, Any]] = None,
) -> Optional[Any]:
    """GET a URL and return parsed JSON, or None on any failure.

    Never raises: callers stay simple and one bad endpoint won't kill the run.
    """
    try:
        resp = session.get(url, params=params, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        log.error("Request failed for %s : %s", url, exc)
        return None

    if resp.status_code != 200:
        log.warning("HTTP %s for %s", resp.status_code, resp.url)
        return None

    try:
        return resp.json()
    except ValueError:
        log.warning("Non-JSON response for %s", resp.url)
        return None
    finally:
        time.sleep(SLEEP_BETWEEN_CALLS)


# ---------------------------------------------------------------------------
# Response-shape helpers
# ---------------------------------------------------------------------------
# Coursedog is not perfectly consistent across endpoints/versions. Sometimes the
# payload is a bare list, sometimes {"data": [...]}, sometimes {"programs":{...}}
# keyed by id. These helpers absorb that variation so the rest of the code is
# clean.

def as_records(payload: Any) -> List[Dict[str, Any]]:
    """Coerce a Coursedog list-ish payload into a list of dict records."""
    if payload is None:
        return []
    if isinstance(payload, list):
        return [r for r in payload if isinstance(r, dict)]
    if isinstance(payload, dict):
        for key in ("data", "programs", "courses", "results", "items"):
            if key in payload:
                inner = payload[key]
                if isinstance(inner, list):
                    return [r for r in inner if isinstance(r, dict)]
                if isinstance(inner, dict):
                    # dict keyed by id -> take the values
                    return [v for v in inner.values() if isinstance(v, dict)]
        # A single record?
        if payload:
            return [payload]
    return []


# ---------------------------------------------------------------------------
# Catalog discovery
# ---------------------------------------------------------------------------

def discover_catalog_id(session: requests.Session) -> Optional[str]:
    """Find the newest catalog id if the user didn't hard-code one."""
    if CATALOG_ID:
        return CATALOG_ID

    url = f"{API_HOST}/api/v1/cm/{SCHOOL_ID}/catalogs"
    catalogs = as_records(get_json(session, url))
    if not catalogs:
        log.warning(
            "Could not auto-discover a catalogId. Set CATALOG_ID manually "
            "(see README_SCRAPER.md)."
        )
        return None

    # Prefer the one flagged current/published, else the highest year.
    def sort_key(c: Dict[str, Any]):
        return (
            bool(c.get("current") or c.get("isCurrent") or c.get("published")),
            str(c.get("effectiveStartDate") or c.get("name") or ""),
        )

    best = sorted(catalogs, key=sort_key, reverse=True)[0]
    cid = best.get("id") or best.get("_id") or best.get("catalogId")
    log.info("Auto-selected catalogId=%s (%s)", cid, best.get("name"))
    return cid


# ---------------------------------------------------------------------------
# Paginated fetch of a Coursedog "search/$filters" endpoint
# ---------------------------------------------------------------------------

def fetch_paginated(
    session: requests.Session,
    entity: str,               # "programs" or "courses"
    catalog_id: Optional[str],
) -> List[Dict[str, Any]]:
    """Walk every page of a Coursedog search endpoint and return all records."""
    url = f"{API_HOST}/api/v1/cm/{SCHOOL_ID}/{entity}/search/$filters"
    all_records: List[Dict[str, Any]] = []
    skip = 0

    while True:
        params = {
            "skip": skip,
            "limit": PAGE_SIZE,
            "orderBy": "code",
            "formatDependents": "false",
        }
        if catalog_id:
            params["catalogId"] = catalog_id

        payload = get_json(session, url, params=params)
        records = as_records(payload)

        if not records:
            break

        all_records.extend(records)
        log.info("  %s: fetched %d (total %d)", entity, len(records), len(all_records))

        if len(records) < PAGE_SIZE:
            break
        skip += PAGE_SIZE

        # Safety valve so a misbehaving API can't loop forever.
        if skip > 50_000:
            log.warning("  %s: pagination safety limit hit, stopping.", entity)
            break

    return all_records


# ---------------------------------------------------------------------------
# Program detail fetch + normalization
# ---------------------------------------------------------------------------

def fetch_program_details(
    session: requests.Session,
    program_id: str,
    catalog_id: Optional[str],
) -> Optional[Dict[str, Any]]:
    """Fetch the full requirement blocks (rules) for a single program."""
    url = f"{API_HOST}/api/v1/cm/{SCHOOL_ID}/programs/{program_id}"
    params = {"catalogId": catalog_id} if catalog_id else None
    payload = get_json(session, url, params=params)
    if payload is None:
        return None
    # Some tenants wrap the single record; unwrap if needed.
    if isinstance(payload, dict) and "data" in payload and isinstance(payload["data"], dict):
        return payload["data"]
    return payload if isinstance(payload, dict) else None


def is_undergrad_program(record: Dict[str, Any]) -> bool:
    """Best-effort filter for undergraduate majors/minors/certificates."""
    haystack = " ".join(
        str(record.get(k, "")).lower()
        for k in ("degreeDesignation", "type", "programType", "name", "career", "level")
    )
    if "graduate" in haystack and "undergraduate" not in haystack:
        return False
    return any(kw in haystack for kw in UNDERGRAD_KEYWORDS) or True
    # NOTE: we default to True so nothing is silently dropped; tighten this
    # once you've inspected the real BYU field values in catalog.json.


def _collect_strings(obj: Any, out: set) -> None:
    """Recursively gather every string value inside a nested dict/list."""
    if isinstance(obj, str):
        out.add(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            _collect_strings(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _collect_strings(v, out)


def normalize_program(
    raw: Dict[str, Any],
    details: Optional[Dict[str, Any]],
    course_index: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Flatten a program into the shape myplanBYU's optimizer will consume."""
    detail = details or {}
    course_index = course_index or {}

    # On BYU's Coursedog tenant the "choose N of these" conditional logic lives
    # under requisites.requisitesSimple[].rules[] -- surface it as a clean,
    # first-class `requirements` field so the optimizer needn't dig into _raw.
    requisites = detail.get("requisites") or {}
    requirements = (
        requisites.get("requisitesSimple") if isinstance(requisites, dict) else None
    ) or detail.get("requirements") or detail.get("rules") or raw.get("requirements")

    # The rules reference courses by Coursedog *internal id* (e.g. "05961-006").
    # Resolve them to human course codes (e.g. "IS 201") using the course index.
    referenced: set = set()
    _collect_strings(requirements, referenced)
    required_course_ids = sorted(s for s in referenced if s in course_index)
    required_course_codes = sorted(
        {course_index[cid] for cid in required_course_ids if course_index.get(cid)}
    )

    return {
        "program_id": raw.get("id") or raw.get("_id"),
        "code": raw.get("code"),
        "name": raw.get("name"),
        "type": raw.get("type") or raw.get("programType"),
        "degree_designation": raw.get("degreeDesignation"),
        "department": raw.get("departments") or raw.get("department"),
        "college": raw.get("college"),
        "credit_hours": raw.get("credits") or detail.get("credits"),
        # Structured requirement rules ("completedAtLeastXOf", grades, etc.).
        "requirements": requirements,
        # Flat, resolved course lists derived from those rules -- handy for the
        # optimizer and for RAG retrieval without walking the nested structure.
        "required_course_ids": required_course_ids,
        "required_course_codes": required_course_codes,
        "requisites": detail.get("requisites"),
        "description": detail.get("description") or raw.get("description"),
        "_raw_summary": raw,     # keep the original for debugging / RAG context
    }


def normalize_course(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Flatten a course record to the fields the optimizer needs."""
    return {
        "course_id": raw.get("id") or raw.get("_id"),
        "code": raw.get("code")
        or f"{raw.get('subjectCode', '')} {raw.get('courseNumber', '')}".strip(),
        "subject": raw.get("subjectCode") or raw.get("department"),
        "number": raw.get("courseNumber") or raw.get("number"),
        "name": raw.get("name") or raw.get("longName") or raw.get("title"),
        "credit_hours": raw.get("credits")
        or raw.get("creditHours")
        or raw.get("credit"),
        "prerequisites": raw.get("requisites")
        or raw.get("prerequisites")
        or raw.get("prereqs"),
        "description": raw.get("description"),
        "_raw_summary": raw,
    }


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def scrape() -> Dict[str, Any]:
    session = build_session()
    catalog_id = discover_catalog_id(session)

    # ---- Courses -------------------------------------------------------
    log.info("Fetching master course list ...")
    raw_courses = fetch_paginated(session, "courses", catalog_id)
    courses: List[Dict[str, Any]] = []
    for rc in raw_courses:
        try:
            courses.append(normalize_course(rc))
        except Exception as exc:  # one malformed record shouldn't stop the run
            log.warning("Skipping malformed course %s : %s", rc.get("id"), exc)
    log.info("Normalized %d courses.", len(courses))

    # Index course_id -> code so program requirement rules (which reference
    # courses by internal id) can be resolved to readable codes. Rules reference
    # the BASE id ('08961-000') while many course records carry a year suffix
    # ('08961-000-2023-09-05'), so index both forms or real courses drop out.
    base_id_re = re.compile(r"^(\d{4,6}-\d{2,3})")
    course_index: Dict[str, str] = {}
    for c in courses:
        cid, code = c.get("course_id"), c.get("code")
        if not cid or not code:
            continue
        course_index[cid] = code
        m = base_id_re.match(str(cid))
        if m:
            course_index.setdefault(m.group(1), code)

    # ---- Programs ------------------------------------------------------
    log.info("Fetching program list ...")
    raw_programs = fetch_paginated(session, "programs", catalog_id)
    undergrad = [p for p in raw_programs if is_undergrad_program(p)]
    log.info("Found %d programs (%d after undergrad filter).",
             len(raw_programs), len(undergrad))

    programs: List[Dict[str, Any]] = []
    for i, rp in enumerate(undergrad, start=1):
        pid = rp.get("id") or rp.get("_id")
        name = rp.get("name") or pid
        if not pid:
            log.warning("Program with no id, skipping: %r", name)
            continue
        try:
            details = fetch_program_details(session, str(pid), catalog_id)
            programs.append(normalize_program(rp, details, course_index))
            log.info("  [%d/%d] %s", i, len(undergrad), name)
        except Exception as exc:
            # Keep going even if one program's detail payload is broken.
            log.warning("  [%d/%d] FAILED %s : %s", i, len(undergrad), name, exc)
            programs.append(normalize_program(rp, None, course_index))

    return {
        "meta": {
            "source": "Coursedog / catalog.byu.edu",
            "school_id": SCHOOL_ID,
            "catalog_id": catalog_id,
            "scraped_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "counts": {
                "programs": len(programs),
                "programs_with_requirements": sum(
                    1 for p in programs if p.get("requirements")
                ),
                "courses": len(courses),
            },
        },
        "programs": programs,
        "courses": courses,
    }


def save(data: Dict[str, Any], path: Path = OUTPUT_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    log.info("Wrote %s (%.1f KB)", path, path.stat().st_size / 1024)


def main() -> int:
    try:
        data = scrape()
    except KeyboardInterrupt:
        log.error("Interrupted by user.")
        return 130
    except Exception as exc:  # last-resort guard
        log.exception("Fatal error during scrape: %s", exc)
        return 1

    if not data["programs"] and not data["courses"]:
        log.error(
            "No data returned. Almost certainly SCHOOL_ID/CATALOG_ID are wrong "
            "or the endpoint shape changed. See README_SCRAPER.md."
        )
        return 2

    save(data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
