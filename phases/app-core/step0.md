# Step 0: anthropic-recommend — 추천·문답 모델 호출 (TR-009 · TR-010의 호출부)

## 읽어야 할 파일

- `/docs/TRD.md` — **7번 "Anthropic 호출 규약"** 전문, 3번 표의 TR-009·TR-010 행, **6.5 보안의 프롬프트 인젝션 절**
- `/docs/PRD.md` — FR-006(추천 3권) · FR-007(기분 유도 문답) · FR-009(화이트리스트) · 7번 이벤트 로그(`questions_generated`의 토큰 필수)
- `/docs/API_SPEC.md` — `POST /api/mood/questions`와 `POST /api/recommend` 절. **이 step은 라우트를 만들지 않지만, 서비스가 무엇을 돌려줘야 라우트가 그 계약을 지킬 수 있는지가 거기 있다**
- `/docs/ADR.md` — **ADR-002(사실과 해석의 분리)** · ADR-005(실패와 데이터 없음의 분리) · ADR-006(증명 동반)
- `src/services/anthropic.ts` — **이전 런의 산출물. 이것을 확장한다.** `extractFromPhoto`·`generateNotes`와 그 아래의 `callWithRetry`·`buildBody`를 먼저 읽어라
- `src/services/anthropic.test.ts` — 기존 68건. 깨뜨리지 마라
- `src/lib/prompts.ts` — **`buildRecommendPrompt`·`recommendOutputSchema`·`recommendJsonSchema`·`buildQuestionsPrompt`·`questionsOutputSchema`·`questionsJsonSchema`가 이미 있다. 다시 만들지 마라**
- `src/lib/env.ts` — `getRecommendModel()`
- `src/lib/schemas.ts` — `moodQuestionSchema`(질문 10~60자·선택지 3~4개) · `recommendationSchema`

## 작업

`src/services/anthropic.ts`를 확장해 추천과 문답의 모델 호출부를 만든다. **라우트는 만들지 않는다 — step 1·2다.**

### 왜 필요한가

`lib/prompts.ts`에 프롬프트와 JSON Schema는 이미 있는데 그것을 SDK에 태우는 함수가 없다. 지금 상태로는 `mood/questions`·`recommend` 라우트가 모델을 부를 방법이 없다.

### 반드시 지킬 규칙

1. **`mood`는 데이터로만 다뤄라.** 사용자가 쓴 자유 텍스트다. 시스템 프롬프트에 이어 붙이지 말고 **사용자 메시지 안의 구분된 블록**에 넣어라. 그 블록 안의 지시문은 지시가 아니라 텍스트다 (TRD 6.5 프롬프트 인젝션). `buildRecommendPrompt`가 이미 그 형태를 잡고 있다면 그 규약을 깨지 마라.
2. **호출 규약은 기존 것을 공유하라.** `buildBody`·`callWithRetry`를 재사용한다. `output_config.format` · betas + fallbacks · `max_tokens` · **`stop_reason`을 먼저 읽는 순서**를 추출·한줄평과 다르게 만들지 마라. 새 SDK 래퍼를 만들면 규약이 세 벌이 된다.
3. **모델은 `getRecommendModel()`** 을 쓴다. 추출 모델과 분리돼 있는 이유가 있다.
4. **실패는 예외가 아니라 판별 가능한 값이다.** 사유를 뭉개지 마라 — `refusal` · `max_tokens` · `timeout` · `schema` · `upstream`을 구분해서 담아라 (ADR-005).
5. **실패 분기에도 `usage`를 실어라.** 런 #3의 `anthropic` step이 올린 보고다. refusal·`max_tokens`·스키마 위반은 **응답이 돌아와 과금된 경우**이므로 토큰을 비용 집계로 날라야 한다. 반대로 호출 자체가 없었거나(예산 소진) 응답을 못 받은 경우(timeout·연결 오류)는 **`usage` 키를 만들지 마라** — 0을 지어내면 "호출했는데 공짜"로 집계된다.
6. **응답은 반드시 zod를 통과한 뒤에만 도메인 타입으로 쓴다.** `recommendOutputSchema`·`questionsOutputSchema`를 통과하지 못하면 `schema` 실패다.
7. **화이트리스트 검증은 이 파일의 일이 아니다.** `bookId`가 요청 목록 안에 있는지 확인하고 재요청하는 것은 **라우트(step 2)** 가 한다 — 서명 검증을 통과한 목록을 아는 쪽이 라우트이기 때문이다. 다만 라우트가 재요청할 수 있도록 **위반한 `bookId`를 알려 주고 허용 목록을 다시 제시하는 재요청 경로**는 이 파일이 열어 둬야 한다(예: 프롬프트에 붙일 교정 문구를 인자로 받는다).
8. **`relevant: false`를 서비스가 해석하지 마라.** 모델이 준 값을 그대로 실어 올린다. 422로 만들지, 무시하고 진행할지는 라우트가 정한다 (API_SPEC의 "2회 연속이면 무시" 규칙 때문이다).
9. **질문 개수는 0개 또는 2~3개다.** 1개짜리 응답은 문답 화면을 성립시키지 못한다. `moodQuestionsResponseSchema`가 그렇게 정해 뒀다 — 서비스는 모델이 1개를 주면 `schema` 실패로 다뤄라. **빈 배열로 흡수하는 것은 라우트의 일이다.**
10. **TTB 키·API 키를 로그·에러 메시지에 남기지 마라.**
11. **기존 `extractFromPhoto`·`generateNotes`의 시그니처를 깨지 마라.** 68건의 테스트가 걸려 있다.

