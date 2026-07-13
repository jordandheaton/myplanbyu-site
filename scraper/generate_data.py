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
               "MM", "MPH", "MISM", "JD", "LLM", "EDS", "MSW", "MENG", "DNP"}
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
        if not code:
            code = f"{cname_clean[:24]}*" if cname_clean else f"NEW*{cid[:8]}"
            if code not in synth:
                synth[code] = {"n": cname_clean or "New course (see catalog)",
                               "c": float(ccred) if ccred else 3.0, "off": "FW"}
        cred = float(ccred) if ccred else (course_credits(by_code[code]) if code in by_code else 3.0)
        if not any(c == code for c, _ in out):
            out.append((code, cred))
    return out


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
                txt = strip_tags(body)
                if txt:
                    notes.append(f"{header} {txt}".strip()[:400])
                continue
            auto += 1
            num = str(auto)                 # flat programs w/o R#/Option# labels
        k, unit = parse_quant(header)
        nodes[num] = {"num": num, "header": header, "k": k, "unit": unit,
                      "courses": courses, "children": []}
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
        if unit == "hour":
            pick = {"type": "credits", "n": (3.0 if k is None else k)}
        elif k is None or k >= len(opts):
            pick = {"type": "all"}
        else:
            pick = {"type": "courses", "n": int(k)}
        nm = re.sub(r"\s*[—–-]\s*", " — ", node["header"]).strip()
        return {"id": f"{slugify(name)}-{node['num'].replace('.', '-')}",
                "name": (label_prefix + nm)[:80], "pick": pick,
                "options": opts, "_creds": creds}

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
        # 'take': how many of the group's courses complete it
        if node["courses"] and node["unit"] != "hour" and node["k"] and node["k"] < len(node["courses"]):
            take = int(node["k"])
        elif node["unit"] == "hour":
            take = ("credits", node["k"] or 3)
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
                buckets.append({
                    "id": f"{slugify(name)}-{node['num'].replace('.', '-')}",
                    "name": (re.sub(r"\s*[—–-]\s*", " — ", node["header"]).strip())[:80],
                    "pick": {"type": "credits", "n": k},
                    "options": opts, "_creds": creds,
                })
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
    credits = p.get("credit_hours")
    if not isinstance(credits, (int, float)) or not credits:
        credits = round(total * 2) / 2

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

    plans: Dict[str, Any] = {}
    for li, layer in enumerate(layers):
        # MAP sheets (the weakest layer) are SEQUENCE hints only; department
        # flowcharts/overrides also FORCE-INCLUDE their courses (business core
        # like HRM 391 isn't in the catalog requirement lists but is required)
        forced = not (MAPS_PLANS.exists() and li == 0)
        for name, plan in layer.items():
            if name.startswith("_") or not isinstance(plan, dict):
                continue                    # _readme / metadata keys
            m = plans.setdefault(norm(name), {"name": name, "course_terms": {}, "cohorts": None})
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

    by_name = {p["name"]: p for p in programs}
    by_base = {}
    for p in programs:
        by_base.setdefault(norm(p["name"]), p)

    # compact-code index resolves spacing differences: "CS 111"/"C S 111" -> real
    compact = lambda c: re.sub(r"[^A-Z0-9]", "", c.upper())
    cindex = {compact(code): code for code in by_code}

    SEASON_OFF = {"F": "F", "W": "W"}
    attached = 0
    for key, plan in plans.items():
        prog = by_name.get(plan["name"]) or by_base.get(key)
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

        if hint:
            prog["flowchartPlan"] = hint
            if cohorts:
                prog["flowchartCohorts"] = cohorts
            attached += 1
    print(f"flowchart plans: attached to {attached} programs")


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
    credits = p.get("credit_hours")
    if not isinstance(credits, (int, float)) or not credits:
        credits = round(total * 2) / 2
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

def main() -> int:
    cat = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    id2code, by_code, name2code = build_course_maps(cat["courses"])
    print(f"courses: {len(by_code)} unique codes ({len(cat['courses'])} raw)")

    out_courses: Dict[str, Any] = {}
    n_prereqs = 0
    for code, c in by_code.items():
        raw = c.get("_raw_summary") or {}
        off, rare, note = season_string(raw.get("courseTypicallyOffered") or "")
        entry: Dict[str, Any] = {"n": (c.get("name") or code).strip(),
                                 "c": course_credits(c), "off": off}
        if rare:
            entry["rare"] = True
        if note:
            entry["note"] = note
        pre = course_prereq_groups(raw, id2code, by_code)
        if pre:
            entry["p"] = pre
            n_prereqs += 1
        out_courses[code] = entry
    print(f"courses with parsed prerequisite chains: {n_prereqs}")

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

    cores = [p for p in cat["programs"] if p.get("name") == CORE_NAME]
    ge = parse_ge(max(cores, key=eff_date), id2code, by_code) if cores else None
    if ge:
        print(f"GE: {len(ge['buckets'])} categories: "
              + ", ".join(b["name"] for b in ge["buckets"]))

    payload = {"generated": str(date.today()), "courses": out_courses,
               "programs": out_programs, "ge": ge}
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
