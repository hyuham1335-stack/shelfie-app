---
{
  "id": "02-cross-verify",
  "index": 2,
  "owner": "main",
  "approval": "none",
  "requires": [
    {"kind": "state", "pointer": "phases.01-plan.status", "equals": "passed"},
    {"kind": "file", "path": "${run.dir}/01_plan.md", "min_bytes": 200}
  ],
  "produces": [
    {"key": "verdict", "path": "${run.dir}/02_verdict.json", "kind": "json",
     "schema": "verdict"}
  ],
  "skip_when": "state.cross_verify.mode == \"skipped\"",
  "on_skip": {"status": "skipped", "grade": "PASS_WITH_GAPS",
              "gap": "cross_verify_unavailable"},
  "submit_checks": [
    {"id": "reviewer_not_main", "on_fail": 8},
    {"id": "source_quote_substring", "on_fail": 8},
    {"id": "critical_zero", "on_fail": 4}
  ],
  "gate": {"runner": "none"},
  "loop": {"counter": "xverify_return", "max": 1, "on_exceed": "escalate",
           "on_fail_return_to": "01-plan"},
  "allow": {"agents": []},
  "on_success": "03-implement"
}
---

## 목적

확정된 플랜 **전문**에 대한 최종 확인 1회.

01 의 매 라운드에서 이미 교차검증이 걸렸으므로 여기서 새 지적이 나오는 일은
드물다. 그럼에도 이 페이즈를 두는 이유는, 01 의 리뷰가 **회차마다 그때의 플랜**을
봤지 완성된 전문을 본 적이 없기 때문이다. 부분 편집으로 고쳐 온 문서는 부분끼리
모순될 수 있고, 그 모순은 전문을 한 번 읽어야 보인다.

## 진입 조건

- 01 이 `passed` 다
- `01_plan.md` 가 있다

교차검증기가 **primary 도 fallback 도 불가**하면 이 페이즈를 스킵한다. 단
스킵은 통과가 아니다 — 등급이 `PASS_WITH_GAPS` 로 내려가고 보고서에
"교차검증 없음"이 박힌다.

## 절차

1. 확정된 `01_plan.md` 전문을 교차검증기에 넘긴다.
2. 판정을 `02_verdict.json` 으로 받는다.
3. Critical 이 남아 있으면 01 로 되돌린다 — **왕복은 최대 1회**다.
4. 채택 여부를 `adopted[]` 에 남긴다. 지금 이것을 쓰는 페이즈는 없지만,
   나중에 필요해졌을 때 소급 생성할 수 없는 종류의 기록이다.

## 제출 형식

```json
{"reviewer":"xv","mode":"primary|fallback","status":"ok",
 "findings":[{"id":"F-1","severity":"critical|major|minor","category":"…",
              "title":"…","quote":"…","evidence":"…","suggestion":"…"}],
 "adopted":[{"id":"F-1","verdict":"accept|reject","reason":"…"}],
 "resolved_from_previous":[]}
```

`mode` 가 `fallback` 이면 그 사실이 상태와 보고서에 남는다. 폴백은 독립 관측이
약해진 것이고, 약해졌다는 사실이 드러나야 그 뒤의 판단이 정직해진다.

## 금지

- **플랜을 여기서 고치지 마라.** 이유: 이 페이즈는 판정만 한다. 고치는 것은 01 이고,
  되돌아가지 않고 여기서 고치면 01 의 커버리지 검사를 우회하게 된다
- **`reject` 에 이유를 비우지 마라.** 이유: 근거 없는 기각은 다음 런에서 같은
  지적을 다시 받는다
- **Critical 을 minor 로 내려 통과시키지 마라.** 이유: 심각도는 리뷰어의 것이고,
  옮겨 적는 쪽이 바꾸면 `.raw.md` 대조에서 잡힌다

## 실패 시

| 무엇 | 어떻게 |
|---|---|
| Critical 이 남았다 | exit 4 — 01 로 1회 되돌린다 |
| 두 번째 되돌림 | exit 7 → 에스컬레이션. 왕복 상한이 1이다 |
| 교차검증기 둘 다 불가 | 스킵 + 등급 `PASS_WITH_GAPS`. **조용히 통과가 아니다** |
