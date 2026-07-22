#!/usr/bin/env python3
"""
generate_data.py  --  catalog.json -> js/catalog_data.js
=========================================================

Turns the scraped Coursedog catalog into the myplanBYU planner's data layer:
REAL courses (credits, offering seasons) and REAL program requirements
(majors / minors / certificates / University Core GE), replacing the manually
curated placeholder chains in js/data.js.

PARSING STRATEGY -- freeform first. The catalog's structured `requirements`
rules are sometimes stale (Accounting's rules list 5 courses where the page
shows 11); `requisitesFreeform` is the HTML the official catalog RENDERS, so
it's authoritative. Its shape:

    <p><strong>Requirement 3 --Complete 11 Courses</strong></p>
    <p><em>Junior Core courses:</em></p>
    <p><a data-course-id="10313-000">course</a> - Bus & Acc Info Systems 3.0</p>
    ...

So per <strong> header segment we get: the pick rule (Complete N Courses /
N hours / all), an optional human bucket label (<em>), the option course list
(data-course-id links), and each course's credits (trailing float). Programs
whose freeform is empty (University Core) fall back to the structured rules;
GE buckets are named by signature course (block containing A HTG 100 =
American Heritage, ...).

Run after every catalog refresh:
    .\\.venv\\Scripts\\python.exe generate_data.py

Output: ../js/catalog_data.js  (const CATALOG_DATA = {...})

Author: Jordan Heaton
"""

from __future__ import annotations

import html as htmllib
import json
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DATA_PATH = Path(__file__).resolve().parent / "data" / "catalog.json"
OUT_PATH = Path(__file__).resolve().parent.parent / "js" / "catalog_data.js"

PROGRAM_TYPES = {
    "MAJOR": "major", "Major": "major",
    "MINOR": "minor", "Minor": "minor",
    "CERT": "cert", "CERTIFICATE": "cert",
}
# The planner is for UNDERGRADUATE studies only — graduate degrees (the catalog
# labels them MAJOR too) are excluded here. The RAG advisor still ingests the
# full catalog, so the chatbot can answer MAcc/MBA/PhD questions.
GRAD_DESIGS = {"MS", "PHD", "MA", "MED", "MFA", "MACC", "MPA", "MBA", "EDD",
               "MM", "MPH", "MISM", "JD", "LLM", "EDS", "MSW", "MENG", "DNP",
               "MAT"}   # Master of Athletic Training — was leaking into the undergrad list
CORE_NAME = "University Core 2004-Present"

# University Core block names, by stable block order (verified July 2026 by
# signature courses: 1 has A HTG 100, 4 has MATH 110, 10 has BIO 100, ...).
GE_BLOCK_NAMES = [
    "American Heritage",
    "Global & Cultural Awareness",
    "Advanced Written & Oral Communication",
    "Quantitative Reasoning",
    "Languages of Learning",
    "Civilization 1",
    "Civilization 2",
    "Arts",
    "Letters",
    "Biological Science",
    "Physical Science",
    "Social Science",
]
# sanity signatures: block index -> course that MUST be in it (warn if not)
GE_CHECKS = {0: "A HTG 100", 3: "MATH 110", 7: "ARTHC 111", 9: "BIO 100", 11: "PSYCH 111"}

BASE_ID_RE = re.compile(r"^(\d{4,6}-\d{2,3})")


# ---------------------------------------------------------------------------
# Course maps
# ---------------------------------------------------------------------------

def eff_date(p: Dict[str, Any]) -> str:
    return str((p.get("_raw_summary") or {}).get("effectiveStartDate") or "")


