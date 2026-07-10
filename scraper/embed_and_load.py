#!/usr/bin/env python3
"""
embed_and_load.py  --  myplanBYU catalog -> local embeddings -> Pinecone
========================================================================

Reads the scraped BYU catalog (data/catalog.json), turns every course and
program into a clean, human-readable text chunk, embeds each chunk *locally and
for free* with a small open-source model, and upserts the vectors into a
Pinecone serverless index for RAG retrieval.

Pipeline
--------
    catalog.json
        -> readable text chunk per course / program  (build_records)
        -> 384-dim dense vectors  (BAAI/bge-small-en-v1.5, runs on your CPU/GPU)
        -> Pinecone serverless index "myplanbyu-catalog"  (batched upserts)

Cost: $0 for embeddings (model runs locally). Pinecone free tier for storage.

Usage
-----
    # 1. install deps
    pip install -r requirements.txt

    # 2. provide your Pinecone key (see README -- do NOT hard-code it)
    #    PowerShell:  $env:PINECONE_API_KEY = "pcsk_..."
    #    bash:        export PINECONE_API_KEY="pcsk_..."

    # 3. run
    python embed_and_load.py

    # dry run: build + inspect chunks without loading the model or touching
    # Pinecone (great for sanity-checking the parsing):
    python embed_and_load.py --dry-run
    python embed_and_load.py --dry-run --limit 5 --show

Author: Jordan Heaton
"""

from __future__ import annotations

import argparse
import html as htmllib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

# Load secrets from a local .env file (e.g. PINECONE_API_KEY) if python-dotenv
# is installed. This keeps the key out of the source code. It's optional: if the
# variable is already set in the environment, that value wins.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

