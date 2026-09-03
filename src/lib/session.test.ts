import { describe, expect, it } from "vitest";
import {
  MAX_RECOMMEND_ATTEMPTS,
  canRecommendAgain,
  createSessionState,
  hasVerifiedBooks,
  mergeShelfBooks,
  mergeUnidentified,
  sessionReducer,
  toBookReferences,
  toRecommendBooks,
} from "./session";
import type { SessionAction, SessionState, SessionStatus, ShelfBook } from "./session";
import { MAX_IDENTIFIED_BOOKS, MAX_UNIDENTIFIED_BOOKS } from "./env";
import type { AnalyzeResponse, MoodQuestion, Recommendation } from "@/types/api";
import type { IdentifiedBook, ResolvedCandidate, UnidentifiedBook } from "@/types/book";

const SESSION_ID = "6f1c0d2e-0a3b-4c5d-8e9f-0a1b2c3d4e5f";

/** 13자리 ISBN을 인덱스로 만든다 */
function isbn(n: number): string {
  return `9788936${String(n).padStart(6, "0")}`;
}

function 확인된책(overrides: Partial<IdentifiedBook> = {}): IdentifiedBook {
  return {
    isbn13: isbn(1),
    title: "미움받을 용기",
    author: "기시미 이치로",
    publisher: "인플루엔셜",
    coverUrl: "https://image.aladin.co.kr/cover/1.jpg",
    pages: 336,
    aladinRating: 8.6,
    aladinLink: "https://www.aladin.co.kr/shop/1",
    claudeNote: "대화체라 술술 읽힌다",
    photoIndex: 0,
    proof: "proof-1",
    ...overrides,
  };
}

function 승격된책(overrides: Partial<ResolvedCandidate> = {}): ResolvedCandidate {
  return {
    isbn13: isbn(2),
    title: "총, 균, 쇠",
    author: "재레드 다이아몬드",
    publisher: "문학사상사",
    coverUrl: "https://image.aladin.co.kr/cover/2.jpg",
    pages: 750,
    aladinRating: 9.1,
    aladinLink: "https://www.aladin.co.kr/shop/2",
    proof: "proof-2",
    ...overrides,
  };
}

function 미확인책(overrides: Partial<UnidentifiedBook> = {}): UnidentifiedBook {
  return { rawText: "총균쇠", reason: "no_match", candidates: [], ...overrides };
}

function 분석응답(overrides: Partial<AnalyzeResponse> = {}): AnalyzeResponse {
  return {
    sessionId: SESSION_ID,
    identified: [확인된책()],
    unidentified: [],
    overflowCount: 0,
    unidentifiedOverflowCount: 0,
    failedPhotoCount: 0,
    failedPhotoIndexes: [],
    ...overrides,
  };
}

const 질문: MoodQuestion[] = [
  { id: "q1", question: "지금 머리를 얼마나 쓰고 싶으세요?", options: ["거의 안", "조금", "많이"] },
  { id: "q2", question: "며칠 안에 다 읽고 싶으신가요?", options: ["하루", "일주일", "천천히"] },
];

const 추천: Recommendation[] = [
  { bookId: isbn(1), reason: "지금처럼 지친 날에 대화체로 술술 넘어가는 책이라 부담이 없어요", position: 1 },
];

/** 액션을 순서대로 먹여 원하는 상태까지 끌고 간다 */
function 상태(...actions: SessionAction[]): SessionState {
  return actions.reduce(sessionReducer, createSessionState(SESSION_ID));
}

const 분석시작: SessionAction = { type: "ANALYZE_STARTED", photoCount: 3 };

/** reviewing — 확인된 책 1권 + 미확인 1건 */
function reviewing(): SessionState {
  return 상태(분석시작, {
    type: "ANALYZE_SUCCEEDED",
    result: 분석응답({ unidentified: [미확인책()] }),
  });
}

function unidentifiedOnly(): SessionState {
  return 상태(분석시작, {
    type: "ANALYZE_SUCCEEDED",
    result: 분석응답({ identified: [], unidentified: [미확인책()] }),
  });
}

function moodInput(): SessionState {
  return sessionReducer(reviewing(), { type: "MOOD_STEP_ENTERED" });
}

function guidedQuestions(): SessionState {
  return sessionReducer(moodInput(), { type: "GUIDED_MODE_ENTERED" });
}

function recommending(): SessionState {
  return sessionReducer(moodInput(), { type: "MOOD_SUBMITTED", mood: "번아웃인데 가볍게" });
}

function result(): SessionState {
  return sessionReducer(recommending(), {
    type: "RECOMMEND_SUCCEEDED",
    recommendations: 추천,
    shortfall: false,
  });
}

/** 분석 단계에서 실패해 들어온 error */
function errorState(): SessionState {
  return sessionReducer(상태(분석시작), {
    type: "ANALYZE_FAILED",
    code: "UPSTREAM_UNAVAILABLE",
    requestId: "req-1",
  });
}

/** 추천 단계에서 실패해 들어온 error. 기분과 책장을 그대로 들고 있다 */
function recommendErrorState(): SessionState {
  return sessionReducer(recommending(), {
    type: "RECOMMEND_FAILED",
    code: "UPSTREAM_UNAVAILABLE",
    requestId: "req-5",
  });
}

function emptyShelf(): SessionState {
  return sessionReducer(상태(분석시작), {
    type: "ANALYZE_FAILED",
    code: "EMPTY_SHELF",
    requestId: "req-2",
  });
}

describe("createSessionState — 초기 상태", () => {
  it("idle에서 시작하고 주입받은 sessionId를 그대로 들고 있다", () => {
    const state = createSessionState(SESSION_ID);

    expect(state.status).toBe("idle");
    expect(state.sessionId).toBe(SESSION_ID);
    expect(state.books).toEqual([]);
    expect(state.photoCount).toBe(0);
    expect(state.recommendCount).toBe(0);
    expect(state.errorCode).toBeNull();
  });
});

