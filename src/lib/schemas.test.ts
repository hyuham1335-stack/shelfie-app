import { describe, expect, it } from "vitest";
import {
  aladinCandidateSchema,
  analyzeRequestSchema,
  analyzeResponseSchema,
  errorCodeSchema,
  errorResponseSchema,
  eventsRequestSchema,
  extractedCandidateSchema,
  extractionResultSchema,
  identifiedBookSchema,
  isbn13Schema,
  moodQuestionSchema,
  moodQuestionsRequestSchema,
  moodQuestionsResponseSchema,
  recommendRequestSchema,
  recommendResponseSchema,
  recommendationSchema,
  resolveRequestSchema,
  resolveResponseSchema,
  unidentifiedBookSchema,
  unidentifiedReasonSchema,
} from "./schemas";
import type { ExtractedCandidate, IdentifiedBook, UnidentifiedBook } from "@/types/book";
import type { AnalyzeResponse, ErrorCode, Recommendation } from "@/types/api";

const SESSION_ID = "3f6c0a54-2b2e-4a6a-9f1f-9d9a2b1c4e77";
const ISBN = "9788934942467";
const PROOF = "aGVsbG8.c2lnbmF0dXJl";
const ALADIN_LINK = "https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=1";

const aladinCandidate = {
  isbn13: ISBN,
  title: "코스모스",
  author: "칼 세이건",
  publisher: "사이언스북스",
  coverUrl: "https://image.aladin.co.kr/product/1/1/cover/8983711892.jpg",
};

const identifiedBook = {
  ...aladinCandidate,
  pages: 719,
  aladinRating: 9.6,
  aladinLink: ALADIN_LINK,
  claudeNote: "우주를 보는 눈이 한 뼘 넓어지는 책.",
  photoIndex: 0,
  proof: PROOF,
};

/** Claude가 돌려주는 형태. photoIndex가 없다 — 사진 인덱스는 서버가 붙인다. */
const modelCandidate = {
  rawText: "코스모스 칼세이건",
  title: "코스모스",
  author: "칼 세이건",
  confidence: 0.92,
};

/** 서버가 photoIndex를 붙인 뒤의 형태. */
const extractedCandidate = { ...modelCandidate, photoIndex: 0 };

const recommendation = {
  bookId: ISBN,
  reason: "지금처럼 생각이 복잡한 밤에는 시야를 우주까지 넓혀 주는 글이 잘 맞습니다.",
  position: 1,
};

const moodQuestion = {
  id: "q1",
  question: "지금 머리를 비우고 싶으신가요, 채우고 싶으신가요?",
  options: ["비우고 싶어요", "채우고 싶어요", "잘 모르겠어요"],
};

/** 상한 경계를 만들기 위해 같은 항목을 n개로 늘린다. */
function repeat<T>(item: T, n: number): T[] {
  return Array.from({ length: n }, () => item);
}

describe("검증 경계 — 실패는 예외가 아니라 판별 가능한 값이다 (ARCHITECTURE 검증 경계 패턴)", () => {
  it("스키마를 위반해도 throw하지 않고 success:false를 돌려준다", () => {
    expect(() => identifiedBookSchema.safeParse({ nope: true })).not.toThrow();
    expect(identifiedBookSchema.safeParse({ nope: true }).success).toBe(false);
  });

  it("정상 입력은 success:true와 파싱된 값을 돌려준다", () => {
    const result = identifiedBookSchema.safeParse(identifiedBook);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.isbn13).toBe(ISBN);
  });
});

describe("isbn13 — 중복 제거 키이자 추천 화이트리스트의 유일한 식별자 (ADR-002)", () => {
  it("13자리 숫자만 통과한다", () => {
    expect(isbn13Schema.safeParse(ISBN).success).toBe(true);
  });

  it.each([
    ["12자리", "978893494246"],
    ["14자리", "97889349424670"],
    ["하이픈 포함", "978-89-349-4246-7"],
    ["문자 포함", "978893494246X"],
    ["빈 문자열", ""],
  ])("%s는 거부한다", (_label, value) => {
    expect(isbn13Schema.safeParse(value).success).toBe(false);
  });
});

