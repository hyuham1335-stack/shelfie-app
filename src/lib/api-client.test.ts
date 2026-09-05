/**
 * `lib/api-client.ts` — 클라이언트 네트워크 경계.
 *
 * 검증하는 것은 두 가지다: ① 실패가 예외가 아니라 판별 가능한 값으로 나온다
 * ② 서버가 낸 `code`·`requestId`가 화면까지 손실 없이 도달한다. 후자가 깨지면
 * 사용자는 에러 배너에 띄울 오류 ID를 못 받고, 서버 로그를 찾을 길이 사라진다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_TIMEOUT_MS,
  analyzePhotos,
  fetchMoodQuestions,
  requestRecommendations,
  resolveBook,
  sendClientEvent,
} from "@/lib/api-client";
import type { BookReference } from "@/types/book";
import type { AnalyzeResponse, RecommendRequest } from "@/types/api";

const SESSION_ID = "3f8a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b";
const REQUEST_ID = "9c0d1e2f-3a4b-4c5d-8e9f-0a1b2c3d4e5f";

/** 서버가 실제로 내보내는 형태 — 본문에 requestId, 헤더에 X-Request-Id */
function errorResponse(
  status: number,
  code: string,
  options: { requestId?: string | null; headerId?: string | null; body?: string } = {},
): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  const headerId = options.headerId === undefined ? REQUEST_ID : options.headerId;
  if (headerId !== null) headers.set("X-Request-Id", headerId);

  const requestId = options.requestId === undefined ? REQUEST_ID : options.requestId;
  const body =
    options.body ??
    JSON.stringify(
      requestId === null ? { error: "실패", code } : { error: "실패", code, requestId },
    );

  return new Response(body, { status, headers });
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-Id": REQUEST_ID },
  });
}

const ANALYZE_OK: AnalyzeResponse = {
  sessionId: SESSION_ID,
  identified: [],
  unidentified: [],
  overflowCount: 0,
  unidentifiedOverflowCount: 0,
  failedPhotoCount: 0,
  failedPhotoIndexes: [],
};

const BOOK_REFERENCE: BookReference = {
  isbn13: "9788934972467",
  title: "사피엔스",
  author: "유발 하라리",
  proof: "abc.def",
};

const RECOMMEND_INPUT: RecommendRequest = {
  sessionId: SESSION_ID,
  books: [
    {
      isbn13: "9788934972467",
      title: "사피엔스",
      author: "유발 하라리",
      pages: 636,
      claudeNote: "",
      proof: "abc.def",
    },
  ],
  mood: "번아웃이라 가볍게",
  inputMode: "free_text",
  // 세션 진행 상태는 필수 평면 필드다. 값을 아는 것은 화면이고,
  // 이 래퍼는 받은 입력을 그대로 실어 보내기만 한다 (API_SPEC /api/recommend).
  retryIndex: 0,
  irrelevantStreak: 0,
};

const IMAGE = "data:image/jpeg;base64,AAAA";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 마지막 호출의 (url, init) */
function lastCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch가 호출되지 않았습니다");
  return [String(call[0]), (call[1] ?? {}) as RequestInit];
}

describe("요청 형태", () => {
  it("analyzePhotos는 /api/analyze에 sessionId와 images를 POST한다", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, ANALYZE_OK));

    const result = await analyzePhotos(SESSION_ID, [IMAGE]);

    expect(result).toEqual({ ok: true, data: ANALYZE_OK });
    const [url, init] = lastCall();
    expect(url).toBe("/api/analyze");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ sessionId: SESSION_ID, images: [IMAGE] });
  });

  it("resolveBook은 /api/books/resolve에 query를 POST한다", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { candidates: [] }));

    const result = await resolveBook(SESSION_ID, "사피엔스");

    expect(result).toEqual({ ok: true, data: { candidates: [] } });
    const [url, init] = lastCall();
    expect(url).toBe("/api/books/resolve");
    expect(JSON.parse(String(init.body))).toEqual({ sessionId: SESSION_ID, query: "사피엔스" });
  });

  it("fetchMoodQuestions는 /api/mood/questions에 책 목록을 POST한다", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { questions: [] }));

    const result = await fetchMoodQuestions(SESSION_ID, [BOOK_REFERENCE]);

    expect(result).toEqual({ ok: true, data: { questions: [] } });
    const [url, init] = lastCall();
    expect(url).toBe("/api/mood/questions");
    expect(JSON.parse(String(init.body))).toEqual({
      sessionId: SESSION_ID,
      books: [BOOK_REFERENCE],
    });
  });

  it("requestRecommendations는 받은 입력을 그대로 /api/recommend에 POST한다", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { recommendations: [], shortfall: false }));

    const result = await requestRecommendations(RECOMMEND_INPUT);

    expect(result).toEqual({ ok: true, data: { recommendations: [], shortfall: false } });
    const [url, init] = lastCall();
    expect(url).toBe("/api/recommend");
    expect(JSON.parse(String(init.body))).toEqual(RECOMMEND_INPUT);
  });

  it("sendClientEvent는 /api/events에 POST한다", async () => {
    fetchMock.mockResolvedValue(jsonResponse(202, { accepted: true }));

    await sendClientEvent({
      sessionId: SESSION_ID,
      event: "recommend_accepted",
      properties: { position: 2 },
    });

    const [url, init] = lastCall();
    expect(url).toBe("/api/events");
    expect(JSON.parse(String(init.body))).toEqual({
      sessionId: SESSION_ID,
      event: "recommend_accepted",
      properties: { position: 2 },
    });
  });
});

