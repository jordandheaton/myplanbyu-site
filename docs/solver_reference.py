"""
myplanBYU — V2 backend reference architecture (NOT used by the live site).

The shipped V1 site is 100% client-side JavaScript (js/solver.js) because it
deploys as a static portfolio page and the problem size (~60 courses x ~24
terms) solves in milliseconds in the browser.

This file is the scale-up path: the same data model expressed as Python
dataclasses plus an OR-Tools CP-SAT skeleton that solves the identical
problem *optimally* (V1 hill-climbing is heuristic) and extends naturally to
section-level time conflicts, which V1 deliberately excludes.

Run:  pip install ortools   →   python solver_reference.py
"""

from __future__ import annotations
from dataclasses import dataclass, field
from ortools.sat.python import cp_model

# ---------------------------------------------------------------------------
# 1 · DATA MODEL — mirrors js/data.js
# ---------------------------------------------------------------------------

@dataclass
class Course:
    course_id: str
    name: str
    credit_hours: float
    tags: list[str] = field(default_factory=list)          # e.g. ["GE-Arts", "Fall-Only"]
    prerequisites: list[list[str]] = field(default_factory=list)  # AND of OR-groups
    offered_seasons: set[str] = field(default_factory=lambda: {"F", "W"})
    difficulty: float = 5.0            # historical 1-10
    load_factor: float = 1.0           # real time-cost multiplier (labs, writing, rehearsals)
    demand: str = "med"                # seat pressure: low | med | high
    rarely_offered: bool = False
    test_out: str | None = None        # AP/CLEP/challenge-exam note


@dataclass
class RequirementBucket:
    """Placeholder architecture: requirements are buckets filled by tagged
    courses, NOT hardcoded course lists. 'all' pins an exact set; 'credits'
    and 'courses' choose from options/tags at solve time."""
    bucket_id: str
    bucket_name: str
    pick_type: str                     # "all" | "credits" | "courses"
    amount: int                        # credit minimum or course count (ignored for "all")
    target_tags: list[str] = field(default_factory=list)
    explicit_options: list[str] = field(default_factory=list)
    cohort_block: str | None = None    # e.g. "IS-JCORE-F": all members share one term
    per_course_max_credits: int | None = None


@dataclass
class Program:
    program_id: str
    program_name: str
    program_type: str                  # "major" | "minor" | "cert" | "core"
    buckets: list[RequirementBucket] = field(default_factory=list)


@dataclass
class Term:
    term_id: int
    season: str                        # F | W | S | U
    year: int
    max_credits: int
    min_full_time: int = 12            # scholarship floor for F/W
    enabled: bool = True


@dataclass
class UserProfile:
    selected_major: str
    selected_minors: list[str]         # up to 2 (validated in the API layer)
    selected_certs: list[str]
    completed_courses: dict[str, str]  # course_id -> grade
    current_term: int
    housing_contract: str              # "on-campus" | "off-campus" | "off-campus-12mo"
    pins: dict[str, int] = field(default_factory=dict)      # course_id -> term_id
    weights: dict[str, int] = field(default_factory=lambda: dict(
        speed=5, cost=5, risk=5, load=5, life=5))            # 0-10 dials
    double_count_cap: int = 15         # university cap on shared credits


# ---------------------------------------------------------------------------
# 2 · CP-SAT SKELETON
# ---------------------------------------------------------------------------

