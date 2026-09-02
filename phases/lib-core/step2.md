# Step 2: match — 제목 유사도와 확인/미확인 판정 (TR-004의 lib 부분)

## 읽어야 할 파일

- `/docs/PRD.md` — **FR-003 (확인/미확인 판정)이 이 step의 계약이다.** US-001의 AC도 함께 읽어라
- `/docs/TRD.md` — 3번 표의 TR-004 행 (판정 규칙과 엣지 케이스), 6.1 성능
- `/docs/ADR.md` — **ADR-002 (알라딘 대조를 통과하지 않은 책을 확인으로 표시하지 않는다)**, ADR-005 (실패와 데이터 없음의 분리)
- `/docs/ARCHITECTURE.md` — "강등 패턴", "사유 보존" 패턴, 레이어 의존 관계
- `src/lib/schemas.ts` — `aladinCandidateSchema` · `unidentifiedReasonSchema` · `extractedCandidateSchema`
- `src/types/book.ts` — `AladinCandidate` · `ExtractedCandidate` · `UnidentifiedReason`
- `CLAUDE.md` — 알라딘 대조 관련 CRITICAL 규칙

## 작업

`src/lib/match.ts`를 새로 만든다. 추출된 후보 1건과 알라딘 검색 결과 목록을 받아 **확인인지 미확인인지, 미확인이면 왜인지**를 판정하는 순수 함수다.

**알라딘을 실제로 호출하는 `services/aladin.ts`는 이 step에서 만들지 않는다.** 이 step은 판정 로직만 담당하고, 알라딘 응답은 인자로 받는다.

### 판정 규칙 (FR-003 · TR-004)

정규화한 제목의 유사도를 기준으로 판정한다.

| 조건 | 결과 |
|---|---|
| 유사도 0.8 이상인 후보가 **정확히 1건** | **확인** |
| 유사도 0.8 이상인 후보가 **0건** | 미확인 `no_match` |
| 유사도 0.8 이상인 후보가 **2건 이상** | 저자 일치로 tie-break → 1건으로 좁혀지면 **확인**, 그래도 복수면 미확인 `ambiguous` |
| 추출 후보의 판독 자체가 불완전 | 미확인 `unreadable` |
| 알라딘을 조회하지 못함 (5xx·타임아웃·예산 소진) | 미확인 `lookup_failed` |

### 인터페이스 (시그니처 수준. 내부 구현은 재량이다)

```ts
/** 비교용 정규화. 공백·대소문자·문장부호·괄호 부제 등을 정리한다 */
export function normalizeTitle(raw: string): string;
export function normalizeAuthor(raw: string): string;

/** 0~1 유사도. 정규화 후 Levenshtein 거리 기반 */
export function titleSimilarity(a: string, b: string): number;

export const MATCH_THRESHOLD = 0.8;

/** 조회 결과를 인자로 받는다 — 이 함수는 네트워크를 모른다 */
export type LookupOutcome =
  | { status: "ok"; candidates: readonly AladinCandidate[] }
  | { status: "failed" };   // 5xx · 타임아웃 · 예산 소진

export type MatchVerdict =
  | { kind: "identified"; candidate: AladinCandidate }
  | { kind: "unidentified"; reason: UnidentifiedReason; candidates: AladinCandidate[] };

export function judge(extracted: ExtractedCandidate, lookup: LookupOutcome): MatchVerdict;
```

### 반드시 지킬 규칙

