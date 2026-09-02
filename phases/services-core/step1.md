# Step 1: budget — 시간 예산과 데드라인 전파 (TRD 7번)

## 읽어야 할 파일

- `/docs/TRD.md` — **7번의 "시간 예산 (Time Budget)" 표가 이 step의 계약이다.** 6.1 성능도 함께 읽어라
- `/docs/ADR.md` — **ADR-005.** 왜 단계별 타임아웃을 따로 두면 안 되는지가 거기 있다
- `/docs/ARCHITECTURE.md` — "시간 예산 패턴"과 데이터 흐름 1(사진 분석)의 예산 표시
- `/docs/API_SPEC.md` — 에러 응답 규약(504가 언제 나가는지)
- `src/lib/env.ts` — 이전 step 산출물. 상수를 여기 둘지 판단할 때 본다

## 작업

`src/lib/budget.ts`를 새로 만든다. 요청 하나의 총 예산을 잡고, 각 단계가 자기 몫과 남은 예산 중 **작은 쪽**을 데드라인으로 삼게 하는 순수 모듈이다.

### 왜 필요한가 (이 문단을 이해한 뒤 구현하라)

`/api/analyze`의 Vercel 함수 상한은 60s다. 단계별 타임아웃을 따로 두면 **합이 상한을 넘길 수 있다.** 그러면 플랫폼이 연결을 끊어 `API_SPEC`이 정의한 504와 안내 문구조차 돌려주지 못하고, `analyze_failed` 이벤트도 남지 않는다. 그래서 상한을 단계로 쪼개 배분하고, 각 단계는 자기 예산 안에서만 산다 (ADR-005).

### 배분 (TRD 7번 표)

총 예산 **55s** (함수 상한 60s − 응답 직렬화·로깅 여유 5s):

| 순서 | 단계 | 예산 | 예산을 다 썼을 때 |
|---|---|---|---|
| 1 | 책등 추출 (사진별 병렬) | 30s | 끝내지 못한 사진은 실패 → `failedPhotoIndexes` |
| 2 | 알라딘 대조 (동시성 12) | 12s | 조회하지 못한 후보는 **`lookup_failed`**로 강등 |
| 3 | 한줄평 배치 (1회) | 8s | 남은 예산이 8s 미만이면 **호출을 생략**하고 `claudeNote: ""` |
| — | 응답 조립·로깅 여유 | 5s | — |

### 인터페이스 (시그니처 수준. 내부 구현은 재량이다)

```ts
export const TOTAL_BUDGET_MS = 55_000;
export const STAGE_BUDGET_MS = {
  extract: 30_000,
  lookup: 12_000,
  note: 8_000,
} as const;

export type BudgetStage = keyof typeof STAGE_BUDGET_MS;

export interface Budget {
  /** 총 예산에서 경과 시간을 뺀 값 */
  remainingMs(): number;
  /** 이 단계의 데드라인 = min(단계 예산, 남은 예산). 음수면 0 */
  deadlineFor(stage: BudgetStage): number;
  /** 남은 예산이 이 단계를 시작할 만큼도 없는가 */
  isExhaustedFor(stage: BudgetStage): boolean;
  elapsedMs(): number;
}

/** now 를 주입 가능하게 만든다 — 가짜 타이머로 예산 소진을 검증해야 한다 */
export function createBudget(totalMs?: number, now?: () => number): Budget;
```

### 반드시 지킬 규칙

1. **데드라인은 항상 `min(단계 예산, 남은 예산)`이다.** 1단계가 빨리 끝나면 그 여유가 뒤 단계로 넘어가고, 1단계가 예산을 다 쓰면 뒤 단계가 줄어든다. 단계 예산을 그대로 쓰면 합이 총 예산을 넘긴다.
2. **음수 데드라인을 만들지 마라.** 남은 예산이 음수면 `0`으로 잘라 돌려준다. 음수 타임아웃을 그대로 넘기면 호출부가 예상 못 한 동작을 한다.
3. **시계를 주입 가능하게 만들어라.** `Date.now()`를 모듈 안에서 직접 부르면 예산 소진을 테스트할 수 없다. TRD 8번이 "시간 예산 테스트는 가짜 타이머로 검증"하라고 명시했다.
4. **이 모듈은 아무것도 실패시키지 않는다.** 예산 초과는 예외가 아니라 **판별 가능한 값**(`isExhaustedFor`가 `true`)이다. 어느 단계가 예산을 넘겨도 요청은 200으로 끝나는 것이 이 프로젝트의 규약이다.
5. **숫자를 두 곳에 적지 마라.** 예산 상수는 이 파일에만 둔다. TRD 7번의 표가 바뀌면 이 파일 하나만 고치면 되게 한다.
6. **`services/`를 import하지 마라.** 순수 함수 모듈이다.

### 테스트 (먼저 작성한다)

`src/lib/budget.test.ts`. 시계를 주입해 검증하라.

- 시작 직후 `remainingMs()`가 총 예산과 같다
- `extract`가 0ms 걸렸으면 `deadlineFor("lookup")`이 단계 예산 12s다 (남은 43s보다 작은 쪽)
- **`extract`가 50s를 썼으면 `deadlineFor("lookup")`이 5s다** — 남은 예산이 더 작을 때 그쪽을 택하는지 (이 프로젝트가 ADR-005에서 정한 핵심 동작)
- 총 예산을 초과하면 `remainingMs()`가 음수여도 `deadlineFor`는 `0`이다
- 남은 예산 7.9s에서 `isExhaustedFor("note")`가 `true`, 8.1s에서 `false` (TRD의 "8s 미만이면 호출 생략" 경계값)
- 세 단계 예산의 합 + 여유 5s가 함수 상한 60s를 넘지 않는다 (배분 자체가 깨지면 잡는 회귀 테스트)
- `elapsedMs()`가 주입한 시계를 따른다

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
   - 예산 숫자가 이 파일에만 있는가?
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/services-core/index.json`의 step 1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(export한 함수·상수명 포함)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **새 npm 의존성을 추가하지 마라** (`p-timeout` 등 타임아웃 유틸 포함). 이유: 스택 확장은 ADR이 먼저다 (CLAUDE.md CRITICAL).
- **단계별로 독립된 타임아웃을 두지 마라.** 이유: 합이 함수 상한을 넘겨 플랫폼이 연결을 끊으면 정의된 504조차 못 돌려준다 (ADR-005).
- **예산 초과를 예외로 던지지 마라.** 이유: 부분 실패는 200으로 돌려주는 fail-soft 패턴이고, 시간 초과는 그 패턴의 한 경우일 뿐이다.
- **`src/services/`나 `src/app/api/`를 만들거나 import하지 마라.** 이유: 레이어 경계이고 이번 step 범위 밖이다.
- **`harness/` · `docs/` · `scripts/` · `.claude/` · `.env.example` 을 고치지 마라.** 이유: `main_owned_paths`가 메인 에이전트 단독 소유로 정한 곳이다.
- **이전 step이 만든 `src/lib/env.ts`를 수정하지 마라.** 결함을 발견하면 고치지 말고 `summary`에 적어 보고하라.
- **기존 테스트를 깨뜨리지 마라.**
