import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALADIN_CALL_TIMEOUT_MS,
  ALADIN_CONCURRENCY,
  BREAKER_CONSECUTIVE_FAILURES,
  createRequestBreaker,
  searchByTitle,
  searchMany,
} from "./aladin";

/** 테스트에서 쓰는 TTB 키. 어떤 로그·에러에도 이 문자열이 나타나서는 안 된다 (TRD 6.5) */
const TTB_KEY = "ttb_secret_key_do_not_leak_0001";

/** 넉넉한 데드라인. 예산을 검증하는 테스트만 이 값을 줄여 쓴다 */
const AMPLE_DEADLINE_MS = 10_000;

/* ------------------------------------------------------------------ *
 * 응답 픽스처 — 실제 알라딘을 부르지 않는다 (TRD 8번)
 * ------------------------------------------------------------------ */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

/** 알라딘 ItemSearch 원본 레코드 1건 */
function aladinItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "소년이 온다",
    author: "한강 (지은이)",
    publisher: "창비",
    isbn13: "9788936434120",
    isbn: "8936434128",
    cover: "https://image.aladin.co.kr/product/4086/40/cover/8936434128_1.jpg",
    link: "https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=40864086",
    priceSales: 13500,
    ...overrides,
  };
}

/** ItemSearch 응답 봉투 */
function searchBody(items: Record<string, unknown>[]): Record<string, unknown> {
  return {
    version: "20131101",
    title: "알라딘 검색결과",
    totalResults: items.length,
    startIndex: 1,
    itemsPerPage: items.length,
    query: "...",
    item: items,
  };
}

/** 호출을 세는 fetch 스텁 */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => Promise<Response>) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** 항상 같은 응답을 주는 fetch 스텁 */
function alwaysRespond(response: () => Response) {
  return stubFetch(async () => response());
}

/** 절대 스스로 끝나지 않고 abort 신호에만 반응하는 fetch 스텁 — 타임아웃 경로 검증용 */
function neverResolves() {
  return stubFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
  );
}

