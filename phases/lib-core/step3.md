# Step 3: merge — 후보 상한·중복 제거·결정적 절단 (TR-005)

## 읽어야 할 파일

- `/docs/PRD.md` — **FR-004 (사진 간 중복 제거) · FR-005 (목록 상한) · FR-012 (조회 전 후보 상한)** 가 이 step의 계약이다
- `/docs/TRD.md` — 3번 표의 TR-005 행 (성공 지표와 엣지 케이스에 절단 순서가 못박혀 있다), 10번 "병목 예상 지점"
- `/docs/ADR.md` — ADR-005 (사유 분리), ADR-002
- `/docs/ARCHITECTURE.md` — "강등 패턴", 데이터 흐름 1 (사진 분석)
- `src/lib/match.ts` (**이전 step 산출물 — 정규화 함수를 여기서 재사용한다**)
- `src/lib/env.ts` — `MAX_CANDIDATES_FOR_LOOKUP`(80) · `MAX_IDENTIFIED_BOOKS`(50) · `MAX_UNIDENTIFIED_BOOKS`(100)
- `src/lib/schemas.ts` · `src/types/book.ts` — `ExtractedCandidate` · `IdentifiedBook` · `UnidentifiedBook`

## 작업

`src/lib/merge.ts`를 새로 만든다. 증폭 방지와 중복 제거, 그리고 **결정적 절단**을 담당하는 순수 함수들이다.

이 모듈이 없으면 판독 한 번의 이상 동작이 알라딘 일일 한도(5,000회)를 한 요청에 소진시킨다 (FR-012, TRD 10번).

### 3단계 (순서가 중요하다)

**① 알라딘 조회 *전*** — 입력: 사진별 추출 후보 전량

1. `confidence < 0.3`인 후보를 `unreadable`로 강등한다 (조회하지 않는다)
2. 남은 후보를 **제목+저자 정규화 키**로 사전 병합한다 (step 2의 `normalizeTitle`·`normalizeAuthor` 재사용)
3. `confidence` 내림차순으로 **80건(`MAX_CANDIDATES_FOR_LOOKUP`)까지만** 남긴다

**② 알라딘 조회 *후*** — 입력: 확인된 책 목록

4. `isbn13` 기준으로 중복을 제거한다. **최초 등장 사진 인덱스(`photoIndex`)를 유지**한다 (FR-004)

**③ 상한 절단**

5. 확인된 책 **50건**(`MAX_IDENTIFIED_BOOKS`), 미확인 **100건**(`MAX_UNIDENTIFIED_BOOKS`)으로 자르고 넘친 개수를 따로 돌려준다

### 절단 순서는 결정적이어야 한다 (FR-005 · TR-005)

확인된 책을 자를 때의 정렬은 **정확히 이 순서다**:

1. `aladinRating` 내림차순
2. `aladinRating`이 `null`인 것은 **최하위**
3. 동점이면 `photoIndex` 오름차순 (먼저 등장한 사진 순)
4. 그래도 동점이면 `isbn13` 오름차순

같은 입력에 항상 같은 출력이 나와야 한다. 정렬이 불안정하면 같은 사진으로 두 번 분석했을 때 결과가 달라져 사용자가 "왜 아까 있던 책이 사라졌지"를 묻게 된다.

### 인터페이스 (시그니처 수준. 내부 구현은 재량이다)

```ts
/** ① 조회 전 축소. 강등된 것과 조회 대상을 나눠 돌려준다 */
export function reduceBeforeLookup(candidates: readonly ExtractedCandidate[]): {
  toLookup: ExtractedCandidate[];
  unreadable: ExtractedCandidate[];
};

/** ② ISBN13 중복 제거. 최초 photoIndex 유지 */
export function dedupeByIsbn<T extends { isbn13: string; photoIndex: number }>(
  books: readonly T[],
): T[];

/** ③ 결정적 절단 */
export function capIdentified<T extends { aladinRating: number | null; photoIndex: number; isbn13: string }>(
  books: readonly T[],
): { kept: T[]; overflowCount: number };

export function capUnidentified<T>(books: readonly T[]): { kept: T[]; overflowCount: number };

export const CONFIDENCE_FLOOR = 0.3;
```

