#!/usr/bin/env python3
"""
query.py  --  quick semantic-search tester for the myplanBYU Pinecone index
===========================================================================

Embeds a query with the SAME local model used for indexing and retrieves the
most similar courses/programs from Pinecone. Use it to sanity-check retrieval
quality before wiring the index into your RAG app.

Usage
-----
    # needs PINECONE_API_KEY in .env (same as embed_and_load.py)
    python query.py "beginning programming courses for information systems"
    python query.py "linear algebra" --top-k 8
    python query.py "accounting major requirements" --type program

Note on BGE models: the retrieval quality of bge-small-en-v1.5 improves when the
*query* (not the stored documents) is prefixed with a short instruction. We add
it here; embed_and_load.py deliberately does NOT add it to the documents.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

import os

# Reuse the exact model / index config from the loader so they can't drift.
from embed_and_load import EMBED_MODEL, INDEX_NAME

# BGE's recommended retrieval instruction for the query side.
QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: "


def main() -> int:
    ap = argparse.ArgumentParser(description="Semantic search over the myplanBYU catalog index.")
    ap.add_argument("query", help="Natural-language search text.")
    ap.add_argument("--top-k", type=int, default=5, help="How many results to return.")
    ap.add_argument("--type", choices=["course", "program"], default=None,
                    help="Restrict results to one record type.")
    args = ap.parse_args()

    api_key = os.environ.get("PINECONE_API_KEY")
    if not api_key:
        print("PINECONE_API_KEY not set (put it in .env). Aborting.", file=sys.stderr)
        return 1

    from pinecone import Pinecone
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(EMBED_MODEL)
    vector = model.encode(
        QUERY_INSTRUCTION + args.query,
        normalize_embeddings=True,
    ).tolist()

    index = Pinecone(api_key=api_key).Index(INDEX_NAME)
    result = index.query(
        vector=vector,
        top_k=args.top_k,
        include_metadata=True,
        filter={"type": args.type} if args.type else None,
    )

    print(f"\nTop {args.top_k} matches for: {args.query!r}"
          + (f"  [type={args.type}]" if args.type else "") + "\n")
    for i, match in enumerate(result.get("matches", []), start=1):
        meta = match.get("metadata", {})
        text = (meta.get("text") or "").strip()
        snippet = text[:200] + ("..." if len(text) > 200 else "")
        print(f"{i}. [{match['score']:.3f}] ({meta.get('type')}) {meta.get('id')} - {meta.get('name')}")
        print(f"     {snippet}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
