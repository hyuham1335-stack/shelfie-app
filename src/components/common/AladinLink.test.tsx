/**
 * 알라딘 상품 링크 (FR-013, UI_GUIDE "외부 링크").
 *
 * URL 은 알라딘이 준 `aladinLink` 를 **그대로** 쓴다. ISBN 으로 조립한 링크는
 * 우리가 만든 사실이고, 그것을 알라딘 사실처럼 보여 주는 것이 이 프로젝트에서
 * 가장 심각한 결함이다 (ADR-002).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AladinLink } from "./AladinLink";

const HREF = "https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=12345";

describe("AladinLink", () => {
  it("받은 URL 을 그대로 href 로 쓴다 (조립하지 않는다)", () => {
    render(<AladinLink href={HREF} title="코스모스" />);

    expect(screen.getByRole("link").getAttribute("href")).toBe(HREF);
  });

  it("새 창으로 열고 opener 를 넘기지 않는다", () => {
    render(<AladinLink href={HREF} title="코스모스" />);

    const link = screen.getByRole("link");
    expect(link.getAttribute("target")).toBe("_blank");

    const rel = link.getAttribute("rel") ?? "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });

  it("보이는 문구는 '알라딘에서 보기'다", () => {
    render(<AladinLink href={HREF} title="코스모스" />);

    expect(screen.getByRole("link").textContent).toBe("알라딘에서 보기");
  });

  it("접근성 이름에 책 제목이 들어가 같은 문구의 링크들이 구분된다 (TRD 6.6)", () => {
    render(
      <>
        <AladinLink href={HREF} title="코스모스" />
        <AladinLink href={`${HREF}6`} title="데미안" />
      </>,
    );

    expect(screen.getByRole("link", { name: /코스모스/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /데미안/ })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /알라딘에서 보기/ })).toHaveLength(2);
  });

  it("키보드 포커스를 받는 <a> 다 — div + onClick 이 아니다", () => {
    const { container } = render(<AladinLink href={HREF} title="코스모스" />);

    const link = container.firstElementChild;
    expect(link?.tagName).toBe("A");
    link instanceof HTMLElement && link.focus();
    expect(document.activeElement).toBe(link);
  });

  it("Text 버튼 스타일을 쓰고 새 아이콘을 만들지 않는다 (UI_GUIDE 아이콘 4종 제한)", () => {
    const { container } = render(<AladinLink href={HREF} title="코스모스" />);

    const className = container.firstElementChild?.getAttribute("class") ?? "";
    expect(className).toContain("underline");
    expect(className).toContain("text-subtle");
    expect(className).not.toContain("#");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("AI 슬롭 안티패턴을 쓰지 않는다", () => {
    const { container } = render(<AladinLink href={HREF} title="코스모스" />);

    ["backdrop-blur", "bg-gradient-to", "animate-pulse", "rounded-2xl", "shadow-", "purple"].forEach(
      (token) => expect(container.innerHTML).not.toContain(token),
    );
  });
});
