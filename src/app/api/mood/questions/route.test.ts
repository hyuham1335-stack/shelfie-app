/**
 * POST /api/mood/questions 계약 테스트 (TR-009, US-004, ADR-006).
 *
 * ## 무엇을 모킹하고 무엇을 모킹하지 않는가
 * `services/anthropic`의 `generateQuestions`만 갈아 끼운다. **`lib/`은 전부
 * 진짜다** — 특히 `lib/proof`를 모킹하면 라우트가 서명 검증을 건너뛰어도
 * 초록불이 나온다. 이 라우트는 `proof` 검증을 **처음 소비하는** 곳이므로
 * 검증 자체가 테스트 대상이다.
 *
 * `lib/analytics`만 예외적으로 스파이로 바꾼다. 진짜 `logEvent`는 표준 출력에
 * 쓰고 예외를 삼키므로, 무엇이 실렸는지 확인할 방법이 그것뿐이다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_IDENTIFIED_BOOKS } from "@/lib/env";
import { issueProof } from "@/lib/proof";
import { moodQuestionsResponseSchema } from "@/lib/schemas";
import type { AnalyticsEvent } from "@/lib/analytics";
import type { QuestionsOptions } from "@/services/anthropic";
import type { MoodQuestion } from "@/types/api";

const { generateQuestionsMock, logEventMock } = vi.hoisted(() => ({
  generateQuestionsMock: vi.fn(),
  logEventMock: vi.fn(),
}));

vi.mock("@/services/anthropic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/anthropic")>();
  return { ...actual, generateQuestions: generateQuestionsMock };
});

vi.mock("@/lib/analytics", () => ({ logEvent: logEventMock }));

import { POST, maxDuration, runtime } from "./route";

/* ------------------------------------------------------------------ *
 * 픽스처
 * ------------------------------------------------------------------ */

const SESSION_ID = "5f7c2a1e-0000-4000-8000-000000000001";
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

interface BookReference {
  isbn13: string;
  title: string;
  author: string;
  proof: string;
}

function isbnOf(index: number): string {
  return `9788900000${String(index).padStart(3, "0")}`;
}

/** 서명이 정상적으로 붙은 확인된 책 */
function bookOf(index: number, issuedAt: number = Date.now()): BookReference {
  const isbn13 = isbnOf(index);
  const title = `책 ${index}`;
  const author = "한강 (지은이)";
  return { isbn13, title, author, proof: issueProof({ isbn13, title, author }, issuedAt) };
}

/**
 * 다른 책의 서명을 붙인 책. 형식은 완벽하지만 MAC이 맞지 않는다 —
 * 클라이언트가 목록을 조립하다 남의 증명을 옮겨 붙인 경우가 정확히 이 모양이다.
 */
function forgedBook(index: number): BookReference {
  return { ...bookOf(index), proof: bookOf(index + 500).proof };
}

/** 발급 시각을 3시간 전으로 되돌려 TTL(2h)이 지난 서명 */
function expiredBook(index: number): BookReference {
  return bookOf(index, Date.now() - 3 * 60 * 60 * 1000);
}

function questionOf(id: string): MoodQuestion {
  return {
    id,
    question: "지금 어떤 무게의 책이 끌리나요?",
    options: ["가벼운 것", "묵직한 것", "아무거나"],
  };
}

