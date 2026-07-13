#!/usr/bin/env python3
"""
maps.py  --  BYU MAP sheets (Major Academic Plan) -> data/maps.json + data/maps_plans.json
==========================================================================================

Most BYU majors publish a MAP sheet PDF on their catalog page: the college
advisement center's official 8-semester plan ("FRESHMAN YEAR / 1st Semester /
BIO 130 4.0 ..."). The coursedog program payload carries the file reference in
customFields.majorAcademicPlan; the catalog site downloads it through a
signedUrl endpoint, which this script replicates.

Unlike department flowcharts (2-D grids that need LLM extraction), MAP sheets
flatten to CLEAN linear text, so the semester plan is parsed deterministically
with regex -- no LLM cost, fully reproducible.

Outputs
    data/maps.json         RAG docs (one per major, full sheet text)
    data/maps_plans.json   {"<program display name>": {"terms":[{year,season,
                            courses:[{code,credits}]}], "_src": path}}
                           -- the same schema extract_flowchart_plans.py emits,
                           so generate_data.py merges both into solver hints.

Run (from scraper/):
    .\\.venv\\Scripts\\python.exe sources\\maps.py           # new/changed only
    .\\.venv\\Scripts\\python.exe sources\\maps.py --force   # redo all

Refresh: yearly (sheets are per curricular year).
Author: Jordan Heaton
"""

from __future__ import annotations

import io
import json
import re
import sys
import time
from pathlib import Path

import requests
from pypdf import PdfReader

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CATALOG = DATA_DIR / "catalog.json"
OUT_DOCS = DATA_DIR / "maps.json"
OUT_PLANS = DATA_DIR / "maps_plans.json"

SIGNED_URL = "https://app.coursedog.com/api/v1/byu/files/signedUrl"
BUCKET = "coursedog-static-public"

# ---------------------------------------------------------------------------
# MAP sheet text -> semester plan (deterministic)
# ---------------------------------------------------------------------------
# Sheets read: "FRESHMAN YEAR" / "1st Semester" / "BIO 130 4.0" ... A course
# line is DEPT NUM credits; placeholder lines ("Religion Cornerstone course",
# "Arts or Letters elective", "General electives 8.0") carry no course code
# and are skipped -- the planner already schedules GE/religion placeholders.

SEM_RE = re.compile(r"^\s*(\d)\s*(?:st|nd|rd|th)\s+Semester", re.I)
SPRING_RE = re.compile(r"^\s*(?:Spring|Summer)\s+Term", re.I)
# "BIO 130 4.0" / "A HTG 100 3.0" / "M COM 320 3.0" / "CS 111 3.0" /
# "BIO 364 (only taught Fall semesters) 3.0" / "NEURO 455R 0.5"
COURSE_RE = re.compile(
    r"^\s*([A-Z][A-Z&\s]{0,8}?\s\d{3}[A-Z]?R?)\s*(?:\([^)]*\))?\s+(\d+(?:\.\d+)?)\s*$"
)
# lines that look like courses but are choices/placeholders -> skip
SKIP_RE = re.compile(r"\bor\b|elective|cornerstone|writing|course\b|hours|total", re.I)


