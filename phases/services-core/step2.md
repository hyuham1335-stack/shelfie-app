# Step 2: prompts — 프롬프트 4종과 구조화 출력 스키마 파생 (TR-002·TR-003·TR-007·TR-009·TR-010)

## 읽어야 할 파일

- `/docs/TRD.md` — **7번의 "Anthropic 호출 규약"이 이 step의 계약이다.** 3번 표의 TR-003·TR-007·TR-009·TR-010 행도 읽어라
- `/docs/PRD.md` — FR-006(추천 3권) · FR-007(기분 입력 분기) · FR-008(한줄평 규칙) · FR-009(추천 범위 제약)
- `/docs/ADR.md` — ADR-001(단일 공급자), ADR-002(사실과 해석의 분리)
- `/docs/ARCHITECTURE.md` — "출처 분리" · "화이트리스트 검증" 패턴
- `src/lib/schemas.ts` — **`extractionResultSchema` · `recommendationSchema` · `moodQuestionSchema` 가 파생의 원본이다**
- `src/types/book.ts` · `src/types/api.ts`
- `src/lib/env.ts` — `getExtractModel()` · `getRecommendModel()` · `MAX_CANDIDATES_PER_PHOTO` · `MAX_RECOMMENDATIONS`

## 작업

`src/lib/prompts.ts`를 새로 만든다. Claude 호출 4종의 프롬프트 문자열과, **zod 스키마에서 파생한 구조화 출력 스키마**를 담는 순수 모듈이다.

### 프롬프트 4종

| 이름 | 용도 | 핵심 제약 |
|---|---|---|
| 추출 | 책장 사진 1장 → 책 후보(제목·저자·신뢰도) | 사진당 후보 `MAX_CANDIDATES_PER_PHOTO`(60) 상한. 못 읽은 것을 지어내지 말고 `confidence`를 낮게 줄 것 |
| 한줄평 | 확인된 책 전체 → 책당 한 줄 | **책당 60자 이내. 난이도·분위기·읽는 맛만 다루고 줄거리 요약 금지** (FR-008) |
| 추천 | 확인된 책 목록 + 기분 → 3권 | **반드시 주어진 목록 안에서만 고른다.** 무관한 기분은 `relevant: false`로 판정 (FR-006·FR-009) |
| 문답 | 확인된 책 목록 → 질문 2~3개(각 선택지 3~4개) | 책 목록을 근거로 만든다 (FR-007) |

### 구조화 출력 스키마 파생 — 이 지시를 반드시 따르라

TR-002가 "Claude structured output용 JSON Schema를 **같은 스키마에서 파생**한다"고 정했다. 타입과 스키마를 두 벌 적으면 한쪽만 고쳐지는 날이 온다.

**이 리포의 `zod` 3.25.76에는 `zod/v4` 진입점이 있고 거기에 `toJSONSchema`가 들어 있다.** 확인된 사실이다:

```
node -e "console.log(typeof require('zod/v4').toJSONSchema)"   // => function
```

이것을 쓴다. **`zod-to-json-schema` 같은 패키지를 설치하지 마라.**

`zod/v4`의 `toJSONSchema`를 쓸 수 없는 사정이 생기면(런타임 오류 등) 손으로 JSON Schema를 적되, **파생 결과와 zod 스키마가 어긋나지 않는지 검증하는 테스트를 반드시 함께 쓴다.** 어긋난 채로 두면 모델이 zod가 거부할 모양을 만들고, 그 실패가 사용자에게는 "책을 못 읽었다"로 보인다.

### 인터페이스 (시그니처 수준. 내부 구현은 재량이다)

```ts
/** 각 호출의 프롬프트. 순수 함수 — 입력만으로 문자열이 결정된다 */
export function buildExtractPrompt(): string;
export function buildNotePrompt(books: readonly { isbn13: string; title: string; author: string }[]): string;
export function buildRecommendPrompt(books: readonly {...}[], mood: string): string;
export function buildQuestionsPrompt(books: readonly {...}[]): string;

/** 구조화 출력용 JSON Schema. zod 스키마에서 파생한다 */
export const extractionJsonSchema: unknown;
export const noteJsonSchema: unknown;
export const recommendJsonSchema: unknown;
export const questionsJsonSchema: unknown;
```

### 반드시 지킬 규칙

