#!/usr/bin/env python3
"""
build_site.py -- assemble the deployable site into _site/ for GitHub Pages.

The repo holds the scraper, the Worker and the tests next to the site; only
these get served: index.html, css/, js/, and the favicons. Everything else
stays in the repo and off myplan.jordanheaton.com.

CACHE-BUSTING. myplan.jordanheaton.com is proxied through Cloudflare, which
caches .js and .css at the edge. After a deploy the origin is correct but
visitors can keep getting the old file until the TTL expires -- worse, a MIXED
build: on 2026-08-06 the site served a new solver.js beside a 251-second-old
app.js. So every local js/css reference in index.html gets ?v=<first 8 hex of
the file's SHA-256>. Each deploy that changes a file gives it a new URL;
unchanged files keep theirs and stay cached.

Ported from publish_site.ps1 (the mirror into the old deploy-only repo, retired
2026-10-24 when this repo became the source). Same stamping rule; the page is
byte-identical to the source apart from the ?v= stamps -- UTF-8 in, UTF-8 out,
no BOM added.

Usage:
    python build_site.py            # writes ./_site
    python build_site.py --out DIR
"""

from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FILES = ("index.html", "favicon.ico", "favicon.svg", "apple-touch-icon.png")
DIRS = ("css", "js")
STAMP_RE = re.compile(r'(?P<attr>(?:src|href)=")(?P<path>(?:js|css)/[^"?]+)"')


def build(out: Path) -> int:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for name in FILES:
        shutil.copy2(ROOT / name, out / name)
    for name in DIRS:
        shutil.copytree(ROOT / name, out / name)

    index = out / "index.html"
    html = index.read_bytes().decode("utf-8")
    stamped = 0

    def stamp(m: re.Match) -> str:
        nonlocal stamped
        target = out / m.group("path")
        if not target.is_file():
            return m.group(0)
        stamped += 1
        digest = hashlib.sha256(target.read_bytes()).hexdigest()[:8]
        return f'{m.group("attr")}{m.group("path")}?v={digest}"'

    index.write_bytes(STAMP_RE.sub(stamp, html).encode("utf-8"))
    print(f"built {out}: {len(FILES)} files, {', '.join(DIRS)}/ -- {stamped} asset(s) stamped")
    return 0 if stamped else 1      # no stamps means index.html changed shape


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "_site"))
    args = ap.parse_args()
    return build(Path(args.out))


if __name__ == "__main__":
    sys.exit(main())
