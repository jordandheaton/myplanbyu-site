/* =========================================================================
   myplanBYU — app.js
   UI layer: MyMAP-style board, progress report, saved plans, wizard,
   priorities dials, drag & drop with live constraint validation.
   ========================================================================= */
"use strict";

const App = (() => {

  const LS_KEY = "myplanbyu.v1";
  const SEASON_EMOJI = { F: "🍁", W: "❄️", S: "🌱", U: "☀️" };
  const TYPE_META = {
    maj: { label: "Maj", cls: "b-maj", full: "Major" },
    min: { label: "Min", cls: "b-min", full: "Minor" },
    crt: { label: "Crt", cls: "b-crt", full: "Certificate" },
    rel: { label: "Rel", cls: "b-rel", full: "Religion" },
    ge:  { label: "GE",  cls: "b-ge",  full: "University Core" },
    el:  { label: "El",  cls: "b-el",  full: "Elective" },
  };

  let plans = [];            // [{id,name,profile,createdAt,updatedAt}]
  let activeId = null;
  let result = null;         // live solve result for active plan
  let wiz = null;            // wizard working profile
  let wizStep = 0;
  let dragUid = null;

  const $ = sel => document.querySelector(sel);
  const $$ = sel => [...document.querySelectorAll(sel)];
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /* ------------------------------ storage ---------------------------- */
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY));
      if (raw && Array.isArray(raw.plans)) { plans = raw.plans; activeId = raw.activeId; }
    } catch (e) { /* fresh start */ }
  }
  function save() {
    localStorage.setItem(LS_KEY, JSON.stringify({ plans, activeId }));
  }
  const activePlan = () => plans.find(p => p.id === activeId) || null;

  function newPlanFromProfile(profile, name) {
    const plan = {
      id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name || profile.name || "New plan",
      profile: JSON.parse(JSON.stringify(profile)),
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    plans.unshift(plan);
    activeId = plan.id;
    save();
    return plan;
  }

  /* ------------------------------ solving ---------------------------- */
  function solveActive(opts = {}) {
    const plan = activePlan();
    if (!plan) { result = null; render(); return; }
    result = Solver.solve(plan.profile, opts);
    plan.updatedAt = Date.now();
    save();
    checkFlowchartGaps(plan.profile);
    render();
  }

  /* Data-quality flag: if a selected program has thin requirement data (the
     catalog freeform was sparse), log a utility pointer so the data pipeline
     knows to re-scrape that layout. Fires once per program per session. */
  const _flaggedPrograms = new Set();
  function checkFlowchartGaps(profile) {
    const ids = [profile.majorId, ...(profile.minorIds || []), ...(profile.certIds || [])].filter(Boolean);
    ids.forEach(id => {
      const p = DATA.programIndex[id];
      if (!p || _flaggedPrograms.has(id)) return;
      const realOptions = new Set();
      (p.buckets || []).forEach(b => (b.options || []).forEach(o => { if (!/^BUCKET::/.test(o)) realOptions.add(o); }));
      if (realOptions.size < 4) {
        _flaggedPrograms.add(id);
        console.warn(
          `[myplanBYU:flowchart-gap] "${p.name}" has thin requirement data ` +
          `(${realOptions.size} courses). Re-scrape its layout from ` +
          `https://catalog26byu.catalog.prod.coursedog.com/programs — ` +
          `then re-run scraper/generate_data.py.`);
      }
    });
  }

  /* ------------------------------ helpers ---------------------------- */
  function classify(buckets) {
    let best = "el", bestRank = 9;
    const rank = { maj: 0, min: 1, crt: 2, rel: 3, ge: 4, el: 5 };
    (buckets || []).forEach(key => {
      const [pid, bid] = key.split("::");
      let k = "el";
      const prog = DATA.programIndex[pid];
      if (prog) {
        if (prog.type === "major") k = "maj";
        else if (prog.type === "minor") k = "min";
        else if (prog.type === "cert") k = "crt";
        else if (prog.type === "core") k = bid.startsWith("rel") ? "rel" : "ge";
      }
      if (rank[k] < bestRank) { bestRank = rank[k]; best = k; }
    });
    return TYPE_META[best];
  }
  const planCredits = () => result ? result.placements.reduce((s, p) => s + p.credits, 0) : 0;
  const planSemesters = () => result ? new Set(result.placements.map(p => p.termIndex)).size : 0;
  function seasonsUsed() {
    if (!result) return [];
    const s = new Set(result.placements.map(p => result.terms[p.termIndex].season));
    return ["W", "S", "U", "F"].filter(x => s.has(x));
  }
  function persistPin(uid, termIndex) {
    const plan = activePlan();
    if (!plan || !result) return;
    const tm = result.terms[termIndex];
    plan.profile.pins[uid] = { year: tm.year, season: tm.season, manual: true };
    plan.updatedAt = Date.now();
    save();
  }

  function toast(msg, kind = "err") {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $("#toasts").appendChild(el);
    setTimeout(() => el.classList.add("show"), 10);
    setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 4200);
  }

  /* ------------------------------ render ----------------------------- */
  function render() {
    renderStudentBand();
    renderToolbar();
    renderBoard();
    renderProgress();
    renderPlans();
  }

  function renderStudentBand() {
    const plan = activePlan();
    const el = $("#studentBand");
    if (!plan) { el.innerHTML = ""; return; }
    const prof = plan.profile;
    const major = DATA.programIndex[prof.majorId];
    el.innerHTML = `
      <div class="sb-name">
        <a class="sb-link">${esc(plan.name)}</a>
        <div class="sb-sub">${esc(major ? major.name : "No major selected")} · starts ${esc(Solver.SEASON_NAME[prof.startTerm.season])} ${prof.startTerm.year}</div>
      </div>
      <div class="sb-chips">
        <div class="sb-chip"><span class="sb-lbl">Standing</span><span class="pill green">GOOD</span></div>
        <div class="sb-chip"><span class="sb-lbl">Solver</span><span class="pill green">${result ? result.solveMs + " ms" : "—"}</span></div>
        <div class="sb-chip"><span class="sb-lbl">Housing</span><span class="pill blue">${prof.settings.housing === "off-campus-12mo" ? "12-mo lease" : prof.settings.housing === "off-campus" ? "Off campus" : "On campus"}</span></div>
        <div class="sb-chip"><span class="sb-lbl">Double-counted</span><span class="pill amber">${result ? result.doubleCounted : 0} cr</span></div>
        <div class="sb-chip"><span class="sb-lbl">Plan score</span><span class="pill navy">${result ? result.score.total.toFixed(1) : "—"}</span></div>
      </div>`;
  }

  function renderToolbar() {
    const plan = activePlan();
    $("#planTitleName").textContent = plan ? plan.name : "No plan yet";
  }

  function renderBoard() {
    const board = $("#board");
    if (!result || !activePlan()) {
      board.innerHTML = `<div class="board-empty">
        <div class="be-icon"><i class="fas fa-map"></i></div>
        <h3>No plan yet</h3>
        <p>Click <b>+ New plan</b> to choose a major, up to two minors, and certificates —
        then the solver builds an optimized semester-by-semester sequence around your life.</p>
        <button class="btn primary" id="emptyNewPlan"><i class="fas fa-plus"></i> New plan</button>
        <button class="btn ghost" id="emptyDemo"><i class="fas fa-wand-magic-sparkles"></i> Load the demo (IS + MISM + Ballroom + Spanish + Global Business)</button>
      </div>`;
      $("#emptyNewPlan").onclick = () => openWizard();
      $("#emptyDemo").onclick = () => { newPlanFromProfile(DATA.demoProfile, "Jordan's integrated MISM plan"); solveActive(); };
      return;
    }
    const byTerm = new Map();
    result.placements.forEach(p => {
      if (!byTerm.has(p.termIndex)) byTerm.set(p.termIndex, []);
      byTerm.get(p.termIndex).push(p);
    });
    if (!byTerm.size) {
      board.innerHTML = `<div class="board-empty"><h3>Nothing left to schedule</h3><p>Everything selected is already completed. Add more programs or start a new plan.</p></div>`;
      return;
    }
    const last = Math.max(...byTerm.keys());
    let html = "";
    result.terms.forEach(tm => {
      if (tm.index > last) return;
      const items = byTerm.get(tm.index) || [];
      if (!items.length && !tm.isFW) return;              // hide empty Spring/Summer
      if (!items.length && !tm.enabled) return;
      const credits = items.reduce((s, p) => s + p.credits, 0);
      // Over-cap terms get a visible red banner instead of blocking the move.
      const over18 = credits > 18;                       // BYU registration cap
      const overCap = credits > tm.cap;
      items.sort((a, b) => (classify(a.buckets).label > classify(b.buckets).label ? 1 : -1) || b.credits - a.credits);
      html += `
      <div class="col ${items.length ? "" : "col-empty"} ${overCap ? "col-over" : ""}" data-term="${tm.index}">
        <div class="col-head">
          <span class="col-season">${SEASON_EMOJI[tm.season]}</span>
          <span class="col-title">${esc(tm.label)}</span>
          <span class="col-credits ${overCap ? "over" : ""}">${credits} credits</span>
        </div>
        ${overCap ? `<div class="col-warnbar">${over18
          ? `<i class="fas fa-triangle-exclamation"></i> ${credits} cr — over BYU's 18-credit cap (needs college approval)`
          : `<i class="fas fa-triangle-exclamation"></i> ${credits} cr — over your ${tm.cap}-credit limit`}</div>` : ""}
        <div class="col-body" data-term="${tm.index}">
          ${items.map(cardHtml).join("")}
          ${items.length ? "" : `<div class="col-hint">open — drag a class here</div>`}
        </div>
        <div class="col-search">
          <input type="text" placeholder="🔍 Add a ${Solver.SEASON_NAME[tm.season]} class…"
                 data-term="${tm.index}" data-season="${tm.season}" data-year="${tm.year}">
          <div class="col-search-results" hidden></div>
        </div>
      </div>`;
    });
    if (result.unscheduled.length) {
      html += `<div class="col col-problem">
        <div class="col-head"><span class="col-season">⚠️</span><span class="col-title">Unscheduled</span></div>
        <div class="col-body">${result.unscheduled.map(u => `<div class="card"><div class="card-main"><span class="card-code">${esc(u.uid)}</span><span class="card-name">${esc(u.name)}</span></div></div>`).join("")}</div>
      </div>`;
    }
    board.innerHTML = html;

    // drag & drop wiring
    $$("#board .card[draggable]").forEach(card => {
      card.addEventListener("dragstart", e => {
        dragUid = card.dataset.uid;
        card.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      card.addEventListener("dragend", () => { card.classList.remove("dragging"); $$(".col-body.over").forEach(c => c.classList.remove("over")); });
      card.addEventListener("click", (e) => {
        const p = result.placements.find(x => x.uid === card.dataset.uid);
        if (p && p.bucket) { e.stopPropagation(); openBucketPicker(p, card); }
        else openCourseModal(card.dataset.uid);
      });
    });
    // per-semester course search: only shows classes actually offered that
    // season (a Fall-only elective never appears in a Winter search)
    $$("#board .col-search input").forEach(inp => {
      const box = inp.nextElementSibling;
      const season = inp.dataset.season;
      inp.addEventListener("input", () => {
        const q = inp.value.trim().toLowerCase();
        if (q.length < 2) { box.hidden = true; return; }
        const inPlan = new Set(result.placements.map(p => p.courseId));
        const hits = [];
        for (const [code, c] of Object.entries(DATA.courses)) {
          if (hits.length >= 8) break;
          if (inPlan.has(code) || c.placeholder) continue;
          if (!c.off.includes(season)) continue;      // not taught this season
          if (code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) {
            hits.push([code, c]);
          }
        }
        box.innerHTML = hits.map(([code, c]) => `
          <button class="csr-item" data-code="${esc(code)}">
            <b>${esc(code)}</b><span>${esc(c.name)}</span><em>${c.credits} cr</em>
          </button>`).join("") ||
          `<div class="csr-empty">No ${Solver.SEASON_NAME[season]} classes match — courses not taught in ${Solver.SEASON_NAME[season]} are hidden.</div>`;
        box.hidden = false;
        box.querySelectorAll(".csr-item").forEach(btn => btn.addEventListener("click", () => {
          const code = btn.dataset.code;
          const plan = activePlan();
          plan.profile.extras = plan.profile.extras || [];
          if (!plan.profile.extras.includes(code)) plan.profile.extras.push(code);
          plan.profile.pins[code] = {
            year: parseInt(inp.dataset.year, 10), season, manual: true,
          };
          plan.updatedAt = Date.now(); save();
          solveActive();
          toast(`${code} added to ${Solver.SEASON_NAME[season]} ${inp.dataset.year} and pinned.`, "ok");
        }));
      });
      inp.addEventListener("blur", () => setTimeout(() => { box.hidden = true; }, 200));
    });

    $$("#board .col-body").forEach(zone => {
      zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("over"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("over"));
      zone.addEventListener("drop", e => {
        e.preventDefault(); zone.classList.remove("over");
        if (dragUid == null) return;
        const t = parseInt(zone.dataset.term, 10);
        const v = Solver.validateMove(result, dragUid, t);
        if (!v.ok) { toast(v.reason); return; }
        Solver.applyMove(result, dragUid, t);
        persistPin(dragUid, t);
        // credit caps warn but never block — moving things around is allowed
        if (v.warn) toast(`⚠️ ${v.warn}`);
        else toast("Moved and pinned — Re-optimize keeps it there.", "ok");
        render();
      });
    });
  }

  function cardHtml(p) {
    const t = classify(p.buckets);
    const warn = p.flags.some(f => f.level === "warn");
    const info = p.flags.some(f => f.level === "info" || f.level === "note");
    // Bucket placeholders render as an open, dashed "choose a class" slot — the
    // schedule shows WHAT is required (Arts GE, a Religion Cornerstone) without
    // locking a specific class until the student picks one.
    if (p.bucket) {
      return `
      <div class="card card-bucket ${t.cls}" draggable="true" data-uid="${esc(p.uid)}" data-ph="1">
        <span class="badge ${t.cls}">${t.label}</span>
        <div class="card-main">
          <span class="card-code">${esc(p.display)}${p.reqLabel ? ` <span class="req-tag" title="Catalog requirement number">${esc(p.reqLabel)}</span>` : ""}</span>
          <span class="card-name"><i class="fas fa-list-ul"></i> choose a class ▾</span>
        </div>
        <div class="card-side"><span class="card-cr">${p.credits.toFixed(1)}</span></div>
      </div>`;
    }
    return `
    <div class="card" draggable="true" data-uid="${esc(p.uid)}">
      <span class="badge ${t.cls}">${t.label}</span>
      <div class="card-main">
        <span class="card-code">${esc(p.display)}${p.uid.includes("#") ? `<span class="card-rep" title="Repeatable course — one enrollment per semester. This is enrollment ${p.uid.split("#")[1]} of the ${p.repTotal || "several"} your requirement needs.">take ${p.uid.split("#")[1]}${p.repTotal ? `/${p.repTotal}` : ""}</span>` : ""}</span>
        <span class="card-name">${esc(p.name)}</span>
      </div>
      <div class="card-side">
        <span class="card-cr">${p.credits.toFixed(1)}</span>
        <span class="card-dots">
          ${p.pinned ? `<i class="fas fa-thumbtack dot-pin" title="Pinned"></i>` : ""}
          ${warn ? `<span class="dot dot-warn" title="Warning — click for details"></span>` : ""}
          ${info && !warn ? `<span class="dot dot-info" title="Info — click for details"></span>` : ""}
        </span>
      </div>
    </div>`;
  }

  /* Placeholder picker: click a bucket slot -> curated dropdown of real classes
     that (a) fill the bucket and (b) are actually taught that term. Choosing one
     records a bucket-fill so the solver swaps the placeholder for that class. */
  function openBucketPicker(p, anchor) {
    closeMenus();
    const cat = result.state.cat;
    const ph = cat[p.courseId] || {};
    const season = result.terms[p.termIndex].season;
    const prof = activePlan().profile;
    const inPlan = new Set(result.placements.filter(x => !x.bucket).map(x => x.courseId));
    // Sort the dropdown by the student's OWN priority dials (instant, local —
    // no network). GPA-protection weight favors easier classes; workload weight
    // favors lighter time-cost; rare/high-demand classes drop down the list.
    const w = prof.weights || { risk: 5, load: 5 };
    const prefScore = code => {
      const c = DATA.courses[code];
      return (w.risk / 5) * (c.diff || 4)
           + (w.load / 5) * ((c.load || 1) * c.credits)
           + (c.demand === "high" ? (w.risk / 5) * 1.5 : 0)
           + (c.rare ? 4 : 0);
    };
    const usable = (ph.suggestions || []).filter(code => DATA.courses[code] && !inPlan.has(code));
    const opts = usable
      .filter(code => DATA.courses[code].off.includes(season))
      .sort((a, b) => prefScore(a) - prefScore(b))
      .slice(0, 40);
    // fallback: nothing taught this term -> offer the other suggestions with
    // their seasons; picking one moves the slot to a term where it IS taught
    const alts = opts.length ? [] : usable.sort((a, b) => prefScore(a) - prefScore(b)).slice(0, 20);
    const fillKey = p.fillKey || p.bucketKey;

    // which numbered catalog requirement this slot fills (Req 4.2 / Opt 8.1)
    const [pid, bid] = (p.bucketKey || "::").split("::");
    const prog = DATA.programIndex[pid];
    const bucket = prog && (prog.buckets || []).find(b => b.id === bid);
    const reqLine = bucket ? `${prog.name.replace(/\s*\(.*\)$/, "")} → ${bucket.name}` : "";
    const group = bucket && bucket.pick.type === "group" && p.groupIdx != null
      ? bucket.groups[p.groupIdx] : null;

    // sibling option-groups the student could switch this slot to
    const sel = (result.groupSel || {})[p.bucketKey] || [];
    const switchable = group ? bucket.groups
      .map((g, gi) => ({ g, gi }))
      .filter(x => x.gi !== p.groupIdx && !sel.includes(x.gi) &&
                   (x.g.options || []).some(o => DATA.courses[o]))
      : [];

    const menu = document.createElement("div");
    menu.className = "ctx-menu bucket-picker";
    menu.innerHTML = `
      <div class="bp-head">${esc(p.display)} · ${esc(result.terms[p.termIndex].label)}
        ${reqLine ? `<span class="bp-req">${esc(reqLine)}${group ? ` · ${esc(group.label)}` : ""}</span>` : ""}
        <span class="bp-sub">${opts.length ? "only classes taught this term" : "no options taught this term — picking one moves the slot"}</span></div>
      <div class="bp-list">
        ${opts.map(code => {
          const c = DATA.courses[code];
          return `<button class="bp-item" data-code="${esc(code)}">
            <b>${esc(code)}</b><span>${esc(c.name)}</span><em>${c.credits} cr</em></button>`;
        }).join("")}
        ${alts.map(code => {
          const c = DATA.courses[code];
          const seasons = [...c.off].map(s => Solver.SEASON_NAME[s]).join("/");
          return `<button class="bp-item bp-alt" data-code="${esc(code)}" data-move="1">
            <b>${esc(code)}</b><span>${esc(c.name)}</span><em>${esc(seasons)}</em></button>`;
        }).join("")}
        ${opts.length || alts.length ? "" : `<div class="bp-empty">Every option is already in your plan — check the progress report, or use the semester search bar.</div>`}
      </div>
      ${switchable.length ? `
      <div class="bp-switch">
        <div class="bp-switch-head">or switch this slot to a different option:</div>
        ${switchable.map(x => `<button class="bp-item bp-group" data-gi="${x.gi}">
          <b>${esc(x.g.label)}</b><span>${(x.g.options || []).filter(o => DATA.courses[o]).slice(0, 4).map(esc).join(", ")}${(x.g.options || []).length > 4 ? "…" : ""}</span></button>`).join("")}
      </div>` : ""}`;
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = (r.bottom + 4) + "px";
    menu.style.left = Math.min(window.innerWidth - 300, r.left) + "px";
    menu.querySelectorAll(".bp-item[data-code]").forEach(btn => btn.addEventListener("click", () => {
      const code = btn.dataset.code;
      const c = DATA.courses[code];
      closeMenus();
      let year = result.terms[p.termIndex].year, ssn = season;
      if (btn.dataset.move) {
        // find the nearest enabled term (to the slot) where this IS taught
        const terms = result.terms, state = result.state;
        const byDist = terms.map(tm => tm).filter(tm => tm.enabled && c.off.includes(tm.season))
          .sort((a, b) => Math.abs(a.index - p.termIndex) - Math.abs(b.index - p.termIndex));
        const target = byDist.find(tm => state.load[tm.index] + c.credits <= tm.cap) || byDist[0];
        if (!target) { toast(`${code} has no available term in your plan window.`); return; }
        year = target.year; ssn = target.season;
      }
      prof.fills = prof.fills || {};
      (prof.fills[fillKey] = prof.fills[fillKey] || []).push(code);
      prof.pins[code] = { year, season: ssn, manual: true };
      activePlan().updatedAt = Date.now(); save();
      solveActive();
      toast(`${code} chosen for ${p.display}${btn.dataset.move ? ` — scheduled ${Solver.SEASON_NAME[ssn]} ${year} (not taught ${Solver.SEASON_NAME[season]})` : ""}.`, "ok");
    }));
    menu.querySelectorAll(".bp-group").forEach(btn => btn.addEventListener("click", () => {
      const gi = parseInt(btn.dataset.gi, 10);
      closeMenus();
      const newSel = sel.length ? sel.map(x => x === p.groupIdx ? gi : x) : [gi];
      prof.groupChoice = prof.groupChoice || {};
      prof.groupChoice[p.bucketKey] = newSel;
      if (prof.fills) delete prof.fills[fillKey];   // old group's picks no longer apply
      activePlan().updatedAt = Date.now(); save();
      solveActive();
      toast(`Switched to ${bucket.groups[gi].label}.`, "ok");
    }));
  }

  function renderProgress() {
    const el = $("#progressBody");
    if (!result) { el.innerHTML = `<p class="pr-empty">Generate a plan to see your progress report.</p>`; $("#flagList").innerHTML = ""; return; }
    const prof = activePlan().profile;
    let compCr = 0;
    (prof.completed || []).forEach(id => { if (DATA.courses[id]) compCr += DATA.courses[id].credits; });
    const plannedCr = planCredits();
    const pct = Math.round(100 * compCr / Math.max(1, compCr + plannedCr));
    el.innerHTML = `
      <div class="pr-summary">
        <div class="pr-pct"><b>${pct}</b> % Complete</div>
        <div class="pr-bar"><span class="pr-bar-done" style="width:${pct}%"></span><span class="pr-bar-plan" style="width:${100 - pct}%"></span></div>
        <div class="pr-legend">
          <span><b>${compCr}</b> Completed</span>
          <span><b>${plannedCr}</b> Planned</span>
          <span><b>${planSemesters()}</b> Semesters</span>
        </div>
      </div>
      ${result.progress.map(progHtml).join("")}`;
    // accordions
    $$("#progressBody .pr-prog-head").forEach(h => h.addEventListener("click", () => h.parentElement.classList.toggle("open")));
    $$("#progressBody .pr-req-head").forEach(h => h.addEventListener("click", e => { e.stopPropagation(); h.parentElement.classList.toggle("open"); }));

    // flags
    $("#flagList").innerHTML = result.flags.map(f => `
      <div class="flag flag-${f.level}">
        <i class="fas fa-${f.icon || "circle-info"}"></i><span>${esc(f.text)}</span>
      </div>`).join("") || `<div class="flag flag-info"><i class="fas fa-check"></i><span>No warnings — clean plan.</span></div>`;
  }

  function progHtml(pr) {
    const prog = DATA.programIndex[pr.id];
    const kind = prog.type === "core" ? "ge" : prog.type === "major" ? "maj" : prog.type === "minor" ? "min" : "crt";
    return `
    <div class="pr-prog ${pr.id === "univ-core" ? "" : "open"}">
      <div class="pr-prog-head">
        <span class="badge ${TYPE_META[kind].cls}">${TYPE_META[kind].label}</span>
        <div class="pr-prog-name">
          <b>${esc(pr.name)}</b>
          <span>${prog.credits} required credit hours${pr.detailed ? "" : " · placeholder data"}</span>
        </div>
        <div class="pr-prog-pct">${Math.round(pr.pctPlan * 100)}%</div>
        <i class="fas fa-chevron-down chev"></i>
      </div>
      <div class="pr-prog-body">
        ${(pr.notes || []).length ? `
        <div class="pr-prog-notes">
          <div class="pr-notes-head"><i class="fas fa-circle-info"></i> Important notes from the catalog</div>
          ${pr.notes.map(n => `<p class="pr-note">${esc(n)}</p>`).join("")}
        </div>` : ""}
        ${pr.buckets.map((b, i) => {
          // color bars by what the bucket really is: inside University Core,
          // religion buckets are red and GE buckets orange; programs use
          // their own type color (major purple, minor magenta, cert teal)
          const bkind = pr.id === "univ-core" ? (String(b.id).startsWith("rel") ? "rel" : "ge") : kind;
          return `
          <div class="pr-req kind-${bkind}">
            <div class="pr-req-head">
              <span class="pr-req-n">${i + 1}</span>
              <div class="pr-req-name"><b>${esc(b.name)}</b><span>${esc(b.need)}</span></div>
              <div class="pr-req-bar">
                <span class="done" style="width:${Math.round(b.pctDone * 100)}%"></span>
                <span class="plan" style="width:${Math.round((b.pctPlan - b.pctDone) * 100)}%"></span>
              </div>
              <i class="fas fa-chevron-down chev"></i>
            </div>
            <div class="pr-req-body">
              ${b.note ? `<p class="pr-note">${esc(b.note)}</p>` : ""}
              ${b.rows.map(r => {
                if (r.status === "slot") {
                  return `<div class="pr-row">
                    <span class="pr-row-status planned">▾</span>
                    <span class="pr-row-code">${esc(r.reqLabel || "Slot")}${r.instances > 1 ? ` ×${r.instances}` : ""}</span>
                    <span class="pr-row-name">${esc(r.label || "Open slot")} — choose a class on the board</span>
                  </div>`;
                }
                const c = DATA.courses[r.id] || { name: "" };
                const disp = c.display || r.id.replace(/\s*\[.*\]$/, "");
                return `<div class="pr-row">
                  <span class="pr-row-status ${r.status}">${r.status === "done" ? "✓" : "•"}</span>
                  <span class="pr-row-code">${esc(disp)}${r.instances > 1 ? ` ×${r.instances}` : ""}</span>
                  <span class="pr-row-name">${esc((DATA.courses[r.id] || {}).name || "")}</span>
                </div>`;
              }).join("") || `<div class="pr-row"><span class="pr-row-name">Filled from tagged catalog options.</span></div>`}
            </div>
          </div>`;
        }).join("")}
      </div>
    </div>`;
  }

  function renderPlans() {
    const el = $("#plansList");
    el.innerHTML = plans.map(p => {
      const active = p.id === activeId;
      const prof = p.profile;
      const major = DATA.programIndex[prof.majorId];
      const minors = (prof.minorIds || []).map(id => DATA.programIndex[id]).filter(Boolean);
      const certs = (prof.certIds || []).map(id => DATA.programIndex[id]).filter(Boolean);
      const meta = active && result ? `${planSemesters()} Semesters · ${planCredits().toFixed(1)} Credits` : "";
      return `
      <div class="plan-card ${active ? "viewing" : ""}" data-plan="${p.id}">
        ${active ? `<div class="viewing-tag">Now viewing</div>` : ""}
        <div class="plan-card-top">
          <b class="plan-card-name">${esc(p.name)}</b>
          <span class="pill amber sm">Draft</span>
          <button class="plan-menu-btn" data-plan="${p.id}" title="Plan actions"><i class="fas fa-bars"></i></button>
        </div>
        ${meta ? `<div class="plan-card-meta">${meta}</div>` : ""}
        ${active && result ? `<div class="plan-card-seasons">${seasonsUsed().map(s => `<span>${SEASON_EMOJI[s]} ${Solver.SEASON_NAME[s]}</span>`).join("")}</div>` : ""}
        <div class="plan-card-progs">
          ${major ? `<div><span class="dotc maj"></span>${esc(major.name)}</div>` : ""}
          ${minors.map(m => `<div><span class="dotc min"></span>${esc(m.name)}</div>`).join("")}
          ${certs.map(c => `<div><span class="dotc crt"></span>${esc(c.name)}</div>`).join("")}
        </div>
        <div class="plan-card-edited">Last edited ${new Date(p.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
      </div>`;
    }).join("") || `<p class="pr-empty">No plans saved yet.</p>`;

    $$(".plan-card").forEach(c => c.addEventListener("click", e => {
      if (e.target.closest(".plan-menu-btn")) return;
      if (c.dataset.plan !== activeId) { activeId = c.dataset.plan; save(); solveActive(); }
    }));
    $$(".plan-menu-btn").forEach(b => b.addEventListener("click", e => {
      e.stopPropagation();
      openPlanMenu(b.dataset.plan, b);
    }));
  }

  function openPlanMenu(planId, anchor) {
    closeMenus();
    const plan = plans.find(p => p.id === planId);
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.innerHTML = `
      <button data-a="load"><i class="fas fa-eye"></i> View</button>
      <button data-a="edit"><i class="fas fa-sliders"></i> Edit programs &amp; courses</button>
      <button data-a="rename"><i class="fas fa-pen"></i> Rename</button>
      <button data-a="dup"><i class="fas fa-copy"></i> Duplicate</button>
      <button data-a="export"><i class="fas fa-download"></i> Export JSON</button>
      <button data-a="del" class="danger"><i class="fas fa-trash"></i> Delete</button>`;
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = (r.bottom + 4) + "px";
    menu.style.left = Math.min(window.innerWidth - 180, r.left - 120) + "px";
    menu.addEventListener("click", e => {
      const a = e.target.closest("button")?.dataset.a;
      closeMenus();
      if (a === "load") { activeId = planId; save(); solveActive(); }
      if (a === "edit") { activeId = planId; save(); openWizard(plan); }
      if (a === "rename") startRename(plan);
      if (a === "dup") { newPlanFromProfile(plan.profile, plan.name + " (copy)"); solveActive(); }
      if (a === "export") exportPlan(plan);
      if (a === "del") {
        if (!confirm(`Delete "${plan.name}"? This can't be undone.`)) return;
        plans = plans.filter(p => p.id !== planId);
        if (activeId === planId) { activeId = plans[0]?.id || null; }
        save(); solveActive();
        toast("Plan deleted.", "ok");
      }
    });
  }
  function closeMenus() { $$(".ctx-menu").forEach(m => m.remove()); }
  function startRename(plan) {
    const name = window.prompt ? prompt("Plan name:", plan.name) : null;
    if (name) { plan.name = name.trim() || plan.name; plan.updatedAt = Date.now(); save(); render(); }
  }
  function exportPlan(plan) {
    const payload = { app: "myplanBYU", exported: new Date().toISOString(), plan };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = plan.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".myplanbyu.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* --------------------------- course modal -------------------------- */
  /* if a class was chosen from a bucket dropdown, find its fill entry so it
     can be put back (returns [fillKey, index] or null) */
  function fillOf(courseId) {
    const prof = activePlan()?.profile;
    for (const [k, arr] of Object.entries(prof?.fills || {})) {
      const i = arr.indexOf(courseId);
      if (i >= 0) return [k, i];
    }
    return null;
  }

  function openCourseModal(uid) {
    const p = result.placements.find(x => x.uid === uid);
    if (!p) return;
    const c = result.state.cat[p.courseId];
    const term = result.terms[p.termIndex];
    const t = classify(p.buckets);
    const buckets = p.buckets.filter(b => !b.startsWith("electives") && !b.startsWith("prereq")).map(key => {
      const [pid, bid] = key.split("::");
      const prog = DATA.programIndex[pid];
      const bucket = prog && prog.buckets.find(b => b.id === bid);
      return prog && bucket ? `${prog.name} → ${bucket.name}` : key;
    });
    const pre = (c.pre || []).map(g => Array.isArray(g) ? g.join(" or ") : g);
    const moveOpts = result.terms
      .filter(tm => tm.enabled && tm.index !== p.termIndex && c.off.includes(tm.season))
      .map(tm => `<option value="${tm.index}">${esc(tm.label)}</option>`).join("");
    $("#modalBody").innerHTML = `
      <div class="cm-head">
        <span class="badge lg ${t.cls}">${t.label}</span>
        <div>
          <h3>${esc(p.display)} <span class="cm-cr">${p.credits.toFixed(1)} cr</span></h3>
          <p class="cm-name">${esc(p.name)}</p>
        </div>
      </div>
      <div class="cm-grid">
        <div class="cm-cell"><label>Scheduled</label><b>${esc(term.label)}${p.pinned ? " 📌" : ""}${p.block ? " · cohort block" : ""}</b></div>
        <div class="cm-cell"><label>Offered</label><b>${[...c.off].map(s => Solver.SEASON_NAME[s]).join(", ")}</b></div>
        <div class="cm-cell"><label>Difficulty</label>
          <span class="diff-meter"><span style="width:${c.diff * 10}%" class="${c.diff >= 7 ? "hot" : ""}"></span></span> <b>${c.diff}/10</b></div>
        <div class="cm-cell"><label>Time cost</label><b>×${(c.load || 1).toFixed(1)} of credit hours</b></div>
      </div>
      ${pre.length ? `<div class="cm-sec"><label>Prerequisites</label>${pre.map(x => `<span class="chip">${esc(x)}</span>`).join("")}</div>` : ""}
      ${buckets.length ? `<div class="cm-sec"><label>Fills requirements</label>${buckets.map(x => `<span class="chip soft">${esc(x)}</span>`).join("")}</div>` : ""}
      ${p.flags.length ? `<div class="cm-sec"><label>Notes & flags</label>${p.flags.map(f => `<div class="flag flag-${f.level}"><i class="fas fa-circle-info"></i><span>${esc(f.text)}</span></div>`).join("")}</div>` : ""}
      ${p.block ? `<p class="cm-blocknote"><i class="fas fa-people-group"></i> Part of a locked cohort block — it moves only when the whole block moves.</p>` : `
      <div class="cm-move">
        <select id="cmMoveSel"><option value="">Move to term…</option>${moveOpts}</select>
        <button class="btn primary sm" id="cmMoveBtn">Move & pin</button>
        ${p.pinned ? `<button class="btn ghost sm" id="cmUnpinBtn">Unpin</button>` : ""}
        ${fillOf(p.courseId) ? `<button class="btn ghost sm" id="cmUnfillBtn" title="Turn this back into an open 'choose a class' slot"><i class="fas fa-rotate-left"></i> Back to dropdown</button>` : ""}
      </div>`}
    `;
    $("#courseModal").classList.add("open");
    const btn = $("#cmMoveBtn");
    if (btn) btn.onclick = () => {
      const v = $("#cmMoveSel").value;
      if (v === "") return;
      const check = Solver.validateMove(result, uid, parseInt(v, 10));
      if (!check.ok) { toast(check.reason); return; }
      Solver.applyMove(result, uid, parseInt(v, 10));
      persistPin(uid, parseInt(v, 10));
      closeModal("#courseModal");
      toast("Moved and pinned.", "ok");
      render();
    };
    const unfill = $("#cmUnfillBtn");
    if (unfill) unfill.onclick = () => {
      const hit = fillOf(p.courseId);
      if (hit) {
        const plan = activePlan();
        plan.profile.fills[hit[0]].splice(hit[1], 1);
        if (!plan.profile.fills[hit[0]].length) delete plan.profile.fills[hit[0]];
        delete plan.profile.pins[p.courseId];
        plan.updatedAt = Date.now(); save();
      }
      closeModal("#courseModal");
      solveActive();
      toast(`${p.display} returned to its dropdown slot.`, "ok");
    };
    const unpin = $("#cmUnpinBtn");
    if (unpin) unpin.onclick = () => {
      result.state.pinnedUids.delete(uid);
      p.pinned = false;
      const plan = activePlan();
      if (plan) { delete plan.profile.pins[uid]; plan.updatedAt = Date.now(); save(); }
      closeModal("#courseModal");
      toast("Unpinned — Re-optimize may move it.", "ok");
      render();
    };
  }
  function closeModal(sel) { $(sel).classList.remove("open"); }

  /* letter grades for the completed-courses checklist (record only) */
  const GRADES = ["—", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "P"];

  /* ------------------------- priorities modal ------------------------ */
  const DIALS = [
    ["speed", "Speed to graduation", "Finish in as few semesters as possible."],
    ["cost", "Financial cost", "Pack the flat-tuition band (12–18 cr), use lease-covered Spring/Summer wisely, avoid extra terms."],
    ["risk", "GPA protection", "Never stack 3+ historically hard classes in one semester."],
    ["life", "Life balance", "Avoid crammed terms and long heavy streaks; keep religion pacing steady."],
  ];
  function openPriorities() {
    const plan = activePlan();
    if (!plan) { toast("Create a plan first."); return; }
    const prof = plan.profile;
    $("#prioBody").innerHTML = `
      <h4>Optimization dials</h4>
      ${DIALS.map(([k, name, desc]) => `
        <div class="dial">
          <div class="dial-top"><b>${name}</b><span class="dial-val" id="dv-${k}">${prof.weights[k]}</span></div>
          <input type="range" min="0" max="10" value="${prof.weights[k]}" data-dial="${k}">
          <p>${desc}</p>
        </div>`).join("")}
      <h4>Hard constraints</h4>
      <div class="prio-grid">
        <label>Max credits (Fall/Winter)
          <input type="number" id="pcMaxFW" min="12" max="21" value="${prof.settings.maxCreditsFW}"></label>
        <label>Full-time minimum
          <input type="number" id="pcMinFW" min="9" max="14" value="${prof.settings.minCreditsFW}"></label>
        <label>Max credits (Spring/Summer)
          <input type="number" id="pcMaxSS" min="3" max="12" value="${prof.settings.maxCreditsSpSu}"></label>
        <label>Double-count cap (credits)
          <input type="number" id="pcDcCap" min="0" max="30" value="${prof.settings.doubleCountCap}"></label>
        <label class="chk"><input type="checkbox" id="pcSpring" ${prof.settings.allowSpring ? "checked" : ""}> Allow Spring terms</label>
        <label class="chk"><input type="checkbox" id="pcSummer" ${prof.settings.allowSummer ? "checked" : ""}> Allow Summer terms</label>
        <label class="chk"><input type="checkbox" id="pcSchol" ${prof.settings.scholarshipFullTime ? "checked" : ""}> Scholarship requires full-time</label>
        <label class="chk"><input type="checkbox" id="pcRel" ${prof.settings.religionPacing ? "checked" : ""}> Pace religion credits yearly</label>
        <label>Housing
          <select id="pcHousing">
            <option value="on-campus" ${prof.settings.housing === "on-campus" ? "selected" : ""}>On campus</option>
            <option value="off-campus" ${prof.settings.housing === "off-campus" ? "selected" : ""}>Off campus (school-year)</option>
            <option value="off-campus-12mo" ${prof.settings.housing === "off-campus-12mo" ? "selected" : ""}>Off campus (12-month lease)</option>
          </select></label>
      </div>`;
    $$("#prioBody input[type=range]").forEach(r => r.addEventListener("input", () => {
      $("#dv-" + r.dataset.dial).textContent = r.value;
    }));
    $("#prioModal").classList.add("open");
    $("#prioApply").onclick = () => {
      $$("#prioBody input[type=range]").forEach(r => prof.weights[r.dataset.dial] = parseInt(r.value, 10));
      Object.assign(prof.settings, {
        maxCreditsFW: parseInt($("#pcMaxFW").value, 10) || 16,
        minCreditsFW: parseInt($("#pcMinFW").value, 10) || 12,
        maxCreditsSpSu: parseInt($("#pcMaxSS").value, 10) || 8,
        doubleCountCap: parseInt($("#pcDcCap").value, 10) || 15,
        allowSpring: $("#pcSpring").checked, allowSummer: $("#pcSummer").checked,
        scholarshipFullTime: $("#pcSchol").checked, religionPacing: $("#pcRel").checked,
        housing: $("#pcHousing").value,
      });
      closeModal("#prioModal");
      solveActive();
      toast("Re-optimized with new priorities.", "ok");
    };
  }

  /* ------------------------------ wizard ----------------------------- */
  let wizEditId = null;   // when set, the wizard edits an existing plan in place

  function openWizard(planToEdit) {
    if (planToEdit) {
      wiz = JSON.parse(JSON.stringify(planToEdit.profile));
      wiz.name = planToEdit.name;
      wizEditId = planToEdit.id;
    } else {
      wiz = JSON.parse(JSON.stringify(DATA.defaultProfile));
      wizEditId = null;
    }
    wiz.grades = wiz.grades || {};
    wizStep = 0;
    renderWizard();
    $("#wizardModal").classList.add("open");
  }

  /* Modal retention: don't let a half-built plan vanish on a stray backdrop
     click / Escape — confirm first when there's unsaved work. */
  function wizHasProgress() {
    return !!(wiz && (wiz.majorId || (wiz.minorIds || []).length ||
      (wiz.certIds || []).length || (wiz.completed || []).length));
  }
  function tryCloseWizard() {
    if (!wizHasProgress() || confirm(wizEditId
        ? "Discard your changes to this plan?"
        : "Discard this new plan? Your selections won't be saved.")) {
      wizEditId = null;
      closeModal("#wizardModal");
    }
  }

  function renderWizard() {
    const steps = ["Programs", "History", "Constraints", "Priorities"];
    $("#wizSteps").innerHTML = steps.map((s, i) =>
      `<span class="wstep ${i === wizStep ? "on" : i < wizStep ? "done" : ""}">${i + 1}. ${s}</span>`).join("");
    const b = $("#wizBody");
    if (wizStep === 0) {
      b.innerHTML = `
        <p class="wiz-intro">Pick your programs — any of ${DATA.majors.length} majors, up to 2 minors, and any certificates.
        Requirements come from the official BYU catalog.</p>
        <label class="wiz-lbl">Major</label>
        <div id="wsMajor"></div>
        <label class="wiz-lbl">Minors <span class="wiz-sub">(up to 2)</span></label>
        <div id="wsMinors"></div>
        <label class="wiz-lbl">Certificates</label>
        <div id="wsCerts"></div>
        <button class="btn ghost demo-btn" id="wizDemo"><i class="fas fa-wand-magic-sparkles"></i> Load Jordan's demo profile (IS/MISM + Ballroom + Spanish + Global Business)</button>`;
      searchSelect("#wsMajor", DATA.majors, wiz.majorId ? [wiz.majorId] : [], 1, ids => wiz.majorId = ids[0] || null);
      searchSelect("#wsMinors", DATA.minors, wiz.minorIds, 2, ids => wiz.minorIds = ids);
      searchSelect("#wsCerts", DATA.certs, wiz.certIds, 8, ids => wiz.certIds = ids);
      $("#wizDemo").onclick = () => { wiz = JSON.parse(JSON.stringify(DATA.demoProfile)); renderWizard(); };
    }
    if (wizStep === 1) {
      const years = [2024, 2025, 2026, 2027, 2028];
      b.innerHTML = `
        <label class="wiz-lbl">First planned semester</label>
        <div class="wiz-row">
          <select id="wsSeason">${["F", "W", "S", "U"].map(s => `<option value="${s}" ${wiz.startTerm.season === s ? "selected" : ""}>${Solver.SEASON_NAME[s]}</option>`).join("")}</select>
          <select id="wsYear">${years.map(y => `<option ${wiz.startTerm.year === y ? "selected" : ""}>${y}</option>`).join("")}</select>
        </div>
        <label class="wiz-lbl">Quick-add common courses <span class="wiz-sub">(tap to toggle)</span></label>
        <div class="chip-row">${DATA.commonCompleted.map(id => `
          <button class="chip toggle ${wiz.completed.includes(id) ? "on" : ""}" data-c="${esc(id)}">${esc(id)}</button>`).join("")}
        </div>
        <label class="wiz-lbl">Search the catalog to add more</label>
        <input type="text" id="wsAddCourse" placeholder="Search ${Object.keys(DATA.courses).length.toLocaleString()} BYU courses — e.g. GSCM 201, Human Development…" autocomplete="off">
        <div class="ss-list" id="wsAddList" hidden></div>
        <label class="wiz-lbl">Completed courses <span class="wiz-sub">(grades are for your record — they don't affect planning)</span></label>
        <div class="done-list" id="wsDoneList">${wiz.completed.length ? wiz.completed.map(id => {
          const c = DATA.courses[id];
          return `<div class="done-row" data-c="${esc(id)}">
            <span class="done-code">${esc(id)}</span>
            <span class="done-name">${esc(c ? c.name : "—")}</span>
            <select class="done-grade" data-c="${esc(id)}">${GRADES.map(g =>
              `<option ${((wiz.grades||{})[id]||"—") === g ? "selected" : ""}>${g}</option>`).join("")}</select>
            <button class="done-x" data-rm="${esc(id)}" title="Remove">×</button>
          </div>`;
        }).join("") : `<p class="done-empty">No completed courses yet — add them above so the planner skips them.</p>`}</div>`;
      wiz.grades = wiz.grades || {};
      $$("#wizBody .chip.toggle").forEach(ch => ch.addEventListener("click", () => {
        const id = ch.dataset.c;
        if (wiz.completed.includes(id)) wiz.completed = wiz.completed.filter(x => x !== id);
        else { wiz.completed.push(id); wiz.grades[id] = wiz.grades[id] || "—"; }
        renderWizard();
      }));
      $$("#wsDoneList .done-x").forEach(x => x.addEventListener("click", () => {
        wiz.completed = wiz.completed.filter(c => c !== x.dataset.rm);
        delete wiz.grades[x.dataset.rm];
        renderWizard();
      }));
      $$("#wsDoneList .done-grade").forEach(sel => sel.addEventListener("change", () => {
        wiz.grades[sel.dataset.c] = sel.value;
      }));
      $("#wsSeason").onchange = e => wiz.startTerm.season = e.target.value;
      $("#wsYear").onchange = e => wiz.startTerm.year = parseInt(e.target.value, 10);
      // searchable picker over the REAL course catalog — only known courses
      // can be selected, so a typo like "SPAN 320" can't silently do nothing
      const addInput = $("#wsAddCourse"), addList = $("#wsAddList");
      addInput.addEventListener("input", () => {
        const q = addInput.value.trim().toLowerCase();
        if (q.length < 2) { addList.hidden = true; return; }
        const hits = [];
        for (const [code, c] of Object.entries(DATA.courses)) {
          if (hits.length >= 10) break;
          if (wiz.completed.includes(code) || c.placeholder) continue;
          if (code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) hits.push([code, c]);
        }
        addList.innerHTML = hits.map(([code, c]) => `
          <button class="ss-item" data-code="${esc(code)}"><b>${esc(code)}</b><span>${esc(c.name)} · ${c.credits} cr</span></button>`).join("")
          || `<div class="ss-empty">No catalog match — only real BYU courses can be marked completed.</div>`;
        addList.hidden = false;
        addList.querySelectorAll(".ss-item").forEach(it => it.addEventListener("click", () => {
          wiz.completed.push(it.dataset.code);
          wiz.grades[it.dataset.code] = "—";
          renderWizard();
        }));
      });
    }
    if (wizStep === 2) {
      b.innerHTML = `
        <div class="prio-grid">
          <label>Max credits (Fall/Winter)<input type="number" id="wcMaxFW" min="12" max="21" value="${wiz.settings.maxCreditsFW}"></label>
          <label>Max credits (Spring/Summer)<input type="number" id="wcMaxSS" min="3" max="12" value="${wiz.settings.maxCreditsSpSu}"></label>
          <label class="chk"><input type="checkbox" id="wcSpring" ${wiz.settings.allowSpring ? "checked" : ""}> I can take Spring terms</label>
          <label class="chk"><input type="checkbox" id="wcSummer" ${wiz.settings.allowSummer ? "checked" : ""}> I can take Summer terms</label>
          <label class="chk"><input type="checkbox" id="wcSchol" ${wiz.settings.scholarshipFullTime ? "checked" : ""}> My scholarship requires full-time (12+ cr)</label>
          <label class="chk"><input type="checkbox" id="wcRel" ${wiz.settings.religionPacing ? "checked" : ""}> Pace religion credits across years</label>
          <label>Housing situation
            <select id="wcHousing">
              <option value="on-campus" ${wiz.settings.housing === "on-campus" ? "selected" : ""}>On campus</option>
              <option value="off-campus" ${wiz.settings.housing === "off-campus" ? "selected" : ""}>Off campus (school-year contract)</option>
              <option value="off-campus-12mo" ${wiz.settings.housing === "off-campus-12mo" ? "selected" : ""}>Off campus (12-month lease)</option>
            </select></label>
        </div>
        <p class="wiz-hint"><i class="fas fa-lightbulb"></i> A 12-month lease makes Spring/Summer classes cheap on the housing side — the cost dial knows this.</p>`;
    }
    if (wizStep === 3) {
      b.innerHTML = DIALS.map(([k, name, desc]) => `
        <div class="dial">
          <div class="dial-top"><b>${name}</b><span class="dial-val" id="wdv-${k}">${wiz.weights[k]}</span></div>
          <input type="range" min="0" max="10" value="${wiz.weights[k]}" data-dial="${k}">
          <p>${desc}</p>
        </div>`).join("");
      $$("#wizBody input[type=range]").forEach(r => r.addEventListener("input", () => {
        wiz.weights[r.dataset.dial] = parseInt(r.value, 10);
        $("#wdv-" + r.dataset.dial).textContent = r.value;
      }));
    }
    $("#wizBack").style.visibility = wizStep === 0 ? "hidden" : "visible";
    $("#wizNext").innerHTML = wizStep === 3 ? `<i class="fas fa-wand-magic-sparkles"></i> Generate plan` : `Next <i class="fas fa-arrow-right"></i>`;
  }

  function wizardCollect() {
    if (wizStep === 2) {
      Object.assign(wiz.settings, {
        maxCreditsFW: parseInt($("#wcMaxFW").value, 10) || 16,
        maxCreditsSpSu: parseInt($("#wcMaxSS").value, 10) || 8,
        allowSpring: $("#wcSpring").checked, allowSummer: $("#wcSummer").checked,
        scholarshipFullTime: $("#wcSchol").checked, religionPacing: $("#wcRel").checked,
        housing: $("#wcHousing").value,
      });
    }
    if (wizStep === 1) {
      wiz.startTerm.season = $("#wsSeason").value;
      wiz.startTerm.year = parseInt($("#wsYear").value, 10);
    }
  }

  /* searchable multi-select */
  function searchSelect(sel, items, initial, max, onChange) {
    const root = $(sel);
    let chosen = [...initial];
    const draw = () => {
      root.innerHTML = `
        <div class="ss-chosen">${chosen.map(id => {
          const p = DATA.programIndex[id];
          return `<span class="chip on">${esc(p ? p.name : id)}<button class="ss-x" data-id="${esc(id)}">×</button></span>`;
        }).join("") || `<span class="ss-none">None selected</span>`}</div>
        <input type="text" class="ss-input" placeholder="Search ${items.length} programs…">
        <div class="ss-list" hidden></div>`;
      const input = root.querySelector(".ss-input");
      const list = root.querySelector(".ss-list");
      input.addEventListener("input", () => {
        const q = input.value.trim().toLowerCase();
        if (!q) { list.hidden = true; return; }
        const hits = items.filter(p => p.name.toLowerCase().includes(q) && !chosen.includes(p.id)).slice(0, 12);
        list.innerHTML = hits.map(p => `
          <button class="ss-item" data-id="${esc(p.id)}">
            <b>${esc(p.name)}</b>
            <span>${esc(p.college || "")}${p.detailed ? "" : " · placeholder"}</span>
          </button>`).join("") || `<div class="ss-empty">No matches</div>`;
        list.hidden = false;
        list.querySelectorAll(".ss-item").forEach(it => it.addEventListener("click", () => {
          if (chosen.length >= max) chosen = max === 1 ? [] : chosen.slice(0, max - 1);
          chosen.push(it.dataset.id);
          onChange(chosen); draw();
        }));
      });
      root.querySelectorAll(".ss-x").forEach(x => x.addEventListener("click", () => {
        chosen = chosen.filter(c => c !== x.dataset.id);
        onChange(chosen); draw();
      }));
    };
    draw();
  }

  /* ------------------------------- init ------------------------------ */
  function init() {
    load();

    $("#newPlanBtn").addEventListener("click", () => openWizard());
    $("#wizBack").addEventListener("click", () => { wizardCollect(); if (wizStep > 0) { wizStep--; renderWizard(); } });
    $("#wizNext").addEventListener("click", () => {
      wizardCollect();
      if (wizStep === 0 && !wiz.majorId) { toast("Pick a major first."); return; }
      if (wizStep < 3) { wizStep++; renderWizard(); return; }
      // finish — update the existing plan in place, or create a new one
      const major = DATA.programIndex[wiz.majorId];
      const title = wiz.name && wiz.name !== "My plan"
        ? wiz.name : (major ? major.name.replace(/\s*\(.*\)$/, "") + " plan" : "My plan");
      if (wizEditId) {
        const plan = plans.find(p => p.id === wizEditId);
        plan.profile = JSON.parse(JSON.stringify(wiz));
        plan.name = title;
        plan.updatedAt = Date.now();
        activeId = plan.id;
        save();
      } else {
        newPlanFromProfile(wiz, title);
      }
      wizEditId = null;
      closeModal("#wizardModal");
      solveActive();
      toast(`Plan ${wizEditId ? "updated" : "generated"} in ${result ? result.solveMs : "?"} ms.`, "ok");
    });
    // Close buttons: the wizard confirms before discarding; other modals close freely.
    $$("[data-close]").forEach(x => x.addEventListener("click", () => {
      if (x.dataset.close === "#wizardModal") tryCloseWizard();
      else closeModal(x.dataset.close);
    }));
    $$(".modal").forEach(m => m.addEventListener("click", e => {
      if (e.target !== m) return;
      if (m.id === "wizardModal") tryCloseWizard();   // guard accidental backdrop click
      else m.classList.remove("open");
    }));
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      if ($("#wizardModal").classList.contains("open")) tryCloseWizard();
    });
    document.addEventListener("click", e => { if (!e.target.closest(".ctx-menu") && !e.target.closest(".plan-menu-btn")) closeMenus(); });

    $("#prioritiesBtn").addEventListener("click", openPriorities);
    $("#navPriorities").addEventListener("click", e => { e.preventDefault(); openPriorities(); });
    $("#navHow").addEventListener("click", e => { e.preventDefault(); $("#howModal").classList.add("open"); });
    $("#refreshBtn").addEventListener("click", () => { solveActive(); toast("Re-optimized.", "ok"); });

    // Plan Options dropdown
    $("#planOptionsBtn").addEventListener("click", e => {
      e.stopPropagation();
      closeMenus();
      const menu = document.createElement("div");
      menu.className = "ctx-menu";
      menu.innerHTML = `
        <button data-a="opt"><i class="fas fa-rotate"></i> Re-optimize</button>
        <button data-a="shuffle"><i class="fas fa-dice"></i> Try an alternative</button>
        <button data-a="prio"><i class="fas fa-sliders"></i> Priorities & constraints…</button>
        <button data-a="pins"><i class="fas fa-thumbtack-slash"></i> Clear manual pins</button>
        <button data-a="print"><i class="fas fa-print"></i> Print / PDF</button>`;
      document.body.appendChild(menu);
      const r = e.currentTarget.getBoundingClientRect();
      menu.style.top = (r.bottom + 6) + "px";
      menu.style.left = Math.min(window.innerWidth - 240, r.left) + "px";
      menu.addEventListener("click", ev => {
        const a = ev.target.closest("button")?.dataset.a;
        closeMenus();
        if (a === "opt") { solveActive(); toast("Re-optimized.", "ok"); }
        if (a === "shuffle") { solveActive({ shuffleSeed: (Math.random() * 1e9) | 0 }); toast("Alternative schedule generated.", "ok"); }
        if (a === "prio") openPriorities();
        if (a === "pins") {
          const plan = activePlan();
          if (plan) {
            for (const k of Object.keys(plan.profile.pins)) {
              if (plan.profile.pins[k].manual) delete plan.profile.pins[k];
            }
            plan.updatedAt = Date.now(); save();
          }
          solveActive(); toast("Manual pins cleared (original pins kept).", "ok");
        }
        if (a === "print") window.print();
      });
    });

    if (!plans.length) {
      render();          // empty state with demo CTA
    } else {
      solveActive();
    }
  }

  /* ---------------------- chat integration ---------------------------- */
  /* Compact text snapshot of the active plan for the AI advisor: programs,
     each term's classes + credits, unscheduled leftovers, active warnings.
     Returns "" when there's no solved plan (the chat still works, just
     without schedule context). */
  function planSummary() {
    const plan = activePlan();
    if (!plan || !result) return "";
    const progNames = (result.programs || []).map(id => DATA.programIndex[id]?.name || id);
    const lines = [`Plan "${plan.name}" -- programs: ${progNames.join("; ")}`];

    // HOW TO READ THIS PLAN — semantics the advisor keeps getting wrong
    // without them (placeholders read as extra hours, envelopes read as
    // student choices, religion pacing read as a mistake).
    lines.push(
      "HOW TO READ THIS PLAN:",
      "- 'choose a class' slots are single placeholder cards (credits shown) ALREADY counted in the term totals — a label like 'Complete 15 hours' names the whole catalog requirement, NOT extra load that term.",
      "- Repeatable courses ('take 2/6') enroll once per semester by rule.",
      "- Religion is deliberately spread ~2 cr per semester (BYU norm) — do not suggest clustering it.",
      "- The planner has already verified every prerequisite chain and season offering against the live BYU catalog; the sequencing shown is valid unless a warning below says otherwise. Do not ask the student to re-verify prerequisites you cannot see.");
    // locked flowchart cohorts (junior-core envelopes)
    const state = result.state;
    const blockLines = [];
    state.blocks.forEach(blk => {
      const t = state.assign.get(blk.uids[0]);
      if (t !== undefined) {
        blockLines.push(`- ${blk.label}: ${blk.uids.map(u => u.split("#")[0]).join(", ")} locked together in ${result.terms[t].label} (department-assigned envelope from the official flowchart — these CANNOT move or spread).`);
      }
    });
    if (blockLines.length) lines.push(...blockLines);

    const byTerm = new Map();
    result.placements.forEach(p => {
      if (!byTerm.has(p.termIndex)) byTerm.set(p.termIndex, []);
      byTerm.get(p.termIndex).push(p);
    });
    [...byTerm.keys()].sort((a, b) => a - b).forEach(t => {
      const items = byTerm.get(t);
      const cr = items.reduce((s, p) => s + p.credits, 0);
      lines.push(`${result.terms[t].label} [${cr} cr]: ` +
        items.map(p => `${p.display} (${p.credits}cr${p.bucket ? " slot" : ""})`).join(", "));
    });

    // program requirements + status, from the same catalog parse the solver uses
    (result.progress || []).forEach(pr => {
      if (pr.id === "univ-core") return;   // GE list is long and well-known
      const reqs = pr.buckets.map(b =>
        `${b.name} [needs ${b.need}${b.pctPlan >= 1 ? "; covered by this plan" : ""}]`);
      lines.push(`Requirements — ${pr.name}: ${reqs.join(" | ")}`);
    });

    if (result.unscheduled?.length) {
      lines.push("Unscheduled: " + result.unscheduled.map(u => u.name).join(", "));
    }
    const warns = (result.flags || []).filter(f => f.level === "warn").slice(0, 4);
    if (warns.length) lines.push("Planner warnings: " + warns.map(f => f.text).join(" | "));

    return lines.join("\n").slice(0, 5800);
  }

  return { init, planSummary };
})();

document.addEventListener("DOMContentLoaded", App.init);
