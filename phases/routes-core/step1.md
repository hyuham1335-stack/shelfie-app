# Step 1: anthropic-notes — 한줄평 배치 호출과 실패 usage 보존 (TR-007)

## 읽어야 할 파일

- `/docs/TRD.md` — **7번 "Anthropic 호출 규약"** 전문(특히 `max_tokens` 절단 시 **배치는 단건과 다르게 다룬다**), 3번 표의 TR-007 행, 7번 시간 예산의 한줄평 8s
- `/docs/PRD.md` — **FR-008(한줄평 생성)** · 7번 이벤트 로그(토큰 수 필수)
- `/docs/ADR.md` — **ADR-002(사실과 해석의 분리)** · ADR-005 · ADR-001
- `/docs/API_SPEC.md` — `analyze` 응답의 `claudeNote` 설명("생성 실패 시 빈 문자열")
- `src/services/anthropic.ts` — **이전 런의 산출물. 이것을 확장한다**
- `src/services/anthropic.test.ts` — 기존 39건. 깨뜨리지 마라
- `src/lib/prompts.ts` — `buildNotePrompt` · `noteJsonSchema` · `noteBatchSchema`가 이미 있다. **다시 만들지 마라**
- `src/lib/schemas.ts` — `identifiedBookSchema`의 `claudeNote`는 `.max(60)`이다
- `src/lib/budget.ts` — `deadlineFor("note")` · `isExhaustedFor("note")`

## 작업

`src/services/anthropic.ts`를 확장한다. 두 가지다.

### ① 한줄평 배치 호출 (TR-007)

확인된 책 **전체를 1회 호출**로 한줄평을 생성한다. 책 50권 기준 1회, 응답 p95 15초 이내가 목표다.

- 책당 **60자 이내**. 난이도·분위기·읽는 맛만 다루고 **줄거리 요약 금지** (FR-008)
- 생성 실패 시 `claudeNote`를 **빈 문자열**로 두고 책 자체는 정상 반환한다 — 요청 전체를 실패시키지 마라
- **남은 예산이 8s 미만이면 호출 자체를 건너뛰고** 전원 빈 문자열로 둔다 (ADR-005)
- **`max_tokens` 절단 시 배치는 입력을 절반으로 쪼개 1회 재시도한다.** 이것이 단건 호출(추출)과 다른 점이다 — TRD 7번이 명시적으로 나눠 뒀다. 그래도 실패하면 전원 빈 문자열
- `refusal`은 재시도하지 않는다
- 프롬프트와 스키마는 `src/lib/prompts.ts`의 것을 쓴다

### ② 실패 분기에도 `usage`를 싣는다 (이전 런의 보고 해소)

이전 런의 `anthropic` step이 직접 올린 보고다: *"`ExtractOutcome`의 `failed` 분기에는 `usage`가 없다. 그런데 `refusal`·`max_tokens` 응답도 토큰은 과금되므로, 그 사진의 비용은 `analyze_completed` 집계에서 빠진다."*

PRD 7번의 가드레일이 "세션당 비용 300원"인데 일부 호출의 토큰이 빠지면 **실제보다 낮게 집계된다.** `ExtractOutcome`의 `failed` 분기에도 `usage`를 선택적으로 실어라(`timeout`처럼 호출 자체가 없던 경우는 `usage` 없음이 맞다).

### 인터페이스 (시그니처 수준. 내부 구현은 재량이다)

```ts
export type NoteOutcome =
  | { status: "ok"; notes: Map<string, string>; usage: ExtractUsage }   // isbn13 -> 한줄평
  | { status: "skipped"; reason: "budget" | "no_books" }
  | { status: "failed"; reason: "refusal" | "max_tokens" | "timeout" | "schema" | "upstream"; usage?: ExtractUsage };

export interface NoteOptions {
  deadlineMs: number;
  clientImpl?: unknown;
  sleepImpl?: (ms: number) => Promise<void>;
}

/** 확인된 책 전체의 한줄평을 1회 호출로 생성한다 */
export function generateNotes(
  books: readonly { isbn13: string; title: string; author: string }[],
  options: NoteOptions,
): Promise<NoteOutcome>;
```

`skipped`와 `failed`를 나누는 이유는 사유 보존이다. "예산이 없어서 안 불렀다"와 "불렀는데 거절당했다"는 다른 사실이고, 보고서·로그에서 구분돼야 한다.

### 반드시 지킬 규칙

