#!/usr/bin/env python3
"""
advisor_server.py  --  myplanBYU chat API
=========================================

A small Flask server that puts the RAG advisor (ask_advisor.py) behind an HTTP
endpoint so the myplanBYU website's chat panel can talk to it. The embedding
model and Pinecone connection load ONCE at startup, so each question costs
only a vector query + one Claude call (~2-4 s).

    POST /api/ask
        {"question": "...",                     required
         "plan_context": "Fall 2026: IS 303...", optional -- the student's
                                                 current draft plan, injected
                                                 into the prompt so the bot
                                                 can discuss THEIR schedule
         "history": [{"role":"user"|"assistant","content":"..."}, ...]}
                                                 optional -- last few turns
        -> {"answer": "...", "sources": [{"name","type","score"}, ...]}

    GET /api/health  ->  {"ok": true, ...}

Run (from the scraper folder, venv active or via the venv python):
    .\\.venv\\Scripts\\python.exe advisor_server.py     # listens on :5000

Keys come from the same .env as ask_advisor.py (PINECONE_API_KEY,
ANTHROPIC_API_KEY). Claude is called with plain requests (no anthropic SDK --
see the note in ask_advisor.answer about Smart App Control and jiter).

Author: Jordan Heaton
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import requests
from flask import Flask, jsonify, request

# Reuses the CLI advisor's retrieval + prompt so behavior can't drift.
import ask_advisor
from ask_advisor import MODEL, MAX_TOKENS, SYSTEM_PROMPT, build_context, retrieve

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Forced context — belt-and-suspenders over vector retrieval
# ---------------------------------------------------------------------------
# Vector search occasionally misses a document that's plainly relevant (the
# Spanish certificate, a Marriott track sheet) because the query wording is
# short or generic. So we ALSO load every source-doc JSON directly and, when
# the student's question or plan clearly names one, force its full text into
# the context regardless of what Pinecone returned.

_re = re

_DATA_DIR = Path(__file__).resolve().parent / "data"
_FORCE_SOURCES = ("language_certs", "marriott_business")   # the ones users hit gaps on
_FORCE_DOCS = []   # [{name, text, source, triggers:set[str]}]

# Hardcoded academic nuances the catalog data doesn't encode cleanly.
HARDCODED_NOTES = {
    "spanish": (
        "SPAN 321 policy (BYU Center for Language Studies): a student who places "
        "into or completes SPAN 321 (Third-Year Grammar/Reading/Culture) receives "
        "credit/waiver for the lower-level preparatory Spanish sequence (SPAN "
        "101/102/105/201/205/211). Returned missionaries typically test directly "
        "into SPAN 321. So do NOT tell a student to take SPAN 101-211 before their "
        "Spanish minor/certificate courses if they have SPAN 321 — those are waived."
    ),
}


def _stopword_tokens(name: str) -> set:
    generic = {"language", "certificate", "cert", "the", "of", "and", "byu",
               "school", "business", "program", "studies", "global"}
    toks = {t for t in _re.findall(r"[a-z]+", name.lower()) if len(t) > 2}
    return toks - generic


def _load_force_docs():
    for src in _FORCE_SOURCES:
        path = _DATA_DIR / f"{src}.json"
        if not path.exists():
            continue
        try:
            docs = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"  [warn] couldn't load {path.name}: {exc}")
            continue
        for d in docs:
            name = (d.get("name") or "").strip()
            text = (d.get("text") or "").strip()
            if not name or not text:
                continue
            _FORCE_DOCS.append({
                "name": name, "text": text, "source": src,
                "url": (d.get("url") or None),
                "triggers": _stopword_tokens(name),
            })
    print(f"Force-context: loaded {len(_FORCE_DOCS)} docs from {_FORCE_SOURCES}.")


# ---------------------------------------------------------------------------
# Student-college inference -> major-matched opportunities
# ---------------------------------------------------------------------------
# Opportunity docs (study abroad / clubs / grants) are embedded with a
# "Relevant to students in: College of X" line (embed_and_load). When a student
# shares their plan AND asks about opportunities, we map their major(s) to a
# college and fold it into the RETRIEVAL query so those college-tagged docs rank
# up — "study abroad for me" as a Neuroscience major surfaces Life-Sciences
# programs, not a random list.
_PROGRAM_COLLEGE = {}   # normalized program name -> canonical college
# prefix match (no trailing boundary) so plurals hit: "scholarships", "clubs"
_OPP_RE = re.compile(
    r"\b(?:study\s*abroad|abroad|scholarship|club|research|grant|opportunit|"
    r"internship|get\s+involved|extracurricular|mentored|volunteer|funding)", re.I)


def _norm_prog(s: str) -> str:
    s = _re.sub(r"\s*\(.*?\)\s*", " ", s or "")
    s = _re.sub(r"\b(minor|certificate|emphasis|track|bs|ba|bfa|bm|bgs|major)\b", " ", s, flags=_re.I)
    return _re.sub(r"\s+", " ", s).strip().lower()


def _load_program_colleges():
    try:
        import opportunity_tags as ot
    except Exception:
        print("  [warn] opportunity_tags unavailable; college matching off.")
        return
    cat_path = _DATA_DIR / "catalog.json"
    if not cat_path.exists():
        return
    try:
        cat = json.loads(cat_path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"  [warn] program->college map: {exc}")
        return
    for p in cat.get("programs", []):
        col = ot.normalize_college(p.get("college") or "")
        nm = _norm_prog(p.get("name"))
        if col and nm and nm not in _PROGRAM_COLLEGE:
            _PROGRAM_COLLEGE[nm] = col
    print(f"Program->college map: {len(_PROGRAM_COLLEGE)} programs.")


def student_colleges(plan_context: str):
    """Canonical colleges of the programs named in the shared plan summary."""
    if not plan_context or not _PROGRAM_COLLEGE:
        return []
    m = _re.search(r"programs?:\s*(.+)", plan_context, _re.I)
    if not m:
        return []
    cols, seen = [], set()
    for part in _re.split(r"[;,]", m.group(1))[:6]:
        col = _PROGRAM_COLLEGE.get(_norm_prog(part))
        if col and col not in seen:
            seen.add(col)
            cols.append(col)
    return cols


def forced_context(question: str, plan_context: str, already: set, limit: int = 4):
    """Docs whose distinctive name-words appear in the question or plan but that
    retrieval didn't already surface. Returns (context_blocks, source_meta)."""
    haystack = f"{question}\n{plan_context}".lower()
    hits = []
    for d in _FORCE_DOCS:
        if d["name"] in already or not d["triggers"]:
            continue
        # every distinctive word of the doc name must be present (tight match)
        if all(t in haystack for t in d["triggers"]):
            hits.append(d)
    hits = hits[:limit]
    blocks = [f"[forced:{d['source']}] {d['name']}\n{d['text'][:4000]}" for d in hits]
    meta = [{"name": d["name"], "type": "forced", "url": d.get("url"), "score": 1.0} for d in hits]
    return blocks, meta


