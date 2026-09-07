import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logEvent, type AnalyticsEvent } from "./analytics";
import { errorCodeSchema, unidentifiedReasonSchema } from "./schemas";
import { RESPONSE_REASON, type MeasurementReason } from "./unidentified";
import {
  MAX_CANDIDATES_FOR_LOOKUP,
  MAX_IDENTIFIED_BOOKS,
  MAX_UNIDENTIFIED_BOOKS,
} from "./env";

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

/**
 * 계측 사유 일곱 칸의 0 분해. `Record`가 일곱 키를 전부 요구하므로 계측 사유가
 * 늘면 이 픽스처가 컴파일에서 먼저 깨진다 — 목록을 복창하는 것이 아니라
 * 타입이 강제하는 자리를 채우는 것이다.
 */
const 계측분해_0건: Record<MeasurementReason, number> = {
  low_confidence: 0,
  lookup_capped: 0,
  blank_title: 0,
  no_match: 0,
  ambiguous: 0,
  search_failed: 0,
  facts_failed: 0,
};

/**
 * 표시 상한 절단 **전**의 원시 계측 넷. 전부 옵셔널이 아니므로 빠뜨리면
 * `npm run typecheck`가 깨진다 — 분모(`raw_guardrail_denominator`)와
 * 분자(`raw_unidentified_guardrail_count`)가 한쪽만 실리면 비율을 낼 수 없고,
 * 낼 수 없는 비율은 있으나 마나 한 가드레일이다.
 *
 * `raw_candidate_count`는 **분모가 아니다.** 세션의 규모를 보는 관측값이고, 이
 * 값으로 분자를 나누면 조회하지 못한 책이 분모에만 남아 비율을 희석한다.
 */
const 원시계측_0건 = {
  raw_candidate_count: 0,
  raw_guardrail_denominator: 0,
  raw_unidentified_guardrail_count: 0,
  raw_unidentified_by_measurement: 계측분해_0건,
};

describe("logEvent — PRD 7번 이벤트 9종을 JSON 한 줄로 남긴다 (TR-012)", () => {
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
      ...원시계측_0건,
      raw_candidate_count: 15,
      raw_guardrail_denominator: 14,
      raw_unidentified_guardrail_count: 2,
      raw_unidentified_by_measurement: { ...계측분해_0건, no_match: 2, search_failed: 1 },
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
      raw_candidate_count: 15,
      raw_guardrail_denominator: 14,
      raw_unidentified_guardrail_count: 2,
      raw_unidentified_by_measurement: {
        low_confidence: 0,
        lookup_capped: 0,
        blank_title: 0,
        no_match: 2,
        ambiguous: 0,
        search_failed: 1,
        facts_failed: 0,
      },
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

  it("recommend_failed — 실패에 태운 토큰도 청구되므로 함께 싣는다", () => {
    logEvent({
      event: "recommend_failed",
      session_id: SESSION,
      error_code: "RECOMMENDATION_VALIDATION_FAILED",
      input_tokens: 4_300,
      output_tokens: 180,
    });
    expect(lastLine()).toEqual({
      event: "recommend_failed",
      session_id: SESSION,
      error_code: "RECOMMENDATION_VALIDATION_FAILED",
      input_tokens: 4_300,
      output_tokens: 180,
    });
    // PRD 7번 표의 속성 넷 + event. duration_ms·recommended_count는 표에 없다.
    expect(Object.keys(lastLine())).toHaveLength(5);
  });

  it("recommend_failed — error_code는 errorCodeSchema의 값이면 전부 통과한다", () => {
    for (const code of errorCodeSchema.options) {
      logSpy.mockClear();
      logEvent({
        event: "recommend_failed",
        session_id: SESSION,
        error_code: code,
        input_tokens: 0,
        output_tokens: 0,
      });
      expect(lastLine()).toEqual({
        event: "recommend_failed",
        session_id: SESSION,
        error_code: code,
        input_tokens: 0,
        output_tokens: 0,
      });
    }
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
      ...원시계측_0건,
      raw_candidate_count: 1,
      raw_guardrail_denominator: 1,
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
      ...원시계측_0건,
      raw_candidate_count: 4,
      raw_guardrail_denominator: 3,
      raw_unidentified_guardrail_count: 3,
      raw_unidentified_by_measurement: {
        ...계측분해_0건,
        low_confidence: 1,
        no_match: 1,
        ambiguous: 1,
        search_failed: 1,
      },
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
      ...원시계측_0건,
      raw_candidate_count: 5,
      raw_guardrail_denominator: 2,
      raw_unidentified_guardrail_count: 2,
      raw_unidentified_by_measurement: {
        ...계측분해_0건,
        no_match: 2,
        search_failed: 2,
        facts_failed: 1,
      },
    });

    const counts = lastLine().unidentified_by_reason as Record<string, number>;
    expect(counts.lookup_failed).toBe(3);
    expect(counts.no_match).toBe(2);
  });
});

