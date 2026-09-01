import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ *
 * 모킹 — `lib/analytics`만 대역으로 감싼다
 *
 * 기본 구현은 **진짜 `logEvent`**다. 이 라우트가 검증해야 하는 것이 "PRD 7번
 * 표에 정의된 속성만 로그 줄에 실리는가"인데, 대역이 인자만 기록하면 실제로
 * 표준 출력에 무엇이 나가는지는 아무도 보지 않게 된다. 그래서 출력은
 * `console.log` 스파이로 가로채 실제 줄을 읽고, 대역은 "로깅이 던져도 202가
 * 나가는가"(TR-012)를 검증할 때만 던지도록 바꾼다 — 진짜 `logEvent`는 어떤
 * 예외도 삼키므로 그 대역 없이는 라우트 층위의 방어를 확인할 수 없다.
 * ------------------------------------------------------------------ */

const { logEventMock } = vi.hoisted(() => ({ logEventMock: vi.fn() }));

vi.mock("@/lib/analytics", () => ({
  logEvent: (event: unknown) => logEventMock(event),
}));

const actualAnalytics = await vi.importActual<typeof import("@/lib/analytics")>("@/lib/analytics");

import { POST, maxDuration, runtime } from "./route";

/* ------------------------------------------------------------------ *
 * 픽스처
 * ------------------------------------------------------------------ */

const SESSION_ID = "5f7c2a1e-0000-4000-8000-000000000001";

/** API_SPEC이 정한 본문 상한 */
const MAX_BODY_BYTES = 8 * 1024;

function eventsRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/events", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** 허용 3종의 정상 본문 */
function viewedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    event: "recommend_viewed",
    properties: {
      recommended_count: 3,
      duration_ms: 14_200,
      input_tokens: 1800,
      output_tokens: 260,
      ...overrides,
    },
  };
}

function acceptedBody(
  properties: Record<string, unknown> = { position: 2 },
): Record<string, unknown> {
  return { sessionId: SESSION_ID, event: "recommend_accepted", properties };
}

function resolvedBody(
  properties: Record<string, unknown> = { resolve_attempt: 1, matched: true },
): Record<string, unknown> {
  return { sessionId: SESSION_ID, event: "book_resolved", properties };
}

let logSpy: ReturnType<typeof vi.spyOn>;

/** 표준 출력에 실제로 나간 이벤트 줄 */
function loggedLines(): Record<string, unknown>[] {
  return logSpy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

beforeEach(() => {
  logEventMock.mockReset();
  // 기본은 진짜 구현이다. 던지는 대역은 필요한 테스트에서만 갈아 끼운다.
  logEventMock.mockImplementation(actualAnalytics.logEvent);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * 계약
 * ------------------------------------------------------------------ */

describe("POST /api/events — 계약", () => {
  it("라우트 상수가 API_SPEC의 하드 상한과 런타임을 따른다", () => {
    expect(maxDuration).toBe(3);
    expect(runtime).toBe("nodejs");
  });

  it("허용 3종이 각각 202와 { accepted: true }를 돌려준다", async () => {
    for (const body of [viewedBody(), acceptedBody(), resolvedBody()]) {
      const response = await POST(eventsRequest(body));

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ accepted: true });
      expect(response.headers.get("X-Request-Id")).toMatch(/[0-9a-f-]{36}/);
    }
  });

  it("이벤트를 PRD 7번 표의 속성 그대로 한 줄로 남긴다", async () => {
    await POST(eventsRequest(viewedBody()));
    await POST(eventsRequest(acceptedBody({ position: 3 })));
    await POST(eventsRequest(resolvedBody({ resolve_attempt: 2, matched: false })));

    expect(loggedLines()).toEqual([
      {
        event: "recommend_viewed",
        session_id: SESSION_ID,
        recommended_count: 3,
        duration_ms: 14_200,
        input_tokens: 1800,
        output_tokens: 260,
      },
      { event: "recommend_accepted", session_id: SESSION_ID, position: 3 },
      { event: "book_resolved", session_id: SESSION_ID, resolve_attempt: 2, matched: false },
    ]);
  });

  it("이벤트마다 표준 출력에 정확히 한 줄만 쓴다", async () => {
    await POST(eventsRequest(acceptedBody()));

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).not.toContain("\n");
  });
});

