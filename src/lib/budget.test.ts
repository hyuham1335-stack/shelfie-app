import { describe, expect, it } from "vitest";
import {
  createBudget,
  FUNCTION_MAX_DURATION_MS,
  RESPONSE_RESERVE_MS,
  STAGE_BUDGET_MS,
  TOTAL_BUDGET_MS,
  type BudgetStage,
} from "./budget";

/**
 * 가짜 시계. TRD 8번이 "시간 예산 테스트는 가짜 타이머로 검증"하라고 정했다 —
 * 실제로 55초를 기다리는 테스트는 아무도 돌리지 않는다.
 */
function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("createBudget — 총 예산에서 경과를 뺀다", () => {
  it("시작 직후 remainingMs()는 총 예산과 같고 elapsedMs()는 0이다", () => {
    const clock = fakeClock();
    const budget = createBudget(TOTAL_BUDGET_MS, clock.now);

    expect(budget.remainingMs()).toBe(TOTAL_BUDGET_MS);
    expect(budget.elapsedMs()).toBe(0);
  });

  it("elapsedMs()가 주입한 시계를 따른다 — 모듈이 Date.now()를 직접 부르지 않는다", () => {
    const clock = fakeClock();
    const budget = createBudget(TOTAL_BUDGET_MS, clock.now);

    clock.advance(1_234);
    expect(budget.elapsedMs()).toBe(1_234);
    expect(budget.remainingMs()).toBe(TOTAL_BUDGET_MS - 1_234);

    clock.advance(766);
    expect(budget.elapsedMs()).toBe(2_000);
  });

  it("인자 없이 만들면 총 예산 55s에 실제 시계를 쓴다", () => {
    const budget = createBudget();
    expect(budget.remainingMs()).toBeLessThanOrEqual(TOTAL_BUDGET_MS);
    expect(budget.remainingMs()).toBeGreaterThan(TOTAL_BUDGET_MS - 1_000);
  });

  it("총 예산을 넘기면 remainingMs()는 음수를 그대로 돌려준다 — 얼마나 초과했는지가 로그에 필요하다", () => {
    const clock = fakeClock();
    const budget = createBudget(TOTAL_BUDGET_MS, clock.now);

    clock.advance(TOTAL_BUDGET_MS + 3_000);
    expect(budget.remainingMs()).toBe(-3_000);
  });
});

describe("deadlineFor — 항상 min(단계 예산, 남은 예산) (ADR-005)", () => {
  it("추출이 0ms 걸렸으면 lookup 데드라인은 단계 예산 12s다 (남은 55s보다 작은 쪽)", () => {
    const clock = fakeClock();
    const budget = createBudget(TOTAL_BUDGET_MS, clock.now);

    expect(budget.deadlineFor("lookup")).toBe(STAGE_BUDGET_MS.lookup);
  });

  it("추출이 50s를 썼으면 lookup 데드라인은 5s다 — 남은 예산이 더 작으면 그쪽을 택한다", () => {
    const clock = fakeClock();
    const budget = createBudget(TOTAL_BUDGET_MS, clock.now);

    clock.advance(50_000);
    expect(budget.remainingMs()).toBe(5_000);
    expect(budget.deadlineFor("lookup")).toBe(5_000);
  });

  it("앞 단계가 빨리 끝나면 그 여유가 뒤 단계로 넘어간다 — 단계 예산이 상한 역할만 한다", () => {
    const clock = fakeClock();
    const budget = createBudget(TOTAL_BUDGET_MS, clock.now);

    clock.advance(5_000); // 추출이 예산 30s 중 5s만 씀
    expect(budget.deadlineFor("lookup")).toBe(STAGE_BUDGET_MS.lookup);
    expect(budget.deadlineFor("note")).toBe(STAGE_BUDGET_MS.note);
  });

  it("총 예산을 초과하면 데드라인은 음수가 아니라 0이다", () => {
    const clock = fakeClock();
    const budget = createBudget(TOTAL_BUDGET_MS, clock.now);

    clock.advance(TOTAL_BUDGET_MS + 10_000);
    expect(budget.remainingMs()).toBeLessThan(0);
    for (const stage of Object.keys(STAGE_BUDGET_MS) as BudgetStage[]) {
      expect(budget.deadlineFor(stage)).toBe(0);
    }
  });

  it("어느 단계든 데드라인이 남은 예산과 단계 예산을 동시에 넘지 않는다", () => {
    const clock = fakeClock();
    const budget = createBudget(TOTAL_BUDGET_MS, clock.now);

    for (let elapsed = 0; elapsed <= TOTAL_BUDGET_MS + 5_000; elapsed += 1_000) {
      for (const stage of Object.keys(STAGE_BUDGET_MS) as BudgetStage[]) {
        const deadline = budget.deadlineFor(stage);
        expect(deadline).toBeGreaterThanOrEqual(0);
        expect(deadline).toBeLessThanOrEqual(STAGE_BUDGET_MS[stage]);
        expect(deadline).toBeLessThanOrEqual(Math.max(0, budget.remainingMs()));
      }
      clock.advance(1_000);
    }
  });
});

