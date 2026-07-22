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

# $-anchored: the header must BE the line ("1st Semester") — prose that
# mentions a semester ("...1st Semester professional sequence to start...",
# "(taken 3rd semester) 3.0") must not restart the term counter. reflow puts
# every real header on its own line, so anchoring is safe.
SEM_RE = re.compile(r"^\s*(\d)\s*(?:st|nd|rd|th)\s+Semester\s*$", re.I)
SPRING_RE = re.compile(
    r"^\s*Spring\s*/\s*Summer\s*$|^\s*(?:Spring|Summer)\s+Term\b", re.I)
# Some sheets (Psychology) jump straight from "FRESHMAN YEAR" into course
# lines with no "1st Semester" header — the YEAR header primes the semester.
YEAR_RE = re.compile(r"^\s*(FRESHMAN|SOPHO?MORE|JUNIOR|SENIOR)\s+YEAR", re.I)
YEAR_SEM = {"FRESHMAN": 1, "SOPHOMORE": 3, "SOPHMORE": 3, "JUNIOR": 5, "SENIOR": 7}

CODE_PAT = r"[A-Z][A-Z&\s]{0,8}?\s\d{3}[A-Z]?R?"
# "BIO 130 4.0" / "A HTG 100 3.0" / "*EL ED 310 2.0" (concurrent-with-practicum
# marker) / "EL ED 410* 1.0" / "EL ED 443 (GE-Letters)* 3.0" /
# "EL ED 299R 3.0v" (v = variable credit) / "NEURO 455R 0.5"
COURSE_RE = re.compile(
    rf"^\s*\*?\s*({CODE_PAT})\s*\*?\s*(?:\([^)]*\))?\s*\*?\s+(\d+(?:\.\d+)?)\s*v?\s*$"
)
# "EL ED 400R or 496R 12.0" / "BIO 100 or PHY S 100 3.0" — a same-slot CHOICE:
# hint EVERY alternative to this term (whichever the student takes, the year
# guidance holds). Dropping these orphaned EL ED 400R and let student teaching
# float into the freshman year.
OR_RE = re.compile(
    rf"^\s*\*?\s*({CODE_PAT})\s*\*?\s+or\s+((?:{CODE_PAT})|\d{{3}}[A-Z]?R?)\s*\*?"
    rf"\s*(?:\([^)]*\))?\s*\*?\s+(\d+(?:\.\d+)?)\s*v?\s*$")
# "CHEM 106 & 107 4.0" / "MUSIC 193, 195, 197 (FSp) 4.5" — an AND-LIST of
# REQUIRED courses on one line (take ALL, sharing the credit). These are NOT a
# choose-slot: without splitting them into coded courses the whole line became a
# single placeholder that mis-bound to an unrelated elective bucket AND the real
# required courses lost their sheet pin (Exercise Sci CHEM 106/107 drifted to
# senior year). A trailing digit inheriting the previous dept ("... 195, 197")
# is a bare course number. An "or" list is a CHOICE (OR_RE above), not this.
ANDLIST_RE = re.compile(
    rf"^\s*\*?\s*({CODE_PAT})((?:\s*(?:,|&|and)\s*(?:(?:{CODE_PAT})|\d{{3}}[A-Z]?R?)\s*\*?)+)"
    rf"\s*(?:\([^)]*\))?\s+(\d+(?:\.\d+)?)\s*v?\s*$", re.I)
_ANDLIST_TOK = re.compile(rf"{CODE_PAT}|\d{{3}}[A-Z]?R?", re.I)


def andlist_codes(m) -> list:
    """AND-list line -> resolved course codes, bare numbers inheriting the
    previous department ("MUSIC 193, 195, 197" -> MUSIC 193/195/197)."""
    first = re.sub(r"\s+", " ", m.group(1)).strip().upper()
    codes = [first]
    dept = first.rsplit(" ", 1)[0]
    for tok in _ANDLIST_TOK.findall(m.group(2)):
        tok = re.sub(r"\s+", " ", tok).strip().upper()
        if re.match(r"^\d", tok):
            codes.append(f"{dept} {tok}")
        else:
            codes.append(tok)
            dept = tok.rsplit(" ", 1)[0]
    return list(dict.fromkeys(codes))