def hardcoded_context(question: str, plan_context: str):
    hay = f"{question}\n{plan_context}".lower()
    return [note for key, note in HARDCODED_NOTES.items() if key in hay]

MAX_HISTORY_TURNS = 8       # most recent turns forwarded to Claude
MAX_PLAN_CHARS = 8000       # safety cap on the plan context blob (client sends ≤7800 incl. solver decision log)
MAX_QUESTION_CHARS = 2000

PLAN_PROMPT_ADDON = (
    "\n\nThe student may include their CURRENT DRAFT SEMESTER PLAN from the "
    "myplanBYU planner. When present, treat it as their real schedule: answer "
    "questions about it, point out conflicts with requirements or deadlines in "
    "the Context, and suggest concrete improvements (moving a class to a term "
    "it's actually offered, taking GE courses early, prioritizing Fall/Winter). "
    "The plan is a draft made by an unofficial tool -- recommend verifying "
    "against MyMAP before registering.\n"
    "Planner semantics you MUST respect (the plan includes a HOW TO READ "
    "section -- believe it):\n"
    "- 'slot' entries are placeholder cards already counted in that term's "
    "credit total. A slot labeled 'Complete 15 hours' is ONE course slot of a "
    "multi-term requirement, not 15 extra hours that term.\n"
    "- Cohort/envelope blocks (e.g. a business junior core) are department-"
    "assigned: every course in the envelope is taken together in that exact "
    "semester. Never suggest spreading or re-sequencing them.\n"
    "- Religion is intentionally paced ~2 credits per semester across the plan "
    "(BYU norm). Never suggest clustering religion courses.\n"
    "- The planner has machine-checked prerequisites and season offerings "
    "against the live catalog. Don't tell the student to go verify "
    "prerequisites unless the plan itself lists a warning.\n"
    "Never answer with 'my Context doesn't include X' and stop there: if the "
    "Context and plan lack something, use web search to find it on byu.edu / "
    "catalog.byu.edu, and say what you found.\n\n"
    "PROPOSED ACTIONS: the planner page can rebuild the student's plan and "
    "show a side-by-side comparison. When (and ONLY when) your answer "
    "concretely proposes one of these changes -- adding a minor, adding a "
    "certificate, switching majors, dropping a minor, or enabling "
    "Spring/Summer terms -- append as the VERY LAST line of your reply, on "
    "its own line, no markdown, no code fence:\n"
    'ACTION_JSON: {"type": "add_minor|add_cert|switch_major|remove_minor|'
    'enable_spsu", "program": "<official program name or empty for '
    'enable_spsu>"}\n'
    "Exactly one action per reply, and only if the student is asking about "
    "such a change (a what-if, 'should I add X', 'what would Y cost me'). "
    "Never emit it for informational questions. The page renders it as a "
    "'Try it' button that runs the comparison -- so DON'T claim exact "
    "semester counts for the hypothetical; the comparison computes them."
)

