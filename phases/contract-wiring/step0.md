# Step 0: request-contract — 요청 스키마에 세션 진행 상태를 넣고, 그 값을 실제로 싣는다

무상태 설계(ADR-003)라 서버는 "이 세션이 몇 번째 재추천인지"도 "무관 판정을 연속 몇 번 받았는지"도 셀 수 없다. 그래서 다섯 런 동안 **세는 쪽(클라이언트)과 판정하는 쪽(서버)이 갈라져 있었다.** 계약 문서는 이미 고쳐졌다 — `/docs/API_SPEC.md`가 `retryIndex`·`irrelevantStreak`를 **필수 평면 필드**로 규정했다. 네가 할 일은 코드를 그 계약에 맞추는 것이다.

**이 step 은 스키마와 그 호출부를 함께 닫는다.** 필수 필드를 넓히면 `RecommendRequest`를 조립하는 자리가 즉시 컴파일 에러가 되므로 두 변경은 분리될 수 없다. 판정 로직(서버가 그 값으로 무엇을 하는가)은 이 step 이 건드리지 않는다 — 그것은 step 2 다.

## 읽어야 할 파일

- `/docs/API_SPEC.md` — `POST /api/recommend` 절 **전문**. 요청 파라미터 표의 `retryIndex`·`irrelevantStreak` 두 행과 그 아래 규칙 불릿 3개(무관 판정 2회 연속 무시 · 두 값을 서명하지 않는 이유 · 실패 응답의 400 조건). `POST /api/events` 절의 허용 이벤트 목록도 본다
- `/docs/ADR.md` — ADR-006(확인된 책에 서버 서명). **무엇에 서명하고 무엇에 서명하지 않는가**의 구분이 이 step 의 핵심 근거다
- `/docs/ARCHITECTURE.md` — 레이어 의존 관계와 상태 관리 절
- `src/lib/schemas.ts` — `recommendRequestSchema`(230행 부근) · `clientEventSchema`(246행 부근)
- `src/types/api.ts` — 스키마에서 파생되는 타입들. 손댈 일은 없을 가능성이 높다
- `src/lib/api-client.ts` — `requestRecommendations(input: RecommendRequest)` · `ClientEventPayload`
- `src/app/page.tsx` — `runRecommend`(296행 부근)가 요청을 조립하는 유일한 자리. `irrelevantCount` state(93~94행)와 `state.recommendCount`
- `src/lib/session.ts` — `MAX_RECOMMEND_ATTEMPTS` · `canRecommendAgain` · `RECOMMEND_AGAIN` 이 `recommendCount`를 올리는 규칙
- `src/app/api/events/route.ts` — `propertiesSchema`(78행 부근)와 `switch`(220행 부근)에 `recommend_viewed` 분기가 남아 있다
- `src/lib/schemas.test.ts` · `src/lib/api-client.test.ts` · `src/app/api/recommend/route.test.ts` · `src/app/api/events/route.test.ts` · `src/app/page.test.tsx` — **이 step 이 깨뜨릴 기존 테스트가 전부 여기 있다**

## 작업

### A. `recommendRequestSchema`에 두 필드를 넣는다

`src/lib/schemas.ts`:

```ts
export const recommendRequestSchema = z.object({
  sessionId: sessionIdSchema,
  books: z.array(recommendBookSchema).min(1).max(MAX_IDENTIFIED_BOOKS),
  mood: z.string().min(2).max(500),
  inputMode: z.enum(["free_text", "guided"]),
  retryIndex: /* 정수 0~4 */,
  irrelevantStreak: /* 정수 0~2 */,
});
```

세 가지를 정확히 지켜라:

