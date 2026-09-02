import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_ALADIN_CANDIDATES } from "@/lib/env";
import { verifyProof } from "@/lib/proof";
import { resolveResponseSchema } from "@/lib/schemas";
import type { LookupOutcome } from "@/lib/match";
import type { FactsOutcome, SearchOptions } from "@/services/aladin";
import type { AladinCandidate, AladinFacts } from "@/types/book";

/* ------------------------------------------------------------------ *
 * 모킹 — 실제 알라딘을 절대 부르지 않는다 (TRD 8번)
 *
 * `services/aladin`에서 네트워크를 하는 둘만 갈아 끼우고 `createRequestBreaker`는
 * 진짜를 쓴다(순수 인메모리다). `lib/`은 전부 진짜다 — 서명·스키마까지 모킹하면
 * 라우트가 그것들을 다시 구현해도 초록불이 나온다.
 * ------------------------------------------------------------------ */

const { searchByTitleMock, lookupFactsManyMock } = vi.hoisted(() => ({
  searchByTitleMock: vi.fn(),
  lookupFactsManyMock: vi.fn(),
}));

vi.mock("@/services/aladin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/aladin")>();
  return { ...actual, searchByTitle: searchByTitleMock, lookupFactsMany: lookupFactsManyMock };
});

import { POST, maxDuration } from "./route";

/* ------------------------------------------------------------------ *
 * 픽스처
 * ------------------------------------------------------------------ */

const SESSION_ID = "5f7c2a1e-0000-4000-8000-000000000001";

function isbnOf(index: number): string {
  return `9788900000${String(index).padStart(3, "0")}`;
}

function candidateOf(index: number, title = `후보 ${index}`): AladinCandidate {
  return {
    isbn13: isbnOf(index),
    title,
    author: "한강 (지은이)",
    publisher: "창비",
    coverUrl: `https://image.aladin.co.kr/cover/${isbnOf(index)}.jpg`,
  };
}

function factsOf(
  candidate: AladinCandidate,
  pages: number | null = 208,
  aladinRating: number | null = 8.6,
): AladinFacts {
  return {
    ...candidate,
    pages,
    aladinRating,
    aladinLink: `https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=${candidate.isbn13}`,
  };
}

function resolveRequest(body: unknown): Request {
  return new Request("http://localhost/api/books/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** 정상 요청 본문. 필요한 필드만 덮어쓴다 */
function bodyOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionId: SESSION_ID, query: "소년이 온다", ...overrides };
}

/* ------------------------------------------------------------------ *
 * 대역 설정 헬퍼
 * ------------------------------------------------------------------ */

const searchOptionsSeen: SearchOptions[] = [];
const lookupOptionsSeen: SearchOptions[] = [];
const lookupIsbnsSeen: string[][] = [];

/** ItemSearch 결과를 고정한다 */
function setSearch(
  outcome: LookupOutcome | ((title: string, author: string | null) => LookupOutcome),
): void {
  searchByTitleMock.mockImplementation(
    async (title: string, author: string | null, options: SearchOptions) => {
      searchOptionsSeen.push(options);
      return typeof outcome === "function" ? outcome(title, author) : outcome;
    },
  );
}

/** ISBN13별 ItemLookUp 결과를 결정한다 */
function setFacts(resolve: (isbn13: string) => FactsOutcome): void {
  lookupFactsManyMock.mockImplementation(async (isbn13s: string[], options: SearchOptions) => {
    lookupOptionsSeen.push(options);
    lookupIsbnsSeen.push([...isbn13s]);
    return isbn13s.map((isbn13) => resolve(isbn13));
  });
}