# --- CPU throttle -----------------------------------------------------------
# A full embed pins every core at 100% for minutes, which was thermally
# shutting the machine down (Kernel-Power 41, no BSOD). Cap the math libraries
# to half the cores so it runs cooler (a bit slower, but it finishes). Override
# with the EMBED_THREADS env var. MUST be set before torch/numpy are imported,
# so it lives here at module load -- torch is only imported later, in load_model.
CPU_THREADS = int(os.environ.get("EMBED_THREADS") or max(1, (os.cpu_count() or 4) // 2))
for _var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_var, str(CPU_THREADS))

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DATA_PATH = Path(__file__).resolve().parent / "data" / "catalog.json"

INDEX_NAME = "myplanbyu-catalog"
EMBED_MODEL = "BAAI/bge-small-en-v1.5"   # 384-dim, free, runs locally
EMBED_DIM = 384                          # must match the model's output size

# Pinecone serverless placement (standard free-tier location)
PINECONE_CLOUD = "aws"
PINECONE_REGION = "us-east-1"
PINECONE_METRIC = "cosine"

UPSERT_BATCH = 100      # vectors per upsert call (payload-size safety)
EMBED_BATCH = 64        # sentences per model.encode() batch

# --- Junk / test-record filtering -----------------------------------------
# BYU's live catalog carries a few of the registrar's own CMS test records.
# These signals are deliberately VERY specific: broad words like "test" or
# "placeholder" appear in plenty of *real* courses (e.g. "Testing of Soils",
# DIGHT 270 which teaches about localization placeholders), so we only match
# unmistakable sandbox data to avoid deleting legitimate courses.
JUNK_SUBJECTS = {"TEST"}                     # e.g. "TEST 101 - Test Class"
JUNK_PHRASES = (
    "testing whether or not",                # "Haley Test w/ Action"
    "will stick",
    "this is a test course",
    "please ignore this",
)

# Cap how many course codes we spell out inside a single requirement line so a
# giant GE list doesn't blow past the embedding model's context window (or
# Pinecone's 40 KB/vector metadata limit). The full resolved list still lives in
# catalog.json; this only affects the readable chunk.
MAX_CODES_IN_TEXT = 40

# Cap the rendered requirement text stored per program (Pinecone metadata is
# capped at 40 KB/vector). Almost every program is far under this; only a few
# huge elective dumps (e.g. Political Science) approach it.
MAX_REQ_CHARS = 20000


# ---------------------------------------------------------------------------
# Small parsing helpers
# ---------------------------------------------------------------------------

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def clean_text(value: Optional[str]) -> str:
    """Strip HTML tags and collapse whitespace to a single space."""
    if not value:
        return ""
    return _WS_RE.sub(" ", _TAG_RE.sub(" ", str(value))).strip()


def course_credits(course: Dict[str, Any]) -> Tuple[str, Optional[float]]:
    """Return (display_string, numeric_value) for a course's credit hours.

    Course credit_hours looks like:
        {"creditHours": {"min": 3, "value": 3, "operator": ""}, ...}
    but we stay defensive in case it's a bare number or missing.
    """
    ch = course.get("credit_hours")
    if isinstance(ch, (int, float)):
        return str(ch), float(ch)
    if isinstance(ch, dict):
        inner = ch.get("creditHours") if isinstance(ch.get("creditHours"), dict) else ch
        if isinstance(inner, dict):
            val = inner.get("value")
            lo, hi = inner.get("min"), inner.get("max")
            if lo is not None and hi is not None and lo != hi:
                return f"{lo}-{hi}", None
            if val is not None:
                try:
                    return str(val), float(val)
                except (TypeError, ValueError):
                    return str(val), None
    return "N/A", None


_BASE_ID_RE = re.compile(r"^(\d{4,6}-\d{2,3})")


def build_course_index(courses: List[Dict[str, Any]]) -> Dict[str, str]:
    """Map Coursedog course id -> readable code (e.g. '00011-009' -> 'IS 201').

    Program requirement rules reference courses by their BASE id ('08961-000'),
    but many course records carry a catalog-year suffix ('08961-000-2023-09-05').
    We index BOTH the full id and the base id so those references still resolve --
    otherwise real courses (IS 201, IS 302, ACC 200, ...) silently drop out of a
    program's requirement list.
    """
    idx: Dict[str, str] = {}
    for c in courses:
        cid, code = c.get("course_id"), c.get("code")
        if not cid or not code:
            continue
        idx[cid] = code
        m = _BASE_ID_RE.match(str(cid))
        if m:
            idx.setdefault(m.group(1), code)  # base id -> code (keep exact if present)
    return idx


def _collect_strings(obj: Any, out: set) -> None:
    """Recursively gather every string value inside a nested dict/list."""
    if isinstance(obj, str):
        out.add(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            _collect_strings(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _collect_strings(v, out)


def codes_from(node: Any, course_index: Dict[str, str]) -> List[str]:
    """Resolve every internal course-id referenced under `node` to a sorted list of codes."""
    found: set = set()
    _collect_strings(node, found)
    return sorted({course_index[s] for s in found if s in course_index})


def format_code_list(codes: List[str]) -> str:
    """Render a course-code list, truncated so chunks stay a sane size."""
    if not codes:
        return ""
    shown = codes[:MAX_CODES_IN_TEXT]
    extra = len(codes) - len(shown)
    text = ", ".join(shown)
    if extra > 0:
        text += f" (+{extra} more)"
    return text


def _first_number(*candidates: Any) -> Optional[Any]:
    for c in candidates:
        if isinstance(c, (int, float)):
            return c
        if isinstance(c, str) and c.strip().replace(".", "", 1).isdigit():
            return c.strip()
    return None


# ---------------------------------------------------------------------------
# Requirement-rule -> English
# ---------------------------------------------------------------------------

def summarize_rule(rule: Dict[str, Any], course_index: Dict[str, str]) -> str:
    """Turn one Coursedog requirement rule into a readable sentence."""
    cond = rule.get("condition")
    codes = codes_from(rule.get("value"), course_index)
    listed = format_code_list(codes)

    if cond == "completedAllOf":
        return f"complete all of: {listed}" if codes else "complete required courses"
    if cond in ("completedAnyOf", "anyOf"):
        return f"complete any of: {listed}" if codes else "complete any of the listed courses"
    if cond == "completedAtLeastXOf":
        n = rule.get("restriction") or _first_number(
            (rule.get("value") or {}).get("restriction")
        ) or "a number of"
        return f"complete at least {n} of: {listed}" if codes else f"complete at least {n} listed courses"
    if cond == "minimumGrade":
        grade = rule.get("grade") or rule.get("value", {}).get("grade") or ""
        stem = f"earn at least a {grade}".strip()
        return f"{stem} in: {listed}" if codes else stem
    if cond == "minimumCredits":
        credits = _first_number(
            rule.get("credits"),
            (rule.get("value") or {}).get("credits"),
            (rule.get("value") or {}).get("value"),
        )
        base = f"complete at least {credits} credits" if credits else "complete a minimum number of credits"
        return f"{base} from: {listed}" if codes else base
    if cond == "freeformText":
        return clean_text(rule.get("value") or rule.get("text"))

    # Unknown condition: degrade gracefully rather than crash.
    return f"{cond}: {listed}".strip(": ") if cond else (listed or "")


def summarize_requirements(
    requirements: Optional[List[Dict[str, Any]]],
    course_index: Dict[str, str],
) -> str:
    """Turn a program's requirement blocks into a readable multi-part summary."""
    if not requirements:
        return "No structured course requirements listed."
    parts: List[str] = []
    for block in requirements:
        if not isinstance(block, dict):
            continue
        block_name = clean_text(block.get("name")) or "Requirement"
        rule_texts = [
            t for t in (summarize_rule(r, course_index) for r in block.get("rules", []) if isinstance(r, dict))
            if t
        ]
        if rule_texts:
            parts.append(f"{block_name}: " + "; ".join(rule_texts) + ".")
    return " ".join(parts) if parts else "No structured course requirements listed."


# ---------------------------------------------------------------------------
# Freeform requirements (the HTML the catalog actually renders)
# ---------------------------------------------------------------------------
# Many programs author requirements as an HTML blob in requisitesFreeform rather
# than as structured requisitesSimple rules. That HTML is exactly what the
# catalog site displays -- full nesting, "complete N of M" options, and notes --
# with each course referenced via a `data-course-id="..."` link. Rendering it to
# text (and resolving those links to codes) reproduces the catalog page.

_COURSE_LINK_RE = re.compile(r'<a[^>]*data-course-id="([^"]+)"[^>]*>.*?</a>', re.S)
_COURSE_ID_ATTR_RE = re.compile(r'data-course-id="([^"]+)"')


def render_freeform(raw_html: str, course_index: Dict[str, str]) -> str:
    """Turn a requisitesFreeform HTML blob into clean, readable requirement text."""
    # Replace each course anchor ("<a ...>course</a>") with its resolved code.
    def repl(m: "re.Match") -> str:
        return course_index.get(m.group(1), "course")

    s = _COURSE_LINK_RE.sub(repl, raw_html)
    s = re.sub(r"</p>|</li>|<br\s*/?>|</h\d>", "\n", s, flags=re.I)  # block breaks
    s = re.sub(r"<[^>]+>", "", s)                                    # drop tags
    s = htmllib.unescape(s)
    s = s.replace("\xa0", " ")                                        # nbsp
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n[ \t]*", "\n", s)
    s = re.sub(r"\n{2,}", "\n", s).strip()
    return s


def freeform_course_codes(raw_html: str, course_index: Dict[str, str]) -> List[str]:
    """Resolve every course referenced in a freeform blob to a sorted list of codes."""
    codes = {
        course_index[cid]
        for cid in _COURSE_ID_ATTR_RE.findall(raw_html)
        if cid in course_index
    }
    return sorted(codes)


def program_requirements(
    program: Dict[str, Any], course_index: Dict[str, str]
) -> tuple[str, List[str], str]:
    """Best requirement text + resolved codes for a program, freeform-preferred.

    Returns (readable_text, course_codes, source) where source is
    'freeform' | 'structured' | 'none' so retrieval can tell where it came from.
    """
    ff = (program.get("requisites") or {}).get("requisitesFreeform")
    ff_html = ff.get("value") if isinstance(ff, dict) else None

    if ff_html and ff_html.strip():
        text = render_freeform(ff_html, course_index)
        if len(text) > MAX_REQ_CHARS:
            text = text[:MAX_REQ_CHARS].rstrip() + " ...(truncated)"
        return text, freeform_course_codes(ff_html, course_index), "freeform"

    if program.get("requirements"):
        return (
            summarize_requirements(program.get("requirements"), course_index),
            program.get("required_course_codes") or [],
            "structured",
        )

    return "No course requirements listed in the catalog.", [], "none"


# ---------------------------------------------------------------------------
# Record construction  (text chunk + metadata per vector)
# ---------------------------------------------------------------------------

class Record(Dict[str, Any]):
    """Just a dict; the alias documents intent: {id, text, metadata}."""


def course_to_record(course: Dict[str, Any], course_index: Dict[str, str]) -> Optional[Record]:
    code = course.get("code")
    cid = course.get("course_id")
    if not code or not cid:
        return None

    name = clean_text(course.get("name")) or code
    credit_disp, credit_num = course_credits(course)
    prereq_codes = [c for c in codes_from(course.get("prerequisites"), course_index) if c != code]
    prereq_disp = format_code_list(prereq_codes) or "None"
    description = clean_text(course.get("description")) or "No description available."

    # SIS offering pattern ("Fall and Winter", "Winter Even Years", ...) --
    # essential for schedule building: an elective that only runs every other
    # winter can't be penciled into just any semester. Already captured in the
    # course's _raw_summary; "Contact Department" carries no signal, drop it.
    offered = clean_text(
        (course.get("_raw_summary") or {}).get("courseTypicallyOffered")
    )
    if offered.lower() == "contact department":
        offered = ""

    text = (
        f"Course: {code}. Title: {name}. Credits: {credit_disp}. "
        f"Prerequisites: {prereq_disp}. "
        + (f"Typically offered: {offered}. " if offered else "")
        + f"Description: {description}"
    )

    metadata: Dict[str, Any] = {
        "source": "catalog",
        "type": "course",
        "id": code,
        "name": name,
        "subject": course.get("subject") or "",
        "text": text,
    }
    if credit_num is not None:
        metadata["credits"] = credit_num
    if prereq_codes:
        metadata["prerequisites"] = prereq_codes  # list[str] is a valid metadata type
    if offered:
        metadata["typically_offered"] = offered

    return Record(id=f"course::{cid}", text=text, metadata=metadata)


def program_to_record(program: Dict[str, Any], course_index: Dict[str, str]) -> Optional[Record]:
    pid = program.get("program_id")
    name = clean_text(program.get("name"))
    if not pid or not name:
        return None

    ptype = clean_text(program.get("type")) or "Program"
    designation = clean_text(program.get("degree_designation"))
    college = clean_text(program.get("college"))
    description = clean_text(program.get("description"))
    # Freeform-preferred: reproduce the rendered catalog page when available,
    # else fall back to the structured requisitesSimple rules.
    req_text, required_codes, req_source = program_requirements(program, course_index)

    label = f"{name} ({designation})" if designation else name
    text_parts = [f"Program: {label}.", f"Type: {ptype}."]
    if college:
        text_parts.append(f"College: {college}.")
    if description:
        text_parts.append(f"Description: {description}")
    text_parts.append(f"Requirements:\n{req_text}")
    text = "\n".join(text_parts)

    metadata: Dict[str, Any] = {
        "source": "catalog",        # tags origin for multi-source retrieval later
        "type": "program",
        "id": name,                 # human-facing id, per spec (e.g. "Information Systems")
        "name": name,
        "program_type": ptype,
        "req_source": req_source,   # 'freeform' | 'structured' | 'none'
        "text": text,
    }
    if designation:
        metadata["degree_designation"] = designation
    if college:
        metadata["college"] = college
    if required_codes:
        # Cap the list stored in metadata to stay well under Pinecone's 40 KB/vector.
        metadata["required_courses"] = required_codes[:200]

    return Record(id=f"program::{pid}", text=text, metadata=metadata)


def is_junk_record(item: Dict[str, Any]) -> bool:
    """True for the registrar's CMS test/sandbox records (see JUNK_* config)."""
    if str(item.get("subject", "")).strip().upper() in JUNK_SUBJECTS:
        return True
    blob = f"{item.get('name', '')} {item.get('description', '')}".lower()
    return any(phrase in blob for phrase in JUNK_PHRASES)


# ---------------------------------------------------------------------------
# Catalog-year de-duplication
# ---------------------------------------------------------------------------
# Coursedog returns multiple catalog-year versions of the same program/course
# (e.g. the 2024-25 AND the 2025-26 "Information Systems, BS"). We keep only the
# newest, so the advisor never sees two conflicting requirement sets.

def _effective_date(rec: Dict[str, Any]) -> str:
    """Effective start date: from _raw_summary if present, else the id suffix."""
    raw = rec.get("_raw_summary") or {}
    if raw.get("effectiveStartDate"):
        return str(raw["effectiveStartDate"])
    ident = str(rec.get("program_id") or rec.get("course_id") or "")
    m = re.search(r"(\d{4}-\d{2}-\d{2})$", ident)
    return m.group(1) if m else ""


def dedup_latest(records: List[Dict[str, Any]], key_fn, id_prefix: str):
    """Keep the newest record per key. Returns (kept_records, stale_vector_ids)."""
    groups: Dict[Any, List[Dict[str, Any]]] = {}
    for r in records:
        groups.setdefault(key_fn(r), []).append(r)
    kept, stale = [], []
    for recs in groups.values():
        if len(recs) == 1:
            kept.append(recs[0])
            continue
        newest_first = sorted(recs, key=_effective_date, reverse=True)
        kept.append(newest_first[0])
        keep_id = newest_first[0].get("program_id") or newest_first[0].get("course_id")
        for r in newest_first[1:]:
            rid = r.get("program_id") or r.get("course_id")
            if rid and rid != keep_id:          # never delete the kept vector
                stale.append(f"{id_prefix}::{rid}")
    return kept, stale


def dedup_catalog(catalog: Dict[str, Any]):
    """Dedup courses (by code) + programs (by name/type/designation) to newest."""
    courses, c_stale = dedup_latest(
        catalog.get("courses", []), lambda c: c.get("code"), "course")
    programs, p_stale = dedup_latest(
        catalog.get("programs", []),
        lambda p: (p.get("name"), p.get("type"), p.get("degree_designation")),
        "program")
    return courses, programs, c_stale + p_stale


def build_records(catalog: Dict[str, Any], filter_junk: bool = True) -> List[Record]:
    """Build every vector record (courses + programs) from the catalog."""
    # Index from ALL courses (pre-dedup) so any referenced id still resolves.
    course_index = build_course_index(catalog.get("courses", []))
    # Keep only the newest catalog-year version of each course + program.
    courses, programs, _stale = dedup_catalog(catalog)

    records: List[Record] = []
    skipped = 0
    junk = 0

    for c in courses:
        if filter_junk and is_junk_record(c):
            junk += 1
            print(f"  [junk] dropped course {c.get('code')!r} ({c.get('name')!r})")
            continue
        try:
            rec = course_to_record(c, course_index)
            records.append(rec) if rec else None
            if rec is None:
                skipped += 1
        except Exception as exc:  # one bad record shouldn't sink the batch
            skipped += 1
            print(f"  [warn] skipped course {c.get('code')!r}: {exc}")

    for p in programs:
        if filter_junk and is_junk_record(p):
            junk += 1
            print(f"  [junk] dropped program {p.get('name')!r}")
            continue
        try:
            rec = program_to_record(p, course_index)
            records.append(rec) if rec else None
            if rec is None:
                skipped += 1
        except Exception as exc:
            skipped += 1
            print(f"  [warn] skipped program {p.get('name')!r}: {exc}")

    print(f"Built {len(records)} records "
          f"({sum(1 for r in records if r['metadata']['type']=='course')} courses, "
          f"{sum(1 for r in records if r['metadata']['type']=='program')} programs); "
          f"{junk} junk filtered, {skipped} skipped.")
    return records


# ---------------------------------------------------------------------------
# Other sources (study abroad, certificates, ...) -- generic document lists
# ---------------------------------------------------------------------------
# Every non-catalog scraper in sources/ writes data/<source>.json as a plain
# list of {id, source, type, name, url, text} documents. We embed those as-is,
# alongside the catalog, so the advisor retrieves across all sources at once.

def source_doc_to_record(doc: Dict[str, Any]) -> Optional[Record]:
    did, text = doc.get("id"), doc.get("text")
    if not did or not text:
        return None
    meta: Dict[str, Any] = {
        "source": doc.get("source", "external"),
        "type": doc.get("type", "document"),
        "id": doc.get("name") or did,
        "name": doc.get("name") or did,
        "text": text,
    }
    if doc.get("url"):
        meta["url"] = doc["url"]
    return Record(id=str(did), text=text, metadata=meta)


def load_source_records(data_dir: Path) -> List[Record]:
    """Load every data/*.json that is a source-document list (not the catalog)."""
    records: List[Record] = []
    for path in sorted(data_dir.glob("*.json")):
        if path.name == DATA_PATH.name:      # catalog.json is handled separately
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"  [warn] could not read {path.name}: {exc}")
            continue
        if not isinstance(payload, list):    # only document-list sources
            continue
        n = 0
        for doc in payload:
            if isinstance(doc, dict):
                rec = source_doc_to_record(doc)
                if rec:
                    records.append(rec)
                    n += 1
        if n:
            print(f"  loaded {n} documents from {path.name}")
    return records


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------

def load_model():
    """Load the local sentence-transformers model (downloads once, then cached)."""
    from sentence_transformers import SentenceTransformer  # lazy import: keeps --dry-run light
    try:
        import torch
        torch.set_num_threads(CPU_THREADS)  # keep PyTorch off every core (heat)
    except Exception:
        pass
    print(f"Loading embedding model '{EMBED_MODEL}' "
          f"(CPU threads capped at {CPU_THREADS} of {os.cpu_count()}; "
          f"first run downloads ~130 MB)...")
    model = SentenceTransformer(EMBED_MODEL)
    # sentence-transformers 5.x renamed this; support both old and new names.
    dim_fn = getattr(model, "get_embedding_dimension", None) or model.get_sentence_embedding_dimension
    got = dim_fn()
    if got != EMBED_DIM:
        raise SystemExit(
            f"Model dimension {got} != configured EMBED_DIM {EMBED_DIM}. "
            f"Fix EMBED_DIM / index dimension to match."
        )
    return model


def embed_texts(model, texts: List[str]) -> List[List[float]]:
    """Embed a list of texts -> list of normalized 384-dim vectors."""
    vectors = model.encode(
        texts,
        batch_size=EMBED_BATCH,
        normalize_embeddings=True,   # cosine similarity wants unit vectors
        show_progress_bar=False,
        convert_to_numpy=True,
    )
    return vectors.tolist()


# ---------------------------------------------------------------------------
# Pinecone
# ---------------------------------------------------------------------------

def get_pinecone_index():
    """Connect to Pinecone, creating the serverless index if it doesn't exist."""
    from pinecone import Pinecone, ServerlessSpec

    api_key = os.environ.get("PINECONE_API_KEY")
    if not api_key:
        raise SystemExit(
            "PINECONE_API_KEY environment variable is not set.\n"
            "  PowerShell:  $env:PINECONE_API_KEY = \"pcsk_...\"\n"
            "  bash/zsh:    export PINECONE_API_KEY=\"pcsk_...\"\n"
            "See README_SCRAPER.md for details."
        )

    pc = Pinecone(api_key=api_key)

    existing = {ix["name"] for ix in pc.list_indexes()}
    if INDEX_NAME not in existing:
        print(f"Index '{INDEX_NAME}' not found -- creating serverless index "
              f"(dim={EMBED_DIM}, metric={PINECONE_METRIC}, {PINECONE_CLOUD}/{PINECONE_REGION})...")
        pc.create_index(
            name=INDEX_NAME,
            dimension=EMBED_DIM,
            metric=PINECONE_METRIC,
            spec=ServerlessSpec(cloud=PINECONE_CLOUD, region=PINECONE_REGION),
        )
        # Wait until the index is ready to receive writes.
        for _ in range(60):
            if pc.describe_index(INDEX_NAME).status.get("ready"):
                break
            time.sleep(1)
        print("Index is ready.")
    else:
        print(f"Index '{INDEX_NAME}' already exists -- reusing it.")

    return pc.Index(INDEX_NAME)


def chunked(seq: List[Any], size: int) -> Iterable[List[Any]]:
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def upload(records: List[Record], model) -> None:
    """Embed and upsert every record into Pinecone in batches of UPSERT_BATCH."""
    index = get_pinecone_index()
    total = len(records)
    uploaded = 0

    for batch in chunked(records, UPSERT_BATCH):
        vectors = embed_texts(model, [r["text"] for r in batch])
        payload = [
            {"id": r["id"], "values": vec, "metadata": r["metadata"]}
            for r, vec in zip(batch, vectors)
        ]
        index.upsert(vectors=payload)
        uploaded += len(payload)
        pct = uploaded / total * 100
        print(f"  upserted {uploaded:>5}/{total} vectors ({pct:5.1f}%)")

    print(f"\nDone. {uploaded} vectors are live in Pinecone index '{INDEX_NAME}'.")
    try:
        stats = index.describe_index_stats()
        print(f"Index now reports {stats.get('total_vector_count', '?')} total vectors.")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Embed the BYU catalog and load it into Pinecone.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Build chunks + metadata only; skip the model and Pinecone.")
    ap.add_argument("--limit", type=int, default=None,
                    help="Only process the first N records (handy with --dry-run).")
    ap.add_argument("--show", action="store_true",
                    help="Print a few full sample chunks.")
    ap.add_argument("--keep-junk", action="store_true",
                    help="Do NOT filter the registrar's CMS test records.")
    ap.add_argument("--only-sources", default=None,
                    help="Comma-separated source names to embed, skipping the "
                         "catalog entirely (e.g. --only-sources language_certs). "
                         "Fast + light: refresh one source without re-embedding "
                         "all 8k catalog vectors. Upserts overwrite by ID.")
    ap.add_argument("--dedup-cleanup", action="store_true",
                    help="Delete stale prior-catalog-year duplicate vectors from "
                         "Pinecone (the current versions stay). Light + no re-embed.")
    args = ap.parse_args()

    if args.dedup_cleanup:
        # Surgically remove prior-year duplicate vectors; no embedding needed.
        if not DATA_PATH.exists():
            print(f"ERROR: {DATA_PATH} not found.", file=sys.stderr)
            return 1
        catalog = json.loads(DATA_PATH.read_text(encoding="utf-8"))
        _, _, stale = dedup_catalog(catalog)
        stale = sorted(set(stale))
        print(f"Found {len(stale)} stale duplicate vectors (older catalog years).")
        if not stale:
            return 0
        index = get_pinecone_index()
        for batch in chunked(stale, 100):
            index.delete(ids=batch)
        print(f"Deleted {len(stale)} stale vectors. Current versions remain.")
        try:
            print("Index now reports",
                  get_pinecone_index().describe_index_stats().get("total_vector_count"),
                  "vectors.")
        except Exception:
            pass
        return 0

    if args.only_sources:
        # Targeted refresh: embed just these sources, skip the heavy catalog.
        wanted = {s.strip() for s in args.only_sources.split(",") if s.strip()}
        records = [
            r for r in load_source_records(DATA_PATH.parent)
            if r["metadata"].get("source") in wanted
        ]
        print(f"Embedding only source(s) {sorted(wanted)}: {len(records)} records.")
        if not records:
            print("No matching source records found. Check the source name(s).")
            return 2
    else:
        if not DATA_PATH.exists():
            print(f"ERROR: {DATA_PATH} not found. Run sources/catalog.py first.",
                  file=sys.stderr)
            return 1

        print(f"Loading {DATA_PATH} ...")
        catalog = json.loads(DATA_PATH.read_text(encoding="utf-8"))
        records = build_records(catalog, filter_junk=not args.keep_junk)

        # Fold in any other sources (certificates, study abroad, ...) from data/.
        source_records = load_source_records(DATA_PATH.parent)
        if source_records:
            records += source_records
            print(f"Total records incl. other sources: {len(records)}")

    if args.limit:
        records = records[:args.limit]
        print(f"Limited to {len(records)} records.")

    if args.show:
        print("\n=== sample chunks ===")
        for r in records[:3] + records[-2:]:
            print(f"\n[{r['id']}]  meta={ {k: v for k, v in r['metadata'].items() if k != 'text'} }")
            print(" ", r["text"][:500] + ("..." if len(r["text"]) > 500 else ""))
        print("=====================\n")

    if args.dry_run:
        print("Dry run complete -- no model loaded, nothing sent to Pinecone.")
        return 0

    model = load_model()
    upload(records, model)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(130)
