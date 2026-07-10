#!/usr/bin/env python3
"""
sources/kennedy_scraper.py
==========================

Scrapes BYU Kennedy Center "Find Your Program" -- every International Study
Program (study abroad, international internships, direct enrollment). The
listing page holds ALL programs (no pagination) with a short snippet (program
type, term, dates, price); each program's detail page adds the locations,
description, courses/credits, cost breakdown, housing, travel, and application
deadlines.

Source pages: https://kennedy.byu.edu/find-your-program   (listing)
              https://kennedy.byu.edu/isp-program/<slug>  (one per program)
Refresh cadence: each semester (programs and dates turn over constantly).

Output (shared source-document format -- see sources/README.md):
    ../data/study_abroad.json  ->  one document per program, e.g.
      {
        "id":     "study_abroad::asia-pacific-business",
        "source": "study_abroad",
        "type":   "study_abroad",
        "name":   "Asia Pacific Business",
        "url":    "https://kennedy.byu.edu/isp-program/asia-pacific-business",
        "text":   "<locations, term, cost, courses, deadlines, ...>"
      }

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

SOURCE = "study_abroad"
LISTING_URL = "https://kennedy.byu.edu/find-your-program"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / f"{SOURCE}.json"

HEADERS = {
    "User-Agent": (
        "myplanBYU-scraper/1.0 (+educational; contact jordandheaton@gmail.com) "
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    )
}
TIMEOUT = 45
DELAY = 0.7          # polite pause between program-page fetches (~130 pages;
                     # Kennedy's server rate-limits bursts with 403s)
RETRIES = 2          # extra attempts on 403/5xx, with a growing backoff
MAX_TEXT_CHARS = 30000  # stay well under Pinecone's 40 KB metadata cap

# Detail-page sections worth embedding. Everything else ("Funding Sources",
# "Program Adjustments", "ISP Student Handbook", "Contact Us", ...) is
# identical boilerplate on every program and would dilute the embeddings.
KEEP_SECTIONS = {
    "courses",
    "cost",
    "preparation",
    "housing",
    "travel",
    "application process",
    "faculty",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def slug_of(url: str) -> str:
    return url.rstrip("/").rsplit("/", 1)[-1]


def clean(text: str) -> str:
    return re.sub(r"[ \t]+", " ", re.sub(r"\n[ \t]*", "\n", text)).strip()


def fetch(url: str) -> BeautifulSoup:
    """GET a page, retrying on 403/5xx -- Kennedy's server throttles bursts."""
    for attempt in range(RETRIES + 1):
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        if resp.status_code in (403, 429, 500, 502, 503) and attempt < RETRIES:
            wait = 15 * (attempt + 1)
            print(f"    [retry] HTTP {resp.status_code}; waiting {wait}s...")
            time.sleep(wait)
            continue
        resp.raise_for_status()
        return BeautifulSoup(resp.text, "html.parser")
    raise RuntimeError("unreachable")


# ---------------------------------------------------------------------------
# Scrape: listing page -> {url: snippet}
# ---------------------------------------------------------------------------

def scrape_listing() -> Dict[str, Dict[str, str]]:
    """All program URLs with their listing snippet (type / term / dates / price)."""
    soup = fetch(LISTING_URL)
    programs: Dict[str, Dict[str, str]] = {}

    for item in soup.select("div.SearchSnippet-GridItem"):
        link = item.select_one(".SearchSnippet-GridItem-title a[href]")
        if not link or "/isp-program/" not in link["href"]:
            continue
        desc = item.select_one(".SearchSnippet-GridItem-description")
        programs[link["href"]] = {
            "name": link.get_text(strip=True),
            # e.g. "Study Abroad/Internship Spr 2026 | 26 Apr-20 Jun | $8,500-9,000"
            "snippet": clean(desc.get_text(" | ", strip=True)) if desc else "",
        }

    return programs


# ---------------------------------------------------------------------------
# Scrape: one program detail page -> text body
# ---------------------------------------------------------------------------

def scrape_program(url: str) -> Dict[str, str]:
    """Locations + description + the KEEP_SECTIONS from a program page."""
    soup = fetch(url)
    main = soup.find("main") or soup

    # Intro block: first RichTextFullWidth-items -- a bold locations line
    # ("SOUTH KOREA, JAPAN, ...") followed by the program description.
    locations, description = "", ""
    intro = main.select_one(".RichTextFullWidth-items")
    if intro:
        strong = intro.find("strong")
        if strong:
            locations = strong.get_text(" ", strip=True)
        description = clean(intro.get_text("\n", strip=True))

    # Accordion sections: each is a PromoIconOnSide-content with an <h3> title
    # and a -description body (Courses, Cost, Housing, Application Process...).
    # NOTE: these live OUTSIDE <main> on Kennedy's pages, so search the whole
    # page -- the class names are specific enough to be safe.
    sections: List[str] = []
    for block in soup.select(".PromoIconOnSide-content"):
        h3 = block.find("h3")
        body = block.select_one(".PromoIconOnSide-description")
        if not h3 or not body:
            continue
        title = h3.get_text(" ", strip=True)
        if title.lower() not in KEEP_SECTIONS:
            continue
        body_text = clean(body.get_text("\n", strip=True))
        if body_text:
            sections.append(f"{title}:\n{body_text}")

    return {
        "locations": locations,
        "description": description,
        "sections": "\n\n".join(sections),
    }


# ---------------------------------------------------------------------------
# Build documents
# ---------------------------------------------------------------------------

def scrape() -> List[Dict[str, Any]]:
    listing = scrape_listing()
    print(f"Found {len(listing)} programs on the listing page.")

    docs: List[Dict[str, Any]] = []
    for i, (url, info) in enumerate(sorted(listing.items()), start=1):
        name = info["name"]
        print(f"  [{i}/{len(listing)}] {name}")
        try:
            detail = scrape_program(url)
        except Exception as exc:
            print(f"    [warn] detail page failed ({exc}); keeping listing snippet only")
            detail = {"locations": "", "description": "", "sections": ""}

        # Lead with (and repeat) the program name + locations so each program
        # embeds distinctly -- the application/cost boilerplate is similar
        # across all 130 programs.
        parts = [
            f"{name} -- BYU study abroad / international study program "
            f"(Kennedy Center ISP).",
        ]
        if detail["locations"]:
            parts.append(f"Location: {detail['locations']}.")
        if info["snippet"]:
            parts.append(f"Term and cost: {info['snippet']}.")
        if detail["description"]:
            parts.append(detail["description"])
        if detail["sections"]:
            parts.append(detail["sections"])

        docs.append({
            "id": f"{SOURCE}::{slug_of(url)}",
            "source": SOURCE,
            "type": "study_abroad",
            "name": name,
            "url": url,
            "text": "\n".join(parts)[:MAX_TEXT_CHARS],
        })
        time.sleep(DELAY)

    return docs


def main() -> int:
    try:
        docs = scrape()
    except Exception as exc:
        print(f"FATAL: {exc}", file=sys.stderr)
        return 1

    if not docs:
        print("FATAL: 0 programs scraped -- page layout may have changed.", file=sys.stderr)
        return 1

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(docs, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nWrote {len(docs)} study abroad programs -> {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
