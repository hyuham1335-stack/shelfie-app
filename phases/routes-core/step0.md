# Step 0: aladin-lookup — ItemLookUp으로 서지 사실 완성 (TR-004 보완)

## 읽어야 할 파일

- `/docs/API_SPEC.md` — **`POST /api/analyze` 응답의 `identified` 항목이 이 step의 목표다.** `pages`·`aladinRating`·`aladinLink`가 거기 있다. `POST /api/books/resolve` 응답도 같은 필드를 요구한다
- `/docs/TRD.md` — 3번 표의 TR-004 행, 7번 "시간 예산"(대조 예산 12s)과 "Circuit Breaker 정책"의 요청 스코프 브레이커, 10번 병목 예상 지점
- `/docs/ADR.md` — **ADR-005(실패와 데이터 없음의 분리)** · ADR-002
- `/docs/ARCHITECTURE.md` — 레이어 의존, "검증 경계"·"강등"·"사유 보존" 패턴, 데이터 흐름 1
- `src/services/aladin.ts` — **이전 런의 산출물. 이것을 확장한다**
- `src/services/aladin.test.ts` — 기존 32건. 깨뜨리지 마라
- `src/lib/schemas.ts` — `aladinCandidateSchema`(현재 반환) · **`aladinFactsSchema`(목표)**
- `src/lib/match.ts` — `LookupOutcome` 타입
- `src/lib/budget.ts` — `deadlineFor("lookup")`

## 작업

`src/services/aladin.ts`를 확장해 알라딘 **ItemLookUp** 경로를 붙인다.

### 왜 필요한가

이전 런의 `aladin.ts`는 ItemSearch만 호출하고 `aladinCandidateSchema`(`isbn13`·`title`·`author`·`publisher`·`coverUrl`)까지만 채운다. 그런데 `API_SPEC`의 `analyze`·`resolve` 응답은 **`pages`·`aladinRating`·`aladinLink`까지** 요구한다 — 즉 `aladinFactsSchema`다. 지금 상태로는 라우트가 응답을 만들 수 없다.

이전 런의 `aladin` step이 직접 올린 보고이기도 하다: *"`LookupOutcome`이 `aladinCandidate`만 담는 형태라 `IdentifiedBook`에 필요한 `pages`·`aladinRating`·`aladinLink`는 이 함수로 채울 수 없다 — ItemLookUp 경로가 라우트 step에서 따로 필요하다."*

### 반드시 지킬 규칙

1. **`no_match`와 `lookup_failed`를 절대 섞지 마라.** ItemLookUp이 5xx·타임아웃을 내면 그 책은 `lookup_failed`다. ItemSearch로 찾았는데 ItemLookUp이 실패한 경우도 마찬가지 — **확인으로 승격시키지 마라.** 사실 필드를 못 채운 책을 확인된 책이라고 부르면 화면이 빈 칸을 사실인 것처럼 보여준다 (ADR-002, ADR-005).
2. **호출 수를 재검토하라.** 대조 예산은 12s인데 후보 80건 × (ItemSearch + ItemLookUp) = 최대 160회가 된다. 다음 중 하나를 택하고 **선택한 이유를 코드 주석에 남겨라**:
   - ItemSearch 응답에 이미 들어 있는 필드를 최대한 쓰고 ItemLookUp은 **확인으로 승격된 책에만** 부른다 (권장 — 미확인 책은 어차피 사실 필드가 필요 없다)
   - ItemLookUp을 배치로 묶는다 (알라딘이 지원하는 경우)
3. **요청 스코프 브레이커를 ItemLookUp에도 적용하라.** 이미 만들어 둔 `RequestBreaker`를 재사용한다. 새로 만들지 마라.
4. **데드라인을 인자로 받아라.** ItemSearch와 ItemLookUp이 **합쳐서** `deadlineFor("lookup")` 안에 살아야 한다. 각자 12s를 쓰면 합이 24s가 되어 총 예산을 깬다 (ADR-005).
5. **응답은 반드시 zod를 통과한 뒤에만 도메인 타입으로 쓴다.** `aladinFactsSchema`를 통과하지 못한 레코드는 확인으로 올리지 말고 제외 건수를 로그로 남겨라.
6. **`pages`·`aladinRating`은 `null`이 정상값이다.** 알라딘이 정보를 안 주는 책이 있다. `null`과 "조회 실패"를 구분하라 — 전자는 확인된 책이고 후자는 `lookup_failed`다.
7. **TTB 키를 로그·에러 메시지·URL에 남기지 마라.** 이미 `warn()` 하나로 출구를 좁혀 뒀으니 그 규약을 유지하라.
8. **기존 `searchByTitle`·`searchMany`의 시그니처를 깨지 마라.** 32건의 테스트가 걸려 있다. 확장은 새 함수로 하거나 선택적 인자로 한다.

