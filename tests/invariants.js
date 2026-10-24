/* =========================================================================
   myplanBYU — tests/invariants.js
   Rules that must hold for EVERY plan the solver emits, on every case.

   These deliberately mirror solver.js's own semantics rather than an
   idealized reading of the catalog — a test that enforces a stricter rule
   than the solver implements is a false alarm generator, and a suite that
   cries wolf gets muted. Where the solver documents a legitimate
   exception, this file encodes the same exception and downgrades the
   finding to a warning instead of dropping it:

     * MAP-sheet placements are AUTHORITATIVE. solve() locks a sheet's
       coded courses to their printed semester and bypasses season and
       prerequisite checks on purpose — a violation there is the sheet
       disagreeing with the catalog, which is real signal about the DATA,
       not a solver bug. Reported as `warn`.
     * Cohort blocks may exceed the per-term credit ceiling. The solver
       calls this a "forced exception"; so does this file.

   Severity: fail = the solver broke a rule it enforces itself.
             warn  = a documented exception fired, or the underlying data
                     is inconsistent. Worth reading, does not fail a run.
   ========================================================================= */
"use strict";

const Invariants = (() => {

  const baseId = uid => String(uid).split("#")[0];
  const instK  = uid => { const p = String(uid).split("#"); return p[1] ? +p[1] : 1; };

  /* placeholder / bucket slots stand in for "some course from this list" —
     they carry no real prerequisites and no real season restriction. */
  const isAbstract = p => !!(p.placeholder || p.bucket || p.elective);

  function courseOf(result, p) {
    const cat = (result.state && result.state.cat) || {};
    return cat[p.courseId] || (typeof DATA !== "undefined" && DATA.courses[p.courseId]) || null;
  }

  /* ---------------------------------------------------------------------
     1. PREREQUISITE ORDER
     solver.js prereqSatisfied(): groups are AND, options inside a group
     are OR, satisfied by a completed course, a cohort block-mate, or any
     instance placed STRICTLY earlier. Base prereqs bind instance #1 only.
     --------------------------------------------------------------------- */
  function prereqOrder(profile, result, out) {
    const completed = (result.state && result.state.completed) || new Set();
    // uid -> termIndex, and baseId -> earliest termIndex it appears in
    const earliest = new Map();
    result.placements.forEach(p => {
      const b = p.courseId;
      if (!earliest.has(b) || p.termIndex < earliest.get(b)) earliest.set(b, p.termIndex);
    });
    // cohort block members count as concurrent for each other
    const blockMates = new Map();   // block id -> Set(courseId)
    result.placements.forEach(p => {
      if (!p.block) return;
      if (!blockMates.has(p.block)) blockMates.set(p.block, new Set());
      blockMates.get(p.block).add(p.courseId);
    });

    result.placements.forEach(p => {
      if (isAbstract(p) || instK(p.uid) > 1) return;
      const c = courseOf(result, p);
      if (!c || !c.pre || !c.pre.length) return;
      const co = p.block ? blockMates.get(p.block) : null;

      c.pre.forEach(group => {
        const opts = Array.isArray(group) ? group : [group];
        // Mirror of solver analyze()'s sheetConcurrent exception: when the MAP
        // sheet pins BOTH a course and its prerequisite into the SAME semester
        // (Accounting's junior core runs ACC 402/405/409 alongside ACC 407),
        // that is the advisement center co-scheduling a block, and the app
        // shows an info note, not a warning. A rule that keeps flagging it
        // diverges from the app's own documented semantics — see README.
        const pinnedTogether = g => p.pinned && result.placements.some(q =>
          q.courseId === g && q.termIndex === p.termIndex && q.pinned && !isAbstract(q));
        const satisfied = opts.some(g =>
          completed.has(g) || (co && co.has(g)) || pinnedTogether(g) ||
          (earliest.has(g) && earliest.get(g) < p.termIndex));
        if (satisfied) return;

        const present = opts.some(g => earliest.has(g) || completed.has(g));
        const where = t => (result.terms[t] ? result.terms[t].label : `term ${t}`);
        const detail = opts.map(g =>
          completed.has(g) ? `${g} (completed)`
          : earliest.has(g) ? `${g} in ${where(earliest.get(g))}`
          : `${g} (absent)`).join(" OR ");

        // A prerequisite that is ABSENT from the plan is a much weaker signal
        // than one scheduled too late: BYU satisfies plenty of them by exam
        // (MATH 110 carries an ACT 22+ test-out, WRTG 150 an AP waiver), and
        // the plan legitimately omits a course the student tests out of.
        // Present-but-later is unambiguous — that plan cannot be registered.
        if (!present) {
          out.push({
            rule: "prereq-missing", severity: "warn",
            msg: `${p.courseId} in ${where(p.termIndex)} needs ${detail}`,
            detail: "prerequisite is in neither the plan nor completed work — test-out, or a gap in the catalog data",
          });
          return;
        }

        out.push({
          rule: p.pinned ? "prereq-order (MAP-locked)" : "prereq-order",
          severity: p.pinned ? "warn" : "fail",
          msg: `${p.courseId} in ${where(p.termIndex)} needs ${detail}`,
          detail: "prerequisite is in the plan but not early enough",
        });
      });
    });
  }

  /* ---------------------------------------------------------------------
     2. SEASON LEGALITY — a Fall-only course cannot sit in a Winter term.
     --------------------------------------------------------------------- */
  function seasonLegality(profile, result, out) {
    result.placements.forEach(p => {
      if (isAbstract(p)) return;
      const c = courseOf(result, p);
      const term = result.terms[p.termIndex];
      if (!c || !term || !c.off) return;
      if (c.off.includes(term.season)) return;
      out.push({
        rule: p.pinned ? "season (MAP-locked)" : "season",
        severity: p.pinned ? "warn" : "fail",
        msg: `${p.courseId} placed in ${term.label} but is offered ${c.off}`,
      });
    });
  }

  /* ---------------------------------------------------------------------
     3. CREDIT CAPS — per-term ceiling from the profile's own settings.
     Cohort blocks are the documented forced exception.
     --------------------------------------------------------------------- */
  function creditCaps(profile, result, out) {
    const load = new Map(), blocked = new Set(), mapTerm = new Set();
    result.placements.forEach(p => {
      load.set(p.termIndex, (load.get(p.termIndex) || 0) + (p.credits || 0));
      if (p.block) blocked.add(p.termIndex);
      if (p.pinned) mapTerm.add(p.termIndex);
    });
    load.forEach((cr, t) => {
      const term = result.terms[t];
      if (!term) return;
      const cap = term.isFW ? profile.settings.maxCreditsFW : profile.settings.maxCreditsSpSu;
      if (cr <= cap + 1e-9) return;
      const excused = blocked.has(t) || mapTerm.has(t);
      out.push({
        rule: excused ? "credit-cap (cohort/MAP term)" : "credit-cap",
        severity: excused ? "warn" : "fail",
        msg: `${term.label} carries ${+cr.toFixed(1)} credits, cap is ${cap}`,
      });
    });
  }

  /* ---------------------------------------------------------------------
     4. TERM VALIDITY — nothing in a disabled or out-of-range term.
     A Spring placement in a profile that never enabled Spring is a plan
     the student cannot register for.
     --------------------------------------------------------------------- */
  function termValidity(profile, result, out) {
    result.placements.forEach(p => {
      const term = result.terms[p.termIndex];
      if (!term) {
        out.push({ rule: "term-range", severity: "fail",
          msg: `${p.courseId} placed at term index ${p.termIndex}, outside the ${result.terms.length}-term canvas` });
        return;
      }
      if (!term.enabled) {
        out.push({ rule: "term-disabled", severity: "fail",
          msg: `${p.courseId} placed in ${term.label}, which is disabled in settings` });
      }
    });
  }

  /* ---------------------------------------------------------------------
     5. COMPLETED WORK IS NOT RESCHEDULED.
     --------------------------------------------------------------------- */
  function completedNotScheduled(profile, result, out) {
    const done = new Set(profile.completed || []);
    result.placements.forEach(p => {
      if (!done.has(p.courseId)) return;
      out.push({ rule: "completed-rescheduled", severity: "fail",
        msg: `${p.courseId} is marked completed but was scheduled in ${result.terms[p.termIndex] ? result.terms[p.termIndex].label : p.termIndex}` });
    });
  }

  /* ---------------------------------------------------------------------
     6. NO DUPLICATE ENROLLMENT — one uid once; a real course twice only
     when it is genuinely repeatable (repTotal).
     --------------------------------------------------------------------- */
  function noDuplicates(profile, result, out) {
    const seenUid = new Set(), byCourse = new Map();
    result.placements.forEach(p => {
      if (seenUid.has(p.uid)) {
        out.push({ rule: "duplicate-uid", severity: "fail", msg: `${p.uid} placed more than once` });
      }
      seenUid.add(p.uid);
      if (isAbstract(p)) return;
      if (!byCourse.has(p.courseId)) byCourse.set(p.courseId, []);
      byCourse.get(p.courseId).push(p);
    });
    byCourse.forEach((ps, id) => {
      if (ps.length < 2) return;
      if (ps[0].repTotal && ps.length <= ps[0].repTotal) return;
      out.push({ rule: "duplicate-course", severity: "fail",
        msg: `${id} scheduled ${ps.length}x (repeatable limit: ${ps[0].repTotal || 1})` });
    });
  }

  /* ---------------------------------------------------------------------
     7. REPEAT SEQUENCING — instance #k strictly after #k-1. Bucket slots
     are exempt unless they are religion slots (BYU one-per-semester).

     Unlike the prereq and season rules, a MAP-locked placement gets NO
     downgrade here. Those two bypasses are documented solver behaviour —
     the sheet outranks the catalog on purpose. This one is not: a sheet
     row saying "IAS 399R (6 credits over the program)" is an instruction
     to repeat the seminar across semesters, never to enroll in all six
     at once. Stacking them in one term is the skeleton's reading of the
     row, not the row's instruction, so it stays a failure.
     --------------------------------------------------------------------- */
  function repeatSequence(profile, result, out) {
    const at = new Map();
    result.placements.forEach(p => at.set(p.uid, p.termIndex));
    result.placements.forEach(p => {
      const k = instK(p.uid);
      if (k < 2) return;
      if (p.bucket && !p.isReligion) return;
      const prev = `${baseId(p.uid)}#${k - 1}`;
      if (!at.has(prev)) return;                 // earlier instance completed
      if (at.get(prev) < p.termIndex) return;
      const term = result.terms[p.termIndex];
      out.push({
        rule: p.pinned ? "repeat-sequence (MAP-locked)" : "repeat-sequence",
        severity: "fail",
        msg: at.get(prev) === p.termIndex
          ? `${p.uid} shares ${term ? term.label : p.termIndex} with ${prev} — a repeatable course is one enrollment per semester`
          : `${p.uid} is scheduled before ${prev} (terms ${p.termIndex} and ${at.get(prev)})`,
      });
    });
  }

  /* ---------------------------------------------------------------------
     8. DOUBLE-COUNT CAP — the student's own ceiling, honoured.
     --------------------------------------------------------------------- */
  function doubleCountCap(profile, result, out) {
    const cap = profile.settings.doubleCountCap;
    if (typeof cap !== "number") return;
    if ((result.doubleCounted || 0) <= cap) return;
    out.push({ rule: "double-count-cap", severity: "fail",
      msg: `${result.doubleCounted} credits double-counted, cap is ${cap}` });
  }

  /* ---------------------------------------------------------------------
     9. THE PLAN EXISTS — an empty plan for a real major is a silent
     failure that every other rule would pass.
     --------------------------------------------------------------------- */
  function planIsUsable(profile, result, out) {
    if (!result.placements.length) {
      out.push({ rule: "empty-plan", severity: "fail", msg: "solver returned no placements" });
      return;
    }
    if (result.unscheduled && result.unscheduled.length) {
      out.push({ rule: "unscheduled", severity: "warn",
        msg: `${result.unscheduled.length} course(s) could not be placed: ${result.unscheduled.map(u => u.uid).join(", ")}` });
    }
  }

  const RULES = [
    planIsUsable, prereqOrder, seasonLegality, creditCaps,
    termValidity, completedNotScheduled, noDuplicates, repeatSequence, doubleCountCap,
  ];

  function checkAll(profile, result, def) {
    const out = [];
    RULES.forEach(fn => {
      try { fn(profile, result, out); }
      catch (e) {
        out.push({ rule: `${fn.name}-threw`, severity: "fail",
          msg: String((e && e.message) || e), detail: (e && e.stack) || null });
      }
    });
    return out;
  }

  return { checkAll, RULES };
})();