# lines that look like courses but are placeholders -> skip
SKIP_RE = re.compile(r"\bor\b|elective|cornerstone|writing|course\b|hours|total", re.I)
# "(not required)" / "(optional)" / "(recommended)" annotations -> skip
OPTIONAL_RE = re.compile(r"\(\s*(?:not\s+required|optional|recommended)", re.I)
# admission anchor: "Apply to the program during this semester." — the sheet
# tells us exactly when a limited-enrollment major expects the application
APPLY_RE = re.compile(
    r"\bapply\s+(?:to|for)\s+(?:the\s+)?(?:program|major|degree|admission)", re.I)


# "Total Hours 15.0" at the end of each semester block — the sheet's declared
# per-term load, kept for shaping/validating MAP-first plans
TOTAL_RE = re.compile(r"^\s*Total\s+Hours\s+(\d+(?:\.\d+)?)", re.I)
# placeholder line = anything ending in a credit value that isn't a coded
# course. Accepts range credits ("CELL 210 or 220 3-4.0") — without the range
# the whole line silently vanished (Dietetics' anatomy requirement).
SLOT_RE = re.compile(r"^\s*\*?\s*(.+?)\s+(\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?)\s*v?\s*$")
# prose guard: sentence-y lines that happen to end with a number aren't slots.
# "should be taken / once in semester / taken twice" catches wrapped advice
# sentences ("NEURO 455R should be taken twice; once in semester 3, ...") whose
# trailing digit would otherwise read as a credit value.
SLOT_GUARD_RE = re.compile(
    r"\b(see|apply|visit|must|http|www\.|note:|deadline|advisement|center|contact"
    r"|should be taken|taken twice|once in semester)\b", re.I)
# GE category names as MAP sheets write them (with or without a "GE -" prefix)
GE_RE = re.compile(
    r"american heritage|first.?year writing|civilization|civ\s*[12]|languages of learning"
    r"|quantitative reasoning|biological science|physical science|social science"
    r"|global\W{0,3}cultural|global\s+and\s+cultural|adv(?:anced)?\W+writ|adv\W+writing|arts or letters"
    r"|^arts\b|^letters\b|oral comm", re.I)


def classify_slot(label: str):
    """A non-coded MAP line -> slot kind. Religion/GE/elective slots map onto
    the planner's University-Core machinery; anything else named ('PSYCH
    elective (req 7)', 'Requirement 4 research course') is a major slot."""
    low = label.lower()
    if "religion" in low and "cornerstone" in low:
        return "rel-corner"
    if "religion" in low:
        return "rel-elective"
    if low.startswith("ge") or GE_RE.search(label):
        return "ge"
    if re.fullmatch(r"(general\s+)?electives?(\s+course)?s?", low):
        return "elective"
    return "major"


