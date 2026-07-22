/* =========================================================================
   myplanBYU — data.js
   Curated data snapshot (manually entered, no scraping).
   Architecture: Courses carry tags; Programs are lists of Requirement
   Buckets; Buckets are filled by courses matched via explicit option
   lists and/or tags. Programs without hand-entered detail generate
   realistic placeholder course chains so ANY major/minor/cert is plannable.
   ========================================================================= */
"use strict";

const DATA = (() => {

  /* ---------------------------------------------------------------
     COURSE CATALOG (detailed, hand-entered)
     off: seasons offered  F=Fall W=Winter S=Spring U=Summer
     diff: historical difficulty 1-10   load: time-cost multiplier
     demand: seat pressure low|med|high  rare: rarely offered
     ---------------------------------------------------------------- */
  const C = {};
  function add(id, name, cr, o = {}) {
    C[id] = {
      id, name, credits: cr,
      tags: o.tags || [],
      pre: o.pre || [],            // array of prereq groups; each group = "A" or ["A","B"] meaning A OR B
      off: o.off || "FW",
      diff: o.diff ?? 4,
      load: o.load ?? 1.0,
      demand: o.demand || "med",
      rare: !!o.rare,
      testOut: o.testOut || null,
      repeatMax: o.repeatMax || 1, // repeatable R-courses
      note: o.note || null,
    };
  }

  /* ---- University Core: writing / quantitative ---- */
  add("WRTG 150", "Writing and Rhetoric", 3, { tags: ["fyw"], off: "FWSU", diff: 4, load: 1.3, demand: "high", testOut: "AP English Lang (4+) waives First-Year Writing." });
  add("MATH 110", "College Algebra", 3, { tags: ["qr"], off: "FWSU", diff: 5, demand: "med", testOut: "ACT Math 22+ / AP Calc satisfies Quantitative Reasoning." });
  add("M COM 320", "Management Communication", 3, { tags: ["adv-writing"], pre: ["WRTG 150"], off: "FWSU", diff: 5, load: 1.4, demand: "high", note: "Marriott section of Advanced Written & Oral Communication." });
  add("WRTG 316", "Technical Communication", 3, { tags: ["adv-writing"], pre: ["WRTG 150"], off: "FWS", diff: 4, load: 1.3 });

  /* ---- American Heritage options ---- */
  add("A HTG 100", "American Heritage", 3, { tags: ["am-heritage"], off: "FW", diff: 5, demand: "high", testOut: "AP US History (4+) + AP Gov can substitute." });
  add("POLI 110", "American Government and Politics", 3, { tags: ["am-heritage"], off: "FWSU", diff: 4 });
  add("HIST 220", "The American Experience", 3, { tags: ["am-heritage"], off: "FW", diff: 4 });

  /* ---- Civilization 1 / 2 ---- */
  add("HIST 201", "World Civilization to 1500", 3, { tags: ["civ1"], off: "FWS", diff: 4 });
  add("ARTHC 201", "World Civilization to 1500 (Art)", 3, { tags: ["civ1"], off: "FW", diff: 4 });
  add("PHIL 201", "History of Philosophy 1", 3, { tags: ["civ1"], off: "FW", diff: 5 });
  add("HIST 202", "World Civilization since 1500", 3, { tags: ["civ2"], off: "FWS", diff: 4 });
  add("PHIL 202", "History of Philosophy 2", 3, { tags: ["civ2"], off: "FW", diff: 5 });
  add("ARTHC 202", "World Civilization since 1500 (Art)", 3, { tags: ["civ2"], off: "FW", diff: 4 });

  /* ---- Arts / Letters ---- */
  add("MUSIC 101", "Introduction to Music", 3, { tags: ["ge-arts"], off: "FWSU", diff: 2 });
  add("TMA 101", "Introduction to Theatre", 3, { tags: ["ge-arts"], off: "FW", diff: 2 });
  add("DANCE 260", "Introduction to Dance", 3, { tags: ["ge-arts", "blrm-theory"], off: "FW", diff: 2, note: "Double-counts: Arts GE + Ballroom Dance minor." });
  add("ENGL 230", "Introduction to Literature", 3, { tags: ["ge-letters"], off: "FWS", diff: 3, load: 1.2 });
  add("PHIL 110", "Introduction to Philosophy", 3, { tags: ["ge-letters"], off: "FWSU", diff: 4 });
  add("IHUM 240", "Introduction to the Humanities", 3, { tags: ["ge-letters"], off: "FW", diff: 3 });

  /* ---- Sciences ---- */
  add("BIO 100", "Principles of Biology", 3, { tags: ["ge-bio"], off: "FWSU", diff: 3, testOut: "AP Biology (4+) fulfills Biological Science." });
  add("PWS 150", "Environmental Biology", 3, { tags: ["ge-bio"], off: "FW", diff: 3 });
  add("NDFS 100", "Essentials of Human Nutrition", 3, { tags: ["ge-bio"], off: "FWSU", diff: 2 });
  add("PHSCS 100", "Physical Science", 3, { tags: ["ge-phys"], off: "FWSU", diff: 3, testOut: "AP Physics / AP Chemistry can fulfill Physical Science." });
  add("PWS 180", "Climate Change: Science and Solutions", 3, { tags: ["ge-phys"], off: "FW", diff: 3 });
  add("CHEM 101", "Introductory General Chemistry", 3, { tags: ["ge-phys"], off: "FWS", diff: 5 });
  add("GEOL 101", "Introduction to Geology", 3, { tags: ["ge-phys"], off: "FW", diff: 3 });

  /* ---- Social Science / Global & Cultural Awareness ---- */
  add("ECON 110", "Economic Principles and Problems", 3, { tags: ["ge-social", "msb-precore"], off: "FWSU", diff: 6, demand: "high", note: "Double-counts: Social Science GE + Marriott pre-core.", testOut: "AP Micro+Macro (4+) may substitute — confirm with advisement." });
  add("PSYCH 111", "General Psychology", 3, { tags: ["ge-social"], off: "FWSU", diff: 3, testOut: "AP Psychology (4+) fulfills Social Science." });
  add("SOC 111", "Introductory Sociology", 3, { tags: ["ge-social"], off: "FWS", diff: 3 });
  add("GEOG 120", "Geography and World Affairs", 3, { tags: ["ge-social", "gca"], off: "FW", diff: 3, note: "Double-counts: Social Science + Global & Cultural Awareness." });
  add("ANTHR 101", "Social and Cultural Anthropology", 3, { tags: ["gca"], off: "FW", diff: 3 });
  add("IAS 220", "Introduction to Global and Development Studies", 3, { tags: ["gca"], off: "FW", diff: 3 });

  /* ---- Religion: cornerstones (2.0 each) + electives ---- */
  add("REL A 275", "Teachings and Doctrine of the Book of Mormon", 2, { tags: ["rel-corner"], off: "FWSU", diff: 2 });
  add("REL A 250", "Jesus Christ and the Everlasting Gospel", 2, { tags: ["rel-corner"], off: "FWSU", diff: 2 });
  add("REL C 200", "The Eternal Family", 2, { tags: ["rel-corner"], off: "FWSU", diff: 2 });
  add("REL C 225", "Foundations of the Restoration", 2, { tags: ["rel-corner"], off: "FWSU", diff: 2 });
  add("REL A 211", "The New Testament", 2, { tags: ["rel-elective"], off: "FWSU", diff: 2 });
  add("REL A 301", "The Old Testament", 2, { tags: ["rel-elective"], off: "FW", diff: 2 });
  add("REL C 324", "The Doctrine and Covenants", 2, { tags: ["rel-elective"], off: "FWSU", diff: 2 });
  add("REL C 351", "Survey of World Religions", 2, { tags: ["rel-elective", "gca"], off: "FW", diff: 2, note: "Double-counts: Religion elective + Global & Cultural Awareness." });
  add("REL C 341", "The Latter-day Saint Church, 1805-1846", 2, { tags: ["rel-elective"], off: "FW", diff: 2 });

  /* ---- Marriott pre-core / IS pre-core ---- */
  add("IS 201", "Introduction to Information Systems", 3, { tags: ["msb-precore"], off: "FWSU", diff: 4, demand: "high" });
  add("ACC 200", "Principles of Accounting", 3, { tags: ["msb-precore"], off: "FWSU", diff: 6, load: 1.2, demand: "high" });
  add("FIN 201", "Principles of Finance", 3, { tags: ["msb-precore"], pre: ["ACC 200", "ECON 110"], off: "FWSU", diff: 7, load: 1.2, demand: "high" });
  add("MKTG 201", "Marketing Management", 3, { tags: ["msb-precore"], off: "FWS", diff: 4 });
  add("STAT 121", "Principles of Statistics", 3, { tags: ["msb-precore", "qr"], off: "FWSU", diff: 5, testOut: "AP Statistics (4+) may substitute." });
  add("IS 303", "Introduction to Computer Programming", 3, { tags: ["is-precore"], pre: ["IS 201"], off: "FW", diff: 6.5, load: 1.4, demand: "high", note: "B or better strongly recommended for IS admission." });

  /* ---- IS Junior Core — Fall envelope (co-requisite block) ---- */
  const JC_F = { off: "F", diff: 7, load: 1.3, demand: "high" };
  add("IS 401", "Project Management & Systems Design", 3, { ...JC_F, tags: ["is-jcore-f"], pre: ["IS 303"] });
  add("IS 402", "Database Systems", 3, { ...JC_F, tags: ["is-jcore-f"], pre: ["IS 303"] });
  add("IS 403", "Principles of Business Programming", 3, { ...JC_F, diff: 8, load: 1.5, tags: ["is-jcore-f"], pre: ["IS 303"] });
  add("IS 404", "Data Communications and Networking", 3, { ...JC_F, diff: 6, tags: ["is-jcore-f"], pre: ["IS 303"] });

  /* ---- IS Junior Core — Winter ---- */
  const JC_W = { off: "W", diff: 7, load: 1.3, demand: "high" };
  add("IS 414", "Information Systems Security & Controls", 3, { ...JC_W, diff: 6, tags: ["is-jcore-w"], pre: ["IS 404"] });
  add("IS 455", "Predictive Data Analytics", 3, { ...JC_W, diff: 6, tags: ["is-jcore-w"], pre: ["IS 402", "STAT 121"] });
  add("IS 456", "Agentic AI in Business", 3, { ...JC_W, diff: 6, tags: ["is-jcore-w"], pre: ["IS 403"] });

  /* ---- IS electives (no longer in the current junior core) ---- */
  add("IS 413", "Web and Mobile Systems Development", 3, { off: "W", diff: 7.5, load: 1.5, tags: ["is-elective"], pre: ["IS 403"] });
  add("IS 415", "Enterprise Data Analytics", 3, { off: "F", diff: 6, tags: ["is-elective"], pre: ["IS 303", "STAT 121"] });

  /* ---- Integrated MISM (grad year blocks) ---- */
  const MI_F = { off: "F", diff: 7, load: 1.3 };
  add("IS 515", "Advanced Systems Analysis", 3, { ...MI_F, tags: ["mism-f"], pre: ["IS 401"] });
  add("IS 531", "Enterprise Application Development", 3, { ...MI_F, diff: 8, load: 1.5, tags: ["mism-f"], pre: ["IS 413"] });
  add("IS 537", "IT Governance and Controls", 3, { ...MI_F, diff: 5, tags: ["mism-f"], pre: ["IS 455"] });
  add("IS 562", "Machine Learning for Business", 3, { ...MI_F, diff: 8, tags: ["mism-elective"], pre: ["IS 415"] });
  add("IS 566", "Cybersecurity Analytics", 3, { off: "F", diff: 7, rare: true, tags: ["mism-elective"], pre: ["IS 414"], note: "Offered Fall only; small section." });
  const MI_W = { off: "W", diff: 6, load: 1.2 };
  add("IS 520", "Spreadsheet Automation and Modeling", 3, { ...MI_W, tags: ["mism-w"], pre: ["IS 403"], demand: "high" });
  add("IS 542", "Web Services and Cloud Architecture", 3, { ...MI_W, diff: 7, tags: ["mism-w"], pre: ["IS 413"] });
  add("IS 555", "Data Science for Business", 3, { ...MI_W, diff: 7, tags: ["mism-w"], pre: ["IS 415"] });
  add("IS 590R", "Special Topics in Information Systems", 3, { off: "FW", diff: 5, tags: ["mism-elective"] });
  add("MSB 494R", "On-Campus Experiential Projects", 3, { off: "FW", diff: 4, tags: ["msb-elective", "gbc-experience"], note: "Counts toward Global Business international-experience prep track." });

  /* ---- Ballroom Dance minor ---- */
  add("DANCE 386", "Methods of Teaching Social Dance", 2, { tags: ["blrm-teach"], off: "F", diff: 3, rare: false });
  add("DANCE 387", "Ballroom Dance Choreography", 2, { tags: ["blrm-teach"], off: "W", diff: 3, rare: true, note: "Small studio section — offered once per year." });
  add("DANCE 384R", "Ballroom Dance, International Technique 3", 1, { tags: ["blrm-tech"], off: "FW", diff: 3, load: 1.6, repeatMax: 2, note: "Audition placement." });
  add("DANCE 385R", "Latin Dance, International Technique 3", 1, { tags: ["blrm-tech"], off: "FW", diff: 3, load: 1.6, repeatMax: 2 });
  add("DANCE 484R", "Ballroom Dance, International Technique 4", 1, { tags: ["blrm-tech"], pre: ["DANCE 384R"], off: "FW", diff: 4, load: 1.8, repeatMax: 3, demand: "high" });
  add("DANCE 485R", "Latin Dance, International Technique 4", 1, { tags: ["blrm-tech"], pre: ["DANCE 385R"], off: "FW", diff: 4, load: 1.8, repeatMax: 3, demand: "high" });
  add("DANCE 488R", "Ballroom Dance Performance Company", 2, { tags: ["blrm-perf"], off: "FW", diff: 3, load: 2.2, repeatMax: 4, demand: "high", note: "Audition required; heavy rehearsal block (evenings)." });
  add("DANCE 480R", "Social Dance Technique 3", 1, { tags: ["blrm-tech"], off: "FW", diff: 2, load: 1.4, repeatMax: 2 });

  /* ---- Spanish certificate ---- */
  add("SPAN 321", "Third-Year Spanish Reading, Grammar, and Culture", 3, { tags: ["span-core"], off: "FWS", diff: 5, demand: "med", testOut: "Returned missionaries: challenge exam / SPAN 321 placement." });
  add("SPAN 322", "Advanced Spanish Grammar", 3, { tags: ["span-elective"], pre: ["SPAN 321"], off: "FW", diff: 5 });
  add("SPAN 326", "Advanced Spanish Conversation", 3, { tags: ["span-elective"], pre: ["SPAN 321"], off: "FW", diff: 4 });
  add("SPAN 339", "Introduction to Hispanic Literature", 3, { tags: ["span-elective"], pre: ["SPAN 321"], off: "FW", diff: 5, load: 1.3 });
  add("SPAN 355", "Cultures of Spanish America", 3, { tags: ["span-elective", "gca"], pre: ["SPAN 321"], off: "FW", diff: 4, note: "Double-counts: Spanish cert + Global & Cultural Awareness." });
  add("SPAN 356", "Cultures of Spain", 3, { tags: ["span-elective"], pre: ["SPAN 321"], off: "W", diff: 4, rare: true });
  add("SPAN 320", "Spanish for Business", 3, { tags: ["span-elective", "gbc-lang"], pre: ["SPAN 321"], off: "F", diff: 4, rare: true, note: "Double-counts: Spanish cert + Global Business language. Offered Fall only." });

  /* ---- Global Business certificate ---- */
  add("MSB 430", "International Business Management", 3, { tags: ["gbc-core"], off: "FW", diff: 5 });
  add("GSCM 415", "Global Supply Chain Strategy", 3, { tags: ["gbc-core"], off: "W", diff: 6 });
  add("MKTG 454", "International Marketing", 3, { tags: ["gbc-core"], pre: ["MKTG 201"], off: "F", diff: 5 });
  add("ECON 358", "Economics of the Global Economy", 3, { tags: ["gbc-core"], pre: ["ECON 110"], off: "W", diff: 6 });
  add("GLOBAL XP", "International Experience (study abroad / internship)", 1, { tags: ["gbc-experience"], off: "SU", diff: 1, note: "Whitmore Center approved experience — study abroad, field study, or international internship. Best fit: Spring/Summer term." });

  /* ---------------------------------------------------------------
     UNIVERSITY CORE buckets (applies to every plan)
     pick: {type:'all'} | {type:'courses', n} | {type:'credits', n}

     The 12 GE categories come from the REAL University Core program in the
     scraped catalog (js/catalog_data.js) — full official option lists per
     category. First-Year Writing and Religion aren't in that catalog
     program, so they stay hand-defined (they're stable and small).
     ---------------------------------------------------------------- */
  const HAVE_REAL = typeof CATALOG_DATA !== "undefined" && CATALOG_DATA && CATALOG_DATA.courses;
  const GE_REAL = HAVE_REAL && CATALOG_DATA.ge ? CATALOG_DATA.ge.buckets : null;

  const HAND_GE_BUCKETS = [
    { id: "am-heritage",name: "American Heritage",                 pick: { type: "courses", n: 1 }, tag: "am-heritage" },
    { id: "qr",         name: "Quantitative Reasoning",            pick: { type: "courses", n: 1 }, tag: "qr", waivableByExam: true },
    { id: "civ1",       name: "Civilization 1",                    pick: { type: "courses", n: 1 }, tag: "civ1" },
    { id: "civ2",       name: "Civilization 2",                    pick: { type: "courses", n: 1 }, tag: "civ2" },
    { id: "ge-arts",    name: "Arts",                              pick: { type: "courses", n: 1 }, tag: "ge-arts" },
    { id: "ge-letters", name: "Letters",                           pick: { type: "courses", n: 1 }, tag: "ge-letters" },
    { id: "ge-bio",     name: "Biological Science",                pick: { type: "courses", n: 1 }, tag: "ge-bio" },
    { id: "ge-phys",    name: "Physical Science",                  pick: { type: "courses", n: 1 }, tag: "ge-phys" },
    { id: "ge-social",  name: "Social Science",                    pick: { type: "courses", n: 1 }, tag: "ge-social" },
    { id: "gca",        name: "Global & Cultural Awareness",       pick: { type: "courses", n: 1 }, tag: "gca" },
    { id: "adv-writing",name: "Advanced Written & Oral Communication", pick: { type: "courses", n: 1 }, tag: "adv-writing" },
  ];

  const UNIV_CORE = {
    id: "univ-core", name: "University Core (GE + Religion)", type: "core", credits: 39,
    buckets: [
      { id: "univ101", name: "BYU Foundations for Student Success", pick: { type: "all" },
        options: ["UNIV 101"],
        note: "UNIV 101 is required for all new freshmen — take it your first semester." },
      { id: "fyw", name: "First-Year Writing", pick: { type: "courses", n: 1 },
        options: ["WRTG 150"], waivableByExam: true },
      ...(GE_REAL || HAND_GE_BUCKETS),
      { id: "rel-corner", name: "Religion Cornerstones",  pick: { type: "courses", n: 4 }, tag: "rel-corner" },
      { id: "rel-elective", name: "Religion Electives",   pick: { type: "credits", n: 6 }, tag: "rel-elective" },
    ],
  };

  /* ---------------------------------------------------------------
     DETAILED PROGRAMS
     ---------------------------------------------------------------- */
  const IS_BS = {
    id: "is-bs", name: "Information Systems (BS)", type: "major",
    college: "Marriott School of Business", credits: 64, detailed: true,
    gates: [{ id: "is-apply", name: "IS program application", note: "Pre-core must be complete before the Junior Core fall." }],
    buckets: [
      { id: "msb-precore", name: "Pre-Core Requirements", pick: { type: "all" }, options: ["IS 201", "ACC 200", "ECON 110", "FIN 201", "MKTG 201", "STAT 121", "M COM 320"] },
      { id: "is-precore",  name: "Programming Prerequisite", pick: { type: "all" }, options: ["IS 303"] },
      // Junior core = the current official flowchart envelopes (rigid, co-req).
      { id: "is-jcore-f",  name: "Junior Core — Fall Envelope", pick: { type: "all" }, options: ["IS 401", "IS 403", "IS 404", "IS 402"],
        block: { id: "jcf", season: "F", label: "IS Junior Core (Fall envelope)", fcYear: 3 } },
      { id: "is-jcore-w",  name: "Junior Core — Winter", pick: { type: "all" }, options: ["IS 414", "IS 455", "IS 456"],
        block: { id: "jcw", season: "W", label: "IS Junior Core (Winter)", after: "jcf", fcYear: 3 } },
      { id: "is-bcore",    name: "Business Core (after IS core)", pick: { type: "all" }, options: ["HRM 391", "PSE 390", "STRAT 392"] },
      { id: "is-senior",   name: "Senior Electives", pick: { type: "credits", n: 6 }, options: ["IS 413", "IS 415", "MSB 494R", "IS 590R", "IS 566"] },
    ],
  };

  const IS_BS_MISM = {
    id: "is-bs-mism", name: "Information Systems (BS) — Integrated MISM Track", type: "major",
    college: "Marriott School of Business", credits: 94, detailed: true,
    gates: [
      { id: "is-apply", name: "IS program application", note: "Pre-core complete before Junior Core fall." },
      { id: "mism-apply", name: "MISM application deadline", note: "Apply during the Junior Core winter semester; Junior Core fall block must be complete.", requiresBucket: "is-jcore-f" },
    ],
    buckets: [
      ...IS_BS.buckets,
      { id: "mism-f", name: "MISM Core — Fall Block", pick: { type: "all" }, options: ["IS 515", "IS 531", "IS 537"],
        block: { id: "mif", season: "F", label: "MISM cohort (Fall)", after: "jcw" } },
      { id: "mism-w", name: "MISM Core — Winter Block", pick: { type: "all" }, options: ["IS 520", "IS 542", "IS 555"],
        block: { id: "miw", season: "W", label: "MISM cohort (Winter)", after: "mif" } },
      { id: "mism-elective", name: "MISM Electives", pick: { type: "credits", n: 6 }, options: ["IS 562", "IS 566", "IS 590R"] },
    ],
  };

  const BALLROOM_MINOR = {
    id: "ballroom-minor", name: "Ballroom Dance (Minor)", type: "minor",
    college: "College of Fine Arts and Communications", credits: 17, detailed: true,
    buckets: [
      { id: "blrm-theory", name: "Dance Theory Core", pick: { type: "all" }, options: ["DANCE 260"] },
      { id: "blrm-teach",  name: "Teaching & Choreography", pick: { type: "all" }, options: ["DANCE 386", "DANCE 387"] },
      { id: "blrm-tech",   name: "Technique Courses", pick: { type: "credits", n: 6 }, tag: "blrm-tech", perCourseMax: 3,
        note: "No more than 3 credits from any single R-course." },
      { id: "blrm-perf",   name: "Performance Company", pick: { type: "credits", n: 4 }, options: ["DANCE 488R"] },
    ],
  };

  const SPANISH_CERT = {
    id: "spanish-cert", name: "Spanish Studies (Certificate)", type: "cert",
    college: "College of Humanities", credits: 12, detailed: true,
    buckets: [
      { id: "span-core", name: "Required Foundation", pick: { type: "all" }, options: ["SPAN 321"] },
      { id: "span-elective", name: "Spanish Electives", pick: { type: "credits", n: 9 }, tag: "span-elective" },
    ],
  };

  const GLOBAL_BUS_CERT = {
    id: "gbc-cert", name: "Global Business (Certificate)", type: "cert",
    college: "Marriott School of Business", credits: 10, detailed: true,
    buckets: [
      { id: "gbc-lang", name: "Business Language", pick: { type: "courses", n: 1 }, tag: "gbc-lang",
        note: "Business language course in your target language (Spanish shown; 10 other languages sponsored)." },
      { id: "gbc-core", name: "International Business Courses", pick: { type: "credits", n: 6 }, tag: "gbc-core" },
      { id: "gbc-experience", name: "International Experience", pick: { type: "courses", n: 1 }, tag: "gbc-experience",
        note: "Study abroad, field study, or international internship approved by the Whitmore Center." },
    ],
  };

  /* ---------------------------------------------------------------
     GENERIC PROGRAM CATALOG
     [name, college, coreCredits, prefix, baseDifficulty]
     Placeholder chains are generated deterministically per program.
     ---------------------------------------------------------------- */
  const COLLEGES = {
    MSB: "Marriott School of Business",
    ENG: "Ira A. Fulton College of Engineering",
    CPMS: "College of Computational, Mathematical & Physical Sciences",
    LS: "College of Life Sciences",
    FHSS: "College of Family, Home & Social Sciences",
    HUM: "College of Humanities",
    FAC: "College of Fine Arts and Communications",
    EDU: "David O. McKay School of Education",
    NUR: "College of Nursing",
    KEN: "Kennedy Center / Interdisciplinary",
  };

  const GENERIC_MAJORS = [
    // Marriott School of Business
    ["Accounting (BS)", "MSB", 57, "ACC", 7], ["Finance (BS)", "MSB", 54, "FIN", 7],
    ["Global Supply Chain Management (BS)", "MSB", 52, "GSCM", 6], ["Marketing (BS)", "MSB", 52, "MKTG", 5],
    ["Human Resource Management (BS)", "MSB", 52, "HRM", 5], ["Strategic Management (BS)", "MSB", 52, "STRAT", 6],
    ["Entrepreneurial Management (BS)", "MSB", 52, "ENT", 5], ["Experience Design & Management (BS)", "MSB", 55, "EXDM", 4],
    ["Cybersecurity (BS)", "MSB", 74, "CYBER", 7],
    // Engineering
    ["Chemical Engineering (BS)", "ENG", 90, "CH EN", 8], ["Civil Engineering (BS)", "ENG", 85, "CE EN", 8],
    ["Computer Engineering (BS)", "ENG", 88, "EC EN", 8], ["Electrical Engineering (BS)", "ENG", 88, "EC EN", 8],
    ["Mechanical Engineering (BS)", "ENG", 90, "ME EN", 8], ["Manufacturing Engineering (BS)", "ENG", 85, "MFG", 7],
    ["Construction Management (BS)", "ENG", 70, "CM", 5], ["Facility & Property Management (BS)", "ENG", 65, "FPM", 4],
    ["Industrial Design (BFA)", "ENG", 70, "INDES", 5], ["Information Technology (BS)", "ENG", 70, "IT", 6],
    // CPMS
    ["Applied & Computational Mathematics (BS)", "CPMS", 80, "MATH", 9], ["Mathematics (BS)", "CPMS", 60, "MATH", 8],
    ["Mathematics Education (BS)", "CPMS", 74, "MTHED", 7], ["Statistics: Data Science (BS)", "CPMS", 62, "STAT", 7],
    ["Actuarial Science (BS)", "CPMS", 62, "STAT", 8], ["Computer Science (BS)", "CPMS", 74, "CS", 8],
    ["Computer Science: Software Engineering (BS)", "CPMS", 76, "CS", 8], ["Computer Science: Machine Learning (BS)", "CPMS", 76, "CS", 8],
    ["Computer Science: Animation & Games (BS)", "CPMS", 76, "CS", 7], ["Chemistry (BS)", "CPMS", 74, "CHEM", 8],
    ["Biochemistry (BS)", "CPMS", 76, "CHEM", 8], ["Physics (BS)", "CPMS", 74, "PHSCS", 9],
    ["Applied Physics (BS)", "CPMS", 74, "PHSCS", 8], ["Physics-Astronomy (BS)", "CPMS", 76, "PHSCS", 9],
    ["Physics Teaching (BS)", "CPMS", 70, "PHSCS", 7], ["Geology (BS)", "CPMS", 70, "GEOL", 6],
    ["Geospatial Science & Technology (BS)", "CPMS", 60, "GEOG", 5],
    // Life Sciences
    ["Biology (BS)", "LS", 66, "BIO", 6], ["Molecular Biology (BS)", "LS", 70, "MMBIO", 8],
    ["Microbiology (BS)", "LS", 68, "MMBIO", 7], ["Neuroscience (BS)", "LS", 72, "NEURO", 8],
    ["Physiology & Developmental Biology (BS)", "LS", 68, "PDBIO", 7], ["Bioinformatics (BS)", "LS", 74, "BIO", 8],
    ["Genetics, Genomics & Biotechnology (BS)", "LS", 70, "GEN", 7], ["Exercise Science (BS)", "LS", 65, "EXSC", 6],
    ["Public Health (BS)", "LS", 62, "HLTH", 5], ["Nutritional Science (BS)", "LS", 68, "NDFS", 7],
    ["Dietetics (BS)", "LS", 70, "NDFS", 7], ["Food Science (BS)", "LS", 66, "NDFS", 6],
    ["Wildlife & Wildlands Conservation (BS)", "LS", 64, "PWS", 5], ["Environmental Science & Sustainability (BS)", "LS", 64, "PWS", 5],
    ["Landscape Management (BS)", "LS", 60, "PWS", 4], ["Biodiversity & Conservation (BS)", "LS", 64, "BIO", 6],
    ["Biophysics (BS)", "LS", 76, "PHSCS", 9],
    // FHSS
    ["Economics (BS)", "FHSS", 45, "ECON", 7], ["Psychology (BS)", "FHSS", 50, "PSYCH", 4],
    ["Sociology (BS)", "FHSS", 45, "SOC", 4], ["Political Science (BA)", "FHSS", 45, "POLI", 5],
    ["History (BA)", "FHSS", 48, "HIST", 5], ["History Teaching (BA)", "FHSS", 60, "HIST", 5],
    ["Anthropology (BA)", "FHSS", 48, "ANTHR", 4], ["Geography (BS)", "FHSS", 45, "GEOG", 4],
    ["Family Studies (BS)", "FHSS", 50, "SFL", 4], ["Human Development (BS)", "FHSS", 50, "SFL", 4],
    // Humanities
    ["English (BA)", "HUM", 48, "ENGL", 4], ["English Teaching (BA)", "HUM", 62, "ENGL", 5],
    ["Linguistics (BA)", "HUM", 48, "LING", 5], ["Philosophy (BA)", "HUM", 45, "PHIL", 5],
    ["Spanish (BA)", "HUM", 45, "SPAN", 4], ["Spanish Translation & Localization (BA)", "HUM", 50, "SPAN", 6],
    ["Portuguese (BA)", "HUM", 45, "PORT", 4], ["French (BA)", "HUM", 45, "FREN", 4],
    ["French Teaching (BA)", "HUM", 60, "FREN", 5], ["German (BA)", "HUM", 45, "GERM", 4],
    ["Russian (BA)", "HUM", 45, "RUSS", 5], ["Italian (BA)", "HUM", 42, "ITAL", 4],
    ["Chinese (BA)", "HUM", 48, "CHIN", 6], ["Japanese (BA)", "HUM", 48, "JAPAN", 6],
    ["Korean (BA)", "HUM", 45, "KOREA", 6], ["Middle East Studies / Arabic (BA)", "HUM", 54, "MESA", 6],
    ["Classical Studies (BA)", "HUM", 45, "CL CV", 5], ["American Studies (BA)", "HUM", 48, "AMST", 4],
    ["European Studies (BA)", "HUM", 48, "EUROP", 4], ["Latin American Studies (BA)", "HUM", 48, "LAS", 4],
    ["Asian Studies (BA)", "HUM", 48, "ASIAN", 4], ["Ancient Near Eastern Studies (BA)", "HUM", 48, "ANES", 5],
    ["Interdisciplinary Humanities (BA)", "HUM", 48, "IHUM", 4],
    // Fine Arts & Communications
    ["Communications: Advertising (BA)", "FAC", 55, "COMMS", 5], ["Communications: Public Relations (BA)", "FAC", 55, "COMMS", 5],
    ["Communications: News Media (BA)", "FAC", 55, "COMMS", 5], ["Communication Studies (BA)", "FAC", 48, "COMMS", 4],
    ["Art (BFA)", "FAC", 60, "ART", 4], ["Art Education (BA)", "FAC", 70, "ARTED", 5],
    ["Art History & Curatorial Studies (BA)", "FAC", 50, "ARTHC", 4], ["Graphic Design (BFA)", "FAC", 65, "DES", 6],
    ["Illustration (BFA)", "FAC", 65, "DES", 6], ["Animation (BFA)", "FAC", 70, "CSANM", 7],
    ["Photography (BFA)", "FAC", 60, "DES", 5], ["Music (BA)", "FAC", 60, "MUSIC", 6],
    ["Commercial Music (BM)", "FAC", 62, "MUSIC", 6], ["Music Education (BM)", "FAC", 78, "MUSIC", 6],
    ["Music Performance (BM)", "FAC", 70, "MUSIC", 7], ["Dance (BA)", "FAC", 55, "DANCE", 5],
    ["Dance Education (BA)", "FAC", 70, "DANCE", 5], ["Media Arts Studies (BA)", "FAC", 55, "TMA", 5],
    ["Theatre Arts Studies (BA)", "FAC", 55, "TMA", 4], ["Acting (BFA)", "FAC", 60, "TMA", 6],
    ["Music Dance Theatre (BFA)", "FAC", 70, "MDT", 7], ["Interior Design (BFA)", "FAC", 65, "DES", 5],
    // Education
    ["Elementary Education (BS)", "EDU", 75, "EL ED", 5], ["Early Childhood Education (BS)", "EDU", 72, "ECE", 4],
    ["Special Education (BS)", "EDU", 75, "CPSE", 5], ["Communication Disorders (BS)", "EDU", 60, "COMD", 6],
    ["Physical Education Teaching & Coaching (BS)", "EDU", 70, "PETE", 4],
    // Nursing / Kennedy
    ["Nursing (BS)", "NUR", 72, "NURS", 7],
    ["International Relations (BA)", "KEN", 45, "IR", 5],
  ];

  const GENERIC_MINORS = [
    ["American Studies", "HUM", 18, "AMST", 4], ["Ancient Near Eastern Studies", "HUM", 18, "ANES", 4],
    ["Anthropology", "FHSS", 18, "ANTHR", 4], ["Art", "FAC", 21, "ART", 4],
    ["Art History", "FAC", 18, "ARTHC", 4], ["Asian Studies", "HUM", 18, "ASIAN", 4],
    ["Ballet", "FAC", 20, "DANCE", 5], ["Biology", "LS", 19, "BIO", 6],
    ["Business", "MSB", 24, "MSB", 5], ["Chemistry", "CPMS", 19, "CHEM", 7],
    ["Chinese", "HUM", 18, "CHIN", 6], ["Classical Studies", "HUM", 18, "CL CV", 4],
    ["Computer Science", "CPMS", 21, "CS", 8], ["Creative Writing", "HUM", 18, "ENGL", 4],
    ["Dance", "FAC", 18, "DANCE", 4], ["Design Thinking", "FAC", 15, "DES", 3],
    ["Digital Humanities & Technology", "HUM", 18, "DIGHT", 4], ["Economics", "FHSS", 18, "ECON", 7],
    ["Editing & Publishing", "HUM", 18, "ELANG", 4], ["Entrepreneurship", "MSB", 18, "ENT", 4],
    ["Environmental Science", "LS", 18, "PWS", 5], ["European Studies", "HUM", 18, "EUROP", 4],
    ["Family History (Genealogy)", "FHSS", 18, "FHGEN", 3], ["Family Life", "FHSS", 18, "SFL", 3],
    ["French", "HUM", 18, "FREN", 4], ["Geography", "FHSS", 18, "GEOG", 4],
    ["Geology", "CPMS", 18, "GEOL", 5], ["German", "HUM", 18, "GERM", 4],
    ["Gerontology", "FHSS", 18, "GERON", 3], ["Global Business & Literacy", "MSB", 18, "GLBUS", 4],
    ["Global Women's Studies", "KEN", 18, "WS", 4], ["History", "FHSS", 18, "HIST", 4],
    ["Information Technology", "ENG", 18, "IT", 6], ["International Development", "KEN", 18, "IAS", 4],
    ["International Strategy & Diplomacy", "KEN", 18, "IR", 5], ["Italian", "HUM", 18, "ITAL", 4],
    ["Japanese", "HUM", 18, "JAPAN", 6], ["Korean", "HUM", 18, "KOREA", 6],
    ["Latin American Studies", "HUM", 18, "LAS", 4], ["Linguistics", "HUM", 18, "LING", 5],
    ["Mathematics", "CPMS", 18, "MATH", 8], ["Mathematics Education", "CPMS", 20, "MTHED", 6],
    ["Media Arts", "FAC", 18, "TMA", 4], ["Military Science (ROTC)", "KEN", 18, "MILS", 3],
    ["Modern Dance", "FAC", 20, "DANCE", 5], ["Music", "FAC", 20, "MUSIC", 5],
    ["Nonprofit Management", "MSB", 18, "MSB", 4], ["Nutrition", "LS", 18, "NDFS", 5],
    ["Philosophy", "HUM", 18, "PHIL", 5], ["Physics", "CPMS", 19, "PHSCS", 8],
    ["Political Science", "FHSS", 18, "POLI", 5], ["Portuguese", "HUM", 18, "PORT", 4],
    ["Psychology", "FHSS", 18, "PSYCH", 4], ["Russian", "HUM", 18, "RUSS", 5],
    ["Scandinavian Studies", "HUM", 18, "SCAND", 4], ["Sociology", "FHSS", 18, "SOC", 4],
    ["Spanish", "HUM", 18, "SPAN", 4], ["Special Education", "EDU", 18, "CPSE", 4],
    ["Statistics", "CPMS", 18, "STAT", 6], ["TESOL K-12", "HUM", 20, "TESOL", 4],
    ["Theatre Arts Studies", "FAC", 18, "TMA", 4],
  ];

  const GENERIC_CERTS = [
    ["Entrepreneurship (Certificate)", "MSB", 12, "ENT", 4],
    ["Family History Research (Certificate)", "FHSS", 12, "FHGEN", 3],
    ["Fundamentals of Business (Certificate)", "MSB", 12, "MSB", 4],
    ["Geographic Information Systems (Certificate)", "FHSS", 12, "GEOG", 5],
    ["International Development (Certificate)", "KEN", 12, "IAS", 4],
    ["Nonprofit Leadership (Certificate)", "MSB", 12, "MSB", 4],
    ["Professional Selling (Certificate)", "MSB", 12, "MKTG", 4],
    ["TESOL (Certificate)", "HUM", 12, "TESOL", 4],
    ["Digital Humanities (Certificate)", "HUM", 12, "DIGHT", 4],
    ["Editing (Certificate)", "HUM", 12, "ELANG", 4],
    ["Environmental Sustainability (Certificate)", "LS", 12, "PWS", 4],
    ["Data Analytics (Certificate)", "CPMS", 12, "STAT", 6],
  ];

  /* ---------------------------------------------------------------
     GENERIC PROGRAM EXPANSION
     Deterministic placeholder chains: intro -> core -> advanced,
     with one rare advanced course per major (single-point-of-failure demo).
     ---------------------------------------------------------------- */
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function slugify(name) {
    return name.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function buildGenericProgram([name, collegeKey, credits, prefix, baseDiff], type) {
    const id = `${type}-${slugify(name)}`;
    const h = hashStr(id);
    const field = name.replace(/\s*\(.*?\)\s*/g, "");
    const n = Math.max(2, Math.round(credits / 3));
    const nIntro = Math.max(1, Math.round(n * 0.25));
    const nCore = Math.max(1, Math.round(n * 0.45));
    const nAdv = Math.max(1, n - nIntro - nCore);
    const courses = [];
    const mk = (num, title, o) => {
      const cid = `${prefix} ${num} [${id}]`; // namespaced so two generic programs never collide
      courses.push({ id: cid, display: `${prefix} ${num}`, name: title, credits: 3, tags: [id], placeholder: true, ...o });
      return cid;
    };
    const intros = [], cores = [], advs = [];
    for (let i = 0; i < nIntro; i++) {
      intros.push(mk(110 + i * 10, `${field} Foundations ${nIntro > 1 ? i + 1 : ""}`.trim(), {
        pre: [], off: "FWS", diff: Math.max(2, baseDiff - 2), demand: i === 0 ? "high" : "med",
      }));
    }
    for (let i = 0; i < nCore; i++) {
      cores.push(mk(210 + i * 10, `Core Topics in ${field} ${i + 1}`, {
        pre: [intros[i % nIntro]], off: "FW", diff: baseDiff - (i % 2 ? 1 : 0),
      }));
    }
    for (let i = 0; i < nAdv; i++) {
      const rare = i === nAdv - 1 && nAdv > 1;               // last advanced course = rarely offered
      advs.push(mk(310 + i * 10, `Advanced ${field} ${i + 1}`, {
        pre: i === 0 ? [cores[0]] : [cores[i % nCore], advs[i - 1]], // spine creates a critical path
        off: rare ? "F" : ((h + i) % 2 ? "F" : "W"), rare,
        diff: Math.min(10, baseDiff + (i % 2)), load: 1.1,
      }));
    }
    return {
      id, name, type, college: COLLEGES[collegeKey], credits, detailed: false,
      placeholderCourses: courses,
      buckets: [
        { id: `${id}-req`, name: `${field} Required Courses`, pick: { type: "all" }, options: [...intros, ...cores, ...advs] },
      ],
    };
  }

  /* ---------------------------------------------------------------
     REAL COURSE CATALOG MERGE
     CATALOG_DATA.courses (scraped: name, credits, seasons) is the base;
     hand-entered courses above contribute tuning the catalog can't know
     (difficulty, time-load, seat demand, test-out notes, prereq chains,
     tags for tag-based buckets). Hand-only pseudo-courses (GLOBAL XP)
     survive the merge.
     ---------------------------------------------------------------- */
  /* Difficulty 1-10 the catalog doesn't give us. Base is course LEVEL
     (1xx=3 … 5xx=7); quantitative / lab-science / engineering departments run
     genuinely harder at every level, so they get a bump. Without this every
     3xx reads 5 and every 4xx reads 6 — a whole semester of 400-level majors
     looked uniform and the "hard-stacking" guard (diff≥7) never fired. */
  const HARD_DEPT = /^(MATH|PHSCS|PHYS|CHEM|STAT|CS|ECEN|MEEN|CHEN|CEEN|MTHED|PHY S)$/;
  const MOD_HARD  = /^(ACC|FIN|ECON|BIO|CELL|MMBIO|PDBIO|PWS|NEURO|IT|IS|GSCM|MSE|BIOL)$/;
  function defaultDiff(code) {
    const m = code.match(/^([A-Z][A-Z& ]*?)\s*(\d)(\d{2})/);
    if (!m) return 4;
    const dept = m[1].replace(/\s+/g, "");        // "C S"->"CS", "EC EN"->"ECEN"
    const lvl = Number(m[2]);                      // 1..5
    let d = 2 + lvl;                               // 1xx=3 … 5xx=7
    if (HARD_DEPT.test(dept)) d += 1.5;
    else if (MOD_HARD.test(dept)) d += 0.5;
    return Math.max(1, Math.min(10, Math.round(d)));
  }
  if (HAVE_REAL) {
    const merged = {};
    for (const [code, e] of Object.entries(CATALOG_DATA.courses)) {
      const hand = C[code];
      merged[code] = {
        id: code, name: e.n || code, credits: e.c ?? 3,
        tags: hand?.tags || [],
        // real prereq chains from the catalog (requisitesSimple) win; the
        // hand-entered chains remain as fallback for courses without them
        pre: (e.p && e.p.length ? e.p : hand?.pre) || [],
        // concurrent-allowed prereqs (before-or-same term) and a hard minimum
        // academic year (senior-standing / capstone courses) from the catalog
        preCo: (e.pc && e.pc.length ? e.pc : hand?.preCo) || [],
        // catalog's human-readable prerequisite line (incl. non-course
        // requirements: standing, admission, instructor consent) for the card
        preText: e.pt || hand?.preText || null,
        minY: e.minY || hand?.minY || 0,
        // variable-credit max per term (CPSE 486R 1-12): lets the solver raise
        // per-term enrollment instead of laddering 12 one-credit semesters
        vmax: e.vx || hand?.vmax || 0,
        off: e.off || hand?.off || "FW",
        diff: hand?.diff ?? defaultDiff(code),
        load: hand?.load ?? 1.0,
        demand: hand?.demand || "med",
        rare: !!(e.rare || hand?.rare),
        testOut: hand?.testOut || null,
        repeatMax: hand?.repeatMax || (/R$/.test(code.trim()) ? 3 : 1),
        note: [e.note, hand?.note].filter(Boolean).join(" ") || null,
      };
    }
    for (const [code, hc] of Object.entries(C)) {
      if (!merged[code]) merged[code] = hc;       // pseudo-courses like GLOBAL XP
    }
    for (const k of Object.keys(C)) delete C[k];
    Object.assign(C, merged);
  }

  /* ---------------------------------------------------------------
     ASSEMBLED CATALOG
     Real parsed programs from CATALOG_DATA replace the old generated
     placeholder chains. Hand-detailed programs are kept where they encode
     structure the catalog can't express: the IS cohort blocks + integrated
     MISM track, and the Global Business Certificate (not in Coursedog).
     Placeholder generation remains only as a no-CATALOG_DATA fallback.
     ---------------------------------------------------------------- */
  const realPrograms = HAVE_REAL ? CATALOG_DATA.programs.map(p => ({
    ...p, detailed: true,
    college: p.college || "BYU",
  })) : [];

  // The hand IS programs replace the catalog IS record (they encode the cohort
  // blocks), but they must still inherit the catalog's flowchart/MAP placement
  // hints — incl. force-included precore (IS 110, MSB 180, GSCM 201/211) and
  // the year-4 business core (HRM 391, PSE 390, STRAT 392).
  if (HAVE_REAL) {
    const catIS = CATALOG_DATA.programs.find(p =>
      p.type === "major" && /^Information Systems \(BS\)$/.test(p.name));
    if (catIS && catIS.flowchartPlan) {
      IS_BS.flowchartPlan = catIS.flowchartPlan;
      IS_BS_MISM.flowchartPlan = catIS.flowchartPlan;
    }
    // MAP-first: the official IS MAP sheet drives the plain IS (BS) draft
    // (sheet placement outranks the hand cohort blocks where they disagree —
    // e.g. the 2025-26 sheet's fall/winter junior-core split). The integrated
    // MISM track deliberately does NOT take the sheet: its 5-year shape is
    // hand-designed and the undergrad sheet would fight the MISM year.
    if (catIS && catIS.mapPlan) IS_BS.mapPlan = catIS.mapPlan;
    if (catIS && catIS.admit) IS_BS.admit = catIS.admit;
  }

  const majors = HAVE_REAL
    ? [
        IS_BS_MISM, IS_BS,
        // real majors, minus the plain IS record (hand version has the
        // cohort blocks the catalog can't express)
        ...realPrograms.filter(p => p.type === "major" && !/^Information Systems/.test(p.name)),
      ].sort((a, b) => a.name.localeCompare(b.name))
    : [IS_BS_MISM, IS_BS, ...GENERIC_MAJORS.map(m => buildGenericProgram(m, "major"))]
        .sort((a, b) => a.name.localeCompare(b.name));

  const minors = HAVE_REAL
    ? realPrograms.filter(p => p.type === "minor").sort((a, b) => a.name.localeCompare(b.name))
    : [BALLROOM_MINOR, ...GENERIC_MINORS.map(m => buildGenericProgram(m, "minor"))]
        .sort((a, b) => a.name.localeCompare(b.name));

  const certs = HAVE_REAL
    ? [GLOBAL_BUS_CERT, ...realPrograms.filter(p => p.type === "cert")]
        .sort((a, b) => a.name.localeCompare(b.name))
    : [SPANISH_CERT, GLOBAL_BUS_CERT, ...GENERIC_CERTS.map(m => buildGenericProgram(m, "cert"))]
        .sort((a, b) => a.name.localeCompare(b.name));

  const programIndex = {};
  [...majors, ...minors, ...certs, UNIV_CORE].forEach(p => programIndex[p.id] = p);

  /* Courses commonly already completed — offered as quick chips in the wizard */
  const COMMON_COMPLETED = [
    "WRTG 150", "A HTG 100", "MATH 110", "IS 201", "ACC 200", "ECON 110", "STAT 121",
    "REL A 275", "REL C 225", "REL A 250", "REL C 200", "BIO 100", "PHSCS 100",
    "PSYCH 111", "HIST 201", "MUSIC 101", "SPAN 321",
  ];

  /* ---------------------------------------------------------------
     DEMO PROFILE — Jordan's dogfood scenario
     ---------------------------------------------------------------- */
  /* resolve demo program ids against whichever catalog is loaded */
  const byName = (list, re) => (list.find(p => re.test(p.name)) || {}).id;
  const DEMO_PROFILE = {
    name: "Jordan (demo)",
    majorId: "is-bs-mism",
    minorIds: [byName(minors, /^Ballroom/i), byName(minors, /^Spanish$/i)].filter(Boolean),
    certIds: ["gbc-cert"],
    completed: ["IS 201", "REL A 275", "REL C 225", "STAT 121", "SPAN 321", "MATH 110"],
    startTerm: { year: 2026, season: "F" },
    pins: { "IS 303": { year: 2027, season: "W" } },   // immovable: IS 303 in Winter 2027
    settings: {
      // 17 = the optimizer's Fall/Winter ceiling: terms TARGET <=16 credits
      // (scoring penalizes every credit above 16) but may reach 17 when that
      // keeps the plan inside the 8-10 semester shape — one 17-credit term
      // beats a whole extra semester. 18 (BYU's registration cap) needs the
      // student to raise this setting. Locked cohort envelopes may still
      // exceed it — they're a forced exception. Spring/Summer stay light.
      // fixed load policy (no user dials): every Fall/Winter targets 14-16
      // credits, 17 allowed when it saves a semester; MAP-sheet terms follow
      // their own printed totals even below 14
      maxCreditsFW: 17, minCreditsFW: 14, maxCreditsSpSu: 6,
      // The demo's 12-month lease makes Spring housing free, and the double
      // degree (IS+MISM + 2 minors + cert, ~174 cr) can't fit 10 Fall/Winter
      // terms at <=17 cr — so the demo opts INTO Spring terms: the cost dial
      // routes a couple of light, lease-covered Springs instead of stretching
      // to a 6th year. (New plans still default Spring/Summer OFF.)
      allowSpring: true, allowSummer: false,
      housing: "off-campus-12mo",                       // Alpine Village 12-month lease
      scholarshipFullTime: true,
      doubleCountCap: 15,
      religionPacing: true,
      horizonYears: 6,
    },
    weights: { speed: 6, cost: 8, risk: 7, load: 5, life: 6 },
  };

  const DEFAULT_PROFILE = {
    name: "My plan",
    majorId: null, minorIds: [], certIds: [],
    completed: [],
    startTerm: { year: 2026, season: "F" },
    pins: {},
    settings: { ...DEMO_PROFILE.settings, housing: "on-campus", allowSpring: false },
    weights: { speed: 5, cost: 5, risk: 5, load: 5, life: 5 },
  };

  /* ---------------------------------------------------------------
     CO-REQUISITES (concurrent enrollment) — must be taken the SAME term.
     AUTO-EXTRACTED by generate_data.py from each course's
     customFields.nonEnforcedPrerequisites (the 82 STRICT "Concurrent
     enrollment in X" cases — the 137 "X or concurrent" and 18 consent cases
     are deliberately excluded so they aren't wrongly rigid-blocked). The solver
     bundles a present co-req set into a same-term movable cohort, so the CH EN
     445 lab lands with its 436/476 lecture pair, AEROS 110 with AEROS 100, etc.
     HAND_COREQS below overrides/augments the auto data for edge cases.
     ---------------------------------------------------------------- */
  const HAND_COREQS = {};   // add manual { "LAB": ["PARTNER", ...] } entries here
  const COREQS = HAVE_REAL
    ? { ...(CATALOG_DATA.coreqs || {}), ...HAND_COREQS }
    : HAND_COREQS;

  return {
    courses: C,
    univCore: UNIV_CORE,
    majors, minors, certs, programIndex,
    commonCompleted: COMMON_COMPLETED,
    demoProfile: DEMO_PROFILE,
    defaultProfile: DEFAULT_PROFILE,
    colleges: COLLEGES,
    coreqs: COREQS,
  };
})();
