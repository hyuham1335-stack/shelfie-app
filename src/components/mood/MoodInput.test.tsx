/**
 * 기분 입력 화면 (US-003·US-004, FR-007).
 *
 * 이 화면에서 검사할 것은 세 가지다.
 * ① 비운 채 진행하는 경로가 **에러가 아니라 설계된 분기**인가 (FR-007)
 * ② 무관 판정(422 IRRELEVANT_MOOD)이 연속됐을 때 사용자를 입력 화면에 가두지 않는가
 * ③ 저장소를 쓰지 않는가 (ADR-003)
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MOOD_EXAMPLES, MoodInput, nextIrrelevantCount } from "./MoodInput";

function 입력창(): HTMLTextAreaElement {
  return screen.getByLabelText("지금 기분이나 상황") as HTMLTextAreaElement;
}

function 적기(text: string) {
  fireEvent.change(입력창(), { target: { value: text } });
}

function 추천받기() {
  fireEvent.click(screen.getByRole("button", { name: "추천받기" }));
}

describe("MoodInput", () => {
  it("2자 이상을 적고 제출하면 공백을 다듬은 기분 텍스트가 올라간다", () => {
    const onSubmit = vi.fn();
    render(<MoodInput onSubmit={onSubmit} onGuidedStart={vi.fn()} />);

    적기("  번아웃이라 가볍게 읽을 것  ");
    추천받기();

    expect(onSubmit).toHaveBeenCalledWith("번아웃이라 가볍게 읽을 것");
  });

  it("비운 채 진행하면 문답으로 간다 — 제출이 막히지 않는다 (FR-007)", () => {
    const onSubmit = vi.fn();
    const onGuidedStart = vi.fn();
    render(<MoodInput onSubmit={onSubmit} onGuidedStart={onGuidedStart} />);

    추천받기();

    expect(onGuidedStart).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("공백만 적은 것도 비운 것으로 본다 (FR-007)", () => {
    const onGuidedStart = vi.fn();
    render(<MoodInput onSubmit={vi.fn()} onGuidedStart={onGuidedStart} />);

    적기("   ");
    추천받기();

    expect(onGuidedStart).toHaveBeenCalledTimes(1);
  });

  it("비운 채 진행하는 경로를 실패로 말하지 않는다 — 경고색을 쓰지 않는다", () => {
    const { container } = render(<MoodInput onSubmit={vi.fn()} onGuidedStart={vi.fn()} />);

    추천받기();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.innerHTML).not.toContain("text-danger");
    expect(container.innerHTML).not.toContain("text-unverified");
  });

  it("한 글자는 추천으로도 문답으로도 보내지 않고 더 적도록 안내한다", () => {
    const onSubmit = vi.fn();
    const onGuidedStart = vi.fn();
    render(<MoodInput onSubmit={onSubmit} onGuidedStart={onGuidedStart} />);

    적기("음");
    적기("아");
    추천받기();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onGuidedStart).not.toHaveBeenCalled();
    expect(screen.getByText(/조금만 더/)).toBeInTheDocument();
  });

  it("예시 문장 3개를 보여주고, 고르면 입력창에 들어간다", () => {
    render(<MoodInput onSubmit={vi.fn()} onGuidedStart={vi.fn()} />);

    expect(MOOD_EXAMPLES).toHaveLength(3);
    MOOD_EXAMPLES.forEach((example) => {
      expect(screen.getByRole("button", { name: example })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: MOOD_EXAMPLES[0] }));

    expect(입력창().value).toBe(MOOD_EXAMPLES[0]);
  });

  it("500자를 넘겨 적을 수 없다 (recommendRequestSchema)", () => {
    render(<MoodInput onSubmit={vi.fn()} onGuidedStart={vi.fn()} />);

    expect(입력창().maxLength).toBe(500);
  });

  it("무관 판정 1회에는 PRD 문구로 다시 받는다", () => {
    render(<MoodInput onSubmit={vi.fn()} onGuidedStart={vi.fn()} irrelevantCount={1} />);

    expect(screen.getByText("책 고르는 데 참고할 내용을 적어 주세요")).toBeInTheDocument();
  });

  it("무관 판정 2회 연속이면 재입력을 요구하지 않고 예시를 강조한다", () => {
    render(<MoodInput onSubmit={vi.fn()} onGuidedStart={vi.fn()} irrelevantCount={2} />);

    // 같은 요구를 반복하면 오탐으로 사용자를 입력 화면에 가두게 된다 (API_SPEC /api/recommend)
    expect(screen.queryByText("책 고르는 데 참고할 내용을 적어 주세요")).toBeNull();
    expect(screen.getByText("이렇게 적으면 잘 골라져요")).toBeInTheDocument();
  });

  it("제출 중에는 두 번 보내지 않는다", () => {
    const onSubmit = vi.fn();
    render(<MoodInput onSubmit={onSubmit} onGuidedStart={vi.fn()} isSubmitting />);

    적기("가볍게 읽을 것");
    추천받기();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("직전 기분을 이어서 고칠 수 있다 (다시 추천받기)", () => {
    render(
      <MoodInput onSubmit={vi.fn()} onGuidedStart={vi.fn()} defaultMood="번아웃이라 가볍게" />,
    );

    expect(입력창().value).toBe("번아웃이라 가볍게");
  });

  it("nextIrrelevantCount는 연속만 센다 — 다른 결과가 오면 0으로 돌아간다", () => {
    expect(nextIrrelevantCount(0, "IRRELEVANT_MOOD")).toBe(1);
    expect(nextIrrelevantCount(1, "IRRELEVANT_MOOD")).toBe(2);
    expect(nextIrrelevantCount(2, null)).toBe(0);
    expect(nextIrrelevantCount(1, "UPSTREAM_UNAVAILABLE")).toBe(0);
  });
});
