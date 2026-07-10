#!/usr/bin/env python3
"""
sources/flowcharts.py
=====================

Scrapes official BYU departmental MAJOR FLOWCHARTS -- the PDFs departments
publish showing the recommended semester-by-semester sequence (what to take
freshman fall vs junior winter, offering seasons, junior-core envelopes).
These encode sequencing nuance the catalog itself doesn't, so the advisor
prioritizes them when asked "how should my major be laid out?".

Each entry below is a department HUB PAGE that links to the current year's
flowchart PDF (link text/href matched by 'flowchart'), plus optional DIRECT
PDF urls for departments without a stable hub. Hub-first means the scraper
self-heals when a department rolls to a new year's PDF.

TO ADD A DEPARTMENT: append one CONFIG entry (find the page that links to the
PDF), rerun this script, then `embed_and_load.py --only-sources flowcharts`.

Refresh cadence: yearly (new flowcharts appear each spring for fall cohorts).

Output (shared source-document format -- see sources/README.md):
    ../data/flowcharts.json  ->  source="flowcharts", type="flowchart"

Author: Jordan Heaton
"""

from __future__ import annotations

import io
import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

try:
    from pypdf import PdfReader
except ImportError:  # pragma: no cover
    PdfReader = None

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SOURCE = "flowcharts"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / f"{SOURCE}.json"

CONFIGS: List[Dict[str, Any]] = [
    # ---- Marriott School of Business ----
    # (pattern: marriott.byu.edu/<dept>/.../what-will-i-study/flowcharts/)
    {"program": "Accounting (BS)",
     "hub": "https://marriott.byu.edu/acc/bsacc/what-will-i-study/flowcharts/"},
    {"program": "Finance (BS)",
     "hub": "https://marriott.byu.edu/bsfin/academics/what-will-i-study/flowcharts/"},
    {"program": "Global Supply Chain Management (BS)",
     "hub": "https://marriott.byu.edu/gscm/academics/what-will-i-study/flowcharts/"},
    {"program": "Marketing (BS)",
     "hub": "https://marriott.byu.edu/mktg/academics/what-will-i-study/flowcharts/"},
    {"program": "Entrepreneurial Management (BS)",
     "hub": "https://marriott.byu.edu/ent/academics/what-will-i-study/flowcharts/"},
    {"program": "Human Resource Management (BS)",
     "hub": "https://marriott.byu.edu/hrm/academics/what-will-i-study/flowcharts/"},
    {"program": "Experience Design & Management (BS)",
     "hub": "https://marriott.byu.edu/exdm/academics/what-will-i-study/flowcharts/"},
    {"program": "Information Systems (BS)",
     "hub": "https://marriott.byu.edu/infosys/bsis/what-will-i-study/flowcharts/"},
    # ---- Ira A. Fulton College of Engineering ----
    {"program": "Electrical Engineering (BS)",
     "hub": "https://ece.byu.edu/electrical-engineering"},
    {"program": "Computer Engineering (BS)",
     "hub": "https://ece.byu.edu/computerengineering"},
    {"program": "Mechanical Engineering (BS)",
     "hub": "https://www.me.byu.edu/flowchart"},
    {"program": "Information Technology (BS)",
     "hub": "https://ece.byu.edu/information-technology-flowcharts"},
    {"program": "Manufacturing Engineering (BS)",
     "hub": "https://mfgen.byu.edu/mfgen-flowcharts"},
]

HEADERS = {
    "User-Agent": (
        "myplanBYU-scraper/1.0 (+educational; contact jordandheaton@gmail.com) "
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    )
}
TIMEOUT = 60
DELAY = 0.7
MAX_PDFS_PER_PROGRAM = 3      # current-year chart + maybe an elective sheet
MAX_TEXT_CHARS = 25000


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def fetch(url: str) -> Optional[requests.Response]:
    try:
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        return resp
    except Exception as exc:
        print(f"  [warn] fetch failed {url} : {exc}")
        return None


