/**
 * 표지 폴백 회귀 (UI_GUIDE 레이아웃).
 *
 * URL이 있어도 로드에 실패하는 경우(404·네트워크)가 실제로 발생하므로,
 * "URL이 없을 때"와 "로드에 실패했을 때"를 같은 폴백으로 흡수하는지 함께 고정한다.
 * 깨진 이미지 아이콘이 뜨는 순간 사실 정보를 보여주는 화면의 신뢰가 먼저 깎인다.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { BookCover } from "./BookCover";

afterEach(cleanup);

const COVER = "https://image.aladin.co.kr/product/1/1/cover/8934972467.jpg";

describe("BookCover", () => {
  it("표지 URL이 있으면 img를 그린다", () => {
    const { container } = render(<BookCover coverUrl={COVER} title="코스모스" />);

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe(COVER);
  });

  it("alt는 '{제목} 표지'이고 빈 문자열이 아니다", () => {
    const { container } = render(<BookCover coverUrl={COVER} title="코스모스" />);

    const alt = container.querySelector("img")?.getAttribute("alt");
    expect(alt).toBe("코스모스 표지");
    expect(alt).not.toBe("");
  });

  it("표지 URL이 없으면 제목 첫 글자 폴백을 그린다", () => {
    const { container, getByRole } = render(
      <BookCover coverUrl={null} title="코스모스" />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("코");
    expect(getByRole("img").getAttribute("aria-label")).toBe("코스모스 표지");
  });

  it("img에 error 이벤트가 나면 폴백으로 바뀐다 (깨진 이미지 아이콘 금지)", () => {
    const { container } = render(<BookCover coverUrl={COVER} title="코스모스" />);

    const img = container.querySelector("img");
    expect(img).not.toBeNull();

    fireEvent.error(img as HTMLImageElement);

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("코");
  });

  it("폴백 배경은 muted-surface 토큰이고 원시 hex를 쓰지 않는다", () => {
    const { container } = render(<BookCover coverUrl={null} title="코스모스" />);

    expect(container.innerHTML).toContain("bg-muted-surface");
    expect(container.innerHTML).not.toContain("#");
  });

  it("기본 폭은 w-16이고 비율을 유지한다", () => {
    const { container } = render(<BookCover coverUrl={COVER} title="코스모스" />);

    const className = container.querySelector("img")?.getAttribute("class") ?? "";
    expect(className).toContain("w-16");
    expect(className).toContain("object-contain");
  });

  it("className으로 크기를 바꿀 수 있다 (후보 목록의 작은 표지)", () => {
    const { container } = render(
      <BookCover coverUrl={COVER} title="코스모스" className="w-10" />,
    );

    expect(container.querySelector("img")?.getAttribute("class")).toContain("w-10");
  });
});