describe("실패는 값으로 돌아온다", () => {
  it.each([
    [400, "INVALID_REQUEST"],
    [400, "UNVERIFIED_BOOKS"],
    [404, "EMPTY_SHELF"],
    [404, "NOT_FOUND_IN_ALADIN"],
    [413, "PAYLOAD_TOO_LARGE"],
    [422, "IRRELEVANT_MOOD"],
    [500, "INTERNAL_ERROR"],
    [502, "UPSTREAM_UNAVAILABLE"],
    [502, "RECOMMENDATION_VALIDATION_FAILED"],
    [503, "SERVICE_DISABLED"],
    [504, "TIMEOUT"],
  ])("서버가 %i %s를 내면 같은 code로 돌려준다", async (status, code) => {
    fetchMock.mockResolvedValue(errorResponse(status, code));

    const result = await analyzePhotos(SESSION_ID, [IMAGE]);

    expect(result).toEqual({ ok: false, code, requestId: REQUEST_ID, status });
  });

  it("500·502·504·422가 서로 다른 code로 갈라진다", async () => {
    const codes: string[] = [];
    for (const [status, code] of [
      [500, "INTERNAL_ERROR"],
      [502, "UPSTREAM_UNAVAILABLE"],
      [504, "TIMEOUT"],
      [422, "IRRELEVANT_MOOD"],
    ] as const) {
      fetchMock.mockResolvedValue(errorResponse(status, code));
      const result = await requestRecommendations(RECOMMEND_INPUT);
      if (result.ok) throw new Error("실패를 기대했습니다");
      codes.push(result.code);
    }
    expect(new Set(codes).size).toBe(4);
  });

  it("어떤 실패에서도 예외를 던지지 않는다", async () => {
    fetchMock.mockResolvedValue(errorResponse(502, "UPSTREAM_UNAVAILABLE"));
    await expect(resolveBook(SESSION_ID, "사피엔스")).resolves.toMatchObject({ ok: false });
  });
});

