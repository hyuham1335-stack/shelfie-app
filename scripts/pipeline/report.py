# -*- coding: utf-8 -*-
"""`08-report` — 런이 스스로에 대해 말하는 자리.

**08 은 diff 도 코드도 읽지 않는다.** 입력은 `08_report_data.json` 하나뿐이고
전문은 파일 경로로만 가리킨다. 이 제약이 보고서의 비용을 런 크기와 무관하게
만든다.

분업이 요점이다 — **표는 실행기가 조립하고 서술은 모델이 쓴다.** 특히 승격
규칙 목록은 원장에서 자동으로 나오므로 **모델이 빠뜨릴 수 없다.**

그리고 `## 캘리브레이션 상태` 가 필수 섹션인 이유가 이 리포에서 지금 그대로
성립한다 — `calibration.json` 이 `partial: true` 이고 어댑터가
`verified: false` 다. 보고서가 그것을 적지 않으면 런은 초록불로 끝나고 다음
런이 같은 미검증 값을 물려받는다.
"""

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
sys.path.insert(0, str(_HERE.parent))

REQUIRED_SECTIONS = ("## 완료 등급", "## 승격된 규칙", "## 건너뛴 게이트",
                     "## 비용과 시간", "## 캘리브레이션 상태")

# `gaps[]` 의 어휘. **명세가 열거형으로 주지 않았다** — 문서 전체에 흩어진
# `PASS_WITH_GAPS` 유발 사유를 여기 모은 것이고, 그 사실을 적어 둔다.
# 모아 두지 않으면 새 사유가 어휘 없이 들어가 보고서가 그것을 설명하지 못한다.
GAP_REASONS = {
    "stage_absent": "어댑터에 그 스테이지가 없다 (`cmd: null`)",
    "stage_not_touched": "그 스테이지가 볼 변경이 없었다",
    "adapter_unverified": "어댑터가 `verified: false` 다 — 실물로 완주한 적이 없다",
    "cross_verify_unavailable": "교차검증 primary·fallback 이 둘 다 불가였다",
    "review05": "05 의 리뷰어가 전부 또는 일부 실패했다",
    "external": "외부 PR 리뷰를 받지 못했다",
    "infra_skipped": "인프라 프로브 실패로 건너뛴 검증이 있다",
    "tests_not_ran": "테스트가 한 건도 돌지 않았다",
    "pr_closed": "PR 이 닫혔다 — 수리·코멘트를 하지 않았다",
    "pr_merged": "PR 이 이미 머지됐다 — 수리·코멘트를 하지 않았다",
    "local_only": "원격이 없어 로컬 커밋까지만 했다",
}


def explain_gap(gap):
    """gap 하나를 사람이 읽는 한 줄로. 모르는 것은 **모른다고 적는다.**"""
    head = str(gap).split(":")[0]
    known = GAP_REASONS.get(head)
    if known:
        return "`%s` — %s" % (gap, known)
    return "`%s` — 어휘에 없는 사유다 (보고서가 설명하지 못한다)" % gap


def _tbl(rows):
    """2열 표. 값이 없으면 **`미측정` 이라고 적는다** — 빈칸은 거짓말이다."""
    out = ["| 항목 | 값 |", "|---|---|"]
    for k, v in rows:
        out.append("| %s | %s |" % (k, "미측정" if v in (None, "") else v))
    return out


