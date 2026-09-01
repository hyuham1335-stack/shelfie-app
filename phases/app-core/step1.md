# Step 1: questions-route — 기분 유도 문답 엔드포인트 (TR-009)

## 읽어야 할 파일

- `/docs/API_SPEC.md` — **`POST /api/mood/questions` 절 전문이 이 step의 계약이다.** 공통 규약과 에러 응답 규약도 읽어라
- `/docs/PRD.md` — **US-004(기분을 모르겠는 사용자)** 와 그 AC, FR-007, 7번 이벤트 로그의 `questions_generated`
- `/docs/TRD.md` — 3번 표의 TR-009·TR-015 행, 6.4 관측성, 6.5 보안
- `/docs/ADR.md` — **ADR-006(증명 동반)** · ADR-005 · ADR-003(무상태)
- `/docs/ARCHITECTURE.md` — 데이터 흐름 2(추천 생성), 레이어 의존 관계
- `src/app/api/analyze/route.ts` · `src/app/api/events/route.ts` — **이전 런의 산출물. 라우트 구조·에러 응답·requestId·`SERVICE_ENABLED` 처리를 여기에 맞춘다**
- `src/services/anthropic.ts` — `generateQuestions` (step 0에서 추가됨)
- `src/lib/proof.ts` — **`verifyProof`·`filterVerified`. 이 라우트가 검증을 처음 소비한다**
- `src/lib/schemas.ts` — `moodQuestionsRequestSchema` · `moodQuestionsResponseSchema` · `bookReferenceSchema`
- `src/lib/analytics.ts` — `questions_generated` 이벤트의 필수 속성

## 작업

`src/app/api/mood/questions/route.ts`를 만든다.

### 왜 이 라우트가 특별한가

**`proof` 검증을 처음 소비하는 라우트다.** 지금까지 `analyze`·`resolve`는 서명을 **발급**만 했다. 클라이언트가 보낸 책 목록을 형식만 검사하고 사실로 취급하면 화이트리스트(FR-009)는 무의미하다 — 모델 출력이 입력과 일치하는지만 볼 뿐, 그 입력이 진짜인지는 묻지 않기 때문이다 (ADR-006).

### 반드시 지킬 규칙

1. **서명을 먼저 검증한다.** `filterVerified`로 통과분만 남긴다. 서명이 없거나 위조·만료된 책은 **그 책만** 버리고 나머지로 진행한다. 요청 전체를 실패시키지 마라 (TR-015).
2. **검증 통과 0권이면 400 `UNVERIFIED_BOOKS`.** `recommend`와 같은 규약이다. **API_SPEC이 `mood/questions`에 대해서는 이 경우를 명시하지 않았다** — 같은 규약을 택하고, 그 판단을 코드 주석과 `summary`에 남겨 보고하라. 문서를 고치지는 마라.
3. **생성 실패도, 모델 장애도 200 + 빈 배열이다.** 502를 쓰지 마라. 클라이언트는 빈 배열을 받으면 자유 입력으로 폴백하고 세션을 끊지 않는다. 상태 코드를 나누면 클라이언트 경로가 둘이 되고 둘 중 하나는 반드시 덜 검증된다 (API_SPEC).
4. **타임아웃만 504.** 30s다.
5. **400은 요청 문제일 때만** — 책 목록이 비었거나 50개 초과, 스키마 위반, 서명 통과 0권.
6. **응답은 `moodQuestionsResponseSchema`를 통과한 뒤에만 내보낸다.** 질문이 1개인 응답은 이 스키마가 막는다 — 그런 경우 빈 배열로 강등하라(폴백). 계약을 어긴 본문을 사용자에게 보내지 마라.
7. **`SERVICE_ENABLED=false`면 503.** 값이 망가져 읽을 수 없어도 **차단 쪽으로 넘어져라** — `analyze`가 그렇게 했다.
8. **관측성**: `questions_generated`를 남기고 **토큰(`input_tokens`·`output_tokens`)을 반드시 싣는다.** 실패 분기의 `usage`도 합산하라(step 0이 그것을 실어 올린다). `logEvent` 호출은 try/catch로 감싸 로깅 실패가 응답을 막지 않게 한다.
9. **`maxDuration`을 설정하고 `runtime = "nodejs"`를 쓴다.** `lib/proof.ts`가 `node:crypto`를 쓴다.
10. **`lib/budget.ts`를 고치지 마라.** `STAGE_BUDGET_MS`에는 `extract`·`lookup`·`note`만 있다 — 그 표는 `analyze`(55s) 전용이다. 이 라우트는 자체 `maxDuration`과 30s 타임아웃을 쓴다. 예산 표를 넓히고 싶으면 고치지 말고 `summary`로 보고하라.
11. **에러 응답에 `requestId`를 반드시 담는다.** 화면이 그것을 노출하도록 설계돼 있다 (TRD 6.4, UI_GUIDE 에러 배너).
12. **모델이 생성한 문장이나 내부 에러 원문을 에러 본문에 넣지 마라.** 정해진 코드와 문구만 쓴다.

