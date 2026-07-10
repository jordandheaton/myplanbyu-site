#!/usr/bin/env python3
"""
sources/transfer_credit.py
==========================

Scrapes BYU's AP / IB exam credit guides and per-institution transfer guides --
the data the optimizer needs to skip prerequisites ("I got a 5 on AP Biology"
-> exact BYU course credit + GE fulfillment).

Both hubs are link pages whose guides are PDFs served at extension-less URLs:

    enrollment.byu.edu/registrar/ap-and-ib-exam-guides
        -> hub rules text + one PDF per AP exam year (2020-2027) + IB guides
    enrollment.byu.edu/transfer-team/transfer-guides
        -> hub rules text (incl. associate-degree GE waiver) + one PDF per
           feeder institution (~29 schools)

Refresh cadence: yearly (a new AP guide appears each spring; transfer guides
are updated for the current school year).

Output (shared source-document format -- see sources/README.md):
    ../data/transfer_credit.json  ->  source="transfer_credit",
    type="transfer_credit", one doc per guide + one per hub's rules.

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

import requests
from bs4 import BeautifulSoup

try:
    from pypdf import PdfReader
except ImportError:  # pragma: no cover
    PdfReader = None

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SOURCE = "transfer_credit"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / f"{SOURCE}.json"

AP_IB_HUB = "https://enrollment.byu.edu/registrar/ap-and-ib-exam-guides"
TRANSFER_HUB = "https://enrollment.byu.edu/transfer-team/transfer-guides"

HEADERS = {
    "User-Agent": (
        "myplanBYU-scraper/1.0 (+educational; contact jordandheaton@gmail.com) "
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    )
}
TIMEOUT = 60
DELAY = 0.7
MAX_TEXT_CHARS = 30000   # Pinecone metadata cap safety


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def clean(text: str) -> str:
    return re.sub(r"[ \t]+", " ", re.sub(r"\n[ \t]*", "\n", text)).strip()


def fetch(url: str) -> Optional[requests.Response]:
    for attempt in range(2):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
            if resp.status_code in (403, 429, 500, 502, 503) and attempt == 0:
                time.sleep(15)
                continue
            resp.raise_for_status()
            return resp
        except Exception as exc:
            print(f"  [warn] fetch failed {url} : {exc}")
            return None
    return None


def pdf_to_text(resp: requests.Response) -> str:
    """PDF response -> extracted text ('' on failure)."""
    if PdfReader is None:
        return ""
    try:
        reader = PdfReader(io.BytesIO(resp.content))
        return clean("\n".join((p.extract_text() or "") for p in reader.pages))
    except Exception as exc:
        print(f"  [warn] PDF extraction failed: {exc}")
        return ""


def hub_text(soup: BeautifulSoup) -> str:
    """The hub page's own rules text (how to send scores, GE waiver, ...)."""
    main = soup.find("main") or soup
    for t in main(["script", "style", "noscript", "nav", "aside"]):
        t.decompose()
    return clean(main.get_text("\n", strip=True))


# ---------------------------------------------------------------------------
# Scrape
# ---------------------------------------------------------------------------