def build(state, data, calibration, promotions):
    """보고서 마크다운. 반환: (text, missing_sections).

    **필수 섹션이 빠져도 파이프라인을 실패시키지 않는다** — 원장에 기록만
    한다. 보고서가 런을 실패시키면, 보고서를 안 쓰는 것이 이득이 된다.
    """
    grade = state.get("grade") or "미정"
    gaps = state.get("gaps") or []
    narrative = (data.get("narrative") or {})
    budget = ((state.get("budget") or {}).get("model_calls") or {})
    tests = state.get("tests") or {}
    r05 = state.get("review05") or {}
    r07 = state.get("review07") or {}
    audit = state.get("audit") or {}

    lines = ["# 런 보고서 — %s" % state.get("run_id"), ""]
    lines += ["> 요청 슬러그: `%s`" % (state.get("slug") or "?"), ""]

    lines += ["## 완료 등급", "", "**%s**" % grade, ""]
    if gaps:
        lines.append("건너뛴 비차단을 아래 `## 건너뛴 게이트` 에 나열한다.")
    else:
        lines.append("건너뛴 비차단이 없다.")
    lines.append("")

    lines += ["## 승격된 규칙", ""]
    applied = [p for p in promotions or [] if p.get("status") == "applied"]
    if applied:
        lines += ["| 규칙 | category | 사유 |", "|---|---|---|"]
        lines += ["| `%s` | %s | %s |" % (p.get("rule_id"), p.get("category"),
                                          p.get("reason") or "-")
                  for p in applied]
    else:
        lines.append("이 런에서 승격된 규칙이 없다.")
    other = [p for p in promotions or [] if p.get("status") != "applied"]
    if other:
        lines += ["", "승격되지 않은 것 %d 건:" % len(other)]
        lines += ["- `%s` — **%s** · %s" % (p.get("rule_id"), p.get("status"),
                                            p.get("reason") or "사유 없음")
                  for p in other]
    lines.append("")

    lines += ["## 건너뛴 게이트", ""]
    if gaps:
        lines += ["- %s" % explain_gap(g) for g in gaps]
    else:
        lines.append("없다.")
    lines.append("")

    lines += ["## 비용과 시간", ""]
    lines += _tbl([
        ("모델 호출 수", "%s / %s%s" % (
            budget.get("total"), budget.get("max"),
            " (**근사** — 제출 수에서 유도한 값이다)"
            if budget.get("approx") else "")),
        ("라운드", (state.get("counters") or {}).get("round", {}).get("used")),
        ("수리", (state.get("counters") or {}).get("repair", {}).get("used")),
        ("테스트 실행 수", tests.get("ran")),
        ("테스트 상태", tests.get("status")),
    ])
    lines += ["", "**소요 시간은 미측정이다** — 8페이즈 실행기가 페이즈별 "
                  "소요를 아직 기록하지 않는다. 재는 것을 만들기 전에는 "
                  "값을 지어내지 않는다.", ""]

    lines += ["## 리뷰", ""]
    lines += _tbl([
        ("05 상태", r05.get("status")),
        ("05 리뷰어", "%s / %s" % (r05.get("reviewers_ok"),
                                   r05.get("reviewers_planned"))),
        ("검토 제외로 드롭", r05.get("dropped_by_enforcement")),
        ("절단됨", r05.get("truncated")),
        ("맥락 부족 요청", len(r05.get("need_more_context") or []) or 0),
        ("외부 리뷰", (r07.get("external") or {}).get("status")),
        ("내장 리뷰", r07.get("code_review")),
        ("escaped_05", r07.get("escaped_05")),
        ("감사 런", audit.get("is_audit_run")),
    ])
    lines.append("")

    lines += ["## 캘리브레이션 상태", ""]
    partial = calibration.get("partial")
    verified = calibration.get("adapter_verified")
    lines += _tbl([
        ("측정 시각", calibration.get("measured_at")),
        ("부분 측정(partial)", partial),
        ("어댑터 verified", verified),
    ])
    notes = []
    if partial:
        notes.append("**`partial: true` 다** — 옛 값을 쓰는 스테이지가 있고, "
                     "거기서 유도된 정책은 그만큼 오래된 것이다.")
    if verified is False:
        notes.append("**어댑터가 `verified: false` 다** — 실패 경로가 실물에서 "
                     "돈 적이 없다. 이 런의 초록불은 그만큼만 말한다.")
    lines += ([""] + ["- %s" % n for n in notes] if notes
              else ["", "- 캘리브레이션에 표시할 결손이 없다."])
    lines.append("")

    lines += ["## 서술", ""]
    if narrative:
        for k in ("문제", "원인", "해결", "결과", "배운 점"):
            if narrative.get(k):
                lines += ["### %s" % k, "", str(narrative[k]), ""]
        for k, v in narrative.items():
            if k not in ("문제", "원인", "해결", "결과", "배운 점") and v:
                lines += ["### %s" % k, "", str(v), ""]
    else:
        lines += ["_서술이 비어 있다. 표는 실행기가 조립했으므로 사실은 "
                  "남았지만, 왜 그랬는가는 이 런이 말하지 않았다._", ""]

    for k, head in (("contract_gaps", "계약이 어디서 부족했는가"),
                    ("review_scope", "05 리뷰 범위가 적절했는가"),
                    ("next_run", "다음 런에서 바꿀 것")):
        if data.get(k):
            lines += ["### %s" % head, "", str(data[k]), ""]

    text = "\n".join(lines)
    missing = [s for s in REQUIRED_SECTIONS if s not in text]
    return text, missing
