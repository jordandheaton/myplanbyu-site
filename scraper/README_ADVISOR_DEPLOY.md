# Deploying the AI Advisor

> **CURRENT DEPLOYMENT (2026-08-06): a Cloudflare Worker — `myplanBYU/worker/`.**
> `advisor.jordanheaton.com` is served by the Worker, not by this PC. Nothing
> below about tunnels or `run_advisor.ps1` is part of the live path any more;
> it is kept because Path A is still the fastest way to test a prompt change
> locally, and because the reasoning explains why the Worker looks the way it
> does. To deploy: `cd ../worker && npx wrangler deploy`. See
> `worker/README.md`.
>
> **Why it moved.** The tunnel died on every reboot (it was never installed as
> a service), and each death took the advisor, live sections, and the feedback
> form offline until someone noticed. The Worker has no such failure mode.

The planner itself is a static site and needs no server. The **AI Advisor** is
the one part that does: `advisor_server.py` retrieves grounded BYU data from
Pinecone and answers with Claude.

Until this is deployed and the site is pointed at it, the chat panel shows a
plain "offline" message — which is correct, not a bug.

---

## Why the site can't reach a local server

Two hard blockers, both browser-enforced:

1. `advisor_server.py` binds `127.0.0.1` — reachable only from your own machine.
2. The live site is **HTTPS**. An HTTPS page may not call `http://127.0.0.1`
   (mixed content). `chat.js` detects this and shows the offline notice rather
   than a network error.

So the advisor needs a public **HTTPS** URL. Two ways to get one.

---

## Path A — tunnel from your PC (fastest)

No re-architecture. Good for demos and collecting feedback. Your PC must be on
and running the server.

```bash
cloudflared tunnel --url http://127.0.0.1:5000
```

That prints an `https://…trycloudflare.com` URL. Then:

**1. Start the advisor with the tunnel's origin allowed.** PowerShell:

```powershell
$env:ADVISOR_ALLOWED_ORIGINS = "https://jordandheaton.github.io"
$env:ADVISOR_TRUSTED_PROXIES = "1"
python advisor_server.py
```

**2. Point the site at it** — one line in `index.html`, before `chat.js`:

```html
<script>window.MYPLAN_ADVISOR_API = "https://your-tunnel.trycloudflare.com/api";</script>
```

Nothing else changes; `chat.js` reads that global and falls back to localhost.

> A free `trycloudflare.com` URL changes every restart. For a stable one, use a
> named tunnel on a domain you own — Path A2.

---

## Path A2 — named tunnel (the URL stops changing)

A quick tunnel hands you a new random hostname every restart, and that hostname
is baked into `index.html`, so every tunnel restart means an edit + commit +
push or the live site points at a dead address. A **named** tunnel fixes that
permanently: `advisor.yourdomain.com`, stable across reboots.

The catch: named tunnels need DNS, so they need **a domain you control**. There
is no permanent free `trycloudflare` hostname.

### Your part (three steps — account, purchase, sign-in)

These need an account holder; nobody can do them for you.

**1. Free Cloudflare account** — <https://dash.cloudflare.com/sign-up>. Email +
password, verify the email. No card required for this step.

**2. Buy the domain, at Cloudflare** — Dashboard → **Domain Registration** →
**Register Domain** → search (e.g. `jordanheaton.com`) → buy. Roughly $10-12/yr
for `.com`, sold at wholesale with no first-year-discount trap.

Buy it *here* rather than elsewhere: a domain registered at Cloudflare is
already on Cloudflare DNS, so the tunnel works immediately. Bought elsewhere,
you must add the site and re-point nameservers at the other registrar first, and
wait for propagation.

**3. Authorise cloudflared** — in a terminal:

```powershell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel login
```

A browser opens; pick the domain and click **Authorize**. That writes
`%USERPROFILE%\.cloudflared\cert.pem`, which every later command reads. This is
a sign-in as you, which is why it is not automatable.

### The rest (mechanical — hand it back to Claude, or run it yourself)

```powershell
$cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe"

# 1. create the tunnel (writes a credentials JSON keyed by tunnel UUID)
& $cf tunnel create myplan-advisor

# 2. point a hostname at it (creates the DNS record for you)
& $cf tunnel route dns myplan-advisor advisor.YOURDOMAIN.com

# 3. run it
& $cf tunnel run --url http://127.0.0.1:5000 myplan-advisor
```

Then one final edit to `index.html`, never to be repeated:

```html
<script>window.MYPLAN_ADVISOR_API = "https://advisor.YOURDOMAIN.com/api";</script>
```

…and restart the advisor so CORS allows the live site:

```powershell
.\run_advisor.ps1 -Restart -Origin https://jordandheaton.github.io -Proxies 1
```

Keep `-Origin` pointing at wherever the SITE is served from — that is the page
making the request. It only changes if you also move the portfolio onto the new
domain, in which case use `https://yourdomain.com`.