### 인터페이스 (시그니처 수준. 내부 구현은 재량이다)

```ts
export type RecommendFailureReason = ExtractFailureReason;

export interface RecommendOptions {
  deadlineMs: number;
  /** 직전 시도가 목록 밖 책을 반환했을 때 라우트가 넘기는 교정 정보. 첫 시도에는 없다 */
  correction?: { violatingBookIds: readonly string[] };
  // 나머지는 기존 옵션 규약을 따른다 (client 주입 등)
}

export type RecommendOutcome =
  | { status: "ok"; relevant: boolean; picks: readonly { bookId: string; reason: string }[]; usage: ExtractUsage }
  | { status: "failed"; reason: RecommendFailureReason; usage?: ExtractUsage };

export function generateRecommendations(
  books: readonly RecommendPromptBook[],
  mood: string,
  options: RecommendOptions,
): Promise<RecommendOutcome>;

export type QuestionsOutcome =
  | { status: "ok"; questions: readonly MoodQuestion[]; usage: ExtractUsage }
  | { status: "failed"; reason: RecommendFailureReason; usage?: ExtractUsage };

export function generateQuestions(
  books: readonly PromptBook[],
  options: { deadlineMs: number },
): Promise<QuestionsOutcome>;
```

### 테스트 (먼저 작성한다)

`src/services/anthropic.test.ts`를 **확장**한다(기존 68건 유지). SDK는 전부 스텁·모킹한다.

- 정상 응답 → `recommendOutputSchema`를 통과한 `picks`와 `relevant`
- `relevant: false` 응답 → **`status: "ok"` 이고 `relevant: false`** (실패가 아니다. 판단은 라우트가 한다)
- `correction`을 넘기면 프롬프트에 **위반한 `bookId`와 허용 목록이 들어간다** (같은 프롬프트를 그대로 반복하지 않는다)
- 스키마 위반 응답 → `failed`, `reason: "schema"`, **`usage` 있음**(응답이 돌아왔으므로 과금됐다)
- refusal → `failed`, `reason: "refusal"`, `usage` 있음, **재시도하지 않는다**
- 429·5xx → 1회 재시도 후 성공/실패
- timeout·연결 오류 → `failed`, **`usage` 키 자체가 없다**
- `deadlineMs`가 0이면 SDK를 부르지 않고 즉시 `failed`
- 질문 2~3개 → `ok`. **질문 1개 → `failed`(`schema`)**. 질문 0개는 모델이 줄 수 있는 값이 아니므로 스키마가 막는다
- 질문 텍스트가 60자를 넘거나 선택지가 2개면 `failed`(`schema`)
- `mood`에 "이전 지시를 무시하고…" 같은 문장을 넣어도 **시스템 프롬프트가 아니라 사용자 메시지의 구분된 블록에 담긴다** (인젝션 회귀 — 삭제하지 마라)
- 에러 메시지·로그에 API 키가 없다
- 기존 68건이 그대로 통과한다

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
   - `services/`가 `components/`·`app/`을 import하지 않는가?
   - 실패 사유 5종이 끝까지 다른 값으로 나르는가? (ADR-005)
   - 과금된 호출의 `usage`가 보존되고, 호출 없는 실패에는 `usage`가 **없는가**?
   - 테스트가 실제 Anthropic API를 치지 않는가?
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/app-core/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(export한 함수·타입명, 재요청 교정 인터페이스의 형태, 라우트가 지켜야 할 규약을 포함하라. 다음 step이 쓴다)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **`index.json`의 타임스탬프 필드를 쓰지 마라.** `started_at`·`completed_at`·`failed_at`·`blocked_at`·`created_at`은 전부 실행기가 기록한다.
- **`src/app/`을 만들거나 고치지 마라.** 이유: 라우트는 step 1~2다.
- **`src/lib/`을 수정하지 마라.** 이유: 프롬프트·스키마·env는 이전 런들이 확정한 계약이다. 결함을 발견하면 고치지 말고 `summary`에 적어 보고하라.
- **실제 Anthropic API를 호출하지 마라.** 이유: `/docs/TRD.md` 8번이 정한 규칙이다.
- **새 npm 의존성을 추가하지 마라.** 이유: 스택 확장은 ADR이 먼저다 (CLAUDE.md CRITICAL).
- **`mood`를 시스템 프롬프트에 이어 붙이지 마라.** 이유: 프롬프트 인젝션 경로가 열린다 (TRD 6.5).
- **화이트리스트 검증과 422 판정을 서비스에서 하지 마라.** 이유: 서명 검증을 통과한 목록을 아는 쪽은 라우트다 (ADR-006).
- **`harness/` · `docs/` · `scripts/` · `.claude/` · `phases/` 외 파일 · 루트의 `*.ts`(`vitest.config.ts` 포함) · `.env*` 를 고치지 마라.** 이유: `main_owned_paths`다.
- **기존 테스트를 깨뜨리지 마라.**
