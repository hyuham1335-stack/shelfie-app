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
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
 * 업로드 화면은 파일 선택·리사이즈를 스스로 하며 자기 테스트를 갖고 있다.
 * 이 파일이 검사할 것은 그 화면이 넘겨주는 값을 페이지가 어떻게 쓰는가이므로,
 * 콜백만 남긴 스텁으로 바꿔 둔다.
 */
vi.mock("@/components/upload/UploadScreen", () => ({
  UploadScreen: ({
    onAnalyze,
    isAnalyzing,
  }: {
    onAnalyze: (dataUris: string[], photoCount: number) => void;
    isAnalyzing?: boolean;
  }) => (
    <div>
      <p>업로드 화면</p>
      {isAnalyzing === true && <p>분석 중</p>}
      <button type="button" onClick={() => onAnalyze(IMAGES, IMAGES.length)}>
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

const IMAGES = ["data:image/jpeg;base64,AAAA", "data:image/jpeg;base64,BBBB"];

const analyzeMock = vi.mocked(analyzePhotos);
const resolveMock = vi.mocked(resolveBook);
const questionsMock = vi.mocked(fetchMoodQuestions);
const recommendMock = vi.mocked(requestRecommendations);
const eventMock = vi.mocked(sendClientEvent);

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
    await screen.findByRole("heading", { name: "직접 확인한 책 1권" });
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
    expect(screen.queryByRole("heading", { name: /직접 확인한 책/ })).not.toBeInTheDocument();
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

    await screen.findByRole("heading", { name: "직접 확인한 책 1권" });
    expect(screen.queryByText("데미ㅇ")).not.toBeInTheDocument();
    expect(resolveMock).toHaveBeenCalledWith(expect.any(String), "데미안");
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
    expect(analyzeMock).toHaveBeenLastCalledWith(expect.any(String), IMAGES);
  });

  it("문답 생성이 빈 배열이면 자유 입력으로 폴백한다", async () => {
    await reachMoodInput();
    const empty: MoodQuestionsResponse = { questions: [] };
    questionsMock.mockResolvedValue(ok(empty));

    fireEvent.click(screen.getByRole("button", { name: "뭘 읽고 싶은지 모르겠어요" }));

    await waitFor(() => expect(questionsMock).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: "지금 어떤 기분이세요?" })).toBeInTheDocument();
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
});