describe("전이 — idle · analyzing (ARCHITECTURE 상태도)", () => {
  it("idle → analyzing: 사진 장수를 상태가 보관한다 (부분 실패 배너의 분모)", () => {
    const state = 상태(분석시작);

    expect(state.status).toBe("analyzing");
    expect(state.photoCount).toBe(3);
  });

  it("analyzing → reviewing: 확인된 책 1권 이상", () => {
    const state = reviewing();

    expect(state.status).toBe("reviewing");
    expect(state.books).toEqual([{ origin: "photo", book: 확인된책() }]);
    expect(state.unidentified).toHaveLength(1);
  });

  it("analyzing → unidentifiedOnly: 후보는 있으나 확인 0건 — 빈 상태가 아니다", () => {
    const state = unidentifiedOnly();

    expect(state.status).toBe("unidentifiedOnly");
    expect(state.books).toEqual([]);
    expect(state.unidentified).toHaveLength(1);
  });

  it("analyzing → emptyShelf: 추출된 후보 0건(EMPTY_SHELF)", () => {
    expect(emptyShelf().status).toBe("emptyShelf");
  });

  it("analyzing → error: 전 사진 실패 또는 네트워크 오류", () => {
    const state = errorState();

    expect(state.status).toBe("error");
    expect(state.errorCode).toBe("UPSTREAM_UNAVAILABLE");
    expect(state.requestId).toBe("req-1");
  });

  it("응답의 절단·실패 카운트를 그대로 옮긴다", () => {
    const state = sessionReducer(상태(분석시작), {
      type: "ANALYZE_SUCCEEDED",
      result: 분석응답({
        overflowCount: 4,
        unidentifiedOverflowCount: 7,
        failedPhotoCount: 1,
        failedPhotoIndexes: [2],
      }),
    });

    expect(state.overflowCount).toBe(4);
    expect(state.unidentifiedOverflowCount).toBe(7);
    expect(state.failedPhotoIndexes).toEqual([2]);
  });
});

describe("전이 — 미확인 책의 승격 (US-002)", () => {
  it("unidentifiedOnly → reviewing: 직접 수정으로 1권 이상 확인", () => {
    const state = sessionReducer(unidentifiedOnly(), {
      type: "BOOK_RESOLVED",
      rawText: "총균쇠",
      book: 승격된책(),
    });

    expect(state.status).toBe("reviewing");
    expect(state.books).toEqual([{ origin: "resolved", book: 승격된책() }]);
    expect(state.unidentified).toEqual([]);
  });

  it("reviewing → reviewing: 미확인 책 수정·재검색", () => {
    const state = sessionReducer(reviewing(), {
      type: "BOOK_RESOLVED",
      rawText: "총균쇠",
      book: 승격된책(),
    });

    expect(state.status).toBe("reviewing");
    expect(state.books).toHaveLength(2);
    expect(state.unidentified).toEqual([]);
  });

  it("승격된 책에 photoIndex를 지어내지 않는다", () => {
    const state = sessionReducer(unidentifiedOnly(), {
      type: "BOOK_RESOLVED",
      rawText: "총균쇠",
      book: 승격된책(),
    });

    const [entry] = state.books;
    expect(entry.origin).toBe("resolved");
    expect(entry.book).not.toHaveProperty("photoIndex");
  });

  it("이미 책장에 있는 ISBN이면 미확인만 지우고 중복으로 담지 않는다 (FR-004)", () => {
    const state = sessionReducer(reviewing(), {
      type: "BOOK_RESOLVED",
      rawText: "총균쇠",
      book: 승격된책({ isbn13: isbn(1) }),
    });

    expect(state.books).toHaveLength(1);
    expect(state.unidentified).toEqual([]);
  });

  it("원문이 목록에 없으면 아무것도 바꾸지 않는다", () => {
    const before = reviewing();
    const after = sessionReducer(before, {
      type: "BOOK_RESOLVED",
      rawText: "없는 원문",
      book: 승격된책(),
    });

    expect(after).toBe(before);
  });

  it("확인된 책이 50권이면 승격을 무시한다 — 미확인 원문을 조용히 지우지 않는다 (FR-005)", () => {
    const 가득 = sessionReducer(상태(분석시작), {
      type: "ANALYZE_SUCCEEDED",
      result: 분석응답({
        identified: Array.from({ length: MAX_IDENTIFIED_BOOKS }, (_, i) =>
          확인된책({ isbn13: isbn(100 + i), proof: `proof-${i}` }),
        ),
        unidentified: [미확인책()],
      }),
    });

    const after = sessionReducer(가득, {
      type: "BOOK_RESOLVED",
      rawText: "총균쇠",
      book: 승격된책(),
    });

    expect(after).toBe(가득);
    expect(after.unidentified).toHaveLength(1);
  });
});

describe("전이 — 재시도와 처음으로", () => {
  it("unidentifiedOnly → analyzing: 실패한 사진만 재시도", () => {
    const before = unidentifiedOnly();
    const state = sessionReducer(before, { type: "ANALYZE_RETRIED", photoCount: 1 });

    expect(state.status).toBe("analyzing");
    expect(state.photoCount).toBe(1);
    // 재시도는 **이번에 보낸 사진**의 결과만 받는다. 읽어낸 원문을 여기서 버리면
    // 사용자가 손으로 고치던 미확인 목록이 응답에 없다는 이유로 사라진다.
    expect(state.unidentified).toEqual(before.unidentified);
  });

  it("error → analyzing: 재시도", () => {
    const state = sessionReducer(errorState(), { type: "ANALYZE_RETRIED", photoCount: 2 });

    expect(state.status).toBe("analyzing");
    expect(state.photoCount).toBe(2);
    expect(state.errorCode).toBeNull();
  });

  it.each<[SessionStatus, () => SessionState]>([
    ["emptyShelf", emptyShelf],
    ["unidentifiedOnly", unidentifiedOnly],
    ["result", result],
    ["error", errorState],
  ])("%s → idle: 다시 찍기·처음으로", (_status, build) => {
    const state = sessionReducer(build(), { type: "RESTARTED" });

    expect(state.status).toBe("idle");
    expect(state.sessionId).toBe(SESSION_ID);
    expect(state.books).toEqual([]);
    expect(state.unidentified).toEqual([]);
    expect(state.recommendations).toEqual([]);
    expect(state.errorCode).toBeNull();
  });

  it("사진 장수가 0이하면 analyzing으로 가지 않는다", () => {
    const before = createSessionState(SESSION_ID);

    expect(sessionReducer(before, { type: "ANALYZE_STARTED", photoCount: 0 })).toBe(before);
  });
});

