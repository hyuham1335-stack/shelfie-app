/**
 * 세션 셸의 배선 테스트 (TR-011).
 *
 * 여기서 검사하는 것은 화면의 모양이 아니라 **잇는 방식**이다. 화면 5종은 각자
 * 테스트를 갖고 있으므로, 이 파일은 그것들 사이에서만 관찰되는 계약을 고정한다.
 *
 * 세 가지는 회귀 테스트다. 삭제하지 마라.
 * ① `ambiguous` 승격은 `isbn13`이 일치할 때만 목록에 합류한다 (ADR-002·ADR-006).
 * ② `recommend_viewed`를 클라이언트가 보내지 않는다 — 라우트가 정본이고,
 *    둘 다 보내면 North Star의 분모가 이중 계상된다 (PRD 7번).
 * ③ 부분 실패 배너의 분모(`photoCount`)는 응답이 아니라 업로드에서 온다.
 * ④ 세션이 들고 다니는 것은 **원본 `File`**이고 재시도는 그 원본에서 다시 리사이즈한다.
 *    파생값을 재사용하면 EXIF·품질·짧은 변 판정을 되돌릴 근거가 사라진다.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApiResult } from "@/lib/api-client";
import type { AnalyzeResponse, MoodQuestionsResponse, RecommendResponse } from "@/types/api";
import type { IdentifiedBook, ResolvedCandidate, UnidentifiedBook } from "@/types/book";

vi.mock("@/lib/api-client", () => ({
  analyzePhotos: vi.fn(),
  resolveBook: vi.fn(),
  fetchMoodQuestions: vi.fn(),
  requestRecommendations: vi.fn(),
  sendClientEvent: vi.fn(() => Promise.resolve()),
}));

/**
 * 저장 이미지 모듈은 캔버스를 만진다 — jsdom에는 canvas 구현이 없어 실물로는 한 줄도
 * 돌지 않는다 (ADR-009). 이 파일이 검사할 것은 "무엇을 넘겨 부르는가"이므로 가짜로 건다.
 */
vi.mock("@/lib/share-image", () => ({
  renderShareImage: vi.fn(),
}));

/**
 * 리사이즈는 캔버스를 만지므로 jsdom에서는 한 줄도 돌지 않는다. 이 파일이 검사할 것은
 * "재시도가 무엇을 입력으로 삼는가"이므로 **`resizeToDataUri`만** 가짜로 걸고,
 * 전송 예산(`checkOutputBudget`)은 실물을 그대로 쓴다 — 상한이 조용히 사라지지
 * 않았음을 이 파일에서도 확인해야 하기 때문이다.
 */
vi.mock("@/lib/image", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/image")>()),
  resizeToDataUri: vi.fn(),
}));

/**
 * 업로드 화면은 파일 선택·리사이즈를 스스로 하며 자기 테스트를 갖고 있다.
 * 이 파일이 검사할 것은 그 화면이 넘겨주는 값을 페이지가 어떻게 쓰는가이므로,
 * 콜백만 남긴 스텁으로 바꿔 둔다.
 */
vi.mock("@/components/upload/UploadScreen", () => ({
  UploadScreen: ({
    onAnalyze,
    isAnalyzing,
  }: {
    onAnalyze: (files: File[], dataUris: string[]) => void;
    isAnalyzing?: boolean;
  }) => (
    <div>
      <p>업로드 화면</p>
      {isAnalyzing === true && <p>분석 중</p>}
      <button type="button" onClick={() => onAnalyze(FILES, IMAGES)}>
        사진 2장 분석
      </button>
    </div>
  ),
}));

import Home from "./page";
import {
  analyzePhotos,
  fetchMoodQuestions,
  requestRecommendations,
  resolveBook,
  sendClientEvent,
} from "@/lib/api-client";
import { renderShareImage } from "@/lib/share-image";
import { resizeToDataUri } from "@/lib/image";

/** 업로드 화면이 방금 원본에서 만들어 곁들여 넘기는 파생값. 첫 요청에만 쓰인다 */
const IMAGES = ["data:image/jpeg;base64,AAAA", "data:image/jpeg;base64,BBBB"];

/** 세션이 보존하는 원본. 재시도는 언제나 여기서 출발한다 */
const FILES = [
  new File([new Uint8Array([1, 1])], "shelf-a.jpg", { type: "image/jpeg" }),
  new File([new Uint8Array([2, 2])], "shelf-b.jpg", { type: "image/jpeg" }),
];

const analyzeMock = vi.mocked(analyzePhotos);
const resolveMock = vi.mocked(resolveBook);
const questionsMock = vi.mocked(fetchMoodQuestions);
const recommendMock = vi.mocked(requestRecommendations);
const eventMock = vi.mocked(sendClientEvent);
const shareMock = vi.mocked(renderShareImage);
const resizeMock = vi.mocked(resizeToDataUri);

/** 회차마다 다른 값을 돌려준다 — 첫 호출 결과를 재사용하면 이 번호가 늘지 않는다 */
let resizeCallCount = 0;
function resizedUri(file: File, nth: number): string {
  return `data:image/jpeg;base64,RESIZED-${file.name}-${nth}`;
}

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function makeIdentified(overrides: Partial<IdentifiedBook> = {}): IdentifiedBook {
  return {
    isbn13: "9788934972464",
    title: "코스모스",
    author: "칼 세이건",
    publisher: "사이언스북스",
    coverUrl: "https://image.aladin.co.kr/product/1/1/cover/8934972467.jpg",
    pages: 719,
    aladinRating: 8.6,
    aladinLink: "https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=1",
    claudeNote: "우주를 다루는데 문장이 다정하다",
    photoIndex: 0,
    proof: "proof-cosmos",
    ...overrides,
  };
}

function makeResolved(overrides: Partial<ResolvedCandidate> = {}): ResolvedCandidate {
  return {
    isbn13: "9788937460777",
    title: "데미안",
    author: "헤르만 헤세",
    publisher: "민음사",
    coverUrl: "https://image.aladin.co.kr/product/2/2/cover/8937460777.jpg",
    pages: 240,
    aladinRating: 9.1,
    aladinLink: "https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=2",
    proof: "proof-demian",
    ...overrides,
  };
}

function makeAmbiguous(): UnidentifiedBook {
  return {
    rawText: "데미안 헤세",
    reason: "ambiguous",
    candidates: [
      {
        isbn13: "9788937460777",
        title: "데미안",
        author: "헤르만 헤세",
        publisher: "민음사",
        coverUrl: "https://image.aladin.co.kr/product/2/2/cover/8937460777.jpg",
      },
    ],
  };
}

function makeAnalyze(overrides: Partial<AnalyzeResponse> = {}): AnalyzeResponse {
  return {
    sessionId: "00000000-0000-4000-8000-000000000000",
    identified: [makeIdentified()],
    unidentified: [],
    overflowCount: 0,
    unidentifiedOverflowCount: 0,
    failedPhotoCount: 0,
    failedPhotoIndexes: [],
    ...overrides,
  };
}

function makeRecommendation(): RecommendResponse {
  return {
    recommendations: [
      {
        bookId: "9788934972464",
        reason: "지금 컨디션에 분량이 맞고 문장이 다정해서 오늘 밤에 읽기 좋아요",
        position: 1,
      },
    ],
    shortfall: false,
  };
}

