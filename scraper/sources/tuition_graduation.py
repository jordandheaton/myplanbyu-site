#!/usr/bin/env python3
"""
sources/tuition_graduation.py
=============================

Scrapes BYU's tuition/cost pages and graduation application pages -- the two
most-asked question areas the advisor couldn't answer yet:

    "How much is tuition?"           -> tuition rates + cost of attendance
    "When do I apply to graduate?"   -> per-cycle application deadlines + steps

Pages (all enrollment.byu.edu, same Brightspot pattern as policy_scraper.py):
    /tuition                                   tuition & fees rates, policy
    /financial-aid/cost-of-attendance          full COA budget breakdown
    /registrar/graduation-dates-and-deadlines  application due dates per cycle
    /how-to-apply-for-graduation               steps + $15 fee + endorsement
    /registrar/graduating-with-scholastic-honors  cum laude / GPA thresholds

Refresh cadence: each semester (tuition is set annually, but graduation
deadline tables roll forward every cycle).

Output (shared source-document format -- see sources/README.md):
    ../data/tuition_graduation.json  ->  source="tuition_graduation";
    tuition docs type="policy", graduation docs type="deadline".

Author: Jordan Heaton
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SOURCE = "tuition_graduation"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / f"{SOURCE}.json"

PAGES: List[Dict[str, str]] = [
    {
        "name": "BYU Tuition and Fees",
        "url": "https://enrollment.byu.edu/tuition",
        "type": "policy",
        "lead": "How much BYU costs: official tuition and general fee rates "
                "(Latter-day Saint and non-member rates, per-credit costs)",
    },
    {
        "name": "BYU Cost of Attendance",
        "url": "https://enrollment.byu.edu/financial-aid/cost-of-attendance",
        "type": "policy",
        "lead": "Full cost of attending BYU (used for financial aid): tuition, "
                "housing, food, books, transportation budget estimates",
    },
    {
        "name": "Graduation Dates and Application Deadlines",
        "url": "https://enrollment.byu.edu/registrar/graduation-dates-and-deadlines",
        "type": "deadline",
        "lead": "When to apply for BYU graduation: application due dates and "
                "final requirement deadlines for each graduation cycle "
                "(December, April, June, August)",
    },
    {
        "name": "How to Apply for Graduation",
        "url": "https://enrollment.byu.edu/how-to-apply-for-graduation",
        "type": "deadline",
        "lead": "Steps to apply for BYU graduation: choosing a date, "
                "ecclesiastical endorsement, online application, and fee",
    },
    {
        "name": "Graduating with Scholastic Honors (Cum Laude)",
        "url": "https://enrollment.byu.edu/registrar/graduating-with-scholastic-honors",
        "type": "policy",
        "lead": "GPA thresholds and rules for graduating cum laude, magna cum "
                "laude, and summa cum laude at BYU",
    },
]

HEADERS = {
    "User-Agent": (
        "myplanBYU-scraper/1.0 (+educational; contact jordandheaton@gmail.com) "
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    )
}
TIMEOUT = 45
DELAY = 0.7
MIN_TEXT_CHARS = 300
MAX_TEXT_CHARS = 30000


# ---------------------------------------------------------------------------
# Helpers (same extraction pattern as policy_scraper.py)
# ---------------------------------------------------------------------------

def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def fetch_text(url: str) -> str:
    try:
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        if "text/html" not in resp.headers.get("Content-Type", ""):
            return ""
        soup = BeautifulSoup(resp.text, "html.parser")
    except Exception as exc:
        print(f"  [warn] fetch failed {url} : {exc}")
        return ""

    root = soup.find("main") or soup.body or soup
    for t in root(["script", "style", "noscript", "header", "footer", "nav", "aside", "form", "svg"]):
        t.decompose()
    lines = []
    for ln in root.get_text("\n", strip=True).splitlines():
        ln = re.sub(r"[ \t]+", " ", ln).strip()
        if ln and not (lines and lines[-1] == ln):
            lines.append(ln)
    return "\n".join(lines)


def main() -> int:
    docs: List[Dict[str, Any]] = []
    for page in PAGES:
        body = fetch_text(page["url"])
        if len(body) < MIN_TEXT_CHARS:
            print(f"  [warn] thin/missing ({len(body)} chars): {page['url']}")
            continue
        docs.append({
            "id": f"{SOURCE}::{slug(page['name'])}",
            "source": SOURCE,
            "type": page["type"],
            "name": page["name"],
            "url": page["url"],
            "text": f"{page['name']} -- {page['lead']}:\n{body}"[:MAX_TEXT_CHARS],
        })
        print(f"  + {page['name']}  ({len(body)} chars)")
        time.sleep(DELAY)

    if not docs:
        print("FATAL: 0 documents scraped.", file=sys.stderr)
        return 1

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(docs, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nWrote {len(docs)} documents -> {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