describe("전이 — 기분 입력과 문답 (US-003·US-004)", () => {
  it("reviewing → moodInput: 추천 단계로 이동", () => {
    expect(moodInput().status).toBe("moodInput");
  });

  it("확인된 책이 0권이면 추천 단계로 가지 않는다", () => {
    const before = unidentifiedOnly();

    expect(sessionReducer(before, { type: "MOOD_STEP_ENTERED" })).toBe(before);
  });

  it("moodInput → guidedQuestions: 기분을 비운 채 진행", () => {
    const state = guidedQuestions();

    expect(state.status).toBe("guidedQuestions");
    expect(state.inputMode).toBe("guided");
  });

  it("질문 2~3개를 받으면 문답 화면에 담는다", () => {
    const state = sessionReducer(guidedQuestions(), {
      type: "QUESTIONS_RECEIVED",
      questions: 질문,
    });

    expect(state.status).toBe("guidedQuestions");
    expect(state.questions).toEqual(질문);
  });

  it("guidedQuestions → moodInput: 생성 실패(빈 배열)면 자유 입력으로 폴백한다", () => {
    const state = sessionReducer(guidedQuestions(), { type: "QUESTIONS_RECEIVED", questions: [] });

    expect(state.status).toBe("moodInput");
    expect(state.inputMode).toBe("free_text");
  });

  it("guidedQuestions → moodInput: 문답 건너뛰기", () => {
    const state = sessionReducer(guidedQuestions(), { type: "GUIDED_SKIPPED" });

    expect(state.status).toBe("moodInput");
    expect(state.questions).toEqual([]);
  });

  it("moodInput → recommending: 기분 텍스트 제출 (free_text)", () => {
    const state = recommending();

    expect(state.status).toBe("recommending");
    expect(state.mood).toBe("번아웃인데 가볍게");
    expect(state.inputMode).toBe("free_text");
  });

  it("guidedQuestions → recommending: 답변 제출 (guided)", () => {
    const state = sessionReducer(guidedQuestions(), {
      type: "ANSWERS_SUBMITTED",
      mood: "머리를 거의 안 쓰고, 하루 안에",
    });

    expect(state.status).toBe("recommending");
    expect(state.inputMode).toBe("guided");
  });

  it("공백을 떼면 2자 미만인 기분은 제출로 치지 않는다 (FR-007)", () => {
    const before = moodInput();

    expect(sessionReducer(before, { type: "MOOD_SUBMITTED", mood: "   " })).toBe(before);
    expect(sessionReducer(before, { type: "MOOD_SUBMITTED", mood: " 쉼 " }).status).toBe(
      "moodInput",
    );
  });

  it("기분 텍스트는 앞뒤 공백을 떼어 보관한다", () => {
    const state = sessionReducer(moodInput(), {
      type: "MOOD_SUBMITTED",
      mood: "  번아웃인데 가볍게  ",
    });

    expect(state.mood).toBe("번아웃인데 가볍게");
  });
});

describe("전이 — 추천 (US-003, FR-010)", () => {
  it("recommending → result: 추천 수신", () => {
    const state = result();

    expect(state.status).toBe("result");
    expect(state.recommendations).toEqual(추천);
    expect(state.shortfall).toBe(false);
  });

  it.each(["IRRELEVANT_MOOD", "RECOMMENDATION_VALIDATION_FAILED"] as const)(
    "recommending → moodInput: %s — 무관한 입력·검증 실패는 기분을 다시 받는다",
    (code) => {
      const state = sessionReducer(recommending(), {
        type: "RECOMMEND_FAILED",
        code,
        requestId: "req-3",
      });

      expect(state.status).toBe("moodInput");
      expect(state.errorCode).toBe(code);
    },
  );

  it.each(["UPSTREAM_UNAVAILABLE", "TIMEOUT", "UNVERIFIED_BOOKS", "INTERNAL_ERROR"] as const)(
    "recommending → error: %s",
    (code) => {
      const state = sessionReducer(recommending(), {
        type: "RECOMMEND_FAILED",
        code,
        requestId: "req-4",
      });

      expect(state.status).toBe("error");
      expect(state.errorCode).toBe(code);
      expect(state.requestId).toBe("req-4");
    },
  );

  it("result → moodInput: 다시 추천받기 — 횟수를 센다", () => {
    const state = sessionReducer(result(), { type: "RECOMMEND_AGAIN" });

    expect(state.status).toBe("moodInput");
    expect(state.recommendCount).toBe(1);
    expect(state.recommendations).toEqual([]);
  });

  it("재추천 5회를 소진하면 더 진행하지 않는다 (FR-010)", () => {
    let state = result();

    for (let i = 0; i < MAX_RECOMMEND_ATTEMPTS; i += 1) {
      expect(canRecommendAgain(state)).toBe(true);
      state = sessionReducer(state, { type: "RECOMMEND_AGAIN" });
      state = sessionReducer(state, { type: "MOOD_SUBMITTED", mood: "다른 기분" });
      state = sessionReducer(state, {
        type: "RECOMMEND_SUCCEEDED",
        recommendations: 추천,
        shortfall: false,
      });
    }

    expect(state.recommendCount).toBe(MAX_RECOMMEND_ATTEMPTS);
    expect(canRecommendAgain(state)).toBe(false);
    expect(sessionReducer(state, { type: "RECOMMEND_AGAIN" })).toBe(state);
  });

  it("새 사진으로 시작해도 재추천 횟수는 초기화되지 않는다 — 상한은 세션당이다", () => {
    const state = sessionReducer(
      sessionReducer(result(), { type: "RECOMMEND_AGAIN" }),
      { type: "MOOD_SUBMITTED", mood: "다른 기분" },
    );
    const 다시 = sessionReducer(
      sessionReducer(state, {
        type: "RECOMMEND_SUCCEEDED",
        recommendations: 추천,
        shortfall: false,
      }),
      { type: "RESTARTED" },
    );

    expect(다시.status).toBe("idle");
    expect(다시.recommendCount).toBe(1);
  });
});

