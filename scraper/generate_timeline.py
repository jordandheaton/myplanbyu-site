"""Bake js/timeline_data.js — the deadline & opportunity layer for the plan board.

All sources are LOCAL files (no network, no API keys):
  data/academic_dates.json               -> per-term start/end + add-drop/withdraw
  data/catalog.json                      -> per-MAJOR admission requirement notes
                                            (limited-enrollment language) + colleges
  data/study_abroad.json                 -> Kennedy Center programs + term/cost,
                                            college-tagged via sources/opportunity_tags
  ../../BYU Scholarship Matcher/data.js  -> curated scholarship deadlines
                                            ({month, day}, college keys, urls)

Output: js/timeline_data.js defining a single `TIMELINE` global consumed by
app.js to draw per-term deadline chips + the Deadlines & Opportunities panel,
and folded into the AI advisor's plan context.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE / "sources"))
import opportunity_tags as optags                       # noqa: E402
from generate_data import slugify                       # noqa: E402

DATA = HERE / "data"
OUT = HERE.parent / "js" / "timeline_data.js"
SCHOL_JS = HERE.parent.parent / "BYU Scholarship Matcher" / "data.js"

SEASON = {"winter": "W", "spring": "S", "summer": "U", "fall": "F"}

# ---------------------------------------------------------------------------
# CURATED admission requirements — transcribed from each program's OWN online
# admission page (not inferred from the plan). Keyed by RUNTIME program id
# (the id the app uses at solve time: catalog majors are "major-<slug>", the
# hand-curated IS majors in data.js are "is-bs" / "is-bs-mism"). Shape:
#   prereqs  — the exact prerequisite courses the application requires
#   criteria — GPA / grade / deadline / experience / portfolio requirements
#   note     — one-line framing; url — the source page to "see full details".
# Verified 2026-07-22. When a program has no entry here, the app falls back to
# the catalog admission sentence + a "confirm with the department" pointer
# (NOT a guessed course list).
# ---------------------------------------------------------------------------
ADMISSION_REQS = {
    "major-nursing-bs": {
        "note": "Competitive limited-enrollment major (~64 seats/cohort); apply after the prerequisite year.",
        "prereqs": ["CHEM 285 — Bio-Organic Chemistry", "NDFS 100 — Essentials of Human Nutrition",
                    "CELL 220 (or CELL 210) — Human Anatomy",
                    "SFL 210 (or PSYCH 220) — Human Development"],
        "criteria": ["Complete a minimum of 16 hours from the University Core before applying.",
                     "Competitive GPA in the prerequisites; acceptance is not guaranteed by minimums alone."],
        "url": "https://nursing.byu.edu/prospective-students",
    },
    "major-dietetics-bs": {
        "note": "Holistic, limited-enrollment admission (~40 students/year); apply by Feb 15 for a fall start.",
        "prereqs": ["CHEM 285 — Bio-Organic Chemistry", "CHEM 101 or 105 — General Chemistry",
                    "CELL 210 or 220 — Human Anatomy", "CELL 305 — Human Physiology",
                    "MMBIO 221 + 222 — General Microbiology", "NDFS 100 — Essentials of Human Nutrition",
                    "NDFS 200 — Nutrient Metabolism", "NDFS 250 + 251 — Essentials of Food Science",
                    "NDFS 290 — Intro to Dietetics", "STAT 121 — Principles of Statistics"],
        "criteria": ["At least 4 prerequisite courses done at time of application; all done before the professional sequence.",
                     "Major & cumulative GPA above 3.0; NDFS grades above B-.",
                     "≥150 hours of dietetics-related work/volunteer experience.",
                     "Personal statement, two letters of recommendation, and a faculty interview."],
        "url": "https://ndfs.byu.edu/dietetics/dpd-admission-requirements-and-process",
    },
    "major-elementary-education-bs": {
        "note": "Apply to the major after the pre-major courses; two admission rounds a year (Feb 15 and Oct 1).",
        "prereqs": ["SFL 210 — Human Development", "EL ED 200 — Introduction to Education"],
        "criteria": ["Declare the Elementary Education pre-major and attend a program orientation.",
                     "Submit the online Program Entrance Application (Educator Preparation & Licensure System).",
                     "Maintain a 2.7+ total GPA; C or better in every education, major, and minor course."],
        "url": "https://education.byu.edu/advisement/program_entrance_application",
    },
    "major-accounting-bs": {
        "note": "Junior Core is a competitive, limited-enrollment application (School of Accountancy).",
        "prereqs": ["ACC 200 — Principles of Accounting", "ACC 310 — Principles of Accounting 2",
                    "FIN 201 — Managerial Finance", "MKTG 201 — Marketing Management",
                    "IS 201 — Intro to Information Systems"],
        "criteria": ["Prerequisite GPA of 3.0 to apply (admitted median ~3.9); ACC 310 weighted most heavily.",
                     "Apply online to the School of Accountancy; deadline is the last business day of June.",
                     "Historically 50–75% of applicants are admitted."],
        "url": "https://marriott.byu.edu/acc/admissions/bs-acc/admission-criteria/",
    },
    "major-finance-bs": {
        "note": "Highly competitive, limited-enrollment major; all prerequisites done before the June deadline.",
        "prereqs": ["ACC 200 — Principles of Accounting", "ACC 310 — Principles of Accounting 2",
                    "IS 201 — Intro to Information Systems",
                    "6 credits from: ECON 110, FIN 201, GSCM 201/211, IS 303, MKTG 201, or STAT 121"],
        "criteria": ["Applications below a 3.0 prerequisite GPA are not considered.",
                     "Weighted GPA (prereq, last 30 hrs, BYU, overall) — over half the weight on the prereq GPA.",
                     "Application: four GPA measures, current resume, essay, and transcripts.",
                     "Deadline: last business day of June."],
        "url": "https://marriott.byu.edu/bsfin/",
    },
}
# Both IS tracks share the Information Systems admission criteria.
_IS_REQS = {
    "note": "Competitive, limited-enrollment major (Junior Core); prerequisites must be done before the deadline.",
    "prereqs": ["ACC 200 — Principles of Accounting", "IS 201 — Intro to Management Information Systems",
                "IS 303 or C S 111 — Intro to Programming"],
    "criteria": ["Minimum 3.0 GPA across the prerequisite courses.",
                 "A grade below B in IS 201 and/or IS 303 is not accepted.",
                 "Transferred or repeated prerequisites are discounted by 0.3 (e.g., A → A-).",
                 "Deadline: last business day of June, 4:30 p.m. — all prereq grades must be posted."],
    "url": "https://marriott.byu.edu/infosys/admissions/bsis/admission-criteria/",
}
ADMISSION_REQS["is-bs"] = _IS_REQS
ADMISSION_REQS["is-bs-mism"] = _IS_REQS

# Scholarship-matcher college keys -> the same canonical names opportunity_tags
# uses, so ONE vocabulary matches programs, scholarships, and study abroad.
SCHOL_COLLEGE = {
    "marriott": optags.BUS, "cpms": optags.CPMS, "engineering": optags.ENG,
    "education": optags.EDU, "fhss": optags.FHSS, "finearts": optags.FAC,
    "humanities": optags.HUM, "lifesci": optags.LIFE, "nursing": optags.NURS,
    "undeclared": None, "any": "any",
}


# ------------------------- academic dates ------------------------------------
def parse_academic_dates():
    docs = json.loads((DATA / "academic_dates.json").read_text(encoding="utf-8"))
    out = []
    for d in docs:
        m = re.match(r"(Winter|Spring|Summer|Fall)\s+(?:Semester|Term)\s+(\d{4})", d.get("name") or "")
        if not m:
            continue
        text = d.get("text") or ""
        entry = {"s": SEASON[m.group(1).lower()], "y": int(m.group(2))}
        rng = re.search(r"runs\s+([A-Z][a-z]{2}\s+\d{1,2})\s*-\s*([A-Z][a-z]{2}\s+\d{1,2}),?\s*(\d{4})", text)
        if rng:
            entry["start"], entry["end"] = rng.group(1), f"{rng.group(2)}, {rng.group(3)}"
        ad = re.search(r"Add/Drop Deadline:\s*([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})", text)
        wd = re.search(r"Withdraw Deadline:\s*([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})", text)
        if ad:
            entry["addDrop"] = ad.group(1)
        if wd:
            entry["withdraw"] = wd.group(1)
        out.append(entry)
    return out


# ------------------------- admission notes -----------------------------------
_ADMIT_RE = re.compile(
    r"(students must apply|apply (?:to|for) (?:the )?(?:program|major)|acceptance into"
    r"|admittance (?:to|into)|admission (?:to|into) the (?:program|major)"
    r"|by application|application required|selective admission)", re.I)


def _strings(obj):
    if isinstance(obj, str):
        # catalog rich-text carries raw HTML — strip tags/entities so notes
        # read clean and tag soup can't satisfy the phrase match
        yield re.sub(r"&[a-z]+;", " ", re.sub(r"<[^>]+>", " ", obj))
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _strings(v)


def _sentence_around(text, match):
    """The sentence containing the match, trimmed to something chip-sized."""
    start = max(text.rfind(". ", 0, match.start()) + 1, 0)
    end = text.find(". ", match.end())
    s = text[start:end + 1 if end >= 0 else len(text)].strip()
    s = re.sub(r"\s+", " ", s)
    return (s[:240] + "…") if len(s) > 240 else s


def parse_admission_notes(catalog):
    """majorId (generate_data id scheme) -> admission-requirement sentence."""
    notes = {}
    for p in catalog["programs"]:
        if (p.get("type") or "").upper() != "MAJOR":
            continue
        desig = str(p.get("degree_designation") or "").strip()
        if desig.upper() in ("", "NONE", "PRE"):
            continue                                    # premajor shells etc.
        display = f"{p.get('name')} ({desig})"
        pid = f"major-{slugify(display)}"
        if pid in notes:
            continue                                    # first catalog year wins
        for s in _strings({k: v for k, v in p.items() if k != "_raw_summary"}):
            m = _ADMIT_RE.search(s)
            if m:
                notes[pid] = _sentence_around(s, m)
                break
    # PRE-MAJOR fallback: admission criteria often live on the premajor page
    # ("Nursing Premajor Program"), not the degree page — attach to the
    # matching undergrad major when it has no note of its own.
    majors_by_base = {}
    for p in catalog["programs"]:
        if (p.get("type") or "").upper() != "MAJOR":
            continue
        desig = str(p.get("degree_designation") or "").strip()
        if desig.upper() in ("", "NONE", "PRE", "MS", "MA", "PHD", "MED", "MACC", "MBA", "MPA", "MSW"):
            continue
        display = f"{p.get('name')} ({desig})"
        majors_by_base.setdefault((p.get("name") or "").strip().lower(),
                                  f"major-{slugify(display)}")
    for p in catalog["programs"]:
        if (p.get("type") or "").upper() != "PRE-MAJOR":
            continue
        base = re.sub(r"\s*premajor.*$", "", (p.get("name") or ""), flags=re.I).strip().lower()
        pid = majors_by_base.get(base)
        if not pid or pid in notes:
            continue
        for s in _strings({k: v for k, v in p.items() if k != "_raw_summary"}):
            m = _ADMIT_RE.search(s)
            if m:
                notes[pid] = _sentence_around(s, m)
                break
    return notes


# ------------------------- program colleges ----------------------------------
def parse_program_colleges(catalog):
    """programId -> canonical college (majors, minors; same id scheme as bake)."""
    out = {}
    for p in catalog["programs"]:
        ptype = (p.get("type") or "").lower()
        if ptype not in ("major", "minor"):
            continue
        col = optags.normalize_college(p.get("college") or "")
        if not col:
            continue
        desig = str(p.get("degree_designation") or "").strip()
        keep = ptype == "major" and desig.upper() not in ("", "NONE", "PRE")
        display = f"{p.get('name')} ({desig})" if keep else p.get("name")
        out.setdefault(f"{ptype}-{slugify(display)}", col)
    return out


# ------------------------- study abroad --------------------------------------
def parse_study_abroad(catalog):
    docs = json.loads((DATA / "study_abroad.json").read_text(encoding="utf-8"))
    subj2col = optags.build_subject_college_map(catalog["courses"])
    out = []
    for d in docs:
        text = d.get("text") or ""
        cols = optags.college_tags(d.get("name") or "", text, "study_abroad", subj2col)
        term = ""
        tm = re.search(r"Term and cost:\s*([^\n]+)", text)
        if tm:
            term = re.sub(r"\s+", " ", tm.group(1)).strip()
        # which SEASONS the program runs (chips attach to the preceding term)
        seasons = sorted({s for kw, s in
                          [("win", "W"), ("spr", "S"), ("sum", "U"), ("fall", "F")]
                          if re.search(kw, term, re.I)})
        out.append({
            "name": d.get("name"), "url": d.get("url"),
            "colleges": [c for c in cols if c != optags.KENN],  # KENN tags all — noise
            "term": term, "seasons": seasons,
        })
    return out


# ------------------------- scholarships --------------------------------------
def _js_blocks(src, array_name):
    """Yield the top-level {...} entry blocks of `const <array_name> = [...]`."""
    start = src.find(f"const {array_name} = [")
    if start < 0:
        return
    i = src.find("[", start)
    depth = 0
    block_start = None
    while i < len(src):
        ch = src[i]
        if ch == "{":
            if depth == 0:
                block_start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and block_start is not None:
                yield src[block_start:i + 1]
                block_start = None
        elif ch == "]" and depth == 0:
            return
        i += 1


def _js_field(block, name, kind="str"):
    if kind == "str":
        m = re.search(rf'{name}:\s*"([^"]*)"', block)
        return m.group(1) if m else None
    if kind == "num":
        m = re.search(rf"{name}:\s*([\d.]+)", block)
        return float(m.group(1)) if m else None
    if kind == "strlist":
        m = re.search(rf"{name}:\s*\[([^\]]*)\]", block)
        if not m:
            return None
        return re.findall(r'"([^"]+)"', m.group(1))
    return None


def parse_scholarships():
    if not SCHOL_JS.exists():
        print(f"WARNING: {SCHOL_JS} not found — scholarships omitted.")
        return []
    src = SCHOL_JS.read_text(encoding="utf-8")
    out = []
    for block in _js_blocks(src, "SCHOLARSHIPS"):
        deadline = None
        dm = re.search(r"deadline:\s*\{\s*month:\s*(\d+),\s*day:\s*(\d+)\s*\}", block)
        if dm:
            deadline = {"month": int(dm.group(1)), "day": int(dm.group(2))}
        raw_cols = _js_field(block, "colleges", "strlist") or []
        cols = sorted({SCHOL_COLLEGE.get(c, None) or "any" if c == "any" else SCHOL_COLLEGE.get(c)
                       for c in raw_cols if SCHOL_COLLEGE.get(c) or c == "any"},
                      key=lambda x: (x != "any", x))
        levels = _js_field(block, "levels", "strlist")
        if levels is None and re.search(r"levels:\s*CONTINUING", block):
            levels = ["continuing"]
        out.append({
            "id": _js_field(block, "id"),
            "name": _js_field(block, "name"),
            "provider": _js_field(block, "provider"),
            "scope": _js_field(block, "scope"),
            "group": _js_field(block, "group"),
            "award": _js_field(block, "award"),
            "colleges": cols or ["any"],
            "levels": levels or [],
            "deadline": deadline,
            "deadlineNote": _js_field(block, "deadlineNote"),
            "minGPA": _js_field(block, "minGPA", "num"),
            "url": _js_field(block, "url"),
        })
    return out


# ------------------------- emit ----------------------------------------------
def main():
    catalog = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    timeline = {
        "academicDates": parse_academic_dates(),
        "admitNotes": parse_admission_notes(catalog),
        "admissionReqs": ADMISSION_REQS,
        "programColleges": parse_program_colleges(catalog),
        "studyAbroad": parse_study_abroad(catalog),
        "scholarships": parse_scholarships(),
    }
    body = json.dumps(timeline, ensure_ascii=False, separators=(",", ": "))
    OUT.write_text(
        "/* AUTO-GENERATED by scraper/generate_timeline.py — do not hand-edit.\n"
        "   Deadline & opportunity layer: academic dates, limited-enrollment\n"
        "   admission notes, program colleges, study abroad, scholarships. */\n"
        f'"use strict";\nconst TIMELINE = {body};\n',
        encoding="utf-8")
    print(f"Wrote {OUT}")
    print(f"  academicDates: {len(timeline['academicDates'])}")
    print(f"  admitNotes:    {len(timeline['admitNotes'])} majors")
    print(f"  admissionReqs: {len(timeline['admissionReqs'])} curated programs")
    print(f"  programColleges: {len(timeline['programColleges'])}")
    print(f"  studyAbroad:   {len(timeline['studyAbroad'])} "
          f"({sum(1 for s in timeline['studyAbroad'] if s['colleges'])} college-tagged)")
    print(f"  scholarships:  {len(timeline['scholarships'])} "
          f"({sum(1 for s in timeline['scholarships'] if s['deadline'])} with deadlines)")


if __name__ == "__main__":
    main()
