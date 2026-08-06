#!/usr/bin/env python3
"""Bake the advisor Worker's bundled data from the scraper's outputs.

The Python server computes two things at startup from local files the Worker
cannot read: the FORCE-CONTEXT documents (language certs + Marriott business
sheets, with their distinctive trigger words) and the program->college map used
to bias opportunity retrieval. A Worker has no filesystem, so both are baked to
JSON here and imported as modules at build time.

Run from this directory (uses the scraper venv):
    C:\\Users\\jorda\\venvs\\myplan-scraper\\Scripts\\python.exe generate_worker_data.py

Re-run whenever the weekly refresh changes language_certs.json,
marriott_business.json, or catalog.json — refresh_core.ps1 does this
automatically before deploying the Worker.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRAPER = HERE.parent / "scraper"
DATA = SCRAPER / "data"
OUT = HERE / "src" / "data"

sys.path.insert(0, str(SCRAPER / "sources"))
import opportunity_tags as ot                             # noqa: E402

FORCE_SOURCES = ("language_certs", "marriott_business")   # mirror advisor_server.py

GENERIC = {"language", "certificate", "cert", "the", "of", "and", "byu",
           "school", "business", "program", "studies", "global"}


def stopword_tokens(name: str) -> list:
    toks = {t for t in re.findall(r"[a-z]+", name.lower()) if len(t) > 2}
    return sorted(toks - GENERIC)


def norm_prog(s: str) -> str:
    s = re.sub(r"\s*\(.*?\)\s*", " ", s or "")
    s = re.sub(r"\b(minor|certificate|emphasis|track|bs|ba|bfa|bm|bgs|major)\b",
               " ", s, flags=re.I)
    return re.sub(r"\s+", " ", s).strip().lower()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)

    force = []
    for src in FORCE_SOURCES:
        path = DATA / f"{src}.json"
        for d in json.loads(path.read_text(encoding="utf-8")):
            name = (d.get("name") or "").strip()
            text = (d.get("text") or "").strip()
            if not name or not text:
                continue
            force.append({
                "name": name,
                "text": text[:4000],          # server truncated at use; bake it truncated
                "source": src,
                "url": d.get("url") or None,
                "triggers": stopword_tokens(name),
            })
    (OUT / "force_docs.json").write_text(
        json.dumps(force, ensure_ascii=False), encoding="utf-8")

    cat = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    colleges = {}
    for p in cat.get("programs", []):
        col = ot.normalize_college(p.get("college") or "")
        nm = norm_prog(p.get("name"))
        if col and nm and nm not in colleges:
            colleges[nm] = col
    (OUT / "program_colleges.json").write_text(
        json.dumps(colleges, ensure_ascii=False), encoding="utf-8")

    print(f"force_docs.json: {len(force)} docs "
          f"({(OUT / 'force_docs.json').stat().st_size // 1024} KB)")
    print(f"program_colleges.json: {len(colleges)} programs "
          f"({(OUT / 'program_colleges.json').stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
