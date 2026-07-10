#!/usr/bin/env python3
"""
sources/clubs.py
================

Scrapes the BYU student club directory (clubs.byu.edu) -- all ~374 registered
student organizations with meeting day/time and status. Clubs are prime
"come-to-you" data: a student asking about accounting should hear about the
Accounting Society without knowing it exists.

clubs.byu.edu is a Mendix single-page app: there is NO static HTML and no
public REST API. Data flows over Mendix's /xas/ runtime protocol, which this
scraper replicates anonymously in four steps:

    1. GET /                 -> session cookie
    2. POST /xas/ get_session_data          -> CSRF token
    3. POST /xas/ runtimeOperation CREATE_HELPER -> a FindClubHelper object
    4. POST /xas/ runtimeOperation LIST_CLUBS    -> all clubs in one response

MAINTENANCE NOTE: the two operation IDs below are constants baked into the
deployed Mendix model. They only change if BYU redeploys the app. If this
scraper suddenly returns errors or 0 clubs, re-capture the IDs: open
clubs.byu.edu -> Find an Organization in a browser with DevTools' Network tab
filtered to "xas", and copy the "operationId" values from the two POST bodies
(the helper-creation call and the club-list call, in that order).

Refresh cadence: each semester (clubs come and go with the school year).

Output (shared source-document format -- see sources/README.md):
    ../data/clubs.json  ->  one doc per active club, source="clubs", type="club"

Author: Jordan Heaton
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List

import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SOURCE = "clubs"
BASE = "https://clubs.byu.edu"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / f"{SOURCE}.json"

# Mendix model operation IDs -- see MAINTENANCE NOTE above.
OP_CREATE_HELPER = "5Vv5KGIX4FOjHUSrnRAqTA"
OP_LIST_CLUBS = "fdd/Dv0gxlKfjpw+SmiZeQ"

HEADERS = {
    "User-Agent": (
        "myplanBYU-scraper/1.0 (+educational; contact jordandheaton@gmail.com) "
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    )
}
TIMEOUT = 45


# ---------------------------------------------------------------------------
# Mendix /xas/ flow
# ---------------------------------------------------------------------------

def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def fetch_clubs() -> List[Dict[str, Any]]:
    s = requests.Session()
    s.headers.update(HEADERS)

    # 1) landing page -> session cookie
    s.get(BASE + "/", timeout=TIMEOUT).raise_for_status()

    # 2) anonymous session -> CSRF token
    r = s.post(BASE + "/xas/", json={"action": "get_session_data", "params": {}},
               timeout=TIMEOUT)
    r.raise_for_status()
    csrf = r.json().get("csrftoken")
    if not csrf:
        raise RuntimeError("no CSRF token -- Mendix protocol may have changed")
    hdr = {"X-Csrf-Token": csrf, "Content-Type": "application/json"}

    # 3) create the FindClubHelper (server returns the object + state hash)
    r = s.post(BASE + "/xas/", headers=hdr, timeout=TIMEOUT, json={
        "action": "runtimeOperation", "operationId": OP_CREATE_HELPER,
        "params": {}, "options": {}, "changes": {}, "objects": [],
    })
    r.raise_for_status()
    j = r.json()
    if not j.get("objects"):
        raise RuntimeError("helper creation returned no object -- operation ID stale? "
                           "See MAINTENANCE NOTE in this file.")
    helper = j["objects"][0]

    # 4) list every club in one call
    r = s.post(BASE + "/xas/", headers=hdr, timeout=TIMEOUT, json={
        "action": "runtimeOperation", "operationId": OP_LIST_CLUBS,
        "params": {"FindClubFilters": {"guid": helper["guid"]}},
        "options": {}, "changes": j.get("changes", {}), "objects": [helper],
    })
    r.raise_for_status()
    clubs = r.json().get("partialObjects", [])
    if not clubs:
        raise RuntimeError("club list came back empty -- operation ID stale? "
                           "See MAINTENANCE NOTE in this file.")
    return clubs


# ---------------------------------------------------------------------------
# Build documents
# ---------------------------------------------------------------------------

def club_to_doc(club: Dict[str, Any]) -> Dict[str, Any]:
    attrs = club.get("attributes", {})
    get = lambda k: (attrs.get(k, {}).get("value") or "").strip()
    name = get("Name")
    day, time_ = get("MeetingDay"), get("MeetingTime")
    status = get("Status")

    meets = ""
    if day and day.upper() != "NA":
        meets = f" Meets {day}" + (f" at {time_}." if time_ and time_.upper() != "NA" else ".")
    restricted = (
        " Membership is restricted (an application or tryout is required)."
        if "Restricted" in status else ""
    )

    return {
        "id": f"{SOURCE}::{slug(name)}",
        "source": SOURCE,
        "type": "club",
        "name": name,
        "url": BASE,
        "text": (
            f"{name} -- official BYU student club / student organization. "
            f"Joining clubs is free or low-cost and one of the best ways to build "
            f"a network, get involved, and explore a career interest.{meets}"
            f"{restricted} Find it under \"Find an Organization\" at clubs.byu.edu."
        ),
    }


def main() -> int:
    try:
        clubs = fetch_clubs()
    except Exception as exc:
        print(f"FATAL: {exc}", file=sys.stderr)
        return 1

    docs = []
    seen = set()
    for c in clubs:
        d = club_to_doc(c)
        if d["name"] and d["id"] not in seen:
            docs.append(d)
            seen.add(d["id"])

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(docs, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {len(docs)} clubs -> {OUTPUT_PATH}")
    print("Sample:", ", ".join(d["name"] for d in docs[:5]), "...")
    return 0


if __name__ == "__main__":
    sys.exit(main())
