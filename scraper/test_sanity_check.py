#!/usr/bin/env python3
"""
test_sanity_check.py  --  tests for the publish gate's baseline handling
=======================================================================

Run:  python -m unittest test_sanity_check -v      (from scraper/)

Stdlib unittest on purpose: this machine has no pytest, and the gate is the
one piece of the pipeline whose failure is silent -- it just declines to
publish, and the site quietly serves last week's data. That happened for
three weeks running (2026-08-02 through 2026-08-09) and nobody noticed until
the date on the site was queried by hand.

The fixtures build a miniature site tree rather than touching scraper/data:
the real catalog.json is 73 MB and is not committed, so a test that needed it
could not run on a fresh checkout.

Author: Jordan Heaton
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import _sanity_check as sc  # noqa: E402


BASELINE_HEALTH = 24
REGRESSED_HEALTH = 63       # what the 2026-07-27 detectors actually produced


def build_site(root: Path, *, health_lines: int, courses: int = 7123,
               programs: int = 313) -> None:
    """Write a minimal generated-site tree and point the module at it."""
    js = root / "js"
    data = root / "data"
    js.mkdir(parents=True, exist_ok=True)
    data.mkdir(parents=True, exist_ok=True)

    catalog = {
        "generated": "2026-08-16",
        "courses": {"C%d" % i: {} for i in range(courses)},
        "programs": {"P%d" % i: {} for i in range(programs)},
        "coreqs": {},
    }
    js.joinpath("catalog_data.js").write_text(
        "const CATALOG_DATA = " + json.dumps(catalog) + ";", encoding="utf-8")
    js.joinpath("timeline_data.js").write_text(
        "const TIMELINE_DATA = " + json.dumps({"academicDates": [1, 2, 3, 4]})
        + ";", encoding="utf-8")

    for name in sc.LIST_SOURCES:
        data.joinpath(name + ".json").write_text(json.dumps([{}]),
                                                 encoding="utf-8")
    data.joinpath("_health_report.txt").write_text(
        "\n".join("finding %d" % i for i in range(health_lines)),
        encoding="utf-8")

    sc.JS = js
    sc.DATA = data
    sc.BASELINE_PATH = root / "refresh_baseline.json"


def write_baseline(root: Path, *, health: int = BASELINE_HEALTH,
                   courses: int = 7123, programs: int = 313) -> None:
    (root / "refresh_baseline.json").write_text(json.dumps({
        "generated": "2026-07-29",
        "metrics": {
            "catalog_js_parsed": True,
            "js_courses": courses,
            "js_programs": programs,
            "js_generated": "2026-07-29",
            "timeline_js_parsed": True,
            "health_findings": health,
            **{"src_" + n: 1 for n in sc.LIST_SOURCES},
        },
    }, indent=2), encoding="utf-8")


def run_gate(*argv: str) -> tuple[int, dict]:
    """Invoke main() with the given flags; return (exit code, verdict)."""
    sys.argv = ["_sanity_check.py", *argv]
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = sc.main()
    try:
        verdict = json.loads(buf.getvalue())
    except json.JSONDecodeError:
        verdict = {}
    return code, verdict


class GateBaselineTests(unittest.TestCase):

    def setUp(self) -> None:
        self._saved = (sc.JS, sc.DATA, sc.BASELINE_PATH)
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        sc.JS, sc.DATA, sc.BASELINE_PATH = self._saved
        self._tmp.cleanup()

    def baseline_health(self) -> int:
        return json.loads((self.root / "refresh_baseline.json")
                          .read_text(encoding="utf-8"))["metrics"]["health_findings"]

    # --- the regression that started this ---------------------------------

    def test_health_jump_blocks_publish(self) -> None:
        """A findings jump past the tolerance still blocks. Unchanged behavior."""
        build_site(self.root, health_lines=REGRESSED_HEALTH)
        write_baseline(self.root)
        code, verdict = run_gate()
        self.assertEqual(code, 2)
        self.assertFalse(verdict["ok"])
        self.assertTrue(any("health findings rose" in r
                            for r in verdict["reasons"]))

    def test_update_does_not_ratchet_past_a_failure(self) -> None:
        """--update writes only on success -- the deadlock, pinned as behavior."""
        build_site(self.root, health_lines=REGRESSED_HEALTH)
        write_baseline(self.root)
        code, _ = run_gate("--update")
        self.assertEqual(code, 2)
        self.assertEqual(self.baseline_health(), BASELINE_HEALTH)

    # --- the new escape hatch ---------------------------------------------

    def test_accept_records_the_audited_findings(self) -> None:
        """--accept ratchets past a health-only failure, so the gate unsticks."""
        build_site(self.root, health_lines=REGRESSED_HEALTH)
        write_baseline(self.root)
        code, _ = run_gate("--accept")
        self.assertEqual(code, 0)
        self.assertEqual(self.baseline_health(), REGRESSED_HEALTH)

    def test_accept_refuses_when_the_data_itself_broke(self) -> None:
        """A collapsed scrape is not a detector change -- --accept must refuse.

        Without this, one --accept on a bad run would bake a half-catalog in as
        the new known-good and permanently lower the guard.
        """
        build_site(self.root, health_lines=REGRESSED_HEALTH, courses=100)
        write_baseline(self.root)
        code, verdict = run_gate("--accept")
        self.assertEqual(code, 2)
        self.assertEqual(self.baseline_health(), BASELINE_HEALTH)
        self.assertTrue(any("courses" in r for r in verdict["reasons"]))

    def test_accept_still_writes_when_nothing_is_wrong(self) -> None:
        """--accept on a clean run behaves like --update, not like an error."""
        build_site(self.root, health_lines=BASELINE_HEALTH)
        write_baseline(self.root)
        code, _ = run_gate("--accept")
        self.assertEqual(code, 0)
        self.assertEqual(self.baseline_health(), BASELINE_HEALTH)


if __name__ == "__main__":
    unittest.main(verbosity=2)