### 반드시 지킬 규칙

1. **입력을 변형하지 마라.** 전부 순수 함수다. `sort`는 원본 배열을 제자리에서 바꾸므로 복사한 뒤 정렬하라.
2. **`null` 평점의 정렬 위치를 명시적으로 처리하라.** JavaScript의 비교 연산은 `null`에 대해 조용히 이상하게 동작한다. 테스트로 고정하라.
3. **ISBN13이 없는 책은 애초에 확인으로 올라오지 않으므로**(TR-004) 대체 키 병합 경로를 두지 마라. 없는 경우를 상상해 분기를 늘리는 것은 검증할 수 없는 코드를 만드는 일이다.
4. **강등된 후보를 조용히 버리지 마라.** `unreadable`도 사용자에게 미확인으로 보여야 한다 (ADR-002 — 왜 빠졌는지 보여준다).
5. **상한 상수를 다시 적지 마라.** 전부 `src/lib/env.ts`에 있으니 import하라. 숫자를 두 곳에 적으면 한쪽만 고쳐지는 날이 온다.
6. **step 2의 정규화를 재사용하라.** `merge.ts`에 정규화를 다시 구현하면 두 모듈의 병합 키가 소리 없이 어긋난다.

### 테스트 (먼저 작성한다)

`src/lib/merge.test.ts`. 최소한 아래를 덮어라.

- `confidence` 0.29는 강등되고 0.30은 조회 대상이다 (경계값)
- 제목+저자가 정규화 후 같은 후보 3건이 1건으로 병합된다
- 후보 300건을 넣어도 `toLookup`이 **80건을 넘지 않는다** (TR-005 성공 지표)
- 같은 책이 사진 5장에 모두 등장해도 결과 1권이고 `photoIndex`는 **최초 등장 값**이다
- 51권 입력 시 정확히 50권 + `overflowCount: 1`
- **절단 순서 결정성**: 평점 `null`이 섞인 입력을 순서만 바꿔 두 번 넣어도 결과가 동일하다
- 평점 동점 + `photoIndex` 동점이면 `isbn13` 오름차순으로 갈린다
- 미확인 101건 입력 시 100건 + `overflowCount: 1`
- 입력 배열이 호출 후에도 변형되지 않는다

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
   - 상한 상수를 `env.ts`에서 가져왔는가? (숫자를 새로 적지 않았는가)
   - 정규화를 `match.ts`에서 재사용했는가?
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/lib-core/index.json`의 step 3을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(생성한 파일과 export한 함수명)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **새 npm 의존성을 추가하지 마라** (`lodash` 등 유틸 라이브러리 포함). 이유: 스택 확장은 ADR이 먼저다 (CLAUDE.md CRITICAL).
- **`src/lib/match.ts`의 정규화 함수를 복사해 오지 마라.** import해서 써라. 이유: 두 벌이 되면 병합 키가 소리 없이 어긋난다.
- **`src/lib/env.ts`의 상한 상수를 바꾸지 마라.** 이유: 값의 근거가 PRD FR-005·FR-012와 TRD 10번에 있다. 바꾸려면 문서가 먼저다.
- **`src/services/`를 만들거나 import하지 마라.** 이유: 레이어 경계다.
- **`harness/` · `docs/` · `scripts/` · `.claude/` 를 고치지 마라.** 이유: `main_owned_paths`가 메인 에이전트 단독 소유로 정한 곳이다.
- **이전 step이 만든 파일(`proof.ts` · `analytics.ts` · `match.ts`)을 수정하지 마라.** 결함을 발견하면 고치지 말고 `summary`에 적어 보고하라.
- **기존 테스트를 깨뜨리지 마라.**