beforeEach(() => {
  vi.stubEnv("ALADIN_TTB_KEY", TTB_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * 상수
 * ------------------------------------------------------------------ */

describe("상수 — TRD가 정한 값을 그대로 쓴다", () => {
  it("동시성은 12다 (TR-004)", () => {
    expect(ALADIN_CONCURRENCY).toBe(12);
  });

  it("요청 스코프 브레이커는 연속 5회 실패에 열린다 (TRD 7번)", () => {
    expect(BREAKER_CONSECUTIVE_FAILURES).toBe(5);
  });

  it("개별 호출 타임아웃은 5s다 (TRD 7번 외부 의존성 표)", () => {
    expect(ALADIN_CALL_TIMEOUT_MS).toBe(5_000);
  });
});

/* ------------------------------------------------------------------ *
 * 성공 경로와 검증 경계
 * ------------------------------------------------------------------ */

describe("searchByTitle — 성공 응답", () => {
  it("200 + 결과 2건이면 ok로 후보 2건을 돌려주고 cover를 coverUrl로 옮긴다", async () => {
    const { impl } = alwaysRespond(() =>
      jsonResponse(
        searchBody([
          aladinItem(),
          aladinItem({ title: "채식주의자", isbn13: "9788936433598", publisher: "창비" }),
        ]),
      ),
    );

    const outcome = await searchByTitle("소년이 온다", "한강", {
      deadlineMs: AMPLE_DEADLINE_MS,
      fetchImpl: impl,
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.candidates).toHaveLength(2);
    expect(outcome.candidates[0]).toEqual({
      isbn13: "9788936434120",
      title: "소년이 온다",
      author: "한강 (지은이)",
      publisher: "창비",
      coverUrl: "https://image.aladin.co.kr/product/4086/40/cover/8936434128_1.jpg",
    });
  });

  it("결과 0건은 ok + 빈 배열이다 — failed가 아니다 (no_match와 lookup_failed의 갈림길, ADR-005)", async () => {
    const { impl } = alwaysRespond(() => jsonResponse(searchBody([])));

    const outcome = await searchByTitle("있을 리 없는 제목", null, {
      deadlineMs: AMPLE_DEADLINE_MS,
      fetchImpl: impl,
    });

    expect(outcome).toEqual({ status: "ok", candidates: [] });
  });

  it("ttbkey와 제목·저자를 쿼리에 실어 https로 호출한다", async () => {
    const { impl, calls } = alwaysRespond(() => jsonResponse(searchBody([aladinItem()])));

    await searchByTitle("소년이 온다", "한강", {
      deadlineMs: AMPLE_DEADLINE_MS,
      fetchImpl: impl,
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]);
    expect(url.protocol).toBe("https:");
    expect(url.searchParams.get("ttbkey")).toBe(TTB_KEY);
    expect(url.searchParams.get("Query")).toContain("소년이 온다");
    expect(url.searchParams.get("Query")).toContain("한강");
  });

  it("저자가 null이면 제목만 쿼리에 싣는다", async () => {
    const { impl, calls } = alwaysRespond(() => jsonResponse(searchBody([aladinItem()])));

    await searchByTitle("소년이 온다", null, {
      deadlineMs: AMPLE_DEADLINE_MS,
      fetchImpl: impl,
    });

    expect(new URL(calls[0]).searchParams.get("Query")).toBe("소년이 온다");
  });
});

describe("searchByTitle — 검증 경계 (CLAUDE.md CRITICAL, ADR-002)", () => {
  it("ISBN13이 없거나 형식이 틀린 레코드는 후보에서 빠진다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl } = alwaysRespond(() =>
      jsonResponse(
        searchBody([
          aladinItem({ isbn13: "" }), // 세트·구간 상품
          aladinItem({ isbn13: "897861234", title: "12자리 미만" }),
          aladinItem({ isbn13: "9788936434120", title: "정상" }),
        ]),
      ),
    );

    const outcome = await searchByTitle("아무 제목", null, {
      deadlineMs: AMPLE_DEADLINE_MS,
      fetchImpl: impl,
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0].title).toBe("정상");
    // 조용히 버리지 않는다 — 몇 건을 제외했는지 로그에 남는다
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain("2");
  });

  it("표지 URL이 절대 URL이 아니거나 필드가 통째로 빠진 레코드도 제외된다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl } = alwaysRespond(() =>
      jsonResponse(
        searchBody([
          aladinItem({ cover: "/product/cover.jpg" }),
          aladinItem({ publisher: undefined, title: "출판사 없음" }),
          aladinItem({ title: "정상" }),
        ]),
      ),
    );

    const outcome = await searchByTitle("아무 제목", null, {
      deadlineMs: AMPLE_DEADLINE_MS,
      fetchImpl: impl,
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.candidates.map((candidate) => candidate.title)).toEqual(["정상"]);
  });

  it("본문이 JSON이 아니면 failed다 — 빈 결과(no_match)로 뭉개지 않는다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl, calls } = alwaysRespond(() => textResponse("<html>점검 중</html>"));

    const outcome = await searchByTitle("소년이 온다", null, {
      deadlineMs: AMPLE_DEADLINE_MS,
      fetchImpl: impl,
    });

    expect(outcome).toEqual({ status: "failed" });
    // 같은 본문이 다시 올 뿐이므로 재시도하지 않는다
    expect(calls).toHaveLength(1);
  });

  it("봉투 형태가 어긋난 200 응답(errorCode 등)도 failed다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl } = alwaysRespond(() =>
      jsonResponse({ errorCode: 8, errorMessage: "Invalid TTBKey" }),
    );

    const outcome = await searchByTitle("소년이 온다", null, {
      deadlineMs: AMPLE_DEADLINE_MS,
      fetchImpl: impl,
    });

    expect(outcome).toEqual({ status: "failed" });
  });
});

/* ------------------------------------------------------------------ *
 * 실패 경로 — ADR-005 회귀. 이 블록은 삭제하지 않는다.
 * ------------------------------------------------------------------ */

