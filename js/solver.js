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
  const FULL_TIME_CREDITS = 12; // BYU full-time line (scholarships, aid, housing)

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
  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* ------------------------------ terms ------------------------------ */
  function buildTerms(profile) {
    const { startTerm, settings } = profile;
    const terms = [];
    let { year, season } = startTerm;
    let si = SEASONS.indexOf(season);
    // The horizon stays generous on purpose: it is a canvas, not a target. The
    // optimizer packs as early as it can, and what actually bounds a plan's
    // length is state.termBudget below. Keeping the canvas wide leaves the
    // budget's relief valve somewhere to go when a target proves impossible.
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
    // TARGET GRADUATION (tester request: "put my desired graduation date and
    // pace that way"). The target simply ENDS THE CANVAS: terms after it are
    // disabled, and every downstream system already respects that — MAP-sheet
    // binding skips disabled terms, canPlace refuses them, backfill never
    // reaches them. So an impossible target degrades through the EXISTING
    // honesty machinery (unscheduled list, error flags, one-click Spring/
    // Summer recommendation) instead of a parallel code path that would need
    // its own guarantees. analyze() adds one summary flag naming the target.
    if (settings.targetGrad && settings.targetGrad.year) {
      const tg = terms.find(t => t.year === settings.targetGrad.year
                              && t.season === settings.targetGrad.season);
      if (tg) {
        terms.forEach(t => { if (t.index > tg.index) t.enabled = false; });
        terms.targetIdx = tg.index;
      }
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

  /* course level from its code number: IS 303 -> 3, ACC 200 -> 2, MATH 110 -> 1.
     [A-Z]? handles repeatable/suffixed numbers (MUSIC 460R, CPSE 486R) — the
     old \b-only regex failed on the R and silently leveled every repeatable
     course as 2, letting 400-level ensembles/practica pace like freshman work. */
  function courseLevel(course) {
    if (course.level) return course.level;
    const m = (course.display || course.id || "").match(/(\d)\d{2}[A-Z]?\b/);
    return m ? +m[1] : 2;
  }
  /* earliest academic-year index a level should appear (0 = freshman year).
     Prereq data is sparse in the catalog, so LEVEL is our main pacing signal:
     400s out of freshman year, 500s (grad/MISM) junior+, GE/100s front-loaded. */
  function minYearForLevel(level) {
    return level <= 2 ? 0 : level === 3 ? 1 : level === 4 ? 2 : 3;
  }
  /* academic-year index of a term (0-based). Plan-relative year PLUS the
     student's standing offset (terms.yearOffset — ~1 per 30 earned credits):
     a junior's first plan year IS academic year 3. Every year-keyed rule
     reads through here, so the one offset transparently re-aligns MAP-sheet
     term binding, flowchart-hint pacing, level pacing, senior-standing minY,
     admission gates, and hardMinYear for mid-degree students. */
  function acadYearIdx(terms, t) {
    const ay = tm => (tm.season === "F" ? tm.year : tm.year - 1);
    return ay(terms[t]) - ay(terms[0]) + (terms.yearOffset || 0);
  }

  /* Build (or reuse) a labeled bucket placeholder: a schedulable card that
     stands for "one Arts GE" / "one Religion Cornerstone" / "one elective"
     and carries a curated, easy-first suggestion list for its dropdown. */
  function makeBucketPlaceholder(cat, program, bucket, realPool, isReligion, slotCr, completed, group, idSuffix) {
    // per-GROUP placeholders: "choose 2 of 5 options" realizes each chosen
    // option-group as its OWN slot with its own suggestion pool — sharing one
    // id made the second group's slot vanish and mixed suggestion lists.
    // idSuffix isolates a differently-sized slot (a leftover-hours remainder).
    const id = `BUCKET::${program.id}::${bucket.id}` + (group ? `::g${group.gi}` : "") + (idSuffix || "");
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
      // level + difficulty from the REAL option pool: an "IS Senior Electives"
      // bucket whose choices are all 400-level should itself read as a
      // 400-level slot (so it paces to junior/senior year, not sophomore) and
      // carry their difficulty (so it counts toward hard-semester spread).
      const optLevels = realPool.map(c => cat[c] && courseLevel(cat[c])).filter(Boolean).sort((a, b) => a - b);
      const optDiffs = realPool.map(c => cat[c] && cat[c].diff).filter(v => v != null);
      // Pace a CHOICE slot by a LOW percentile of its options' levels, not the
      // median: "choose 1 of {STAT 121, STAT 201, MATH 431}" is realistically
      // the 100-level stat (the easy-first default), so the slot should pace to
      // sophomore year — not drift to senior because one hard 400-level option
      // drags the median up. The 20th percentile (not the raw min) ignores a
      // lone low outlier among many genuinely upper-division options.
      const poolLevel = optLevels.length ? optLevels[Math.floor(0.2 * (optLevels.length - 1))] : null;
      const poolDiff = optDiffs.length ? median(optDiffs) : null;
      const baseLevel = program.id === "univ-core" ? 1 : 2;
      cat[id] = {
        id, display: shortBucketLabel(program, bucket, group),
        name: group ? group.label : bucket.name,
        credits: slotCr, pre: [], off,                      // constrained to where options are taught
        diff: isReligion ? 2 : (poolDiff != null ? poolDiff : 3),
        load: 1, demand: "med", rare: false,
        tags: [], testOut: null, repeatMax: 99, note: null,
        placeholder: true, bucket: true, isReligion: !!isReligion,
        // GE/religion front-load (level 1); a program elective slot inherits
        // its options' level so upper-division slots don't drift to freshman yr
        level: program.id === "univ-core" ? 1 : (poolLevel != null ? Math.max(1, poolLevel) : baseLevel),
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
  /* set by expand(): courseId -> {fillKey, bucketKey, groupIdx} for classes the
     student chose from a dropdown slot — the UI keeps these swappable */
  let _fillMeta = null;

  function placeholderFill(cat, program, bucket, realPool, key, slots, completed, take, profile, group) {
    const isRel = /(^|[^a-z])rel/i.test(bucket.id) || /religion/i.test(bucket.name);
    // slot credit = the options' TYPICAL credit, not a hardcoded 3 — a "1 of 4
    // lecture-series (1 cr)" requirement was showing (and loading) as 3 cr, and
    // a credit-based bucket now divides by the real per-course credit.
    const optCreds = realPool.map(id => cat[id] && cat[id].credits).filter(v => v != null);
    // Attribute-defined credit requirement whose few listed courses fall far
    // short of the need (ChemE tech electives: 3 cr of 1-cr labs toward 15 cr)
    // — size slots at a normal 3 cr, not the tiny pool median (which would make
    // fifteen 1-cr slots).
    const poolTotalCr = optCreds.reduce((s, c) => s + c, 0);
    const underEnum = bucket.pick && bucket.pick.type === "credits" && poolTotalCr < bucket.pick.n - 2.5;
    // For an "N hours" requirement, recommend the FEWEST classes the pool
    // honestly supports: among credit sizes with a real choice of options
    // (≥3 courses or ≥25% of the pool), pick the one needing the fewest
    // slots, tie-broken by the cleanest fit (EC EN "8 hours": pools of 3s
    // AND 4s → two 4-cr classes, not three 3s; a mostly-3s humanities pool
    // still gets 3-cr slots because 4s aren't a real choice there).
    const fewestSlotCr = () => {
      if (!optCreds.length) return 3;
      const need = bucket.pick && bucket.pick.type === "credits" ? bucket.pick.n : null;
      if (need == null) return Math.max(0.5, median(optCreds));
      const freq = new Map();
      optCreds.forEach(c => freq.set(c, (freq.get(c) || 0) + 1));
      const cands = [...freq.keys()].filter(c =>
        freq.get(c) >= 3 || freq.get(c) >= optCreds.length * 0.25);
      if (!cands.length) return Math.max(0.5, median(optCreds));
      cands.sort((a, b) => {
        const na = Math.ceil(need / a), nb = Math.ceil(need / b);
        if (na !== nb) return na - nb;                     // fewest classes
        const ra = na * a - need, rb = nb * b - need;
        if (ra !== rb) return ra - rb;                     // least overshoot
        return b - a;                                      // then bigger classes
      });
      return Math.max(0.5, cands[0]);
    };
    const slotCr = isRel ? 2 : underEnum ? 3 : fewestSlotCr();
    const alreadyDone = realPool.filter(id => completed.has(id)).length;
    // double-count awareness: a required program course that ALSO satisfies
    // this GE bucket covers a slot (within the double-count cap) — no extra
    // GE class needed, and the progress report shows it filling both.
    let covered = [];
    if (_preRequired) {
      const pre = realPool.filter(id => _preRequired.has(id) && !completed.has(id));
      // Cover only up to the bucket's NEED. A pool can hold several
      // pre-required courses (the EE sheet codes PHSCS 121 AND CHEM 105, both
      // in the 1-course Physical Science GE) — taking every one burns the
      // cross-program double-count budget on a bucket a single course already
      // satisfies, which starves legitimate double-counts elsewhere.
      const isCredits = bucket.pick && bucket.pick.type === "credits";
      const needN = isCredits ? bucket.pick.n
        : (slots != null ? slots : (bucket.pick && bucket.pick.n) || 1);
      let got = 0;
      for (const id of pre) {
        if (got >= needN) break;
        if (program.id === "univ-core") {
          // GE bucket auto-covered by a required major course (double-count,
          // capped, and shown on the progress report)
          if (!take(id, key, 1)) continue;
        }
        // else: a course this program REQUIRES outright (pick:all, sole
        // option, forced flowchart core, MAP-coded) also satisfies its own
        // "choose N / N hours" requirement — reduce the need without
        // consuming the cross-program double-count budget.
        covered.push(id);
        got += isCredits ? (cat[id].credits || 3) : 1;
      }
    }
    // group slots record their fills under a per-group key so choosing a class
    // for Option 8.1 can't leak into Option 8.3's slot
    const fillKey = key + (group ? `::g${group.gi}` : "");
    const fills = ((profile.fills || {})[fillKey] || []).filter(cid => cat[cid]);
    fills.forEach(cid => {
      take(cid, key, 1);
      if (_fillMeta) _fillMeta.set(cid, { fillKey, bucketKey: key, groupIdx: group ? group.gi : null });
    });
    // CREDIT-based requirement ("Complete 3 hours"): track REMAINING HOURS, not
    // a fixed slot count. If the student fills a 1-cr class against a 3-hr
    // requirement, 2 hours remain and a slot must stay — the old count-based
    // math wrongly marked it done. Slot credit shrinks to the leftover hours so
    // the plan's credit total stays exact.
    if (slots == null && bucket.pick && bucket.pick.type === "credits") {
      const cr = id => cat[id].credits || 3;
      const doneCr = realPool.filter(id => completed.has(id)).reduce((s, id) => s + cr(id), 0)
        + fills.reduce((s, id) => s + cr(id), 0) + covered.reduce((s, id) => s + cr(id), 0);
      let remCr = bucket.pick.n - doneCr;
      if (remCr <= 0.01) return;
      // full-size slots, then one smaller slot for any leftover fraction
      const full = Math.floor(remCr / slotCr + 1e-9);
      if (full > 0) take(makeBucketPlaceholder(cat, program, bucket, realPool, isRel, slotCr, completed, group), key, full);
      const rem = +(remCr - full * slotCr).toFixed(2);
      if (rem > 0.01) take(makeBucketPlaceholder(cat, program, bucket, realPool, isRel, rem, completed, group, "-rem"), key, 1);
      return;
    }
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
    // the active major has an official MAP sheet -> religion cornerstones and
    // other slots render as choosable buckets the sheet places (not concrete)
    const isMapMajor = programs.some(p => p.id === profile.majorId && p.mapPlan);
    const completed = new Set(profile.completed || []);
    // Courses the student explicitly REMOVED from the plan. Unlike "completed"
    // these are NOT counted as done and do NOT satisfy a requirement — the
    // solver simply never schedules them, so the bucket honestly shows a gap.
    const excluded = new Set(profile.excluded || []);
    const warnings = [];
    const chosen = new Map();   // baseId -> { buckets:Set, instances }
    const groupSel = {};        // bucketKey -> [chosen original group indices]
    let doubleCounted = 0;
    const cap = profile.settings.doubleCountCap ?? 15;

    // Buckets the catalog marks "cannot double count" (Math Req 3 vs Req 2):
    // a course can't satisfy such a bucket AND another requirement of the SAME
    // program. Cross-program sharing (major course also covering a GE) is
    // unaffected — that's the intended double-count.
    const noDblKeys = new Set();
    programs.forEach(p => (p.buckets || []).forEach(b => {
      if (b.noDbl) noDblKeys.add(`${p.id}::${b.id}`);
    }));

    const dcIds = new Set();    // which courses actually double-count
    const take = (id, bucketKey, instances = 1) => {
      if (excluded.has(id)) return false;   // student dropped this course
      if (!chosen.has(id)) chosen.set(id, { buckets: new Set(), instances: 0 });
      const rec = chosen.get(id);
      if (rec.buckets.size >= 1 && !rec.buckets.has(bucketKey)) {
        // intra-program single-count: if this bucket (or an existing one for the
        // same program) forbids double counting, don't let the course share.
        const prog = bucketKey.split("::")[0];
        const guarded = noDblKeys.has(bucketKey);
        // ONE COURSE, ONE GE AREA. University Core areas are alternatives, not
        // a menu to fill at once: IHUM 202 is listed under BOTH Civilization 2
        // and Letters because it may satisfy either, never both. The dropdown
        // path has always behaved this way; nothing enforced it for the other
        // paths, so a course arriving via _preRequired could close two areas at
        // once and hand the student ~3 phantom credits. A tester caught this
        // ("it should know IHUM 202 can't [count] for both"). Cross-program
        // sharing — a major course also covering one GE — is untouched and
        // still metered by the double-count cap below.
        if (prog === "univ-core") {
          for (const bk of rec.buckets) if (bk.startsWith("univ-core::")) return false;
        }
        let sameProg = false;
        for (const bk of rec.buckets) {
          if (bk.split("::")[0] !== prog) continue;
          if (guarded || noDblKeys.has(bk)) return false;   // no intra-program share
          sameProg = true;
        }
        // The DOUBLE-COUNT budget meters CROSS-program sharing (a major course
        // covering a GE, a course shared with a minor). Two keys of the SAME
        // program (Requirement 1 + the ::map sheet view of one course) are one
        // enrollment, not a double count — never spend budget on them.
        if (!sameProg) {
          if (doubleCounted + cat[id].credits > cap) return false;
          doubleCounted += cat[id].credits;
          dcIds.add(id);
        }
      }
      rec.buckets.add(bucketKey);
      rec.instances = Math.max(rec.instances, instances);
      return true;
    };

    _fillMeta = new Map();
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
      if (p.flowchartPlan) for (const code in p.flowchartPlan) {
        if (p.flowchartPlan[code].f && cat[code]) _preRequired.add(code);
      }
      // MAP-sheet coded courses WILL be taken (Pass 2.45 forces them) — a
      // choice bucket listing one must count it as covered, or the plan
      // schedules the course AND a redundant slot (EE Req 2.1 spawned a 4-cr
      // "CHEM 105 or 111" slot while CHEM 105 sat pinned in Winter Y1).
      // Or-choice lines (it.alts) stay out — their bucket owns the choice.
      if (p.mapPlan) p.mapPlan.forEach(t => (t.items || []).forEach(it => {
        if (it.c && !it.alts && cat[it.c] && !cat[it.c].placeholder) _preRequired.add(it.c);
      }));
    });
    // A course the STUDENT added by hand is every bit as committed as one the
    // sheet codes: they picked it, it occupies a term, they will sit in it. So
    // a bucket listing it must count it as covered — exactly the rule the MAP
    // block above states. Without this, extras were taken ONLY into
    // `electives::extra`, so adding IHUM 202 to fill Civilization 2 scheduled
    // the course AND left "Civilization 2 — choose a class" open beside it.
    // First real bug report from a tester, and it hit every hand-added course
    // that could satisfy any requirement.
    (profile.extras || []).forEach(code => {
      if (cat[code] && !cat[code].placeholder && !completed.has(code)) _preRequired.add(code);
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
        let c = cat[pool[0]];
        let per = c.credits || 3;
        let inst = Math.max(1, Math.ceil(b.pick.n / per));
        // Variable-credit repeatable (practicum/lessons — CPSE 486R is 1-12
        // cr, MUSIC 460R 1.5-3): planning at the minimum laddered "12 hours"
        // into 12 sequential SEMESTERS, single-handedly stretching the plan.
        // Students take these at higher per-term credit loads. The ladder
        // budget depends on the course's LEVEL — a 400-level repeatable can
        // only live in years 3-4 (4 terms of an 8-term plan), a 100/200-level
        // one has all 8 — so raise per-term enrollment (within the course's
        // real max) until the ladder fits its window.
        // ONE ENROLLMENT when the course's own per-term maximum already covers
        // the whole requirement. IAS 399R "Academic Internship" is 0.5-9 cr
        // against American Studies' 3-hour internship line: a student does ONE
        // internship for 3 credits, not six half-credit semesters of one. The
        // ladder below only ever shortened these, never collapsed them, and its
        // `inst > maxLadder` threshold missed this case by exactly one step
        // (6 instances against a maxLadder of 6). Laddering internships and
        // practica was the largest single source of repeated-course findings.
        // Bounded at 9 credits — roughly three-quarters of a full-time load,
        // so the semester still has room for two more classes. Collapsing a
        // BIGGER requirement swallows the whole term: SPED's CPSE 487R is a
        // 1-12 cr practicum, and taking all 12 at once left no room for
        // CPSE 463 and CPSE 470, which then fit nowhere in the plan at all.
        // Above the bound the ladder below still shortens it, just not to one.
        if (c.vmax >= b.pick.n && b.pick.n > per && b.pick.n <= 9) {
          per = b.pick.n;
          inst = 1;
          c = cat[pool[0]] = { ...c, credits: per };
        }
        const maxLadder = Math.max(2, 8 - minYearForLevel(courseLevel(c)) * 2);
        if (inst > maxLadder && c.vmax > per) {
          per = Math.min(c.vmax, Math.ceil((b.pick.n / maxLadder) * 2) / 2);
          inst = Math.max(1, Math.ceil(b.pick.n / per));
          c = cat[pool[0]] = { ...c, credits: per };
        }
        // A course that is NOT repeatable — no "R" suffix, no variable credit —
        // cannot honestly be taken more than once. Needing 15 enrollments of
        // the 1-credit PORT 493 capstone to satisfy "Complete 15 hours" means
        // the REQUIREMENT was mis-scraped: Portuguese Studies' own structured
        // data shows 9 hours drawn from 28 courses, not 15 from a single
        // capstone. Laddering it built a 12-semester plan carrying six copies
        // that could never be placed. Take it once and say so — an honest
        // under-fill the student can take to an advisor beats a fabricated
        // extra two years.
        if (inst > 1 && !/R$/.test(pool[0].trim()) && !(c.vmax > 0)) {
          warnings.push({ text: `${cat[pool[0]].display || pool[0]} is listed as the only way to fill `
            + `"${b.name}" (${b.pick.n} hours), but it is a ${per}-credit course that cannot be repeated. `
            + `The catalog requirement looks mis-scraped, so the plan schedules it once — verify this `
            + `requirement with your advisor.` });
          inst = 1;
        }
        // clone (cat shares objects with DATA.courses) before bumping repeatMax
        if (inst > (c.repeatMax || 1)) cat[pool[0]] = { ...cat[pool[0]], repeatMax: inst };
        take(pool[0], key, inst);
        return;
      }

      // A one-option "choice" is really required — no dropdown needed.
      const realPool = pool.filter(id => cat[id]);
      if (realPool.length === 1) { take(realPool[0], key, 1); return; }

      // "Complete N hours" whose options BARELY cover N (their credits sum to
      // ~N) isn't a real choice — every course is required. Place them directly
      // instead of as "choose a class" slots (Exercise Science Req 1: five EXSC
      // courses summing to the 11.5 required hours). A genuine choice (16
      // options for 12 hours) still becomes slots. IMPORTANT: only when the
      // pool can nearly REACH N — an attribute-defined requirement whose few
      // listed courses fall far short (ChemE tech electives: 3 cr of chem lab
      // toward a 15 cr minimum) must fall through to slots for the shortfall.
      if (b.pick.type === "credits" && realPool.length >= 2) {
        const poolCr = realPool.reduce((s, id) => s + (cat[id].credits || 3), 0);
        if (poolCr <= b.pick.n + 0.5 && poolCr >= b.pick.n - 2.5) {
          realPool.forEach(id => take(id, key, 1)); return;
        }
      }
      // "Complete N courses" with exactly N options = all required, not a choice
      // — EXCEPT religion cornerstones under a MAP major, which the sheet wants
      // as choosable "Religion Cornerstone — choose ▾" slots (all 4 are still
      // required; the student just picks which lands in which term).
      const isRelChoose = isMapMajor && (/(^|[^a-z])rel/i.test(b.id) || /religion/i.test(b.name || ""));
      if (b.pick.type === "courses" && b.pick.n >= realPool.length && !isRelChoose) {
        realPool.forEach(id => take(id, key, 1)); return;
      }

      const slots = b.pick.type === "courses" ? b.pick.n : null;   // null => by credits
      placeholderFill(cat, p, b, realPool, key, slots, completed, take, profile);
    }));

    // Pass 2.4: guarantee every course the official DEPARTMENT FLOWCHART lists
    // is INCLUDED (business core like HRM 391 / STRAT 392, new courses like
    // IS 456). MAP-sheet hints (no "f" flag) are sequence-only — the specific
    // electives a MAP shows as examples must NOT be forced into the plan.
    programs.forEach(p => {
      if (!p.flowchartPlan) return;
      for (const code in p.flowchartPlan) {
        if (p.flowchartPlan[code].f && cat[code] && !completed.has(code)) take(code, `${p.id}::flowchart`, 1);
      }
    });

    // Pass 2.45: MAP-first — every coded course on the official MAP sheet is
    // included (the sheet IS the plan). A course repeated across sheet
    // semesters (MUSIC 160R in 4 of them) becomes that many enrollments.
    programs.forEach(p => {
      if (!p.mapPlan) return;
      const count = new Map();
      p.mapPlan.forEach(t => (t.items || []).forEach(it => {
        // an or-choice ("C S 110 or C S 111") is NOT a forced course — the
        // catalog's "Complete 1 of N" bucket owns it, bound as a slot below
        if (it.c && !it.alts && cat[it.c] && !cat[it.c].placeholder) {
          count.set(it.c, (count.get(it.c) || 0) + 1);
        }
      }));
      count.forEach((n, code) => {
        if (completed.has(code)) return;
        const c = cat[code];
        if (n > (c.repeatMax || 1)) cat[code] = { ...c, repeatMax: n };
        if (!take(code, `${p.id}::map`, n) && chosen.has(code)) {
          // already claimed by a noDbl bucket of this same program — the
          // bucket keeps its claim, but the sheet's enrollment COUNT still
          // applies (GREEK 411R appears in two sheet semesters)
          const rec = chosen.get(code);
          rec.instances = Math.max(rec.instances, n);
        }
      });
    });

    // Pass 2.5: user-added extras (from the per-semester search bar). By now
    // the bucket passes have already claimed any extra that satisfies a real
    // requirement (see _preRequired above), so `electives::extra` is only the
    // FALLBACK for one that satisfies nothing. Labelling it unconditionally
    // was the other half of the tester's bug: it either overwrote the real
    // requirement credit or spent double-count budget re-adding a bucket the
    // course already had.
    (profile.extras || []).forEach(code => {
      if (!cat[code] || completed.has(code)) return;
      const rec = chosen.get(code);
      if (rec && rec.buckets.size) return;      // already filling a requirement
      take(code, "electives::extra", 1);
    });

    // sheet-coded courses (a MAP sheet places these in a specific term). A
    // prereq the sheet OMITS for a coded course is assumed already satisfied
    // (AP / placement / transfer) — pulling it as prereq-closure adds a course
    // the sheet never intended (ChemE places out of MATH 110 for CHEM 111) that
    // then strands in the senior-year tail, anchoring an extra term that floor-
    // padding fills. Trust the sheet: don't pull a coded course's prereq unless
    // the prereq is ALSO on the sheet.
    const mapCoded = new Set();
    programs.forEach(p => { if (p.mapPlan) p.mapPlan.forEach(t => (t.items || []).forEach(it => {
      if (it.c && !it.alts) mapCoded.add(it.c);
    })); });

    // Courses whose unmet prerequisite this pass DELIBERATELY declined to pull,
    // on the grounds that the sheet vouches for it (see below). prereqSatisfied()
    // has to be told, or the two halves of the solver contradict each other: the
    // expander says "assume it's satisfied", the scheduler says "it isn't in the
    // plan, so this course can never be placed", and the course silently falls
    // out of the degree. That is exactly what happened to Dance Education K-12's
    // DANCE 384R, whose prerequisite DANCE 382R is not on the sheet.
    const sheetPreSat = new Set();

    // Pass 3: prerequisite closure (pull in unmet prereqs as additions)
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id] of [...chosen]) {
        for (const group of [...cat[id].pre, ...(cat[id].preCo || [])]) {
          const optsG = Array.isArray(group) ? group : [group];
          const ok = optsG.some(g => completed.has(g) || chosen.has(g));
          if (!ok) {
            // sheet-coded course whose prereq the sheet omits -> pre-satisfied
            if (mapCoded.has(id) && !optsG.some(g => mapCoded.has(g))) { sheetPreSat.add(id); continue; }
            // don't try to auto-pull an excluded course (would loop forever)
            const pick = optsG.filter(g => cat[g] && !excluded.has(g)).sort((a, b2) => cat[a].diff - cat[b2].diff)[0];
            if (pick && take(pick, "prereq::closure", 1)) changed = true;
          }
        }
      }
    }

    // Pass 3.4: reclaim prerequisite-only courses into the choose-buckets they
    // satisfy. A concrete course dragged into the plan PURELY as a prerequisite
    // (its only tag is prereq::closure / a bare extra) credits no graded
    // requirement — yet a "choose N / N hours" requirement whose pool lists it
    // may be provisioning full placeholder slots right on top of it, so the same
    // hours get planned twice. Reassign the orphan to the requirement and rebuild
    // that bucket's placeholders for the reduced remainder. (Civil Eng: CE 321,
    // pulled as a prereq of a design course, IS one of the 7 CE Breadth options —
    // count it, don't add another 12 hours of breadth on top.)
    const orphanKeys = new Set(["prereq::closure", "electives::extra"]);
    const isOrphan = id => {
      const rec = chosen.get(id);
      return rec && rec.buckets.size > 0 && [...rec.buckets].every(k => orphanKeys.has(k));
    };
    programs.forEach(p => {
      if (p.id === "univ-core") return;   // GE coverage already handled via _preRequired
      // specific requirements (smaller pools) claim before generic ones, so a
      // course shared by "CE Breadth (7)" and "Technical Elective (70)" credits
      // the breadth requirement it was really meant for
      const cbuckets = (p.buckets || [])
        .filter(b => b.pick.type === "credits" || b.pick.type === "courses")
        .sort((a, b) => (a.options || []).length - (b.options || []).length);
      cbuckets.forEach(b => {
        const key = `${p.id}::${b.id}`;
        const phBase = `BUCKET::${key}`;
        const phIds = [phBase, phBase + "-rem"].filter(id => chosen.has(id));
        if (!phIds.length) return;
        const phCr = phIds.reduce((s, id) => s + cat[id].credits * chosen.get(id).instances, 0);
        if (phCr <= 0.01) return;
        const slotCr = cat[phBase] ? cat[phBase].credits : 3;
        const pool = (b.options || []).filter(id => cat[id] && !cat[id].placeholder);
        // largest-credit orphans first so whole slots clear cleanly
        const cands = pool.filter(id => isOrphan(id)).sort((a, c) => cat[c].credits - cat[a].credits);
        let reclaimed = 0;
        for (const id of cands) {
          if (reclaimed + 1e-9 >= phCr) break;
          chosen.get(id).buckets = new Set([key]);   // reassign prereq -> this requirement (single-count)
          reclaimed += cat[id].credits;
        }
        if (reclaimed <= 0) return;
        // rebuild this bucket's placeholders for the reduced remaining need
        phIds.forEach(id => { chosen.delete(id); if (id.endsWith("-rem")) delete cat[id]; });
        const rem = Math.max(0, phCr - reclaimed);
        if (b.pick.type === "courses") {
          const slots = Math.round(rem / slotCr);
          if (slots > 0) take(makeBucketPlaceholder(cat, p, b, pool, false, slotCr, completed), key, slots);
        } else {
          const full = Math.floor(rem / slotCr + 1e-9);
          if (full > 0) take(makeBucketPlaceholder(cat, p, b, pool, false, slotCr, completed), key, full);
          const frac = +(rem - full * slotCr).toFixed(2);
          if (frac > 0.01) take(makeBucketPlaceholder(cat, p, b, pool, false, frac, completed, null, "-rem"), key, 1);
        }
      });
    });

    // Pass 4: elective filler to reach the undergrad target
    const isMism = profile.majorId === "is-bs-mism";
    const gradCredits = isMism ? 24 : 0;
    let planned = 0;
    chosen.forEach((rec, id) => { if (!completed.has(id)) planned += cat[id].credits * rec.instances; });
    let compCredits = 0;
    completed.forEach(id => { if (cat[id]) compCredits += cat[id].credits; });
    // 120 credits is BYU's graduation requirement, so it is a FLOOR on the
    // plan, never something a MAP sheet can lower. This used to clamp the
    // target down to the sheet's printed Total Hours
    // (`target = Math.min(target, ceil(sheet))`) to stop filler electives
    // overstuffing sheet terms that have printed caps. But 47 of the 161
    // sheets print less than 120 — Geography: Global Studies sums to 103,
    // Cell Biology to 113.5 — so the clamp only ever fired in the direction
    // that produced un-graduatable plans: Cell Biology came out at exactly
    // 114 credits, and the app then had to warn the student its own plan was
    // 6 credits short. The overstuffing it guarded against is handled
    // properly elsewhere: mapCap keeps each sheet term to its printed total,
    // and enforceMapCap evicts anything that overflows one.
    const target = UG_TARGET_CREDITS + gradCredits;
    let gap = target - (planned + compCredits);
    let en = 1;
    while (gap > 0) {
      const id = `ELECTIVE ${en}`;
      cat[id] = { id, display: "ELECTIVE", name: "Open Elective / Exploration", credits: 3, pre: [], off: "FWSU", diff: 3, load: 1, demand: "low", rare: false, tags: [], testOut: "Consider AP/CLEP credit, an internship (academic credit), or test-out exams to clear elective hours.", repeatMax: 1, placeholder: true, elective: true, note: null };
      take(id, "electives::fill", 1);
      gap -= 3; en++;
    }

    return { chosen, warnings, doubleCounted, completed, groupSel, dcIds, sheetPreSat, fillMeta: _fillMeta };
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
    // repeatable sequencing: instance k after instance k-1 — REAL repeatable
    // courses only (one enrollment per semester). Bucket placeholder slots are
    // exempt (two different electives from one bucket can share a term) EXCEPT
    // religion slots, which stay strictly one per semester (BYU pacing).
    if (inst.k > 1 && (!inst.course.bucket || inst.course.isReligion)) {
      const prevUid = `${baseId(inst.uid)}#${inst.k - 1}`;
      const pt = assign.get(prevUid);
      if (pt === undefined || pt >= t) return false;
    }
    if (inst.k > 1) return true;         // base prereqs only bind the first instance
    // The sheet vouched for this course's missing prerequisites (expand() Pass 3
    // declined to pull them in because the sheet schedules the course without
    // them — AP, transfer, placement). Honour that here too: a group with NO
    // option anywhere in the plan is treated as satisfied, exactly like preCo's
    // "an absent course doesn't block". A group whose option IS in the plan
    // still binds in the normal order.
    const vouched = state.sheetPreSat && state.sheetPreSat.has(baseId(inst.uid));
    // Sheet-sanctioned concurrency: when the sheet pins BOTH a course and its
    // prerequisite into the SAME semester, that is the advisement centre
    // scheduling them together — Accounting's junior core takes ACC 402/405/409
    // alongside ACC 407 in one Winter, exactly like a cohort envelope. Under
    // sheet-wins (§4h) that is the sheet's call, so treat it like coSet rather
    // than flagging the sheet's own layout as a prerequisite error.
    const tHere = t;
    const pinnedTogether = g => {
      if (!state.pinnedUids.has(inst.uid)) return false;
      for (const [uid, tt] of assign) {
        if (tt === tHere && baseId(uid) === g && state.pinnedUids.has(uid)) return true;
      }
      return false;
    };
    for (const group of inst.course.pre) {
      const opts = Array.isArray(group) ? group : [group];
      if (opts.some(pinnedTogether)) continue;
      if (vouched) {
        let present = opts.some(g => completed.has(g));
        if (!present) {
          for (const [uid] of state.assign) {
            if (opts.includes(baseId(uid))) { present = true; break; }
          }
        }
        if (!present) continue;         // sheet vouched for it; nothing to order against
      }
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
    // concurrent-allowed prereqs: the course may be taken BEFORE OR THE SAME
    // term ("Math 112 or concurrent enrollment"). Only block the clear error —
    // the dependency scheduled strictly LATER. An absent course doesn't block.
    for (const group of (inst.course.preCo || [])) {
      const opts = Array.isArray(group) ? group : [group];
      let present = false, ok = false;
      for (const g of opts) {
        if (completed.has(g) || (coSet && coSet.has(g))) { ok = true; break; }
        for (const [uid, tt] of state.assign) {
          if (baseId(uid) === g) { present = true; if (tt <= t) ok = true; }
        }
        if (ok) break;
      }
      if (!ok && present) return false;   // dependency exists but only later
    }
    return true;
  }

  /* Limited-enrollment admission gate: majors with a junior-core cohort (or
     scraper-derived admission data) only let you take professional work ONCE
     ADMITTED. Gated: courses in the program's professional DEPT (any level —
     Nursing's clinical ladder starts at 288) and 300+/400-level slots.
     Exempt: courses the chart/MAP places BEFORE the admission year (declared
     pre-admission prerequisites like ACC 200, IS 303, NDFS 100). */
  function admitGateFor(state, inst) {
    if (!state.admitGate) return -1;
    const id = baseId(inst.uid);
    const hint = state.fcHint && state.fcHint[id];
    const lvl = courseLevel(inst.course);
    let g = -1;
    (inst.buckets || []).forEach(b => {
      const pid = b.split("::")[0];
      const gy = state.admitGate[pid];
      if (gy == null) return;
      const admitY = (state.admitY || {})[pid] || (gy + 1);
      if (hint && hint.y < admitY) return;      // charted pre-admission course
      const dept = (state.admitDept || {})[pid];
      const deptHit = dept && id.startsWith(dept + " ");
      if (deptHit || lvl >= 3) g = Math.max(g, gy);
    });
    return g;
  }

  /* canPlace = the single gate for HARD CONSTRAINTS. Every optimizer move
     (greedy, swap, SA, compact, fillLight, floor) checks it, so a move that
     breaks a hard rule is REJECTED outright — never merely penalized. The hard
     rules are: term enabled, within the 4-year budget, admission gate, season
     offering, ≤18 credit cap, prerequisites satisfied. Everything else (gaps,
     Fall-vs-Winter finish, difficulty ramp, compactness, GE/religion spread,
     the ≥12 floor) is a SOFT PENALTY in scorePlan / a post-pass guarantee — the
     solver prefers against them but will accept them when nothing better fits.
     (A locked cohort is the one intentional exception: placeBlock may exceed
     the cap to keep an envelope together — flagged as an over-cap warning.) */
  function canPlace(state, inst, t, ignoreCap = false) {
    const term = state.terms[t];
    if (!term || !term.enabled) return false;
    // the 4-year plan boundary: nothing schedules past the term budget
    if (state.termBudget != null && t > state.termBudget) return false;
    // admission gate: no gated professional course before the admit year
    const gate = admitGateFor(state, inst);
    if (gate >= 0 && acadYearIdx(state.terms, t) < gate) return false;
    // lock-step floor: charted professional courses never before their
    // charted year (limited-enrollment programs — see state.hardMinYear)
    const hm = state.hardMinYear && state.hardMinYear.get(baseId(inst.uid));
    if (hm != null && acadYearIdx(state.terms, t) < hm) return false;
    // course-level year restriction: senior-standing / capstone courses
    // (catalog "Senior standing." text) can't land before their minimum year
    if (inst.course.minY && acadYearIdx(state.terms, t) < inst.course.minY - 1) return false;
    if (!inst.course.off.includes(term.season)) return false;
    // soft seeding cap: first passes fill F/W to ~16 so the plan spreads into
    // enough terms to taper the final year (18 stays the hard cap for the
    // relaxed pass, the optimizer, and manual moves)
    let cap = (!ignoreCap && term.isFW && state.softCapFW)
      ? Math.min(term.cap, state.softCapFW) : term.cap;
    // true-freshman pacing: official MAPs start a new student at ~13-15
    // credits, not a packed 18 — hard-cap the very first term (override with
    // settings.firstTermCap; ignored once any completed credit exists)
    if (t === 0 && state.firstTermCap != null) cap = Math.min(cap, state.firstTermCap);
    // MAP-first: a sheet term has an ABSOLUTE ceiling so backfill fills the
    // capacity the sheet left. Fall/Winter sheet terms may stretch to 16
    // (the fixed 14-16 policy band) when requirements exceed the sheet's
    // printed totals — +2 on a sheet term beats an 11th semester. Sp/Su
    // sheet blocks keep their own printed total. Applies even to swap moves
    // (ignoreCap — they already unplaced their outgoing course). Locked
    // cohort envelopes exempt; _mapCapOff is enforceMapCaps' last resort.
    if (!state._mapCapOff && state.mapCap && state.mapCap.has(t) && !state.blockOf.has(inst.uid)) {
      const ceil = term.isFW ? Math.max(state.mapCap.get(t), 16) : state.mapCap.get(t);
      if (state.load[t] + inst.course.credits > ceil + 0.5) return false;
    }
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

  /* THE SHEET AND THE FLOWCHART WIN ON SEASON.

     When the official MAP sheet or a program's flowchart envelope places a
     course in a term, that placement is the authority for THIS plan. BYU's
     advisement documents are maintained separately from the course record's
     `courseTypicallyOffered`, and the course record goes stale: IS 404 reads
     "Winter." while both the 2025-26 IS sheet and the flowchart put it in the
     FALL junior core, and IS 401 carries the mirror-image conflict. The
     documents the advisement centre hands students are the ones to trust.

     Widening the course's offered seasons for this plan keeps canPlace(), the
     season warnings, and the drag-drop validator all agreeing with the sheet
     instead of contradicting it — previously the plan placed IS 404 in Fall
     and then had no way to say why that was legal. */
  function widenSeason(state, baseCode, season) {
    if (!season) return;
    const c = state.cat[baseCode];
    if (!c || (c.off || "").includes(season)) return;
    const widened = { ...c, off: (c.off || "") + season, seasonFromPlan: true };
    state.cat[baseCode] = widened;
    state.instances.forEach(i => { if (baseId(i.uid) === baseCode) i.course = widened; });
  }

  /* GRADUATION TOP-UP — re-assert the 120-credit floor after every pass that
     can SHRINK a plan.

     expand() sizes the plan to 120, but later passes remove credits: GE
     right-sizing drops categories a sheet already enumerates, and the
     "Recommended Courses are not required to complete the program" fix stopped
     scheduling BYU's optional blocks. Elementary Education finished at 115 and
     the app had to tell the student its own plan was 5 credits short of the
     requirement — a plan that does not graduate anyone.

     These are REAL open electives the student chooses, not disposable floor
     padding: they carry ELECTIVE ids, count toward the degree, and survive the
     padding strip. Slots go to the term with the most headroom (respecting the
     sheet's printed cap and the credit ceiling) so nothing overstuffs, and
     never past the graduating term — the plan gets fuller, not longer. */
  function topUpCredits(state) {
    let owed = creditsOwed(state);
    if (owed <= 0.01) return;
    const gradTerm = lastActiveTerm(state);
    const cap = Math.min(BYU_HARD_CAP, state.profile.settings.maxCreditsFW || 17);
    let n = 0;
    state.instances.forEach(i => {
      const m = /^ELECTIVE (\d+)$/.exec(i.uid);
      if (m) n = Math.max(n, +m[1]);
    });
    let guard = 0;
    while (owed > 0.01 && guard++ < 8) {
      // most headroom first, so the extra work spreads instead of stacking
      let best = -1, bestRoom = 0;
      state.terms.forEach(tm => {
        if (!tm.isFW || !tm.enabled || tm.index > gradTerm) return;
        const mc = state.mapCap && state.mapCap.get(tm.index);
        const room = (mc != null ? mc : cap) - (state.load[tm.index] || 0);
        if (room > bestRoom + 1e-9) { bestRoom = room; best = tm.index; }
      });
      // Size the card to what is still OWED, capped at 3 — a fixed 3 gave up
      // whenever the last gap was smaller than the room available. Elementary
      // Education finished 2 credits short with 3 credits of headroom sitting
      // in its final term, and told the student its own plan did not graduate
      // them. Minimum 1: "Open Elective, 0.5 cr" is not a class.
      const cr = Math.max(1, Math.min(3, Math.ceil(owed * 2) / 2));
      if (best < 0 || bestRoom < cr) break;     // genuinely nowhere legal to put it
      const id = `ELECTIVE ${++n}`;
      state.cat[id] = { id, display: "ELECTIVE", name: "Open Elective / Exploration",
        credits: cr, pre: [], off: "FWSU", diff: 3, load: 1, demand: "low", rare: false,
        tags: [], testOut: "Consider AP/CLEP credit, an internship (academic credit), or test-out exams to clear elective hours.",
        repeatMax: 1, placeholder: true, elective: true, note: null };
      const inst = { uid: id, course: state.cat[id], k: 1, total: 1, buckets: ["electives::fill"] };
      state.byUid.set(id, inst);
      state.instances.push(inst);
      place(state, inst, best);
      owed -= cr;
    }
  }

  function seed(state, programs) {
    const { profile, terms, cat } = state;
    const problems = [];

    /* 1 — register cohort blocks (hand-defined, e.g. IS junior core).
       MAP-first: sheet-coded courses are already hard-pinned to their exact
       sheet semester and never join a block (the 2025-26 IS sheet splits the
       junior core differently than the hand blocks — the sheet wins). */
    programs.forEach(p => p.buckets.forEach(b => {
      if (!b.block) return;
      const uids = bucketOptions(b, cat).filter(id => state.byUid.has(id) &&
        !(state.mapCodes && state.mapCodes.has(id)));
      if (!uids.length) return;
      state.blocks.set(b.block.id, { ...b.block, uids });
      uids.forEach(u => {
        state.blockOf.set(u, b.block.id);
        widenSeason(state, baseId(u), b.block.season);   // the envelope's season wins
      });
    }));

    /* 1b — flowchart cohorts: the RIGID junior-core envelopes. These lock their
       exact courses to the flowchart's exact year+season and move as a unit
       (can't be dragged apart) — the business/eng junior core is immutable. */
    programs.forEach(p => (p.flowchartCohorts || []).forEach((co, i) => {
      let uids = co.courses.filter(id => state.byUid.has(id) && !state.blockOf.has(id));
      // MAP-first: sheet-coded courses are already hard-pinned to their exact
      // sheet semester — they never join a flowchart envelope (when the sheet
      // and the older chart disagree, e.g. IS 401 fall vs winter, the sheet wins)
      if (state.mapCodes) uids = uids.filter(id => !state.mapCodes.has(id));
      // junior/senior cores are upper-division; drop any prereqs the extraction
      // swept in (STAT 121, MSB 180) so they schedule at their real early spot
      if (co.y >= 3) uids = uids.filter(id => courseLevel(state.byUid.get(id).course) >= 3);
      if (uids.length < 2) return;
      const id = `fc:${p.id}:${i}`;
      state.blocks.set(id, { id, season: co.s, label: co.label, uids, fcYear: co.y });
      uids.forEach(u => {
        state.blockOf.set(u, id);
        widenSeason(state, baseId(u), co.s);             // the flowchart's season wins
      });
    }));

    /* 1c — CO-REQUISITE cohorts: concurrent-enrollment courses (a lab + its
       lecture) must share a term. Bundle them into a movable block whose season
       is their common offering, placed by prereq order (no fixed year) — this
       stops the CH EN 445 lab drifting to a random early term away from its
       CH EN 436/476 lecture partners. */
    if (DATA.coreqs) {
      let ci = 0;
      const repeatable = id => {
        const c = state.byUid.has(id) && state.byUid.get(id).course;
        return !c || (c.repeatMax || 1) > 1 || /R$/.test(id.trim());
      };
      for (const primary in DATA.coreqs) {
        const group = [primary, ...DATA.coreqs[primary]];
        // a REPEATABLE co-req (an Education practicum like EL ED 299R taken once
        // alongside EACH methods course, at different terms) can't be one rigid
        // same-term block — exclude repeatables and keep true lab+lecture pairs.
        // Sheet-pinned courses stay where the MAP put them (never in a block).
        const uids = group.filter(id => state.byUid.has(id) && !state.blockOf.has(id) &&
          !repeatable(id) && !(state.mapCodes && state.mapCodes.has(id)));
        if (uids.length < 2) continue;                    // need ≥2 of them present
        // common season: intersection of all members' offerings; F/W preferred
        let common = "FWSU";
        uids.forEach(u => { const off = state.byUid.get(u).course.off || "FWSU";
          common = [...common].filter(s => off.includes(s)).join(""); });
        const season = common.includes("F") ? "F" : common.includes("W") ? "W" : (common[0] || "F");
        // target the members' flowchart year (if hinted) so a co-req lab lands
        // at its recommended term WITH its lecture, not just the earliest
        // feasible slot (which otherwise stretched packed majors like ChemE).
        let hy = 0;
        uids.forEach(u => { const h = state.fcHint && state.fcHint[baseId(u)];
          if (h && h.s === season) hy = Math.max(hy, h.y); });
        const id = `coreq:${ci++}`;
        state.blocks.set(id, { id, season, label: `${primary} + co-requisites`, uids, coreq: true,
          ...(hy ? { fcYear: hy } : {}) });
        uids.forEach(u => state.blockOf.set(u, id));
      }
    }

    /* 2 — pins (e.g. IS 303 -> Winter 2027); prereq order is verified after seeding */
    Object.entries(profile.pins || {}).forEach(([cid, when]) => {
      const inst = state.byUid.get(cid);
      if (!inst) return;
      const t = termIndexFor(terms, when.year, when.season);
      if (t < 0 || !terms[t].enabled || !inst.course.off.includes(terms[t].season)) {
        problems.push({ type: "pin", text: `Pinned course ${cid} cannot be placed in ${SEASON_NAME[when.season]} ${when.year} (term unavailable or course not offered that season).` });
        return;
      }
      // The MAP sheet's labeled-slot pass (takeSlot) runs BEFORE seed() and may
      // already have placed this instance into a sheet slot. The student's pin
      // outranks the sheet — but it must RELOCATE that placement, not add a
      // second one: place() blindly adds credits to state.load, so pinning an
      // already-placed course counted it twice and every capacity guard
      // (canPlace, the 12-credit floor, MAP caps, the part-time warning) then
      // read the term as fuller than it is. Symptom: real electives went
      // unscheduled and plans finished under the 120 credits BYU requires.
      unplace(state, inst);
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
        // unplace first: a member the sheet's slot pass already placed would
        // otherwise have its credits added to state.load a second time (see
        // the pin pass above for what that corrupts)
        blk.uids.forEach(u => { const i = state.byUid.get(u); unplace(state, i); place(state, i, t); });
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
      // fallback (no target year, or it wasn't available): earliest term with
      // room, of the right season, after prereqs are met
      const prereqOK = t => blk.uids.every(u => {
        const inst = state.byUid.get(u);
        return inst.course.off.includes(state.terms[t].season) && prereqSatisfied(state, inst, t, coSet);
      });
      for (let t = minT; t < state.terms.length; t++) {
        if (state.termBudget != null && t > state.termBudget) break;
        const term = state.terms[t];
        if (!term || !term.enabled || term.season !== blk.season) continue;
        if (state.load[t] + credits > term.cap) continue;
        if (prereqOK(t)) return placeAt(t);
      }
      // NEVER SPLIT A COHORT: if nothing fit under the cap (a packed multi-program
      // plan can leave no term with room), place the whole block together at the
      // earliest prereq-valid right-season term anyway — over-cap is a warning,
      // not a reason to scatter the members (which later passes would then treat
      // as independent courses). Extend past budget only as a last resort.
      for (let t = minT; t < state.terms.length; t++) {
        const term = state.terms[t];
        if (!term || !term.enabled || term.season !== blk.season) continue;
        if (prereqOK(t)) return placeAt(t);
      }
      // absolute last resort: earliest right-season term regardless of prereqs
      for (let t = minT; t < state.terms.length; t++) {
        const term = state.terms[t];
        if (term && term.enabled && term.season === blk.season) return placeAt(t);
      }
      problems.push({ type: "block", text: `Couldn't schedule cohort block "${blk.label}" — no ${SEASON_NAME[blk.season]} term available in the plan window.` });
      return false;
    };

    /* 4 — greedy for everything else, critical path first, LOW LEVELS FIRST so
       freshman-friendly courses claim early terms and 300/400s get pushed out */
    const depths = computeDepth(state.instances, cat);
    state.depths = depths;               // scorePlan pulls deep chains early
    // freshman-only 19x seminars/projects must claim year-1 seats before the
    // GE placeholders (which can fill ANY term) soak them up
    const froshOnly = i => ((/\b19\d[A-Z]?\b/.test(i.course.display || i.course.id || "") &&
                             courseLevel(i.course) <= 1) ||
                            /^(UNIV 101|WRTG 150)$/.test(baseId(i.uid))) ? 0 : 1;
    const courseNum = i => {
      const m = (i.course.display || i.course.id || "").match(/(\d{3})/);
      return m ? +m[1] : 999;
    };
    const fc = state.fcHint || {};
    const rest = state.instances
      .filter(i => !state.assign.has(i.uid) && !i.course.elective)
      .sort((a, b) =>
        ((fc[baseId(a.uid)] ? 0 : 1) - (fc[baseId(b.uid)] ? 0 : 1)) ||   // flowchart-hinted first
        (froshOnly(a) - froshOnly(b)) ||
        (depths.get(b.uid) - depths.get(a.uid)) ||
        (courseLevel(a.course) - courseLevel(b.course)) ||        // 1xx/2xx before 3xx/4xx
        (courseNum(a) - courseNum(b)) ||                          // CHEM 105 before CHEM 106
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
          // STABILITY: a re-solve after a small edit (a bucket pick, a drop)
          // returns every course to its previous term when still legal — the
          // plan must not reshuffle under the student mid-choice
          // (opts.prevAssign; scorePlan defends the same preference).
          const pv = state.prevAssign ? state.prevAssign.get(inst.uid) : undefined;
          if (pv != null && canPlace(state, inst, pv)) { place(state, inst, pv); progress = true; return; }
          // a lab lands beside its lecture whenever the lecture is placed
          const mateUid = state.pairOf ? state.pairOf.get(inst.uid) : undefined;
          if (mateUid != null) {
            const mt = state.assign.get(mateUid);
            if (mt != null && canPlace(state, inst, mt)) { place(state, inst, mt); progress = true; return; }
          }
          // flowchart-hinted courses aim straight for their target year+season
          // (first instance only — repeats span semesters by definition)
          const hint = inst.k === 1 ? fc[baseId(inst.uid)] : null;
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
    // 16 is the default policy band; a graduation target replaces it with the
    // pace that target implies (lower to stretch, higher to compact) so the
    // FIRST pass already lays courses down at the student's chosen density
    // instead of packing to 16 and leaving later passes to unpick it.
    state.softCapFW = Math.min(state.paceFill || 16, profile.settings.maxCreditsFW || 16);
    tryFill(true, true);
    for (let pass = 0; pass < 4; pass++) blockOrder.forEach(placeBlock);
    tryFill(true, false);
    state.softCapFW = 0;     // relaxed passes get the full cap
    tryFill(true, false);
    tryFill(false, false);   // relaxed fallback for the stubborn few
    // budget extension — LAST resort: only if real courses can't fit the
    // 4-year budget, stretch a whole year at a time (keeps a Winter finish)
    for (let ext = 0; ext < 3; ext++) {
      if (!state.instances.some(i => !state.assign.has(i.uid) && !i.course.elective)) break;
      const fwBeyond = state.terms.filter(tm =>
        tm.isFW && tm.enabled && tm.index > state.termBudget);
      if (fwBeyond.length < 2) break;
      state.termBudget = fwBeyond[1].index;   // +Fall+Winter
      tryFill(true, false);
      tryFill(false, false);
    }

    /* 4b — verify pinned courses ended up after their prerequisites */
    state.pinnedUids.forEach(uid => {
      const inst = state.byUid.get(uid);
      const t = state.assign.get(uid);
      // Only a REAL ordering bug counts: a prerequisite that IS in the plan but
      // sits at/after this pinned course. A prereq that's entirely ABSENT is
      // assumed satisfied externally (AP / placement / transfer) — the sheet
      // placed the course without it ON PURPOSE (ChemE's CHEM 111 vs MATH 110)
      // — so don't raise a false "before its prerequisites" alarm.
      const orderingBug = t !== undefined && (inst.course.pre || []).some(group => {
        const opts = Array.isArray(group) ? group : [group];
        const satisfied = opts.some(g => state.completed.has(g) ||
          [...state.assign].some(([u, tt]) => baseId(u) === g && tt < t));
        if (satisfied) return false;
        // Same-term sheet cohort is not an ordering bug: when the sheet pins
        // both courses to the SAME semester it is running them as a block
        // (Accounting's ACC 407 with 402/405/409). Reported as a defect, it
        // put three red alarms on a plan that follows the sheet exactly.
        if (state.mapCodes && state.mapCodes.has(baseId(uid)) &&
            opts.some(g => state.mapCodes.has(g) &&
              [...state.assign].some(([u, tt]) => baseId(u) === g && tt === t))) return false;
        return opts.some(g => [...state.assign].some(([u]) => baseId(u) === g));  // present, just late
      });
      if (orderingBug) {
        problems.push({ type: "pin", text: `Pinned course ${inst.course.display || uid} sits before its prerequisites — move the prerequisites earlier or unpin it.` });
      }
    });

    /* 5 — pad below-minimum Fall/Winter terms with electives, then spread leftovers */
    const electives = state.instances.filter(i => i.course.elective && !state.assign.has(i.uid));
    const minFW = floorFW(state);
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
    // Remaining electives: earliest F/W term with headroom (inside budget).
    // A graduation target caps the FIRST sweep at its pace, so leftovers
    // spread into the later semesters the student asked for instead of
    // stacking the earliest term to 17 and leaving the tail empty — moving
    // them out afterwards is a bulk move no single-course optimizer step can
    // make (each first course into an empty term looks like a 25-point loss).
    // The second sweep runs at the real cap and seats anything the pace
    // couldn't, so pace can never strand an elective.
    for (const paced of [true, false]) {
      const ceilOf = term => (paced && state.paceFill != null)
        ? Math.min(term.cap, state.paceFill) : term.cap;
      while (ei < electives.length) {
        let placed = false;
        for (let t = 0; t < state.terms.length; t++) {
          if (state.termBudget != null && t > state.termBudget) break;
          const term = state.terms[t];
          if (!term.enabled || !term.isFW) continue;
          if (state.load[t] + 3 <= ceilOf(term)) { place(state, electives[ei++], t); placed = true; break; }
        }
        if (!placed) break;
      }
      if (state.paceFill == null) break;
    }

    const unscheduled = state.instances.filter(i => !state.assign.has(i.uid));
    unscheduled.forEach(i => problems.push({
      type: "unscheduled", uid: i.uid,   // so solve() can drop the ones it rescues
      // Name the dial the student actually has. "Extend the horizon" is useless
      // advice to someone whose plan is bounded by a finish target they set.
      text: `${i.course.display || i.uid} couldn't be scheduled${i.course.off.length < 4 ? ` (offered ${[...i.course.off].map(s => SEASON_NAME[s]).join("/")} only)` : ""} — try enabling Spring/Summer, raising the credit cap, or extending the horizon.`,
    }));
    return { problems, unscheduled };
  }

  /* ----------------------------- scoring ----------------------------- */
  function scorePlan(state) {
    const { profile, terms, assign, load } = state;
    const w = profile.weights;
    const lease12 = profile.settings.housing === "off-campus-12mo";
    const minFW = floorFW(state);

    const activeIdx = new Set(assign.values());
    let lastIdx = 0, firstIdx = Infinity;
    activeIdx.forEach(t => { lastIdx = Math.max(lastIdx, t); firstIdx = Math.min(firstIdx, t); });

    // per-term stats
    let spsuCredits = 0, partTimeFW = 0, spsuTerms = 0, fwTermCount = 0;
    const hardByTerm = new Map();
    terms.forEach(tm => {
      if (!activeIdx.has(tm.index)) return;
      if (tm.isFW) {
        fwTermCount++;
        // a MAP-sheet term filled to its own declared total is never
        // "part-time" — some official sheets pace a 13-credit semester
        const mc = sheetTotal(state, tm.index);
        if (load[tm.index] < minFW && !(mc != null && load[tm.index] >= mc - 0.5)) partTimeFW++;
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

    // COST — part-time F/W wastes the flat-tuition band; Sp/Su tuition is extra,
    // but a 12-month lease means housing for Sp/Su is already paid (cheaper to use it).
    // EVERY ACTIVE SEMESTER costs real money and months (6/term): this is the
    // marginal price that lets the optimizer trade "a couple of 17-credit
    // terms" (life penalty ~0.8 each) against "a whole extra semester" — and
    // is what makes compact()'s term-emptying moves actually score as wins.
    // The 8-10 term shape emerges from this trade, not from force-filling.
    // With a graduation target set, the NUMBER of semesters stops being
    // something to minimize — the student already decided it. Charging 6 a
    // term on top of that is the optimizer arguing with them, and it is what
    // kept a 5-year target packing into 8 terms. Semesters up to the target's
    // own ideal are free; only overshoot still costs.
    const billableTerms = state.idealTerms != null
      ? Math.max(0, fwTermCount - state.idealTerms) : fwTermCount;
    const cost = partTimeFW * 4 + spsuCredits * (lease12 ? 0.25 : 0.9) + spsuTerms * (lease12 ? 0.2 : 1)
      + billableTerms * 6 + lastIdx * 0.35;

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
      // first-semester courses (UNIV 101, first-year writing) stay freshman
      // year no matter which scoring branch applies below
      if (yr > 0 && /^(UNIV 101|WRTG 150)$/.test(baseId(uid))) structure += yr * 12;
      // repeat instances (#2+) can't all sit in the hinted term — a repeatable
      // seminar spans many semesters by definition, so only #1 chases the hint
      const hint = i.k === 1 && state.fcHint && state.fcHint[baseId(uid)];
      if (hint) {
        // 2a) FLOWCHART PLACEMENT — the department's official chart is
        //     authoritative: pull the course to its recommended year+season.
        const dy = Math.abs(yr - (hint.y - 1));
        structure += dy * dy * 7;
        // Honor the chart's FALL-vs-WINTER split within the right year: the MAP
        // deliberately separates e.g. C S 312/340 (junior fall) from C S 324
        // (junior winter) to avoid a finals pileup. Kept just under the 1-year
        // drift penalty (7) so a season fix never pulls a course a whole year
        // off its chart.
        if (terms[t].isFW && terms[t].season !== hint.s) structure += 6;
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
        // deep dependent chain (MATH 113→302→…, CHIN 201→202→301→302) belongs
        // EARLY — the whole chain waits on it, and a season-alternating language
        // chain that starts late spills the plan into an extra Fall semester.
        // Strong pull so chain roots land in the first year or two.
        if (state.depths) {
          const d = state.depths.get(uid) || 1;
          if (d >= 2 && !c.placeholder && !c.elective) structure += yr * (d - 1) * (d - 1) * 1.2;
        }
        if (!c.placeholder) {
          const isFreshmanOnly = /\b19\d[A-Z]?\b/.test(c.display || c.id || "") ||
                                 /^(UNIV 101|WRTG 150)$/.test(baseId(uid));
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
    // COMPACTNESS — pack credits into the FEWEST Winter-ending terms rather than
    // smearing them thin at the 12 floor (a 129-cr major+minor is ~8-9 terms at
    // ~15, not 10 at 13). Without this (and with no speed dial) the optimizer is
    // indifferent between "8 terms at 16" and "10 at 13" and the fill passes
    // spread everything to the minimum, stranding low-priority courses late.
    const totalFW = fwActive.reduce((s, t) => s + load[t], 0);
    // A graduation target overrides the 15.5 house pace with its own — see the
    // TARGET PACE block in solve(). state.idealTerms is already clamped to what
    // the full-time floor can actually support, so a wildly distant target
    // still can't smear 120 credits across 12 half-empty semesters.
    const idealTerms = state.idealTerms != null
      ? state.idealTerms : Math.max(8, Math.round(totalFW / 15.5));
    if (fwActive.length > idealTerms) structure += (fwActive.length - idealTerms) * 16;
    // OVER-PACE — the force that actually spreads a stretched plan. Without it
    // nothing pulls work out of a naturally-16-credit term into the empty
    // semesters the student asked for; the ideal-term count alone only stops
    // punishing them. Weight 4/credit beats the "no generals in the last two
    // semesters" rule below (softened to 3 under a stretch), which is the only
    // thing standing between a tail term and the GE slots that would fill it.
    if (state.paceCap != null) {
      fwActive.forEach(t => { structure += Math.max(0, load[t] - state.paceCap) * 4; });
    }
    // The senior taper is a comfort rule: finish light. A student who set an
    // EARLIER graduation date has explicitly traded that comfort away, and
    // holding it at full strength left Chemistry's last semester at 12 credits
    // with a required course sitting unscheduled beside it. Softened under a
    // rush, never dropped — the taper still breaks ties toward a lighter end.
    const taperW = state.rush ? 0.7 : 2.2;
    const lastTwo = new Set(fwActive.slice(-2));
    lastTwo.forEach(t => {
      structure += Math.max(0, load[t] - 14) * taperW   // over the senior taper
                 + Math.max(0, load[t] - 10) * (state.rush ? 0 : 0.25);
    });
    // strong but not compression-blocking: emptying a straggler term shifts
    // the "last two" boundary onto GE-bearing terms — the compressed plan must
    // still win, then improve() relocates those GEs earlier. And a final term
    // STARVING below full-time takes GEs gladly (better than part-time).
    // Under a deliberate stretch this rule has to give ground. The tail terms
    // exist BECAUSE the student asked for them, and generals/electives are the
    // only work loose enough to move into them — every major course is held by
    // its sheet row or its prerequisites. Held at 8 it kept those terms empty
    // and the stretch never happened. Softened, not dropped: real major work
    // still wins the tail whenever any is free to go there.
    const geLateW = state.stretch ? 3 : 8;
    gePerTerm.forEach((n, t) => { if (lastTwo.has(t) && load[t] >= minFW) structure += n * geLateW; });
    fwActive.forEach(t => {
      const mc = sheetTotal(state, t);
      if (mc != null && load[t] >= mc - 0.5) return;   // at the sheet's own total
      if (load[t] < minFW) structure += (minFW - load[t]) * 2.0;
    });
    // over BYU's 18-credit registration cap (a rigid envelope can force a term
    // over; everything MOVABLE should clear out of its way)
    fwActive.forEach(t => { if (load[t] > BYU_HARD_CAP) structure += (load[t] - BYU_HARD_CAP) * 9; });
    // INTERIOR gap only: an empty Fall/Winter term BETWEEN the first and LAST
    // ACTIVE term is a skipped semester. Empty terms AFTER the plan ends are
    // just unused budget — penalizing up to the budget (as before) force-filled
    // every term and ballooned plans across extra semesters.
    for (let t = firstIdx + 1; t < lastIdx; t++) {
      const tm = terms[t];
      if (tm && tm.isFW && tm.enabled && load[t] === 0) structure += 15;
    }
    // finish in Winter (April grad). Must OUTWEIGH the compactness penalty
    // (~16/term) so the plan never trades a Winter finish for one fewer term.
    if (fwActive.length && terms[fwActive[fwActive.length - 1]].season === "F") structure += 24;
    // 6) lower number first within a department level: CHEM 105 before
    //    CHEM 106, MATH 302 before 303 — patches gaps in catalog prereq data
    //    (same term is fine; only a strictly LATER lower number is penalized)
    if (state.seqGroups) {
      const termOf = id => {
        const t = assign.get(id);
        return t !== undefined ? t : assign.get(`${id}#1`);
      };
      state.seqGroups.forEach(group => {
        for (let i = 0; i < group.length - 1; i++) {
          for (let j = i + 1; j < group.length; j++) {
            if (group[i].num === group[j].num) continue;
            const ti = termOf(group[i].id), tj = termOf(group[j].id);
            if (ti !== undefined && tj !== undefined && ti > tj) structure += 3;
          }
        }
      });
    }

    // 7) DIFFICULTY RAMP — difficulty should climb gently across the plan, not
    //    spike. Each F/W term gets a "hardness load" = Σ over real (non-GE,
    //    non-religion) courses of (diff-3)·credits. Penalize (a) piling hard
    //    courses into one term and (b) a term jumping far above the previous.
    //    Locked cohort terms (junior cores) are EXEMPT — they're a forced hard
    //    block the student can't spread, and the user expects that.
    const cohortTerms = new Set();
    if (state.blockOf) assign.forEach((t, uid) => { if (state.blockOf.has(uid)) cohortTerms.add(t); });
    const hardLoad = new Map();
    assign.forEach((t, uid) => {
      if (!terms[t] || !terms[t].isFW) return;
      const c = state.byUid.get(uid).course;
      // GE and religion slots aren't "hard"; but a MAJOR/MINOR elective slot
      // stands for a real upper-division class (its diff = median of its
      // options), so it counts toward the term's difficulty.
      if (c.isReligion) return;
      const isGEslot = c.placeholder && (c.level == null || c.level <= 1);
      if (isGEslot) return;
      hardLoad.set(t, (hardLoad.get(t) || 0) + Math.max(0, (c.diff || 3) - 3) * c.credits);
    });
    // (a) concentration: a non-cohort term whose hardness load exceeds a ceiling.
    //     Kept gentle (0.55) so it discourages an all-400-level pileup but never
    //     forces an EXTRA semester just to thin difficulty — packing into 8
    //     Winter-ending terms outranks a slightly heavier term.
    hardLoad.forEach((h, t) => {
      if (!cohortTerms.has(t) && h > 22) structure += (h - 22) * 0.55;
    });
    // (a2) don't pile extra upper-division major work onto a locked cohort term
    //      — the junior core is already a full block (the IS-415-in-the-fall-
    //      envelope bug); push those electives to a later, lighter term
    if (cohortTerms.size) assign.forEach((t, uid) => {
      if (!cohortTerms.has(t) || state.blockOf.has(uid)) return;
      const c = state.byUid.get(uid).course;
      if (c.isReligion) return;
      // concrete upper-division course crammed onto the core term must beat its
      // own flowchart-hint pull (≈7 per year of drift) so it moves to a senior
      // term; a floating elective slot needs a lighter nudge
      if (courseLevel(c) >= 3 && !c.placeholder) structure += 14;
      else if (c.placeholder && c.level >= 3) structure += 7;
    });
    // (b) linear ramp: a smooth rise term-to-term is free; a spike above the
    //     previous active F/W term is penalized (into a cohort term is exempt)
    for (let i = 1; i < fwActive.length; i++) {
      const t = fwActive[i];
      if (cohortTerms.has(t)) continue;
      const jump = (hardLoad.get(t) || 0) - (hardLoad.get(fwActive[i - 1]) || 0);
      if (jump > 7) structure += (jump - 7) * 0.7;
    }

    // lab ↔ lecture split: a lab scheduled in a different semester than its
    // lecture is a real-world scheduling error — penalize each split pair
    if (state.pairOf && state.pairOf.size) {
      state.pairOf.forEach((mateUid, labUid) => {
        const a = assign.get(labUid), b = assign.get(mateUid);
        if (a != null && b != null && a !== b) structure += 7;
      });
    }

    // STABILITY on re-solves: each course moved away from its previous term
    // costs — a bucket pick or drop must not reshuffle the rest of the plan.
    // Strong enough to beat cosmetic preferences, weak enough that a genuine
    // constraint (the new course needs the seat) still wins.
    if (state.prevAssign && state.prevAssign.size) {
      let moved = 0;
      assign.forEach((t, uid) => {
        const pv = state.prevAssign.get(uid);
        if (pv != null && pv !== t) moved++;
      });
      structure += moved * 9;
    }

    const total =
      (w.cost / 5) * cost + (w.risk / 5) * risk +
      (w.life / 5) * life + structure;
    return { total, parts: { cost, risk, life, structure } };
  }

  /* --------------------------- improvement --------------------------- */
  function improve(state, iterations, seedNum, floorSafe = false) {
    const rnd = mulberry32(seedNum);
    const minFW = floorFW(state);
    // floor-safe: a move that pulls a course OUT of an active term must not
    // leave that term part-time (in (0, min)); emptying it fully is fine. Lets
    // the FINAL improve() de-strand courses without breaking the ≥12 guarantee.
    const okSource = from => {
      if (!floorSafe || !state.terms[from].isFW) return true;
      const after = state.load[from];   // load already reduced (inst unplaced) at call site
      return after <= 0.01 || after >= minFW;
    };
    const movable = state.instances.filter(i =>
      state.assign.has(i.uid) && !state.pinnedUids.has(i.uid) && !state.blockOf.has(i.uid));
    if (!movable.length) return;

    // moving a course must not break dependents scheduled after it
    const dependentsOf = uid => {
      const bid = baseId(uid);
      const out = [];
      state.instances.forEach(i => {
        if (i.uid !== uid && i.course.pre.flat().includes(bid)) out.push(i);
        if (baseId(i.uid) === bid && (!i.course.bucket || i.course.isReligion) && i.k > state.byUid.get(uid).k) out.push(i); // later repeats (sequenced courses only)
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

    const cap = Math.min(BYU_HARD_CAP, state.profile.settings.maxCreditsFW || BYU_HARD_CAP);
    let cur = scorePlan(state).total;      // current (SA may wander above best)
    let best = cur;
    let bestSnap = new Map(state.assign);  // best-ever assignment, restored at end
    const snapshot = () => { best = cur; bestSnap = new Map(state.assign); };
    for (let it = 0; it < iterations; it++) {
      // annealing temperature cools linearly to ~0 over the run
      const temp = 1.2 * (1 - it / iterations);
      const inst = movable[(rnd() * movable.length) | 0];
      const from = state.assign.get(inst.uid);
      const depLimit = earliestDependentTerm(inst.uid);
      // candidate terms for a plain move (canPlace enforces every HARD
      // constraint: season, cap, prereqs, budget, admission gate)
      const cands = [];
      for (let t = 0; t < state.terms.length; t++) {
        if (t === from || t >= depLimit) continue;
        unplace(state, inst);
        const ok = canPlace(state, inst, t);
        place(state, inst, from);
        if (ok) cands.push(t);
      }
      // 1) GREEDY best single-move — take the candidate that most improves score.
      let bestTo = -1, bestScore = cur;
      for (const t of cands) {
        unplace(state, inst); place(state, inst, t);
        const s = scorePlan(state).total;
        unplace(state, inst); place(state, inst, from);
        if (s < bestScore - 1e-9) { bestScore = s; bestTo = t; }
      }
      if (bestTo >= 0) {
        unplace(state, inst); place(state, inst, bestTo); cur = bestScore;
        if (cur < best - 1e-9) snapshot();
        continue;
      }
      // 2) SWAP — a strongly-hinted course often can't move because its ideal
      //    term is FULL. Swap it with a lower-priority course already there
      //    (the ME EN 204 stranding). Only attempt for a course that is
      //    genuinely STRANDED (≥2 academic years from its hint) — this keeps the
      //    expensive swap search rare, so it doesn't slow the common case.
      const hint = state.fcHint && state.fcHint[baseId(inst.uid)];
      const wantYr = hint ? hint.y - 1 : null;
      let didSwap = false;
      if (wantYr != null && Math.abs(acadYearIdx(state.terms, from) - wantYr) >= 2) {
      const swapTerms = [];
      for (let t = 0; t < state.terms.length; t++) {
        const term = state.terms[t];
        if (t === from || t >= depLimit || !term || !term.enabled) continue;
        if (state.termBudget != null && t > state.termBudget) continue;
        if (!inst.course.off.includes(term.season)) continue;
        if (state.load[t] + inst.course.credits <= cap) continue;   // has room → step 1 handled it
        swapTerms.push(t);
      }
      swapTerms.sort((a, b) =>
        Math.abs(acadYearIdx(state.terms, a) - wantYr) - Math.abs(acadYearIdx(state.terms, b) - wantYr));
      swapTerms.length = Math.min(swapTerms.length, 3);   // only the 3 nearest-hint full terms
      for (const t of swapTerms) {
        // inst must be prereq/gate-valid at t (ignoring cap, which the swap frees)
        unplace(state, inst);
        const g = admitGateFor(state, inst);
        const preOk = prereqSatisfied(state, inst, t) && (g < 0 || acadYearIdx(state.terms, t) >= g);
        place(state, inst, from);
        if (!preOk) continue;
        const others = [...state.assign].filter(([, tt]) => tt === t).map(([u]) => u)
          .filter(u => !state.pinnedUids.has(u) && !state.blockOf.has(u));
        for (const uid2 of others) {
          const j = state.byUid.get(uid2);
          if (from >= earliestDependentTerm(uid2)) continue;   // j can't legally go to 'from'
          unplace(state, inst); unplace(state, j);
          if (canPlace(state, j, from)) {
            place(state, j, from);
            if (canPlace(state, inst, t)) {
              place(state, inst, t);
              const s = scorePlan(state).total;
              if (s < cur - 1e-9) { cur = s; if (cur < best - 1e-9) snapshot(); didSwap = true; break; }
              unplace(state, inst); unplace(state, j);       // revert
              place(state, inst, from); place(state, j, t);
            } else { unplace(state, j); place(state, inst, from); place(state, j, t); }
          } else { place(state, inst, from); place(state, j, t); }
        }
        if (didSwap) break;
      }
      }   // end stranded-course swap gate
      if (didSwap) continue;
      // 3) SIMULATED ANNEALING — occasionally accept a slightly-WORSE move to
      //    escape local optima (best-ever is snapshotted and restored at the end)
      if (cands.length && temp > 0.02) {
        const t = cands[(rnd() * cands.length) | 0];
        unplace(state, inst); place(state, inst, t);
        const s = scorePlan(state).total;
        const delta = s - cur;
        if (delta < 0 || rnd() < Math.exp(-delta / temp)) { cur = s; if (cur < best - 1e-9) snapshot(); }
        else { unplace(state, inst); place(state, inst, from); }
      }
    }
    // restore the best plan seen (SA may have left us on a worse "current")
    if (cur > best + 1e-9) {
      state.assign = new Map(bestSnap);
      state.load = state.terms.map(() => 0);
      state.assign.forEach((t, uid) => { state.load[t] += state.byUid.get(uid).course.credits; });
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
      if (baseId(i.uid) === bid && (!i.course.bucket || i.course.isReligion) && i.k > state.byUid.get(uid).k) m = Math.min(m, t);
    });
    return m;
  }

  /* COMPACTION — when a plan sprawls across more Fall/Winter terms than needed
     (a major+minor smeared thin at the 12 floor), empty the lightest surplus
     terms by repacking their courses into other active terms with headroom.
     Emptying a term needs several coordinated moves that hill-climbing + the
     compactness penalty can't reach alone. */
  function compact(state) {
    const cap = Math.min(BYU_HARD_CAP, state.profile.settings.maxCreditsFW || BYU_HARD_CAP);
    for (let round = 0; round < 8; round++) {
      const activeIdx = [...new Set(state.assign.values())];
      const fw = state.terms.filter(tm => tm.isFW && tm.enabled && activeIdx.includes(tm.index)).map(tm => tm.index);
      const totalFW = fw.reduce((s, t) => s + state.load[t], 0);
      // NO hard 8-term floor: a transfer/mid-degree student with 60 credits
      // left deserves a 4-term plan. A fresh 120-cr degree still computes to
      // ~8 on its own (120/15.5 ≈ 7.7 → 8); caps + prereqs bound the rest.
      const ideal = state.idealTerms != null
        ? state.idealTerms : Math.max(1, Math.round(totalFW / 15.5));
      // A term below the full-time line is ALWAYS worth trying to dissolve,
      // however few semesters the plan is using. The count alone said yes to
      // Chemistry's eleven terms — the eleventh holding a single 2-credit
      // religion class — because eleven was a legal number of semesters for
      // its credit total. Term count is a budget, not a certificate of health.
      // The score gate below still vetoes any move that makes things worse.
      const starved = fw.some(t => state.load[t] < floorFW(state) - 0.01);
      // Under a stretch this pass changes job. The semester COUNT is the thing
      // the student picked, so compacting is no longer an improvement — it is
      // the optimizer overruling them. Accounting paced cleanly to ten
      // 12-credit semesters and this pulled it back to nine, finishing a term
      // early of the date the student typed. It still runs as a REPAIR: a term
      // below the full-time line is worth dissolving whatever the target.
      if (state.stretch && !starved) return;
      if (fw.length <= ideal && !starved) return;
      const cands = fw.filter(t => {
        const uids = [...state.assign].filter(([, tt]) => tt === t).map(([u]) => u);
        return uids.length && !uids.some(u => state.blockOf.has(u) || state.pinnedUids.has(u));
      }).sort((a, b) => state.load[a] - state.load[b]);   // lightest first
      let emptied = false;
      for (const t of cands) {
        const before = scorePlan(state).total;
        const uids = [...state.assign].filter(([, tt]) => tt === t).map(([u]) => u);
        const moved = [];
        let ok = true;
        for (const uid of uids) {
          const inst = state.byUid.get(uid);
          const depLimit = depLimitOf(state, uid);
          unplace(state, inst);
          let placed = false;
          // pack into the FULLEST term that still has headroom
          const targets = fw.filter(x => x !== t).sort((a, b) => state.load[b] - state.load[a]);
          for (const x of targets) {
            if (x >= depLimit) continue;
            if (state.load[x] + inst.course.credits > cap) continue;
            if (canPlace(state, inst, x)) { place(state, inst, x); moved.push(inst); placed = true; break; }
          }
          if (!placed) { place(state, inst, t); ok = false; break; }
        }
        if (ok && scorePlan(state).total <= before) { emptied = true; break; }
        moved.forEach(inst => { unplace(state, inst); place(state, inst, t); });   // revert
      }
      if (!emptied) return;
    }
  }

  /* GAP CLOSE — an EMPTY enabled Fall/Winter term BEFORE the last active term
     is a skipped semester (unrealistic). Collapse the plan leftward: pull
     movable courses from the tail into the gap until it's full, which activates
     the gap and lightens/empties a later term. (Only interior gaps — empty
     terms AFTER the last active one are just unused budget.) */
  function closeGaps(state) {
    const minFW = floorFW(state);
    const cap = Math.min(BYU_HARD_CAP, state.profile.settings.maxCreditsFW || BYU_HARD_CAP);
    for (let round = 0; round < 8; round++) {
      const active = [...new Set(state.assign.values())].sort((a, b) => a - b);
      if (!active.length) return;
      const last = active[active.length - 1];
      const gap = state.terms.find(tm => tm.isFW && tm.enabled && tm.index < last && !active.includes(tm.index));
      if (!gap) return;
      let moved = false;
      for (let src = last; src > gap.index && state.load[gap.index] < minFW; src--) {
        const uids = [...state.assign].filter(([, tt]) => tt === src).map(([u]) => u);
        for (const uid of uids) {
          if (state.load[gap.index] + 3 > cap) break;
          const inst = state.byUid.get(uid);
          if (state.pinnedUids.has(uid) || state.blockOf.has(uid)) continue;
          if (gap.index >= depLimitOf(state, uid)) continue;
          unplace(state, inst);
          if (canPlace(state, inst, gap.index)) { place(state, inst, gap.index); moved = true; }
          else place(state, inst, src);
        }
      }
      if (!moved) return;
    }
  }

  function consolidate(state) {
    const minFW = floorFW(state);
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
          // lightest destination first — dumping everything into one early
          // term stacks religion/GE and gets the whole move rejected
          const order = state.terms.map(tm => tm.index)
            .filter(x => x !== t && x < depLimit && !lows.includes(x))
            .sort((a, b) => state.load[a] - state.load[b]);
          for (const x of order) {
            if (canPlace(state, inst, x)) { place(state, inst, x); moved.push(inst); placed = true; break; }
          }
          if (!placed) { place(state, inst, t); ok = false; break; }
        }
        // small tolerance: emptying a straggler shifts the last-two boundary
        // and briefly looks worse; the improve() pass after cleans that up
        if (!ok || scorePlan(state).total > before + 3) {
          moved.forEach(inst => { unplace(state, inst); place(state, inst, t); });
        } else if (ok) { emptied = true; }
      }
      if (!emptied) break;
    }
  }

  /* Targeted rebalance: pull courses from the heaviest terms into starved
     (below-minimum) ones. Random hill-climbing rarely samples exactly this
     donor→starved pair, so extended plans kept 2-5 credit tail terms. */
  function fillLight(state) {
    const minFW = floorFW(state);
    for (let round = 0; round < 40; round++) {
      const activeIdx = new Set(state.assign.values());
      // rebalance among ACTIVE terms only — pulling courses into empty budget
      // terms to "fill" them just smears the plan thin (compact() handles the
      // opposite direction, and the Fall-ending penalty handles Winter finish)
      const fw = state.terms.filter(tm => tm.isFW && tm.enabled && activeIdx.has(tm.index))
        .map(tm => tm.index);
      const starved = fw.filter(t => state.load[t] < minFW)
        .sort((a, b) => state.load[a] - state.load[b])[0];
      if (starved === undefined) return;
      const donors = fw.filter(t => t !== starved && activeIdx.has(t))
        .sort((a, b) => state.load[b] - state.load[a]);
      // filling an EMPTY term takes several moves before the score nets
      // positive (each early move sits below full time) — move a batch of
      // courses to the floor in one score-gated step
      const before = scorePlan(state).total;
      const batch = [];
      for (const d of donors) {
        if (state.load[starved] >= minFW) break;
        if (state.load[d] <= state.load[starved] + 3) break;   // nothing meaningfully heavier
        const uids = [...state.assign].filter(([, t]) => t === d).map(([u]) => u);
        for (const uid of uids) {
          if (state.load[starved] >= minFW) break;
          const inst = state.byUid.get(uid);
          if (state.pinnedUids.has(uid) || state.blockOf.has(uid)) continue;
          if (state.load[d] >= minFW && state.load[d] - inst.course.credits < minFW) continue;
          if (starved >= depLimitOf(state, uid)) continue;
          unplace(state, inst);
          if (canPlace(state, inst, starved)) { place(state, inst, starved); batch.push([inst, d]); }
          else place(state, inst, d);
        }
      }
      if (!batch.length) return;
      if (scorePlan(state).total > before + 0.01) {            // didn't pay off — revert
        batch.forEach(([inst, d]) => { unplace(state, inst); place(state, inst, d); });
        return;
      }
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

  /* The graduating term — the one term floor padding must never touch.

     The full-time floor protects scholarships and aid, but it must not invent
     coursework. A student in their final semester takes the credits they still
     need and graduates; they do not enrol in nine credits of "Open Elective"
     to reach 14. Accounting's requirements land on exactly 120.0 credits and
     floor padding pushed the plan to 129. Across the catalogue three quarters
     of ALL filler sat in the last two terms of plans that were already
     complete, and padded plans averaged 130 credits against a 120 requirement.

     A first attempt capped TOTAL padding at the degree target instead. That
     also starved genuinely short MID-degree terms — below-full-time findings
     tripled and uneven-load findings quintupled — because a light semester in
     year two is a real problem the floor is right to fix. The final term is
     the only one where padding invents work rather than protecting the
     student, so it is the only one exempted OUTRIGHT.

     Mid-degree terms are handled by degree, not by exemption: once the plan
     already meets 120, padFloor() holds them to the full-time line (12) rather
     than the comfort floor (14). That keeps the protection the first attempt
     destroyed — no term ever drops below full time — while ending the
     invention. See padFloor() for the measurement behind it. */
  /* The Fall/Winter credit floor a plan is PACED and PADDED to. 14 is the
     comfort target the load policy aims at; BYU's actual full-time line is 12.
     A student who sets a LATER graduation target is asking, in the only words
     the UI gives them, for lighter semesters — so the comfort floor yields to
     the pace that target implies. It can never fall below the real full-time
     line, and with no target set nothing changes. Without this the two floors
     fought: paceCap said 13, minCreditsFW said 14, and the 14 won every time,
     which is why the first cut of the stretch moved nothing. */
  /* The MAP row's printed Total Hours for a plan term — but only when the
     number is believable. A Fall/Winter row printed BELOW BYU's full-time line
     is not the advisement center pacing a light semester; it is a bad scrape.
     The Anthropology cultural/linguistic double major prints rows of 3.0 and
     3.5 against five real courses apiece.

     That matters because everything downstream reads the printed total as a
     floor EXEMPTION — "this term is allowed to be short" — so a bogus 3.0 told
     padFloor not to pad and told scorePlan not to penalize, and the plan came
     out with a 6-credit Fall between two full semesters. The natural plan hid
     it: elective backfill happened to fill those terms anyway. Pacing the plan
     to a target moved the backfill earlier and exposed it.

     Same plausibility test the sheet-binding block already applies to the
     CEILING side (see sheetCeil) — this is the floor side of the same coin. */
  function sheetTotal(state, t) {
    if (!state.mapCap) return null;
    const total = state.mapCap.get(t);
    if (total == null) return null;
    const tm = state.terms[t];
    if (tm && tm.isFW && total < FULL_TIME_CREDITS) return null;
    return total;
  }

  function floorFW(state) {
    const pref = state.profile.settings.minCreditsFW || FULL_TIME_CREDITS;
    if (state.paceFill == null) return pref;
    return Math.max(FULL_TIME_CREDITS, Math.min(pref, state.paceFill));
  }

  function lastActiveTerm(state) {
    let last = -1;
    state.assign.forEach(t => { if (t > last) last = t; });
    return last;
  }

  /* Credits the plan still owes the 120-hour graduation requirement. The
     graduating term is padded to THIS, not to the full-time floor: Accounting
     already lands on 120.0 and needs nothing, while Elementary Education
     lands on 118 and genuinely needs one more class. Padding to the floor
     instead gave Accounting nine credits it did not need. */
  function creditsOwed(state) {
    let planned = 0;
    state.terms.forEach(tm => { planned += state.load[tm.index] || 0; });
    const earned = state.terms.earnedCredits || 0;
    const target = UG_TARGET_CREDITS + (state.profile.majorId === "is-bs-mism" ? 24 : 0);
    return target - (planned + earned);
  }

  /* Drop every disposable floor-filler. Both floor passes call this first so
     repeated enforceFloor()/improve() cycles don't accumulate phantom
     electives, and solve() calls it before the last compact() so compact's
     term-count target reflects REAL content. */
  function stripFloorPadding(state) {
    state.instances.filter(i => /^ELECTIVE\+/.test(i.uid)).forEach(i => {
      unplace(state, i); state.byUid.delete(i.uid); delete state.cat[i.uid];
    });
    state.instances = state.instances.filter(i => !/^ELECTIVE\+/.test(i.uid));
  }

  /* FLOOR PADDING — the ONE place disposable `ELECTIVE+` filler is created,
     shared by enforceFloor (mid-solve) and topUpFloor (final).

     Filler is not wrong in itself. A term that lands at 10 credits really does
     cost the student full-time status, and one open elective is the honest fix
     for that. What it must not do is INVENT work, and it was: measured across
     the 700-plan taxonomy, **78 of 78 padded plans already reached the
     120-credit graduation requirement before a single filler slot was added.**
     Three rules keep it honest:

       1. Once the degree requirement is met, padding stops protecting the
          student and starts adding classes they will never need — so the bar
          drops from the profile's COMFORT floor (`minCreditsFW`, default 14)
          to BYU's actual full-time line, 12. The 14-credit preference still
          shapes the plan through scorePlan and the redistribution pass above;
          it just no longer fabricates credits to reach itself.
       2. At most TWO filler cards in one semester. Three or four "ELECTIVE"
          cards side by side read as the solver giving up, because they are.
          This cap yields to the full-time floor — see the loop.
       3. The card is sized to the GAP, not a flat 3 credits. Flat 3s overshot:
          158 of 364 padded terms used to end ABOVE their own MAP sheet's
          printed total.

     The graduating term keeps the stricter rule from the credits-owed fix:
     padded only as far as the credits still owed, never up to a floor. A
     student in their last semester takes what they still need and graduates. */
  function padFloor(state) {
    const minFW = floorFW(state);
    const active = new Set(state.assign.values());
    const gradTerm = lastActiveTerm(state);
    state.terms.forEach(tm => {
      if (!tm.isFW || !tm.enabled || !active.has(tm.index)) return;
      // MAP-sheet terms follow their own printed total — a 13-credit sheet
      // semester is the advisement center's pacing, never "short"
      const mc = sheetTotal(state, tm.index);
      for (let g = 1; g <= 5; g++) {
        // the two-card cap is COSMETIC, so it yields to the one thing that is
        // a guarantee rather than a preference: a term below BYU's full-time
        // line keeps filling. In practice this never fires past g=2.
        if (g > 2 && state.load[tm.index] >= FULL_TIME_CREDITS) break;
        const owed = creditsOwed(state);
        if (tm.index === gradTerm && owed <= 0.01) break;
        const want = owed > 0.01 ? minFW : Math.min(minFW, FULL_TIME_CREDITS);
        const floorTarget = mc != null ? Math.min(want, mc) : want;
        let gap = floorTarget - state.load[tm.index];
        if (tm.index === gradTerm) gap = Math.min(gap, owed);
        if (gap <= 0.01) break;
        // 0.5-credit granularity, but never a card smaller than 1 credit —
        // "Open Elective, 0.5 cr" is not a class anyone registers for
        const cr = Math.max(1, Math.min(3, Math.ceil(gap * 2) / 2));
        const id = `ELECTIVE+ ${tm.index}.${g}`;
        state.cat[id] = { id, display: "ELECTIVE", name: "Open Elective / Exploration",
          credits: cr, pre: [], off: "FWSU", diff: 3, load: 1, demand: "low", rare: false,
          tags: [], testOut: "Fills full-time status — swap in a real elective, minor course, or internship credit.",
          repeatMax: 1, placeholder: true, elective: true, note: null };
        const inst = { uid: id, course: state.cat[id], k: 1, total: 1, buckets: ["electives::floor"] };
        state.byUid.set(id, inst); state.instances.push(inst); place(state, inst, tm.index);
      }
    });
  }

  /* FINAL floor top-up — runs AFTER the last improve(). Unlike enforceFloor it
     ONLY relocates LOW-VALUE courses (electives, GE/religion slots, un-hinted)
     into a below-min term, so it can never (a) re-strand a flowchart-hinted
     major course or (b) re-activate a surplus term the optimizer just emptied.
     Any term still short goes to padFloor(). */
  function topUpFloor(state) {
    const minFW = floorFW(state);
    stripFloorPadding(state);                                               // idempotent
    const moveCost = uid => {
      const c = state.byUid.get(uid).course;
      if (c.elective) return 0;
      if (c.placeholder && (c.level == null || c.level <= 1)) return 1;   // GE slot
      if (c.placeholder) return 2;                                        // major/minor slot
      return state.fcHint && state.fcHint[baseId(uid)] ? 9 : 3;           // hinted major = never move
    };
    for (let round = 0; round < 30; round++) {
      const active = new Set(state.assign.values());
      const low = state.terms.filter(tm => tm.isFW && tm.enabled && active.has(tm.index) && state.load[tm.index] < minFW)
        .sort((a, b) => state.load[b.index] - state.load[a.index])[0];   // closest-to-full first
      if (!low) break;
      const t = low.index;
      const donors = state.terms.filter(tm => tm.isFW && tm.enabled && active.has(tm.index) && tm.index !== t && state.load[tm.index] > minFW)
        .sort((a, b) => state.load[b.index] - state.load[a.index]);
      let moved = false;
      for (const d of donors) {
        const uids = [...state.assign].filter(([, tt]) => tt === d.index).map(([u]) => u)
          .filter(u => !state.pinnedUids.has(u) && !state.blockOf.has(u) && moveCost(u) <= 3)
          .sort((a, b) => moveCost(a) - moveCost(b));
        for (const uid of uids) {
          const inst = state.byUid.get(uid);
          if (state.load[d.index] - inst.course.credits < minFW) continue;
          if (t >= depLimitOf(state, uid)) continue;
          unplace(state, inst);
          if (canPlace(state, inst, t)) { place(state, inst, t); moved = true; break; }
          place(state, inst, d.index);
        }
        if (moved) break;
      }
      if (!moved) break;
    }
    padFloor(state);   // anything still short gets bounded, gap-sized filler
  }

  /* HARD FLOOR — the score nudges terms toward full time, but the user wants a
     GUARANTEE: no active Fall/Winter term below 12 credits (part-time risks
     scholarships/housing). Runs LAST: first redistribute a movable course from
     a term that can spare it, then, if a term still can't reach 12, hand it to
     padFloor() — a real full-time semester beats a part-time one, and that is
     the one thing padding is still allowed to buy past the 120-credit target. */
  function enforceFloor(state) {
    const minFW = floorFW(state);
    stripFloorPadding(state);
    // pass 1: redistribution — donor keeps ≥ min, prereqs/dependents stay valid
    for (let round = 0; round < 40; round++) {
      const active = new Set(state.assign.values());
      const low = state.terms
        .filter(tm => tm.isFW && tm.enabled && active.has(tm.index) && state.load[tm.index] < minFW)
        .sort((a, b) => state.load[a.index] - state.load[b.index])[0];
      if (!low) break;
      const t = low.index;
      const donors = state.terms
        .filter(tm => tm.isFW && tm.enabled && active.has(tm.index) && tm.index !== t)
        .sort((a, b) => state.load[b.index] - state.load[a.index]);
      // prefer to relocate LOW-VALUE courses (electives, GE slots, un-hinted)
      // into the starved term — never strand a strongly flowchart-hinted major
      // course far from its recommended year just to hit the floor
      const moveCost = uid => {
        const c = state.byUid.get(uid).course;
        if (c.elective) return 0;
        if (c.placeholder && (c.level == null || c.level <= 1)) return 1;   // GE slot
        if (c.placeholder) return 2;
        const h = state.fcHint && state.fcHint[baseId(uid)];
        if (!h) return 3;
        return 6 + Math.abs(acadYearIdx(state.terms, t) - (h.y - 1));       // hinted: rises w/ disruption
      };
      let moved = false;
      for (const d of donors) {
        if (state.load[d.index] <= minFW) break;   // nothing left to spare
        const uids = [...state.assign].filter(([, tt]) => tt === d.index).map(([u]) => u)
          .filter(u => !state.pinnedUids.has(u) && !state.blockOf.has(u))
          .sort((a, b) => moveCost(a) - moveCost(b));
        for (const uid of uids) {
          const inst = state.byUid.get(uid);
          if (state.load[d.index] - inst.course.credits < minFW) continue;
          if (t >= depLimitOf(state, uid)) continue;   // would land on/after a dependent
          unplace(state, inst);
          if (canPlace(state, inst, t)) { place(state, inst, t); moved = true; break; }
          place(state, inst, d.index);
        }
        if (moved) break;
      }
      if (!moved) break;
    }
    // pass 2: any term still short gets bounded, gap-sized filler
    padFloor(state);
  }

  /* LAST-CHANCE PLACEMENT — seed() computes `unscheduled` before the optimizer
     has run, and nothing revisits it. A course that had nowhere to go in the
     first pass therefore stays unplaced for good, even after compaction and
     tail-weaving free exactly the room it needed.

     The commonest reason it had nowhere to go is a PREREQUISITE that landed too
     late. Acting's TMA 291 is pulled in by prereq closure for TMA 497, gets no
     early seat because the MAP sheet fills every term, and ends up in the plan's
     final Fall — after which TMA 497, taught Fall only, has no term left in the
     horizon. depLimitOf() cannot prevent this: it only looks at dependents that
     are already SCHEDULED, and TMA 497 never was.

     Two attempts per stranded course, cheapest first:
       1. place it as-is in any legal term (the room may simply exist now);
       2. otherwise find the prerequisite blocking it, move that prerequisite to
          an earlier legal term, and retry. The prerequisite moves only if it
          lands somewhere canPlace() accepts and stays before its own dependents
          (depLimitOf), and every move is REVERTED if the rescue still fails —
          a stranded course is bad, but shuffling a healthy plan to fail anyway
          is worse. */
  /* PINNED-COURSE PREREQUISITE ORDER — a sheet pin bypasses canPlace, so a
     pinned course can sit BEFORE a prerequisite the plan schedules later, and
     nothing downstream repairs it: the pinned course never moves, and the
     optimizer has no move that pays it to relocate the prerequisite.

     The first tester to try Accounting found the canonical case in minutes:
     the sheet pins ACC 310 into freshman Winter and omits ACC 200 entirely
     (BYU assumes it is done beforehand), but the requirement bucket pulls
     ACC 200 into the plan wherever it fits — sometimes after 310. This class
     is 48 `prereq-order (MAP-locked)` warnings across 32 majors.

     For each pinned course P: for each unsatisfied prerequisite group, if an
     in-plan option sits at/after P's term and is movable, relocate it to the
     EARLIEST legal term before P (earliest = most slack, and a prerequisite
     belongs where it unlocks things). Three rounds so two-link chains settle.
     A group with no legal repair keeps its warning — honest beats silent. */
  function fixPinnedPrereqOrder(state) {
    for (let round = 0; round < 3; round++) {
      let moved = false;
      state.pinnedUids.forEach(puid => {
        const pinst = state.byUid.get(puid);
        const tp = state.assign.get(puid);
        if (!pinst || tp === undefined || pinst.k > 1) return;
        for (const group of pinst.course.pre) {
          const opts = Array.isArray(group) ? group : [group];
          if (opts.some(g => state.completed.has(g))) continue;
          let ok = false, candidate = null;
          for (const [uid, tt] of state.assign) {
            if (!opts.includes(baseId(uid))) continue;
            if (tt < tp) { ok = true; break; }
            if (candidate == null) candidate = uid;
          }
          if (ok || candidate == null) continue;
          if (state.pinnedUids.has(candidate) || state.blockOf.has(candidate)) continue;
          const ci = state.byUid.get(candidate);
          const from = state.assign.get(candidate);
          unplace(state, ci);
          let placed = false;
          for (let t = 0; t < tp; t++) {
            if (canPlace(state, ci, t)) { place(state, ci, t); placed = true; moved = true; break; }
          }
          // Every earlier term full (sheet terms sit at their printed totals —
          // Statistics pins MATH 113 into Winter of year ONE, so the only
          // earlier term is a Fall the sheet already filled). Trade places
          // with a flexible occupant: a GE/elective card can live anywhere,
          // a prerequisite cannot. All-or-nothing with revert, like weaveTail.
          if (!placed) {
            for (let t = 0; t < tp && !placed; t++) {
              const occ = [...state.assign].filter(([u, tt]) => tt === t).map(([u]) => u)
                .filter(u => !state.pinnedUids.has(u) && !state.blockOf.has(u))
                .map(u => state.byUid.get(u))
                .filter(oi => oi && (oi.course.elective || oi.course.placeholder) && !oi.course.isReligion);
              for (const oi of occ) {
                unplace(state, oi);
                if (canPlace(state, ci, t)) {
                  place(state, ci, t);
                  let home = -1;
                  for (let t2 = 0; t2 < state.terms.length; t2++) {
                    if (t2 !== t && canPlace(state, oi, t2)) { home = t2; break; }
                  }
                  if (home >= 0) { place(state, oi, home); placed = true; moved = true; break; }
                  unplace(state, ci);                    // no home for the displaced card
                }
                place(state, oi, t);                     // revert this attempt
              }
            }
          }
          if (!placed) place(state, ci, from);
        }
      });
      if (!moved) break;
    }
  }

  function rescueUnscheduled(state) {
    if (!state.instances.some(i => !state.assign.has(i.uid))) return;
    // Floor padding must never be what stands between a REQUIRED course and a
    // seat. enforceFloor has already run by now, so a term can look full while
    // most of its credits are disposable "Open Elective" cards — Chemistry's
    // Winter 2031 was 7.5 credits of filler, and a religion cornerstone that
    // would have fitted underneath it got pushed into a brand-new Fall holding
    // that one 2-credit class. Strip first; topUpFloor re-pads at the end.
    stripFloorPadding(state);
    const pending = state.instances.filter(i => !state.assign.has(i.uid));
    if (!pending.length) return;
    // NEVER past the plan's existing span. The first cut of this pass let the
    // horizon grow and "rescued" Acting's TMA 497 into a Fall 2031 holding that
    // one 3-credit class — a whole extra academic year, which is worse than the
    // honest error flag it replaced. If a course does not fit in the terms the
    // plan already uses, leaving it unscheduled is the truthful answer: app.js
    // names it and offers the dials (Spring term, credit cap, horizon), and
    // solver.js's standing rule is that the student decides those.
    // ...UNLESS the student named a graduation date. Then the semesters
    // between the plan's end and that date are not "the horizon growing" —
    // they are semesters the student has already said they intend to enrol in,
    // and refusing to use them is how Chemistry's fourth religion cornerstone
    // ended up unscheduled with an empty Winter sitting right there. The
    // target still bounds it: nothing is ever rescued past the date.
    const span = state.terms.targetIdx != null
      ? Math.min(state.terms.targetIdx, state.termBudget == null ? state.terms.targetIdx : state.termBudget)
      : lastActiveTerm(state);
    // Semesters the plan ALREADY uses come first. Opening a new one for a
    // single course is the outcome this pass exists to avoid, so it stays the
    // last resort rather than whichever term happens to sort first.
    const inUse = new Set(state.assign.values());
    const legalTerms = inst => state.terms
      .filter(tm => tm.enabled && tm.index <= span
                 && (state.termBudget == null || tm.index <= state.termBudget)
                 && (inst.course.off || "FW").includes(tm.season))
      .map(tm => tm.index)
      .sort((a, b) => (inUse.has(b) ? 1 : 0) - (inUse.has(a) ? 1 : 0) || a - b);

    // Pull the prerequisites blocking `inst` at term t earlier. Returns the
    // list of [instance, originalTerm] it moved, or null if it could not.
    const pullPrereqsBefore = (inst, t) => {
      const moved = [];
      const revert = () => moved.forEach(([m, f]) => { unplace(state, m); place(state, m, f); });
      // A repeatable's OWN previous instance blocks it just as hard as a
      // prerequisite does — prereqSatisfied requires #k strictly after #k-1 —
      // but it isn't in course.pre, so this pass could never see it. That is
      // the whole of the religion-cornerstone stranding: #3 drifts into the
      // last term and #4, needing a term after it, has nowhere to go while the
      // plan sits at 12 credits with room to spare. Pull #3 back one term and
      // both fit. Recursive by construction: pulling #3 pulls #2 if it must.
      if (inst.k > 1 && (!inst.course.bucket || inst.course.isReligion)) {
        const prevUid = `${baseId(inst.uid)}#${inst.k - 1}`;
        const prev = state.byUid.get(prevUid);
        const pt = prev && state.assign.get(prevUid);
        if (prev && pt !== undefined && pt >= t) {
          const from = pt;
          unplace(state, prev);
          let ok = false;
          for (let t2 = 0; t2 < t; t2++) {
            if (t2 >= depLimitOf(state, prevUid)) continue;
            if (canPlace(state, prev, t2) || pullPrereqsBefore(prev, t2)) {
              if (canPlace(state, prev, t2)) { place(state, prev, t2); moved.push([prev, from]); ok = true; break; }
            }
          }
          if (!ok) { place(state, prev, from); return null; }
        }
      }
      for (const group of inst.course.pre) {
        const opts = Array.isArray(group) ? group : [group];
        if (opts.some(g => state.completed.has(g))) continue;
        let satisfied = false, blocker = null;
        for (const [uid, tt] of state.assign) {
          if (!opts.includes(baseId(uid))) continue;
          if (tt < t) { satisfied = true; break; }
          if (blocker == null) blocker = uid;
        }
        if (satisfied) continue;
        // nothing of this group is in the plan, or it is immovable
        if (blocker == null || state.pinnedUids.has(blocker) || state.blockOf.has(blocker)) {
          revert(); return null;
        }
        const bi = state.byUid.get(blocker);
        const from = state.assign.get(blocker);
        unplace(state, bi);
        let ok = false;
        for (let t2 = 0; t2 < t; t2++) {
          if (t2 >= depLimitOf(state, blocker)) continue;
          if (canPlace(state, bi, t2)) { place(state, bi, t2); moved.push([bi, from]); ok = true; break; }
        }
        if (!ok) { place(state, bi, from); revert(); return null; }
      }
      return moved;
    };

    pending.forEach(inst => {
      const legal = legalTerms(inst);
      for (const t of legal) {
        if (canPlace(state, inst, t)) { place(state, inst, t); return; }
      }
      for (const t of legal) {
        const moved = pullPrereqsBefore(inst, t);
        if (!moved) continue;
        if (canPlace(state, inst, t)) { place(state, inst, t); return; }
        moved.forEach(([m, f]) => { unplace(state, m); place(state, m, f); });
      }
    });
  }

  /* BACKLOADING — trade a major course out of the last two terms for a flexible
     GE/elective slot sitting earlier.

     The plans that trip this are credit-balanced but content-backloaded: Korean
     runs 14/15/15/17/15/15/17/14 credits, which looks fine, while nine of its
     eighteen named courses sit in the final two semesters. The cause is not the
     prerequisite ladder, which was the obvious suspect and the wrong one —
     measured against the plan's own placements, only 3 of Korean's 11 late
     courses, 2 of Latin American Studies' 13 and 1 of English's 10 are actually
     pinned there by a prerequisite. The rest could legally sit at t0.

     What puts them late is that GE placeholders are front-loaded by design
     (scorePlan pushes low levels early), so they occupy the early capacity, the
     sheet fills the rest, and the major's own courses take the only seats left —
     the tail. Both kinds of card are interchangeable in the sense that matters:
     a "GE - Arts" slot can be satisfied any semester, a 400-level major course
     cannot. So swap them.

     Rules: the major course must clear level pacing at its new year (never drag
     a 400-level into freshman fall — that just trades one complaint for a worse
     one), both halves must pass canPlace, neither may cross a dependent
     (depLimitOf), and pinned/cohort/sheet-labelled cards are untouchable. Every
     swap is all-or-nothing and reverts cleanly. */
  function spreadMajorWork(state) {
    const used = [...new Set(state.assign.values())].sort((a, b) => a - b);
    if (used.length < 4) return;
    const lateFrom = used[used.length - 2];
    const movable = uid => !state.pinnedUids.has(uid) && !state.blockOf.has(uid)
      && !(state.mapLabels && state.mapLabels.has(uid));
    const isMajorCourse = uid => {
      const c = state.byUid.get(uid).course;
      return !c.placeholder && !c.elective && !c.bucket;
    };
    // a slot that stands for "some course of this kind", not a named class.
    // Religion is excluded: BYU paces it one per semester, and weaveTail
    // already documents why those must not be shuffled.
    const isFlexibleSlot = uid => {
      const c = state.byUid.get(uid).course;
      return (c.placeholder || c.elective) && !c.isReligion;
    };
    const majorsIn = t => [...state.assign]
      .filter(([u, tt]) => tt === t && isMajorCourse(u)).length;

    // Only touch plans that are ACTUALLY backloaded. A healthy board must come
    // out of this pass byte-identical, or a fix for 6 majors becomes churn
    // across 175. Thresholds mirror the taxonomy detector: ≥12 named courses,
    // ≥40% of them in the last two terms.
    const allMajors = [...state.assign].filter(([u]) => isMajorCourse(u));
    if (allMajors.length < 12) return;
    const lateShare = () => allMajors.filter(([u]) => state.assign.get(u) >= lateFrom).length
      / allMajors.length;
    if (lateShare() < 0.4) return;

    for (let round = 0; round < 20; round++) {
      const lateMajors = [...state.assign]
        .filter(([u, t]) => t >= lateFrom && isMajorCourse(u) && movable(u))
        .map(([u]) => u);
      if (!lateMajors.length) break;
      let swapped = false;
      for (const uid of lateMajors) {
        const mi = state.byUid.get(uid);
        const mt = state.assign.get(uid);
        const minY = minYearForLevel(courseLevel(mi.course));
        // earliest, emptiest-of-major-work donor terms first, so the major's
        // courses end up spread rather than piled into one rescued semester
        const donors = [...state.assign]
          .filter(([u, t]) => t < lateFrom && isFlexibleSlot(u) && movable(u)
                           && acadYearIdx(state.terms, t) >= minY)
          .sort((a, b) => (majorsIn(a[1]) - majorsIn(b[1])) || (a[1] - b[1]));
        for (const [duid, dt] of donors) {
          const di = state.byUid.get(duid);
          unplace(state, mi); unplace(state, di);
          if (dt < depLimitOf(state, uid) && mt < depLimitOf(state, duid)
              && canPlace(state, di, mt)) {
            place(state, di, mt);
            if (canPlace(state, mi, dt)) { place(state, mi, dt); swapped = true; break; }
            unplace(state, di);
          }
          place(state, mi, mt); place(state, di, dt);      // revert
        }
        if (swapped) break;
      }
      if (!swapped) break;
    }
  }

  /* MAP-CAP GUARANTEE — several passes (swaps with freed capacity, floor
     top-ups, cohort placement) can push a MAP-sheet term past its printed
     Total Hours. This final pass evicts the overflow: disposable padding
     first, then electives/GE slots, relocated via canPlace so nothing else
     breaks. Sheet-pinned courses and cohort envelopes are never touched. */
  function enforceMapCaps(state) {
    if (!state.mapCap || !state.mapCap.size) return;
    const cost = u => {
      if (/^ELECTIVE\+/.test(u)) return 0;               // floor padding: disposable
      const c = state.byUid.get(u).course;
      if (c.elective) return 1;
      if (c.placeholder && (c.level == null || c.level <= 1)) return 2;   // GE slot
      if (c.placeholder) return 3;
      return 4;
    };
    state.mapCap.forEach((total, t) => {
      // The printed total is the sheet's own DENSITY, and a graduation target
      // is a request to change exactly that — the same reasoning that lets a
      // stretch thin these rows lets a rush thicken them. Order and season,
      // which are what the sheet is really authoritative about, do not move.
      const ceil = state.terms[t].isFW
        ? Math.max(total, 16, state.paceFill || 0) : total;
      let guard = 0;
      while (state.load[t] > ceil + 0.6 && guard++ < 12) {
        const uids = [...state.assign].filter(([, tt]) => tt === t).map(([u]) => u)
          .filter(u => !state.pinnedUids.has(u) && !state.blockOf.has(u))
          .sort((a, b) => cost(a) - cost(b));
        let moved = false;
        for (const u of uids) {
          const inst = state.byUid.get(u);
          if (/^ELECTIVE\+/.test(u)) {                   // padding just evaporates
            unplace(state, inst);
            state.byUid.delete(u);
            state.instances = state.instances.filter(i => i.uid !== u);
            delete state.cat[u];
            moved = true; break;
          }
          unplace(state, inst);
          let target = state.terms.find(tm => tm.enabled && tm.index !== t &&
            canPlace(state, inst, tm.index));
          if (!target) {
            // requirements genuinely exceed the sheet's printed capacity
            // (slot-approximation slack, added minors). Overflow to the
            // LATEST term with room under the hard cap — a slightly heavy
            // senior term beats an overloaded freshman fall.
            state._mapCapOff = true;
            target = [...state.terms].reverse().find(tm => tm.enabled &&
              tm.index !== t && canPlace(state, inst, tm.index));
            state._mapCapOff = false;
          }
          if (target) { place(state, inst, target.index); moved = true; break; }
          place(state, inst, t);                         // nowhere else — keep
        }
        if (!moved) break;
      }
    });
  }

  /* HEADROOM WEAVING — fold post-MAP "leftover" terms into the sheet's own
     semesters. MAP-first plans park non-sheet work (GE slots, choose-buckets,
     filler electives, prerequisite pulls) in trailing terms while the sheet
     terms sit at their PRINTED totals (~14-15.5) — under the 16-credit policy
     band there's ~1.5 cr/term of unused headroom. improve()'s random score-
     gated moves rarely find the multi-move sequence that fully EMPTIES a term,
     so this pass does it deterministically:
       - tail terms are processed last-first, ALL-OR-NOTHING: either every item
         finds an earlier home (term dies) or the term is left untouched — no
         half-drained semester below the 12-credit floor.
       - within a term, deepest prerequisite chains move first and target the
         EARLIEST legal term (a pulled prereq lands early, where it unlocks).
       - a course whose seasons/prereqs block every direct home may SWAP with a
         flexible unlabeled placeholder (GE slot) — the placeholder vacates to
         another term, the course takes its seat. Religion slots (1-per-term
         pacing) and sheet-labeled cards (the board must keep reading like the
         printed MAP) are never bumped.
       - floor-padding (ELECTIVE+) in a dying term is deleted, not moved: it
         existed only to satisfy THAT term's full-time floor.
     Every placement passes canPlace (season/prereq/gate/caps) plus the 16-cr
     policy ceiling, so the result is legal by construction. */
  function weaveTail(state) {
    if (!state.mapCap || !state.mapCap.size) return;      // MAP-first plans only
    const lastSheet = Math.max(...state.mapCap.keys());
    const FLOOR = floorFW(state);
    const depths = computeDepth(state.instances, state.cat);
    const room = (t, cr, ceil) => state.load[t] + cr <= ceil + 0.01;

    // a blocked course trades places with a flexible placeholder: the slot
    // vacates (to another term with room), the course takes its seat. The
    // DONOR term must stay at/above the full-time floor after the exchange
    // (a 0.5-cr seminar replacing a 3-cr GE slot drains it). Returns a revert
    // closure so a failed all-or-nothing term can undo the whole exchange.
    const trySwap = (inst, fromT, ceil) => {
      for (const tm of state.terms) {
        if (!tm.enabled || !tm.isFW || tm.index >= fromT) continue;
        if (!inst.course.off.includes(tm.season)) continue;
        const slots = [...state.assign].filter(([, tt]) => tt === tm.index)
          .map(([u]) => state.byUid.get(u))
          .filter(s => s.course.placeholder && !s.course.isReligion &&
            !state.pinnedUids.has(s.uid) && !state.blockOf.has(s.uid) &&
            !(state.mapLabels && state.mapLabels.get(s.uid)));
        for (const s of slots) {
          // donor floor: term keeps ≥ FLOOR after losing s and gaining inst
          if (state.load[tm.index] - s.course.credits + inst.course.credits < FLOOR - 0.01) continue;
          unplace(state, s);
          if (room(tm.index, inst.course.credits, ceil) && canPlace(state, inst, tm.index)) {
            const home2 = state.terms.find(t2 => t2.enabled && t2.isFW &&
              t2.index !== fromT && t2.index !== tm.index &&
              room(t2.index, s.course.credits, ceil) && canPlace(state, s, t2.index));
            if (home2) {
              place(state, s, home2.index);
              place(state, inst, tm.index);
              return () => {                               // revert closure
                unplace(state, inst);
                unplace(state, s);
                place(state, s, tm.index);
              };
            }
          }
          place(state, s, tm.index);                       // revert probe
        }
      }
      return null;
    };

    const tails = [...new Set([...state.assign.values()])]
      .filter(t => t > lastSheet && state.terms[t] && state.terms[t].isFW)
      .sort((a, b) => b - a);                              // last term first
    for (const t of tails) {
      const items = [...state.assign].filter(([, tt]) => tt === t)
        .map(([u]) => state.byUid.get(u));
      // a pinned/cohort course anchors the term — leave it whole
      if (items.some(i => state.pinnedUids.has(i.uid) || state.blockOf.has(i.uid))) continue;
      const padding = items.filter(i => /^ELECTIVE\+/.test(i.uid));
      const movable = items.filter(i => !/^ELECTIVE\+/.test(i.uid))
        .sort((a, b) => (depths.get(b.uid) || 0) - (depths.get(a.uid) || 0));
      const reverts = [];                                  // undo stack (LIFO)
      let ok = true;
      for (const inst of movable) {
        unplace(state, inst);
        // 16 is the policy band; 17 is the tolerated stretch ("sometimes 17
        // is fine") tried only when nothing fits at 16. A graduation target
        // replaces both with its own pace — otherwise this pass, which is not
        // score-gated, would quietly re-pack a deliberately stretched tail
        // back into the sheet terms at 16 credits and undo the whole thing.
        // ...but a tail term BELOW the full-time line is a semester that should
        // not exist, and dissolving it outranks the pace. Holding the band at
        // ~13 left 21 of 125 paced plans ending on a starved term — Accounting
        // finished on a Winter holding one 2-credit religion class. Pace is a
        // preference about how full semesters are; this is about whether a
        // semester is worth enrolling in at all, so the real policy band wins.
        const starvedTail = state.load[t] < floorFW(state) - 0.01;
        const band = (state.paceCap != null && !starvedTail)
          ? [Math.min(16, state.paceCap), Math.min(17, state.paceCap + 1)] : [16, 17];
        let home = null;
        for (const ceil of band) {
          home = state.terms.find(tm => tm.enabled && tm.isFW && tm.index < t &&
            room(tm.index, inst.course.credits, ceil) && canPlace(state, inst, tm.index));
          if (home) break;
        }
        if (home) {
          place(state, inst, home.index);
          reverts.push(() => { unplace(state, inst); place(state, inst, t); });
          continue;
        }
        const undoSwap = trySwap(inst, t, band[0]) || trySwap(inst, t, band[1]);
        if (undoSwap) {
          reverts.push(() => { undoSwap(); place(state, inst, t); });
          continue;
        }
        place(state, inst, t);                             // no home — abort term
        ok = false;
        break;
      }
      if (!ok) {                                           // all-or-nothing revert
        while (reverts.length) reverts.pop()();
        continue;
      }
      // decision log: these courses were folded forward from a dissolved
      // tail term — explain() tells the student (and the AI) why they sit
      // in a sheet term the printed MAP doesn't show them in
      if (!state.woven) state.woven = new Set();
      movable.forEach(inst => state.woven.add(inst.uid));
      padding.forEach(inst => {                            // dying term's padding evaporates
        unplace(state, inst);
        state.byUid.delete(inst.uid);
        state.instances = state.instances.filter(i => i.uid !== inst.uid);
        delete state.cat[inst.uid];
      });
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
      // year-restricted course (catalog "Senior standing." / a capstone): a
      // hard rule — surfaced so the student knows why it can't move earlier
      if (c.minY >= 3) {
        const yr = ["", "freshman", "sophomore", "junior", "senior"][c.minY] || `year ${c.minY}`;
        addCF(uid, "info", `Requires ${yr} standing — can't be taken before your ${yr} year.`);
      }
      if (c.note) addCF(uid, "note", c.note);

      // PREREQUISITE check — real catalog chains. A course whose prereq isn't
      // completed or scheduled strictly earlier gets a visible warning (moves
      // and pins can create this; the solver itself won't). EXCEPTION: a course
      // in a flowchart COHORT envelope is sequenced by the department's own
      // chart — its catalog prereqs on other cohort courses (which the chart
      // may schedule concurrently or later, e.g. EXDM 422↔415) are overridden,
      // so those don't warn.
      const inst = state.byUid.get(uid);
      const inCohort = state.blockOf.has(uid);
      const cohortMates = inCohort
        ? new Set(state.instances.filter(i => state.blockOf.has(i.uid)).map(i => baseId(i.uid)))
        : null;
      if (inst.k === 1) {
        (c.pre || []).forEach(group => {
          const opts = Array.isArray(group) ? group : [group];
          const ok = opts.some(g => {
            if (completed.has(g)) return true;
            if (cohortMates && cohortMates.has(g)) return true;   // dept chart sequences the cohort
            for (const [uid2, t2] of assign) if (baseId(uid2) === g && t2 < t) return true;
            return false;
          });
          if (!ok) {
            // Sheet doctrine (same as canPlace/seed-4b/the chain visual): a
            // MAP-coded pinned course whose prereq is ENTIRELY ABSENT from
            // the plan was placed that way by the advisement center on
            // purpose (AP/placement/track split — Music's per-instrument
            // ladders, Dietetics' "Chem 101 or equivalent"). Only a prereq
            // that IS in the plan but sits late is a real ordering problem.
            const anyPresent = opts.some(g => [...assign].some(([u]) => baseId(u) === g));
            // Same-term sheet cohort: when the sheet pins BOTH this course and
            // its prerequisite to the SAME semester, that is the advisement
            // center co-scheduling a junior-core block (Accounting's ACC 407
            // alongside 402/405/409), not an ordering mistake. Warning on it
            // buried the real problems under noise.
            const sheetConcurrent = state.pinnedUids.has(uid) && state.mapCodes &&
              state.mapCodes.has(baseId(uid)) &&
              opts.some(g => state.mapCodes.has(g) &&
                [...assign].some(([u, t2]) => baseId(u) === g && t2 === t && state.pinnedUids.has(u)));
            if (sheetConcurrent) {
              addCF(uid, "info", `The official sheet puts this in the same semester as ${opts.map(g => cat[g]?.display || g).join(" or ")} — the department runs them together as a block.`);
              return;
            }
            const sheetAssumed = !anyPresent && state.pinnedUids.has(uid) &&
              state.mapCodes && state.mapCodes.has(baseId(uid));
            if (sheetAssumed) {
              addCF(uid, "info", `The official sheet schedules this without ${opts.map(g => cat[g]?.display || g).join(" or ")} — the department assumes it's covered (AP, placement, or your track). Verify with advisement if unsure.`);
              return;
            }
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
      // isn't normally taught. Envelope members are exempt: the department
      // enrolls the cohort as a block regardless of the catalog season.
      const tm = terms[t];
      if (tm && c.off && !c.off.includes(tm.season) && !state.blockOf.has(uid)) {
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

    // EXCESSIVE CREDITS — extra classes cost tuition and semesters. Two
    // honest signals: open electives nothing requires, and a graduation
    // total far beyond typical (135 clears legit heavy programs like ChemE).
    {
      let planCr = 0, elecCr = 0;
      assign.forEach((t, uid) => {
        const c = state.byUid.get(uid).course;
        planCr += c.credits;
        if (c.elective || /^ELECTIVE\+/.test(uid)) elecCr += c.credits;
      });
      let compCr = 0;
      completed.forEach(id => {
        compCr += (cat[id] || (typeof DATA !== "undefined" && DATA.courses[id]) || { credits: 3 }).credits;
      });
      const grandTotal = planCr + compCr;
      // THE 120-CREDIT FLOOR. Filling every requirement is not enough to
      // graduate — BYU also wants 120 hours, and a plan can satisfy a lean
      // major and still land short. This is the one warning a student cannot
      // discover by reading their own plan, so it leads.
      // tolerance is float-noise only: BYU counts half credits, and a 119.5
      // plan really does leave the student half a credit short of graduating
      if (grandTotal < UG_TARGET_CREDITS - 0.01) {
        const need = Math.ceil(UG_TARGET_CREDITS - grandTotal);
        flags.push({ level: "error", icon: "triangle-exclamation", text: `This plan totals ~${Math.round(grandTotal)} credits (completed + planned) — short of the ${UG_TARGET_CREDITS} BYU requires to graduate. Add about ${need} more credit${need === 1 ? "" : "s"}: a minor, a certificate, or open electives.` });
      }
      // Only call electives "padding" when the plan can actually AFFORD to lose
      // them. Below ~127 those credits are what carries the student to 120, and
      // telling them to cut electives there is advice that prevents graduation.
      if (elecCr >= 7 && grandTotal - elecCr >= UG_TARGET_CREDITS) {
        flags.push({ level: "warn", icon: "coins", text: `~${Math.round(elecCr)} credits of open electives pad this plan beyond your actual requirements — roughly ${elecCr >= 12 ? "a semester" : "half a semester"} of tuition. Swap them for a minor or certificate (What if… compares one), or ask advisement about graduating lighter.` });
      }
      if (grandTotal > 135) {
        flags.push({ level: "warn", icon: "scale-unbalanced", text: `This path graduates with ~${Math.round(grandTotal)} total credits (completed + planned) — well beyond the 120 BYU requires. Check the progress report for requirements filled past their need, and verify double-counting with your advisor.` });
      }
    }

    // part-time Fall/Winter warning
    const minFW = floorFW(state);
    terms.forEach(tm => {
      const active = [...assign.values()].includes(tm.index);
      if (active && tm.isFW && state.load[tm.index] < minFW) {
        flags.push({ level: profile.settings.scholarshipFullTime ? "warn" : "info", icon: "gauge-simple-low", text: `${tm.label} is below ${minFW} credits${profile.settings.scholarshipFullTime ? " — scholarship / full-time status risk" : ""}.` });
      }
    });

    // A Fall/Winter term with NOTHING in it, sandwiched between enrolled terms.
    // scorePlan penalizes these but can't always avoid one, and sitting out a
    // semester costs continuous enrollment, scholarships and often housing —
    // too expensive to leave for the student to notice on their own.
    {
      const activeT = [...new Set(assign.values())].sort((a, b) => a - b);
      const first = activeT[0], last = activeT[activeT.length - 1];
      const empty = terms.filter(tm => tm.isFW && tm.enabled && tm.index > first &&
        tm.index < last && !state.load[tm.index]).map(tm => tm.label);
      if (empty.length) {
        flags.push({ level: "warn", icon: "calendar-xmark", text: `${empty.join(" and ")} ${empty.length > 1 ? "are" : "is"} empty in the middle of this plan — sitting out a semester can break continuous enrollment and scholarship eligibility. Drag work into ${empty.length > 1 ? "those terms" : "that term"} or finish a semester sooner.` });
      }
    }

    // MAP-SHEET COVERAGE. The sheet is authoritative, so a course printed on it
    // that ended up in neither the plan nor the completed list is a conflict
    // between the sheet and the scraped catalog requirements. We surface it
    // rather than force-scheduling it: the catalog may legitimately have
    // dropped the requirement, and only an advisor can say which is current.
    if (state.mapCodes && state.mapCodes.size) {
      const inPlan = new Set([...assign.keys()].map(baseId));
      const gone = [...state.mapCodes].filter(c =>
        !inPlan.has(c) && !completed.has(c) && cat[c] &&
        !(profile.excluded || []).includes(c));
      if (gone.length) {
        const names = gone.slice(0, 4).map(c => cat[c].display || c).join(", ");
        flags.push({ level: "warn", icon: "map", text: `Your ${state.mapName || "MAP"} sheet lists ${names}${gone.length > 4 ? ` and ${gone.length - 4} more` : ""}, but ${gone.length > 1 ? "they aren't" : "it isn't"} in this plan — the online catalog doesn't tie ${gone.length > 1 ? "them" : "it"} to a requirement, or another class you picked covers it. Worth confirming with your advisor.` });
      }
    }

    // lab ↔ lecture split: the optimizer pairs free courses, but sheet-pinned
    // ones keep the sheet's own pacing — either way the student should KNOW
    if (state.pairOf) state.pairOf.forEach((lecUid, labUid) => {
      const a = assign.get(labUid), b = assign.get(lecUid);
      if (a == null || b == null || a === b) return;
      const lab = state.byUid.get(labUid).course, lec = state.byUid.get(lecUid).course;
      addCF(labUid, "warn", `${lab.display || labUid} is the lab for ${lec.display || lecUid}, which sits in ${terms[b].label} — most students take them the SAME semester. Drag one to pair them${state.pinnedUids.has(labUid) && state.pinnedUids.has(lecUid) ? " (the official MAP sheet splits them — verify with advisement)" : ""}.`);
    });

    // the official sheet schedules Spring work but Spring is off — the student
    // decides (Recommended offers the one-click opt-in); we never auto-enable
    if (state.mapWantsSpring) {
      flags.push({ level: "warn", icon: "sun", text: "The official MAP sheet schedules some courses in a Spring term, but Spring terms are OFF in your constraints. Courses also taught Fall/Winter were re-sequenced; a Spring-only course will show as unscheduled. See Recommended (left panel) to add a Spring term." });
    }

    // Target graduation: one summary flag that names the target, so a too-
    // tight date reads as "your target doesn't fit" rather than a pile of
    // per-course errors with no visible cause. The per-course entries stay —
    // they say WHICH courses; this says WHY.
    if (state.terms.targetIdx != null) {
      const tgLabel = state.terms[state.terms.targetIdx].label;
      const nUnsched = problems.filter(p => p.type === "unscheduled").length;
      const lastT = lastActiveTerm(state);
      const activeT = new Set(assign.values());
      const fwT = terms.filter(tm => tm.isFW && activeT.has(tm.index));
      const perTerm = fwT.length
        ? fwT.reduce((s, tm) => s + (state.load[tm.index] || 0), 0) / fwT.length : 0;
      const pace = perTerm
        ? ` It paces about ${perTerm.toFixed(1)} credits per Fall/Winter semester across ${fwT.length}.` : "";
      if (nUnsched > 0) {
        // WHY it doesn't fit decides what to tell them, and the two causes take
        // opposite advice. If the degree needs more credits than the Fall/Winter
        // semesters before the target can physically hold, no amount of solver
        // work helps and "raise the credit cap" is close to useless — at a
        // three-year target the average major needs 124 credits against 102 of
        // capacity. That is a Spring/Summer conversation. If the capacity is
        // there and courses still won't fit, the binding constraint is
        // sequence — prerequisite chains, or a course taught one season a year
        // — and adding credits per term changes nothing. Saying both every
        // time taught students to ignore the flag.
        const fwToTarget = terms.filter(tm => tm.isFW && tm.enabled
          && tm.index <= state.terms.targetIdx).length;
        const capFW = Math.min(BYU_HARD_CAP, profile.settings.maxCreditsFW || 17);
        const room = fwToTarget * capFW;
        let placedCr = 0;
        state.load.forEach((cr, t) => { if (terms[t] && terms[t].isFW) placedCr += cr || 0; });
        const stuckCr = problems.filter(p => p.type === "unscheduled")
          .reduce((s, p) => s + ((state.byUid.get(p.uid) || { course: {} }).course.credits || 0), 0);
        const need = placedCr + stuckCr;
        const spOff = !profile.settings.allowSpring || !profile.settings.allowSummer;
        flags.push({ level: "error", icon: "flag-checkered",
          text: need > room + 0.5
            ? `Graduating by ${tgLabel} doesn't fit, and it isn't close: that leaves ${fwToTarget} Fall/Winter semesters, which hold ${Math.round(room)} credits even at your ${capFW}-credit cap, against the ${Math.round(need)} this degree still needs. ${spOff ? "Spring and Summer terms are the only way to close a gap this size — turn them on in Constraints" : "Even with Spring and Summer on, a gap this size needs a later date"}, or push the target back. ${nUnsched} course${nUnsched > 1 ? "s are" : " is"} parked unscheduled; nothing has been dropped.`
            : `Graduating by ${tgLabel} doesn't fit: ${nUnsched} required course${nUnsched > 1 ? "s" : ""} can't be scheduled in time. The semesters have the room — what blocks ${nUnsched > 1 ? "them" : "it"} is sequence: a prerequisite chain that has to run in order, or a class taught only one season a year. More credits per term won't help; a later target${spOff ? ", or Spring/Summer terms to run the chain sooner," : ""} will. Nothing has been dropped from your requirements.` });
      } else if (lastT >= 0 && lastT < state.terms.targetIdx && terms[lastT].isFW &&
                 terms.slice(lastT + 1, state.terms.targetIdx + 1)
                   .some(tm => tm.isFW && tm.enabled)) {
        // Finishing EARLY of the target is not a failure and it is not silent
        // padding either. Past a point a stretch stops being possible, and
        // inventing filler to reach the date would be charging the student for
        // classes to hit a number.
        //
        // But there are TWO reasons it stops, and they need different answers.
        // Usually it is the full-time floor: you cannot spread 120 credits
        // across twelve semesters and still be full time. On a MAP-bound major
        // it is more often the sheet — pace thins a sheet's generals but never
        // its coded courses, so Accounting's first five semesters stay at the
        // 14-16 the advisement centre printed and the plan lands at nine
        // regardless of the date. Blaming the floor there is simply false: nine
        // terms of 121 credits would sit at 12.1, comfortably full time.
        const heldBySheet = terms.filter(tm => tm.isFW && activeT.has(tm.index)
          && state.load[tm.index] > (state.paceCap || 99) + 0.5
          && [...assign].filter(([u, t2]) => t2 === tm.index && state.pinnedUids.has(u))
               .reduce((s, [u]) => s + ((state.byUid.get(u) || { course: {} }).course.credits || 0), 0)
             >= state.load[tm.index] / 2).length;
        flags.push({ level: "info", icon: "flag-checkered",
          text: heldBySheet
            ? `You finish in ${terms[lastT].label}, ahead of your ${tgLabel} target.${pace} ${heldBySheet} of those semesters are set by your ${state.mapName || "MAP"} sheet, which paces them heavier than your date asks for — the planner lightens the generals and religion around a sheet, never the major sequence itself. To use the extra time, add a minor, a certificate, or an internship.`
            : `You finish in ${terms[lastT].label}, ahead of your ${tgLabel} target — spreading the rest any thinner would drop you below full-time status.${pace} To use the extra time, add a minor or certificate, or lower your full-time floor in Constraints.` });
      } else {
        flags.push({ level: "info", icon: "flag-checkered",
          text: `On track for your ${tgLabel} graduation target — every requirement fits.${pace}` });
      }
    }

    // lease utilization hint
    const spsuUsed = [...assign.values()].some(t => !terms[t].isFW);
    if (profile.settings.housing === "off-campus-12mo" && !spsuUsed) {
      flags.push({ level: "info", icon: "house", text: "Your 12-month lease already covers Spring/Summer housing — a Spring term is nearly free on the housing side and could lighten Fall/Winter loads." });
    }

    // MAP-first provenance — the single most important thing to know about
    // a draft: whether it mirrors the official sheet or was generated
    if (state.mapName) {
      flags.unshift({ level: "info", icon: "map", text: `This draft follows the official ${state.mapName.replace(/\s*\(.*\)$/, "")} MAP sheet — the advisement center's own semester-by-semester plan. Completed courses, minors, and certificates are adapted around that skeleton.` });
    } else if (profile.majorId) {
      flags.unshift({ level: "info", icon: "wand-magic-sparkles", text: `No official MAP sheet is published for this major — this draft is algorithmically generated from catalog requirements. Sequencing is machine-checked but NOT advisor-authored; verify with your college advisement center.` });
    }

    // cohort notices
    state.blocks.forEach(blk => {
      const t = assign.get(blk.uids[0]);
      if (t !== undefined) flags.push({ level: "info", icon: "people-group", text: `${blk.label} locked as a cohort in ${terms[t].label}.` });
    });

    // limited-enrollment admission gate: tell the student the upper-division
    // major work is held until they're admitted (application ~ pre-core year)
    if (state.admitGate) {
      programs.forEach(p => {
        const g = state.admitGate[p.id];
        if (g == null) return;
        // Report the term the plan ACTUALLY starts gated work, not the earliest
        // year the gate would allow. Those diverge whenever something upstream
        // (an unfinished IS 303, a late pre-core) pushes the first professional
        // course back, and quoting the theoretical gate told students to apply
        // a year before they needed to — the one number on this flag that has
        // to be right. Fall back to the gate year only if nothing gated landed.
        let firstT = null;
        state.instances.forEach(i => {
          if (admitGateFor(state, i) < 0) return;
          const t = assign.get(i.uid);
          if (t !== undefined && (firstT === null || t < firstT)) firstT = t;
        });
        const gateTerm = firstT !== null ? terms[firstT]
          : terms.find(tm => tm.isFW && tm.season === "F" && acadYearIdx(terms, tm.index) === g);
        const dept = (state.admitDept || {})[p.id];
        const what = dept ? `Its ${dept} professional sequence and upper-division courses`
                          : `Its junior core and upper-division courses`;
        flags.push({ level: "info", icon: "lock",
          text: `${p.name.replace(/\s*\(.*\)$/, "")} is a limited-enrollment (application) major. ${what} are held until admission, and this plan's first admitted coursework is ${gateTerm ? gateTerm.label : `year ${g + 1}`} — apply the cycle before that. Only pre-reqs and GE are scheduled until then; the plan assumes you're admitted, so have a backup.` });
      });
    }

    // MISM application gate
    if (profile.majorId === "is-bs-mism") {
      const jcw = state.blocks.get("jcw"), jcwT = jcw ? assign.get(jcw.uids[0]) : undefined;
      if (jcwT !== undefined) flags.push({ level: "info", icon: "flag-checkered", text: `MISM application is due during ${terms[jcwT].label} (Junior Core winter). The solver keeps all MISM prerequisites before this gate.` });
    }

    return { flags, courseFlags };
  }

  /* ----------------------- decision log (the "why") ------------------- */
  /* Post-hoc explanation of WHY each course sits where it does and WHY the
     plan has the shape it has, computed from the same state the passes used
     so it can never drift from the actual placement logic. Consumed by the
     course modal ("Why it's here"), and folded into the AI advisor's plan
     context so it can answer "why is X in semester N?" accurately. */
  function explain(state, expandRes, programs) {
    const { terms, assign, cat, profile, completed } = state;
    const courseWhy = new Map();          // uid -> [text]
    const planNotes = [];
    const add = (uid, text) => {
      if (!courseWhy.has(uid)) courseWhy.set(uid, []);
      courseWhy.get(uid).push(text);
    };
    const yearOf = t => acadYearIdx(terms, t) + 1;

    // strict dependents: X -> placed courses whose prereq group X ALONE
    // satisfies among the planned/completed options (if another planned
    // alternative could satisfy the group, we stay silent — never claim a
    // dependency that a different class might actually be covering)
    const placedIds = new Map();          // baseId -> earliest placed term
    assign.forEach((t, uid) => {
      const id = baseId(uid);
      const cur = placedIds.get(id);
      if (cur === undefined || t < cur) placedIds.set(id, t);
    });
    const depsOf = new Map();             // baseId -> Set of dependent display names
    assign.forEach((tY, uidY) => {
      const instY = state.byUid.get(uidY);
      if (instY.k > 1) return;            // prereqs bind the first instance only
      (instY.course.pre || []).forEach(group => {
        const opts = Array.isArray(group) ? group : [group];
        if (opts.some(g => completed.has(g))) return;      // satisfied by history
        const present = opts.filter(g => placedIds.has(g));
        if (present.length !== 1) return;                  // ambiguous satisfier
        const g = present[0];
        if (!depsOf.has(g)) depsOf.set(g, new Set());
        depsOf.get(g).add(instY.course.display || baseId(uidY));
      });
    });

    const depths = computeDepth(state.instances, cat);

    assign.forEach((t, uid) => {
      const inst = state.byUid.get(uid);
      const c = inst.course;
      const id = baseId(uid);
      const tm = terms[t];

      // ---- placement authority (who chose this term) -------------------
      if ((profile.pins || {})[id] !== undefined || (profile.pins || {})[uid] !== undefined) {
        add(uid, "Pinned here by you — the optimizer schedules everything else around it.");
      } else if (state.mapCodes && state.mapCodes.has(id) && state.pinnedUids.has(uid)) {
        add(uid, `Placed by the official MAP sheet — the advisement center's own plan puts ${c.display || id} in Year ${yearOf(t)} ${SEASON_NAME[tm.season]}.`);
      } else if (state.mapLabels && state.mapLabels.get(uid)) {
        add(uid, `This is the MAP sheet's "${state.mapLabels.get(uid)}" line, kept in its printed sheet term.`);
      } else if (state.woven && state.woven.has(uid)) {
        add(uid, "Woven into this term's spare room: it fell after the MAP sheet's last semester (minor/certificate/leftover work), and folding it forward here avoids adding a whole extra semester.");
      }

      // pulled purely as a prerequisite — not itself a printed requirement
      const bks = inst.buckets || [];
      if (bks.length && bks.every(b => /^(prereq|electives)::/.test(b)) && bks.some(b => b.startsWith("prereq::"))) {
        add(uid, "Not a printed requirement itself — added because other planned courses list it as a prerequisite.");
      }

      // ---- what it unlocks --------------------------------------------
      const dep = depsOf.get(id);
      if (dep && dep.size && inst.k === 1) {
        const names = [...dep];
        const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3} more` : "");
        add(uid, `Must come before ${shown} — it's the prerequisite that unlocks ${names.length > 1 ? "them" : "it"}.`);
      }

      // ---- season lock (only when it truly constrains F/W placement) ---
      const off = [...(c.off || "")];
      const fwOff = off.filter(s => s === "F" || s === "W");
      if (!c.placeholder && fwOff.length === 1) {
        add(uid, `Only taught ${SEASON_NAME[fwOff[0]]} semester${off.length > fwOff.length ? ` (plus ${off.filter(s => s !== fwOff[0]).map(s => SEASON_NAME[s]).join("/")})` : ""} — moving it means waiting a full year for the next offering.`);
      }

      // ---- admission gate / professional lock-step ---------------------
      const gate = admitGateFor(state, inst);
      const hm = state.hardMinYear && state.hardMinYear.get(id);
      if (gate >= 0) {
        const pid = (bks.find(b => (state.admitGate || {})[b.split("::")[0]] != null) || "").split("::")[0];
        const pname = pid && DATA.programIndex[pid]
          ? DATA.programIndex[pid].name.replace(/\s*\(.*\)$/, "") : "the program";
        add(uid, `Professional-phase course — held until assumed admission to ${pname} (limited enrollment; the professional phase starts Year ${gate + 1}, so apply during Year ${Math.max(1, gate)}).`);
      } else if (hm != null) {
        add(uid, `The department's own chart holds this professional-phase course at Year ${hm + 1} or later — cohort lock-step pacing.`);
      }

      // ---- deep prerequisite chains must start early -------------------
      // real courses only: a repeatable placeholder's instance-to-instance
      // sequencing (religion slots) inflates depth without being a real chain
      const d = Math.floor(depths.get(uid) || 0);
      if (d >= 4 && yearOf(t) <= 2 && !c.placeholder) {
        add(uid, `Heads a ${d}-course prerequisite chain — starting it any later pushes graduation out.`);
      }

      // ---- placeholder semantics --------------------------------------
      if (c.isReligion) {
        add(uid, "Religion is deliberately paced about one class per semester across the plan (BYU norm: 1 religion course per ~14 credits).");
      }
      if (/^ELECTIVE\+/.test(uid)) {
        add(uid, "Padding: keeps this semester at or above the 12-credit full-time floor. Swap in any real elective, minor course, or internship credit.");
      } else if (c.placeholder && !c.isReligion && !(state.mapLabels && state.mapLabels.get(uid))) {
        add(uid, "Flexible requirement slot — scheduled where the plan had room; any option in its dropdown satisfies it.");
      }
    });

    // ---- plan-level rationale ------------------------------------------
    const activeT = new Set(assign.values());
    const activeFW = terms.filter(tm => tm.isFW && tm.enabled && activeT.has(tm.index));
    const fwCr = activeFW.reduce((s, tm) => s + state.load[tm.index], 0);
    if (activeFW.length) {
      const ideal = Math.max(1, Math.round(fwCr / 15.5));
      let line = `${activeFW.length} Fall/Winter semesters carry ${Math.round(fwCr)} credits (avg ${(fwCr / activeFW.length).toFixed(1)}/term; policy band 14–16, 17 tolerated).`;
      line += activeFW.length > ideal
        ? ` Raw credit math would fit ~${ideal} — the extra term(s) are forced by prerequisite chains, single-season offerings, and MAP-sheet term caps, not unused space.`
        : " That is the tightest packing the credit total allows.";
      planNotes.push(line);
    }
    if (terms.yearOffset) {
      planNotes.push(`Mid-degree start: ${(profile.completed || []).length} completed courses (~${Math.round(terms.earnedCredits || 0)} credits) are counted as done. The plan starts at academic Year ${terms.yearOffset + 1} standing — remaining MAP-sheet semesters are pulled forward, and upper-division/standing rules treat the student as Year ${terms.yearOffset + 1}.`);
    }
    if (state.mapName) {
      planNotes.push(`Skeleton: the official ${state.mapName.replace(/\s*\(.*\)$/, "")} MAP sheet. Sheet-coded courses are locked to their printed semesters, each sheet term stops near its printed total, and everything else (GE, religion, minors, certificates) backfills the room the sheet left.`);
    }
    const wovenN = state.woven ? state.woven.size : 0;
    if (wovenN) {
      planNotes.push(`${wovenN} course${wovenN > 1 ? "s" : ""} beyond the sheet's own plan (minor/certificate/prerequisite work) were woven into spare capacity in earlier terms instead of adding semesters at the end.`);
    }
    programs.forEach(p => {
      const g = state.admitGate && state.admitGate[p.id];
      if (g != null) planNotes.push(`${p.name.replace(/\s*\(.*\)$/, "")} is limited-enrollment: upper-division work is scheduled only after the assumed admission (professional phase starts Year ${g + 1}; apply during Year ${Math.max(1, g)}).`);
    });
    planNotes.push("Hard rules enforced everywhere: prerequisites strictly earlier, catalog season offerings, ≤18 cr registration cap, ≥12 cr full-time floor, admission gates, cohort envelopes. Preferences (difficulty spread, religion pacing, compactness) are optimized but not guaranteed.");

    return { courseWhy, planNotes };
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
    // MAP-FIRST: when the selected major has a full-fidelity official MAP
    // sheet, the sheet IS the draft plan — its coded courses are locked to
    // their exact semesters and the optimizer only adapts around them
    // (completed courses vacate slots; minors/certs/GE backfill capacity).
    const mapProg = programs.find(p => p.id === profile.majorId && p.mapPlan);
    // a sheet that schedules Spring courses (Elem Ed practica, Nursing's
    // Spring clinical). The student's own setting is RESPECTED — we never
    // silently enable Spring. Courses that can also run F/W re-sequence
    // there; Spring-ONLY ones surface as unscheduled + a recommendation
    // with an explicit "add Spring term" action (the student opts in).
    const mapNeedsSpring = !!mapProg && mapProg.mapPlan.some(t =>
      t.s === "S" && (t.items || []).some(it => it.c));
    const terms = buildTerms(profile);
    // MID-DEGREE STANDING OFFSET — ~1 academic year per 30 earned credits.
    // acadYearIdx() adds this, so a junior's remaining MAP-sheet years pull
    // forward (sheet Y3 courses land in the FIRST plan year instead of
    // stranding at plan year 3 with hollow years before them) and standing
    // rules (senior minY, admission gates, level pacing) read correctly.
    {
      let earned = 0;
      (profile.completed || []).forEach(id => {
        const c = cat[id] || (typeof DATA !== "undefined" && DATA.courses[id]);
        earned += c ? (c.credits || 3) : 3;
      });
      terms.yearOffset = Math.min(3, Math.floor(earned / 30));
      terms.earnedCredits = earned;
    }
    const expandRes = expand(profile, programs, cat);
    const instances = buildInstances(expandRes.chosen, expandRes.completed, cat);
    const state = makeState(profile, terms, instances, cat, expandRes.completed);
    // see expand() Pass 3 — courses whose missing prerequisite the SHEET vouches
    // for, so prereqSatisfied() doesn't strand them
    state.sheetPreSat = expandRes.sheetPreSat || new Set();
    state.mapWantsSpring = mapNeedsSpring && !profile.settings.allowSpring;
    // STABILITY: previous uid -> termIndex from the plan being re-solved
    // (small edits keep everything else put; see seed + scorePlan)
    if (opts.prevAssign) state.prevAssign = new Map(Object.entries(opts.prevAssign));
    // ---- lab ↔ lecture pairing ---------------------------------------
    // A small "... Lab" course belongs in the SAME semester as its lecture
    // (EC EN 224 + 225 drifted a year apart). The catalog rarely encodes the
    // link, so pair conservatively: ≤1.5 cr, "Lab" in the name, same subject,
    // adjacent catalog number, and the partner is a real (≥2 cr) course in
    // this plan. Seeding places the lab beside its lecture; scorePlan
    // penalizes any split so the optimizer keeps them together.
    state.pairOf = new Map();
    {
      const bySubjNum = new Map();
      instances.forEach(i => {
        const m = baseId(i.uid).match(/^([A-Z][A-Z& ]*?)\s+(\d+)[A-Z]*$/);
        if (m && !i.course.placeholder) bySubjNum.set(`${m[1]}|${+m[2]}`, i);
      });
      instances.forEach(i => {
        const c = i.course;
        if (c.placeholder || c.credits > 1.5 || !/\blab\b/i.test(c.name || "")) return;
        const m = baseId(i.uid).match(/^([A-Z][A-Z& ]*?)\s+(\d+)[A-Z]*$/);
        if (!m) return;
        const mate = bySubjNum.get(`${m[1]}|${+m[2] - 1}`) || bySubjNum.get(`${m[1]}|${+m[2] + 1}`);
        if (mate && mate.uid !== i.uid && mate.course.credits >= 2) state.pairOf.set(i.uid, mate.uid);
      });
    }
    // HARD TERM BUDGET — the classic 8-10 semester shape. Plans target
    // max(8, credits/16) Fall/Winter semesters at a comfortable ~16-credit
    // pace, but rather than spill into an 11th semester, the budget clamps to
    // 10 and lets the optimizer run some terms to the 17-credit ceiling (one
    // 17-credit term beats a whole extra semester — scoring keeps 17s rare).
    // Only a plan that can't fit 10 terms even at the ceiling gets more.
    // Extended so the LAST term is a Winter (graduate in April).
    {
      let planCr = 0;
      instances.forEach(i => { planCr += i.course.credits; });
      const capFW = Math.min(BYU_HARD_CAP, profile.settings.maxCreditsFW || 17);
      const fwEnabled = terms.filter(tm => tm.isFW && tm.enabled);
      let n = Math.max(8, Math.ceil(planCr / 16));
      if (n > 10) n = Math.max(10, Math.ceil(planCr / capFW));
      while (n < fwEnabled.length && fwEnabled[n - 1] && fwEnabled[n - 1].season !== "W") n++;
      state.termBudget = fwEnabled[Math.min(n, fwEnabled.length) - 1].index;

      // ---- TARGET PACE ------------------------------------------------
      // A graduation target used to do exactly one thing: end the canvas.
      // Measured across 25 majors x 4 targets, that made the two directions
      // fail in opposite ways. A LATER target was a no-op — the plan still
      // packed into its natural 8 terms and left the extra semesters empty
      // (0.0 credit difference at 5- and 6-year targets). An EARLIER one was
      // a guillotine — 6 terms filled at the usual pace and 20-40 credits
      // dumped into "unscheduled" without the plan ever trying a heavier
      // semester.
      //
      // A date the student picks is not a deadline to truncate against; it
      // is a PACE. Credits still owed / semesters available gives the
      // credits-per-semester that date implies, and everything downstream
      // reads that one number:
      //
      //   stretch (pace < ~15)  -> a lower per-term ceiling. Terms settle just
      //                            above the full-time line, which is what the
      //                            student asked for: still full time, but with
      //                            room for a job, research, or a lighter load.
      //   compact (pace > ~15.5)-> a higher one, up to the profile's own credit
      //                            cap, so the solver packs harder before it
      //                            gives up and reports something unscheduled.
      //   on pace (~15.5)       -> paceCap lands on 16, the value the seeding
      //                            passes already used. Unchanged by design.
      //
      // What pace NEVER moves: prerequisites (canPlace is still the only gate),
      // the MAP sheet's order and seasons, and cohort blocks. Pace decides how
      // DENSE a semester is, never what may legally sit in it.
      //
      // The stretch is bounded by the full-time floor: you cannot pace 120
      // credits across 12 semesters and stay full time, so idealTerms clamps
      // to floor(credits / minCreditsFW) and the plan finishes EARLY of a
      // target that far out. analyze() says so rather than padding filler
      // across two invented semesters.
      const tgIdx = terms.targetIdx;
      if (tgIdx != null) {
        const fwAvail = fwEnabled.filter(tm => tm.index <= tgIdx).length;
        if (fwAvail > 0) {
          const pace = planCr / fwAvail;
          state.paceRaw = pace;
          // Two numbers, because one was not enough. paceFill is what the
          // fill passes aim AT; paceCap is what scoring penalizes ABOVE, and
          // it sits a credit higher on purpose. Classes come in 2- and
          // 3-credit lumps, so a ceiling equal to the mean demands every term
          // hit the mean exactly: Accounting paces to 12.0 across ten
          // semesters, filled all ten to precisely 12, and then had nowhere
          // to put two 2-credit religion electives — with 120 credits of room
          // and 124 credits of degree. One credit of slack absorbs the lumps.
          // Both bounds are the REAL lines, not the comfort policy: BYU's
          // full-time floor below, the student's own credit cap above. See
          // floorFW() — the 14-credit comfort target yields to a pace the
          // student asked for, and only to that.
          // FLOOR, not ceil. Rounding the mean up quietly costs a semester:
          // Accounting paces to 12.1 across ten, and a fill target of 13 packs
          // it into nine and finishes a term early of the date the student
          // typed. The +1 slack on paceCap is what absorbs the 2- and
          // 3-credit lumps, so the fill target itself should sit AT the mean.
          state.paceFill = Math.max(FULL_TIME_CREDITS, Math.min(capFW, Math.floor(pace)));
          state.paceCap = Math.min(capFW, state.paceFill + 1);
          state.stretch = pace < 14.5;
          state.rush = pace > 15.5;      // target is tighter than the house pace
          state.idealTerms = Math.max(1, Math.min(fwAvail, Math.floor(planCr / FULL_TIME_CREDITS)));
          // the target owns the canvas in BOTH directions: a stretch needs the
          // later terms unlocked, a compaction needs the budget pulled in.
          state.termBudget = tgIdx;
        }
      }
    }
    // flowchart placement hints: courseId -> {y (1-based year), s (F/W)}. The
    // official department flowchart, where we have one, overrides the generic
    // level-pacing heuristic for those courses.
    state.fcHint = {};
    programs.forEach(p => {
      if (!p.flowchartPlan) return;
      for (const code in p.flowchartPlan) {
        if (state.fcHint[code]) continue;
        let h = p.flowchartPlan[code];
        // Guard against MAP-grid mis-reads that hint a foundational 100-level
        // course (Calculus 1, intro stats/physics, ECON 110) to junior/senior
        // year: it has few/no prerequisites and belongs early. Trust level
        // pacing for the YEAR (keep the season); any real prereq still gates it.
        if (h.y >= 3 && cat[code] && courseLevel(cat[code]) <= 1) h = { ...h, y: 1 };
        state.fcHint[code] = h;
      }
    });
    // admission gate per limited-enrollment program: earliest professional
    // year (0-based gate) from junior-core cohorts AND scraper-derived
    // admission data (MAP "apply" anchors, curated programs like Nursing).
    state.admitGate = {};
    state.admitY = {};     // 1-based year the professional sequence begins
    state.admitDept = {};  // professional course prefix ("NURS", "EL ED")
    programs.forEach(p => {
      const yrs = [];
      (p.flowchartCohorts || []).forEach(c => { if (c.y) yrs.push(c.y); });
      (p.buckets || []).forEach(b => { if (b.block && b.block.fcYear) yrs.push(b.block.fcYear); });
      if (p.admit && p.admit.y) {
        yrs.push(p.admit.y);
        if (p.admit.dept) state.admitDept[p.id] = p.admit.dept;
      }
      if (yrs.length) {
        state.admitY[p.id] = Math.min(...yrs);
        state.admitGate[p.id] = state.admitY[p.id] - 1;
      }
    });
    // limited-enrollment lock-step floor: a charted PROFESSIONAL course
    // (at/after the admission year) can never be pulled EARLIER than its
    // charted year — student teaching stays senior year, the NURS clinical
    // ladder keeps its MAP pacing, even when an earlier term has room.
    state.hardMinYear = new Map();
    programs.forEach(p => {
      const gy = state.admitGate[p.id];
      if (gy == null || !p.flowchartPlan) return;
      const admitY = state.admitY[p.id] || (gy + 1);
      for (const code in p.flowchartPlan) {
        const h = state.fcHint[code];
        if (h && h.y >= admitY) {
          const cur = state.hardMinYear.get(code);
          state.hardMinYear.set(code, Math.max(cur ?? 0, h.y - 1));
        }
      }
    });
    // true-freshman first-term pacing cap (MAPs start new students ~13-15 cr)
    state.firstTermCap = (profile.completed || []).length ? null
      : Math.min(terms[0].cap, profile.settings.firstTermCap ?? 15);

    // ---- MAP-FIRST SKELETON -------------------------------------------
    // Lock every coded MAP-sheet course to its exact sheet semester and cap
    // each sheet term at its declared Total Hours, so backfill (GE/religion
    // slots, minors, certs) lands in the capacity the sheet actually left.
    // The sheet is authoritative: placement bypasses season/prereq checks
    // (violations surface as warnings, never re-sequencing).
    state.mapCap = new Map();
    state.mapLabels = new Map();      // uid -> sheet slot label (board cards)
    const bindOf = new Map();         // mapPlan row index -> plan term index
    if (mapProg) {
      state.mapName = mapProg.name;
      // sheet-coded courses OWN their placement — they leave any flowchart
      // cohort envelope (the sheet's term grouping IS the envelope now; the
      // 2025-26 IS sheet moved IS 401 to the winter core while the older
      // flowchart still showed it in fall — the sheet wins)
      state.mapCodes = new Set();
      mapProg.mapPlan.forEach(mt => (mt.items || []).forEach(it => {
        if (it.c) state.mapCodes.add(it.c);
      }));
      // ---- SHEET BINDING ------------------------------------------------
      // Walk the sheet IN ORDER and give every row the earliest plan term it
      // can legally occupy. Two rules do all the work:
      //   * a row whose coded courses are ALL earned consumes NO plan term —
      //     finished work is the only thing that legitimately shortens a plan;
      //   * a row is only pulled back to where its courses can actually run:
      //     it keeps the sheet's season, and any prerequisite the sheet itself
      //     schedules EARLIER must already be bound to an earlier term.
      // Because the cursor never moves backwards, the sheet's own sequence
      // survives by construction: no row can overtake one it used to follow.
      //
      // This replaced an offset derived from earned credits (~1 year per 30).
      // Standing is the wrong ruler for indexing into a sheet — 30 credits of
      // AP/transfer GE makes a student a sophomore without touching the
      // sheet's Y1 major sequence — and shifting by it bound Y2/Y3 rows to the
      // first plan terms while the still-owed Y1 rows resolved to t < 0 and
      // dropped out of the skeleton entirely, to be re-seeded wherever they
      // fit. That is how MATH 303 landed a year before MATH 302, how PHSCS 318
      // was scheduled alongside the PHSCS 123 it requires, and how the IS
      // junior core got split across three years.
      const firstRow = new Map();     // code -> first sheet row it appears on
      mapProg.mapPlan.forEach((mt, si) => (mt.items || []).forEach(it => {
        if (it.c && !firstRow.has(it.c)) firstRow.set(it.c, si);
      }));
      const boundAt = new Map();      // code -> plan term it is bound to
      {
        let cursor = 0;
        mapProg.mapPlan.forEach((mt, si) => {
          const coded = (mt.items || []).filter(it => it.c).map(it => it.c);
          const owed = coded.filter(c => !expandRes.completed.has(c));
          // A row whose coded courses are ALL earned costs no semester — that
          // is the whole of legitimate compression. Its GE/religion slots do
          // not hold the row open; backfill re-places them in the compressed
          // plan wherever capacity allows.
          if (coded.length && !owed.length) return;
          // A row keeps the sheet's own SEASON. That is what makes compression
          // land on whole academic years: skipping both halves of a finished
          // year moves the next Fall row a year earlier, while skipping a
          // single term can't silently flip a Fall course into Winter.
          // The season comes from the sheet, never from catalog `off` data —
          // the sheet is authoritative, and enforcing `off` here re-sequenced
          // rows wholesale wherever the scraped offering string disagreed.
          const fits = t => {
            const term = terms[t];
            if (!term || !term.enabled || term.season !== mt.s) return false;
            return owed.every(c => {
              const cs = cat[c];
              if (!cs) return true;
              return (cs.pre || []).every(group => {
                const opts = Array.isArray(group) ? group : [group];
                if (!opts.length) return true;
                if (opts.some(g => expandRes.completed.has(g))) return true;
                // Only a prerequisite the SHEET puts earlier can gate the row.
                // One that is absent from the sheet is assumed satisfied
                // outside it (AP / transfer / placement — ChemE's CHEM 111 vs
                // MATH 110), and one the sheet puts later or alongside is the
                // sheet's own call. The sheet stays authoritative either way.
                const gating = opts.filter(g => firstRow.has(g) && firstRow.get(g) < si);
                if (!gating.length) return true;
                return gating.some(g => boundAt.has(g) && boundAt.get(g) < t);
              });
            });
          };
          let t = cursor;
          while (t < terms.length && !fits(t)) t++;
          if (t >= terms.length) return;   // sheet year beyond horizon / Sp disabled
          bindOf.set(si, t);
          owed.forEach(c => { if (!boundAt.has(c)) boundAt.set(c, t); });
          cursor = t + 1;
        });
      }
      // ---- the printed Total Hours is the sheet's own ceiling -------------
      // A MAP row carries both a list of items and a printed total, and 37 of
      // the 1,306 rows across the 161 sheets list items summing ABOVE that
      // total — four of them by 10+ credits. Elementary Education's year-2
      // Fall row carries a 12-credit "Education EL ED 400R or 496R" line that
      // also appears, correctly, in the year-4 Fall row: student teaching,
      // duplicated two years early. Pinning the whole row put 25 credits in a
      // term the sheet prints at 15, seven credits above BYU's registration
      // cap, and nothing downstream could undo it — sheet placement calls
      // place() directly, bypassing canPlace, and enforceMapCaps skips
      // anything in pinnedUids.
      //
      // So the two numbers disagree and one of them has to win. The printed
      // total wins: it is the figure the advisement center publishes, a
      // student reads, and mapCap already enforces on everything else. Items
      // that do not fit are simply NOT PINNED — they stay ordinary instances
      // and the optimizer places them under the normal rules, which is how
      // Elementary Education's student teaching finds its way back to the
      // year-4 term the sheet itself puts it in.
      //
      // BUT the printed total only wins when it could plausibly describe the
      // term it labels, because the corruption runs both ways. Dietetics'
      // year-2 Winter prints 6.0 against six perfectly ordinary items
      // (Civilization 1, NDFS 250, NDFS 251, CELL 305, religion, a
      // physical-science GE) summing to a normal 16 — there the TOTAL is the
      // mis-read number. A Fall/Winter row printed below the full-time line is
      // not a light semester; it is a bad scrape, and enforcing it as a ceiling
      // stranded CELL 305 with nowhere to go. Only 3 of the 37 overflowing
      // rows are that shape; in the other 34 the total sits in the normal
      // 13-16 band and the items are the corrupt half.
      //
      // The 0.5 tolerance absorbs sheet rounding, not a duplicated line.
      // Only rows that CONTRADICT THEMSELVES are constrained. A well-formed row
      // is left exactly as it was: slot filling routinely lands a 3-credit
      // course in a 2-credit slot (takeSlot allows budget + 0.6), and clamping
      // that would re-shape 1,269 sheets that were never broken to fix 37 that
      // were. An earlier cut applied the ceiling everywhere and pushed
      // Classical Studies: Classics from 10 semesters to 11.
      const rowOverflows = new Map();     // plan term -> row exceeds its own total
      mapProg.mapPlan.forEach((mt, si) => {
        const t = bindOf.get(si);
        if (t == null || mt.total == null) return;
        const items = (mt.items || []).reduce((s, it) => s + (+it.cr || 0), 0);
        if (items > mt.total + 0.6) rowOverflows.set(t, true);
      });
      const sheetPinned = new Map();      // plan term -> credits pinned so far
      const sheetCeil = t => {
        if (!rowOverflows.get(t)) return null;                  // row agrees with itself
        const total = state.mapCap.get(t);
        if (total == null) return null;                         // row prints no total
        const tm = state.terms[t];
        if (tm && tm.isFW && total < FULL_TIME_CREDITS) return null;   // total is the bad number
        return total;
      };
      // ---- pace thins the sheet's SLOTS, never its coded courses ---------
      // A MAP row prints ~15-16 credits. Stretching a MAP-bound plan to a
      // 12-13 credit pace therefore means ~25 credits have to leave the sheet
      // terms, and there is no way around that: the sheet's own density IS
      // what the student is asking to change.
      //
      // Which credits leave is the whole question. The coded courses are the
      // sequence — MATH 113 before 302, the junior core as a block, the season
      // the row prints — and pace must not touch them. The labeled slots are
      // generals, religion and elective lines, which is exactly what an
      // advisor moves when a student says "I want a lighter semester."
      //
      // The coded loop below runs FIRST and claims the term's pace budget; the
      // slot pass (takeSlot, further down) runs with paceActive on and stops
      // when the term is at pace, leaving those slots to ordinary backfill in
      // a later term. So the sheet keeps its order and seasons, and the pace
      // is paid for out of the generals.
      let paceActive = false;
      const paceCeil = t => (paceActive && state.paceFill != null
        && state.terms[t] && state.terms[t].isFW) ? state.paceFill : null;
      const sheetRoom = (t, cr) => {
        const pc = paceCeil(t);
        if (pc != null && state.load[t] + cr > pc + 0.5) return false;
        const ceil = sheetCeil(t);
        if (ceil == null) return true;    // nothing trustworthy to enforce
        return (sheetPinned.get(t) || 0) + cr <= ceil + 0.5;
      };
      const notePinned = (t, cr) => sheetPinned.set(t, (sheetPinned.get(t) || 0) + cr);
      const occ = new Map();          // code -> occurrence # seen so far
      mapProg.mapPlan.forEach((mt, si) => {
        const t = bindOf.get(si);
        if (t == null) return;
        if (mt.total != null) state.mapCap.set(t, mt.total);
        (mt.items || []).forEach(it => {
          if (!it.c) return;
          const k = (occ.get(it.c) || 0) + 1;
          occ.set(it.c, k);
          if (expandRes.completed.has(it.c)) return;   // already earned
          const inst = state.byUid.get(it.c) || state.byUid.get(`${it.c}#${k}`);
          if (!inst || state.assign.has(inst.uid)) return;
          // student pin (profile.pins) outranks the sheet for that course
          if ((profile.pins || {})[baseId(inst.uid)]) return;
          if (!sheetRoom(t, inst.course.credits)) return;   // row overflows its own total
          // the sheet's own term is authoritative for this course's season —
          // see widenSeason()
          widenSeason(state, baseId(inst.uid), state.terms[t] && state.terms[t].season);
          place(state, inst, t);
          state.pinnedUids.add(inst.uid);
          notePinned(t, inst.course.credits);
        });
      });
      // ---- labeled sheet slots -> catalog-bucket placeholders -----------
      // Each non-coded sheet line binds to the REAL catalog requirement it
      // stands for and is placed in its sheet term with the sheet's label, so
      // the board reads like the printed MAP AND the "choose ▾" dropdown shows
      // that requirement's actual option pool. Matching: GE label -> the GE
      // category bucket; religion -> the cornerstone/elective buckets; a major
      // slot -> its requirement bucket by "(req N)" or keyword; an "A or B"
      // choice -> the "Complete 1 of N" bucket holding those courses.
      const GE_MAP = [
        // First-Year Writing (WRTG 150) is its OWN requirement, NOT a GE
        // distribution category — must be listed FIRST so "First Year Writing
        // Elective" binds fyw and never falls through to the generic catch-all
        // that grabbed American Heritage. ("adv writ/oral comm/written" below is
        // the SEPARATE Advanced Written & Oral requirement — different course.)
        [/first[\s-]?year\s+writing|\bfyw\b/i, "fyw"],
        [/american heritage/i, "ge-american-heritage"],
        [/global|cultural/i, "ge-global-cultural-awareness"],
        [/languages of learning/i, "ge-languages-of-learning"],
        [/quantitative/i, "ge-quantitative-reasoning"],
        [/biological/i, "ge-biological-science"],
        [/physical science/i, "ge-physical-science"],
        [/social science/i, "ge-social-science"],
        [/civ\w*\s*2|civilization 2/i, "ge-civilization-2"],
        [/civ\w*\s*1|civilization 1/i, "ge-civilization-1"],
        [/\barts?\b/i, "ge-arts"],
        [/letters/i, "ge-letters"],
        [/adv\w*\s*writ|oral comm|written/i, "ge-advanced-written-oral-communication"],
      ];
      const stop = new Set(["complete","course","courses","elective","electives","hours","hour",
        "credit","credits","approved","from","the","and","for","with","other","only","see","dept",
        "requirement","option","options","advanced","department","general","education","supporting",
        "professional","obtain","confirmation","your","advisement","center","work"]);
      // keep tokens >=3 chars (so "lab","eng","emsb","epsel" survive) minus stopwords
      const kw = s => new Set((s || "").toLowerCase().replace(/[^a-z ]/g, " ")
        .split(/\s+/).filter(w => w.length >= 3 && !stop.has(w)));
      // Explicit course codes in a slot label are the STRONGEST signal of which
      // requirement the sheet means — stronger than any keyword. "Applied
      // Neuroscience (NEURO 399R, 449R, 481)" lists Req 7's exact options (the
      // keyword "neuroscience" matches every bucket of the program and used to
      // tie-break to the big Req 9 elective pool); "NEURO 316, WRTG 315 or 316"
      // is this major's Advanced Written & Oral Communication line. A bare
      // number inherits the previous department ("WRTG 315 or 316").
      const labelCodes = (label) => {
        const toks = (label || "").replace(/[(),;:/]/g, " ").split(/\s+/);
        const found = [];
        let dept = "";
        for (let i = 0; i < toks.length; i++) {
          if (!/^\d{3}[A-Z]{0,2}$/.test(toks[i])) continue;
          const p1 = toks[i - 1], p2 = toks[i - 2];
          const two = p2 && p1 && /^[A-Z&]{1,5}$/.test(p2) && /^[A-Z&]{1,5}$/.test(p1) ? `${p2} ${p1}` : null;
          const one = p1 && /^[A-Z&]{2,6}$/.test(p1) ? p1 : null;
          for (const d of [two, one, dept]) {
            if (d && cat[`${d} ${toks[i]}`]) { found.push(`${d} ${toks[i]}`); dept = d; break; }
          }
        }
        return [...new Set(found)];
      };
      const ucProg = programs.find(p => p.id === "univ-core");
      const bucketByCodes = (label) => {
        const codes = labelCodes(label);
        if (!codes.length) return null;
        let bestKey = null, bestFrac = 0, bestPool = Infinity;
        const scan = (progId, b) => {
          if (!b.options || !b.options.length || (b.pick && b.pick.type === "all")) return;
          const set = new Set(b.options);
          const hit = codes.filter(c => set.has(c)).length;
          if (!hit) return;
          const frac = hit / codes.length;
          // most codes covered wins; tie -> SMALLER pool (the specific req,
          // not the giant elective list that happens to share one course)
          if (frac > bestFrac || (frac === bestFrac && b.options.length < bestPool)) {
            bestFrac = frac; bestPool = b.options.length; bestKey = `${progId}::${b.id}`;
          }
        };
        (mapProg.buckets || []).forEach(b => scan(mapProg.id, b));
        if (ucProg) ucProg.buckets.forEach(b => scan("univ-core", b));
        return bestFrac >= 0.5 ? bestKey : null;   // majority of the codes must be in the pool
      };
      const bucketByKeyword = (label, cr) => {   // best major bucket for a slot
        const lw = kw(label);
        const rn = (label.match(/req(?:uirement)?\s*\.?\s*(\d+(?:\.\d+)?)/i) || [])[1];
        let best = null, bestScore = 0;
        (mapProg.buckets || []).forEach(b => {
          if (b.pick && b.pick.type === "all") return;   // fixed requirements aren't "electives"
          let score = 0;
          if (rn && (b.id.endsWith("-" + rn.replace(".", "-")) || b.id.endsWith("-" + rn))) score += 100;
          // match against the bucket's name, note, AND its option course names
          // (so "CHEM Lab elective" finds the bucket whose options are the
          // Organic/Physical Chemistry LAB courses even with no note)
          const optNames = (b.options || []).slice(0, 30)
            .map(o => `${o} ${(cat[o] && cat[o].name) || ""}`).join(" ");
          const bw = kw(`${b.name} ${b.note || ""} ${optNames}`);
          lw.forEach(w => { if (bw.has(w)) score += 3; });
          // Tie-break by LARGEST credit pool, not exact credit match: "Engineering
          // elective" (3 cr) ties every ChemE sub-req (all mention "engineering"),
          // and belongs to the 12-cr ENG pool — not the 2-cr chem-lab bucket.
          const bn = (b.pick && b.pick.n) || 0, cn = (best && best.pick && best.pick.n) || 0;
          if (score > bestScore || (score === bestScore && score > 0 && bn > cn)) {
            bestScore = score; best = b;
          }
        });
        return bestScore >= 3 ? `${mapProg.id}::${best.id}` : null;
      };
      const slotKeys = it => {                    // candidate bucketKeys, best first
        if (it.alts) {                            // "A or B" -> the choice bucket
          const set = new Set([it.c, ...it.alts]);
          const hit = (mapProg.buckets || []).find(b =>
            (b.options || []).some(o => set.has(o)) && b.pick && b.pick.type !== "all");
          return hit ? [`${mapProg.id}::${hit.id}`] : [];
        }
        if (it.slot === "rel-corner") return ["univ-core::rel-corner"];
        if (it.slot === "rel-elective") return ["univ-core::rel-elective"];
        if (it.slot === "ge") {
          const ids = GE_MAP.filter(([rx]) => rx.test(it.label || "")).map(([, id]) => id);
          if (ids.length) return ids.map(id => `univ-core::${id}`);
          // a GE line naming explicit courses ("First Year Writing or A HTG
          // 100") binds the bucket that holds those courses
          const ck = bucketByCodes(it.label);
          if (ck) return [ck];
          // truly generic "General Education courses N.0" -> any category;
          // an unrecognized SPECIFIC label (First-Year Writing, handled as the
          // WRTG 150 requirement) must NOT grab a random category and mislabel it
          if (/general education|^\s*ge\b|elective/i.test(it.label || ""))
            return GE_MAP.map(([, id]) => `univ-core::${id}`);
          return [];
        }
        if (it.slot === "elective") return ["__elective__"];
        // "major" slot: explicit course codes in the label outrank keywords
        // (they may even point OUTSIDE the major — NEURO 316/WRTG 315/316 is
        // the Advanced Written & Oral Communication GE requirement)
        const ck = bucketByCodes(it.label);
        if (ck) return [ck];
        const mk = bucketByKeyword(it.label, it.cr);   // "major"
        return mk ? [mk] : [];
      };
      const takeSlot = (keys, t, budget, label) => {
        let guard = 0;
        // A sheet slot says "a GE course here" / "a major elective here", not
        // WHICH one — so the class we drop in must actually be taught that
        // semester. Without this a Summer-only class (HLTH 481) or a
        // Winter-only one (NORWE 340) got slotted into the wrong season and
        // the plan shipped a class the student cannot register for. Sheet
        // authority covers courses the sheet NAMES, not our choice of filler.
        const taughtNow = i => (i.course.off || "FW").includes(state.terms[t].season);
        // ONE ENROLLMENT PER SEMESTER. A slot's credit budget used to be spent
        // by taking instance after instance of the SAME repeatable course:
        // IAS 399R is 0.5 cr against a 3 cr "internship" line, so all six of
        // American Studies' enrollments landed in Winter 2029, and Portuguese
        // Studies stacked PORT 493 ten deep. The student cannot register for
        // the same class six times in one semester.
        // The exemption mirrors prereqSatisfied() exactly: two DIFFERENT
        // electives drawn from one bucket may share a term, but a real
        // repeatable course may not, and neither may religion slots (BYU
        // pacing keeps those to one per semester).
        const oneEnrollmentPerTerm = i => !i.course.bucket || i.course.isReligion;
        const baseAlreadyInTerm = i => {
          if (!oneEnrollmentPerTerm(i)) return false;
          const b = baseId(i.uid);
          for (const [uid, tt] of state.assign) {
            if (tt === t && baseId(uid) === b) return true;
          }
          return false;
        };
        // DEPENDENCY-SAFE slot filling. A slot binding is a PIN, and a GE pool
        // can contain concrete courses that carry prerequisite chains — adding
        // MATH 112/113 to Languages of Learning made a Statistics sheet's late
        // GE slot grab the MATH 112 instance (in the plan as Calc 2's prereq)
        // and pin it into Winter 2030, AFTER the three courses that need it.
        // A candidate must be legal where the slot sits: its own prereqs
        // satisfiable at t, and no dependent of it already scheduled at/before
        // t. Placeholder cards pass both trivially, so a generic slot always
        // has a safe fallback.
        const depSafe = i => prereqSatisfied(state, i, t) && t < depLimitOf(state, i.uid);
        while (budget > 0.4 && guard++ < 6) {
          let cand = null;
          for (const key of keys) {
            if (key === "__elective__") {
              cand = state.instances.find(i => !state.assign.has(i.uid) && i.course.elective &&
                taughtNow(i) && !baseAlreadyInTerm(i) && depSafe(i));
            } else {
              cand = state.instances.find(i => !state.assign.has(i.uid) && taughtNow(i) &&
                (i.buckets || []).includes(key) && i.course.credits <= budget + 0.6 &&
                !baseAlreadyInTerm(i) && depSafe(i));
            }
            if (cand) break;
          }
          if (!cand || cand.course.credits > budget + 0.6) break;
          // the row's printed Total Hours caps the whole row, slots included —
          // see sheetRoom(). Elementary Education's duplicated 12-credit
          // student-teaching line arrives here, not in the coded loop.
          if (!sheetRoom(t, cand.course.credits)) break;
          place(state, cand, t);
          state.pinnedUids.add(cand.uid);
          if (label) state.mapLabels.set(cand.uid, label);
          notePinned(t, cand.course.credits);
          budget -= cand.course.credits;
        }
      };
      // Two passes so a SPECIFIC category ("American Heritage") is never
      // consumed by a GENERIC line ("General Education courses") in an earlier
      // term: bind single-target slots first, multi-target/elective last.
      const jobs = [];
      mapProg.mapPlan.forEach((mt, si) => {
        const t = bindOf.get(si);
        if (t == null) return;
        (mt.items || []).forEach(it => {
          if (!it.slot && !it.alts) return;       // coded singles handled above
          // A slot whose label IS a course code is the sheet scheduling that
          // exact course — the scraper just couldn't read the cell as a coded
          // item. Bind it directly, exactly like the coded loop above. Routing
          // it through the bucket search instead put STAT 121 in the cell
          // Accounting's sheet marks "ACC 200": bucketByCodes skips pick-all
          // buckets, so the only bucket containing ACC 200 was univ-core's
          // Quantitative Reasoning pool (BYU lists it there, restricted-use),
          // and takeSlot handed that bucket its first fitting instance. The
          // real ACC 200 then floated to Fall 2027 — a year AFTER the pinned
          // ACC 310 that requires it, which is what the tester reported.
          if (it.slot && !it.alts) {
            const codes = labelCodes(it.label || "");
            if (codes.length === 1 && !expandRes.completed.has(codes[0])
                && !(profile.pins || {})[codes[0]]) {
              let bound = false;
              for (let k = 0; k <= 3 && !bound; k++) {
                const inst = state.byUid.get(k === 0 ? codes[0] : `${codes[0]}#${k}`);
                if (!inst || state.assign.has(inst.uid)) continue;
                if (!sheetRoom(t, inst.course.credits)) break;
                widenSeason(state, codes[0], state.terms[t] && state.terms[t].season);
                place(state, inst, t);
                state.pinnedUids.add(inst.uid);
                notePinned(t, inst.course.credits);
                bound = true;
              }
              if (bound) return;                  // no job — the cell is filled
            }
          }
          const keys = slotKeys(it);
          if (keys.length) jobs.push({ keys, t, cr: it.cr || 3,
            label: it.label || (it.c ? `${it.c} or …` : null), specific: keys.length === 1 && keys[0] !== "__elective__" });
        });
      });
      jobs.sort((a, b) => (b.specific ? 1 : 0) - (a.specific ? 1 : 0));
      paceActive = true;              // see sheetRoom(): slots yield to the pace
      jobs.forEach(j => takeSlot(j.keys, j.t, j.cr, j.label));
      paceActive = false;
      // REPEAT ORDER — the sort above fills specific slots before generic ones,
      // so slots are NOT filled in term order and instance #2 of a repeatable
      // could be bound to an earlier term than #1 (PORT 493 came out #2 in
      // term 5, #1 in term 9). prereqSatisfied() enforces #k strictly after
      // #k-1, so leaving them crossed makes this skeleton contradict the
      // optimizer that runs next. Instances of one course are interchangeable,
      // so the repair is to hand the same set of terms back out in ascending
      // order of instance number — no course moves semester, they just stop
      // being numbered backwards.
      {
        const byBase = new Map();
        state.assign.forEach((t, uid) => {
          const inst = state.byUid.get(uid);
          if (!inst || inst.k == null) return;
          if (inst.course.bucket && !inst.course.isReligion) return;  // see takeSlot
          if (state.blockOf.has(uid)) return;      // cohort blocks move as a unit
          const b = baseId(uid);
          if (!byBase.has(b)) byBase.set(b, []);
          byBase.get(b).push(inst);
        });
        byBase.forEach(insts => {
          if (insts.length < 2) return;
          const terms = insts.map(i => state.assign.get(i.uid)).sort((a, b) => a - b);
          const ordered = insts.slice().sort((a, b) => a.k - b.k);
          if (ordered.every((i, idx) => state.assign.get(i.uid) === terms[idx])) return;
          ordered.forEach(i => unplace(state, i));
          ordered.forEach((i, idx) => place(state, i, terms[idx]));
        });
      }
      // first-term cap yields to the sheet (a 17-credit MAP freshman fall
      // is the advisement center's own pacing)
      if (state.mapCap.has(0)) state.firstTermCap = null;
    }
    // sequence groups for the "lower number first" rule: same dept + same
    // hundreds level (CHEM 105 before CHEM 106, MATH 302 before 303, ...)
    state.seqGroups = (() => {
      const g = new Map();
      const seen = new Set();
      instances.forEach(i => {
        const id = baseId(i.uid);
        if (seen.has(id) || i.course.placeholder || i.course.elective) return;
        seen.add(id);
        const m = id.match(/^([A-Z][A-Z &]*?)\s*(\d)(\d{2})[A-Z]?$/);
        if (!m) return;
        const key = `${m[1]}:${m[2]}`;
        if (!g.has(key)) g.set(key, []);
        g.get(key).push({ id, num: +(m[2] + m[3]) });
      });
      return [...g.values()].filter(a => a.length >= 2)
        .map(a => a.sort((x, y) => x.num - y.num));
    })();

    let { problems } = seed(state, programs);   // `unscheduled` is recomputed after
    fixPinnedPrereqOrder(state);               // sheet pins bypass canPlace — repair order early
                                                // rescueUnscheduled() — see below

    // GE RIGHT-SIZING — trust the sheet's OWN General Education, not the
    // universal 12-category University Core. A MAP sheet that ENUMERATES GE (no
    // generic "General Education courses" catch-all) is authoritative on that
    // major's GE: engineering degrees carry a reduced Civ/Arts/Letters
    // distribution — "Civ 2 / Arts" is ONE course (the student picks), and a
    // separate Civ 1 / Languages-of-Learning simply isn't required — whereas a
    // humanities sheet lists Civ 1 AND Civ 2 AND Arts AND Letters as four
    // courses. The universal model over-provisions the reduced-GE majors by
    // ~12 cr, spilling them into extra terms. So for an enumerated-GE sheet the
    // BOUND GE slots ARE the requirement: drop the GE placeholders the sheet
    // never slots. Generic-catch-all sheets keep the full model (the catch-all
    // stands in for those categories). Religion is never touched.
    const mapMajorGE = programs.find(p => p.id === profile.majorId && p.mapPlan);
    if (mapMajorGE) {
      // the sheet's OWN credit budget (sum of its printed term totals)
      let budget = 0; state.mapCap.forEach(v => budget += v);
      // a GENERIC / distribution GE slot ("General Education courses", "Arts,
      // Letters, and Sciences elective", "University Core elective") stands in
      // for the universal categories — those sheets keep the full 12-category
      // model. Only sheets that enumerate SPECIFIC categories (American
      // Heritage, "Civ 2/Arts") are trusted to have the reduced set.
      const genericGE = mapMajorGE.mapPlan.some(mt => (mt.items || []).some(it =>
        it.slot === "ge" && /general education|university core|\bge\s+elective/i.test(it.label || "")));
      // budget >= 100 skips secondary/double majors whose sheet is only the
      // ~37-cr major slice and never carried University Core to begin with
      if (!genericGE && budget >= 100) {
        const droppable = state.instances.filter(i => i.course.bucket && !i.course.isReligion &&
          (i.buckets || []).some(b => /^univ-core::ge-/.test(b)) && !state.mapLabels.has(i.uid));
        const planned = () => state.instances.reduce((s, i) => s + (i.course.credits || 0), 0);
        for (const i of droppable) {
          if (planned() <= budget + 1) break;            // NEVER trim below the sheet's degree size
          if (state.assign.has(i.uid)) unplace(state, i);
          state.byUid.delete(i.uid);
          expandRes.chosen.delete(baseId(i.uid));         // so the progress report doesn't flag a gap
          state.instances = state.instances.filter(x => x.uid !== i.uid);
        }
      }
    }

    const seedNum = (hashStr(JSON.stringify({
      m: profile.majorId, mi: profile.minorIds, c: profile.certIds, w: profile.weights,
    })) ^ (opts.shuffleSeed || 0)) >>> 0;
    // greedy improve() is far more effective per iteration than the old random
    // single-pick, so the counts are lower than they look
    improve(state, opts.iterations ?? 1200, seedNum);
    compact(state);                            // pack into the fewest terms
    consolidate(state);                        // empty straggler light terms
    closeGaps(state);                          // collapse any interior skipped semester
    expandTail(state);                         // open a light final term if the tail is crammed
    improve(state, 350, seedNum ^ 0x9e3779b9); // settle after the compound moves
    compact(state);                            // re-pack after settling
    consolidate(state);                        // second sweep once the tail is clean
    closeGaps(state);
    fillLight(state);                          // rebalance heavy → starved terms
    improve(state, 350, seedNum ^ 0x51ed2701);
    compact(state); closeGaps(state);
    fillLight(state);
    enforceFloor(state);                       // hard guarantee: every F/W ≥ 12
    // fill/floor/compact passes run AFTER the optimizer and can strand a hinted
    // course (e.g. a 0.5-cr seminar) in a late term. The optimizer MUST get the
    // last word: run compaction/floor, THEN a final corrective improve() to pull
    // any stranded hinted course home, THEN a light idempotent floor top-up that
    // only relocates low-value courses (so it can't re-strand).
    improve(state, 400, seedNum ^ 0x2545f491);
    compact(state); closeGaps(state);
    enforceFloor(state);
    // the optimizer gets the LAST word: a final improve() empties any surplus
    // term and pulls stranded hinted courses home, then a low-value-only floor
    // top-up guarantees ≥12 WITHOUT re-stranding or re-inflating the term count
    improve(state, 450, seedNum ^ 0x2545f491);
    // strip floor padding BEFORE the last compact so compact()'s term-count
    // target (round(totalFW/15.5)) reflects REAL content, not filler that
    // self-justifies extra terms; compact/closeGaps then collapse the freed
    // terms, and the final topUpFloor re-guarantees the ≥12 floor.
    stripFloorPadding(state);
    compact(state); closeGaps(state);
    enforceMapCaps(state);                     // sheet terms end at their printed totals
    // weave BEFORE the floor top-up: padding the receiving terms to ≥12 first
    // eats exactly the headroom the tail needs to fold forward (the EE+CS
    // combo kept a 12-cr tail of three GE slots + C S 236 for that reason).
    // The single topUpFloor afterwards guarantees ≥12 everywhere that's left.
    weaveTail(state);                          // fold leftover tail terms into sheet headroom
    closeGaps(state);                          // a dissolved tail can leave an interior hole
    rescueUnscheduled(state);                  // retry courses seed() had to give up on
    spreadMajorWork(state);                    // trade late major work for early GE slots
    fixPinnedPrereqOrder(state);               // late passes can re-shuffle a repaired prereq
    // The tail passes above can each ACTIVATE a term: enforceMapCaps overflows
    // an evicted card to the latest term with room, rescueUnscheduled seats a
    // course the seed gave up on. Nothing re-packed after them, so Chemistry
    // finished with a Fall 2031 holding one 2-credit religion cornerstone that
    // had a legal seat in the Winter before it. Score-gated, so a term that
    // deserves to exist survives.
    compact(state); closeGaps(state);
    topUpCredits(state);                       // re-assert the 120-credit graduation floor
    topUpFloor(state);                         // guarantee ≥12 on every surviving term

    // seed()'s `unscheduled` is a snapshot taken before any optimizer pass ran,
    // so anything rescueUnscheduled() has since placed must stop being reported
    // as unplaceable — and its problem text with it, or the app shows an error
    // flag naming a course that is sitting on the board.
    const stranded = state.instances.filter(i => !state.assign.has(i.uid));
    const strandedUids = new Set(stranded.map(i => i.uid));
    problems = problems.filter(p => p.type !== "unscheduled" || strandedUids.has(p.uid));

    const score = scorePlan(state);
    const { flags, courseFlags } = analyze(state, expandRes, programs, problems);
    const { courseWhy, planNotes } = explain(state, expandRes, programs);
    const progress = progressReport(profile, programs, cat, expandRes.chosen, expandRes.completed, state.assign, state.byUid);

    // serializable placements for the UI
    const placements = [];
    state.assign.forEach((t, uid) => {
      const inst = state.byUid.get(uid);
      const fm = expandRes.fillMeta && expandRes.fillMeta.get(baseId(uid));
      if (fm) {
        // a class the student picked from a dropdown slot — stays swappable
        placements.push({
          uid, termIndex: t,
          courseId: baseId(uid), display: inst.course.display || baseId(uid),
          name: inst.course.name, credits: inst.course.credits,
          diff: inst.course.diff, buckets: inst.buckets,
          pinned: state.pinnedUids.has(uid), block: state.blockOf.get(uid) || null,
          flags: courseFlags.get(uid) || [], why: courseWhy.get(uid) || [],
          placeholder: false, elective: false, bucket: false,
          isFill: true, fillKey: fm.fillKey, bucketKey: fm.bucketKey, groupIdx: fm.groupIdx,
        });
        return;
      }
      placements.push({
        uid, termIndex: t,
        courseId: baseId(uid), display: inst.course.display || baseId(uid),
        name: inst.course.name, credits: inst.course.credits,
        diff: inst.course.diff, buckets: inst.buckets,
        pinned: state.pinnedUids.has(uid), block: state.blockOf.get(uid) || null,
        repTotal: inst.total > 1 ? inst.total : null,
        flags: courseFlags.get(uid) || [], why: courseWhy.get(uid) || [],
        placeholder: !!inst.course.placeholder, elective: !!inst.course.elective,
        bucket: !!inst.course.bucket, isReligion: !!inst.course.isReligion,
        bucketKey: inst.course.bucket ? (inst.buckets && inst.buckets[0]) : null,
        fillKey: inst.course.fillKey || null,
        reqLabel: inst.course.reqLabel || null,
        groupIdx: inst.course.bucketRef ? inst.course.bucketRef.groupIdx : null,
        sheetName: (state.mapLabels && state.mapLabels.get(uid)) || null,
      });
    });

    if (expandRes.doubleCounted > 0) {
      const names = [...expandRes.dcIds].map(id => cat[id]?.display || id).join(", ");
      flags.push({ level: "info", icon: "clone", text: `${expandRes.doubleCounted} credits double-counted across programs (cap: ${profile.settings.doubleCountCap} cr): ${names}. Click a class for the requirements it fills.` });
    }

    return {
      terms, placements, programs: programs.map(p => p.id),
      progress, flags, planNotes, groupSel: expandRes.groupSel,
      score, doubleCounted: expandRes.doubleCounted,
      unscheduled: stranded.map(i => ({ uid: i.uid, name: i.course.name })),
      solveMs: Math.round(performance.now() - t0),
      state, // kept live for drag-drop validation
      _ctx: { expandRes, programsFull: programs, problems }, // for reanalyze()
    };
  }

  /* Recompute flags + per-course warnings on the LIVE state (after a manual
     move) so a fixed prerequisite order clears its stale warning immediately. */
  function reanalyze(result) {
    const { expandRes, programsFull, problems } = result._ctx || {};
    if (!expandRes) return;
    const { flags, courseFlags } = analyze(result.state, expandRes, programsFull, problems);
    if (expandRes.doubleCounted > 0) {
      const names = [...expandRes.dcIds].map(id => result.state.cat[id]?.display || id).join(", ");
      flags.push({ level: "info", icon: "clone", text: `${expandRes.doubleCounted} credits double-counted across programs (cap: ${result.state.profile.settings.doubleCountCap} cr): ${names}. Click a class for the requirements it fills.` });
    }
    result.flags = flags;
    const ex = explain(result.state, expandRes, programsFull);
    result.planNotes = ex.planNotes;
    result.placements.forEach(p => {
      p.flags = courseFlags.get(p.uid) || [];
      p.why = ex.courseWhy.get(p.uid) || [];
    });
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
      if (baseId(i.uid) === baseId(uid) && (!inst.course.bucket || inst.course.isReligion) && i.k > inst.k && t2 <= targetTermIndex) { depOk = false; depName = i.course.display || baseId(i.uid); }
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
    reanalyze(result);   // warnings track the move (stale prereq flags clear)
  }

  /* DEBUG: probe a single course's best greedy move on a solved state */
  function _probeMove(result, courseId) {
    const state = result.state;
    const inst = state.byUid.get(courseId);
    if (!inst) return { err: "not found" };
    const from = state.assign.get(inst.uid);
    const inMovable = state.assign.has(inst.uid) && !state.pinnedUids.has(inst.uid) && !state.blockOf.has(inst.uid);
    const base = scorePlan(state).total;
    const out = [];
    for (let t = 0; t < state.terms.length; t++) {
      if (t === from) continue;
      unplace(state, inst);
      const ok = canPlace(state, inst, t);
      if (ok) { place(state, inst, t); const s = scorePlan(state).total; unplace(state, inst); out.push({ term: state.terms[t].label, delta: +(s - base).toFixed(2) }); }
      place(state, inst, from);
    }
    out.sort((a, b) => a.delta - b.delta);
    return { from: state.terms[from].label, inMovable, baseScore: +base.toFixed(2), bestMoves: out.slice(0, 4) };
  }
  return { solve, validateMove, applyMove, reanalyze, SEASON_NAME, _probeMove };
})();