1. **프롬프트는 순수 함수다.** 환경변수를 읽거나 시각을 참조하지 마라. 같은 입력에 항상 같은 문자열이 나와야 테스트할 수 있다.
2. **모델 ID를 프롬프트에 넣지 마라.** 모델 선택은 `env.ts`의 `getExtractModel()`·`getRecommendModel()`이 하고, 호출은 다음 step의 `services/anthropic.ts`가 한다.
3. **추천 프롬프트는 허용 목록을 명시적으로 싣는다.** 모델이 목록 밖 책을 고르지 못하게 프롬프트에서 한 번, 응답 검증에서 또 한 번 막는다. **프롬프트만 믿지 마라** — 검증은 다음 계층의 몫이지만 프롬프트도 제 몫을 해야 한다 (FR-009).
4. **한줄평은 줄거리를 요약하지 않는다.** 60자 상한과 함께 프롬프트에 못박아라. `identifiedBookSchema`의 `claudeNote`가 `.max(60)`이므로 넘치면 zod가 통째로 거부한다.
5. **사실과 해석을 섞지 마라.** 프롬프트가 모델에게 제목·저자·출판사·쪽수·평점을 **생성하라고 요구해서는 안 된다.** 그것들은 알라딘에서 오는 사실이다 (ADR-002). 모델이 만드는 것은 `claudeNote`와 추천 `reason`뿐이다.
6. **한국어 프롬프트를 쓴다.** `harness/config.json`의 `project.language`가 `ko`이고 사용자에게 보이는 생성 텍스트가 한국어여야 한다.
7. **후보 상한을 프롬프트에도 적어라.** 스키마가 60건에서 자르지만, 모델이 200건을 만들어 놓고 잘리는 것보다 60건만 만드는 편이 토큰이 싸다.

### 테스트 (먼저 작성한다)

`src/lib/prompts.test.ts`.

- 네 프롬프트가 전부 비어 있지 않고, 같은 입력에 같은 문자열을 돌려준다 (순수성)
- 추천 프롬프트에 **입력 목록의 모든 `isbn13`이 들어 있다** (허용 목록이 실제로 실리는가)
- 한줄평 프롬프트에 "60자"와 줄거리 요약 금지 지시가 들어 있다
- **파생한 JSON Schema가 zod 스키마와 일치한다** — 최소한 다음을 검증하라:
  - 추출 스키마의 `candidates` 상한이 60이다
  - 추천 스키마가 `MAX_RECOMMENDATIONS`(3) 상한을 담고 있다
  - 문답 스키마가 질문 2~3개 제약을 담고 있다
  - 파생 결과가 `JSON.stringify`로 직렬화된다 (Anthropic API에 실려야 하므로)
- **zod 스키마가 거부하는 모양은 JSON Schema도 허용하지 않는다** — 대표 케이스 하나 이상으로 확인하라
- 책 목록이 비어 있을 때도 프롬프트 생성이 예외를 던지지 않는다

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
   - `package.json`이 변하지 않았는가? (`git diff package.json` — 새 의존성 0건이어야 한다)
   - `lib/`가 `services/`를 import하지 않는가?
   - 프롬프트가 사실 필드를 생성하라고 요구하지 않는가? (ADR-002)
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/services-core/index.json`의 step 2를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(export한 함수·상수명과 JSON Schema 파생 방법을 명시하라. 다음 step이 쓴다)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **새 npm 의존성을 절대 추가하지 마라.** `zod-to-json-schema` · `@anthropic-ai/tokenizer` 등을 설치하지 마라. 이유: `zod/v4`의 `toJSONSchema`가 이미 있고, 스택 확장은 `/docs/ADR.md`에 ADR을 먼저 써야 한다 (CLAUDE.md CRITICAL).
- **`src/lib/schemas.ts`의 기존 스키마를 바꾸지 마라.** 이유: TR-002가 확정한 계약이고 테스트 56건이 걸려 있다. 파생만 하고 원본은 건드리지 않는다.
- **타입과 스키마를 두 벌 적지 마라.** 이유: TR-002의 성공 지표가 "타입과 스키마 중복 정의 0건"이다.
- **실제 Claude API를 호출하지 마라.** 이유: 이 step은 문자열과 스키마만 만든다. 호출은 다음 step이다.
- **`src/services/`나 `src/app/api/`를 만들지 마라.** 이유: 레이어 경계이고 범위 밖이다.
- **`harness/` · `docs/` · `scripts/` · `.claude/` · `.env.example` 을 고치지 마라.** 이유: `main_owned_paths`다.
- **이전 step이 만든 `env.ts` · `budget.ts`를 수정하지 마라.** 결함을 발견하면 고치지 말고 `summary`에 적어 보고하라.
- **기존 테스트를 깨뜨리지 마라.**
