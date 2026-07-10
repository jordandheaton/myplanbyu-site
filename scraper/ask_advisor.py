#!/usr/bin/env python3
"""
ask_advisor.py  --  myplanBYU RAG advisor
=========================================

Step 3 of the RAG architecture: ask a question in plain English, retrieve the
most relevant BYU catalog chunks from Pinecone, and have Claude answer using
*only* that retrieved context (grounded, so it won't invent courses or credits).

    retrieve (Pinecone)  ->  build Context string  ->  Claude answers

Usage
-----
    # needs PINECONE_API_KEY and ANTHROPIC_API_KEY in .env
    python ask_advisor.py "Does IS 303 count toward the Global Business Certificate?"
    python ask_advisor.py "What are the requirements for the Accounting major?" --type program
    python ask_advisor.py "beginning stats classes" --show-sources
    python ask_advisor.py "test question" --dry-run   # retrieve only, no Claude call

Embedding uses the SAME local model as embed_and_load.py (BAAI/bge-small-en-v1.5),
so query and document vectors live in the same space. Generation uses Claude
Haiku 4.5 -- cheap and fast, well-suited to grounded catalog Q&A.

Author: Jordan Heaton
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

# Load PINECONE_API_KEY / ANTHROPIC_API_KEY from the local .env if present.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

# Reuse the exact model + index names from the loader so they can't drift.
from embed_and_load import EMBED_MODEL, INDEX_NAME

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MODEL = "claude-haiku-4-5"   # cheap + fast; fine for grounded catalog Q&A
TOP_K = 12                   # chunks to retrieve; enough for multi-part questions
                             # ("major + 2 certificates") without one crowding out
                             # the others. Haiku's context is huge, so this is cheap.
MAX_TOKENS = 2048            # cap on the answer length

# BGE models want this instruction on the QUERY side only (documents were
# embedded without it in embed_and_load.py) -- it measurably improves recall.
QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: "

# Common BYU program acronyms -> full names. A student writing "IS" barely
# registers in the embedding, so we append the full name to the *embedding*
# query (never shown to them). Only whole-word, UPPERCASE matches expand, so the
# verb "is" is never mistaken for the Information Systems major. Extend freely.
PROGRAM_ACRONYMS = {
    "IS": "Information Systems",
    "CS": "Computer Science",
    "CE": "Civil Engineering",
    "ME": "Mechanical Engineering",
    "EE": "Electrical Engineering",
    "GBC": "Global Business Certificate",
    "GSCM": "Global Supply Chain Management",
    "MBA": "Master of Business Administration",
    "MPA": "Master of Public Administration",
}


def named_programs(query: str) -> list:
    """Full program names explicitly referenced by an UPPERCASE acronym in the query."""
    return [
        full for acro, full in PROGRAM_ACRONYMS.items()
        if re.search(rf"\b{re.escape(acro)}\b", query)   # case-sensitive: uppercase only
    ]


# "EC EN 450", "MATH 113", "C S 240", "REL A 275" — BYU course codes in a query.
COURSE_CODE_RE = re.compile(r"\b([A-Z](?:[A-Z& ]{0,5}[A-Z])?)\s?(\d{3}[A-Z]?R?)\b")


def named_courses(query: str, limit: int = 12) -> list:
    """Explicit course codes mentioned in the question (normalized 'DEPT NUM')."""
    out = []
    for dept, num in COURSE_CODE_RE.findall(query):
        code = f"{dept.strip()} {num}"
        if code not in out:
            out.append(code)
    return out[:limit]


def expand_acronyms(query: str) -> str:
    """Append full program names for any UPPERCASE acronym in the query."""
    extra = named_programs(query)
    return f"{query} {' '.join(extra)}" if extra else query

SYSTEM_PROMPT = (
    "You are the myplanBYU Academic Advisor, an assistant that helps BYU students "
    "plan their degrees. Answer using ONLY the information in the provided Context. "
    "The Context contains BYU academic data from several sources: courses (with "
    "credit hours and prerequisites), programs (majors, minors, emphases) with their "
    "requirement rules, and other opportunities such as certificates and study "
    "abroad programs. Each Context item is labeled with its type and source.\n\n"
    "Rules:\n"
    "- Answer EVERY part of a multi-part question. If the Context supports one "
    "part but not another, answer the supported part fully and only flag the "
    "missing part.\n"
    "- If the Context contains the requested fact (a deadline, cost, rate, or "
    "requirement), state it directly with its dates/amounts. Do not refuse or "
    "hedge when the data is present; if the data is labeled for a specific year "
    "or term, present it and name that year/term.\n"
    "- If the Context truly does not contain enough information, say so plainly "
    "and point the student to catalog.byu.edu. Do NOT invent courses, credit "
    "hours, requirements, costs, or dates.\n"
    "- Cite specific course codes (e.g. IS 303) and program names when relevant.\n"
    "- For questions about how a major should be SEQUENCED or laid out across "
    "semesters, prefer Context items of type 'flowchart' (official departmental "
    "flowcharts) over inferring an order yourself. If no flowchart exists for "
    "the program, say so and note the layout is inferred from prerequisites.\n"
    "- Be concise, practical, and encouraging."
)


# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------

# Cached across calls: the CLI pays the load once anyway, and advisor_server.py
# answers many questions per process -- reloading a 130 MB model per question
# would add ~5 s each time.
_MODEL = None
_INDEX = None


def _get_model():
    global _MODEL
    if _MODEL is None:
        from sentence_transformers import SentenceTransformer
        _MODEL = SentenceTransformer(EMBED_MODEL)
    return _MODEL


def _get_index():
    global _INDEX
    if _INDEX is None:
        from pinecone import Pinecone
        api_key = os.environ.get("PINECONE_API_KEY")
        if not api_key:
            raise SystemExit("PINECONE_API_KEY not set (put it in .env). See README_SCRAPER.md.")
        _INDEX = Pinecone(api_key=api_key).Index(INDEX_NAME)
    return _INDEX


def retrieve(query: str, top_k: int, type_filter: str | None = None):
    """Return the most relevant Pinecone matches for the query.

    With no --type filter, retrieval is *balanced*: one query for courses and one
    for everything else (programs, certificates, minors, emphases, study abroad,
    ...), merged by score. This guarantees course detail isn't crowded out, and
    that non-course sources (like certificates) are always eligible. With a
    --type filter, it's a single filtered query for that one type.
    """
    # Embed once, reuse the vector for however many filtered queries we run.
    # Expand program acronyms (IS -> Information Systems) so short forms retrieve.
    model = _get_model()
    embed_query = QUERY_INSTRUCTION + expand_acronyms(query)
    vector = model.encode(embed_query, normalize_embeddings=True).tolist()
    index = _get_index()

    def query_filter(k: int, flt, vec=None):
        if k <= 0:
            return []
        result = index.query(
            vector=vec or vector,
            top_k=k,
            include_metadata=True,
            filter=flt,
        )
        return result.get("matches", [])

    # Single-type: honor the explicit filter and return top_k of just that type.
    if type_filter:
        return query_filter(top_k, {"type": type_filter})

    # Balanced base: guarantee a share of COURSES (the granular credit/prereq
    # detail) AND a share of everything else -- programs, certificates, minors,
    # emphases, study abroad, and any future source -- so no single type crowds
    # the others out. The "everything else" bucket is `type != course`.
    courses_k = max(1, top_k - top_k // 2)   # courses get the slightly larger share
    other_k = max(1, top_k // 2)
    base = (
        query_filter(courses_k, {"type": "course"})
        + query_filter(other_k, {"type": {"$ne": "course"}})
    )
    base.sort(key=lambda m: m.get("score", 0.0), reverse=True)

    # Entity-guaranteed: a question like "major in IS + Spanish cert + GBC" is
    # dominated by the heavier entities, so an explicitly-named program can get
    # crowded out. Give each named program its OWN targeted query so it's always
    # in the context.
    guaranteed, seen = [], set()

    # Course-code guarantee: "what are the prereqs of EC EN 450, MATH 113, ..."
    # names more courses than balanced retrieval can surface. Fetch every
    # explicitly-named course chunk directly by its metadata id.
    codes = named_courses(query)
    if codes:
        for hit in query_filter(len(codes), {"id": {"$in": codes}}):
            if hit["id"] not in seen:
                guaranteed.append(hit)
                seen.add(hit["id"])
    for name in named_programs(query):
        gvec = model.encode(
            QUERY_INSTRUCTION + f"{name} degree program requirements",
            normalize_embeddings=True,
        ).tolist()
        for hit in query_filter(1, {"type": {"$ne": "course"}}, vec=gvec):
            if hit["id"] not in seen:
                guaranteed.append(hit)
                seen.add(hit["id"])

    # Named programs first, then fill the rest from the balanced base by score.
    result = list(guaranteed)
    for m in base:
        if m["id"] not in seen:
            result.append(m)
            seen.add(m["id"])
    return result[:max(top_k, len(guaranteed))]


def build_context(matches) -> str:
    """Flatten retrieved chunks into a single numbered Context string for Claude."""
    blocks = []
    for i, m in enumerate(matches, start=1):
        meta = m.get("metadata", {})
        text = (meta.get("text") or "").strip()
        blocks.append(f"[{i}] ({meta.get('type')}) {meta.get('name')}\n{text}")
    return "\n\n".join(blocks)


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

def answer(question: str, matches) -> None:
    """Stream Claude's grounded answer to the terminal.

    Calls the Messages API directly with `requests` instead of the anthropic
    SDK: the SDK depends on `jiter`, a compiled DLL that Windows Smart App
    Control blocks on this machine. Plain HTTPS + stdlib JSON needs nothing
    compiled and behaves identically.
    """
    import json as _json

    import requests

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise SystemExit(
            "ANTHROPIC_API_KEY not set. Add it to .env on its own line:\n"
            "  ANTHROPIC_API_KEY=sk-ant-...\n"
            "Get a key at https://console.anthropic.com (separate from Claude Pro)."
        )

    context = build_context(matches)
    user_content = f"Context:\n{context}\n\nQuestion: {question}"

    print("\n--- Advisor ---")
    # Server-sent events: print text deltas as they arrive (same UX as the
    # SDK's stream helper, and no HTTP read timeout on long answers).
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": MODEL,
            "max_tokens": MAX_TOKENS,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": user_content}],
            "stream": True,
        },
        stream=True,
        timeout=120,
    )
    if resp.status_code != 200:
        raise SystemExit(f"Claude API error {resp.status_code}: {resp.text[:500]}")

    model_used, in_tokens, out_tokens = MODEL, None, None
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw or not raw.startswith("data:"):
            continue
        data = raw[5:].strip()
        if data == "[DONE]":
            break
        event = _json.loads(data)
        etype = event.get("type")
        if etype == "message_start":
            msg = event.get("message", {})
            model_used = msg.get("model", MODEL)
            in_tokens = msg.get("usage", {}).get("input_tokens")
        elif etype == "content_block_delta":
            text = event.get("delta", {}).get("text", "")
            print(text, end="", flush=True)
        elif etype == "message_delta":
            out_tokens = event.get("usage", {}).get("output_tokens", out_tokens)
        elif etype == "error":
            raise SystemExit(f"\nClaude API stream error: {event.get('error')}")

    print(f"\n\n[model={model_used} | in={in_tokens} out={out_tokens} tokens]")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Ask the myplanBYU RAG advisor a question.")
    ap.add_argument("question", help="Your question, in quotes.")
    ap.add_argument("--top-k", type=int, default=TOP_K, help="Chunks to retrieve (default 7).")
    ap.add_argument("--type", choices=["course", "program"], default=None,
                    help="Restrict retrieval to one record type "
                         "(default: a balanced mix of both).")
    ap.add_argument("--show-sources", action="store_true",
                    help="Print the retrieved chunks (with scores) before answering.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Retrieve + assemble the prompt but skip the Claude call.")
    args = ap.parse_args()

    matches = retrieve(args.question, args.top_k, args.type)
    if not matches:
        print("No relevant catalog entries found. Try rephrasing your question.")
        return 0

    if args.show_sources or args.dry_run:
        print("Retrieved sources:")
        for i, m in enumerate(matches, start=1):
            meta = m.get("metadata", {})
            print(f"  [{i}] {m['score']:.3f} ({meta.get('type')}) {meta.get('name')}")

    if args.dry_run:
        print("\n--- Prompt that WOULD be sent to Claude ---")
        print(f"[system]\n{SYSTEM_PROMPT}\n")
        print(f"[user]\nContext:\n{build_context(matches)[:1500]} ...\n\nQuestion: {args.question}")
        print("\n(dry run -- no Claude call made)")
        return 0

    answer(args.question, matches)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(130)