def build_model(courses: dict[str, Course], buckets: list[RequirementBucket],
                terms: list[Term], profile: UserProfile) -> cp_model.CpModel:
    m = cp_model.CpModel()
    T = [t for t in terms if t.enabled]
    completed = set(profile.completed_courses)

    # --- decision vars -----------------------------------------------------
    # x[c, t] = 1 iff course c is taken in term t
    x = {(c, t.term_id): m.NewBoolVar(f"x_{c}_{t.term_id}")
         for c in courses for t in T if c not in completed
         if t.season in courses[c].offered_seasons}
    # taken[c] = 1 iff course c is scheduled at all (buckets choose courses!)
    taken = {c: m.NewBoolVar(f"taken_{c}") for c in courses if c not in completed}
    # fills[c, b] = 1 iff course c is credited to bucket b (double-count modeling)
    fills = {}

    for c in taken:
        slots = [x[k] for k in x if k[0] == c]
        m.Add(sum(slots) == 1).OnlyEnforceIf(taken[c])
        m.Add(sum(slots) == 0).OnlyEnforceIf(taken[c].Not())

    # --- HARD: bucket fulfilment (set-cover core) --------------------------
    for b in buckets:
        opts = [c for c in courses
                if c in b.explicit_options or set(courses[c].tags) & set(b.target_tags)]
        for c in opts:
            fills[c, b.bucket_id] = m.NewBoolVar(f"fills_{c}_{b.bucket_id}")
            if c in completed:
                continue                                   # completed fills free
            m.AddImplication(fills[c, b.bucket_id], taken[c])
        pool = [(c, courses[c].credit_hours) for c in opts]
        if b.pick_type == "all":
            for c in opts:
                if c not in completed:
                    m.Add(taken[c] == 1)
        elif b.pick_type == "credits":
            m.Add(sum(int(cr * 2) * fills[c, b.bucket_id] for c, cr in pool)
                  >= b.amount * 2)                          # x2: half-credit safe ints
        elif b.pick_type == "courses":
            m.Add(sum(fills[c, b.bucket_id] for c, _ in pool) >= b.amount)

    # --- HARD: global double-count cap -------------------------------------
    # A course double-counts when it fills 2+ buckets; cap total shared credits.
    over = []
    for c in courses:
        fb = [v for (cc, _), v in fills.items() if cc == c]
        if len(fb) > 1:
            dc = m.NewBoolVar(f"dc_{c}")
            m.Add(sum(fb) >= 2).OnlyEnforceIf(dc)
            m.Add(sum(fb) <= 1).OnlyEnforceIf(dc.Not())
            over.append((dc, courses[c].credit_hours))
    m.Add(sum(int(cr * 2) * v for v, cr in over) <= profile.double_count_cap * 2)

    # --- HARD: prerequisites (AND of OR-groups, strictly earlier term) -----
    for c, crs in courses.items():
        if c in completed:
            continue
        for group in crs.prerequisites:
            if any(g in completed for g in group):
                continue
            for t in T:
                if (c, t.term_id) not in x:
                    continue
                earlier = [x[g, u.term_id] for g in group for u in T
                           if u.term_id < t.term_id and (g, u.term_id) in x]
                m.Add(sum(earlier) >= 1).OnlyEnforceIf(x[c, t.term_id])

    # --- HARD: per-term credit window + cohort blocks + pins ---------------
    for t in T:
        load = sum(int(courses[c].credit_hours * 2) * x[c, t.term_id]
                   for c in taken if (c, t.term_id) in x)
        m.Add(load <= t.max_credits * 2)
        # full-time floor is conditional on "enrolled that term" — model with
        # an indicator var; omitted here for brevity.
    for b in buckets:
        if b.cohort_block:                                  # all members share one term
            members = [c for c in b.explicit_options if c not in completed]
            for t in T:
                for c1, c2 in zip(members, members[1:]):
                    if (c1, t.term_id) in x and (c2, t.term_id) in x:
                        m.Add(x[c1, t.term_id] == x[c2, t.term_id])
    for c, term_id in profile.pins.items():                 # e.g. IS 303 -> Winter 2027
        if (c, term_id) in x:
            m.Add(x[c, term_id] == 1)

    # --- SOFT: weighted multi-objective ------------------------------------
    w = profile.weights
    lease12 = profile.housing_contract == "off-campus-12mo"

    # Speed: minimize the latest used term (makespan)
    makespan = m.NewIntVar(0, len(T), "makespan")
    for (c, tid), var in x.items():
        m.Add(makespan >= tid).OnlyEnforceIf(var)

    # Cost: Sp/Su credits are extra tuition — but cheap housing-wise on a
    # 12-month lease; part-time F/W terms waste the flat 12-18cr band.
    spsu = sum(int(courses[c].credit_hours * 2) * v
               for (c, tid), v in x.items()
               if next(t for t in T if t.term_id == tid).season in "SU")
    cost_pen = spsu * (1 if lease12 else 4)                 # + part-time indicators

    # Risk: pairwise-stacking penalty for 3+ hard courses in one term
    risk_terms = []
    for t in T:
        hard = [x[c, t.term_id] for c in taken
                if courses[c].difficulty >= 7 and (c, t.term_id) in x]
        if len(hard) >= 3:
            over3 = m.NewIntVar(0, len(hard), f"hard_over_{t.term_id}")
            m.Add(over3 >= sum(hard) - 2)
            risk_terms.append(over3)

    # Load/Life: linearize |load_t - mean| with aux vars (omitted for brevity)

    m.Minimize(w["speed"] * 10 * makespan
               + w["cost"] * cost_pen
               + w["risk"] * 25 * sum(risk_terms))
    return m


# ---------------------------------------------------------------------------
# 3 · PLACEHOLDER vs STRICT-COURSE MODELING — the key architectural idea
# ---------------------------------------------------------------------------
# STRICT (brittle — breaks when the catalog changes):
#     arts_ge = ["MUSIC 101"]                    # hardcoded pick
#
# BUCKET (flexible — solver picks the best filler, double-counts allowed):
ARTS_GE = RequirementBucket(
    bucket_id="ge-arts", bucket_name="Arts GE",
    pick_type="credits", amount=3, target_tags=["GE-Arts"],
)
# DANCE 260 carries tags ["GE-Arts", "Ballroom-Minor-Theory"], so one 3-credit
# class can legally fill both buckets — and the global double_count_cap decides
# how much of that synergy the plan may exploit. New catalog year? Retag
# courses; every stored plan re-solves without code changes.

if __name__ == "__main__":
    print("Reference architecture — see build_model(). The live site runs js/solver.js.")