describe("정의되지 않은 전이 — 던지지 않고 상태를 그대로 돌려준다", () => {
  const 모든상태: Array<[string, SessionStatus, () => SessionState]> = [
    ["idle", "idle", () => createSessionState(SESSION_ID)],
    ["analyzing", "analyzing", () => 상태(분석시작)],
    ["reviewing", "reviewing", reviewing],
    ["unidentifiedOnly", "unidentifiedOnly", unidentifiedOnly],
    ["emptyShelf", "emptyShelf", emptyShelf],
    ["moodInput", "moodInput", moodInput],
    ["guidedQuestions", "guidedQuestions", guidedQuestions],
    ["recommending", "recommending", recommending],
    ["result", "result", result],
    ["error(분석 실패)", "error", errorState],
    ["error(추천 실패)", "error", recommendErrorState],
  ];

  const 모든액션: SessionAction[] = [
    { type: "ANALYZE_STARTED", photoCount: 2 },
    { type: "ANALYZE_RETRIED", photoCount: 1 },
    { type: "ANALYZE_SUCCEEDED", result: 분석응답() },
    { type: "ANALYZE_FAILED", code: "UPSTREAM_UNAVAILABLE", requestId: null },
    { type: "BOOK_RESOLVED", rawText: "총균쇠", book: 승격된책() },
    { type: "MOOD_STEP_ENTERED" },
    { type: "GUIDED_MODE_ENTERED" },
    { type: "QUESTIONS_RECEIVED", questions: 질문 },
    { type: "GUIDED_SKIPPED" },
    { type: "MOOD_SUBMITTED", mood: "가볍게" },
    { type: "ANSWERS_SUBMITTED", mood: "가볍게" },
    { type: "RECOMMEND_SUCCEEDED", recommendations: 추천, shortfall: false },
    { type: "RECOMMEND_FAILED", code: "TIMEOUT", requestId: null },
    { type: "RECOMMEND_AGAIN" },
    { type: "RECOMMEND_RETRIED" },
    { type: "MOOD_REENTERED" },
    { type: "RESTARTED" },
  ];

  /** 상태도에 있는 (출발 상태 → 액션) 조합 */
  const 허용된조합: Record<string, SessionStatus[]> = {
    ANALYZE_STARTED: ["idle"],
    // `reviewing`이 여기 있는 이유: 부분 실패 배너의 "이 사진만 다시 시도"는 확인된
    // 책이 이미 있는 화면에서 눌린다. 빠져 있으면 그 버튼이 아무것도 하지 않는다.
    ANALYZE_RETRIED: ["reviewing", "unidentifiedOnly", "error"],
    ANALYZE_SUCCEEDED: ["analyzing"],
    ANALYZE_FAILED: ["analyzing"],
    BOOK_RESOLVED: ["reviewing", "unidentifiedOnly"],
    MOOD_STEP_ENTERED: ["reviewing"],
    GUIDED_MODE_ENTERED: ["moodInput"],
    QUESTIONS_RECEIVED: ["guidedQuestions"],
    GUIDED_SKIPPED: ["guidedQuestions"],
    MOOD_SUBMITTED: ["moodInput"],
    ANSWERS_SUBMITTED: ["guidedQuestions"],
    RECOMMEND_SUCCEEDED: ["recommending"],
    RECOMMEND_FAILED: ["recommending"],
    RECOMMEND_AGAIN: ["result"],
    // 이 둘은 error에서만 나가지만 `failedStage`까지 봐야 유효하다. 단계별
    // 좁히기는 아래 "실패 단계가 나가는 문을 고른다"가 따로 검사한다.
    RECOMMEND_RETRIED: ["error"],
    MOOD_REENTERED: ["error"],
    RESTARTED: ["emptyShelf", "unidentifiedOnly", "result", "error"],
  };

  it.each(모든상태)(
    "%s에서 상태도에 없는 액션은 같은 상태 객체를 그대로 돌려준다",
    (_label, status, build) => {
    for (const action of 모든액션) {
      if (허용된조합[action.type].includes(status)) continue;

      const before = build();
      expect(sessionReducer(before, action)).toBe(before);
    }
    },
  );

  it("알 수 없는 액션에도 던지지 않는다", () => {
    const before = reviewing();

    expect(sessionReducer(before, { type: "NOT_AN_ACTION" } as unknown as SessionAction)).toBe(
      before,
    );
  });
});

describe("전이 — 추천 실패에서의 회복 (ARCHITECTURE 상태 관리)", () => {
  it("error → recommending: 직전 기분을 그대로 들고 간다 — 다시 묻지 않는다", () => {
    const before = recommendErrorState();
    const state = sessionReducer(before, { type: "RECOMMEND_RETRIED" });

    expect(state.status).toBe("recommending");
    expect(state.mood).toBe("번아웃인데 가볍게");
    expect(state.inputMode).toBe("free_text");
    // 책장이 그대로다 — 회복에 재분석이 끼지 않는다.
    expect(state.books).toEqual(before.books);
    expect(state.errorCode).toBeNull();
    expect(state.failedStage).toBeNull();
    expect(state.requestId).toBeNull();
  });

  it("error → recommending: 재추천 횟수를 올린다 — 실패한 호출도 청구된다", () => {
    const state = sessionReducer(recommendErrorState(), { type: "RECOMMEND_RETRIED" });

    expect(state.recommendCount).toBe(1);
  });

  it("재추천 상한을 소진하면 같은 기분 재시도도 막힌다 (FR-010)", () => {
    let state = recommendErrorState();

    for (let i = 0; i < MAX_RECOMMEND_ATTEMPTS; i += 1) {
      state = sessionReducer(state, { type: "RECOMMEND_RETRIED" });
      expect(state.status).toBe("recommending");
      state = sessionReducer(state, {
        type: "RECOMMEND_FAILED",
        code: "UPSTREAM_UNAVAILABLE",
        requestId: "req-loop",
      });
    }

    expect(state.recommendCount).toBe(MAX_RECOMMEND_ATTEMPTS);
    expect(canRecommendAgain(state)).toBe(false);
    // 상한 없는 유료 호출 루프가 되지 않는다.
    expect(sessionReducer(state, { type: "RECOMMEND_RETRIED" })).toBe(state);
  });

  it("error → moodInput: 기분을 다르게 쓰는 경로 — 횟수를 올리지 않는다", () => {
    const state = sessionReducer(recommendErrorState(), { type: "MOOD_REENTERED" });

    expect(state.status).toBe("moodInput");
    expect(state.recommendCount).toBe(0);
    expect(state.errorCode).toBeNull();
    expect(state.failedStage).toBeNull();
  });
});

