#!/usr/bin/env python3
"""
sources/byu_api.py
==================

Shared client for BYU's API gateway (api.byu.edu, behind Tyk). Every source
that reads a BYU API goes through this, so token handling, pacing, retries and
the legacy-JSON workarounds live in exactly one place.

Credentials: an OAuth client made at tcm.byu.edu, read from the environment as
BYU_CLIENT_ID / BYU_CLIENT_SECRET. Locally they live in scraper/.env (gitignored,
next to the Pinecone key); in CI they are GitHub Actions secrets. Clients are
per-environment -- a Sandbox client only works against api-sandbox.byu.edu --
so BYU_API_ENV picks the host (default: prod).

The secret and the token are never printed, logged, or written anywhere.

Why a client at all, when scraping is simpler: the dates step scrapes pages
behind BYU's CloudFront, which answers 403 to GitHub's runner IPs. The gateway
does not, and it returns structured data instead of HTML that can change shape.

Usage:
    from byu_api import ByuApi
    api = ByuApi()
    data = api.get("/domains/legacy/academic/controls/controldatesws/v1/registration")

Author: Jordan Heaton
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any, Optional

import requests

HOSTS = {
    "prod": "https://api.byu.edu",
    "sandbox": "https://api-sandbox.byu.edu",
}
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"

# The gateway advertised "300-in-1min" during recon (2026-10-20). Stay well
# under it: a weekly job has no reason to race, and an unpublished limit is one
# to treat as lower than it looks.
MIN_INTERVAL = 0.3          # seconds between requests (~200/min)
TOKEN_MARGIN = 120          # refresh this many seconds before the token expires
RETRIES = 4                 # attempts on 429/5xx/network errors
TIMEOUT = 60
USER_AGENT = "myplanBYU-scraper/1.0 (+educational; contact jordandheaton@gmail.com)"


class ByuApiError(RuntimeError):
    pass


def _load_env_file() -> None:
    """Fill BYU_* from scraper/.env if the environment doesn't already have them.
    Hand-parsed so CI doesn't need python-dotenv; CI passes secrets as env."""
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("BYU_") and key not in os.environ:
            os.environ[key] = value.strip().strip('"').strip("'")


_BAD_ESCAPE = re.compile(r'\\(?!["\\/bfnrtu])')


def lenient_json(text: str) -> Any:
    """Legacy BYU services emit JSON strict parsers reject: raw control
    characters in strings, trailing junk after the object, invalid escapes,
    and (ExamCredit) a literal error message where a closing ']' belongs."""
    text = text.lstrip("﻿")
    if not text.strip():
        raise ValueError("empty body")
    attempts = (
        lambda t: json.loads(t),
        lambda t: json.loads(t.replace("data list is missing ending delimiter", ""), strict=False),
        lambda t: json.loads(t, strict=False),
        lambda t: json.JSONDecoder(strict=False).raw_decode(t.lstrip())[0],
        lambda t: json.JSONDecoder(strict=False).raw_decode(_BAD_ESCAPE.sub(r"\\\\", t.lstrip()))[0],
    )
    last: Optional[Exception] = None
    for parse in attempts:
        try:
            return parse(text)
        except ValueError as exc:
            last = exc
    raise ValueError(f"unparseable JSON: {last}")


class ByuApi:
    def __init__(self, env: Optional[str] = None) -> None:
        _load_env_file()
        self.env = (env or os.environ.get("BYU_API_ENV") or "prod").lower()
        if self.env not in HOSTS:
            raise ByuApiError(f"BYU_API_ENV must be one of {sorted(HOSTS)}, got {self.env!r}")
        self.host = HOSTS[self.env]
        self._id = os.environ.get("BYU_CLIENT_ID", "")
        self._secret = os.environ.get("BYU_CLIENT_SECRET", "")
        if not (self._id and self._secret):
            raise ByuApiError(
                "BYU_CLIENT_ID / BYU_CLIENT_SECRET are not set "
                "(scraper/.env locally, repository secrets in GitHub Actions)")
        self._token: Optional[str] = None
        self._expires_at = 0.0
        self._last_call = 0.0
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})

    # --- token -------------------------------------------------------------
    def _fetch_token(self) -> None:
        resp = self.session.post(
            self.host + "/token",
            data={"grant_type": "client_credentials"},
            auth=(self._id, self._secret),
            timeout=TIMEOUT,
        )
        if resp.status_code != 200:
            # The body can echo request details; keep it short and never
            # include the credentials.
            raise ByuApiError(
                f"token request failed: HTTP {resp.status_code} on {self.env} -- check that "
                f"the client was made for this environment in tcm.byu.edu")
        body = resp.json()
        token = body.get("access_token")
        if not token:
            raise ByuApiError("token response had no access_token")
        self._token = token
        self._expires_at = time.time() + float(body.get("expires_in") or 3600)

    def _auth_header(self) -> dict:
        if not self._token or time.time() > self._expires_at - TOKEN_MARGIN:
            self._fetch_token()
        return {"Authorization": "Bearer " + self._token}

    # --- requests ----------------------------------------------------------
    def _pace(self) -> None:
        wait = self._last_call + MIN_INTERVAL - time.time()
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.time()

    def get(self, path: str, params: Optional[dict] = None) -> Any:
        """GET a gateway path and return parsed JSON. Refreshes the token once
        on 401; backs off on 429/5xx/network errors; raises ByuApiError on
        anything else (403 = not subscribed / needs a Data Sharing Request)."""
        refreshed = False
        for attempt in range(RETRIES):
            self._pace()
            try:
                resp = self.session.get(self.host + path, params=params,
                                        headers=self._auth_header(), timeout=TIMEOUT)
            except requests.RequestException as exc:
                if attempt == RETRIES - 1:
                    raise ByuApiError(f"GET {path}: {exc.__class__.__name__}") from None
                time.sleep(2 ** attempt)
                continue
            if resp.status_code == 401 and not refreshed:
                self._token, refreshed = None, True
                continue
            if resp.status_code == 429 or resp.status_code >= 500:
                if attempt == RETRIES - 1:
                    raise ByuApiError(f"GET {path}: HTTP {resp.status_code} after {RETRIES} tries")
                retry_after = resp.headers.get("Retry-After", "")
                time.sleep(float(retry_after) if retry_after.isdigit() else 2 ** (attempt + 1))
                continue
            if resp.status_code != 200:
                raise ByuApiError(f"GET {path}: HTTP {resp.status_code}")
            try:
                return lenient_json(resp.text)
            except ValueError as exc:
                raise ByuApiError(f"GET {path}: {exc}") from None
        raise ByuApiError(f"GET {path}: gave up")
