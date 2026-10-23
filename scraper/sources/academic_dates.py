#!/usr/bin/env python3
"""
sources/academic_dates.py
=========================

Scrapes BYU's academic calendar deadlines and registration information -- the
"do this BY THIS DATE" data that turns the advisor from reactive to proactive
(add/drop deadlines, withdraw deadlines, semester start/end, registration).

Sources:
    BYU API ControlDatesWS v1 (api.byu.edu)    -> per-term dates and deadlines
    https://academiccalendar.byu.edu/          -> fallback for the above
    https://enrollment.byu.edu/registrar/...   -> registration how-to pages

WHY THE API IS PRIMARY. Both websites sit behind BYU's CloudFront, which
answers 403 to GitHub Actions runner IPs, so the HTML scrape cannot run in CI.
The gateway can, and its control dates were checked against every 2026 term
the calendar scrape had captured (2026-10-22) -- all identical:
    CLASS_DATES        start..end  -> "runs Jan 07 - Apr 15"
    REGISTRATION       end         -> Add/Drop Deadline   ("Semester add deadline")
    SEMESTER WITHDRAW  end         -> Withdraw Deadline   ("semester W/D deadline")
It also has terms the calendar page doesn't show yet (Winter/Spring 2027 in
October 2026). Needs BYU_CLIENT_ID / BYU_CLIENT_SECRET -- see byu_api.py.

FAILURE POLICY. Each piece falls back rather than vanishing: no API -> the
calendar scrape; a registrar page that won't fetch -> its copy from the last
good run. The step fails only if the term dates come from neither source.

Refresh cadence: weekly (cheap; about a dozen API calls).

Output (shared source-document format -- see sources/README.md):
    ../data/academic_dates.json  ->  one doc per term + one registration doc,
    all source="academic_dates", type="deadline".

Author: Jordan Heaton
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SOURCE = "academic_dates"
CALENDAR_URL = "https://academiccalendar.byu.edu/"
# The /registrar/registration page is a menu hub -- the substance lives on
# these registrar pages, each of which becomes its own document.
REGISTRAR_PAGES = [
    ("Registration Dates and Deadlines",
     "https://enrollment.byu.edu/registrar/dates-and-deadlines"),
    ("How to Register for Classes",
     "https://enrollment.byu.edu/checklist/register-for-classes"),
    ("Dropping and Withdrawing from Classes",
     "https://enrollment.byu.edu/registrar/dropping-classes"),
    ("Deferring or Taking a Break from School",
     "https://enrollment.byu.edu/registrar/deferring-or-leaving-school"),
]
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / f"{SOURCE}.json"

HEADERS = {
    "User-Agent": (
        "myplanBYU-scraper/1.0 (+educational; contact jordandheaton@gmail.com) "
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    )
}
TIMEOUT = 45

TERM_NAMES = ("Winter Semester", "Spring Term", "Summer Term", "Fall Semester")

# BYU year-term codes: YYYY + 1 Winter, 3 Spring, 4 Summer, 5 Fall.
TERM_CODES = (("1", "Winter Semester"), ("3", "Spring Term"),
              ("4", "Summer Term"), ("5", "Fall Semester"))
CONTROL_DATES = "/domains/legacy/academic/controls/controldatesws/v1/yearterm/{yt}/{types}"
DATE_TYPES = "CLASS_DATES,REGISTRATION,SEMESTER%20WITHDRAW"
# Which terms to publish: any not yet over, starting within this horizon. The
# planner only attaches dates to terms a plan still has ahead of it.
HORIZON_DAYS = 450


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def fetch(url: str) -> Optional[BeautifulSoup]:
    try:
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        return BeautifulSoup(resp.text, "html.parser")
    except Exception as exc:
        print(f"  [warn] fetch failed {url} : {exc}")
        return None


def term_doc(term: str, year: str, url: str, lines: List[str]) -> Dict[str, Any]:
    """One term's deadline document. generate_timeline.py parses the 'runs',
    'Add/Drop Deadline' and 'Withdraw Deadline' lines, so both sources must
    produce exactly this shape."""
    name = f"{term} {year} Dates & Deadlines"
    return {
        "id": f"{SOURCE}::{slug(term)}-{year}",
        "source": SOURCE,
        "type": "deadline",
        "name": name,
        "url": url,
        "text": (
            f"{name} -- BYU academic calendar. Key dates every student "
            f"must know for {term} {year}:\n" + "\n".join(lines) +
            "\nMissing the add/drop deadline means classes stay on your "
            "record; missing the withdraw deadline means a W or grade is "
            "assigned. Full calendar: academiccalendar.byu.edu."
        ),
    }


# ---------------------------------------------------------------------------
# BYU API: per-term dates and deadlines (primary)
# ---------------------------------------------------------------------------

def _api_date(value: Optional[str]) -> Optional[date]:
    try:
        return datetime.strptime((value or "")[:8], "%Y%m%d").date()
    except ValueError:
        return None


def _fmt(d: date) -> str:
    return d.strftime("%b %d")          # "Jan 07" -- the calendar page's style


def fetch_api_terms() -> List[Dict[str, Any]]:
    """Term docs from ControlDatesWS. Raises if the API is unusable, so the
    caller can fall back to the calendar scrape."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from byu_api import ByuApi   # local import: the scrape fallback needs no credentials

    api = ByuApi()
    today = date.today()
    docs: List[Dict[str, Any]] = []
    for year in (today.year - 1, today.year, today.year + 1):
        for code, term in TERM_CODES:
            yt = f"{year}{code}"
            data = api.get(CONTROL_DATES.format(yt=yt, types=DATE_TYPES))
            rows = ((data or {}).get("ControlDatesWSService") or {}).get("response") or {}
            by_type = {r.get("date_type"): r for r in rows.get("date_list") or [] if r.get("date_type")}
            cls = by_type.get("CLASS_DATES")
            if not cls:
                continue                     # not posted yet
            start, end = _api_date(cls.get("start_date")), _api_date(cls.get("end_date"))
            if not (start and end) or end < today or start > today + timedelta(days=HORIZON_DAYS):
                continue
            lines = [f"{term} {year} runs {_fmt(start)} - {_fmt(end)}, {end.year}."]
            add = _api_date((by_type.get("REGISTRATION") or {}).get("end_date"))
            wd = _api_date((by_type.get("SEMESTER WITHDRAW") or {}).get("end_date"))
            reg_open = _api_date((by_type.get("REGISTRATION") or {}).get("start_date"))
            if add:
                lines.append(f"Add/Drop Deadline: {_fmt(add)}, {add.year}")
            if wd:
                lines.append(f"Withdraw Deadline: {_fmt(wd)}, {wd.year}")
            if reg_open:
                lines.append(f"Registration Opens: {_fmt(reg_open)}, {reg_open.year}")
            docs.append(term_doc(term, str(year), CALENDAR_URL, lines))
            print(f"  + {term} {year}: {' | '.join(lines[1:]) or 'dates only'}")
    return docs


