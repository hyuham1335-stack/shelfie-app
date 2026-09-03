# -*- coding: utf-8 -*-
"""`promote` — 원장에 쌓인 지적을 규칙으로 올린다. **07 에서 런당 한 번.**

05 는 후보(`staged`)까지만 만들었다. 실제 쓰기를 07 로 미룬 이유가 둘이다 —
dedup 이 로직이 아니라 **시점**으로 성립하고, 기능 PR 의 diff 에 규칙 문서
변경이 섞이지 않는다.

네 플래그가 한 흐름이다:

- `--scan`  — 원장을 다시 집계한다. **후보가 0 이면 모델을 부르지 않고
  종결한다.** 초기 런에서는 이것이 최빈 경로다.
- `--stage` — 후보를 `state.promotions` 에 `staged` 로 적재한다.
- `--apply` — 판정(`verdict`)을 받아 실제로 쓴다.
- `--flush` — 08 진입 전 잔여 `staged` 를 강제 종결한다.

**"일단 붙이기" 를 선택지에서 없앤 것이 이 모듈의 설계 전부다.** 판정이
`duplicate` 면 `create` 가 금지되고, `contradicts` 면 자동 쓰기가 차단되며
에스컬레이션이다. 그리고 `lint` 승격은 **베이스라인 diff 를 반드시 남긴다** —
없으면 "규칙은 추가했는데 아무것도 안 막는다"가 조용히 통과한다.
"""

import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
sys.path.insert(0, str(_HERE.parent))

import ledger  # noqa: E402

# `promotions[].status` 의 닫힌 어휘. 05 는 `staged` 만 쓰고 07 이 나머지를 쓴다.
STATUSES = ("staged", "applied", "rejected", "skipped")

# 판정 어휘. `duplicate` 에서 `create` 가 금지되는 것이 요점이다.
JUDGEMENTS = ("new", "duplicate", "contradicts")
ACTIONS = ("create", "amend", "skip")

# **미검증 상속값이다.** 원본 명세에서 왔고 이 리포에서 재본 적이 없다.
# 첫 세 런의 원장이 이 값을 검사한다 — 매 런 상한에 닿으면 낮은 것이다.
CREATE_MAX_PER_RUN = 3


def scan(root):
    """원장을 다시 집계한다. `ledger.stage_promotions` 를 그대로 쓴다.

    **집계 파일을 두지 않고 매번 재계산한다** — 수백 줄 규모라 밀리초고,
    파생 파일을 두면 동기화 버그만 생긴다.
    """
    got = ledger.stage_promotions(root)
    got["needs_model"] = bool(got["candidates"])
    if not got["candidates"]:
        got["note"] = ("후보가 0 이다 — 모델을 부르지 않고 종결한다. "
                       "초기 런의 최빈 경로이고, 임계에 닿을 표본이 아직 없다는 "
                       "뜻이지 지적이 없었다는 뜻이 아니다.")
    return got


def stage(candidates):
    """후보를 `state.promotions` 모양으로 만든다. **전부 `staged` 다.**"""
    return [{"rule_id": c.get("rule") or c["category"].lower().replace("_", "-"),
             "finding_key": c["finding_key"],
             "category": c["category"],
             "enforceable": c.get("enforceable"),
             "severity": c["severity"],
             "count": c["count"],
             "distinct_runs": c["distinct_runs"],
             "status": "staged",
             "reason": None}
            for c in candidates]


def check_verdicts(root, verdicts, promotions=None):
    """판정을 검사한다. 반환: (errors, blocked).

    `blocked` 가 참이면 **자동 쓰기를 하지 않고 에스컬레이션**한다 — 규칙끼리
    싸우는 상태를 파이프라인이 혼자 정리하려 들면 안 된다.

    판정은 **어느 후보를 올리는지 가리켜야 한다** (`category`, 또는 원장의
    신원인 `finding_key`). `rule_id` 는 새로 짓는 목적지 이름이라 후보와 이름이
    다를 수 있고, 그것으로 매칭하면 엉뚱한 후보가 승격된다.
    """
    errors, blocked = [], False
    creates = 0
    for v in verdicts or []:
        if not _resolve_category(root, v, promotions):
            errors.append("%s: 어느 후보를 승격하는지 가리키지 않았다 — "
                          "`category` 또는 `finding_key` 가 필요하다."
                          % (v.get("rule_id") or "(이름 없음)"))
        j, a = v.get("judgement"), v.get("action")
        rid = v.get("rule_id") or "(이름 없음)"
        if j not in JUDGEMENTS:
            errors.append("%s: 알 수 없는 judgement %r (%s)"
                          % (rid, j, " · ".join(JUDGEMENTS)))
            continue
        if a not in ACTIONS:
            errors.append("%s: 알 수 없는 action %r (%s)"
                          % (rid, a, " · ".join(ACTIONS)))
            continue
        if j == "duplicate" and a == "create":
            errors.append("%s: judgement 가 duplicate 인데 action 이 create 다 — "
                          "같은 규칙이 두 벌 생긴다. skip 또는 amend 만 허용된다."
                          % rid)
        if j == "contradicts":
            blocked = True
        if a == "create":
            creates += 1
        code = _resolve_category(root, v, promotions)
        if code:
            try:
                ledger.check_destination(root, code, v.get("enforceable"))
            except ValueError as exc:
                errors.append("%s: %s" % (rid, exc))
    if creates > CREATE_MAX_PER_RUN:
        errors.append("이 런의 create 가 %d 건이다 — 상한 %d 를 넘는다. "
                      "**미검증 상속값이지만 넘는 것을 조용히 통과시키지는 "
                      "않는다.**" % (creates, CREATE_MAX_PER_RUN))
    return errors, blocked