describe("searchByTitle — 실패는 failed로 나른다 (ADR-005 회귀)", () => {
  it("500이면 failed다 — 절대 ok + 빈 배열이 아니다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl } = alwaysRespond(() => jsonResponse({}, 500));

    const outcome = await searchByTitle("소년이 온다", null, {
      deadlineMs: AMPLE_DEADLINE_MS,
      fetchImpl: impl,
    });

    expect(outcome).toEqual({ status: "failed" });
  });

  it("5xx는 1회 재시도한다 (호출 2회)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl, calls } = alwaysRespond(() => jsonResponse({}, 503));

    await searchByTitle("소년이 온다", null, {
      deadlineMs: AMPLE_DEADLINE_MS,
      fetchImpl: impl,
    });

    expect(calls).toHaveLength(2);
  });

  it("5xx 재시도가 성공하면 ok다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempt = 0;
    const { impl, calls } = stubFetch(async () => {
      attempt += 1;
      return attempt === 1 ? jsonResponse({}, 500) : jsonResponse(searchBody([aladinItem()]));
    });

    const outcome = await searchByTitle("소년이 온다", null, {
      deadlineMs: AMPLE_DEADLINE_MS,
      fetchImpl: impl,
    });

    expect(outcome.status).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("4xx는 재시도하지 않는다 — 우리 요청이 잘못된 것이므로 반복해도 같다 (호출 1회)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl, calls } = alwaysRespond(() => jsonResponse({}, 400));

    const outcome = await searchByTitle("소년이 온다", null, {
      deadlineMs: AMPLE_DEADLINE_MS,
      fetchImpl: impl,
    });

    expect(outcome).toEqual({ status: "failed" });
    expect(calls).toHaveLength(1);
  });

  it("네트워크 오류는 failed이고 1회 재시도한다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl, calls } = stubFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const outcome = await searchByTitle("소년이 온다", null, {
      deadlineMs: AMPLE_DEADLINE_MS,
      fetchImpl: impl,
    });

    expect(outcome).toEqual({ status: "failed" });
    expect(calls).toHaveLength(2);
  });

  it("타임아웃(데드라인 소진)은 failed이고, 남은 예산이 없으므로 재시도하지 않는다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl, calls } = neverResolves();

    const outcome = await searchByTitle("소년이 온다", null, {
      deadlineMs: 5,
      fetchImpl: impl,
    });

    expect(outcome).toEqual({ status: "failed" });
    expect(calls).toHaveLength(1);
  });

  it("데드라인이 0이면 호출하지 않고 즉시 failed다 (예산 소진 → lookup_failed)", async () => {
    const { impl, calls } = alwaysRespond(() => jsonResponse(searchBody([aladinItem()])));

    const outcome = await searchByTitle("소년이 온다", null, {
      deadlineMs: 0,
      fetchImpl: impl,
    });

    expect(outcome).toEqual({ status: "failed" });
    expect(calls).toHaveLength(0);
  });

  it("예산 소진은 브레이커의 연속 실패로 세지 않는다 — 알라딘이 죽은 것이 아니다", async () => {
    const { impl } = alwaysRespond(() => jsonResponse(searchBody([aladinItem()])));
    const breaker = createRequestBreaker();

    for (let i = 0; i < BREAKER_CONSECUTIVE_FAILURES + 1; i += 1) {
      await searchByTitle("소년이 온다", null, { deadlineMs: 0, breaker, fetchImpl: impl });
    }

    expect(breaker.isOpen()).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 요청 스코프 서킷 브레이커 (TRD 7번 [MVP])
 * ------------------------------------------------------------------ */

describe("createRequestBreaker — 요청 하나의 수명을 갖는다", () => {
  it("연속 5회 실패에 열린다", () => {
    const breaker = createRequestBreaker();
    for (let i = 0; i < BREAKER_CONSECUTIVE_FAILURES - 1; i += 1) {
      breaker.recordFailure();
      expect(breaker.isOpen()).toBe(false);
    }
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
  });

  it("성공하면 연속 실패 카운터가 초기화된다", () => {
    const breaker = createRequestBreaker();
    for (let i = 0; i < BREAKER_CONSECUTIVE_FAILURES - 1; i += 1) breaker.recordFailure();
    breaker.recordSuccess();
    for (let i = 0; i < BREAKER_CONSECUTIVE_FAILURES - 1; i += 1) breaker.recordFailure();

    expect(breaker.isOpen()).toBe(false);
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
  });

  it("새로 만들면 닫힌 상태다 — 상태가 모듈 스코프에 남지 않는다 (ADR-003)", () => {
    const first = createRequestBreaker();
    for (let i = 0; i < BREAKER_CONSECUTIVE_FAILURES; i += 1) first.recordFailure();
    expect(first.isOpen()).toBe(true);

    expect(createRequestBreaker().isOpen()).toBe(false);
  });
});

describe("searchByTitle — 브레이커가 열리면 조회하지 않는다", () => {
  it("연속 5회 실패 후 이후 쿼리는 fetch를 호출하지 않고 전부 failed다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl, calls } = alwaysRespond(() => jsonResponse({}, 500));
    const breaker = createRequestBreaker();
    const options = { deadlineMs: AMPLE_DEADLINE_MS, breaker, fetchImpl: impl };

    for (let i = 0; i < BREAKER_CONSECUTIVE_FAILURES; i += 1) {
      expect(await searchByTitle(`책 ${i}`, null, options)).toEqual({ status: "failed" });
    }
    expect(breaker.isOpen()).toBe(true);

    // 5회 × (호출 1 + 재시도 1) = 10회에서 멈춘다
    const callsBeforeOpen = calls.length;
    expect(callsBeforeOpen).toBe(BREAKER_CONSECUTIVE_FAILURES * 2);

    expect(await searchByTitle("브레이커 이후", null, options)).toEqual({ status: "failed" });
    expect(calls).toHaveLength(callsBeforeOpen);
  });
});

/* ------------------------------------------------------------------ *
 * searchMany — 동시성과 순서
 * ------------------------------------------------------------------ */

describe("searchMany", () => {
  function queries(count: number): { title: string; author: string | null }[] {
    return Array.from({ length: count }, (_, index) => ({
      title: `책 ${index}`,
      author: null,
    }));
  }

  it("동시 실행 수가 12를 넘지 않는다 (TR-004)", async () => {
    let inFlight = 0;
    let peak = 0;
    const { impl } = stubFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return jsonResponse(searchBody([aladinItem()]));
    });

    await searchMany(queries(40), { deadlineMs: AMPLE_DEADLINE_MS, fetchImpl: impl });

    expect(peak).toBeLessThanOrEqual(ALADIN_CONCURRENCY);
    expect(peak).toBe(ALADIN_CONCURRENCY);
  });

  it("결과 순서가 입력 순서와 같다", async () => {
    const { impl } = stubFetch(async (url) => {
      const query = new URL(url).searchParams.get("Query") ?? "";
      // 뒤쪽 쿼리를 더 빨리 끝내도 순서가 흔들리지 않아야 한다
      await new Promise((resolve) => setTimeout(resolve, query.endsWith("0") ? 3 : 0));
      return jsonResponse(searchBody([aladinItem({ title: query })]));
    });

    const outcomes = await searchMany(queries(5), {
      deadlineMs: AMPLE_DEADLINE_MS,
      fetchImpl: impl,
    });

    expect(outcomes).toHaveLength(5);
    outcomes.forEach((outcome, index) => {
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;
      expect(outcome.candidates[0].title).toBe(`책 ${index}`);
    });
  });

  it("브레이커가 열리면 잔여 후보는 조회하지 않고 전부 failed로 온다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl, calls } = alwaysRespond(() => jsonResponse({}, 500));

    const outcomes = await searchMany(queries(60), {
      deadlineMs: AMPLE_DEADLINE_MS,
      fetchImpl: impl,
    });

    expect(outcomes).toHaveLength(60);
    expect(outcomes.every((outcome) => outcome.status === "failed")).toBe(true);
    // 상한이 없으면 60건 × (호출 1 + 재시도 1) = 120회를 던진다.
    // 브레이커가 있으면 동시에 떠 있던 12건까지만 나가고 멈춘다.
    expect(calls.length).toBeLessThanOrEqual(ALADIN_CONCURRENCY * 2);
  });

  it("빈 목록이면 호출 없이 빈 배열이다", async () => {
    const { impl, calls } = alwaysRespond(() => jsonResponse(searchBody([])));

    expect(await searchMany([], { deadlineMs: AMPLE_DEADLINE_MS, fetchImpl: impl })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 목업 모드 (TRD 9번)
 * ------------------------------------------------------------------ */

describe("목업 모드 — ALADIN_TTB_KEY가 없을 때", () => {
  beforeEach(() => {
    vi.stubEnv("ALADIN_TTB_KEY", undefined);
  });

  it("fetch를 호출하지 않고 목업 후보를 돌려준다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl, calls } = alwaysRespond(() => jsonResponse(searchBody([aladinItem()])));

    const outcome = await searchByTitle("소년이 온다", "한강", {
      deadlineMs: AMPLE_DEADLINE_MS,
      fetchImpl: impl,
    });

    expect(calls).toHaveLength(0);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0].title).toBe("소년이 온다");
    expect(outcome.candidates[0].isbn13).toMatch(/^\d{13}$/);
  });

  it("목업이라는 사실을 로그로 드러낸다 — 조용한 목업은 금지다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await searchByTitle("소년이 온다", null, { deadlineMs: AMPLE_DEADLINE_MS });

    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain("목업");
  });

  it("같은 제목이면 같은 ISBN을 준다 — 사진 간 중복 제거(FR-004)를 로컬에서도 확인할 수 있어야 한다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const [first, second] = await searchMany(
      [
        { title: "소년이 온다", author: null },
        { title: "소년이 온다", author: "한강" },
      ],
      { deadlineMs: AMPLE_DEADLINE_MS },
    );

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status !== "ok" || second.status !== "ok") return;
    expect(first.candidates[0].isbn13).toBe(second.candidates[0].isbn13);
  });

  it("목업 ISBN은 실제 ISBN 접두사(978·979)를 쓰지 않는다 — 진짜처럼 보이면 안 된다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await searchByTitle("아무 책", null, { deadlineMs: AMPLE_DEADLINE_MS });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.candidates[0].isbn13.startsWith("97")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 시크릿 유출 회귀 (TRD 6.5). 이 블록은 삭제하지 않는다.
 * ------------------------------------------------------------------ */

describe("TTB 키는 로그·에러 어디에도 남지 않는다", () => {
  it("모든 실패 경로의 콘솔 출력에 키가 들어 있지 않다", async () => {
    const captured: string[] = [];
    const capture = (...args: unknown[]) => {
      captured.push(args.map((arg) => String(arg)).join(" "));
    };
    vi.spyOn(console, "warn").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    vi.spyOn(console, "log").mockImplementation(capture);

    const options = { deadlineMs: AMPLE_DEADLINE_MS };

    // 5xx · 4xx · JSON 아님 · 봉투 어긋남 · 스키마 탈락 · 네트워크 오류 · 타임아웃
    await searchByTitle("책", null, {
      ...options,
      fetchImpl: alwaysRespond(() => jsonResponse({}, 500)).impl,
    });
    await searchByTitle("책", null, {
      ...options,
      fetchImpl: alwaysRespond(() => jsonResponse({}, 404)).impl,
    });
    await searchByTitle("책", null, {
      ...options,
      fetchImpl: alwaysRespond(() => textResponse("not json")).impl,
    });
    await searchByTitle("책", null, {
      ...options,
      fetchImpl: alwaysRespond(() => jsonResponse({ errorCode: 8 })).impl,
    });
    await searchByTitle("책", null, {
      ...options,
      fetchImpl: alwaysRespond(() => jsonResponse(searchBody([aladinItem({ isbn13: "" })]))).impl,
    });
    await searchByTitle("책", null, {
      ...options,
      fetchImpl: stubFetch(async () => {
        // fetch 실패 메시지에 URL이 통째로 실려 오는 상황을 재현한다
        throw new Error(`request to https://www.aladin.co.kr/...?ttbkey=${TTB_KEY} failed`);
      }).impl,
    });
    await searchByTitle("책", null, { deadlineMs: 5, fetchImpl: neverResolves().impl });

    expect(captured.length).toBeGreaterThan(0);
    for (const line of captured) {
      expect(line).not.toContain(TTB_KEY);
    }
  });
});
