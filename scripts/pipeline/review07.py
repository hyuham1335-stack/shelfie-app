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

import harness  # noqa: E402
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


def escaped(root, findings, run_id, previous_open=None):
    """05 가 이미 낸 것을 뺀 나머지. **05 라우팅 품질의 지표다.**

    dedup 이 목적이 아니라 **세는 것**이 목적이다 — 여기서 처음 잡힌
    Critical/Major 가 05 의 리뷰어 라우팅이 놓친 것이다.

    대조는 둘이다.

    ① **키 대조** — `finding_key = sha1(category|target_role|title)`. 07 이
       05 와 같은 이름을 붙였을 때만 맞는다. **승격 축(`rule_key`)이 아니라
       인스턴스 축이다** — 여기서 물어야 하는 것은 "같은 규칙인가" 가 아니라
       "05 가 이미 낸 바로 그 지적인가" 이고, 규칙으로 접으면 05 가 못 본
       새 인스턴스가 dupe 로 삼켜져 `escaped_05` 가 조용히 급락한다
       (ADR-H034 가 축을 갈라 둔 이유).
    ② **선언 대조** — 07 이 `reraised_from_previous` 로 05 의 열린 지적을
       가리키면 그것도 dupe 다. 키만 보면 **07 이 같은 결함에 다른 이름을
       붙였을 때 새 것으로 세고**, 그러면 지표가 05 를 실제보다 나쁘게 적는다
       (M48). M21 이 05 라운드 안에서 고친 것과 같은 어휘를 경계에 둔다.

    **자동 의미 dedup 이 아니다.** 07 이 선언하면 기계가 검증하는 것이고,
    선언하지 않으면 여전히 새 것으로 센다. 자동으로 하려면 모델 호출이 하나
    더 들고 그 비용의 근거가 아직 없다 — 보고서가 "선언 기반"임을 적는다.
    """
    seen = set()
    for row in ledger.read_all(root):
        if row.get("_corrupt") or row.get("phase") != "05":
            continue
        if row.get("finding_key"):
            seen.add(row["finding_key"])

    open_keys = {k.get("key") for k in (previous_open or []) if k.get("key")}

    fresh, dupes = [], 0
    for f in findings or []:
        key = ledger.finding_key(f)
        if key in seen or f.get("reraised_from_previous") in open_keys:
            dupes += 1
            continue
        fresh.append(dict(f, finding_key=key))
    n = sum(1 for f in fresh if f.get("severity") in ("critical", "major"))
    return {"findings": fresh, "deduped": dupes, "escaped_05": n}


def check_reraise(findings, previous_open):
    """[오류 문자열]. 열려 있지 않은 것을 가리키면 그것은 회계가 아니다.

    `verdict.check_review` 가 05 에서 하는 검사와 같은 형태다 — 가리킨 대상이
    실재해야 선언이 대조 가능한 사실이 된다.
    """
    open_keys = {k.get("key") for k in (previous_open or []) if k.get("key")}
    errors = []
    for f in findings or []:
        ref = f.get("reraised_from_previous")
        if ref and ref not in open_keys:
            errors.append(
                "finding %s: `reraised_from_previous` 가 05 의 열린 지적을 "
                "가리키지 않는다 (%r). 봉투의 「05 가 이미 낸 지적」 절에 있는 "
                "키만 쓸 수 있다 — 없는 것을 가리키면 dedup 이 검증되지 않는다."
                % (f.get("id"), ref))
    return errors


# 07 에서 수리하는 주체는 메인뿐이다 — 절차에 역할 호출이 없다 (§E7).
REPAIRED_BY = ("main",)


def check_resolution(root, findings, head_sha):
    """([오류], 확인 불가 여부). `repaired` 주장을 **git 으로 대조한다**.

    `_record_07` 이 `resolution="deferred"` 를 하드코딩해서, 메인이 실제로
    고친 지적도 `deferred` 로 굳었다 (M49). `deferred` 는
    `EXCLUDED_FROM_COUNT` 에 없으므로 **고쳐진 결함이 "반복되는 미해결" 로
    승격 집계에 학습된다** — P2 의 G-6 이 07 경로에서 재발한 것이다.

    그렇다고 자진 신고를 그대로 받지도 않는다. "고쳤다" 는 git 으로 확인
    가능하므로 확인한다(불변식 8) — 05 가 `closed` 를 단조성 검사로 검증한
    뒤에야 `repaired` 로 승계하는 것과 같은 규율이다.

    기준점(`pr.head_sha`)이 없으면 **대조가 불가능하다.** 그때는 주장을 받지
    않고(`deferred` 로 남긴다) 그 사실을 갭으로 드러낸다 — 확인할 수 없는
    것을 확인한 것처럼 적지 않는 것이 이 함수의 요점이다.
    """
    errors, unverified = [], False
    for f in findings or []:
        res = f.get("resolution")
        if res is not None and res not in ledger.RESOLUTIONS:
            errors.append("finding %s: `resolution` 이 어휘 밖이다 (%r) — %s"
                          % (f.get("id"), res, " · ".join(ledger.RESOLUTIONS)))
            continue
        if res != "repaired":
            continue
        by = f.get("repaired_by")
        if by not in REPAIRED_BY:
            errors.append(
                "finding %s: 07 에서 수리하는 주체는 %s 뿐이다 (받은 값: %r) — "
                "이 페이즈의 절차에 역할 호출이 없다"
                % (f.get("id"), " · ".join("`%s`" % r for r in REPAIRED_BY), by))
            continue
        path_ = f.get("path")
        if not path_:
            errors.append(
                "finding %s: `path` 없이 `repaired` 를 주장할 수 없다 — "
                "무엇이 고쳐졌는지 대조할 자리가 없다"
                % f.get("id"))
            continue
        if not head_sha:
            unverified = True
            continue
        if not _touched_since(root, head_sha, path_):
            errors.append(
                "finding %s: `repaired` 라는데 `%s` 를 건드린 변경이 PR push "
                "이후에 없다. 고친 뒤 커밋하고 다시 제출하거나, 안 고쳤으면 "
                "`deferred` 로 낸다 — 자진 신고 중 기계로 확인 가능한 것은 "
                "기계로 확인한다." % (f.get("id"), path_))
    return errors, unverified


def _touched_since(root, head_sha, path_):
    """커밋된 것과 워킹트리 둘 다 본다 — 아직 안 커밋한 수리도 수리다."""
    r = harness._git(root, "log", "--format=%H", "%s..HEAD" % head_sha,
                     "--", path_)
    if r is not None and r.returncode == 0 and r.stdout.strip():
        return True
    r = harness._git(root, "status", "--porcelain", "--", path_)
    return bool(r is not None and r.returncode == 0 and r.stdout.strip())
