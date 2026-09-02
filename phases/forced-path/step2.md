# Step 2: forced-route — 라우트가 강행을 첫 호출에 싣는다

`src/app/api/recommend/route.ts`는 이미 강행을 **판정**한다. 요청의 `irrelevantStreak`가 `IRRELEVANT_STREAK_LIMIT`(2) 이상이면 모델이 `relevant: false`를 내도 422로 끊지 않고 손에 있는 `outcome.picks`로 진행하고, 그 사실을 `console.warn` 한 줄로 남긴다.

**문제는 그 판정이 모델 호출 뒤에 일어난다는 것이다.** 모델은 규칙 7("단서가 없으면 `recommendations`를 빈 배열로 둔다")을 보고 이미 빈 배열을 돌려준 상태이고, 라우트는 그 빈 배열을 강행으로 통과시킨다. 결과는 `200` + 추천 0건 — 화면이 "적으신 그대로 골라 드릴게요"라고 약속한 뒤에 아무것도 주지 않는다.

앞 두 step이 통로를 만들었다:

- step 0 — `src/lib/prompts.ts`의 `buildRecommendPrompt`가 강행 옵션을 받으면 규칙 7을 대체한다
- step 1 — `src/services/anthropic.ts`의 `RecommendOptions`에 강행 필드가 생겼고 `buildRecommendBody`까지 전달된다

**이 step은 그 스위치를 켜는 한 곳이다.** 정확한 필드 이름과 타입은 앞 step들의 `summary`에 있다.

이 라우트는 이 프로젝트에서 계약이 가장 촘촘한 파일이다. 서명 검증 → 화이트리스트의 **순서**, 목록 밖 `bookId`의 교정 재요청, 실패 사유를 뭉개지 않는 규율(ADR-005), `recommend_failed` 기록 지점들이 전부 여기 있다. **그중 어느 것도 이 step이 바꾸지 않는다.**

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도를 파악하라:

- `/docs/API_SPEC.md` — `POST /api/recommend` 절 **전문**. 특히 **"강행하기로 한 요청은 그 사실을 모델 호출에도 싣는다"** 불릿의 세 규정: 첫 호출부터 바뀐다 · 교정 재요청에도 강행이 유지된다 · 강행 중에도 `relevant` 값 자체는 모델이 준 그대로 응답에 싣는다
- `/docs/TRD.md` — TR-010(추천 라우트) · 6번 시간 예산(강행이 호출을 늘리면 예산이 깨진다) · 비기능 요구사항의 관측성
- `/docs/ADR.md` — ADR-003(무상태) · ADR-005(실패와 데이터 없음) · ADR-006(서명·화이트리스트)
- `/docs/PRD.md` — US-003의 AC · FR-009(화이트리스트) · 7번 이벤트 로그 표의 `mood_submitted`·`recommend_failed`
- `src/app/api/recommend/route.ts` — **전문.** 상단 주석 블록부터 끝까지
- `src/app/api/recommend/route.test.ts` — 기존 케이스 전부. 특히 `irrelevantStreak` 0·1·2 분기와 "모델 호출 1회" 단정

## 작업

### A. 강행 요청은 **첫 호출부터** 강행 프롬프트로 부른다

지금은 `generateRecommendations`를 부른 **뒤에** `outcome.relevant`와 `irrelevantStreak`를 보고 강행을 정한다. 요청의 `irrelevantStreak`는 **호출 전에 이미 알고 있는 값**이므로, 그 판정을 호출 앞으로 옮겨 옵션으로 넘긴다.

```ts
const forced = irrelevantStreak >= IRRELEVANT_STREAK_LIMIT;
// generateRecommendations(books, mood, { deadlineMs, forced, ... })
```

**모델 호출 횟수를 늘리지 마라.** 강행은 재호출이 아니라 **첫 호출의 옵션**이다. 기존 테스트가 "호출 1회"를 단정하고 있고, 그것이 이 설계의 핵심이다 — 빈 배열을 받은 뒤 강행 프롬프트로 다시 부르면 같은 요청에 모델 비용이 두 배가 되고 60초 예산(TRD 6번)도 위태로워진다.

`IRRELEVANT_STREAK_LIMIT`을 그대로 쓴다. 새 상수를 만들지 마라 — **호출을 강행으로 바꾸는 경계와 422를 내지 않는 경계는 같은 값이어야 한다.** 두 값이 갈라지면 "강행 프롬프트로 불렀는데 422로 끊는다" 또는 그 반대가 생긴다.

### B. 호출 뒤의 강행 처리는 그대로 둔다

`outcome.relevant`가 `false`여도 `irrelevantStreak >= 2`면 422를 내지 않고 진행하는 기존 분기를 **지우지 마라.**

이유: 강행 프롬프트를 줬어도 모델이 여전히 `relevant: false`를 낼 수 있다. 그때도 진행해야 하고, 그 판정은 여전히 라우트의 일이다. **A는 "모델이 빈 배열을 주지 않게" 만들고, B는 "그래도 false가 오면 무시"를 지킨다. 둘 다 필요하다.**

강행 로그(`console.warn`, `request_id`·`session_id`·`streak`, **`mood` 원문 없음**)도 그대로 유지한다. 요청당 1회만 남기는 성질도 유지한다.