1. **필수다.** `.optional()`도 `.default()`도 붙이지 마라. 이유: 기본값을 주면 "보내지 않은 것"과 "0을 보낸 것"이 같아지고, 그러면 클라이언트가 필드를 잊어도 지표가 조용히 0으로 채워진다. 다섯 런을 온 결함이 정확히 그 모양이다 — `retry_index: 0` 하드코딩
2. **평면 필드다.** `session: { retryIndex, irrelevantStreak }` 처럼 묶지 마라. 이유: API_SPEC 의 요청 파라미터 표가 `body`의 최상위 이름으로 규정했고, 계약 문서가 단일 출처다 (CLAUDE.md CRITICAL)
3. **상한은 스키마가 강제한다.** `retryIndex` 0~4(FR-010 의 세션당 5회) · `irrelevantStreak` 0~2. 정수가 아니거나 범위 밖이면 400 이다. 이 두 값에 `proof` 서명을 붙이지 마라 — **이유는 API_SPEC 과 ADR-006 에 적혀 있다.** 서명은 *사실인 척할 수 있는 값*(책)에만 붙는다. 이 둘은 위조해도 얻는 것이 원래 허용된 동작 하나뿐이고, 전부 서명하면 무상태 설계가 세션 상태를 서버로 되가져오는 방향으로 밀린다

### B. 클라이언트가 두 값을 싣는다

`src/app/page.tsx`의 `runRecommend`가 `requestRecommendations`를 부르는 자리에서 채운다. **값의 출처는 이미 화면 안에 있다**:

- `retryIndex` ← `state.recommendCount` (리듀서의 `RECOMMEND_AGAIN`이 올린다)
- `irrelevantStreak` ← `irrelevantCount` state (`nextIrrelevantCount`가 갱신한다)

`irrelevantStreak`는 **보내기 직전에 2로 클램프하라.** 이유: `nextIrrelevantCount`에는 상한이 없어서 서버가 아직 판정을 무시하지 않는 동안(step 2 이전) 3회째 422 를 받으면 값이 3이 되고, 그러면 스키마 상한 밖이라 400 이 된다. **400 은 사용자에게 아무 의미가 없는 실패다** — 계약의 상한을 화면이 지키는 편이 맞다. `retryIndex`는 `canRecommendAgain`이 이미 5회에서 막으므로 클램프가 필요 없지만, **그 사실을 테스트로 고정하라**(재추천 상한까지 눌러도 `retryIndex`가 4를 넘지 않는다).

`src/lib/api-client.ts`의 `requestRecommendations` 시그니처는 `RecommendRequest`를 그대로 받으므로 **바꿀 것이 없다.** 타입이 저절로 넓어진다. 이 파일에 두 필드를 하드코딩하지 마라 — 값을 아는 것은 화면이다.

### C. `/api/events`의 허용 목록에서 `recommend_viewed`를 뺀다

`recommend_viewed`는 `app/api/recommend/route.ts`가 응답 반환 직전에 **서버에서** 남긴다. `/api/events`도 그 이름을 받으면 추천 수락률의 분모가 이중 계상된다. 보내는 클라이언트는 이미 없지만(`ClientEventPayload` 유니온이 타입으로 막는다), **받을 수 있다는 것과 보내는 곳이 없다는 것은 다른 문제다.** 문서는 이미 "허용 2종"으로 고쳐져 있다.

- `src/lib/schemas.ts`의 `clientEventSchema`에서 `"recommend_viewed"` 제거
- `src/app/api/events/route.ts`의 `propertiesSchema.recommend_viewed`와 `switch`의 해당 `case` 제거
- 두 파일의 주석에서 "3종"을 말하는 문장을 고쳐라

`src/lib/analytics.ts`의 `AnalyticsEvent`에 있는 `recommend_viewed`는 **지우지 마라.** 그것은 서버가 남기는 이벤트의 정의이고 라우트가 쓰고 있다. 지우는 것은 `/api/events`가 **받는** 목록뿐이다.

### D. 깨진 테스트를 고친다