# Anthropic server-side web search: the fallback when RAG has no answer.
# Capped to keep cost bounded; localized to BYU-relevant queries by prompt.
WEB_SEARCH_TOOL = {"type": "web_search_20250305", "name": "web_search", "max_uses": 3}


@app.after_request
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return resp


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "model": MODEL})


@app.route("/api/ask", methods=["POST", "OPTIONS"])
def ask():
    if request.method == "OPTIONS":   # CORS preflight
        return ("", 204)

    body = request.get_json(silent=True) or {}
    question = (body.get("question") or "").strip()[:MAX_QUESTION_CHARS]
    plan_context = (body.get("plan_context") or "").strip()[:MAX_PLAN_CHARS]
    history = body.get("history") or []

    if not question:
        return jsonify({"error": "question is required"}), 400

    # ---- retrieve grounded context from Pinecone --------------------------
    # For opportunity questions with a shared plan, bias retrieval toward the
    # student's college so major-matched study abroad / clubs / grants surface.
    retrieval_query = question
    if plan_context and _OPP_RE.search(question):
        cols = student_colleges(plan_context)
        if cols:
            retrieval_query = f"{question} (for students in {', '.join(cols)})"
    try:
        matches = retrieve(retrieval_query, top_k=12, type_filter=None)
    except Exception as exc:
        return jsonify({"error": f"retrieval failed: {exc}"}), 500

    context = build_context(matches)
    sources = [
        {
            "name": (m.get("metadata") or {}).get("name"),
            "type": (m.get("metadata") or {}).get("type"),
            "url": (m.get("metadata") or {}).get("url") or None,
            "score": round(m.get("score", 0.0), 3),
        }
        for m in matches
    ]

    # ---- forced + hardcoded context (fills retrieval gaps) ----------------
    retrieved_names = {s["name"] for s in sources}
    forced_blocks, forced_meta = forced_context(question, plan_context, retrieved_names)
    if forced_blocks:
        context += "\n\n" + "\n\n".join(forced_blocks)
        sources = forced_meta + sources
    notes = hardcoded_context(question, plan_context)
    if notes:
        context += "\n\nKEY POLICY NOTES:\n" + "\n".join(f"- {n}" for n in notes)

    # ---- build the Claude message list ------------------------------------
    user_content = f"Context:\n{context}\n\n"
    if plan_context:
        user_content += f"Student's current draft plan (myplanBYU):\n{plan_context}\n\n"
    user_content += f"Question: {question}"

    messages = []
    for turn in history[-MAX_HISTORY_TURNS:]:
        role = turn.get("role")
        content = (turn.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content[:4000]})
    messages.append({"role": "user", "content": user_content})

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return jsonify({"error": "ANTHROPIC_API_KEY not set on the server"}), 500

    try:
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
                "system": SYSTEM_PROMPT + PLAN_PROMPT_ADDON,
                "messages": messages,
                "tools": [WEB_SEARCH_TOOL],
            },
            timeout=180,
        )
    except requests.RequestException as exc:
        return jsonify({"error": f"Claude API unreachable: {exc}"}), 502

    if resp.status_code != 200:
        return jsonify({"error": f"Claude API {resp.status_code}: {resp.text[:300]}"}), 502

    data = resp.json()
    answer = "".join(
        block.get("text", "") for block in data.get("content", [])
        if block.get("type") == "text"
    )
    usage = data.get("usage", {})
    web_searches = (usage.get("server_tool_use") or {}).get("web_search_requests", 0)

    return jsonify({
        "answer": answer,
        "sources": sources,
        "web_searches": web_searches,
        "usage": {"in": usage.get("input_tokens"), "out": usage.get("output_tokens")},
    })


if __name__ == "__main__":
    _load_force_docs()
    _load_program_colleges()
    print("Warming up: loading embedding model + Pinecone connection ...")
    try:
        retrieve("warmup", top_k=1)   # loads + caches the model and index
        print("Ready.")
    except Exception as exc:
        print(f"WARNING: warmup failed ({exc}); first request will retry.")
    app.run(host="127.0.0.1", port=5000, debug=False)
