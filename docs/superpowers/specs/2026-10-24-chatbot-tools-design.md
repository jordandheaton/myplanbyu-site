# myplanBYU advisor: answering from tools, not from memory

Status: draft for Jordan's approval — 2026-10-24
Repo: `jordandheaton/myplanbyu-site` (working copy `C:\Users\jorda\repos\myplanBYU`)

## 1. Why

The chatbot ("AI Advisor") is meant to be the product: a BYU-aware assistant
that knows the student's own situation and answers with exact facts no general
chatbot has. Today it fails the questions that matter, and it fails them the
same way: **the data exists in myplanBYU, but the chatbot never reaches it.**

Real failures Jordan hit (verbatim questions):

| Question | What it said | What was true |
|---|---|---|
| "Is stat 121 offered online in the winter?" | "I don't have information about online course offerings" — sent the student to MyMAP | Winter 2027 has two on-demand sections (001: 162/450 seats; 002: 0/450, 8 on waitlist). The site's live sections endpoint returns exactly this. |
| "I want to do a study abroad summer 2028. What do you recommend?" | "I don't have study abroad program data" | All 130 Kennedy Center programs are scraped, with their course lists. **15 earn GE** through the UNIV 2xxR study-abroad GE courses (SAGE and similar, e.g. the BYU London Centre) — **4 of them in Summer 2027**: Buenos Aires Argentina, Netherlands: Navigating New Worlds, BYU London Centre Summer, Fashion, Food & the Finer Things in Paris & London. No 2028 programs are posted yet; the honest answer is "2028 isn't announced; these 2027 summer GE programs are the ones to watch." |

**A data bug found on the way (fixed by this project, 6.8):** the scraped data
flags only 6 programs as SAGE, all Spring, because the flag relied on the
phrase "Study Abroad General Education (SAGE)" appearing in a program page's
kept sections. Kennedy marks several SAGE programs only by their courses (and
an image filename) — e.g. the Argentina page never says "SAGE". Jordan caught
this: "there are SAGE programs that run in the Summer".
| "whats the easiest ge for arts" | Said the Arts course would go in its plan's "Civilization 1" slot, dumped a long option list, then "check RateMyProfessor" | No difficulty data exists, but "easiest" has defensible answers myplanBYU can compute — above all, courses that **double-count**: 14 of the 47 Arts options also fill another GE area (e.g. ARTHC 202, MUSIC 202, TMA 202 fill Arts *and* Civilization 2). |

How it works today (for the builder): `js/chat.js` posts `{question,
plan_context, history}` to the Worker's `/api/ask`. The Worker
(`worker/src/index.js`) embeds the question, pulls ~N chunks from Pinecone,
adds a large text summary of the plan (`App.planSummary()`), and makes **one**
Claude call (`claude-haiku-4-5`) whose only tool is web search. Anything the
retrieval misses, the model doesn't know — so it guesses or deflects.

## 2. What success looks like

- Factual answers come from **tool results** — live sections, the student's own
  plan and record, the scraped datasets — and say where they came from and how
  fresh they are ("live from BYU's class schedule", "from your plan").
- Answers that **combine** a dataset with the student's plan — the thing general
  AI can't do ("Summer 2028 is open in your plan, and these SAGE programs would
  fill the Arts GE you still need").
- When no tool covers a question, the advisor **says it doesn't know**. A guess
  is a failure even when it happens to be right.
- A test set of real questions with answers Jordan has verified, run after every
  change, so "did that help?" has an answer.

## 3. Goals, non-goals, anti-goals

**Goals (this project)**

1. Tool-based answering for: live sections, course facts, study abroad,
   the student's record, remaining requirements, requirement-filling courses
   (double-count ranking), the plan's semesters, program admission notes,
   BYU-site web search, and the existing document search.