### 인터페이스 (시그니처 수준. 내부 구현은 재량이다)

```ts
/** ItemLookUp 으로 서지 사실을 채운다. 실패는 예외가 아니라 판별 가능한 값이다 */
export type FactsOutcome =
  | { status: "ok"; facts: AladinFacts }
  | { status: "failed" };

export function lookupFacts(isbn13: string, options: SearchOptions): Promise<FactsOutcome>;

/** 확인된 책들의 사실을 채운다. 동시성·브레이커·데드라인은 searchMany 와 같은 규약 */
export function lookupFactsMany(
  isbn13s: readonly string[],
  options: SearchOptions,
): Promise<FactsOutcome[]>;
```

### 테스트 (먼저 작성한다)

`src/services/aladin.test.ts`를 **확장**한다(기존 32건 유지). `fetch`는 전부 주입·모킹한다.

- ItemLookUp 200 + 정상 응답 → `aladinFactsSchema`를 통과한 `facts`
- `pages`·`aladinRating`이 없는 응답 → `null`로 채워지고 **`status: "ok"`** (조회 실패가 아니다)
- **ItemLookUp 5xx·타임아웃 → `{ status: "failed" }`** — 이 테스트는 삭제하지 마라 (ADR-005 회귀)
- `aladinFactsSchema`를 어긴 응답(예: `aladinLink` 누락) → `failed`, 확인으로 승격되지 않는다
- 브레이커가 Open이면 ItemLookUp을 호출하지 않고 전부 `failed`
- `lookupFactsMany`의 동시 실행 수가 `ALADIN_CONCURRENCY`를 넘지 않는다
- 데드라인이 0이면 호출하지 않고 즉시 `failed`
- ItemSearch + ItemLookUp 합산 호출이 데드라인을 넘기지 않는다
- **에러 메시지·로그에 TTB 키가 없다** (시크릿 유출 회귀 — 삭제하지 마라)
- 기존 32건이 그대로 통과한다

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
   - `no_match`와 `lookup_failed`가 끝까지 다른 값으로 나르는가?
   - 사실 필드를 못 채운 책이 확인으로 승격되지 않는가? (ADR-002)
   - 테스트가 실제 네트워크를 치지 않는가?
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/routes-core/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(export한 함수·타입명과 호출 수를 어떻게 줄였는지 포함하라. 다음 step이 쓴다)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **`index.json`의 타임스탬프 필드를 쓰지 마라.** `started_at`·`completed_at`·`failed_at`·`blocked_at`·`created_at`은 전부 실행기가 기록한다. 이유: 형식이 어긋나면 파일럿 실측이 오염된다.
- **실제 알라딘 API를 호출하지 마라.** 이유: `/docs/TRD.md` 8번이 정한 규칙이다.
- **새 npm 의존성을 추가하지 마라.** 이유: 스택 확장은 ADR이 먼저다 (CLAUDE.md CRITICAL).
- **`no_match`와 `lookup_failed`를 뭉개지 마라.** 이유: 시스템 문제를 데이터 문제로 설명하게 된다 (ADR-005).
- **사실 필드를 못 채운 책을 확인으로 표시하지 마라.** 이유: ADR-002가 가장 심각한 결함으로 규정한 것이다.
- **`src/app/api/`를 만들지 마라.** 이유: 라우트는 step 2~4다.
- **`src/lib/` 파일을 수정하지 마라.** 이유: 이전 런들이 확정한 계약이다. 결함을 발견하면 고치지 말고 `summary`에 적어 보고하라.
- **`harness/` · `docs/` · `scripts/` · `.claude/` · `.env.example` 을 고치지 마라.** 이유: `main_owned_paths`다.
- **기존 테스트를 깨뜨리지 마라.**
