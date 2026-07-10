#!/usr/bin/env python3
"""
sources/marriott_business.py
============================

Scrapes BYU Marriott's emphases / minors / certificates page, including the
Global Business Certificate (which is NOT in the Coursedog catalog). Each
section is an <h2> with a text description plus, usually, a linked track-sheet
PDF that holds the actual course plan -- so this scraper does HTML section
parsing AND PDF text extraction.

Source page:  https://marriott.byu.edu/mba/academics/minors-certificates/
Refresh cadence: yearly (business curricula change slowly).

Output (the shared "source document" format every non-catalog source emits):
    ../data/marriott_business.json  ->  a list of documents, each:
      {
        "id":     "marriott::global-business-certificate",
        "source": "marriott_business",
        "type":   "certificate" | "minor" | "emphasis" | "program",
        "name":   "Global Business Certificate",
        "url":    "<source page url>",
        "text":   "<readable description + PDF track-sheet text>"
      }

ingest (embed_and_load.py) reads every such list in ../data/ and embeds it into
the same Pinecone index, tagged by `source`, alongside the catalog.

Author: Jordan Heaton
"""

from __future__ import annotations

import io
import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin

try:
    from pypdf import PdfReader
except ImportError:  # pragma: no cover
    PdfReader = None

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SOURCE = "marriott_business"
PAGE_URL = "https://marriott.byu.edu/mba/academics/minors-certificates/"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / f"{SOURCE}.json"

HEADERS = {
    "User-Agent": (
        "myplanBYU-scraper/1.0 (+educational; contact jordandheaton@gmail.com) "
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    )
}
TIMEOUT = 45
MAX_PDF_CHARS = 8000  # keep each doc comfortably under Pinecone's 40 KB/vector


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def classify(name: str) -> str:
    low = name.lower()
    if "certificate" in low:
        return "certificate"
    if "minor" in low:
        return "minor"
    if "emphasis" in low:
        return "emphasis"
    return "program"


def clean(text: str) -> str:
    return re.sub(r"[ \t]+", " ", re.sub(r"\n[ \t]*", "\n", text)).strip()


def pdf_text(url: str) -> str:
    """Download a PDF and extract its text, or return '' on any failure."""
    if PdfReader is None:
        return ""
    try:
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        reader = PdfReader(io.BytesIO(resp.content))
        text = "\n".join((page.extract_text() or "") for page in reader.pages)
        return clean(text)[:MAX_PDF_CHARS]
    except Exception as exc:
        print(f"  [warn] PDF failed {url} : {exc}")
        return ""


def fix_url(href: str) -> str:
    """Resolve a link, repairing BYU's occasional doubled-prefix hrefs."""
    full = urljoin(PAGE_URL, href)
    # e.g. "https://ph.byu.edu/https:/brightspotcdn..." -> take the inner absolute URL
    m = re.search(r"https?:/+(?:brightspotcdn|[\w.-]+\.byu\.edu).*", href)
    if href.count("http") > 1 and m:
        full = re.sub(r"^https?:/+", "https://", m.group(0))
    return full


# ---------------------------------------------------------------------------
# Scrape
# ---------------------------------------------------------------------------

def scrape() -> List[Dict[str, Any]]:
    resp = requests.get(PAGE_URL, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    main = soup.find("main") or soup

    docs: List[Dict[str, Any]] = []
    headings = main.find_all("h2")
    print(f"Found {len(headings)} sections on the Marriott page.")

    for h2 in headings:
        name = h2.get_text(strip=True)
        if not name:
            continue

        # Collect this section's content: everything until the next <h2>.
        parts: List[str] = []
        pdf_urls: List[str] = []
        for sib in h2.find_next_siblings():
            if sib.name == "h2":
                break
            for a in sib.find_all("a", href=True) if hasattr(sib, "find_all") else []:
                if ".pdf" in a["href"].lower():
                    pdf_urls.append(fix_url(a["href"]))
            text = sib.get_text(" ", strip=True) if hasattr(sib, "get_text") else str(sib)
            if text:
                parts.append(text)

        description = clean("\n".join(parts))

        # Pull the track-sheet PDF(s) for the real course plan.
        pdf_blocks = []
        for pu in dict.fromkeys(pdf_urls):  # dedupe, keep order
            print(f"  {name}: fetching PDF {pu.rsplit('/', 1)[-1]}")
            t = pdf_text(pu)
            if t:
                pdf_blocks.append(f"Track sheet ({pu.rsplit('/', 1)[-1]}):\n{t}")
            time.sleep(0.3)

        body = description
        if pdf_blocks:
            body += "\n\n" + "\n\n".join(pdf_blocks)

        docs.append({
            "id": f"{SOURCE}::{slug(name)}",
            "source": SOURCE,
            "type": classify(name),
            "name": name,
            "url": PAGE_URL,
            "text": f"BYU Marriott {classify(name)}: {name}.\n{body}".strip(),
        })

    return docs


def main() -> int:
    if PdfReader is None:
        print("WARNING: pypdf not installed; PDFs will be skipped. `pip install pypdf`")
    try:
        docs = scrape()
    except Exception as exc:
        print(f"FATAL: {exc}", file=sys.stderr)
        return 1

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(docs, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nWrote {len(docs)} documents -> {OUTPUT_PATH}")
    for d in docs:
        print(f"  [{d['type']}] {d['name']}  ({len(d['text'])} chars)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
