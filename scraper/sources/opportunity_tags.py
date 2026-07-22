"""Tag opportunity documents (study abroad, research grants, clubs) with the BYU
COLLEGES they're relevant to, so the RAG advisor can surface accurate
"opportunities for a <major> student" answers.

Opportunity docs are free text with no structured program/college field. Rather
than keyword-match verbose prose (which over-tags — a Greek myth trip is not
"engineering" just because the word appears), this uses the STRONGEST signal
available per source:
  - study abroad -> the actual COURSE CODES the program enrolls you in (a program
    that gives ARTHC / CL CV credit is Humanities), + Kennedy Center by nature.
  - research grants -> the explicit "College of X" named in the text.
  - clubs -> the club NAME only (titles are the reliable signal; the boilerplate
    body is identical across all 374 and says nothing).
Deliberately CONSERVATIVE: an ambiguous doc gets NO college (better an untagged
general opportunity than a wrong-major one).

Canonical colleges are shared on BOTH sides: opportunities are tagged with them,
and a student's major maps to them via the catalog's `course.college`, so
retrieval can line them up.
"""
from __future__ import annotations
import re
from collections import Counter
from typing import Dict, List

ENG = "Ira A. Fulton College of Engineering"
CPMS = "College of Computational, Mathematical, & Physical Sciences"
LIFE = "College of Life Sciences"
BUS = "Marriott School of Business"
HUM = "College of Humanities"
FHSS = "College of Family, Home, and Social Sciences"
EDU = "David O. McKay School of Education"
FAC = "College of Fine Arts and Communications"
NURS = "College of Nursing"
KENN = "Kennedy Center for International Studies"
REL = "Religious Education"
CANON_COLLEGES = [ENG, CPMS, LIFE, BUS, HUM, FHSS, EDU, FAC, NURS, KENN, REL]

_NORMALIZE = [
    (re.compile(r"engineering", re.I), ENG),
    (re.compile(r"computational|physical\s*&?\s*math|mathematical", re.I), CPMS),
    (re.compile(r"life scien", re.I), LIFE),
    (re.compile(r"business|marriott", re.I), BUS),
    (re.compile(r"humanities", re.I), HUM),
    (re.compile(r"family.*social|social scien|\bfhss\b", re.I), FHSS),
    (re.compile(r"education", re.I), EDU),
    (re.compile(r"fine arts|communication", re.I), FAC),
    (re.compile(r"nursing", re.I), NURS),
    (re.compile(r"kennedy|international", re.I), KENN),
    (re.compile(r"religious", re.I), REL),
]


def normalize_college(raw: str) -> str | None:
    for rx, canon in _NORMALIZE:
        if rx.search(raw or ""):
            return canon
    return None


def build_subject_college_map(courses: List[Dict]) -> Dict[str, str]:
    """subject code ("ARTHC", "EC EN") -> canonical college, from each course's
    OWN `_raw_summary.college` (authoritative — not the colleges of programs that
    merely require the subject)."""
    tmp: Dict[str, Counter] = {}
    for c in courses:
        rs = c.get("_raw_summary") or {}
        subj = rs.get("subjectCode") or c.get("subject")
        col = normalize_college(rs.get("college") or "")
        if subj and col:
            tmp.setdefault(str(subj).strip().upper(), Counter())[col] += 1
    return {s: cc.most_common(1)[0][0] for s, cc in tmp.items()}


# subject-code token immediately before a 3-digit catalog number
_CODE_RE = re.compile(r"\b([A-Z][A-Z&]{1,5}(?:\s[A-Z&]{1,4})?)\s+\d{3}[A-Z]?R?\b")

# club NAME -> college (titles only; conservative). No match -> general/social club.
_NAME_KW = [
    (ENG, r"engineer|robotic|\brocket|\bSAE\b|aerospace|\bBEAM\b|\bAIAA\b|mechatron"),
    (CPMS, r"computer|coding|\bcode\b|software|data scien|\bA\.?I\.?\b|machine learning|"
           r"cyber|\bACM\b|physics|astronom|\bmath\b|actuarial|statistic|blockchain"),
    (LIFE, r"pre-?med|pre-?dent|pre-?vet|medic|health|nursing club|neuro|biolog|"
           r"anatomy|nutrition|dietet|wildlife|\bMEDLIFE\b|premedical|dental"),
    (BUS, r"business|account|finance|\bMBA\b|entrepreneur|market|invest|consult|"
          r"supply chain|econ|\bDECA\b|real estate|\bVC\b|venture"),
    (HUM, r"language|linguist|literature|\bfrench\b|\bspanish\b|\bgerman\b|\bchinese\b|"
          r"\bjapanese\b|\bkorean\b|\barabic\b|\brussian\b|\bitalian\b|philosoph|"
          r"editing|writing|debate|classic"),
    (FHSS, r"\bhistory\b|politic|\blaw\b|pre-?law|psycholog|sociolog|anthropolog|"
           r"\bmodel un\b|\bMUN\b|diploma|geograph|social work|criminolog|women"),
    (EDU, r"\bteach|educat|tutor|\bK-?12\b|literacy|future educators"),
    (FAC, r"\bart\b|\bmusic\b|\bchoir\b|a cappella|\bband\b|orchestra|theatre|theater|"
          r"\bdance\b|\bdesign\b|\bfilm\b|animation|photo|media|journalism|advertis|"
          r"\bPR\b|improv|acting|sculpt|paint"),
    (NURS, r"\bnursing\b|\bnurse"),
    (REL, r"\breligio|scriptur|missionary|\bgospel\b|latter-day|world religions|ministeri"),
]
_NAME_COMPILED = [(c, re.compile(p, re.I)) for c, p in _NAME_KW]


def college_tags(name: str, text: str, doc_type: str, subj2col: Dict[str, str]) -> List[str]:
    hits = set()
    if doc_type == "study_abroad":
        seg = text.split("Courses:", 1)
        hay = seg[1] if len(seg) > 1 else text
        for m in _CODE_RE.finditer(hay):
            subj = re.sub(r"\s+", " ", m.group(1)).strip()
            if subj in subj2col:
                hits.add(subj2col[subj])
        hits.add(KENN)                                  # all study abroad is international
    elif doc_type in ("opportunity", "research", "grant"):
        # research grants name the college explicitly ("College of Humanities")
        for rx, canon in _NORMALIZE:
            if rx.search(text) or rx.search(name):
                hits.add(canon)
    else:                                               # clubs & anything else: NAME only
        for c, rx in _NAME_COMPILED:
            if rx.search(name):
                hits.add(c)
    return [c for c in CANON_COLLEGES if c in hits]