### Optional: run it as a service

`cloudflared service install` registers the tunnel as a Windows service so it
survives reboots without a terminal window. The advisor itself still needs to be
running for the tunnel to have anything to reach.

---

## Path B — always-on hosting

The blocker is size: the advisor embeds each question locally with
`sentence-transformers`, which pulls in **PyTorch (~526 MB)**. The venv is
**~1.1 GB** — too big for most free tiers and slow to cold-start.

To fix that properly, move embedding to a hosted API (Pinecone inference,
Voyage, OpenAI) and drop torch entirely. **The catch:** queries must be embedded
by the same model as the documents. The index is 384-dim `BAAI/bge-small-en-v1.5`,
so switching providers means a new index and a full re-run of
`embed_and_load.py`. Budget half a day, not a rewrite.

Once torch is gone, any small container host works. Set `ADVISOR_HOST=0.0.0.0`
(containers must bind all interfaces) and the platform's `PORT` is picked up
automatically.

---

## Settings that matter in production

All optional, all environment variables. Defaults are safe for local use.

| Variable | Default | Why you care |
|---|---|---|
| `ADVISOR_ALLOWED_ORIGINS` | localhost only | Which sites may spend your Anthropic budget. Set to your site's origin. |
| `ADVISOR_TRUSTED_PROXIES` | `0` | Number of proxies in front. **Behind a tunnel this must be `1`** — see below. |
| `ADVISOR_MONTHLY_BUDGET_USD` | `5.00` | Hard ceiling. Server returns 503 when reached. |
| `ADVISOR_QUESTIONS_PER_IP` | `10` | Questions per visitor. |
| `ADVISOR_QUOTA_WINDOW_HOURS` | `24` | `0` = lifetime quota instead of rolling. |
| `ADVISOR_HOST` | `127.0.0.1` | `0.0.0.0` for containers. |
| `ADVISOR_PORT` / `PORT` | `5000` | Most platforms set `PORT` for you. |
| `ANTHROPIC_API_KEY`, `PINECONE_API_KEY` | — | Host env vars. Never commit; `.env` stays local. |

The server prints all of this at startup — a misconfigured deploy is visible in
the first ten lines of log.

### `ADVISOR_TRUSTED_PROXIES` is the one people get wrong

`X-Forwarded-For` is written by whoever is upstream, **including the client**.
Trust it blindly and the quota is decorative: send a random one per request and
every question looks like a new visitor.

So it's ignored unless you say how many proxies are really in front. Then the
honest client address is the Nth entry from the *right*; anything a client
prepends lands to the left and is discarded.

- Behind a tunnel or reverse proxy → **`1`**
- Directly exposed → **`0`**

Leaving it `0` behind a proxy doesn't fail loudly — it puts **every visitor in
one shared pool of 10**. The startup log warns about it.

> This also configures waitress, which strips `X-Forwarded-For` by default. Both
> layers are driven by this single setting, so they can't disagree.

### Two limits of an IP quota, on purpose

Visitors behind one NAT (campus wi-fi, a dorm) share a pool, and anyone on
mobile data can get a fresh one by cycling their address. It's a cost guardrail,
not authentication — **the spend cap is what actually bounds the bill.**

---

## Checklist before it faces the internet

- [ ] `ADVISOR_ALLOWED_ORIGINS` set to your site (not `*`)
- [ ] `ADVISOR_TRUSTED_PROXIES=1` if behind a tunnel or proxy
- [ ] `ADVISOR_MONTHLY_BUDGET_USD` set to a number you'd be happy to lose
- [ ] API keys are host env vars, not committed
- [ ] Startup log shows the expected CORS origin and proxy hops
- [ ] `advisor_usage.json` persists (spend and quota survive restarts; a cap you
      can reset by restarting is not a cap)
- [ ] Prices in `advisor_limits.py` still match Anthropic's published rates — if
      the real rate is higher, the cap measures the wrong currency

Verify from a machine that isn't yours:

```bash
curl https://your-host/api/health
```

Expect `ok: true` and a `limits` block with your budget and per-visitor cap.

---

## Running it

```bash
python advisor_server.py
```

Serves under **waitress** (production WSGI, same on Windows and Linux). Flask's
development server is only used if waitress is missing, and warns that it
shouldn't face the internet.

Startup loads the embedding model and warms the Pinecone connection, so the
first question isn't slow. Expect ~10–20 s before "Ready."

---

## Costs

- **Claude** (`claude-haiku-4-5`): a typical question is well under a cent;
  the monthly cap is the real bound.
- **Web search**: up to 3 per question, billed per search, counted against the
  same cap.
- **Pinecone**: a small index on the free tier is normally enough.
- **Embedding**: free — it runs locally (which is exactly what makes the
  container large).
