#!/usr/bin/env python3
"""
sources/research_grants.py
==========================

Scrapes BYU's per-college undergraduate research / experiential-learning grant
pages. BYU's old central ORCA grant program was decentralized: each college now
runs its own mentored-research funding (HUM Grants in Humanities, Experiential
Learning Grants in Economics, etc.). These are classic "didn't know to ask"
opportunities -- $1,000-$1,500 for student research with a faculty mentor.

PAGES below is a curated list (one entry per college page that exists); add a
line whenever another college's grant page is found. Each page becomes one
document with an "Relevant to:" audience hint so retrieval can surface the
right college's grant for a student's major.

Refresh cadence: yearly (application windows repeat annually; amounts rarely
change).

Output (shared source-document format -- see sources/README.md):
    ../data/research_grants.json  ->  source="research_grants", type="opportunity"

Author: Jordan Heaton
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SOURCE = "research_grants"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / f"{SOURCE}.json"

# One entry per college grant page. "audience" feeds the Relevant-to hint that
# helps the embedding surface the right grant for a student's major.
PAGES: List[Dict[str, str]] = [
    {
        "name": "Humanities Undergraduate Mentoring (HUM) Grants",
        "url": "https://humgrants.byu.edu/",
        "audience": "College of Humanities students (English, languages, linguistics, philosophy, comparative literature)",
    },
    {
        "name": "Economics Experiential Learning Grant",
        "url": "https://economics.byu.edu/experiential-learning-grant",
        "audience": "Economics students (FHSS)",
    },
    {
        "name": "College of Fine Arts & Communications Student Scholarships and Grants",
        "url": "https://cfac.byu.edu/student-scholarships-and-grants/",
        "audience": "Fine Arts and Communications students (art, design, music, theatre, media arts, communications)",
    },
    {
        "name": "McKay School of Education Research and Student Mentoring Grants",
        "url": "https://education.byu.edu/research/grants",
        "audience": "McKay School of Education students (elementary/secondary education, teaching, counseling psychology)",
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

STRIP_TAGS = ["script", "style", "noscript", "header", "footer", "nav", "aside", "form", "iframe", "svg"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def fetch_text(url: str) -> Optional[str]:
    """Page -> cleaned main-content text, or None."""
    try:
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        if "text/html" not in resp.headers.get("Content-Type", ""):
            print(f"  [skip] non-HTML: {url}")
            return None
        soup = BeautifulSoup(resp.text, "html.parser")
    except Exception as exc:
        print(f"  [warn] fetch failed {url} : {exc}")
        return None

    # Some BYU sites (WordPress themes) have TWO <main> tags -- an empty
    # wrapper first and the real content second. Take the densest candidate.
    candidates = soup.find_all("main") + soup.find_all("article")
    if soup.body is not None:
        candidates.append(soup.body)
    if not candidates:
        candidates = [soup]
    root = max(candidates[:-1] or candidates,
               key=lambda el: len(el.get_text(" ", strip=True)))
    if len(root.get_text(" ", strip=True)) < MIN_TEXT_CHARS and soup.body is not None:
        root = soup.body   # last resort: whole body
    for t in root(STRIP_TAGS):
        t.decompose()
    lines = []
    for ln in root.get_text("\n", strip=True).splitlines():
        ln = re.sub(r"[ \t]+", " ", ln).strip()
        if ln and not re.match(r"^\s*[\w-]+=\S*\s*$", ln):   # CMS template junk
            if not lines or lines[-1] != ln:
                lines.append(ln)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    docs: List[Dict[str, Any]] = []
    for page in PAGES:
        print(f"[{page['name']}]")
        body = fetch_text(page["url"])
        if not body or len(body) < MIN_TEXT_CHARS:
            print(f"  [warn] thin/missing content ({len(body or '')} chars) -- skipped")
            continue
        docs.append({
            "id": f"{SOURCE}::{slug(page['name'])}",
            "source": SOURCE,
            "type": "opportunity",
            "name": page["name"],
            "url": page["url"],
            "text": (
                f"{page['name']} -- BYU undergraduate research / mentored "
                f"experiential learning grant funding.\n"
                f"Relevant to: {page['audience']}.\n"
                f"This is funding students can apply for to do research or creative "
                f"work with a faculty mentor (great for grad school and resumes).\n"
                f"{body}"
            )[:MAX_TEXT_CHARS],
        })
        print(f"  + captured ({len(body)} chars)")
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
