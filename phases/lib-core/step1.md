# Step 1: analytics — 구조화 이벤트 로그 (TR-012)

## 읽어야 할 파일

- `/docs/PRD.md` — **7번 "이벤트 로그 (Tracking Plan)"의 표가 이 step의 계약이다.** 이벤트 8종의 이름·수집 경로·발생 시점·속성이 전부 거기 있다. 2번의 North Star와 가드레일 지표도 함께 읽어라 — 어떤 속성이 왜 필요한지가 거기서 나온다
- `/docs/TRD.md` — 3번 표의 TR-012·TR-014 행, 6.4 "관측성"
- `/docs/ARCHITECTURE.md` — 레이어 의존 관계 (`lib/`는 순수 함수만)
- `/docs/ADR.md` — ADR-003 (무상태 — 저장소가 없어서 표준 출력에 남긴다), ADR-005 (사유 분리)
- `src/lib/schemas.ts` — `clientEventSchema`, `unidentifiedReasonSchema`
- `src/types/api.ts` — `ClientEvent`
- `src/lib/proof.ts` (이전 step 산출물) — 같은 파일에 두지 말고 참고만 하라

## 작업

`src/lib/analytics.ts`를 새로 만든다. PRD 7번 표의 이벤트 8종을 **구조화 JSON 한 줄**로 표준 출력에 남긴다. 저장소가 없으므로(ADR-003) Vercel 로그가 유일한 조회 수단이다.

### 이벤트 8종 (PRD 7번 표를 정본으로 삼되, 여기 요약을 대조하라)

| 이벤트명 | 속성 |
|---|---|
| `photo_uploaded` | `session_id`, `photo_count` |
| `analyze_completed` | `session_id`, `identified_count`, `unidentified_count`, `unidentified_by_reason`(4종 카운트), `overflow_count`, `failed_photo_count`, `duration_ms`, `input_tokens`, `output_tokens` |
| `analyze_failed` | `session_id`, `error_code`, `failed_photo_count` |
| `questions_generated` | `session_id`, `question_count`, `input_tokens`, `output_tokens` |
| `mood_submitted` | `session_id`, `input_mode`(`free_text`\|`guided`), `retry_index` |
| `book_resolved` | `session_id`, `resolve_attempt`, `matched` |
| `recommend_viewed` | `session_id`, `recommended_count`, `duration_ms`, `input_tokens`, `output_tokens` |
| `recommend_accepted` | `session_id`, `position`(1~3) |

### 인터페이스 (시그니처 수준. 내부 구현은 재량이다)

이벤트마다 속성이 다르므로 **판별 유니온**으로 타입을 잡고, 호출부가 잘못된 속성을 넘기면 컴파일이 깨지게 하라. 이벤트 이름을 문자열로 받는 느슨한 API는 만들지 마라 — 오타가 조용히 통과해 지표가 비게 된다.

```ts
export type AnalyticsEvent =
  | { event: "photo_uploaded"; session_id: string; photo_count: number }
  | { event: "analyze_completed"; /* ... 위 표대로 */ }
  /* ... 8종 전부 */;

/** 이벤트 하나를 JSON 한 줄로 표준 출력에 남긴다 */
export function logEvent(event: AnalyticsEvent): void;
```

`unidentified_by_reason`은 `unidentifiedReasonSchema`의 4종(`unreadable`·`no_match`·`ambiguous`·`lookup_failed`)을 키로 갖는 카운트 객체다. 이 4종을 문자열로 다시 적지 말고 기존 스키마/타입에서 파생시켜라 — 사유가 늘거나 이름이 바뀌면 컴파일이 깨져야 한다.

### 반드시 지킬 규칙

1. **한 이벤트 = 한 줄의 JSON.** 여러 줄로 나누거나 pretty-print 하지 마라. 로그 집계가 줄 단위이기 때문이다.
2. **PII·이미지·판독 원문(`rawText`)을 절대 기록하지 마라.** PRD 7번이 명시한 금지사항이다. 타입 수준에서 그런 필드를 받을 수 없게 만드는 편이 낫다.
3. **로깅 실패가 요청 처리를 막지 않는다.** 직렬화 실패(순환 참조 등)를 포함해 전부 `try/catch`로 삼킨다. 다만 **조용히 삼키지는 마라** — 삼켰다는 사실 자체는 남길 수 있게 하라(예: 최소한의 폴백 로그).
4. **Claude를 호출하는 이벤트에는 `input_tokens`·`output_tokens`가 필수다.** 타입에서 옵셔널로 두지 마라. 이유: 가드레일이 "세션당 비용 300원"인데 일부 호출의 토큰이 빠지면 실제보다 낮게 집계된다.
5. **`lookup_failed`를 다른 사유와 합치지 마라.** 미확인은 사유별로 나눠 세고, `lookup_failed`(외부 장애)는 미확인 비율 가드레일의 분자에서 제외할 수 있어야 한다 (ADR-005). 그러려면 사유별 카운트가 로그에 따로 남아 있어야 한다.
6. **지표에 연결되지 않는 이벤트를 새로 만들지 마라.** PRD 7번 표에 없는 이벤트는 추가하지 않는다.

### 테스트 (먼저 작성한다)

`src/lib/analytics.test.ts`. `console.log`(또는 사용하는 출력 함수)를 `vi.spyOn`으로 가로채 검증하라.

- 8종 각각이 정확한 `event` 이름과 표에 적힌 속성으로 출력된다
- 출력이 **한 줄이고** `JSON.parse`로 되읽힌다
- 직렬화가 실패해도 예외가 호출부로 새어 나가지 않는다
- `unidentified_by_reason`이 4종 키를 모두 갖는다
- 토큰 필드를 빠뜨린 이벤트는 **타입 수준에서 막힌다** (컴파일이 곧 검증이므로, 이 항목은 테스트 대신 타입 정의로 보장하고 그 사실을 주석으로 남겨라)

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
   - `lib/`가 `services/`를 import하지 않는가?
   - PRD 7번 표의 이벤트명·속성과 코드가 1:1로 일치하는가?
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/lib-core/index.json`의 step 1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(생성한 파일과 export한 함수·타입명)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **새 npm 의존성을 추가하지 마라** (로깅 라이브러리 포함). 이유: 구조화 JSON 한 줄은 `JSON.stringify`로 충분하고, 스택 확장은 ADR이 먼저다 (CLAUDE.md CRITICAL).
- **`app/api/events/route.ts`를 만들지 마라.** 이유: TR-014는 별도 step이고 라우트는 이번 파일럿 범위 밖이다. 이 step은 `lib/analytics.ts`만 만든다.
- **`harness/` · `docs/` · `scripts/` · `.claude/` 를 고치지 마라.** 이유: `harness/config.json`의 `main_owned_paths`가 메인 에이전트 단독 소유로 정한 곳이다.
- **`src/services/`를 만들거나 import하지 마라.** 이유: 레이어 경계다.
- **`src/lib/schemas.ts`의 기존 스키마를 바꾸지 마라.** 이유: TR-002가 확정한 계약이고 기존 테스트 56건이 걸려 있다.
- **이전 step이 만든 `src/lib/proof.ts`를 수정하지 마라.** 이유: 이 step의 범위가 아니다. 결함을 발견하면 고치지 말고 `summary`에 적어 보고하라.
- **기존 테스트를 깨뜨리지 마라.**
