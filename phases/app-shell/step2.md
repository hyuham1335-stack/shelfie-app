# Step 2: api-client — 클라이언트 네트워크 경계

`components/`는 `services/`를 직접 부르지 않고 반드시 `app/api/`를 경유한다 (ARCHITECTURE 레이어 규칙). 그 경유를 한 파일로 모아 화면이 `fetch`를 몰라도 되게 한다.

## 읽어야 할 파일

- `/docs/API_SPEC.md` — **전문.** 특히 공통 규약(타임아웃 표·`X-Request-Id`)과 5개 엔드포인트의 요청·응답·실패 응답
- `/docs/PRD.md` — 7번 이벤트 표 (어느 이벤트를 누가 보내는가)
- `/docs/ARCHITECTURE.md` — 레이어 의존 관계 · 데이터 흐름
- `src/app/api/analyze/route.ts` · `books/resolve/route.ts` · `mood/questions/route.ts` · `recommend/route.ts` · `events/route.ts` — **실제 요청·응답 형태.** 문서가 아니라 코드가 지금 무엇을 받는지 확인하라
- `src/types/api.ts` — 요청·응답·에러 코드 타입. **그대로 쓴다**
- step 1의 `src/lib/session.ts` — 셀렉터가 돌려주는 형태
- step 0의 `src/lib/schemas.ts` — `errorResponseSchema`

## 작업

`src/lib/api-client.ts` 하나를 만든다.

```ts
analyzePhotos(sessionId, images)            // POST /api/analyze
resolveBook(sessionId, query)               // POST /api/books/resolve
fetchMoodQuestions(sessionId, books)        // POST /api/mood/questions
requestRecommendations(input)               // POST /api/recommend
sendClientEvent(event)                      // POST /api/events
```

### 실패를 값으로 돌려준다

에러를 던지지 말고 **판별 가능한 결과**로 돌려준다 — `services/aladin.ts`가 이미 쓰는 방식이다:

```ts
type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ErrorCode; requestId: string | null; status: number };
```

`requestId`는 본문 우선, 없으면 `X-Request-Id` 헤더에서 읽는다. **본문 파싱에 실패해도 결과를 돌려줘야 한다** — 배너를 띄우지 못하면 사용자는 아무 설명도 못 받는다. 파싱 실패 시 `code`는 상태 코드에서 유추한다(5xx → `INTERNAL_ERROR`, 그 외 → `INVALID_REQUEST`).

### 타임아웃

`AbortController`로 건다. **서버 하드 상한보다 길게** 잡는다 (API_SPEC 공통 규약이 명시한다 — 같은 값이면 클라이언트가 먼저 끊어 504와 안내 문구를 못 받는다):

| 호출 | 서버 상한 | 클라이언트 |
|---|---|---|
| `analyze` | 60s | 70s |
| `recommend` · `mood/questions` | 30s | 35s |
| `books/resolve` | 10s | 15s |
| `events` | 3s | 5s |

Abort로 끊긴 경우와 서버 504는 둘 다 `TIMEOUT`으로 정규화한다 — 화면 동작이 같다.

### 이벤트

`sendClientEvent`가 보낼 수 있는 것은 **`recommend_accepted`와 `book_resolved` 둘뿐**이다.

**`recommend_viewed`를 보내지 마라.** `app/api/recommend/route.ts`가 이미 남기고 있고, 양쪽이 보내면 North Star(추천 수락률)의 분모가 이중 계상된다. 라우트가 정본이다.

이벤트 전송 실패는 **삼킨다.** 로깅 실패가 화면을 막으면 관측이 결함이 된다.

## Acceptance Criteria

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run audit
```

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 확인한다:
   - `grep -n "services/" src/lib/api-client.ts` 가 0건인가? (레이어 경계)
   - 서버가 500·502·504·422를 낼 때 각각 다른 `code`가 나오는가?
   - 본문이 JSON이 아닐 때도 `ok: false` 결과가 나오는가? (던지지 않는가)
   - `grep -rn "recommend_viewed" src/lib/api-client.ts` 가 0건인가?
3. 결과에 따라 `phases/app-shell/index.json`의 step 2를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 **export한 함수 시그니처와 `ApiResult` 형태**를 담아라. step 5가 그대로 쓴다
   - 실패 → `"status": "error"` + `"error_message"` / 개입 필요 → `"status": "blocked"` + `"blocked_reason"`

## 금지사항

- **`services/*` · `lib/proof.ts` · `lib/prompts.ts`를 import하지 마라.** 이유: 서버 전용 모듈이 클라이언트 번들로 끌려 들어가고 API 키가 새는 경로가 열린다 (ARCHITECTURE 레이어 규칙)
- **`recommend_viewed`를 클라이언트에서 보내지 마라.** 이유: 라우트가 이미 보낸다. 둘 다 보내면 North Star 분모가 이중 계상된다
- **에러를 `throw`하지 마라.** 이유: 화면이 try/catch 없이 분기하게 하려는 것이 이 파일의 목적이다
- **`src/lib/`의 다른 파일과 `src/app/api/`의 라우트를 고치지 마라.** 이유: step 0·1이 확정했다. 결함은 `summary`로 보고하라
- **재시도 루프를 넣지 마라.** 이유: 재시도 정책은 상태 머신(step 1)과 화면의 결정이고, 여기서 숨기면 사용자가 30초를 두 번 기다리는 것을 아무도 모른다
- **`index.json`의 실행기 소유 필드와 `RUNNING` 파일을 건드리지 마라**
- 새 npm 의존성을 추가하지 마라 (`fetch`는 표준이다)
- 기존 테스트를 깨뜨리지 마라
