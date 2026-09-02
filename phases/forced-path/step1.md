# Step 1: forced-service — 강행 여부를 모델 호출까지 나른다

앞 step이 `src/lib/prompts.ts`의 `buildRecommendPrompt`에 **강행 옵션**을 열었다. 강행 프롬프트는 "단서가 약해도 목록 안에서 최선을 고르고 `recommendations`를 비우지 않는다"로 규칙 7을 대체한다.

**그런데 그 옵션을 켜 줄 통로가 없다.** `src/services/anthropic.ts`의 `generateRecommendations`는 `RecommendOptions`를 받아 `buildRecommendBody`로 요청 본문을 조립하는데, 그 경로 어디에도 강행을 실을 자리가 없다. 라우트(step 2)가 강행을 결정해도 모델에 닿지 못한다.

이 step은 **그 통로 하나만** 판다. 판정은 하지 않는다.

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도를 파악하라:

- `/docs/API_SPEC.md` — `POST /api/recommend` 절. 특히 **"강행하기로 한 요청은 그 사실을 모델 호출에도 싣는다"** 불릿. 그 안의 세 규정(첫 호출부터 · 교정 재요청에도 유지 · `relevant` 값은 그대로 싣는다)이 이 step의 계약이다
- `/docs/TRD.md` — TR-010(추천 호출) · 6번 시간 예산 · 6.5 프롬프트 인젝션 · 7번 모델 호출 규약
- `/docs/ADR.md` — ADR-005(외부 호출 실패와 데이터 없음을 뭉개지 않는다). 이 파일의 실패 사유 어휘가 그 규율 위에 있다
- `src/services/anthropic.ts` — `RecommendOptions` · `RecommendOutcome` · `generateRecommendations` · `buildRecommendBody` · `buildCorrectionBlock` 주변 전문
- `src/lib/prompts.ts` — 앞 step이 고친 `buildRecommendPrompt`의 **실제 시그니처**. 첨부본은 이 step 시작 시점의 내용이므로 앞 step의 수정이 반영돼 있다

## 첨부하지 않은 것 — 직접 읽어라

이 서비스의 테스트 파일(`services/` 아래 `anthropic`의 `.test.ts`)은 70,189자로 접두부 상한 60,000자를 혼자 넘는다. 그래서 첨부하지 못했다. **작업 전에 직접 읽어라** — 추천 관련 기존 케이스(교정 재요청 1회 · 실패 사유 5종 · 목 클라이언트 주입 방식)를 확인하지 않고 테스트를 쓰면 같은 픽스처를 두 벌 만들게 된다.

## 작업

### A. `RecommendOptions`에 강행 필드를 넣는다

```ts
export interface RecommendOptions {
  deadlineMs: number;
  correction?: { violatingBookIds: readonly string[] };
  /** 이 step이 추가하는 것 */
  forced?: boolean;      // 이름은 재량. 기본값은 "강행하지 않음"이어야 한다
  clientImpl?: unknown;
  sleepImpl?: (ms: number) => Promise<void>;
}
```

**옵셔널이고 기본이 꺼짐이어야 한다.** 이유: 이 함수의 다른 호출자(테스트 포함)가 전부 깨지지 않아야 하고, 강행은 예외 경로이지 기본 경로가 아니다.

주석에 **무엇을 나르는 값인지** 적어라. 이 값은 "판정"이 아니라 "이미 라우트가 내린 판정의 전달"이다. `correction`이 그렇듯 이 필드도 라우트가 아는 것을 서비스에 알려 주는 통로다.

### B. `buildRecommendBody`에 전달한다

`buildRecommendBody(books, mood, correction)`가 `buildRecommendPrompt(books, mood)`를 부른다. 강행 값을 그 호출까지 나른다.

**`generateRecommendations`가 프롬프트를 직접 조립하지 않는다는 기존 규약을 깨지 마라.** 이 파일 주석이 명시한 대로, 이 함수가 덧붙이는 유일한 것은 교정 블록이고 그것은 우리가 쓴 문장이다. 강행도 같다 — **문구는 `prompts.ts`가 소유하고 이 파일은 플래그만 넘긴다.** 여기서 문자열을 이어 붙이지 마라.

### C. `correction`과 `forced`는 독립이다