A 가 필수 필드를 늘렸으므로 요청 본문을 조립하는 기존 테스트가 400 을 받기 시작한다. `src/app/api/recommend/route.test.ts`의 픽스처, `src/lib/api-client.test.ts`, `src/lib/schemas.test.ts`, `src/app/page.test.tsx`를 확인하라. **테스트를 지우거나 `skip` 하지 마라.** 픽스처에 두 필드를 채우는 것이 맞는 수정이다.

C 가 지운 이벤트를 쓰던 `src/app/api/events/route.test.ts`의 케이스는 **"이제 400 이다"로 뒤집어라.** 지우면 이중 계상을 다시 열어도 아무도 모른다.

### E. 새로 쓰는 테스트

- `retryIndex`·`irrelevantStreak`의 경계: `-1` · `5`(retryIndex) · `3`(irrelevantStreak) · 소수 · 문자열 · **누락**이 전부 파싱 실패
- 화면이 실제 값을 싣는다: 재추천 2회 후 요청의 `retryIndex`가 2 · 무관 판정 2회 후 `irrelevantStreak`가 2
- 클램프: 무관 판정 3회째에도 요청의 `irrelevantStreak`가 2를 넘지 않는다
- `/api/events`가 `recommend_viewed`를 400 으로 거부한다

## Acceptance Criteria

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit --audit-level=high
```

전부 통과해야 한다. 특히 `npm run typecheck` 는 이 step 의 핵심 게이트다 — 필수 필드를 넓히면 **채우지 않은 호출부가 전부 컴파일 에러로 드러나야** 한다. 에러가 하나도 안 났다면 스키마가 필수가 아닌 것이다.

## 검증 절차

1. 위 AC 커맨드를 순서대로 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `retryIndex`·`irrelevantStreak`가 API_SPEC 의 요청 파라미터 표와 **이름·타입·범위가 1:1**인가?
   - 새 의존성을 추가하지 않았는가? (ADR 범위)
   - `lib/`가 `services/`·`app/`을 import 하지 않는가? (ARCHITECTURE 레이어 의존)
   - 저장소·전역 변수·쿠키에 세션 상태를 남기지 않았는가? (ADR-003)
3. 결과에 따라 `phases/contract-wiring/index.json`의 step 0 을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

`summary`에는 **정한 필드 이름·타입·범위**와 **클램프를 어디에 뒀는지**를 남겨라. step 2 가 그 값을 소비한다.

## 금지사항

- **`retryIndex`·`irrelevantStreak`를 옵셔널이나 기본값으로 만들지 마라.** 이유: 클라이언트가 필드를 잊어도 지표가 조용히 0으로 채워지고, 그것이 이 step 이 고치려는 결함의 원형이다
- **`src/app/api/recommend/route.ts`의 판정 로직을 고치지 마라.** 이유: `irrelevantStreak >= 2`면 무시하는 동작과 `retry_index` 기록은 step 2 의 범위다. 이 step 은 값이 **도착하게** 만들 뿐이다. 라우트 파일 상단의 "계약의 공백 두 곳" 주석도 step 2 가 지운다
- **`src/lib/analytics.ts`를 고치지 마라.** 이유: `recommend_failed` 추가는 step 1 이다
- **기존 테스트를 지우거나 `skip` 하지 마라.** 이유: 이 step 이 깨뜨린 테스트는 계약이 넓어졌다는 증거이고, 픽스처를 채우는 것이 맞는 수정이다
- **`proof` 서명 대상을 넓히지 마라.** 이유: ADR-006 과 API_SPEC 이 이 두 값을 서명하지 않는 근거를 명시했다. 전부 서명하면 무상태 설계가 세션 상태를 서버로 되가져오는 방향으로 밀린다
- **`index.json`의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`). 이유: 실행기가 기록한다. 네가 쓰면 실측이 오염된다
- **`RUNNING` 파일을 읽지도 지우지도 마라.** 이유: 실행기 소유다
- `docs/**` · `harness/**` · `scripts/**` 를 고치지 마라. 이유: 메인 소유 경계다. 계약 문서는 이미 갱신돼 있다
