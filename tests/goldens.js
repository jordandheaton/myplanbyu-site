/* =========================================================================
   myplanBYU — tests/goldens.js  (GENERATED — do not hand-edit)

   Recorded plan snapshots. Re-record with the "Record goldens" button in
   tests/index.html whenever a solver change is INTENDED to move courses,
   and read the diff in code review: the diff IS the change.

   recorded: 2026-08-07
   cases:    26
   ========================================================================= */
"use strict";

const GOLDENS = { "cases": {
  "accounting": {
   "termsUsed": 9, "courses": 46, "credits": 120,
   "score": 465.5, "doubleCounted": 11,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["A HTG 100", "ACC 200", "BUCKET::univ-core::rel-corner#1", "IS 110", "UNIV 101", "WRTG 150"],
    "Winter 2027": ["ACC 310", "BUCKET::univ-core::ge-global-cultural-awareness", "BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::rel-corner#2", "IS 201"],
    "Fall 2027": ["BUCKET::univ-core::rel-corner#3", "ELECTIVE 1", "FIN 201", "MKTG 201", "MSB 180", "STAT 121"],
    "Winter 2028": ["BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::ge-physical-science", "BUCKET::univ-core::rel-corner#4", "ECON 110", "M COM 320"],
    "Fall 2028": ["ACC 401", "ACC 403", "ACC 406", "ACC 408", "ACC 410", "BUCKET::univ-core::rel-elective#1"],
    "Winter 2029": ["ACC 402", "ACC 405", "ACC 407", "ACC 409", "ACC 411", "BUCKET::univ-core::rel-elective#2"],
    "Fall 2029": ["ACC 404", "BUCKET::univ-core::rel-elective#3", "FIN 402", "HRM 391", "MSB 571"],
    "Winter 2030": ["ACC 241", "ACC 504", "BUCKET::univ-core::ge-arts", "BUCKET::univ-core::ge-civilization-2", "STRAT 392"],
    "Fall 2030": ["BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::ge-letters"]
   }
  },
  "acting": {
   "termsUsed": 9, "courses": 55, "credits": 132,
   "score": 278.1, "doubleCounted": 11,
   "unscheduled": ["TMA 497"],
   "errorFlags": [
    "TMA 497 couldn't be scheduled (offered Fall only) — try enabling Spring/Summer, raising the credit cap, or extending the horizon."
   ],
   "plan": {
    "Fall 2026": ["BUCKET::univ-core::rel-corner#1", "BUCKET::univ-core::rel-elective#1", "TMA 122", "TMA 125", "TMA 128", "UNIV 101", "WRTG 150"],
    "Winter 2027": ["A HTG 100", "BUCKET::major-acting-bfa::acting-4-1", "BUCKET::univ-core::rel-corner#2", "TMA 115", "TMA 140", "TMA 228"],
    "Fall 2027": ["BUCKET::univ-core::ge-global-cultural-awareness", "BUCKET::univ-core::rel-elective#2", "TMA 102", "TMA 127", "TMA 201", "TMA 222", "TMA 223"],
    "Winter 2028": ["BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::rel-corner#3", "MDT 229", "TMA 202", "TMA 225", "TMA 260R", "TMA 267"],
    "Fall 2028": ["BUCKET::univ-core::ge-quantitative-reasoning", "BUCKET::univ-core::rel-elective#3", "TMA 224", "TMA 322", "TMA 324", "TMA 325"],
    "Winter 2029": ["BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::ge-physical-science", "TMA 240", "TMA 421", "TMA 422", "TMA 424"],
    "Fall 2029": ["BUCKET::major-acting-bfa::acting-6#1", "BUCKET::univ-core::ge-social-science", "TMA 114", "TMA 410", "TMA 427", "TMA 491"],
    "Winter 2030": ["BUCKET::major-acting-bfa::acting-6#2", "BUCKET::major-acting-bfa::acting-6#3", "BUCKET::major-acting-bfa::acting-6#4", "BUCKET::univ-core::ge-advanced-written-oral-communication", "BUCKET::univ-core::ge-letters"],
    "Fall 2030": ["BUCKET::major-acting-bfa::acting-6#5", "BUCKET::major-acting-bfa::acting-6-rem", "BUCKET::univ-core::rel-corner#4", "TMA 291", "TMA 428"]
   }
  },
  "actuarial": {
   "termsUsed": 8, "courses": 45, "credits": 120.5,
   "score": 145, "doubleCounted": 13,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["BUCKET::univ-core::rel-corner#1", "Data Ethics*", "MATH 112", "STAT 121", "STAT 130", "UNIV 101", "WRTG 150"],
    "Winter 2027": ["A HTG 100", "BUCKET::univ-core::rel-corner#2", "MATH 113", "STAT 240", "STAT 274"],
    "Fall 2027": ["BUCKET::univ-core::ge-arts", "BUCKET::univ-core::ge-global-cultural-awareness", "BUCKET::univ-core::rel-corner#3", "STAT 230", "STAT 250"],
    "Winter 2028": ["BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::ge-letters", "BUCKET::univ-core::rel-corner#4", "MATH 213", "MATH 215", "STAT 340"],
    "Fall 2028": ["BUCKET::major-actuarial-science-bs::actuarial-science-4", "BUCKET::univ-core::rel-elective#1", "ELECTIVE 1", "STAT 330", "STAT 344", "WRTG 316"],
    "Winter 2029": ["BUCKET::major-actuarial-science-bs::actuarial-science-7#1", "BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::rel-elective#2", "STAT 346", "STAT 390"],
    "Fall 2029": ["BUCKET::univ-core::ge-physical-science", "BUCKET::univ-core::ge-social-science", "BUCKET::univ-core::rel-elective#3", "ELECTIVE 5", "STAT 348"],
    "Winter 2030": ["BUCKET::major-actuarial-science-bs::actuarial-science-7#2", "ELECTIVE 2", "ELECTIVE 3", "ELECTIVE 4", "STAT 444"]
   }
  },
  "ah-half-pair": {
   "termsUsed": 8, "courses": 44, "credits": 117,
   "score": 396.7, "doubleCounted": 8,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["A HTG 100", "BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::ge-global-cultural-awareness", "BUCKET::univ-core::rel-corner#1", "UNIV 101", "WRTG 150"],
    "Winter 2027": ["ACC 200", "BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::rel-corner#2", "IS 110", "MKTG 201", "MSB 180"],
    "Fall 2027": ["BUCKET::univ-core::ge-arts", "BUCKET::univ-core::ge-physical-science", "BUCKET::univ-core::rel-corner#3", "FIN 201", "IS 201"],
    "Winter 2028": ["BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::rel-corner#4", "IS 303", "M COM 320", "STAT 121"],
    "Fall 2028": ["BUCKET::univ-core::rel-elective#1", "IS 402", "IS 403", "IS 404", "IS 415"],
    "Winter 2029": ["BUCKET::univ-core::rel-elective#2", "IS 401", "IS 413", "IS 414", "IS 455"],
    "Fall 2029": ["BUCKET::univ-core::ge-letters", "BUCKET::univ-core::rel-elective#3", "GSCM 201", "GSCM 211", "HRM 391", "MSB 390"],
    "Winter 2030": ["BUCKET::is-bs::information-systems-4", "ELECTIVE 1", "ELECTIVE 2", "IS 456", "STRAT 392"]
   }
  },
  "ah-pair-done": {
   "termsUsed": 8, "courses": 43, "credits": 114,
   "score": 392.2, "doubleCounted": 11,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["BUCKET::univ-core::ge-arts", "BUCKET::univ-core::ge-global-cultural-awareness", "BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::rel-corner#1", "UNIV 101", "WRTG 150"],
    "Winter 2027": ["ACC 200", "BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::ge-physical-science", "BUCKET::univ-core::rel-corner#2", "IS 110", "MKTG 201", "MSB 180"],
    "Fall 2027": ["BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::ge-letters", "BUCKET::univ-core::rel-corner#3", "FIN 201", "IS 201"],
    "Winter 2028": ["BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::rel-corner#4", "IS 303", "M COM 320", "STAT 121"],
    "Fall 2028": ["BUCKET::univ-core::rel-elective#1", "IS 402", "IS 403", "IS 404", "IS 415"],
    "Winter 2029": ["BUCKET::univ-core::rel-elective#2", "IS 401", "IS 413", "IS 414", "IS 455"],
    "Fall 2029": ["BUCKET::is-bs::information-systems-4", "BUCKET::univ-core::rel-elective#3", "GSCM 201", "GSCM 211", "HRM 391", "MSB 390"],
    "Winter 2030": ["ELECTIVE 1", "ELECTIVE 2", "IS 456", "STRAT 392"]
   }
  },
  "animation": {
   "termsUsed": 8, "courses": 46, "credits": 120,
   "score": 112.5, "doubleCounted": 8,
   "unscheduled": ["DESAN 363R"],
   "errorFlags": [
    "DESAN 363R couldn't be scheduled (offered Spring only) — try enabling Spring/Summer, raising the credit cap, or extending the horizon."
   ],
   "plan": {
    "Fall 2026": ["A HTG 100", "BUCKET::univ-core::ge-global-cultural-awareness", "BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::rel-corner#1", "CSANM 150#1", "DESAN 101", "UNIV 101"],
    "Winter 2027": ["BUCKET::univ-core::rel-elective#1", "C S 110", "CSANM 150#2", "DESAN 102", "TMA 102", "WRTG 150"],
    "Fall 2027": ["BUCKET::univ-core::ge-quantitative-reasoning", "BUCKET::univ-core::rel-corner#2", "CSANM 210", "CSANM 250", "DESAN 250R", "DESAN 262"],
    "Winter 2028": ["ARTHC 201", "BUCKET::major-animation-bfa::animation-4", "CSANM 258", "DESAN 265", "TMA 294"],
    "Fall 2028": ["ARTHC 202", "BUCKET::major-animation-bfa::animation-10-rem", "BUCKET::major-animation-bfa::animation-6", "BUCKET::major-animation-bfa::animation-7#1", "BUCKET::univ-core::rel-elective#2", "CSANM 354"],
    "Winter 2029": ["BUCKET::major-animation-bfa::animation-7#2", "BUCKET::major-animation-bfa::animation-9", "BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::rel-corner#3", "ELECTIVE 3"],
    "Fall 2029": ["BUCKET::univ-core::ge-physical-science", "BUCKET::univ-core::ge-social-science", "BUCKET::univ-core::rel-corner#4", "BUCKET::univ-core::rel-elective#3", "DESAN 460", "ELECTIVE 2"],
    "Winter 2030": ["BUCKET::univ-core::ge-advanced-written-oral-communication", "BUCKET::univ-core::ge-letters", "ELECTIVE 1", "ELECTIVE 4", "ELECTIVE 5"]
   }
  },
  "asian-studies": {
   "termsUsed": 8, "courses": 44, "credits": 120,
   "score": 72.5, "doubleCounted": 4,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::ge-quantitative-reasoning", "ELECTIVE 6", "UNIV 101", "WRTG 150"],
    "Winter 2027": ["A HTG 100", "BUCKET::major-asian-studies-ba::asian-studies-3", "BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::rel-elective#1", "REL C 200"],
    "Fall 2027": ["BUCKET::major-asian-studies-ba::asian-studies-5#1", "BUCKET::major-asian-studies-ba::asian-studies-6#4", "BUCKET::univ-core::ge-advanced-written-oral-communication", "BUCKET::univ-core::ge-civilization-1", "REL A 250"],
    "Winter 2028": ["BUCKET::major-asian-studies-ba::asian-studies-5#2", "BUCKET::major-asian-studies-ba::asian-studies-6#1", "BUCKET::major-asian-studies-ba::asian-studies-6#2", "BUCKET::univ-core::ge-arts", "BUCKET::univ-core::ge-letters", "BUCKET::univ-core::rel-elective#2"],
    "Fall 2028": ["BUCKET::major-asian-studies-ba::asian-studies-1::g1#1", "BUCKET::major-asian-studies-ba::asian-studies-1::g1#2", "BUCKET::major-asian-studies-ba::asian-studies-6#3", "BUCKET::univ-core::ge-physical-science", "BUCKET::univ-core::rel-elective#3"],
    "Winter 2029": ["ASIAN 200", "BUCKET::major-asian-studies-ba::asian-studies-1::g1#3", "BUCKET::major-asian-studies-ba::asian-studies-4", "BUCKET::major-asian-studies-ba::asian-studies-6#5", "ELECTIVE 1", "REL A 275"],
    "Fall 2029": ["ELECTIVE 2", "ELECTIVE 4", "ELECTIVE 5", "HIST 231", "REL C 225"],
    "Winter 2030": ["ASIAN 495", "ELECTIVE 3", "ELECTIVE 7", "ELECTIVE 8", "ELECTIVE 9", "IAS 300"]
   }
  },
  "chem-e": {
   "termsUsed": 9, "courses": 56, "credits": 139.5,
   "score": 500.4, "doubleCounted": 15,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["CH EN 170", "CH EN 191", "CHEM 111", "MATH 112", "UNIV 101", "WRTG 150"],
    "Winter 2027": ["A HTG 100", "BIO 100", "CHEM 112", "MATH 113", "PHSCS 121"],
    "Fall 2027": ["BUCKET::univ-core::rel-corner#1", "CH EN 263", "CH EN 273", "CH EN 291", "CHEM 357", "MATH 302", "STAT 201"],
    "Winter 2028": ["BUCKET::major-chemical-engineering-bs::chemical-engineering-4-1#1", "BUCKET::major-chemical-engineering-bs::chemical-engineering-4-1#2", "BUCKET::univ-core::rel-corner#2", "CH EN 285", "CH EN 311", "CH EN 374", "ECON 110", "MATH 303"],
    "Fall 2028": ["BUCKET::univ-core::rel-corner#3", "CH EN 345", "CH EN 378", "CH EN 386", "CH EN 391", "CH EN 467", "EC EN 301"],
    "Winter 2029": ["BUCKET::univ-core::ge-global-cultural-awareness", "BUCKET::univ-core::rel-corner#4", "BUCKET::univ-core::rel-elective#1", "CH EN 373", "CH EN 376", "CH EN 385", "ENGL 316"],
    "Fall 2029": ["BUCKET::major-chemical-engineering-bs::chemical-engineering-4-3-rem", "BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::rel-elective#2", "CH EN 436", "CH EN 476", "CH EN 479"],
    "Winter 2030": ["BUCKET::major-chemical-engineering-bs::chemical-engineering-4-2#1", "BUCKET::major-chemical-engineering-bs::chemical-engineering-4-2#2", "BUCKET::major-chemical-engineering-bs::chemical-engineering-4-2-rem", "BUCKET::univ-core::rel-elective#3", "CH EN 451"],
    "Fall 2030": ["CH EN 445", "CHEM 351", "CHEM 467", "STAT 121", "WRTG 316"]
   }
  },
  "cs": {
   "termsUsed": 8, "courses": 44, "credits": 120,
   "score": 258.6, "doubleCounted": 12,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["A HTG 100", "BUCKET::univ-core::rel-corner#1", "C S 111", "C S 191", "MATH 112", "UNIV 101"],
    "Winter 2027": ["BUCKET::major-computer-science-bs::computer-science-4", "BUCKET::univ-core::rel-corner#2", "C S 235", "C S 260", "WRTG 150"],
    "Fall 2027": ["BUCKET::major-computer-science-bs::computer-science-3", "BUCKET::major-computer-science-bs::computer-science-5-rem", "BUCKET::univ-core::ge-arts", "BUCKET::univ-core::rel-corner#3", "C S 224", "C S 236", "C S 291"],
    "Winter 2028": ["BUCKET::univ-core::ge-letters", "BUCKET::univ-core::rel-corner#4", "C S 240", "C S 252", "MATH 213", "MATH 215"],
    "Fall 2028": ["BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::rel-elective#1", "C S 312", "C S 340", "WRTG 316"],
    "Winter 2029": ["BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::rel-elective#2", "C S 324", "C S 404"],
    "Fall 2029": ["BUCKET::major-computer-science-bs::computer-science-5#1", "BUCKET::major-computer-science-bs::computer-science-5#2", "BUCKET::univ-core::ge-social-science", "BUCKET::univ-core::rel-elective#3", "PHSCS 121"],
    "Winter 2030": ["BUCKET::major-computer-science-bs::computer-science-5#3", "BUCKET::major-computer-science-bs::computer-science-5#4", "BUCKET::major-computer-science-bs::computer-science-5#5", "BUCKET::univ-core::ge-global-cultural-awareness"]
   }
  },
  "elem-ed": {
   "termsUsed": 8, "courses": 45, "credits": 118,
   "score": 121.8, "doubleCounted": 11,
   "unscheduled": [],
   "errorFlags": [
    "This plan totals ~118 credits (completed + planned) — short of the 120 BYU requires to graduate. Add about 2 more credits: a minor, a certificate, or open electives."
   ],
   "plan": {
    "Fall 2026": ["A HTG 100", "BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::ge-quantitative-reasoning", "BUCKET::univ-core::rel-corner#1", "ELECTIVE 3", "UNIV 101"],
    "Winter 2027": ["BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::ge-physical-science", "BUCKET::univ-core::rel-corner#2", "WRTG 150"],
    "Fall 2027": ["ARTED 326", "BUCKET::univ-core::rel-corner#3", "BUCKET::univ-core::rel-elective#1", "EL ED 200", "MTHED 305", "PETE 169", "SFL 210"],
    "Winter 2028": ["BUCKET::univ-core::rel-corner#4", "CPSE 300", "EL ED 203", "EL ED 340", "ELECTIVE 1", "IP&T 371", "MTHED 306"],
    "Fall 2028": ["ECE 334", "EL ED 299R", "EL ED 310", "EL ED 333", "EL ED 445"],
    "Winter 2029": ["EL ED 399R", "EL ED 410", "EL ED 435", "EL ED 443", "EL ED 446", "EL ED 447"],
    "Fall 2029": ["BUCKET::major-elementary-education-bs::elementary-education-4", "BUCKET::univ-core::rel-elective#2", "EDLF 411"],
    "Winter 2030": ["BUCKET::univ-core::rel-elective#3", "ELECTIVE 2", "ELECTIVE 4", "ELECTIVE 5", "IP&T 372", "PETE 212"]
   }
  },
  "gen-studies-bus": {
   "termsUsed": 8, "courses": 45, "credits": 122,
   "score": 71.1, "doubleCounted": 6,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::ge-global-cultural-awareness", "BUCKET::univ-core::ge-letters", "IS 110", "STDEV 100", "WRTG 150"],
    "Winter 2027": ["A HTG 100", "ELECTIVE 4", "ELECTIVE 6", "IS 201", "REL C 200", "UNIV 101"],
    "Fall 2027": ["BUCKET::major-general-studies-business-bgs-bgs::general-studies-business-bgs-5", "BUCKET::major-general-studies-business-bgs-bgs::general-studies-business-bgs-6#1", "BUCKET::major-general-studies-business-bgs-bgs::general-studies-business-bgs-6#2", "BUCKET::univ-core::ge-arts", "BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::rel-elective#1"],
    "Winter 2028": ["ACC 200", "BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::ge-physical-science", "BUCKET::univ-core::rel-elective#2", "ELECTIVE 3"],
    "Fall 2028": ["BUCKET::univ-core::ge-languages-of-learning", "ELECTIVE 12", "ELECTIVE 2", "M COM 320", "MKTG 201", "REL A 250"],
    "Winter 2029": ["BUCKET::univ-core::ge-social-science", "ELECTIVE 1", "HRM 300", "MSB 360", "REL A 275", "REL C 225"],
    "Fall 2029": ["ELECTIVE 5", "ELECTIVE 7", "ELECTIVE 8", "ELECTIVE 9", "STDEV 490"],
    "Winter 2030": ["BUCKET::major-general-studies-business-bgs-bgs::general-studies-business-bgs-6#3", "BUCKET::univ-core::rel-elective#3", "ELECTIVE 10", "ELECTIVE 11", "ELECTIVE 13"]
   }
  },
  "is-fresh": {
   "termsUsed": 8, "courses": 45, "credits": 120,
   "score": 417.4, "doubleCounted": 11,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["A HTG 100", "BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::ge-global-cultural-awareness", "BUCKET::univ-core::rel-corner#1", "UNIV 101", "WRTG 150"],
    "Winter 2027": ["ACC 200", "BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::rel-corner#2", "IS 110", "MKTG 201", "MSB 180"],
    "Fall 2027": ["BUCKET::univ-core::ge-physical-science", "BUCKET::univ-core::rel-corner#3", "ECON 110", "FIN 201", "IS 201"],
    "Winter 2028": ["BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::rel-corner#4", "IS 303", "M COM 320", "STAT 121"],
    "Fall 2028": ["BUCKET::univ-core::rel-elective#1", "IS 402", "IS 403", "IS 404", "IS 415"],
    "Winter 2029": ["BUCKET::univ-core::rel-elective#2", "ELECTIVE 2", "IS 401", "IS 413", "IS 414", "IS 455"],
    "Fall 2029": ["BUCKET::univ-core::ge-arts", "BUCKET::univ-core::rel-elective#3", "GSCM 201", "GSCM 211", "HRM 391", "MSB 390"],
    "Winter 2030": ["BUCKET::is-bs::information-systems-4", "BUCKET::univ-core::ge-letters", "ELECTIVE 1", "IS 456", "STRAT 392"]
   }
  },
  "is-junior": {
   "termsUsed": 6, "courses": 31, "credits": 83,
   "score": 279.9, "doubleCounted": 3,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["BUCKET::univ-core::ge-arts", "BUCKET::univ-core::ge-letters", "BUCKET::univ-core::ge-physical-science", "ELECTIVE 1", "ELECTIVE 2"],
    "Winter 2027": ["BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::ge-global-cultural-awareness", "BUCKET::univ-core::rel-corner#1", "IS 303", "M COM 320", "MSB 180"],
    "Fall 2027": ["BUCKET::univ-core::rel-elective#1", "IS 402", "IS 403", "IS 404", "IS 415"],
    "Winter 2028": ["BUCKET::univ-core::rel-elective#2", "IS 401", "IS 413", "IS 414", "IS 455"],
    "Fall 2028": ["BUCKET::is-bs::information-systems-4", "BUCKET::univ-core::rel-elective#3", "GSCM 201", "GSCM 211", "HRM 391", "MSB 390"],
    "Winter 2029": ["BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::rel-corner#2", "IS 456", "STRAT 392"]
   }
  },
  "is-light-load": {
   "termsUsed": 9, "courses": 45, "credits": 120,
   "score": 477.9, "doubleCounted": 11,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["A HTG 100", "BUCKET::univ-core::ge-global-cultural-awareness", "BUCKET::univ-core::rel-corner#1", "MSB 180", "UNIV 101", "WRTG 150"],
    "Winter 2027": ["ACC 200", "BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::rel-corner#2", "IS 110", "MKTG 201"],
    "Fall 2027": ["BUCKET::univ-core::ge-physical-science", "BUCKET::univ-core::rel-corner#3", "ECON 110", "FIN 201", "IS 201"],
    "Winter 2028": ["BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::rel-corner#4", "IS 303", "M COM 320", "STAT 121"],
    "Fall 2028": ["BUCKET::univ-core::rel-elective#1", "IS 402", "IS 403", "IS 404", "IS 415"],
    "Winter 2029": ["BUCKET::univ-core::rel-elective#2", "IS 401", "IS 413", "IS 414", "IS 455"],
    "Fall 2029": ["BUCKET::univ-core::rel-elective#3", "ELECTIVE 2", "GSCM 201", "GSCM 211", "HRM 391", "MSB 390"],
    "Winter 2030": ["BUCKET::univ-core::ge-arts", "BUCKET::univ-core::ge-letters", "IS 456", "STRAT 392"],
    "Fall 2030": ["BUCKET::is-bs::information-systems-4", "BUCKET::univ-core::ge-civilization-1", "ELECTIVE 1"]
   }
  },
  "is-minor": {
   "termsUsed": 8, "courses": 46, "credits": 121,
   "score": 429.7, "doubleCounted": 11,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["A HTG 100", "BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::ge-global-cultural-awareness", "BUCKET::univ-core::rel-corner#1", "UNIV 101", "WRTG 150"],
    "Winter 2027": ["ACC 200", "BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::rel-corner#2", "IS 110", "MKTG 201", "MSB 180"],
    "Fall 2027": ["BUCKET::univ-core::ge-physical-science", "BUCKET::univ-core::rel-corner#3", "ECON 110", "FIN 201", "IS 201"],
    "Winter 2028": ["BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::rel-corner#4", "IS 303", "M COM 320", "STAT 121"],
    "Fall 2028": ["BUCKET::univ-core::rel-elective#1", "ELECTIVE 1", "IS 402", "IS 403", "IS 404", "IS 415"],
    "Winter 2029": ["BUCKET::univ-core::rel-elective#2", "IS 401", "IS 413", "IS 414", "IS 455"],
    "Fall 2029": ["BUCKET::minor-business::business-3", "BUCKET::univ-core::ge-arts", "BUCKET::univ-core::rel-elective#3", "GSCM 201", "GSCM 211", "HRM 391", "MSB 390"],
    "Winter 2030": ["BUCKET::is-bs::information-systems-4", "BUCKET::minor-business::business-2", "BUCKET::univ-core::ge-letters", "IS 456", "STRAT 392"]
   }
  },
  "is-mism-nomap": {
   "termsUsed": 10, "courses": 53, "credits": 144,
   "score": 190.3, "doubleCounted": 9,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["ACC 200", "ECON 110", "IS 110", "M COM 320", "UNIV 101", "WRTG 150"],
    "Winter 2027": ["BUCKET::univ-core::ge-global-cultural-awareness", "GSCM 201", "IS 201", "IS 303", "MSB 180", "STAT 121"],
    "Fall 2027": ["A HTG 100", "BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::rel-elective#1", "GSCM 211", "HRM 401", "REL C 200"],
    "Winter 2028": ["BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::ge-letters", "ELECTIVE 1", "FIN 201", "REL C 225"],
    "Fall 2028": ["IS 401", "IS 402", "IS 403", "IS 404", "IS 415"],
    "Winter 2029": ["BUCKET::univ-core::ge-arts", "IS 414", "IS 455", "IS 456", "REL A 250"],
    "Fall 2029": ["BUCKET::is-bs-mism::mism-elective#1", "BUCKET::univ-core::rel-elective#2", "HRM 391", "MKTG 201", "STRAT 392"],
    "Winter 2030": ["BUCKET::is-bs-mism::mism-elective#2", "BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::rel-elective#3", "ELECTIVE 2", "PSE 390"],
    "Fall 2030": ["BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::ge-physical-science", "IS 515", "IS 531", "IS 537"],
    "Winter 2031": ["BUCKET::is-bs-mism::is-senior", "IS 520", "IS 542", "IS 555", "REL A 275"]
   }
  },
  "is-sophomore": {
   "termsUsed": 8, "courses": 40, "credits": 106,
   "score": 421.4, "doubleCounted": 11,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["BUCKET::univ-core::ge-global-cultural-awareness", "BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::rel-corner#1", "ELECTIVE+ 0.1", "UNIV 101"],
    "Winter 2027": ["ACC 200", "BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::ge-physical-science", "BUCKET::univ-core::rel-corner#2", "IS 110", "MKTG 201", "MSB 180"],
    "Fall 2027": ["BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::ge-letters", "ECON 110", "FIN 201", "IS 201"],
    "Winter 2028": ["BUCKET::univ-core::ge-arts", "ELECTIVE 1", "IS 303", "M COM 320", "STAT 121"],
    "Fall 2028": ["BUCKET::univ-core::rel-elective#1", "IS 402", "IS 403", "IS 404", "IS 415"],
    "Winter 2029": ["BUCKET::univ-core::rel-elective#2", "IS 401", "IS 413", "IS 414", "IS 455"],
    "Fall 2029": ["BUCKET::is-bs::information-systems-4", "BUCKET::univ-core::rel-elective#3", "GSCM 201", "GSCM 211", "HRM 391", "MSB 390"],
    "Winter 2030": ["IS 456", "STRAT 392"]
   }
  },
  "is-stacked": {
   "termsUsed": 10, "courses": 56, "credits": 150.5,
   "score": 533.6, "doubleCounted": 14,
   "unscheduled": ["SPAN 320"],
   "errorFlags": [
    "SPAN 320 couldn't be scheduled (offered Fall only) — try enabling Spring/Summer, raising the credit cap, or extending the horizon."
   ],
   "plan": {
    "Fall 2026": ["A HTG 100", "BUCKET::gbc-cert::gbc-core#2", "BUCKET::univ-core::ge-global-cultural-awareness", "BUCKET::univ-core::rel-corner#1", "UNIV 101", "WRTG 150"],
    "Winter 2027": ["ACC 200", "BUCKET::minor-business::business-3", "BUCKET::univ-core::rel-corner#2", "IS 110", "MATH 112", "MKTG 201", "MSB 180"],
    "Fall 2027": ["BUCKET::univ-core::rel-corner#3", "ECON 110", "FIN 201", "IS 201", "MATH 113"],
    "Winter 2028": ["BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::rel-corner#4", "IS 303", "M COM 320", "STAT 121"],
    "Fall 2028": ["BUCKET::gbc-cert::gbc-experience", "BUCKET::univ-core::rel-elective#1", "IS 402", "IS 403", "IS 404", "IS 415"],
    "Winter 2029": ["BUCKET::univ-core::rel-elective#2", "IS 401", "IS 413", "IS 414", "IS 455"],
    "Fall 2029": ["BUCKET::minor-mathematics::mathematics-3", "BUCKET::minor-mathematics::mathematics-4-rem", "BUCKET::univ-core::rel-elective#3", "GSCM 201", "GSCM 211", "HRM 391", "MSB 390"],
    "Winter 2030": ["BUCKET::univ-core::ge-letters", "IS 456", "MATH 290", "SPAN 206", "STRAT 392"],
    "Fall 2030": ["BUCKET::is-bs::information-systems-4", "BUCKET::minor-business::business-2", "BUCKET::minor-mathematics::mathematics-4", "BUCKET::univ-core::ge-arts", "SPAN 321"],
    "Winter 2031": ["BUCKET::gbc-cert::gbc-core#1", "BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::ge-physical-science", "MATH 213"]
   }
  },
  "is-winter-start": {
   "termsUsed": 9, "courses": 46, "credits": 122,
   "score": 768.4, "doubleCounted": 11,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Winter 2027": ["BUCKET::univ-core::ge-arts", "BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::ge-letters", "ELECTIVE+ 0.1", "MSB 180"],
    "Fall 2027": ["A HTG 100", "BUCKET::univ-core::ge-global-cultural-awareness", "BUCKET::univ-core::rel-corner#1", "ELECTIVE 1", "UNIV 101", "WRTG 150"],
    "Winter 2028": ["ACC 200", "BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::rel-corner#2", "IS 110", "MKTG 201"],
    "Fall 2028": ["BUCKET::univ-core::ge-physical-science", "BUCKET::univ-core::rel-corner#3", "ECON 110", "FIN 201", "IS 201"],
    "Winter 2029": ["BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::rel-corner#4", "IS 303", "M COM 320", "STAT 121"],
    "Fall 2029": ["BUCKET::univ-core::rel-elective#1", "IS 402", "IS 403", "IS 404", "IS 415"],
    "Winter 2030": ["BUCKET::univ-core::rel-elective#2", "IS 401", "IS 413", "IS 414", "IS 455"],
    "Fall 2030": ["BUCKET::is-bs::information-systems-4", "BUCKET::univ-core::rel-elective#3", "GSCM 201", "GSCM 211", "HRM 391", "MSB 390"],
    "Winter 2031": ["ELECTIVE 2", "IS 456", "STRAT 392"]
   }
  },
  "is-year-round": {
   "termsUsed": 9, "courses": 45, "credits": 120,
   "score": 407.1, "doubleCounted": 11,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["A HTG 100", "BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::ge-global-cultural-awareness", "BUCKET::univ-core::rel-corner#1", "UNIV 101", "WRTG 150"],
    "Winter 2027": ["ACC 200", "BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::rel-corner#2", "IS 110", "MKTG 201", "MSB 180"],
    "Spring 2027": ["BUCKET::univ-core::ge-arts", "BUCKET::univ-core::ge-letters"],
    "Fall 2027": ["BUCKET::univ-core::ge-physical-science", "BUCKET::univ-core::rel-corner#3", "ECON 110", "FIN 201", "IS 201"],
    "Winter 2028": ["BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::rel-corner#4", "IS 303", "M COM 320", "STAT 121"],
    "Fall 2028": ["BUCKET::univ-core::rel-elective#1", "IS 402", "IS 403", "IS 404", "IS 415"],
    "Winter 2029": ["BUCKET::univ-core::rel-elective#2", "IS 401", "IS 413", "IS 414", "IS 455"],
    "Fall 2029": ["BUCKET::is-bs::information-systems-4", "BUCKET::univ-core::rel-elective#3", "GSCM 201", "GSCM 211", "HRM 391", "MSB 390"],
    "Winter 2030": ["ELECTIVE 1", "ELECTIVE 2", "IS 456", "STRAT 392"]
   }
  },
  "tester-mism": {
   "termsUsed": 4, "courses": 22, "credits": 57,
   "score": 281.8, "doubleCounted": 0,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["BUCKET::univ-core::rel-elective#1", "FREN 317", "HRM 401", "REL C 200", "STRAT 392", "UNIV 101"],
    "Winter 2027": ["A HTG 100", "BUCKET::univ-core::rel-elective#2", "HRM 391", "IHUM 202", "IS 456", "MSB 180"],
    "Fall 2027": ["BUCKET::univ-core::rel-elective#3", "ELECTIVE+ 4.1", "ELECTIVE+ 4.2", "ELECTIVE+ 4.3", "IS 515"],
    "Winter 2028": ["BUCKET::is-bs-mism::mism-elective", "IS 520", "IS 542", "IS 555", "PSE 390"]
   }
  },
  "mech-e": {
   "termsUsed": 9, "courses": 47, "credits": 138.5,
   "score": 417.4, "doubleCounted": 15,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["BUCKET::univ-core::rel-corner#1", "MATH 112", "ME EN 191", "PHSCS 121", "UNIV 101", "WRTG 150"],
    "Winter 2027": ["A HTG 100", "BUCKET::univ-core::rel-corner#2", "CHEM 105", "MATH 113", "ME EN 101"],
    "Fall 2027": ["BUCKET::major-mechanical-engineering-bs::mechanical-engineering-3", "BUCKET::univ-core::rel-corner#3", "CCE 203", "MATH 302", "ME EN 204", "PHSCS 123"],
    "Winter 2028": ["EC EN 301", "MATH 303", "ME EN 250", "ME EN 272", "ME EN 275"],
    "Fall 2028": ["BUCKET::univ-core::rel-corner#4", "ME EN 231", "ME EN 321", "ME EN 330", "ME EN 335", "ME EN 382"],
    "Winter 2029": ["BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::rel-elective#1", "ME EN 312", "ME EN 362", "ME EN 372", "WRTG 316"],
    "Fall 2029": ["BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::rel-elective#2", "CCE 102", "ME EN 340", "ME EN 475"],
    "Winter 2030": ["BUCKET::major-mechanical-engineering-bs::mechanical-engineering-9#3", "BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::rel-elective#3", "CCE 270", "ME EN 476"],
    "Fall 2030": ["BUCKET::major-mechanical-engineering-bs::mechanical-engineering-1", "BUCKET::major-mechanical-engineering-bs::mechanical-engineering-9#1", "BUCKET::major-mechanical-engineering-bs::mechanical-engineering-9#2"]
   }
  },
  "nursing": {
   "termsUsed": 10, "courses": 57, "credits": 139.5,
   "score": 280.9, "doubleCounted": 11,
   "unscheduled": ["NURS 404"],
   "errorFlags": [
    "NURS 404 couldn't be scheduled (offered Spring only) — try enabling Spring/Summer, raising the credit cap, or extending the horizon.",
    "Pinned course CHEM 285 sits before its prerequisites — move the prerequisites earlier or unpin it."
   ],
   "plan": {
    "Fall 2026": ["A HTG 100", "BUCKET::major-nursing-bs::nursing-1-3", "BUCKET::univ-core::rel-corner#1", "CHEM 101", "NDFS 100", "UNIV 101"],
    "Winter 2027": ["BUCKET::univ-core::ge-arts", "BUCKET::univ-core::rel-corner#2", "CELL 210", "CHEM 285", "WRTG 150"],
    "Fall 2027": ["BUCKET::univ-core::rel-corner#3", "MMBIO 221", "MMBIO 222", "NURS 288", "NURS 290", "NURS 294", "PDBIO 305"],
    "Winter 2028": ["NURS 292", "NURS 295", "NURS 296", "NURS 298", "NURS 300", "NURS 301", "STAT 121"],
    "Fall 2028": ["BUCKET::univ-core::rel-corner#4", "NURS 320", "NURS 341", "NURS 342", "NURS 348", "NURS 361", "NURS 362"],
    "Winter 2029": ["BUCKET::univ-core::rel-elective#1", "NURS 351", "NURS 352", "NURS 371", "NURS 372", "NURS 378", "NURS 403"],
    "Fall 2029": ["BUCKET::univ-core::rel-elective#2", "CELL 305", "NURS 461", "NURS 462", "NURS 471", "NURS 472", "NURS 478"],
    "Winter 2030": ["BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::rel-elective#3", "NURS 449", "NURS 491", "NURS 492"],
    "Fall 2030": ["BUCKET::univ-core::ge-advanced-written-oral-communication", "BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::ge-letters", "BUCKET::univ-core::ge-physical-science"],
    "Winter 2031": ["BUCKET::univ-core::ge-social-science"]
   }
  },
  "nursing-spring": {
   "termsUsed": 12, "courses": 58, "credits": 145.5,
   "score": 186.3, "doubleCounted": 11,
   "unscheduled": [],
   "errorFlags": [
    "Pinned course CHEM 285 sits before its prerequisites — move the prerequisites earlier or unpin it."
   ],
   "plan": {
    "Fall 2026": ["BUCKET::major-nursing-bs::nursing-1-3", "BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::rel-corner#1", "CHEM 101", "NDFS 100", "UNIV 101"],
    "Winter 2027": ["BUCKET::univ-core::ge-arts", "BUCKET::univ-core::rel-corner#2", "CELL 210", "CHEM 285", "WRTG 150"],
    "Spring 2027": ["BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::ge-physical-science"],
    "Summer 2027": ["BUCKET::univ-core::ge-letters", "BUCKET::univ-core::ge-social-science"],
    "Fall 2027": ["BUCKET::univ-core::rel-corner#3", "MMBIO 221", "MMBIO 222", "NURS 288", "NURS 290", "NURS 294", "PDBIO 305"],
    "Winter 2028": ["NURS 292", "NURS 295", "NURS 296", "NURS 298", "NURS 300", "NURS 301", "STAT 121"],
    "Spring 2028": ["NURS 404"],
    "Summer 2028": ["BUCKET::univ-core::ge-advanced-written-oral-communication", "BUCKET::univ-core::ge-civilization-1"],
    "Fall 2028": ["BUCKET::univ-core::rel-corner#4", "NURS 320", "NURS 341", "NURS 342", "NURS 348", "NURS 361", "NURS 362"],
    "Winter 2029": ["BUCKET::univ-core::rel-elective#1", "NURS 351", "NURS 352", "NURS 371", "NURS 372", "NURS 378", "NURS 403"],
    "Fall 2029": ["A HTG 100", "BUCKET::univ-core::rel-elective#2", "NURS 461", "NURS 462", "NURS 471", "NURS 472", "NURS 478"],
    "Winter 2030": ["BUCKET::univ-core::rel-elective#3", "CELL 305", "NURS 449", "NURS 491", "NURS 492"]
   }
  },
  "sped": {
   "termsUsed": 8, "courses": 44, "credits": 120,
   "score": 171.1, "doubleCounted": 2,
   "unscheduled": ["CPSE 463", "CPSE 470"],
   "errorFlags": [
    "CPSE 463 couldn't be scheduled (offered Spring only) — try enabling Spring/Summer, raising the credit cap, or extending the horizon.",
    "CPSE 470 couldn't be scheduled (offered Spring only) — try enabling Spring/Summer, raising the credit cap, or extending the horizon."
   ],
   "plan": {
    "Fall 2026": ["BUCKET::univ-core::ge-advanced-written-oral-communication", "BUCKET::univ-core::ge-quantitative-reasoning", "ELECTIVE 1", "ELECTIVE 3", "UNIV 101", "WRTG 150"],
    "Winter 2027": ["A HTG 100", "BUCKET::univ-core::ge-biological-science", "BUCKET::univ-core::ge-civilization-2", "ELECTIVE 2", "ELECTIVE 4", "REL C 200"],
    "Fall 2027": ["BUCKET::univ-core::ge-physical-science", "BUCKET::univ-core::ge-social-science", "BUCKET::univ-core::rel-elective#1", "CPSE 203", "MATH 110"],
    "Winter 2028": ["BUCKET::univ-core::ge-arts", "BUCKET::univ-core::ge-civilization-1", "BUCKET::univ-core::rel-elective#2", "CPSE 410", "MTHED 305", "REL C 225"],
    "Fall 2028": ["BUCKET::univ-core::ge-letters", "CPSE 420", "CPSE 425", "CPSE 487R#1", "REL A 250"],
    "Winter 2029": ["BUCKET::univ-core::rel-elective#3", "CPSE 430", "CPSE 440", "CPSE 447", "CPSE 487R#2", "REL A 275"],
    "Fall 2029": ["CPSE 443", "CPSE 453", "CPSE 467", "CPSE 480", "CPSE 487R#3"],
    "Winter 2030": ["BUCKET::univ-core::ge-languages-of-learning", "CPSE 460", "CPSE 462", "CPSE 487R#4", "MTHED 306"]
   }
  },
  "tax": {
   "termsUsed": 8, "courses": 46, "credits": 122,
   "score": 214.4, "doubleCounted": 9,
   "unscheduled": [],
   "errorFlags": [],
   "plan": {
    "Fall 2026": ["BUCKET::univ-core::ge-global-cultural-awareness", "BUCKET::univ-core::ge-languages-of-learning", "BUCKET::univ-core::rel-elective#1", "REL A 250", "UNIV 101", "WRTG 150"],
    "Winter 2027": ["ACC 200", "BUCKET::univ-core::ge-arts", "BUCKET::univ-core::ge-civilization-2", "BUCKET::univ-core::ge-physical-science", "ELECTIVE 4", "IS 110"],
    "Fall 2027": ["A HTG 100", "ACC 406", "BUCKET::univ-core::ge-civilization-1", "ELECTIVE 1", "IS 201", "REL C 200"],
    "Winter 2028": ["ACC 241", "BUCKET::univ-core::ge-letters", "ECON 110", "FIN 201", "MKTG 201"],
    "Fall 2028": ["ACC 401", "ACC 403", "ACC 407", "BUCKET::univ-core::ge-biological-science", "REL C 225"],
    "Winter 2029": ["ACC 310", "ACC 402", "ACC 405", "ACC 408", "BUCKET::univ-core::rel-elective#2", "M COM 320"],
    "Fall 2029": ["ACC 404", "ACC 410", "ELECTIVE 3", "HRM 540", "REL A 275", "STRAT 560"],
    "Winter 2030": ["ACC 409", "ACC 411", "BUCKET::univ-core::rel-elective#3", "ELECTIVE 2", "FIN 520", "MSB 571"]
   }
  }
} };
