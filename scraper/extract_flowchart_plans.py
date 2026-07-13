#!/usr/bin/env python3
"""
extract_flowchart_plans.py  --  flowcharts.json -> data/flowchart_plans.json
============================================================================

Flowchart PDFs are 2-D grids; text extraction flattens them into a garbled
stream that regex can't reliably parse into "course -> which semester". Claude
reads that stream well, so this OFFLINE step has Claude convert each flowchart
into a structured per-semester plan, cached to JSON. generate_data.py then bakes
those placement hints into catalog_data.js, and the solver uses them to target
each course's recommended year+season (and to move junior-core cohorts as a
block). One-time per flowchart refresh -- no runtime LLM cost or unreliability.

    .\\.venv\\Scripts\\python.exe extract_flowchart_plans.py          # new only
    .\\.venv\\Scripts\\python.exe extract_flowchart_plans.py --force  # redo all

Output: data/flowchart_plans.json
    { "<program name>": {
        "terms":   [{"year":1-5,"season":"F|W","courses":["GSCM 401", ...]}],
        "cohorts": [{"label":"...","year":N,"season":"F|W","courses":[...]}] } }

Author: Jordan Heaton
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

import requests

FLOWCHARTS = Path(__file__).resolve().parent / "data" / "flowcharts.json"
OUT_PATH = Path(__file__).resolve().parent / "data" / "flowchart_plans.json"
MODEL = "claude-haiku-4-5"

SYSTEM = (
    "You convert a BYU major flowchart into a structured semester plan. Output "
    "ONLY valid JSON, no prose, no markdown fences.\n\n"
    "IMPORTANT — the input is a 2-D flowchart FLATTENED to text by a PDF "
    "extractor: side-by-side boxes are mashed together, and section labels can "
    "appear before/after the wrong course list. Do NOT trust the raw line "
    "order. Logically REASSEMBLE the chart: attach each course to the nearest "
    "section label that makes curricular sense (prereqs/precore are 100-200 "
    "level taken years 1-2; envelopes/cores are the major's upper-division "
    "block; 'senior year' groups come last), and use each course's SEASON "
    "token plus number level to sanity-check its year.\n\n"
    "Each course on the chart is written as: CODE  Name  SEASON  credits — where "
    "SEASON is F, W, Sp, Su or a combination like FWSpSu. That SEASON token is "
    "AUTHORITATIVE for which semester the course belongs to: a course marked 'F' "
    "goes in a Fall term, 'W' in Winter. If it lists many seasons (FWSpSu) it is "
    "flexible; place it wherever the chart's layout/section suggests.\n\n"
    "The chart groups courses into sections with labels like 'Prereqs' / 'Precore' "
    "(years 1-2), 'Junior Core' or 'Complete junior year, fall envelope' / "
    "'winter envelope' (year 3), and 'senior year' (year 4). An ENVELOPE / CORE is "
    "a RIGID cohort: the exact set of courses that must ALL be taken together in "
    "that one specific semester.\n"
    "EXCEPTION — inside a labeled envelope the ENVELOPE decides the semester, not "
    "the season token: every course listed under 'fall envelope' goes in that "
    "envelope's Fall term (and in that cohort) even if its own token says W — the "
    "token then only shows other offerings. Courses under a 'senior year' label "
    "go in year 4 even if the flattened text puts them near the junior core.\n\n"
    "Return exactly:\n"
    '{"terms":[{"year":<1-4>,"season":"F"|"W","courses":[{"code":"DEPT NUM",'
    '"credits":<number>}, ...]}],'
    '"cohorts":[{"label":"...","year":<1-4>,"season":"F"|"W",'
    '"courses":["DEPT NUM",...]}]}\n\n'
    "Rules:\n"
    "- Course codes EXACTLY as on the chart (keep internal spaces if shown): "
    "'GSCM 401','EC EN 340','C S 235','M COM 320','IS 401'. If the chart writes "
    "'CS 111' keep it as 'CS 111'.\n"
    "- Each course appears in 'terms' EXACTLY ONCE. Never list the same course in "
    "two terms. If unsure of the year for a flexible (FWSpSu) course, pick the "
    "earliest sensible year.\n"
    "- 'cohorts' = the labeled junior-core / envelope blocks ONLY. List the exact "
    "courses in each envelope (Fall envelope courses have season F; Winter "
    "envelope courses have season W). Every cohort course must also be in 'terms'.\n"
    "- OMIT generic placeholders: 'Elective', 'GE', 'Religion', 'Internship', "
    "'choose one', 'technical elective' — only concrete coded courses.\n"
    "- Do NOT invent courses or semesters. Only use what the chart shows."
)


def extract(text: str) -> dict:
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": os.environ["ANTHROPIC_API_KEY"],
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": MODEL, "max_tokens": 2500, "system": SYSTEM,
            "temperature": 0,           # deterministic: same chart -> same plan
            "messages": [{"role": "user", "content": text[:8000]}],
        },
        timeout=120,
    )
    resp.raise_for_status()
    raw = resp.json()["content"][0]["text"]
    raw = raw[raw.find("{"):raw.rfind("}") + 1]
    return json.loads(raw)


def norm_code(c: str) -> str:
    return re.sub(r"\s+", " ", c).strip().upper()


def main() -> int:
    force = "--force" in sys.argv
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY not set (.env).", file=sys.stderr)
        return 1

    docs = json.loads(FLOWCHARTS.read_text(encoding="utf-8"))
    # one plan per program: the NEWEST sheet by year in the URL/name (the
    # incoming-freshman chart). Departments sometimes hub-list an undated or
    # older chart first, so "first non-additional doc" is not reliable.
    def doc_year(d) -> int:
        s = f"{d.get('url', '')} {d.get('name', '')}"
        years = [int(y) for y in re.findall(r"20(\d\d)", s)]
        years += [int(a) for a, _ in re.findall(r"\b(\d\d)-(\d\d)\b", s) if 18 <= int(a) <= 35]
        return max(years) if years else 0

    primary = {}
    for d in docs:
        prog = re.sub(r"\s*\(additional sheet \d+\)", "",
                      d["name"]).replace(" Official Major Flowchart", "").strip()
        y = doc_year(d)
        cur = primary.get(prog)
        # higher year wins; ties go to the hub's primary (non-additional) sheet
        if cur is None or y > cur[0] or (y == cur[0] and "additional sheet" not in d["name"]
                                         and "additional sheet" in cur[1]["name"]):
            primary[prog] = (y, d)
    primary = {k: v[1] for k, v in primary.items()}

    existing = {}
    if OUT_PATH.exists() and not force:
        existing = json.loads(OUT_PATH.read_text(encoding="utf-8"))

    out = dict(existing)
    for prog, doc in primary.items():
        # cached plans are tied to the exact sheet they came from — a newer
        # sheet appearing in the hub invalidates the cache automatically
        if prog in out and not force and out[prog].get("_src") == doc.get("url"):
            print(f"[skip cached] {prog}")
            continue
        print(f"[extract] {prog} ...", end=" ", flush=True)
        try:
            plan = extract(doc["text"])
        except Exception as exc:
            print(f"FAILED ({exc})")
            continue
        # normalize codes; terms carry {code, credits}, cohorts carry codes.
        # de-dup a course across terms (keep first occurrence).
        seen = set()
        for t in plan.get("terms", []):
            kept = []
            for c in t.get("courses", []):
                code = norm_code(c["code"] if isinstance(c, dict) else c)
                cred = (c.get("credits") if isinstance(c, dict) else None)
                if code in seen:
                    continue
                seen.add(code)
                kept.append({"code": code, "credits": cred})
            t["courses"] = kept
        for c in plan.get("cohorts", []):
            c["courses"] = [norm_code(x["code"] if isinstance(x, dict) else x)
                            for x in c.get("courses", [])]
        n_courses = sum(len(t["courses"]) for t in plan.get("terms", []))
        plan["_src"] = doc.get("url")
        out[prog] = plan
        print(f"{n_courses} courses, {len(plan.get('cohorts', []))} cohorts")
        time.sleep(0.4)

    OUT_PATH.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nWrote {len(out)} flowchart plans -> {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
