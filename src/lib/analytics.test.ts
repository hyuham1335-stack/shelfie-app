import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logEvent, type AnalyticsEvent } from "./analytics";
import { unidentifiedReasonSchema } from "./schemas";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 마지막 출력 한 줄을 되읽는다. 줄 단위 집계가 전제이므로 개행이 없어야 한다 */
function lastLine(): Record<string, unknown> {
  expect(logSpy).toHaveBeenCalledTimes(1);
  const [line] = logSpy.mock.calls[0] as [string];
  expect(typeof line).toBe("string");
  expect(line).not.toContain("\n");
  return JSON.parse(line) as Record<string, unknown>;
}

const SESSION = "3f1c2b8e-0a4d-4c1e-9b7a-5e6f7a8b9c0d";

const 사유_0건 = {
  unreadable: 0,
  no_match: 0,
  ambiguous: 0,
  lookup_failed: 0,
};

describe("logEvent — PRD 7번 이벤트 8종을 JSON 한 줄로 남긴다 (TR-012)", () => {
  it("photo_uploaded", () => {
    logEvent({ event: "photo_uploaded", session_id: SESSION, photo_count: 3 });
    expect(lastLine()).toEqual({
      event: "photo_uploaded",
      session_id: SESSION,
      photo_count: 3,
    });
  });

  it("analyze_completed — 사유별 카운트와 토큰 수를 함께 싣는다", () => {
    logEvent({
      event: "analyze_completed",
      session_id: SESSION,
      identified_count: 12,
      unidentified_count: 3,
      unidentified_by_reason: { ...사유_0건, no_match: 2, lookup_failed: 1 },
      overflow_count: 0,
      failed_photo_count: 1,
      duration_ms: 18_420,
      input_tokens: 9_800,
      output_tokens: 1_240,
    });
    expect(lastLine()).toEqual({
      event: "analyze_completed",
      session_id: SESSION,
      identified_count: 12,
      unidentified_count: 3,
      unidentified_by_reason: {
        unreadable: 0,
        no_match: 2,
        ambiguous: 0,
        lookup_failed: 1,
      },
      overflow_count: 0,
      failed_photo_count: 1,
      duration_ms: 18_420,
      input_tokens: 9_800,
      output_tokens: 1_240,
    });
  });

  it("analyze_failed", () => {
    logEvent({
      event: "analyze_failed",
      session_id: SESSION,
      error_code: "UPSTREAM_UNAVAILABLE",
      failed_photo_count: 5,
    });
    expect(lastLine()).toEqual({
      event: "analyze_failed",
      session_id: SESSION,
      error_code: "UPSTREAM_UNAVAILABLE",
      failed_photo_count: 5,
    });
  });

  it("questions_generated — question_count 0은 자유 입력 폴백을 뜻한다", () => {
    logEvent({
      event: "questions_generated",
      session_id: SESSION,
      question_count: 0,
      input_tokens: 1_100,
      output_tokens: 0,
    });
    expect(lastLine()).toEqual({
      event: "questions_generated",
      session_id: SESSION,
      question_count: 0,
      input_tokens: 1_100,
      output_tokens: 0,
    });
  });

  it("mood_submitted", () => {
    logEvent({
      event: "mood_submitted",
      session_id: SESSION,
      input_mode: "guided",
      retry_index: 2,
    });
    expect(lastLine()).toEqual({
      event: "mood_submitted",
      session_id: SESSION,
      input_mode: "guided",
      retry_index: 2,
    });
  });

  it("book_resolved", () => {
    logEvent({
      event: "book_resolved",
      session_id: SESSION,
      resolve_attempt: 1,
      matched: true,
    });
    expect(lastLine()).toEqual({
      event: "book_resolved",
      session_id: SESSION,
      resolve_attempt: 1,
      matched: true,
    });
  });

  it("recommend_viewed — 추천 수락률의 분모", () => {
    logEvent({
      event: "recommend_viewed",
      session_id: SESSION,
      recommended_count: 3,
      duration_ms: 9_120,
      input_tokens: 4_300,
      output_tokens: 520,
    });
    expect(lastLine()).toEqual({
      event: "recommend_viewed",
      session_id: SESSION,
      recommended_count: 3,
      duration_ms: 9_120,
      input_tokens: 4_300,
      output_tokens: 520,
    });
  });

  it("recommend_accepted — North Star의 분자", () => {
    logEvent({ event: "recommend_accepted", session_id: SESSION, position: 2 });
    expect(lastLine()).toEqual({
      event: "recommend_accepted",
      session_id: SESSION,
      position: 2,
    });
  });
});