function questionsRequest(body: unknown): Request {
  return new Request("http://localhost/api/mood/questions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function bodyOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionId: SESSION_ID, books: [bookOf(1), bookOf(2)], ...overrides };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * 대역 설정 헬퍼
 * ------------------------------------------------------------------ */

const questionsBooksSeen: { isbn13: string }[][] = [];
const questionsOptionsSeen: QuestionsOptions[] = [];

function setQuestions(outcome: unknown): void {
  generateQuestionsMock.mockImplementation(
    async (books: { isbn13: string }[], options: QuestionsOptions) => {
      questionsBooksSeen.push([...books]);
      questionsOptionsSeen.push(options);
      return outcome;
    },
  );
}

/** 정상 생성. 질문 2개 + 토큰 */
function setOkQuestions(
  questions: readonly MoodQuestion[] = [questionOf("q1"), questionOf("q2")],
): void {
  setQuestions({ status: "ok", questions, usage: { input_tokens: 900, output_tokens: 120 } });
}

function eventsOf(name: AnalyticsEvent["event"]): Record<string, unknown>[] {
  return logEventMock.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((event) => event.event === name);
}

beforeEach(() => {
  vi.stubEnv("BOOK_PROOF_SECRET", "test-book-proof-secret-0123456789abcdef");
  vi.stubEnv("SERVICE_ENABLED", undefined);
  vi.stubEnv("ANTHROPIC_API_KEY", undefined);
  questionsBooksSeen.length = 0;
  questionsOptionsSeen.length = 0;
  logEventMock.mockImplementation(() => {});
  setOkQuestions();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * 라우트 설정 (API_SPEC 공통 규약)
 * ------------------------------------------------------------------ */

describe("라우트 설정", () => {
  it("maxDuration이 이 라우트의 하드 상한 30초로 선언돼 있다", () => {
    expect(maxDuration).toBe(30);
  });

  it("lib/proof가 node:crypto를 쓰므로 nodejs 런타임이다", () => {
    expect(runtime).toBe("nodejs");
  });
});

/* ------------------------------------------------------------------ *
 * 정상 경로
 * ------------------------------------------------------------------ */

describe("정상 경로", () => {
  it("질문 2개를 돌려주고 응답이 moodQuestionsResponseSchema를 통과한다", async () => {
    const response = await POST(questionsRequest(bodyOf()));

    expect(response.status).toBe(200);
    const body = await readJson(response);
    const parsed = moodQuestionsResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.questions).toHaveLength(2);
  });

  it("질문 3개도 그대로 나간다", async () => {
    setOkQuestions([questionOf("q1"), questionOf("q2"), questionOf("q3")]);

    const response = await POST(questionsRequest(bodyOf()));

    expect(response.status).toBe(200);
    expect((await readJson(response)).questions).toHaveLength(3);
  });

  it("X-Request-Id 헤더를 붙인다 (TRD 6.4 상관관계 ID)", async () => {
    const response = await POST(questionsRequest(bodyOf()));
    expect(response.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("서비스에는 proof를 벗긴 서지 최소값만 넘긴다", async () => {
    await POST(questionsRequest(bodyOf()));

    expect(questionsBooksSeen[0]).toEqual([
      { isbn13: isbnOf(1), title: "책 1", author: "한강 (지은이)" },
      { isbn13: isbnOf(2), title: "책 2", author: "한강 (지은이)" },
    ]);
  });

  it("남은 예산을 데드라인으로 넘긴다", async () => {
    await POST(questionsRequest(bodyOf()));

    expect(questionsOptionsSeen[0].deadlineMs).toBeGreaterThan(0);
    expect(questionsOptionsSeen[0].deadlineMs).toBeLessThanOrEqual(maxDuration * 1000);
  });
});

/* ------------------------------------------------------------------ *
 * 서명 검증 (ADR-006, TR-015) — 이 라우트가 검증을 처음 소비한다.
 * 아래 다섯 건은 회귀 테스트다. 삭제하지 않는다.
 * ------------------------------------------------------------------ */

describe("proof 검증", () => {
  it("서명이 위조된 책은 그 책만 버리고 나머지로 진행한다", async () => {
    const response = await POST(
      questionsRequest(bodyOf({ books: [bookOf(1), forgedBook(2), bookOf(3)] })),
    );

    expect(response.status).toBe(200);
    expect(questionsBooksSeen[0].map((book) => book.isbn13)).toEqual([isbnOf(1), isbnOf(3)]);
  });

  it("만료된 서명도 그 책만 버린다", async () => {
    const response = await POST(questionsRequest(bodyOf({ books: [bookOf(1), expiredBook(2)] })));

    expect(response.status).toBe(200);
    expect(questionsBooksSeen[0].map((book) => book.isbn13)).toEqual([isbnOf(1)]);
  });

  it("TTL 2시간 안쪽에서 발급된 서명은 통과한다", async () => {
    const stillValid = bookOf(1, Date.now() - (TWO_HOURS_MS - 60_000));

    const response = await POST(questionsRequest(bodyOf({ books: [stillValid] })));

    expect(response.status).toBe(200);
    expect(questionsBooksSeen[0]).toHaveLength(1);
  });

  it("전부 위조되면 400 UNVERIFIED_BOOKS이고 모델을 부르지 않는다", async () => {
    const response = await POST(
      questionsRequest(bodyOf({ books: [forgedBook(1), forgedBook(2)] })),
    );

    expect(response.status).toBe(400);
    expect((await readJson(response)).code).toBe("UNVERIFIED_BOOKS");
    expect(generateQuestionsMock).not.toHaveBeenCalled();
  });

  it("proof 필드 자체가 없으면 스키마가 먼저 막는다", async () => {
    const { proof: _proof, ...withoutProof } = bookOf(1);

    const response = await POST(questionsRequest(bodyOf({ books: [withoutProof] })));

    expect(response.status).toBe(400);
    expect(generateQuestionsMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * 폴백 — 생성 실패도 모델 장애도 200 + 빈 배열이다 (API_SPEC).
 * 회귀 테스트다. 삭제하지 않는다.
 * ------------------------------------------------------------------ */

describe("생성 실패 폴백", () => {
  it.each(["schema", "refusal", "upstream", "max_tokens"] as const)(
    "%s 실패는 502가 아니라 200 + 빈 배열이다",
    async (reason) => {
      setQuestions({ status: "failed", reason, usage: { input_tokens: 700, output_tokens: 0 } });

      const response = await POST(questionsRequest(bodyOf()));

      expect(response.status).toBe(200);
      expect((await readJson(response)).questions).toEqual([]);
    },
  );

  it("질문이 1개면 계약을 어긴 본문 대신 빈 배열로 강등한다", async () => {
    setOkQuestions([questionOf("q1")]);

    const response = await POST(questionsRequest(bodyOf()));

    expect(response.status).toBe(200);
    expect((await readJson(response)).questions).toEqual([]);
  });

  it("질문이 4개여도 빈 배열로 강등한다 (상한 3)", async () => {
    setOkQuestions([questionOf("q1"), questionOf("q2"), questionOf("q3"), questionOf("q4")]);

    const response = await POST(questionsRequest(bodyOf()));

    expect(response.status).toBe(200);
    expect((await readJson(response)).questions).toEqual([]);
  });

  it("폴백 응답도 moodQuestionsResponseSchema를 통과한다", async () => {
    setQuestions({ status: "failed", reason: "upstream" });

    const body = await readJson(await POST(questionsRequest(bodyOf())));

    expect(moodQuestionsResponseSchema.safeParse(body).success).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 타임아웃 — 유일하게 200이 아닌 실패 응답이다
 * ------------------------------------------------------------------ */

describe("타임아웃", () => {
  it("timeout은 504 TIMEOUT이다", async () => {
    setQuestions({ status: "failed", reason: "timeout" });

    const response = await POST(questionsRequest(bodyOf()));

    expect(response.status).toBe(504);
    expect((await readJson(response)).code).toBe("TIMEOUT");
  });
});

/* ------------------------------------------------------------------ *
 * 요청 검증 (400)
 * ------------------------------------------------------------------ */

describe("요청 검증", () => {
  it("books가 빈 배열이면 400이다", async () => {
    const response = await POST(questionsRequest(bodyOf({ books: [] })));

    expect(response.status).toBe(400);
    expect((await readJson(response)).code).toBe("INVALID_REQUEST");
    expect(generateQuestionsMock).not.toHaveBeenCalled();
  });

  it("books가 51개면 400이다", async () => {
    const books = Array.from({ length: MAX_IDENTIFIED_BOOKS + 1 }, (_, index) => bookOf(index));

    const response = await POST(questionsRequest(bodyOf({ books })));

    expect(response.status).toBe(400);
    expect(generateQuestionsMock).not.toHaveBeenCalled();
  });

  it("books가 50개면 통과한다", async () => {
    const books = Array.from({ length: MAX_IDENTIFIED_BOOKS }, (_, index) => bookOf(index));

    const response = await POST(questionsRequest(bodyOf({ books })));

    expect(response.status).toBe(200);
  });

  it("sessionId가 없으면 400이다", async () => {
    const response = await POST(questionsRequest({ books: [bookOf(1)] }));

    expect(response.status).toBe(400);
    expect(generateQuestionsMock).not.toHaveBeenCalled();
  });

  it("본문이 JSON이 아니면 400이다", async () => {
    const response = await POST(questionsRequest("{"));

    expect(response.status).toBe(400);
  });

  it("에러 응답 본문에 requestId가 있고 헤더와 같은 값이다", async () => {
    const response = await POST(questionsRequest(bodyOf({ books: [] })));
    const body = await readJson(response);

    expect(body.requestId).toBe(response.headers.get("X-Request-Id"));
    expect(typeof body.error).toBe("string");
  });
});

/* ------------------------------------------------------------------ *
 * SERVICE_ENABLED (TRD 7번 긴급 차단 스위치)
 * ------------------------------------------------------------------ */

describe("SERVICE_ENABLED", () => {
  it("false면 외부 호출 없이 503이다", async () => {
    vi.stubEnv("SERVICE_ENABLED", "false");

    const response = await POST(questionsRequest(bodyOf()));

    expect(response.status).toBe(503);
    expect((await readJson(response)).code).toBe("SERVICE_DISABLED");
    expect(generateQuestionsMock).not.toHaveBeenCalled();
  });

  it("값이 망가져 읽을 수 없으면 차단 쪽으로 넘어진다", async () => {
    vi.stubEnv("SERVICE_ENABLED", "maybe");

    const response = await POST(questionsRequest(bodyOf()));

    expect(response.status).toBe(503);
    expect(generateQuestionsMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * 관측성 (TRD 6.4, PRD 7번)
 * ------------------------------------------------------------------ */

describe("관측성", () => {
  it("questions_generated에 질문 수와 토큰을 싣는다", async () => {
    await POST(questionsRequest(bodyOf()));

    expect(eventsOf("questions_generated")[0]).toMatchObject({
      session_id: SESSION_ID,
      question_count: 2,
      input_tokens: 900,
      output_tokens: 120,
    });
  });

  it("폴백으로 끝나도 실패 분기의 토큰을 합산한다", async () => {
    setQuestions({
      status: "failed",
      reason: "schema",
      usage: { input_tokens: 800, output_tokens: 40 },
    });

    await POST(questionsRequest(bodyOf()));

    expect(eventsOf("questions_generated")[0]).toMatchObject({
      question_count: 0,
      input_tokens: 800,
      output_tokens: 40,
    });
  });

  it("usage가 없는 실패는 토큰 0으로 남긴다", async () => {
    setQuestions({ status: "failed", reason: "upstream" });

    await POST(questionsRequest(bodyOf()));

    expect(eventsOf("questions_generated")[0]).toMatchObject({
      question_count: 0,
      input_tokens: 0,
      output_tokens: 0,
    });
  });

  it("서명 통과 0권으로 끊긴 요청은 모델을 부르지 않았으므로 이벤트도 남기지 않는다", async () => {
    await POST(questionsRequest(bodyOf({ books: [forgedBook(1)] })));

    expect(eventsOf("questions_generated")).toHaveLength(0);
  });

  it("logEvent가 던져도 응답은 200이다 (TR-012)", async () => {
    logEventMock.mockImplementation(() => {
      throw new Error("로깅 실패");
    });

    const response = await POST(questionsRequest(bodyOf()));

    expect(response.status).toBe(200);
  });

  it("로그에 서지 원문을 통째로 싣지 않는다", async () => {
    await POST(questionsRequest(bodyOf()));

    expect(JSON.stringify(logEventMock.mock.calls)).not.toContain("책 1");
  });
});

/* ------------------------------------------------------------------ *
 * 외부 호출 격리 (TRD 8번)
 * ------------------------------------------------------------------ */

describe("외부 호출", () => {
  it("실제 Anthropic을 치지 않는다", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await POST(questionsRequest(bodyOf()));

    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