describe("미확인 사유 — 4종이 서로 겹치지 않는다 (ADR-005)", () => {
  it.each(["unreadable", "no_match", "ambiguous", "lookup_failed"])(
    "%s는 유효한 사유다",
    (reason) => {
      expect(unidentifiedReasonSchema.safeParse(reason).success).toBe(true);
    },
  );

  it("사유는 정확히 4종이다 — lookup_failed가 사라지면 조회 실패를 no_match로 뭉개게 된다", () => {
    expect(unidentifiedReasonSchema.options).toHaveLength(4);
  });

  it("정의되지 않은 사유는 거부한다", () => {
    expect(unidentifiedReasonSchema.safeParse("not_found").success).toBe(false);
    expect(unidentifiedReasonSchema.safeParse("").success).toBe(false);
  });
});

describe("UnidentifiedBook — candidates는 ambiguous일 때만 채운다 (API_SPEC)", () => {
  it("ambiguous가 아닌데 후보가 채워져 있으면 거부한다", () => {
    const filled = { rawText: "코스모스", reason: "no_match", candidates: [aladinCandidate] };
    expect(unidentifiedBookSchema.safeParse(filled).success).toBe(false);
  });

  it("ambiguous면 후보를 최대 5건까지 담는다", () => {
    const ok = { rawText: "코스모스", reason: "ambiguous", candidates: repeat(aladinCandidate, 5) };
    expect(unidentifiedBookSchema.safeParse(ok).success).toBe(true);
    expect(unidentifiedBookSchema.safeParse({ ...ok, candidates: repeat(aladinCandidate, 6) }).success).toBe(false);
  });

  it("lookup_failed는 후보 없이 통과한다", () => {
    const parsed = unidentifiedBookSchema.safeParse({
      rawText: "읽히다 만 제목",
      reason: "lookup_failed",
      candidates: [],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("IdentifiedBook — 알라딘 사실과 Claude 해석을 한 객체에 담되 제약은 다르다 (ADR-002)", () => {
  it("pages·aladinRating은 null을 허용한다 (알라딘 레코드에 없을 수 있다)", () => {
    const parsed = identifiedBookSchema.safeParse({ ...identifiedBook, pages: null, aladinRating: null });
    expect(parsed.success).toBe(true);
  });

  it("claudeNote는 빈 문자열을 허용한다 (생성 실패·예산 부족 시 비운다 — ADR-005)", () => {
    expect(identifiedBookSchema.safeParse({ ...identifiedBook, claudeNote: "" }).success).toBe(true);
  });

  it("claudeNote가 60자를 넘으면 거부한다 (TR-007)", () => {
    expect(identifiedBookSchema.safeParse({ ...identifiedBook, claudeNote: "가".repeat(61) }).success).toBe(false);
  });

  it("proof가 없으면 확인된 책이 될 수 없다 (ADR-006)", () => {
    const { proof: _proof, ...withoutProof } = identifiedBook;
    expect(identifiedBookSchema.safeParse(withoutProof).success).toBe(false);
    expect(identifiedBookSchema.safeParse({ ...identifiedBook, proof: "" }).success).toBe(false);
  });

  it("aladinRating은 0~10 범위다", () => {
    expect(identifiedBookSchema.safeParse({ ...identifiedBook, aladinRating: 10 }).success).toBe(true);
    expect(identifiedBookSchema.safeParse({ ...identifiedBook, aladinRating: 10.1 }).success).toBe(false);
    expect(identifiedBookSchema.safeParse({ ...identifiedBook, aladinRating: -1 }).success).toBe(false);
  });

  it("coverUrl·aladinLink는 절대 URL이어야 한다", () => {
    expect(identifiedBookSchema.safeParse({ ...identifiedBook, coverUrl: "/local.jpg" }).success).toBe(false);
    expect(identifiedBookSchema.safeParse({ ...identifiedBook, aladinLink: "wproduct.aspx" }).success).toBe(false);
  });
});

describe("추출 결과 — 사진당 후보 상한을 스키마로 강제한다 (TR-003)", () => {
  it("정상 후보를 파싱한다", () => {
    expect(extractedCandidateSchema.safeParse(extractedCandidate).success).toBe(true);
  });

  it("author는 읽히지 않으면 null이다", () => {
    expect(extractedCandidateSchema.safeParse({ ...extractedCandidate, author: null }).success).toBe(true);
  });

  it("photoIndex는 0-based이고 사진 장수 상한 안에 있어야 한다", () => {
    expect(extractedCandidateSchema.safeParse({ ...extractedCandidate, photoIndex: 4 }).success).toBe(true);
    expect(extractedCandidateSchema.safeParse({ ...extractedCandidate, photoIndex: 5 }).success).toBe(false);
    expect(extractedCandidateSchema.safeParse({ ...extractedCandidate, photoIndex: -1 }).success).toBe(false);
  });

  it("confidence는 0~1 범위다", () => {
    expect(extractedCandidateSchema.safeParse({ ...extractedCandidate, confidence: 1.01 }).success).toBe(false);
    expect(extractedCandidateSchema.safeParse({ ...extractedCandidate, confidence: -0.1 }).success).toBe(false);
  });

  it("사진 한 장에서 60건까지만 받는다 — 61건이면 거부 (TR-003)", () => {
    expect(extractionResultSchema.safeParse({ candidates: repeat(modelCandidate, 60) }).success).toBe(true);
    expect(extractionResultSchema.safeParse({ candidates: repeat(modelCandidate, 61) }).success).toBe(false);
  });

  it("모델 응답에는 photoIndex가 없다 — 사진 인덱스를 모델이 지어낼 경로를 두지 않는다", () => {
    const parsed = extractionResultSchema.safeParse({ candidates: [{ ...modelCandidate, photoIndex: 99 }] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.candidates[0]).not.toHaveProperty("photoIndex");
  });
});

describe("POST /api/analyze 계약", () => {
  const image = "data:image/jpeg;base64,AAAA";

  it("사진 1~5장을 받는다", () => {
    expect(analyzeRequestSchema.safeParse({ sessionId: SESSION_ID, images: [image] }).success).toBe(true);
    expect(analyzeRequestSchema.safeParse({ sessionId: SESSION_ID, images: repeat(image, 5) }).success).toBe(true);
    expect(analyzeRequestSchema.safeParse({ sessionId: SESSION_ID, images: repeat(image, 6) }).success).toBe(false);
    expect(analyzeRequestSchema.safeParse({ sessionId: SESSION_ID, images: [] }).success).toBe(false);
  });

  it("jpeg·png·webp 데이터 URI만 받는다 (UNSUPPORTED_IMAGE_TYPE)", () => {
    for (const accepted of ["data:image/jpeg;base64,AAAA", "data:image/png;base64,AAAA", "data:image/webp;base64,AAAA"]) {
      expect(analyzeRequestSchema.safeParse({ sessionId: SESSION_ID, images: [accepted] }).success).toBe(true);
    }
    for (const rejected of ["data:image/heic;base64,AAAA", "data:image/gif;base64,AAAA", "https://example.com/a.jpg"]) {
      expect(analyzeRequestSchema.safeParse({ sessionId: SESSION_ID, images: [rejected] }).success).toBe(false);
    }
  });

  it("sessionId가 UUID가 아니어도 요청은 통과한다 — 서버는 이 값을 신뢰하거나 검증하지 않는다 (API_SPEC 공통 규약)", () => {
    expect(analyzeRequestSchema.safeParse({ sessionId: "not-a-uuid", images: [image] }).success).toBe(true);
  });

  it("그래도 sessionId는 비어 있을 수 없다 — 로그에서 한 세션을 묶는 유일한 키다", () => {
    expect(analyzeRequestSchema.safeParse({ sessionId: "", images: [image] }).success).toBe(false);
  });

  it("응답은 확인 50권·미확인 100건 상한을 넘지 못한다 (TR-005)", () => {
    const base = {
      sessionId: SESSION_ID,
      identified: [],
      unidentified: [],
      overflowCount: 0,
      unidentifiedOverflowCount: 0,
      failedPhotoCount: 0,
      failedPhotoIndexes: [],
    };
    expect(analyzeResponseSchema.safeParse({ ...base, identified: repeat(identifiedBook, 50) }).success).toBe(true);
    expect(analyzeResponseSchema.safeParse({ ...base, identified: repeat(identifiedBook, 51) }).success).toBe(false);

    const unidentifiedItem = { rawText: "읽히다 만 제목", reason: "unreadable", candidates: [] };
    expect(analyzeResponseSchema.safeParse({ ...base, unidentified: repeat(unidentifiedItem, 100) }).success).toBe(true);
    expect(analyzeResponseSchema.safeParse({ ...base, unidentified: repeat(unidentifiedItem, 101) }).success).toBe(false);
  });

  it("확인 0건 + 미확인만 있는 응답도 유효하다 (unidentifiedOnly 분기 — EMPTY_SHELF가 아니다)", () => {
    const parsed = analyzeResponseSchema.safeParse({
      sessionId: SESSION_ID,
      identified: [],
      unidentified: [{ rawText: "코스모스", reason: "lookup_failed", candidates: [] }],
      overflowCount: 0,
      unidentifiedOverflowCount: 0,
      failedPhotoCount: 0,
      failedPhotoIndexes: [],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("POST /api/books/resolve 계약", () => {
  const resolved = {
    ...aladinCandidate,
    pages: 719,
    aladinRating: 9.6,
    aladinLink: ALADIN_LINK,
    proof: PROOF,
  };

  it("query는 1~200자다", () => {
    expect(resolveRequestSchema.safeParse({ sessionId: SESSION_ID, query: "코스모스" }).success).toBe(true);
    expect(resolveRequestSchema.safeParse({ sessionId: SESSION_ID, query: "" }).success).toBe(false);
    expect(resolveRequestSchema.safeParse({ sessionId: SESSION_ID, query: "가".repeat(201) }).success).toBe(false);
  });

  it("author는 선택 항목이다", () => {
    expect(resolveRequestSchema.safeParse({ sessionId: SESSION_ID, query: "코스모스", author: null }).success).toBe(true);
    expect(resolveRequestSchema.safeParse({ sessionId: SESSION_ID, query: "코스모스", author: "칼 세이건" }).success).toBe(true);
  });

  it("후보에도 proof가 붙는다 — 없으면 US-002가 검증 우회 통로가 된다 (ADR-006)", () => {
    expect(resolveResponseSchema.safeParse({ candidates: [resolved] }).success).toBe(true);
    const { proof: _proof, ...withoutProof } = resolved;
    expect(resolveResponseSchema.safeParse({ candidates: [withoutProof] }).success).toBe(false);
  });

  it("후보는 최대 5건이다", () => {
    expect(aladinCandidateSchema.safeParse(aladinCandidate).success).toBe(true);
    expect(resolveResponseSchema.safeParse({ candidates: repeat(resolved, 5) }).success).toBe(true);
    expect(resolveResponseSchema.safeParse({ candidates: repeat(resolved, 6) }).success).toBe(false);
  });
});

describe("POST /api/mood/questions 계약", () => {
  const bookRef = { isbn13: ISBN, title: "코스모스", author: "칼 세이건", proof: PROOF };

  it("책 목록은 1~50개이고 각 항목에 proof가 있어야 한다", () => {
    expect(moodQuestionsRequestSchema.safeParse({ sessionId: SESSION_ID, books: [bookRef] }).success).toBe(true);
    expect(moodQuestionsRequestSchema.safeParse({ sessionId: SESSION_ID, books: [] }).success).toBe(false);
    expect(moodQuestionsRequestSchema.safeParse({ sessionId: SESSION_ID, books: repeat(bookRef, 51) }).success).toBe(false);

    const { proof: _proof, ...withoutProof } = bookRef;
    expect(moodQuestionsRequestSchema.safeParse({ sessionId: SESSION_ID, books: [withoutProof] }).success).toBe(false);
  });

  it("질문은 10~60자, 선택지는 3~4개다 (TR-009)", () => {
    expect(moodQuestionSchema.safeParse(moodQuestion).success).toBe(true);
    expect(moodQuestionSchema.safeParse({ ...moodQuestion, question: "짧다" }).success).toBe(false);
    expect(moodQuestionSchema.safeParse({ ...moodQuestion, question: "가".repeat(61) }).success).toBe(false);
    expect(moodQuestionSchema.safeParse({ ...moodQuestion, options: ["하나", "둘"] }).success).toBe(false);
    expect(moodQuestionSchema.safeParse({ ...moodQuestion, options: ["1", "2", "3", "4", "5"] }).success).toBe(false);
  });

  it("질문 수는 2~3개이거나, 자유 입력 폴백을 위한 빈 배열이다", () => {
    expect(moodQuestionsResponseSchema.safeParse({ questions: [] }).success).toBe(true);
    expect(moodQuestionsResponseSchema.safeParse({ questions: repeat(moodQuestion, 2) }).success).toBe(true);
    expect(moodQuestionsResponseSchema.safeParse({ questions: repeat(moodQuestion, 3) }).success).toBe(true);
    expect(moodQuestionsResponseSchema.safeParse({ questions: [moodQuestion] }).success).toBe(false);
    expect(moodQuestionsResponseSchema.safeParse({ questions: repeat(moodQuestion, 4) }).success).toBe(false);
  });
});

describe("POST /api/recommend 계약", () => {
  const recommendBook = {
    isbn13: ISBN,
    title: "코스모스",
    author: "칼 세이건",
    pages: 719,
    claudeNote: "",
    proof: PROOF,
  };
  const request = {
    sessionId: SESSION_ID,
    books: [recommendBook],
    mood: "복잡한 하루였고 머리를 식히고 싶어요",
    inputMode: "free_text",
  };

  it("정상 요청을 파싱한다", () => {
    expect(recommendRequestSchema.safeParse(request).success).toBe(true);
  });

  it("mood는 2~500자다", () => {
    expect(recommendRequestSchema.safeParse({ ...request, mood: "가" }).success).toBe(false);
    expect(recommendRequestSchema.safeParse({ ...request, mood: "가".repeat(501) }).success).toBe(false);
  });

  it("inputMode는 free_text 또는 guided다", () => {
    expect(recommendRequestSchema.safeParse({ ...request, inputMode: "guided" }).success).toBe(true);
    expect(recommendRequestSchema.safeParse({ ...request, inputMode: "voice" }).success).toBe(false);
  });

  it("책 목록의 각 항목에 proof가 없으면 거부한다 (ADR-006)", () => {
    const { proof: _proof, ...withoutProof } = recommendBook;
    expect(recommendRequestSchema.safeParse({ ...request, books: [withoutProof] }).success).toBe(false);
  });

  it("추천 이유는 20~200자, position은 1~3이다", () => {
    expect(recommendationSchema.safeParse(recommendation).success).toBe(true);
    expect(recommendationSchema.safeParse({ ...recommendation, reason: "짧은 이유" }).success).toBe(false);
    expect(recommendationSchema.safeParse({ ...recommendation, reason: "가".repeat(201) }).success).toBe(false);
    expect(recommendationSchema.safeParse({ ...recommendation, position: 4 }).success).toBe(false);
    expect(recommendationSchema.safeParse({ ...recommendation, position: 0 }).success).toBe(false);
  });

  it("bookId는 isbn13 형식이어야 한다 — 모델이 지어낸 문자열을 통과시키지 않는다 (FR-009)", () => {
    expect(recommendationSchema.safeParse({ ...recommendation, bookId: "코스모스" }).success).toBe(false);
  });

  it("추천은 최대 3권이고, 3권 미만이면 shortfall로 표시한다", () => {
    const three = [
      recommendation,
      { ...recommendation, position: 2 },
      { ...recommendation, position: 3 },
    ];
    expect(recommendResponseSchema.safeParse({ recommendations: three, shortfall: false }).success).toBe(true);
    expect(recommendResponseSchema.safeParse({ recommendations: [recommendation], shortfall: true }).success).toBe(true);
    expect(
      recommendResponseSchema.safeParse({
        recommendations: [...three, { ...recommendation, position: 1 }],
        shortfall: false,
      }).success,
    ).toBe(false);
  });
});

describe("POST /api/events 계약", () => {
  it("허용 이벤트 3종만 받는다 (TR-014)", () => {
    for (const event of ["recommend_viewed", "recommend_accepted", "book_resolved"]) {
      expect(eventsRequestSchema.safeParse({ sessionId: SESSION_ID, event }).success).toBe(true);
    }
    expect(eventsRequestSchema.safeParse({ sessionId: SESSION_ID, event: "analyze_completed" }).success).toBe(false);
    expect(eventsRequestSchema.safeParse({ sessionId: SESSION_ID, event: "custom_event" }).success).toBe(false);
  });

  it("properties는 선택이며 원시값만 담는다 (PII 유입 차단)", () => {
    expect(
      eventsRequestSchema.safeParse({
        sessionId: SESSION_ID,
        event: "recommend_viewed",
        properties: { position: 1 },
      }).success,
    ).toBe(true);
    expect(
      eventsRequestSchema.safeParse({
        sessionId: SESSION_ID,
        event: "recommend_viewed",
        properties: { nested: { deep: "value" } },
      }).success,
    ).toBe(false);
  });
});

describe("에러 응답 규약", () => {
  it("API_SPEC의 에러 코드 15종과 정확히 일치한다", () => {
    expect([...errorCodeSchema.options].sort()).toEqual(
      [
        "EMPTY_SHELF",
        "IMAGE_TOO_LARGE",
        // 500. 502와 뭉개지 않는다 — 우리 응답이 우리 계약을 어긴 것을 502로
        // 내보내면 남의 장애로 기록된다 (API_SPEC 에러 응답 규약).
        "INTERNAL_ERROR",
        "INVALID_REQUEST",
        "IRRELEVANT_MOOD",
        "NOT_FOUND_IN_ALADIN",
        "PAYLOAD_TOO_LARGE",
        "RATE_LIMITED",
        "RECOMMENDATION_VALIDATION_FAILED",
        "SERVICE_DISABLED",
        "TIMEOUT",
        "TOO_MANY_PHOTOS",
        "UNSUPPORTED_IMAGE_TYPE",
        "UNVERIFIED_BOOKS",
        "UPSTREAM_UNAVAILABLE",
      ].sort(),
    );
  });

  it("에러 본문에는 requestId가 반드시 담긴다 — 사용자가 읽어 신고한 ID로 로그를 찾는다", () => {
    const body = { error: "사진을 읽지 못했어요", code: "UPSTREAM_UNAVAILABLE", requestId: "req_123" };
    expect(errorResponseSchema.safeParse(body).success).toBe(true);

    const { requestId: _requestId, ...withoutRequestId } = body;
    expect(errorResponseSchema.safeParse(withoutRequestId).success).toBe(false);
  });

  it("정의되지 않은 코드는 거부한다", () => {
    expect(errorCodeSchema.safeParse("SOMETHING_WENT_WRONG").success).toBe(false);
  });
});

describe("파생 타입 — 스키마와 타입이 어긋나면 npm run build가 실패한다 (TR-002 중복 정의 0건)", () => {
  it("파싱 결과를 types/의 타입에 그대로 대입할 수 있다", () => {
    const book: IdentifiedBook = identifiedBookSchema.parse(identifiedBook);
    const candidate: ExtractedCandidate = extractedCandidateSchema.parse(extractedCandidate);
    const unidentified: UnidentifiedBook = unidentifiedBookSchema.parse({
      rawText: "읽히다 만 제목",
      reason: "lookup_failed",
      candidates: [],
    });
    const suggestion: Recommendation = recommendationSchema.parse(recommendation);

    expect(book.isbn13).toBe(ISBN);
    expect(candidate.photoIndex).toBe(0);
    expect(unidentified.reason).toBe("lookup_failed");
    expect(suggestion.position).toBe(1);
  });

  it("응답 타입과 에러 코드 타입도 스키마에서 파생된다", () => {
    const response: AnalyzeResponse = analyzeResponseSchema.parse({
      sessionId: SESSION_ID,
      identified: [identifiedBook],
      unidentified: [],
      overflowCount: 0,
      unidentifiedOverflowCount: 0,
      failedPhotoCount: 0,
      failedPhotoIndexes: [],
    });
    const code: ErrorCode = errorCodeSchema.parse("EMPTY_SHELF");

    expect(response.identified).toHaveLength(1);
    expect(code).toBe("EMPTY_SHELF");
  });
});
