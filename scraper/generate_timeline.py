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
    print(f"  programColleges: {len(timeline['programColleges'])}")
    print(f"  studyAbroad:   {len(timeline['studyAbroad'])} "
          f"({sum(1 for s in timeline['studyAbroad'] if s['colleges'])} college-tagged)")
    print(f"  scholarships:  {len(timeline['scholarships'])} "
          f"({sum(1 for s in timeline['scholarships'] if s['deadline'])} with deadlines)")


if __name__ == "__main__":
    main()