교정 재요청(목록 밖 `bookId` 반환 시 1회)이 일어나도 **강행 여부가 유지돼야 한다.**

이유: 강행 중에 화이트리스트 위반이 나면 재요청도 강행이어야 한다. 재요청에서 강행이 풀리면 모델이 다시 규칙 7을 보고 빈 배열을 돌려주고, **강행 경로가 교정 한 번으로 조용히 무력화된다.** 이것은 실환경에서만 드러나는 종류의 결함이라 테스트로 못 박아야 한다.

### D. `relevant` 해석은 여기서 하지 않는다 — 기존 계약 유지

`RecommendOutcome`은 지금 모델이 준 `relevant`를 **그대로 실어 올린다.** 이 파일 상단 주석이 그 이유를 적어 두었다("세션을 아는 쪽만 적용할 수 있다").

**강행이 들어와도 이 규약은 바뀌지 않는다.** `forced: true`라고 해서 반환값의 `relevant`를 `true`로 덮어쓰지 마라. 서버가 무시하기로 한 것은 그 값의 **효력**이지 값이 아니고(API_SPEC), 덮어쓰면 오탐률을 아무 데서도 볼 수 없게 된다.

화이트리스트 검증도 여기서 하지 않는다 — 그것도 기존 계약 그대로다.

### E. 테스트

`src/services/anthropic.test.ts`에 최소 아래를 넣어라:

- **회귀 고정**: `forced`를 주지 않은 호출이 만드는 요청 본문이 지금과 동일하다
- `forced: true`면 요청 본문의 프롬프트에 강행 문구가 있고 규칙 7 문구가 없다
- **교정 재요청에서도 강행이 유지된다** — `correction`과 `forced`를 함께 준 호출을 검사한다 (C의 결함을 막는 테스트다)
- `forced: true`여도 응답의 `relevant`가 모델 값 그대로 올라온다 (모델이 `false`를 낸 경우를 포함)
- 실패 경로(`deadlineMs <= 0` · timeout · upstream)가 `forced`와 무관하게 지금과 같이 동작한다

### F. `summary`에 최종 시그니처를 남겨라

step 2가 이 함수를 호출한다. **`RecommendOptions`의 최종 필드 이름과 타입을 문자 그대로 적어라.**

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
   - `services/`가 `app/`을 import하지 않는가? (레이어 방향 — ARCHITECTURE)
   - 새 의존성을 추가하지 않았는가? (`@anthropic-ai/sdk` 버전을 올리는 것도 새 의존성이다 — 아래 금지사항)
   - 모델 응답이 여전히 zod 스키마 파싱을 통과한 뒤에만 쓰이는가? (CLAUDE.md CRITICAL)
3. 결과에 따라 `phases/forced-path/index.json`의 step 1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 요약 (최종 시그니처 포함)"`
   - 자가 교정 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **`src/lib/prompts.ts`를 고치지 마라.** 이유: 앞 step이 끝낸 범위다. 문구가 마음에 들지 않으면 고치지 말고 `summary`에 보고하라
- **`src/app/api/recommend/route.ts`를 고치지 마라.** 이유: step 2의 범위다. 이 step은 통로만 판다
- **강행 문구를 이 파일에서 문자열로 조립하지 마라.** 이유: 프롬프트 문구의 소유자는 `prompts.ts`다. 두 곳에서 문장을 만들면 다음에 고칠 때 한 곳만 고친다
- **`forced`로 반환값의 `relevant`를 덮어쓰지 마라.** 이유: 오탐률 계측이 사라진다 (API_SPEC)
- **`@anthropic-ai/sdk` 버전을 올리지 마라.** 이유: 타입이 TRD 7번 호출 규약보다 낡다는 보고가 두 런째 있지만, 의존성 변경은 ADR이 먼저다 (CLAUDE.md CRITICAL). 이 런의 범위가 아니다
- **`extractFromPhoto`·`generateNotes`·`generateQuestions`를 건드리지 마라.** 이유: 이 step의 계약이 아니다
- **`index.json`의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`). 이유: 실행기가 기록한다
- **`RUNNING` 파일을 읽지도 지우지도 마라.** 이유: 실행기 소유다
- 기존 테스트를 깨뜨리지 마라
