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
  /* What to call a course on screen. Almost always its code — but a course the
     catalog links without publishing a number has an internal placeholder key
     for an id, and printing that verbatim reads as corrupt data. Use anywhere
     a bare course id would otherwise reach the student (labels, toasts). */
  const codeLabel = id => {
    const c = DATA.courses[id];
    return c && c.unlisted ? (c.display || c.name) : id;
  };

  /* ------------------------------ storage ---------------------------- */
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY));
      if (raw && Array.isArray(raw.plans)) { plans = raw.plans; activeId = raw.activeId; }
    } catch (e) { /* fresh start */ }
  }
  /* Saving must never take the app down with it. Private browsing and a full
     origin quota both make setItem throw, and save() is called mid-interaction
     (after a move, a bucket pick, a new plan) — an uncaught throw there strands
     the student inside the action they just took. The plan still works for the
     session; only persistence is lost, so say that once and carry on. */
  let saveWarned = false;
  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ plans, activeId }));
    } catch (e) {
      if (!saveWarned) {
        saveWarned = true;
        toast("This browser won't let the page save — your plan works now but " +
              "won't be here next visit. Private browsing? Use Plan Options → " +
              "Print / PDF to keep a copy.", "err");
      }
    }
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
  let resultPlanId = null;   // which plan the live `result` belongs to
  function solveActive(opts = {}) {
    const plan = activePlan();
    if (!plan) { result = null; resultPlanId = null; render(); return; }
    // STABILITY: re-solving the SAME plan after a small edit (bucket pick,
    // drop, added class) keeps every other course in its current term unless
    // the edit genuinely demands otherwise. An explicit Re-optimize
    // ({fresh:true}), an alternative shuffle, or switching plans starts clean.
    if (result && resultPlanId === plan.id && !opts.fresh && !opts.shuffleSeed) {
      const prev = {};
      result.placements.forEach(p => { prev[p.uid] = p.termIndex; });
      const prevTermCount = new Set(Object.values(prev)).size;
      const stable = Solver.solve(plan.profile, { ...opts, prevAssign: prev });
      const stableTerms = new Set(stable.placements.map(p => p.termIndex)).size;
      // stability must never COST a semester: if holding courses in place
      // blocked re-compaction, take the freshly packed plan instead
      if (stableTerms > prevTermCount) {
        const fresh = Solver.solve(plan.profile, opts);
        const freshTerms = new Set(fresh.placements.map(p => p.termIndex)).size;
        result = freshTerms < stableTerms ? fresh : stable;
      } else {
        result = stable;
      }
      resultPlanId = plan.id;
      plan.updatedAt = Date.now();
      save();
      checkFlowchartGaps(plan.profile);
      render();
      return;
    }
    result = Solver.solve(plan.profile, opts);
    resultPlanId = plan.id;
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
  let timeline = { byTerm: new Map(), list: [] };   // deadlines & opportunities

  function render() {
    renderStudentBand();
    renderToolbar();
    timeline = result ? buildTimeline() : { byTerm: new Map(), list: [] };
    renderBoard();
    renderProgress();
    renderTimeline(timeline);
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
        <div class="sb-chip"><span class="sb-lbl">Solver</span><span class="pill green">${result ? result.solveMs + " ms" : "—"}</span></div>
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
      </div>`;
      $("#emptyNewPlan").onclick = () => openWizard();
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
        ${(timeline.byTerm.get(tm.index) || []).map((ev, ci) => `
          <div class="col-event ${ev.cls || ""} ${ev.expand ? "ev-expandable" : ""}"
               ${ev.expand ? `data-evt="${tm.index}" data-evi="${ci}"` : ""} title="${esc(ev.detail || "")}">
            <i class="fas ${ev.icon}"></i> ${esc(ev.text)}${ev.expand ? ` <i class="fas fa-chevron-down ev-caret"></i>` : ""}</div>`).join("")}
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

    // expandable event chips (limited-enrollment "what the application needs")
    $$("#board .col-event.ev-expandable").forEach(el => el.addEventListener("click", () => {
      const open = el.nextElementSibling && el.nextElementSibling.classList.contains("col-event-detail");
      $$("#board .col-event-detail").forEach(d => d.remove());
      $$("#board .ev-caret").forEach(c => c.style.transform = "");
      if (open) return;
      const ev = (timeline.byTerm.get(+el.dataset.evt) || [])[+el.dataset.evi];
      if (!ev || !ev.expand) return;
      const ex = ev.expand;
      const d = document.createElement("div");
      d.className = "col-event-detail";
      d.innerHTML = `
        <p>${esc(ex.note)}</p>
        ${(ex.prereqs && ex.prereqs.length) ? `<b>Prerequisite courses</b>
          <ul class="ev-prereqs">${ex.prereqs.map(pr => `<li class="${pr.done ? "ev-done" : ""}">${pr.done ? '<i class="fas fa-check"></i>' : '<i class="far fa-circle"></i>'} ${esc(pr.text)}</li>`).join("")}</ul>` : ""}
        ${(ex.criteria && ex.criteria.length) ? `<b>Also required</b>
          <ul>${ex.criteria.map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
        ${ex.pointer ? `<p class="ev-pointer">${esc(ex.pointer)}</p>` : ""}
        ${ex.url ? `<a href="${esc(ex.url)}" target="_blank" rel="noopener">Full admission requirements <i class="fas fa-arrow-up-right-from-square"></i></a>` : ""}`;
      el.after(d);
      const caret = el.querySelector(".ev-caret");
      if (caret) caret.style.transform = "rotate(180deg)";
    }));

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
        if (p && (p.bucket || (p.isFill && e.target.closest(".fill-change")))) {
          e.stopPropagation(); openBucketPicker(p, card);
        } else openCourseModal(card.dataset.uid);
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
            <b>${esc(codeLabel(code))}</b><span>${c.unlisted ? "no course number yet" : esc(c.name)}</span><em>${c.credits} cr</em>
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
          toast(`${codeLabel(code)} added to ${Solver.SEASON_NAME[season]} ${inp.dataset.year} and pinned.`, "ok");
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
      // sheet-labeled slots read exactly like the printed MAP line
      return `
      <div class="card card-bucket ${t.cls}" draggable="true" data-uid="${esc(p.uid)}" data-ph="1">
        <span class="badge ${t.cls}">${t.label}</span>
        <div class="card-main">
          <span class="card-code">${esc(p.display)}${p.reqLabel ? ` <span class="req-tag" title="Catalog requirement number">${esc(p.reqLabel)}</span>` : ""}</span>
          <span class="card-name"><i class="fas fa-list-ul"></i> ${p.sheetName ? `${esc(p.sheetName)} — choose ▾` : "choose a class ▾"}</span>
        </div>
        <div class="card-side"><span class="card-cr">${p.credits.toFixed(1)}</span></div>
      </div>`;
    }
    // A course the catalog links but doesn't list has no code to show, so its
    // name takes the code line and a tag stands in for the missing code —
    // rather than printing the internal placeholder key as if it were one.
    const unlisted = !!(DATA.courses[p.courseId] || {}).unlisted;
    return `
    <div class="card ${p.isFill ? "card-fillpick" : ""}" draggable="true" data-uid="${esc(p.uid)}">
      <span class="badge ${t.cls}">${t.label}</span>
      <div class="card-main">
        <span class="card-code">${esc(p.display)}${p.uid.includes("#") ? `<span class="card-rep" title="Repeatable course — one enrollment per semester. This is enrollment ${p.uid.split("#")[1]} of the ${p.repTotal || "several"} your requirement needs.">take ${p.uid.split("#")[1]}${p.repTotal ? `/${p.repTotal}` : ""}</span>` : ""}</span>
        <span class="card-name">${unlisted
          ? `<span class="unlisted-tag" title="Your program lists this course, but it has no course number in the catalog yet. Ask your advisor for the current number before you register.">no course number yet</span>`
          : esc(p.sheetName || p.name)}${p.isFill ? ` <span class="fill-change" title="You picked this from a requirement dropdown — swap it any time"><i class="fas fa-list-ul"></i> change ▾</span>` : ""}</span>
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
    const isSwap = !!p.isFill;          // a chosen class being swapped out
    const fillKey = p.fillKey || p.bucketKey;

    // which numbered catalog requirement this slot fills (Req 4.2 / Opt 8.1)
    const [pid, bid] = (p.bucketKey || "::").split("::");
    const prog = DATA.programIndex[pid];
    const bucket = prog && (prog.buckets || []).find(b => b.id === bid);
    const reqLine = bucket ? `${prog.name.replace(/\s*\(.*\)$/, "")} → ${bucket.name}` : "";
    const group = bucket && bucket.pick.type === "group" && p.groupIdx != null
      ? bucket.groups[p.groupIdx] : null;

    // option pool: the placeholder's curated suggestions, else rebuilt from
    // the bucket definition (needed when a chosen class is being swapped)
    let basePool = ph.suggestions;
    if (!basePool || !basePool.length) {
      basePool = group ? [...(group.options || [])] : bucket ? [...(bucket.options || [])] : [];
      if (bucket && bucket.tag) {
        for (const [code, c] of Object.entries(DATA.courses)) {
          if (c.tags && c.tags.includes(bucket.tag)) basePool.push(code);
        }
      }
    }
    // per-option prerequisite check relative to this slot's term
    const compl = new Set(prof.completed || []);
    const unmetPre = code => {
      const c = DATA.courses[code];
      for (const g of (c.pre || [])) {
        const alts2 = Array.isArray(g) ? g : [g];
        const ok = alts2.some(x => compl.has(x) ||
          result.placements.some(pl => pl.courseId === x && pl.termIndex < p.termIndex));
        if (!ok) return alts2.map(x => (DATA.courses[x] || {}).display || x).join(" or ");
      }
      return null;
    };
    const preOf = {};
    // The FULL catalog pool for this requirement — every real option, so the
    // student sees the complete roster (BYU's "CE Breadth: choose 7" should show
    // all 7, not just the two that happen to be un-scheduled). We split it into:
    //   opts     — taught this term & not already in the plan (pick to fill here)
    //   alts     — a real option, but taught another term (pick MOVES the slot)
    //   inPlan   — already in the plan (informational; picking again would double it)
    const allPool = [...new Set(basePool)].filter(code => DATA.courses[code]);
    allPool.forEach(code => { preOf[code] = unmetPre(code); });
    const rank = code => prefScore(code) + (preOf[code] ? 50 : 0);   // unmet-prereq options sink
    const free = allPool.filter(code => !inPlan.has(code));
    // Options whose OWN prerequisites aren't planned/completed can't be taken
    // for this slot as-is (SPAN 355 needs SPAN 202; a 400-level IS elective
    // needs IS 303). They stay available but are TUCKED behind a toggle so a
    // requirement like Languages of Learning doesn't read as "53 missing
    // prerequisites" — the student sees the handful they can actually take.
    const allOpts = free
      .filter(code => DATA.courses[code].off.includes(season))
      .sort((a, b) => rank(a) - rank(b)).slice(0, 45);
    const opts = allOpts.filter(code => !preOf[code]).slice(0, 40);
    const optsNeedPre = allOpts.filter(code => preOf[code]).slice(0, 30);
    // other-term options are now ALWAYS shown (not just when nothing fits this
    // term) — picking one moves the slot to a term where it IS taught.
    const optSet = new Set([...opts, ...optsNeedPre]);
    const altsAll = free.filter(code => !optSet.has(code))
      .sort((a, b) => rank(a) - rank(b)).slice(0, 30);
    const alts = altsAll.filter(code => !preOf[code]).slice(0, 20);
    const altsNeedPre = altsAll.filter(code => preOf[code]).slice(0, 20);
    const needPre = [...optsNeedPre, ...altsNeedPre];
    // pool courses already scheduled (often pulled in as a prerequisite of some
    // other class) — surfaced so the requirement's full option list is visible.
    const inPlanPool = allPool.filter(code => inPlan.has(code))
      .sort((a, b) => rank(a) - rank(b)).slice(0, 20);

    // sibling option-groups the student could switch this slot to
    const sel = (result.groupSel || {})[p.bucketKey] || [];
    const switchable = group ? bucket.groups
      .map((g, gi) => ({ g, gi }))
      .filter(x => x.gi !== p.groupIdx && !sel.includes(x.gi) &&
                   (x.g.options || []).some(o => DATA.courses[o]))
      : [];

    const itemHtml = (code, move) => {
      const c = DATA.courses[code];
      const em = move ? [...c.off].map(s => Solver.SEASON_NAME[s]).join("/") : `${c.credits} cr`;
      // No catalog number for this one: lead with the name and say so, instead
      // of showing the internal placeholder key in the course-code column.
      const lead = c.unlisted ? esc(c.display || c.name) : esc(code);
      const detail = c.unlisted
        ? `<i class="bp-preq" title="Your program lists this course, but the catalog has no course number for it yet.">no course number yet</i>`
        : esc(c.name);
      return `<button class="bp-item ${move ? "bp-alt" : ""}" data-code="${esc(code)}" ${move ? 'data-move="1"' : ""}>
        <b>${lead}</b><span>${detail}${preOf[code] ? `<i class="bp-preq" title="Prerequisite not completed or scheduled before this term">needs ${esc(preOf[code])} first</i>` : ""}</span><em>${esc(em)}</em></button>`;
    };
    const menu = document.createElement("div");
    menu.className = "ctx-menu bucket-picker";
    menu.innerHTML = `
      <div class="bp-head">${isSwap ? `${esc(p.display)} → change class` : esc(p.display)} · ${esc(result.terms[p.termIndex].label)}
        ${reqLine ? `<span class="bp-req">${esc(reqLine)}${group ? ` · ${esc(group.label)}` : ""}</span>` : ""}
        <span class="bp-sub">${allPool.length} option${allPool.length === 1 ? "" : "s"} for this requirement${opts.length ? "" : " — none taught this term, so picking one moves the slot"}</span></div>
      <div class="bp-list">
        ${opts.map(code => itemHtml(code, false)).join("")}
        ${alts.length ? `<div class="bp-grouphdr">taught another term — picking moves this slot</div>` : ""}
        ${alts.map(code => itemHtml(code, true)).join("")}
        ${needPre.length ? `<details class="bp-needpre"><summary>${needPre.length} more need a prerequisite you haven't planned yet</summary>
          ${optsNeedPre.map(code => itemHtml(code, false)).join("")}
          ${altsNeedPre.map(code => itemHtml(code, true)).join("")}</details>` : ""}
        ${inPlanPool.length ? `<div class="bp-grouphdr">already in your plan</div>
          ${inPlanPool.map(code => { const c = DATA.courses[code];
            return `<div class="bp-item bp-inplan" title="Already scheduled elsewhere in your plan — often a prerequisite of another class"><b>${esc(codeLabel(code))}</b><span>${c.unlisted ? "no course number yet" : esc(c.name)}</span><em><i class="fas fa-check"></i> in plan</em></div>`; }).join("")}` : ""}
        ${opts.length || alts.length || inPlanPool.length ? "" : `<div class="bp-empty">No catalog options resolve for this requirement — check the progress report, or use the semester search bar.</div>`}
        ${isSwap ? `<button class="bp-item bp-unfill"><b><i class="fas fa-rotate-left"></i></b><span>Back to an open "choose a class" slot</span></button>` : ""}
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
        // find the nearest enabled term (to the slot) where this IS taught —
        // INSIDE the plan's current span first (a moved pick must not mint a
        // 9th semester when an existing term has room at the 14-16 band)
        const terms = result.terms, state = result.state;
        const lastActive = Math.max(...result.placements.map(x => x.termIndex));
        // a sheet term's REAL ceiling: its printed total (stretchable to 16 on
        // F/W) — ignoring it pins the course somewhere the solver must then
        // evict from, cascading into a brand-new semester
        const ceilOf = tm => state.mapCap && state.mapCap.has(tm.index)
          ? (tm.isFW ? Math.max(state.mapCap.get(tm.index), 16) : state.mapCap.get(tm.index))
          : Math.min(16, tm.cap);
        const byDist = terms.map(tm => tm).filter(tm => tm.enabled && c.off.includes(tm.season))
          .sort((a, b) => Math.abs(a.index - p.termIndex) - Math.abs(b.index - p.termIndex));
        const target =
          byDist.find(tm => tm.index <= lastActive && state.load[tm.index] + c.credits <= ceilOf(tm)) ||
          byDist.find(tm => tm.index <= lastActive && state.load[tm.index] + c.credits <= tm.cap) ||
          byDist.find(tm => state.load[tm.index] + c.credits <= tm.cap) || byDist[0];
        if (!target) { toast(`${codeLabel(code)} has no available term in your plan window.`); return; }
        year = target.year; ssn = target.season;
        if (target.index > lastActive) toast(`Heads up: ${codeLabel(code)} only fits in a NEW semester (${Solver.SEASON_NAME[ssn]} ${year}) — every existing term is full.`, "err");
      }
      prof.fills = prof.fills || {};
      const arr = (prof.fills[fillKey] = prof.fills[fillKey] || []);
      if (isSwap) {
        // replace the previously chosen class in place
        const idx = arr.indexOf(p.courseId);
        if (idx >= 0) arr[idx] = code; else arr.push(code);
        delete prof.pins[p.courseId];
      } else {
        arr.push(code);
      }
      prof.pins[code] = { year, season: ssn, manual: true };
      activePlan().updatedAt = Date.now(); save();
      solveActive();
      toast(`${codeLabel(code)} ${isSwap ? `swapped in for ${p.display}` : `chosen for ${p.display} — stays in ${Solver.SEASON_NAME[ssn]} ${year}`}${btn.dataset.move ? ` (moved: not taught ${Solver.SEASON_NAME[season]})` : ""}.`, "ok");
    }));
    const unfillBtn = menu.querySelector(".bp-unfill");
    if (unfillBtn) unfillBtn.addEventListener("click", () => {
      closeMenus();
      const arr = (prof.fills || {})[fillKey] || [];
      const idx = arr.indexOf(p.courseId);
      if (idx >= 0) arr.splice(idx, 1);
      if (!arr.length && prof.fills) delete prof.fills[fillKey];
      delete prof.pins[p.courseId];
      activePlan().updatedAt = Date.now(); save();
      solveActive();
      toast(`${p.display} returned to an open slot.`, "ok");
    });
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

  /* ------------- timeline: deadlines & opportunities layer ------------- */
  /* Baked by scraper/generate_timeline.py into js/timeline_data.js:
     academic dates, limited-enrollment admission notes, program->college,
     college-tagged study abroad, curated scholarship deadlines. Everything
     here is defensive — the app still works if TIMELINE is absent. */
  const MONTH_NAME = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthSeason = m => (m >= 9 ? "F" : m >= 7 ? "U" : m >= 5 ? "S" : "W");

  function studentColleges() {
    if (typeof TIMELINE === "undefined" || !result) return [];
    const cols = [];
    (result.programs || []).forEach(id => {
      const c = (TIMELINE.programColleges || {})[id];
      if (c && !cols.includes(c)) cols.push(c);
    });
    return cols;
  }

  // client-side academic-year index matching the solver's (incl. mid-degree
  // standing offset carried on result.terms.yearOffset)
  function acadYearOf(tm) {
    const t0 = result.terms[0];
    const ay = x => (x.season === "F" ? x.year : x.year - 1);
    return ay(tm) - ay(t0) + (result.terms.yearOffset || 0);
  }

  function buildTimeline() {
    const empty = { byTerm: new Map(), deadlines: [], recs: [], schols: [], abroad: [], clubs: [] };
    if (typeof TIMELINE === "undefined" || !result) return empty;
    const { byTerm, deadlines, recs, schols, abroad, clubs } = empty;
    const chip = (t, c) => { if (t == null) return; if (!byTerm.has(t)) byTerm.set(t, []); byTerm.get(t).push(c); };
    const activeT = [...new Set(result.placements.map(p => p.termIndex))].sort((a, b) => a - b);
    if (!activeT.length) return empty;
    const lastT = activeT[activeT.length - 1];
    const cols = studentColleges();
    const state = result.state;

    // 1) limited-enrollment admission — the make-or-break deadline (chips stay
    //    on the board; scholarships/abroad live in the panel sections only)
    // which of a curated prereq line's course codes the student has done or has
    // planned before applying — drives the ✓ next to each requirement
    const doneOrPlannedBefore = (codes, applyIdx) => codes.some(code =>
      result.state.completed.has(code) ||
      result.placements.some(p => p.courseId === code && (applyIdx == null || p.termIndex < applyIdx)));
    const codesIn = s => (s.match(/\b[A-Z][A-Z&]{0,3}(?:\s[A-Z&]{1,4})?\s\d{3}[A-Z]?\b/g) || []);

    (result.programs || []).forEach(pid => {
      const prog = DATA.programIndex[pid];
      if (!prog || pid === "univ-core") return;
      const g = state.admitGate && state.admitGate[pid] != null ? state.admitGate[pid] : null;
      const note = (TIMELINE.admitNotes || {})[pid];
      const req = (TIMELINE.admissionReqs || {})[pid];   // CURATED, from the dept's page
      if (g == null && !note && !req) return;
      const short = prog.name.replace(/\s*\(.*\)$/, "");

      // apply term: the year before the professional phase for gated majors;
      // for curated-but-ungated ones (IS, Accounting) the term before the
      // first ≥300-level major course (the junior core the application gates)
      let applyTm = g != null
        ? result.terms.find(tm => tm.enabled && tm.isFW && tm.season === "W" &&
            tm.index <= lastT && acadYearOf(tm) === g - 1)
        : null;
      if (!applyTm && req) {
        const firstPro = result.placements
          .filter(p => !p.placeholder && (p.buckets || []).some(b => b.split("::")[0] === pid) &&
            /\b[34]\d\d\b/.test(p.courseId))
          .sort((a, b) => a.termIndex - b.termIndex)[0];
        if (firstPro) applyTm = [...result.terms].filter(tm => tm.enabled && tm.isFW &&
          tm.index < firstPro.termIndex && activeT.includes(tm.index)).pop();
      }
      applyTm = applyTm || result.terms.find(tm => tm.index === activeT[Math.min(2, activeT.length - 1)]);

      // curated dropdown (prereqs with ✓ + criteria + source), else the
      // catalog note + a "confirm with the department" pointer — NOT a guess
      const expand = req ? {
        note: req.note, url: req.url,
        prereqs: (req.prereqs || []).map(line => ({ text: line, done: doneOrPlannedBefore(codesIn(line), applyTm && applyTm.index) })),
        criteria: req.criteria || [],
      } : {
        note: note || "This is a limited-enrollment (application) major.",
        pointer: "Confirm the exact prerequisite courses, GPA, and deadline on the department's admission page or with your college advisement center.",
      };
      chip(applyTm && applyTm.index, { icon: "fa-lock", cls: "ev-admit",
        text: `Apply to ${short}`, expand, detail: "Click to see what the application needs." });
      deadlines.push({ when: applyTm ? applyTm.label : `Year ${g || 2}`, icon: "fa-lock",
        title: `${short} application`, detail: (req && req.note) || note || "Limited-enrollment — apply before the professional phase.", cls: "ev-admit" });
    });

    // 2) academic dates for terms with real calendar data (chips + deadline rows)
    (TIMELINE.academicDates || []).forEach(d => {
      const tm = result.terms.find(x => x.season === d.s && x.year === d.y && activeT.includes(x.index));
      if (!tm) return;
      chip(tm.index, { icon: "fa-calendar-check", cls: "ev-dates",
        text: `Add/drop ${d.addDrop || "?"}`,
        detail: `${tm.label}: runs ${d.start} – ${d.end}. Add/drop deadline ${d.addDrop}; withdraw deadline ${d.withdraw}.` });
      deadlines.push({ when: tm.label, icon: "fa-calendar-check", cls: "ev-dates",
        title: `Add/drop ${d.addDrop} · withdraw ${d.withdraw}`, detail: `Term runs ${d.start} – ${d.end}.` });
    });

    // 3) RELEVANT SCHOLARSHIPS — Scholarship-Matcher-style relevance: your
    //    college's own awards first, then university-wide BYU, then national.
    (TIMELINE.scholarships || []).filter(s =>
      (s.colleges.includes("any") || s.colleges.some(c => cols.includes(c))) &&
      // audience-specific awards (incoming freshmen, transfers) don't apply
      // to a continuing student planning at BYU
      !(s.levels.length && s.levels.every(l => l === "incoming-freshman" || l === "transfer")))
      .forEach(s => schols.push({
        name: s.name, url: s.url, award: s.award, note: s.deadlineNote,
        gpa: s.minGPA, group: s.group, scope: s.scope,
        collegeMatch: s.colleges.some(c => cols.includes(c)),
        when: s.deadline ? `${MONTH_NAME[s.deadline.month]} ${s.deadline.day}` : "varies",
        sortKey: s.deadline ? s.deadline.month * 40 + s.deadline.day : 999,
      }));
    schols.sort((a, b) => (b.collegeMatch - a.collegeMatch) ||
      ((a.scope !== "byu") - (b.scope !== "byu")) || (a.sortKey - b.sortKey));

    // 4) RELEVANT STUDY ABROAD — matched to the student's college(s)
    (TIMELINE.studyAbroad || []).filter(p => p.colleges.some(c => cols.includes(c)))
      .forEach(p => abroad.push({ name: p.name, url: p.url, term: p.term,
        colleges: p.colleges.filter(c => cols.includes(c)) }));

    // 4b) RELEVANT CLUBS — tester request: surface them beside scholarships
    //     and study abroad. Same college matching as study abroad; capped so
    //     the panel stays a panel (clubs.byu.edu has the full directory).
    (TIMELINE.clubs || []).filter(c => c.colleges && c.colleges.some(c2 => cols.includes(c2)))
      .slice(0, 14)
      .forEach(c => clubs.push({ name: c.name, url: c.url }));

    // 5) RECOMMENDATIONS — rule-based, from THIS plan's actual shape. Each can
    //    carry an `act` the student applies with ONE CLICK — the solver never
    //    silently changes a constraint (e.g. adding Spring) on its own.
    const prof = activePlan() ? activePlan().profile : null;
    const st = prof ? prof.settings : {};
    const load = t => result.placements.filter(p => p.termIndex === t).reduce((s, p) => s + p.credits, 0);
    const fwActive = result.terms.filter(tm => tm.isFW && activeT.includes(tm.index));
    const heavy = fwActive.filter(tm => load(tm.index) >= 17);
    // 5a) Spring/Summer-ONLY courses whose offered seasons are all disabled
    const spsuOnly = [...result.placements, ...(result.unscheduled || []).map(u => ({ display: u.name, courseId: u.uid }))]
      .filter(p => {
        const c = DATA.courses[p.courseId];
        if (!c) return false;
        const off = String(c.off);
        if (/[FW]/.test(off)) return false;
        return !((st.allowSpring && off.includes("S")) || (st.allowSummer && off.includes("U")));
      });
    if (spsuOnly.length) {
      const wantsS = spsuOnly.some(p => String(DATA.courses[p.courseId].off).includes("S"));
      const wantsU = spsuOnly.some(p => { const o = String(DATA.courses[p.courseId].off); return o.includes("U") && !o.includes("S"); });
      recs.push({ icon: "fa-sun",
        title: `${spsuOnly.slice(0, 3).map(p => p.display).join(", ")} ${spsuOnly.length > 1 ? "are" : "is"} only taught ${wantsS && wantsU ? "Spring/Summer" : wantsS ? "Spring" : "Summer"} — your plan can't schedule ${spsuOnly.length > 1 ? "them" : "it"} without that term.`,
        detail: "One click re-plans with the term added. Your other constraints stay as they are.",
        act: { kind: "seasons", spring: wantsS, summer: wantsU,
          label: `Add ${wantsS && wantsU ? "Spring & Summer terms" : wantsS ? "a Spring term" : "a Summer term"}` } });
    }
    // 5a2) the official sheet paces work into Spring, but the courses fit F/W
    if (!spsuOnly.length && result.state && result.state.mapWantsSpring) {
      recs.push({ icon: "fa-sun",
        title: "Your major's official MAP sheet uses a Spring term — this plan re-sequenced that work into Fall/Winter.",
        detail: "Adding Spring restores the sheet's intended pacing and lightens Fall/Winter loads.",
        act: { kind: "seasons", spring: true, summer: false, label: "Add a Spring term" } });
    }
    // 5b) Spring as a pressure valve for a long or heavy plan
    if (!st.allowSpring && !st.allowSummer && !spsuOnly.length && (heavy.length >= 2 || fwActive.length >= 9)) {
      const springable = result.placements.filter(p => { const c = DATA.courses[p.courseId]; return c && String(c.off).includes("S"); }).length;
      const firstSpring = result.terms.find(tm => tm.season === "S" && tm.index > activeT[0]);
      if (springable >= 3) recs.push({ icon: "fa-sun",
        title: `A Spring term${firstSpring ? ` (${firstSpring.label})` : ""} could help — ${springable} of your planned classes are also taught Spring.`,
        detail: `${heavy.length ? `${heavy.length} semester${heavy.length > 1 ? "s" : ""} run${heavy.length > 1 ? "" : "s"} 17 credits; ` : ""}${fwActive.length >= 9 ? `the plan spans ${fwActive.length} Fall/Winter semesters; ` : ""}a 6-9 credit Spring lightens the load or shortens the plan.`,
        act: { kind: "seasons", spring: true, summer: false, label: "Add a Spring term" } });
    }
    // 5c) open-elective headroom = a free minor/certificate
    const elecCr = result.placements.filter(p => p.elective || /^ELECTIVE\+/.test(p.uid))
      .reduce((s, p) => s + p.credits, 0);
    if (elecCr >= 6 && (prof && !(prof.minorIds || []).length)) {
      recs.push({ icon: "fa-graduation-cap",
        title: `~${Math.round(elecCr)} credits of open electives — that's room for a minor or certificate with no extra semesters.`,
        detail: "Compare one side-by-side before committing; your current plan stays untouched.",
        act: { kind: "whatif_minor", label: "Compare adding a minor…" } });
    }
    // 5d) heavy terms that a drag could ease (only when Spring isn't the answer)
    if (heavy.length && (st.allowSpring || st.allowSummer)) {
      recs.push({ icon: "fa-scale-unbalanced",
        title: `${heavy.map(tm => tm.label).join(" and ")} run${heavy.length > 1 ? "" : "s"} 17 credits.`,
        detail: "A Spring/Summer class or dragging one elective to a lighter semester would ease the crunch." });
    }
    // 5e) scholarship full-time flag unchecked but plan floors at 12
    if (prof && !st.scholarshipFullTime && schols.some(s => s.scope === "byu")) {
      recs.push({ icon: "fa-circle-check",
        title: "BYU scholarships require full-time (12+ cr) — this plan keeps every Fall/Winter at 12+, so you're covered.",
        detail: "Make it a hard guarantee on every future re-plan:",
        act: { kind: "fulltime", label: "Guarantee full-time status" } });
    }

    return { byTerm, deadlines, recs, schols, abroad, clubs };
  }

  /* Apply a one-click Recommended action. The student initiated it — settings
     changes re-solve immediately; bigger changes route through what-if. */
  function applyRec(act) {
    const plan = activePlan();
    if (!plan || !act) return;
    if (act.kind === "seasons") {
      if (act.spring) plan.profile.settings.allowSpring = true;
      if (act.summer) plan.profile.settings.allowSummer = true;
      plan.updatedAt = Date.now(); save();
      solveActive();
      toast(`${act.spring && act.summer ? "Spring & Summer" : act.spring ? "Spring" : "Summer"} terms enabled — plan rebuilt.`, "ok");
    } else if (act.kind === "whatif_minor") {
      openWhatIf({ type: "add_minor" });
    } else if (act.kind === "fulltime") {
      plan.profile.settings.scholarshipFullTime = true;
      plan.updatedAt = Date.now(); save();
      solveActive();
      toast("Full-time (12+ cr) is now a hard guarantee.", "ok");
    }
  }

  function renderTimeline(tl) {
    const sec = $("#timelineSec"), el = $("#timelineList");
    if (!sec || !el) return;
    const any = tl.deadlines.length || tl.recs.length || tl.schols.length || tl.abroad.length;
    if (!any) { sec.hidden = true; return; }
    sec.hidden = false;
    const item = e => `
      <div class="tl-item ${e.cls || ""}">
        <span class="tl-when">${esc(e.when)}</span>
        <div class="tl-body">
          <b>${esc(e.title)}</b>
          ${e.detail ? `<p>${esc(e.detail)}</p>` : ""}
          ${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">Details <i class="fas fa-arrow-up-right-from-square"></i></a>` : ""}
        </div>
      </div>`;
    el.innerHTML = `
      ${tl.deadlines.map(item).join("")}
      ${tl.recs.length ? `<div class="tl-recs">
        <h4><i class="fas fa-lightbulb"></i> Recommended</h4>
        ${tl.recs.map((r, i) => `<div class="tl-rec"><i class="fas ${r.icon}"></i><div>
          <b>${esc(r.title)}</b>${r.detail ? `<p>${esc(r.detail)}</p>` : ""}
          ${r.act ? `<button class="btn primary sm tl-rec-btn" data-rec="${i}"><i class="fas fa-wand-magic-sparkles"></i> ${esc(r.act.label)}</button>` : ""}
        </div></div>`).join("")}
      </div>` : ""}
      ${tl.schols.length ? `<details class="tl-acc">
        <summary><i class="fas fa-sack-dollar"></i> Relevant scholarships <span class="tl-count">${tl.schols.length}</span></summary>
        ${tl.schols.map(s => `
          <div class="tl-item ev-money">
            <span class="tl-when">${esc(s.when)}</span>
            <div class="tl-body">
              <b>${esc(s.name)}</b>${s.collegeMatch ? ` <span class="tl-badge">your college</span>` : s.scope !== "byu" ? ` <span class="tl-badge nat">national</span>` : ""}
              <p>${esc([s.award, s.gpa ? `${s.gpa}+ GPA` : "", s.note].filter(Boolean).join(" · "))}</p>
              ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">Details <i class="fas fa-arrow-up-right-from-square"></i></a>` : ""}
            </div>
          </div>`).join("")}
      </details>` : ""}
      ${tl.abroad.length ? `<details class="tl-acc">
        <summary><i class="fas fa-plane"></i> Study abroad for your college <span class="tl-count">${tl.abroad.length}</span></summary>
        <p class="tl-acc-hint">Matched to your college by the courses each program grants credit for. Most run Spring/Summer — they fit between your semesters.</p>
        ${tl.abroad.map(p => `
          <div class="tl-item ev-abroad">
            <span class="tl-when">${esc((p.term || "varies").split("|")[0].trim().slice(0, 22))}</span>
            <div class="tl-body">
              <b>${esc(p.name)}</b>
              ${p.term ? `<p>${esc(p.term)}</p>` : ""}
              ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">Details <i class="fas fa-arrow-up-right-from-square"></i></a>` : ""}
            </div>
          </div>`).join("")}
      </details>` : ""}
      ${tl.clubs.length ? `<details class="tl-acc">
        <summary><i class="fas fa-people-group"></i> Clubs for your college <span class="tl-count">${tl.clubs.length}</span></summary>
        <p class="tl-acc-hint">Matched to your programs' college. Free to join, great for networking — full directory at clubs.byu.edu.</p>
        ${tl.clubs.map(c => `
          <div class="tl-item ev-club">
            <span class="tl-when"><i class="fas fa-user-group"></i></span>
            <div class="tl-body">
              <b>${esc(c.name)}</b>
              ${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">Details <i class="fas fa-arrow-up-right-from-square"></i></a>` : ""}
            </div>
          </div>`).join("")}
      </details>` : ""}`;
    // one-click Recommended actions (the student opts in — never automatic)
    el.querySelectorAll(".tl-rec-btn").forEach(b =>
      b.addEventListener("click", () => applyRec((tl.recs[+b.dataset.rec] || {}).act)));
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

  /* ------------------------- clean print / PDF ----------------------- */
  /* Builds a dedicated printable document (hidden iframe) instead of
     printing the app shell: every semester in a wrapping grid, clean tables,
     plan summary, key deadlines, warnings, and a verify-with-MyMAP footer.
     The scrolling board could never fit all semesters on paper. */
  function printPlan() {
    const plan = activePlan();
    if (!plan || !result) { toast("Generate a plan first."); return; }
    const progNames = (result.programs || []).filter(id => id !== "univ-core")
      .map(id => DATA.programIndex[id]?.name || id);
    const byTerm = new Map();
    result.placements.forEach(p => {
      if (!byTerm.has(p.termIndex)) byTerm.set(p.termIndex, []);
      byTerm.get(p.termIndex).push(p);
    });
    const termIdx = [...byTerm.keys()].sort((a, b) => a - b);
    const totalCr = result.placements.reduce((s, p) => s + p.credits, 0);
    const done = plan.profile.completed || [];
    const doneCr = done.reduce((s, id) => s + (DATA.courses[id]?.credits ?? 3), 0);
    const warns = (result.flags || []).filter(f => f.level === "warn").slice(0, 4);

    const termBlock = t => {
      const items = byTerm.get(t);
      const cr = items.reduce((s, p) => s + p.credits, 0);
      items.sort((a, b) => b.credits - a.credits);
      return `<div class="term">
        <div class="term-head"><b>${esc(result.terms[t].label)}</b><span>${cr.toFixed(1).replace(/\.0$/, "")} cr</span></div>
        <table>${items.map(p => `<tr>
          <td class="code">${esc(p.display)}${p.bucket ? " ▾" : ""}${p.pinned ? " 📌" : ""}</td>
          <td class="name">${esc(p.bucket ? (p.name || "choose a class") : p.name)}</td>
          <td class="cr">${p.credits.toFixed(1).replace(/\.0$/, "")}</td>
        </tr>`).join("")}</table>
      </div>`;
    };

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(plan.name)} — myplanBYU</title>
      <style>
        * { box-sizing: border-box; margin: 0; }
        body { font: 10.5px/1.45 'Segoe UI', Arial, sans-serif; color: #1c2733; padding: 28px 32px; }
        h1 { font-size: 19px; margin-bottom: 2px; }
        .sub { color: #55677a; font-size: 11px; margin-bottom: 12px; }
        .stats { display: flex; gap: 22px; border: 1px solid #d8dfe6; border-radius: 8px; padding: 8px 14px; margin-bottom: 14px; font-size: 11px; }
        .stats b { font-size: 14px; display: block; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .term { border: 1px solid #d8dfe6; border-radius: 8px; padding: 8px 10px; break-inside: avoid; }
        .term-head { display: flex; justify-content: space-between; border-bottom: 1.5px solid #1c2733; padding-bottom: 4px; margin-bottom: 5px; font-size: 11.5px; }
        table { width: 100%; border-collapse: collapse; }
        td { padding: 2.5px 4px 2.5px 0; vertical-align: top; border-bottom: 1px solid #eef1f4; }
        tr:last-child td { border-bottom: 0; }
        .code { white-space: nowrap; font-weight: 600; width: 34%; }
        .name { color: #45566a; }
        .cr { text-align: right; white-space: nowrap; width: 30px; color: #45566a; }
        .sec { margin-top: 14px; break-inside: avoid; }
        .sec h2 { font-size: 12px; margin-bottom: 5px; }
        .sec p, .sec li { font-size: 10px; color: #45566a; }
        .sec ul { padding-left: 16px; }
        .legend { margin-top: 10px; font-size: 9.5px; color: #55677a; }
        .foot { margin-top: 16px; padding-top: 8px; border-top: 1px solid #d8dfe6; font-size: 9.5px; color: #55677a; }
        @page { margin: 12mm; }
      </style></head><body>
      <h1>${esc(plan.name)}</h1>
      <div class="sub">${esc(progNames.join(" · "))} — draft plan generated ${new Date().toLocaleDateString()} by myplanBYU${result.state && result.state.mapName ? ` · follows the official ${esc(result.state.mapName.replace(/\s*\(.*\)$/, ""))} MAP sheet` : ""}</div>
      <div class="stats">
        <div><b>${termIdx.length}</b> semesters</div>
        <div><b>${Math.round(totalCr)}</b> planned credits</div>
        ${done.length ? `<div><b>${Math.round(doneCr)}</b> credits already completed</div>` : ""}
        <div><b>${esc(result.terms[termIdx[termIdx.length - 1]].label)}</b> graduation</div>
      </div>
      <div class="grid">${termIdx.map(termBlock).join("")}</div>
      <div class="legend">▾ = choose-a-class slot (any listed option satisfies it) · 📌 = pinned. Credits shown per class; term totals include every card.</div>
      ${timeline.deadlines.length ? `<div class="sec"><h2>Key deadlines</h2><ul>${timeline.deadlines.slice(0, 6).map(d => `<li><b>${esc(d.when)}:</b> ${esc(d.title)}</li>`).join("")}</ul></div>` : ""}
      ${warns.length ? `<div class="sec"><h2>Planner warnings</h2><ul>${warns.map(w => `<li>${esc(w.text)}</li>`).join("")}</ul></div>` : ""}
      <div class="foot">Draft made with myplanBYU, an unofficial planning tool — verify against MyMAP and your college advisement center before registering.</div>
      </body></html>`;

    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    document.body.appendChild(f);
    f.contentDocument.open();
    f.contentDocument.write(html);
    f.contentDocument.close();
    f.onload = () => {
      f.contentWindow.focus();
      f.contentWindow.print();
      setTimeout(() => f.remove(), 2000);
    };
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

  /* ---------------- what-if: compare this plan against a change --------- */
  /* Solve a MODIFIED copy of the active profile and diff it against the
     current plan: which credits carry over, what's newly required, what's no
     longer needed, semesters and graduation date. Entry points: Plan Options
     -> "What if…" and the AI advisor's proposed-action button (chat.js). */
  const WHATIF_TYPES = {
    add_minor:    { label: "Add a minor",        pool: () => DATA.minors, max: 1 },
    add_cert:     { label: "Add a certificate",  pool: () => DATA.certs,  max: 1 },
    switch_major: { label: "Switch major",       pool: () => DATA.majors, max: 1 },
    remove_minor: { label: "Drop a minor",       pool: () => (activePlan()?.profile.minorIds || []).map(id => DATA.programIndex[id]).filter(Boolean), max: 1 },
    enable_spsu:  { label: "Allow Spring & Summer terms", pool: null },
  };

  function whatIfProfile(mod) {
    const plan = activePlan();
    if (!plan) return null;
    const p = JSON.parse(JSON.stringify(plan.profile));
    if (mod.type === "switch_major") {
      p.majorId = mod.programId;
      // pins/fills/removals refer to the OLD major's plan — a fresh start is honest
      p.pins = {}; p.fills = {}; p.excluded = [];
    }
    if (mod.type === "add_minor") p.minorIds = [...new Set([...(p.minorIds || []), mod.programId])].slice(0, 2);
    if (mod.type === "remove_minor") p.minorIds = (p.minorIds || []).filter(id => id !== mod.programId);
    if (mod.type === "add_cert") p.certIds = [...new Set([...(p.certIds || []), mod.programId])];
    if (mod.type === "enable_spsu") { p.settings.allowSpring = true; p.settings.allowSummer = true; }
    return p;
  }

  function planMetrics(r) {
    const activeT = [...new Set(r.placements.map(p => p.termIndex))].sort((a, b) => a - b);
    const real = r.placements.filter(p => !p.placeholder && !/^ELECTIVE\+/.test(p.uid));
    return {
      fwTerms: r.terms.filter(tm => tm.isFW && activeT.includes(tm.index)).length,
      spsuTerms: r.terms.filter(tm => !tm.isFW && activeT.includes(tm.index)).length,
      credits: r.placements.reduce((s, p) => s + p.credits, 0),
      // "choose a class" requirement slots vs pure open-elective filler —
      // a new minor mostly arrives as slots, so the diff must show them
      slotCr: r.placements.filter(p => p.placeholder && !p.elective && !/^ELECTIVE\+/.test(p.uid))
        .reduce((s, p) => s + p.credits, 0),
      elecCr: r.placements.filter(p => p.elective || /^ELECTIVE\+/.test(p.uid))
        .reduce((s, p) => s + p.credits, 0),
      grad: activeT.length ? r.terms[activeT[activeT.length - 1]].label : "—",
      realIds: new Set(real.map(p => p.courseId)),
      crOf: id => { const p = real.find(x => x.courseId === id); return p ? p.credits : 3; },
      nameOf: id => { const p = real.find(x => x.courseId === id); return p ? p.display : id; },
    };
  }

  function openWhatIf(preset) {
    const plan = activePlan();
    if (!plan || !result) { toast("Generate a plan first."); return; }
    const body = $("#whatifBody");
    $("#whatifModal").classList.add("open");
    let mode = preset && WHATIF_TYPES[preset.type] ? preset.type : null;

    const pickerHtml = () => `
      <p class="wi-intro">Compare your current plan against a change — the solver builds the alternative and shows exactly what it costs: semesters, credits, what carries over, what's new.</p>
      <div class="wi-modes">${Object.entries(WHATIF_TYPES).map(([k, t]) =>
        `<button class="btn ${mode === k ? "primary" : "ghost"} sm" data-mode="${k}">${t.label}</button>`).join("")}
      </div>
      <div id="wiPick"></div>
      <div class="wi-run"><button class="btn primary" id="wiRun" disabled><i class="fas fa-code-compare"></i> Compare</button></div>
      <div id="wiResult"></div>`;

    let chosenProg = preset && preset.programId ? preset.programId : null;
    const renderPicker = () => {
      body.innerHTML = pickerHtml();
      body.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => {
        mode = b.dataset.mode; chosenProg = null; renderPicker();
      }));
      const pickEl = body.querySelector("#wiPick");
      if (mode && WHATIF_TYPES[mode].pool) {
        pickEl.innerHTML = `<div id="wiSearch"></div>`;
        searchSelect("#wiSearch", WHATIF_TYPES[mode].pool(), chosenProg ? [chosenProg] : [], 1,
          ids => { chosenProg = ids[0] || null; body.querySelector("#wiRun").disabled = !chosenProg; });
      }
      const run = body.querySelector("#wiRun");
      run.disabled = mode === "enable_spsu" ? false : !chosenProg;
      run.addEventListener("click", () => runCompare({ type: mode, programId: chosenProg }));
    };

    const runCompare = (mod) => {
      const resEl = body.querySelector("#wiResult");
      resEl.innerHTML = `<div class="wi-solving"><i class="fas fa-gear fa-spin"></i> Building the alternative plan…</div>`;
      setTimeout(() => {           // let the spinner paint before the solve blocks
        const altProfile = whatIfProfile(mod);
        let alt;
        try { alt = Solver.solve(altProfile); }
        catch (e) { resEl.innerHTML = `<div class="flag flag-error">The alternative couldn't be solved: ${esc(String(e))}</div>`; return; }
        const A = planMetrics(result), B = planMetrics(alt);
        const carry = [...A.realIds].filter(id => B.realIds.has(id));
        const added = [...B.realIds].filter(id => !A.realIds.has(id));
        const dropped = [...A.realIds].filter(id => !B.realIds.has(id));
        const carryCr = carry.reduce((s, id) => s + A.crOf(id), 0);
        const dTerms = B.fwTerms - A.fwTerms;
        const dCr = Math.round(B.credits - A.credits);
        const modLabel = mod.type === "enable_spsu" ? "with Spring/Summer terms"
          : `${WHATIF_TYPES[mod.type].label.replace(/^Add a |^Switch |^Drop a /, m => m.toLowerCase())}: ${DATA.programIndex[mod.programId]?.name || ""}`;
        const chipList = (ids, M) => ids.slice(0, 14).map(id => `<span class="chip">${esc(M.nameOf(id))}</span>`).join("") +
          (ids.length > 14 ? `<span class="chip soft">+${ids.length - 14} more</span>` : "");
        resEl.innerHTML = `
          <div class="wi-grid">
            <div class="wi-card"><h4>Current plan</h4>
              <b>${A.fwTerms}</b> Fall/Winter semesters${A.spsuTerms ? ` + ${A.spsuTerms} Sp/Su` : ""}<br>
              <b>${Math.round(A.credits)}</b> planned credits · graduates <b>${esc(A.grad)}</b></div>
            <div class="wi-card wi-alt"><h4>What-if (${esc(modLabel)})</h4>
              <b>${B.fwTerms}</b> Fall/Winter semesters${B.spsuTerms ? ` + ${B.spsuTerms} Sp/Su` : ""}
              <span class="wi-delta ${dTerms > 0 ? "bad" : dTerms < 0 ? "good" : ""}">${dTerms > 0 ? `+${dTerms}` : dTerms || "±0"}</span><br>
              <b>${Math.round(B.credits)}</b> planned credits
              <span class="wi-delta ${dCr > 0 ? "bad" : dCr < 0 ? "good" : ""}">${dCr > 0 ? `+${dCr}` : dCr || "±0"}</span>
              · graduates <b>${esc(B.grad)}</b></div>
          </div>
          <div class="wi-sec"><label><i class="fas fa-arrows-rotate"></i> Carries over</label>
            <p>${carry.length} of your ${A.realIds.size} scheduled classes (${Math.round(carryCr)} cr) count in both plans — you lose nothing on those.${
              Math.abs(B.slotCr - A.slotCr) >= 1 ? ` Flexible "choose a class" requirement slots go ${Math.round(A.slotCr)} → ${Math.round(B.slotCr)} cr${B.slotCr > A.slotCr ? " (the new program's requirements arrive as choose-slots)" : ""}.` : ""}${
              A.elecCr - B.elecCr >= 3 ? ` ${Math.round(A.elecCr - B.elecCr)} cr of open electives convert into real requirements — that's why the totals barely move.` : ""}</p></div>
          ${added.length ? `<div class="wi-sec"><label><i class="fas fa-plus"></i> Newly required (${added.length})</label><div class="cm-chips">${chipList(added, B)}</div></div>` : ""}
          ${dropped.length ? `<div class="wi-sec"><label><i class="fas fa-minus"></i> No longer needed (${dropped.length})</label><div class="cm-chips">${chipList(dropped, A)}</div></div>` : ""}
          <div class="wi-actions">
            <button class="btn primary" id="wiSave"><i class="fas fa-floppy-disk"></i> Save as a new plan</button>
            <button class="btn ghost" data-close="#whatifModal">Keep my current plan</button>
          </div>
          <p class="wi-note"><i class="fas fa-circle-info"></i> Saving creates a separate plan — your current one stays untouched in My Plans.</p>`;
        resEl.querySelector("#wiSave").addEventListener("click", () => {
          const name = mod.type === "enable_spsu" ? `${plan.name} + Sp/Su`
            : `${plan.name.replace(/ \+.*$/, "")} + ${(DATA.programIndex[mod.programId]?.name || "change").replace(/\s*\(.*\)$/, "")}`;
          newPlanFromProfile(altProfile, name);
          closeModal("#whatifModal");
          solveActive();
          toast("Saved as a new plan — you're now viewing it.", "ok");
        });
        resEl.querySelector("[data-close]").addEventListener("click", () => closeModal("#whatifModal"));
      }, 30);
    };

    renderPicker();
    if (preset && (preset.programId || preset.type === "enable_spsu")) {
      runCompare({ type: preset.type, programId: preset.programId });
    }
  }

  /* Prerequisite-chain visual: what unlocks this course -> THIS -> what it
     unlocks, resolved against the ACTUAL plan (✓ completed, term labels for
     planned satisfiers, red for missing). One level each way — the deeper
     story lives in the "Why it's here" chain notes. */
  function chainHtml(p, c) {
    if (p.placeholder || p.bucket) return "";
    const completed = result.state.completed;
    const placedAt = id => {
      let best = null;
      result.placements.forEach(x => {
        if (x.courseId === id && (best === null || x.termIndex < best)) best = x.termIndex;
      });
      return best;
    };
    // upstream: per prereq group, the satisfier this plan actually uses
    const up = (c.pre || []).map(group => {
      const opts = Array.isArray(group) ? group : [group];
      const doneOpt = opts.find(g => completed.has(g));
      if (doneOpt) return { label: doneOpt, cls: "done", note: "✓ done" };
      const planned = opts.map(g => ({ g, t: placedAt(g) })).filter(x => x.t !== null)
        .sort((a, b) => a.t - b.t)[0];
      if (planned) return { label: planned.g, cls: "", note: result.terms[planned.t].label };
      // Absent AND the course itself is placed by the official sheet → the
      // sheet scheduled it without this prereq on purpose (AP / placement /
      // transfer assumed). Match the solver's stance instead of a red alarm.
      if (p.pinned && result.state.mapCodes && result.state.mapCodes.has(p.courseId))
        return { label: opts[0] + (opts.length > 1 ? ` (or ${opts.length - 1} more)` : ""), cls: "assume", note: "assumed met" };
      return { label: opts[0] + (opts.length > 1 ? ` (or ${opts.length - 1} more)` : ""), cls: "miss", note: "not planned" };
    });
    // downstream: planned courses whose prereqs list this one
    const seen = new Set();
    const down = [];
    result.placements.forEach(x => {
      if (x.courseId === p.courseId || seen.has(x.courseId)) return;
      const cc = result.state.cat[x.courseId];
      if (!cc || !(cc.pre || []).some(g => (Array.isArray(g) ? g : [g]).includes(p.courseId))) return;
      seen.add(x.courseId);
      down.push({ label: x.display, note: result.terms[x.termIndex].label, t: x.termIndex });
    });
    down.sort((a, b) => a.t - b.t);
    if (!up.length && !down.length) return "";
    const chip = n => `<span class="cm-chn ${n.cls || ""}"><b>${esc(n.label)}</b><i>${esc(n.note)}</i></span>`;
    return `<div class="cm-sec"><label>Prerequisite chain</label>
      <div class="cm-chain">
        <div class="cm-chain-col">${up.length ? up.map(chip).join("") : `<span class="cm-chain-none">no prerequisites</span>`}</div>
        <span class="cm-chain-arrow"><i class="fas fa-arrow-right-long"></i></span>
        <span class="cm-chain-this">${esc(p.display)}</span>
        <span class="cm-chain-arrow"><i class="fas fa-arrow-right-long"></i></span>
        <div class="cm-chain-col">${down.length
          ? down.slice(0, 5).map(chip).join("") + (down.length > 5 ? `<span class="cm-chain-none">+${down.length - 5} more</span>` : "")
          : `<span class="cm-chain-none">nothing in the plan waits on it</span>`}</div>
      </div></div>`;
  }

  /* WHO TEACHES THIS — the one question the planner structurally could not
     answer. The catalog knows a course exists and what it requires; only BYU's
     class schedule knows who stands in front of it.

     The display's rules:
       1. THE SCHEDULED TERM DECIDES THE STATE. A course the plan puts in Fall
          2026 must show the FALL 2026 roster when BYU has posted it — the
          first cut showed the newest posted term instead, which put a
          "Winter 2027:" roster on a Fall 2026 class and made confirmed data
          read as guesswork.
       2. LABEL EVERY STATE. "Confirmed" only when the roster is for the exact
          term the plan schedules the course; a roster from a different posted
          term says whose it is AND that the plan's term isn't posted;
          history says "usually"; absence says "not posted", never "nobody".
       3. ALL the names are reachable — four inline, the rest one tap away —
          and every name links to its own Rate My Professors search. BY NAME,
          because RMP indexes professors and has no course pages.
       4. Date the waiting. The registrar publishes when each term's cart
          opens and when registration begins; "opens Aug 1" beats "closed". */
  const SEASON_TERM_DIGIT = { W: "1", S: "3", U: "4", F: "5" };
  function termCodeOf(tm) {
    return tm ? `${tm.year}${SEASON_TERM_DIGIT[tm.season] || ""}` : null;
  }
  function fmtRegDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1]} ${d}, ${y}`;
  }
  // "cart opens Aug 1" / "registration begins Oct 19" for a posted term, or
  // "BYU posts this schedule around Dec 1" for one that isn't. Empty string
  // when the registrar table doesn't reach that term — no date is better than
  // an invented one.
  function regNote(S, code, posted) {
    const rd = (S.regDates || {})[code];
    if (!rd) return "";
    const today = new Date().toISOString().slice(0, 10);
    if (!posted) {
      return rd.cart > today ? `BYU posts this term's schedule around ${fmtRegDate(rd.cart)}.` : "";
    }
    if (rd.cart > today) return `Registration cart opens ${fmtRegDate(rd.cart)}.`;
    if (rd.reg && rd.reg > today) return `Cart is open; registration begins ${fmtRegDate(rd.reg)}.`;
    return "";
  }
  function whoTeaches(courseId, schedTm) {
    const S = typeof SCHEDULE !== "undefined" ? SCHEDULE : null;
    const sched = "https://commtech.byu.edu/noauth/classSchedule/index.php";
    // The block is a `.cm-sec` — the modal's own visual grammar ("PREREQUISITES
    // · per catalog", "WHY IT'S HERE · solver reasoning") — instead of an
    // unlabeled strip of chips under the title, which is how the first version
    // shipped and why it read as clutter. One line per job, top to bottom:
    // what this is (label + data-state), the names, how to read them, the
    // live-sections action, and the registration note. The tan callout for
    // the historical state is the same idea colour-coded: pattern, not roster.
    const sec = (srcLabel, body, cls) => `
      <div class="cm-sec cm-who-sec${cls ? " " + cls : ""}">
        <label>Who teaches it ${srcLabel ? `<span class="cm-seclabel-src">· ${srcLabel}</span>` : ""}</label>
        ${body}
      </div>`;
    if (!S || !S.terms || !S.terms.length) {
      return sec("", `<p class="cm-pretext cm-none"><a href="${sched}" target="_blank" rel="noopener">Search BYU's class schedule ↗</a></p>`);
    }
    const rmp = n => `<a class="cm-prof-chip" href="https://www.ratemyprofessors.com/search/professors/135?q=${encodeURIComponent(n)}"
        target="_blank" rel="noopener"
        title="${esc(n)} — opens their Rate My Professors reviews (BYU)">${esc(n)}</a>`;
    const namesBlock = names => {
      const head = names.slice(0, 4), rest = names.slice(4);
      return `<div class="cm-prof-row">${head.map(rmp).join("")}
        ${rest.length ? `<button type="button" class="cm-prof-chip cm-prof-more" id="cmWhoMore">+${rest.length} more ▾</button>
          <span class="cm-who-rest" id="cmWhoRest" hidden>${rest.map(rmp).join("")}</span>` : ""}</div>
        <div class="cm-who-hint">tap a name for their Rate My Professors reviews</div>`;
    };
    const sectionsBtn = (code, label, n) =>
      `<button type="button" class="cm-sections-btn" id="cmSectionsBtn"
        data-course="${esc(courseId)}" data-term="${code}" data-label="${esc(label)}"
        title="Fetched from BYU the moment you click — section times, instructors, and current seat availability">
        <i class="fas fa-table-list"></i> See ${esc(label)} sections <span class="cm-live-dot"></span> live seat counts</button>`;
    const noteLine = t => t ? `<div class="cm-who-note">${t}</div>` : "";

    const schedCode = termCodeOf(schedTm);
    const rosterOf = code => {
      const idx = (S.byTerm[code] || {})[courseId];
      return idx && idx.length ? idx.map(i => S.names[i]).filter(Boolean) : null;
    };

    // 1) CONFIRMED — the roster for the exact term the plan schedules it
    const own = schedCode && S.terms.find(t => t.code === schedCode) && rosterOf(schedCode);
    if (own) {
      return sec(`<span class="cm-badge cm-badge-live">✓ confirmed for ${esc(schedTm.label)}</span>`,
        namesBlock(own) + sectionsBtn(schedCode, schedTm.label)
        + noteLine(esc(regNote(S, schedCode, true))));
    }

    // 2) A DIFFERENT posted term lists it — real data, wrong semester. Say
    //    both halves plainly; never let Winter's roster impersonate Fall's.
    for (const t of S.terms) {
      const names = rosterOf(t.code);
      if (names) {
        return sec(`<span class="cm-badge cm-badge-other">latest roster — ${esc(t.label)}</span>`,
          namesBlock(names) + sectionsBtn(t.code, t.label)
          + noteLine(`Your plan takes this ${esc(schedTm ? schedTm.label : "later")}, which BYU hasn't posted — above is who's teaching it ${esc(t.label)}, the best available signal. ${esc(regNote(S, schedCode, false))}`));
      }
    }

    // 3) HISTORY — who USUALLY teaches it, from the archive. Hedged: "usually",
    //    the count it rests on, and never a promise about an unassigned term.
    const hist = (S.historic || {})[courseId];
    if (hist && hist.length) {
      const span = (S.historyTerms || []).length;
      const names = hist.slice(0, 3).map(([i]) => S.names[i]).filter(Boolean);
      return sec(`<span class="cm-badge cm-badge-hist">↻ based on past terms</span>`,
        `<div class="cm-prof-row">${names.map(rmp).join("")}</div>
         <div class="cm-who-hint">taught it ${hist[0][1]} of the last ${span} Fall/Winter terms${hist.length > names.length ? " (among others)" : ""} — tap a name for reviews</div>`
        + noteLine(`BYU hasn't assigned this term yet. ${esc(regNote(S, schedCode, false))}`),
        "cm-who-histsec");
    }
    return sec("",
      `<p class="cm-pretext cm-none">BYU hasn't posted who teaches this yet. ${esc(regNote(S, schedCode, false))}
       <a href="${sched}" target="_blank" rel="noopener">Check the class schedule ↗</a></p>`);
  }

  /* LIVE SECTIONS — one click fetches this course's real section list through
     the advisor server (a plain data proxy; BYU's endpoint sends no CORS
     headers, so the browser can't ask it directly). This is the only place in
     the app with LIVE data: seat counts move by the minute during
     registration, which is exactly why they can't ride the weekly scrape.
     Every failure lands on the link-out — the student always has a path. */
  function advisorApiBase() {
    const url = (typeof window !== "undefined" && window.MYPLAN_ADVISOR_API)
      || "http://127.0.0.1:5000/api";
    if (typeof location !== "undefined" && location.protocol === "https:"
        && /^http:\/\//i.test(url)) return "";      // mixed content — unusable
    return url;
  }
  async function loadSections(course, term, label) {
    const box = $("#cmSections");
    if (!box) return;
    const fallback = `<a href="https://commtech.byu.edu/noauth/classSchedule/index.php" target="_blank" rel="noopener">open BYU's class schedule ↗</a>`;
    const api = advisorApiBase();
    if (!api) { box.innerHTML = `<div class="cm-sec-err">Live sections need the advisor server — ${fallback}</div>`; return; }
    box.innerHTML = `<div class="cm-sec-loading"><i class="fas fa-circle-notch fa-spin"></i> Fetching live ${esc(label)} sections from BYU…</div>`;
    let d;
    try {
      const r = await fetch(`${api}/sections?course=${encodeURIComponent(course)}&term=${encodeURIComponent(term)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      d = await r.json();
    } catch (e) {
      box.innerHTML = `<div class="cm-sec-err">Couldn't reach the live schedule (${esc(String(e.message || e))}) — ${fallback}</div>`;
      return;
    }
    if (!d.sections || !d.sections.length) {
      box.innerHTML = `<div class="cm-sec-err">BYU lists no ${esc(label)} sections for ${esc(course)} right now — ${fallback}</div>`;
      return;
    }
    const rmp = n => `<a href="https://www.ratemyprofessors.com/search/professors/135?q=${encodeURIComponent(n)}" target="_blank" rel="noopener">${esc(n)}</a>`;
    const seat = s => s.seats == null ? "—"
      : +s.seats > 0 ? `<b class="cm-seats-open">${esc(s.seats)}</b> of ${esc(s.size)}`
      : `<b class="cm-seats-full">full</b> (${esc(s.size)}${+s.waitlist > 0 ? `, ${esc(s.waitlist)} waitlisted` : ""})`;
    box.innerHTML = `
      <div class="cm-sec-head">${esc(label)} sections — live from BYU
        <span class="cm-sec-sub">seat counts are current as of right now</span></div>
      <table class="cm-sec-table"><thead>
        <tr><th>Sec</th><th>Instructor</th><th>When / where</th><th>Seats</th><th>Mode</th></tr>
      </thead><tbody>
        ${d.sections.map(s => `<tr>
          <td>${esc(s.num || "")}</td>
          <td>${s.instructors.length ? s.instructors.map(rmp).join(", ") : '<span class="cm-sec-tba">TBA</span>'}</td>
          <td>${s.times.length ? s.times.map(esc).join("<br>") : "—"}</td>
          <td>${seat(s)}</td>
          <td>${esc(s.mode || "")}</td>
        </tr>`).join("")}
      </tbody></table>`;
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
          <p class="cm-name">${c.unlisted
            ? `<span class="unlisted-tag">no course number yet</span> Your program lists this course, but the catalog hasn't published a course number for it. Ask your advisor for the number before you register.`
            : esc(p.name)}</p>
        </div>
      </div>
      <div class="cm-grid">
        <div class="cm-cell"><label>Scheduled</label><b>${esc(term.label)}${p.pinned ? " 📌" : ""}${p.block ? " · cohort block" : ""}</b></div>
        <div class="cm-cell"><label>Offered</label><b>${[...c.off].map(s => Solver.SEASON_NAME[s]).join(", ")}</b></div>
        <div class="cm-cell"><label>Difficulty</label>
          <span class="diff-meter"><span style="width:${c.diff * 10}%" class="${c.diff >= 7 ? "hot" : ""}"></span></span> <b>${c.diff}/10</b></div>
        <div class="cm-cell"><label>Time cost</label><b>×${(c.load || 1).toFixed(1)} of credit hours</b></div>
      </div>
      ${!p.placeholder && !c.unlisted ? whoTeaches(p.courseId, term) : ""}
      <div id="cmSections"></div>
      ${(c.preText || pre.length) ? `<div class="cm-sec"><label>Prerequisites <span class="cm-seclabel-src">· per catalog</span></label>
        ${c.preText ? `<p class="cm-pretext">${esc(c.preText)}</p>` : ""}
        ${pre.length ? `<div class="cm-chips">${pre.map(x => `<span class="chip">${esc(x)}</span>`).join("")}</div>` : ""}</div>`
        : `<div class="cm-sec"><label>Prerequisites <span class="cm-seclabel-src">· per catalog</span></label><p class="cm-pretext cm-none">None listed.</p></div>`}
      ${buckets.length ? `<div class="cm-sec"><label>Fills requirements</label>${buckets.map(x => `<span class="chip soft">${esc(x)}</span>`).join("")}</div>` : ""}
      ${chainHtml(p, c)}
      ${(p.why || []).length ? `<div class="cm-sec"><label>Why it's here <span class="cm-seclabel-src">· solver reasoning</span></label>${p.why.map(w => `<div class="cm-why"><i class="fas fa-route"></i><span>${esc(w)}</span></div>`).join("")}</div>` : ""}
      ${p.flags.length ? `<div class="cm-sec"><label>Notes & flags</label>${p.flags.map(f => `<div class="flag flag-${f.level}"><i class="fas fa-circle-info"></i><span>${esc(f.text)}</span></div>`).join("")}</div>` : ""}
      ${p.block ? `<p class="cm-blocknote"><i class="fas fa-people-group"></i> Part of a locked cohort block — it moves only when the whole block moves.</p>` : `
      <div class="cm-move">
        <select id="cmMoveSel"><option value="">Move to term…</option>${moveOpts}</select>
        <button class="btn primary sm" id="cmMoveBtn">Move & pin</button>
        ${p.pinned ? `<button class="btn ghost sm" id="cmUnpinBtn">Unpin</button>` : ""}
        ${fillOf(p.courseId) ? `<button class="btn ghost sm" id="cmUnfillBtn" title="Turn this back into an open 'choose a class' slot"><i class="fas fa-rotate-left"></i> Back to dropdown</button>` : ""}
        <button class="btn ghost sm cm-remove" id="cmRemoveBtn" title="Drop this class from the plan entirely"><i class="fas fa-trash-can"></i> Remove</button>
      </div>
      <p class="cm-removenote"><i class="fas fa-circle-info"></i> Removing drops the class from your plan. If a program requires it, that requirement will show as an open gap until you restore it (Plan Options → Restore removed).</p>`}
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
    const remove = $("#cmRemoveBtn");
    if (remove) remove.onclick = () => removeCourse(p.courseId, p.display);
    // instructor row: "+N more" toggle and the live-sections fetch
    const whoMore = $("#cmWhoMore");
    if (whoMore) {
      const label = whoMore.textContent;          // "+58 more ▾"
      whoMore.onclick = () => {
        const rest = $("#cmWhoRest");
        rest.hidden = !rest.hidden;
        whoMore.textContent = rest.hidden ? label : "show fewer ▴";
      };
    }
    const secBtn = $("#cmSectionsBtn");
    if (secBtn) secBtn.onclick = () =>
      loadSections(secBtn.dataset.course, secBtn.dataset.term, secBtn.dataset.label);
  }

  /* Drop a course from the plan entirely. Cleans every place the profile could
     re-introduce it (extras / bucket fills / pins) and records it in
     profile.excluded so the solver won't re-pull it as a requirement,
     flowchart course, or prerequisite. A required course simply becomes an
     honest open gap in the progress report until it's restored. */
  function removeCourse(courseId, display) {
    const plan = activePlan();
    if (!plan) return;
    const prof = plan.profile;
    // 1) drop from user-added extras
    if (prof.extras) prof.extras = prof.extras.filter(c => c !== courseId);
    // 2) drop any bucket-fill picks that chose it
    if (prof.fills) {
      for (const k of Object.keys(prof.fills)) {
        prof.fills[k] = prof.fills[k].filter(c => c !== courseId);
        if (!prof.fills[k].length) delete prof.fills[k];
      }
    }
    // 3) drop any pin
    if (prof.pins) delete prof.pins[courseId];
    // 4) record the exclusion (so requirements/flowchart/prereqs won't re-add it)
    prof.excluded = prof.excluded || [];
    if (!prof.excluded.includes(courseId)) prof.excluded.push(courseId);
    plan.updatedAt = Date.now();
    save();
    closeModal("#courseModal");
    solveActive();
    toast(`${display} removed. Restore it from Plan Options → Restore removed.`, "ok");
  }
  function closeModal(sel) { $(sel).classList.remove("open"); }

  /* ----------------------------- feedback ----------------------------- */
  /* WHERE RESPONSES GO. This is a static site with no backend, so there are
     only two honest options and this picks the one that needs no setup and
     no third party:

       endpoint === ""  ->  opens the student's own mail client with the whole
                            report pre-written, addressed to `email`. Works
                            today, nothing to configure, and the student's
                            coursework never passes through anyone else.

       endpoint === url ->  POSTs the report as JSON instead (Formspree,
                            FormSubmit, a Cloud Function — anything that takes
                            a JSON body). Higher completion rate, because the
                            student never leaves the page.

     To switch, paste the URL into `endpoint` and nothing else changes. Worth
     knowing before you do: a form service means every report — including the
     completed-course list, if the student leaves the snapshot ticked — passes
     through that company. That is a call for you to make, not me, which is
     why the no-third-party path is the default. */
  /* Where a bug report goes.
     `mailto:` alone was not good enough to launch on: on a phone, or any
     machine with no mail client configured, the button silently does nothing,
     and a plan report is long enough that clients truncate the URL anyway
     (submitFeedback below already guards that at 1900 chars). So POST it.

     The endpoint rides the SAME origin as the AI advisor — that server is
     already deployed alongside the site, so this needs no second service and no
     third-party form host. One `window.MYPLAN_ADVISOR_API` line configures
     both. Reports land in scraper/data/feedback.jsonl.

     Every failure path still falls back to clipboard + email, so a report is
     never lost when the backend is down. Set `endpoint` to a fixed URL here to
     override (Formspree and friends accept exactly this JSON POST). */
  const FEEDBACK = {
    endpoint: (() => {
      const url = (typeof window !== "undefined" && window.MYPLAN_FEEDBACK_API)
        || ((typeof window !== "undefined" && window.MYPLAN_ADVISOR_API)
            || "http://127.0.0.1:5000/api") + "/feedback";
      // An https: page cannot call http://127.0.0.1 — the browser blocks it as
      // mixed content. Report it as unset rather than burning a doomed fetch
      // and a confusing error on the way to the mail fallback (same check as
      // chat.js MIXED_CONTENT_BLOCKED).
      if (typeof location !== "undefined" && location.protocol === "https:"
          && /^http:\/\//i.test(url)) return "";
      return url;
    })(),
    email: "jordandheaton@gmail.com",
  };
  const FEEDBACK_KINDS = [
    ["requirement", "A requirement is wrong, missing, or shouldn't be there"],
    ["sequence", "A class is in the wrong semester / prerequisite order"],
    ["course", "A course's details are wrong (credits, when it's offered, name)"],
    ["admission", "Application or admission info is wrong"],
    ["ui", "Something was confusing or broken in the app"],
    ["idea", "An idea or a feature request"],
    ["other", "Something else"],
  ];

  /* The PROFILE is the reproduction: major + completed + settings re-solves to
     the exact plan being complained about. So the snapshot stays compact — no
     board dump — and a report can be replayed by pasting it back in. */
  function feedbackSnapshot() {
    const plan = activePlan();
    if (!plan) return null;
    const p = plan.profile;
    const name = id => (DATA.programIndex[id] || {}).name || id;
    const snap = {
      major: p.majorId ? name(p.majorId) : null,
      majorId: p.majorId,
      minors: (p.minorIds || []).map(name),
      certs: (p.certIds || []).map(name),
      start: `${p.startTerm.season}${p.startTerm.year}`,
      completed: p.completed || [],
      pinned: Object.keys(p.pins || {}),
      // extras/fills/excluded are what the STUDENT chose by hand, and leaving
      // them out made the "paste this back to reproduce" promise false: a
      // course added from the search bar writes BOTH extras and pins, so a
      // snapshot carrying only pins re-solves to a plan that never contains
      // it. The first real bug report was unreproducible for exactly this
      // reason — the pinned IHUM 202 simply vanished on replay.
      extras: p.extras || [],
      fills: p.fills || {},
      excluded: p.excluded || [],
      settings: p.settings,
    };
    if (result) {
      const used = new Set(result.placements.map(x => x.termIndex));
      snap.terms = used.size;
      snap.ends = result.terms[Math.max(...used)].label;
      snap.unscheduled = result.unscheduled.length;
      // Two warnings, trimmed. The profile above re-solves to this exact plan,
      // so the full list is always one paste away — and the whole report has
      // to survive a mailto: URL, where every character counts.
      snap.warnings = (result.flags || []).filter(f => f.level === "warn")
        .slice(0, 2).map(f => f.text.slice(0, 120));
    }
    return snap;
  }

  function feedbackReport(fields, snap) {
    const L = [];
    L.push(`Type: ${(FEEDBACK_KINDS.find(k => k[0] === fields.kind) || [, fields.kind])[1]}`);
    if (fields.where) L.push(`Where: ${fields.where}`);
    L.push("", "What happened:", fields.what);
    if (fields.expected) L.push("", "What should have happened:", fields.expected);
    L.push("", `Reply to: ${fields.email || "(not given)"}`);
    if (snap) {
      L.push("", "--- plan snapshot (paste back into the app to reproduce) ---");
      L.push(JSON.stringify(snap));
    }
    L.push("", `myplanBYU ${location.host} · ${new Date().toISOString()}`);
    return L.join("\n");
  }

  function openFeedback() {
    const snap = feedbackSnapshot();
    $("#feedbackBody").innerHTML = `
      <p class="fb-intro">This is a student project and the catalog data is
      messy in places — if the planner got something wrong, telling me is what
      makes it better. Everything here is optional except what happened.</p>
      <label class="wiz-lbl">What kind of feedback?</label>
      <select id="fbKind">${FEEDBACK_KINDS.map(([v, t]) =>
        `<option value="${v}">${esc(t)}</option>`).join("")}</select>
      <label class="wiz-lbl">Which class or semester? <span class="wiz-sub">(if it's about one — e.g. "IS 401" or "Fall 2028")</span></label>
      <input type="text" id="fbWhere" placeholder="IS 401, Winter 2029…" autocomplete="off">
      <label class="wiz-lbl">What happened?</label>
      <textarea id="fbWhat" rows="4" placeholder="The planner put IS 401 in the fall, but my advisor says it's a winter-only class."></textarea>
      <label class="wiz-lbl">What should it have done? <span class="wiz-sub">(optional)</span></label>
      <textarea id="fbExpected" rows="2" placeholder="Scheduled it in Winter with the rest of the winter core."></textarea>
      <label class="wiz-lbl">Your email <span class="wiz-sub">(optional — only so I can ask a follow-up question)</span></label>
      <input type="email" id="fbEmail" placeholder="you@byu.edu" autocomplete="off">
      ${snap ? `<label class="chk fb-snap"><input type="checkbox" id="fbSnap" checked>
        Include my plan so it can be reproduced
        <span class="wiz-sub">${esc(snap.major || "no major")}${snap.completed.length ? `, ${snap.completed.length} completed course${snap.completed.length === 1 ? "" : "s"}` : ""}${snap.terms ? `, ${snap.terms} semesters` : ""} — your name is never included.</span></label>`
        : `<p class="fb-note"><i class="fas fa-circle-info"></i> No plan open, so this will be sent on its own.</p>`}
      <p class="fb-note" id="fbHow"></p>`;
    $("#fbHow").innerHTML = FEEDBACK.endpoint
      ? `<i class="fas fa-paper-plane"></i> Sends straight from this page.`
      : `<i class="fas fa-envelope"></i> Opens your email app with everything filled in — you still have to press send there.`;
    $("#feedbackModal").classList.add("open");
    setTimeout(() => $("#fbWhat").focus(), 30);
  }

  function collectFeedback() {
    const fields = {
      kind: $("#fbKind").value,
      where: $("#fbWhere").value.trim(),
      what: $("#fbWhat").value.trim(),
      expected: $("#fbExpected").value.trim(),
      email: $("#fbEmail").value.trim(),
    };
    if (!fields.what) { toast("Tell me what happened first — the rest is optional.", "err"); $("#fbWhat").focus(); return null; }
    const snapEl = $("#fbSnap");
    const snap = snapEl && snapEl.checked ? feedbackSnapshot() : null;
    return { fields, snap, report: feedbackReport(fields, snap) };
  }

  async function submitFeedback() {
    const f = collectFeedback();
    if (!f) return;
    const subject = `myplanBYU feedback: ${f.fields.kind}${f.fields.where ? ` — ${f.fields.where}` : ""}`;
    if (FEEDBACK.endpoint) {
      try {
        const res = await fetch(FEEDBACK.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ subject, ...f.fields, snapshot: f.snap, report: f.report }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        closeModal("#feedbackModal");
        toast("Thanks — feedback sent.", "ok");
      } catch (e) {
        // Never swallow it: the student typed a real report, so hand it back
        // rather than pretending it went somewhere.
        copyFeedback(f, "Couldn't reach the form. Your feedback is on the clipboard — email it to " + FEEDBACK.email);
      }
      return;
    }
    const href = `mailto:${FEEDBACK.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(f.report)}`;
    // Mail clients silently truncate long mailto: URLs, and a half-sent bug
    // report is worse than none. Past a conservative ceiling, don't fire one —
    // hand the student the full text and let them paste it.
    if (href.length > 1900) {
      copyFeedback(f, `That's a long one — it's on your clipboard. Paste it into an email to ${FEEDBACK.email}.`);
      return;
    }
    // Under the ceiling the clipboard is still a safety net for clients that
    // clip anyway, so a paste always fixes it.
    navigator.clipboard && navigator.clipboard.writeText(f.report).catch(() => {});
    window.location.href = href;
    closeModal("#feedbackModal");
    toast("Opening your email app — the full text is also on your clipboard.", "ok");
  }

  function copyFeedback(f, msg) {
    f = f || collectFeedback();
    if (!f) return;
    const done = () => toast(msg || `Copied — send it to ${FEEDBACK.email}.`, "ok");
    if (navigator.clipboard) navigator.clipboard.writeText(f.report).then(done, done);
    else done();
  }

  /* ------------------------- constraints modal ------------------------ */
  // (Preference dials removed: the solver runs a fixed policy — MAP-sheet
  // pacing where a sheet exists, otherwise 14-16 credits per Fall/Winter
  // semester, 17 when it saves a semester, 8-10 semesters total.)
  function openPriorities() {
    const plan = activePlan();
    if (!plan) { toast("Create a plan first."); return; }
    const prof = plan.profile;
    $("#prioBody").innerHTML = `
      <p class="prio-policy"><i class="fas fa-scale-balanced"></i> Plans follow the official
      MAP sheet where one exists; otherwise semesters target <b>14–16 credits</b>
      (17 when it saves a semester) across <b>8–10 semesters</b>.</p>
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
      </div>
      ${gradTargetControls(prof, "pcTargetSeason", "pcTargetYear")}`;
    $("#prioModal").classList.add("open");
    $("#prioApply").onclick = () => {
      // Changing the graduation date is NOT a small edit. Stability holds every
      // course in the term it already occupies, which is right for a bucket
      // pick and wrong for a re-pacing: the guard below only overrides it when
      // holding costs a semester, so a STRETCH — whose whole point is gaining
      // one — lost it every time. Computer Science set to Winter 2031 in the
      // wizard lands on ten semesters ending on the target; changed to Winter
      // 2031 from the panel it landed on nine, ending a term early. Re-pacing
      // starts clean.
      const before = JSON.stringify(prof.settings.targetGrad || null);
      prof.settings.targetGrad = readGradTarget("pcTargetSeason", "pcTargetYear");
      const paceChanged = JSON.stringify(prof.settings.targetGrad || null) !== before;
      Object.assign(prof.settings, {
        maxCreditsFW: parseInt($("#pcMaxFW").value, 10) || 17,
        minCreditsFW: parseInt($("#pcMinFW").value, 10) || 14,
        maxCreditsSpSu: parseInt($("#pcMaxSS").value, 10) || 8,
        doubleCountCap: parseInt($("#pcDcCap").value, 10) || 15,
        allowSpring: $("#pcSpring").checked, allowSummer: $("#pcSummer").checked,
        scholarshipFullTime: $("#pcSchol").checked, religionPacing: $("#pcRel").checked,
      });
      closeModal("#prioModal");
      solveActive(paceChanged ? { fresh: true } : {});
      toast("Re-optimized with new constraints.", "ok");
    };
  }

  /* Graduate-by target as TWO dropdowns (season, then year) rather than one
     combined list: "Winter" + "2028" is how a student says it out loud, and a
     single 12-option list made them read a compound label to find their term.
     Shared by the wizard and the constraints panel so the two cannot drift.
     Season first, because that is the part people are sure about. */
  function gradTargetControls(prof, idSeason, idYear) {
    const cur = (prof.settings && prof.settings.targetGrad) || {};
    const st = prof.startTerm || { year: new Date().getFullYear(), season: "F" };
    const span = prof.settings && prof.settings.horizonYears || 6;
    const years = [];
    for (let y = st.year; y <= st.year + span; y++) years.push(y);
    return `
      <label class="wiz-lbl grad-lbl">Graduate by <span class="wiz-sub">(optional — a later date paces lighter semesters, an earlier one packs them; leave blank to let the planner choose)</span></label>
      <div class="grad-row">
        <select id="${idSeason}">
          <option value="">No target</option>
          <option value="W"${cur.season === "W" ? " selected" : ""}>Winter (April)</option>
          <option value="F"${cur.season === "F" ? " selected" : ""}>Fall (December)</option>
        </select>
        <select id="${idYear}">
          ${years.map(y => `<option value="${y}"${cur.year === y ? " selected" : ""}>${y}</option>`).join("")}
        </select>
      </div>`;
  }

  /* Read the pair back. Season empty = no target; a year alone means nothing. */
  function readGradTarget(idSeason, idYear) {
    const se = $("#" + idSeason).value;
    if (!se) return null;
    const yr = parseInt($("#" + idYear).value, 10);
    return yr ? { year: yr, season: se } : null;
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

  /* ---------------- transcript import (wizard History step) ------------ */
  /* Paste text from the official transcript preview OR the new MyMAP
     academic summary (or upload the PDF) — every course code is matched
     against the real catalog, so junk can't get in. Three buckets:
     graded/transfer/AP (auto-checked), no-grade-yet (unchecked — could be a
     future "projected" semester), withdrawn/failed (never counted). */
  const TI_GRADE_RE = /^(A-?|B[+-]?|C[+-]?|D[+-]?|E|F|P|CR|NC|W|UW|I|T|IP)$/;
  const TI_BAD = new Set(["E", "F", "W", "UW", "NC", "I", "IP"]);

  let _tiSubjects = null;             // known subject prefixes ("PHIL", "REL C")
  function scanTranscript(text) {
    if (!_tiSubjects) {
      _tiSubjects = new Set(Object.keys(DATA.courses).map(k => k.replace(/\s+\S+$/, "")));
    }
    const found = new Map();          // id -> {grade, equiv, future, hours}
    const unknown = new Set();        // real-looking BYU codes not in the current catalog
    const lines = String(text || "").split(/\r?\n/);
    // The official transcript separates finished work from current/registered
    // work with a "CURRENT ENROLLMENT" header. When present, everything after
    // it is in-progress and everything before it is COMPLETED — so a course
    // whose grade token we couldn't parse (odd layout, unusual grade) still
    // counts as done instead of silently landing unchecked and staying in the
    // plan. MyMAP has no such header, so we fall back to the grade heuristic.
    const hasEnrollBoundary = /current enrollment|courses in progress|registered/i.test(text);
    let future = false;
    const codeRe = /\b([A-Z][A-Z&]{0,5}(?:\s+[A-Z&]{1,5})?)\s+(\d{3}[A-Z]{0,2})\b/g;
    lines.forEach((raw, li) => {
      const line = raw.replace(/\s+/g, " ").trim();
      if (!line) return;
      if (/current enrollment|courses in progress|registered for/i.test(line)) future = true;
      codeRe.lastIndex = 0;
      let m;
      while ((m = codeRe.exec(line))) {
        const subjWords = m[1].replace(/\s+/g, " ").split(" ");
        const id = `${subjWords.join(" ")} ${m[2]}`.toUpperCase();
        const cat = DATA.courses[id];
        if (!cat || cat.placeholder) {                    // catalog is the filter
          // a known SUBJECT with an unknown number = likely a discontinued
          // course (PHIL 215) — surface it instead of silently dropping it
          const subj = id.replace(/\s+\S+$/, "");
          if (!cat && _tiSubjects.has(subj)) unknown.add(id);
          // a greedy two-word miss ("WORK MATH 110" from merged PDF columns)
          // may have swallowed the REAL code — rescan from the second word
          if (subjWords.length === 2) codeRe.lastIndex = m.index + subjWords[0].length + 1;
          continue;
        }
        // grade on the SAME line (transcript layout: "... 3.00 A")
        let grade = null;
        const tail = line.slice(m.index + m[0].length);
        const tm = tail.match(/(\d+\.\d{1,2})\s+(A-?|B[+-]?|C[+-]?|D[+-]?|E|F|P|CR|NC|W|UW|I|T)\b/);
        if (tm) grade = tm[2];
        // a real course ROW carries an hours value (decimal) — distinguishes a
        // graded/completed row from a bare code mentioned in prose
        const hours = /\b\d+\.\d{1,2}\b/.test(tail) || /\b\d+\.\d{1,2}\b/.test(line);
        // MyMAP layout: hours then grade on FOLLOWING lines (blanks between)
        if (!grade) {
          for (let j = li + 1; j <= li + 6 && j < lines.length; j++) {
            const t = lines[j].trim();
            if (!t) continue;
            if (/^\d+(\.\d+)?$/.test(t)) continue;        // the hours line
            if (TI_GRADE_RE.test(t)) grade = t;
            break;                                        // next real line decides
          }
        }
        const equiv = /equivalent course/i.test(line);
        const prev = found.get(id);
        if (!prev || (!prev.grade && (grade || equiv))) {
          found.set(id, { grade, equiv, future, hours: hours || (prev && prev.hours) });
        }
      }
    });
    const graded = [], inProgress = [], excluded = [];
    found.forEach((v, id) => {
      if (v.grade && TI_BAD.has(v.grade)) excluded.push({ id, grade: v.grade });
      else if (v.grade || v.equiv) graded.push({ id, grade: v.grade || "P" });
      // official transcript, real course row, in the COMPLETED region but grade
      // unparsed -> still completed (don't strand it unchecked in the plan)
      else if (hasEnrollBoundary && !v.future && v.hours) graded.push({ id, grade: "—" });
      else inProgress.push({ id, grade: null });
    });
    const byId = (a, b) => a.id.localeCompare(b.id);
    return { graded: graded.sort(byId), inProgress: inProgress.sort(byId),
      excluded: excluded.sort(byId), unknown: [...unknown].sort() };
  }

  // pdf.js from cdnjs (same CDN as Font Awesome), loaded ONLY when a PDF is
  // actually chosen — the page stays dependency-free otherwise.
  let _pdfjs = null;
  function loadPdfJs() {
    if (_pdfjs) return _pdfjs;
    _pdfjs = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        res(window.pdfjsLib);
      };
      s.onerror = () => { _pdfjs = null; rej(new Error("pdf.js couldn't load — paste the text instead.")); };
      document.head.appendChild(s);
    });
    return _pdfjs;
  }

  async function pdfToText(file) {
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      // rebuild visual LINES by Y position so a course code and its grade
      // stay on one line (transcripts are two-column — same-row merge is fine
      // for parsing: each code's own hours/grade come first on its row)
      const rows = new Map();
      tc.items.forEach(it => {
        const y = Math.round(it.transform[5]);
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push(it);
      });
      [...rows.keys()].sort((a, b) => b - a).forEach(y => {
        out.push(rows.get(y).sort((a, b) => a.transform[4] - b.transform[4]).map(it => it.str).join(" "));
      });
    }
    return out.join("\n");
  }

  function renderScanResult(scan) {
    const box = $("#tiResult");
    const total = scan.graded.length + scan.inProgress.length + scan.excluded.length;
    if (!total) {
      box.innerHTML = `<p class="ti-none">No BYU courses recognized — make sure you pasted the transcript/MyMAP text itself.</p>`;
      return;
    }
    const row = (e, group, checked, disabled) => {
      const c = DATA.courses[e.id];
      const already = wiz.completed.includes(e.id);
      return `<label class="ti-row-item ${disabled || already ? "off" : ""}">
        <input type="checkbox" data-id="${esc(e.id)}"
          ${already ? "checked disabled" : checked ? "checked" : ""} ${disabled ? "disabled" : ""}>
        <b>${esc(e.id)}</b><span>${esc(c ? c.name : "")}</span>
        <i>${already ? "already added" : ""}</i>
      </label>`;
    };
    box.innerHTML = `
      ${scan.graded.length ? `<div class="ti-group"><h5>Completed — graded / transfer / AP (${scan.graded.length})</h5>
        ${scan.graded.map(e => row(e, "done", true, false)).join("")}</div>` : ""}
      ${scan.inProgress.length ? `<div class="ti-group"><h5>No grade yet — in progress or future semesters (${scan.inProgress.length})</h5>
        <p class="ti-hint">Check only what you'll finish BEFORE this plan starts.</p>
        ${scan.inProgress.map(e => row(e, "prog", false, false)).join("")}</div>` : ""}
      ${scan.excluded.length ? `<div class="ti-group"><h5>Not counted — withdrawn / failed (${scan.excluded.length})</h5>
        ${scan.excluded.map(e => row(e, "bad", false, true)).join("")}</div>` : ""}
      ${(scan.unknown || []).length ? `<p class="ti-hint"><i class="fas fa-circle-info"></i> Not in the current catalog (likely discontinued — the credits still count toward your total, but they can't fill current requirements): ${scan.unknown.map(esc).join(", ")}</p>` : ""}
      <button class="btn primary sm" id="tiAdd"><i class="fas fa-plus"></i> Add selected to completed courses</button>`;
    $("#tiAdd").onclick = () => {
      let n = 0;
      box.querySelectorAll("input[type=checkbox]:checked:not(:disabled)").forEach(cb => {
        const id = cb.dataset.id;
        if (!wiz.completed.includes(id)) { wiz.completed.push(id); n++; }
      });
      renderWizard();
      toast(`${n} course${n === 1 ? "" : "s"} imported from your transcript.`, "ok");
    };
  }

  function renderWizard() {
    const steps = ["Programs", "History", "Constraints"];
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
        <div id="wsCerts"></div>`;
      searchSelect("#wsMajor", DATA.majors, wiz.majorId ? [wiz.majorId] : [], 1, ids => wiz.majorId = ids[0] || null);
      searchSelect("#wsMinors", DATA.minors, wiz.minorIds, 2, ids => wiz.minorIds = ids);
      searchSelect("#wsCerts", DATA.certs, wiz.certIds, 8, ids => wiz.certIds = ids);
    }
    if (wizStep === 1) {
      const years = [2024, 2025, 2026, 2027, 2028];
      b.innerHTML = `
        <label class="wiz-lbl">First planned semester</label>
        <div class="wiz-row">
          <select id="wsSeason">${["F", "W", "S", "U"].map(s => `<option value="${s}" ${wiz.startTerm.season === s ? "selected" : ""}>${Solver.SEASON_NAME[s]}</option>`).join("")}</select>
          <select id="wsYear">${years.map(y => `<option ${wiz.startTerm.year === y ? "selected" : ""}>${y}</option>`).join("")}</select>
        </div>
        <label class="wiz-lbl">Import from your transcript <span class="wiz-sub">(fastest — paste from MyMAP or the transcript preview, or upload the PDF)</span></label>
        <div class="ti-box">
          <textarea id="tiText" rows="4" placeholder="Paste your transcript text or MyMAP academic summary here — every course code is matched against the real BYU catalog."></textarea>
          <div class="ti-actions">
            <button class="btn primary sm" id="tiScan"><i class="fas fa-magnifying-glass"></i> Scan for courses</button>
            <label class="btn ghost sm ti-file"><i class="fas fa-file-pdf"></i> Upload transcript PDF
              <input type="file" id="tiFile" accept=".pdf,.txt" hidden></label>
            <span class="ti-status" id="tiStatus"></span>
          </div>
          <div id="tiResult"></div>
        </div>
        <label class="wiz-lbl">Quick-add common courses <span class="wiz-sub">(tap to toggle)</span></label>
        <div class="chip-row">${DATA.commonCompleted.map(id => `
          <button class="chip toggle ${wiz.completed.includes(id) ? "on" : ""}" data-c="${esc(id)}">${esc(id)}</button>`).join("")}
        </div>
        <label class="wiz-lbl">Search the catalog to add more</label>
        <input type="text" id="wsAddCourse" placeholder="Search ${Object.keys(DATA.courses).length.toLocaleString()} BYU courses — e.g. GSCM 201, Human Development…" autocomplete="off">
        <div class="ss-list" id="wsAddList" hidden></div>
        <label class="wiz-lbl">Completed courses</label>
        <div class="done-list" id="wsDoneList">${wiz.completed.length ? wiz.completed.map(id => {
          const c = DATA.courses[id];
          return `<div class="done-row" data-c="${esc(id)}">
            <span class="done-code">${esc(codeLabel(id))}</span>
            <span class="done-name">${esc(c ? c.name : "—")}</span>
            <button class="done-x" data-rm="${esc(id)}" title="Remove">×</button>
          </div>`;
        }).join("") : `<p class="done-empty">No completed courses yet — add them above so the planner skips them.</p>`}</div>`;
      $$("#wizBody .chip.toggle").forEach(ch => ch.addEventListener("click", () => {
        const id = ch.dataset.c;
        if (wiz.completed.includes(id)) wiz.completed = wiz.completed.filter(x => x !== id);
        else wiz.completed.push(id);
        renderWizard();
      }));
      $$("#wsDoneList .done-x").forEach(x => x.addEventListener("click", () => {
        wiz.completed = wiz.completed.filter(c => c !== x.dataset.rm);
        renderWizard();
      }));
      $("#wsSeason").onchange = e => { wiz.startTerm.season = e.target.value; };
      $("#wsYear").onchange = e => { wiz.startTerm.year = parseInt(e.target.value, 10); };
      // transcript import: paste-and-scan, or PDF -> text -> same scanner
      $("#tiScan").onclick = () => {
        const t = $("#tiText").value;
        if (t.trim().length < 20) { $("#tiStatus").textContent = "Paste your transcript text first."; return; }
        $("#tiStatus").textContent = "";
        renderScanResult(scanTranscript(t));
      };
      $("#tiFile").addEventListener("change", async e => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const status = $("#tiStatus");
        try {
          let text;
          if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
            status.textContent = "Reading PDF…";
            text = await pdfToText(file);
          } else {
            text = await file.text();
          }
          $("#tiText").value = text;
          status.textContent = `Read ${file.name}.`;
          renderScanResult(scanTranscript(text));
        } catch (err) {
          status.textContent = String(err.message || err);
        }
      });
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
          <button class="ss-item" data-code="${esc(code)}"><b>${esc(codeLabel(code))}</b><span>${esc(c.name)} · ${c.credits} cr</span></button>`).join("")
          || `<div class="ss-empty">No catalog match — only real BYU courses can be marked completed.</div>`;
        addList.hidden = false;
        addList.querySelectorAll(".ss-item").forEach(it => it.addEventListener("click", () => {
          wiz.completed.push(it.dataset.code);
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
        </div>
        ${gradTargetControls(wiz, "wcTargetSeason", "wcTargetYear")}
        <p class="wiz-hint"><i class="fas fa-lightbulb"></i> Spring and Summer terms are optional — turning them on lets the planner finish sooner, at the cost of a shorter break.</p>`;
    }
    $("#wizBack").style.visibility = wizStep === 0 ? "hidden" : "visible";
    $("#wizNext").innerHTML = wizStep === 2 ? `<i class="fas fa-wand-magic-sparkles"></i> Generate plan` : `Next <i class="fas fa-arrow-right"></i>`;
  }

  function wizardCollect() {
    if (wizStep === 2) {
      Object.assign(wiz.settings, {
        maxCreditsFW: parseInt($("#wcMaxFW").value, 10) || 16,
        maxCreditsSpSu: parseInt($("#wcMaxSS").value, 10) || 8,
        allowSpring: $("#wcSpring").checked, allowSummer: $("#wcSummer").checked,
        scholarshipFullTime: $("#wcSchol").checked, religionPacing: $("#wcRel").checked,
        targetGrad: readGradTarget("wcTargetSeason", "wcTargetYear"),
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
        <div class="ss-inrow">
          <input type="text" class="ss-input" placeholder="Search ${items.length} programs…">
          <button type="button" class="btn ghost sm ss-browse"><i class="fas fa-list"></i> Browse all</button>
        </div>
        <div class="ss-list" hidden></div>`;
      const input = root.querySelector(".ss-input");
      const list = root.querySelector(".ss-list");
      const itemHtml = p => `
          <button class="ss-item" data-id="${esc(p.id)}">
            <b>${esc(p.name)}</b>
            <span>${esc(p.college || "")}${p.detailed ? "" : " · placeholder"}</span>
          </button>`;
      const wireItems = () => list.querySelectorAll(".ss-item").forEach(it => it.addEventListener("click", () => {
        if (chosen.length >= max) chosen = max === 1 ? [] : chosen.slice(0, max - 1);
        chosen.push(it.dataset.id);
        onChange(chosen); draw();
      }));
      input.addEventListener("input", () => {
        const q = input.value.trim().toLowerCase();
        if (!q) { list.hidden = true; return; }
        const hits = items.filter(p => p.name.toLowerCase().includes(q) && !chosen.includes(p.id)).slice(0, 12);
        list.innerHTML = hits.map(itemHtml).join("") || `<div class="ss-empty">No matches</div>`;
        list.hidden = false;
        wireItems();
      });
      // Tester request: "a list of majors/minors/certificates people can look
      // through before they begin searching." Grouped by college, scrollable,
      // same click-to-select as search hits.
      root.querySelector(".ss-browse").addEventListener("click", () => {
        if (!list.hidden && list.dataset.mode === "browse") { list.hidden = true; return; }
        const byCol = new Map();
        items.filter(p => !chosen.includes(p.id)).forEach(p => {
          const k = p.college || "Other";
          if (!byCol.has(k)) byCol.set(k, []);
          byCol.get(k).push(p);
        });
        list.innerHTML = [...byCol.keys()].sort().map(col => `
          <div class="ss-group">${esc(col)}</div>
          ${byCol.get(col).sort((a, b) => a.name.localeCompare(b.name)).map(itemHtml).join("")}`).join("");
        list.dataset.mode = "browse";
        list.hidden = false;
        wireItems();
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

    // collapsible side panels (state persisted across visits)
    const uiPrefs = (() => { try { return JSON.parse(localStorage.getItem("myplanbyu.ui")) || {}; } catch { return {}; } })();
    const wireCollapse = (btnSel, panelSel, key) => {
      const btn = $(btnSel), panel = $(panelSel);
      if (!btn || !panel) return;
      panel.classList.toggle("collapsed", !!uiPrefs[key]);
      btn.addEventListener("click", () => {
        uiPrefs[key] = !panel.classList.contains("collapsed");
        panel.classList.toggle("collapsed", uiPrefs[key]);
        // a collapsed panel that can't be remembered is not worth an error
        try { localStorage.setItem("myplanbyu.ui", JSON.stringify(uiPrefs)); } catch (e) { /* ignore */ }
      });
    };
    wireCollapse("#collapseLeft", "#panelLeft", "leftCollapsed");
    wireCollapse("#collapseRight", "#panelRight", "rightCollapsed");

    $("#newPlanBtn").addEventListener("click", () => openWizard());
    $("#wizBack").addEventListener("click", () => { wizardCollect(); if (wizStep > 0) { wizStep--; renderWizard(); } });
    $("#wizNext").addEventListener("click", () => {
      wizardCollect();
      if (wizStep === 0 && !wiz.majorId) { toast("Pick a major first."); return; }
      if (wizStep < 2) { wizStep++; renderWizard(); return; }
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
    $("#navFeedback").addEventListener("click", e => { e.preventDefault(); openFeedback(); });
    $("#footFeedback").addEventListener("click", e => { e.preventDefault(); openFeedback(); });

    /* CATALOG AGE. The scraper refreshes this data on a schedule; if it ever
       stops, the site would keep serving last year's requirements with total
       confidence and no one would know. Printing the date makes a silent
       failure visible, and says plainly when it's stale enough to double-check
       against the live catalog. It lives in the notice bar rather than the
       footer because phones hide the footer — and phones are most of the
       audience. */
    (() => {
      const el = $("#dataStamp");
      const stamp = typeof CATALOG_DATA !== "undefined" && CATALOG_DATA.generated;
      if (!el || !stamp) return;
      const when = new Date(stamp + "T00:00:00");
      if (isNaN(when)) return;
      const days = Math.floor((Date.now() - when) / 86400000);
      const nice = when.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
      el.textContent = `Catalog data from ${nice}.`;
      if (days > 120) {
        el.textContent += " Requirements may have changed since — check catalog.byu.edu.";
        el.className = "data-stale";
      }
      el.title = `Generated from catalog.byu.edu on ${nice} (${days} day${days === 1 ? "" : "s"} ago).`;
    })();
    $("#fbSend").addEventListener("click", submitFeedback);
    $("#fbCopy").addEventListener("click", () => copyFeedback());
    $("#refreshBtn").addEventListener("click", () => { solveActive(); toast("Re-optimized.", "ok"); });

    // Plan Options dropdown
    $("#planOptionsBtn").addEventListener("click", e => {
      e.stopPropagation();
      closeMenus();
      const menu = document.createElement("div");
      menu.className = "ctx-menu";
      const nRemoved = (activePlan()?.profile.excluded || []).length;
      menu.innerHTML = `
        <button data-a="opt"><i class="fas fa-rotate"></i> Re-optimize</button>
        <button data-a="whatif"><i class="fas fa-code-compare"></i> What if… (compare a change)</button>
        <button data-a="shuffle"><i class="fas fa-dice"></i> Try an alternative</button>
        <button data-a="prio"><i class="fas fa-sliders"></i> Constraints…</button>
        <button data-a="pins"><i class="fas fa-thumbtack-slash"></i> Clear manual pins</button>
        <button data-a="restore" ${nRemoved ? "" : 'class="ctx-dim"'}><i class="fas fa-trash-arrow-up"></i> Restore removed${nRemoved ? ` (${nRemoved})` : ""}</button>
        <button data-a="print"><i class="fas fa-print"></i> Print / PDF</button>`;
      document.body.appendChild(menu);
      const r = e.currentTarget.getBoundingClientRect();
      menu.style.top = (r.bottom + 6) + "px";
      menu.style.left = Math.min(window.innerWidth - 240, r.left) + "px";
      menu.addEventListener("click", ev => {
        const a = ev.target.closest("button")?.dataset.a;
        closeMenus();
        if (a === "opt") { solveActive({ fresh: true }); toast("Re-optimized.", "ok"); }
        if (a === "whatif") openWhatIf();
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
        if (a === "restore") {
          const plan = activePlan();
          // The item is ALWAYS in the menu now — the course modal names it as
          // the undo path, and an option that only exists once you have
          // removed something reads as a broken reference (tester report).
          // With nothing removed it answers honestly instead of no-op'ing.
          if (!plan || !(plan.profile.excluded || []).length) {
            toast("Nothing has been removed from this plan.", "ok");
          } else {
            plan.profile.excluded = []; plan.updatedAt = Date.now(); save();
            solveActive(); toast("Restored all removed courses.", "ok");
          }
        }
        if (a === "print") printPlan();
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

    // mid-degree context: the advisor must know what's already done
    const done = plan.profile.completed || [];
    if (done.length) {
      const doneCr = done.reduce((s, id) => s + (DATA.courses[id]?.credits ?? 3), 0);
      lines.push(`Already completed BEFORE this plan: ${done.length} courses / ~${Math.round(doneCr)} credits (${done.slice(0, 24).join(", ")}${done.length > 24 ? ", …" : ""}). These are DONE — never suggest scheduling them; prerequisites they satisfy are satisfied.`);
    }

    // HOW TO READ THIS PLAN — semantics the advisor keeps getting wrong
    // without them (placeholders read as extra hours, envelopes read as
    // student choices, religion pacing read as a mistake).
    lines.push(
      "HOW TO READ THIS PLAN:",
      "- 'choose a class' slots are single placeholder cards (credits shown) ALREADY counted in the term totals — a label like 'Complete 15 hours' names the whole catalog requirement, NOT extra load that term.",
      "- Repeatable courses ('take 2/6') enroll once per semester by rule.",
      "- Religion is deliberately spread ~2 cr per semester (BYU norm) — do not suggest clustering it.",
      "- The planner has already verified every prerequisite chain and season offering against the live BYU catalog; the sequencing shown is valid unless a warning below says otherwise. Do not ask the student to re-verify prerequisites you cannot see.");

    // WHY THE PLAN LOOKS THIS WAY — the solver's own decision log, so the
    // advisor answers "why is X in semester N?" from facts, not guesses.
    if ((result.planNotes || []).length) {
      lines.push("WHY THE PLAN LOOKS THIS WAY (solver's own reasoning — cite these when asked why):");
      result.planNotes.forEach(n => lines.push("- " + n));
    }
    const whyLines = [];
    (result.placements || []).forEach(p => {
      (p.why || []).forEach(w => {
        // only the load-bearing reasons; sheet/slot provenance is implied above
        if (whyLines.length < 14 && /prerequisite|admission|Only taught|Woven|chain|Pinned/.test(w)) {
          whyLines.push(`- ${p.display} (${result.terms[p.termIndex].label}): ${w}`);
        }
      });
    });
    if (whyLines.length) {
      lines.push("Placement notes for specific courses:");
      lines.push(...whyLines);
    }
    // WHO TEACHES WHAT — from BYU's public class schedule. The advisor used to
    // have to send every "who teaches X / which professor should I take"
    // question away to two other websites. For the terms BYU has actually
    // posted it can now answer, and the term label travels with the names so
    // it can never present a Fall roster as if it were next Winter's. Capped
    // and restricted to courses IN THIS PLAN — the point is the student's own
    // classes, not a directory dump.
    if (typeof SCHEDULE !== "undefined" && SCHEDULE.terms && SCHEDULE.terms.length) {
      const rows = [];
      (result.placements || []).forEach(p => {
        if (rows.length >= 25 || p.placeholder) return;
        // THE SCHEDULED TERM'S roster first. The first cut walked the posted
        // terms newest-first and stopped at the first hit, so ACC 200 —
        // scheduled Fall 2026, taught BOTH posted terms — was reported only
        // with its Winter 2027 roster, and the advisor truthfully told the
        // student Fall 2026 "wasn't posted" while the Fall roster sat unread
        // in our own data. The term the plan schedules is the one the student
        // is asking about; it wins whenever it is posted.
        const tm = result.terms[p.termIndex];
        const code = tm ? `${tm.year}${({ W: "1", S: "3", U: "4", F: "5" })[tm.season] || ""}` : null;
        const nm = idx => idx.slice(0, 6).map(i => SCHEDULE.names[i]).join(", ");
        const own = code && (SCHEDULE.byTerm[code] || {})[p.courseId];
        if (own && own.length) {
          rows.push(`- ${p.courseId} (${tm.label}, CONFIRMED — the same term the plan schedules it): ${nm(own)}`);
          return;
        }
        for (const t of SCHEDULE.terms) {
          const idx = (SCHEDULE.byTerm[t.code] || {})[p.courseId];
          if (idx && idx.length) {
            rows.push(`- ${p.courseId} (plan takes it ${tm ? tm.label : "later"}, which isn't posted; `
              + `CONFIRMED for ${t.label} only): ${nm(idx)}`);
            return;
          }
        }
        // Past terms, clearly marked as a pattern rather than an assignment —
        // the advisor must never turn "has taught it four years running" into
        // "will be teaching it", which is a promise BYU has not made.
        const h = (SCHEDULE.historic || {})[p.courseId];
        if (h && h.length) {
          rows.push(`- ${p.courseId} (HISTORICAL, not yet posted): usually `
            + h.slice(0, 3).map(([i, n]) => `${SCHEDULE.names[i]} (${n} of last `
              + `${(SCHEDULE.historyTerms || []).length} Fall/Winter terms)`).join(", "));
        }
      });
      if (rows.length) {
        lines.push(`INSTRUCTORS ON RECORD (BYU's public class schedule, scraped ${SCHEDULE.scraped}; `
          + `only ${SCHEDULE.terms.map(t => t.label).join(" and ")} are posted). `
          + `Rows marked CONFIRMED are sections BYU has actually published — ALWAYS say which term `
          + `a name belongs to, and when the row is CONFIRMED for the very term the student asks `
          + `about, ANSWER with those names directly instead of sending them to look it up. `
          + `Rows marked HISTORICAL are who taught it in PAST terms: report them `
          + `as a pattern ("has taught it 3 of the last 4 years"), NEVER as who will teach it, `
          + `because BYU has not assigned that term yet. If a course appears in neither list, say it `
          + `isn't posted yet rather than that it has no instructor. `
          + `For opinions on a professor, point the student to Rate My Professors and search the NAME.`);
        lines.push(...rows);
      }
    }

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

    // Co-requisites among the planned courses. "Do any of my classes have a lab
    // I have to register for at the same time?" is a routine registration
    // question, and the advisor used to burn its web searches and then tell the
    // student to look up 21 course pages by hand — while DATA.coreqs held the
    // answer (ME EN 330 + ME EN 335) the whole time. The solver already keeps
    // these together; say so, so the advisor can just answer.
    {
      const planned = new Set(result.placements.map(p => p.courseId));
      const pairs = [];
      Object.entries(DATA.coreqs || {}).forEach(([code, mates]) => {
        if (!planned.has(code)) return;
        const inPlan = (mates || []).filter(m => planned.has(m));
        if (inPlan.length) pairs.push(`${code} + ${inPlan.join(" + ")}`);
      });
      if (pairs.length) {
        lines.push("MUST REGISTER TOGETHER (co-requisites — same semester, and the "
          + "planner has already placed them together): " + pairs.join("; "));
      }
    }

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

    const tg = plan.profile.settings && plan.profile.settings.targetGrad;
    if (tg && tg.year) {
      // Say that the date CHANGED THE SEMESTER LOADS, not just the end point.
      // Without this the advisor sees 12-credit semesters, reads them as the
      // planner underloading the student, and offers to "fix" the thing the
      // student deliberately asked for.
      const fw = (result.terms || []).filter(t => t.isFW);
      const used = new Map();
      (result.placements || []).forEach(p => used.set(p.termIndex, (used.get(p.termIndex) || 0) + (p.credits || 0)));
      const act = fw.filter(t => used.has(t.index));
      const per = act.length
        ? (act.reduce((s, t) => s + used.get(t.index), 0) / act.length).toFixed(1) : null;
      lines.push(`STUDENT'S GRADUATION TARGET: ${tg.season === "W" ? "Winter" : "Fall"} ${tg.year} — the student chose this date, and the planner PACED THE WHOLE PLAN to it`
        + (per ? `: ${act.length} Fall/Winter semesters averaging ${per} credits each` : "")
        + `. A light semester here is the student's own choice, not an error — do not advise "adding more classes" to a paced plan unless they ask to finish sooner. Courses that could not fit by the date are listed as unscheduled below.`);
    }
    if (result.unscheduled?.length) {
      // Spell out what this list MEANS. As a bare "Unscheduled: <name>" the AI
      // advisor read it as a list of optional extras and told a nursing student
      // they could "skip" NURS 404 and stay Fall/Winter — it is a required
      // clinical, and skipping it means not graduating. Give the course CODE
      // too: the advisor quoted "Cl Prac Glob & Pop Hlth Nurs", which a student
      // cannot look up or register for.
      lines.push("REQUIRED BUT NOT YET SCHEDULED — degree requirements the planner "
        + "could NOT place. These are NOT optional and NOT droppable; the student "
        + "cannot graduate without them, so never suggest skipping one. The usual "
        + "fix is enabling a Spring/Summer term (the app offers a one-click action) "
        + "or raising the credit cap: "
        + result.unscheduled.map(u => `${u.uid} (${u.name})`).join(", "));
    }

    // deadlines & opportunities (timeline layer) — so the advisor can answer
    // "when do I apply / what scholarships or study abroad fit me?" factually
    if (timeline.deadlines.length) {
      lines.push("KEY DEADLINES (from BYU calendars + limited-enrollment admission notes — cite these):");
      timeline.deadlines.slice(0, 6).forEach(e =>
        lines.push(`- [${e.when}] ${e.title}${e.detail ? `: ${e.detail}` : ""}`.slice(0, 240)));
    }
    // curated admission requirements for this student's limited-enrollment
    // program(s) — verbatim from the department, so the advisor answers
    // "what do I need to apply?" accurately
    (result.programs || []).forEach(pid => {
      const req = (typeof TIMELINE !== "undefined" && TIMELINE.admissionReqs) ? TIMELINE.admissionReqs[pid] : null;
      if (!req) return;
      const nm = (DATA.programIndex[pid]?.name || pid).replace(/\s*\(.*\)$/, "");
      lines.push(`ADMISSION REQUIREMENTS — ${nm} (from ${req.url || "the department"}):`);
      (req.prereqs || []).forEach(p => lines.push(`- prerequisite: ${p}`));
      (req.criteria || []).forEach(c => lines.push(`- ${c}`));
    });
    if (timeline.recs.length) {
      lines.push("PLANNER RECOMMENDATIONS shown to the student (agree with or refine these, don't contradict them blindly):");
      timeline.recs.forEach(r => lines.push(`- ${r.title} ${r.detail || ""}`.slice(0, 240)));
    }
    if (timeline.schols.length) {
      lines.push("RELEVANT SCHOLARSHIPS for this student (deadlines recur annually):");
      timeline.schols.slice(0, 6).forEach(s =>
        lines.push(`- ${s.name} [due ${s.when}${s.gpa ? `; ${s.gpa}+ GPA` : ""}]${s.collegeMatch ? " (their college)" : ""}`.slice(0, 200)));
    }
    if (timeline.abroad.length) {
      lines.push(`STUDY ABROAD matched to this student's college (${timeline.abroad.length} total): ` +
        timeline.abroad.slice(0, 4).map(p => p.name).join("; ") + (timeline.abroad.length > 4 ? "; …" : ""));
    }
    const warns = (result.flags || []).filter(f => f.level === "warn").slice(0, 4);
    if (warns.length) lines.push("Planner warnings: " + warns.map(f => f.text).join(" | "));

    return lines.join("\n").slice(0, 7800);   // server MAX_PLAN_CHARS = 8000
  }

  return { init, planSummary, openWhatIf, scanTranscript };
})();

document.addEventListener("DOMContentLoaded", App.init);
