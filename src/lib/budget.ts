/**
 * 단계별 시간 예산과 데드라인 전파 (TRD 7번 "시간 예산", ADR-005).
 *
 * ## 왜 단계마다 타임아웃을 따로 두면 안 되는가
 * `/api/analyze`의 Vercel 함수 상한은 60s다. 단계별 타임아웃을 독립적으로 잡으면
 * **합이 상한을 넘길 수 있다.** 그러면 플랫폼이 연결을 끊어 API_SPEC이 정의한
 * 504와 안내 문구조차 돌려주지 못하고, `analyze_failed` 이벤트도 남지 않는다.
 * 사용자는 이유 없는 실패를 보고 서버에는 아무 기록도 없다 — 그래서 상한을
 * 단계로 쪼개 배분하고, 각 단계는 **자기 예산과 남은 예산 중 작은 쪽** 안에서만 산다.
 *
 * ## 예산 초과는 실패가 아니다
 * 이 모듈은 아무것도 던지지 않는다. 예산 소진은 예외가 아니라 판별 가능한
 * 값(`isExhaustedFor`가 `true`, `deadlineFor`가 `0`)이며, 호출자는 요청을
 * 죽이는 대신 해당 항목만 강등한다 — 대조 미완료는 `lookup_failed`, 한줄평
 * 미완료는 `claudeNote: ""`. 부분 실패를 200으로 돌려주는 fail-soft 패턴이
 * 이미 정해져 있고(/docs/ARCHITECTURE.md), 시간 초과는 그 패턴의 한 경우다.
 *
 * ## 순수 모듈이다
 * `services/`를 import하지 않고 외부 호출도 하지 않는다. 시계는 주입 가능해야
 * 하는데(`createBudget`의 두 번째 인자), 그러지 않으면 예산 소진을 실제로 55초
 * 기다려야만 검증할 수 있다 — TRD 8번이 가짜 타이머 검증을 요구한 이유다.
 */

/** Vercel 함수 실행 상한. `/api/analyze`의 `maxDuration = 60`과 같은 값이다 (TRD 2번) */
export const FUNCTION_MAX_DURATION_MS = 60_000;

/** 응답 조립·로깅에 남겨 두는 여유. 이만큼은 어떤 단계에도 배분하지 않는다 */
export const RESPONSE_RESERVE_MS = 5_000;

/**
 * 요청 하나의 내부 총 예산 55s.
 * 함수 상한에서 여유를 뺀 값이며, 두 값을 각각 적지 않고 여기서 파생시킨다 —
 * TRD 7번 표가 바뀌면 위 두 상수만 고치면 되게 한다.
 */
export const TOTAL_BUDGET_MS = FUNCTION_MAX_DURATION_MS - RESPONSE_RESERVE_MS;

/**
 * 단계별 배분 (TRD 7번 표). 실측 전 추정치이며, 골든 세트 측정 후 재조정할 때
 * **이 객체와 TRD 7번 표·6.1 성능 목표를 함께 고친다.**
 *
 * - `extract` 30s — 책등 추출(사진별 병렬). 끝내지 못한 사진은 `failedPhotoIndexes`
 * - `lookup`  12s — 알라딘 대조(동시성 12). 조회하지 못한 후보는 `lookup_failed`
 * - `note`     8s — 한줄평 배치 1회. 모자라면 호출 자체를 생략하고 `claudeNote: ""`
 */
export const STAGE_BUDGET_MS = {
  extract: 30_000,
  lookup: 12_000,
  note: 8_000,
} as const;

export type BudgetStage = keyof typeof STAGE_BUDGET_MS;

export interface Budget {
  /** 총 예산에서 경과 시간을 뺀 값. 초과했으면 음수를 그대로 돌려준다 */
  remainingMs(): number;
  /** 이 단계에 줄 수 있는 시간 = min(단계 예산, 남은 예산). 음수면 0 */
  deadlineFor(stage: BudgetStage): number;
  /** 남은 예산이 이 단계를 시작할 만큼도 없는가 */
  isExhaustedFor(stage: BudgetStage): boolean;
  /** 예산 시작 시점부터 흐른 시간 */
  elapsedMs(): number;
}

/**
 * 요청 진입점에서 한 번 호출해 예산을 연다.
 *
 * @param totalMs 총 예산. 기본값은 `TOTAL_BUDGET_MS`(55s)
 * @param now 시계. 기본값은 `Date.now`. 테스트는 가짜 시계를 주입한다 (TRD 8번)
 */
export function createBudget(totalMs: number = TOTAL_BUDGET_MS, now: () => number = Date.now): Budget {
  const startedAt = now();

  const elapsedMs = () => now() - startedAt;
  const remainingMs = () => totalMs - elapsedMs();

  return {
    elapsedMs,
    remainingMs,

    /**
     * 남은 예산이 단계 예산보다 작으면 **그쪽을 택한다.** 앞 단계가 빨리 끝나면
     * 그 여유가 뒤로 넘어가고, 앞 단계가 예산을 다 쓰면 뒤 단계가 줄어든다.
     * 단계 예산을 그대로 쓰면 합이 총 예산을 넘겨 이 모듈이 존재할 이유가 사라진다.
     *
     * 음수는 절대 돌려주지 않는다 — 음수 타임아웃을 그대로 넘기면 호출부(SDK·
     * `AbortSignal.timeout`)가 예상 못 한 동작을 한다.
     */
    deadlineFor(stage) {
      return Math.max(0, Math.min(STAGE_BUDGET_MS[stage], remainingMs()));
    },

    /**
     * 이 단계를 온전히 수행할 만큼 남지 않았으면 `true`.
     *
     * `deadlineFor`와 판정 기준이 다른 것은 의도적이다. 추출·대조는 도중에 끊겨도
     * 거기까지의 결과를 살릴 수 있어 줄어든 데드라인으로 진행하지만, 한줄평은
     * 배치 1회 호출이라 절반만 받아 쓸 수 없다 — 그래서 TRD 7번은 "남은 예산이
     * 8s 미만이면 **호출을 생략**"이라고 정했다. 경계 8s 정각은 생략하지 않는다.
     */
    isExhaustedFor(stage) {
      return remainingMs() < STAGE_BUDGET_MS[stage];
    },
  };
}
