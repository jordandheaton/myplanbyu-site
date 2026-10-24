/* =========================================================================
   myplanBYU — tests/cases.js
   The profiles the suite solves.

   Chosen to cover the paths that actually differ inside solver.js, not to
   be a representative sample of BYU:
     * MAP-first majors (161 of 175 have an official sheet) vs. the 14 with
       none, which fall through to bucket expansion + placeholder chains
     * cohort-block majors (Nursing, Elementary Ed) whose sheets schedule
       Spring terms the default profile does not enable
     * limited-enrollment majors with admission gates (IS, Accounting)
     * long prereq chains (engineering, actuarial) where sequencing bites
     * mid-degree students, whose earned credits drive the standing offset
       and the sheet-binding cursor — the source of the MATH 303-before-302
       class of bug
     * minors/certs stacked on a major, which is what exercises the
       double-count cap

   Adding a case: append here, run, then Record goldens. A case with no
   golden reports "none" rather than failing.

   A case may declare `knownIssues: { rules: [...], note: "..." }` for a real
   bug that is understood but not yet fixed. Those rules report as KNOWN
   instead of FAIL, so the suite stays green and a genuinely NEW failure is
   visible the moment it appears. The note is the point: a bare allowlist
   rots into a place where failures go to be forgotten. When the bug is
   fixed the rule stops firing and the entry should be deleted.
   ========================================================================= */
"use strict";

