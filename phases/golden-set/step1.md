# Step 1: golden-score

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ARCHITECTURE.md` — 레이어 의존 관계, `lib/golden-*.ts` 노드 3개
- `/docs/ADR.md` — **ADR-010의 판정 규약**이 이 step의 계약이다. ADR-002(사실과 해석의 경계)도 본다
- `/docs/TRD.md` — **8번 "골든 인식률 계약"의 판정 규약 표**가 정의다. TR-003(재현율 90%)·TR-004(오확인 0건)도 본다
- `src/lib/match.ts` — **이 step이 재사용해야 하는 모듈이다.** `normalizeTitle`·`normalizeAuthor`·`titleSimilarity`·`MATCH_THRESHOLD`
- `src/lib/golden-manifest.ts` — step 0이 만든 매니페스트 타입
- `src/lib/env.ts` — `GOLDEN_MIN_RECALL`·`GOLDEN_MAX_MISIDENTIFIED`
- `src/types/book.ts` — `ExtractedCandidate`·`IdentifiedBook`

위 소스 파일은 **프롬프트에 이미 실려 있다. 다시 읽지 마라.** 단 네가 고친 뒤의 내용은 첨부본에 반영되지 않는다.

## 작업

골든 결과의 **판정**을 만든다. 순수 함수만이다 — 외부 호출도 파일 시스템도 없다.

### `src/lib/golden-score.ts` (신규)

```ts
/** 기대 항목 하나가 어떻게 처리됐는가 */
export interface GoldenMatch {
  expected: GoldenExpectedBook;
  /** 짝지어진 추출 후보. 없으면 놓친 것이다 */
  matched: ExtractedCandidate | null;
  similarity: number;
}

/** 사진 1장의 판정 */
export interface GoldenPhotoScore {
  file: string;
  matches: GoldenMatch[];
  /** 기대 목록 어디와도 짝지어지지 않은 채 **확인으로 승격된** 책 (TR-004) */
  misidentified: IdentifiedBook[];
  expectedCount: number;
  matchedCount: number;
  recall: number;
}

/** 세트 전체의 판정 */
export interface GoldenSetScore {
  photos: GoldenPhotoScore[];
  expectedCount: number;
  matchedCount: number;
  recall: number;
  misidentifiedCount: number;
  /** recall >= GOLDEN_MIN_RECALL && misidentifiedCount <= GOLDEN_MAX_MISIDENTIFIED */
  passed: boolean;
}

/** 사진 1장을 판정한다 */
export function scorePhoto(
  photo: GoldenPhoto,
  candidates: readonly ExtractedCandidate[],
  identified: readonly IdentifiedBook[],
): GoldenPhotoScore;