describe("실패 단계가 나가는 문을 고른다 (error의 failedStage)", () => {
  it("분석 실패는 analyze, 추천 실패는 recommend로 기록된다", () => {
    expect(errorState().failedStage).toBe("analyze");
    expect(recommendErrorState().failedStage).toBe("recommend");
  });

  it.each(["RECOMMEND_RETRIED", "MOOD_REENTERED"] as const)(
    "분석 실패로 들어온 error에서 %s는 무시된다",
    (type) => {
      const before = errorState();

      expect(sessionReducer(before, { type })).toBe(before);
    },
  );

  it("추천 실패로 들어온 error에서 ANALYZE_RETRIED는 무시된다", () => {
    const before = recommendErrorState();

    // 추천 한 번의 장애에 분석 비용을 다시 내게 하는 문이다. 열려 있으면 안 된다.
    expect(sessionReducer(before, { type: "ANALYZE_RETRIED", photoCount: 2 })).toBe(before);
  });

  it.each<[string, () => SessionState]>([
    ["idle", () => createSessionState(SESSION_ID)],
    ["analyzing", () => 상태(분석시작)],
    ["reviewing", reviewing],
    ["unidentifiedOnly", unidentifiedOnly],
    ["emptyShelf", emptyShelf],
    ["moodInput", moodInput],
    ["guidedQuestions", guidedQuestions],
    ["recommending", recommending],
    ["result", result],
  ])("error가 아닌 %s에서는 failedStage가 비어 있다", (_status, build) => {
    expect(build().failedStage).toBeNull();
  });

  it("실패에서 회복한 뒤에도 failedStage가 따라다니지 않는다", () => {
    const 회복 = sessionReducer(errorState(), { type: "ANALYZE_RETRIED", photoCount: 2 });
    const 성공 = sessionReducer(회복, { type: "ANALYZE_SUCCEEDED", result: 분석응답() });

    expect(성공.status).toBe("reviewing");
    expect(성공.failedStage).toBeNull();
  });

  it("emptyShelf는 error가 아니므로 failedStage를 갖지 않는다", () => {
    expect(emptyShelf().errorCode).toBe("EMPTY_SHELF");
    expect(emptyShelf().failedStage).toBeNull();
  });
});

/**
 * 상태도와 리듀서가 갈라지는 것이 이 파일이 막는 결함의 원형이다 — 상태도에
 * `error → recommending`이 없던 동안 리듀서에도 없었고, 그래서 추천 한 번의 장애에
 * 전체 재분석을 요구했다. 아래 표는 ARCHITECTURE 상태도의 전이를 한 줄씩 옮긴 것이며
 * **개수까지 고정한다.** 상태도가 늘면 이 표가 먼저 깨진다.
 */
describe("상태도 전수 대조 — 전이 26개", () => {
  interface 전이 {
    from: string;
    to: SessionStatus;
    action: SessionAction;
    build: () => SessionState;
  }

  const 전이표: 전이[] = [
    { from: "idle", to: "analyzing", build: () => createSessionState(SESSION_ID), action: 분석시작 },
    {
      from: "analyzing",
      to: "reviewing",
      build: () => 상태(분석시작),
      action: { type: "ANALYZE_SUCCEEDED", result: 분석응답() },
    },
    {
      from: "analyzing",
      to: "unidentifiedOnly",
      build: () => 상태(분석시작),
      action: {
        type: "ANALYZE_SUCCEEDED",
        result: 분석응답({ identified: [], unidentified: [미확인책()] }),
      },
    },
    {
      from: "analyzing",
      to: "emptyShelf",
      build: () => 상태(분석시작),
      action: { type: "ANALYZE_FAILED", code: "EMPTY_SHELF", requestId: null },
    },
    {
      from: "analyzing",
      to: "error",
      build: () => 상태(분석시작),
      action: { type: "ANALYZE_FAILED", code: "UPSTREAM_UNAVAILABLE", requestId: null },
    },
    { from: "emptyShelf", to: "idle", build: emptyShelf, action: { type: "RESTARTED" } },
    {
      from: "unidentifiedOnly",
      to: "reviewing",
      build: unidentifiedOnly,
      action: { type: "BOOK_RESOLVED", rawText: "총균쇠", book: 승격된책() },
    },
    {
      from: "unidentifiedOnly",
      to: "analyzing",
      build: unidentifiedOnly,
      action: { type: "ANALYZE_RETRIED", photoCount: 1 },
    },
    { from: "unidentifiedOnly", to: "idle", build: unidentifiedOnly, action: { type: "RESTARTED" } },
    {
      from: "reviewing",
      to: "reviewing",
      build: reviewing,
      action: { type: "BOOK_RESOLVED", rawText: "총균쇠", book: 승격된책() },
    },
    {
      from: "reviewing",
      to: "analyzing",
      build: reviewing,
      action: { type: "ANALYZE_RETRIED", photoCount: 1 },
    },
    { from: "reviewing", to: "moodInput", build: reviewing, action: { type: "MOOD_STEP_ENTERED" } },
    {
      from: "moodInput",
      to: "guidedQuestions",
      build: moodInput,
      action: { type: "GUIDED_MODE_ENTERED" },
    },
    {
      from: "guidedQuestions",
      to: "guidedQuestions",
      build: guidedQuestions,
      action: { type: "QUESTIONS_RECEIVED", questions: 질문 },
    },
    {
      from: "guidedQuestions",
      to: "moodInput",
      build: guidedQuestions,
      action: { type: "GUIDED_SKIPPED" },
    },
    {
      from: "guidedQuestions",
      to: "recommending",
      build: guidedQuestions,
      action: { type: "ANSWERS_SUBMITTED", mood: "가볍게 하루 안에" },
    },
    {
      from: "moodInput",
      to: "recommending",
      build: moodInput,
      action: { type: "MOOD_SUBMITTED", mood: "번아웃인데 가볍게" },
    },
    {
      from: "recommending",
      to: "result",
      build: recommending,
      action: { type: "RECOMMEND_SUCCEEDED", recommendations: 추천, shortfall: false },
    },
    {
      from: "recommending",
      to: "moodInput",
      build: recommending,
      action: { type: "RECOMMEND_FAILED", code: "IRRELEVANT_MOOD", requestId: null },
    },
    {
      from: "recommending",
      to: "error",
      build: recommending,
      action: { type: "RECOMMEND_FAILED", code: "UPSTREAM_UNAVAILABLE", requestId: null },
    },
    { from: "result", to: "moodInput", build: result, action: { type: "RECOMMEND_AGAIN" } },
    { from: "result", to: "idle", build: result, action: { type: "RESTARTED" } },
    {
      from: "error(분석 실패)",
      to: "analyzing",
      build: errorState,
      action: { type: "ANALYZE_RETRIED", photoCount: 2 },
    },
    {
      from: "error(추천 실패)",
      to: "recommending",
      build: recommendErrorState,
      action: { type: "RECOMMEND_RETRIED" },
    },
    {
      from: "error(추천 실패)",
      to: "moodInput",
      build: recommendErrorState,
      action: { type: "MOOD_REENTERED" },
    },
    { from: "error(분석 실패)", to: "idle", build: errorState, action: { type: "RESTARTED" } },
  ];

  it("리듀서가 아는 전이는 정확히 26개다 (상태도와 같은 수)", () => {
    expect(전이표).toHaveLength(26);
  });

  it.each(전이표.map((t): [string, SessionStatus, 전이] => [t.from, t.to, t]))(
    "%s → %s",
    (_from, to, 전이) => {
      expect(sessionReducer(전이.build(), 전이.action).status).toBe(to);
    },
  );
});