const Cases = (() => {

  /* A sophomore's worth of finished work — the standing-offset path. */
  const SOPHOMORE = ["WRTG 150", "MATH 110", "A HTG 100", "REL A 275", "REL C 225", "BIO 100"];
  /* Deeper into a business degree: the IS sheet's whole first year. */
  const JUNIOR_IS = [...SOPHOMORE, "IS 201", "ACC 200", "ECON 110", "STAT 121", "IS 110", "MKTG 201", "FIN 201", "UNIV 101"];

  const CURATED = [
    /* ---- flagship: the major the author knows best ------------------- */
    { id: "is-fresh", name: "IS (BS), true freshman", majorId: "is-bs" },
    { id: "is-minor", name: "IS (BS) + Business minor", majorId: "is-bs", minorIds: ["minor-business"] },
    { id: "is-stacked", name: "IS (BS) + 2 minors + cert (double-count pressure)",
      majorId: "is-bs", minorIds: ["minor-business", "minor-mathematics"], certIds: ["gbc-cert"] },
    { id: "is-junior", name: "IS (BS), mid-degree (first year done)", majorId: "is-bs", completed: JUNIOR_IS },
    { id: "is-sophomore", name: "IS (BS), sophomore standing", majorId: "is-bs", completed: SOPHOMORE },
    { id: "is-winter-start", name: "IS (BS), starting Winter (off-cycle)",
      majorId: "is-bs", startTerm: { year: 2027, season: "W" } },
    // Was a knownIssues case (IS 404 forced into Fall against a Winter-only
    // course record). RESOLVED both halves: IS 414 was never a real
    // prerequisite (envelope co-member), and the sheet/flowchart now wins on
    // season, which is Jordan's call — the advisement documents are more
    // current than courseTypicallyOffered. Kept as a plain case: it is still
    // the only IS variant with no MAP sheet, so it exercises that path.
    { id: "is-mism-nomap", name: "IS/MISM (no MAP sheet)", majorId: "is-bs-mism" },

    /* ---- cohort blocks + sheets that want Spring --------------------- */
    { id: "nursing", name: "Nursing (BS) — cohort blocks, Spring clinicals", majorId: "major-nursing-bs" },
    { id: "nursing-spring", name: "Nursing (BS) with Spring/Summer enabled",
      majorId: "major-nursing-bs", settings: { allowSpring: true, allowSummer: true } },
    { id: "elem-ed", name: "Elementary Education (BS) — practica", majorId: "major-elementary-education-bs" },
    { id: "sped", name: "Special Ed: Severe Disabilities (no MAP sheet)",
      majorId: "major-special-education-severe-disabilities-bs" },

    /* ---- long prereq chains ------------------------------------------ */
    { id: "cs", name: "Computer Science (BS)", majorId: "major-computer-science-bs" },
    { id: "mech-e", name: "Mechanical Engineering (BS)", majorId: "major-mechanical-engineering-bs" },
    { id: "chem-e", name: "Chemical Engineering (BS) — lab/lecture pairing", majorId: "major-chemical-engineering-bs" },
    { id: "actuarial", name: "Actuarial Science (BS)", majorId: "major-actuarial-science-bs" },

    /* ---- limited enrollment / admission gates ------------------------ */
    { id: "accounting", name: "Accounting (BS) — limited enrollment", majorId: "major-accounting-bs" },
    { id: "tax", name: "Tax (BS) (no MAP sheet)", majorId: "major-tax-bs" },

    /* ---- non-STEM shapes --------------------------------------------- */
    { id: "acting", name: "Acting (BFA) — audition-gated studio sequence", majorId: "major-acting-bfa" },
    { id: "animation", name: "Animation (BFA)", majorId: "major-animation-bfa" },
    { id: "asian-studies", name: "Asian Studies (BA) (no MAP sheet)", majorId: "major-asian-studies-ba" },
    { id: "gen-studies-bus", name: "General Studies: Business (BGS) (no MAP sheet)",
      majorId: "major-general-studies-business-bgs-bgs" },

    /* ---- reported by a tester, kept so they can't regress ------------ */
    // Tester report, 2026-08-03: a near-finished MISM student whose plan
    // still demanded Civilization 2 and Advanced Written & Oral. Both were
    // already covered: IHUM 202 (a hand-added course) is printed under
    // Civilization 2 AND Letters, and M COM 320 is Marriott's Advanced Written
    // & Oral route. The invariants can't catch either -- an over-full plan is
    // a valid plan -- so this case exists for its GOLDEN.
    { id: "tester-mism", name: "MISM, nearly done (GE double-count + M COM 320)",
      majorId: "is-bs-mism", extras: ["IHUM 202", "FREN 317"],
      completed: ["ACC 200", "AP 100R", "ECON 110", "FIN 201", "FREN 101", "FREN 102", "FREN 201",
        "FREN 202", "FREN 211R", "FREN 321", "G E 220", "GSCM 201", "GSCM 211", "HIST 201",
        "HRM 540", "IAS 201R", "IS 110", "IS 201", "IS 303", "IS 401", "IS 402", "IS 403",
        "IS 404", "IS 413", "IS 414", "IS 415", "IS 455", "IS 490R", "IS 531", "IS 537",
        "IS 560", "IS 566", "IS 595R", "M COM 320", "MATH 110", "MATH 111", "MKTG 201",
        "MSB 380", "MSB 430", "MSB 572", "NDFS 100", "PHY S 100", "REL A 250", "REL A 275",
        "REL A 327", "REL C 225", "REL C 357", "SFL 200", "STAT 121", "STRAT 560",
        "SWELL 115", "SWELL 156", "WRTG 150"] },

    // American Heritage is one course OR an approved two-course pair, so it is
    // the only GE area where "what the student already has" changes WHICH
    // option is cheapest. The pair case must schedule NOTHING; the half-pair
    // case must still schedule A HTG 100. Reading it as a flat pick-one told
    // every business student it was complete off ECON 110 alone.
    { id: "ah-pair-done", name: "American Heritage already met by ECON 110 + POLI 210",
      majorId: "is-bs", completed: ["ECON 110", "POLI 210"] },
    { id: "ah-half-pair", name: "American Heritage with only half a pair (ECON 110)",
      majorId: "is-bs", completed: ["ECON 110"] },

    /* ---- settings that change the term canvas ------------------------ */
    { id: "is-year-round", name: "IS (BS), year-round (Spring + Summer on)",
      majorId: "is-bs", settings: { allowSpring: true, allowSummer: true } },
    { id: "is-light-load", name: "IS (BS), 14-credit ceiling",
      majorId: "is-bs", settings: { maxCreditsFW: 14, minCreditsFW: 12 } },
  ];

  /* ---- profile assembly ------------------------------------------------
     Always built from DATA.defaultProfile so a change to the app's own
     defaults flows into the tests instead of drifting away from them. */
  function buildProfile(def) {
    const p = JSON.parse(JSON.stringify(DATA.defaultProfile));
    p.name = def.name;
    p.majorId = def.majorId;
    p.minorIds = def.minorIds || [];
    p.certIds = def.certIds || [];
    p.completed = def.completed || [];
    if (def.startTerm) p.startTerm = def.startTerm;
    if (def.pins) p.pins = def.pins;
    if (def.extras) p.extras = def.extras;   // hand-added courses, as the UI writes them
    if (def.settings) Object.assign(p.settings, def.settings);
    if (def.weights) Object.assign(p.weights, def.weights);
    return p;
  }

  /* ---- selection -------------------------------------------------------
     mode "curated" (default) runs the list above.
     mode "sweep" runs every major on default settings — no goldens, pure
     invariant checking. That is the wide net; the curated list is the
     regression net. */
  function select(opts = {}) {
    if (opts.mode === "sweep") {
      const majors = (typeof DATA !== "undefined" ? DATA.majors : []).slice();
      const limit = opts.limit || majors.length;
      return majors.slice(0, limit).map(m => ({
        id: `sweep:${m.id}`, name: m.name, majorId: m.id, sweep: true,
      }));
    }
    let list = CURATED;
    if (opts.only) list = list.filter(c => c.id === opts.only || c.majorId === opts.only);
    return list;
  }

  return { CURATED, buildProfile, select, SOPHOMORE, JUNIOR_IS };
})();