def reflow_map_text(text: str) -> str:
    """Some PDFs extract with the whole semester table flowed onto a few long
    lines (Mathematics, Graphic Design, Illustration, ...). The parser is
    line-oriented, so those sheets lost their slots/totals and fell back to the
    legacy flat parser (which can't build the full-fidelity 'map'). Re-insert
    line breaks: before YEAR / 'Nth Semester' / 'Total Hours' headers, and
    after each decimal credit token ("3.0", "0.5", "2-3.0", "3.0v") when a new
    entry follows. Course numbers are 3-digit integers (no decimal point), so
    they never trigger the credit split. Well-formed sheets pass through
    with at most harmless extra breaks."""
    t = re.sub(r"[ \t]+(?=(?:FRESHMAN|SOPHO?MORE|JUNIOR|SENIOR)\s+YEAR\b)", "\n", text, flags=re.I)
    t = re.sub(r"[ \t]+(?=\d\s*(?:st|nd|rd|th)\s+Semester\b)", "\n", t, flags=re.I)
    t = re.sub(r"[ \t]+(?=Total\s+Hours\s+\d)", "\n", t, flags=re.I)
    t = re.sub(r"((?:\d+\s*-\s*)?\d+\.\d+v?)[ \t]+(?=[A-Z(*\d])", r"\1\n", t)
    # ...and AFTER each header, so the first entry of the term isn't glued to
    # (and swallowed with) the header line ("1st Semester First Year Writing 3.0")
    t = re.sub(r"((?:FRESHMAN|SOPHO?MORE|JUNIOR|SENIOR)\s+YEAR)[ \t]+", "\\1\n", t, flags=re.I)
    t = re.sub(r"(\d\s*(?:st|nd|rd|th)\s+Semester)[ \t]+", "\\1\n", t, flags=re.I)
    # re-join WRAPPED entries: a line with no trailing credit whose next line
    # starts lowercase is one sheet entry split across two PDF lines
    # ("CHEM 101 or equivalent general chemistry course from" / "high school
    # or junior college 3.0"). Without the join, the credit-bearing tail
    # becomes a junk slot and the real entry is lost.
    cred_end = re.compile(r"\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?v?\s*$")
    joined: list = []
    for ln in t.splitlines():
        s = ln.strip()
        if joined and s and s[0].islower() and joined[-1].strip() \
                and not cred_end.search(joined[-1]):
            joined[-1] = joined[-1].rstrip() + " " + s
        else:
            joined.append(ln)
    return "\n".join(joined)