describe("isExhaustedFor — 단계를 시작할 만큼도 남지 않았는가", () => {
  it("남은 예산 7.9s면 note는 소진, 8.1s면 아니다 (TRD의 8s 경계)", () => {
    const clock = fakeClock();
    const budget = createBudget(TOTAL_BUDGET_MS, clock.now);

    clock.advance(TOTAL_BUDGET_MS - 8_100);
    expect(budget.remainingMs()).toBe(8_100);
    expect(budget.isExhaustedFor("note")).toBe(false);

    clock.advance(200);
    expect(budget.remainingMs()).toBe(7_900);
    expect(budget.isExhaustedFor("note")).toBe(true);
  });

  it("정확히 8s가 남았으면 소진이 아니다 — TRD는 '8s 미만이면 생략'이라고 정했다", () => {
    const clock = fakeClock();
    const budget = createBudget(TOTAL_BUDGET_MS, clock.now);

    clock.advance(TOTAL_BUDGET_MS - STAGE_BUDGET_MS.note);
    expect(budget.remainingMs()).toBe(STAGE_BUDGET_MS.note);
    expect(budget.isExhaustedFor("note")).toBe(false);
  });

  it("시작 직후에는 어떤 단계도 소진이 아니다", () => {
    const clock = fakeClock();
    const budget = createBudget(TOTAL_BUDGET_MS, clock.now);

    for (const stage of Object.keys(STAGE_BUDGET_MS) as BudgetStage[]) {
      expect(budget.isExhaustedFor(stage)).toBe(false);
    }
  });

  it("예산을 다 쓰면 모든 단계가 소진이다", () => {
    const clock = fakeClock();
    const budget = createBudget(TOTAL_BUDGET_MS, clock.now);

    clock.advance(TOTAL_BUDGET_MS);
    for (const stage of Object.keys(STAGE_BUDGET_MS) as BudgetStage[]) {
      expect(budget.isExhaustedFor(stage)).toBe(true);
    }
  });

  it("소진 판정이 예외를 던지지 않는다 — 예산 초과는 판별 가능한 값이지 실패가 아니다", () => {
    const clock = fakeClock();
    const budget = createBudget(TOTAL_BUDGET_MS, clock.now);

    clock.advance(TOTAL_BUDGET_MS * 10);
    expect(() => budget.isExhaustedFor("extract")).not.toThrow();
    expect(() => budget.deadlineFor("extract")).not.toThrow();
    expect(() => budget.remainingMs()).not.toThrow();
  });
});

describe("배분 자체의 회귀 테스트 (TRD 7번 시간 예산 표)", () => {
  it("세 단계 예산의 합 + 여유 5s가 함수 상한 60s를 넘지 않는다", () => {
    const stageSum = Object.values(STAGE_BUDGET_MS).reduce((sum, ms) => sum + ms, 0);

    expect(stageSum).toBe(50_000);
    expect(stageSum + RESPONSE_RESERVE_MS).toBeLessThanOrEqual(FUNCTION_MAX_DURATION_MS);
    expect(stageSum).toBeLessThanOrEqual(TOTAL_BUDGET_MS);
  });

  it("총 예산은 함수 상한에서 응답 조립·로깅 여유를 뺀 값이다", () => {
    expect(TOTAL_BUDGET_MS).toBe(55_000);
    expect(TOTAL_BUDGET_MS + RESPONSE_RESERVE_MS).toBe(FUNCTION_MAX_DURATION_MS);
  });

  it("단계 예산은 TRD 7번 표와 정확히 일치한다 (30/12/8)", () => {
    expect(STAGE_BUDGET_MS).toEqual({ extract: 30_000, lookup: 12_000, note: 8_000 });
  });
});
