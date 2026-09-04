# -*- coding: utf-8 -*-
"""`07-pr-review` 의 판정 — 외부 리뷰를 읽고 내장 리뷰를 부를지 정한다.

**이 모듈이 막는 실패는 하나다** — "봇이 없으니 리뷰가 없었다"가 "통과"가
되는 것. 생략 조건이 `external.status == "reviewed"` 를 요구하고, 봇이 꺼져
있으면 그 값이 `disabled` 가 되어 **생략이 성립하지 않는다.** 리뷰가 빠지면
내장 리뷰가 대신 돌고, 그것도 못 하면 등급이 그 사실을 말한다.

판정이 결정론인 것도 요점이다. 모델이 `--effort` 를 고르면 같은 상황이
런마다 다른 리뷰를 받고, 그러면 `escaped_05`(05 가 놓쳐 07 에서 처음 잡힌
Critical/Major)를 세는 것이 정책의 근거가 되지 못한다.
"""

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
sys.path.insert(0, str(_HERE.parent))

import ledger  # noqa: E402
import verdict  # noqa: E402

# 닫힌 어휘. `timeout` 은 폴링이 상한에 닿은 것이고 `not_a_review` 는 뭔가
# 왔는데 리뷰의 구조가 아닌 것이다 — 둘 다 `reviewed` 가 아니다.
EXTERNAL_STATUS = ("reviewed", "disabled", "not_a_review", "timeout")

# 내장 리뷰의 effort. **`high` 는 없다** — 명세의 state 어휘가 셋뿐이다.
EFFORTS = ("skipped", "low", "medium")

# **미검증 상속값이다.** 5런에 1회의 비용으로 생략 정책의 근거를 산다 (§E2).
AUDIT_EVERY = 5


def audit_due(root):
    """이번이 감사 런인가. 런 디렉터리 수로 센다.

    `ledger.distinct_runs` 를 쓰지 않는 것이 의도다 — 그 함수는 **관측이
    있었던 런**을 세므로 지적 0건인 런이 빠진다. 감사 주기는 달력의 런이어야
    한다. 그러지 않으면 조용한 런이 이어질수록 감사가 영영 안 온다.
    """
    d = Path(root) / "_workspace" / "runs"
    if not d.exists():
        return False
    n = len([p for p in d.iterdir() if p.is_dir()])
    return n > 0 and n % AUDIT_EVERY == 0


def _has_review_structure(payload):
    """리뷰의 **구조**가 있는가. 헤딩 텍스트로 판정하지 않는다.

    봇의 출력 언어에 의존하지 않으려는 것이다 — 한국어 봇과 영어 봇이 같은
    판정을 받아야 한다. 구조는 셋 중 하나다: 명시된 status · findings 배열 ·
    변경 요청 플래그.
    """
    if not isinstance(payload, dict):
        return False
    if payload.get("status") in EXTERNAL_STATUS:
        return True
    if isinstance(payload.get("findings"), list):
        return True
    return "change_requested" in payload


def normalize_external(payload):
    """외부 리뷰를 05 와 **같은 finding 스키마**로 정규화한다.

    두 규칙이 여기 있다:

    1. **심각도를 못 가르면 Major 로 낙하한다.** 모르는 것이 괜찮은 것이 되면
       안 된다 (§E1). 생략하지 않는 방향으로 떨어뜨린다.
    2. **사람 코멘트는 수리 대상이 아니라 보고 대상이다.** 파이프라인이 사람과
       논쟁하지 않는다 — findings 에서 빼고 따로 담는다.
    """
    if not _has_review_structure(payload):
        return {"status": "not_a_review", "major": 0, "findings": [],
                "human_comments": [], "change_requested": False,
                "note": "구조를 찾지 못했다 — 리뷰 상태·findings·변경 요청 중 "
                        "아무것도 없다. 봇이 무언가 쓴 것은 리뷰가 아니다."}

    status = payload.get("status") or "reviewed"
    findings, humans = [], []
    for f in payload.get("findings") or []:
        if f.get("source") == "human":
            humans.append(f)
            continue
        sev = f.get("severity")
        if sev not in verdict.SEVERITIES:
            f = dict(f, severity="major",
                     severity_inferred=True,
                     evidence=(f.get("evidence") or "")
                     + " [심각도를 가르지 못해 Major 로 보수 판정했다]")
        findings.append(f)

    # **봇이 신고한 숫자를 믿지 않고 구조에서 센다.** 모델과 외부 도구의
    # 자진 신고 중 기계로 확인 가능한 것은 기계로 확인한다 (불변식 8).
    major = sum(1 for f in findings
                if f.get("severity") in ("critical", "major"))
    return {"status": status, "major": major, "findings": findings,
            "human_comments": humans,
            "change_requested": bool(payload.get("change_requested")),
            "note": None}