### 인터페이스

```ts
export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: Request): Promise<Response>;
```

### 테스트 (먼저 작성한다)

`src/app/api/mood/questions/route.test.ts`. `services/`는 모킹하고 **`lib/`은 진짜를 쓴다** — 서명 검증까지 모킹하면 라우트가 검증을 건너뛰어도 초록불이 난다.

- 정상 → 200, 질문 2~3개, `moodQuestionsResponseSchema` 통과
- **서명이 위조된 책은 버려지고 나머지로 진행한다** (ADR-006 회귀 — 삭제하지 마라)
- **만료된 서명도 같다**
- **전부 위조 → 400 `UNVERIFIED_BOOKS`** (모델을 부르지 않는다)
- 모델 실패(`schema`·`refusal`·`upstream`) → **200 + 빈 배열**. 502가 아니다 (회귀 — 삭제하지 마라)
- 모델이 질문 1개를 주면 → 200 + **빈 배열**(폴백)
- 타임아웃 → 504
- `books`가 빈 배열 / 51개 → 400
- `sessionId` 누락 → 400
- `SERVICE_ENABLED=false` → 503, 모델을 부르지 않는다
- `questions_generated` 이벤트에 토큰이 실린다
- `logEvent`가 던져도 응답은 200이다
- 에러 응답 본문에 `requestId`가 있다
- 테스트가 실제 Anthropic을 치지 않는다

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
   - 라우트가 `src/app/api/mood/questions/route.ts`에만 생겼는가?
   - 서명 검증이 **모델 호출보다 먼저** 일어나는가? (검증 0권이면 돈을 쓰지 않는다)
   - 생성 실패가 502가 아니라 200 + 빈 배열인가?
   - `services/`의 판정 로직을 라우트가 재구현하지 않았는가?
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/app-core/index.json`의 step 1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(서명 검증 처리 방식과 폴백 규약을 포함하라. step 2가 같은 규약을 쓴다)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **`index.json`의 타임스탬프 필드를 쓰지 마라.** 실행기가 기록한다.
- **502를 쓰지 마라.** 이유: API_SPEC이 명시적으로 금지했다. 모델 장애도 200 + 빈 배열로 흡수한다.
- **서명 검증을 건너뛰지 마라.** 이유: 클라이언트가 보낸 목록을 사실로 취급하는 순간 화이트리스트가 무의미해진다 (ADR-006).
- **검증 실패로 요청 전체를 실패시키지 마라.** 이유: 검증 실패는 **해당 책만** 폐기다 (TR-015).
- **`src/lib/`·`src/services/`를 수정하지 마라.** 이유: step 0까지의 계약이다. 결함은 `summary`로 보고하라.
- **`src/components/`를 만들지 마라.** 이유: UI는 step 3~4다.
- **실제 Anthropic API를 호출하지 마라.**
- **새 npm 의존성을 추가하지 마라.**
- **`harness/` · `docs/` · `scripts/` · `.claude/` · 루트의 `*.ts`(`vitest.config.ts` 포함) · `.env*` 를 고치지 마라.** 이유: `main_owned_paths`다.
- **기존 테스트를 깨뜨리지 마라.**