/** 업로드 → 분석 성공까지 진행한다 */
async function analyzeInto(response: AnalyzeResponse) {
  analyzeMock.mockResolvedValue(ok(response));
  render(<Home />);
  fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));
  await screen.findByRole("heading", { name: "책장을 이렇게 읽었어요" });
}

/** 분석 → 확인된 책 1권 → 기분 입력까지 진행한다 */
async function reachMoodInput() {
  await analyzeInto(makeAnalyze());
  fireEvent.click(screen.getByRole("button", { name: "추천받기" }));
  await screen.findByRole("heading", { name: "지금 어떤 기분이세요?" });
}

beforeEach(() => {
  vi.clearAllMocks();
  resizeCallCount = 0;
  resizeMock.mockImplementation(async (file: File) => {
    resizeCallCount += 1;
    return resizedUri(file, resizeCallCount);
  });
});

describe("세션 셸", () => {
  it("업로드가 넘긴 photoCount를 부분 실패 배너의 분모로 쓴다 (회귀 — 삭제하지 마라)", async () => {
    await analyzeInto(makeAnalyze({ failedPhotoCount: 1, failedPhotoIndexes: [1] }));

    // 분모는 응답에 없다. 업로드 화면이 넘긴 장수가 여기까지 와야 한다.
    expect(screen.getByText("사진 2장 중 1장은 읽지 못했어요")).toBeInTheDocument();
    expect(screen.getByText("코스모스")).toBeInTheDocument();
  });

  it("분석 요청 중에는 업로드 화면을 유지한다", async () => {
    analyzeMock.mockReturnValue(new Promise(() => {}));
    render(<Home />);

    fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));

    expect(await screen.findByText("분석 중")).toBeInTheDocument();
    expect(screen.getByText("업로드 화면")).toBeInTheDocument();
  });

  it("EMPTY_SHELF는 빈 목록이 아니라 재촬영 안내로 분기한다", async () => {
    analyzeMock.mockResolvedValue({
      ok: false,
      code: "EMPTY_SHELF",
      requestId: "req-empty",
      status: 404,
    });
    render(<Home />);

    fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));

    await screen.findByRole("heading", { name: "책등이 보이도록 다시 찍어 주세요" });
    fireEvent.click(screen.getByRole("button", { name: "다시 찍기" }));
    expect(screen.getByText("업로드 화면")).toBeInTheDocument();
  });

  it("확인 0건·미확인만 있으면 추천 CTA를 감춘다", async () => {
    await analyzeInto(
      makeAnalyze({
        identified: [],
        unidentified: [{ rawText: "읽히지 않은 책등", reason: "lookup_failed", candidates: [] }],
      }),
    );

    expect(screen.getByText("읽어낸 책을 알라딘에서 확인하지 못했어요")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "추천받기" })).not.toBeInTheDocument();
  });

  it("ambiguous 후보는 isbn13이 일치하는 resolve 응답으로만 합류한다 (회귀 — 삭제하지 마라)", async () => {
    await analyzeInto(makeAnalyze({ identified: [], unidentified: [makeAmbiguous()] }));
    resolveMock.mockResolvedValue(ok({ candidates: [makeResolved()] }));

    fireEvent.click(screen.getByRole("button", { name: /데미안/ }));

    // 합류한 책은 `/api/books/resolve`가 발급한 proof를 갖는다 (ADR-006).
    await screen.findByRole("heading", { name: "확인된 책 1권" });
    expect(eventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "book_resolved",
        properties: { resolve_attempt: 1, matched: true },
      }),
    );
  });

  it("resolve 응답에 고른 isbn13이 없으면 승격하지 않고 재검색으로 되돌린다 (회귀 — 삭제하지 마라)", async () => {
    await analyzeInto(makeAnalyze({ identified: [], unidentified: [makeAmbiguous()] }));
    // 검색어로 찾은 알라딘 순위 1번이 사용자가 고른 책이 아니다.
    resolveMock.mockResolvedValue(
      ok({ candidates: [makeResolved({ isbn13: "9791162540213", title: "싯다르타" })] }),
    );

    fireEvent.click(screen.getByRole("button", { name: /데미안/ }));

    await screen.findByText("고른 책을 다시 확인하지 못했어요. 아래에서 다시 골라 주세요");
    // 다른 책을 사용자가 고른 것처럼 목록에 넣지 않는다.
    expect(screen.queryByRole("heading", { name: /확인된 책/ })).not.toBeInTheDocument();
    expect(eventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "book_resolved",
        properties: { resolve_attempt: 1, matched: false },
      }),
    );
  });

  it("재검색 후보를 고르면 목록에 합류하고 미확인에서 빠진다", async () => {
    await analyzeInto(
      makeAnalyze({
        identified: [],
        unidentified: [{ rawText: "데미ㅇ", reason: "no_match", candidates: [] }],
      }),
    );
    resolveMock.mockResolvedValue(ok({ candidates: [makeResolved()] }));

    fireEvent.click(screen.getByRole("button", { name: "제목 고쳐 재검색" }));
    fireEvent.change(screen.getByLabelText("책 제목"), { target: { value: "데미안" } });
    fireEvent.click(screen.getByRole("button", { name: "재검색" }));

    const candidate = await screen.findByRole("button", { name: /데미안/ });
    fireEvent.click(candidate);

    await screen.findByRole("heading", { name: "확인된 책 1권" });
    expect(screen.queryByText("데미ㅇ")).not.toBeInTheDocument();
    expect(resolveMock).toHaveBeenCalledWith(expect.any(String), "데미안");
  });

  it("재검색으로 합류한 책은 사진에서 온 책과 한 목록에 선다 (별도 섹션 없음)", async () => {
    await analyzeInto(
      makeAnalyze({
        unidentified: [{ rawText: "데미ㅇ", reason: "no_match", candidates: [] }],
      }),
    );
    resolveMock.mockResolvedValue(ok({ candidates: [makeResolved()] }));

    fireEvent.click(screen.getByRole("button", { name: "제목 고쳐 재검색" }));
    fireEvent.change(screen.getByLabelText("책 제목"), { target: { value: "데미안" } });
    fireEvent.click(screen.getByRole("button", { name: "재검색" }));
    fireEvent.click(await screen.findByRole("button", { name: /데미안/ }));

    // 사용자의 책장은 하나다. 두 출처가 한 섹션에 서고 권수는 합계다.
    await screen.findByRole("heading", { name: "확인된 책 2권" });
    expect(screen.queryByRole("heading", { name: /직접 확인한 책/ })).not.toBeInTheDocument();
    expect(screen.getByText("코스모스")).toBeInTheDocument();
    // 한 목록에 서더라도 출처는 숨기지 않는다.
    expect(screen.getByTestId("resolved-origin").textContent).toBe("직접 확인");
  });

  it("lookup_failed의 '다시 시도'는 재분석이 아니라 그 책의 재조회를 부른다", async () => {
    await analyzeInto(
      makeAnalyze({
        unidentified: [{ rawText: "코스모ㅅ 칼세이건", reason: "lookup_failed", candidates: [] }],
      }),
    );
    const analyzeCallsBefore = analyzeMock.mock.calls.length;
    resolveMock.mockResolvedValue(ok({ candidates: [makeResolved()] }));

    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));

    // 알라딘 조회 한 건이 실패했을 뿐이다. 읽힌 원문 그대로 같은 질의를 다시 보낸다.
    await waitFor(() =>
      expect(resolveMock).toHaveBeenCalledWith(expect.any(String), "코스모ㅅ 칼세이건"),
    );
    // 모델에 사진을 다시 태우지 않는다 — 이 배선이 이 항목이 보고된 이유였다.
    expect(analyzeMock.mock.calls.length).toBe(analyzeCallsBefore);
  });

  it("추천 요청에 proof를 실어 보내고, 수락은 recommend_accepted만 보낸다 (회귀 — 삭제하지 마라)", async () => {
    await reachMoodInput();
    recommendMock.mockResolvedValue(ok(makeRecommendation()));

    fireEvent.change(screen.getByLabelText("지금 기분이나 상황"), {
      target: { value: "번아웃이라 가볍게" },
    });
    fireEvent.click(screen.getByRole("button", { name: "추천받기" }));

    await screen.findByRole("heading", { name: "이 책은 어때요?" });
    expect(recommendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mood: "번아웃이라 가볍게",
        inputMode: "free_text",
        books: [expect.objectContaining({ isbn13: "9788934972464", proof: "proof-cosmos" })],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "이거 읽을래요" }));

    expect(eventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "recommend_accepted",
        properties: { position: 1 },
      }),
    );
    // 분모는 라우트가 남긴다. 화면이 함께 보내면 이중 계상이다.
    for (const [payload] of eventMock.mock.calls) {
      expect(payload.event).not.toBe("recommend_viewed");
    }
  });

  it("UNVERIFIED_BOOKS는 재시도 대신 처음으로만 제공하고 idle로 되돌린다", async () => {
    await reachMoodInput();
    recommendMock.mockResolvedValue({
      ok: false,
      code: "UNVERIFIED_BOOKS",
      requestId: "req-expired",
      status: 400,
    });

    fireEvent.change(screen.getByLabelText("지금 기분이나 상황"), {
      target: { value: "가볍게 읽을 것" },
    });
    fireEvent.click(screen.getByRole("button", { name: "추천받기" }));

    await screen.findByText("책 정보가 만료됐어요. 사진을 다시 분석해 주세요");
    // 서명이 만료됐으므로 같은 목록으로 다시 시도해도 통과하지 못한다.
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "처음으로" }));
    expect(screen.getByText("업로드 화면")).toBeInTheDocument();
  });

  it("IRRELEVANT_MOOD는 기분 입력으로 되돌리고 안내 문구를 띄운다", async () => {
    await reachMoodInput();
    recommendMock.mockResolvedValue({
      ok: false,
      code: "IRRELEVANT_MOOD",
      requestId: "req-irrelevant",
      status: 422,
    });

    fireEvent.change(screen.getByLabelText("지금 기분이나 상황"), {
      target: { value: "점심 뭐 먹지" },
    });
    fireEvent.click(screen.getByRole("button", { name: "추천받기" }));

    await screen.findByText("책 고르는 데 참고할 내용을 적어 주세요");
    expect(screen.getByRole("heading", { name: "지금 어떤 기분이세요?" })).toBeInTheDocument();
  });

  /* ---------------------------------------------------------------- *
   * 세션 진행 상태 배선 (API_SPEC /api/recommend)
   * ---------------------------------------------------------------- */

  /** 기분을 적고 추천 버튼을 누른다. `moodInput` 화면에 있어야 한다 */
  function submitMood(mood: string) {
    fireEvent.change(screen.getByLabelText("지금 기분이나 상황"), { target: { value: mood } });
    fireEvent.click(screen.getByRole("button", { name: "추천받기" }));
  }

  /** 마지막 추천 요청에 실린 본문 */
  function lastRecommendCall(): { retryIndex: number; irrelevantStreak: number } {
    const calls = recommendMock.mock.calls;
    return calls[calls.length - 1][0];
  }

  const IRRELEVANT: ApiResult<RecommendResponse> = {
    ok: false,
    code: "IRRELEVANT_MOOD",
    requestId: "req-irrelevant",
    status: 422,
  };

  it("첫 추천은 retryIndex 0 · irrelevantStreak 0을 싣는다", async () => {
    await reachMoodInput();
    recommendMock.mockResolvedValue(ok(makeRecommendation()));

    submitMood("번아웃이라 가볍게");

    await screen.findByRole("heading", { name: "이 책은 어때요?" });
    expect(lastRecommendCall()).toMatchObject({ retryIndex: 0, irrelevantStreak: 0 });
  });

  it("재추천 2회 후 요청의 retryIndex가 2다 — 하드코딩된 0이 아니다", async () => {
    await reachMoodInput();
    recommendMock.mockResolvedValue(ok(makeRecommendation()));

    submitMood("번아웃이라 가볍게");
    await screen.findByRole("heading", { name: "이 책은 어때요?" });

    for (const expected of [1, 2]) {
      fireEvent.click(screen.getByRole("button", { name: "다시 추천받기" }));
      await screen.findByRole("heading", { name: "지금 어떤 기분이세요?" });
      submitMood("이번엔 좀 묵직한 걸로");
      await screen.findByRole("heading", { name: "이 책은 어때요?" });

      expect(lastRecommendCall().retryIndex).toBe(expected);
    }
  });

  it("재추천 상한까지 눌러도 retryIndex가 4를 넘지 않는다 (스키마 상한)", async () => {
    await reachMoodInput();
    recommendMock.mockResolvedValue(ok(makeRecommendation()));

    submitMood("번아웃이라 가볍게");
    await screen.findByRole("heading", { name: "이 책은 어때요?" });

    // 버튼이 비활성이 될 때까지 누른다. 리듀서의 세션당 상한(FR-010)이 먼저 막는다.
    for (let i = 0; i < 10; i += 1) {
      const again = screen.queryByRole("button", { name: "다시 추천받기" });
      if (again === null || (again as HTMLButtonElement).disabled) break;

      fireEvent.click(again);
      await screen.findByRole("heading", { name: "지금 어떤 기분이세요?" });
      submitMood("또 다른 기분으로");
      await screen.findByRole("heading", { name: "이 책은 어때요?" });

      expect(lastRecommendCall().retryIndex).toBeLessThanOrEqual(4);
    }

    expect(recommendMock.mock.calls.length).toBeGreaterThan(1);
    for (const [payload] of recommendMock.mock.calls) {
      expect(payload.retryIndex).toBeLessThanOrEqual(4);
      expect(payload.retryIndex).toBeGreaterThanOrEqual(0);
    }
  });

  /** 기분을 제출하고 요청이 한 번 더 나가 화면이 입력으로 되돌아올 때까지 기다린다 */
  async function submitMoodAndSettle(mood: string) {
    const before = recommendMock.mock.calls.length;
    submitMood(mood);
    await waitFor(() => expect(recommendMock.mock.calls.length).toBe(before + 1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "추천받기" })).not.toBeDisabled(),
    );
  }

  it("무관 판정 2회 후 요청의 irrelevantStreak가 2다 — 연속만 센다", async () => {
    await reachMoodInput();
    recommendMock.mockResolvedValue(IRRELEVANT);

    for (const expected of [0, 1, 2]) {
      await submitMoodAndSettle("점심 뭐 먹지");

      expect(lastRecommendCall().irrelevantStreak).toBe(expected);
    }
  });

  it("무관 판정 3회째에도 irrelevantStreak가 2를 넘지 않는다 (클램프)", async () => {
    await reachMoodInput();
    recommendMock.mockResolvedValue(IRRELEVANT);

    // 화면의 연속 카운터에는 상한이 없다. 계약의 상한(0~2)은 보내기 직전에
    // 지킨다 — 넘겨 보내면 400이고, 400은 사용자에게 아무 의미가 없는 실패다.
    for (let i = 0; i < 5; i += 1) {
      await submitMoodAndSettle("점심 뭐 먹지");
    }

    expect(recommendMock).toHaveBeenCalledTimes(5);
    for (const [payload] of recommendMock.mock.calls) {
      expect(payload.irrelevantStreak).toBeLessThanOrEqual(2);
      expect(payload.irrelevantStreak).toBeGreaterThanOrEqual(0);
    }
    expect(lastRecommendCall().irrelevantStreak).toBe(2);
  });

  it("추천에 성공하면 irrelevantStreak가 0으로 되돌아간다", async () => {
    await reachMoodInput();
    recommendMock.mockResolvedValue(IRRELEVANT);

    submitMood("점심 뭐 먹지");
    await screen.findByText("책 고르는 데 참고할 내용을 적어 주세요");

    recommendMock.mockResolvedValue(ok(makeRecommendation()));
    submitMood("번아웃이라 가볍게");
    await screen.findByRole("heading", { name: "이 책은 어때요?" });
    expect(lastRecommendCall().irrelevantStreak).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "다시 추천받기" }));
    await screen.findByRole("heading", { name: "지금 어떤 기분이세요?" });
    submitMood("이번엔 묵직하게");
    await screen.findByRole("heading", { name: "이 책은 어때요?" });

    expect(lastRecommendCall().irrelevantStreak).toBe(0);
  });

  it("무관 판정 2회 연속 뒤 세 번째 제출은 추천 화면까지 간다 (US-003 AC)", async () => {
    await reachMoodInput();
    recommendMock.mockResolvedValue(IRRELEVANT);

    // 1·2회째는 판정을 그대로 받아 입력 화면에 남는다.
    await submitMoodAndSettle("점심 뭐 먹지");
    expect(screen.getByText("책 고르는 데 참고할 내용을 적어 주세요")).toBeInTheDocument();

    await submitMoodAndSettle("점심 뭐 먹지");
    // 2회 연속부터는 같은 요구를 반복하지 않고, 다음에 무슨 일이 일어나는지 말한다.
    expect(screen.queryByText("책 고르는 데 참고할 내용을 적어 주세요")).toBeNull();
    expect(screen.getByText(/이번에는 적으신 그대로/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "추천받기" })).not.toBeDisabled();

    // 세 번째는 서버가 판정을 무시하고 추천을 진행한다 (API_SPEC /api/recommend).
    recommendMock.mockResolvedValue(ok(makeRecommendation()));
    submitMood("점심 뭐 먹지");

    await screen.findByRole("heading", { name: "이 책은 어때요?" });
    expect(lastRecommendCall().irrelevantStreak).toBe(2);
  });

  it("강행 경로로 성공하면 irrelevantCount가 0으로 돌아간다", async () => {
    await reachMoodInput();
    recommendMock.mockResolvedValue(IRRELEVANT);

    await submitMoodAndSettle("점심 뭐 먹지");
    await submitMoodAndSettle("점심 뭐 먹지");

    recommendMock.mockResolvedValue(ok(makeRecommendation()));
    submitMood("점심 뭐 먹지");
    await screen.findByRole("heading", { name: "이 책은 어때요?" });

    fireEvent.click(screen.getByRole("button", { name: "다시 추천받기" }));
    await screen.findByRole("heading", { name: "지금 어떤 기분이세요?" });

    // 연속이 끊겼으므로 강행 안내도 요구 문구도 남아 있지 않다.
    expect(screen.queryByText(/이번에는 적으신 그대로/)).toBeNull();
    expect(screen.queryByText("책 고르는 데 참고할 내용을 적어 주세요")).toBeNull();

    submitMood("번아웃이라 가볍게");
    await screen.findByRole("heading", { name: "이 책은 어때요?" });
    expect(lastRecommendCall().irrelevantStreak).toBe(0);
  });

  it("무관 판정이 아닌 실패는 연속을 끊는다 — 강행 안내가 사라진다", async () => {
    await reachMoodInput();
    recommendMock.mockResolvedValue(IRRELEVANT);

    await submitMoodAndSettle("점심 뭐 먹지");
    await submitMoodAndSettle("점심 뭐 먹지");
    expect(screen.getByText(/이번에는 적으신 그대로/)).toBeInTheDocument();

    recommendMock.mockResolvedValue({
      ok: false,
      code: "UPSTREAM_UNAVAILABLE",
      requestId: "req-upstream",
      status: 502,
    });
    submitMood("점심 뭐 먹지");

    // 추천 실패 화면에서 기분 입력으로 되돌아오면 카운터는 이미 0이다.
    await screen.findByRole("button", { name: "기분 다시 입력" });
    fireEvent.click(screen.getByRole("button", { name: "기분 다시 입력" }));
    await screen.findByRole("heading", { name: "지금 어떤 기분이세요?" });

    expect(screen.queryByText(/이번에는 적으신 그대로/)).toBeNull();

    recommendMock.mockResolvedValue(ok(makeRecommendation()));
    submitMood("번아웃이라 가볍게");
    await screen.findByRole("heading", { name: "이 책은 어때요?" });
    expect(lastRecommendCall().irrelevantStreak).toBe(0);
  });

  it("분석 실패 후 재시도는 재업로드를 요구하지 않는다", async () => {
    analyzeMock.mockResolvedValue({
      ok: false,
      code: "TIMEOUT",
      requestId: "req-timeout",
      status: 504,
    });
    render(<Home />);

    fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));
    await screen.findByText("시간이 오래 걸려 중단됐어요. 사진 장수를 줄여 다시 시도해 주세요");

    analyzeMock.mockResolvedValue(ok(makeAnalyze()));
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));

    await screen.findByRole("heading", { name: "책장을 이렇게 읽었어요" });
    // 같은 사진을 그대로 다시 보낸다 — 사용자가 파일을 다시 고르지 않는다.
    // 다만 보내는 값은 **원본에서 다시 만든 것**이지 첫 요청의 파생값이 아니다.
    expect(resizeMock.mock.calls.map(([file]) => file)).toEqual(FILES);
    expect(analyzeMock).toHaveBeenLastCalledWith(expect.any(String), [
      resizedUri(FILES[0], 1),
      resizedUri(FILES[1], 2),
    ]);
    expect(analyzeMock).not.toHaveBeenLastCalledWith(expect.any(String), IMAGES);
  });

  it("첫 요청은 업로드가 곁들여 넘긴 파생값을 쓴다 — 두 번 리사이즈하지 않는다", async () => {
    await analyzeInto(makeAnalyze());

    expect(resizeMock).not.toHaveBeenCalled();
    expect(analyzeMock).toHaveBeenLastCalledWith(expect.any(String), IMAGES);
  });

  /* ---------------------------------------------------------------- *
   * 확인된 책이 있는 화면에서의 사진 재시도 (US-001 부분 실패 회복)
   *
   * 이 자리에서 어긋날 수 있는 것이 둘이다. 리듀서가 `reviewing`의 재시도를
   * 무시하면 버튼이 죽은 것처럼 보이고, 전이만 되고 응답이 책장을 **덮으면**
   * 앞 회차에서 확인된 책이 이유 없이 사라진다. 아래 세 단언이 그 둘을 각각
   * 잡는다 — 하나라도 빼면 한쪽 결함이 통과한다.
   * ---------------------------------------------------------------- */

  it("확인된 책이 있는 화면의 재시도는 분석 중으로 바뀌고, 응답에 없던 책도 다시 선다", async () => {
    await analyzeInto(makeAnalyze({ failedPhotoCount: 1, failedPhotoIndexes: [1] }));
    expect(screen.getByText("코스모스")).toBeInTheDocument();

    // 응답을 손에 쥐고 있어야 "분석 중" 화면을 볼 수 있다.
    let finish!: (result: ApiResult<AnalyzeResponse>) => void;
    analyzeMock.mockReturnValue(
      new Promise<ApiResult<AnalyzeResponse>>((resolve) => {
        finish = resolve;
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "이 사진만 다시 시도" }));

    // ① 화면이 실제로 바뀐다. `reviewing`에서 재시도가 무시되면 여기서 멈춘다.
    const progress = await screen.findByRole("status");
    expect(progress.textContent).toContain("다시 읽고 있어요");
    // ② 분석 중에는 목록을 그리지 않는다.
    expect(screen.queryByText("코스모스")).toBeNull();

    // 두 번째 응답은 **이번에 보낸 1장**의 결과뿐이다 — 코스모스는 여기 없다.
    await act(async () => {
      finish(ok(makeAnalyze({ identified: [], unidentified: [makeAmbiguous()] })));
    });

    // ③ 앞 회차에서 확인된 책이 "이번 응답에 없다"는 이유로 사라지지 않는다.
    await screen.findByRole("heading", { name: "책장을 이렇게 읽었어요" });
    expect(screen.getByText("코스모스")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "확인된 책 1권" })).toBeInTheDocument();
  });

  /* ---------------------------------------------------------------- *
   * 실패 단계별 회복 (ARCHITECTURE 상태 관리, 상태도 error → recommending·moodInput)
   * ---------------------------------------------------------------- */

  /** 기분을 적고 추천 요청이 502로 실패해 에러 화면에 도달할 때까지 진행한다 */
  async function failRecommend(mood: string) {
    recommendMock.mockResolvedValue({
      ok: false,
      code: "UPSTREAM_UNAVAILABLE",
      requestId: "req-502",
      status: 502,
    });
    submitMood(mood);
    await screen.findByText("지금 책을 확인할 수 없어요. 잠시 후 다시 시도해 주세요");
  }

  it("추천 실패 후 '같은 기분으로 다시 추천'은 같은 mood로 한 번 더 부른다 (재분석 없음)", async () => {
    await reachMoodInput();
    await failRecommend("번아웃이라 가볍게");

    expect(recommendMock).toHaveBeenCalledTimes(1);
    const analyzeCallsBefore = analyzeMock.mock.calls.length;

    recommendMock.mockResolvedValue(ok(makeRecommendation()));
    fireEvent.click(screen.getByRole("button", { name: "같은 기분으로 다시 추천" }));

    await screen.findByRole("heading", { name: "이 책은 어때요?" });
    // 기분을 다시 묻지 않는다 — 직전 mood가 그대로 재전송된다.
    expect(recommendMock).toHaveBeenCalledTimes(2);
    expect(lastRecommendCall()).toMatchObject({ mood: "번아웃이라 가볍게" });
    // 사진 재업로드도 재분석도 없다. 이 경로가 없을 때의 회복은 전체 재분석뿐이었다.
    expect(analyzeMock.mock.calls.length).toBe(analyzeCallsBefore);
  });

  it("회복 재추천은 재추천 횟수를 올려 요청의 retryIndex에 반영한다", async () => {
    await reachMoodInput();
    await failRecommend("번아웃이라 가볍게");
    expect(lastRecommendCall().retryIndex).toBe(0);

    recommendMock.mockResolvedValue(ok(makeRecommendation()));
    fireEvent.click(screen.getByRole("button", { name: "같은 기분으로 다시 추천" }));

    await screen.findByRole("heading", { name: "이 책은 어때요?" });
    // 실패한 호출도 토큰은 청구된다. 리듀서가 센 값과 요청에 실린 값이 같아야 한다.
    expect(lastRecommendCall().retryIndex).toBe(1);
  });

  it("추천 실패에서 '기분 다시 입력'은 입력 화면으로 되돌리고 호출하지 않는다", async () => {
    await reachMoodInput();
    await failRecommend("번아웃이라 가볍게");

    fireEvent.click(screen.getByRole("button", { name: "기분 다시 입력" }));

    await screen.findByRole("heading", { name: "지금 어떤 기분이세요?" });
    expect(recommendMock).toHaveBeenCalledTimes(1);
  });

  it("추천 실패 화면에는 사진 재시도 CTA가 없다 — 분석 비용을 다시 내지 않는다", async () => {
    await reachMoodInput();
    await failRecommend("번아웃이라 가볍게");

    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "같은 기분으로 다시 추천" })).toBeInTheDocument();
  });

  it("분석 실패 화면에는 추천 회복 CTA가 없다", async () => {
    analyzeMock.mockResolvedValue({
      ok: false,
      code: "TIMEOUT",
      requestId: "req-timeout",
      status: 504,
    });
    render(<Home />);

    fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));
    await screen.findByText("시간이 오래 걸려 중단됐어요. 사진 장수를 줄여 다시 시도해 주세요");

    expect(screen.queryByRole("button", { name: "같은 기분으로 다시 추천" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "기분 다시 입력" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });

  it("requestId가 없는 실패에서 '(없음)'을 지어내지 않는다 (회귀 — 삭제하지 마라)", async () => {
    // 네트워크가 끊기면 api-client가 requestId: null을 준다.
    analyzeMock.mockResolvedValue({
      ok: false,
      code: "INTERNAL_ERROR",
      requestId: null,
      status: 500,
    });
    render(<Home />);

    fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));

    const banner = await screen.findByRole("alert");
    expect(banner.textContent).not.toContain("오류 ID");
    expect(banner.textContent).not.toContain("없음");
  });

  it("문답 생성이 빈 배열이면 자유 입력으로 폴백한다", async () => {
    await reachMoodInput();
    const empty: MoodQuestionsResponse = { questions: [] };
    questionsMock.mockResolvedValue(ok(empty));

    fireEvent.click(screen.getByRole("button", { name: "뭘 읽고 싶은지 모르겠어요" }));

    await waitFor(() => expect(questionsMock).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: "지금 어떤 기분이세요?" })).toBeInTheDocument();
  });

  /* ---------------------------------------------------------------- *
   * 분석 재시도 간격 (FR-010 — 0초 → 5초 → 15초)
   *
   * **가짜 타이머로 쓴다.** 실제로 5초·15초를 기다리면 이 리포의 모든 실행에
   * 그 비용이 곱해진다. 에러 화면까지는 실제 타이머로 가고(`findBy*`가 가짜
   * 타이머 아래서 멈춘다), 재시도 버튼을 누르기 직전에 갈아 끼운다.
   * ---------------------------------------------------------------- */

  describe("재시도 간격", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** 마이크로태스크만 흘린다. 타이머는 건드리지 않는다 */
    async function settle() {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    /** 가짜 시계를 ms만큼 민다 */
    async function advance(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    }

    /** 분석이 502로 실패한 에러 화면까지 진행한 뒤 가짜 타이머로 갈아 끼운다 */
    async function reachAnalyzeError() {
      analyzeMock.mockResolvedValue({
        ok: false,
        code: "UPSTREAM_UNAVAILABLE",
        requestId: "req-502",
        status: 502,
      });
      render(<Home />);
      fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));
      await screen.findByText("지금 책을 확인할 수 없어요. 잠시 후 다시 시도해 주세요");
      vi.useFakeTimers();
    }

    function retryButton(): HTMLButtonElement {
      return screen.getByRole("button", { name: "다시 시도" }) as HTMLButtonElement;
    }

    /** 간격만큼 밀어 재시도를 한 번 끝낸다. 응답은 다시 502라 에러 화면으로 돌아온다 */
    async function retryOnce(delayMs: number) {
      fireEvent.click(retryButton());
      if (delayMs > 0) await advance(delayMs);
      await settle();
    }

    it("1회차 재시도는 간격이 0초라 즉시 분석을 부른다", async () => {
      await reachAnalyzeError();
      const before = analyzeMock.mock.calls.length;

      fireEvent.click(retryButton());
      // 리사이즈가 비동기라 마이크로태스크만 흘린다. **타이머는 하나도 밀지 않는다** —
      // 간격이 0초임을 보는 자리이기 때문이다.
      await settle();

      expect(analyzeMock.mock.calls.length).toBe(before + 1);
      // 0초 대기에 "0초 남았어요"를 띄우지 않는다.
      expect(screen.queryByText(/뒤에 다시 시도할게요/)).toBeNull();
      await settle();
    });

    it("2회차 재시도는 5초 전에는 부르지 않고 5초에 부른다", async () => {
      await reachAnalyzeError();
      await retryOnce(0);
      const before = analyzeMock.mock.calls.length;

      fireEvent.click(retryButton());

      await advance(4999);
      // 이 단정이 없으면 간격이 0이어도 아래 단정만으로 통과한다.
      expect(analyzeMock.mock.calls.length).toBe(before);

      await advance(1);
      await settle();
      expect(analyzeMock.mock.calls.length).toBe(before + 1);
    });

    it("3회차 재시도는 15초 전에는 부르지 않고 15초에 부른다", async () => {
      await reachAnalyzeError();
      await retryOnce(0);
      await retryOnce(5_000);
      const before = analyzeMock.mock.calls.length;

      fireEvent.click(retryButton());

      await advance(14_999);
      expect(analyzeMock.mock.calls.length).toBe(before);

      await advance(1);
      await settle();
      expect(analyzeMock.mock.calls.length).toBe(before + 1);
    });

    it("대기 중에는 재시도 버튼이 비활성이고 남은 시간이 보인다", async () => {
      await reachAnalyzeError();
      await retryOnce(0);

      fireEvent.click(retryButton());

      expect(retryButton()).toBeDisabled();
      const notice = screen.getByText("5초 뒤에 다시 시도할게요");
      // 우리가 간격을 두는 것이지 사용자의 잘못이 아니다 (UI_GUIDE).
      expect(notice.closest('[role="alert"]')).toBeNull();

      await advance(1_000);
      expect(screen.getByText("4초 뒤에 다시 시도할게요")).toBeInTheDocument();

      await advance(4_000);
      await settle();
    });

    it("대기 중 버튼을 다시 눌러도 타이머가 겹치지 않는다", async () => {
      await reachAnalyzeError();
      await retryOnce(0);
      const before = analyzeMock.mock.calls.length;

      fireEvent.click(retryButton());
      // 비활성이라 눌리지 않지만, 상태로도 막혀 있어야 한다.
      fireEvent.click(retryButton());
      fireEvent.click(retryButton());

      await advance(5_000);
      await settle();
      expect(analyzeMock.mock.calls.length).toBe(before + 1);
    });

    it("대기 중 처음으로 돌아가면 타이머가 취소되고 분석이 불리지 않는다", async () => {
      await reachAnalyzeError();
      await retryOnce(0);
      const before = analyzeMock.mock.calls.length;

      fireEvent.click(retryButton());
      expect(screen.getByText("5초 뒤에 다시 시도할게요")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "처음으로" }));
      expect(screen.getByText("업로드 화면")).toBeInTheDocument();

      // 사용자가 버리기로 한 작업이다. 유령 호출에 비용을 내지 않는다.
      await advance(20_000);
      expect(analyzeMock.mock.calls.length).toBe(before);
    });

    it("상한 3회를 소진하면 버튼 없이 기존 안내만 남는다", async () => {
      await reachAnalyzeError();
      await retryOnce(0);
      await retryOnce(5_000);
      await retryOnce(15_000);

      expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
      expect(screen.getByText("잠시 후 다시 시도해 주세요")).toBeInTheDocument();
      expect(screen.queryByText(/뒤에 다시 시도할게요/)).toBeNull();
    });

    it("부분 실패 배너의 '이 사진만 다시 시도'도 같은 간격을 따른다", async () => {
      analyzeMock.mockResolvedValue(ok(makeAnalyze({ failedPhotoCount: 1, failedPhotoIndexes: [1] })));
      render(<Home />);
      fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));
      await screen.findByRole("heading", { name: "책장을 이렇게 읽었어요" });
      vi.useFakeTimers();

      const partialRetry = () =>
        screen.getByRole("button", { name: "이 사진만 다시 시도" }) as HTMLButtonElement;
      const before = analyzeMock.mock.calls.length;

      // 1회차는 즉시.
      fireEvent.click(partialRetry());
      await settle();
      expect(analyzeMock.mock.calls.length).toBe(before + 1);

      // 2회차는 5초. 비용이 드는 쪽이 같으므로 간격도 같다.
      fireEvent.click(partialRetry());
      expect(partialRetry()).toBeDisabled();
      expect(screen.getByText("5초 뒤에 다시 시도할게요")).toBeInTheDocument();

      await advance(4_999);
      expect(analyzeMock.mock.calls.length).toBe(before + 1);

      await advance(1);
      await settle();
      expect(analyzeMock.mock.calls.length).toBe(before + 2);
    });
  });

  /* ---------------------------------------------------------------- *
   * 재시도의 입력은 언제나 원본이다 (ARCHITECTURE 상태 관리)
   *
   * 세션이 리사이즈 결과를 들고 있으면 재업로드는 면하지만, EXIF 보정·JPEG 품질·
   * 짧은 변 경고를 다시 고를 수 없다 — 그 판정은 전부 `lib/image.ts`가 원본
   * 비트맵에서 내리는 것이고 줄인 결과에는 되돌릴 근거가 없다.
   * ---------------------------------------------------------------- */

  describe("원본에서 다시 리사이즈", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** 분석이 502로 실패한 에러 화면까지 진행한다 */
    async function reachAnalyzeError() {
      analyzeMock.mockResolvedValue({
        ok: false,
        code: "UPSTREAM_UNAVAILABLE",
        requestId: "req-502",
        status: 502,
      });
      render(<Home />);
      fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));
      await screen.findByText("지금 책을 확인할 수 없어요. 잠시 후 다시 시도해 주세요");
    }

    /** 확인 0건 — 미확인만 남아 부분 실패 배너와 "이 사진만 다시 시도"가 함께 선다 */
    function unidentifiedOnlyWithFailure(failedPhotoIndexes: number[]) {
      return makeAnalyze({
        identified: [],
        unidentified: [makeAmbiguous()],
        failedPhotoCount: failedPhotoIndexes.length,
        failedPhotoIndexes,
      });
    }

    it("재시도마다 원본에서 다시 만든다 — 첫 회차의 결과를 재사용하지 않는다", async () => {
      await reachAnalyzeError();

      fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
      await waitFor(() => expect(resizeMock).toHaveBeenCalledTimes(2));
      expect(analyzeMock).toHaveBeenLastCalledWith(expect.any(String), [
        resizedUri(FILES[0], 1),
        resizedUri(FILES[1], 2),
      ]);

      // 2회차. 같은 원본이지만 리사이즈는 다시 돈다 — 캐시된 파생값이 아니다.
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(resizeMock).toHaveBeenCalledTimes(4);
      expect(resizeMock.mock.calls.map(([file]) => file)).toEqual([...FILES, ...FILES]);
      expect(analyzeMock).toHaveBeenLastCalledWith(expect.any(String), [
        resizedUri(FILES[0], 3),
        resizedUri(FILES[1], 4),
      ]);
    });

    it("실패한 사진만 재시도하면 그 원본만 다시 만들고, 다음 응답의 photoIndex도 그 배열 기준이다", async () => {
      analyzeMock.mockResolvedValue(ok(unidentifiedOnlyWithFailure([1])));
      render(<Home />);
      fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));
      await screen.findByRole("heading", { name: "책장을 이렇게 읽었어요" });
      expect(screen.getByText("사진 2장 중 1장은 읽지 못했어요")).toBeInTheDocument();

      // 두 번째 응답은 **이번에 보낸 배열**(1장) 기준으로 0번이 실패했다고 말한다.
      analyzeMock.mockResolvedValue(ok(unidentifiedOnlyWithFailure([0])));
      fireEvent.click(screen.getByRole("button", { name: "이 사진만 다시 시도" }));
      await screen.findByText("사진 1장 중 1장은 읽지 못했어요");

      // 고쳐야 할 사진은 1번 하나뿐이다. 나머지 원본을 다시 태우지 않는다.
      expect(resizeMock.mock.calls.map(([file]) => file)).toEqual([FILES[1]]);
      expect(analyzeMock).toHaveBeenLastCalledWith(expect.any(String), [
        resizedUri(FILES[1], 1),
      ]);

      // 응답의 0번은 이제 원본 배열의 1번 사진이다. 대응이 어긋나면 사용자가 고친
      // 사진 대신 엉뚱한 사진이 다시 돈다.
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("button", { name: "이 사진만 다시 시도" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(resizeMock.mock.calls.map(([file]) => file)).toEqual([FILES[1], FILES[1]]);
    });

    it("재시도의 전송 합계가 상한을 넘으면 보내지 않고 용량으로 말한다 (checkOutputBudget)", async () => {
      await reachAnalyzeError();
      const before = analyzeMock.mock.calls.length;

      // 장당 상한(2MB)을 넘기는 산출물. 413은 마지막 방어선이지 설계가 아니다.
      resizeMock.mockImplementation(
        async () => `data:image/jpeg;base64,${"A".repeat(2.5 * 1024 * 1024)}`,
      );
      fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));

      await screen.findByText("사진 용량이 너무 커요. 장수를 줄여 주세요");
      expect(analyzeMock.mock.calls.length).toBe(before);
    });

    it("재시도의 리사이즈가 실패하면 데이터 문제로 설명하지 않는다 (ADR-005)", async () => {
      await reachAnalyzeError();
      const before = analyzeMock.mock.calls.length;

      resizeMock.mockRejectedValue(new Error("decode"));
      fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));

      await screen.findByText("문제가 생겨 중단했어요. 잠시 후 다시 시도해 주세요");
      expect(analyzeMock.mock.calls.length).toBe(before);
      // 우리 쪽에서 못 만든 것이지 알라딘에 없는 책이 아니다.
      expect(screen.queryByText(/원서·절판/)).toBeNull();
    });

    it("앞선 회차의 낡은 응답은 새 회차의 상태를 덮지 않는다 (RESTARTED와 같은 관문)", async () => {
      let resolveStale: (result: ApiResult<AnalyzeResponse>) => void = () => {};
      analyzeMock.mockReturnValueOnce(
        new Promise<ApiResult<AnalyzeResponse>>((resolve) => {
          resolveStale = resolve;
        }),
      );
      render(<Home />);
      fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));
      await screen.findByText("분석 중");

      // 새 회차가 시작되면 앞 회차는 그 자리에서 낡은 것이 된다.
      analyzeMock.mockResolvedValue(ok(makeAnalyze()));
      fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));
      await screen.findByRole("heading", { name: "책장을 이렇게 읽었어요" });

      await act(async () => {
        resolveStale({
          ok: false,
          code: "UPSTREAM_UNAVAILABLE",
          requestId: "req-stale",
          status: 502,
        });
      });

      // 사용자가 보고 있는 결과를 뒤늦게 도착한 실패가 지우지 않는다.
      expect(screen.getByRole("heading", { name: "책장을 이렇게 읽었어요" })).toBeInTheDocument();
      expect(
        screen.queryByText("지금 책을 확인할 수 없어요. 잠시 후 다시 시도해 주세요"),
      ).toBeNull();
    });

    it("처음으로 돌아가면 들고 있던 원본까지 버린다 — 새 세션에 옛 사진이 섞이지 않는다", async () => {
      await reachAnalyzeError();

      fireEvent.click(screen.getByRole("button", { name: "처음으로" }));
      expect(screen.getByText("업로드 화면")).toBeInTheDocument();

      // 원본을 버렸으므로 다시 고르기 전에는 재시도할 사진 자체가 없다.
      analyzeMock.mockResolvedValue(ok(makeAnalyze()));
      fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));
      await screen.findByRole("heading", { name: "책장을 이렇게 읽었어요" });

      // 새 세션의 첫 요청도 곁들여 온 파생값을 그대로 쓴다.
      expect(resizeMock).not.toHaveBeenCalled();
      expect(analyzeMock).toHaveBeenLastCalledWith(expect.any(String), IMAGES);
    });
  });

  it("문답에 답하면 합성된 기분 텍스트가 guided로 나간다", async () => {
    await reachMoodInput();
    questionsMock.mockResolvedValue(
      ok({
        questions: [
          { id: "q1", question: "오늘은 어떤 밀도의 책이 좋을까요?", options: ["가볍게", "묵직하게", "중간"] },
          { id: "q2", question: "지금 읽을 시간은 얼마나 되나요?", options: ["짧게", "길게", "상관없음"] },
        ],
      }),
    );
    recommendMock.mockResolvedValue(ok(makeRecommendation()));

    fireEvent.click(screen.getByRole("button", { name: "뭘 읽고 싶은지 모르겠어요" }));
    await screen.findByRole("heading", { name: "몇 가지만 여쭤볼게요" });

    fireEvent.click(screen.getByLabelText("가볍게"));
    fireEvent.click(screen.getByLabelText("짧게"));
    fireEvent.click(screen.getByRole("button", { name: "추천받기" }));

    await screen.findByRole("heading", { name: "이 책은 어때요?" });
    expect(recommendMock).toHaveBeenCalledWith(
      expect.objectContaining({ inputMode: "guided" }),
    );
  });
  /* ---------------------------------------------------------------- *
   * 추천 결과 이미지 저장 (FR-014, ADR-009)
   *
   * 화면은 이미지를 만들지 않는다. 여기서 고정하는 것은 페이지가 **무엇을 넘겨**
   * 부르고, 만든 `Blob`을 어떻게 내보내고 되돌려 놓는가다. 서버는 등장하지 않는다
   * (ADR-003 — 저장 이미지는 클라이언트에만 존재한다).
   * ---------------------------------------------------------------- */
  describe("추천 결과 이미지 저장", () => {
    const SHELF = [
      makeIdentified(),
      makeIdentified({
        isbn13: "9788937460777",
        title: "데미안",
        author: "헤르만 헤세",
        publisher: "민음사",
        coverUrl: "https://image.aladin.co.kr/product/2/2/cover/8937460777.jpg",
        proof: "proof-demian",
      }),
      makeIdentified({
        isbn13: "9791162540640",
        title: "달러구트 꿈 백화점",
        author: "이미예",
        publisher: "팩토리나인",
        coverUrl: "https://image.aladin.co.kr/product/3/3/cover/1162540648.jpg",
        proof: "proof-dallergut",
      }),
    ];

    const THREE: RecommendResponse = {
      recommendations: SHELF.map((book, index) => ({
        bookId: book.isbn13,
        reason: book.title + "은 지금 기분에 분량과 밀도가 맞아요",
        position: (index + 1) as 1 | 2 | 3,
      })),
      shortfall: false,
    };

    const createObjectURL = vi.fn(() => "blob:shelfie");
    const revokeObjectURL = vi.fn();
    const clicked: { href: string; download: string }[] = [];
    let originalCreate: typeof URL.createObjectURL;
    let originalRevoke: typeof URL.revokeObjectURL;
    let clickSpy: { mockRestore: () => void } | undefined;

    beforeEach(() => {
      clicked.length = 0;
      originalCreate = URL.createObjectURL;
      originalRevoke = URL.revokeObjectURL;
      URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
      // jsdom은 앵커 클릭을 실제 내비게이션으로 다루려 한다. 여기서 보고 싶은 것은
      // "무엇을 들고 눌렸는가"뿐이므로 클릭 자체를 기록으로 바꾼다.
      clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(function (this: HTMLAnchorElement) {
          clicked.push({ href: this.href, download: this.download });
        });
    });

    afterEach(() => {
      clickSpy?.mockRestore();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    });

    /** 확인된 책 3권 → 추천 3권까지 진행한다 */
    async function reachResult(response: RecommendResponse = THREE) {
      await analyzeInto(makeAnalyze({ identified: SHELF }));
      fireEvent.click(screen.getByRole("button", { name: "추천받기" }));
      await screen.findByRole("heading", { name: "지금 어떤 기분이세요?" });
      recommendMock.mockResolvedValue(ok(response));
      submitMood("번아웃이라 가볍게");
      await screen.findByRole("heading", { name: "이 책은 어때요?" });
    }

    function pngBlob() {
      return new Blob(["png"], { type: "image/png" });
    }

    it("화면에 뜬 추천 3권을 그대로 넘겨 한 번만 그린다", async () => {
      shareMock.mockResolvedValue(pngBlob());
      await reachResult();

      fireEvent.click(screen.getByRole("button", { name: "이미지로 저장" }));

      await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
      expect(shareMock.mock.calls[0][0]).toEqual(
        SHELF.map((book, index) => ({
          title: book.title,
          author: book.author,
          publisher: book.publisher,
          coverUrl: book.coverUrl,
          reason: book.title + "은 지금 기분에 분량과 밀도가 맞아요",
          position: index + 1,
        })),
      );
    });

    it("Blob을 결정적인 파일명으로 내려받고 objectURL을 회수한다", async () => {
      const blob = pngBlob();
      shareMock.mockResolvedValue(blob);
      await reachResult();

      fireEvent.click(screen.getByRole("button", { name: "이미지로 저장" }));

      await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:shelfie"));
      expect(createObjectURL).toHaveBeenCalledWith(blob);
      // 파일명에 시각을 넣지 않는다 — 테스트가 시계에 의존하지 않아야 한다
      expect(clicked).toEqual([
        { href: "blob:shelfie", download: "shelfie-recommendations.png" },
      ]);
    });

    it("저장 중에는 버튼을 숨기지 않고 비활성으로 두었다가 되돌린다", async () => {
      let finish!: (blob: Blob) => void;
      shareMock.mockReturnValue(
        new Promise<Blob>((resolve) => {
          finish = resolve;
        }),
      );
      await reachResult();

      fireEvent.click(screen.getByRole("button", { name: "이미지로 저장" }));

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "이미지로 저장" })).toBeDisabled(),
      );
      expect(screen.getByRole("button", { name: "이미지로 저장" })).toBeInTheDocument();

      await act(async () => {
        finish(pngBlob());
      });

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "이미지로 저장" })).not.toBeDisabled(),
      );
      expect(shareMock).toHaveBeenCalledTimes(1);
    });

    it("실패하면 안내만 뜨고 추천 목록은 그대로 남는다", async () => {
      shareMock.mockRejectedValue(new Error("캔버스 2d 컨텍스트를 얻지 못했습니다"));
      await reachResult();

      fireEvent.click(screen.getByRole("button", { name: "이미지로 저장" }));

      await screen.findByText("이미지를 만들지 못했어요. 다시 시도해 주세요");
      expect(screen.getByRole("heading", { name: "이 책은 어때요?" })).toBeInTheDocument();
      expect(screen.getAllByRole("article")).toHaveLength(3);
      // 내부 에러 원문을 화면에 흘리지 않는다 (UI_GUIDE 에러 배너)
      expect(screen.queryByText(/캔버스 2d/)).toBeNull();
    });

    it("저장은 재추천 횟수를 소모하지 않고 새 이벤트도 만들지 않는다 (FR-010·PRD 7번)", async () => {
      shareMock.mockResolvedValue(pngBlob());
      await reachResult();

      const recommendCallsBefore = recommendMock.mock.calls.length;
      const eventCallsBefore = eventMock.mock.calls.length;

      fireEvent.click(screen.getByRole("button", { name: "이미지로 저장" }));
      await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: "이미지로 저장" }));
      await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(2));

      // 모델을 부르지 않았으므로 재추천 상한도 그대로다
      expect(recommendMock.mock.calls.length).toBe(recommendCallsBefore);
      expect(eventMock.mock.calls.length).toBe(eventCallsBefore);
      expect(screen.getByRole("button", { name: "다시 추천받기" })).not.toBeDisabled();
    });

    it("추천 묶음이 바뀌면 직전 저장 실패 안내가 남지 않는다", async () => {
      shareMock.mockRejectedValue(new Error("실패"));
      await reachResult();

      fireEvent.click(screen.getByRole("button", { name: "이미지로 저장" }));
      await screen.findByText("이미지를 만들지 못했어요. 다시 시도해 주세요");

      fireEvent.click(screen.getByRole("button", { name: "다시 추천받기" }));
      await screen.findByRole("heading", { name: "지금 어떤 기분이세요?" });
      submitMood("이번엔 좀 묵직한 걸로");
      await screen.findByRole("heading", { name: "이 책은 어때요?" });

      expect(screen.queryByText(/이미지를 만들지 못했어요/)).toBeNull();
    });
  });
});
