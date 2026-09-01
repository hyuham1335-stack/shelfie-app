# Step 4: events-route — 클라이언트 이벤트 수집 엔드포인트 (TR-014)

## 읽어야 할 파일

- `/docs/API_SPEC.md` — **`POST /api/events` 절 전문이 이 step의 계약이다.** 공통 규약과 에러 응답 규약도 읽어라
- `/docs/PRD.md` — **7번 "이벤트 로그 (Tracking Plan)"**. 특히 `수집` 열이 **클라이언트**인 3종이 이 엔드포인트의 대상이다. 2번 North Star도 읽어라
- `/docs/TRD.md` — 3번 표의 TR-014·TR-012 행, 6.4 관측성, 6.5 보안
- `/docs/ADR.md` — ADR-003(무상태 — 저장하지 않는다)
- `src/lib/analytics.ts` — **`logEvent`와 `AnalyticsEvent` 판별 유니온이 이미 있다. 다시 만들지 마라**
- `src/lib/schemas.ts` — `clientEventSchema` · `eventsRequestSchema` · `eventsResponseSchema`가 이미 있다
- `src/app/api/analyze/route.ts` · `src/app/api/books/resolve/route.ts` — 이전 step 산출물. 라우트 구조를 맞춘다

## 작업

`src/app/api/events/route.ts`를 새로 만든다. 클라이언트에서만 관측할 수 있는 이벤트를 서버 로그로 합류시키는 얇은 엔드포인트다.

### 왜 필요한가

North Star 지표인 **추천 수락률의 분자(`recommend_accepted`)는 순수한 클릭 이벤트라 서버가 알 수 없다.** 이 엔드포인트가 없으면 가설 검증 자체가 불가능하다 (PRD 7번).

### 계약 (API_SPEC)

**요청**: `sessionId`(UUID v4) · `event`(화이트리스트 3종) · `properties`(선택)

**허용 이벤트는 3종뿐이다**: `recommend_viewed` · `recommend_accepted` · `book_resolved`.
나머지는 서버가 직접 관측할 수 있으므로 이 경로로 받지 않는다 — 목록 밖 이름은 **400**이다.

**응답 202**: `{ "accepted": true }`

| 상황 | 응답 |
|---|---|
| 허용 목록 밖 이벤트명 | **400** |
| 스키마 위반 | **400** |
| 본문 8KB 초과 | **400** |
| 정상 | **202** |

### 반드시 지킬 규칙

1. **속성을 화이트리스트로 걸러 기록하라.** 클라이언트가 보낸 임의의 키를 그대로 로그에 쓰면 **PII가 흘러들어온다** (API_SPEC 명시). 각 이벤트에 정의된 속성만 남기고 나머지는 **조용히 버린다**(400이 아니라 무시 — API_SPEC이 "그 외 키는 무시하고 버린다"로 정했다).
   - `recommend_viewed`: `recommended_count` · `duration_ms` · `input_tokens` · `output_tokens`
   - `recommend_accepted`: `position` (1~3)
   - `book_resolved`: `resolve_attempt` · `matched`
2. **본문 8KB 상한.** 로그 한 줄로 남길 값에 그 이상이 필요할 이유가 없다. 상한 검사는 **본문을 파싱하기 전에** 하라 — 파싱 후에 재면 이미 메모리를 쓴 뒤다.
3. **202로 응답하고 결과를 기다리지 않는다.** 로깅 실패가 사용자 화면에 영향을 주면 안 된다 (TR-012).
4. **`lib/analytics.ts`의 `logEvent`를 쓴다.** 이벤트 이름·속성을 라우트에서 다시 정의하지 마라 — 두 벌이 되면 PRD 7번 표와 소리 없이 갈린다.
5. **저장하지 않는다.** 표준 출력에 한 줄 쓰고 끝이다 (ADR-003). 파일·DB·전역 변수 금지.
6. **`sessionId`를 신뢰하지 않는다.** 위조하면 지표가 오염되지만 인증 없는 서비스에서 감수하는 비용이다 — 그 사실을 주석에 남겨라. 대신 **형식 검증(UUID v4)은 한다.**
7. **응답을 `eventsResponseSchema`로 검증한 뒤 반환하라.**
8. **`analyze`·`resolve` 라우트와 구조를 맞춰라.**

### 테스트 (먼저 작성한다)

`src/app/api/events/route.test.ts`. `lib/analytics.ts`의 출력을 `vi.spyOn`으로 가로챈다.

- 허용 3종 각각이 **202**와 `{ accepted: true }`를 돌려준다
- **허용 목록 밖 이벤트명(`photo_uploaded` 등) → 400** — 서버가 직접 관측하는 이벤트를 이 경로로 받지 않는다
- 알 수 없는 이벤트명 → 400
- `sessionId`가 UUID v4가 아니면 400
- **정의되지 않은 속성 키는 로그에 실리지 않는다** (PII 유출 회귀 테스트 — 삭제하지 마라). 400이 아니라 **무시**하고 202를 돌려준다
- 본문 8KB 초과 → 400
- **로깅이 실패해도 202가 나간다** (`logEvent`가 던지도록 모킹)
- 저장 부수효과가 없다 (파일 쓰기·전역 변수 변경 0건)
- `recommend_accepted`의 `position`이 1~3 밖이면 400

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
2. 아키텍처 체크리스트를 확인한다:
   - `lib/analytics.ts`를 재사용했는가? 이벤트 정의를 다시 만들지 않았는가?
   - 정의되지 않은 속성이 로그에 실리지 않는가? (PII)
   - 저장 부수효과가 없는가? (ADR-003)
   - `analyze`·`resolve`와 구조가 일관되는가?
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/routes-core/index.json`의 step 4를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **`index.json`의 타임스탬프 필드를 쓰지 마라.** 실행기가 기록한다.
- **허용 목록 밖 이벤트를 받지 마라.** 이유: 서버가 직접 관측할 수 있는 이벤트를 이 경로로 받으면 같은 이벤트가 두 번 집계된다.
- **클라이언트가 보낸 임의의 속성 키를 그대로 기록하지 마라.** 이유: PII가 흘러들어온다 (API_SPEC 명시).
- **이벤트를 저장하지 마라.** 표준 출력 한 줄이 전부다 (ADR-003, CLAUDE.md CRITICAL).
- **`lib/analytics.ts`의 이벤트 정의를 라우트에 다시 만들지 마라.** 이유: PRD 7번 표와 두 벌이 되면 소리 없이 갈린다.
- **로깅 실패로 4xx·5xx를 돌려주지 마라.** 이유: 로깅이 사용자 화면에 영향을 주면 안 된다 (TR-012).
- **새 npm 의존성을 추가하지 마라.**
- **`mood/questions`·`recommend` 라우트를 만들지 마라.** 이유: 다음 런이다.
- **`components/`를 만들지 마라.**
- **`src/lib/`·`src/services/` 파일을 수정하지 마라.** 결함을 발견하면 `summary`에 적어 보고하라.
- **`harness/` · `docs/` · `scripts/` · `.claude/` · `.env.example` 을 고치지 마라.**
- **기존 테스트를 깨뜨리지 마라.**
