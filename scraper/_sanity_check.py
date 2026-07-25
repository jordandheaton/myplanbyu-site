#!/usr/bin/env python3
"""
_sanity_check.py  --  the publish gate for scheduled refreshes
==============================================================

A scheduled scrape that quietly returns half a catalog is worse than one that
fails: the bad data would be committed and pushed to the live site. This script
measures the freshly generated output, compares it to the last known-good
numbers in `refresh_baseline.json`, and decides whether the refresh is fit to
ship.

The PowerShell jobs stay dumb -- they run this and read the exit code:

    0  gate passed, safe to publish
    2  gate FAILED, do not publish (reasons on stdout)
    1  the check itself broke (treat as a failure)

A machine-readable verdict goes to stdout as JSON either way, so the caller can
fold the metrics into its log and status file.

    python _sanity_check.py                 # check only
    python _sanity_check.py --update        # check, then ratchet the baseline
                                            #   forward on success

`--update` is called only after a successful publish, so the baseline always
reflects what is actually live.

Author: Jordan Heaton
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
JS = HERE.parent / "js"
BASELINE_PATH = HERE / "refresh_baseline.json"

# --- thresholds (see docs/superpowers/specs/2026-07-24-...-design.md) --------
# A real catalog edit never removes 5% of the courses at once; a broken scrape
# or a parser regression does.
MAX_COUNT_DROP_FRAC = 0.05
# generate_data.py logs one line per unresolved requirement. 24 findings was the
# 2026-07-24 baseline; a jump of more than 8 means the parser regressed, not
# that BYU edited eight programs in one week.
MAX_HEALTH_INCREASE = 8

# Sources whose JSON is a flat list of documents. A drop to zero here is the
# signature of a scraper that broke silently (clubs.py in particular -- it
# speaks the Mendix /xas/ protocol, which BYU can change without notice).
LIST_SOURCES = [
    "academic_dates", "clubs", "flowcharts", "language_certs", "maps",
    "marriott_business", "policies", "research_grants", "study_abroad",
    "transfer_credit", "tuition_graduation",
]


# Read with utf-8-sig throughout: it is identical to utf-8 for clean files but
# also swallows a UTF-8 BOM. PowerShell 5.1's `Set-Content -Encoding utf8` emits
# one, and a BOM would otherwise make a perfectly good file report as
# "unreadable" -- a misleading gate reason for what is really a 0-record scrape.
READ_ENCODING = "utf-8-sig"

# Metrics that describe the RUN rather than the data. They change on every
# scrape by definition, so writing them into the baseline would make the file
# differ every week even when BYU changed nothing -- an automated commit and a
# Pages redeploy per run, burying the weeks the catalog actually moved. They
# stay in the verdict, and so in _last_run.json, which is where "when did this
# run" belongs.
VOLATILE_KEYS = ("catalog_scraped_at",)


def parse_js_object(path: Path) -> Optional[Dict[str, Any]]:
    """Pull the object literal out of a `const NAME = {...};` generated file."""
    try:
        text = path.read_text(encoding=READ_ENCODING)
    except OSError:
        return None
    try:
        start = text.index("{")
        end = text.rindex("}")
    except ValueError:
        return None
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None


def load_json(path: Path) -> Optional[Any]:
    try:
        return json.loads(path.read_text(encoding=READ_ENCODING))
    except (OSError, json.JSONDecodeError):
        return None


def size_of(obj: Any) -> Optional[int]:
    if obj is None:
        return None
    if isinstance(obj, (list, dict)):
        return len(obj)
    return None


def collect_metrics() -> Dict[str, Any]:
    """Measure everything the gate cares about. `None` means unreadable."""
    m: Dict[str, Any] = {}

    catalog_js = parse_js_object(JS / "catalog_data.js")
    if catalog_js is None:
        m["catalog_js_parsed"] = False
        m["js_courses"] = None
        m["js_programs"] = None
        m["js_coreqs"] = None
    else:
        m["catalog_js_parsed"] = True
        m["js_courses"] = size_of(catalog_js.get("courses"))
        m["js_programs"] = size_of(catalog_js.get("programs"))
        m["js_coreqs"] = size_of(catalog_js.get("coreqs"))
        m["js_generated"] = catalog_js.get("generated")

    timeline_js = parse_js_object(JS / "timeline_data.js")
    m["timeline_js_parsed"] = timeline_js is not None
    if timeline_js is not None:
        m["timeline_academic_dates"] = size_of(timeline_js.get("academicDates"))

    catalog = load_json(DATA / "catalog.json")
    if isinstance(catalog, dict):
        m["catalog_programs"] = size_of(catalog.get("programs"))
        m["catalog_courses"] = size_of(catalog.get("courses"))
        meta = catalog.get("meta")
        if isinstance(meta, dict):
            m["catalog_scraped_at"] = meta.get("scraped_at")
    else:
        # catalog.json is a local-only build input; absent is not fatal on its
        # own (a weekly run that skipped the catalog step still has the JS).
        m["catalog_programs"] = None
        m["catalog_courses"] = None

    for name in LIST_SOURCES:
        m["src_" + name] = size_of(load_json(DATA / (name + ".json")))

    health = DATA / "_health_report.txt"
    if health.exists():
        lines = [ln for ln in health.read_text(encoding=READ_ENCODING).splitlines()
                 if ln.strip()]
        m["health_findings"] = len(lines)
    else:
        m["health_findings"] = None

    return m


def evaluate(metrics: Dict[str, Any],
             baseline: Dict[str, Any]) -> List[str]:
    """Return the list of blocking reasons. Empty list means the gate passes."""
    reasons: List[str] = []

    # --- rule 1: the generated output must be readable and non-empty ---------
    if not metrics.get("catalog_js_parsed"):
        reasons.append("js/catalog_data.js did not parse as JSON")
    if not metrics.get("timeline_js_parsed"):
        reasons.append("js/timeline_data.js did not parse as JSON")
    for key, label in (("js_courses", "courses"), ("js_programs", "programs")):
        val = metrics.get(key)
        if val is None:
            reasons.append("catalog_data.%s is missing" % label)
        elif val == 0:
            reasons.append("catalog_data.%s is empty" % label)

    # --- rule 2: counts must not collapse -----------------------------------
    for key, label in (
        ("js_courses", "catalog_data courses"),
        ("js_programs", "catalog_data programs"),
        ("catalog_courses", "catalog.json courses"),
        ("catalog_programs", "catalog.json programs"),
    ):
        new = metrics.get(key)
        old = baseline.get(key)
        if new is None or not isinstance(old, int) or old <= 0:
            continue
        floor = old * (1.0 - MAX_COUNT_DROP_FRAC)
        if new < floor:
            reasons.append(
                "%s fell %d -> %d (more than %.0f%% below last known good)"
                % (label, old, new, MAX_COUNT_DROP_FRAC * 100))

    # --- rule 3: no source may go from populated to zero ---------------------
    for name in LIST_SOURCES:
        key = "src_" + name
        new = metrics.get(key)
        old = baseline.get(key)
        if not isinstance(old, int) or old <= 0:
            continue
        if new == 0:
            reasons.append(
                "%s.json returned 0 records (was %d) -- scraper likely broken"
                % (name, old))
        elif new is None:
            reasons.append(
                "%s.json is unreadable or missing (was %d records)"
                % (name, old))

    # --- rule 4: the requirement parser must not regress --------------------
    new_h = metrics.get("health_findings")
    old_h = baseline.get("health_findings")
    if isinstance(new_h, int) and isinstance(old_h, int):
        if new_h > old_h + MAX_HEALTH_INCREASE:
            reasons.append(
                "health findings rose %d -> %d (limit +%d) -- requirement "
                "parsing regressed" % (old_h, new_h, MAX_HEALTH_INCREASE))

    return reasons


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--update", action="store_true",
                    help="on success, write the new metrics as the baseline")
    args = ap.parse_args()

    try:
        metrics = collect_metrics()
    except Exception as exc:  # the gate must never crash the caller ambiguously
        print(json.dumps({"ok": False, "error": "collect failed: %r" % exc}))
        return 1

    baseline = load_json(BASELINE_PATH)
    first_run = not isinstance(baseline, dict) or not baseline.get("metrics")
    base_metrics = {} if first_run else baseline["metrics"]

    reasons = evaluate(metrics, base_metrics)
    ok = not reasons

    verdict = {
        "ok": ok,
        "first_run": first_run,
        "reasons": reasons,
        "metrics": metrics,
        "baseline_generated": None if first_run else baseline.get("generated"),
    }
    print(json.dumps(verdict, indent=2))

    if ok and args.update:
        BASELINE_PATH.write_text(
            json.dumps({
                "_readme": "Last known-good scrape metrics. Written by "
                           "_sanity_check.py --update after a successful "
                           "publish; the gate compares each new scrape "
                           "against these numbers.",
                "generated": metrics.get("js_generated"),
                "metrics": {k: v for k, v in metrics.items()
                            if k not in VOLATILE_KEYS},
            }, indent=2) + "\n",
            encoding="utf-8")

    if not ok:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
