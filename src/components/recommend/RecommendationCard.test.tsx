/**
 * 추천 카드 (US-003, TR-010).
 *
 * 이 카드에는 이 프로젝트에서 가장 조심해야 할 지점이 있다 — `reason`은 Claude가
 * 지어낸 문장이고, 표지·제목·저자·쪽수·평점은 알라딘에서 온 사실이다. 둘을 같은
 * 시각 층위로 흘리면 사용자는 무엇을 믿어야 할지 알 수 없다 (ADR-002).
 * 그래서 `reason`이 ClaudeText 블록을 거치는지를 회귀 테스트로 고정한다.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Recommendation } from "@/types/api";
import type { AladinFacts } from "@/types/book";
import { RecommendationCard } from "./RecommendationCard";

const BOOK: AladinFacts = {
  isbn13: "9788934972467",
  title: "미움받을 용기",
  author: "기시미 이치로",
  publisher: "인플루엔셜",
  coverUrl: "https://image.aladin.co.kr/cover/9788934972467.jpg",
  pages: 336,
  aladinRating: 8.6,
  aladinLink: "https://www.aladin.co.kr/shop/9788934972467",
};

const RECOMMENDATION: Recommendation = {
  bookId: BOOK.isbn13,
  reason: "지금 컨디션에 분량이 맞고 한 챕터씩 끊어 읽기 좋아요",
  position: 1,
};

function 렌더(overrides: Partial<Parameters<typeof RecommendationCard>[0]> = {}) {
  return render(
    <RecommendationCard book={BOOK} recommendation={RECOMMENDATION} {...overrides} />,
  );
}

describe("RecommendationCard", () => {
  it("알라딘에서 온 사실을 그대로 보여준다", () => {
    렌더();

    expect(screen.getByText("미움받을 용기")).toBeInTheDocument();
    expect(screen.getByText("기시미 이치로")).toBeInTheDocument();
    expect(screen.getByText("인플루엔셜")).toBeInTheDocument();
    expect(screen.getByText("336쪽")).toBeInTheDocument();
    expect(screen.getByText("독자 8.6")).toBeInTheDocument();
  });

  it("추천 이유는 ClaudeText 블록으로만 나간다 (ADR-002)", () => {
    렌더();

    const 이유 = screen.getByText(RECOMMENDATION.reason);
    const 블록 = 이유.parentElement;

    expect(블록?.className).toContain("border-l-2");
    expect(블록?.className).toContain("italic");
    expect(블록).toHaveTextContent("추천 이유");
  });

  it("추천 카드는 확인·미확인 카드와 모서리 반경이 다르다 (UI_GUIDE 안티패턴 1)", () => {
    const { container } = 렌더();
    const 카드 = container.querySelector("article");

    expect(카드?.className).toContain("rounded-lg");
    expect(카드?.className).not.toContain("rounded-md");
    expect(카드?.className).not.toContain("rounded-sm");
    expect(카드?.className).not.toContain("rounded-2xl");
  });

  it("'이거 읽을래요'는 bookId와 position을 함께 올린다 (North Star 분자)", () => {
    const onAccept = vi.fn();
    렌더({ onAccept });

    fireEvent.click(screen.getByRole("button", { name: "이거 읽을래요" }));

    expect(onAccept).toHaveBeenCalledWith(BOOK.isbn13, 1);
  });

  it("고른 뒤에는 선택이 시각적으로 반영되고 다시 눌리지 않는다", () => {
    const onAccept = vi.fn();
    렌더({ onAccept, accepted: true });

    const 버튼 = screen.getByRole("button", { name: "읽을 책으로 골랐어요" });

    expect(버튼).toHaveAttribute("aria-pressed", "true");
    expect(버튼).toBeDisabled();
    fireEvent.click(버튼);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("쪽수·평점이 없으면 서지 메타 줄을 그리지 않는다 — 0쪽을 지어내지 않는다", () => {
    렌더({ book: { ...BOOK, pages: null, aladinRating: null } });

    expect(screen.queryByTestId("book-meta")).toBeNull();
  });

  it("표지 alt는 '{제목} 표지'다 (TRD 6.6 접근성)", () => {
    렌더();

    expect(screen.getByAltText("미움받을 용기 표지")).toBeInTheDocument();
  });

  it("UI_GUIDE 안티패턴을 쓰지 않는다", () => {
    const { container } = 렌더();

    ["backdrop-blur", "bg-gradient-to", "animate-pulse", "rounded-2xl", "shadow-", "purple"].forEach(
      (token) => expect(container.innerHTML).not.toContain(token),
    );
  });
});

describe("RecommendationCard — 알라딘 상품 링크 (FR-013)", () => {
  it("알라딘이 준 aladinLink 를 그대로 href 로 쓴다", () => {
    렌더();

    const 링크 = screen.getByRole("link", { name: /알라딘에서 보기/ });
    expect(링크.getAttribute("href")).toBe(BOOK.aladinLink);
    expect(링크.getAttribute("target")).toBe("_blank");
    expect(링크.getAttribute("rel")).toContain("noopener");
    expect(링크.getAttribute("rel")).toContain("noreferrer");
  });

  it("링크는 추천 이유 블록 **밖**에 있다 — 링크는 사실이고 블록은 해석의 자리다", () => {
    const { container } = 렌더();

    const 블록 = container.querySelector(".border-l-2");
    expect(블록).not.toBeNull();
    expect(블록?.querySelector("a")).toBeNull();
  });

  it("접근성 이름으로 어느 책의 링크인지 알 수 있다 (같은 문구가 3장에 반복된다)", () => {
    렌더();

    expect(screen.getByRole("link", { name: /미움받을 용기/ })).toBeInTheDocument();
  });
});
