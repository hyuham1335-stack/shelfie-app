import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STAGE_BUDGET_MS, TOTAL_BUDGET_MS } from "@/lib/budget";
import {
  MAX_IDENTIFIED_BOOKS,
  MAX_OUTPUT_BYTES_PER_IMAGE,
  MAX_OUTPUT_BYTES_TOTAL,
  MAX_UNIDENTIFIED_BOOKS,
} from "@/lib/env";
import { verifyProof } from "@/lib/proof";
import { analyzeResponseSchema } from "@/lib/schemas";
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
