/* =========================================================================
   myplanBYU — solver.js
   In-browser constraint solver for degree sequencing.

   Pipeline:
     1. expand()  — selected programs -> requirement buckets -> concrete
                    course set (bucket cover w/ double-count cap + prereq closure)
     2. seed()    — cohort blocks + pins first, then greedy placement in
                    critical-path order (hard constraints only)
     3. improve() — weighted hill-climbing over random feasible moves,
                    objective = user dial weights (speed/cost/risk/load/life)
     4. analyze() — informational flags + progress report data

   Hard constraints: prerequisite chains, season availability, per-term
   credit caps, cohort blocks (same-term, ordered), pinned courses,
   repeatable-course sequencing. Soft (weighted): everything else.
   ========================================================================= */
"use strict";

const Solver = (() => {

  const SEASONS = ["F", "W", "S", "U"];
  const SEASON_NAME = { F: "Fall", W: "Winter", S: "Spring", U: "Summer" };
  const HARD_DIFF = 7;          // "historically hard" threshold
  const UG_TARGET_CREDITS = 120;
  const BYU_HARD_CAP = 18;      // BYU registration cap (above needs approval)

  /* ------------------------------ utils ------------------------------ */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const baseId = uid => uid.split("#")[0];

  /* ------------------------------ terms ------------------------------ */
  function buildTerms(profile) {
    const { startTerm, settings } = profile;
    const terms = [];
    let { year, season } = startTerm;
    let si = SEASONS.indexOf(season);
    const total = (settings.horizonYears || 6) * 4;
    for (let i = 0; i < total; i++) {
      const s = SEASONS[si];
      const isFW = s === "F" || s === "W";
      terms.push({
        index: terms.length, year, season: s,
        label: `${SEASON_NAME[s]} ${year}`,
        isFW,
        cap: isFW ? settings.maxCreditsFW : settings.maxCreditsSpSu,
        enabled: isFW || (s === "S" ? !!settings.allowSpring : !!settings.allowSummer),
      });
      si++;
      if (si >= 4) { si = 0; }
      if (s === "F") year++;           // Fall 2026 -> Winter 2027
    }
    return terms;
  }
  function termIndexFor(terms, year, season) {
    const t = terms.find(t => t.year === year && t.season === season);
    return t ? t.index : -1;
  }

  /* --------------------------- expansion ----------------------------- */
  function collectPrograms(profile) {
    const progs = [DATA.univCore];
    if (profile.majorId && DATA.programIndex[profile.majorId]) progs.push(DATA.programIndex[profile.majorId]);
    (profile.minorIds || []).slice(0, 2).forEach(id => DATA.programIndex[id] && progs.push(DATA.programIndex[id]));
    (profile.certIds || []).forEach(id => DATA.programIndex[id] && progs.push(DATA.programIndex[id]));
    return progs;
  }

  function buildCatalog(programs) {
    const cat = { ...DATA.courses };
    programs.forEach(p => (p.placeholderCourses || []).forEach(c => {
      cat[c.id] = {
        pre: [], off: "FW", diff: 5, load: 1, demand: "med", rare: false,
        tags: [], testOut: null, repeatMax: 1, note: null, ...c,
      };
    }));
    return cat;
  }

  function bucketOptions(bucket, cat) {
    const set = new Set(bucket.options || []);
    if (bucket.tag) for (const id in cat) if (cat[id].tags.includes(bucket.tag)) set.add(id);
    return [...set].filter(id => cat[id]);
  }

  /* course level from its code number: IS 303 -> 3, ACC 200 -> 2, MATH 110 -> 1 */
  function courseLevel(course) {
    if (course.level) return course.level;
    const m = (course.display || course.id || "").match(/(\d)\d{2}\b/);
    return m ? +m[1] : 2;
  }
  /* earliest academic-year index a level should appear (0 = freshman year).
     Prereq data is sparse in the catalog, so LEVEL is our main pacing signal:
     400s out of freshman year, 500s (grad/MISM) junior+, GE/100s front-loaded. */
  function minYearForLevel(level) {
    return level <= 2 ? 0 : level === 3 ? 1 : level === 4 ? 2 : 3;
  }
  /* academic-year index of a term relative to the plan's first term (0-based) */
  function acadYearIdx(terms, t) {
    const ay = tm => (tm.season === "F" ? tm.year : tm.year - 1);
    return ay(terms[t]) - ay(terms[0]);
  }

  /* Build (or reuse) a labeled bucket placeholder: a schedulable card that
     stands for "one Arts GE" / "one Religion Cornerstone" / "one elective"
     and carries a curated, easy-first suggestion list for its dropdown. */
  function makeBucketPlaceholder(cat, program, bucket, realPool, isReligion, slotCr, completed, group) {
    // per-GROUP placeholders: "choose 2 of 5 options" realizes each chosen
    // option-group as its OWN slot with its own suggestion pool — sharing one
    // id made the second group's slot vanish and mixed suggestion lists.
    const id = `BUCKET::${program.id}::${bucket.id}` + (group ? `::g${group.gi}` : "");
    if (!cat[id]) {
      const suggestions = realPool
        .filter(c => !completed.has(c))
        .sort((a, b) => (cat[a]?.diff ?? 4) - (cat[b]?.diff ?? 4))   // easy-first default; Claude re-sorts later
        .slice(0, 60);
      // Season = union of the options' offering seasons, so the slot can only
      // land in a term where at least one real choice is actually taught (this
      // is what fixes "choose a class -> no classes found" on one-season
      // buckets). University Core buckets have huge option pools -> effectively
      // any term; a Winter-only elective bucket becomes Winter-only.
      let off = "";
      for (const c of realPool) {
        const o = cat[c] && cat[c].off;
        if (o) for (const s of o) if (!off.includes(s)) off += s;
      }
      if (!off) off = "FWSU";
      cat[id] = {
        id, display: shortBucketLabel(program, bucket, group),
        name: group ? group.label : bucket.name,
        credits: slotCr, pre: [], off,                      // constrained to where options are taught
        diff: isReligion ? 2 : 3, load: 1, demand: "med", rare: false,
        tags: [], testOut: null, repeatMax: 99, note: null,
        placeholder: true, bucket: true, isReligion: !!isReligion,
        level: program.id === "univ-core" ? 1 : 2,           // GE/religion front-load
        bucketRef: { programId: program.id, bucketId: bucket.id, groupIdx: group ? group.gi : null },
        reqLabel: reqLabelOf(bucket, group),
        fillKey: `${program.id}::${bucket.id}` + (group ? `::g${group.gi}` : ""),
        suggestions,
      };
    }
    return id;
  }
  function shortBucketLabel(program, bucket, group) {
    if (program.id === "univ-core") return bucket.name;      // "Arts", "American Heritage"
    // trim "Requirement 3 — Complete 2 Courses" to something card-sized
    const src = group ? group.label : bucket.name;
    const n = src.replace(/^(Requirement|Option) [\d.]+\s*[—-]\s*/i, "").trim();
    return `${program.name.replace(/\s*\(.*\)$/, "")}: ${n || src}`.slice(0, 46);
  }
  /* "Req 4.2" / "Opt 8.1" tag so students can match a dropdown slot to the
     numbered requirement on the catalog page */
  function reqLabelOf(bucket, group) {
    const m = (group ? group.label : bucket.name).match(/^(Requirement|Option)\s+([\d.]+)/i);
    return m ? `${/^o/i.test(m[1]) ? "Opt" : "Req"} ${m[2]}` : null;
  }

  /* Fill a choice bucket with placeholders for its remaining slots (after
     completed courses and student dropdown picks). Shared by plain choice
     buckets and by the realized option-group of a GROUP bucket. */
  /* set by expand(): course ids the selected MAJOR/MINOR programs require
     outright — a GE bucket containing one of them is auto-covered (the neuro
     student's required bio class IS their Biological Science GE) */
  let _preRequired = null;

  function placeholderFill(cat, program, bucket, realPool, key, slots, completed, take, profile, group) {
    const isRel = /(^|[^a-z])rel/i.test(bucket.id) || /religion/i.test(bucket.name);
    const slotCr = isRel ? 2 : 3;
    const alreadyDone = realPool.filter(id => completed.has(id)).length;
    // double-count awareness: a required program course that ALSO satisfies
    // this GE bucket covers a slot (within the double-count cap) — no extra
    // GE class needed, and the progress report shows it filling both.
    let covered = [];
    if (program.id === "univ-core" && _preRequired) {
      covered = realPool.filter(id => _preRequired.has(id) && !completed.has(id))
        .filter(id => take(id, key, 1));
    }
    // group slots record their fills under a per-group key so choosing a class
    // for Option 8.1 can't leak into Option 8.3's slot
    const fillKey = key + (group ? `::g${group.gi}` : "");
    const fills = ((profile.fills || {})[fillKey] || []).filter(cid => cat[cid]);
    fills.forEach(cid => take(cid, key, 1));
    const want = slots != null ? slots : Math.max(1, Math.round(bucket.pick.n / slotCr));
    const remaining = Math.max(0, want - alreadyDone - fills.length - covered.length);
    if (remaining <= 0) return;
    const phId = makeBucketPlaceholder(cat, program, bucket, realPool, isRel, slotCr, completed, group);
    take(phId, key, remaining);
  }

  /* Choose which option-group(s) of a GROUP bucket to realize: the student's
     saved choice if any, else the lightest group(s) by completion credits.
     (A "choose 1 of 2 options" defaults to the shorter option — what most
     students pick — but stays switchable.) */
  function groupCompletionCredits(g, cat) {
    if (g.take === "all") return g.opts.reduce((s, id) => s + (cat[id]?.credits || 3), 0);
    if (g.take && g.take.credits) return g.take.credits;
    const avg = g.opts.reduce((s, id) => s + (cat[id]?.credits || 3), 0) / Math.max(1, g.opts.length);
    return (typeof g.take === "number" ? g.take : 1) * avg;
  }
  function pickGroups(profile, key, groups, cat, k) {
    // saved choices are ORIGINAL group indices (g.gi) so they stay stable even
    // when some groups have no resolvable courses and get filtered out
    const saved = (profile.groupChoice || {})[key];
    const savedArr = Array.isArray(saved) ? saved : (typeof saved === "number" ? [saved] : null);
    if (savedArr) {
      const picked = groups.filter(g => savedArr.includes(g.gi));
      if (picked.length >= Math.min(k, groups.length)) return picked.slice(0, k);
      // partial save: keep what was chosen, top up with the lightest others
      const rest = groups.filter(g => !savedArr.includes(g.gi)).sort((a, b) =>
        groupCompletionCredits(a, cat) - groupCompletionCredits(b, cat));
      return [...picked, ...rest].slice(0, k);
    }
    return groups.slice().sort((a, b) =>
      groupCompletionCredits(a, cat) - groupCompletionCredits(b, cat)).slice(0, k);
  }

  /*  Choose concrete courses to satisfy every bucket.
      Returns { chosen: Map baseId -> {course, buckets:[], instances:n},
                warnings, doubleCounted } */
  function expand(profile, programs, cat) {
    const completed = new Set(profile.completed || []);
    const warnings = [];
    const chosen = new Map();   // baseId -> { buckets:Set, instances }
    const groupSel = {};        // bucketKey -> [chosen original group indices]
    let doubleCounted = 0;
    const cap = profile.settings.doubleCountCap ?? 15;

    const take = (id, bucketKey, instances = 1) => {
      if (!chosen.has(id)) chosen.set(id, { buckets: new Set(), instances: 0 });
      const rec = chosen.get(id);
      if (rec.buckets.size >= 1 && !rec.buckets.has(bucketKey)) {
        // sharing across buckets = double counting
        if (doubleCounted + cat[id].credits > cap) return false;
        doubleCounted += cat[id].credits;
      }
      rec.buckets.add(bucketKey);
      rec.instances = Math.max(rec.instances, instances);
      return true;
    };

    // courses the majors/minors REQUIRE outright — used to auto-cover GE
    // buckets that list them (double-count), before any bucket expands
    _preRequired = new Set();
    programs.forEach(p => {
      if (p.id === "univ-core") return;
      p.buckets.forEach(b => {
        if (b.pick.type === "all") {
          (b.options || []).forEach(id => { if (cat[id] && !cat[id].placeholder) _preRequired.add(id); });
        } else if (b.pick.type !== "group") {
          const pool = (b.options || []).filter(id => cat[id] && !cat[id].placeholder);
          if (pool.length === 1) _preRequired.add(pool[0]);
        }
      });
      if (p.flowchartPlan) for (const code in p.flowchartPlan) { if (cat[code]) _preRequired.add(code); }
    });

    /* Pass 1/2 — REQUIRED vs CHOICE (the LLM-guided pivot).
       Required buckets ('pick:all' — cohort blocks, rigid major courses) lock
       in the specific real classes. CHOICE buckets (GE, religion, elective
       "pick N of these") do NOT lock a class: they place labeled BUCKET
       PLACEHOLDERS the student fills from a curated, preference-sorted dropdown.
       This is what kills "GE 112 for American Heritage" and locked electives. */
    programs.forEach(p => p.buckets.forEach(b => {
      const key = `${p.id}::${b.id}`;

      // "Complete up to N hours" with no floor = optional — nothing required
      if (b.pick.type === "credits" && b.pick.n <= 0) return;

      // GROUP bucket: "complete 1 of 2 options" — pick ONE option-group (the
      // student's choice, else the lightest by credits) and realize just that
      // group. This is what stops the old "took every option" bug.
      if (b.pick.type === "group") {
        const groups = (b.groups || []).map((g, gi) => ({
          ...g, gi, opts: (g.options || []).filter(id => cat[id]),
        })).filter(g => g.opts.length);
        if (!groups.length) return;
        const picked = pickGroups(profile, key, groups, cat, b.pick.k || 1);
        groupSel[key] = picked.map(g => g.gi);      // exposed for the UI switcher
        picked.forEach(g => {
          if (g.take === "all" || (typeof g.take === "number" && g.take >= g.opts.length)) {
            g.opts.forEach(id => take(id, key, 1));
          } else if (g.take && g.take.credits) {
            placeholderFill(cat, p, b, g.opts, key, Math.max(1, Math.round(g.take.credits / 3)), completed, take, profile, g);
          } else {                        // take N courses -> N placeholders
            placeholderFill(cat, p, b, g.opts, key, g.take || 1, completed, take, profile, g);
          }
        });
        return;
      }

      const pool = bucketOptions(b, cat).filter(id => !cat[id]?.placeholder);

      // Required: take every real course (skip already-completed happens later).
      if (b.pick.type === "all") { pool.forEach(id => take(id, key, 1)); return; }

      // Single repeatable course counted by CREDITS (CE 291R "complete 3 hrs",
      // NEURO 455R "complete 1 hr" at 0.5 cr) -> schedule enough repeats.
      if (pool.length === 1 && b.pick.type === "credits") {
        const c = cat[pool[0]];
        const inst = Math.max(1, Math.ceil(b.pick.n / (c.credits || 3)));
        // clone (cat shares objects with DATA.courses) before bumping repeatMax
        if (inst > (c.repeatMax || 1)) cat[pool[0]] = { ...c, repeatMax: inst };
        take(pool[0], key, inst);
        return;
      }

      // A one-option "choice" is really required — no dropdown needed.
      const realPool = pool.filter(id => cat[id]);
      if (realPool.length === 1) { take(realPool[0], key, 1); return; }

      const slots = b.pick.type === "courses" ? b.pick.n : null;   // null => by credits
      placeholderFill(cat, p, b, realPool, key, slots, completed, take, profile);
    }));

    // Pass 2.4: guarantee every course the official flowchart lists is INCLUDED
    // (business core like HRM 391 / PSE 390 / STRAT 392, or new courses like
    // IS 456 that the catalog requirement lists don't sequence).
    programs.forEach(p => {
      if (!p.flowchartPlan) return;
      for (const code in p.flowchartPlan) {
        if (cat[code] && !completed.has(code)) take(code, `${p.id}::flowchart`, 1);
      }
    });

    // Pass 2.5: user-added extras (from the per-semester search bar) — they
    // count as electives unless they happen to fill a bucket elsewhere
    (profile.extras || []).forEach(code => {
      if (cat[code] && !completed.has(code)) take(code, "electives::extra", 1);
    });

    // Pass 3: prerequisite closure (pull in unmet prereqs as additions)
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id] of [...chosen]) {
        for (const group of cat[id].pre) {
          const optsG = Array.isArray(group) ? group : [group];
          const ok = optsG.some(g => completed.has(g) || chosen.has(g));
          if (!ok) {
            const pick = optsG.filter(g => cat[g]).sort((a, b2) => cat[a].diff - cat[b2].diff)[0];
            if (pick) { take(pick, "prereq::closure", 1); changed = true; }
          }
        }
      }
    }

    // Pass 4: elective filler to reach the undergrad target
    const isMism = profile.majorId === "is-bs-mism";
    const gradCredits = isMism ? 24 : 0;
    let planned = 0;
    chosen.forEach((rec, id) => { if (!completed.has(id)) planned += cat[id].credits * rec.instances; });
    let compCredits = 0;
    completed.forEach(id => { if (cat[id]) compCredits += cat[id].credits; });
    const target = UG_TARGET_CREDITS + gradCredits;
    let gap = target - (planned + compCredits);
    let en = 1;
    while (gap > 0) {
      const id = `ELECTIVE ${en}`;
      cat[id] = { id, display: "ELECTIVE", name: "Open Elective / Exploration", credits: 3, pre: [], off: "FWSU", diff: 3, load: 1, demand: "low", rare: false, tags: [], testOut: "Consider AP/CLEP credit, an internship (academic credit), or test-out exams to clear elective hours.", repeatMax: 1, placeholder: true, elective: true, note: null };
      take(id, "electives::fill", 1);
      gap -= 3; en++;
    }

    return { chosen, warnings, doubleCounted, completed, groupSel };
  }

  /* Build schedulable instances from chosen courses */
  function buildInstances(chosen, completed, cat) {
    const inst = [];
    chosen.forEach((rec, id) => {
      if (completed.has(id)) return;
      for (let k = 1; k <= rec.instances; k++) {
        inst.push({
          uid: rec.instances > 1 ? `${id}#${k}` : id,
          course: cat[id], k, total: rec.instances,
          buckets: [...rec.buckets],
        });
      }
    });
    return inst;
  }

  /* --------------------------- scheduling ---------------------------- */
  function makeState(profile, terms, instances, cat, completed) {
    return {
      profile, terms, cat, completed,
      instances,
      byUid: new Map(instances.map(i => [i.uid, i])),
      assign: new Map(),                 // uid -> termIndex
      load: terms.map(() => 0),          // credits per term
      pinnedUids: new Set(),
      blockOf: new Map(),                // uid -> blockId
      blocks: new Map(),                 // blockId -> {season, after, uids:[], label}
    };
  }

  function prereqSatisfied(state, inst, t, coSet) {
    const { cat, completed, assign, byUid } = state;
    // repeatable sequencing: instance k after instance k-1
    if (inst.k > 1) {
      const prevUid = `${baseId(inst.uid)}#${inst.k - 1}`;
      const pt = assign.get(prevUid);
      if (pt === undefined || pt >= t) return false;
    }
    if (inst.k > 1) return true;         // base prereqs only bind the first instance
    for (const group of inst.course.pre) {
      const opts = Array.isArray(group) ? group : [group];
      const ok = opts.some(g => {
        if (completed.has(g)) return true;
        // co-requisites: block-mates in the same cohort count as satisfied
        // (a junior-core envelope is taken all at once, not in prereq order)
        if (coSet && coSet.has(g)) return true;
        // any scheduled instance of g strictly earlier
        for (const [uid, tt] of state.assign) {
          if (baseId(uid) === g && tt < t) return true;
        }
        return false;
      });
      if (!ok) return false;
    }
    return true;
  }

  function canPlace(state, inst, t, ignoreCap = false) {
    const term = state.terms[t];
    if (!term || !term.enabled) return false;
    if (!inst.course.off.includes(term.season)) return false;
    // soft seeding cap: first passes fill F/W to ~16 so the plan spreads into
    // enough terms to taper the final year (18 stays the hard cap for the
    // relaxed pass, the optimizer, and manual moves)
    const cap = (!ignoreCap && term.isFW && state.softCapFW)
      ? Math.min(term.cap, state.softCapFW) : term.cap;
    if (!ignoreCap && state.load[t] + inst.course.credits > cap) return false;
    if (!prereqSatisfied(state, inst, t)) return false;
    return true;
  }

  function place(state, inst, t) {
    state.assign.set(inst.uid, t);
    state.load[t] += inst.course.credits;
  }
  function unplace(state, inst) {
    const t = state.assign.get(inst.uid);
    if (t !== undefined) { state.load[t] -= inst.course.credits; state.assign.delete(inst.uid); }
  }

  /* critical-path depth: longest chain of dependents hanging off a course */
  function computeDepth(instances, cat) {
    const dependents = new Map();
    instances.forEach(i => dependents.set(baseId(i.uid), []));
    instances.forEach(i => {
      i.course.pre.flat().forEach(p => {
        if (dependents.has(p)) dependents.get(p).push(baseId(i.uid));
      });
    });
    const memo = new Map();
    function depth(id) {
      if (memo.has(id)) return memo.get(id);
      memo.set(id, 0); // cycle guard
      const d = 1 + Math.max(0, ...(dependents.get(id) || []).map(depth));
      memo.set(id, d);
      return d;
    }
    const out = new Map();
    instances.forEach(i => out.set(i.uid, depth(baseId(i.uid)) + (i.course.repeatMax - i.k) * 0.1));
    return out;
  }

  function seed(state, programs) {
    const { profile, terms, cat } = state;
    const problems = [];

    /* 1 — register cohort blocks (hand-defined, e.g. IS junior core) */
    programs.forEach(p => p.buckets.forEach(b => {
      if (!b.block) return;
      const uids = bucketOptions(b, cat).filter(id => state.byUid.has(id));
      if (!uids.length) return;
      state.blocks.set(b.block.id, { ...b.block, uids });
      uids.forEach(u => state.blockOf.set(u, b.block.id));
    }));

    /* 1b — flowchart cohorts: the RIGID junior-core envelopes. These lock their
       exact courses to the flowchart's exact year+season and move as a unit
       (can't be dragged apart) — the business/eng junior core is immutable. */
    programs.forEach(p => (p.flowchartCohorts || []).forEach((co, i) => {
      let uids = co.courses.filter(id => state.byUid.has(id) && !state.blockOf.has(id));
      // junior/senior cores are upper-division; drop any prereqs the extraction
      // swept in (STAT 121, MSB 180) so they schedule at their real early spot
      if (co.y >= 3) uids = uids.filter(id => courseLevel(state.byUid.get(id).course) >= 3);
      if (uids.length < 2) return;
      const id = `fc:${p.id}:${i}`;
      state.blocks.set(id, { id, season: co.s, label: co.label, uids, fcYear: co.y });
      uids.forEach(u => state.blockOf.set(u, id));
    }));

    /* 2 — pins (e.g. IS 303 -> Winter 2027); prereq order is verified after seeding */
    Object.entries(profile.pins || {}).forEach(([cid, when]) => {
      const inst = state.byUid.get(cid);
      if (!inst) return;
      const t = termIndexFor(terms, when.year, when.season);
      if (t < 0 || !terms[t].enabled || !inst.course.off.includes(terms[t].season)) {
        problems.push({ type: "pin", text: `Pinned course ${cid} cannot be placed in ${SEASON_NAME[when.season]} ${when.year} (term unavailable or course not offered that season).` });
        return;
      }
      place(state, inst, t);
      state.pinnedUids.add(cid);
    });

    /* 3 — place blocks in dependency order, earliest feasible term */
    const blockOrder = [...state.blocks.values()].sort((a, b) => (a.after ? 1 : 0) - (b.after ? 1 : 0));
    const blockTerm = {};
    const placeBlock = (blk) => {
      if (blockTerm[blk.id] !== undefined) return true;
      if (blk.after && blockTerm[blk.after] === undefined) {
        const dep = state.blocks.get(blk.after);
        if (dep) placeBlock(dep);
      }
      let minT = blk.after !== undefined && blockTerm[blk.after] !== undefined ? blockTerm[blk.after] + 1 : 0;
      // flowchart cohorts target their EXACT recommended academic year; try that
      // term first (ignoring the cap so the rigid core always lands there), then
      // fall back to the earliest feasible term of the right season.
      const credits = blk.uids.reduce((s, u) => s + state.byUid.get(u).course.credits, 0);
      const coSet = new Set(blk.uids.map(baseId));   // block-mates are co-reqs
      // RIGID: at the flowchart's target term, place the whole envelope
      // unconditionally — the department chart overrides individual course
      // seasons/prereqs (which can be stale in the catalog). Over-cap shows as
      // a warning; genuine prereq gaps are flagged by analyze(), not blocked.
      const placeAt = (t) => {
        blk.uids.forEach(u => place(state, state.byUid.get(u), t));
        blockTerm[blk.id] = t;
        return true;
      };
      if (blk.fcYear) {
        for (let t = minT; t < state.terms.length; t++) {
          const term = state.terms[t];
          if (term && term.enabled && term.season === blk.season &&
              acadYearIdx(state.terms, t) === blk.fcYear - 1) return placeAt(t);
        }
      }
      // fallback (no target year, or it wasn't available): earliest feasible term
      for (let t = minT; t < state.terms.length; t++) {
        const term = state.terms[t];
        if (!term || !term.enabled || term.season !== blk.season) continue;
        if (state.load[t] + credits > term.cap) continue;
        const ok = blk.uids.every(u => {
          const inst = state.byUid.get(u);
          return inst.course.off.includes(term.season) && prereqSatisfied(state, inst, t, coSet);
        });
        if (ok) return placeAt(t);
      }
      problems.push({ type: "block", text: `Couldn't schedule cohort block "${blk.label}" — check prerequisites and term availability.` });
      return false;
    };

    /* 4 — greedy for everything else, critical path first, LOW LEVELS FIRST so
       freshman-friendly courses claim early terms and 300/400s get pushed out */
    const depths = computeDepth(state.instances, cat);
    state.depths = depths;               // scorePlan pulls deep chains early
    // freshman-only 19x seminars/projects must claim year-1 seats before the
    // GE placeholders (which can fill ANY term) soak them up
    const froshOnly = i => (/\b19\d[A-Z]?\b/.test(i.course.display || i.course.id || "") &&
                            courseLevel(i.course) <= 1) ? 0 : 1;
    const fc = state.fcHint || {};
    const rest = state.instances
      .filter(i => !state.assign.has(i.uid) && !i.course.elective)
      .sort((a, b) =>
        ((fc[baseId(a.uid)] ? 0 : 1) - (fc[baseId(b.uid)] ? 0 : 1)) ||   // flowchart-hinted first
        (froshOnly(a) - froshOnly(b)) ||
        (depths.get(b.uid) - depths.get(a.uid)) ||
        (courseLevel(a.course) - courseLevel(b.course)) ||        // 1xx/2xx before 3xx/4xx
        ((b.course.demand === "high") - (a.course.demand === "high")) ||
        (b.course.credits - a.course.credits));
    // multiple passes: prereq chains unlock as earlier courses land. Placement
    // respects level pacing (no 400s in freshman year); a relaxed pass after
    // catches anything that genuinely can't fit its ideal window.
    const tryFill = (respectPacing, skipBlocks) => {
      for (let pass = 0; pass < 6; pass++) {
        let progress = false;
        rest.forEach(inst => {
          if (state.assign.has(inst.uid)) return;
          if (skipBlocks && state.blockOf.has(inst.uid)) return;   // cohort blocks placed separately
          // flowchart-hinted courses aim straight for their target year+season
          const hint = fc[baseId(inst.uid)];
          if (respectPacing && hint) {
            for (let t = 0; t < state.terms.length; t++) {
              const tm = state.terms[t];
              if (!tm.isFW || tm.season !== hint.s || acadYearIdx(state.terms, t) !== hint.y - 1) continue;
              if (canPlace(state, inst, t)) { place(state, inst, t); progress = true; return; }
            }
          }
          const minY = respectPacing ? (hint ? hint.y - 1 : minYearForLevel(courseLevel(inst.course))) : 0;
          for (let t = 0; t < state.terms.length; t++) {
            if (acadYearIdx(state.terms, t) < minY) continue;
            if (canPlace(state, inst, t)) { place(state, inst, t); progress = true; return; }
          }
        });
        if (!progress) break;
      }
    };
    // 1) place NON-block courses first so cohort prerequisites (IS 303,
    //    pre-core) land in early terms; 2) then lock the rigid cohort blocks
    //    at their target term; 3) then fill whatever remains.
    state.softCapFW = Math.min(16, profile.settings.maxCreditsFW || 16);
    tryFill(true, true);
    for (let pass = 0; pass < 4; pass++) blockOrder.forEach(placeBlock);
    tryFill(true, false);
    state.softCapFW = 0;     // relaxed passes get the full cap
    tryFill(true, false);
    tryFill(false, false);   // relaxed fallback for the stubborn few

    /* 4b — verify pinned courses ended up after their prerequisites */
    state.pinnedUids.forEach(uid => {
      const inst = state.byUid.get(uid);
      const t = state.assign.get(uid);
      if (t !== undefined && !prereqSatisfied(state, inst, t)) {
        problems.push({ type: "pin", text: `Pinned course ${inst.course.display || uid} sits before its prerequisites — move the prerequisites earlier or unpin it.` });
      }
    });

    /* 5 — pad below-minimum Fall/Winter terms with electives, then spread leftovers */
    const electives = state.instances.filter(i => i.course.elective && !state.assign.has(i.uid));
    const minFW = profile.settings.minCreditsFW || 12;
    let ei = 0;
    const lastUsed = () => Math.max(0, ...[...state.assign.values()]);
    const firstUsed = Math.min(...[...state.assign.values(), Infinity]);
    for (let t = 0; t <= lastUsed() && ei < electives.length; t++) {
      const term = state.terms[t];
      if (!term.isFW || !term.enabled) continue;
      // pad BOTH active below-minimum terms and empty gap terms inside the
      // plan's span — a zero-credit Fall between two enrolled Winters is a gap
      const inSpan = t >= firstUsed;
      while (inSpan && state.load[t] < minFW && state.load[t] + 3 <= term.cap && ei < electives.length) {
        place(state, electives[ei++], t);
      }
    }
    while (ei < electives.length) {
      // remaining electives: earliest F/W term with headroom
      let placed = false;
      for (let t = 0; t < state.terms.length; t++) {
        const term = state.terms[t];
        if (!term.enabled || !term.isFW) continue;
        if (state.load[t] + 3 <= term.cap) { place(state, electives[ei++], t); placed = true; break; }
      }
      if (!placed) break;
    }

    const unscheduled = state.instances.filter(i => !state.assign.has(i.uid));
    unscheduled.forEach(i => problems.push({
      type: "unscheduled",
      text: `${i.course.display || i.uid} couldn't be scheduled${i.course.off.length < 4 ? ` (offered ${[...i.course.off].map(s => SEASON_NAME[s]).join("/")} only)` : ""} — try enabling Spring/Summer, raising the credit cap, or extending the horizon.`,
    }));
    return { problems, unscheduled };
  }

  /* ----------------------------- scoring ----------------------------- */
  function scorePlan(state) {
    const { profile, terms, assign, load } = state;
    const w = profile.weights;
    const lease12 = profile.settings.housing === "off-campus-12mo";
    const minFW = profile.settings.minCreditsFW || 12;

    const activeIdx = new Set(assign.values());
    let lastIdx = 0, firstIdx = Infinity;
    activeIdx.forEach(t => { lastIdx = Math.max(lastIdx, t); firstIdx = Math.min(firstIdx, t); });

    // per-term stats
    let spsuCredits = 0, partTimeFW = 0, spsuTerms = 0;
    const hardByTerm = new Map();
    terms.forEach(tm => {
      if (!activeIdx.has(tm.index)) return;
      if (tm.isFW) {
        if (load[tm.index] < minFW) partTimeFW++;
      } else { spsuTerms++; spsuCredits += load[tm.index]; }
    });
    terms.forEach(tm => {
      if (!activeIdx.has(tm.index) || !tm.isFW) return;
      let hard = 0;
      assign.forEach((t, uid) => {
        if (t !== tm.index) return;
        if (state.byUid.get(uid).course.diff >= HARD_DIFF) hard++;
      });
      hardByTerm.set(tm.index, hard);
    });

    // SPEED — finish line + number of enrolled terms
    const speed = lastIdx * 1.4 + activeIdx.size * 0.5;

    // COST — part-time F/W wastes the flat-tuition band; Sp/Su tuition is extra,
    // but a 12-month lease means housing for Sp/Su is already paid (cheaper to use it)
    const cost = partTimeFW * 4 + spsuCredits * (lease12 ? 0.25 : 0.9) + spsuTerms * (lease12 ? 0.2 : 1) + lastIdx * 0.35;

    // RISK — hard-course stacking
    let risk = 0;
    hardByTerm.forEach(h => { if (h >= 3) risk += (h - 2) * (h - 2) * 4; else if (h === 2) risk += 1; });
    // (No "workload evenness" objective: real MyMAPs simply get harder as the
    // chain deepens. Spreading difficulty was re-ordering prereq chains badly.)

    // LIFE — crammed terms, heavy streaks, religion pacing
    let life = 0;
    let streak = 0;
    terms.forEach(tm => {
      if (!tm.isFW || !activeIdx.has(tm.index)) { return; }
      life += Math.max(0, load[tm.index] - (profile.settings.maxCreditsFW - 1)) * 0.8;
      if (load[tm.index] >= 16) { streak++; if (streak >= 3) life += 2.5; }
      else streak = 0;
    });
    if (profile.settings.religionPacing) {
      const relTermYears = new Set(), activeYears = new Set();
      assign.forEach((t, uid) => {
        const tm = terms[t];
        if (!tm.isFW) return;
        const ay = tm.season === "F" ? tm.year : tm.year - 1;
        activeYears.add(ay);
        if (baseId(uid).startsWith("REL")) relTermYears.add(ay);
      });
      activeYears.forEach(y => { if (!relTermYears.has(y)) life += 1.2; });
    }

    // STRUCTURE (fixed weight — BYU-advisement heuristics, not user dials):
    let structure = 0;
    const relPerTerm = new Map();
    const gePerTerm = new Map();     // GE (non-religion University Core) per term
    assign.forEach((t, uid) => {
      const i = state.byUid.get(uid);
      const c = i.course;
      // 1) GE courses early — clear University Core in the first years
      // (soft: foundational 100-level major chains below outrank it, so
      // MATH 112 or a freshman project can share year 1 with the GEs)
      // pure GE only: a major course double-counting a GE lives on the
      // major's timeline, not the "generals early / none senior year" rule
      const isGE = i.buckets && i.buckets.some(b => b.startsWith("univ-core::") && !b.includes("rel")) &&
                   !i.buckets.some(b => !b.startsWith("univ-core::"));
      if (isGE) {
        structure += t * 0.15;
        gePerTerm.set(t, (gePerTerm.get(t) || 0) + 1);
      }
      const yr = acadYearIdx(terms, t);
      const hint = state.fcHint && state.fcHint[baseId(uid)];
      if (hint) {
        // 2a) FLOWCHART PLACEMENT — the department's official chart is
        //     authoritative: pull the course to its recommended year+season.
        const dy = Math.abs(yr - (hint.y - 1));
        structure += dy * dy * 7;
        if (terms[t].isFW && terms[t].season !== hint.s) structure += 3;
      } else {
        // 2b) LEVEL PACING (fallback where no flowchart exists) — a 300/400/500
        //     course before its recommended year is heavily penalized (stops
        //     400s in freshman year); low levels lingering late are pushed down.
        const lvl = courseLevel(c);
        const early = minYearForLevel(lvl) - yr;
        if (early > 0) structure += early * early * 6;
        // no 300+ courses in freshman year (rare forced exceptions survive
        // the relaxed seeding pass, but the optimizer strongly moves them out)
        if (yr === 0 && lvl >= 3 && !c.placeholder) structure += 18;
        // natural difficulty ramp: a course with a deep dependent chain
        // (MATH 113 → 302 → …) belongs EARLY — its whole chain waits on it
        if (state.depths) {
          const d = state.depths.get(uid) || 1;
          if (d >= 2 && !c.placeholder && !c.elective) structure += yr * (d - 1) * 1.3;
        }
        if (!c.placeholder) {
          const isFreshmanOnly = /\b19\d[A-Z]?\b/.test(c.display || c.id || "");
          const lateLimit = isFreshmanOnly ? 0 : lvl <= 1 ? 1 : lvl === 2 ? 2 : 99;
          const late = yr - lateLimit;
          if (late > 0) structure += late * (isFreshmanOnly ? 8 : lvl <= 1 ? 5 : 2.5);
        }
      }
      // 3) religion spread — tally per term, penalize stacking below
      if (c.isReligion || baseId(uid).startsWith("REL")) {
        relPerTerm.set(t, (relPerTerm.get(t) || 0) + 1);
      }
    });
    // religion: one per term is ideal; each extra in a term is penalized
    relPerTerm.forEach(n => { if (n > 1) structure += (n - 1) * 4; });
    // GE spread: real MyMAPs don't stack every general up front. Cap per term
    // by year — freshman ≤3, sophomore ≤2, everything after ≤1 — and penalize
    // the overflow so generals trickle through sophomore/junior year too.
    gePerTerm.forEach((n, t) => {
      const yr = acadYearIdx(terms, t);
      const capGE = yr === 0 ? 3 : yr === 1 ? 2 : 1;
      if (n > capGE) structure += (n - capGE) * (n - capGE) * 3;
    });
    // 4) Fall/Winter fill first: a used Spring/Summer term while an EARLIER
    //    Fall/Winter still has 3+ spare credits wastes the flat-tuition band
    terms.forEach(tm => {
      if (tm.isFW || !activeIdx.has(tm.index) || load[tm.index] <= 0) return;
      const wasted = terms.some(f =>
        f.index < tm.index && f.isFW && f.enabled && activeIdx.has(f.index) &&
        (f.cap - load[f.index]) >= 3);
      if (wasted) structure += 2.5;
    });
    // 5) plan SHAPE (advisement rules, fixed weight):
    //    - the LAST TWO semesters carry the lightest load (≤14 cr ideally)
    //    - no GE courses in those final two semesters
    //    - every enrolled Fall/Winter stays at/above full time (12 cr)
    //    - no gap semesters (enrolled Winter, skip Fall, enrolled Winter)
    //    - prefer finishing in Winter (Fall finish is allowed, mildly worse)
    const fwActive = terms.filter(tm => tm.isFW && activeIdx.has(tm.index)).map(tm => tm.index);
    const lastTwo = new Set(fwActive.slice(-2));
    lastTwo.forEach(t => {
      structure += Math.max(0, load[t] - 14) * 2.2      // over the senior taper
                 + Math.max(0, load[t] - 10) * 0.25;    // gently: lighter is better
    });
    gePerTerm.forEach((n, t) => { if (lastTwo.has(t)) structure += n * 8; });
    fwActive.forEach(t => { if (load[t] < minFW) structure += (minFW - load[t]) * 2.0; });
    // over BYU's 18-credit registration cap (a rigid envelope can force a term
    // over; everything MOVABLE should clear out of its way)
    fwActive.forEach(t => { if (load[t] > BYU_HARD_CAP) structure += (load[t] - BYU_HARD_CAP) * 9; });
    for (let t = firstIdx + 1; t < lastIdx; t++) {
      const tm = terms[t];
      if (tm.isFW && tm.enabled && load[t] === 0) structure += 15;
    }
    if (fwActive.length && terms[fwActive[fwActive.length - 1]].season === "F") structure += 2.5;

    const total =
      (w.speed / 5) * speed + (w.cost / 5) * cost + (w.risk / 5) * risk +
      (w.life / 5) * life + structure;
    return { total, parts: { speed, cost, risk, life, structure } };
  }

  /* --------------------------- improvement --------------------------- */
  function improve(state, iterations, seedNum) {
    const rnd = mulberry32(seedNum);
    const movable = state.instances.filter(i =>
      state.assign.has(i.uid) && !state.pinnedUids.has(i.uid) && !state.blockOf.has(i.uid));
    if (!movable.length) return;

    // moving a course must not break dependents scheduled after it
    const dependentsOf = uid => {
      const bid = baseId(uid);
      const out = [];
      state.instances.forEach(i => {
        if (i.uid !== uid && i.course.pre.flat().includes(bid)) out.push(i);
        if (baseId(i.uid) === bid && i.k > state.byUid.get(uid).k) out.push(i); // later repeats
      });
      return out;
    };
    const earliestDependentTerm = uid => {
      let m = Infinity;
      dependentsOf(uid).forEach(d => {
        const t = state.assign.get(d.uid);
        if (t !== undefined) m = Math.min(m, t);
      });
      return m;
    };

    let best = scorePlan(state).total;
    for (let it = 0; it < iterations; it++) {
      const inst = movable[(rnd() * movable.length) | 0];
      const from = state.assign.get(inst.uid);
      const depLimit = earliestDependentTerm(inst.uid);
      // candidate terms
      const cands = [];
      for (let t = 0; t < state.terms.length; t++) {
        if (t === from || t >= depLimit) continue;
        unplace(state, inst);
        const ok = canPlace(state, inst, t);
        place(state, inst, from);
        if (ok) cands.push(t);
      }
      if (!cands.length) continue;
      const to = cands[(rnd() * cands.length) | 0];
      unplace(state, inst);
      place(state, inst, to);
      const s = scorePlan(state).total;
      if (s <= best) { best = s; }
      else { unplace(state, inst); place(state, inst, from); }
    }
  }

  /* Compound move the hill-climber can't make: EMPTY a below-minimum term by
     relocating all its courses at once (each single move alone scores worse,
     so improve() gets stuck with 5-credit straggler semesters at the end). */
  /* earliest term any scheduled dependent (or later repeat) of uid sits in */
  function depLimitOf(state, uid) {
    const bid = baseId(uid);
    let m = Infinity;
    state.instances.forEach(i => {
      if (i.uid === uid) return;
      const t = state.assign.get(i.uid);
      if (t === undefined) return;
      if (i.course.pre.flat().includes(bid)) m = Math.min(m, t);
      if (baseId(i.uid) === bid && i.k > state.byUid.get(uid).k) m = Math.min(m, t);
    });
    return m;
  }

  function consolidate(state) {
    const minFW = state.profile.settings.minCreditsFW || 12;
    for (let round = 0; round < 3; round++) {
      const activeIdx = new Set(state.assign.values());
      const lows = state.terms
        .filter(tm => tm.isFW && activeIdx.has(tm.index) && state.load[tm.index] < minFW)
        .map(tm => tm.index).sort((a, b) => b - a);   // latest first
      let emptied = false;
      for (const t of lows) {
        const uids = [...state.assign].filter(([, tt]) => tt === t).map(([uid]) => uid);
        if (uids.some(u => state.pinnedUids.has(u) || state.blockOf.has(u))) continue;
        const before = scorePlan(state).total;
        const moved = [];
        let ok = true;
        for (const uid of uids) {
          const inst = state.byUid.get(uid);
          const depLimit = depLimitOf(state, uid);
          unplace(state, inst);
          let placed = false;
          for (let x = 0; x < state.terms.length && x < depLimit; x++) {
            if (x === t) continue;
            if (canPlace(state, inst, x)) { place(state, inst, x); moved.push(inst); placed = true; break; }
          }
          if (!placed) { place(state, inst, t); ok = false; break; }
        }
        if (!ok || scorePlan(state).total > before) {
          moved.forEach(inst => { unplace(state, inst); place(state, inst, t); });
        } else if (ok) { emptied = true; }
      }
      if (!emptied) break;
    }
  }

  /* The mirror compound move: when the FINAL terms sit at 17-18 credits and
     every earlier term is full, single moves can't open a new light semester
     (the first course moved there scores terribly alone). Move a batch of
     tail courses into the next empty F/W term at once; keep it if it scores. */
  function expandTail(state) {
    for (let round = 0; round < 2; round++) {
      const activeIdx = new Set(state.assign.values());
      const fw = state.terms.filter(tm => tm.isFW && activeIdx.has(tm.index)).map(tm => tm.index);
      if (fw.length < 2) return;
      const lastTwo = fw.slice(-2);
      const over = lastTwo.filter(t => state.load[t] > 14);
      if (!over.length) return;
      const next = state.terms.find(tm => tm.index > fw[fw.length - 1] && tm.isFW && tm.enabled);
      if (!next) return;
      const before = scorePlan(state).total;
      const moved = [];
      for (const t of over) {
        const cands = [...state.assign].filter(([, tt]) => tt === t)
          .map(([uid]) => state.byUid.get(uid))
          .filter(i => !state.pinnedUids.has(i.uid) && !state.blockOf.has(i.uid) &&
                       depLimitOf(state, i.uid) > next.index)
          .sort((a, b) => a.course.credits - b.course.credits);
        for (const inst of cands) {
          if (state.load[t] <= 14) break;
          unplace(state, inst);
          if (canPlace(state, inst, next.index)) { place(state, inst, next.index); moved.push([inst, t]); }
          else place(state, inst, t);
        }
      }
      if (!moved.length) return;
      if (scorePlan(state).total > before) {   // didn't pay off — revert
        moved.forEach(([inst, t]) => { unplace(state, inst); place(state, inst, t); });
        return;
      }
    }
  }

  /* ----------------------------- analysis ---------------------------- */
  function analyze(state, expandRes, programs, problems) {
    const { profile, terms, assign, cat, completed } = state;
    const flags = [];
    const courseFlags = new Map(); // uid -> [{level,text}]
    const addCF = (uid, level, text) => {
      if (!courseFlags.has(uid)) courseFlags.set(uid, []);
      courseFlags.get(uid).push({ level, text });
    };

    problems.forEach(p => flags.push({ level: "error", icon: "ban", text: p.text }));
    expandRes.warnings.forEach(wn => flags.push({ level: "warn", icon: "triangle-exclamation", text: wn.text }));

    // credits completed before each term -> registration-priority proxy
    let compCredits = 0;
    completed.forEach(id => { if (cat[id]) compCredits += cat[id].credits; });
    const creditsBefore = terms.map(() => compCredits);
    assign.forEach((t, uid) => {
      const cr = state.byUid.get(uid).course.credits;
      for (let i = t + 1; i < terms.length; i++) creditsBefore[i] += cr;
    });

    assign.forEach((t, uid) => {
      const c = state.byUid.get(uid).course;
      if (c.demand === "high" && creditsBefore[t] < 60) {
        addCF(uid, "warn", `Fills fast — with ~${Math.round(creditsBefore[t])} earned credits your registration window opens late. Register the minute it opens.`);
      }
      if (c.rare) {
        addCF(uid, "warn", `Rarely offered (${[...c.off].map(s => SEASON_NAME[s]).join("/")} only). Single point of failure — missing it could slip graduation.`);
      }
      if (c.testOut) addCF(uid, "info", `Test-out option: ${c.testOut}`);
      if (c.note) addCF(uid, "note", c.note);

      // PREREQUISITE check — real catalog chains. A course whose prereq isn't
      // completed or scheduled strictly earlier gets a visible warning (moves
      // and pins can create this; the solver itself won't).
      const inst = state.byUid.get(uid);
      if (inst.k === 1) {
        (c.pre || []).forEach(group => {
          const opts = Array.isArray(group) ? group : [group];
          const ok = opts.some(g => {
            if (completed.has(g)) return true;
            for (const [uid2, t2] of assign) if (baseId(uid2) === g && t2 < t) return true;
            return false;
          });
          if (!ok) {
            const names = opts.map(g => cat[g]?.display || g).join(" or ");
            addCF(uid, "warn", `Prerequisite not planned: needs ${names} in an earlier semester (or already completed).`);
          }
        });
      }
      // DOUBLE-COUNT note — one class filling requirements in two programs
      // (e.g. a required major course that also covers a GE category)
      const dcProgs = new Set((inst.buckets || [])
        .filter(b => !/^(electives|prereq)::/.test(b) && !/::flowchart$/.test(b))
        .map(b => (DATA.programIndex[b.split("::")[0]] || {}).name || b.split("::")[0]));
      if (dcProgs.size >= 2) {
        addCF(uid, "info", `Double-counts: fills requirements in ${[...dcProgs].join(" and ")} with one class.`);
      }

      // SEASON check — pinned/moved courses can sit in a term the class
      // isn't normally taught.
      const tm = terms[t];
      if (tm && c.off && !c.off.includes(tm.season)) {
        addCF(uid, "warn", `${c.display || baseId(uid)} isn't normally taught in ${SEASON_NAME[tm.season]} (offered: ${[...c.off].map(s => SEASON_NAME[s]).join(", ")}).`);
      }
    });

    // hard-course stacking per term
    terms.forEach(tm => {
      let hard = 0; const names = [];
      assign.forEach((t, uid) => {
        if (t !== tm.index) return;
        const c = state.byUid.get(uid).course;
        if (c.diff >= HARD_DIFF) { hard++; names.push(c.display || baseId(uid)); }
      });
      if (hard >= 3) flags.push({ level: "warn", icon: "layer-group", text: `${tm.label} stacks ${hard} historically hard courses (${names.join(", ")}) — finals week collision risk.` });
    });

    // part-time Fall/Winter warning
    const minFW = profile.settings.minCreditsFW || 12;
    terms.forEach(tm => {
      const active = [...assign.values()].includes(tm.index);
      if (active && tm.isFW && state.load[tm.index] < minFW) {
        flags.push({ level: profile.settings.scholarshipFullTime ? "warn" : "info", icon: "gauge-simple-low", text: `${tm.label} is below ${minFW} credits${profile.settings.scholarshipFullTime ? " — scholarship / full-time status risk" : ""}.` });
      }
    });

    // lease utilization hint
    const spsuUsed = [...assign.values()].some(t => !terms[t].isFW);
    if (profile.settings.housing === "off-campus-12mo" && !spsuUsed) {
      flags.push({ level: "info", icon: "house", text: "Your 12-month lease already covers Spring/Summer housing — a Spring term is nearly free on the housing side and could lighten Fall/Winter loads." });
    }

    // cohort notices
    state.blocks.forEach(blk => {
      const t = assign.get(blk.uids[0]);
      if (t !== undefined) flags.push({ level: "info", icon: "people-group", text: `${blk.label} locked as a cohort in ${terms[t].label}.` });
    });

    // MISM application gate
    if (profile.majorId === "is-bs-mism") {
      const jcw = state.blocks.get("jcw"), jcwT = jcw ? assign.get(jcw.uids[0]) : undefined;
      if (jcwT !== undefined) flags.push({ level: "info", icon: "flag-checkered", text: `MISM application is due during ${terms[jcwT].label} (Junior Core winter). The solver keeps all MISM prerequisites before this gate.` });
    }

    return { flags, courseFlags };
  }

  /* progress-report data: per program -> buckets -> fill status */
  function progressReport(profile, programs, cat, chosen, completed, assign, byUid) {
    return programs.map(p => {
      const buckets = p.buckets.map(b => {
        const key = `${p.id}::${b.id}`;
        const isGroup = b.pick.type === "group";
        // group buckets keep courses in .groups, not .options — union them
        const opts = isGroup
          ? [...new Set((b.groups || []).flatMap(g => g.options || []))].filter(id => cat[id])
          : bucketOptions(b, cat);
        let needC = b.pick.type === "credits" ? b.pick.n : null;
        let needN = b.pick.type === "courses" ? b.pick.n
                  : b.pick.type === "all" ? opts.length
                  : isGroup ? (b.pick.k || 1) : null;
        let doneC = 0, planC = 0, doneN = 0, planN = 0;
        const rows = [];
        opts.forEach(id => {
          const rec = chosen.get(id);
          const inBucket = rec && rec.buckets.has(key) || (b.pick.type === "all" && (completed.has(id) || rec));
          if (completed.has(id)) { doneC += cat[id].credits; doneN++; rows.push({ id, status: "done" }); }
          else if (inBucket) {
            const inst = rec ? rec.instances : 1;
            planC += cat[id].credits * inst; planN++;
            rows.push({ id, status: "planned", instances: inst });
          }
        });
        // open dropdown SLOTS assigned to this bucket count as planned too
        chosen.forEach((rec, id) => {
          if (!cat[id] || !cat[id].bucket || !rec.buckets.has(key)) return;
          planC += cat[id].credits * rec.instances; planN += rec.instances;
          rows.push({ id, status: "slot", instances: rec.instances, label: cat[id].display, reqLabel: cat[id].reqLabel });
        });
        const totalNeed = needC ?? (needN ?? 0) * 3;
        const gotDone = needC != null ? doneC : doneN * 3;
        const gotPlan = needC != null ? planC : planN * 3;
        return {
          id: b.id, name: b.name, note: b.note || null,
          need: needC != null ? `${needC} cr`
              : isGroup ? `${b.pick.k || 1} of ${(b.groups || []).length} options`
              : `${needN} course${needN === 1 ? "" : "s"}`,
          pctDone: totalNeed ? Math.min(1, gotDone / totalNeed) : 1,
          pctPlan: totalNeed ? Math.min(1, (gotDone + gotPlan) / totalNeed) : 1,
          rows,
        };
      });
      const pctDone = buckets.reduce((s, b) => s + b.pctDone, 0) / Math.max(1, buckets.length);
      const pctPlan = buckets.reduce((s, b) => s + b.pctPlan, 0) / Math.max(1, buckets.length);
      return { id: p.id, name: p.name, type: p.type, credits: p.credits, detailed: p.detailed !== false, pctDone, pctPlan, buckets, notes: p.notes || [] };
    });
  }

  /* ------------------------------ solve ------------------------------ */
  function solve(profile, opts = {}) {
    const t0 = performance.now();
    const programs = collectPrograms(profile);
    const cat = buildCatalog(programs);
    const terms = buildTerms(profile);
    const expandRes = expand(profile, programs, cat);
    const instances = buildInstances(expandRes.chosen, expandRes.completed, cat);
    const state = makeState(profile, terms, instances, cat, expandRes.completed);
    // flowchart placement hints: courseId -> {y (1-based year), s (F/W)}. The
    // official department flowchart, where we have one, overrides the generic
    // level-pacing heuristic for those courses.
    state.fcHint = {};
    programs.forEach(p => {
      if (!p.flowchartPlan) return;
      for (const code in p.flowchartPlan) {
        if (!state.fcHint[code]) state.fcHint[code] = p.flowchartPlan[code];
      }
    });

    const { problems, unscheduled } = seed(state, programs);
    const seedNum = (hashStr(JSON.stringify({
      m: profile.majorId, mi: profile.minorIds, c: profile.certIds, w: profile.weights,
    })) ^ (opts.shuffleSeed || 0)) >>> 0;
    improve(state, opts.iterations ?? 1600, seedNum);
    consolidate(state);                        // empty straggler light terms
    expandTail(state);                         // open a light final term if the tail is crammed
    improve(state, 400, seedNum ^ 0x9e3779b9); // settle after the compound moves

    const score = scorePlan(state);
    const { flags, courseFlags } = analyze(state, expandRes, programs, problems);
    const progress = progressReport(profile, programs, cat, expandRes.chosen, expandRes.completed, state.assign, state.byUid);

    // serializable placements for the UI
    const placements = [];
    state.assign.forEach((t, uid) => {
      const inst = state.byUid.get(uid);
      placements.push({
        uid, termIndex: t,
        courseId: baseId(uid), display: inst.course.display || baseId(uid),
        name: inst.course.name, credits: inst.course.credits,
        diff: inst.course.diff, buckets: inst.buckets,
        pinned: state.pinnedUids.has(uid), block: state.blockOf.get(uid) || null,
        repTotal: inst.total > 1 ? inst.total : null,
        flags: courseFlags.get(uid) || [],
        placeholder: !!inst.course.placeholder, elective: !!inst.course.elective,
        bucket: !!inst.course.bucket, isReligion: !!inst.course.isReligion,
        bucketKey: inst.course.bucket ? (inst.buckets && inst.buckets[0]) : null,
        fillKey: inst.course.fillKey || null,
        reqLabel: inst.course.reqLabel || null,
        groupIdx: inst.course.bucketRef ? inst.course.bucketRef.groupIdx : null,
      });
    });

    if (expandRes.doubleCounted > 0) {
      flags.push({ level: "info", icon: "clone", text: `${expandRes.doubleCounted} credits double-counted across programs (cap: ${profile.settings.doubleCountCap} cr).` });
    }

    return {
      terms, placements, programs: programs.map(p => p.id),
      progress, flags, groupSel: expandRes.groupSel,
      score, doubleCounted: expandRes.doubleCounted,
      unscheduled: unscheduled.map(i => ({ uid: i.uid, name: i.course.name })),
      solveMs: Math.round(performance.now() - t0),
      state, // kept live for drag-drop validation
    };
  }

  /* validate a manual drag of uid -> targetTerm on a solved state */
  function validateMove(result, uid, targetTermIndex) {
    const state = result.state;
    const inst = state.byUid.get(uid);
    if (!inst) return { ok: false, reason: "Unknown course." };
    if (state.blockOf.has(uid)) return { ok: false, reason: "This course is part of a locked cohort block — the whole block moves together." };
    const term = state.terms[targetTermIndex];
    if (!term || !term.enabled) return { ok: false, reason: "That term isn't enabled in your settings." };
    if (!inst.course.off.includes(term.season)) {
      return { ok: false, reason: `${inst.course.display || uid} isn't offered in ${SEASON_NAME[term.season]} (offered: ${[...inst.course.off].map(s => SEASON_NAME[s]).join(", ")}).` };
    }
    const from = state.assign.get(uid);
    unplace(state, inst);
    const newLoad = state.load[targetTermIndex] + inst.course.credits;
    const preOk = prereqSatisfied(state, inst, targetTermIndex);
    // dependents must stay after
    let depOk = true, depName = "";
    state.instances.forEach(i => {
      const t2 = state.assign.get(i.uid);
      if (t2 === undefined) return;
      if (i.course.pre.flat().includes(baseId(uid)) && t2 <= targetTermIndex) { depOk = false; depName = i.course.display || baseId(i.uid); }
      if (baseId(i.uid) === baseId(uid) && i.k > inst.k && t2 <= targetTermIndex) { depOk = false; depName = i.course.display || baseId(i.uid); }
    });
    place(state, inst, from);
    if (!preOk) return { ok: false, reason: `Prerequisites for ${inst.course.display || uid} wouldn't be complete before ${term.label}.` };
    if (!depOk) return { ok: false, reason: `${depName} depends on this course and is scheduled too early.` };
    // Credit caps WARN instead of block — students can move things around;
    // BYU's own registration cap is 18 (above that needs college approval).
    let warn = null;
    if (newLoad > BYU_HARD_CAP) {
      warn = `${term.label} would be at ${newLoad} credits — over BYU's ${BYU_HARD_CAP}-credit registration cap (requires college approval).`;
    } else if (newLoad > term.cap) {
      warn = `${term.label} would be at ${newLoad} credits — over the ${term.cap}-credit cap you set.`;
    }
    return { ok: true, warn };
  }

  function applyMove(result, uid, targetTermIndex) {
    const state = result.state;
    const inst = state.byUid.get(uid);
    unplace(state, inst);
    place(state, inst, targetTermIndex);
    const p = result.placements.find(p => p.uid === uid);
    if (p) { p.termIndex = targetTermIndex; p.pinned = true; }
    state.pinnedUids.add(uid);
    result.score = scorePlan(state);
  }

  return { solve, validateMove, applyMove, SEASON_NAME };
})();