describe("본문을 읽지 못해도 결과를 돌려준다", () => {
  it("HTML 본문 + 5xx면 INTERNAL_ERROR로 유추한다", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>500</html>", {
        status: 500,
        headers: { "Content-Type": "text/html", "X-Request-Id": REQUEST_ID },
      }),
    );

    const result = await analyzePhotos(SESSION_ID, [IMAGE]);

    expect(result).toEqual({
      ok: false,
      code: "INTERNAL_ERROR",
      requestId: REQUEST_ID,
      status: 500,
    });
  });

  it("HTML 본문 + 4xx면 INVALID_REQUEST로 유추한다", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>400</html>", { status: 400, headers: { "X-Request-Id": REQUEST_ID } }),
    );

    const result = await resolveBook(SESSION_ID, "사피엔스");

    expect(result).toMatchObject({ ok: false, code: "INVALID_REQUEST", status: 400 });
  });

  it("본문을 못 읽어도 504는 TIMEOUT으로 남는다 — 우리 결함으로 오귀속하지 않는다", async () => {
    fetchMock.mockResolvedValue(
      new Response("", { status: 504, headers: { "X-Request-Id": REQUEST_ID } }),
    );

    const result = await analyzePhotos(SESSION_ID, [IMAGE]);

    expect(result).toMatchObject({ ok: false, code: "TIMEOUT", status: 504 });
  });

  it("본문이 우리 에러 계약을 어기면(code 누락) 상태 코드로 유추한다", async () => {
    fetchMock.mockResolvedValue(errorResponse(500, "INTERNAL_ERROR", { body: '{"oops":true}' }));

    const result = await analyzePhotos(SESSION_ID, [IMAGE]);

    expect(result).toMatchObject({ ok: false, code: "INTERNAL_ERROR", requestId: REQUEST_ID });
  });

  it("본문이 목록 밖 code를 담아도 상태 코드로 유추한다", async () => {
    fetchMock.mockResolvedValue(errorResponse(400, "WHO_KNOWS"));

    const result = await resolveBook(SESSION_ID, "사피엔스");

    expect(result).toMatchObject({ ok: false, code: "INVALID_REQUEST", status: 400 });
  });

  it("200인데 본문이 JSON이 아니면 INTERNAL_ERROR로 돌려준다", async () => {
    fetchMock.mockResolvedValue(
      new Response("not json", { status: 200, headers: { "X-Request-Id": REQUEST_ID } }),
    );

    const result = await analyzePhotos(SESSION_ID, [IMAGE]);

    expect(result).toMatchObject({ ok: false, code: "INTERNAL_ERROR", status: 200 });
  });
});

describe("requestId", () => {
  it("본문의 requestId를 우선한다", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(502, "UPSTREAM_UNAVAILABLE", { requestId: "body-id", headerId: "header-id" }),
    );

    const result = await analyzePhotos(SESSION_ID, [IMAGE]);

    expect(result).toMatchObject({ requestId: "body-id" });
  });

  it("본문에 없으면 X-Request-Id 헤더에서 읽는다", async () => {
    fetchMock.mockResolvedValue(
      new Response("", { status: 502, headers: { "X-Request-Id": "header-id" } }),
    );

    const result = await analyzePhotos(SESSION_ID, [IMAGE]);

    expect(result).toMatchObject({ requestId: "header-id" });
  });

  it("둘 다 없으면 null이다 — 없는 ID를 지어내지 않는다", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 502 }));

    const result = await analyzePhotos(SESSION_ID, [IMAGE]);

    expect(result).toMatchObject({ requestId: null });
  });
});

