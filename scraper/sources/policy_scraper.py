#!/usr/bin/env python3
"""
sources/policy_scraper.py
=========================

Scrapes BYU policy / funding pages: university scholarships, Marriott School
scholarships, experiential learning, and career/internship resources.

Three of the four target URLs are "hub" landing pages whose <main> is just a
menu -- the real policy text lives one level deeper. So each site is configured
either to CRAWL (follow same-domain links found in the hub's <main>, one level
deep, each subpage becoming its own document) or to SPLIT (one rich page split
into a document per <h2> section, for retrieval granularity).

Sites:
  university_scholarships  enrollment.byu.edu/financial-aid/scholarships  (crawl)
      -> deadlines, scholarship types, departmental / need-based / off-campus,
         eligibility, notifications, FAQs        type="scholarship"
  marriott_scholarships    marriott.byu.edu/financialaid/scholarships     (split)
      -> Marriott-specific funding + deadlines   type="scholarship"
  experiential_learning    experience.byu.edu                             (crawl)
      -> academic internship + experiential learning definitions and hubs
                                                 type="policy"
  careers                  careers.byu.edu                                (crawl)
      -> career center resources, internships, graduate outcomes
                                                 type="policy"

Refresh cadence: each semester (scholarship DEADLINES change every term even
when the rules don't).

Output (shared source-document format -- see sources/README.md):
    ../data/policies.json  ->  list of documents, every one source="policies"
    so `embed_and_load.py --only-sources policies` refreshes them all at once.

Author: Jordan Heaton
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SOURCE = "policies"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / f"{SOURCE}.json"

SITES: List[Dict[str, Any]] = [
    {
        "name": "university_scholarships",
        "url": "https://enrollment.byu.edu/financial-aid/scholarships",
        "type": "scholarship",
        "mode": "crawl",
        "context": "BYU university scholarships and financial aid (Enrollment Services)",
    },
    {
        "name": "marriott_scholarships",
        "url": "https://marriott.byu.edu/financialaid/scholarships/",
        "type": "scholarship",
        "mode": "split",   # one rich page -> one doc per <h2> section
        "context": "BYU Marriott School of Business scholarships and funding",
        "display": "BYU Marriott Scholarships",   # section-name prefix
    },
    {
        "name": "experiential_learning",
        "url": "https://experience.byu.edu/",
        "type": "policy",
        "mode": "crawl",
        "context": "BYU experiential learning and academic internships (Experience BYU)",
        # The student-facing internship policy (application steps, add/drop
        # deadline rules, agreements, FAQ) sits two clicks from the homepage.
        "depth": 2,
        "max_pages": 25,
        # staff/employer admin pages -- not useful to a student advisor
        "skip": r"coordinator|irams|faculty|employer|working-with|why-byu|spotlight|department-sites|need-help|managers|dashboard",
    },
    {
        "name": "careers",
        "url": "https://careers.byu.edu/",
        "type": "policy",
        "mode": "crawl",
        "context": "BYU Career Center: internships, career prep, graduate outcomes",
    },
]

HEADERS = {
    "User-Agent": (
        "myplanBYU-scraper/1.0 (+educational; contact jordandheaton@gmail.com) "
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    )
}
TIMEOUT = 45
DELAY = 0.7             # polite pause between fetches
MAX_SUBPAGES = 12       # per hub, one level deep only
MIN_TEXT_CHARS = 300    # drop menu-only / marketing-shell pages
MAX_TEXT_CHARS = 30000  # stay well under Pinecone's 40 KB metadata cap

# Boilerplate containers removed before text extraction.
STRIP_TAGS = ["script", "style", "noscript", "header", "footer", "nav", "aside", "form", "iframe", "svg"]
STRIP_CLASS_RE = re.compile(r"nav|menu|footer|header|breadcrumb|cookie|skip|social", re.I)

# Brightspot CMS leaks template attributes as literal text nodes
# ("overrideTextColor=", "data-content-type=oneOffPage", ...). Drop those lines.
JUNK_LINE_RE = re.compile(r"^\s*(?:[\w-]+=\S*|data-content-type=.*)\s*$")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def fetch(url: str) -> Optional[BeautifulSoup]:
    """GET a page (retry once on throttle/5xx); None on failure."""
    for attempt in range(2):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
            if resp.status_code in (403, 429, 500, 502, 503) and attempt == 0:
                print(f"    [retry] HTTP {resp.status_code}; waiting 15s...")
                time.sleep(15)
                continue
            resp.raise_for_status()
            # Brightspot serves images/PDFs at extension-less URLs -- without
            # this check a PNG "page" becomes 400 KB of binary garbage text.
            ctype = resp.headers.get("Content-Type", "")
            if "text/html" not in ctype:
                print(f"    [skip] non-HTML ({ctype.split(';')[0]}): {url}")
                return None
            return BeautifulSoup(resp.text, "html.parser")
        except Exception as exc:
            print(f"    [warn] fetch failed {url} : {exc}")
            return None
    return None


def clean_text(el) -> str:
    """Element -> dense text: junk lines dropped, whitespace collapsed."""
    lines = []
    for line in el.get_text("\n", strip=True).splitlines():
        line = re.sub(r"[ \t]+", " ", line).strip()
        if line and not JUNK_LINE_RE.match(line):
            lines.append(line)
    # collapse runs of duplicate lines (repeated menus render twice on some pages)
    out: List[str] = []
    for line in lines:
        if not out or out[-1] != line:
            out.append(line)
    return "\n".join(out)


def main_content(soup: BeautifulSoup):
    """The page's content area with boilerplate chrome stripped out.

    Pick <main> FIRST, then strip inside it -- BYU's Brightspot theme puts
    classes like "header-large" on <body> itself, so stripping by class on the
    whole document would decompose the entire page.
    """
    root = soup.find("main") or soup.body or soup
    for t in root(STRIP_TAGS):
        t.decompose()
    for t in root.find_all(attrs={"class": STRIP_CLASS_RE}):
        t.decompose()
    for t in root.find_all(attrs={"id": STRIP_CLASS_RE}):
        t.decompose()
    return root


def page_title(soup: BeautifulSoup, fallback: str) -> str:
    h1 = soup.find("h1")
    if h1 and h1.get_text(strip=True):
        return h1.get_text(" ", strip=True)
    if soup.title and soup.title.get_text(strip=True):
        # "Applying for Scholarships | BYU Enrollment Services" -> left part
        return soup.title.get_text(strip=True).split("|")[0].strip()
    return fallback


def make_doc(site: Dict[str, Any], url: str, name: str, body: str) -> Dict[str, Any]:
    return {
        "id": f"{SOURCE}::{site['name']}::{slug(name)}",
        "source": SOURCE,
        "type": site["type"],
        "name": name,
        "url": url,
        # Lead with the name + site context so each page embeds distinctly.
        "text": f"{name} -- {site['context']}.\n{body}"[:MAX_TEXT_CHARS],
    }


# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------

def hub_links(soup: BeautifulSoup, base_url: str, skip_re: Optional[re.Pattern]) -> List[str]:
    """Same-domain content links from a page's <main>, deduped, in order."""
    base_host = urlparse(base_url).netloc
    main = soup.find("main") or soup
    links: List[str] = []
    for a in main.find_all("a", href=True):
        href = urljoin(base_url, a["href"]).split("#")[0].rstrip("/")
        p = urlparse(href)
        if p.netloc != base_host or not p.path or p.path == "/":
            continue
        if re.search(r"\.(pdf|jpg|png|docx?|xlsx?)$", p.path, re.I):
            continue
        if skip_re and skip_re.search(p.path):
            continue
        if href not in links and href != base_url.rstrip("/"):
            links.append(href)
    return links