1. **`no_match`와 `lookup_failed`를 절대 같은 값으로 뭉개지 마라.** 알라딘이 5xx·타임아웃을 냈으면 `lookup_failed`다. `no_match`는 "알라딘에 정말 없음"이고 `lookup_failed`는 "지금 확인 못 함"이다. 시스템 문제를 데이터 문제로 설명하는 것은 이 프로젝트에서 가장 심각한 결함 중 하나다 (ADR-005, CLAUDE.md CRITICAL).
2. **ISBN13이 없는 레코드는 확인으로 승격하지 않는다** (TR-004). 유사도가 아무리 높아도 마찬가지다. 이유: 사진 간 중복 제거(FR-004)와 서명(FR-011)이 전부 ISBN13을 키로 삼는다.
3. **`candidates`는 `reason`이 `ambiguous`일 때만 채운다.** `unidentifiedBookSchema`의 `.refine`이 이것을 이미 강제하고 있으니, 판정 결과를 그 스키마에 넣어도 통과하도록 맞춰라. 다른 사유에 후보를 붙이면 화면이 "왜 빠졌는지"를 잘못 설명한다.
4. **후보 수 상한은 `MAX_ALADIN_CANDIDATES`(5)다.** `src/lib/env.ts`에 이미 있으니 숫자를 다시 적지 말고 import하라.
5. **정규화는 되돌릴 수 없는 정보를 버린다는 점을 의식하라.** 무엇을 정규화했고 왜 그렇게 했는지 함수 상단 주석에 남겨라. 한글 제목이 주 대상이므로 영문 전용 가정(대소문자만 처리 등)을 두지 마라.
6. **Levenshtein 구현은 직접 쓴다** (새 의존성 금지). 긴 문자열에서 O(n*m) 메모리가 문제되지 않도록 두 행만 유지하는 구현을 권한다.

### 테스트 (먼저 작성한다)

`src/lib/match.test.ts`. 최소한 아래를 덮어라.

- 동일 제목 → 유사도 1.0, 완전히 다른 제목 → 낮은 값
- 공백·문장부호·괄호 부제만 다른 제목이 임계값을 넘는다 (한글 예시로)
- 0.8 이상 1건 → `identified`
- 0.8 이상 0건 → `no_match`이고 `candidates`가 비어 있다
- 0.8 이상 2건 + 저자 일치 1건 → tie-break로 `identified`
- 0.8 이상 2건 + 저자 구분 불가 → `ambiguous`이고 `candidates`가 채워진다
- **`lookup.status === "failed"`면 후보가 있든 없든 `lookup_failed`** — 이 테스트는 삭제 대상이 아니다 (ADR-005 회귀 테스트)
- ISBN13이 없는(혹은 형식이 틀린) 후보는 유사도 1.0이어도 확인으로 승격되지 않는다
- 추출 후보가 `unreadable` 조건일 때 알라딘을 보지도 않고 `unreadable`을 낸다
- `ambiguous` 후보 수가 5건을 넘지 않는다

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
   - `lib/`가 `services/`를 import하지 않는가? (이 함수는 네트워크를 몰라야 한다)
   - `no_match`와 `lookup_failed`가 코드 경로에서 끝까지 다른 값으로 나르는가?
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/lib-core/index.json`의 step 2를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(생성한 파일과 export한 함수명 — 특히 정규화 함수명을 명시하라. 다음 step이 재사용한다)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **새 npm 의존성을 추가하지 마라** (`fastest-levenshtein` 등 문자열 거리 라이브러리 포함). 이유: 스택 확장은 `/docs/ADR.md`에 ADR을 먼저 써야 한다 (CLAUDE.md CRITICAL).
- **`src/services/aladin.ts`를 만들거나 import하지 마라.** 이유: 서비스 계층은 이번 파일럿 범위 밖이고, `lib/`는 외부 호출을 하지 않는 순수 함수만 담는다.
- **알라딘 대조를 통과하지 않은 책을 확인으로 표시하지 마라.** 이유: `/docs/ADR.md` ADR-002가 이 프로젝트에서 가장 심각한 결함으로 규정한 것이다.
- **`harness/` · `docs/` · `scripts/` · `.claude/` 를 고치지 마라.** 이유: `main_owned_paths`가 메인 에이전트 단독 소유로 정한 곳이다.
- **`src/lib/schemas.ts`의 기존 스키마를 바꾸지 마라.** 이유: TR-002가 확정한 계약이고 기존 테스트가 걸려 있다.
- **이전 step이 만든 `src/lib/proof.ts` · `src/lib/analytics.ts`를 수정하지 마라.** 결함을 발견하면 고치지 말고 `summary`에 적어 보고하라.
- **기존 테스트를 깨뜨리지 마라.**