def parse_map_text(text: str) -> dict:
    """MAP sheet text -> {"terms":[{year, season, courses:[{code,credits}]}]}.
    Semester N: year = ceil(N/2), season = F for odd / W for even (sheets
    assume a Fall start). Spring/Summer blocks are skipped (optional terms)."""
    terms: dict = {}
    sem = None
    in_spsu = False
    for raw in text.splitlines():
        line = raw.strip()
        m = SEM_RE.match(line)
        if m:
            sem = int(m.group(1))
            in_spsu = False
            continue
        if SPRING_RE.match(line):
            in_spsu = True
            continue
        if sem is None or in_spsu or not (1 <= sem <= 8):
            continue
        cm = COURSE_RE.match(line)
        if not cm or SKIP_RE.search(line.split("(")[0]):
            continue
        code = re.sub(r"\s+", " ", cm.group(1)).strip().upper()
        cred = float(cm.group(2))
        if cred > 12:                      # "General electives 8.0" style noise
            continue
        key = (1 + (sem - 1) // 2, "F" if sem % 2 == 1 else "W")
        terms.setdefault(key, [])
        if not any(c["code"] == code for t in terms.values() for c in t):
            terms[key].append({"code": code, "credits": cred})
    out = {
        "terms": [
            {"year": y, "season": s, "courses": cs}
            for (y, s), cs in sorted(terms.items()) if cs
        ]
    }
    if not out["terms"]:
        out = parse_map_flat(text)   # some sheets extract as ONE long line
    return out


FLAT_SEM_RE = re.compile(r"(\d)\s*(?:st|nd|rd|th)\s+Semester", re.I)
FLAT_COURSE_RE = re.compile(
    r"([A-Z][A-Z&]*(?:\s[A-Z&]{1,4})?\s\d{3}[A-Z]?R?)\s*(?:\([^)]*\))?\s+(\d+(?:\.\d+)?)")


def parse_map_flat(text: str) -> dict:
    """Fallback for sheets whose PDF text has no line breaks (Mathematics,
    Graphic Design, ...): split the flat text on 'Nth Semester' markers and
    regex courses out of each chunk (up to its 'Total Hours' / a term break)."""
    flat = re.sub(r"\s+", " ", text)
    parts = FLAT_SEM_RE.split(flat)      # [pre, '1', chunk1, '2', chunk2, ...]
    terms: dict = {}
    seen: set = set()
    for i in range(1, len(parts) - 1, 2):
        sem = int(parts[i])
        if not (1 <= sem <= 8):
            continue
        chunk = parts[i + 1]
        # a chunk ends at its credit total or an off-track Spring/Summer block
        chunk = re.split(r"Total Hours|Spring Term|Summer Term", chunk, flags=re.I)[0]
        key = (1 + (sem - 1) // 2, "F" if sem % 2 == 1 else "W")
        for m in FLAT_COURSE_RE.finditer(chunk):
            code = re.sub(r"\s+", " ", m.group(1)).strip().upper()
            cred = float(m.group(2))
            # skip placeholder phrasing right before the code ("or A HTG 100")
            pre = chunk[max(0, m.start() - 12):m.start()].lower()
            if " or " in pre or cred > 12:
                continue
            if code in seen:
                continue
            seen.add(code)
            terms.setdefault(key, []).append({"code": code, "credits": cred})
    return {
        "terms": [
            {"year": y, "season": s, "courses": cs}
            for (y, s), cs in sorted(terms.items()) if cs
        ]
    }


# ---------------------------------------------------------------------------

def display_name(p: dict) -> str:
    """Match generate_data.py's display naming: 'Name (BS)' when designated."""
    name = (p.get("name") or "").strip()
    desig = str(p.get("degree_designation") or "").strip()
    if desig and desig.upper() not in ("", "NONE", "PRE"):
        return f"{name} ({desig})"
    return name


def main() -> int:
    force = "--force" in sys.argv
    cat = json.loads(CATALOG.read_text(encoding="utf-8"))

    old_plans = {}
    old_docs = {d["name"]: d for d in json.loads(OUT_DOCS.read_text(encoding="utf-8"))} \
        if OUT_DOCS.exists() and not force else {}
    if OUT_PLANS.exists() and not force:
        old_plans = json.loads(OUT_PLANS.read_text(encoding="utf-8"))

    session = requests.Session()
    session.headers.update({
        "User-Agent": "myplanBYU-scraper/1.0 (+educational; contact jordandheaton@gmail.com)",
        "Origin": "https://catalog.byu.edu", "Referer": "https://catalog.byu.edu/",
    })

    # newest record per display name (catalog carries multiple catalog years)
    majors: dict = {}
    for p in cat["programs"]:
        if str(p.get("type")).upper() != "MAJOR":
            continue
        files = (((p.get("_raw_summary") or {}).get("customFields")) or {}).get("majorAcademicPlan") or []
        files = [f for f in files if f.get("public") and f.get("path")]
        if not files:
            continue
        disp = display_name(p)
        pid = str(p.get("program_id") or "")
        if disp not in majors or pid > majors[disp][0]:
            majors[disp] = (pid, files[0])

    docs, plans = [], {}
    n_new = 0
    for disp, (_pid, f) in sorted(majors.items()):
        path = f["path"]
        cached = old_plans.get(disp)
        if cached and cached.get("_src") == path and cached.get("terms"):
            plans[disp] = cached
            doc = old_docs.get(f"{disp} MAP sheet (official 8-semester plan)") or old_docs.get(disp)
            if doc:
                docs.append(doc)
            print(f"[cached] {disp}")
            continue
        try:
            r = session.post(SIGNED_URL, params={
                "fileName": path, "type": "get",
                "originalName": f.get("name") or "map.pdf", "bucketName": BUCKET,
            }, timeout=30)
            r.raise_for_status()
            url = r.text.strip().strip('"')
            pdf = session.get(url, timeout=60).content
            text = "\n".join(pg.extract_text() or "" for pg in PdfReader(io.BytesIO(pdf)).pages)
        except Exception as exc:
            print(f"[FAIL] {disp}: {exc}")
            continue
        plan = parse_map_text(text)
        n_courses = sum(len(t["courses"]) for t in plan["terms"])
        plan["_src"] = path
        plans[disp] = plan
        docs.append({
            "id": f"maps::{re.sub(r'[^a-z0-9]+', '-', disp.lower()).strip('-')}",
            "source": "maps", "type": "map_sheet",
            "name": f"{disp} MAP sheet (official 8-semester plan)",
            "url": f"https://catalog.byu.edu",
            "text": ("Official MAP sheet (Major Academic Plan) -- the college advisement "
                     f"center's recommended 8-semester sequence for {disp}.\n\n" + text[:30000]),
        })
        n_new += 1
        print(f"[maps] {disp}: {n_courses} placed courses, {len(plan['terms'])} terms")
        time.sleep(0.3)

    OUT_DOCS.write_text(json.dumps(docs, indent=1, ensure_ascii=False), encoding="utf-8")
    OUT_PLANS.write_text(json.dumps(plans, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\n{len(plans)} MAP plans ({n_new} fetched) -> {OUT_PLANS.name}, {len(docs)} docs -> {OUT_DOCS.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
