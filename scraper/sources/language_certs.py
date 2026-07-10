#!/usr/bin/env python3
"""
sources/language_certs.py
=========================

Scrapes BYU's Center for Language Studies "Language Certificate" course-options
page. Every language (Arabic, Chinese, Spanish, ...) is an <h3> followed by its
certificate requirements as text -- three categories (Language, Civilization/
Culture, Literature), each usually "choose one" from a short list of courses.
Plain HTML, no PDFs.

Source page:  https://cls.byu.edu/programs/certificate/courseoptions/
Refresh cadence: yearly.

Output (shared source-document format -- see sources/README.md):
    ../data/language_certs.json  ->  one document per language, e.g.
      {
        "id":     "language_certs::spanish",
        "source": "language_certs",
        "type":   "certificate",
        "name":   "Spanish Language Certificate",
        "url":    "<source page>",
        "text":   "<the 3-category course requirements>"
      }

Author: Jordan Heaton
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List

import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SOURCE = "language_certs"
PAGE_URL = "https://cls.byu.edu/programs/certificate/courseoptions/"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / f"{SOURCE}.json"

HEADERS = {
    "User-Agent": (
        "myplanBYU-scraper/1.0 (+educational; contact jordandheaton@gmail.com) "
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    )
}
TIMEOUT = 45

# A section only counts as a language certificate if its text references a BYU
# course code (e.g. "ARAB 302", "IHUM 242") -- this filters out any stray
# navigation/heading <h3> that isn't a language.
COURSE_CODE_RE = re.compile(r"\b[A-Z][A-Z ]{1,5}\s?\d{3}[A-Z]?\b")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def clean(text: str) -> str:
    return re.sub(r"[ \t]+", " ", re.sub(r"\n[ \t]*", "\n", text)).strip()


# ---------------------------------------------------------------------------
# Scrape
# ---------------------------------------------------------------------------

def scrape() -> List[Dict[str, Any]]:
    resp = requests.get(PAGE_URL, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    main = soup.find("main") or soup

    docs: List[Dict[str, Any]] = []
    for h3 in main.find_all("h3"):
        language = h3.get_text(strip=True)
        if not language:
            continue

        # Everything between this <h3> and the next heading is the requirements.
        parts: List[str] = []
        for sib in h3.find_next_siblings():
            if sib.name in ("h1", "h2", "h3"):
                break
            text = sib.get_text(" ", strip=True) if hasattr(sib, "get_text") else ""
            if text:
                parts.append(text)
        body = clean("\n".join(parts))

        # Skip non-language sections (no course codes in the body).
        if not body or not COURSE_CODE_RE.search(body):
            continue

        name = f"{language} Language Certificate"
        docs.append({
            "id": f"{SOURCE}::{slug(language)}",
            "source": SOURCE,
            "type": "certificate",
            "name": name,
            "url": PAGE_URL,
            # Lead with the language name and repeat it so each certificate embeds
            # distinctly -- otherwise the shared "three categories" boilerplate
            # makes all 21 languages look alike and the language name gets diluted.
            "text": (
                f"{name} (BYU Center for Language Studies). "
                f"This is the {language} certificate. To earn the {language} "
                f"Language Certificate, complete one {language} course in each of "
                f"three categories -- Language, Civilization/Culture, and Literature. "
                f"{language} certificate course options:\n{body}"
            ),
        })

    return docs


def main() -> int:
    try:
        docs = scrape()
    except Exception as exc:
        print(f"FATAL: {exc}", file=sys.stderr)
        return 1

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(docs, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {len(docs)} language certificates -> {OUTPUT_PATH}")
    for d in docs:
        print(f"  {d['name']}  ({len(d['text'])} chars)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
