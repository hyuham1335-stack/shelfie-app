---
{
  "id": "01-plan",
  "index": 1,
  "owner": "main",
  "approval": "none",
  "docs": ["${config.project.instruction_file}"],
  "requires": [
    {"kind": "file", "path": "${run.dir}/00_original_request.md", "min_bytes": 1,
     "sha256_pointer": "request.sha256"},
    {"kind": "adapter_stage", "steps": ["compile", "lint", "check", "scoped", "full"],
     "mode": "warn"}
  ],
  "produces": [
    {"key": "plan", "path": "${run.dir}/01_plan.md", "kind": "markdown",
     "min_bytes": 200, "must_contain": ["<!-- INTENT", "<!-- COVERAGE"],
     "unless": "state.profile.inv_skipped == true"}
  ],
  "review": {
    "parallel": true,
    "reviewers": [
      {"code": "plan", "kind": "internal",
       "raw": "${run.dir}/01_review_r{n}.raw.md",
       "json": "${run.dir}/01_review_r{n}.json"},
      {"code": "xv", "kind": "cross_verify",
       "raw": "${run.dir}/01_xverify_r{n}.raw.md",
       "json": "${run.dir}/01_xverify_r{n}.json"}
    ]
  },
  "converge": {
    "counter": "round",
    "max_by_profile": {"small": 3, "normal": 5},
    "one_round_allowed_when": "all_reviewers_non_fallback AND major_free",
    "focus_round_2": "불변식 커버리지 · 범위 밖 항목 · 인수 조건의 검증 가능성",
    "on_exceed": "escalate"
  },
  "submit_checks": [
    {"id": "reviewer_not_main", "on_fail": 8},
    {"id": "source_quote_substring", "on_fail": 8},
    {"id": "raw_json_severity_match", "on_fail": 8},
    {"id": "monotonicity", "on_fail": 8},
    {"id": "coverage_exact_once", "on_fail": 8},
    {"id": "plan_section_exists", "on_fail": 8},
    {"id": "coverage_reason_required", "on_fail": 8},
    {"id": "drift_score_zero", "on_fail": 4}
  ],
  "gate": {"runner": "none"},
  "loop": {"counter": "round", "max_by_profile": {"small": 3, "normal": 5},
           "stuck_after_identical": 2, "on_exceed": "escalate"},
  "allow": {"agents": []},
  "on_success": "02-cross-verify"
}
---

## 목적

원본 요청을 **의도로 동결**하고, 그 의도를 빠짐없이 덮는 플랜을 만든다.

동결이 결정론의 앵커다. 요청은 `init` 이 바이트 그대로 복사했고 sha256 이 박혀
있으므로, 이후 어느 페이즈도 "요청이 원래 이랬다"를 새로 지어낼 수 없다. 이
페이즈가 하는 일은 그 바이트를 **검증 가능한 불변식과 인수 조건으로 옮기는 것**이고,
옮기는 과정에서 무엇이 새어 나갔는지를 기계가 셀 수 있게 만드는 것이다.

산출물은 **`01_plan.md` 하나뿐이다.** 불변식·플랜·커버리지를 세 파일로 나누면
파일마다 제출 왕복이 붙는다.

## 진입 조건

- 동결된 요청 원문이 있고 sha256 이 상태의 것과 일치한다
- 어댑터가 선언한 스테이지들이 실재한다 (여기서는 **경고만** 한다 — 뒤 페이즈가
  파일을 고치므로 사전 검사는 예측이지 보장이 아니다. 04 진입 시 다시 강제한다)

## 절차

1. **요청을 읽는다.** 요약하지 말고 그대로 읽는다.
2. **불변식과 인수 조건을 뽑는다.** 각 항목에 `source_quote` 를 단다 —
   요청 원문의 **문자 단위 부분문자열**이어야 한다. 공백만 정규화한 뒤 포함 검사를
   하며, 통과하지 못하면 제출이 거부된다. 이것이 "없는 요구를 지어내거나 실제
   요구를 자기 말로 바꿔치기"를 막는 유일한 기계적 손잡이다.