1. **호출 규약을 추출과 동일하게 유지하라** — `getRecommendModel()`(한줄평은 추출 모델이 아니다), `output_config.format`, `thinking: {type:"adaptive"}`(**`budget_tokens` 금지**), betas + `fallbacks`, `max_tokens` 16000, **`stop_reason`을 `content`보다 먼저 본다**.
2. **모델이 만드는 것은 `claudeNote`뿐이다.** 제목·저자·출판사·쪽수·평점을 생성하라고 요구하지 마라. 그것들은 알라딘에서 오는 사실이다 (ADR-002).
3. **60자를 넘으면 zod가 통째로 거부한다.** 스키마 검증 실패를 잘라서 살려 쓰지 말고 그 책만 빈 문자열로 두거나 전체를 `failed`로 처리하라 — 어느 쪽을 택했는지 주석에 남겨라.
4. **입력 목록에 없는 `isbn13`이 응답에 있으면 버려라.** 화이트리스트 검증은 추천에만 필요한 것이 아니다.
5. **잘린 JSON을 부분 파싱해 살려 쓰지 마라.** 검증 경계 우회다.
6. **데드라인을 인자로 받아라.** 자체 타임아웃 상수를 두지 마라.
7. **API 키·`rawText`를 로그에 남기지 마라.** 이미 `warn()` 하나로 출구를 좁혀 뒀으니 유지하라.
8. **기존 `extractFromPhoto`의 시그니처를 깨지 마라.** 39건의 테스트가 걸려 있다. `usage` 추가는 `failed` 분기에 **선택적 필드**로 붙인다.

### 테스트 (먼저 작성한다)

`src/services/anthropic.test.ts`를 **확장**한다(기존 39건 유지). SDK는 전부 모킹한다.

- 책 3권 → 1회 호출로 3건의 한줄평, `isbn13`이 키로 맞다
- **호출이 정확히 1회다** (책 50권을 넣어도 배치 1회 — TR-007 성공 지표)
- 60자를 넘는 한줄평이 오면 스키마에서 걸린다
- 입력에 없는 `isbn13`이 응답에 있으면 버려진다
- **남은 예산 7.9s → `skipped`, `reason: "budget"`이고 SDK를 호출하지 않는다**
- 책 0권 → `skipped`, `reason: "no_books"`
- **`stop_reason: "max_tokens"` → 입력을 절반으로 쪼개 1회 재시도한다** (호출 횟수 2회로 확인). 그래도 실패하면 `failed`
- `stop_reason: "refusal"` → 재시도하지 않는다
- **`failed`(refusal·max_tokens)에도 `usage`가 실린다** — 이 테스트는 삭제하지 마라 (비용 집계 회귀)
- `timeout`(호출 자체가 없음)에는 `usage`가 없다
- 모델 ID가 `getRecommendModel()`에서 온다
- `thinking: {type:"adaptive"}`가 있고 `budget_tokens`가 없다
- `ANTHROPIC_API_KEY`가 없으면 목업
- **에러 메시지·로그에 API 키가 없다** (시크릿 유출 회귀 — 삭제하지 마라)
- 기존 39건이 그대로 통과한다

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
   - `prompts.ts`의 프롬프트·스키마를 재사용했는가? (다시 만들지 않았는가)
   - 모델이 사실 필드를 생성하지 않는가? (ADR-002)
   - 배치와 단건의 `max_tokens` 처리가 다른가? (TRD 7번)
   - 테스트가 실제 API를 치지 않는가?
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/routes-core/index.json`의 step 1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(export한 함수·타입명 포함)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **`index.json`의 타임스탬프 필드를 쓰지 마라.** 실행기가 기록한다.
- **실제 Anthropic API를 호출하지 마라.** 이유: TRD 8번. 비용이 들고 CI에서 재현되지 않는다.
- **새 npm 의존성을 추가하지 마라.** `@anthropic-ai/sdk`는 이미 있다.
- **`src/lib/prompts.ts`에 프롬프트를 다시 만들지 마라.** `buildNotePrompt`·`noteJsonSchema`·`noteBatchSchema`가 이미 있다. 이유: 두 벌이 되면 60자 규칙이 소리 없이 갈린다.
- **`budget_tokens`를 쓰지 마라.** 이유: `claude-opus-5`에서 400을 반환한다.
- **잘린 JSON을 부분 파싱하지 마라.** 이유: 검증 경계 우회다.
- **`src/app/api/`를 만들지 마라.** 이유: 라우트는 step 2~4다.
- **`src/lib/` 파일을 수정하지 마라.** 결함을 발견하면 `summary`에 적어 보고하라.
- **`harness/` · `docs/` · `scripts/` · `.claude/` · `.env.example` 을 고치지 마라.**
- **기존 테스트를 깨뜨리지 마라.**
