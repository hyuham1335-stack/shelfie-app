/**
 * 촬영 가이드 시트 (FR-015).
 *
 * 이 시트가 지켜야 하는 것은 두 가지다 — **기본은 접혀 있고**, 펼치는 일이
 * 아무 부수 효과도 만들지 않는다. 그래서 테스트도 "무엇이 보이는가"보다
 * "무엇을 하지 않는가"를 함께 고정한다 (이벤트 0건, PRD 7번).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MAX_PHOTOS } from "@/lib/env";
import { CaptureGuide } from "./CaptureGuide";

const TRIGGER = "어떻게 찍으면 잘 읽히나요?";

function 시트(container: HTMLElement): HTMLDetailsElement {
  const details = container.querySelector("details");
  if (details === null) throw new Error("details 를 찾지 못했습니다");
  return details as HTMLDetailsElement;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CaptureGuide — 펼침 (FR-015)", () => {
  it("기본은 접힌 상태다 (첫 화면의 마찰을 늘리지 않는다)", () => {
    const { container } = render(<CaptureGuide />);

    expect(시트(container).open).toBe(false);
  });

  it("트리거를 누르면 본문이 보인다", () => {
    const { container } = render(<CaptureGuide />);

    fireEvent.click(screen.getByText(TRIGGER));

    expect(시트(container).open).toBe(true);
  });

  it("details/summary 로 만든다 — 키보드·스크린리더 동작을 직접 구현하지 않는다", () => {
    const { container } = render(<CaptureGuide />);

    expect(시트(container).querySelector("summary")?.textContent).toBe(TRIGGER);
  });

  it("모달이 아니다 — 화면을 덮는 오버레이를 그리지 않는다", () => {
    const { container } = render(<CaptureGuide />);

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.innerHTML).not.toContain("fixed");
    expect(container.innerHTML).not.toContain("inset-0");
  });
});

describe("CaptureGuide — 내용", () => {
  it("촬영 요령을 글 항목으로 4~6개 담는다", () => {
    render(<CaptureGuide />);
    fireEvent.click(screen.getByText(TRIGGER));

    const items = screen.getAllByRole("listitem");
    expect(items.length).toBeGreaterThanOrEqual(4);
    expect(items.length).toBeLessThanOrEqual(6);
    items.forEach((item) => expect(item.textContent?.trim().length).toBeGreaterThan(0));
  });

  it("사진 장수 상한을 리터럴이 아니라 MAX_PHOTOS 로 말한다", () => {
    render(<CaptureGuide />);

    expect(screen.getByText(new RegExp(`${MAX_PHOTOS}장`))).toBeInTheDocument();
  });

  it("지킬 수 없는 약속을 하지 않는다 (인식률은 목표 지표이지 보장이 아니다)", () => {
    const { container } = render(<CaptureGuide />);

    expect(container.textContent).not.toMatch(/100%|반드시 인식|모두 인식|정확히 인식/);
  });

  it("그림·아이콘을 만들지 않는다 (UI_GUIDE 아이콘 4종 제한)", () => {
    const { container } = render(<CaptureGuide />);

    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("CaptureGuide — 부수 효과 (PRD 7번)", () => {
  it("펼쳐도 이벤트를 보내지 않는다", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<CaptureGuide />);

    fireEvent.click(screen.getByText(TRIGGER));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("CaptureGuide — AI 슬롭 안티패턴 (UI_GUIDE)", () => {
  const FORBIDDEN = [
    "backdrop-blur",
    "backdrop-filter",
    "bg-gradient-to",
    "bg-clip-text",
    "animate-",
    "rounded-2xl",
    "shadow-",
    "indigo",
    "purple",
    "violet",
    "blur-3xl",
    "#",
  ];

  it.each(FORBIDDEN)("렌더된 마크업에 %s가 없다", (token) => {
    const { container } = render(<CaptureGuide />);
    fireEvent.click(screen.getByText(TRIGGER));

    expect(container.innerHTML).not.toContain(token);
  });
});
