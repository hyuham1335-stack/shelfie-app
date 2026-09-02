/**
 * 추천 결과 화면 (US-003, FR-006·FR-010).
 *
 * 여기서 지키는 것은 두 가지다.
 * ① 추천은 **확인된 책 목록 안에서만** 나온다. 목록에 없는 bookId가 오면 그 카드를
 *    그리지 않는다 — 서지 사실이 없는데 카드를 그리면 지어내는 수밖에 없다 (ADR-002).
 * ② 재추천 상한(FR-010)에 걸린 버튼은 숨기지 않고 **비활성으로 남긴다**.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Recommendation } from "@/types/api";
import type { AladinFacts } from "@/types/book";
import { RecommendationList } from "./RecommendationList";

function 책(isbn13: string, title: string): AladinFacts {
  return {
    isbn13,
    title,
    author: "저자",
    publisher: "출판사",
    coverUrl: `https://image.aladin.co.kr/cover/${isbn13}.jpg`,
    pages: 300,
    aladinRating: 8.0,
    aladinLink: `https://www.aladin.co.kr/shop/${isbn13}`,
  };
}

const BOOKS = [
  책("9788934972467", "미움받을 용기"),
  책("9788937460777", "데미안"),
  책("9791162540640", "달러구트 꿈 백화점"),
];

const RECOMMENDATIONS: Recommendation[] = BOOKS.map((book, index) => ({
  bookId: book.isbn13,
  reason: `${book.title}은 지금 기분에 분량과 밀도가 맞아요`,
  position: (index + 1) as 1 | 2 | 3,
}));

function 렌더(overrides: Partial<Parameters<typeof RecommendationList>[0]> = {}) {
  return render(
    <RecommendationList
      recommendations={RECOMMENDATIONS}
      books={BOOKS}
      shortfall={false}
      canRecommendAgain
      isSavingImage={false}
      saveImageFailed={false}
      onAccept={vi.fn()}
      onRecommendAgain={vi.fn()}
      onSaveImage={vi.fn()}
      {...overrides}
    />,
  );
}

describe("RecommendationList", () => {
  it("추천된 책을 순서대로 그린다", () => {
    렌더();

    const 카드 = screen.getAllByRole("article");

    expect(카드).toHaveLength(3);
    expect(카드[0]).toHaveTextContent("미움받을 용기");
    expect(카드[2]).toHaveTextContent("달러구트 꿈 백화점");
  });

  it("확인된 책 목록에 없는 bookId는 그리지 않는다 (FR-009·ADR-002)", () => {
    렌더({
      recommendations: [
        RECOMMENDATIONS[0],
        { bookId: "9780000000000", reason: "목록 밖에서 온 추천이라 사실이 없다", position: 2 },
      ],
    });

    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.queryByText(/목록 밖에서 온 추천/)).toBeNull();
  });

  it("한 권을 고르면 bookId·position이 올라가고 선택이 반영된다", () => {
    const onAccept = vi.fn();
    렌더({ onAccept });

    fireEvent.click(screen.getAllByRole("button", { name: "이거 읽을래요" })[1]);

    expect(onAccept).toHaveBeenCalledWith("9788937460777", 2);
    expect(screen.getByRole("button", { name: "읽을 책으로 골랐어요" })).toBeInTheDocument();
  });

  it("이미 고른 책은 다시 세지 않는다 — 수락률 분자를 두 번 올리지 않는다", () => {
    const onAccept = vi.fn();
    렌더({ onAccept });

    const 버튼 = screen.getAllByRole("button", { name: "이거 읽을래요" })[0];
    fireEvent.click(버튼);
    fireEvent.click(버튼);

    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("shortfall이면 UI_GUIDE 문구를 그대로 쓴다 (FR-006)", () => {
    const 두권 = BOOKS.slice(0, 2);
    렌더({
      books: 두권,
      recommendations: RECOMMENDATIONS.slice(0, 2),
      shortfall: true,
    });

    expect(
      screen.getByText("확인된 책이 2권뿐이에요. 책장을 더 찍으면 더 잘 고를 수 있어요"),
    ).toBeInTheDocument();
  });

  it("shortfall이 아니면 그 안내를 붙이지 않는다", () => {
    렌더();

    expect(screen.queryByText(/책장을 더 찍으면/)).toBeNull();
  });

  it("'다시 추천받기'는 콜백으로만 위임한다", () => {
    const onRecommendAgain = vi.fn();
    렌더({ onRecommendAgain });

    fireEvent.click(screen.getByRole("button", { name: "다시 추천받기" }));

    expect(onRecommendAgain).toHaveBeenCalledTimes(1);
  });

  it("재추천 상한을 소진하면 버튼을 숨기지 않고 비활성으로 남긴다 (FR-010)", () => {
    const onRecommendAgain = vi.fn();
    렌더({ canRecommendAgain: false, onRecommendAgain });

    const 버튼 = screen.getByRole("button", { name: "다시 추천받기" });

    expect(버튼).toBeDisabled();
    fireEvent.click(버튼);
    expect(onRecommendAgain).not.toHaveBeenCalled();
    expect(screen.getByText("기분을 바꿔 적어 보세요")).toBeInTheDocument();
  });

  it("추천 묶음이 바뀌면 수락 표시가 따라 비워진다 — 같은 책을 다시 셀 수 있어야 한다", () => {
    const onAccept = vi.fn();
    const { rerender } = 렌더({ onAccept, recommendations: [RECOMMENDATIONS[0]] });

    fireEvent.click(screen.getByRole("button", { name: "이거 읽을래요" }));
    expect(onAccept).toHaveBeenCalledTimes(1);

    // 다시 추천받아 같은 책이 또 나온 경우 (position이 달라졌다)
    rerender(
      <RecommendationList
        recommendations={[{ ...RECOMMENDATIONS[0], position: 3 }, RECOMMENDATIONS[1]]}
        books={BOOKS}
        shortfall={false}
        canRecommendAgain
        isSavingImage={false}
        saveImageFailed={false}
        onAccept={onAccept}
        onRecommendAgain={vi.fn()}
        onSaveImage={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "읽을 책으로 골랐어요" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "이거 읽을래요" })[0]);
    expect(onAccept).toHaveBeenCalledTimes(2);
    expect(onAccept).toHaveBeenLastCalledWith(BOOKS[0].isbn13, 3);
  });

  it("그릴 수 있는 추천이 하나도 없으면 빈 화면 대신 그 사실을 말한다", () => {
    렌더({ recommendations: [] });

    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.getByText("추천한 책을 목록에서 찾지 못했어요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 추천받기" })).toBeInTheDocument();
  });
  /* ---------------------------------------------------------------- *
   * 이미지로 저장 (FR-014, UI_GUIDE 저장 이미지)
   *
   * 이 화면은 이미지를 만들지 않는다 — 캔버스·Blob·다운로드는 전부 페이지의 일이고,
   * 여기서 관찰할 것은 "눌렀다는 사실이 콜백으로 올라가는가"와 "표시 상태를 어떻게
   * 그리는가" 둘뿐이다 (ARCHITECTURE 레이어 규칙).
   * ---------------------------------------------------------------- */

  it("'이미지로 저장'은 콜백으로만 위임한다 (FR-014)", () => {
    const onSaveImage = vi.fn();
    렌더({ onSaveImage });

    fireEvent.click(screen.getByRole("button", { name: "이미지로 저장" }));

    expect(onSaveImage).toHaveBeenCalledTimes(1);
  });

  it("저장 중에는 버튼을 숨기지 않고 비활성으로 남긴다", () => {
    const onSaveImage = vi.fn();
    렌더({ isSavingImage: true, onSaveImage });

    const 버튼 = screen.getByRole("button", { name: "이미지로 저장" });

    // 사라지는 버튼은 사용자가 자기가 뭘 눌렀는지 잃게 만든다 (UI_GUIDE 에러 배너)
    expect(버튼).toBeInTheDocument();
    expect(버튼).toBeDisabled();
    fireEvent.click(버튼);
    expect(onSaveImage).not.toHaveBeenCalled();
  });

  it("진행 상태를 눈으로만 알리지 않는다 (TRD 6.6)", () => {
    렌더({ isSavingImage: true });

    expect(screen.getByRole("button", { name: "이미지로 저장" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("status")).toHaveTextContent("이미지를 만들고 있어요");
  });

  it("저장에 실패하면 안내만 붙고 추천 목록은 그대로 남는다", () => {
    렌더({ saveImageFailed: true });

    expect(screen.getByText("이미지를 만들지 못했어요. 다시 시도해 주세요")).toBeInTheDocument();
    // 실패는 화면 상태를 바꾸지 않는다 — 추천 결과가 사라지면 안 된다
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "이미지로 저장" })).not.toBeDisabled();
    // 경고색도 role="alert"도 쓰지 않는다 (UI_GUIDE 안내 문구)
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("저장 실패 안내를 기본으로 그리지 않는다", () => {
    렌더();

    expect(screen.queryByText(/이미지를 만들지 못했어요/)).toBeNull();
    expect(screen.queryByText(/이미지를 만들고 있어요/)).toBeNull();
  });

  it("그릴 수 있는 추천이 없으면 저장 버튼도 없다 — 사실 없이 그릴 그림이 없다", () => {
    렌더({ recommendations: [] });

    expect(screen.queryByRole("button", { name: "이미지로 저장" })).toBeNull();
  });
});