/**
 * 가드레일 계측 — 표시 상한 절단 전의 원시 수 넷.
 *
 * 응답 어휘는 이 런에서 한 바이트도 바뀌지 않는다. 늘어난 것은 계측뿐이고, 그
 * 사실을 여기서 양쪽으로 잠근다 — raw_ 넷은 실려야 하고, `unidentified_by_reason`의
 * 칸은 **여전히 응답 사유 4종**이어야 한다.
 *
 * ## 이 파일이 재는 것과 재지 않는 것
 * `logEvent`는 **투영만 한다** — 받은 값을 화이트리스트로 걸러 한 줄로 쓸 뿐,
 * 분자와 분모를 스스로 계산하지 않는다. 그래서 여기서 "분자 ≤ 분모"를 단언해도
 * 그것은 **픽스처가 스스로 적은 숫자를 다시 읽는 것**이지 프로덕션의 성질이
 * 아니다. 그 불변식은 파이프라인을 실제로 돌리는 `route.test.ts`가 잠근다.
 *
 * 대신 여기서 할 수 있고 해야 하는 일이 둘이다.
 * 1. 넷이 전부 화이트리스트를 통과하는가, 없어진 필드가 정말 빠지는가
 * 2. 픽스처의 숫자가 **프로덕션에서 나올 수 있는 값인가** — 나올 수 없는 조합을
 *    깔고 통과하면 이 파일은 아무것도 보증하지 않는다
 */
