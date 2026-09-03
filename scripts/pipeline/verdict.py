#!/usr/bin/env python3
"""제출물 판정 — 01 의 의도 동결·커버리지·드리프트·수렴.

**순수 함수에 가깝게 쓴다.** 입력은 텍스트와 dict, 출력은 dict다. 파일을 읽는
곳은 리뷰어 원문 대조 한 군데뿐이고 그것도 경로가 아니라 텍스트를 받는다.

여기가 막는 것은 하나다 — **모델의 자진 신고 중 기계로 확인 가능한 것을
기계로 확인하지 않고 넘어가는 것.** "요구를 지켰다"는 인용의 부분문자열
검증으로, "리뷰했다"는 스키마와 원문 대조로, "고쳤다"는 단조성으로 확인한다.
"""

import hashlib
import json
import re

INTENT_RE = re.compile(r"<!--\s*INTENT\s*(.*?)-->", re.S)
COVERAGE_RE = re.compile(r"<!--\s*COVERAGE\s*(.*?)-->", re.S)
_WS = re.compile(r"\s+")

SEVERITIES = ("critical", "major", "minor")
BLOCKING = ("critical", "major")


def normalize_ws(text):
    """공백만 정규화한다. 그 밖은 건드리지 않는다 — 다듬기와 위조를 구분해야 한다."""
    return _WS.sub(" ", (text or "")).strip()


def parse_plan(text):
    """(intent|None, coverage|None, body). 블록이 없으면 None 이다."""
    intent = coverage = None
    m = INTENT_RE.search(text)
    if m:
        intent = json.loads(m.group(1))
    m2 = COVERAGE_RE.search(text)
    if m2:
        coverage = json.loads(m2.group(1))
    body = COVERAGE_RE.sub("", INTENT_RE.sub("", text))
    return intent, coverage, body


def check_plan(text, request_text, inv_skip_below_chars):
    """01 플랜 제출의 판정.

    반환: {"ok", "exit", "errors":[...], "drift_score", "drift":[...]}
    exit 8 은 스키마·정합성 위반(제출물), exit 4 는 드리프트(기계 판정 실패)다.
    """
    errors, drift = [], []
    try:
        intent, coverage, body = parse_plan(text)
    except ValueError as exc:
        return _fail(8, ["INTENT/COVERAGE 블록의 JSON 을 읽지 못했다: %s" % exc])

    if intent is None:
        # 짧은 요청은 블록을 생략할 수 있다. 한 문단짜리 요청에서 의도 이탈은
        # 물리적으로 일어나기 어렵다.
        if len(request_text) < (inv_skip_below_chars or 0):
            return {"ok": True, "exit": 0, "errors": [], "drift_score": 0,
                    "drift": [], "inv_skipped": True}
        return _fail(8, ["INTENT 블록이 없다. 요청이 %d자로 생략 임계값(%s)을 넘는다"
                         % (len(request_text), inv_skip_below_chars)])

    haystack = normalize_ws(request_text)
    items = list(intent.get("invariants") or []) + list(intent.get("acceptance") or [])
    for item in items:
        quote = item.get("source_quote")
        if not quote:
            errors.append("%s 에 source_quote 가 없다" % item.get("id"))
            continue
        if normalize_ws(quote) not in haystack:
            errors.append(
                "%s 의 source_quote 가 요청 원문에 없다: %r — 원문 그대로 인용한다"
                % (item.get("id"), quote[:60]))

    inv_ids = [i.get("id") for i in intent.get("invariants") or []]
    if coverage is None:
        errors.append("COVERAGE 블록이 없다")
    else:
        covers = coverage.get("covers") or []
        seen = {}
        for c in covers:
            seen[c.get("id")] = seen.get(c.get("id"), 0) + 1
        for iid in inv_ids:
            n = seen.get(iid, 0)
            if n == 0:
                errors.append("커버리지가 %s 를 빠뜨렸다" % iid)
            elif n > 1:
                errors.append("커버리지가 %s 를 %d번 덮는다 — 정확히 한 번이어야 한다"
                              % (iid, n))
        for c in covers:
            if c.get("id") not in inv_ids:
                errors.append("커버리지에 없는 불변식이 있다: %r" % c.get("id"))
                continue
            if c.get("status") == "covered":
                section = c.get("plan_section")
                if not section:
                    errors.append("%s 에 plan_section 이 없다" % c.get("id"))
                elif section not in body:
                    errors.append("%s 의 plan_section %r 이 본문에 없다"
                                  % (c.get("id"), section))
            else:
                if not c.get("reason"):
                    errors.append("%s 가 covered 가 아닌데 reason 이 없다" % c.get("id"))
                else:
                    kind = next((i.get("kind") for i in intent.get("invariants") or []
                                 if i.get("id") == c.get("id")), None)
                    drift.append({"id": c.get("id"), "status": c.get("status"),
                                  "reason": c.get("reason"), "kind": kind})

    if errors:
        return _fail(8, errors, drift_score=len(drift), drift=drift)
    if drift:
        return {"ok": False, "exit": 4, "errors": [], "drift_score": len(drift),
                "drift": drift}
    return {"ok": True, "exit": 0, "errors": [], "drift_score": 0, "drift": []}


