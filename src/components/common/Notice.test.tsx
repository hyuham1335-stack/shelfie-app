/**
 * Notice — 목록에 딸린 짧은 사실 안내 (UI_GUIDE "안내 문구").
 * 에러가 아니므로 색을 쓰지 않는다.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Notice } from "./Notice";

describe("Notice", () => {
  it("문구를 그대로 렌더한다", () => {
    render(<Notice>50권까지만 보여드려요 (3권 더 있음)</Notice>);

    expect(screen.queryByText("50권까지만 보여드려요 (3권 더 있음)")).not.toBeNull();
  });

  it("에러가 아니므로 위험·주의 색을 쓰지 않는다", () => {
    const { container } = render(<Notice>확인된 책이 2권뿐이에요</Notice>);

    const notice = container.firstElementChild!;
    expect(notice.className).toContain("text-subtle");
    expect(notice.className).not.toContain("danger");
    expect(notice.className).not.toContain("unverified");
  });

  it("보조 텍스트 크기로 렌더한다", () => {
    const { container } = render(<Notice>안내</Notice>);

    expect(container.firstElementChild!.className).toContain("text-xs");
  });
});