### C. 교정 재요청에서도 강행을 유지한다

목록 밖 `bookId`를 받아 `correction`을 들고 1회 재요청하는 경로가 있다. 그 재요청에도 강행 옵션을 **같이** 넘겨라.

이유: 재요청에서 강행이 풀리면 모델이 규칙 7을 다시 보고 빈 배열을 돌려주고, **강행 경로가 교정 한 번으로 조용히 무력화된다.**

### D. 바꾸지 않는 것

아래는 이 step의 범위 밖이고 **하나도 건드리지 마라.** 목록으로 적는 이유는 강행 분기를 손대다 보면 근처를 함께 고치고 싶어지기 때문이다.

- 화이트리스트 검증(FR-009)과 그 순서 — **목록 밖 책은 어떤 경로로도 사용자에게 도달하지 않는다.** 강행은 무관 판정을 무시하는 것이지 목록 밖 책을 허용하는 것이 전혀 아니다
- `proof` 서명 검증(ADR-006)과 `UNVERIFIED_BOOKS` 경로
- `recommend_failed` 기록 지점과 그 사유 선택(어느 실패를 남기고 어느 것을 남기지 않는지 주석에 근거가 적혀 있다)
- `mood_submitted.retry_index` 배선
- 상태 코드 표(400·422·502·504·503)

### E. 테스트

`src/app/api/recommend/route.test.ts`에 최소 아래를 넣어라. **모델이 `relevant: false` + 빈 배열을 돌려주는 목**과 **강행 프롬프트를 받았을 때 추천을 채우는 목**을 구분해 쓸 수 있어야 이 step의 성패가 드러난다.

- `irrelevantStreak: 2` 요청이 서비스를 **강행 옵션과 함께** 부른다
- `irrelevantStreak: 0`·`1` 요청은 강행 옵션 없이 부르고, 모델이 `relevant: false`면 **422**다
- **이 런의 본체**: 모델이 강행 옵션을 받았을 때 추천을 채워 주면 응답이 `200` + **빈 배열이 아닌** 추천이다
- 강행 요청에서 모델이 그래도 `relevant: false`를 내면 **422가 아니라 진행**한다 (B가 살아 있다)
- 교정 재요청 경로에서도 강행 옵션이 유지된다
- 모델 호출이 **1회**다 (강행 때문에 재호출이 생기지 않는다)
- 강행 요청에서 목록 밖 `bookId`가 오면 여전히 교정 1회 후 `502`다 (화이트리스트가 살아 있다)
- 강행 로그에 `mood` 원문이 없다

## Acceptance Criteria

```bash
npm run typecheck              # 컴파일 에러 없음
npm run lint                   # ESLint 통과
npm test                       # 전부 통과 (앞 step까지의 누적 + 추가분)
npm run build                  # 프로덕션 빌드 성공
npm audit --audit-level=high   # high 이상 0건
```

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 모든 API 로직이 `app/api/` 라우트 핸들러 안에 있는가? (CLAUDE.md CRITICAL)
   - 모델 응답이 zod 파싱을 통과한 뒤에만 쓰이는가? 알라딘 대조를 통과하지 않은 책이 추천 후보에 들어가지 않는가? (CLAUDE.md CRITICAL · ADR-002)
   - 서버 상태를 파일·전역 변수·쿠키에 남기지 않았는가? (ADR-003)
3. 결과에 따라 `phases/forced-path/index.json`의 step 2를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 자가 교정 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **`src/lib/prompts.ts`·`src/services/anthropic.ts`를 고치지 마라.** 이유: 앞 두 step이 끝낸 범위다. 시그니처가 기대와 다르면 지어내지 말고 앞 step의 `summary`를 보고 맞춰라. 그래도 어긋나면 `error`로 멈추고 그 사실을 적어라
- **강행 때문에 모델을 다시 부르지 마라.** 이유: 같은 요청에 비용이 두 배가 되고 60초 예산이 깨진다 (TRD 6번)
- **화이트리스트 검증을 강행 경로에서 건너뛰지 마라.** 이유: 무관 판정을 무시하는 것과 목록 밖 책을 허용하는 것은 전혀 다른 문제다. 알라딘 대조를 통과하지 않은 책이 추천에 들어가는 것이 이 프로젝트에서 가장 심각한 결함이다 (CLAUDE.md CRITICAL · FR-009)
- **강행 판정을 클라이언트로 옮기지 마라.** 이유: 세는 것은 클라이언트, 판정하는 것은 서버다 (API_SPEC). 판정까지 넘기면 같은 규칙이 화면마다 다시 구현된다
- **`console.warn`에 `mood` 원문을 싣지 마라.** 이유: 사용자가 쓴 텍스트는 로그에 남기지 않는다 (PRD 7번)
- **`src/lib/schemas.ts`의 `irrelevantStreak` 상한을 바꾸지 마라.** 이유: 0~2는 계약이고 상한 밖은 400이다 (API_SPEC)
- **`index.json`의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`). 이유: 실행기가 기록한다
- **`RUNNING` 파일을 읽지도 지우지도 마라.** 이유: 실행기 소유다
- 기존 테스트를 깨뜨리지 마라
