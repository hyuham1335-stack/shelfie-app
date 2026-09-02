# Step 2: recommend-route — 라우트가 세션 진행 상태를 소비하고 실패를 이벤트로 남긴다

`src/app/api/recommend/route.ts` 파일 상단에 **"계약의 공백 두 곳 (문서 결정 사항 — 이 라우트에서 메우지 않는다)"** 이라는 주석 블록이 있다. 그 두 공백은 이제 메워졌다 — `/docs/API_SPEC.md`가 `retryIndex`·`irrelevantStreak`를 필수 필드로 규정했고, 앞 step 이 스키마와 클라이언트 배선을 끝냈다. **이 step 은 그 값을 실제로 쓰는 유일한 자리다.**

이 라우트는 이 프로젝트에서 계약이 가장 촘촘한 파일이다. 서명 검증 → 화이트리스트의 **순서**, 목록 밖 `bookId`의 처리, 실패 사유를 뭉개지 않는 규율(ADR-005)이 전부 여기 있다. **그중 어느 것도 이 step 이 바꾸지 않는다.**

## 읽어야 할 파일

- `/docs/API_SPEC.md` — `POST /api/recommend` 절 **전문**. 특히 `IRRELEVANT_MOOD` 판정 규칙 불릿(`irrelevantStreak >= 2`인 요청은 모델이 `relevant: false`를 내도 422 를 반환하지 않는다)과 실패 응답의 상태 코드 표
- `/docs/PRD.md` — 7번 이벤트 로그 표의 `mood_submitted`·`recommend_viewed`·`recommend_failed` 세 행과 "추천 실패는 `recommend_viewed`를 올리지 않는다" 불릿. US-003 의 AC 도 본다
- `/docs/ADR.md` — ADR-005(실패와 데이터 없음을 뭉개지 않는다) · ADR-006(서명) · ADR-003(무상태)
- `/docs/TRD.md` — TR-010(추천 라우트) · 6번(시간 예산·프롬프트 데이터 블록) · 비기능 요구사항의 관측성
- `src/app/api/recommend/route.ts` — **전문.** 파일 상단 주석 블록부터 `warnBurnedTokens`(345행 부근)까지
- `src/lib/analytics.ts` — 앞 step 이 추가한 `recommend_failed`
- `src/lib/schemas.ts` — 앞 step 이 넓힌 `recommendRequestSchema`
- `src/app/api/recommend/route.test.ts` — 기존 케이스 전부
- `src/app/api/analyze/route.ts` — `analyze_failed`를 남기는 자리와 `warnBurnedTokens` 대응물이 있는지

## 작업

### A. 상단 주석의 "계약의 공백 두 곳"을 지운다

지우기만 하지 말고 **지금의 계약을 서술로 남겨라.** 이 파일의 주석은 장식이 아니라 다음 사람이 읽는 설계 문서다. 새 서술이 담아야 할 것:

- 두 값은 요청에 실려 온다. 무상태라 서버가 셀 수 없기 때문이다 (ADR-003)
- **세는 것은 클라이언트, 판정하는 것은 서버다.** 판정까지 클라이언트에 맡기면 같은 규칙이 화면마다 다시 구현된다
- 두 값에 서명하지 않는 이유 (ADR-006 · API_SPEC) — 위조해도 얻는 것이 원래 허용된 동작 하나뿐이고, 상한은 스키마가 강제한다

### B. `irrelevantStreak >= 2`면 무관 판정을 무시한다

지금은 `outcome.relevant`가 `false`면 무조건 422 다. API_SPEC 이 정한 것은 이렇다 — **같은 세션에서 2회 연속 `false`가 나오면 판정을 무시하고 추천을 진행한다.** 오탐으로 사용자를 입력 화면에 가두는 것이 억지 추천 한 번보다 나쁘다 (US-003 AC).

```ts
if (!outcome.relevant && irrelevantStreak < IRRELEVANT_STREAK_LIMIT) {
  // 422 로 끊는다 (지금 동작)
}
// 그 밖에는 추천을 계속 진행한다
```

네 가지를 지켜라:

1. **무시할 때 모델을 다시 부르지 마라.** `outcome.picks`는 이미 손에 있다. 다시 부르면 같은 응답에 비용만 두 배가 된다
2. **화이트리스트 검증을 건너뛰지 마라.** 무관 판정을 무시하는 것과 목록 밖 책을 허용하는 것은 전혀 다른 문제다. `outsideAllowed` 이후의 경로는 그대로 통과해야 한다 — **목록 밖 책은 어떤 경로로도 사용자에게 도달하지 않는다**(FR-009, PRD 가드레일 0건)
3. **상한 숫자를 이름 있는 상수로 둬라.** 매직 넘버 `2`가 조건문에 박히면 계약이 코드에서 읽히지 않는다
4. **강행했다는 사실을 로그에 남겨라.** 이벤트가 아니라 `console.warn` 한 줄이면 된다 — 오탐률을 나중에 볼 수 있어야 한다. `mood` 원문은 절대 싣지 마라 (PRD 7번)

### C. `mood_submitted.retry_index`에 실제 값을 싣는다

161행 부근의 `retry_index: 0` 하드코딩을 요청의 `retryIndex`로 바꾼다. **이 한 줄이 다섯 런을 살아남은 결함이다** — 값이 없어서가 아니라 값을 실어 보낼 자리가 계약에 없어서였다.