2. First priority use case (Jordan's): **"easiest Arts GE"** answered by
   double-counting first, then prerequisites met, then online/on-demand
   availability — every recommendation with its stated reason.
3. A local-only test set built on Jordan's transcript, with Jordan-verified
   answers, and a harness to run it.

**Non-goals (later projects)**

- "What do I have due this week?" — needs the student's Canvas calendar feed.
- BYU sign-in / reading the official record — needs BYU approval.
- The weekly scheduler and the ClassSchedule-API section snapshot.
- Streaming the answer text token by token (see 6.6).

**Anti-goals — it fails even if it "works" if it:**

- states a fact (seats, dates, requirements, difficulty) that no tool returned;
- says *anything* about what the student is "taking right now" without data;
- invents difficulty ("ARTHC 111 is easy") — there is no difficulty data;
- sends the student's whole transcript/plan to the server or to Claude when a
  small tool result would do (FERPA, BYU's AI policy);
- changes the live chatbot before Jordan approves (develop against a separate
  Worker environment, 6.7).

## 4. Constraints

- **Static site + Cloudflare Worker.** The planner, solver, catalog
  (`js/catalog_data.js`), timeline (`js/timeline_data.js`) and schedule data all
  live in the browser. The Worker (`worker/src/index.js`, Cloudflare free tier)
  holds the Anthropic and Pinecone keys, quotas (D1), and the live sections
  proxy (`/api/sections?course=&term=`, 3-minute cache, returns per-section
  `mode`, `seats`, `waitlist`, instructors, times, rooms).
- **The student's data stays in their browser.** Plans are in `localStorage`;
  there is no account system.
- **Node is available** on Jordan's PC (v24), so the Worker can use the official
  Anthropic TypeScript/JS SDK (`@anthropic-ai/sdk`), bundled by wrangler.
- **Repo is public.** No student data (including Jordan's) is ever committed.
- **Spend: $10/month worst case, total** (Jordan) — live chatbot and test runs
  together. Enforced by caps in code, not by hoping (6.5).

## 5. Decisions Jordan made

- Use **Jordan's own transcript** as the test student; **Jordan confirms** the
  correct answers. That test data stays **on his PC only**, never committed.
- **Remove the "share my plan" checkbox**; the advisor always has the student
  tools (6.1).
- **Map each study abroad program's courses to GE areas** in the data pipeline,
  so "this fills your Arts GE" is a fact (6.8).
- SAGE programs **do** run in summer — the current data is wrong (§1).
- **$10/month worst case**, total. Use the **cheapest model that passes the test
  set** — start with the smallest current model; the hard work is done by the
  tools, not the model's knowledge.
- Priority: "easiest Arts GE" with double-counting.
- Long-term: the advisor should "just know" the student once BYU sign-in exists
  — so student data goes through one replaceable source (6.2).

## 6. Design (calls marked *[my call]* are mine, open to change)

### 6.1 Shape: browser-driven tool loop through a thin Worker relay *[my call]*

```
browser (chat.js)                       Worker /api/chat              Claude API
  question ─────────────────────────────▶ add frozen system + tools ──▶
                                          ◀── response (text | tool_use)
  ◀── response ─────────────────────────
  run each tool_use locally (or via a Worker data endpoint)
  append assistant content + tool_results, POST again ───────────────▶ ...
  until stop_reason == "end_turn" → render
```

- The **browser runs the loop** and executes every tool; the Worker is a relay
  that adds the system prompt, the tool definitions, auth, quotas and spend
  accounting, and forwards to Claude. One uniform loop, one place to debug,
  and student data is only ever read in the browser.
- Tools that need the server (live sections, document search) are plain Worker
  HTTP endpoints the browser calls — `/api/sections` already exists; add
  `/api/docsearch` exposing the existing Pinecone retrieval.
- **History is append-only** *(required by the API, not optional)*: the browser
  sends back every earlier turn exactly as received — including Claude's
  `thinking` blocks, `tool_use` and `tool_result` blocks — never trimmed,
  edited or rebuilt. The Worker's `system` and `tools` must be **byte-identical**
  on every request of a conversation (frozen constants, deterministic order;
  nothing per-request like dates inside them). Today's chat sends a trimmed
  text-only history (`history.slice(-8)`); that must go. Set
  `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` (beta
  `thinking-binding-controls-2026-08-01`) so an accidental edit degrades instead
  of failing, and log `input_transformations` during development.
- **Conversation length:** cap a conversation at a fixed number of questions
  *[my call: 12]*; past that the panel offers "start a new conversation" rather
  than trimming history (trimming the middle breaks the rule above).
- **The "Share my current plan with the advisor" checkbox is removed**
  (Jordan's decision). The advisor can always use the student tools; what
  protects the student is that tools return small answers and the full
  transcript/plan never leaves the browser. Remove `#chatSharePlan` from
  `index.html` and its use in `js/chat.js`.
- **Plan context moves out of the prompt.** The big `planSummary()` text blob is
  replaced by tools the model calls when it needs them. Anything that varies
  per request (today's date, the student's programs) goes in the *user message*
  or a tool result, never in `system`.

### 6.2 Student data source *[my call]*

All student-specific tools read through one module, `StudentData`, with one
implementation today — the active plan in the browser (profile + solver result)
— so a future "BYU sign-in" implementation replaces the source without changing
any tool. Each fact it returns carries its provenance (`"from your plan"`,
`"from your transcript import on Oct 24"`). Anything the source doesn't know is
returned as **explicitly unknown**, which is what lets the model decline.

**Current enrollment *[my call, tightened after review]*:** the transcript
import already sorts courses into graded and *in progress* (`scanTranscript` in
`js/app.js`), but its "in progress" bucket mixes this semester's courses,
registrations for future terms, and — for MyMAP pastes, which have no enrollment
header — courses that are merely *projected*. So only the **official
transcript's current-enrollment section** may become "current courses": save
`profile.inProgress = {term, courses[], importedAt, source: "official-transcript"}`
only when the importer can isolate that section and its term; record the import
kind either way. A MyMAP import, or a transcript where the current term can't be
isolated, leaves current enrollment **unknown**, and the advisor says "I don't
know — import your official transcript in the plan wizard." If isolating the
term turns out to need real term parsing in the importer, that parsing is in
scope; guessing is not. Plans without the field behave as today.

### 6.3 Tools

All tools have `strict: true` schemas. Forced tool choice is not available on
this model, so steering is by the system prompt. Results are compact JSON with a
`source` and, where it matters, `as_of`.

**Browser — the student's own data (via `StudentData` + the solver result):**

| Tool | Returns | Notes |
|---|---|---|
| `get_student_record` | programs (names + ids), completed courses, in-progress courses (or `unknown`), start term, settings that matter (Spring/Summer allowed) | The "who am I" tool; explicit `unknown` fields |
| `get_remaining_requirements` | per program → per requirement: label, needed, done, planned, open slots, the courses filling it | Read from `result.progress` (`progressReport` in `js/solver.js`); filter by program or by requirement name ("Arts") |
| `find_courses_for_requirement` | ranked candidate courses for one requirement, each with `reasons[]` | The "easiest Arts GE" engine — 6.4 |
| `get_plan` | semesters in order with courses/credits; open terms (e.g. Summer 2028 if Spring/Summer are allowed but empty); warnings | From the solver result |
| `check_program_admission` | the program's admission/limited-enrollment notes (already in `timeline_data.js`) next to which prerequisite courses the student has done/planned | "Am I on track to apply to IS?" — it reports facts; it does not predict admission |
| `propose_plan_change` | — (client renders the existing "Try it" what-if button) | Replaces the `ACTION_JSON:` text line chat.js parses today; same action types |

**Browser — public datasets already loaded in the page:**

| Tool | Returns | Notes |
|---|---|---|
| `get_course` | name, credits, prerequisites (structured + text), seasons offered, which requirement buckets (GE areas included) it appears in | From `catalog_data.js` + program buckets |
| `search_study_abroad` | programs filtered by season/year, GE-earning only, GE area, college, keyword: name, term/dates/cost text, colleges, **GE courses offered and the GE areas each fills**, `sage_label` (Kennedy calls it SAGE), URL, plus `latest_posted_year` | From `TIMELINE.studyAbroad`; needs the data change in 6.8. Combine with `get_remaining_requirements` to say which of the student's open GE areas a program fills |

**Worker endpoints (called from the browser):**

| Tool | Returns | Notes |
|---|---|---|
| `get_sections` | for a course + term: each section's number, delivery mode, seats available / capacity, waitlist, instructors, days/times, room | Existing `/api/sections`; term codes `YYYY1/3/4/5`; returns `as_of` |
| `search_byu_documents` | top passages from the existing Pinecone index (policies, program pages, study abroad pages…) with name, type, URL | New `/api/docsearch` wrapping today's `retrieve()` |

**Server tool (Anthropic-hosted):** web search with
`allowed_domains: ["byu.edu"]` (covers subdomains) and `max_uses: 2`, for policy
questions no dataset covers — the version depends on the chosen model (6.5).
*[Builder: verify current web-search pricing — historically about $10 per 1,000
searches.]*

### 6.4 "Easiest" — how `find_courses_for_requirement` ranks *[Jordan's priority; ranking order is his]*

Input: a requirement (by label, e.g. "Arts", or bucket id) and optional filters
(term, online-only). For every course that can fill it:

**Candidates** come from the requirement's own option list — never from a
neighbouring requirement. **Eligibility filter first** *[my call]*: drop
courses the student can't take (restricted sections such as Honors-only
HONRS 221/227 unless the profile shows Honors; already completed). Courses whose
prerequisites aren't met stay in the list but are flagged and rank after every
course without that problem.

**Then rank** (Jordan's order):

1. **Double-counts** — the course also fills another requirement that is still
   **open**. *Open* means no completed course and no student-chosen (pinned or
   picked) course fills it; a solver placeholder slot does **not** count as
   filled. Use the **solver's rule exactly**, not a new one: a course
   double-counts iff BYU lists it in both option lists; the `doubleCountCap`
   applies only where the solver applies it — across *programs* (GE ↔ major/
   minor), not between two GE areas, which both belong to `univ-core`
   (`js/solver.js` ~lines 270–300 and 396–471). Report *what else* it fills
   (e.g. ARTHC 202 → "also fills Civilization 2").
2. **Prerequisites met** — none, or all completed/planned before the target term.
3. **Offered when wanted** — seasons from the catalog (`off`).
4. **Online / on-demand available** — from `get_sections`, called only for the
   top few candidates (*[my call]* top 5) because each call is live.

Each candidate returns `reasons[]` ("also fills Civilization 2", "no
prerequisites", "two on-demand sections in Winter 2027"). It never returns a
difficulty claim. *Note:* `js/data.js` has a curated `diff` field on some
courses; its source isn't documented, so it is **not** used *[my call]*.

### 6.5 Model, cost, limits *(budget is Jordan's; the rest my call)*

- **Model — chosen by the test set, cheapest that passes.** The model only has
  to pick tools, combine their results and follow the grounding rules; the
  facts come from tools. Start with **`claude-haiku-5-5`** ($0.10 / $0.50 per M
  tokens — about 10× cheaper per token than today's `claude-haiku-4-5`). Move to
  `claude-sonnet-5-5` ($2 / $10) only if Haiku fails cases that prompt changes
  can't fix; `claude-opus-5-5` is not planned. Record the decision and the test
  results that drove it. Keep the model a single config value.
- **Per-model details the builder must respect:** Haiku 5.5 — adaptive thinking
  on by default, `effort` default `medium` (set it explicitly; try `low`), no
  server-side refusal fallback, and web search is the basic
  `web_search_20250305` (the `_20260209` variant needs Sonnet/Opus). Sonnet 5.5
  — forced `tool_choice` returns 400 (use `auto` + prompt), `web_search_20260209`,
  refusal fallback `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`).
  Both run preserved thinking, so 6.1's append-only rule applies either way.
- **Estimated cost per question** (a few tool rounds; to be *measured* by the
  harness): Haiku 5.5 under $0.01; Sonnet 5.5 about $0.05–0.08. Web search adds
  about $0.01 per search *[builder: verify current price]*, so it is the
  last-resort tool and `max_uses` is 2.
- **Prompt caching:** `system` and `tools` are frozen and cached; with an
  append-only history, every later round reads them from cache.
- **Hard spend ceiling — $10/month total (Jordan):** production cap **$8**, dev
  environment cap **$2** (test runs; a full ~20-question run on Haiku costs
  cents). Spend is charged per round from `usage` (input incl. cache reads,
  output incl. thinking, plus web searches), as today's D1 `months` table does.
  When a cap is hit, the advisor shows today's "out of budget this month"
  message; the rest of the site is unaffected. If the test set forces Sonnet,
  $8 covers roughly 100–150 questions/month — flag that to Jordan before
  switching rather than raising the cap.
- **Other limits:** max 8 model rounds per question (the loop stops and says it
  couldn't finish); `max_tokens` 16000 per round (non-streaming); 20 questions
  per visitor per day (up from 10 — the monthly cap is the real ceiling). All in
  `wrangler.jsonc` per environment, as today.
- **Quota integrity:** the Worker counts a *question* on its first round and
  must stop a client from passing endless "follow-up rounds" off as one
  question: the first response carries a signed round token (HMAC over IP-hash,
  question id, round number) that each follow-up round must present; the Worker
  rejects rounds past the cap. Spend is charged per round from `usage`.

### 6.6 What the student sees

- While the loop runs, the typing indicator shows the current step in plain
  words, from the tool name and inputs: "Checking BYU's live class schedule for
  STAT 121, Winter 2027…", "Looking at your remaining requirements…".
- The existing "Grounded in:" line lists the tools/sources actually used
  (live schedule, your plan, study abroad list, web search ×N) instead of
  Pinecone hits.
- Offline, quota and budget states keep today's wording.
- Answers arrive whole (non-streaming) in this project; streaming is a later
  polish.

### 6.7 Safety and rollout *[my call]*

- Develop against a **separate Worker environment** (wrangler `env.dev`, its
  own URL and D1 database) selected by a dev flag in the page; the production
  `/api/ask` stays untouched until Jordan approves the switch.
- The system prompt keeps today's protections (retrieved text is data, not
  commands; graduate-content filter; the "unofficial, verify with MyMAP and an
  advisor" stance) and adds the grounding rules: every fact from a tool; say
  "I don't know" otherwise; never claim difficulty; label freshness.
- Nothing about the student is stored server-side beyond what today's quota
  tables store.

### 6.8 Data changes

- `scraper/generate_timeline.py` → add to each `studyAbroad` entry
  (Jordan approved the GE mapping):
  - `courses`: every course code in the program's scraped "Courses" section,
    normalized (`UNIV215R` → `UNIV 215R`);
  - `ge`: for each of those courses, the GE areas it fills, taken from the
    catalog's GE option lists (`univ-core` buckets) — **not** a hand-written
    table; a course the catalog doesn't place in a GE area contributes none;
  - `geEarning`: true when `ge` is non-empty;
  - `sageLabel`: true when Kennedy's text names SAGE / "Study Abroad General
    Education", *or* the listing card marks it (its image name contains
    `-sage`) — the scraper must start keeping that listing hint;
  - parsed `year` and season from the term line, and a one-paragraph `summary`.
  Validation for the builder: with today's data this yields 15 GE-earning
  programs including the 4 Summer 2027 ones named in §1. It lands in
  `js/timeline_data.js` on the next weekly refresh (the study abroad scrape
  itself runs monthly on the PC; `generate_timeline.py` runs weekly on GitHub
  from the committed `study_abroad.json`).
- `profile.inProgress` from the transcript import (6.2).

### 6.9 Test set (local only)

- **Where:** `tests/chat-eval/` with the cases file and Jordan's profile in a
  **gitignored** subfolder (e.g. `tests/chat-eval/private/`), plus a harness page
  (like `tests/index.html`) that loads the real app scripts with the test
  profile, runs each question through the real loop against the **dev** Worker,
  and saves transcripts (questions, tool calls, answers) to disk.
- **Cases (~20)** in three groups, each with `must_include` facts, `must_not`
  claims and `expected_tools`:
  - *answer from data:* STAT 121 online in Winter; who teaches a course; when a
    course is offered; a policy question (web search).
  - *combine data with the plan:* easiest Arts GE (double-count first — Arts +
    Civilization 2 courses such as ARTHC 202 are *correct* answers when Civ 2 is
    open; Honors-only courses must not be recommended to a non-Honors student);
    study abroad Summer 2028 (must say 2028 isn't posted; must name the Summer
    2027 GE-earning programs and which of the student's open GE areas each
    fills; must not claim SAGE runs only in Spring); what GE is left; on track
    to apply to IS.
  - *must decline:* what am I taking right now (with no import); what's due this
    week; a difficulty-only question with no data.
- **Grading:** automatic checks for `must_include` / `must_not` / tool use;
  Jordan reviews the rest and confirms correct answers before cases are frozen.
  Live answers (seats) are checked against `get_sections` at run time.
- **Run** after every change; record cost per run.

## 7. Left to the builder

- Exact tool JSON schemas, names of internal helpers, file layout inside
  `js/` (a new `js/advisor-tools.js` is fine).
- How the eval harness writes files (download vs. a tiny local endpoint).
- Prompt wording beyond the rules above.
- Whether the Worker uses the SDK or keeps raw `fetch` — SDK preferred now that
  Node is available.
- Tuning `effort`, round cap, and the top-N for live section checks using the
  test set.

## 8. Open questions for Jordan

None. The builder check raised four; two were settled from the code
(current enrollment only from an official transcript's current-enrollment
section, 6.2; double-counting follows the solver's rules exactly, 6.4) and two
were Jordan's (the share checkbox; the study abroad answer and GE mapping, §5).