describe("네트워크·타임아웃", () => {
  it("fetch가 던지면 UPSTREAM_UNAVAILABLE로 정규화한다 (status 0)", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await resolveBook(SESSION_ID, "사피엔스");

    expect(result).toEqual({
      ok: false,
      code: "UPSTREAM_UNAVAILABLE",
      requestId: null,
      status: 0,
    });
  });

  it("클라이언트 타임아웃은 서버 상한보다 길다 (API_SPEC 공통 규약)", () => {
    expect(CLIENT_TIMEOUT_MS).toEqual({
      analyze: 70_000,
      resolve: 15_000,
      questions: 35_000,
      recommend: 35_000,
      events: 5_000,
    });
  });

  it("타임아웃이 지나면 요청을 abort하고 TIMEOUT을 돌려준다 — 504와 같은 code다", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      );

      const pending = analyzePhotos(SESSION_ID, [IMAGE]);
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS.analyze);

      await expect(pending).resolves.toEqual({
        ok: false,
        code: "TIMEOUT",
        requestId: null,
        status: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  /* ---------------------------------------------------------------- *
   * 오프라인과 상류 장애를 가른다 (PRD 5번 [오프라인·네트워크 단절], ADR-005)
   *
   * `fetch`가 던졌다는 사실만으로는 **누가 고칠 수 있는 문제인지** 알 수 없다.
   * 연결이 끊긴 사용자에게 "잠시 후 다시 시도해 주세요"라고 말하면 기다려도
   * 아무 일이 일어나지 않고, 상류 장애를 "인터넷 연결을 확인해 주세요"라고 말하면
   * 멀쩡한 와이파이를 껐다 켜게 만든다. 시스템 문제를 데이터·환경 문제로 설명하지
   * 않는다는 규칙이 이 자리에도 걸린다.
   *
   * **`navigator.onLine`은 jsdom 전역이다.** 덮은 채로 두면 이 파일 뒤의 검사는
   * 물론 다른 파일의 검사까지 오프라인 분기를 탄다. `delete`로 되돌리지 않는다 —
   * 원본이 프로토타입의 getter라 `delete`는 그 동작을 되살리지 못하고 `undefined`로
   * 굳힌다. `vi.spyOn` + `afterEach`의 `vi.restoreAllMocks()`(이 파일 위쪽)로
   * 되돌리고, 되돌아왔다는 것 자체를 아래 마지막 검사가 단정한다.
   * ---------------------------------------------------------------- */

  /** 이 검사 동안만 연결 상태를 바꾼다. 되돌리는 것은 `afterEach`다 */
  function setOnLine(value: boolean): void {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(value);
  }

  it("연결이 끊긴 채로 fetch가 던지면 OFFLINE으로 가른다", async () => {
    setOnLine(false);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await analyzePhotos(SESSION_ID, [IMAGE]);

    // 응답을 하나도 받지 못했으므로 매길 HTTP 상태가 없다(0). OFFLINE은
    // 클라이언트 전용 어휘라 서버가 낼 수 없고, `status: 0`이 그 사실이다.
    expect(result).toEqual({
      ok: false,
      code: "OFFLINE",
      requestId: null,
      status: 0,
    });
  });

  it("연결이 살아 있는데 fetch가 던지면 UPSTREAM_UNAVAILABLE로 남는다", async () => {
    setOnLine(true);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await requestRecommendations(RECOMMEND_INPUT);

    // 상류 장애를 단절이라고 부르지 않는다. `onLine === true`는 단절의 근거가
    // 아니라 **단절이 아니라는 근거**로만 쓴다.
    expect(result).toEqual({
      ok: false,
      code: "UPSTREAM_UNAVAILABLE",
      requestId: null,
      status: 0,
    });
  });

  it("연결이 끊겨 있어도 우리가 건 타임아웃이면 TIMEOUT이 이긴다", async () => {
    setOnLine(false);
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      );

      const pending = analyzePhotos(SESSION_ID, [IMAGE]);
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS.analyze);

      // 70초를 기다린 사실을 "인터넷을 확인하세요"로 덮으면 사진 장수를 줄이라는
      // 안내가 사라진다. 우리가 abort한 것은 우리가 아는 사실이고, `onLine`은
      // 그때 무엇이었든 그보다 약한 근거다.
      await expect(pending).resolves.toEqual({
        ok: false,
        code: "TIMEOUT",
        requestId: null,
        status: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("앞 검사가 덮은 navigator.onLine이 되돌아와 있다 (격리 회귀 — 삭제하지 마라)", () => {
    // 이 단정이 없으면 격리가 깨진 날 이 파일은 그대로 통과하고, 대신 이 파일을
    // **뒤따르는** 검사들이 알 수 없는 이유로 무너진다. 원인에서 잡는다.
    expect(navigator.onLine).toBe(true);
  });

  it("각 호출에 AbortSignal을 붙인다", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { candidates: [] }));
    await resolveBook(SESSION_ID, "사피엔스");
    const [, init] = lastCall();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("응답이 돌아오면 타이머를 정리한다 — 떠도는 abort가 남지 않는다", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    fetchMock.mockResolvedValue(jsonResponse(200, { candidates: [] }));

    await resolveBook(SESSION_ID, "사피엔스");

    expect(clearSpy).toHaveBeenCalled();
  });
});

describe("이벤트", () => {
  it("전송이 실패해도 삼킨다 — 로깅 실패가 화면을 막지 않는다", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(
      sendClientEvent({
        sessionId: SESSION_ID,
        event: "book_resolved",
        properties: { resolve_attempt: 1, matched: true },
      }),
    ).resolves.toBeUndefined();
  });

  it("서버가 400을 내도 삼킨다", async () => {
    fetchMock.mockResolvedValue(errorResponse(400, "INVALID_REQUEST"));

    await expect(
      sendClientEvent({
        sessionId: SESSION_ID,
        event: "recommend_accepted",
        properties: { position: 1 },
      }),
    ).resolves.toBeUndefined();
  });

  it("recommend_viewed를 보내지 않는다 — 라우트가 이미 남긴다 (North Star 이중 계상)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(202, { accepted: true }));

    await sendClientEvent({
      sessionId: SESSION_ID,
      event: "book_resolved",
      properties: { resolve_attempt: 1, matched: false },
    });

    for (const call of fetchMock.mock.calls) {
      expect(String(call[1]?.body)).not.toContain("recommend_viewed");
    }
  });
});
