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

  const API = "http://127.0.0.1:5000/api";
  const history = [];   // [{role, content}] — session memory for follow-ups

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

  async function send() {
    const input = $("#chatInput");
    const q = input.value.trim();
    if (!q) return;
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

      let html = md(data.answer);
      const srcs = (data.sources || []).slice(0, 3)
        .map(s => `${esc(s.name)} <span class="chat-src-type">${esc(s.type)}</span>`);
      if (data.web_searches) {
        srcs.push(`<i class="fas fa-globe"></i> live web search ×${data.web_searches}`);
      }
      if (srcs.length) {
        html += `<div class="chat-srcs"><i class="fas fa-book"></i> Grounded in: ${srcs.join(" · ")}</div>`;
      }
      addMsg("bot", html);
      history.push({ role: "assistant", content: data.answer });
    } catch (e) {
      typing.remove();
      addMsg("bot",
        "<b>I can't reach the advisor server.</b><br>Start it from the <code>scraper</code> folder:" +
        "<br><code>.\\.venv\\Scripts\\python.exe advisor_server.py</code><br>then ask again.", "err");
    } finally {
      $("#chatSend").disabled = false;
      input.focus();
    }
  }

  function toggle(open) {
    const panel = $("#chatPanel");
    const show = open ?? !panel.classList.contains("open");
    panel.classList.toggle("open", show);
    $("#chatFab").classList.toggle("hidden", show);
    if (show) $("#chatInput").focus();
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