def parse_map_text(text: str) -> dict:
    """MAP sheet text -> {
        "terms": [{year, season, courses:[{code,credits}]}],   # legacy hints (F/W)
        "map":   [{year, season, items:[...], total}],          # FULL fidelity,
                                                                # incl. Sp/Su blocks
        "admit": {"sem": N}? }
    items: {"c": code, "cr": n[, "alts": [codes]]} for coded courses,
           {"slot": kind, "label": str, "cr": n} for GE/religion/elective/major
           placeholder lines. Semester N: year = ceil(N/2), F odd / W even
    (sheets assume a Fall start)."""
    text = reflow_map_text(text)
    # ---- header pre-scan: catch alternate-track and two-column sheets ----
    # Language sheets print a SECOND semester grid ("start in GERM 201"):
    # numbering restarts once -> keep the FIRST grid (the default track).
    # Some PDFs interleave two COLUMNS line-by-line (German Studies extracts
    # 1,5,2,6,3,7,4,8) -> the content under each header is scrambled beyond
    # line-based repair: skip the full-fidelity map entirely (legacy hints
    # only, honest optimizer-fallback labeling) rather than bake a Franken-
    # sheet with 29-item "semesters".
    lines = text.splitlines()
    hdr = []
    for i, raw in enumerate(lines):
        ln = raw.strip()
        sm0 = SEM_RE.match(ln)
        ym0 = YEAR_RE.match(ln)
        if sm0:
            hdr.append((i, int(sm0.group(1))))
        elif ym0:
            hdr.append((i, YEAR_SEM[ym0.group(1).upper()]))
    descents = [k for k in range(1, len(hdr)) if hdr[k][1] < hdr[k - 1][1]]
    if len(descents) >= 2:
        return parse_map_flat(text)              # interleaved columns
    stop_line = hdr[descents[0]][0] if descents else None

    terms: dict = {}
    items: dict = {}       # (y, season) -> [item, ...]  incl. ("S") blocks
    totals: dict = {}
    sem = None
    in_spsu = False
    admit_sem = None

    def key():
        y = 1 + (sem - 1) // 2
        return (y, "S") if in_spsu else (y, "F" if sem % 2 == 1 else "W")

    def add(code: str, cred: float):
        if in_spsu:
            return                             # legacy hints stay F/W-only
        k = key()
        terms.setdefault(k, [])
        if not any(c["code"] == code for t in terms.values() for c in t):
            terms[k].append({"code": code, "credits": cred})

    def additem(it: dict):
        items.setdefault(key(), []).append(it)

    for li, raw in enumerate(lines):
        if stop_line is not None and li >= stop_line:
            break                          # alternate track — keep first grid
        line = raw.strip()
        # strip footnote markers glued to course codes ("NDFS 100*+ 3.0",
        # "CELL 305+", "STAT 121*+") — they broke COURSE_RE, so the course
        # became an unpinnable SLOT and the real course floated (Dietetics'
        # NDFS 100 drifted to senior year behind the admission gate)
        line = re.sub(r"(?<=\S)[*+]+(?=\s|$)", "", line)
        m = SEM_RE.match(line)
        if m:
            sem = int(m.group(1))
            in_spsu = False
            continue
        ym = YEAR_RE.match(line)
        if ym:
            sem = YEAR_SEM[ym.group(1).upper()]
            in_spsu = False
            continue
        if SPRING_RE.match(line):
            in_spsu = True
            continue
        if sem is None or not (1 <= sem <= 8):
            continue
        tm = TOTAL_RE.match(line)
        if tm:
            totals.setdefault(key(), float(tm.group(1)))
            continue
        if not in_spsu and admit_sem is None and APPLY_RE.search(line):
            admit_sem = sem
            continue
        if OPTIONAL_RE.search(line):
            continue
        om = OR_RE.match(line)
        if om:
            c1 = re.sub(r"\s+", " ", om.group(1)).strip().upper()
            alt = re.sub(r"\s+", " ", om.group(2)).strip().upper()
            c2 = alt if not re.match(r"^\d", alt) else f"{c1.rsplit(' ', 1)[0]} {alt}"
            cred = float(om.group(3))
            if cred <= 12:
                add(c1, cred)
                add(c2, cred)
                additem({"c": c1, "alts": [c2], "cr": cred})
            continue
        alm = ANDLIST_RE.match(line)
        # "and"-joined list of REQUIRED courses -> each is a coded course pinned
        # to this term (skip if any token reads as an "or" choice, handled above)
        if alm and " or " not in line.lower():
            codes = andlist_codes(alm)
            total = float(alm.group(3))
            if len(codes) >= 2 and total <= 12:
                per = round(total / len(codes), 2)
                for cc in codes:
                    add(cc, per)
                    additem({"c": cc, "cr": per})
                continue
        cm = COURSE_RE.match(line)
        if cm and not SKIP_RE.search(re.sub(r"\([^)]*\)", "", line)):
            code = re.sub(r"\s+", " ", cm.group(1)).strip().upper()
            cred = float(cm.group(2))
            if cred <= 12:
                add(code, cred)
                additem({"c": code, "cr": cred})
            continue
        # non-coded line ending in credits -> a slot (GE / religion / elective /
        # named major requirement). This is HALF the sheet — dropping these
        # lines is why plans previously couldn't mirror the MAP.
        sm = SLOT_RE.match(line)
        if sm and not SLOT_GUARD_RE.search(line):
            label = re.sub(r"\s+", " ", sm.group(1)).strip(" -–—*")
            # range credit ("3-4.0") -> the LOWER bound (conservative load)
            cred = float(re.split(r"\s*-\s*", sm.group(2))[0])
            # real sheet credits are always decimal ("3.0", "0.5", "2-3.0"); a
            # bare integer means the "credit" is a digit from wrapped prose
            # ("... once in semester 3") — not a slot
            decimal_cred = "." in sm.group(2)
            # a label ending in a dangling conjunction is a sentence fragment
            fragment = re.search(r"\b(?:or|and|the|in|of|a|to)$", label, re.I)
            if (0 < cred <= 12 and 2 < len(label) <= 90 and decimal_cred
                    and not fragment and re.search(r"[a-zA-Z]{3}", label)):
                additem({"slot": classify_slot(label), "label": label[:60], "cr": cred})

    out = {
        "terms": [
            {"year": y, "season": s, "courses": cs}
            for (y, s), cs in sorted(terms.items()) if cs
        ]
    }
    SEAS_ORD = {"F": 0, "W": 1, "S": 2}
    mp = [
        {"year": y, "season": s, "items": its,
         **({"total": totals[(y, s)]} if (y, s) in totals else {})}
        for (y, s), its in sorted(items.items(), key=lambda kv: (kv[0][0], SEAS_ORD[kv[0][1]]))
        if its
    ]
    if mp:
        out["map"] = mp
    if not out["terms"]:
        out = {**parse_map_flat(text), **({"map": mp} if mp else {})}
    if admit_sem is not None:
        out["admit"] = {"sem": admit_sem}
    return out