def _fail(code, errors, drift_score=0, drift=None):
    return {"ok": False, "exit": code, "errors": errors,
            "drift_score": drift_score, "drift": drift or []}


# ----------------------------------------------------------------- 리뷰 판정

def finding_key(f):
    """같은 지적을 라운드를 가로질러 같은 것으로 센다."""
    raw = "|".join([str(f.get("category") or ""),
                    str(f.get("target_role") or ""),
                    normalize_ws(f.get("title") or "").lower()])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def check_review(payload, raw_text, previous_open):
    """리뷰어 제출의 판정. 반환: {"ok","exit","errors","keys","blocking"}"""
    errors = []
    reviewer = payload.get("reviewer")
    if not reviewer:
        errors.append("reviewer 가 없다")
    elif reviewer == "main":
        errors.append("reviewer 가 main 이다 — 작성자가 자기 글을 리뷰한 것은 "
                      "독립 관측이 아니다")

    findings = payload.get("findings") or []
    for f in findings:
        sev = f.get("severity")
        if sev not in SEVERITIES:
            errors.append("%s 의 severity 가 어휘 밖이다: %r" % (f.get("id"), sev))
        quote = f.get("quote")
        if quote and normalize_ws(quote) not in normalize_ws(raw_text):
            errors.append("%s 의 quote 가 리뷰어 원문에 없다 — 옮겨 적는 쪽이 "
                          "지어냈거나 바꿨다" % f.get("id"))

    # 원문의 심각도 헤딩 개수와 findings 개수가 맞아야 한다. 1라운드 수렴을
    # 허용하는 만큼 이 검사가 더 중요해진다.
    headings = sum(len(re.findall(r"(?mi)^#{1,6}\s*%s\b" % s, raw_text or ""))
                   for s in SEVERITIES)
    if headings != len(findings):
        errors.append("원문의 심각도 헤딩 %d개와 findings %d개가 맞지 않는다"
                      % (headings, len(findings)))

    keys = {finding_key(f) for f in findings}
    resolved = {r.get("id") for r in payload.get("resolved_from_previous") or []}
    resolved_keys = {r.get("key") for r in payload.get("resolved_from_previous") or []}

    # 재제기는 1급 어휘다. 제목이 지적의 신원이라 다듬은 제목으로 다시 올리면
    # 같은 지적이 "신규" 이자 동시에 "증발" 이 되어 한 번의 재제기가 두 곳에서
    # 오탐을 낸다. 리뷰어가 무엇을 다시 올리는지 말할 수 있게 한다.
    prev_by_id = {p["id"]: p for p in previous_open or []}
    reraised, carried = {}, set()
    for f in findings:
        src = f.get("reraised_from_previous")
        if not src:
            continue
        if src not in prev_by_id:
            errors.append(
                "%s 의 reraised_from_previous 가 열려 있는 이전 지적을 "
                "가리키지 않는다: %r — 없는 것을 가리키면 단조성 검사를 "
                "우회하는 구멍이 된다" % (f.get("id"), src))
            continue
        reraised[finding_key(f)] = src
        carried.add(src)

    for prev in previous_open or []:
        if (prev["key"] in keys or prev["key"] in resolved_keys
                or prev["id"] in resolved or prev["id"] in carried):
            continue
        errors.append(
            "이전 회차의 %s 가 이번 findings 에도 resolved_from_previous 에도 "
            "없다 — 지적이 조용히 증발했다" % prev["id"])

    if errors:
        return {"ok": False, "exit": 8, "errors": errors, "keys": [],
                "closed": [], "blocking": 0}
    blocking = sum(1 for f in findings if f.get("severity") in BLOCKING)
    closed = sorted({p["key"] for p in previous_open or []
                     if p["id"] in resolved or p["key"] in resolved_keys})
    return {"ok": True, "exit": 0, "errors": [],
            "keys": [{"key": finding_key(f), "id": f.get("id"),
                      "severity": f.get("severity"),
                      "reraised_from": reraised.get(finding_key(f))}
                     for f in findings],
            "closed": closed,
            "blocking": blocking}


def converged(round_no, submissions, previous_keys, drift_score):
    """(수렴했는가, 사유).

    1라운드 수렴은 **리뷰어 둘 다 폴백이 아니고 Major 이상 0건일 때만** 허용한다.
    독립 관측 두 개가 동시에 놓칠 확률이 한 관측을 두 번 돌리는 것보다 낮다는
    것이 근거이고, 폴백이 섞이면 그 전제가 약해진다.
    """
    if drift_score:
        return False, "드리프트가 남아 있다"
    blocking = sum(s["blocking"] for s in submissions)
    if blocking:
        return False, "Major 이상 %d건이 열려 있다" % blocking
    new = [k["key"] for s in submissions for k in s["keys"]
           if k["key"] not in (previous_keys or set())]
    if new:
        return False, "신규 지적 %d건" % len(new)
    if round_no == 1:
        if any(s.get("mode") == "fallback" for s in submissions):
            return False, ("폴백 리뷰어가 섞였다 — 1라운드 수렴을 허용하지 않는다. "
                           "2라운드를 돈다")
        return True, "리뷰어 둘 다 Major 이상 0건"
    return True, "신규 0건 · 열린 Major 이상 0건"
