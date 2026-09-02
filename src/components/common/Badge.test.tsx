/**
 * Badge — 미확인 사유 배지와 평점 배지 (UI_GUIDE "배지", "미확인 사유 문구").
 *
 * lookup_failed가 중립색이라는 단언은 ADR-005 회귀 테스트다. 삭제하지 않는다 —
 * 우리 쪽 조회 실패를 사용자 책장의 문제처럼 표시하면 사실이 아닌 설명을 하게 된다.
 */
import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Badge } from "./Badge";
import type { UnidentifiedReason } from "@/types/book";

const REASONS: UnidentifiedReason[] = [
  "unreadable",
  "no_match",
  "ambiguous",
  "lookup_failed",
];

describe("Badge — 미확인 사유", () => {
  it("사유 4종이 서로 다른 문구를 쓴다", () => {
    const labels = REASONS.map((reason) => {
      const { container } = render(<Badge kind="reason" reason={reason} />);
      const text = container.textContent ?? "";
      cleanup();
      return text;
    });

    expect(new Set(labels).size).toBe(4);
  });

  it("모든 사유 배지가 색 외에 텍스트를 함께 담는다 (색각 접근성)", () => {
    for (const reason of REASONS) {
      const { container } = render(<Badge kind="reason" reason={reason} />);
      expect((container.textContent ?? "").trim().length).toBeGreaterThan(0);
      cleanup();
    }
  });

  it("unreadable·no_match·ambiguous는 미확인 앰버를 쓴다", () => {
    for (const reason of ["unreadable", "no_match", "ambiguous"] as const) {
      const { container } = render(<Badge kind="reason" reason={reason} />);
      const badge = container.firstElementChild!;
      expect(badge.className).toContain("text-unverified");
      cleanup();
    }
  });

  it("lookup_failed는 중립색이고 앰버가 아니다 (ADR-005 회귀 — 삭제하지 마라)", () => {
    const { container } = render(<Badge kind="reason" reason="lookup_failed" />);

    const badge = container.firstElementChild!;
    expect(badge.className).toContain("text-subtle");
    expect(badge.className).not.toContain("text-unverified");
    expect(badge.className).not.toContain("bg-unverified");
  });

  it("lookup_failed 배지 문구는 절판·원서를 말하지 않는다", () => {
    const { container } = render(<Badge kind="reason" reason="lookup_failed" />);

    const text = container.textContent ?? "";
    expect(text).toContain("확인 못 함");
    expect(text).not.toContain("절판");
    expect(text).not.toContain("원서");
  });
});

describe("Badge — 평점", () => {
  it("출처를 드러내는 '독자 8.6' 형태로 표시한다", () => {
    render(<Badge kind="rating" rating={8.6} />);

    expect(screen.queryByText("독자 8.6")).not.toBeNull();
  });

  it("정수 평점도 소수 한 자리로 맞춘다", () => {
    render(<Badge kind="rating" rating={9} />);

    expect(screen.queryByText("독자 9.0")).not.toBeNull();
  });

  it("별 아이콘을 그리지 않는다", () => {
    const { container } = render(<Badge kind="rating" rating={7.2} />);

    expect(container.querySelector("svg")).toBeNull();
  });

  it("색상을 토큰 클래스로만 쓴다", () => {
    const { container } = render(<Badge kind="rating" rating={7.2} />);

    expect(container.innerHTML).not.toContain("#");
  });
});