/** 검색이 돌려준 후보를 그대로 사실로 채우는 기본 대역 */
function factsForAll(pages: number | null = 208, aladinRating: number | null = 8.6): void {
  setFacts((isbn13) => ({
    status: "ok",
    facts: factsOf(candidateOf(Number(isbn13.slice(-3))), pages, aladinRating),
  }));
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** 응답 후보를 proof 검증에 그대로 넘길 수 있는 형태로 읽는다 */
type ResponseCandidate = { isbn13: string; title: string; author: string; proof: string };

beforeEach(() => {
  vi.stubEnv("BOOK_PROOF_SECRET", "test-book-proof-secret-0123456789abcdef");
  vi.stubEnv("SERVICE_ENABLED", undefined);
  searchOptionsSeen.length = 0;
  lookupOptionsSeen.length = 0;
  lookupIsbnsSeen.length = 0;
  setSearch({ status: "ok", candidates: [] });
  factsForAll();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ *
 * 라우트 설정 (API_SPEC 공통 규약)
 * ------------------------------------------------------------------ */

describe("라우트 설정", () => {
  it("maxDuration이 이 라우트의 하드 상한 10초로 선언돼 있다", () => {
    expect(maxDuration).toBe(10);
  });
});

/* ------------------------------------------------------------------ *
 * 정상 경로
 * ------------------------------------------------------------------ */

describe("정상 경로", () => {
  beforeEach(() => {
    setSearch({
      status: "ok",
      candidates: [candidateOf(1), candidateOf(2), candidateOf(3)],
    });
  });

  it("후보 3건을 돌려주고 응답이 resolveResponseSchema를 통과한다", async () => {
    const response = await POST(resolveRequest(bodyOf()));

    expect(response.status).toBe(200);
    const body = await readJson(response);
    const parsed = resolveResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.candidates).toHaveLength(3);
  });

  it("사실 필드는 ItemLookUp에서 온 값을 그대로 싣는다", async () => {
    const response = await POST(resolveRequest(bodyOf()));
    const body = await readJson(response);
    const [first] = body.candidates as Record<string, unknown>[];

    expect(first.isbn13).toBe(isbnOf(1));
    expect(first.pages).toBe(208);
    expect(first.aladinRating).toBe(8.6);
    expect(first.aladinLink).toBe(
      `https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=${isbnOf(1)}`,
    );
  });

  it("X-Request-Id 헤더를 붙인다 (TRD 6.4 상관관계 ID)", async () => {
    const response = await POST(resolveRequest(bodyOf()));
    expect(response.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("author를 생략해도 동작하고 알라딘에는 null로 넘어간다", async () => {
    const response = await POST(resolveRequest(bodyOf()));

    expect(response.status).toBe(200);
    expect(searchByTitleMock).toHaveBeenCalledWith("소년이 온다", null, expect.anything());
  });

  it("author를 보내면 그대로 알라딘 조회에 넘긴다 (정확도를 높인다)", async () => {
    await POST(resolveRequest(bodyOf({ author: "한강" })));

    expect(searchByTitleMock).toHaveBeenCalledWith("소년이 온다", "한강", expect.anything());
  });

  it("Claude를 부르지 않으므로 응답에 claudeNote가 없다 (API_SPEC)", async () => {
    const response = await POST(resolveRequest(bodyOf()));
    const body = await readJson(response);

    for (const candidate of body.candidates as Record<string, unknown>[]) {
      expect(candidate).not.toHaveProperty("claudeNote");
    }
  });

  it("ItemSearch와 ItemLookUp이 같은 요청 스코프 브레이커를 나눠 쓴다", async () => {
    await POST(resolveRequest(bodyOf()));

    expect(searchOptionsSeen[0].breaker).toBeDefined();
    expect(lookupOptionsSeen[0].breaker).toBe(searchOptionsSeen[0].breaker);
  });

  it("두 요청이 브레이커를 공유하지 않는다 (ADR-003 무상태)", async () => {
    await POST(resolveRequest(bodyOf()));
    await POST(resolveRequest(bodyOf()));

    expect(lookupOptionsSeen[1].breaker).not.toBe(lookupOptionsSeen[0].breaker);
  });
});

/* ------------------------------------------------------------------ *
 * 증명 동반 — 이 테스트는 삭제하지 않는다 (ADR-006, US-002 검증 우회 차단)
 * ------------------------------------------------------------------ */

describe("proof 서명 (ADR-006)", () => {
  it("후보 전원에 proof가 있고 verifyProof로 검증된다", async () => {
    setSearch({
      status: "ok",
      candidates: [candidateOf(1), candidateOf(2), candidateOf(3)],
    });

    const response = await POST(resolveRequest(bodyOf()));
    const body = await readJson(response);
    const candidates = body.candidates as ResponseCandidate[];

    expect(candidates).toHaveLength(3);
    for (const candidate of candidates) {
      expect(candidate.proof).toEqual(expect.any(String));
      expect(verifyProof(candidate, candidate.proof)).toEqual({ ok: true });
    }
  });

  it("한 후보의 proof를 다른 후보에 옮겨 붙이면 검증에 실패한다", async () => {
    setSearch({ status: "ok", candidates: [candidateOf(1), candidateOf(2)] });

    const response = await POST(resolveRequest(bodyOf()));
    const body = await readJson(response);
    const [first, second] = body.candidates as ResponseCandidate[];

    expect(verifyProof(first, second.proof)).toEqual({ ok: false, reason: "bad_signature" });
  });
});

/* ------------------------------------------------------------------ *
 * 요청 검증 (API_SPEC 400)
 * ------------------------------------------------------------------ */

describe("요청 검증", () => {
  it("빈 문자열 query는 400이다", async () => {
    const response = await POST(resolveRequest(bodyOf({ query: "" })));

    expect(response.status).toBe(400);
    expect((await readJson(response)).code).toBe("INVALID_REQUEST");
    expect(searchByTitleMock).not.toHaveBeenCalled();
  });

  it("201자 query는 400이다", async () => {
    const response = await POST(resolveRequest(bodyOf({ query: "가".repeat(201) })));

    expect(response.status).toBe(400);
    expect(searchByTitleMock).not.toHaveBeenCalled();
  });

  it("200자 query는 통과한다 (경계값)", async () => {
    setSearch({ status: "ok", candidates: [candidateOf(1)] });

    const response = await POST(resolveRequest(bodyOf({ query: "가".repeat(200) })));

    expect(response.status).toBe(200);
  });

  it("sessionId가 없으면 400이다", async () => {
    const response = await POST(resolveRequest({ query: "소년이 온다" }));

    expect(response.status).toBe(400);
  });

  it("JSON이 아닌 본문은 400이다", async () => {
    const response = await POST(resolveRequest("이건 JSON이 아니다"));

    expect(response.status).toBe(400);
    expect((await readJson(response)).code).toBe("INVALID_REQUEST");
  });

  it("에러 응답 본문에 requestId가 있고 헤더와 같은 값이다 (UI_GUIDE 에러 배너)", async () => {
    const response = await POST(resolveRequest(bodyOf({ query: "" })));
    const body = await readJson(response);

    expect(body.requestId).toBe(response.headers.get("X-Request-Id"));
    expect(body.error).toEqual(expect.any(String));
  });
});

/* ------------------------------------------------------------------ *
 * 결과 없음과 조회 실패는 다른 응답이다 — 삭제 금지 (ADR-005 회귀)
 * ------------------------------------------------------------------ */

describe("검색 결과 0건과 알라딘 장애를 구분한다 (ADR-005)", () => {
  it("검색 결과 0건은 404 NOT_FOUND_IN_ALADIN이다", async () => {
    setSearch({ status: "ok", candidates: [] });

    const response = await POST(resolveRequest(bodyOf()));

    expect(response.status).toBe(404);
    expect((await readJson(response)).code).toBe("NOT_FOUND_IN_ALADIN");
    expect(lookupFactsManyMock).not.toHaveBeenCalled();
  });

  it("알라딘 5xx·타임아웃은 502이고 404가 아니다", async () => {
    setSearch({ status: "failed" });

    const response = await POST(resolveRequest(bodyOf()));

    expect(response.status).toBe(502);
    expect(response.status).not.toBe(404);
    expect((await readJson(response)).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("검색은 찾았지만 사실을 하나도 못 채우면 502다 — 알라딘에 없다는 뜻이 아니다", async () => {
    setSearch({ status: "ok", candidates: [candidateOf(1), candidateOf(2)] });
    setFacts(() => ({ status: "failed" }));

    const response = await POST(resolveRequest(bodyOf()));

    expect(response.status).toBe(502);
    expect((await readJson(response)).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("일부 후보의 사실 조회만 실패하면 나머지는 그대로 돌려준다 (fail-soft)", async () => {
    setSearch({
      status: "ok",
      candidates: [candidateOf(1), candidateOf(2), candidateOf(3)],
    });
    setFacts((isbn13) =>
      isbn13 === isbnOf(2)
        ? { status: "failed" }
        : { status: "ok", facts: factsOf(candidateOf(Number(isbn13.slice(-3)))) },
    );

    const response = await POST(resolveRequest(bodyOf()));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect((body.candidates as { isbn13: string }[]).map((candidate) => candidate.isbn13)).toEqual([
      isbnOf(1),
      isbnOf(3),
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * 후보 상한과 순위 (API_SPEC, US-002)
 * ------------------------------------------------------------------ */

describe("후보 상한과 순위", () => {
  it("후보가 8건 와도 5건만 돌려준다", async () => {
    setSearch({
      status: "ok",
      candidates: Array.from({ length: 8 }, (_, index) => candidateOf(index + 1)),
    });

    const response = await POST(resolveRequest(bodyOf()));
    const body = await readJson(response);

    expect(body.candidates).toHaveLength(MAX_ALADIN_CANDIDATES);
  });

  it("상한을 넘긴 후보는 사실 조회조차 하지 않는다 (알라딘 일일 한도)", async () => {
    setSearch({
      status: "ok",
      candidates: Array.from({ length: 8 }, (_, index) => candidateOf(index + 1)),
    });

    await POST(resolveRequest(bodyOf()));

    expect(lookupIsbnsSeen[0]).toHaveLength(MAX_ALADIN_CANDIDATES);
  });

  it("알라딘 검색 순위를 그대로 보존한다 — 서버가 재정렬하지 않는다", async () => {
    const ranked = [candidateOf(7), candidateOf(2), candidateOf(9), candidateOf(1)];
    setSearch({ status: "ok", candidates: ranked });

    const response = await POST(resolveRequest(bodyOf()));
    const body = await readJson(response);

    expect((body.candidates as { isbn13: string }[]).map((candidate) => candidate.isbn13)).toEqual(
      ranked.map((candidate) => candidate.isbn13),
    );
  });

  it("후보가 1건이어도 서버가 임의로 확정하지 않고 목록으로 돌려준다 (US-002)", async () => {
    setSearch({ status: "ok", candidates: [candidateOf(4)] });

    const response = await POST(resolveRequest(bodyOf()));
    const body = await readJson(response);

    expect(body.candidates).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 정보 없는 필드 (API_SPEC — null은 정상값이다)
 * ------------------------------------------------------------------ */

describe("사실 필드가 비어 있는 책", () => {
  it("pages·aladinRating이 null이어도 정상 후보로 돌려준다", async () => {
    setSearch({ status: "ok", candidates: [candidateOf(1)] });
    factsForAll(null, null);

    const response = await POST(resolveRequest(bodyOf()));
    const body = await readJson(response);
    const [first] = body.candidates as Record<string, unknown>[];

    expect(response.status).toBe(200);
    expect(first.pages).toBeNull();
    expect(first.aladinRating).toBeNull();
    expect(resolveResponseSchema.safeParse(body).success).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 긴급 차단 스위치 (TRD 7번)
 * ------------------------------------------------------------------ */

describe("SERVICE_ENABLED", () => {
  it("false면 외부 호출 없이 503이다", async () => {
    vi.stubEnv("SERVICE_ENABLED", "false");

    const response = await POST(resolveRequest(bodyOf()));

    expect(response.status).toBe(503);
    expect((await readJson(response)).code).toBe("SERVICE_DISABLED");
    expect(searchByTitleMock).not.toHaveBeenCalled();
  });

  it("값이 망가져 읽을 수 없으면 차단 쪽으로 넘어진다", async () => {
    vi.stubEnv("SERVICE_ENABLED", "maybe");

    const response = await POST(resolveRequest(bodyOf()));

    expect(response.status).toBe(503);
    expect(searchByTitleMock).not.toHaveBeenCalled();
  });
});
