/* =========================================================================
   myplanBYU — chat.js
   Floating "Ask the AI Advisor" panel. Talks to the local RAG advisor server
   (scraper/advisor_server.py, http://127.0.0.1:5000) which retrieves grounded
   BYU data from Pinecone and answers with Claude. Each question can include a
   snapshot of the student's current draft plan (App.planSummary()) so the
   advisor discusses THEIR schedule, not hypotheticals.
   ========================================================================= */
"use strict";

const Chat = (() => {

  // Advisor backend base URL. Local demo default; to host it live later, set
  //   window.MYPLAN_ADVISOR_API = "https://your-host.example.com/api";
  // in a <script> before chat.js (one line — nothing else changes).
  const API = (typeof window !== "undefined" && window.MYPLAN_ADVISOR_API)
    || "http://127.0.0.1:5000/api";
  // If the page is served over https but the API is plain-http localhost, the
  // browser will block the request (mixed content) — treat as offline up front
  // so we show a clean explanation instead of a scary network error.
  const MIXED_CONTENT_BLOCKED =
    typeof location !== "undefined" && location.protocol === "https:" && /^http:\/\//i.test(API);

  const history = [];   // [{role, content}] — session memory for follow-ups
  let online = null;    // null = unknown, true/false after a health check

  const $ = sel => document.querySelector(sel);
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /* tiny safe markdown: bold, inline code, bullets, line breaks */
  function md(s) {
    let h = esc(s);
    h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
    h = h.replace(/^### (.+)$/gm, "<b>$1</b>");
    h = h.replace(/^## (.+)$/gm, "<b>$1</b>");
    h = h.replace(/^[-•] (.+)$/gm, "<span class=\"chat-li\">• $1</span>");
    return h.replace(/\n/g, "<br>");
  }

  function addMsg(role, html, cls = "") {
    const el = document.createElement("div");
    el.className = `chat-msg ${role} ${cls}`;
    el.innerHTML = html;
    $("#chatMsgs").appendChild(el);
    $("#chatMsgs").scrollTop = $("#chatMsgs").scrollHeight;
    return el;
  }

  /* Friendly, non-technical offline notice. The advisor needs a running
     backend; in the static demo deployment there isn't one. */
  function offlineHtml() {
    return "<b>The AI Advisor is offline right now.</b><br>" +
      "It runs on a small backend server that isn't part of this static demo. " +
      "To try it live, run the advisor locally (see the repo's " +
      "<code>scraper/</code> README) and reload — everything else on the page " +
      "works without it.";
  }

  let offlineShown = false;
  function showOffline() {
    if (offlineShown) return;
    offlineShown = true;
    addMsg("bot", offlineHtml(), "err");
  }

  /* Quick health probe (short timeout) so we can tell "server down" from a
     real error, and disable the composer cleanly when offline. */
  async function checkHealth() {
    if (MIXED_CONTENT_BLOCKED) { online = false; return false; }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const r = await fetch(`${API}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      online = r.ok;
    } catch { online = false; }
    return online;
  }

  async function send() {
    const input = $("#chatInput");
    const q = input.value.trim();
    if (!q) return;
    // Known-offline (mixed content or a prior failed probe): explain, don't fetch.
    if (online === false) { addMsg("user", esc(q)); input.value = ""; showOffline(); return; }
    input.value = "";
    addMsg("user", esc(q));
    history.push({ role: "user", content: q });

    const sharePlan = $("#chatSharePlan").checked;
    // App is a top-level `const` (not on window) — reference it directly.
    const planCtx = sharePlan && typeof App !== "undefined" && App.planSummary
      ? App.planSummary() : "";

    const typing = addMsg("bot", "<i class=\"fas fa-ellipsis fa-fade\"></i>", "typing");
    $("#chatSend").disabled = true;

    try {
      const resp = await fetch(`${API}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          plan_context: planCtx,
          history: history.slice(0, -1).slice(-8),
        }),
      });
      const data = await resp.json();
      typing.remove();

      if (!resp.ok || data.error) {
        addMsg("bot", `<b>Hmm, something went wrong.</b><br>${esc(data.error || resp.statusText)}`, "err");
        return;
      }

      // PROPOSED ACTION: the advisor may end with one machine-readable line
      // (ACTION_JSON: {...}) proposing a plan change. Strip it from the shown
      // text and render a "Try it" button that runs the client-side what-if
      // comparison — the user stays in the loop; nothing changes until they
      // choose to save the alternative.
      let action = null;
      const am = data.answer && data.answer.match(/^\s*ACTION_JSON:\s*(\{.*\})\s*$/m);
      if (am) { try { action = JSON.parse(am[1]); } catch { /* malformed — ignore */ } }
      const shown = am ? data.answer.replace(/^\s*ACTION_JSON:.*$/m, "").trim() : data.answer;

      let html = md(shown);
      const srcs = (data.sources || []).slice(0, 3)
        .map(s => (s.url
          ? `<a class="chat-src-link" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>`
          : esc(s.name)) + ` <span class="chat-src-type">${esc(s.type)}</span>`);
      if (data.web_searches) {
        srcs.push(`<i class="fas fa-globe"></i> live web search ×${data.web_searches}`);
      }
      if (srcs.length) {
        html += `<div class="chat-srcs"><i class="fas fa-book"></i> Grounded in: ${srcs.join(" · ")}</div>`;
      }
      const msgEl = addMsg("bot", html);
      attachAction(msgEl, action);
      online = true;
      history.push({ role: "assistant", content: shown });
    } catch (e) {
      typing.remove();
      online = false;
      showOffline();
    } finally {
      $("#chatSend").disabled = false;
      input.focus();
    }
  }

  /* Resolve the advisor's proposed action to a real program and render the
     "Try it" button. Unknown types or unmatched program names fail silently
     (the text answer stands on its own). */
  function attachAction(msgEl, action) {
    if (!action || typeof App === "undefined" || !App.openWhatIf) return;
    const pools = {
      add_minor: DATA.minors, remove_minor: DATA.minors,
      add_cert: DATA.certs, switch_major: DATA.majors,
      enable_spsu: null,
    };
    if (!(action.type in pools)) return;
    let programId = null, progName = "";
    if (pools[action.type]) {
      const want = String(action.program || "").toLowerCase().replace(/\s*\(.*\)$/, "").trim();
      if (!want) return;
      const pool = pools[action.type];
      const hit = pool.find(p => p.name.toLowerCase().replace(/\s*\(.*\)$/, "") === want)
        || pool.find(p => p.name.toLowerCase().includes(want))
        || pool.find(p => want.includes(p.name.toLowerCase().replace(/\s*\(.*\)$/, "")));
      if (!hit) return;
      programId = hit.id; progName = hit.name.replace(/\s*\(.*\)$/, "");
    }
    const label = action.type === "enable_spsu" ? "Try it — compare with Spring/Summer terms"
      : action.type === "switch_major" ? `Try it — compare switching to ${progName}`
      : action.type === "remove_minor" ? `Try it — compare dropping ${progName}`
      : `Try it — compare adding ${progName}`;
    const btn = document.createElement("button");
    btn.className = "btn primary sm chat-action";
    btn.innerHTML = `<i class="fas fa-code-compare"></i> ${esc(label)}`;
    btn.addEventListener("click", () => App.openWhatIf({ type: action.type, programId }));
    msgEl.appendChild(btn);
    $("#chatMsgs").scrollTop = $("#chatMsgs").scrollHeight;
  }

  let probed = false;
  function toggle(open) {
    const panel = $("#chatPanel");
    const show = open ?? !panel.classList.contains("open");
    panel.classList.toggle("open", show);
    $("#chatFab").classList.toggle("hidden", show);
    if (show) {
      $("#chatInput").focus();
      // Probe the backend the first time the panel opens; if it's offline,
      // say so immediately rather than after the user types a question.
      if (!probed) {
        probed = true;
        checkHealth().then(ok => { if (!ok) showOffline(); });
      }
    }
  }

  function init() {
    $("#chatFab").addEventListener("click", () => toggle(true));
    $("#chatClose").addEventListener("click", () => toggle(false));
    $("#chatSend").addEventListener("click", send);
    $("#chatInput").addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    // quick-action chips (Critique my plan, etc.) — fill + send in one click
    document.querySelectorAll("#chatQuick button").forEach(b =>
      b.addEventListener("click", () => { $("#chatInput").value = b.dataset.q; send(); }));

    addMsg("bot",
      "Hi! I'm the <b>myplanBYU AI Advisor</b> — grounded in live BYU data: every major and course, " +
      "certificates, study abroad, scholarships and deadlines, clubs, AP/IB and transfer credit.<br><br>" +
      "Ask me anything — <i>\"Does my plan meet the IS major requirements?\"</i>, " +
      "<i>\"When is the add/drop deadline?\"</i>, <i>\"What clubs fit an accounting major?\"</i>");
  }

  document.addEventListener("DOMContentLoaded", init);
  return { toggle };
})();
