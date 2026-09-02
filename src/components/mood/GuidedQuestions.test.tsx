/**
 * 문답 화면 (US-004, TR-009).
 *
 * 이 화면의 실패 처리가 이 파일의 핵심이다. 질문 생성 실패도 모델 장애도 서버는
 * **200 + 빈 배열**로 돌려준다 (API_SPEC /api/mood/questions). 사용자가 할 수 있는 일이
 * 없는 실패라 에러 배너를 띄우지 않고 자유 입력으로 조용히 되돌린다.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { MoodQuestion } from "@/types/api";
import { GuidedQuestions, composeMood } from "./GuidedQuestions";

const QUESTIONS: MoodQuestion[] = [
  {
    id: "q1",
    question: "지금은 어떤 밀도의 책이 좋을까요?",
    options: ["술술 읽히는 쪽", "곱씹는 쪽", "아무거나"],
  },
  {
    id: "q2",
    question: "얼마나 오래 붙잡고 있을 수 있나요?",
    options: ["한 시간 안쪽", "주말 내내", "모르겠어요"],
  },
];

function 고르기(option: string) {
  fireEvent.click(screen.getByRole("radio", { name: option }));
}

describe("GuidedQuestions", () => {
  it("질문과 선택지를 전부 보여준다", () => {
    render(<GuidedQuestions questions={QUESTIONS} onSubmit={vi.fn()} onSkip={vi.fn()} />);

    QUESTIONS.forEach((question) => {
      expect(screen.getByText(question.question)).toBeInTheDocument();
      question.options.forEach((option) => {
        expect(screen.getByRole("radio", { name: option })).toBeInTheDocument();
      });
    });
  });

  it("답변을 질문과 함께 기분 텍스트로 합성해 올린다", () => {
    const onSubmit = vi.fn();
    render(<GuidedQuestions questions={QUESTIONS} onSubmit={onSubmit} onSkip={vi.fn()} />);

    고르기("술술 읽히는 쪽");
    고르기("한 시간 안쪽");
    fireEvent.click(screen.getByRole("button", { name: "추천받기" }));

    expect(onSubmit).toHaveBeenCalledWith(
      "지금은 어떤 밀도의 책이 좋을까요? 술술 읽히는 쪽\n얼마나 오래 붙잡고 있을 수 있나요? 한 시간 안쪽",
    );
  });

  it("다 답하기 전에는 제출할 수 없다", () => {
    const onSubmit = vi.fn();
    render(<GuidedQuestions questions={QUESTIONS} onSubmit={onSubmit} onSkip={vi.fn()} />);

    고르기("곱씹는 쪽");
    const 제출 = screen.getByRole("button", { name: "추천받기" });

    expect(제출).toBeDisabled();
    fireEvent.click(제출);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("같은 질문에서 다른 선택지를 고르면 마지막 답이 남는다", () => {
    const onSubmit = vi.fn();
    render(<GuidedQuestions questions={QUESTIONS} onSubmit={onSubmit} onSkip={vi.fn()} />);

    고르기("술술 읽히는 쪽");
    고르기("곱씹는 쪽");
    고르기("주말 내내");
    fireEvent.click(screen.getByRole("button", { name: "추천받기" }));

    expect(onSubmit).toHaveBeenCalledWith(
      "지금은 어떤 밀도의 책이 좋을까요? 곱씹는 쪽\n얼마나 오래 붙잡고 있을 수 있나요? 주말 내내",
    );
  });

  it("건너뛰기는 자유 입력으로 돌아가는 경로다", () => {
    const onSkip = vi.fn();
    render(<GuidedQuestions questions={QUESTIONS} onSubmit={vi.fn()} onSkip={onSkip} />);

    fireEvent.click(screen.getByRole("button", { name: "건너뛰고 직접 적기" }));

    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("질문이 빈 배열이면 아무것도 그리지 않는다 — 에러로 말하지 않는다", () => {
    const { container } = render(
      <GuidedQuestions questions={[]} onSubmit={vi.fn()} onSkip={vi.fn()} />,
    );

    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/만들지 못했/)).toBeNull();
  });

  it("생성 중에는 진행 상태를 소리로도 알린다 (TRD 6.6)", () => {
    render(<GuidedQuestions questions={[]} onSubmit={vi.fn()} onSkip={vi.fn()} isLoading />);

    const status = screen.getByRole("status");

    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("질문을 만들고 있어요");
  });

  it("제출 중에는 두 번 보내지 않는다", () => {
    const onSubmit = vi.fn();
    render(
      <GuidedQuestions
        questions={QUESTIONS}
        onSubmit={onSubmit}
        onSkip={vi.fn()}
        isSubmitting
      />,
    );

    고르기("술술 읽히는 쪽");
    고르기("한 시간 안쪽");
    fireEvent.click(screen.getByRole("button", { name: "추천받기" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("composeMood는 답하지 않은 질문을 빼고 500자에서 자른다", () => {
    expect(composeMood(QUESTIONS, { q2: "주말 내내" })).toBe(
      "얼마나 오래 붙잡고 있을 수 있나요? 주말 내내",
    );

    const 긴질문: MoodQuestion[] = Array.from({ length: 20 }, (_, index) => ({
      id: `q${index}`,
      question: "가".repeat(60),
      options: ["ㄱ", "ㄴ", "ㄷ"],
    }));
    const 답 = Object.fromEntries(긴질문.map((q) => [q.id, "ㄱ"]));

    expect(composeMood(긴질문, 답)).toHaveLength(500);
  });
});
