import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STAGE_BUDGET_MS, TOTAL_BUDGET_MS } from "@/lib/budget";
import {
  ALADIN_CALLS_PER_LOOKUP,
  MAX_ALADIN_CALLS_PER_SESSION,
  MAX_CANDIDATES_FOR_LOOKUP,
  MAX_IDENTIFIED_BOOKS,
  MAX_OUTPUT_BYTES_PER_IMAGE,
  MAX_OUTPUT_BYTES_TOTAL,
  MAX_UNIDENTIFIED_BOOKS,
  RATE_LIMIT_MAX_REQUESTS,
} from "@/lib/env";
import { CONFIDENCE_FLOOR } from "@/lib/merge";
import { resetRateLimit } from "@/lib/rate-limit";
import { verifyProof } from "@/lib/proof";
import { RESPONSE_REASON } from "@/lib/unidentified";
import { analyzeResponseSchema, unidentifiedReasonSchema } from "@/lib/schemas";
import type { LookupOutcome } from "@/lib/match";
import type { FactsOutcome } from "@/services/aladin";
import type { ExtractOutcome } from "@/services/anthropic";
import type { AladinCandidate, AladinFacts, ExtractedCandidate } from "@/types/book";

/* ------------------------------------------------------------------ *
 * 모킹 — 실제 외부 API를 절대 부르지 않는다 (TRD 8번)
 *
 * `services/`는 통째로 갈아 끼우고 `lib/`은 진짜를 그대로 쓴다. 이 테스트가
 * 검증하려는 것이 "라우트가 lib의 판정을 그대로 신뢰하는가"이기 때문이다 —
 * 판정까지 모킹하면 라우트가 판정을 다시 구현해도 초록불이 나온다.
 *
 * `lib/analytics`만 예외적으로 스파이로 바꾼다. 실제 `logEvent`는 어떤 예외도
 * 삼키도록 만들어져 있어(TR-012), "로깅이 실패해도 응답이 나간다"를 라우트
 * 층위에서 검증하려면 던질 수 있는 대역이 필요하다.
 * ------------------------------------------------------------------ */

const { logEventMock, extractMock, notesMock, searchManyMock, lookupFactsManyMock } = vi.hoisted(
  () => ({
    logEventMock: vi.fn(),
    extractMock: vi.fn(),
    notesMock: vi.fn(),
    searchManyMock: vi.fn(),
    lookupFactsManyMock: vi.fn(),
  }),
);

vi.mock("@/lib/analytics", () => ({ logEvent: logEventMock }));

vi.mock("@/services/anthropic", () => ({
  extractFromPhoto: extractMock,
  generateNotes: notesMock,
}));

vi.mock("@/services/aladin", async (importOriginal) => {
  // 요청 스코프 브레이커는 순수 인메모리라 진짜를 쓴다. 네트워크를 하는 둘만 바꾼다.
  const actual = await importOriginal<typeof import("@/services/aladin")>();
  return { ...actual, searchMany: searchManyMock, lookupFactsMany: lookupFactsManyMock };
});

import { POST, maxDuration } from "./route";

/* ------------------------------------------------------------------ *
 * 픽스처
 * ------------------------------------------------------------------ */

const SESSION_ID = "5f7c2a1e-0000-4000-8000-000000000001";

/** 스키마를 통과하는 최소 데이터 URI */
const IMAGE = "data:image/jpeg;base64,AAAA";

/** 사진 1장 추출이 쓴 토큰. 실패 응답에도 따라 나와야 한다 (PRD 7번 가드레일) */
const EXTRACT_USAGE = { input_tokens: 1600, output_tokens: 320 };

/** 한줄평 배치가 쓴 토큰 */
const NOTE_USAGE = { input_tokens: 900, output_tokens: 180 };

type Query = { title: string; author: string | null };

/** 13자리 ISBN을 인덱스로 만든다. 사전순이 곧 인덱스 순이라 절단 순서를 눈으로 읽을 수 있다 */
function isbnOf(index: number): string {
  return `9788900000${String(index).padStart(3, "0")}`;
}

function candidateOf(index: number, title: string): AladinCandidate {
  return {
    isbn13: isbnOf(index),
    title,
    author: "한강 (지은이)",
    publisher: "창비",
    coverUrl: `https://image.aladin.co.kr/cover/${isbnOf(index)}.jpg`,
  };
}

function factsOf(candidate: AladinCandidate, rating: number | null = 8.6): AladinFacts {
  return {
    ...candidate,
    pages: 208,
    aladinRating: rating,
    aladinLink: `https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=${candidate.isbn13}`,
  };
}

function extractedOf(
  title: string,
  photoIndex = 0,
  extra: Partial<ExtractedCandidate> = {},
): ExtractedCandidate {
  return { rawText: title, title, author: null, confidence: 0.9, photoIndex, ...extra };
}