/* ------------------------------------------------------------------ *
 * 화이트리스트 — 이벤트명
 * ------------------------------------------------------------------ */

describe("POST /api/events — 이벤트 화이트리스트", () => {
  it("서버가 직접 관측하는 이벤트(photo_uploaded)는 이 경로로 받지 않는다", async () => {
    // 받아 주면 같은 이벤트가 서버 로그와 이 경로에서 두 번 집계된다.
    const response = await POST(
      eventsRequest({
        sessionId: SESSION_ID,
        event: "photo_uploaded",
        properties: { photo_count: 3 },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_REQUEST" });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it.each(["analyze_completed", "analyze_failed", "questions_generated", "mood_submitted"])(
    "서버 관측 이벤트 %s도 400이다",
    async (event) => {
      const response = await POST(eventsRequest({ sessionId: SESSION_ID, event }));

      expect(response.status).toBe(400);
      expect(logSpy).not.toHaveBeenCalled();
    },
  );

  it("알 수 없는 이벤트명은 400이다", async () => {
    const response = await POST(
      eventsRequest({ sessionId: SESSION_ID, event: "book_purchased", properties: {} }),
    );

    expect(response.status).toBe(400);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("JSON이 아닌 본문은 400이다", async () => {
    const response = await POST(eventsRequest("{ not json"));

    expect(response.status).toBe(400);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * 화이트리스트 — 속성 (PII 회귀)
 * ------------------------------------------------------------------ */

describe("POST /api/events — 속성 화이트리스트 (PII 회귀, 삭제 금지)", () => {
  it("정의되지 않은 속성 키는 로그에 실리지 않는다", async () => {
    const response = await POST(
      eventsRequest({
        sessionId: SESSION_ID,
        event: "recommend_accepted",
        properties: {
          position: 1,
          // 아래 셋은 어떤 이벤트에도 정의되지 않았다. 하나라도 새어 나가면
          // 이벤트 로그에 PII·판독 원문이 들어간다 (PRD 7번, TRD 6.4).
          email: "reader@example.com",
          rawText: "소년이 온다 한강",
          file_name: "IMG_0421.HEIC",
        },
      }),
    );

    // 400이 아니라 **무시**다 — API_SPEC이 "그 외 키는 무시하고 버린다"로 정했다.
    expect(response.status).toBe(202);

    const [line] = loggedLines();
    expect(line).toEqual({ event: "recommend_accepted", session_id: SESSION_ID, position: 1 });

    const serialized = JSON.stringify(loggedLines());
    expect(serialized).not.toContain("reader@example.com");
    expect(serialized).not.toContain("소년이 온다 한강");
    expect(serialized).not.toContain("IMG_0421.HEIC");
  });

  it("다른 이벤트의 속성을 얹어도 그 이벤트의 속성만 남는다", async () => {
    const response = await POST(
      eventsRequest({
        sessionId: SESSION_ID,
        event: "book_resolved",
        properties: { resolve_attempt: 1, matched: true, position: 2, photo_count: 5 },
      }),
    );

    expect(response.status).toBe(202);
    expect(loggedLines()[0]).toEqual({
      event: "book_resolved",
      session_id: SESSION_ID,
      resolve_attempt: 1,
      matched: true,
    });
  });

  it("recommend_accepted의 position이 1~3 밖이면 400이다", async () => {
    for (const position of [0, 4, 2.5, -1, "2"]) {
      const response = await POST(eventsRequest(acceptedBody({ position })));

      expect(response.status).toBe(400);
    }
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("정의된 속성이 빠지면 400이다 — 토큰이 빠지면 비용 가드레일이 낮게 집계된다", async () => {
    const bodies = [
      { sessionId: SESSION_ID, event: "recommend_viewed", properties: { recommended_count: 3 } },
      { sessionId: SESSION_ID, event: "recommend_accepted" },
      { sessionId: SESSION_ID, event: "book_resolved", properties: { resolve_attempt: 1 } },
    ];

    for (const body of bodies) {
      const response = await POST(eventsRequest(body));

      expect(response.status).toBe(400);
    }
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("속성 타입이 어긋나면 400이다", async () => {
    const response = await POST(eventsRequest(resolvedBody({ resolve_attempt: 1, matched: "yes" })));

    expect(response.status).toBe(400);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * sessionId
 * ------------------------------------------------------------------ */

describe("POST /api/events — sessionId", () => {
  it.each(["not-a-uuid", "", "5f7c2a1e-0000-1000-8000-000000000001", 12345, null])(
    "UUID v4가 아니면 400이다 (%s)",
    async (sessionId) => {
      const response = await POST(
        eventsRequest({ sessionId, event: "recommend_accepted", properties: { position: 1 } }),
      );

      expect(response.status).toBe(400);
      expect(logSpy).not.toHaveBeenCalled();
    },
  );

  it("UUID v4면 값을 그대로 로그에 옮긴다 — 신뢰하지는 않고 형식만 본다", async () => {
    const other = "1b4e28ba-2fa1-4d1a-b6dd-71d5f2a3c9e7";

    await POST(eventsRequest({ ...acceptedBody(), sessionId: other }));

    expect(loggedLines()[0]).toMatchObject({ session_id: other });
  });
});

/* ------------------------------------------------------------------ *
 * 본문 크기
 * ------------------------------------------------------------------ */

describe("POST /api/events — 본문 크기", () => {
  it("8KB를 넘으면 400이다", async () => {
    const oversized = {
      sessionId: SESSION_ID,
      event: "recommend_accepted",
      properties: { position: 1, padding: "가".repeat(MAX_BODY_BYTES) },
    };

    const response = await POST(eventsRequest(oversized));

    expect(response.status).toBe(400);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("Content-Length가 상한을 넘는다고 말하면 본문을 읽기 전에 거절한다", async () => {
    const request = eventsRequest(acceptedBody(), {
      "content-length": String(MAX_BODY_BYTES + 1),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    // 본문을 읽지 않았으므로 스트림이 그대로 남아 있다.
    expect(request.bodyUsed).toBe(false);
  });

  it("8KB 이하 본문은 정상 처리한다", async () => {
    const response = await POST(eventsRequest(viewedBody()));

    expect(response.status).toBe(202);
  });
});

/* ------------------------------------------------------------------ *
 * 로깅 실패 · 무상태
 * ------------------------------------------------------------------ */

describe("POST /api/events — 로깅 실패와 무상태", () => {
  it("로깅이 던져도 202가 나간다 (TR-012)", async () => {
    logEventMock.mockImplementation(() => {
      throw new Error("표준 출력이 막혔습니다");
    });

    const response = await POST(eventsRequest(acceptedBody()));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
  });

  it("에러 응답에도 requestId가 담기고 헤더와 같은 값이다", async () => {
    const response = await POST(eventsRequest({ sessionId: SESSION_ID, event: "photo_uploaded" }));

    const body = (await response.json()) as { requestId: string; error: string; code: string };
    expect(body.requestId).toBe(response.headers.get("X-Request-Id"));
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("요청마다 requestId가 달라진다", async () => {
    const first = await POST(eventsRequest(acceptedBody()));
    const second = await POST(eventsRequest(acceptedBody()));

    expect(first.headers.get("X-Request-Id")).not.toBe(second.headers.get("X-Request-Id"));
  });

  it("저장 부수효과가 없다 — 전역 변수도 파일도 건드리지 않는다 (ADR-003)", async () => {
    const before = Object.keys(globalThis).length;

    await POST(eventsRequest(acceptedBody()));
    await POST(eventsRequest(resolvedBody()));
    await POST(eventsRequest(viewedBody()));

    expect(Object.keys(globalThis).length).toBe(before);

    // 저장 경로가 코드에 들어오는 것 자체를 막는다. 표준 출력 한 줄이 전부다.
    const source = readFileSync("src/app/api/events/route.ts", "utf8");
    expect(source).not.toMatch(/node:fs|from "fs"|localStorage|sessionStorage|globalThis\./);
  });

  it("SERVICE_ENABLED=false면 503이다 (TRD 7번 — 모든 라우트)", async () => {
    vi.stubEnv("SERVICE_ENABLED", "false");

    const response = await POST(eventsRequest(acceptedBody()));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "SERVICE_DISABLED" });
    expect(logSpy).not.toHaveBeenCalled();
  });
});