# ---------------------------------------------------------------------------
# Academic calendar: per-term deadline summary (fallback)
# ---------------------------------------------------------------------------

def scrape_calendar() -> List[Dict[str, Any]]:
    soup = fetch(CALENDAR_URL)
    if soup is None:
        return []
    for t in soup(["script", "style", "noscript"]):
        t.decompose()

    # The calendar page is one big year view; the most frequent 4-digit year in
    # the markup is the year it's displaying.
    years = Counter(re.findall(r"\b(20\d{2})\b", soup.get_text(" ")))
    year = years.most_common(1)[0][0] if years else ""

    main = soup.find("main") or soup
    lines = [ln.strip() for ln in main.get_text("\n", strip=True).splitlines() if ln.strip()]

    # The "Academic Deadlines" summary block reads like:
    #   Winter Semester / Jan 07 - Apr 15 / Jan 14 / Add/Drop Deadline / Apr 01
    #   / Withdraw Deadline / Spring Term / ...
    # For each term header, collect (date, label) pairs until the next header.
    docs: List[Dict[str, Any]] = []
    date_re = re.compile(r"^[A-Z][a-z]{2} \d{1,2}( - [A-Z][a-z]{2} \d{1,2})?$")

    i = 0
    while i < len(lines):
        if lines[i] in TERM_NAMES:
            term = lines[i]
            i += 1
            span = ""
            deadlines: List[str] = []
            pending_date = None
            while i < len(lines) and lines[i] not in TERM_NAMES and lines[i] != "Color Key":
                ln = lines[i]
                if date_re.match(ln):
                    if " - " in ln and not span:
                        span = ln          # the term's start-end range
                    else:
                        pending_date = ln  # a deadline date awaiting its label
                elif pending_date:
                    deadlines.append(f"{ln}: {pending_date}, {year}")
                    pending_date = None
                i += 1

            if span or deadlines:
                body_parts = []
                if span:
                    body_parts.append(f"{term} {year} runs {span}, {year}.")
                body_parts += deadlines
                docs.append(term_doc(term, year, CALENDAR_URL, body_parts))
        else:
            i += 1

    return docs


# ---------------------------------------------------------------------------
# Registration page
# ---------------------------------------------------------------------------

def scrape_registration(previous: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The registrar pages are prose that changes about once a year. One that
    won't fetch (the 403 CI gets) keeps its copy from the last good run."""
    docs: List[Dict[str, Any]] = []
    for name, url in REGISTRAR_PAGES:
        soup = fetch(url)
        if soup is None:
            kept = previous.get(f"{SOURCE}::{slug(name)}")
            if kept:
                docs.append(kept)
                print(f"  = {name}  (kept previous copy)")
            continue
        root = soup.find("main") or soup.body or soup
        for t in root(["script", "style", "noscript", "header", "footer", "nav", "aside", "form"]):
            t.decompose()
        text = re.sub(r"\n{2,}", "\n", root.get_text("\n", strip=True))
        if len(text) < 300:
            print(f"  [warn] thin page ({len(text)} chars): {url}")
            continue
        docs.append({
            "id": f"{SOURCE}::{slug(name)}",
            "source": SOURCE,
            "type": "deadline",
            "name": name,
            "url": url,
            "text": (
                f"{name} -- BYU Registrar (registration rules and deadlines "
                f"every student needs):\n" + text[:30000]
            ),
        })
        print(f"  + {name}  ({len(text)} chars)")
    return docs


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def load_previous() -> Dict[str, Dict[str, Any]]:
    try:
        return {d["id"]: d for d in json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def main() -> int:
    previous = load_previous()
    try:
        docs = fetch_api_terms()
        print(f"API terms captured: {len(docs)}")
    except Exception as exc:          # no credentials, gateway down, shape changed
        print(f"  [warn] BYU API unavailable ({exc}) -- falling back to the calendar page")
        docs = []
    if not docs:
        docs = scrape_calendar()
        print(f"Calendar terms captured: {len(docs)}")
    if not docs:
        # Without term dates the output would silently lose every deadline;
        # fail and let the pipeline keep the last good file instead.
        print("FATAL: no term dates from the API or the calendar page.", file=sys.stderr)
        return 1
    docs += scrape_registration(previous)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(docs, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nWrote {len(docs)} documents -> {OUTPUT_PATH}")
    for d in docs:
        print(f"  [{d['type']}] {d['name']}  ({len(d['text'])} chars)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
