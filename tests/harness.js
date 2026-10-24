/* =========================================================================
   myplanBYU — tests/harness.js
   Dependency-free test runner. No Node, no build step: tests/index.html
   loads the same script tags the real app does, so the code under test is
   byte-for-byte what ships.

   Two layers, both driven from here:
     1. INVARIANTS (invariants.js) — rules every plan must obey, checked on
        every solved case. These fail on their own merit.
     2. GOLDENS (goldens.js) — a recorded snapshot of each case's plan.
        A golden never says a plan is *good*, only that it is UNCHANGED.
        Any solver edit that moves a course shows up as a diff.

   Goldens are a BASELINE, not an oracle: known-bad output (an error flag
   the solver itself raises) is recorded as known, and the run fails only
   when something NEW appears. Fixing a known problem shows as "resolved"
   and asks you to re-record. A suite that is permanently red teaches you
   to ignore it.
   ========================================================================= */
"use strict";

const Harness = (() => {

  /* ---- canonical plan signature -------------------------------------
     Everything a golden compares, and nothing that legitimately varies
     run to run (solveMs, the live `state` object, object key order). */
  function signature(result) {
    // keyed by term LABEL but emitted in chronological order — a golden is
    // read by a human comparing semesters, and "Winter 2028" appearing above
    // "Fall 2026" because it was solved first makes the diff unreadable.
    const byIdx = new Map();
    result.placements.forEach(p => {
      if (!byIdx.has(p.termIndex)) byIdx.set(p.termIndex, []);
      byIdx.get(p.termIndex).push(p.uid);
    });
    const byTerm = {};
    [...byIdx.keys()].sort((a, b) => a - b).forEach(i => {
      const label = result.terms[i] ? result.terms[i].label : `?? term ${i}`;
      byTerm[label] = byIdx.get(i).sort();
    });

    let credits = 0;
    result.placements.forEach(p => { credits += p.credits || 0; });

    return {
      plan: byTerm,
      termsUsed: Object.keys(byTerm).length,
      courses: result.placements.length,
      credits: +credits.toFixed(1),
      unscheduled: result.unscheduled.map(u => u.uid).sort(),
      doubleCounted: result.doubleCounted || 0,
      score: result.score ? +result.score.total.toFixed(1) : null,
      // error-level flags are the solver's own admission that something is
      // wrong with the plan it just produced — baselined, see header.
      errorFlags: result.flags.filter(f => f.level === "error")
        .map(f => f.text.trim()).sort(),
    };
  }

  /* ---- plan diff, in the terms a human debugs in ---------------------
     "IS 401 moved Fall 2028 -> Winter 2029" beats a JSON blob. */
  function diffPlans(oldSig, newSig) {
    const where = sig => {
      const m = new Map();
      Object.keys(sig.plan).forEach(term =>
        sig.plan[term].forEach(uid => m.set(uid, term)));
      return m;
    };
    const a = where(oldSig), b = where(newSig);
    const moved = [], added = [], removed = [];
    b.forEach((term, uid) => {
      if (!a.has(uid)) added.push(`+ ${uid} in ${term}`);
      else if (a.get(uid) !== term) moved.push(`~ ${uid}: ${a.get(uid)} -> ${term}`);
    });
    a.forEach((term, uid) => { if (!b.has(uid)) removed.push(`- ${uid} was in ${term}`); });
    return { moved, added, removed };
  }

  /* set difference on sorted string arrays */
  function strDiff(oldArr, newArr) {
    const o = new Set(oldArr || []), n = new Set(newArr || []);
    return {
      appeared: [...n].filter(x => !o.has(x)),
      resolved: [...o].filter(x => !n.has(x)),
    };
  }

  /* ---- the run -------------------------------------------------------- */
  const report = {
    startedAt: null, ms: 0,
    cases: [],          // { id, name, ok, ms, violations[], golden{} }
    totals: { cases: 0, pass: 0, fail: 0, warn: 0, noGolden: 0 },
    signatures: {},     // id -> signature, for re-recording goldens
  };

  function runCase(def) {
    const profile = Cases.buildProfile(def);
    const t0 = performance.now();
    let result = null, crash = null;
    try { result = Solver.solve(profile); }
    catch (e) { crash = (e && e.stack) || String(e); }
    const ms = Math.round(performance.now() - t0);

    const entry = {
      id: def.id, name: def.name, ms, crash,
      violations: [], golden: { status: "skip", detail: null },
    };

    if (crash) {
      entry.violations.push({ rule: "solve-crash", severity: "fail", msg: crash.split("\n")[0], detail: crash });
      entry.ok = false;
      return entry;
    }

    entry.violations = Invariants.checkAll(profile, result, def);

    // Declared known issues (see cases.js) downgrade fail -> known. The
    // finding is still reported in full; it just does not redden the run,
    // so a NEW failure on the same case is impossible to miss.
    const known = (def.knownIssues && def.knownIssues.rules) || [];
    if (known.length) {
      entry.knownNote = def.knownIssues.note || null;
      entry.violations.forEach(v => {
        if (v.severity === "fail" && known.includes(v.rule)) v.severity = "known";
      });
    }

    const sig = signature(result);
    report.signatures[def.id] = sig;

    const golden = (typeof GOLDENS !== "undefined" && GOLDENS.cases) ? GOLDENS.cases[def.id] : null;
    if (!golden) {
      // detail stays an array (or null) everywhere — the renderer iterates it
      entry.golden = { status: "none", detail: null };
      report.totals.noGolden++;
      // Nothing to baseline against, so the solver's own error flags are
      // surfaced as warnings rather than silently accepted.
      sig.errorFlags.forEach(t =>
        entry.violations.push({ rule: "solver-error-flag", severity: "warn", msg: t }));
    } else {
      const planDiff = diffPlans(golden, sig);
      const changed = planDiff.moved.length + planDiff.added.length + planDiff.removed.length;
      const flagDiff = strDiff(golden.errorFlags, sig.errorFlags);
      const unschedDiff = strDiff(golden.unscheduled, sig.unscheduled);

      flagDiff.appeared.forEach(t =>
        entry.violations.push({ rule: "new-error-flag", severity: "fail", msg: t }));
      flagDiff.resolved.forEach(t =>
        entry.violations.push({ rule: "error-flag-resolved", severity: "info", msg: `fixed — re-record: ${t}` }));
      unschedDiff.appeared.forEach(u =>
        entry.violations.push({ rule: "newly-unscheduled", severity: "fail", msg: `${u} no longer fits the plan` }));

      if (changed) {
        entry.golden = {
          status: "changed",
          detail: [...planDiff.moved, ...planDiff.added, ...planDiff.removed],
          scoreWas: golden.score, scoreNow: sig.score,
        };
      } else if (golden.score !== sig.score) {
        // Same placements, different score: scoring weights moved. Worth
        // seeing, not worth failing — the plan itself is identical.
        entry.golden = { status: "score-only", detail: [`score ${golden.score} -> ${sig.score}`] };
      } else {
        entry.golden = { status: "match", detail: null };
      }
    }

    entry.ok = !entry.violations.some(v => v.severity === "fail")
            && entry.golden.status !== "changed";
    return entry;
  }

  function run(opts = {}) {
    const defs = Cases.select(opts);
    report.startedAt = new Date().toISOString();
    report.cases = []; report.signatures = {};
    report.totals = { cases: 0, pass: 0, fail: 0, warn: 0, known: 0, noGolden: 0 };

    const t0 = performance.now();
    defs.forEach(def => {
      const entry = runCase(def);
      report.cases.push(entry);
      report.totals.cases++;
      if (entry.ok) report.totals.pass++; else report.totals.fail++;
      report.totals.warn  += entry.violations.filter(v => v.severity === "warn").length;
      report.totals.known += entry.violations.filter(v => v.severity === "known").length;
    });
    report.ms = Math.round(performance.now() - t0);
    report.mode = opts.mode || "curated";
    return report;
  }

  /* ---- goldens.js source text, for the Record button ------------------
     Hand-rolled rather than JSON.stringify(x, null, 1) so that each TERM
     is one line. That is the unit a reviewer reasons about: a moved course
     shows up as two changed lines ("Fall 2028" and "Winter 2029") instead
     of a 40-line reshuffle of one-element-per-line arrays. */
  function goldenText() {
    const q = s => JSON.stringify(s);
    const arr = a => `[${a.map(q).join(", ")}]`;
    const blocks = Object.keys(report.signatures).sort().map(id => {
      const s = report.signatures[id];
      const planLines = Object.keys(s.plan).map(t => `    ${q(t)}: ${arr(s.plan[t])}`);
      return [
        `  ${q(id)}: {`,
        `   "termsUsed": ${s.termsUsed}, "courses": ${s.courses}, "credits": ${s.credits},`,
        `   "score": ${s.score}, "doubleCounted": ${s.doubleCounted},`,
        `   "unscheduled": ${arr(s.unscheduled)},`,
        `   "errorFlags": [${s.errorFlags.length ? "\n" + s.errorFlags.map(f => `    ${q(f)}`).join(",\n") + "\n   " : ""}],`,
        `   "plan": {`,
        planLines.join(",\n"),
        `   }`,
        `  }`,
      ].join("\n");
    });
    return `/* =========================================================================
   myplanBYU — tests/goldens.js  (GENERATED — do not hand-edit)

   Recorded plan snapshots. Re-record with the "Record goldens" button in
   tests/index.html whenever a solver change is INTENDED to move courses,
   and read the diff in code review: the diff IS the change.

   recorded: ${new Date().toISOString().slice(0, 10)}
   cases:    ${blocks.length}
   ========================================================================= */
"use strict";

const GOLDENS = { "cases": {
${blocks.join(",\n")}
} };
`;
  }

  return { run, runCase, signature, diffPlans, goldenText, report };
})();
