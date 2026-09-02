# Step 4: anthropic — 책등 추출 Claude 호출 (TR-003)

## 읽어야 할 파일

- `/docs/TRD.md` — **7번의 "Anthropic 호출 규약"이 이 step의 계약이다. 전부 읽어라.** 3번 표의 TR-003 행, 7번 시간 예산, "Circuit Breaker 정책", 6.4 관측성
- `/docs/PRD.md` — US-001, FR-012(조회 전 후보 상한)
- `/docs/ADR.md` — **ADR-001(어댑터 없는 단일 공급자)** · ADR-002 · ADR-005
- `/docs/ARCHITECTURE.md` — 레이어 의존 관계, "검증 경계"·"강등"·"출처 분리" 패턴, 데이터 흐름 1
- `src/lib/schemas.ts` — **`extractionResultSchema` · `extractedCandidateFromModelSchema`**
- `src/lib/prompts.ts` — 이전 step 산출물. 프롬프트와 구조화 출력 스키마가 거기 있다
- `src/lib/budget.ts` · `src/lib/env.ts` — 이전 step 산출물
- `src/services/aladin.ts` — 이전 step 산출물. 서비스 계층의 형태를 맞춘다
- `src/lib/analytics.ts` — 토큰 수 기록이 필요하다

## 작업

`src/services/anthropic.ts`를 새로 만든다. 이미지 1장에서 책 후보를 추출하는 Claude 호출 래퍼다. `@anthropic-ai/sdk`는 이미 의존성에 있다.

**provider 추상화 레이어를 만들지 마라** — 이 파일이 곧 경계이고, 공급자를 바꿔야 하면 이 파일 하나를 교체한다 (ADR-001).

### 호출 규약 (TRD 7번 — 어기면 400이 나거나 조용히 품질이 떨어진다)

- 모델은 `env.ts`의 `getExtractModel()`에서 읽는다. 하드코딩하지 마라
- 구조화 출력은 **`output_config.format`**을 쓴다. 응답을 정규식·문자열 매칭으로 파싱하지 마라
- **`thinking: { type: "adaptive" }`**를 쓴다. **`budget_tokens`는 `claude-opus-5`에서 400을 반환하므로 쓰지 마라**
- 서버사이드 fallback을 활성화한다: `betas: ["server-side-fallback-2026-07-01"]` + `fallbacks: "default"`
- `max_tokens`는 **16000**
- **`content`를 읽기 전에 `stop_reason`을 먼저 본다**

### `stop_reason` 처리 — 두 경우를 분리하라

| `stop_reason` | 처리 |
|---|---|
| `"refusal"` | **재시도하지 않는다.** 해당 사진만 실패 처리 |
| `"max_tokens"` | `refusal`과 **분리해서** 다룬다. 단건 호출(추출)은 재시도 없이 해당 사진만 실패 처리한다. **잘린 JSON을 부분 파싱해 살려 쓰려는 시도는 절대 하지 마라** — 검증 경계를 우회하는 것이다 |
| 그 외 | 정상 경로. 응답을 `extractionResultSchema`로 파싱한다 |

### 반드시 지킬 규칙

1. **429·5xx는 지수 백오프로 1회 재시도한다.** `refusal`·`max_tokens`·4xx는 재시도하지 않는다.
2. **응답은 반드시 `extractionResultSchema`를 통과한 뒤에만 도메인 타입으로 쓴다.** 파싱 실패는 예외가 아니라 판별 가능한 실패 값이다 (CLAUDE.md CRITICAL).
3. **사진당 후보 60건 상한은 스키마가 강제한다.** 스키마를 우회해 직접 자르지 마라 — 상한이 두 곳에 생긴다.
4. **`photoIndex`는 서버가 붙인다.** 모델에게 요구하지 마라. `extractedCandidateFromModelSchema`에 `photoIndex`가 없는 것이 그 뜻이다.
5. **데드라인을 인자로 받아라.** `budget.ts`의 `deadlineFor("extract")` 결과 안에서만 산다. 자체 타임아웃 상수를 따로 두지 마라 (ADR-005).
6. **예산을 넘긴 사진은 실패로 집계한다** — 예외를 던져 요청 전체를 실패시키지 마라. 실패한 사진 인덱스를 돌려주면 호출부가 `failedPhotoIndexes`에 담는다.
7. **토큰 수를 돌려줘라.** `input_tokens`·`output_tokens`를 반환값에 실어 호출부가 `analytics.ts`의 `analyze_completed`에 담을 수 있게 하라. PRD 7번이 "Claude를 호출하는 모든 이벤트에 토큰 수를 싣는다"고 정했고, 빠지면 세션당 비용이 실제보다 낮게 집계된다.
8. **`ANTHROPIC_API_KEY`가 없으면 목업 모드다.** SDK를 부르지 말고 고정 픽스처를 돌려주되 **목업이라는 사실이 드러나게** 하라.
9. **API 키를 로그·에러 메시지에 남기지 마라** (TRD 6.5).
10. **판독 원문(`rawText`)을 로그에 남기지 마라** (PRD 7번).

### 인터페이스 (시그니처 수준. 내부 구현은 재량이다)