def _resolve_category(root, v, promotions=None):
    """판정이 가리키는 category. 없으면 None.

    순서가 요점이다 — 명시된 `category` → 원장 신원(`finding_key`) → 목적지
    이름(`rule_id`) 이 taxonomy 의 `rule` 과 정확히 같을 때. 마지막은 기계
    강제 규칙에만 성립하고 `prose` 카테고리에는 `rule` 이 없다.
    """
    code = v.get("category")
    if code:
        return code
    fk = v.get("finding_key")
    if fk:
        for p in promotions or []:
            if p.get("finding_key") == fk:
                return p.get("category")
    rid = v.get("rule_id")
    for p in promotions or []:
        if p.get("rule_id") == rid:
            return p.get("category")
    for c, cat in ledger.categories(root).items():
        if cat.get("rule") and cat.get("rule") == rid:
            return c
    return None


def apply(root, run_id, promotions, verdicts):
    """판정대로 승격 상태를 정한다. 반환: (promotions, rows).

    **파일을 쓰기 전에 거절 사유를 먼저 정한다.** `lint` 승격에 베이스라인
    diff 가 없으면 여기서 `rejected` 이고, 규칙 파일은 손대지 않는다.
    """
    rows = []
    for v in verdicts or []:
        rid = v.get("rule_id")
        code = _resolve_category(root, v, promotions)
        target = None
        for p in promotions:
            if p.get("finding_key") and p["finding_key"] == v.get("finding_key"):
                target = p
                break
            if code and p.get("category") == code and p["status"] == "staged":
                target = p
                break
        if target is not None:
            # 목적지 이름은 판정이 짓는다 — 후보의 기본 이름을 덮어쓴다.
            target["rule_id"] = rid or target["rule_id"]
        if target is None:
            # 후보에 없는 규칙을 승격하려 한다 — 조용히 버리지 않고 skipped 로
            # 남긴다. 어디서 왔는지 모르는 규칙이 규칙 문서에 들어가지 않게.
            target = {"rule_id": rid, "finding_key": v.get("finding_key"),
                      "category": code,
                      "enforceable": v.get("enforceable"),
                      "severity": None, "count": 0, "distinct_runs": 0,
                      "status": "staged", "reason": None}
            promotions.append(target)

        if v.get("action") == "skip":
            target["status"] = "skipped"
            target["reason"] = v.get("rationale") or "판정이 skip 이다"
        elif (v.get("enforceable") == "lint"
              and not (v.get("baseline_diff") or "").strip()):
            target["status"] = "rejected"
            target["reason"] = ("lint 승격인데 베이스라인 diff 가 비어 있다 — "
                                "규칙은 추가했는데 아무것도 안 막는다는 뜻이다")
        else:
            target["status"] = "applied"
            target["reason"] = v.get("rationale")

        rows.append({
            "run_id": run_id, "rule_id": rid,
            "category": target.get("category"),
            "enforceable": v.get("enforceable"),
            "evidence": "%s회 / %s런" % (target.get("count"),
                                        target.get("distinct_runs")),
            "judgement": v.get("judgement"),
            "action": target["status"],
            "baseline_diff": (v.get("baseline_diff") or "").strip() or "없음",
            "retired_reason": v.get("retired_reason") or "",
        })
    return promotions, rows


def flush(promotions):
    """잔여 `staged` 를 종결한다. **08 은 미종결을 exit 6 으로 막는다.**

    종결 어휘는 `skipped` 다 — 승격하지 **않았다**는 사실이고, 실패(`rejected`)
    와 구분된다. 임계는 다시 충족되면 다음 런에서 또 후보가 된다.
    """
    n = 0
    for p in promotions or []:
        if p.get("status") == "staged":
            p["status"] = "skipped"
            p["reason"] = ("이 런에서 판정을 받지 못했다 — 임계가 다시 충족되면 "
                           "다음 런에서 재승격 후보가 된다")
            n += 1
    return n


def changelog_append(root, rows):
    """`rules_changelog.md` 에 줄을 더한다. 반환: 쓴 줄 수.

    표는 열 열 개다. 열 이름이 산문과 어긋나 있던 것을 여기서 맞춘다 —
    「철회 사유」가 산문에는 있고 표에는 없었다.
    """
    if not rows:
        return 0
    p = Path(root) / "docs" / "harness" / "pipeline" / "ledger" / "rules_changelog.md"
    if not p.exists():
        ledger.seed(root)
    text = p.read_text(encoding="utf-8")
    stamped = []
    for r in rows:
        stamped.append("| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
            _today(), r["run_id"], r["rule_id"], r["category"],
            r["enforceable"], r["evidence"], r["judgement"], r["action"],
            r["baseline_diff"].replace("|", "\\|")[:80],
            r["retired_reason"] or "-"))
    if not text.endswith("\n"):
        text += "\n"
    # §E4 — UTF-8 을 명시한다.
    p.write_text(text + "\n".join(stamped) + "\n", encoding="utf-8")
    return len(stamped)


def _today():
    import datetime
    return datetime.date.today().isoformat()


def applied_payload(run_id, promotions, rows, scanned):
    """`07_promo_applied.json`. 종결된 것만이 아니라 **전부**를 담는다."""
    return {"schema": 1, "run_id": run_id,
            "promotions": promotions,
            "changelog_rows": rows,
            "thresholds": scanned.get("thresholds"),
            "held": scanned.get("held") or [],
            "note": ("승격은 런당 한 번이고 별도 브랜치로 간다. 기능 PR 에 "
                     "규칙 변경을 섞지 않는다.")}