### D. `warnBurnedTokens`를 `recommend_failed` 이벤트로 바꾼다

지금 `warnBurnedTokens`는 실패 지점 다섯 곳에서 불리며 **경고 한 줄**만 남긴다. 그래서 추천 단계의 에러율과 실패에 태운 토큰이 집계에서 사라진다. 앞 step 이 `recommend_failed`를 추가했다.

- 다섯 호출 지점(`TIMEOUT`/`UPSTREAM_UNAVAILABLE` · `IRRELEVANT_MOOD` · `RECOMMENDATION_VALIDATION_FAILED` · `INTERNAL_ERROR`)이 전부 이벤트를 남기게 한다
- 속성은 PRD 표대로 `session_id` · `error_code` · `input_tokens` · `output_tokens` 넷이다. **태운 토큰을 빼지 마라** — 실패해도 청구되고, 빼면 세션당 비용 가드레일이 실패분을 못 본다
- **`recommend_viewed`를 실패 경로에서 올리지 마라.** 추천 수락률의 분모가 실패로 부풀면 North Star 가 실제보다 낮게 보인다
- 함수 이름과 주석("이벤트가 아니라 경고 한 줄이다")이 더 이상 사실이 아니다. 함수를 지우든 이름을 바꾸든 **주석이 코드와 어긋난 채로 남기지 마라**
- `warnBurnedTokens`가 `sessionId`를 인자로 받지 않는다면 넘겨라. 세션 없이 남긴 이벤트는 어느 지표에도 붙지 않는다

**400 `UNVERIFIED_BOOKS`(서명 통과 0권)에서도 이벤트를 남길지 판단해서 결정하고, 그 판단을 주석과 `summary`에 남겨라.** 그 경로는 모델을 아직 부르지 않아 토큰이 0 이다 — 에러율에는 들어가야 하지만 비용에는 0 으로 들어간다. 어느 쪽으로 정하든 이유를 적어라.

### 테스트

`src/app/api/recommend/route.test.ts`에 더한다:

- `irrelevantStreak: 0`·`1`에서 `relevant: false`면 여전히 422
- `irrelevantStreak: 2`에서 `relevant: false`여도 **200 이고 추천이 나온다**
- 그 강행 경로에서도 **목록 밖 `bookId`는 여전히 502** — 무관 판정 무시가 화이트리스트를 뚫지 않는다
- 강행 경로에서 모델 호출이 **1회**다 (다시 부르지 않는다)
- `mood_submitted.retry_index`가 요청의 `retryIndex`와 같다
- 실패 5종이 각각 `recommend_failed`를 남기고 `error_code`가 응답 코드와 일치한다
- 실패 시 `recommend_viewed`가 **0건**이다 (기존 케이스가 이미 있다 — 깨지지 않는지 확인)

## Acceptance Criteria

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit --audit-level=high
```

## 검증 절차

1. 위 AC 커맨드를 순서대로 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 서명 검증 → 화이트리스트 **순서**가 그대로인가? 화이트리스트의 기준이 여전히 **검증 통과 목록**인가? (ADR-006)
   - 실패 사유를 뭉개지 않았는가 — 타임아웃(504)과 외부 장애(502)와 우리 결함(500)이 여전히 갈리는가? (ADR-005)
   - 파일·전역 변수·쿠키에 상태를 남기지 않았는가? (ADR-003)
   - 이벤트 속성이 PRD 7번 표와 1:1 인가? `mood` 원문이 로그에 닿는 경로가 없는가?
3. 결과에 따라 `phases/contract-wiring/index.json`의 step 2 를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **화이트리스트 검증(FR-009)을 무관 판정 무시 경로에서 건너뛰지 마라.** 이유: 목록 밖 책이 사용자에게 도달하는 것이 이 프로젝트에서 가장 심각한 결함이다 (CLAUDE.md CRITICAL, ADR-002)
- **강행 경로에서 모델을 다시 부르지 마라.** 이유: 같은 응답에 비용만 두 배가 된다
- **`relevant` 판정을 서버가 키워드로 하지 마라.** 이유: 판정 주체는 모델이라고 API_SPEC 이 정했다. 이 step 이 바꾸는 것은 *판정을 언제 무시하는가*뿐이다
- **재요청(교정) 횟수를 늘리지 마라.** 이유: 1회는 계약이다. 재요청 후에도 위반이면 502 로 끊는다
- **`src/lib/schemas.ts`·`src/lib/analytics.ts`를 고치지 마라.** 이유: 앞 step 들이 이미 넓혔다. 여기서 또 고치면 두 계약이 갈린다. **모자란 것이 있으면 고치지 말고 `summary`에 보고하라**
- **상태를 파일·전역 변수·쿠키에 남기지 마라.** 이유: 무상태 전제를 문서 없이 우회하는 것이다 (ADR-003, CLAUDE.md CRITICAL)
- **기존 테스트를 지우거나 `skip` 하지 마라.**
- **`index.json`의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`). 이유: 실행기가 기록한다
- **`RUNNING` 파일을 읽지도 지우지도 마라.** 이유: 실행기 소유다
- `docs/**` · `harness/**` · `scripts/**` 를 고치지 마라. 이유: 메인 소유 경계다