def pdf_text(resp: requests.Response) -> str:
    if PdfReader is None:
        return ""
    try:
        reader = PdfReader(io.BytesIO(resp.content))
        text = "\n".join((p.extract_text() or "") for p in reader.pages)
        return re.sub(r"[ \t]+", " ", text).strip()
    except Exception as exc:
        print(f"  [warn] PDF extract failed: {exc}")
        return ""


def flowchart_links(hub_url: str) -> List[str]:
    """PDF-ish links on the hub whose href or text mentions 'flowchart'."""
    resp = fetch(hub_url)
    if resp is None or "text/html" not in resp.headers.get("Content-Type", ""):
        return []
    soup = BeautifulSoup(resp.text, "html.parser")
    links: List[str] = []
    for a in soup.find_all("a", href=True):
        blob = f"{a['href']} {a.get_text(' ', strip=True)}".lower()
        if "flowchart" not in blob:
            continue
        full = urljoin(hub_url, a["href"]).split("#")[0]
        if full not in links:
            links.append(full)
    return links[:MAX_PDFS_PER_PROGRAM]


# ---------------------------------------------------------------------------
# Scrape
# ---------------------------------------------------------------------------

def main() -> int:
    if PdfReader is None:
        print("FATAL: pypdf not installed.", file=sys.stderr)
        return 1

    docs: List[Dict[str, Any]] = []
    for cfg in CONFIGS:
        program = cfg["program"]
        print(f"[{program}]")
        urls = flowchart_links(cfg["hub"]) if cfg.get("hub") else []
        for d in cfg.get("direct", []):
            if d not in urls:
                urls.append(d)
        if not urls:
            print("  [warn] no flowchart links found on hub — add a 'direct' url.")
            continue

        # A "flowchart" link can be an HTML index page (Marriott does this):
        # recurse ONE level into it and collect its PDF links.
        expanded: List[str] = []
        for url in urls:
            if url in expanded:
                continue
            head = fetch(url)
            if head is None:
                continue
            ctype = head.headers.get("Content-Type", "")
            if "pdf" in ctype or head.content[:5].startswith(b"%PDF"):
                expanded.append(url)
            elif "text/html" in ctype and url != cfg.get("hub"):
                soup = BeautifulSoup(head.text, "html.parser")
                for a in soup.find_all("a", href=True):
                    blob = f"{a['href']} {a.get_text(' ', strip=True)}".lower()
                    if "flowchart" in blob:
                        full = urljoin(url, a["href"]).split("#")[0]
                        if full != url and full not in expanded:
                            expanded.append(full)
            time.sleep(DELAY)

        added = 0
        for url in expanded[:MAX_PDFS_PER_PROGRAM]:
            time.sleep(DELAY)
            resp = fetch(url)
            if resp is None:
                continue
            ctype = resp.headers.get("Content-Type", "")
            if "pdf" not in ctype and not resp.content[:5].startswith(b"%PDF"):
                print(f"  [skip] not a PDF ({ctype.split(';')[0]}): {url}")
                continue
            text = pdf_text(resp)
            if len(text) < 300:
                print(f"  [skip] no extractable text: {url}")
                continue
            added += 1
            suffix = "" if added == 1 else f" (additional sheet {added})"
            name = f"{program} Official Major Flowchart{suffix}"
            docs.append({
                "id": f"{SOURCE}::{slug(program)}{'' if added == 1 else f'-{added}'}",
                "source": SOURCE,
                "type": "flowchart",
                "name": name,
                "url": url,
                "text": (
                    f"{name} -- the department's official recommended "
                    f"semester-by-semester course sequence for the {program} "
                    f"major (which classes to take which year/semester, "
                    f"offering seasons, prerequisite ordering, junior core "
                    f"timing). Prefer this layout when advising on sequencing.\n"
                    f"{text}"
                )[:MAX_TEXT_CHARS],
            })
            print(f"  + {name}  ({len(text)} chars)  <- {url.rsplit('/', 1)[-1]}")

    if not docs:
        print("FATAL: 0 flowcharts scraped.", file=sys.stderr)
        return 1

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(docs, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nWrote {len(docs)} flowchart documents -> {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
