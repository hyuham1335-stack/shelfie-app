# Step 3: error-recovery — error 가 실패 단계를 기억하고, 추천 실패에서 회복한다

지금 추천 한 번이 외부 장애로 실패하면 회복 경로가 **전체 재분석**이거나 **처음으로**뿐이다. 사용자는 30초를 기다려 얻은 서재를 버리고 사진부터 다시 올려야 하고, 분석 API 비용도 다시 든다. 원인은 상태도에 `error → recommending`·`error → moodInput`이 없었다는 것이고, 그 두 전이가 없었던 이유는 **`error` 상태가 어느 단계에서 실패했는지 기억하지 않아서** 나갈 방향을 고를 수 없었다는 것이다.

`/docs/ARCHITECTURE.md`가 고쳐졌다 — 상태도가 **전이 25개**가 됐고, "`error`는 어느 단계에서 실패했는지 기억한다"가 프로즈로 못 박혔다. **실패 단계를 무엇으로 표현할지는 리듀서의 몫이므로 문서가 필드 이름을 정하지 않았다.** 그 이름을 정하는 것이 이 step 이다.

## 읽어야 할 파일

- `/docs/ARCHITECTURE.md` — **상태 관리 절 전문과 상태도.** 특히 "`error`는 어느 단계에서 실패했는지 기억한다" 문단. `error → recommending`은 직전 `mood`를 **그대로 재전송**하는 경로이고 `error → moodInput`은 사용자가 다르게 쓰겠다고 고를 때다
- `/docs/ADR.md` — ADR-003(무상태·저장소 없음) · ADR-005(실패 사유를 뭉개지 않는다)
- `/docs/UI_GUIDE.md` — 에러 배너 절. 상관관계 ID 표시 규칙과 재시도 CTA
- `src/lib/session.ts` — **전문.** `SessionData` · `SessionState` 판별 유니온 · `SessionAction` · `sessionReducer` · `EMPTY_SESSION_DATA`
- `src/lib/session.test.ts` — 지금 22개 전이를 검증하는 방식. **이 step 은 그것을 25개로 만든다**
- `src/app/page.tsx` — `runRecommend` · `handleRestart` · 에러 화면 렌더 분기 · `ErrorBanner`에 넘기는 props
- `src/components/common/ErrorBanner.tsx` — `requestId` prop 의 타입
- `src/components/common/ErrorBanner.test.tsx` · `src/app/page.test.tsx`

## 작업

### A. `error`가 실패 단계를 기억한다

`SessionData`(또는 `error` 변형)에 실패 단계를 담는다. **이름과 표현은 네가 정한다.** 지켜야 할 제약만 적는다:

1. **`error` 상태에서 비어 있을 수 없다.** 지금 `errorCode`가 그렇듯 **타입 수준에서** 강제하라 — `WithStatus<"error", { errorCode: ErrorCode }>` 가 이미 그 패턴이다. 런타임 `if`로 막는 것은 이 파일의 규율이 아니다
2. **`error`가 아닌 상태에서는 의미가 없다.** 남겨 두면 "직전에 실패했었다"가 성공 화면까지 따라다닌다
3. 값의 종류는 회복 경로가 요구하는 만큼만 둔다. 지금 `error`로 들어오는 경로는 `ANALYZE_FAILED`와 `RECOMMEND_FAILED` 둘뿐이다. **미래를 위해 쓰지 않을 값을 미리 넣지 마라**

### B. 회복 전이 2개를 더한다

상태도의 새 전이 두 개에 대응하는 액션을 만든다:

- **`error → recommending`** — 직전 `mood`를 **그대로 재전송**한다. 사용자에게 기분을 다시 쓰게 하지 않는다. `mood`는 이미 `SessionData`에 있다
- **`error → moodInput`** — 사용자가 다르게 쓰겠다고 고를 때다

그리고 **기존 `ANALYZE_RETRIED`를 좁혀라.** 지금은 `error`이기만 하면 통과한다. 추천 실패로 들어온 `error`에서 "실패한 사진만 재시도"는 말이 되지 않는다 — **`error → analyzing`은 분석 단계에서 온 `error`에서만 유효하다**(ARCHITECTURE). 같은 이유로 새 회복 전이 2개는 **추천 단계에서 온 `error`에서만** 유효하다.

`RESTARTED`(`error → idle`)는 실패 단계와 무관하게 그대로 둔다.

`recommendCount`를 회복 전이에서 올릴지 판단해서 결정하고 **이유를 주석과 `summary`에 남겨라.** 한쪽에는 "장애로 실패한 시도를 사용자의 재추천 횟수에서 빼는 것이 맞다"가 있고, 다른 쪽에는 "올리지 않으면 장애가 반복될 때 상한 없이 유료 호출이 반복된다"가 있다.

