/* =========================================================================
   myplanBYU — tests/taxonomy.js
   Failure taxonomy: "where is this BAD?", not "where is this BROKEN?"

   invariants.js checks rules written down in advance, so it can only find
   problems someone already thought to describe. This file asks the other
   question: it solves every major against a matrix of plausible student
   starting states, then RANKS the output by how bad the plan looks to the
   person reading it.

   Nothing here is illegal. A plan that strands a student in a 4-credit
   semester, or leaves a hole in the middle of their degree, or pads three
   terms with generic electives, breaks no rule in invariants.js — it just
   makes someone close the tab. You cannot enumerate that in advance; you
   generate a lot of output and sort it.

   Output is a ranked list of SYMPTOMS, each with the combinations that
   produce it, so a fix session can start at the top and work down.
   ========================================================================= */
"use strict";

const Taxonomy = (() => {

  /* Is this course taught ONLY in seasons the plan has switched off? That is
     the RECOVERABLE class of unscheduled — one setting change fixes it, and
     app.js already offers that change as a one-click action. */
  function seasonOnly(result, uid) {
    const base = String(uid).split("#")[0];
    const cat = (result.state && result.state.cat) || {};
    const c = cat[base] || (typeof DATA !== "undefined" && DATA.courses[base]);
    if (!c || !c.off) return false;
    if (/[FW]/.test(c.off)) return false;          // taught in a term already in use
    const s = (result.state && result.state.profile && result.state.profile.settings) || {};
    if (s.allowSpring && c.off.includes("S")) return false;
    if (s.allowSummer && c.off.includes("U")) return false;
    return true;
  }

  /* ---- the student states worth crossing every major with --------------
     Chosen because each one drives a different branch in solve(): a true
     freshman gets the first-term pacing cap, earned credits move the MAP
     sheet binding cursor, a minor adds bucket-cover pressure and puts the
     double-count cap in play, and year-round changes the term canvas. */
  const STATES = [
    { key: "fresh",     label: "true freshman",        apply: () => ({}) },
    { key: "sophomore", label: "sophomore (30 cr)",    apply: () => ({ completed: Cases.SOPHOMORE }) },
    { key: "minor",     label: "+ business minor",     apply: () => ({ minorIds: ["minor-business"] }) },
    { key: "yearround", label: "year-round",           apply: () => ({ settings: { allowSpring: true, allowSummer: true } }) },
  ];

  /* ---- symptoms -------------------------------------------------------
     weight drives the ranking. These are judgement calls, deliberately
     visible in one place so they can be argued with and retuned. */
  const SYMPTOMS = [
    {
      key: "no-plan", weight: 100,
      title: "No plan produced",
      why: "The solver returned nothing. There is no recovery for the student.",
      detect: (r) => (!r || !r.placements.length) ? "solver returned no placements" : null,
    },
    {
      // Split from the old single "unscheduled" symptom, which over-counted
      // badly. A course offered ONLY in Spring/Summer cannot be placed while
      // those terms are off - but that is a CONSTRAINT the student chose, and
      // app.js already surfaces a one-click "Add a Spring term" action for it
      // (see the spsuOnly recommendation) plus an error flag naming the
      // course. Nothing is silently lost, so it does not deserve the same
      // weight as a course that is genuinely stuck.
      key: "unscheduled-blocked", weight: 40,
      title: "Required course never scheduled, with no way out",
      why: "The course is taught in a term the plan already uses, so the student has no setting to change - this is a real scheduling failure.",
      detect: (r) => {
        const stuck = r.unscheduled.filter(u => !seasonOnly(r, u.uid));
        return stuck.length
          ? `${stuck.length} unplaced: ${stuck.map(u => u.uid).join(", ")}` : null;
      },
    },
    {
      key: "unscheduled-needs-season", weight: 12,
      title: "Required course needs a Spring/Summer term the plan does not have",
      why: "Recoverable: the app already offers a one-click 'Add a Spring term'. Worth knowing because the degree cannot be finished on Fall/Winter alone.",
      detect: (r) => {
        const s = r.unscheduled.filter(u => seasonOnly(r, u.uid));
        return s.length
          ? `${s.map(u => u.uid).join(", ")} — taught Spring/Summer only` : null;
      },
    },
    {
      key: "gap-term", weight: 30,
      title: "Empty semester in the middle of the plan",
      why: "An enabled semester with nothing in it, surrounded by full ones. Reads as a bug, and costs a semester of tuition.",
      detect: (r, ctx) => {
        const holes = ctx.enabledFW.filter(t =>
          t > ctx.firstTerm && t < ctx.lastTerm && !ctx.load.has(t));
        return holes.length ? `empty: ${holes.map(t => r.terms[t].label).join(", ")}` : null;
      },
    },
    {
      key: "too-long", weight: 25,
      title: "Plan runs past 10 semesters",
      why: "The solver's own budget targets 8-10 Fall/Winter terms. Past that it has given up on the shape.",
      detect: (r, ctx) => ctx.fwUsed > 10 ? `${ctx.fwUsed} Fall/Winter semesters` : null,
    },
    {
      // BYU's registration cap is 18 credits; above that a student cannot
      // enroll without a petition, so the plan is not merely heavy, it is
      // impossible to act on. Distinct from the credit-cap invariant, which
      // only measures against the profile's own 17-credit preference.
      key: "unregistrable-term", weight: 35,
      title: "Term above BYU's 18-credit registration cap",
      why: "The student cannot register for this semester at all without a petition.",
      detect: (r, ctx) => {
        const bad = [];
        ctx.load.forEach((cr, t) => {
          if (!r.terms[t].isFW || cr <= 18) return;
          const sheet = ctx.pinnedLoad.get(t) || 0;
          bad.push(`${r.terms[t].label}: ${+cr.toFixed(1)} cr`
            + (sheet >= cr / 2 ? " (from the MAP sheet's own printed total)" : ""));
        });
        return bad.length ? bad.join("; ") : null;
      },
    },
    {
      // Calibrated against the real distribution: across all 175 majors the
      // lowest non-final Fall/Winter term sits at 12 credits, so this fires
      // only if something regresses. That is the point - it is a floor guard,
      // and 12 is BYU's full-time threshold, below which aid is at risk.
      key: "below-full-time", weight: 20,
      title: "Non-final semester below full-time (12 credits)",
      why: "Drops the student under full-time enrollment, which can cost scholarships and aid.",
      detect: (r, ctx) => {
        const bad = [];
        ctx.load.forEach((cr, t) => {
          if (!r.terms[t].isFW || t === ctx.lastTerm) return;
          // a sheet term follows its own printed total, even a light one
          if ((ctx.pinnedLoad.get(t) || 0) >= cr / 2) return;
          if (cr < 12) bad.push(`${r.terms[t].label} (${+cr.toFixed(1)} cr)`);
        });
        return bad.length ? bad.join(", ") : null;
      },
    },
    {
      // NOT excluding sheet-driven terms here, unlike the two above. An
      // earlier version skipped any term containing a pinned course, which
      // silently disabled this detector: 272 of 289 terms contain one. Whose
      // fault the imbalance is belongs in the message, not in a filter that
      // makes the symptom invisible.
      key: "lumpy", weight: 12,
      title: "Wildly uneven load across semesters",
      why: "A 17-credit term beside a 9-credit one. Legal, but nobody plans a degree that way.",
      detect: (r, ctx) => {
        const fw = [...ctx.load.entries()]
          .filter(([t]) => r.terms[t].isFW && t !== ctx.lastTerm)
          .map(([, cr]) => cr);
        if (fw.length < 3) return null;
        const hi = Math.max(...fw), lo = Math.min(...fw);
        return (hi - lo) >= 8 ? `spread ${+lo.toFixed(1)}-${+hi.toFixed(1)} credits` : null;
      },
    },
    {
      // ELECTIVE+ ONLY, never "ELECTIVE n". The two look identical in the UI
      // (both display as "ELECTIVE") but mean opposite things:
      //   ELECTIVE n   - open elective HOURS the degree genuinely requires.
      //                  A BGS with 18 of them is correct, not broken; counting
      //                  those produced 252 hits across 114 majors and buried
      //                  every real finding under a property of the degree.
      //   ELECTIVE+ t.n - floor padding solver.js injects to drag a term up to
      //                  the 14-credit minimum, marked "disposable" in its own
      //                  source. That IS the solver admitting it had nothing
      //                  real to schedule.
      // Threshold 3, not 2: a couple of filler slots is ordinary tail-end
      // behaviour and fires on 150 of 175 majors, which ranks everything and
      // therefore ranks nothing. Weight is low for the same reason - padding
      // is most useful as a co-symptom (it lands with `unscheduled` in 14 of
      // the worst 25 combinations) rather than as a defect on its own.
      key: "floor-padding", weight: 6,
      title: "Semester propped up with filler to reach full-time",
      why: "The solver had no real course to place and injected disposable padding to reach the credit floor.",
      detect: (r) => {
        const pad = r.placements.filter(p => /^ELECTIVE\+/.test(p.courseId));
        if (pad.length < 3) return null;
        const terms = [...new Set(pad.map(p => r.terms[p.termIndex] && r.terms[p.termIndex].label))];
        return `${pad.length} filler slots in ${terms.join(", ")}`;
      },
    },
    {
      // EXCLUDES sheet-pinned cards, and that exclusion is the whole finding.
      // Korean's own MAP sheet names ONE language course per term for three
      // years and then eight courses across year four; Japanese and Spanish
      // Translation have the same shape. Counting those flagged BYU's published
      // sequence as a solver defect - 5 of the 10 findings were the advisement
      // center's plan, faithfully reproduced, which under the sheet-wins policy
      // (solver.js widenSeason / MAP-first seeding) is the solver being RIGHT.
      //
      // Note this is the opposite of the mistake in the uneven-load rule (see
      // README / HANDOFF section 7): there the filter excluded whole TERMS that
      // merely contained a sheet course, which silenced the detector across 272
      // of 289 terms. Here it excludes individual PINNED CARDS, which is exactly
      // the set the solver did not choose. What survives is real: English (BA)
      // leaves years 1-3 holding abstract "choose a course" slots and backfills
      // every named ENGL course into the last three terms.
      key: "backloaded", weight: 8,
      title: "Major courses crammed into the final year",
      why: "Half the major's own courses in the last two terms, and the solver put them there - the MAP sheet did not. Fragile: one missed offering pushes graduation.",
      detect: (r, ctx) => {
        const major = r.placements.filter(p =>
          !p.bucket && !p.placeholder && !p.elective && !p.pinned);
        if (major.length < 12) return null;
        const late = major.filter(p => p.termIndex >= ctx.lastTerm - 1).length;
        return late / major.length >= 0.4
          ? `${late} of ${major.length} solver-placed courses in the last two terms` : null;
      },
    },
  ];

  /* precomputed per-plan context every detector shares */
  function context(result) {
    const load = new Map();
    // credits per term that came from a MAP sheet, so a detector can ask
    // "does the sheet DOMINATE this term" rather than the far blunter
    // "does the term contain any sheet course at all"
    const pinnedLoad = new Map();
    result.placements.forEach(p => {
      load.set(p.termIndex, (load.get(p.termIndex) || 0) + (p.credits || 0));
      if (p.pinned) pinnedLoad.set(p.termIndex, (pinnedLoad.get(p.termIndex) || 0) + (p.credits || 0));
    });
    const used = [...load.keys()].sort((a, b) => a - b);
    const enabledFW = result.terms.filter(t => t.isFW && t.enabled).map(t => t.index);
    return {
      load, pinnedLoad, enabledFW,
      firstTerm: used[0] ?? 0,
      lastTerm: used[used.length - 1] ?? 0,
      fwUsed: used.filter(t => result.terms[t] && result.terms[t].isFW).length,
    };
  }

  function evaluate(def, profile, result, crash) {
    const found = [];
    if (crash || !result || !result.placements.length) {
      found.push({ key: "no-plan", weight: 100, detail: crash ? crash.split("\n")[0] : "no placements" });
    } else {
      const ctx = context(result);
      SYMPTOMS.forEach(s => {
        if (s.key === "no-plan") return;
        let detail = null;
        try { detail = s.detect(result, ctx); }
        catch (e) { detail = `detector threw: ${e && e.message}`; }
        if (detail) found.push({ key: s.key, weight: s.weight, detail });
      });
    }
    return {
      id: def.id, major: def.majorName, state: def.stateLabel,
      score: found.reduce((a, s) => a + s.weight, 0),
      symptoms: found,
      terms: result ? new Set(result.placements.map(p => p.termIndex)).size : 0,
      solveMs: result ? result.solveMs : 0,
    };
  }

  /* ---- the matrix ------------------------------------------------------ */
  function matrix(opts = {}) {
    const majors = DATA.majors.slice(0, opts.limitMajors || DATA.majors.length);
    const states = STATES.filter(s => !opts.states || opts.states.includes(s.key));
    const out = [];
    majors.forEach(m => states.forEach(s => {
      out.push({
        id: `${m.id}::${s.key}`, majorId: m.id, majorName: m.name,
        stateKey: s.key, stateLabel: s.label, extra: s.apply(),
      });
    }));
    return out;
  }

  function runOne(def) {
    const profile = Cases.buildProfile({ majorId: def.majorId, name: def.majorName, ...def.extra });
    let result = null, crash = null;
    try { result = Solver.solve(profile); }
    catch (e) { crash = (e && e.stack) || String(e); }
    return evaluate(def, profile, result, crash);
  }

  /* Ranked rollup: symptom -> the combinations exhibiting it, worst first. */
  function summarize(rows, ms) {
    const bySymptom = {};
    SYMPTOMS.forEach(s => {
      const hits = rows.filter(r => r.symptoms.some(x => x.key === s.key));
      if (!hits.length) return;
      bySymptom[s.key] = {
        key: s.key, title: s.title, why: s.why, weight: s.weight,
        count: hits.length,
        majors: new Set(hits.map(h => h.major)).size,
        // worst offenders first, so a fix session has somewhere to start
        examples: hits.slice().sort((a, b) => b.score - a.score).slice(0, 8).map(h => ({
          major: h.major, state: h.state,
          detail: (h.symptoms.find(x => x.key === s.key) || {}).detail,
        })),
      };
    });
    const ranked = Object.values(bySymptom).sort((a, b) => (b.weight * b.count) - (a.weight * a.count));
    return {
      ms, combinations: rows.length,
      clean: rows.filter(r => !r.symptoms.length).length,
      affected: rows.filter(r => r.symptoms.length).length,
      symptoms: ranked,
      worst: rows.slice().sort((a, b) => b.score - a.score).filter(r => r.score > 0).slice(0, 25)
        .map(r => ({ major: r.major, state: r.state, score: r.score,
                     symptoms: r.symptoms.map(s => s.key) })),
    };
  }

  /* Synchronous: used headlessly, where a chunked loop would leave Edge
     waiting on timers it cannot resolve under --virtual-time-budget. */
  function runSync(opts = {}) {
    const t0 = performance.now();
    const rows = matrix(opts).map(runOne);
    return summarize(rows, Math.round(performance.now() - t0));
  }

  /* Chunked: used in the browser, so the page can paint progress instead of
     locking the tab for three minutes. */
  function runAsync(opts = {}, onProgress) {
    const defs = matrix(opts);
    const rows = [];
    const t0 = performance.now();
    return new Promise(resolve => {
      (function step() {
        const end = Math.min(rows.length + 12, defs.length);
        while (rows.length < end) rows.push(runOne(defs[rows.length]));
        if (onProgress) onProgress(rows.length, defs.length);
        if (rows.length < defs.length) setTimeout(step, 0);
        else resolve(summarize(rows, Math.round(performance.now() - t0)));
      })();
    });
  }

  return { STATES, SYMPTOMS, matrix, runSync, runAsync, summarize };
})();