def dedup_latest(programs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    best: Dict[Tuple, Dict[str, Any]] = {}
    for p in programs:
        key = (p.get("name"), p.get("type"), str(p.get("degree_designation")))
        if key not in best or eff_date(p) > eff_date(best[key]):
            best[key] = p
    return list(best.values())


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _num(x) -> Optional[float]:
    if isinstance(x, (int, float)):
        return float(x)
    if isinstance(x, str) and re.search(r"[\d.]+", x):
        return float(re.search(r"[\d.]+", x).group(0))
    return None


def course_credits(c: Dict[str, Any]) -> float:
    """Planning credits for a course. Variable-credit courses (min..max, e.g.
    EXDM 496R 0.5-12) plan at the MINIMUM enrollment — the old max made a 1.5
    credit internship show as a 12-credit semester monster. Genuine 0-credit
    requirements (BIO 497 field exam) stay 0."""
    ch = c.get("credit_hours")
    if isinstance(ch, (int, float)):
        return float(ch)
    if isinstance(ch, dict):
        inner = ch.get("creditHours") or {}
        v, mn = _num(inner.get("value")), _num(inner.get("min"))
        if mn is not None and v is not None and mn != v:
            return mn if mn > 0 else v          # variable: plan the minimum
        if v is not None:
            return v
        if mn is not None:
            return mn
        n = _num(ch.get("numberOfCredits"))
        if n is not None:
            return n
    return 3.0


def is_variable_credit(c: Dict[str, Any]) -> bool:
    ch = c.get("credit_hours")
    if isinstance(ch, dict):
        inner = ch.get("creditHours") or {}
        v, mn = _num(inner.get("value")), _num(inner.get("min"))
        return v is not None and mn is not None and mn != v
    return False


def variable_credit_max(c: Dict[str, Any]) -> Optional[float]:
    """Max per-term enrollment of a variable-credit course (CPSE 486R: 1-12).
    The planner plans the MINIMUM (course_credits) but the solver may raise
    per-term enrollment so a 12-hour practicum doesn't ladder 12 semesters."""
    if not is_variable_credit(c):
        return None
    inner = (c.get("credit_hours") or {}).get("creditHours") or {}
    v, mn = _num(inner.get("value")), _num(inner.get("min"))
    mx = max(x for x in (v, mn) if x is not None)
    return mx if mx and 0 < mx <= 18 else None


def build_course_maps(courses: List[Dict[str, Any]]):
    id2code: Dict[str, str] = {}
    by_code: Dict[str, Dict[str, Any]] = {}
    name_cands: Dict[str, set] = {}
    for c in courses:
        code = (c.get("code") or "").strip()
        cid = str(c.get("course_id") or "")
        if not code:
            continue
        if cid:
            id2code[cid] = code
            m = BASE_ID_RE.match(cid)
            if m:
                id2code[m.group(1)] = code
        prev = by_code.get(code)
        if prev is None or cid > str(prev.get("course_id")):
            by_code[code] = c
        nm = (c.get("name") or "").strip().lower()
        if nm:
            name_cands.setdefault(nm, set()).add(code)
    # Name-based fallback resolution must survive collisions: "Dynamics" is
    # both CCE 204 (the undergrad course ME majors take) and PHSCS 721 (a grad
    # course). Prefer undergrad (<500) and the lowest-numbered course.
    def _num(code: str) -> int:
        m = re.search(r"(\d{3})", code)
        return int(m.group(1)) if m else 999
    name2code: Dict[str, str] = {
        nm: sorted(codes, key=lambda c: (_num(c) >= 500, _num(c), c))[0]
        for nm, codes in name_cands.items()
    }
    return id2code, by_code, name2code


def season_string(offered: str) -> Tuple[str, bool, Optional[str]]:
    t = (offered or "").lower()
    if not t or "contact" in t:
        return "FW", False, None
    if "all semesters" in t or "every semester" in t:
        return "FWSU", False, None
    off = ""
    if "fall" in t: off += "F"
    if "winter" in t: off += "W"
    if "spring" in t: off += "S"
    if "summer" in t: off += "U"
    if not off:
        off = "FW"
    rare = bool(re.search(r"even year|odd year|alternat", t))
    note = f"Offered: {offered.strip()}" if rare else None
    return off, rare, note


# ---------------------------------------------------------------------------
# Freeform parser (primary)
# ---------------------------------------------------------------------------

LINK_RE = re.compile(
    r'<a\s[^>]*data-course-id="([^"]+)"[^>]*>.*?</a>\s*(?:[-–—]\s*)?'
    r'([^<]*?)\s*(\d+(?:\.\d+)?)?\s*(?=<|$)', re.S)
STRONG_RE = re.compile(r"<(?:strong|b)>(.*?)</(?:strong|b)>", re.I | re.S)
EM_RE = re.compile(r"<em>(.*?)</em>", re.I | re.S)


def strip_tags(s: str) -> str:
    return re.sub(r"\s+", " ", htmllib.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def ff_value(p: Dict[str, Any]) -> Optional[str]:
    ff = ((p.get("_raw_summary") or {}).get("requisites") or {}).get("requisitesFreeform")
    v = ff.get("value") if isinstance(ff, dict) else None
    return v if isinstance(v, str) and v.strip() else None


# Generation-time data-health findings, printed at the end of a run and
# written to data/_health_report.txt so scrape regressions are visible
# (implausible credit totals, "Complete N" wanting more courses than were
# resolved, near-empty programs). See docs/TUNING.md.
HEALTH: List[str] = []


def clamp_credits(payload_credits, computed_total: float, name: str):
    """The catalog payload's credit_hours is sometimes garbage (English
    Teaching '3668', Family Life:HD '210'). No undergrad program requires
    >130 major credits — outside the plausible band, use our computed
    bucket total instead and flag it."""
    ok = isinstance(payload_credits, (int, float)) and 10 <= payload_credits <= 130
    if ok:
        return payload_credits
    if isinstance(payload_credits, (int, float)) and payload_credits:
        HEALTH.append(f"{name}: implausible credit_hours {payload_credits} "
                      f"-> using computed {round(computed_total * 2) / 2}")
    computed = round(computed_total * 2) / 2
    if computed > 130:      # even our computed sum is fishy — surface it
        HEALTH.append(f"{name}: computed credit total {computed} exceeds any "
                      f"plausible undergrad program — requirement parse suspect")
    return computed


def pick_from_header(header: str, n_options: int) -> Optional[Dict[str, Any]]:
    """'Complete 11 Courses' / 'Complete 9.0 hours' / 'Complete 2 Options' -> pick."""
    h = header.lower()
    m = re.search(r"complete\s+(\d+(?:\.\d+)?)\s*hour", h)
    if m:
        return {"type": "credits", "n": float(m.group(1))}
    m = re.search(r"complete\s+(\d+)\s*course", h)
    if m:
        n = int(m.group(1))
        return {"type": "all"} if n >= n_options else {"type": "courses", "n": n}
    m = re.search(r"complete\s+(\d+)\s*option", h)
    if m:
        return {"type": "courses", "n": int(m.group(1))}
    if "complete all" in h:
        return {"type": "all"}
    return None


# Header quantifier: "Complete 1 of 6 Courses", "Complete 2 Requirements",
# "Complete 3 hours", "Complete 1 Course".
QUANT_XOFY_RE = re.compile(r"complete\s+(\d+)\s+of\s+(\d+)\s+(course|option|requirement)", re.I)
QUANT_HOURS_RE = re.compile(r"(?:complete\s+)?(?:at least\s+|up to\s+)?(\d+(?:\.\d+)?)\s+hour", re.I)
QUANT_N_RE = re.compile(r"complete\s+(\d+(?:\.\d+)?)\s+(course|option|requirement)", re.I)
HEADER_NUM_RE = re.compile(r"(?:Requirement|Option)\s+(\d+(?:\.\d+)*)", re.I)


def parse_quant(header: str):
    """Header -> (k, unit) where unit in course/hour/option/requirement.
    'Complete 1 of 6 Courses' -> (1,'course'); 'Complete 2 Requirements' ->
    (2,'requirement'); 'Complete 3 hours' / 'at least 9 hours' -> (N,'hour')."""
    m = QUANT_XOFY_RE.search(header)
    if m:
        return float(m.group(1)), m.group(3).lower()
    # "Complete up to N hours" (no floor) = an OPTIONAL band, not N required
    # hours — its parent header carries the real total (see walk()'s merge)
    if re.search(r"up to\s+[\d.]+\s+hour", header, re.I) and not re.search(r"at least", header, re.I):
        return 0.0, "hour"
    # hours first so "at least 9 hours up to 12" (elective bands) -> credits, not "all"
    m = QUANT_HOURS_RE.search(header)
    if m:
        return float(m.group(1)), "hour"
    m = QUANT_N_RE.search(header)
    if m:
        return float(m.group(1)), m.group(2).lower()
    return None, "course"          # "Complete all" / unrecognized -> all


def seg_courses(body: str, id2code, by_code, name2code, synth):
    """Resolve the course links in one freeform segment -> [(code, credits)]."""
    out = []
    for cid, cname, ccred in LINK_RE.findall(body):
        code = id2code.get(cid) or (id2code.get(BASE_ID_RE.match(cid).group(1))
                                    if BASE_ID_RE.match(cid) else None)
        cname_clean = strip_tags(cname).strip(" -–—")
        if not code and cname_clean:
            code = name2code.get(cname_clean.lower())
        # The trailing number after a link is USUALLY the credit value, but the
        # freeform sometimes puts prose there ("or ENGL 383") and the regex
        # grabs a COURSE NUMBER as credits (383!), silently corrupting program
        # totals (English BA "3645 credits"). No BYU course is >12 credits —
        # outside the plausible band, ignore it and use the catalog's value.
        cred_f = None
        if ccred:
            cred_f = float(ccred)
            if not (0 < cred_f <= 12):
                cred_f = None
        if not code:
            code = f"{cname_clean[:24]}*" if cname_clean else f"NEW*{cid[:8]}"
            if code not in synth:
                synth[code] = {"n": cname_clean or "New course (see catalog)",
                               "c": cred_f if cred_f else 3.0, "off": "FW"}
        cred = cred_f if cred_f is not None else \
            (course_credits(by_code[code]) if code in by_code else 3.0)
        if not any(c == code for c, _ in out):
            out.append((code, cred))
    return out


# A requirement whose catalog text forbids sharing a course with another
# requirement of the same program ("Courses cannot double count in Req 2").
NODBL_RE = re.compile(
    r"cannot\s+double[-\s]?count|may\s+not\s+(?:double[-\s]?count|be\s+counted)"
    r"|cannot\s+be\s+used\s+for\s+both|not\s+count(?:ed)?\s+toward\s+both", re.I)
# A credit floor stated in prose ("technical electives (15 hours minimum)").
MIN_HOURS_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*hours?\s*minimum|minimum\s+of\s+(\d+(?:\.\d+)?)\s*hours?", re.I)
# Hours of WORK (employment/internship/service), not credit hours: "complete
# 200 hours of pre-approved information technology-related work" (IT BS Req 7).
# "course work" (ChemE "12 hours of approved ... course work") IS credit-
# bearing, hence the lookbehind.
WORK_HOURS_RE = re.compile(
    r"(?<!course\s)\bwork\b|\bemploy|\binternship|\bexperience\b|\bservice\b|\bvolunteer",
    re.I)

# Catalog college names (as they appear in courses[*]._raw_summary.college),
# keyed by the words a requirement uses to describe an "approved elective" pool
# ("approved advanced course work from an engineering, math, science, or
# business (EMSB) department"). Used to BUILD option pools by rule where the
# catalog states a rule instead of listing courses.
COLLEGE_BY_KEYWORD = [
    (re.compile(r"\bengineering\b|\bENG\b|technolog", re.I), "Ira A. Fulton College of Engineering"),
    (re.compile(r"\bmath|\bphysical\s+scien|\bcomputational|\bstatist", re.I),
     "College of Computational, Mathematical, & Physical Sciences"),
    (re.compile(r"\blife\s+scien|\bbiolog|\bscience\b", re.I), "College of Life Sciences"),
    (re.compile(r"\bbusiness\b|marriott", re.I), "Marriott School of Business"),
]


def attr_colleges(note: str):
    """Colleges an 'approved elective' requirement draws from, parsed from its
    prose. Returns [] when the requirement isn't a college-attribute pool."""
    if not note or not re.search(r"approved|\bfrom\b.*\b(college|department|coursework|course work)\b", note, re.I):
        return []
    cols = []
    for rx, col in COLLEGE_BY_KEYWORD:
        if rx.search(note) and col not in cols:
            cols.append(col)
    return cols


def parse_freeform(p: Dict[str, Any], id2code, by_code, name2code, ptype: str,
                   synth: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Authoritative parse of the rendered requirement HTML, as a TREE.

    Freeform headers nest by their numbering ("Requirement 1" > "Option 5.1" >
    "Requirement 1.2.1") and carry a quantifier. 'Complete 1 of 2 Options' means
    CHOOSE ONE child option-group; 'Complete 2 Requirements' means do BOTH;
    'Complete N Courses' is a leaf. The old flat parser made every option-group
    required -- this walks the real tree so 'choose one' stays a choice.
    """
    html = ff_value(p)
    if not html or "data-course-id" not in html:
        return None
    name = (p.get("name") or "").strip()

    # ---- segments (header text, body html) ----
    parts = re.split(r"(<(?:strong|b)>.*?</(?:strong|b)>)", html, flags=re.I | re.S)
    segments: List[Tuple[str, str]] = []
    for part in parts:
        if STRONG_RE.fullmatch(part.strip()):
            segments.append((strip_tags(part), ""))
        elif segments:
            segments[-1] = (segments[-1][0], segments[-1][1] + part)

    notes: List[str] = []
    nodes: Dict[str, Dict[str, Any]] = {}   # number -> node
    order: List[str] = []
    auto = 0
    for header, body in segments:
        courses = seg_courses(body, id2code, by_code, name2code, synth)
        body_txt = strip_tags(body)
        # long em/plain sentences -> program notes
        for em in EM_RE.findall(body):
            t = strip_tags(em)
            if t and re.search(r"[.!?]$", t) and len(t) > 40:
                notes.append(t[:400])
        m = HEADER_NUM_RE.search(header)
        if m:
            num = m.group(1)
        else:
            if not courses:                 # header-only policy text
                if body_txt:
                    notes.append(f"{header} {body_txt}".strip()[:400])
                continue
            auto += 1
            num = str(auto)                 # flat programs w/o R#/Option# labels
        k, unit = parse_quant(header)
        # Attribute-defined credit requirement: the header carries no course
        # links or quantifier, but the BODY states the hours ("Complete 12
        # hours of approved advanced engineering (ENG) coursework"). Without
        # this the whole sub-requirement (e.g. ChemE's ENG/EMSB/EPSEL rules)
        # is silently dropped. Pick up the hours from the body prose.
        if k is None and not courses:
            hb = re.search(r"(?:complete|at least)\s+(\d+(?:\.\d+)?)\s+hours?"
                           r"(?:\s+of\s+([^.;:]{0,90}))?", body_txt, re.I)
            if hb:
                # Only CREDIT hours qualify. "Obtain confirmation ... complete
                # 200 hours of pre-approved information technology-related
                # work" (IT BS Req 7) is an employment checkoff — read as
                # credits it spawned a phantom 200-credit elective pool and
                # 12-term plans. Reject hours-of-work prose and implausible
                # counts (no prose-stated pool asks for >25 credit hours);
                # keep the text as a program note instead of a dead bucket.
                if WORK_HOURS_RE.search(hb.group(2) or "") or float(hb.group(1)) > 25:
                    HEALTH.append(f"{name}: '{header.strip()}' states {hb.group(1)} "
                                  f"non-credit hours — demoted to program note")
                    if body_txt:
                        notes.append(f"{header} {body_txt}".strip()[:400])
                    continue
                k, unit = float(hb.group(1)), "hour"
        nodes[num] = {"num": num, "header": header, "k": k, "unit": unit,
                      "courses": courses, "children": [], "note": body_txt[:700]}
        order.append(num)

    if not nodes:
        return None

    # ---- link children to parents by dotted numbering ----
    roots = []
    for num in order:
        parent = num.rsplit(".", 1)[0] if "." in num else None
        if parent and parent in nodes:
            nodes[parent]["children"].append(nodes[num])
        else:
            roots.append(nodes[num])

    # ---- walk tree -> buckets ----
    buckets: List[Dict[str, Any]] = []

    def leaf_bucket(node, label_prefix=""):
        opts = [c for c, _ in node["courses"]]
        creds = {c: cr for c, cr in node["courses"]}
        k, unit = node["k"], node["unit"]
        # scrape-health: "Complete 28 Courses" but only 27 links resolved means
        # the scrape MISSED a course (the catalog count is usually right) —
        # flag it so the data gap gets filled, don't silently under-require
        if unit == "course" and k is not None and k > len(opts):
            HEALTH.append(f"{name}: '{node['header']}' wants {int(k)} courses "
                          f"but only {len(opts)} options resolved")
        if unit == "hour":
            pick = {"type": "credits", "n": (3.0 if k is None else k)}
        elif k is None or k >= len(opts):
            pick = {"type": "all"}
        else:
            pick = {"type": "courses", "n": int(k)}
        nm = re.sub(r"\s*[—–-]\s*", " — ", node["header"]).strip()
        b = {"id": f"{slugify(name)}-{node['num'].replace('.', '-')}",
             "name": (label_prefix + nm)[:80], "pick": pick,
             "options": opts, "_creds": creds}
        # keep the requirement's prose so MAP slot labels can match it ("Technical
        # Elective" -> the bucket whose note describes technical electives) and
        # so double-count rules are detected. Only CHOICE/CREDIT buckets can be a
        # MAP elective slot — pick:all fixed requirements skip the note (keeps
        # catalog_data.js small) unless the note carries a real directive.
        note = (node.get("note") or "").strip()
        directive = note and re.search(
            r"cannot|must|elective|approved|at least|no more than|prior to|before|EPSEL|EMSB", note, re.I)
        if note and (pick["type"] != "all" or directive):
            b["note"] = note[:700]
        if NODBL_RE.search(note):
            b["noDbl"] = True
        return b

    def subtree_requirement(n):
        """How much a requirement SUBTREE actually asks for -> ('credits', X) /
        ('courses', X) / ('all', None). A track option like 'Complete 3
        Requirements' (each 'Complete N hours') sums its children (9+3+6=18
        credits) instead of collapsing to 'take everything' — the bug that let
        one track pull its whole 58-course pool ('Frankenstein' plans)."""
        if n["courses"]:                       # leaf
            k, unit = n["k"], n["unit"]
            if unit == "hour":
                return ("credits", n["k"] or 3)
            if k is None or k >= len(n["courses"]):
                return ("courses", len(n["courses"]))
            return ("courses", int(k))
        ch = n["children"]
        if not ch:
            return ("all", None)
        subs = [subtree_requirement(c) for c in ch]
        k = n["k"]
        # choose-K among sibling requirements -> the K cheapest
        if k is not None and n["unit"] in ("option", "requirement", "course") and k < len(ch):
            def amt(s):
                return s[1] * 3 if s[0] == "credits" else (s[1] or 0) * 3 if s[0] == "courses" else 99
            subs = sorted(subs, key=amt)[:max(1, int(k))]
        cr = sum(a for tp, a in subs if tp == "credits" and a)
        co = sum(a for tp, a in subs if tp == "courses" and a)
        if cr and co:
            return ("credits", cr + co * 3)    # mixed -> approx as credits
        if cr:
            return ("credits", cr)
        if co:
            return ("courses", co)
        return ("all", None)

    def flatten_group(node):
        """A choose-one child -> a selectable group {label, options, take}."""
        opts, creds = [], {}
        def collect(n):
            for c, cr in n["courses"]:
                if c not in creds:
                    opts.append(c); creds[c] = cr
            for ch in n["children"]:
                collect(ch)
        collect(node)
        # 'take': how much of the group's pool actually completes it
        if node["courses"] and node["unit"] != "hour" and node["k"] and node["k"] < len(node["courses"]):
            take = int(node["k"])
        elif node["unit"] == "hour":
            take = ("credits", node["k"] or 3)
        elif node["children"]:                 # nested option -> size the subtree
            tp, amt = subtree_requirement(node)
            if tp == "credits" and amt:
                take = ("credits", amt)
            elif tp == "courses" and amt and amt < len(opts):
                take = int(amt)
            else:
                take = "all"
        else:
            take = "all"
        label = re.sub(r"\s*[—–-]\s*", " — ", node["header"]).strip()
        return {"label": label[:60], "options": opts, "take": take, "_creds": creds}

    def walk(node):
        if node["courses"]:                 # leaf
            buckets.append(leaf_bucket(node))
            return
        ch = node["children"]
        if not ch:
            # Childless requirement whose body states a quantifier but lists NO
            # course links — an attribute-defined "approved elective" pool the
            # catalog describes by rule (ChemE Req 4.2 "12 hours of approved
            # advanced engineering coursework", 4.3 EMSB, 4.4 EPSEL). Emit a
            # real bucket; college-attribute pools get options filled by rule
            # (see enrich_attr_pools). Without this these requirements — and the
            # EPSEL rule — vanish entirely.
            k, unit = node["k"], node["unit"]
            if k is None:
                return
            note = (node.get("note") or "").strip()
            cols = attr_colleges(note)
            if not cols:
                # No rule to build a pool from -> the bucket could NEVER be
                # satisfied (empty options forever). These are policy blocks the
                # catalog wraps in a quantifier ("Requirement 4 — Complete 1
                # Options: Department Admission Requirements ...") — keep the
                # text as a program note instead of a dead "choose" slot.
                if note:
                    notes.append(f"{node['header'].strip()} {note}"[:400])
                return
            b = {"id": f"{slugify(name)}-{node['num'].replace('.', '-')}",
                 "name": (re.sub(r"\s*[—–-]\s*", " — ", node["header"]).strip())[:80],
                 "pick": {"type": "credits", "n": k} if unit == "hour"
                         else {"type": "courses", "n": int(k)},
                 "options": [], "_creds": {},
                 "note": note[:700] or None,
                 "_attr": {"colleges": cols, "minLevel": 3}}
            buckets.append(b)
            return
        # internal: choose-K children, or AND (all children)
        k = node["k"]
        # "Requirement 9 — Complete 12 hours" split over child pools
        # ("Option 9.1 — up to 12 hours", "Option 9.2 — up to 6 hours"):
        # ONE credits bucket over the union — NOT 12+6=18 required hours.
        if k is not None and node["unit"] == "hour":
            opts, creds = [], {}
            def _collect(n):
                for c, cr in n["courses"]:
                    if c not in creds:
                        opts.append(c); creds[c] = cr
                for cc in n["children"]:
                    _collect(cc)
            _collect(node)
            if opts:
                b = {
                    "id": f"{slugify(name)}-{node['num'].replace('.', '-')}",
                    "name": (re.sub(r"\s*[—–-]\s*", " — ", node["header"]).strip())[:80],
                    "pick": {"type": "credits", "n": k},
                    "options": opts, "_creds": creds,
                }
                note = (node.get("note") or "").strip()
                if note:
                    b["note"] = note[:700]           # e.g. "technical electives ..." for slot matching
                if NODBL_RE.search(node.get("note", "")):
                    b["noDbl"] = True
                buckets.append(b)
            return
        if k is not None and k < len(ch):   # "Complete 1 of N Options" -> choose
            groups = [flatten_group(c) for c in ch]
            # policy-only children ("Obtain confirmation from advisement...")
            # carry no courses -> they're notes, not selectable option-groups
            for g, c in zip(groups, ch):
                if not g["options"]:
                    notes.append(re.sub(r"\s*[—–-]\s*", " — ", c["header"]).strip()[:300])
            groups = [g for g in groups if g["options"]]
            if len(groups) >= 2:
                buckets.append({
                    "id": f"{slugify(name)}-{node['num'].replace('.', '-')}",
                    "name": (re.sub(r"\s*[—–-]\s*", " — ", node["header"]).strip())[:80],
                    "pick": {"type": "group", "k": max(1, min(int(k), len(groups)))},
                    "groups": groups,
                })
            elif len(groups) == 1:          # only one real option -> just require it
                g = groups[0]
                take = g["take"]
                pick = ({"type": "credits", "n": float(take[1])} if isinstance(take, tuple)
                        else {"type": "credits", "n": take["credits"]} if isinstance(take, dict)
                        else {"type": "all"} if take == "all"
                        else {"type": "courses", "n": int(take)})
                buckets.append({
                    "id": f"{slugify(name)}-{node['num'].replace('.', '-')}",
                    "name": (re.sub(r"\s*[—–-]\s*", " — ", node["header"]).strip())[:80],
                    "pick": pick, "options": g["options"], "_creds": g.get("_creds", {}),
                })
        else:                               # AND: recurse each child
            for c in ch:
                walk(c)

    for r in roots:
        walk(r)
    if not buckets:
        return None

    # ---- credits total (default/cheapest group for group buckets) ----
    total = 0.0
    for b in buckets:
        if b["pick"]["type"] == "group":
            best = min(b["groups"], key=lambda g: group_credits(g))
            total += group_credits(best)
        else:
            creds = b.pop("_creds", {})
            opts = b["options"]
            if b["pick"]["type"] == "all":
                total += sum(creds.get(c, 3.0) for c in opts)
            elif b["pick"]["type"] == "courses":
                avg = (sum(creds.values()) / len(creds)) if creds else 3.0
                total += b["pick"]["n"] * avg
            else:
                total += b["pick"]["n"]
    credits = clamp_credits(p.get("credit_hours"), total, name)

    # strip internal fields; normalize group 'take' to a JSON-clean shape
    for b in buckets:
        for g in b.get("groups", []):
            g.pop("_creds", None)
            if isinstance(g.get("take"), tuple):
                g["take"] = {"credits": g["take"][1]}
        b.pop("_creds", None)

    desig = str(p.get("degree_designation") or "").strip()
    keep = ptype == "major" and desig.upper() not in ("", "NONE", "PRE")
    display = f"{name} ({desig})" if keep else name
    return {
        "id": f"{ptype}-{slugify(display)}",
        "name": display, "type": ptype,
        "college": (p.get("college") or "").strip() or None,
        "credits": credits, "buckets": buckets, "notes": notes[:8],
    }


def group_credits(g) -> float:
    """Credits to COMPLETE a group (not to list it)."""
    creds = g.get("_creds", {})
    take = g["take"]
    if take == "all":
        return sum(creds.values())
    if isinstance(take, tuple):     # ('credits', n)
        return float(take[1])
    avg = (sum(creds.values()) / len(creds)) if creds else 3.0
    return take * avg


# ---------------------------------------------------------------------------
# Structured-rules parser (fallback + GE)
# ---------------------------------------------------------------------------

def rule_codes(rule, id2code, by_code) -> List[str]:
    v = rule.get("value")
    out: List[str] = []
    if not isinstance(v, dict):
        return out
    for grp in v.get("values") or []:
        for item in grp.get("value") or []:
            item = str(item).strip()
            code = id2code.get(item)
            if code is None and BASE_ID_RE.match(item):
                code = id2code.get(BASE_ID_RE.match(item).group(1))
            if code is None and item in by_code:
                code = item
            if code and code not in out:
                out.append(code)
    return out


def course_prereq_groups(raw: Dict[str, Any], id2code, by_code) -> List[List[str]]:
    """A course's requisitesSimple -> prereq groups for the planner.

    Shape: completedAllOf {values: [{value:[ids], logic:'or'}, ...]} means
    every group is required, courses within a group are alternatives — which
    is exactly the planner's `pre` model: [["A","B"], ["C"]] = (A or B) and C.
    Only 'Prerequisite'-type blocks count (corequisites can share a term).
    """
    groups: List[List[str]] = []
    for blk in (raw.get("requisites") or {}).get("requisitesSimple") or []:
        if str(blk.get("type") or "").lower() != "prerequisite":
            continue
        for rule in blk.get("rules") or []:
            v = rule.get("value")
            if not isinstance(v, dict):
                continue
            for grp in v.get("values") or []:
                codes = []
                for item in grp.get("value") or []:
                    item = str(item).strip()
                    code = id2code.get(item)
                    if code is None and BASE_ID_RE.match(item):
                        code = id2code.get(BASE_ID_RE.match(item).group(1))
                    if code is None and item in by_code:
                        code = item
                    if code and code not in codes:
                        codes.append(code)
                if codes:
                    groups.append(codes)
    return groups[:8]   # sanity cap


# ---------------------------------------------------------------------------
# Language certificates (from the CLS scrape — not in Coursedog)
# ---------------------------------------------------------------------------

LC_PATH = Path(__file__).resolve().parent / "data" / "language_certs.json"
# Stops at the next numbered category or the footnote (" *SPAN 321 is required...").
# Inline asterisks are glued to course numbers ("SPAN 321*,"), so requiring a
# space before the * keeps them from truncating the option list.
LC_CATEGORY_RE = re.compile(
    r"\d\.\s*(Language|Civilization/?\s?Culture|Literature)\s*(?:Choose One:?)?\s*"
    r"(.*?)(?=\d\.\s*(?:Language|Civilization|Literature)|\s\*[A-Z]|$)",
    re.I | re.S)
LC_CODE_RE = re.compile(r"\b([A-Z][A-Z&]{1,5})\s?(\d{3}[A-Z]?R?)\b")


FLOWCHART_PLANS = Path(__file__).resolve().parent / "data" / "flowchart_plans.json"
MAPS_PLANS = Path(__file__).resolve().parent / "data" / "maps_plans.json"
FLOWCHART_OVERRIDES = Path(__file__).resolve().parent / "data" / "flowchart_overrides.json"

# Limited-enrollment programs whose admission event can't be derived from
# their MAP sheet (no "apply" line) or a flowchart cohort — curated from the
# college advisement pages. Keyed by the norm() program name (no designation).
# y = 1-based academic year the professional sequence begins; dept = the
# professional course prefix the solver holds until admission.
LIMITED_ENROLLMENT = {
    # BYU Nursing: competitive (~64 seats/cohort), formal application after the
    # prereq year; the clinical NURS ladder starts sophomore Fall
    # (advisement.nursing.byu.edu/undergraduate-nursing/acceptance-criteria)
    "nursing": {"y": 2, "dept": "NURS"},
}


def _ckey(c: str) -> str:
    """Normalized course key for cross-referencing flowchart boxes against
    catalog buckets: strips spacing and a single repeatable-R suffix so
    'GSCM 585R' (chart) and 'GSCM 585' (catalog) match."""
    return re.sub(r"R$", "", re.sub(r"[^A-Z0-9]", "", (c or "").upper()))


def _flowchart_role_sets(prog, out_courses):
    """(required_keys, choice_keys) from the program's CATALOG buckets:
    which courses the requirements need OUTRIGHT vs. which are only options in
    a real 'choose N / N hours' choice. A flowchart box that is merely a choice
    option must stay a sequence HINT — never force-included — or a 'choose 2 of
    6' elective set gets scheduled as all 6."""
    def crd(code):
        e = out_courses.get(code) or {}
        try:
            return float(e.get("c")) if e.get("c") is not None else 3.0
        except (TypeError, ValueError):
            return 3.0
    required, choice = set(), set()
    for b in prog.get("buckets", []):
        pick = b.get("pick") or {}
        typ = pick.get("type")
        if typ == "group":
            for g in (b.get("groups") or []):
                gopts = g.get("options") or []
                take = g.get("take")
                if take == "all" or (isinstance(take, (int, float))
                                     and not isinstance(take, bool) and take >= len(gopts)):
                    for o in gopts: required.add(_ckey(o))
                else:                              # choose-K or credits group
                    for o in gopts: choice.add(_ckey(o))
            continue
        opts = b.get("options") or []
        if typ == "all":
            for o in opts: required.add(_ckey(o))
        elif len(opts) == 1:
            required.add(_ckey(opts[0]))
        elif typ == "courses":
            if pick.get("n", 0) >= len(opts):
                for o in opts: required.add(_ckey(o))
            else:
                for o in opts: choice.add(_ckey(o))
        elif typ == "credits":
            if sum(crd(o) for o in opts) <= pick.get("n", 0) + 0.5:
                for o in opts: required.add(_ckey(o))
            else:
                for o in opts: choice.add(_ckey(o))
    return required, choice


def enrich_attr_pools(programs, cat, by_code, out_courses) -> None:
    """Fill options for buckets tagged _attr (college-attribute 'approved
    elective' pools). Options = courses in the named colleges at/above the
    requirement's minimum level, capped to a usable set. Keeps any real course
    links the bucket already had first. See COLLEGE_BY_KEYWORD / attr_colleges."""
    # college -> [codes], only genuine numbered courses at 300+; sorted by level
    LEVEL = re.compile(r"(\d)\d\d")
    by_college: Dict[str, List[str]] = {}
    for c in cat["courses"]:
        code = (c.get("code") or "").strip()
        col = (c.get("_raw_summary") or {}).get("college")
        if not code or not col or code not in by_code:
            continue
        m = LEVEL.search(code)
        if not m or int(m.group(1)) < 3:
            continue
        by_college.setdefault(col, []).append(code)
    for lst in by_college.values():
        lst.sort(key=lambda c: (int(LEVEL.search(c).group(1)), c))
    CAP = 120
    n_filled = 0
    for prog in programs:
        # courses this program requires elsewhere can't double as an "approved
        # elective" (catalog: "No course used to satisfy other major
        # requirements may be used as an elective") — and including them made
        # the elective look auto-satisfied, so no choose-slots were generated.
        required = set()
        for b in prog.get("buckets", []):
            if b.get("_attr"):
                continue
            for o in b.get("options", []):
                required.add(o)
            for g in b.get("groups", []):
                required.update(g.get("options", []))
        for b in prog.get("buckets", []):
            attr = b.pop("_attr", None)
            if not attr:
                continue
            keep = [o for o in (b.get("options") or []) if o not in required]
            pool = []
            for col in attr["colleges"]:
                pool.extend(by_college.get(col, []))
            seen = set(keep) | required          # skip other-requirement courses
            merged = list(keep)
            for code in pool:
                if code not in seen:
                    seen.add(code); merged.append(code)
                if len(merged) >= CAP:
                    break
            b["options"] = merged
            n_filled += 1
    if n_filled:
        print(f"attribute pools: filled {n_filled} 'approved elective' buckets by college+level")


def attach_flowchart_plans(programs: List[Dict[str, Any]], by_code, out_courses) -> None:
    """Bake Claude-extracted flowchart plans into matching programs:
      flowchartPlan     course -> {y, s} soft placement hint (whole chart)
      flowchartCohorts  the RIGID junior-core envelopes (hard-locked blocks)
    Codes are normalized to real catalog spacing ('CS 111' -> 'C S 111') and
    brand-new courses on the chart (IS 456, PSE 390, ...) are synthesized so
    they're plannable."""
    # three layers, weakest -> strongest:
    #   1. MAP sheets (advisement's official 8-semester plan, ~123 majors)
    #   2. department flowchart extraction (business/eng, incl. envelopes)
    #   3. hand-verified overrides (data/flowchart_overrides.json)
    # Later layers override per-COURSE placements; the strongest layer that
    # defines cohorts wins the cohort list for that program.
    layers = []
    if MAPS_PLANS.exists():
        layers.append(json.loads(MAPS_PLANS.read_text(encoding="utf-8")))
    if FLOWCHART_PLANS.exists():
        layers.append(json.loads(FLOWCHART_PLANS.read_text(encoding="utf-8")))
    if FLOWCHART_OVERRIDES.exists():
        layers.append(json.loads(FLOWCHART_OVERRIDES.read_text(encoding="utf-8")))
    if not layers:
        print("flowchart plans: none (run sources/maps.py + extract_flowchart_plans.py)")
        return
    # normalize away "(BS)" suffixes AND "&"/"and" spelling differences
    # ("Experience Design & Management" vs "...Design and Management") — used
    # both for MERGING layers keyed under different spellings and for matching
    norm = lambda s: re.sub(r"\s+", " ", re.sub(r"\s*\(.*\)$", "", s)
                            .replace("&", "and")).strip().lower()
    # designation-preserving norm: all three layers key sheets as "Name (BS)",
    # and stripping the parenthetical COLLIDED same-name programs — Chemistry
    # (BA) and (BS) merged into one record (the BS sheet overwrote the BA's and
    # the BS program got nothing). Keep the designation; merging across layers
    # still works because every layer uses the same "Name (DES)" format.
    fullnorm = lambda s: re.sub(r"\s+", " ", s.replace("&", "and")).strip().lower()

    plans: Dict[str, Any] = {}
    for li, layer in enumerate(layers):
        # MAP sheets (the weakest layer) are SEQUENCE hints only; department
        # flowcharts/overrides also FORCE-INCLUDE their courses (business core
        # like HRM 391 isn't in the catalog requirement lists but is required)
        forced = not (MAPS_PLANS.exists() and li == 0)
        for name, plan in layer.items():
            if name.startswith("_") or not isinstance(plan, dict):
                continue                    # _readme / metadata keys
            m = plans.setdefault(fullnorm(name), {"name": name, "course_terms": {}, "cohorts": None})
            for t in plan.get("terms", []):
                y, s = t.get("year"), t.get("season")
                if not y or s not in ("F", "W"):
                    continue
                for c in t.get("courses", []):
                    raw = c["code"] if isinstance(c, dict) else c
                    cred = c.get("credits") if isinstance(c, dict) else None
                    entry = {"y": int(y), "s": s, "cr": cred}
                    if forced:
                        entry["f"] = 1
                    m["course_terms"][re.sub(r"\s+", " ", raw).strip().upper()] = entry
            if plan.get("cohorts"):
                m["cohorts"] = plan["cohorts"]
            if plan.get("admit"):
                m["admit"] = plan["admit"]      # MAP "apply to the program" anchor
            if plan.get("map"):
                m["mapPlan"] = plan["map"]      # full-fidelity sheet (MAP-first mode)

    by_name = {p["name"]: p for p in programs}
    # index MAJORS FIRST so a base-name fallback never attaches a major's MAP
    # sheet to the same-named minor ("Mathematics" minor stealing the BS sheet)
    ordered = sorted(programs, key=lambda p: 0 if p.get("type") == "major" else 1)
    by_full = {}
    by_base = {}
    for p in ordered:
        by_full.setdefault(fullnorm(p["name"]), p)
        by_base.setdefault(norm(p["name"]), p)

    # compact-code index resolves spacing differences: "CS 111"/"C S 111" -> real
    compact = lambda c: re.sub(r"[^A-Z0-9]", "", c.upper())
    cindex = {compact(code): code for code in by_code}

    SEASON_OFF = {"F": "F", "W": "W"}
    attached = 0
    for key, plan in plans.items():
        # exact name -> designation-preserving norm -> base-name (majors-first)
        prog = (by_name.get(plan["name"]) or by_full.get(key)
                or by_base.get(norm(plan["name"])))
        if not prog:
            continue

        def resolve(raw, credits=None, season=None):
            """Map a flowchart code to a real catalog code, synthesizing a new
            course entry if the chart lists one the catalog doesn't have yet."""
            code = cindex.get(compact(raw))
            if code:
                # variable-credit courses (EXDM 496R: 0.5-12): the chart's
                # listed credit value is what students actually enroll for
                if credits and code in out_courses and code in by_code \
                        and is_variable_credit(by_code[code]) \
                        and 0 < float(credits) <= 12:
                    out_courses[code]["c"] = float(credits)
                return code
            # normalize spacing to a plausible real code, then synthesize
            code = re.sub(r"\s+", " ", raw).strip().upper()
            if code not in out_courses:
                out_courses[code] = {"n": code, "c": float(credits) if credits else 3.0,
                                     "off": SEASON_OFF.get(season, "FW"), "new": True}
            return code

        hint: Dict[str, Dict[str, Any]] = {}
        for raw, tm in plan["course_terms"].items():
            code = resolve(raw, tm.get("cr"), tm["s"])
            hint[code] = {"y": tm["y"], "s": tm["s"]}
            if tm.get("f"):
                hint[code]["f"] = 1        # required by the dept flowchart

        cohorts = []
        for c in (plan.get("cohorts") or []):
            s = c.get("season")
            if s not in ("F", "W"):
                continue
            codes = []
            for raw in c.get("courses", []):
                code = resolve(raw, None, s)
                if code not in codes:
                    codes.append(code)
            if len(codes) >= 2:
                cohorts.append({"label": c.get("label", "Cohort")[:60],
                                "y": int(c.get("year") or 3), "s": s, "courses": codes})

        # Reconcile flowchart FORCING with the catalog's 'choose N' counts:
        # a box that's only an option in a real choice keeps its {y,s} SEQUENCE
        # hint but loses its force flag, and drops out of any locked cohort —
        # so 'choose 2 of 6' schedules 2 dropdown slots, not all 6 boxes.
        req_keys, choice_keys = _flowchart_role_sets(prog, out_courses)
        is_choice_only = lambda code: _ckey(code) in choice_keys and _ckey(code) not in req_keys
        dropped = set()                           # courses removed from the plan
        for code in list(hint.keys()):
            if hint[code].get("f") and is_choice_only(code):
                del hint[code]["f"]
                dropped.add(code)                 # no longer locks a cohort term
        # Drop SYNTHESIZED phantoms that duplicate a same-numbered required
        # course: a chart labels the ethics course 'PSE 390' but the catalog
        # requires it as 'MSB 390 Ethics' — forcing the phantom double-books it.
        num_re = re.compile(r"(\d{3})")
        req_nums = {m.group(1) for rk in req_keys for m in [num_re.search(rk)] if m}
        for code in list(hint.keys()):
            info = out_courses.get(code) or {}
            m = num_re.search(_ckey(code))
            if info.get("new") and _ckey(code) not in req_keys \
                    and m and m.group(1) in req_nums:
                del hint[code]
                dropped.add(code)
        pruned = []
        for co in cohorts:
            members = [c for c in co["courses"]
                       if not is_choice_only(c) and c not in dropped]
            if len(members) >= 2:                 # a real multi-course envelope
                co = dict(co); co["courses"] = members
                pruned.append(co)
            # a cohort that collapses to <2 required members isn't a cohort —
            # its remaining required course(s) stay forced via `hint`
        cohorts = pruned

        # ---- limited-enrollment admission gate -------------------------
        # Sources, strongest first: curated table (programs whose MAP has no
        # "apply" line — Nursing), then an EARLY MAP "apply to the program"
        # anchor (sem<=5; late anchors are portfolio/graduation applications).
        # Junior-core cohorts already gate in the solver without this.
        # admit = {y: 1-based year the professional sequence begins,
        #          dept: professional course prefix}. The solver holds dept
        # courses + upper-division work until the admit year, EXCEPT courses
        # the chart itself places earlier (declared pre-admission prereqs).
        admit = None
        # plan keys are display names ("Nursing (BS)") — normalize before the
        # curated-table lookup or the entry silently never merges
        le_key = re.sub(r"\s*\(.*\)$", "", key).strip().lower()
        if le_key in LIMITED_ENROLLMENT:
            admit = dict(LIMITED_ENROLLMENT[le_key])
        else:
            anchor = plan.get("admit")
            if anchor and isinstance(anchor.get("sem"), int) and 1 <= anchor["sem"] <= 5:
                gate_y = anchor["sem"] // 2 + 1   # professional work starts the NEXT term's year
                cnt: Dict[str, int] = {}
                for code, h in hint.items():
                    if h["y"] >= gate_y and " " in code:
                        d = code.rsplit(" ", 1)[0]
                        cnt[d] = cnt.get(d, 0) + 1
                dept = max(cnt, key=cnt.get) if cnt else None
                admit = {"y": gate_y}
                if dept:
                    admit["dept"] = dept
        if admit:
            prog["admit"] = admit

        # ---- full-fidelity MAP sheet (MAP-first draft plans) ---------------
        # Resolve item codes to real catalog spacing; slots pass through. The
        # app builds the draft plan directly from this — the official sheet IS
        # the plan; the optimizer only adapts (completed courses, minors).
        if plan.get("mapPlan"):
            mp_out = []
            for t in plan["mapPlan"]:
                its = []
                for it in t.get("items", []):
                    if it.get("c"):
                        rit = {"c": resolve(it["c"], it.get("cr"), t.get("season")),
                               "cr": it.get("cr")}
                        if it.get("alts"):
                            rit["alts"] = [resolve(a, it.get("cr"), t.get("season"))
                                           for a in it["alts"]]
                        its.append(rit)
                    else:
                        its.append(it)
                if its:
                    e = {"y": t["year"], "s": t["season"], "items": its}
                    if t.get("total") is not None:
                        e["total"] = t["total"]
                    mp_out.append(e)
            if mp_out:
                prog["mapPlan"] = mp_out

        if hint:
            prog["flowchartPlan"] = hint
            if cohorts:
                prog["flowchartCohorts"] = cohorts
            attached += 1
    n_mapped = sum(1 for p in programs if p.get("mapPlan"))
    print(f"flowchart plans: attached to {attached} programs | full MAP sheets: {n_mapped}")


def parse_language_certs(by_code) -> List[Dict[str, Any]]:
    """cls.byu.edu language certificates -> selectable cert programs with a
    'choose 1' bucket per category (Language / Civ-Culture / Literature)."""
    if not LC_PATH.exists():
        return []
    try:
        docs = json.loads(LC_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []
    out = []
    for d in docs:
        name = (d.get("name") or "").strip()          # "Spanish Language Certificate"
        text = d.get("text") or ""
        buckets = []
        for m in LC_CATEGORY_RE.finditer(text):
            cat_name = re.sub(r"\s+", " ", m.group(1)).title().replace("/ ", "/")
            codes = []
            for dept, num in LC_CODE_RE.findall(m.group(2)):
                code = f"{dept} {num}"
                if code in by_code and code not in codes:
                    codes.append(code)
            if codes:
                buckets.append({
                    "id": f"{slugify(name)}-{slugify(cat_name)}",
                    "name": f"{cat_name} — choose 1",
                    "pick": {"type": "courses", "n": 1},
                    "options": codes,
                })
        if len(buckets) >= 2:                          # a real, plannable cert
            out.append({
                "id": f"cert-{slugify(name)}",
                "name": name,
                "type": "cert",
                "college": "BYU Center for Language Studies",
                "credits": 9,
                "buckets": buckets,
                "notes": ["The required core course (e.g. SPAN 321) must be taken "
                          "first and may count toward any one of the three categories. "
                          "See cls.byu.edu for full placement rules."],
            })
    return out


def parse_structured(p: Dict[str, Any], id2code, by_code, ptype: str) -> Optional[Dict[str, Any]]:
    """Fallback for programs whose freeform is empty: the structured rules are
    sometimes incomplete but far better than a placeholder chain."""
    name = (p.get("name") or "").strip()
    if not name:
        return None
    buckets: List[Dict[str, Any]] = []
    notes: List[str] = []
    for bi, blk in enumerate(p.get("requirements") or []):
        for r in blk.get("rules") or []:
            cond = r.get("condition")
            if cond == "freeformText":
                t = re.sub(r"\s+", " ", str(r.get("value") or "")).strip()
                if t:
                    notes.append(t[:400])
                continue
            codes = rule_codes(r, id2code, by_code)
            if not codes:
                continue
            if cond == "completedAllOf":
                pick = {"type": "all"}
            elif cond in ("completedAnyOf", "anyOf"):
                pick = {"type": "courses", "n": 1}
            elif cond == "minimumCredits":
                pick = {"type": "credits", "n": float(r.get("credits") or 3)}
            elif cond == "completedAtLeastXOf":
                n = r.get("restriction") or 1
                pick = ({"type": "credits", "n": float(n)} if n > len(codes)
                        else {"type": "courses", "n": int(n)})
            else:
                continue
            buckets.append({
                "id": f"{slugify(name)}-{len(buckets)+1}",
                "name": blk.get("name") or f"Requirement {bi+1}",
                "pick": pick, "options": codes,
            })
    if not buckets:
        return None
    total = 0.0
    for b in buckets:
        opts = [c for c in b["options"] if c in by_code]
        avg = (sum(course_credits(by_code[c]) for c in opts) / len(opts)) if opts else 3.0
        if b["pick"]["type"] == "all":
            total += sum(course_credits(by_code[c]) for c in opts)
        elif b["pick"]["type"] == "courses":
            total += b["pick"]["n"] * avg
        else:
            total += b["pick"]["n"]
    credits = clamp_credits(p.get("credit_hours"), total, name)
    desig = str(p.get("degree_designation") or "").strip()
    # majors keep their degree designation ("Accounting (BS)"); minors/certs
    # would just repeat their own type ("Spanish (MIN)") -- drop it there.
    keep = ptype == "major" and desig.upper() not in ("", "NONE", "PRE")
    display = f"{name} ({desig})" if keep else name
    return {
        "id": f"{ptype}-{slugify(display)}",
        "name": display, "type": ptype,
        "college": (p.get("college") or "").strip() or None,
        "credits": credits, "buckets": buckets, "notes": notes[:8],
    }


def parse_ge(core: Dict[str, Any], id2code, by_code) -> Optional[Dict[str, Any]]:
    """University Core -> one 'choose 1' bucket per GE category.

    Each block mixes a primary option list with alternate multi-course combos
    (e.g. HIST 220 + POLI 210 instead of A HTG 100). The planner's bucket model
    is single-list, so we take the UNION of every course in the block with
    pick=1 and note that some alternates are two-course combos.
    """
    buckets = []
    notes: List[str] = []
    for bi, blk in enumerate(core.get("requirements") or []):
        union: List[str] = []
        combo_note = False
        for r in blk.get("rules") or []:
            if r.get("condition") == "freeformText":
                t = re.sub(r"\s+", " ", str(r.get("value") or "")).strip()
                if t:
                    notes.append(t[:300])
                continue
            codes = rule_codes(r, id2code, by_code)
            # A multi-course "completedAllOf" is an ALTERNATE combination (e.g.
            # HIST 220 + POLI 210 instead of A HTG 100). Surfacing its pieces as
            # standalone dropdown options is misleading, so skip combos here and
            # just flag that alternates exist. Single-course rules are the clean,
            # pickable options students actually choose from.
            if r.get("condition") == "completedAllOf" and len(codes) > 1:
                combo_note = True
                continue
            for c in codes:
                # "G E ###" is a catalog pseudo-subject used only inside combos —
                # never a real class a student registers for. Drop it.
                if c.startswith("G E ") or c not in by_code:
                    continue
                if c not in union:
                    union.append(c)
        if not union:
            continue
        gname = (GE_BLOCK_NAMES[bi] if bi < len(GE_BLOCK_NAMES)
                 else f"GE Requirement {bi+1}")
        want = GE_CHECKS.get(bi)
        if want and want not in union:
            print(f"  [warn] GE block {bi+1} labeled '{gname}' but missing "
                  f"signature course {want} — verify block order.")
        buckets.append({
            "id": f"ge-{slugify(gname)}",
            "name": gname,
            "pick": {"type": "courses", "n": 1},
            "options": union,
            "note": ("Some alternatives are two-course combinations — see the "
                     "catalog for exact pairings." if combo_note else None),
        })
    if not buckets:
        return None
    return {"name": "University Core (GE)", "buckets": buckets, "notes": notes[:6]}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

CONCURRENT_STRICT_RE = re.compile(
    r"^\s*concurrent\s+(?:enrollment|registration)\s+(?:in|with)\b", re.I)


def make_codes_in(by_code):
    """Build a free-text -> [course codes] resolver for a catalog. Handles
    implied-prefix carry-over: "Bio 377, 379" -> [BIO 377, BIO 379] (a bare
    number inherits the previous coded course's department)."""
    compact = lambda c: re.sub(r"[^A-Z0-9]", "", c.upper())
    cindex = {compact(code): code for code in by_code}
    depts = sorted({re.sub(r"\s*\d.*$", "", code).strip() for code in by_code if re.search(r"\d", code)},
                   key=len, reverse=True)

    def codes_in(text: str) -> List[str]:
        out, cur_dept = [], None
        tokens = re.findall(r"[A-Za-z][A-Za-z&]*|\d{3}[A-Za-z]?", text)
        i = 0
        while i < len(tokens):
            tok = tokens[i]
            if re.fullmatch(r"\d{3}[A-Za-z]?", tok):
                found = None
                for span in (3, 2, 1):
                    cand = " ".join(tokens[max(0, i - span):i])
                    for d in depts:
                        if cand.upper().endswith(d) and compact(d + tok) in cindex:
                            found = cindex[compact(d + tok)]; cur_dept = d; break
                    if found:
                        break
                if not found and cur_dept and compact(cur_dept + tok) in cindex:
                    found = cindex[compact(cur_dept + tok)]
                if found:
                    out.append(found)
            i += 1
        seen, res = set(), []
        for c in out:
            if c not in seen:
                seen.add(c); res.append(c)
        return res
    return codes_in


def parse_coreqs(courses: List[Dict[str, Any]], by_code) -> Dict[str, List[str]]:
    """Extract STRICT co-requisites ("Concurrent enrollment in X and Y") from
    each course's customFields.nonEnforcedPrerequisites: courses that must be
    taken the SAME term (a lab + its lecture): CH EN 445 -> 436/476.
    Excludes "X or concurrent enrollment" (handled as before-or-same prereqs)."""
    codes_in = make_codes_in(by_code)
    coreqs: Dict[str, List[str]] = {}
    for c in courses:
        code = (c.get("code") or "").strip()
        if not code or code not in by_code:
            continue
        nep = ((c.get("_raw_summary") or {}).get("customFields") or {}).get("nonEnforcedPrerequisites") or ""
        if not CONCURRENT_STRICT_RE.match(nep):
            continue
        targets = [t for t in codes_in(nep) if t != code]
        if targets:
            coreqs[code] = targets
    return coreqs


# Standing phrases -> minimum academic year (1-based). BYU commonly writes the
# real year gate in the non-enforced prereq text ("Senior standing.").
STANDING_YEAR = [
    (re.compile(r"\bsenior\s+(?:standing|status)\b", re.I), 4),
    (re.compile(r"\bjunior\s+(?:standing|status)\b", re.I), 3),
    (re.compile(r"\bsophomore\s+(?:standing|status)\b", re.I), 2),
]
# purely-advisory prereq text we should NOT turn into hard constraints
NEP_ADVISORY_RE = re.compile(r"^\s*(recommended|suggested|helpful|prefer)", re.I)
# consent-only lines with no real course ("Instructor's consent.")
NEP_CONSENT_ONLY_RE = re.compile(r"consent|permission|approval|application|interview|audition|department", re.I)
CAPSTONE_NAME_RE = re.compile(r"\bcapstone\b|\bsenior\s+(?:thesis|project|seminar)\b", re.I)


def nep_min_year(nep: str) -> int:
    for rx, y in STANDING_YEAR:
        if rx.search(nep):
            return y
    return 0


def parse_nep_prereqs(nep: str, self_code: str, codes_in) -> Tuple[List[List[str]], List[List[str]]]:
    """Free-text non-enforced prereqs -> (strict_groups, concurrent_groups).
    strict = must precede (each group is an AND; codes within are OR-alts).
    concurrent = before-OR-same-term ("Math 112 or concurrent enrollment").
    Conservative: unrecognizably complex text yields fewer/no constraints
    rather than wrong ones."""
    t = (nep or "").strip()
    if not t or NEP_ADVISORY_RE.match(t):
        return [], []
    codes = [c for c in codes_in(t) if c != self_code]
    if not codes:
        return [], []
    low = t.lower()
    if "concurrent" in low:
        # "X or concurrent enrollment" / "concurrent enrollment in X" -> X may
        # be taken before or the same term (never AFTER the dependent course)
        return [], [[c] for c in codes]
    # ANY "or" -> ONE OR-group of all alternatives. Mixed and/or grammar
    # ("ENGL 291, 292, and 293; or ENGL 291 and 294") can't be structured
    # reliably from free text — under-constraining (any one required) is safe;
    # treating it as AND-everything fabricated requirements (the ENGL 294
    # phantom that forced BOTH survey tracks into English plans).
    if " or " in low:
        return [codes], []
    return [[c] for c in codes], []  # AND: each strict prerequisite


def render_requisites_text(raw: Dict[str, Any], id2code, by_code) -> str:
    """Render a course's full requisitesSimple to a readable line — DISPLAY
    only (enforcement uses course_prereq_groups). Unlike that parser this walks
    BOTH shapes: `completedAllOf` (AND of value-groups; a group's codes joined
    by its own and/or logic) and `anyOf` (OR across sub-rules — BIO 350's
    "one of PHSCS 121 / 137 / 220"). Returns "" when nothing resolves."""
    def resolve(item) -> Optional[str]:
        item = str(item).strip()
        code = id2code.get(item)
        if code is None and BASE_ID_RE.match(item):
            code = id2code.get(BASE_ID_RE.match(item).group(1))
        if code is None and item in by_code:
            code = item
        return code

    def render_rule(rule) -> str:
        if rule.get("condition") == "anyOf":
            alts = [render_rule(sr) for sr in rule.get("subRules") or []]
            alts = [a for a in alts if a]
            # wrap AND-combinations before OR-joining so precedence is clear
            alts = [f"({a})" if " and " in a else a for a in alts]
            return " or ".join(dict.fromkeys(alts))
        v = rule.get("value")
        if not isinstance(v, dict):
            return ""
        groups = []
        for grp in v.get("values") or []:
            codes = []
            for item in grp.get("value") or []:
                c = resolve(item)
                if c and c not in codes:
                    codes.append(c)
            if codes:
                groups.append(" or ".join(codes) if len(codes) > 1 else codes[0])
        return " and ".join(groups)

    out = []
    for blk in (raw.get("requisites") or {}).get("requisitesSimple") or []:
        if str(blk.get("type") or "").lower() != "prerequisite":
            continue
        for rule in blk.get("rules") or []:
            r = render_rule(rule)
            if r and r not in out:
                out.append(r)
    text = "; ".join(out)
    # collapse repeats in a pure-OR chain ("A or B or C or A or D" from
    # overlapping alternative tracks -> "A or B or C or D")
    if text and " and " not in text and "(" not in text and ";" not in text:
        toks = [t.strip() for t in text.split(" or ")]
        text = " or ".join(dict.fromkeys(t for t in toks if t))
    return text


def prereq_text(struct_txt: str, nep: str) -> Optional[str]:
    """Human-readable prerequisite line for the course-detail card — the
    catalog's own phrasing. The rendered structured requisites come first; the
    non-enforced free text (the catalog's real prose — "Math 112.", "Acceptance
    into the Information Systems major") is appended verbatim, since it carries
    NON-course requirements (standing, admission, instructor consent) that never
    become codes. Advisory-only NEP ("recommended", "helpful") is dropped."""
    parts: List[str] = []
    if struct_txt:
        parts.append(struct_txt)
    nep_clean = re.sub(r"\s+", " ", (nep or "")).strip()
    if nep_clean and not NEP_ADVISORY_RE.match(nep_clean):
        low = parts[0].lower() if parts else ""
        # skip the NEP sentence when it only restates the codes we already showed
        if not (parts and re.sub(r"[^a-z0-9]", "", nep_clean.lower())
                in re.sub(r"[^a-z0-9]", "", low)):
            parts.append(nep_clean)
    text = "; ".join(parts).strip()
    return text[:240] or None


def main() -> int:
    cat = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    id2code, by_code, name2code = build_course_maps(cat["courses"])
    print(f"courses: {len(by_code)} unique codes ({len(cat['courses'])} raw)")

    codes_in = make_codes_in(by_code)
    out_courses: Dict[str, Any] = {}
    n_prereqs = n_nep = n_conc = n_year = 0
    for code, c in by_code.items():
        raw = c.get("_raw_summary") or {}
        off, rare, note = season_string(raw.get("courseTypicallyOffered") or "")
        entry: Dict[str, Any] = {"n": (c.get("name") or code).strip(),
                                 "c": course_credits(c), "off": off}
        if rare:
            entry["rare"] = True
        if note:
            entry["note"] = note
        pre = course_prereq_groups(raw, id2code, by_code)   # enforced (structured)
        struct_groups = list(pre)                            # snapshot for readable text

        # Non-enforced prereqs: BYU stores MOST real academic prereqs here as
        # free text (Math 290 "Math 112 or concurrent"; Math 113/213 "Math
        # 112."). Merge strict ones into `p`; keep concurrent-allowed in `pc`
        # (before-or-same). Strict-concurrent labs are already handled as
        # co-requisites (parse_coreqs), so skip those here.
        nep = ((raw.get("customFields") or {}).get("nonEnforcedPrerequisites") or "").strip()
        pc: List[List[str]] = []
        if nep and not CONCURRENT_STRICT_RE.match(nep):
            strict, conc = parse_nep_prereqs(nep, code, codes_in)
            have = {tuple(g) for g in pre}
            for g in strict:
                if tuple(g) not in have:
                    pre.append(g); have.add(tuple(g))
            pc = conc

        # Year restriction: "Senior standing." text, or a capstone course name
        min_y = nep_min_year(nep)
        if not min_y and CAPSTONE_NAME_RE.search(entry["n"]) and re.search(r"[4-9]\d\d", code):
            min_y = 4                                       # 400+ capstone -> senior

        if pre:
            entry["p"] = pre
            n_prereqs += 1
        if pc:
            entry["pc"] = pc
            n_conc += 1
        pt = prereq_text(render_requisites_text(raw, id2code, by_code), nep)
        if pt:
            entry["pt"] = pt
        if min_y:
            entry["minY"] = min_y
            n_year += 1
        vx = variable_credit_max(c)
        if vx is not None and vx > entry["c"]:
            entry["vx"] = vx
        if nep and not CONCURRENT_STRICT_RE.match(nep) and (pre or pc):
            n_nep += 1
        out_courses[code] = entry
    print(f"prereq chains: {n_prereqs} (of which {n_nep} used non-enforced text) "
          f"| concurrent-allowed: {n_conc} | year-restricted: {n_year}")

    latest = dedup_latest(cat["programs"])
    out_programs: List[Dict[str, Any]] = []
    synth: Dict[str, Any] = {}     # courses referenced by freeform but missing
    used_fallback = skipped = 0
    for p in latest:
        ptype = PROGRAM_TYPES.get(str(p.get("type")))
        if not ptype:
            continue
        if str(p.get("degree_designation") or "").strip().upper() in GRAD_DESIGS:
            continue                       # undergraduate planner only
        parsed = parse_freeform(p, id2code, by_code, name2code, ptype, synth)
        if parsed is None:
            parsed = parse_structured(p, id2code, by_code, ptype)
            if parsed is not None:
                used_fallback += 1
        if parsed is None:
            skipped += 1
            continue
        out_programs.append(parsed)

    # EMPHASIS-based majors: some majors (Communications, Statistics, Public
    # Health, ...) keep an EMPTY parent record — the real requirements live in
    # per-emphasis records ("Communications: Advertising"). Students declare an
    # emphasis anyway, so each emphasis becomes a selectable major.
    have_major = {re.sub(r"\s*\(.*\)$", "", p["name"]).split(":")[0].strip().lower()
                  for p in out_programs if p["type"] == "major"}
    n_emph = 0
    for p in latest:
        if str(p.get("type")).upper() != "EMPHASIS":
            continue
        if str(p.get("degree_designation") or "").strip().upper() in GRAD_DESIGS:
            continue
        base = str(p.get("name") or "").split(":")[0].strip().lower()
        if not base or base in have_major:
            continue                       # parent major already plannable
        parsed = parse_freeform(p, id2code, by_code, name2code, "major", synth)
        if parsed is None:
            continue
        out_programs.append(parsed)
        n_emph += 1
    if n_emph:
        print(f"emphasis-based majors added (parent had no requirements): {n_emph}")

    # language certificates from the CLS scrape (not in Coursedog at all)
    lang_certs = parse_language_certs(by_code)
    out_programs.extend(lang_certs)
    print(f"language certificates: {len(lang_certs)} added as selectable certs")

    # flowchart placement hints (course -> recommended year+season, cohort blocks)
    attach_flowchart_plans(out_programs, by_code, out_courses)

    # rule-built option pools for attribute-defined "approved elective"
    # requirements (ChemE EMSB = 300+ from engineering/math/science/business
    # colleges). The catalog states the rule, not the list — we build it.
    enrich_attr_pools(out_programs, cat, by_code, out_courses)

    # dedupe generated ids
    seen: Dict[str, int] = {}
    for prog in out_programs:
        n = seen.get(prog["id"], 0)
        seen[prog["id"]] = n + 1
        if n:
            prog["id"] += f"-{n+1}"

    out_courses.update(synth)      # make synthesized courses schedulable
    counts = {"major": 0, "minor": 0, "cert": 0}
    for prog in out_programs:
        counts[prog["type"]] += 1
    print(f"programs parsed: {counts} | structured fallback: {used_fallback} "
          f"| skipped (no requirements at all): {skipped} "
          f"| synthesized courses: {len(synth)}")

    # ---- data-health report (see docs/TUNING.md) --------------------------
    for prog in out_programs:
        if prog["type"] != "major":
            continue
        real = {o for b in prog["buckets"] for o in b.get("options", [])
                if not str(o).startswith("BUCKET::")}
        for b in prog["buckets"]:
            for g in b.get("groups", []):
                real |= set(g.get("options", []))
        if len(real) < 3:
            HEALTH.append(f"{prog['name']}: near-empty requirement data "
                          f"({len(real)} real courses) — plan would be all placeholders")
    if HEALTH:
        hp = DATA_PATH.parent / "_health_report.txt"
        hp.write_text("\n".join(sorted(HEALTH)) + "\n", encoding="utf-8")
        print(f"health: {len(HEALTH)} findings -> data/{hp.name}")
        for h in sorted(HEALTH)[:12]:
            print(f"  [health] {h}")

    cores = [p for p in cat["programs"] if p.get("name") == CORE_NAME]
    ge = parse_ge(max(cores, key=eff_date), id2code, by_code) if cores else None
    if ge:
        print(f"GE: {len(ge['buckets'])} categories: "
              + ", ".join(b["name"] for b in ge["buckets"]))

    coreqs = parse_coreqs(cat["courses"], by_code)
    print(f"co-requisites (strict 'concurrent enrollment in'): {len(coreqs)} courses")

    payload = {"generated": str(date.today()), "courses": out_courses,
               "programs": out_programs, "ge": ge, "coreqs": coreqs}
    js = ("/* AUTO-GENERATED by scraper/generate_data.py -- do not hand-edit.\n"
          f"   Source: data/catalog.json | generated {date.today()} */\n"
          "const CATALOG_DATA = " + json.dumps(payload, ensure_ascii=False) + ";\n")
    OUT_PATH.write_text(js, encoding="utf-8")
    print(f"wrote {OUT_PATH}  ({len(js)//1024} KB)")

    # sanity checks on the programs the user flagged
    for nm, ty in (("Accounting (BS)", "major"), ("Spanish", "minor")):
        hit = next((x for x in out_programs if x["name"] == nm and x["type"] == ty), None)
        if hit:
            print(f"  check: {hit['name']} -> {hit['credits']} cr, {len(hit['buckets'])} buckets: "
                  + " | ".join(f"{b['name'][:34]} ({len(b['options'])} opts)" for b in hit["buckets"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