### C. 화면을 배선한다

`src/app/page.tsx`:

- 에러 화면이 **실패 단계에 따라 다른 CTA** 를 보여준다. 분석 실패면 "실패한 사진만 다시 시도", 추천 실패면 "같은 기분으로 다시 추천"과 "기분 다시 입력"
- `error → recommending`은 dispatch 로 상태를 옮긴 뒤 `runRecommend(state.mood, state.inputMode)`를 부른다. **`mood`를 다시 묻지 마라**
- `IRRELEVANT_MOOD`·`RECOMMENDATION_VALIDATION_FAILED`가 `moodInput`으로 가는 기존 분기는 그대로다 — 그것들은 `error`를 거치지 않는다

### D. 이월 보고 ③ — `ErrorBanner.requestId`

`requestId`가 `string` 필수라 "요청 ID 없음"을 표현하지 못하고, 페이지가 `"(없음)"` 문자열을 지어내 넘기고 있다. 네트워크가 끊기면 `api-client`가 실제로 `null`을 준다. **없는 값을 문자열로 지어내는 것은 이 리포가 다른 곳에서 금지한 것과 같은 종류의 위조다**(`photoIndex`를 `0`으로 만들지 않는 것과 같은 이유).

`string | null`로 넓히고, `null`이면 **ID 줄 자체를 렌더하지 않는다.** UI_GUIDE 의 에러 배너 규칙을 따르고, 페이지에서 `"(없음)"`을 지어내던 자리를 지워라.

### 테스트

- **상태도 25개 전이 전수 검증.** 지금 22개를 세는 테스트가 있다. 새 전이 2개와 `guidedQuestions` 자기 전이까지 25개가 되고, **전이 개수 자체를 고정하는 검사**를 둬라 — 상태도와 리듀서가 갈라지는 것이 이 결함의 원형이었다
- 미정의 (상태 × 액션) 조합은 여전히 **같은 참조를 반환한다**(던지지 않는다)
- 분석 실패로 들어온 `error`에서 회복 전이 2개가 **무시된다**
- 추천 실패로 들어온 `error`에서 `ANALYZE_RETRIED`가 **무시된다**
- `error → recommending` 후 `mood`가 보존된다
- `ErrorBanner`가 `requestId: null`에서 ID 줄을 렌더하지 않는다
- 페이지: 추천이 502 로 실패한 뒤 "같은 기분으로 다시 추천"을 누르면 **같은 `mood`로 `/api/recommend`가 한 번 더 불린다** (사진 재업로드도 재분석도 없다)

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
   - 리듀서가 여전히 **순수**한가? (`fetch` · React import · 브라우저 API · 저장소 0건)
   - 리듀서에 있는 전이가 상태도에 **전부** 있고, 상태도에 있는 전이가 리듀서에 **전부** 있는가?
   - `localStorage`·쿠키에 세션을 남기지 않았는가? (ADR-003)
   - UI_GUIDE 안티패턴 목록을 위반하지 않았는가?
3. 결과에 따라 `phases/contract-wiring/index.json`의 step 3 을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

`summary`에 **실패 단계 필드의 이름과 값 종류**, **회복 전이의 액션 이름**, **`recommendCount` 판단과 그 이유**를 남겨라.

## 금지사항

- **상태도에 없는 전이를 추가하지 마라.** 이유: 상태도가 정본이고, 리듀서가 앞서가면 문서가 장식이 된다. 필요하다고 판단되면 추가하지 말고 `summary`에 보고하라
- **정의되지 않은 (상태, 액션) 조합에서 던지지 마라.** 이유: 느린 네트워크에서 버튼을 두 번 누르는 것은 평범한 일이다. 같은 참조를 반환하는 지금 규율을 유지하라
- **`localStorage`·쿠키·전역 변수에 세션을 남기지 마라.** 이유: 무상태 전제를 문서 없이 우회하는 것이다 (ADR-003, CLAUDE.md CRITICAL)
- **`requestId`가 없을 때 문자열을 지어내지 마라.** 이유: 없는 값을 있는 것처럼 만드는 것이 이 이월 보고의 내용 자체다
- **`src/app/api/**`를 고치지 마라.** 이유: 이 step 은 클라이언트 상태 머신과 화면이다. 라우트는 step 2 가 닫았다
- **기존 테스트를 지우거나 `skip` 하지 마라.**
- **`index.json`의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`). 이유: 실행기가 기록한다
- **`RUNNING` 파일을 읽지도 지우지도 마라.** 이유: 실행기 소유다
- `docs/**` · `harness/**` · `scripts/**` 를 고치지 마라. 이유: 메인 소유 경계다. 상태도는 이미 갱신돼 있다