3. **플랜 본문을 쓴다.** 절 제목은 자유이고, 커버리지가 그 제목을 참조한다.
4. **커버리지 표를 채운다.** 모든 불변식을 정확히 한 번씩 덮어야 하고,
   `covered` 가 아니면 `reason` 이 필수다.
5. **리뷰어 둘을 매 라운드 병렬로** 돌린다. 하나는 내부 플랜 리뷰어, 하나는 외부
   교차검증기다. 교차검증이 마지막이 아니라 매 라운드 걸린다.
6. 지적을 반영할 때 **플랜을 통째로 다시 쓰지 않는다.** 부분 편집으로 고친다 —
   전문이 라운드마다 다시 쌓이면 접두부가 라운드 수만큼 곱해진다.

### 산출물 형태

```markdown
<!-- INTENT
{"invariants":[{"id":"INV-1","kind":"must|must_not","text":"…",
                "source_quote":"요청 원문의 부분문자열"}],
 "out_of_scope":["…"],
 "acceptance":[{"id":"AC-1","text":"…","source_quote":"…"}]}
-->

# 플랜

…본문…

<!-- COVERAGE
{"covers":[{"id":"INV-1","status":"covered","plan_section":"§2 범위"}],
 "added_scope":[]}
-->
```

요청이 짧으면(`config.profile.inv_skip_below_chars` 미만) INV 블록을 생략한다.
한 문단짜리 요청에서 의도 이탈은 물리적으로 일어나기 어렵다.

## 제출 형식

리뷰어는 회차마다 **두 파일**을 낸다 — 출력 원문 `.raw.md` 와 구조화 `.json`.

```json
{"reviewer":"plan|xv","round":1,"mode":"primary|fallback",
 "findings":[{"id":"F-1","severity":"critical|major|minor","category":"…",
              "title":"…","quote":"raw 원문의 부분문자열","evidence":"…",
              "suggestion":"…"}],
 "resolved_from_previous":[{"id":"F-0","resolved_by":"…"}]}
```

`reviewer` 가 `main` 이면 거부된다. 작성자가 자기 글을 리뷰한 것은 독립 관측이 아니다.

## 금지

- **요청 원문 파일을 고치지 마라.** 이유: 그 바이트가 이 런의 유일한 앵커이고,
  sha256 이 어긋나면 모든 페이즈가 진입을 거부한다
- **`source_quote` 를 다듬지 마라.** 이유: 부분문자열 검증이 그 다듬기를 위조와
  구분하지 못한다. 원문이 어색해도 그대로 인용한다
- **플랜을 전체 재작성하지 마라.** 이유: 라운드마다 전문이 다시 쌓인다
- **리뷰어 지적을 조용히 없애지 마라.** 이유: 이전 회차에 열려 있던 지적은 이번에
  다시 나오거나 `resolved_from_previous` 에 해소 근거와 함께 있어야 한다.
  그냥 사라지면 제출이 거부된다

## 실패 시

| 무엇 | 어떻게 |
|---|---|
| `source_quote` 가 원문에 없다 | exit 8 — 해당 항목을 원문 그대로 고쳐 재제출 |
| 커버리지가 불변식을 빠뜨렸다 | exit 8 — 빠진 id 가 봉투에 나온다 |
| `drift_score > 0` | exit 4 — 이탈 항목이 원문 인용과 함께 나온다. 예산이 남아 있다 |
| 라운드 상한 초과 | exit 7 → 에스컬레이션. 미해결 Critical·Major 전문과 3지선다 |

**라운드 상한 3(small)/5(normal)과 `stuck_after_identical: 2` 는 미검증 상속값이다.**
이 리포의 실측이 아니라 물려받은 숫자이고, 첫 세 런의 원장이 이 값을 검사한다.
그때까지 값을 근거로 삼지 않는다.
