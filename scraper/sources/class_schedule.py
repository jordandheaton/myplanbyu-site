#!/usr/bin/env python3
"""
sources/class_schedule.py
=========================

Scrapes BYU's PUBLIC class schedule -- the one piece of course data the planner
structurally could not know. The catalog says a course exists and what it
requires; only the class schedule says WHO TEACHES IT, and that is the question
students actually ask when choosing between two ways to fill a slot.

Source:
    https://commtech.byu.edu/noauth/classSchedule/    (no login, no API key)

The page is a thin shell over one AJAX endpoint. Its own search box posts a
jQuery-serialised object to ajax/getClasses.php, and OMITTING the catalog
number returns the department's entire term at once -- 187 requests covers the
university instead of ~7,000. The response already carries everything we need,
including `curriculum_id`/`title_code` (BYU's internal ids) and a `sections`
array with `instructor_name`.

Politeness / permission:
  * robots.txt Disallow lists /noauth/courseInformation/ and NOT
    /noauth/classSchedule/ -- they curate this, and our path is permitted.
  * 187 requests once a week, throttled to ~2.5/second, with a descriptive
    User-Agent. Measured cost of a full term: ~110 seconds.
  * `sessionId` is accepted but NOT enforced; we send a constant rather than
    scraping a real session, which would be pretending to be a browser.

WHAT WE KEEP, AND WHY IT IS SMALL
Instructor names repeat enormously (one professor teaches many sections and
many courses), so names go in a deduplicated table and each course holds
integer indices into it. That is what keeps a university's worth of teaching
assignments to a couple of hundred KB of JavaScript.

We keep only courses that exist in OUR catalog -- the planner can never show a
course it cannot schedule -- and only terms BYU still lists as current. Roughly
58% of catalog courses are covered by the Fall+Winter pair; the rest simply are
not taught in the terms currently posted, which the UI has to say plainly
rather than imply the course has no instructor.

Refresh cadence: weekly (refresh_core.ps1). Registration-period churn is real:
sections get added, cancelled and reassigned right up to the first week.

Output (shared source-document format -- see sources/README.md):
    ../data/class_schedule.json

Author: Jordan Heaton
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import requests

SOURCE = "class_schedule"
BASE = "https://commtech.byu.edu/noauth/classSchedule"
INDEX_URL = f"{BASE}/index.php"
AJAX_URL = f"{BASE}/ajax/getClasses.php"

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
CATALOG_JS = HERE.parent.parent / "js" / "catalog_data.js"

# BYU year-term code: YYYY + season digit.
SEASON_DIGIT = {"W": "1", "S": "3", "U": "4", "F": "5"}
SEASON_NAME = {"1": "Winter", "3": "Spring", "4": "Summer", "5": "Fall"}

# Politeness. 0.4s between requests puts a full sweep near two minutes, which
# is nothing next to a weekly cadence, and keeps us well under any rate a
# human clicking the same search box would produce.
DELAY_S = 0.4
TIMEOUT_S = 30
RETRIES = 3

UA = ("myplanBYU/1.0 (BYU student degree-planning project; "
      "https://jordanheaton.com; jordandheaton@gmail.com)")


def session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": UA,
        "X-Requested-With": "XMLHttpRequest",
        "Referer": INDEX_URL,
    })
    return s


def fetch_departments(s: requests.Session) -> List[str]:
    """The department list is a JS literal in index.php, so it self-updates."""
    html = s.get(INDEX_URL, timeout=TIMEOUT_S).text
    m = re.search(r"_department_map\s*=\s*(\{.*?\});", html, re.S)
    if not m:
        raise RuntimeError(
            "could not find _department_map in index.php -- the page changed. "
            "Open the class schedule, view source, and look for the department "
            "lookup the search box uses.")
    return sorted(set(json.loads(m.group(1)).values()))


def fetch_department(s: requests.Session, dept: str, yearterm: str) -> Dict[str, Any]:
    """One department, one term. Empty dict when the term has no such classes.

    The endpoint speaks jQuery's nested form encoding, NOT a JSON body: posting
    `searchObject` as a JSON string returns a PHP "Illegal string offset" stack
    trace rather than an error status.
    """
    payload = {
        "searchObject[yearterm]": yearterm,
        "searchObject[dept_name_or_keyword][dept]": dept,
        "searchObject[dept_name_or_keyword][keyword]": dept,
        "sessionId": "AAAAAAAAAAAAAAAAAAAA",
    }
    for attempt in range(RETRIES):
        try:
            r = s.post(AJAX_URL, data=payload, timeout=TIMEOUT_S)
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code}")
            body = r.text.strip()
            if not body or body[0] not in "{[":
                raise RuntimeError(f"non-JSON body: {body[:120]}")
            return r.json() or {}
        except Exception as exc:            # noqa: BLE001 - retry anything transient
            if attempt == RETRIES - 1:
                print(f"  ! {dept} {yearterm}: {exc}", file=sys.stderr)
                return {}
            time.sleep(1.5 * (attempt + 1))
    return {}


def catalog_codes() -> set:
    """Course codes the planner actually knows about."""
    if not CATALOG_JS.exists():
        print(f"  ! {CATALOG_JS} missing -- keeping every course", file=sys.stderr)
        return set()
    txt = CATALOG_JS.read_text(encoding="utf-8")
    return set(re.findall(r'"([A-Z][A-Z& ]{0,6}\s\d{3}[A-Z]?)"', txt))


def live_terms(s: requests.Session, count: int = 4) -> List[str]:
    """Terms BYU currently lists, newest first.

    The <option> list is injected by JavaScript, so it cannot be read out of
    the HTML -- but the codes are formulaic, so probe instead: ask each
    candidate for one big department and keep the ones that answer with data.
    Probing is also the only honest test of "does BYU have this term posted
    yet", which is exactly the question the UI needs answered.
    """
    from datetime import date
    today = date.today()
    cands: List[str] = []
    for year in (today.year + 1, today.year, today.year - 1):
        for season in "FUSW":                       # Fall, Summer, Spring, Winter
            cands.append(f"{year}{SEASON_DIGIT[season]}")
    found = []
    for yt in cands:
        if len(found) >= count:
            break
        got = fetch_department(s, "REL A", yt)       # every term has religion
        time.sleep(DELAY_S)
        if got:
            found.append(yt)
    return found


def term_label(yt: str) -> str:
    return f"{SEASON_NAME.get(yt[4], '?')} {yt[:4]}"


def past_fw_terms(live: List[str], count: int) -> List[str]:
    """The most recent Fall/Winter terms BEFORE the earliest live one.

    Only Fall and Winter: Spring and Summer are taught by a much smaller and
    less representative slice of faculty, so including them would make "who
    usually teaches this" noisier, not better. The archive runs to 2002; four
    terms (two years) is the useful window — further back and the answer starts
    describing faculty who have retired or moved on.
    """
    floor = min(int(t) for t in live) if live else 99999
    out: List[str] = []
    year = floor // 10
    while len(out) < count and year > 2015:
        for season in ("5", "1"):                    # Fall then Winter of that year
            yt = f"{year}{season}"
            if int(yt) < floor and len(out) < count:
                out.append(yt)
        year -= 1
    return out


def scrape(limit_terms: int = 4, history_terms: int = 4) -> Dict[str, Any]:
    s = session()
    depts = fetch_departments(s)
    terms = live_terms(s, limit_terms)
    if not terms:
        raise RuntimeError("no live terms answered -- the endpoint or codes changed")
    print(f"{len(depts)} departments; terms: {[term_label(t) for t in terms]}")

    ours = catalog_codes()
    names: List[str] = []
    name_idx: Dict[str, int] = {}

    def intern(n: str) -> int:
        if n not in name_idx:
            name_idx[n] = len(names)
            names.append(n)
        return name_idx[n]

    by_term: Dict[str, Dict[str, List[int]]] = {}
    for yt in terms:
        t0 = time.time()
        courses: Dict[str, List[int]] = {}
        for dept in depts:
            for _, c in fetch_department(s, dept, yt).items():
                code = f"{c.get('dept_name','')} {c.get('catalog_number','')}" \
                       f"{c.get('catalog_suffix') or ''}".strip()
                if ours and code not in ours:
                    continue
                seen, idx = set(), []
                for sec in c.get("sections") or []:
                    n = (sec.get("instructor_name") or "").strip()
                    # "TBA"/blank is the schedule saying it does not know yet;
                    # showing it as a name would be worse than showing nothing.
                    if not n or n.upper() in {"TBA", "TBD", "STAFF"} or n in seen:
                        continue
                    seen.add(n)
                    idx.append(intern(n))
                # A course can appear under several departments' keyword
                # matches; keep whichever listing names the most instructors.
                if idx and len(idx) > len(courses.get(code, [])):
                    courses[code] = idx
            time.sleep(DELAY_S)
        by_term[yt] = courses
        print(f"  {term_label(yt)}: {len(courses)} courses "
              f"({int(time.time()-t0)}s)")

    covered = set()
    for c in by_term.values():
        covered |= set(c)

    # ---- HISTORY: who USUALLY teaches the courses BYU has not posted -------
    # A student planning four years out is mostly looking at courses no live
    # term lists, and "no data" is a poor answer when the archive has taught
    # the same course eight times. So sweep past Fall/Winter terms and count
    # how often each instructor appears.
    #
    # Kept ONLY for codes missing from the live terms — that is precisely when
    # the UI falls back to it, and storing history for courses we can already
    # answer exactly would roughly double the payload to say nothing new.
    historic: Dict[str, List[List[int]]] = {}
    hist_terms: List[str] = []
    if history_terms > 0:
        counts: Dict[str, Dict[int, int]] = {}
        for yt in past_fw_terms(terms, history_terms):
            t0 = time.time()
            hits = 0
            for dept in depts:
                for _, c in fetch_department(s, dept, yt).items():
                    code = f"{c.get('dept_name','')} {c.get('catalog_number','')}" \
                           f"{c.get('catalog_suffix') or ''}".strip()
                    if code in covered or (ours and code not in ours):
                        continue
                    bucket = counts.setdefault(code, {})
                    seen = set()
                    for sec in c.get("sections") or []:
                        n = (sec.get("instructor_name") or "").strip()
                        if not n or n.upper() in {"TBA", "TBD", "STAFF"} or n in seen:
                            continue
                        seen.add(n)
                        # count TERMS taught, not sections: a professor with six
                        # sections of one class is not six times as likely to be
                        # the one teaching it next year.
                        bucket[intern(n)] = bucket.get(intern(n), 0) + 1
                    hits += 1
                time.sleep(DELAY_S)
            hist_terms.append(yt)
            print(f"  [history] {term_label(yt)}: {hits} unlisted courses "
                  f"({int(time.time()-t0)}s)")
        for code, bucket in counts.items():
            top = sorted(bucket.items(), key=lambda kv: (-kv[1], names[kv[0]]))[:5]
            historic[code] = [[i, n] for i, n in top]

    return {
        "source": SOURCE,
        "url": INDEX_URL,
        "scraped": time.strftime("%Y-%m-%d"),
        "terms": [{"code": yt, "label": term_label(yt)} for yt in terms],
        "historyTerms": [{"code": yt, "label": term_label(yt)} for yt in hist_terms],
        "instructors": names,
        "byTerm": by_term,
        "historic": historic,
        "stats": {
            "catalogCodes": len(ours),
            "covered": len(covered),
            "coverage": round(100 * len(covered) / len(ours), 1) if ours else None,
            "historic": len(historic),
            "coverageWithHistory": round(
                100 * len(covered | set(historic)) / len(ours), 1) if ours else None,
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--terms", type=int, default=4,
                    help="how many currently-listed terms to pull (default 4)")
    ap.add_argument("--history", type=int, default=4,
                    help="past Fall/Winter terms to sweep for courses BYU has "
                         "not posted yet (default 4 = two years; 0 to skip)")
    ap.add_argument("--out", default=str(DATA / "class_schedule.json"))
    args = ap.parse_args()

    try:
        doc = scrape(args.terms, args.history)
    except Exception as exc:                        # noqa: BLE001
        print(f"class_schedule: FAILED -- {exc}", file=sys.stderr)
        return 1

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1), encoding="utf-8")
    st = doc["stats"]
    print(f"wrote {out}  ({out.stat().st_size/1024:.0f} KB)  "
          f"{len(doc['instructors'])} instructors, "
          f"{st['covered']}/{st['catalogCodes']} posted ({st['coverage']}%)"
          f" + {st['historic']} from history -> {st['coverageWithHistory']}% total")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
