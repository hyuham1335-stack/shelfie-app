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
import {
  IRRELEVANT_EMPHASIS_THRESHOLD,
  MOOD_EXAMPLES,
  MoodInput,
  nextIrrelevantCount,
} from "./MoodInput";
import { MAX_IRRELEVANT_STREAK } from "@/lib/env";

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

  /* ---------------------------------------------------------------- *
   * 무관 판정 세 단계 (US-003 마지막 AC)
   * ---------------------------------------------------------------- */

  /** 2회 연속부터 뜨는 강행 안내 */
  function 강행안내() {
    return screen.queryByText(/이번에는 적으신 그대로/);
  }

  it("강행 임계값은 서버가 판정을 무시하는 경계와 같은 값이다", () => {
    // 두 벌로 적어 두면 화면이 "그대로 눌러도 돼요"라고 말한 요청이 422로 되돌아온다.
    expect(IRRELEVANT_EMPHASIS_THRESHOLD).toBe(MAX_IRRELEVANT_STREAK);
  });

  it("0회에는 요구도 강행 안내도 없이 평소대로 받는다", () => {
    render(<MoodInput onSubmit={vi.fn()} onGuidedStart={vi.fn()} irrelevantCount={0} />);

    expect(screen.queryByText("책 고르는 데 참고할 내용을 적어 주세요")).toBeNull();
    expect(강행안내()).toBeNull();
    expect(screen.getByText("이런 식으로 적어도 돼요")).toBeInTheDocument();
  });

  it("1회째에는 다시 받되 강행 안내는 아직 하지 않는다", () => {
    render(<MoodInput onSubmit={vi.fn()} onGuidedStart={vi.fn()} irrelevantCount={1} />);

    expect(screen.getByText("책 고르는 데 참고할 내용을 적어 주세요")).toBeInTheDocument();
    expect(강행안내()).toBeNull();
    expect(screen.getByText("이런 식으로 적어도 돼요")).toBeInTheDocument();
  });

  it.each([2, 3])(
    "%i회째에는 그대로 눌러도 추천이 나온다는 것을 누르기 전에 알린다",
    (count) => {
      render(<MoodInput onSubmit={vi.fn()} onGuidedStart={vi.fn()} irrelevantCount={count} />);

      expect(강행안내()).toBeInTheDocument();
      // 요구를 반복하지 않는다 — 두 번 말했고 통하지 않았다.
      expect(screen.queryByText("책 고르는 데 참고할 내용을 적어 주세요")).toBeNull();
      expect(screen.queryByText(/다시 시도해 주세요/)).toBeNull();
    },
  );

  it("강행 안내는 사용자의 실패로 말하지 않는다 — 경고색도 alert도 쓰지 않는다", () => {
    const { container } = render(
      <MoodInput onSubmit={vi.fn()} onGuidedStart={vi.fn()} irrelevantCount={2} />,
    );

    // 우리 판정의 오탐 가능성을 인정하는 자리다 (UI_GUIDE 안내 문구).
    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.innerHTML).not.toContain("text-danger");
    expect(container.innerHTML).not.toContain("text-unverified");
    expect(container.innerHTML).not.toContain("#");
  });

  /** UI_GUIDE "AI 슬롭 안티패턴" 표 (common/antipatterns.test.tsx와 같은 목록) */
  const FORBIDDEN = [
    "backdrop-blur",
    "backdrop-filter",
    "bg-gradient-to",
    "bg-clip-text",
    "animate-pulse",
    "rounded-2xl",
    "shadow-",
    "indigo",
    "purple",
    "violet",
    "blur-3xl",
  ];

  it.each(FORBIDDEN)("강행 안내가 뜬 화면에도 %s가 없다", (token) => {
    const { container } = render(
      <MoodInput onSubmit={vi.fn()} onGuidedStart={vi.fn()} irrelevantCount={2} />,
    );

    expect(container.innerHTML).not.toContain(token);
  });

  it("결과 품질이 낮을 수 있다는 것을 숨기지 않는다", () => {
    render(<MoodInput onSubmit={vi.fn()} onGuidedStart={vi.fn()} irrelevantCount={2} />);

    expect(screen.getByText(/덜 들어맞을 수 있어요/)).toBeInTheDocument();
  });

  it.each([0, 1, 2, 3])(
    "무관 판정 %i회에도 제출 버튼이 비활성화되지 않는다 — 입력 화면에 가두지 않는다",
    (count) => {
      const onSubmit = vi.fn();
      render(
        <MoodInput onSubmit={onSubmit} onGuidedStart={vi.fn()} irrelevantCount={count} />,
      );

      const 버튼 = screen.getByRole("button", { name: "추천받기" }) as HTMLButtonElement;
      expect(버튼.disabled).toBe(false);
      expect(입력창().readOnly).toBe(false);

      적기("점심 뭐 먹지");
      추천받기();

      // 화면이 "이건 무관하다"고 자체 판단해 요청을 막지 않는다 (판정은 서버의 몫).
      expect(onSubmit).toHaveBeenCalledWith("점심 뭐 먹지");
    },
  );

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