/**
 * 합치기 규칙 자체 (`mergeShelfBooks` · `mergeUnidentified`).
 *
 * 재시도 응답은 **이번에 보낸 사진**의 결과일 뿐이라, 앞 회차에서 확인된 책은
 * 응답에 없다. 덮어쓰면 성공했던 사진의 책이 조용히 사라진다.
 */
describe("합치기 — mergeShelfBooks · mergeUnidentified", () => {
  function 사진책(n: number, overrides: Partial<IdentifiedBook> = {}): ShelfBook {
    return {
      origin: "photo",
      book: 확인된책({ isbn13: isbn(n), proof: `proof-${n}`, ...overrides }),
    };
  }

  function 승격책(n: number, overrides: Partial<ResolvedCandidate> = {}): ShelfBook {
    return {
      origin: "resolved",
      book: 승격된책({ isbn13: isbn(n), proof: `resolved-${n}`, ...overrides }),
    };
  }

  it("prev를 앞에 두고 next를 뒤에 이어 붙인다", () => {
    expect(mergeShelfBooks([사진책(1)], [사진책(2), 사진책(3)])).toEqual([
      사진책(1),
      사진책(2),
      사진책(3),
    ]);
  });

  it("같은 isbn13은 첫 등장만 남는다 — 남는 쪽은 prev다", () => {
    const 먼저 = 사진책(1, { claudeNote: "처음 읽은 메모", proof: "proof-first" });
    const 나중 = 사진책(1, { claudeNote: "다시 읽은 메모", proof: "proof-second" });

    expect(mergeShelfBooks([먼저], [나중])).toEqual([먼저]);
  });

  it("photoIndex를 보지 않는다 — 나중 사본의 좌표가 더 작아도 prev가 남는다", () => {
    // 재시도 응답의 photoIndex는 **이번에 보낸 배열** 기준이라 0부터 다시 매겨진다.
    // 최솟값을 남기는 방식(merge.ts의 dedupeByIsbn)을 쓰면 여기서 나중 사본이 이긴다.
    const 먼저 = 사진책(1, { photoIndex: 2, proof: "proof-first" });
    const 나중 = 사진책(1, { photoIndex: 0, proof: "proof-second" });

    expect(mergeShelfBooks([먼저], [나중])).toEqual([먼저]);
  });

  it("origin을 비교에 쓰지 않는다 — 손으로 승격한 책이 사진 사본에 밀리지 않는다", () => {
    const 승격 = 승격책(1);

    expect(mergeShelfBooks([승격], [사진책(1)])).toEqual([승격]);
  });

  it("합친 길이가 상한을 넘으면 앞에서부터 그 수까지만 남는다", () => {
    const prev = Array.from({ length: MAX_IDENTIFIED_BOOKS }, (_, i) => 사진책(100 + i));
    const merged = mergeShelfBooks(prev, [사진책(900)]);

    expect(merged).toHaveLength(MAX_IDENTIFIED_BOOKS);
    // 밀려나는 것은 새로 온 쪽이다 — 먼저 확인된 책이 뒤로 밀리지 않는다.
    expect(merged).toEqual(prev);
  });

  it("인자를 변형하지 않는다", () => {
    const prev = [사진책(1)];
    const next = [사진책(1), 사진책(2)];

    mergeShelfBooks(prev, next);

    expect(prev).toEqual([사진책(1)]);
    expect(next).toEqual([사진책(1), 사진책(2)]);
  });

  it("미확인은 rawText 기준으로 첫 등장만 남긴다 — isbn13이 없기 때문이다", () => {
    const 먼저 = 미확인책({ rawText: "총균쇠", reason: "no_match" });
    const 나중 = 미확인책({ rawText: "총균쇠", reason: "lookup_failed" });

    expect(mergeUnidentified([먼저], [나중, 미확인책({ rawText: "코스모ㅅ" })])).toEqual([
      먼저,
      미확인책({ rawText: "코스모ㅅ" }),
    ]);
  });

  it("미확인의 상한은 MAX_UNIDENTIFIED_BOOKS다", () => {
    const prev = Array.from({ length: MAX_UNIDENTIFIED_BOOKS }, (_, i) =>
      미확인책({ rawText: `원문 ${i}` }),
    );
    const merged = mergeUnidentified(prev, [미확인책({ rawText: "밀려나는 원문" })]);

    expect(merged).toHaveLength(MAX_UNIDENTIFIED_BOOKS);
    expect(merged).toEqual(prev);
  });
});