def scrape_crawl(site: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Hub page + same-domain pages it links to, breadth-first to site depth.

    depth=1 (default): hub + directly linked pages. depth=2: also the pages
    THOSE link to -- needed where the policy text sits two clicks in (e.g.
    experience.byu.edu). Thin menu/marketing pages are dropped either way.
    """
    max_depth = site.get("depth", 1)
    max_pages = site.get("max_pages", MAX_SUBPAGES)
    skip_re = re.compile(site["skip"], re.I) if site.get("skip") else None

    docs: List[Dict[str, Any]] = []
    queue: List[tuple] = [(site["url"].rstrip("/"), 0)]
    visited: set = set()

    while queue and len(visited) <= max_pages:
        url, depth = queue.pop(0)
        if url in visited:
            continue
        visited.add(url)

        if depth > 0:
            time.sleep(DELAY)
        soup = fetch(url)
        if soup is None:
            continue

        # Enqueue children before main_content() mutates the tree.
        if depth < max_depth:
            for link in hub_links(soup, site["url"], skip_re):
                if link not in visited:
                    queue.append((link, depth + 1))

        name = page_title(soup, url.rsplit("/", 1)[-1].replace("-", " ").title())
        body = clean_text(main_content(soup))
        if len(body) < MIN_TEXT_CHARS:
            print(f"    [skip] thin page ({len(body)} chars): {url}")
            continue
        docs.append(make_doc(site, url, name, body))
        print(f"    + {name}  ({len(body)} chars)")
    return docs


def scrape_split(site: Dict[str, Any]) -> List[Dict[str, Any]]:
    """One rich page -> a document per <h2> section (better retrieval granularity)."""
    soup = fetch(site["url"])
    if soup is None:
        return []
    title = site.get("display") or page_title(soup, site["name"])
    content = main_content(soup)

    docs: List[Dict[str, Any]] = []
    for h2 in content.find_all("h2"):
        section = h2.get_text(" ", strip=True)
        if not section:
            continue
        parts: List[str] = []
        for sib in h2.find_next_siblings():
            if sib.name == "h2":
                break
            text = clean_text(sib) if hasattr(sib, "get_text") else ""
            if text:
                parts.append(text)
        body = "\n".join(parts)
        if len(body) < 80:   # heading with no real content
            continue
        name = f"{title}: {section}"
        docs.append(make_doc(site, site["url"], name, body))
        print(f"    + {name}  ({len(body)} chars)")
    return docs


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    all_docs: List[Dict[str, Any]] = []
    for site in SITES:
        print(f"[{site['name']}] {site['url']}  (mode={site['mode']})")
        docs = scrape_crawl(site) if site["mode"] == "crawl" else scrape_split(site)
        if not docs:
            print(f"    [warn] no documents from {site['name']}")
        all_docs.extend(docs)
        time.sleep(DELAY)

    if not all_docs:
        print("FATAL: 0 documents scraped -- page layouts may have changed.", file=sys.stderr)
        return 1

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(all_docs, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nWrote {len(all_docs)} policy documents -> {OUTPUT_PATH}")
    for d in all_docs:
        print(f"  [{d['type']}] {d['name']}  ({len(d['text'])} chars)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
