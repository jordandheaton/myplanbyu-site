# myplanBYU advisor — Cloudflare Worker

The live advisor. Serves `advisor.jordanheaton.com`; **no PC involved.**

    POST /api/ask       RAG advisor (embed → Pinecone → Claude)
    GET  /api/health    guardrail state for the chat panel
    GET  /api/sections  live BYU class-schedule proxy (seats/times/rooms)
    POST /api/feedback  bug reports from the planner

## Why this exists

The Python server (`../scraper/advisor_server.py`) ran on Jordan's PC behind a
Cloudflare tunnel. The tunnel was never installed as a service, so every reboot
silently took down the advisor, live seat counts, and the feedback form until
someone noticed. Hosting it anywhere else was blocked by size: embedding each
question locally with `sentence-transformers` pulls in PyTorch, and the venv is
**1.2 GB** — more than most free tiers allow, with a brutal cold start.

Cloudflare Workers AI hosts **the same embedding model the index was built
with** — `@cf/baai/bge-small-en-v1.5`, 384-dim. So query embedding became one
API call and the gigabyte disappeared; it was never the app, it was torch.

Documents are still embedded on the PC by `embed_and_load.py` (unchanged, and
it still needs torch). Only *query-time* embedding moved. Both sides must keep
using bge-small-en-v1.5 or retrieval silently degrades — the vectors would live
in different spaces.

## Deploy

    cd myplanBYU/worker
    npx wrangler deploy

Config is `wrangler.jsonc` (bindings, allowed origins, budget, quota). Secrets
are set once and stored by Cloudflare, never in the repo:

    npx wrangler secret put ANTHROPIC_API_KEY
    npx wrangler secret put PINECONE_API_KEY
    npx wrangler secret put IP_SALT          # salts the hashed IPs in D1

## Bundled data

`src/data/*.json` is generated from the scraper's outputs — force-context docs
(language certificates, Marriott track sheets) and the program→college map. A
Worker has no filesystem, so what the Python server read at startup is baked in
at build time. Regenerate after a data refresh:

    C:\\Users\\jorda\\venvs\\myplan-scraper\\Scripts\\python.exe generate_worker_data.py
    npx wrangler deploy

## State (D1, `myplan-advisor`)

| table | replaces | holds |
|---|---|---|
| `months` | `advisor_usage.json` | monthly spend + question count |
| `hits` | same | salted-hash IP timestamps for quota/rate limits |
| `feedback` | `data/feedback.jsonl` | bug reports from the planner |

The spend cap lives in the database, not memory, for the same reason it was a
file before: a cap that resets when the process recycles is not a cap.

Read feedback:

    .\read_feedback.ps1            # all reports
    .\read_feedback.ps1 -Last 5

## Differences from the Python server

- **Client IP**: the `ADVISOR_TRUSTED_PROXIES` hop arithmetic is gone.
  Cloudflare stamps `CF-Connecting-IP` after terminating the connection and a
  client cannot forge it, so one header read replaces the whole dance.
- **Caching**: the in-process dicts behind `/api/sections` became the Workers
  Cache API, same TTLs (6 h for dept→courseId, 3 min for live seats).
- **Streaming**: `/api/ask` returns a complete JSON response, as the Flask
  server's endpoint did. (The *CLI* streams; the endpoint never did.)

Prompts and retrieval logic are copied verbatim from `ask_advisor.py` /
`advisor_server.py`. **Edit them here** — this is the deployed one. The Python
server remains useful for local prompt experiments.

## Free-tier limits

100,000 requests/day, 10 ms CPU per request (fetch wait doesn't count, and this
Worker is almost entirely waiting), 50 subrequests/request (`/api/ask` uses ~3),
10,000 Workers AI Neurons/day. Cloudflare is free; **Anthropic still bills per
question** — that is what `ADVISOR_MONTHLY_BUDGET_USD` bounds.