/**
 * reviewing에서의 재시도 (US-001 부분 실패 회복).
 *
 * 이 블록이 막는 결함은 둘이다 — ① `reviewing`에서 `ANALYZE_RETRIED`가 아무것도
 * 하지 않아 "이 사진만 다시 시도"가 화면을 바꾸지 못하는 것, ② 전이는 되지만
 * 응답이 책장을 **덮어써** 앞 회차에서 확인된 책이 사라지는 것. 하나가 고쳐지고
 * 다른 하나가 남는 구현이 실재하므로 아래 it 블록은 서로 나뉘어 있다.
 */
describe("전이 — reviewing에서의 재시도와 책장 보존", () => {
  /** 재시도를 걸어 analyzing까지 간다 */
  function 재시도(from: SessionState, photoCount: number): SessionState {
    return sessionReducer(from, { type: "ANALYZE_RETRIED", photoCount });
  }

  it("reviewing → analyzing: 확인된 책이 있어도 재시도는 분석 화면으로 간다", () => {
    const state = 재시도(reviewing(), 1);

    expect(state.status).toBe("analyzing");
    expect(state.photoCount).toBe(1);
  });

  it("재시도 진입은 지난 회차의 실패 흔적만 지운다", () => {
    const 부분실패 = 상태(분석시작, {
      type: "ANALYZE_SUCCEEDED",
      result: 분석응답({
        unidentified: [미확인책()],
        overflowCount: 3,
        unidentifiedOverflowCount: 5,
        failedPhotoCount: 1,
        failedPhotoIndexes: [2],
      }),
    });

    const state = 재시도(부분실패, 1);

    expect(state.failedPhotoIndexes).toEqual([]);
    expect(state.overflowCount).toBe(0);
    expect(state.unidentifiedOverflowCount).toBe(0);
    expect(state.errorCode).toBeNull();
    expect(state.failedStage).toBeNull();
    expect(state.requestId).toBeNull();
    // 지우는 것은 실패 흔적뿐이다. 읽어낸 것은 그대로 들고 들어간다.
    expect(state.books).toEqual(부분실패.books);
    expect(state.unidentified).toEqual(부분실패.unidentified);
    expect(state.recommendCount).toBe(부분실패.recommendCount);
    expect(state.sessionId).toBe(SESSION_ID);
  });

  it("사진 장수가 정수가 아니거나 1 미만이면 reviewing에서도 전이하지 않는다", () => {
    const before = reviewing();

    expect(재시도(before, 0)).toBe(before);
    expect(재시도(before, -1)).toBe(before);
    expect(재시도(before, 1.5)).toBe(before);
  });

  it("재시도 성공 응답에 없는 책도 책장에 남는다 (AC-2 — 전이와 별개다)", () => {
    const 진행중 = 재시도(reviewing(), 1);
    const 다른책 = 확인된책({ isbn13: isbn(7), title: "코스모스", proof: "proof-7" });

    const state = sessionReducer(진행중, {
      type: "ANALYZE_SUCCEEDED",
      result: 분석응답({ identified: [다른책] }),
    });

    expect(state.status).toBe("reviewing");
    // 이번 응답은 이번에 보낸 사진의 결과일 뿐이다. 1번은 앞 회차의 성과다.
    expect(state.books).toEqual([
      { origin: "photo", book: 확인된책() },
      { origin: "photo", book: 다른책 },
    ]);
  });

  it("전체 재전송으로 같은 isbn13이 다시 와도 한 권만 남고, 남는 것은 재시도 전 항목이다", () => {
    const 먼저 = 확인된책({ photoIndex: 2, claudeNote: "처음 읽은 메모", proof: "proof-first" });
    // 재시도 응답의 좌표는 이번에 보낸 배열 기준이라 0으로 다시 매겨진다.
    const 나중 = 확인된책({ photoIndex: 0, claudeNote: "다시 읽은 메모", proof: "proof-second" });
    const 전 = 상태(분석시작, {
      type: "ANALYZE_SUCCEEDED",
      result: 분석응답({ identified: [먼저] }),
    });

    const state = sessionReducer(재시도(전, 2), {
      type: "ANALYZE_SUCCEEDED",
      result: 분석응답({ identified: [나중] }),
    });

    expect(state.books).toHaveLength(1);
    expect(state.books).toEqual([{ origin: "photo", book: 먼저 }]);
  });

  it("미확인 목록도 합쳐지고 같은 원문은 한 번만 남는다", () => {
    const state = sessionReducer(재시도(reviewing(), 1), {
      type: "ANALYZE_SUCCEEDED",
      result: 분석응답({
        identified: [],
        unidentified: [미확인책(), 미확인책({ rawText: "코스모ㅅ 칼세이건" })],
      }),
    });

    expect(state.unidentified.map((book) => book.rawText)).toEqual(["총균쇠", "코스모ㅅ 칼세이건"]);
  });

  it("직접 확인해 승격한 책은 재시도 뒤에도 남는다", () => {
    const 승격후 = sessionReducer(reviewing(), {
      type: "BOOK_RESOLVED",
      rawText: "총균쇠",
      book: 승격된책(),
    });

    const state = sessionReducer(재시도(승격후, 1), {
      type: "ANALYZE_SUCCEEDED",
      result: 분석응답({ identified: [], unidentified: [] }),
    });

    expect(state.status).toBe("reviewing");
    expect(state.books).toContainEqual({ origin: "resolved", book: 승격된책() });
  });

  it("합친 결과가 0권이면 unidentifiedOnly로 간다", () => {
    const state = sessionReducer(재시도(unidentifiedOnly(), 1), {
      type: "ANALYZE_SUCCEEDED",
      result: 분석응답({ identified: [], unidentified: [미확인책({ rawText: "다른 원문" })] }),
    });

    expect(state.status).toBe("unidentifiedOnly");
    expect(state.books).toEqual([]);
    expect(state.unidentified).toHaveLength(2);
  });

  it("실패한 사진 목록과 장수는 누적이 아니라 이번 회차 값으로 교체된다 (AC-5)", () => {
    const 전 = 상태(분석시작, {
      type: "ANALYZE_SUCCEEDED",
      result: 분석응답({ failedPhotoCount: 2, failedPhotoIndexes: [1, 2] }),
    });
    expect(전.failedPhotoIndexes).toEqual([1, 2]);
    expect(전.photoCount).toBe(3);

    // 실패한 2장만 다시 보낸다. 다음 응답의 좌표는 그 2장 배열 기준이다.
    const state = sessionReducer(재시도(전, 2), {
      type: "ANALYZE_SUCCEEDED",
      result: 분석응답({ failedPhotoCount: 1, failedPhotoIndexes: [0] }),
    });

    expect(state.failedPhotoIndexes).toEqual([0]);
    // 부분 실패 배너의 분모는 **이번에 보낸 장수**다. 3이면 사용자가 고치지 않은
    // 사진까지 분모에 들어간다.
    expect(state.photoCount).toBe(2);
  });

  it("초과 카운트 둘도 이번 응답 값으로 교체된다", () => {
    const 전 = 상태(분석시작, {
      type: "ANALYZE_SUCCEEDED",
      result: 분석응답({ overflowCount: 4, unidentifiedOverflowCount: 7 }),
    });

    const state = sessionReducer(재시도(전, 1), {
      type: "ANALYZE_SUCCEEDED",
      result: 분석응답({ overflowCount: 1, unidentifiedOverflowCount: 0 }),
    });

    expect(state.overflowCount).toBe(1);
    expect(state.unidentifiedOverflowCount).toBe(0);
  });

  it("재시도가 실패해도 책장이 비지 않고, 그 error에서 다시 재시도해도 유지된다 (AC-6)", () => {
    const 전 = reviewing();

    const 실패 = sessionReducer(재시도(전, 2), {
      type: "ANALYZE_FAILED",
      code: "UPSTREAM_UNAVAILABLE",
      requestId: "req-retry",
    });

    expect(실패.status).toBe("error");
    expect(실패.failedStage).toBe("analyze");
    // "error에는 책이 0권"이라는 전제는 이 경로가 열린 순간 깨진다.
    expect(실패.books).toEqual(전.books);
    expect(실패.unidentified).toEqual(전.unidentified);

    const 다시 = sessionReducer(실패, { type: "ANALYZE_RETRIED", photoCount: 2 });

    expect(다시.status).toBe("analyzing");
    // 두 번째 재시도가 첫 재시도가 지킨 책을 지우지 않는다.
    expect(다시.books).toEqual(전.books);
    expect(다시.unidentified).toEqual(전.unidentified);
  });

  it("새 사진으로 시작하는 분석은 여전히 세션을 비운다 — 합치기가 새 분석까지 오염시키지 않는다", () => {
    // 책장을 들고 error까지 간 뒤 "처음으로"를 누른 경로다. 상태도에 reviewing에서
    // 곧장 나가는 RESTARTED는 없다.
    const 실패 = sessionReducer(재시도(reviewing(), 2), {
      type: "ANALYZE_FAILED",
      code: "UPSTREAM_UNAVAILABLE",
      requestId: "req-restart",
    });
    expect(실패.books).toHaveLength(1);

    const 처음으로 = sessionReducer(실패, { type: "RESTARTED" });
    const 새분석 = sessionReducer(처음으로, 분석시작);

    expect(새분석.status).toBe("analyzing");
    expect(새분석.books).toEqual([]);
    expect(새분석.unidentified).toEqual([]);

    const 새책 = 확인된책({ isbn13: isbn(9), title: "다른 책장의 책", proof: "proof-9" });
    const state = sessionReducer(새분석, {
      type: "ANALYZE_SUCCEEDED",
      result: 분석응답({ identified: [새책] }),
    });

    // 옛 책장이 새 세션에 묻어 오지 않는다.
    expect(state.books).toEqual([{ origin: "photo", book: 새책 }]);
    expect(state.unidentified).toEqual([]);
  });
});

