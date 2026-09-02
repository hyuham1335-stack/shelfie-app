/**
 * 확인된 책 카드 — 사실(알라딘)과 해석(Claude)이 다른 층위로 나오는지 고정한다 (ADR-002).
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { IdentifiedBook } from "@/types/book";
import { IdentifiedBookCard } from "./IdentifiedBookCard";

function makeBook(overrides: Partial<IdentifiedBook> = {}): IdentifiedBook {
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
    proof: "proof-1",
    ...overrides,
  };
}

describe("IdentifiedBookCard", () => {
  it("제목·저자·출판사·쪽수·평점을 렌더한다", () => {
    const { container } = render(<IdentifiedBookCard book={makeBook()} />);

    const text = container.textContent ?? "";
    expect(text).toContain("코스모스");
    expect(text).toContain("칼 세이건");
    expect(text).toContain("사이언스북스");
    expect(text).toContain("719쪽");
    expect(text).toContain("독자 8.6");
  });

  it("평점은 '독자 8.6' 형태이고 별 아이콘을 쓰지 않는다", () => {
    const { container } = render(
      <IdentifiedBookCard book={makeBook({ aladinRating: 8.55 })} />,
    );

    expect(container.textContent).toContain("독자 8.6");
    expect(container.textContent).not.toContain("★");
    expect(container.textContent).not.toContain("☆");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("pages가 null이면 쪽수를 그리지 않는다 (없는 값을 0으로 표시하지 않는다)", () => {
    const { container } = render(<IdentifiedBookCard book={makeBook({ pages: null })} />);

    expect(container.textContent).not.toContain("쪽");
    expect(container.textContent).not.toContain("0쪽");
  });

  it("aladinRating이 null이면 평점을 그리지 않는다", () => {
    const { container } = render(
      <IdentifiedBookCard book={makeBook({ aladinRating: null })} />,
    );

    expect(container.textContent).not.toContain("독자");
  });

  it("pages·aladinRating이 둘 다 null이면 메타 줄 자체가 없다", () => {
    const { container } = render(
      <IdentifiedBookCard book={makeBook({ pages: null, aladinRating: null })} />,
    );

    expect(container.querySelector("[data-testid='book-meta']")).toBeNull();
  });

  it("한줄평은 ClaudeText 형태로만 렌더한다 (사실과 다른 시각 층위)", () => {
    const { container } = render(<IdentifiedBookCard book={makeBook()} />);

    const block = container.querySelector(".border-l-2");
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain("AI 한줄평");
    expect(block?.textContent).toContain("우주를 다루는데 문장이 다정하다");
    expect(block?.getAttribute("class")).toContain("italic");
  });

  it("한줄평이 빈 문자열이면 블록 자체가 없다", () => {
    const { container } = render(
      <IdentifiedBookCard book={makeBook({ claudeNote: "" })} />,
    );

    expect(container.querySelector(".border-l-2")).toBeNull();
    expect(container.textContent).not.toContain("AI 한줄평");
  });

  it("확인된 책 카드는 rounded-md이고 실선 테두리를 쓴다", () => {
    const { container } = render(<IdentifiedBookCard book={makeBook()} />);

    const className = container.firstElementChild?.getAttribute("class") ?? "";
    expect(className).toContain("rounded-md");
    expect(className).toContain("bg-card");
    expect(className).not.toContain("border-dashed");
  });

  it("긴 제목은 line-clamp-2로 자르고 전체 제목을 title 속성에 남긴다", () => {
    const long =
      "총 균 쇠 — 무기 병균 금속은 인류의 운명을 어떻게 바꿨는가 개정증보판 양장본";
    const { container } = render(<IdentifiedBookCard book={makeBook({ title: long })} />);

    const heading = container.querySelector("h3");
    expect(heading?.getAttribute("class")).toContain("line-clamp-2");
    expect(heading?.getAttribute("title")).toBe(long);
  });

  it("저자·출판사는 line-clamp-1로 자른다", () => {
    const { container } = render(<IdentifiedBookCard book={makeBook()} />);

    const clamped = Array.from(container.querySelectorAll(".line-clamp-1"));
    expect(clamped.length).toBe(2);
  });

  it("표지 alt는 '{제목} 표지'다", () => {
    const { container } = render(<IdentifiedBookCard book={makeBook()} />);

    expect(container.querySelector("img")?.getAttribute("alt")).toBe("코스모스 표지");
  });
});

describe("IdentifiedBookCard — 알라딘 상품 링크 (FR-013)", () => {
  it("알라딘이 준 aladinLink 를 그대로 href 로 쓴다", () => {
    const { getByRole } = render(<IdentifiedBookCard book={makeBook()} />);

    const link = getByRole("link", { name: /알라딘에서 보기/ });
    expect(link.getAttribute("href")).toBe(makeBook().aladinLink);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("ISBN 으로 URL 을 조립하지 않는다 (ADR-002)", () => {
    const aladinLink = "https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=999";
    const { getByRole } = render(
      <IdentifiedBookCard book={makeBook({ aladinLink })} />,
    );

    expect(getByRole("link").getAttribute("href")).toBe(aladinLink);
  });

  it("링크는 Claude 생성 텍스트 블록 **밖**에 있다 (사실 층위)", () => {
    const { container, getByRole } = render(<IdentifiedBookCard book={makeBook()} />);

    const block = container.querySelector(".border-l-2");
    expect(block).not.toBeNull();
    expect(block?.querySelector("a")).toBeNull();
    expect(getByRole("link", { name: /알라딘에서 보기/ })).not.toBeNull();
  });

  it("접근성 이름으로 어느 책의 링크인지 알 수 있다", () => {
    const { getByRole } = render(<IdentifiedBookCard book={makeBook()} />);

    expect(getByRole("link", { name: /코스모스/ })).not.toBeNull();
  });
});