/** 사진별 판정을 세트 전체로 접는다 */
export function aggregateScores(photos: readonly GoldenPhotoScore[]): GoldenSetScore;
```

핵심 규칙 — 어기면 숫자가 거짓말을 한다:

1. **`match.ts`의 임계값과 정규화를 재사용하라.** 자체 유사도 기준을 만들지 마라. 이유: 골든이 프로덕션과 다른 잣대로 재면 골든이 통과해도 실제 판정은 다르게 난다 — 게이트가 재는 대상이 게이트가 지키려는 대상이 아니게 된다 (TRD 8번).
2. **짝짓기는 유사도 내림차순 1:1 그리디다.** 후보와 기대 항목의 모든 쌍에 대해 유사도를 구하고, `MATCH_THRESHOLD` 이상인 쌍만 남긴 뒤, **유사도가 높은 쌍부터** 확정하며 이미 쓰인 기대 항목과 후보를 제외한다. 다대일을 허용하지 마라 — 비슷한 제목 여러 권이 한 기대 항목을 채워 **재현율이 부풀려진다.**
3. **동점은 결정적으로 깨라.** 같은 유사도가 여럿이면 순서가 실행마다 달라져서는 안 된다. 이 리포는 정렬을 항상 결정적으로 만든다(FR-005·TR-005). 2차 키를 정하고 그 근거를 주석에 남겨라.
4. **저자는 tie-break에만 쓴다.** 제목 유사도가 같을 때 `normalizeAuthor`가 일치하는 쪽을 앞세워라 — `judge`가 `ambiguous`를 가르는 방식과 같다(FR-003). 저자를 1차 기준으로 쓰지 마라: 기대 목록의 저자 표기(역자 포함·부제)가 추출 결과와 어긋나는 것이 흔하다.
5. **오확인 판정에서 `isbn13`이 있으면 그것이 이긴다.** 기대 항목에 `isbn13`이 있고 확인된 책의 `isbn13`과 같으면 **제목 유사도와 무관하게 맞은 것**이다. 반대로 기대 목록의 어느 ISBN과도 다르고 제목으로도 짝지어지지 않으면 오확인이다. ISBN이 없는 기대 항목만 제목 유사도로 판정한다. 이유: ISBN은 알라딘이 준 사실이고 제목 유사도는 우리가 만든 추정이다 — 사실이 있는데 추정을 쓰지 않는다 (ADR-002).
6. **기대 항목이 0건인 사진의 재현율은 `0`이 아니다.** 0으로 나누지 말고 이 경우를 명시적으로 다뤄라. 그 사진을 분모에서 빼는 것이 맞고, `aggregateScores`는 **사진별 재현율의 평균이 아니라 전체 기대 건수 대비 전체 매칭 건수**로 계산해야 한다 — 사진마다 책 수가 다른데 평균을 내면 책 3권짜리 사진이 30권짜리 사진과 같은 무게를 갖는다.
7. **`passed`는 두 축을 **모두** 만족해야 한다.** 재현율만 보고 통과시키지 마라 — TR-004의 오확인 0건이 이 프로젝트에서 더 치명적이다(TRD 6.4: 가짜 책이 화면에 떠도 로그에는 정상 응답으로 남는다).

### `src/lib/golden-score.test.ts`

TDD다 — 테스트를 먼저 쓰고 통과하는 구현을 쓴다(CLAUDE.md CRITICAL).

최소한 이것들을 덮어라: 전건 매칭이면 `recall === 1` · 임계값 미만 유사도는 짝지어지지 않음 · **비슷한 후보 둘이 기대 항목 하나를 두고 경쟁하면 하나만 짝지어짐**(1:1 검증) · 동점에서 저자 일치가 이김 · 동점 정렬이 결정적임(입력 순서를 섞어도 같은 결과) · ISBN 일치가 제목 불일치를 이김 · ISBN 불일치 + 제목 불일치면 오확인 · 기대 0건 사진이 분모를 오염시키지 않음 · `aggregateScores`가 사진별 평균이 아니라 전체 비율임(책 수가 다른 사진 2장으로 검증) · 재현율은 통과인데 오확인 1건이면 `passed === false`.

## Acceptance Criteria

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run audit
```

다섯 줄이 한 세트다 (TRD 8번). 하나라도 빼지 마라.

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `lib/golden-score.ts`가 `services/`·`fs`·`process.env`를 import하지 않는가?
   - `match.ts`의 `MATCH_THRESHOLD`를 재사용했는가? 유사도 숫자를 다시 적지 않았는가?
   - 임계값을 `env.ts`에서 가져왔는가? (CLAUDE.md 도메인 상수 단일 출처)
   - CLAUDE.md CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/golden-set/index.json`의 step 1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

`summary`에는 **다음 step이 알아야 할 것**을 담아라 — 내보낸 타입·함수 이름, `GoldenSetScore`의 필드.

## 금지사항

- **`src/lib/match.ts`를 고치지 마라.** 이유: 프로덕션 판정이 그 위에 서 있다. 골든을 위해 그 동작을 바꾸면 골든이 통과시키려고 실제 판정을 움직인 것이 된다. 부족한 것이 있으면 여기서 감싸고 `summary`에 적어라
- **`src/lib/golden-manifest.ts`를 고치지 마라.** 이유: step 0의 산출물이고 계약은 TRD 8번에 있다. 정말 필요하면 `summary`에 적어라
- **파일 시스템을 읽지 마라** (`fs`·`path` import 금지). 이유: 순수 층이다 (ADR-010)
- **리포트 렌더·문자열 포맷을 여기에 쓰지 마라.** 이유: step 2가 `lib/golden-report.ts`에 쓴다. 판정과 표현을 한 모듈에 섞으면 판정을 값으로 검증할 수 없다
- **`*.golden.test.ts` 파일을 만들지 마라.** 이유: step 3의 몫이다
- **`docs/`·`package.json`·`vitest*.config.ts`·`CLAUDE.md`를 고치지 마라.** 이유: 메인 소유 경로이고 계약은 이미 적혀 있다
- **`index.json`의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`). 이유: 실행기가 기록한다
- **`RUNNING` 파일을 읽지도 지우지도 마라.** 이유: 실행기 소유다
- 기존 테스트를 깨뜨리지 마라