```ts
export const MAX_OUTPUT_TOKENS = 16_000;

export interface ExtractOptions {
  deadlineMs: number;
  photoIndex: number;
  clientImpl?: unknown;   // 테스트 주입점 — SDK 를 갈아 끼운다
}

export type ExtractOutcome =
  | { status: "ok"; candidates: ExtractedCandidate[]; usage: { input_tokens: number; output_tokens: number } }
  | { status: "failed"; reason: "refusal" | "max_tokens" | "timeout" | "schema" | "upstream" };

/** 이미지 1장 → 책 후보. 실패를 예외가 아니라 판별 가능한 값으로 돌려준다 */
export function extractFromPhoto(imageDataUri: string, options: ExtractOptions): Promise<ExtractOutcome>;
```

`failed`의 `reason`을 나누는 이유는 이 프로젝트의 사유 보존 원칙 때문이다. "왜 그 사진이 빠졌는지"를 사용자에게 다르게 설명해야 한다.

### 테스트 (먼저 작성한다)

`src/services/anthropic.test.ts`. **SDK를 모킹한다. 실제 Claude API를 호출하지 마라** (TRD 8번).

- 정상 응답 → `status: "ok"`이고 후보가 `extractedCandidateSchema`를 통과하며 `photoIndex`가 붙어 있다
- **`stop_reason: "refusal"` → `status: "failed"`, `reason: "refusal"`, 그리고 재시도하지 않는다** (호출 횟수 1회)
- **`stop_reason: "max_tokens"` → `reason: "max_tokens"`이고 잘린 JSON을 파싱하려 시도하지 않는다** (이 테스트를 삭제하지 마라 — 검증 경계 우회를 막는 회귀 테스트다)
- 429 → 1회 재시도 후 성공하면 `ok`, 두 번째도 실패하면 `upstream`
- 5xx → 1회 재시도
- 4xx(400 등) → 재시도하지 않는다
- 스키마를 어긴 응답 → `reason: "schema"`이고 예외가 새어 나가지 않는다
- 후보 61건을 돌려준 응답은 스키마에서 거부된다 (증폭 방지)
- 데드라인이 0이면 SDK를 호출하지 않고 즉시 `timeout`
- `usage`의 `input_tokens`·`output_tokens`가 반환값에 실린다
- 호출 인자에 `thinking: { type: "adaptive" }`가 있고 **`budget_tokens`가 없다**
- 호출 인자에 `betas`와 `fallbacks`가 실려 있다
- 모델 ID가 `getExtractModel()`에서 온다 (`MODEL_EXTRACT`를 바꾸면 따라간다)
- `ANTHROPIC_API_KEY`가 없으면 SDK를 호출하지 않고 목업을 돌려준다
- **에러 메시지·로그에 API 키와 `rawText`가 들어 있지 않다** (시크릿·PII 유출 회귀 테스트 — 삭제하지 마라)

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
   - `services/`가 `components/`를 import하지 않는가?
   - 응답이 zod를 통과한 뒤에만 도메인 타입으로 쓰이는가?
   - `stop_reason`을 `content`보다 먼저 보는가?
   - 테스트가 실제 API를 치지 않는가?
   - `package.json`이 변하지 않았는가?
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/services-core/index.json`의 step 4를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(export한 함수·타입명 포함)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용 — SDK 모킹 때문이면 그 사실을 명시하라"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **실제 Anthropic API를 호출하지 마라.** 테스트는 SDK를 모킹한다. 이유: `/docs/TRD.md` 8번이 "외부 API 실제 호출 금지"를 정했다. 호출하면 비용이 들고 CI에서 재현되지 않는다.
- **새 npm 의존성을 추가하지 마라.** `@anthropic-ai/sdk`는 이미 있다. 이유: 스택 확장은 ADR이 먼저다 (CLAUDE.md CRITICAL).
- **provider 추상화 레이어를 만들지 마라.** 이유: ADR-001이 "어댑터 없는 단일 공급자"를 명시적으로 선택했다. 이 파일이 곧 경계다.
- **`budget_tokens`를 쓰지 마라.** 이유: `claude-opus-5`에서 400을 반환한다 (TRD 7번).
- **잘린 JSON을 부분 파싱해 살려 쓰지 마라.** 이유: 검증 경계를 우회하는 것이고, 반쪽 데이터가 확인된 책으로 올라가면 ADR-002 위반이다.
- **응답을 정규식이나 문자열 매칭으로 파싱하지 마라.** 이유: 구조화 출력을 쓰는 이유가 사라진다 (TRD 7번).
- **`src/app/api/`를 만들지 마라.** 이유: 라우트는 다음 런이다.
- **한줄평 배치 호출(TR-007)을 구현하지 마라.** 이유: 이번 런의 범위 밖이고 analyze 라우트와 함께 다음 런에서 한다.
- **`harness/` · `docs/` · `scripts/` · `.claude/` · `.env.example` 을 고치지 마라.** 이유: `main_owned_paths`다.
- **이전 step이 만든 파일과 이전 런의 `lib/` 모듈을 수정하지 마라.** 결함을 발견하면 고치지 말고 `summary`에 적어 보고하라.
- **기존 테스트를 깨뜨리지 마라.**