def decide(state, external, config, audit=False):
    """생략 조건과 effort. **명세 §3.7 의 코드블록을 그대로 옮긴 것이다.**

    반환: {"skip", "effort", "audit_run", "reasons", "gaps"}

    **gap 기록은 effort 분기와 독립이다.** 둘을 한 if/elif 사슬에 엮으면
    먼저 걸린 분기가 뒤 분기의 gap 을 삼킨다 — 05 가 degraded 이고 외부가
    disabled 인 런에서 결손 둘 중 하나만 보고서에 남았다 (G-5). 분기 순서를
    바꾸는 것은 고치는 것이 아니라 **구멍을 옮기는 것**이다.
    """
    r05 = state.get("review05") or {}
    profile = ((state.get("profile") or {}).get("id")
               or (state.get("profile") or {}).get("name") or "normal")
    reviewed = external.get("status") == "reviewed"

    # **`small` 은 Major 가 있어도 생략한다** — 명세가 그렇게 정했다. 작은
    # 변경이고 외부가 실제로 봤다면 내장 리뷰를 또 태우지 않는다는 판단이고,
    # 놀라운 규칙이라 여기 적어 둔다. 그 판단이 틀렸다면 `escaped_05` 가
    # 감사 런에서 그것을 드러낸다.
    skip = ((profile == "small" and reviewed)
            or (r05.get("status") == "ok" and reviewed
                and (r05.get("major") or 0) == 0
                and (external.get("major") or 0) == 0))

    # 결손은 **각각** 센다. 무엇이 빠졌는지가 등급과 보고서의 재료다.
    gaps = []
    if r05.get("status") != "ok":
        gaps.append("review05:%s" % r05.get("status"))
    if not reviewed:
        gaps.append("external:%s" % external.get("status"))

    reasons = []
    if r05.get("status") != "ok":
        effort = "medium"
        skip = False
        reasons.append("05 가 `%s` 다 — 리뷰 결손을 비싼 쪽으로 메운다."
                       % r05.get("status"))
    elif not reviewed:
        effort = "low"
        skip = False
        reasons.append("외부 리뷰가 `%s` 다 — 생략 조건이 `reviewed` 를 "
                       "요구하므로 성립하지 않는다." % external.get("status"))
    elif skip:
        effort = "skipped"
        reasons.append("05 가 ok 이고 외부가 reviewed 이며 양쪽 Major 가 0 이다.")
    else:
        effort = "low"
        reasons.append("생략 조건을 만족하지 않는다 — Major 가 남아 있다.")

    if audit:
        # 생략하면 escaped_05 를 셀 수 없다. 그래서 5런에 1회는 강제한다.
        skip = False
        effort = "medium"
        reasons.append("**감사 런이다** — 생략 조건을 만족해도 medium 을 "
                       "강제한다. 생략하면 `escaped_05` 를 셀 수 없고, 그러면 "
                       "생략 정책의 근거가 사라진다 (§E2).")

    return {"skip": skip, "effort": effort, "audit_run": bool(audit),
            "reasons": reasons, "gaps": gaps}


def escaped(root, findings, run_id):
    """05 가 이미 낸 것을 뺀 나머지. **05 라우팅 품질의 지표다.**

    dedup 이 목적이 아니라 **세는 것**이 목적이다 — 여기서 처음 잡힌
    Critical/Major 가 05 의 리뷰어 라우팅이 놓친 것이다.
    """
    seen = set()
    for row in ledger.read_all(root):
        if row.get("_corrupt") or row.get("phase") != "05":
            continue
        if row.get("finding_key"):
            seen.add(row["finding_key"])

    fresh, dupes = [], 0
    for f in findings or []:
        key = ledger.finding_key(f)
        if key in seen:
            dupes += 1
            continue
        fresh.append(dict(f, finding_key=key))
    n = sum(1 for f in fresh if f.get("severity") in ("critical", "major"))
    return {"findings": fresh, "deduped": dupes, "escaped_05": n}