def scrape_ap_ib() -> List[Dict[str, Any]]:
    resp = fetch(AP_IB_HUB)
    if resp is None:
        return []
    soup = BeautifulSoup(resp.text, "html.parser")
    docs: List[Dict[str, Any]] = []

    # The hub's rules: how to send scores, 3-5 score policy, etc.
    rules = hub_text(soup)
    if len(rules) > 200:
        docs.append({
            "id": f"{SOURCE}::ap-ib-rules",
            "source": SOURCE,
            "type": "transfer_credit",
            "name": "AP and IB Exam Credit: How BYU Awards Credit",
            "url": AP_IB_HUB,
            "text": (
                "AP and IB Exam Credit: How BYU Awards Credit -- BYU Registrar "
                "rules for Advanced Placement (AP) and International "
                "Baccalaureate (IB) exam credit:\n" + rules
            )[:MAX_TEXT_CHARS],
        })

    # Guide links: enrollment.byu.edu/ap-guide-<year>, ib-guide-<years>.
    # Each is a PDF equivalency table (exam + score -> BYU course credit).
    links = {}
    for a in (soup.find("main") or soup).find_all("a", href=True):
        m = re.search(r"enrollment\.byu\.edu/((ap|ib)-guide-[\d-]+)$", a["href"])
        if m:
            links[a["href"]] = m.group(1)

    for url, guide_slug in sorted(links.items(), key=lambda kv: kv[1]):
        time.sleep(DELAY)
        r = fetch(url)
        if r is None:
            continue
        text = pdf_to_text(r)
        if len(text) < 200:
            print(f"  [skip] no PDF text: {url}")
            continue
        kind = "AP (Advanced Placement)" if guide_slug.startswith("ap") else "IB (International Baccalaureate)"
        years = guide_slug.split("-guide-")[1]
        name = f"BYU {kind.split(' ')[0]} Credit Guide (exams taken {years})"
        docs.append({
            "id": f"{SOURCE}::{guide_slug}",
            "source": SOURCE,
            "type": "transfer_credit",
            "name": name,
            "url": url,
            "text": (
                f"{name} -- official BYU equivalency table for {kind} exams "
                f"taken in {years}: which exam scores earn credit for which "
                f"BYU courses and General Education requirements.\n{text}"
            )[:MAX_TEXT_CHARS],
        })
        print(f"  + {name}  ({len(text)} chars)")
    return docs


def scrape_transfer() -> List[Dict[str, Any]]:
    resp = fetch(TRANSFER_HUB)
    if resp is None:
        return []
    soup = BeautifulSoup(resp.text, "html.parser")
    docs: List[Dict[str, Any]] = []

    # Hub rules: unofficial-guide caveats + associate-degree GE waiver policy.
    rules = hub_text(soup)
    if len(rules) > 200:
        docs.append({
            "id": f"{SOURCE}::transfer-rules",
            "source": SOURCE,
            "type": "transfer_credit",
            "name": "Transfer Credit Rules and Associate Degree GE Waiver",
            "url": TRANSFER_HUB,
            "text": (
                "Transfer Credit Rules and Associate Degree GE Waiver -- BYU "
                "Transfer Team rules for how transfer courses fulfill BYU "
                "general education (GE) requirements:\n" + rules
            )[:MAX_TEXT_CHARS],
        })

    # Institution guides: Brightspot asset URLs ending "...-transfer-guide".
    links = {}
    for a in (soup.find("main") or soup).find_all("a", href=True):
        m = re.search(r"enrollment\.byu\.edu/[0-9a-f-]+/([a-z0-9-]+)-transfer-guide$", a["href"])
        if m:
            links[a["href"]] = m.group(1)

    for url, inst_slug in sorted(links.items(), key=lambda kv: kv[1]):
        time.sleep(DELAY)
        r = fetch(url)
        if r is None:
            continue
        text = pdf_to_text(r)
        if len(text) < 200:
            print(f"  [skip] no PDF text: {url}")
            continue
        institution = inst_slug.replace("-", " ").title().replace("Byu", "BYU")
        name = f"BYU Transfer Guide: {institution}"
        docs.append({
            "id": f"{SOURCE}::{inst_slug}",
            "source": SOURCE,
            "type": "transfer_credit",
            "name": name,
            "url": url,
            "text": (
                f"{name} -- which {institution} courses transfer to BYU and "
                f"fulfill BYU General Education requirements (unofficial guide, "
                f"updated for the current school year).\n{text}"
            )[:MAX_TEXT_CHARS],
        })
        print(f"  + {name}  ({len(text)} chars)")
    return docs


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    if PdfReader is None:
        print("FATAL: pypdf not installed (pip install pypdf).", file=sys.stderr)
        return 1

    docs = scrape_ap_ib()
    docs += scrape_transfer()

    if not docs:
        print("FATAL: 0 documents scraped -- page layouts may have changed.", file=sys.stderr)
        return 1

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(docs, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nWrote {len(docs)} documents -> {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
