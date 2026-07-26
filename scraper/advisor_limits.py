#!/usr/bin/env python3
"""
advisor_limits.py  --  cost guardrails for the myplanBYU advisor API
====================================================================

Two independent limits, because they fail differently:

  * PER-VISITOR QUOTA -- 10 questions each. Stops one person (or one bored
    script) from burning the whole budget. Returns 429.
  * SPEND CAP -- a hard dollar ceiling per calendar month, measured from the
    token counts Anthropic reports on every reply, not estimated. Stops the
    aggregate of many well-behaved visitors. Returns 503.

The quota is the everyday limit; the spend cap is the backstop that means a
worst case costs a known number of dollars instead of an unknown one.

Both survive a restart (state lives in advisor_usage.json next to this file)
-- a cap you can reset by restarting the process is not a cap.

Configure with environment variables (all optional):

    ADVISOR_MONTHLY_BUDGET_USD   default 5.00   -- hard ceiling per month
    ADVISOR_QUESTIONS_PER_IP     default 10     -- questions per visitor
    ADVISOR_QUOTA_WINDOW_HOURS   default 24     -- 0 = never resets (lifetime)
    ADVISOR_TRUSTED_PROXIES      default 0      -- see client_ip() below
    ADVISOR_PRICE_IN_PER_MTOK    default 1.00   -- claude-haiku-4-5 input
    ADVISOR_PRICE_OUT_PER_MTOK   default 5.00   -- claude-haiku-4-5 output
    ADVISOR_PRICE_WEB_SEARCH_K   default 10.00  -- per 1,000 web searches

Prices default to Anthropic's published claude-haiku-4-5 rates. Verify them
against current pricing before relying on the cap: if the real rate is higher
than what is set here, the cap is measured in the wrong currency and lets more
spend through than intended.

Author: Jordan Heaton
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

STATE_PATH = Path(__file__).resolve().parent / "advisor_usage.json"


def _f(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _i(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


MONTHLY_BUDGET_USD = _f("ADVISOR_MONTHLY_BUDGET_USD", 5.00)
QUESTIONS_PER_IP = _i("ADVISOR_QUESTIONS_PER_IP", 10)
QUOTA_WINDOW_HOURS = _i("ADVISOR_QUOTA_WINDOW_HOURS", 24)
TRUSTED_PROXIES = _i("ADVISOR_TRUSTED_PROXIES", 0)

PRICE_IN = _f("ADVISOR_PRICE_IN_PER_MTOK", 1.00) / 1_000_000
PRICE_OUT = _f("ADVISOR_PRICE_OUT_PER_MTOK", 5.00) / 1_000_000
PRICE_CACHE_WRITE = PRICE_IN * 1.25      # Anthropic: cache writes cost 1.25x input
PRICE_CACHE_READ = PRICE_IN * 0.10       # cache reads cost 0.10x input
PRICE_WEB_SEARCH = _f("ADVISOR_PRICE_WEB_SEARCH_K", 10.00) / 1_000

# Headroom: stop this far short of the cap so the LAST allowed question cannot
# push the month past it. Sized for the expensive shape of a request, not the
# typical one -- retrieval (~12 docs) plus the plan and 8 history turns is only
# ~25k input tokens, but a web search re-runs the model with the results
# appended, so input can land several times higher. 150k is deliberately
# pessimistic; the cost of overestimating is stopping a few cents early.
_WORST_CASE_USD = 150_000 * PRICE_IN + 2_048 * PRICE_OUT + 3 * PRICE_WEB_SEARCH


def client_ip(remote_addr: str, forwarded_for: str | None) -> str:
    """The address to bill this request to.

    X-Forwarded-For is written by whoever is upstream, INCLUDING the client, so
    trusting it blindly turns the quota into a suggestion: send
    `X-Forwarded-For: <random>` and every request looks like a new visitor. So
    the header is ignored entirely unless ADVISOR_TRUSTED_PROXIES says how many
    proxies actually sit in front of this server.

    Each proxy appends the address it received the connection from, so with N
    trusted hops the honest client address is the Nth entry from the RIGHT.
    Anything a client injects lands to the left of that and is ignored.

    Running behind one reverse proxy / tunnel -> set ADVISOR_TRUSTED_PROXIES=1.
    Directly exposed -> leave it 0.
    """
    if TRUSTED_PROXIES > 0 and forwarded_for:
        parts = [p.strip() for p in forwarded_for.split(",") if p.strip()]
        if len(parts) >= TRUSTED_PROXIES:
            return parts[-TRUSTED_PROXIES]
        if parts:                      # fewer hops than configured -- take the
            return parts[0]            # furthest-left rather than trust nothing
    return remote_addr or "unknown"


class Guard:
    """Per-visitor quota + monthly spend cap. Thread-safe; Flask serves
    requests on multiple threads, so every counter is touched under one lock."""

    def __init__(self, path: Path = STATE_PATH):
        self.path = path
        self.lock = threading.Lock()
        self.month = _now_month()
        self.spent_usd = 0.0
        self.questions = 0
        self.hits: dict[str, list[float]] = {}   # ip hash -> question timestamps
        self.salt = secrets.token_hex(16)
        self._load()

    # ---------------------------------------------------------------- state
    def _load(self):
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        self.salt = raw.get("salt") or self.salt
        if raw.get("month") == self.month:          # a new month starts clean
            self.spent_usd = float(raw.get("spent_usd") or 0.0)
            self.questions = int(raw.get("questions") or 0)
            self.hits = {k: [float(t) for t in v]
                         for k, v in (raw.get("hits") or {}).items()}

    def _save(self):
        """Atomic write: a crash mid-save must not leave a truncated file that
        reads as zero spend on the next start."""
        tmp = self.path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps({
                "month": self.month, "salt": self.salt,
                "spent_usd": round(self.spent_usd, 6),
                "questions": self.questions,
                "hits": {k: [round(t, 1) for t in v] for k, v in self.hits.items()},
            }), encoding="utf-8")
            tmp.replace(self.path)
        except OSError as exc:
            print(f"  [warn] couldn't persist advisor usage: {exc}")

    def _roll_month(self):
        m = _now_month()
        if m != self.month:
            self.month, self.spent_usd, self.questions, self.hits = m, 0.0, 0, {}

    def _key(self, ip: str) -> str:
        # Store a salted hash, not the address itself: this file is a record of
        # who asked what and when, and it does not need to be readable.
        return hashlib.sha256(f"{self.salt}{ip}".encode()).hexdigest()[:16]

    def _recent(self, key: str, now: float) -> list[float]:
        stamps = self.hits.get(key, [])
        if QUOTA_WINDOW_HOURS <= 0:
            return stamps                                   # lifetime quota
        cutoff = now - QUOTA_WINDOW_HOURS * 3600
        return [t for t in stamps if t >= cutoff]

    # ---------------------------------------------------------------- checks
    def check(self, ip: str) -> dict:
        """Called before spending anything. Returns
        {ok, status, error, retry_after, remaining}."""
        now = time.time()
        with self.lock:
            self._roll_month()

            if self.spent_usd + _WORST_CASE_USD > MONTHLY_BUDGET_USD:
                return {
                    "ok": False, "status": 503, "remaining": 0,
                    "error": "The advisor has reached its monthly usage budget "
                             "and is paused until next month. Everything else "
                             "on the planner works without it.",
                }

            key = self._key(ip)
            recent = self._recent(key, now)
            if len(recent) >= QUESTIONS_PER_IP:
                if QUOTA_WINDOW_HOURS > 0:
                    retry = int(recent[0] + QUOTA_WINDOW_HOURS * 3600 - now)
                    hrs = max(1, round(retry / 3600))
                    msg = (f"You've used all {QUESTIONS_PER_IP} advisor questions. "
                           f"More become available in about {hrs} hour"
                           f"{'' if hrs == 1 else 's'}.")
                else:
                    retry, msg = 0, (f"You've used all {QUESTIONS_PER_IP} advisor "
                                     "questions for this demo.")
                return {"ok": False, "status": 429, "error": msg,
                        "retry_after": max(1, retry), "remaining": 0}

            return {"ok": True, "remaining": QUESTIONS_PER_IP - len(recent)}

    def consume(self, ip: str) -> int:
        """Claim one question for this visitor. Called once we are committed to
        calling Claude. Returns questions remaining after this one."""
        now = time.time()
        with self.lock:
            key = self._key(ip)
            recent = self._recent(key, now)
            recent.append(now)
            self.hits[key] = recent
            self.questions += 1
            self._prune(now)
            self._save()
            return max(0, QUESTIONS_PER_IP - len(recent))

    def refund(self, ip: str):
        """Give the question back when Claude never answered -- a visitor should
        not lose one of their ten to our outage."""
        with self.lock:
            key = self._key(ip)
            if self.hits.get(key):
                self.hits[key].pop()
                self.questions = max(0, self.questions - 1)
                self._save()

    def record(self, usage: dict, web_searches: int = 0):
        """Add the real cost of one reply, from Anthropic's own token counts."""
        cost = (
            int(usage.get("input_tokens") or 0) * PRICE_IN
            + int(usage.get("output_tokens") or 0) * PRICE_OUT
            + int(usage.get("cache_creation_input_tokens") or 0) * PRICE_CACHE_WRITE
            + int(usage.get("cache_read_input_tokens") or 0) * PRICE_CACHE_READ
            + int(web_searches or 0) * PRICE_WEB_SEARCH
        )
        with self.lock:
            self._roll_month()
            self.spent_usd += cost
            self._save()
        return cost

    def _prune(self, now: float):
        """Drop visitors whose questions have all aged out, so a public URL
        can't grow this dict without bound."""
        if QUOTA_WINDOW_HOURS <= 0 or len(self.hits) < 500:
            return
        cutoff = now - QUOTA_WINDOW_HOURS * 3600
        self.hits = {k: v for k, v in self.hits.items()
                     if v and max(v) >= cutoff}

    def status(self) -> dict:
        with self.lock:
            self._roll_month()
            return {
                "month": self.month,
                "budget_usd": round(MONTHLY_BUDGET_USD, 2),
                "spent_usd": round(self.spent_usd, 4),
                "budget_left_usd": round(max(0.0, MONTHLY_BUDGET_USD - self.spent_usd), 4),
                "budget_exhausted": self.spent_usd + _WORST_CASE_USD > MONTHLY_BUDGET_USD,
                "questions_this_month": self.questions,
                "questions_per_visitor": QUESTIONS_PER_IP,
                "quota_window_hours": QUOTA_WINDOW_HOURS,
            }


def _now_month() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")