FLAT_SEM_RE = re.compile(r"(\d)\s*(?:st|nd|rd|th)\s+Semester", re.I)
FLAT_COURSE_RE = re.compile(
    r"([A-Z][A-Z&]*(?:\s[A-Z&]{1,4})?\s\d{3}[A-Z]?R?)\s*\*?\s*(?:\([^)]*\))?\s*\*?\s+(\d+(?:\.\d+)?)\s*v?")


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

# Cross-program boilerplate that BYU copy-pastes into the wrong sheet: the
# Math (694420) MAP carries Marriott's "apply to BYU Marriott ... marketing
# program ... marriottschool.byu.edu" recruiting paragraph. It only pollutes
# the RAG advisor's text (plans ignore prose), but purge it from non-business
# sheets so the advisor never sources marketing text for a math question.
CONTAM_RE = re.compile(
    r"Students are encouraged to apply to BYU Marriott.*?"
    r"(?:marriottschool\.byu\.edu\S*|marketing program[^.]*\.)",
    re.I | re.S)


def sanitize_map_text(text: str, disp: str) -> str:
    d = disp.lower()
    if "marriott" not in d and "business" not in d and "marketing" not in d:
        text = CONTAM_RE.sub("", text)
    return re.sub(r"\n{3,}", "\n\n", text)


def display_name(p: dict) -> str:
    """Match generate_data.py's display naming: 'Name (BS)' when designated."""
    name = (p.get("name") or "").strip()
    desig = str(p.get("degree_designation") or "").strip()
    if desig and desig.upper() not in ("", "NONE", "PRE"):
        return f"{name} ({desig})"
    return name


def reparse() -> int:
    """--reparse: re-run the (improved) parser over the sheet text already
    cached in maps.json — no downloads, fully offline. Use after any parser
    change; prints a per-major before/after course-count diff."""
    docs = json.loads(OUT_DOCS.read_text(encoding="utf-8"))
    old_plans = json.loads(OUT_PLANS.read_text(encoding="utf-8")) if OUT_PLANS.exists() else {}
    suffix = " MAP sheet (official 8-semester plan)"
    plans = {}
    for d in docs:
        disp = d["name"][:-len(suffix)] if d["name"].endswith(suffix) else d["name"]
        plan = parse_map_text(d["text"])
        old = old_plans.get(disp) or {}
        plan["_src"] = old.get("_src", d.get("url"))
        n_old = sum(len(t["courses"]) for t in old.get("terms", []))
        n_new = sum(len(t["courses"]) for t in plan.get("terms", []))
        mark = "" if n_new == n_old else f"   {n_old} -> {n_new} courses"
        adm = f"  admit@sem{plan['admit']['sem']}" if plan.get("admit") else ""
        if mark or adm:
            print(f"[reparse] {disp}{mark}{adm}")
        plans[disp] = plan
    OUT_PLANS.write_text(json.dumps(plans, indent=1, ensure_ascii=False), encoding="utf-8")
    tot = sum(sum(len(t["courses"]) for t in p.get("terms", [])) for p in plans.values())
    n_adm = sum(1 for p in plans.values() if p.get("admit"))
    print(f"\nReparsed {len(plans)} plans ({tot} placed courses, {n_adm} admission anchors) -> {OUT_PLANS.name}")
    return 0


def main() -> int:
    if "--reparse" in sys.argv:
        return reparse()
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

    # newest record per display name (catalog carries multiple catalog years).
    # EMPHASIS records included: emphasis-based majors (ANES: Greek New
    # Testament, Communications tracks, ...) publish their own MAP sheets and
    # become selectable majors in generate_data.
    majors: dict = {}
    for p in cat["programs"]:
        if str(p.get("type")).upper() not in ("MAJOR", "EMPHASIS"):
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
                     f"center's recommended 8-semester sequence for {disp}.\n\n"
                     + sanitize_map_text(text, disp)[:30000]),
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
