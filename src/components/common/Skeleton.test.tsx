/**
 * Skeleton — 정적 스켈레톤 블록 (UI_GUIDE 애니메이션: 펄스 없음).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Skeleton } from "./Skeleton";

afterEach(cleanup);

describe("Skeleton", () => {
  it("펄스 애니메이션을 쓰지 않는다 (회귀 — 삭제하지 마라)", () => {
    const { container } = render(<Skeleton className="h-4 w-24" />);

    expect(container.innerHTML).not.toContain("animate-pulse");
    expect(container.innerHTML).not.toContain("animate-");
  });

  it("미확인 섹션과 같은 무채색 블록으로 그린다", () => {
    const { container } = render(<Skeleton />);

    expect(container.firstElementChild!.className).toContain("bg-muted-surface");
  });

  it("전달한 크기 클래스를 유지한다", () => {
    const { container } = render(<Skeleton className="h-16 w-16" />);

    const block = container.firstElementChild!;
    expect(block.className).toContain("h-16");
    expect(block.className).toContain("w-16");
  });

  it("장식이므로 스크린리더에서 숨긴다", () => {
    const { container } = render(<Skeleton />);

    expect(container.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
  });
});