describe("analyze_completed의 원시 계측 넷 (표시 상한 절단 전)", () => {
  /**
   * 절단이 실제로 일어난 세션. 숫자는 프로덕션 상한과 아귀가 맞는다.
   *
   * 사진 5장에서 후보 300건이 나왔고, 확신도 하한에 40건이 걸렸다. 남은 260건이
   * 조회 상한 65건에 잘려 195건이 밀렸고, 조회한 65건 중 61건이 확인, 4건이
   * `no_match`였다. 그래서 미확인은 40 + 195 + 4 = 239건이고 표시 상한 100건에서
   * 잘린다. 확인 61건도 표시 상한 50건에서 잘려 넘침 11이다.
   */
  function 절단된_세션(): void {
    logEvent({
      event: "analyze_completed",
      session_id: SESSION,
      // 표시 상한에 잘린 뒤의 수
      identified_count: 50,
      unidentified_count: 100,
      // 절단된 100건의 구성 — 판정 실패 4건이 먼저 담기고 나머지는 강등분이다
      unidentified_by_reason: { ...사유_0건, unreadable: 96, no_match: 4 },
      overflow_count: 11,
      failed_photo_count: 0,
      duration_ms: 24_000,
      input_tokens: 8_000,
      output_tokens: 1_000,
      // 절단 전의 수
      raw_candidate_count: 300,
      raw_guardrail_denominator: 105,
      raw_unidentified_guardrail_count: 44,
      raw_unidentified_by_measurement: {
        ...계측분해_0건,
        low_confidence: 40,
        lookup_capped: 195,
        no_match: 4,
      },
    });
  }

  it("raw_ 넷이 화이트리스트를 통과해 로그 한 줄에 실린다", () => {
    절단된_세션();

    expect(lastLine()).toEqual({
      event: "analyze_completed",
      session_id: SESSION,
      identified_count: 50,
      unidentified_count: 100,
      unidentified_by_reason: { unreadable: 96, no_match: 4, ambiguous: 0, lookup_failed: 0 },
      overflow_count: 11,
      failed_photo_count: 0,
      duration_ms: 24_000,
      input_tokens: 8_000,
      output_tokens: 1_000,
      raw_candidate_count: 300,
      raw_guardrail_denominator: 105,
      raw_unidentified_guardrail_count: 44,
      raw_unidentified_by_measurement: {
        low_confidence: 40,
        lookup_capped: 195,
        blank_title: 0,
        no_match: 4,
        ambiguous: 0,
        search_failed: 0,
        facts_failed: 0,
      },
    });
  });

  it("없어진 raw_unidentified_lookup_capped는 타입을 우회해 얹어도 출력에서 빠진다", () => {
    // 이 필드는 `raw_unidentified_by_measurement`의 한 칸이 되면서 사라졌다.
    // 표에서 지우기만 하고 타입만 고치면, 라우트가 옛 이름으로 계속 얹어도
    // 아무도 모른다 — 그러면 집계 스크립트가 두 이름을 동시에 보게 된다.
    logEvent({
      event: "analyze_completed",
      session_id: SESSION,
      identified_count: 0,
      unidentified_count: 0,
      unidentified_by_reason: 사유_0건,
      overflow_count: 0,
      failed_photo_count: 0,
      duration_ms: 1,
      input_tokens: 1,
      output_tokens: 1,
      ...원시계측_0건,
      raw_unidentified_lookup_capped: 61,
    } as unknown as AnalyticsEvent);

    const line = lastLine();
    expect(Object.keys(line)).not.toContain("raw_unidentified_lookup_capped");
    expect(line.raw_unidentified_by_measurement).toEqual(계측분해_0건);
  });

  it("원시 수는 표시 상한에 깎이지 않는다 — 절단된 수로 나누면 비율이 부풀어 오른다", () => {
    절단된_세션();
    const line = lastLine();

    const 표시된_합 = (line.identified_count as number) + (line.unidentified_count as number);
    // 절단은 화면의 사정이지 세션에서 실제로 다룬 후보 수를 줄이지 않는다.
    expect(line.raw_candidate_count as number).toBeGreaterThan(표시된_합);
    expect(line.raw_guardrail_denominator as number).toBeGreaterThan(
      line.identified_count as number,
    );
  });

  it("픽스처가 프로덕션에서 나올 수 있는 값이다 — 상한과 모순되지 않는다", () => {
    // 나올 수 없는 조합을 깔고 통과하면 이 파일은 아무것도 보증하지 않는다.
    // 예전 픽스처는 판정된 미확인이 113건이었는데, 조회 상한이 65건이라
    // 그만큼 판정하는 것 자체가 불가능했다.
    절단된_세션();
    const line = lastLine();
    const by = line.raw_unidentified_by_measurement as Record<MeasurementReason, number>;

    // 분모 = 확인된 책 + 분자. 이 관계에서 확인된 책 수를 되찾는다.
    const 확인된_책_수 =
      (line.raw_guardrail_denominator as number) -
      (line.raw_unidentified_guardrail_count as number);
    // 알라딘에 실제로 태워 **판정을 받은** 것들. 강등 둘(하한·상한)은 조회한 적이 없다.
    const 판정된_미확인 =
      by.blank_title + by.no_match + by.ambiguous + by.search_failed + by.facts_failed;

    expect(확인된_책_수 + 판정된_미확인).toBeLessThanOrEqual(MAX_CANDIDATES_FOR_LOOKUP);
    expect(line.identified_count as number).toBeLessThanOrEqual(MAX_IDENTIFIED_BOOKS);
    expect(line.unidentified_count as number).toBeLessThanOrEqual(MAX_UNIDENTIFIED_BOOKS);
    // 절단 전 미확인 총수는 표시 상한 이상이어야 절단이 실제로 일어난다.
    const 절단전_미확인 = Object.values(by).reduce((sum, n) => sum + n, 0);
    expect(절단전_미확인).toBeGreaterThanOrEqual(line.unidentified_count as number);
    expect(확인된_책_수 + 절단전_미확인).toBe(line.raw_candidate_count as number);
  });

  it("raw_unidentified_by_measurement가 계측 사유 일곱 칸을 그대로 싣는다", () => {
    절단된_세션();
    const by = lastLine().raw_unidentified_by_measurement as Record<string, number>;

    // 칸 목록을 여기 다시 적지 않는다 — 접힘 매핑의 키가 정본이다. 일곱을 갈라
    // 놓고 집계 둘만 내보내면 `search_failed`와 `facts_failed`를 서로 바꿔
    // 배정해도 어떤 검사도 실패하지 않는다.
    expect(Object.keys(by).sort()).toEqual(Object.keys(RESPONSE_REASON).sort());
  });

  it("unidentified_by_reason의 키 집합은 여전히 4종이다 — 계측 어휘가 응답 칸으로 새지 않는다", () => {
    절단된_세션();
    const counts = lastLine().unidentified_by_reason as Record<string, number>;

    // 두 정본과 동시에 맞춘다: 응답 스키마의 enum, 그리고 계측→응답 접힘의 상.
    // 둘 중 하나만 봐도 통과하는 상태를 만들지 않는다.
    expect(Object.keys(counts).sort()).toEqual([...unidentifiedReasonSchema.options].sort());
    expect(Object.keys(counts).sort()).toEqual([...new Set(Object.values(RESPONSE_REASON))].sort());
    // 응답 칸은 넷, 계측 칸은 일곱 — 두 어휘가 한 이벤트 안에서 섞이지 않는다.
    expect(Object.keys(counts).length).toBeLessThan(Object.keys(RESPONSE_REASON).length);
  });

  it("계측 전용 사유 이름이 사유별 카운트의 칸으로 새지 않는다", () => {
    절단된_세션();
    const counts = lastLine().unidentified_by_reason as Record<string, number>;
    const 응답사유 = unidentifiedReasonSchema.options as readonly string[];
    const 계측전용 = Object.keys(RESPONSE_REASON).filter((m) => !응답사유.includes(m));

    // 일곱 중 넷만 응답 어휘와 이름이 겹친다. 나머지가 이 칸으로 새면 집계
    // 스크립트가 4종을 전제로 짠 그대로 조용히 어긋난다.
    expect(계측전용.length).toBeGreaterThan(0);
    for (const name of 계측전용) {
      expect(Object.keys(counts)).not.toContain(name);
      expect(JSON.stringify(counts)).not.toContain(name);
    }
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

  it("recommend_failed도 표에 없는 속성을 얹으면 출력에서 빠진다", () => {
    logEvent({
      event: "recommend_failed",
      session_id: SESSION,
      error_code: "UPSTREAM_UNAVAILABLE",
      input_tokens: 4_300,
      output_tokens: 0,
      // 라우트가 실수로 얹기 쉬운 값들 — 기분 원문·요청 ID·책 목록.
      mood: "번아웃이라 가볍게 읽을 것",
      request_id: "req_01HXYZ",
      books: [{ isbn13: "9788936434120", title: "소년이 온다" }],
    } as unknown as AnalyticsEvent);

    const line = lastLine();
    expect(line).toEqual({
      event: "recommend_failed",
      session_id: SESSION,
      error_code: "UPSTREAM_UNAVAILABLE",
      input_tokens: 4_300,
      output_tokens: 0,
    });
    expect(JSON.stringify(line)).not.toContain("번아웃");
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
 * - `input_tokens`·`output_tokens`는 Claude를 호출하는 네 이벤트에서 옵셔널이 아니다.
 *   빠뜨리면 `npm run typecheck`가 깨진다 — 토큰이 빠지면 세션당 비용이
 *   실제보다 낮게 집계되어 300원 가드레일이 무의미해진다.
 * - `event` 이름은 리터럴 유니온이라 오타가 컴파일 타임에 걸린다.
 * - `unidentified_by_reason`은 `unidentifiedReasonSchema`에서 파생한
 *   Record라 사유가 늘거나 이름이 바뀌면 호출부가 전부 깨진다.
 */