function requestOf(body: unknown): Request {
  return new Request("http://localhost/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function analyzeRequest(images: string[] = [IMAGE]): Request {
  return requestOf({ sessionId: SESSION_ID, images });
}

/* ------------------------------------------------------------------ *
 * 대역 설정 헬퍼
 * ------------------------------------------------------------------ */

/** 사진별 추출 결과를 그대로 돌려준다. 배열에 없는 인덱스는 실패로 본다 */
function setExtract(perPhoto: (ExtractedCandidate[] | ExtractOutcome)[]): void {
  extractMock.mockImplementation(async (_image: string, options: { photoIndex: number }) => {
    const entry = perPhoto[options.photoIndex];
    if (entry === undefined) {
      return { status: "failed", reason: "upstream" } satisfies ExtractOutcome;
    }
    if (Array.isArray(entry)) {
      return { status: "ok", candidates: entry, usage: EXTRACT_USAGE } satisfies ExtractOutcome;
    }
    return entry;
  });
}

const searchOptionsSeen: { deadlineMs: number }[] = [];
const lookupOptionsSeen: { deadlineMs: number }[] = [];

/** 검색 결과를 질의별로 결정한다 */
function setSearch(resolve: (query: Query, index: number) => LookupOutcome): void {
  searchManyMock.mockImplementation(async (queries: Query[], options: { deadlineMs: number }) => {
    searchOptionsSeen.push(options);
    return queries.map((query, index) => resolve(query, index));
  });
}

/** ISBN13별 사실 조회 결과를 결정한다 */
function setFacts(resolve: (isbn13: string) => FactsOutcome): void {
  lookupFactsManyMock.mockImplementation(
    async (isbn13s: string[], options: { deadlineMs: number }) => {
      lookupOptionsSeen.push(options);
      return isbn13s.map((isbn13) => resolve(isbn13));
    },
  );
}

/** 제목이 정확히 일치하는 후보 1건을 돌려주는 기본 검색 대역 */
function searchByExactTitle(titles: readonly string[]): void {
  setSearch((query) => {
    const index = titles.indexOf(query.title);
    if (index < 0) return { status: "ok", candidates: [] };
    return { status: "ok", candidates: [candidateOf(index + 1, query.title)] };
  });
}

/** 검색이 돌려준 후보의 ISBN을 그대로 사실로 채우는 기본 사실 대역 */
function factsForAll(rating: number | null = 8.6): void {
  setFacts((isbn13) => ({
    status: "ok",
    facts: factsOf(candidateOf(Number(isbn13.slice(-3)), "알라딘 원본 제목"), rating),
  }));
}

function eventsOf(name: string): Record<string, unknown>[] {
  return logEventMock.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((event) => event.event === name);
}

beforeEach(() => {
  // 레이트 리밋 상태는 globalThis에 있어 테스트 사이에 살아남는다. 이것이 없으면
  // 이 파일의 다른 테스트들이 공유 버킷 예산을 서로 갉아먹고, 실행 순서에 따라
  // 간헐적으로 깨진다 (교차검증 F-10).
  resetRateLimit();
  vi.stubEnv("BOOK_PROOF_SECRET", "test-book-proof-secret-0123456789abcdef");
  vi.stubEnv("SERVICE_ENABLED", undefined);
  searchOptionsSeen.length = 0;
  lookupOptionsSeen.length = 0;
  logEventMock.mockImplementation(() => {});
  notesMock.mockResolvedValue({ status: "skipped", reason: "no_books" });
  setSearch(() => ({ status: "ok", candidates: [] }));
  setFacts(() => ({ status: "failed" }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ *
 * 라우트 설정 (TRD 9번)
 * ------------------------------------------------------------------ */

describe("라우트 설정", () => {
  it("maxDuration이 함수 상한 60초로 선언돼 있다", () => {
    expect(maxDuration).toBe(60);
  });
});

/* ------------------------------------------------------------------ *
 * 정상 경로
 * ------------------------------------------------------------------ */

describe("정상 경로 — 사진 2장", () => {
  /** 확인 3권 + no_match 1건 + ambiguous 1건을 만드는 공통 설정 */
  function setupMixed(): void {
    setExtract([
      [extractedOf("소년이 온다", 0), extractedOf("작별하지 않는다", 0), extractedOf("데미안", 0)],
      [extractedOf("흰", 1), extractedOf("존재하지 않는 책", 1)],
    ]);

    setSearch((query) => {
      if (query.title === "존재하지 않는 책") return { status: "ok", candidates: [] };
      if (query.title === "데미안") {
        // 유사도 0.8을 넘는 후보가 둘 — 저자를 못 읽었으므로 tie-break도 실패한다
        return {
          status: "ok",
          candidates: [candidateOf(90, "데미안"), candidateOf(91, "데미안")],
        };
      }
      const index = ["소년이 온다", "작별하지 않는다", "흰"].indexOf(query.title) + 1;
      return { status: "ok", candidates: [candidateOf(index, query.title)] };
    });

    setFacts((isbn13) => ({
      status: "ok",
      facts: factsOf(candidateOf(Number(isbn13.slice(-3)), "알라딘 원본 제목"), 9.1),
    }));

    notesMock.mockResolvedValue({
      status: "ok",
      notes: new Map([[isbnOf(1), "짧고 단단한 문장"]]),
      usage: NOTE_USAGE,
    });
  }

  it("확인 3권과 미확인 2건을 200으로 돌려주고 응답이 계약 스키마를 통과한다", async () => {
    setupMixed();

    const response = await POST(analyzeRequest([IMAGE, IMAGE]));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toMatch(/\S/);
    expect(analyzeResponseSchema.safeParse(body).success).toBe(true);

    expect(body.sessionId).toBe(SESSION_ID);
    expect(body.identified).toHaveLength(3);
    expect(body.unidentified).toHaveLength(2);
    expect(body.overflowCount).toBe(0);
    expect(body.unidentifiedOverflowCount).toBe(0);
    expect(body.failedPhotoCount).toBe(0);
    expect(body.failedPhotoIndexes).toEqual([]);
  });

  it("신원은 검색 후보를, 서지 사실은 ItemLookUp을 쓰고 한줄평이 없으면 빈 문자열로 둔다", async () => {
    setupMixed();

    const body = await (await POST(analyzeRequest([IMAGE, IMAGE]))).json();
    const first = body.identified.find((book: { isbn13: string }) => book.isbn13 === isbnOf(1));

    expect(first).toMatchObject({
      // 목업 모드에서는 ItemLookUp이 신원 필드를 만들 수 없어 검색 후보를 유지한다
      title: "소년이 온다",
      publisher: "창비",
      pages: 208,
      aladinRating: 9.1,
      claudeNote: "짧고 단단한 문장",
    });
    // 한줄평이 없는 책은 조용히 빠지지 않고 빈 문자열로 남는다
    expect(
      body.identified.filter((book: { claudeNote: string }) => book.claudeNote === ""),
    ).toHaveLength(2);
  });

  it("미확인 사유가 4종 중 정확한 값이고 candidates는 ambiguous에만 붙는다", async () => {
    setupMixed();

    const body = await (await POST(analyzeRequest([IMAGE, IMAGE]))).json();
    const byReason = Object.fromEntries(
      body.unidentified.map((book: { reason: string; candidates: unknown[] }) => [
        book.reason,
        book.candidates.length,
      ]),
    );

    expect(byReason).toEqual({ no_match: 0, ambiguous: 2 });
  });

  it("photoIndex는 그 책이 처음 등장한 사진을 가리킨다", async () => {
    setupMixed();

    const body = await (await POST(analyzeRequest([IMAGE, IMAGE]))).json();
    const white = body.identified.find((book: { title: string }) => book.title === "흰");

    expect(white.photoIndex).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 증명 동반 (ADR-006 회귀 — 삭제 금지)
 * ------------------------------------------------------------------ */

describe("확인된 책의 서버 서명 (ADR-006, FR-011)", () => {
  it("확인된 책 전원에 proof가 붙고 verifyProof를 통과한다", async () => {
    setExtract([[extractedOf("소년이 온다"), extractedOf("흰")]]);
    searchByExactTitle(["소년이 온다", "흰"]);
    factsForAll();

    const body = await (await POST(analyzeRequest())).json();

    expect(body.identified).toHaveLength(2);
    for (const book of body.identified) {
      expect(book.proof).toMatch(/\S/);
      expect(verifyProof(book, book.proof)).toEqual({ ok: true });
    }
  });

  it("다른 책의 서명을 가져다 붙이면 검증에 실패한다 — 서명 대상이 isbn13이다", async () => {
    setExtract([[extractedOf("소년이 온다"), extractedOf("흰")]]);
    searchByExactTitle(["소년이 온다", "흰"]);
    factsForAll();

    const body = await (await POST(analyzeRequest())).json();
    const [first, second] = body.identified;

    expect(verifyProof(first, second.proof)).toEqual({ ok: false, reason: "bad_signature" });
  });
});

/* ------------------------------------------------------------------ *
 * 요청 검증 — 클라이언트를 신뢰하지 않는다 (TRD 6.5)
 * ------------------------------------------------------------------ */

describe("요청 검증", () => {
  it("사진 6장이면 400 TOO_MANY_PHOTOS이고 외부 호출을 하지 않는다", async () => {
    const response = await POST(analyzeRequest(Array.from({ length: 6 }, () => IMAGE)));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("TOO_MANY_PHOTOS");
    expect(body.requestId).toBe(response.headers.get("X-Request-Id"));
    expect(extractMock).not.toHaveBeenCalled();
  });

  it("지원하지 않는 MIME이면 400 UNSUPPORTED_IMAGE_TYPE이다", async () => {
    const response = await POST(analyzeRequest(["data:image/gif;base64,AAAA"]));

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("UNSUPPORTED_IMAGE_TYPE");
    expect(extractMock).not.toHaveBeenCalled();
  });

  it("장당 2MB를 넘으면 400 IMAGE_TOO_LARGE다", async () => {
    // 상한 값을 여기 다시 적지 않는다. 상한이 바뀌면 이 픽스처도 함께 움직여야 한다.
    const huge = `data:image/jpeg;base64,${"A".repeat(MAX_OUTPUT_BYTES_PER_IMAGE)}`;

    const response = await POST(analyzeRequest([huge]));

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("IMAGE_TOO_LARGE");
    expect(extractMock).not.toHaveBeenCalled();
  });

  it("합계가 4MB를 넘으면 413 PAYLOAD_TOO_LARGE다", async () => {
    // 3장이면 합계 상한을 넘되 장당 상한에는 걸리지 않는 크기다.
    const large = `data:image/jpeg;base64,${"A".repeat(
      Math.floor(MAX_OUTPUT_BYTES_TOTAL / 3) + 1,
    )}`;

    const response = await POST(analyzeRequest([large, large, large]));

    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("PAYLOAD_TOO_LARGE");
    expect(extractMock).not.toHaveBeenCalled();
  });

  it("본문이 JSON이 아니면 400 INVALID_REQUEST다", async () => {
    const response = await POST(requestOf("{ not json"));

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_REQUEST");
  });

  it("에러 응답에 zod 원본 메시지나 필드 경로를 노출하지 않는다 (API_SPEC 에러 규약)", async () => {
    const response = await POST(analyzeRequest(["data:image/gif;base64,AAAA"]));
    const body = await response.json();

    expect(JSON.stringify(body)).not.toMatch(/images|zod|regex|invalid_string/i);
  });

  it("SERVICE_ENABLED=false면 외부 호출 없이 503 SERVICE_DISABLED다 (TRD 7번)", async () => {
    vi.stubEnv("SERVICE_ENABLED", "false");

    const response = await POST(analyzeRequest());

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("SERVICE_DISABLED");
    expect(extractMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * 상태 코드 분기 — 틀려도 초록불로 지나가는 자리다
 * ------------------------------------------------------------------ */

describe("상태 코드 분기", () => {
  it("추출 후보 자체가 0건이면 404 EMPTY_SHELF다", async () => {
    setExtract([[]]);

    const response = await POST(analyzeRequest());

    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("EMPTY_SHELF");
    expect(searchManyMock).not.toHaveBeenCalled();
  });

  it("후보는 있으나 확인 0건이면 200이고 EMPTY_SHELF가 아니다 (ADR-005 회귀 — 삭제 금지)", async () => {
    setExtract([[extractedOf("소년이 온다"), extractedOf("흰")]]);
    // 알라딘 전면 장애 — 조회 자체를 못 했다
    setSearch(() => ({ status: "failed" }));

    const response = await POST(analyzeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.identified).toEqual([]);
    expect(body.unidentified).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("EMPTY_SHELF");
    // 알라딘이 멈춘 것을 "책이 없다"로 설명하지 않는다
    expect(
      body.unidentified.every((book: { reason: string }) => book.reason === "lookup_failed"),
    ).toBe(true);
  });

  it("사진 1장만 실패하면 200이고 실패한 인덱스를 돌려준다", async () => {
    setExtract([
      { status: "failed", reason: "upstream", usage: EXTRACT_USAGE },
      [extractedOf("흰", 1)],
    ]);
    searchByExactTitle(["흰"]);
    factsForAll();

    const response = await POST(analyzeRequest([IMAGE, IMAGE]));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.failedPhotoCount).toBe(1);
    expect(body.failedPhotoIndexes).toEqual([0]);
    expect(body.identified).toHaveLength(1);
  });

  it("전 사진의 추출이 실패하면 502 UPSTREAM_UNAVAILABLE이다", async () => {
    setExtract([
      { status: "failed", reason: "upstream" },
      { status: "failed", reason: "timeout" },
    ]);

    const response = await POST(analyzeRequest([IMAGE, IMAGE]));

    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe("UPSTREAM_UNAVAILABLE");
    expect(searchManyMock).not.toHaveBeenCalled();
    expect(eventsOf("analyze_failed")[0]).toMatchObject({
      error_code: "UPSTREAM_UNAVAILABLE",
      failed_photo_count: 2,
    });
  });
});

/* ------------------------------------------------------------------ *
 * 사유 보존 (ADR-005 회귀 — 삭제 금지)
 * ------------------------------------------------------------------ */

describe("미확인 사유를 뭉개지 않는다 (ADR-005)", () => {
  it("알라딘 검색이 5xx로 실패한 책은 no_match가 아니라 lookup_failed다", async () => {
    setExtract([[extractedOf("소년이 온다"), extractedOf("없는 책")]]);
    setSearch((query) =>
      query.title === "소년이 온다"
        ? { status: "failed" } // 5xx·타임아웃
        : { status: "ok", candidates: [] }, // 알라딘에 정말 없음
    );

    const body = await (await POST(analyzeRequest())).json();
    const reasons = Object.fromEntries(
      body.unidentified.map((book: { rawText: string; reason: string }) => [
        book.rawText,
        book.reason,
      ]),
    );

    expect(reasons["소년이 온다"]).toBe("lookup_failed");
    expect(reasons["없는 책"]).toBe("no_match");
  });

  it("검색은 됐지만 사실 조회가 실패한 책도 lookup_failed이며 확인으로 올리지 않는다", async () => {
    setExtract([[extractedOf("소년이 온다")]]);
    searchByExactTitle(["소년이 온다"]);
    setFacts(() => ({ status: "failed" }));

    const response = await POST(analyzeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.identified).toEqual([]);
    expect(body.unidentified).toEqual([
      { rawText: "소년이 온다", reason: "lookup_failed", candidates: [] },
    ]);
  });

  it("확신도가 낮아 조회조차 하지 않은 후보는 unreadable이다 — 조회 실패로 설명하지 않는다", async () => {
    setExtract([[extractedOf("흐릿한 제목", 0, { confidence: 0.1 })]]);

    const body = await (await POST(analyzeRequest())).json();

    expect(body.unidentified).toEqual([
      { rawText: "흐릿한 제목", reason: "unreadable", candidates: [] },
    ]);
    expect(searchManyMock).toHaveBeenCalledWith([], expect.anything());
  });
});

/* ------------------------------------------------------------------ *
 * 시간 예산 (TRD 7번, ADR-005)
 * ------------------------------------------------------------------ */

describe("시간 예산과 데드라인 전파", () => {
  it("각 단계에 min(단계 예산, 남은 예산)을 넘긴다", async () => {
    setExtract([[extractedOf("소년이 온다")]]);
    searchByExactTitle(["소년이 온다"]);
    factsForAll();

    await POST(analyzeRequest());

    expect(extractMock).toHaveBeenCalledWith(
      IMAGE,
      expect.objectContaining({ deadlineMs: STAGE_BUDGET_MS.extract, photoIndex: 0 }),
    );
    expect(searchOptionsSeen[0].deadlineMs).toBeLessThanOrEqual(STAGE_BUDGET_MS.lookup);
    expect(searchOptionsSeen[0].deadlineMs).toBeGreaterThan(0);
    // 대조 단계의 두 호출은 하나의 예산을 나눠 쓴다 — 각자 12s를 잡으면 총 예산이 깨진다
    expect(lookupOptionsSeen[0].deadlineMs).toBeLessThanOrEqual(searchOptionsSeen[0].deadlineMs);
  });

  it("대조 예산을 다 쓰면 잔여 후보를 lookup_failed로 강등하고 200으로 끝낸다", async () => {
    vi.useFakeTimers();
    extractMock.mockImplementation(async () => {
      // 추출이 예산을 거의 다 썼다
      vi.advanceTimersByTime(TOTAL_BUDGET_MS - 1_000);
      return { status: "ok", candidates: [extractedOf("소년이 온다")], usage: EXTRACT_USAGE };
    });
    // 남은 데드라인이 없으면 서비스는 호출 없이 failed를 돌려준다 (services/aladin 규약)
    setSearch(() => ({ status: "failed" }));

    const response = await POST(analyzeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(searchOptionsSeen[0].deadlineMs).toBeLessThanOrEqual(1_000);
    expect(body.unidentified).toEqual([
      { rawText: "소년이 온다", reason: "lookup_failed", candidates: [] },
    ]);
  });

  it("남은 예산이 8s 미만이면 한줄평을 호출조차 하지 않고 claudeNote를 비운다", async () => {
    vi.useFakeTimers();
    extractMock.mockImplementation(async () => {
      // 남은 예산 7s — 단계 예산 8s보다 적다
      vi.advanceTimersByTime(TOTAL_BUDGET_MS - 7_000);
      return { status: "ok", candidates: [extractedOf("소년이 온다")], usage: EXTRACT_USAGE };
    });
    searchByExactTitle(["소년이 온다"]);
    factsForAll();

    const response = await POST(analyzeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(notesMock).not.toHaveBeenCalled();
    expect(body.identified).toHaveLength(1);
    expect(body.identified[0].claudeNote).toBe("");
  });

  it("한줄평 생성이 실패해도 책 목록은 그대로 나가고 200이다", async () => {
    setExtract([[extractedOf("소년이 온다")]]);
    searchByExactTitle(["소년이 온다"]);
    factsForAll();
    notesMock.mockResolvedValue({ status: "failed", reason: "refusal", usage: NOTE_USAGE });

    const response = await POST(analyzeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.identified[0].claudeNote).toBe("");
  });
});

/* ------------------------------------------------------------------ *
 * 상한과 중복 제거 (FR-004·FR-005, TR-005)
 * ------------------------------------------------------------------ */

describe("상한과 중복 제거", () => {
  it("확인된 책이 51권이면 50권만 남기고 절단 순서가 결정적이다", async () => {
    const titles = Array.from(
      { length: 51 },
      (_, index) => `책${String(index + 1).padStart(3, "0")}`,
    );
    setExtract([titles.map((title) => extractedOf(title))]);
    searchByExactTitle(titles);
    // 평점이 전부 null이면 photoIndex → isbn13 오름차순이 순서를 결정한다
    factsForAll(null);

    const body = await (await POST(analyzeRequest())).json();

    expect(body.identified).toHaveLength(MAX_IDENTIFIED_BOOKS);
    expect(body.overflowCount).toBe(1);
    expect(body.identified.map((book: { isbn13: string }) => book.isbn13)).toEqual(
      Array.from({ length: 50 }, (_, index) => isbnOf(index + 1)),
    );
  });

  it("평점이 높은 책이 먼저 남는다 — null은 최하위다", async () => {
    const titles = ["책001", "책002", "책003"];
    setExtract([titles.map((title) => extractedOf(title))]);
    searchByExactTitle(titles);
    setFacts((isbn13) => {
      const rating: Record<string, number | null> = {
        [isbnOf(1)]: null,
        [isbnOf(2)]: 7.2,
        [isbnOf(3)]: 9.4,
      };
      return {
        status: "ok",
        facts: factsOf(candidateOf(Number(isbn13.slice(-3)), "제목"), rating[isbn13] ?? null),
      };
    });

    const body = await (await POST(analyzeRequest())).json();

    expect(body.identified.map((book: { isbn13: string }) => book.isbn13)).toEqual([
      isbnOf(3),
      isbnOf(2),
      isbnOf(1),
    ]);
  });

  it("미확인이 101건이면 100건만 남기고 넘친 개수를 센다", async () => {
    const titles = Array.from(
      { length: 101 },
      (_, index) => `미확인${String(index + 1).padStart(3, "0")}`,
    );
    setExtract([titles.map((title, index) => extractedOf(title, index % 5))]);
    setSearch(() => ({ status: "ok", candidates: [] }));

    const body = await (await POST(analyzeRequest())).json();

    expect(body.identified).toEqual([]);
    expect(body.unidentified).toHaveLength(MAX_UNIDENTIFIED_BOOKS);
    expect(body.unidentifiedOverflowCount).toBe(1);
  });

  it("같은 책이 여러 사진에 등장해도 1권이고 알라딘 검색도 1회다 (FR-004, TR-005)", async () => {
    setExtract([[extractedOf("소년이 온다", 0)], [extractedOf("소년이 온다", 1)]]);
    searchByExactTitle(["소년이 온다"]);
    factsForAll();

    const body = await (await POST(analyzeRequest([IMAGE, IMAGE]))).json();

    expect(body.identified).toHaveLength(1);
    expect(body.identified[0].photoIndex).toBe(0);
    expect(searchManyMock.mock.calls[0][0]).toHaveLength(1);
  });

  it("서로 다른 후보가 같은 ISBN13으로 확인되면 한 권으로 합치고 사실 조회도 한 번만 한다", async () => {
    setExtract([
      [extractedOf("소년이 온다", 1, { author: "한강" })],
      [extractedOf("소년이 온다", 0)],
    ]);
    setSearch(() => ({ status: "ok", candidates: [candidateOf(1, "소년이 온다")] }));
    factsForAll();

    const body = await (await POST(analyzeRequest([IMAGE, IMAGE]))).json();

    // 저자 유무가 달라 사전 병합은 되지 않지만, 같은 ISBN이므로 결과는 1권이다
    expect(searchManyMock.mock.calls[0][0]).toHaveLength(2);
    expect(lookupFactsManyMock.mock.calls[0][0]).toEqual([isbnOf(1)]);
    expect(body.identified).toHaveLength(1);
    expect(body.identified[0].photoIndex).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 알라딘 호출량 — 선언이 아니라 실행 경로에서 잰다 (TR-005, TRD 10번)
 *
 * `merge.test.ts`는 상수들의 관계를 잠그고, 여기서는 **라우트가 실제로 두 서비스에
 * 넘긴 배열의 길이**를 잰다. 그 둘이 갈리면 선언은 260을 통과하는 동안 실행 경로가
 * 320을 내는 상태가 되고, 상한은 검증되지 않은 상한으로 돌아간다.
 *
 * `fetchImpl` 호출 횟수는 세지 않는다 — 이 파일은 `searchMany`·`lookupFactsMany`를
 * 통째로 모킹하고 `route.ts`는 fetch 구현을 넘기지 않으므로 셀 수 있는 값이 아니다.
 * 셀 수 있는 것은 두 단계가 받은 배열의 길이이고, 호출 수는 거기서 유도된다.
 * ------------------------------------------------------------------ */

describe("알라딘 호출 상한 (TR-005 — 검색한 것이 전부 조회된다)", () => {
  /** 상한보다 확실히 많은 후보. 상한을 올려도 이 픽스처가 함께 커져 여전히 넘친다 */
  const OVER_CAP = MAX_CANDIDATES_FOR_LOOKUP * 3;

  function titlesOver(count: number): string[] {
    return Array.from({ length: count }, (_, index) => `책${String(index + 1).padStart(3, "0")}`);
  }

  it("ItemSearch와 ItemLookUp이 같은 수를 받고 둘 다 조회 상한 이하다", async () => {
    const titles = titlesOver(OVER_CAP);
    setExtract([titles.map((title) => extractedOf(title))]);
    // 검색한 후보가 **전부** 승격되는 최악의 경우다. 조회 단계가 가장 많이 받는다.
    searchByExactTitle(titles);
    factsForAll();

    await POST(analyzeRequest());

    const searched = searchManyMock.mock.calls[0][0] as unknown[];
    const looked = lookupFactsManyMock.mock.calls[0][0] as unknown[];

    expect(searched).toHaveLength(MAX_CANDIDATES_FOR_LOOKUP);
    // 승격은 검색을 통과한 것에서만 나온다. 조회가 검색보다 많아지는 경로는 없다.
    expect(looked.length).toBeLessThanOrEqual(searched.length);
    expect(looked.length).toBeLessThanOrEqual(MAX_CANDIDATES_FOR_LOOKUP);
    // 전량 승격이므로 두 단계가 정확히 같은 수를 태운다 — 이것이 유도식의 `× 2단계`다.
    expect(looked).toHaveLength(MAX_CANDIDATES_FOR_LOOKUP);
    // 실측한 두 단계의 합이 세션 상한 안이다. 선언이 아니라 실행 경로에서 잰 값이다.
    expect((searched.length + looked.length) * ALADIN_CALLS_PER_LOOKUP).toBeLessThanOrEqual(
      MAX_ALADIN_CALLS_PER_SESSION,
    );
  });

  it("상한에 밀린 후보는 조용히 사라지지 않고 unreadable로 응답에 남는다 (FR-012)", async () => {
    // 밀린 수를 미확인 상한보다 훨씬 작게 잡는다 — 여기서 보려는 것은 조회 상한의
    // 절단이지 미확인 절단이 아니다.
    const PUSHED_OUT = 10;
    const titles = titlesOver(MAX_CANDIDATES_FOR_LOOKUP + PUSHED_OUT);
    setExtract([titles.map((title) => extractedOf(title))]);
    searchByExactTitle(titles);
    factsForAll();

    const body = await (await POST(analyzeRequest())).json();

    expect(searchManyMock.mock.calls[0][0]).toHaveLength(MAX_CANDIDATES_FOR_LOOKUP);
    // 밀린 것은 "알라딘에 없다"가 아니다. 조회조차 하지 않았으므로 unreadable이다.
    expect(body.unidentified).toHaveLength(PUSHED_OUT);
    expect(
      body.unidentified.every((book: { reason: string }) => book.reason === "unreadable"),
    ).toBe(true);
    // 미확인 상한에는 닿지 않았으므로 넘친 개수도 0이다 — 두 절단이 섞이지 않았다.
    expect(body.unidentifiedOverflowCount).toBe(0);
    expect(MAX_UNIDENTIFIED_BOOKS).toBeGreaterThan(PUSHED_OUT);
  });
});

/* ------------------------------------------------------------------ *
 * 관측성 (TR-012, PRD 7번)
 * ------------------------------------------------------------------ */

describe("이벤트 로그", () => {
  it("photo_uploaded와 analyze_completed를 남기고 토큰을 전부 합산한다", async () => {
    setExtract([[extractedOf("소년이 온다")], [extractedOf("흰", 1)]]);
    searchByExactTitle(["소년이 온다", "흰"]);
    factsForAll();
    notesMock.mockResolvedValue({ status: "ok", notes: new Map(), usage: NOTE_USAGE });

    await POST(analyzeRequest([IMAGE, IMAGE]));

    expect(eventsOf("photo_uploaded")[0]).toEqual({
      event: "photo_uploaded",
      session_id: SESSION_ID,
      photo_count: 2,
    });
    expect(eventsOf("analyze_completed")[0]).toMatchObject({
      session_id: SESSION_ID,
      identified_count: 2,
      unidentified_count: 0,
      unidentified_by_reason: { unreadable: 0, no_match: 0, ambiguous: 0, lookup_failed: 0 },
      overflow_count: 0,
      failed_photo_count: 0,
      input_tokens: EXTRACT_USAGE.input_tokens * 2 + NOTE_USAGE.input_tokens,
      output_tokens: EXTRACT_USAGE.output_tokens * 2 + NOTE_USAGE.output_tokens,
    });
  });

  it("응답이 돌아온 실패의 토큰도 합산한다 — 실패해도 과금됐다", async () => {
    setExtract([
      { status: "failed", reason: "refusal", usage: EXTRACT_USAGE },
      [extractedOf("흰", 1)],
    ]);
    searchByExactTitle(["흰"]);
    factsForAll();
    notesMock.mockResolvedValue({ status: "failed", reason: "max_tokens", usage: NOTE_USAGE });

    await POST(analyzeRequest([IMAGE, IMAGE]));

    expect(eventsOf("analyze_completed")[0]).toMatchObject({
      input_tokens: EXTRACT_USAGE.input_tokens * 2 + NOTE_USAGE.input_tokens,
      failed_photo_count: 1,
    });
  });

  it("미확인을 사유별로 나눠 센다 (lookup_failed를 가드레일 분자에서 빼기 위해)", async () => {
    setExtract([
      [
        extractedOf("흐릿", 0, { confidence: 0.1 }),
        extractedOf("없는 책"),
        extractedOf("장애 난 책"),
      ],
    ]);
    setSearch((query) =>
      query.title === "장애 난 책" ? { status: "failed" } : { status: "ok", candidates: [] },
    );

    await POST(analyzeRequest());

    expect(eventsOf("analyze_completed")[0]).toMatchObject({
      unidentified_count: 3,
      unidentified_by_reason: { unreadable: 1, no_match: 1, ambiguous: 0, lookup_failed: 1 },
    });
  });

  it("이미지 base64와 판독 원문을 로그에 남기지 않는다 (PRD 7번)", async () => {
    setExtract([[extractedOf("우리집책장_사생활이_섞인_원문")]]);
    setSearch(() => ({ status: "ok", candidates: [] }));

    await POST(analyzeRequest());

    const logged = JSON.stringify(logEventMock.mock.calls);
    expect(logged).not.toContain("우리집책장_사생활이_섞인_원문");
    expect(logged).not.toContain("base64");
  });

  it("로깅이 던져도 응답은 200으로 나간다 (TR-012)", async () => {
    setExtract([[extractedOf("소년이 온다")]]);
    searchByExactTitle(["소년이 온다"]);
    factsForAll();
    logEventMock.mockImplementation(() => {
      throw new Error("로그 채널이 죽었다");
    });

    const response = await POST(analyzeRequest());

    expect(response.status).toBe(200);
    expect((await response.json()).identified).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 가드레일 계측 — 응답과 갈라 센다 (ADR-005 · 05 델타)
 *
 * 이 런이 가르는 것은 **계측뿐**이다. 응답 `reason`은 여전히 4종이고 화면 매핑도
 * 그대로다. 그래서 여기서 재야 하는 것이 셋이다.
 * 1. `analyze_completed`의 raw_ 넷이 표시 상한 절단 **전**의 수를 담는가
 * 2. 그 계측이 생겼는데도 응답의 사유 분포가 **한 칸도 움직이지 않았는가**
 * 3. 분자와 분모가 **같은 모집단**을 세는가 (05 델타 ①)
 *
 * 2번을 직접 단언하는 이유: 라우트가 `"unreadable"` 리터럴을 지우고
 * `RESPONSE_REASON[measured]` 유도로 바꾸는 것이 이 런의 변경이다. 유도가 한
 * 군데라도 어긋나면 화면 문구가 소리 없이 바뀌는데, 응답 스키마는 4종 안의
 * 값이기만 하면 통과시키므로 스키마가 그것을 잡지 못한다.
 *
 * 3번이 여기 있는 이유: `analytics.test.ts`는 `logEvent`의 투영만 볼 수 있어
 * 픽스처가 스스로 적은 숫자를 되읽을 뿐이다. 분자와 분모의 관계는 파이프라인을
 * 실제로 돌리는 이 파일에서만 재진다.
 * ------------------------------------------------------------------ */

describe("미확인 계측을 응답과 갈라 센다 (raw_ 넷)", () => {
  function 유일한_완료이벤트(): Record<string, unknown> {
    const events = eventsOf("analyze_completed");
    expect(events).toHaveLength(1);
    return events[0];
  }

  function 사유별_계측(event: Record<string, unknown>): Record<string, number> {
    return event.raw_unidentified_by_measurement as Record<string, number>;
  }

  /** 응답에 실제로 실린 사유 분포. 응답 어휘가 움직이면 여기서 곧바로 드러난다 */
  function 응답_사유_분포(unidentified: { reason: string }[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const book of unidentified) counts[book.reason] = (counts[book.reason] ?? 0) + 1;
    return counts;
  }

  /** 계측에만 있고 응답에는 없어야 하는 이름들. 하나라도 새면 화면 매핑이 못 읽는다 */
  const 계측_전용_어휘 = [
    "low_confidence",
    "lookup_capped",
    "blank_title",
    "search_failed",
    "facts_failed",
  ];

  const 상한_초과분 = 10;

  /** 조회 상한에 밀린 것 말고는 미확인이 하나도 나오지 않는 세션 */
  function 밀린_후보만(): void {
    const titles = Array.from(
      { length: MAX_CANDIDATES_FOR_LOOKUP + 상한_초과분 },
      (_, index) => `책${String(index + 1).padStart(3, "0")}`,
    );
    setExtract([titles.map((title) => extractedOf(title))]);
    searchByExactTitle(titles);
    factsForAll();
  }

  it("밀린 후보만 있으면 가드레일 분자가 0이고 상한 강등분이 그 수와 같다", async () => {
    밀린_후보만();

    const body = await (await POST(analyzeRequest())).json();

    // 화면에는 전부 unreadable로 보인다 — 상한은 우리가 건 것이지 알라딘의 답이 아니다.
    expect(응답_사유_분포(body.unidentified)).toEqual({ unreadable: 상한_초과분 });
    // 그런데 가드레일 분자는 0이다. 여기에 상한 강등분이 들어가면 사진을 많이
    // 올릴수록 프롬프트 품질이 떨어진 것처럼 보여 엉뚱한 롤백을 부른다.
    expect(유일한_완료이벤트()).toMatchObject({ raw_unidentified_guardrail_count: 0 });
    expect(사유별_계측(유일한_완료이벤트()).lookup_capped).toBe(상한_초과분);
  });

  it("분모가 밀린 후보를 세지 않는다 — 확인된 책 수와 같다 (05 델타 ①)", async () => {
    밀린_후보만();

    const body = await (await POST(analyzeRequest())).json();
    const event = 유일한_완료이벤트();

    // 조회한 65건이 전부 확인됐고 밀린 10건은 판정된 적이 없다. 그 10건이 분모에
    // 남으면 비율이 희석돼, 사진을 많이 올릴수록 성적이 좋아진다.
    expect(event.raw_guardrail_denominator).toBe(MAX_CANDIDATES_FOR_LOOKUP);
    expect(event.raw_candidate_count).toBe(MAX_CANDIDATES_FOR_LOOKUP + 상한_초과분);
    // 두 값은 서로 다르다 — 관측용 총수를 분모로 쓰면 안 된다는 것이 델타의 요지다.
    expect(event.raw_guardrail_denominator).not.toBe(event.raw_candidate_count);
    // 절단 전 수다. 표시된 확인 50권보다 크다.
    expect(event.raw_guardrail_denominator as number).toBeGreaterThan(body.identified.length);
  });

  it("표시 상한 절단이 일어나도 raw_candidate_count가 줄지 않는다", async () => {
    밀린_후보만();

    const body = await (await POST(analyzeRequest())).json();
    const event = 유일한_완료이벤트();

    // 절단이 실제로 발생한 세션이다 — 이것이 전제되지 않으면 아래가 공허하다.
    expect(body.identified).toHaveLength(MAX_IDENTIFIED_BOOKS);
    expect(body.overflowCount).toBeGreaterThan(0);

    const 표시된_합 = body.identified.length + body.unidentified.length;
    expect(event.raw_candidate_count).toBe(MAX_CANDIDATES_FOR_LOOKUP + 상한_초과분);
    expect(event.raw_candidate_count as number).toBeGreaterThan(표시된_합);
    expect(event.identified_count).toBe(MAX_IDENTIFIED_BOOKS);
    expect(event.unidentified_count).toBe(body.unidentified.length);
  });

  it("raw_candidate_count는 추출 총수가 아니다 — 조회 전 병합이 먼저 건수를 줄인다", async () => {
    // 같은 책이 사진 둘에 찍혔다. 조회 전 사전 병합이 이 둘을 한 건으로 만들므로
    // **절단 전 관측 총수조차 추출 후보 수보다 작다.** 이 값을 "추출 후보 전량"
    // 이라 부르면 거짓이고, 그렇게 이름 붙인 채 분모로 쓰면 "몇 권을 다뤘는가"와
    // "몇 판정을 했는가"를 뒤섞게 된다.
    setExtract([
      [extractedOf("소년이 온다", 0, { author: "한강" }), extractedOf("흰", 0)],
      [extractedOf("소년이온다", 1, { author: "한강 (지은이)" })],
    ]);
    searchByExactTitle(["소년이 온다", "흰"]);
    factsForAll();

    const 추출_총수 = 3;
    const body = await (await POST(analyzeRequest([IMAGE, IMAGE]))).json();
    const event = 유일한_완료이벤트();

    // 병합이 실제로 일어났다는 것을 조회에 태운 수로 확인한다.
    expect(searchManyMock.mock.calls[0][0]).toHaveLength(2);
    expect(body.identified).toHaveLength(2);
    expect(body.unidentified).toEqual([]);
    expect(event.raw_candidate_count).toBe(2);
    expect(event.raw_candidate_count as number).toBeLessThan(추출_총수);
  });

  /* --- 분모의 존재 이유 — 리뷰어의 반례 (05 델타 ①) ----------------- */

  it("알라딘 전면 장애 세션은 분모가 0이라 비율을 내지 않는다 — 0%가 아니다", async () => {
    setExtract([[extractedOf("소년이 온다"), extractedOf("흰"), extractedOf("데미안")]]);
    setSearch(() => ({ status: "failed" }));

    const body = await (await POST(analyzeRequest())).json();
    const event = 유일한_완료이벤트();

    expect(body.identified).toEqual([]);
    expect(응답_사유_분포(body.unidentified)).toEqual({ lookup_failed: 3 });

    const 분자 = event.raw_unidentified_guardrail_count as number;
    // 옛 분모(관측용 총수)로 나누면 0/3 = 0% — 알라딘이 통째로 죽은 세션이
    // **가장 좋은 성적**을 낸다. 이것이 리뷰어가 든 반례다.
    expect(event.raw_candidate_count).toBe(3);
    expect(분자 / (event.raw_candidate_count as number)).toBe(0);
    // 새 분모는 0이다. 판정을 하나도 받지 못한 세션은 좋은 성적을 받는 것이
    // 아니라 **모집단에서 빠진다** — 비율 자체가 계산되지 않는다.
    expect(event.raw_guardrail_denominator).toBe(0);
    expect(Number.isNaN(분자 / (event.raw_guardrail_denominator as number))).toBe(true);
  });

  it("조회하지 못한 책이 분모를 희석하지 않는다 — 판정 실패율이 그대로 나온다", async () => {
    const 장애 = Array.from({ length: 8 }, (_, index) => `장애${index}`);
    const 없는책 = ["없는책1", "없는책2"];
    setExtract([[...장애, ...없는책].map((title) => extractedOf(title))]);
    setSearch((query) =>
      장애.includes(query.title) ? { status: "failed" } : { status: "ok", candidates: [] },
    );

    const body = await (await POST(analyzeRequest())).json();
    const event = 유일한_완료이벤트();
    const 분자 = event.raw_unidentified_guardrail_count as number;

    expect(body.identified).toEqual([]);
    expect(응답_사유_분포(body.unidentified)).toEqual({ lookup_failed: 8, no_match: 2 });

    // 실제로 판정을 받은 것은 둘뿐이고 둘 다 실패했다 — 판정 실패율 100%다.
    expect(분자).toBe(2);
    expect(event.raw_guardrail_denominator).toBe(2);
    expect(분자 / (event.raw_guardrail_denominator as number)).toBe(1);
    // 옛 분모로는 20%였다. 조회조차 못 한 여덟 건이 실패율을 5분의 1로 희석한다.
    expect(분자 / (event.raw_candidate_count as number)).toBe(0.2);
  });

  /* --- 계측에서만 중복을 접는다 (05 델타 ②) ------------------------- */

  it("같은 mergeKey를 가진 저확신 항목 다섯이면 분자에 1만 더한다", async () => {
    // 정규화하면 제목·저자가 전부 같은 판독본 다섯이다. 확신도 미달은 사전 병합
    // **전에** 강등되므로 응답에는 다섯 장이 그대로 남는다.
    const 같은_책 = [
      { title: "82년생 김지영", author: "조남주" },
      { title: "82년생김지영", author: "조남주 (지은이)" },
      { title: "82년생 김지영!", author: "조남주" },
      { title: "82년생  김지영", author: "조남주 (지은이)" },
      { title: "(양장) 82년생 김지영", author: "조남주" },
    ];
    setExtract([
      같은_책.map((책) => extractedOf(책.title, 0, { author: 책.author, confidence: 0.1 })),
    ]);

    const body = await (await POST(analyzeRequest())).json();
    const event = 유일한_완료이벤트();

    // 같은 책이 다섯 장에 흐릿하게 찍혔을 뿐인데 분자가 5 오르면, 또렷하게 읽혀
    // 분모에 1만 더하는 같은 책과 **단위가 달라진다** — 이 런이 막겠다고 선언한
    // 오독과 같은 방향이다.
    expect(event.raw_unidentified_guardrail_count).toBe(1);
    expect(event.raw_guardrail_denominator).toBe(1);
    expect(사유별_계측(event).low_confidence).toBe(1);
  });

  it("접는 것은 세는 자리뿐이다 — 응답에는 다섯 장이 전부 남는다", async () => {
    const 같은_책 = [
      { title: "82년생 김지영", author: "조남주" },
      { title: "82년생김지영", author: "조남주 (지은이)" },
      { title: "82년생 김지영!", author: "조남주" },
      { title: "82년생  김지영", author: "조남주 (지은이)" },
      { title: "(양장) 82년생 김지영", author: "조남주" },
    ];
    setExtract([
      같은_책.map((책) => extractedOf(책.title, 0, { author: 책.author, confidence: 0.1 })),
    ]);

    const body = await (await POST(analyzeRequest())).json();

    // 계측을 고치겠다고 응답 목록까지 접으면 사용자 화면에서 카드가 사라진다.
    // "왜 빠졌는지 보여준다"는 원칙(ADR-002)은 계측 사정과 무관하다.
    expect(body.unidentified).toHaveLength(같은_책.length);
    expect(응답_사유_분포(body.unidentified)).toEqual({ unreadable: 같은_책.length });
    expect(new Set(body.unidentified.map((book: { rawText: string }) => book.rawText)).size).toBe(
      같은_책.length,
    );
  });

  /* --- 계측 사유가 골고루 나오는 세션 -------------------------------- */

  const 상한에_밀릴_수 = 3;
  const 흐릿한_후보_수 = 2;
  const 판정_실패_수 = 4;
  const 확인된_책_수 = MAX_CANDIDATES_FOR_LOOKUP - 판정_실패_수;
  const 총_후보_수 = MAX_CANDIDATES_FOR_LOOKUP + 상한에_밀릴_수 + 흐릿한_후보_수;
  // 확신도 미달 둘 + no_match 하나 + ambiguous 하나. 이름을 `분자`로 두면 위
  // 두 테스트의 지역 변수를 가려 읽는 사람이 어느 쪽인지 헷갈린다.
  const 분자_기대값 = 흐릿한_후보_수 + 2;

  /**
   * 계측 사유 여섯이 한 세션에 섞이게 만든다. 판독본의 `mergeKey`가 전부 달라
   * 접힘은 일어나지 않는다 — 접힘은 바로 위 두 테스트가 따로 본다.
   * - `low_confidence` : 확신도 0.1인 후보 둘
   * - `lookup_capped`  : 조회 상한에 밀린 후보 셋
   * - `search_failed`  : ItemSearch 응답을 확보하지 못한 책 하나
   * - `no_match`       : 알라딘에 정말 없는 책 하나
   * - `ambiguous`      : 유사 후보가 둘인 책 하나
   * - `facts_failed`   : 검색은 됐는데 ItemLookUp 응답을 확보하지 못한 책 하나
   */
  function 뒤섞인_세션(): void {
    const 또렷 = Array.from(
      { length: MAX_CANDIDATES_FOR_LOOKUP + 상한에_밀릴_수 },
      (_, index) => `책${String(index + 1).padStart(3, "0")}`,
    );

    setExtract([
      [
        ...또렷.map((title) => extractedOf(title)),
        ...Array.from({ length: 흐릿한_후보_수 }, (_, index) =>
          extractedOf(`흐릿 ${index}`, 0, { confidence: 0.1 }),
        ),
      ],
    ]);

    setSearch((query) => {
      if (query.title === "책001") return { status: "failed" };
      if (query.title === "책002") return { status: "ok", candidates: [] };
      if (query.title === "책003") {
        // 저자를 읽지 못했으므로 tie-break도 실패해 ambiguous로 내려간다
        return {
          status: "ok",
          candidates: [candidateOf(903, "책003"), candidateOf(904, "책003")],
        };
      }
      const index = 또렷.indexOf(query.title);
      return { status: "ok", candidates: [candidateOf(index + 1, query.title)] };
    });

    setFacts((isbn13) =>
      isbn13 === isbnOf(4)
        ? { status: "failed" }
        : {
            status: "ok",
            facts: factsOf(candidateOf(Number(isbn13.slice(-3)), "알라딘 원본 제목")),
          },
    );
  }

  it("응답의 사유 분포는 이 런 전후로 동일하다 — 접힘 결과가 옛 리터럴과 같다", async () => {
    뒤섞인_세션();

    const body = await (await POST(analyzeRequest())).json();

    // 옛 코드는 `unreadable` 바구니 전체에 문자열 "unreadable"을 직접 박았고,
    // 그 바구니에는 확신도 미달과 상한 밀림이 함께 들어 있었다. 새 코드는 둘을
    // 갈라 계측한 뒤 `RESPONSE_REASON`으로 다시 접는다 — 그래서 이 분포는
    // **바뀌지 않아야 한다.** 숫자를 유도식이 아니라 그대로 적는 이유는, 여기서
    // 재려는 것이 "옛 값과 같은가"이지 "새 계산이 자기 자신과 맞는가"가 아니기
    // 때문이다.
    expect(응답_사유_분포(body.unidentified)).toEqual({
      unreadable: 상한에_밀릴_수 + 흐릿한_후보_수,
      no_match: 1,
      ambiguous: 1,
      lookup_failed: 2,
    });
  });

  it("응답에는 응답 어휘 4종만 나가고 계측 어휘는 한 글자도 새지 않는다", async () => {
    뒤섞인_세션();

    const response = await POST(analyzeRequest());
    const body = await response.json();

    expect(analyzeResponseSchema.safeParse(body).success).toBe(true);
    for (const reason of Object.keys(응답_사유_분포(body.unidentified))) {
      expect(unidentifiedReasonSchema.options).toContain(reason);
    }
    // 스키마는 4종 안의 값이기만 하면 통과시키므로 어휘 유출은 따로 본다.
    for (const name of 계측_전용_어휘) {
      expect(JSON.stringify(body)).not.toContain(name);
    }
  });

  it("사유별 계측이 일곱 칸이고 그 합이 (접은) 미확인 총수와 맞는다", async () => {
    뒤섞인_세션();

    const body = await (await POST(analyzeRequest())).json();
    const by = 사유별_계측(유일한_완료이벤트());

    // 칸 목록을 여기 다시 적지 않는다 — 접힘 매핑의 키가 정본이다.
    expect(Object.keys(by).sort()).toEqual(Object.keys(RESPONSE_REASON).sort());
    // 일곱을 갈라 놓고 집계 둘만 내보내면 `search_failed`와 `facts_failed`를 서로
    // 바꿔 배정해도 어떤 검사도 실패하지 않는다. 그래서 칸마다 값을 못 박는다.
    expect(by).toEqual({
      low_confidence: 흐릿한_후보_수,
      lookup_capped: 상한에_밀릴_수,
      blank_title: 0,
      no_match: 1,
      ambiguous: 1,
      search_failed: 1,
      facts_failed: 1,
    });
    // 판독본의 mergeKey가 전부 다르므로 접힘이 없다 — 합이 곧 응답 카드 수다.
    const 합 = Object.values(by).reduce((sum, n) => sum + n, 0);
    expect(합).toBe(body.unidentified.length);
  });

  it("분자는 조회하지 못한 책을 빼고 세고, 분모는 확인된 책을 더해 센다", async () => {
    뒤섞인_세션();

    const body = await (await POST(analyzeRequest())).json();
    const event = 유일한_완료이벤트();

    // 분자 = 확신도 미달 둘 + no_match 하나 + ambiguous 하나.
    // 상한에 밀린 셋과 조회 실패 둘은 들어가지 않는다.
    expect(event.raw_unidentified_guardrail_count).toBe(분자_기대값);
    // 분모 = 확인된 책(절단 전) + 분자. 두 값의 차가 확인된 책 수를 되돌려 준다.
    expect(event.raw_guardrail_denominator).toBe(확인된_책_수 + 분자_기대값);
    expect(
      (event.raw_guardrail_denominator as number) -
        (event.raw_unidentified_guardrail_count as number),
    ).toBe(확인된_책_수);
    // 절단 전 확인 수(61)는 화면에 남은 수(50)보다 크다 — 분모가 절단을 따라가지 않는다.
    expect(확인된_책_수).toBeGreaterThan(body.identified.length);

    // 관측용 총수는 분모보다 크다. 둘을 나누면 안 되는 이유가 이 차이다.
    expect(event.raw_candidate_count).toBe(총_후보_수);
    expect(event.raw_candidate_count as number).toBeGreaterThan(
      event.raw_guardrail_denominator as number,
    );
  });

  it("제목이 기호뿐이라 판독이 무너진 후보는 unreadable이지만 분자에는 든다", async () => {
    // 상한 강등분과 **같은 응답 사유**를 갖는데 계측은 반대다. 이 대비가 이
    // 계약의 전부다 — 응답 한 칸(unreadable) 뒤에 성격이 다른 기전이 셋 있고,
    // 그중 하나만 우리가 스스로 건 제한이다.
    setExtract([[extractedOf("!!!")]]);

    const body = await (await POST(analyzeRequest())).json();
    const event = 유일한_완료이벤트();

    // 이 단언들은 접힘 규칙 재설계 **전후로 똑같이 통과한다.** 그런데 재는
    // 경로가 다르다 — 옛 경로는 이 후보를 알라딘에 던져 `judge`가 `unreadable`을
    // 냈고, 새 경로는 조회 전에 `blankTitle`로 갈라낸다. 어느 경로인지 드러나지
    // 않으면 "질의가 빈 후보를 알라딘에 태우지 않는다"가 회귀해도 여기는 초록불이다.
    expect(searchManyMock).toHaveBeenCalledWith([], expect.anything());
    expect(body.unidentified).toEqual([{ rawText: "!!!", reason: "unreadable", candidates: [] }]);
    expect(event).toMatchObject({
      unidentified_by_reason: { unreadable: 1, no_match: 0, ambiguous: 0, lookup_failed: 0 },
      raw_candidate_count: 1,
      raw_guardrail_denominator: 1,
      raw_unidentified_guardrail_count: 1,
    });
    expect(사유별_계측(event).blank_title).toBe(1);
    expect(사유별_계측(event).lookup_capped).toBe(0);
  });

  /* --- 빈 키를 알라딘에 태우지 않는다 (② 접힘 규칙 재설계) ---------- */

  /** 정규화하면 제목이 통째로 사라지는 원문들. 서로 **다른 문자열**인 것이 요점이다 */
  const 빈제목_원문 = ["!!!", "···", "???"];

  it("제목이 빈 후보는 카드로 전부 남되 알라딘 질의에는 하나도 실리지 않는다", async () => {
    setExtract([
      [...빈제목_원문.map((title) => extractedOf(title)), extractedOf("소년이 온다")],
    ]);
    searchByExactTitle(["소년이 온다"]);
    factsForAll();

    const body = await (await POST(analyzeRequest())).json();

    expect(body.identified).toHaveLength(1);
    // 셋이 서로 다른 카드로 남는다. 옛 키는 이 셋을 `"\u0000"` 하나로 만들어
    // 병합에서 접었고, 대표 하나만 조회에 실려 나머지 둘은 화면에서 사라졌다.
    expect(body.unidentified).toHaveLength(빈제목_원문.length);
    expect(응답_사유_분포(body.unidentified)).toEqual({ unreadable: 빈제목_원문.length });
    expect(body.unidentified.map((book: { rawText: string }) => book.rawText).sort()).toEqual(
      [...빈제목_원문].sort(),
    );

    // 알라딘에 던질 문자가 없는 후보를 조회에 태우면, 확실한 `no_match` 하나를
    // 일일 한도에서 빼 쓰고 화면에는 "알라딘에 없는 책"이라는 사실이 아닌
    // 설명이 남는다. 질의 배열을 통째로 못 박아 그 후보가 새는 길을 막는다.
    const 질의 = searchManyMock.mock.calls[0][0] as { title: string; author: string | null }[];
    expect(질의).toEqual([{ title: "소년이 온다", author: null }]);
    for (const 원문 of 빈제목_원문) {
      expect(질의.some((q) => q.title === 원문)).toBe(false);
    }
  });

  it("65 절단 뒤쪽에 놓일 빈 제목 후보가 blank_title이고 분자·분모에 든다", async () => {
    // 모집단 이동. 옛 규칙에서 이 후보들은 **하나로 접힌 뒤**(키가 전부 같다)
    // 확신도 오름차순 꼴찌라 65 절단 뒤로 밀려 `lookup_capped`가 됐다 — 분자에도
    // 분모에도 들어가지 않았고, 접힌 나머지 하나는 응답에서도 사라졌다. 판독이
    // 무너진 책이 "우리가 건 상한 때문에 밀린 책"으로 기록되면 프롬프트를 고쳐야
    // 할 신호가 상한을 올려야 할 신호로 뒤바뀐다.
    const 또렷 = Array.from(
      { length: MAX_CANDIDATES_FOR_LOOKUP },
      (_, index) => `책${String(index + 1).padStart(3, "0")}`,
    );
    const 빈제목 = ["!!!", "···"];
    setExtract([
      [
        ...또렷.map((title) => extractedOf(title)),
        // 확신도는 하한 바로 위다 — 강등 사유가 확신도가 아님을 픽스처가 못 박는다.
        ...빈제목.map((title) => extractedOf(title, 0, { confidence: CONFIDENCE_FLOOR + 0.01 })),
      ],
    ]);
    searchByExactTitle(또렷);
    factsForAll();

    const body = await (await POST(analyzeRequest())).json();
    const event = 유일한_완료이벤트();

    // 조회는 또렷한 65건뿐이고 절단이 실제로 일어난 세션이다.
    expect(searchManyMock.mock.calls[0][0]).toHaveLength(MAX_CANDIDATES_FOR_LOOKUP);
    expect(body.identified).toHaveLength(MAX_IDENTIFIED_BOOKS);
    expect(응답_사유_분포(body.unidentified)).toEqual({ unreadable: 빈제목.length });

    expect(사유별_계측(event).blank_title).toBe(빈제목.length);
    expect(사유별_계측(event).lookup_capped).toBe(0);
    expect(사유별_계측(event).low_confidence).toBe(0);
    // 분자·분모 **둘 다**에 든다. 오늘은 둘 다 밖이다.
    expect(event.raw_unidentified_guardrail_count).toBe(빈제목.length);
    expect(event.raw_guardrail_denominator).toBe(MAX_CANDIDATES_FOR_LOOKUP + 빈제목.length);
  });

  /* --- 확인된 책과 겹치는 판독본은 분자에서 뺀다 (① 회계) ----------- */

  it("흐릿한 판독본이 또렷한 판독본과 같은 책이면 분자에서 빠진다", async () => {
    // ①-종단. 같은 책을 두 번 읽었고 한 번은 확인으로 올라갔다. 흐릿한 쪽까지
    // 분자에 세면 한 권이 성공과 실패로 동시에 세어져, 사진을 여러 장 올릴수록
    // 판독 품질이 나빠 보이는 뒤집힌 지표가 된다.
    setExtract([
      [
        extractedOf("82년생 김지영", 0, { author: "조남주", confidence: 0.1 }),
        extractedOf("82년생김지영", 0, { author: "조남주 (지은이)", confidence: 0.9 }),
        extractedOf("없는 책", 0),
      ],
    ]);
    setSearch((query) =>
      query.title === "82년생김지영"
        ? { status: "ok", candidates: [candidateOf(1, "82년생김지영")] }
        : { status: "ok", candidates: [] },
    );
    factsForAll();

    const body = await (await POST(analyzeRequest())).json();
    const event = 유일한_완료이벤트();

    expect(body.identified).toHaveLength(1);
    // 접는 것은 세는 자리뿐이다 — 흐릿한 판독본도 카드로 그대로 남는다 (ADR-002).
    expect(응답_사유_분포(body.unidentified)).toEqual({ unreadable: 1, no_match: 1 });

    // 분자는 `no_match` 하나뿐이다.
    expect(event.raw_unidentified_guardrail_count).toBe(1);
    expect(사유별_계측(event).low_confidence).toBe(0);
    expect(사유별_계측(event).no_match).toBe(1);
    // 분모 = 확인된 책 1 + 분자 1.
    expect(event.raw_guardrail_denominator).toBe(2);
  });

  it("dedupe가 버린 쪽 키를 가진 흐릿한 판독본도 분자에서 빠진다", async () => {
    // ①-dedupe 누수. 저자를 읽어낸 판독본과 못 읽은 판독본은 병합 키가 갈리지만
    // 알라딘이 같은 ISBN을 돌려주면 `dedupeByIsbn`이 한 권으로 접는다. 확인 키를
    // dedupe **뒤**의 목록에서 모으면 버려진 쪽 키가 집합에 없어, 그 키를 가진
    // 흐릿한 판독본이 차감되지 않고 분자에 남는다.
    setExtract([
      [
        extractedOf("소년이 온다", 0, { author: "한강" }),
        extractedOf("소년이 온다", 0),
        extractedOf("소년이 온다", 0, { confidence: 0.1 }),
      ],
    ]);
    setSearch(() => ({ status: "ok", candidates: [candidateOf(1, "소년이 온다")] }));
    factsForAll();

    const body = await (await POST(analyzeRequest())).json();
    const event = 유일한_완료이벤트();

    // 저자 유무로 키가 갈려 조회는 둘, 그런데 승격 결과는 같은 ISBN이다.
    expect(searchManyMock.mock.calls[0][0]).toHaveLength(2);
    expect(lookupFactsManyMock.mock.calls[0][0]).toEqual([isbnOf(1)]);
    expect(body.identified).toHaveLength(1);
    expect(응답_사유_분포(body.unidentified)).toEqual({ unreadable: 1 });

    expect(event.raw_unidentified_guardrail_count).toBe(0);
    expect(사유별_계측(event).low_confidence).toBe(0);
    // 분모의 확인 쪽은 **책 수(1)**다. 키 둘을 세면 2가 되어 여기서 깨진다.
    expect(event.raw_guardrail_denominator).toBe(1);
  });

  it("미확인이 하나도 없으면 분자가 0이고 분모가 확인된 책 수다", async () => {
    setExtract([[extractedOf("소년이 온다"), extractedOf("흰")]]);
    searchByExactTitle(["소년이 온다", "흰"]);
    factsForAll();

    const body = await (await POST(analyzeRequest())).json();
    const event = 유일한_완료이벤트();

    expect(body.unidentified).toEqual([]);
    expect(event).toMatchObject({
      raw_candidate_count: body.identified.length,
      raw_guardrail_denominator: body.identified.length,
      raw_unidentified_guardrail_count: 0,
    });
    // 일곱 칸이 전부 0이다 — 미확인이 없는데 어느 칸이든 값이 있으면 어딘가에서
    // 확인된 책이 미확인으로도 세어지고 있다는 뜻이다.
    expect(Object.values(사유별_계측(event)).every((n) => n === 0)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 레이트 리밋 (INV-1 · INV-2 · AC-1 · ADR-012)
 *
 * 순수 판정은 `lib/rate-limit.test.ts`가 전부 덮는다. 여기서는 **라우트가
 * 그 판정을 어디에 걸었는가**만 본다 — 차단이 본문을 읽기 전에 일어나고,
 * 응답이 기존 에러 규약을 그대로 따르는가.
 * ------------------------------------------------------------------ */

describe("레이트 리밋", () => {
  /** 같은 IP에서 온 요청. `requestOf`는 헤더를 못 실어 여기서 따로 만든다 */
  function requestFromSameIp(): Request {
    return new Request("http://localhost/api/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.7",
      },
      body: JSON.stringify({ sessionId: SESSION_ID, images: [IMAGE] }),
    });
  }

  /** IP별 상한만큼 태운다. 상한 값을 여기 리터럴로 적지 않는다 (AC-4) */
  async function fillIpBudget(): Promise<void> {
    setExtract([[]]);
    for (let sent = 0; sent < RATE_LIMIT_MAX_REQUESTS; sent += 1) {
      await POST(requestFromSameIp());
    }
  }

  it("상한을 넘긴 요청이 429 RATE_LIMITED와 Retry-After 헤더를 받는다", async () => {
    await fillIpBudget();

    const response = await POST(requestFromSameIp());
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.requestId).toBe(response.headers.get("X-Request-Id"));
    expect(body.error).toMatch(/\S/);
    // 본문은 **기존 에러 스키마 그대로**다. 같은 값을 본문에 한 번 더 싣지 않는다 —
    // 두 곳에 두면 한쪽만 고쳐지는 날이 온다 (교차검증 F-24).
    expect(Object.keys(body).sort()).toEqual(["code", "error", "requestId"]);
    // `Retry-After`는 정수 초여야 한다. 소수나 0이 나가면 규격 위반이다.
    expect(response.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);
  });

  it("차단된 요청은 Anthropic을 부르지 않는다 — 차단이 비용을 쓰지 않는다", async () => {
    await fillIpBudget();
    extractMock.mockClear();
    notesMock.mockClear();

    const response = await POST(requestFromSameIp());

    expect(response.status).toBe(429);
    expect(extractMock).not.toHaveBeenCalled();
    expect(notesMock).not.toHaveBeenCalled();
  });
});