describe("셀렉터 — 요청 경계용 최소 형태", () => {
  function 섞인책장(): SessionState {
    return sessionReducer(reviewing(), {
      type: "BOOK_RESOLVED",
      rawText: "총균쇠",
      book: 승격된책(),
    });
  }

  it("toBookReferences는 isbn13·title·author·proof만 담는다 (bookReferenceSchema)", () => {
    expect(toBookReferences(섞인책장())).toEqual([
      { isbn13: isbn(1), title: "미움받을 용기", author: "기시미 이치로", proof: "proof-1" },
      { isbn13: isbn(2), title: "총, 균, 쇠", author: "재레드 다이아몬드", proof: "proof-2" },
    ]);
  });

  it("toRecommendBooks는 승격분의 claudeNote를 빈 문자열로 채운다 (recommendBookSchema)", () => {
    const books = toRecommendBooks(섞인책장());

    expect(books).toEqual([
      {
        isbn13: isbn(1),
        title: "미움받을 용기",
        author: "기시미 이치로",
        pages: 336,
        claudeNote: "대화체라 술술 읽힌다",
        proof: "proof-1",
      },
      {
        isbn13: isbn(2),
        title: "총, 균, 쇠",
        author: "재레드 다이아몬드",
        pages: 750,
        claudeNote: "",
        proof: "proof-2",
      },
    ]);
  });

  it("hasVerifiedBooks는 확인된 책이 1권 이상일 때만 참이다", () => {
    expect(hasVerifiedBooks(unidentifiedOnly())).toBe(false);
    expect(hasVerifiedBooks(reviewing())).toBe(true);
  });

  it("canRecommendAgain은 초기 세션에서 참이다", () => {
    expect(canRecommendAgain(createSessionState(SESSION_ID))).toBe(true);
  });
});