describe("출력 형태", () => {
  it("한 줄이고 JSON.parse로 되읽힌다 — 집계가 줄 단위이기 때문이다", () => {
    logEvent({
      event: "analyze_completed",
      session_id: SESSION,
      identified_count: 1,
      unidentified_count: 0,
      unidentified_by_reason: 사유_0건,
      overflow_count: 0,
      failed_photo_count: 0,
      duration_ms: 1,
      input_tokens: 1,
      output_tokens: 1,
    });

    const [line] = logSpy.mock.calls[0] as [string];
    expect(line.split("\n")).toHaveLength(1);
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it("console.log 호출은 이벤트당 정확히 한 번이다", () => {
    logEvent({ event: "photo_uploaded", session_id: SESSION, photo_count: 1 });
    logEvent({ event: "photo_uploaded", session_id: SESSION, photo_count: 2 });
    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it("unidentified_by_reason은 사유 4종을 모두 키로 갖는다 (ADR-005)", () => {
    logEvent({
      event: "analyze_completed",
      session_id: SESSION,
      identified_count: 0,
      unidentified_count: 4,
      unidentified_by_reason: {
        unreadable: 1,
        no_match: 1,
        ambiguous: 1,
        lookup_failed: 1,
      },
      overflow_count: 0,
      failed_photo_count: 0,
      duration_ms: 10,
      input_tokens: 10,
      output_tokens: 10,
    });

    const counts = lastLine().unidentified_by_reason as Record<string, number>;
    // 사유 목록을 테스트에 다시 적지 않는다 — 스키마가 정본이다.
    expect(Object.keys(counts).sort()).toEqual([...unidentifiedReasonSchema.options].sort());
  });

  it("lookup_failed를 다른 사유와 합치지 않는다 — 가드레일 분자에서 빼야 하기 때문이다", () => {
    logEvent({
      event: "analyze_completed",
      session_id: SESSION,
      identified_count: 0,
      unidentified_count: 5,
      unidentified_by_reason: { ...사유_0건, no_match: 2, lookup_failed: 3 },
      overflow_count: 0,
      failed_photo_count: 0,
      duration_ms: 10,
      input_tokens: 10,
      output_tokens: 10,
    });

    const counts = lastLine().unidentified_by_reason as Record<string, number>;
    expect(counts.lookup_failed).toBe(3);
    expect(counts.no_match).toBe(2);
  });
});

describe("PII·이미지·판독 원문을 남기지 않는다 (PRD 7번)", () => {
  it("표에 없는 속성은 타입을 우회해 넣어도 출력에서 빠진다", () => {
    logEvent({
      event: "photo_uploaded",
      session_id: SESSION,
      photo_count: 2,
      // 라우트 핸들러가 실수로 원문을 얹어도 로그에는 닿지 않아야 한다.
      rawText: "소년이 온다 · 한강",
      fileName: "IMG_0421.HEIC",
    } as unknown as AnalyticsEvent);

    const line = lastLine();
    expect(line).toEqual({
      event: "photo_uploaded",
      session_id: SESSION,
      photo_count: 2,
    });
    expect(JSON.stringify(line)).not.toContain("소년이 온다");
  });
});

describe("로깅 실패가 요청 처리를 막지 않는다 (TR-012)", () => {
  it("직렬화가 실패해도 예외가 호출부로 새어 나가지 않는다", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() =>
      logEvent({
        event: "photo_uploaded",
        session_id: SESSION,
        photo_count: circular as unknown as number,
      }),
    ).not.toThrow();
  });

  it("삼킨 실패는 조용히 사라지지 않고 폴백 로그로 남는다", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    logEvent({
      event: "photo_uploaded",
      session_id: SESSION,
      photo_count: circular as unknown as number,
    });

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("photo_uploaded");
  });

  it("출력 채널 자체가 던져도 예외가 새어 나가지 않는다", () => {
    logSpy.mockImplementation(() => {
      throw new Error("stdout이 닫혔다");
    });

    expect(() =>
      logEvent({ event: "recommend_accepted", session_id: SESSION, position: 1 }),
    ).not.toThrow();
  });

  it("폴백 로그마저 실패해도 예외가 새어 나가지 않는다", () => {
    logSpy.mockImplementation(() => {
      throw new Error("stdout이 닫혔다");
    });
    errorSpy.mockImplementation(() => {
      throw new Error("stderr도 닫혔다");
    });

    expect(() =>
      logEvent({ event: "recommend_accepted", session_id: SESSION, position: 1 }),
    ).not.toThrow();
  });
});

/*
 * 타입 수준 보장 (컴파일이 곧 검증이라 런타임 테스트를 두지 않는다):
 * - `input_tokens`·`output_tokens`는 Claude를 호출하는 세 이벤트에서 옵셔널이 아니다.
 *   빠뜨리면 `npm run typecheck`가 깨진다 — 토큰이 빠지면 세션당 비용이
 *   실제보다 낮게 집계되어 300원 가드레일이 무의미해진다.
 * - `event` 이름은 리터럴 유니온이라 오타가 컴파일 타임에 걸린다.
 * - `unidentified_by_reason`은 `unidentifiedReasonSchema`에서 파생한
 *   Record라 사유가 늘거나 이름이 바뀌면 호출부가 전부 깨진다.
 */
