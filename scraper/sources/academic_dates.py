#!/usr/bin/env python3
"""
sources/academic_dates.py
=========================

Scrapes BYU's academic calendar deadlines and registration information -- the
"do this BY THIS DATE" data that turns the advisor from reactive to proactive
(add/drop deadlines, withdraw deadlines, semester start/end, registration).

Sources:
    https://academiccalendar.byu.edu/          -> per-term deadline summary
    https://enrollment.byu.edu/registrar/registration -> registration how-to/dates

Refresh cadence: each semester (the calendar page rolls forward continuously).

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


# ---------------------------------------------------------------------------
# Academic calendar: per-term deadline summary
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
                name = f"{term} {year} Dates & Deadlines"
                body_parts = []
                if span:
                    body_parts.append(f"{term} {year} runs {span}, {year}.")
                body_parts += deadlines
                docs.append({
                    "id": f"{SOURCE}::{slug(term)}-{year}",
                    "source": SOURCE,
                    "type": "deadline",
                    "name": name,
                    "url": CALENDAR_URL,
                    "text": (
                        f"{name} -- BYU academic calendar. Key dates every student "
                        f"must know for {term} {year}:\n" + "\n".join(body_parts) +
                        "\nMissing the add/drop deadline means classes stay on your "
                        "record; missing the withdraw deadline means a W or grade is "
                        "assigned. Full calendar: academiccalendar.byu.edu."
                    ),
                })
        else:
            i += 1

    return docs


# ---------------------------------------------------------------------------
# Registration page
# ---------------------------------------------------------------------------

def scrape_registration() -> List[Dict[str, Any]]:
    docs: List[Dict[str, Any]] = []
    for name, url in REGISTRAR_PAGES:
        soup = fetch(url)
        if soup is None:
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

def main() -> int:
    docs = scrape_calendar()
    print(f"Calendar terms captured: {len(docs)}")
    docs += scrape_registration()

    if not docs:
        print("FATAL: 0 documents scraped -- page layouts may have changed.", file=sys.stderr)
        return 1

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(docs, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nWrote {len(docs)} documents -> {OUTPUT_PATH}")
    for d in docs:
        print(f"  [{d['type']}] {d['name']}  ({len(d['text'])} chars)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
