/**
 * ClaudeText — 사실과 해석을 가르는 장치 (ADR-002, UI_GUIDE "Claude 생성 텍스트 블록").
 *
 * 이 파일의 시각 층위 단언은 회귀 테스트다. 삭제하지 않는다 —
 * 한줄평·추천 이유가 알라딘 사실과 같은 층위로 렌더되는 순간 이 프로젝트의 전제가 무너진다.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ClaudeText } from "./ClaudeText";

afterEach(cleanup);

describe("ClaudeText", () => {
  it("라벨과 본문을 함께 렌더한다", () => {
    render(<ClaudeText label="AI 한줄평" text="가볍게 읽히는데 여운이 길다" />);

    expect(screen.queryByText("AI 한줄평")).not.toBeNull();
    expect(screen.queryByText("가볍게 읽히는데 여운이 길다")).not.toBeNull();
  });

  it("추천 이유 라벨도 같은 블록으로 렌더한다", () => {
    render(<ClaudeText label="추천 이유" text="번아웃일 때 부담 없는 분량" />);

    expect(screen.queryByText("추천 이유")).not.toBeNull();
  });

  it("왼쪽 보더와 italic으로 사실과 다른 시각 층위를 만든다 (ADR-002 회귀)", () => {
    const { container } = render(
      <ClaudeText label="AI 한줄평" text="문장이 짧고 리듬이 좋다" />,
    );

    const block = container.firstElementChild;
    expect(block).not.toBeNull();
    expect(block!.className).toContain("border-l-2");
    expect(block!.className).toContain("border-accent/40");
    expect(block!.className).toContain("italic");
    expect(block!.className).toContain("pl-3");
  });

  it("라벨은 본문과 달리 italic이 아니다", () => {
    render(<ClaudeText label="AI 한줄평" text="문장이 짧다" />);

    const label = screen.getByText("AI 한줄평");
    expect(label.className).toContain("not-italic");
    expect(label.className).toContain("text-disabled");
  });

  it("빈 문자열이면 블록 자체를 렌더하지 않는다 (한줄평 생성 실패 경로)", () => {
    const { container } = render(<ClaudeText label="AI 한줄평" text="" />);

    expect(container.innerHTML).toBe("");
    expect(screen.queryByText("AI 한줄평")).toBeNull();
  });

  it("공백뿐인 문자열도 렌더하지 않는다", () => {
    const { container } = render(<ClaudeText label="추천 이유" text={"  \u000a\t  "} />);

    expect(container.innerHTML).toBe("");
  });

  it("색상을 토큰 클래스로만 쓴다 (원시 hex 재입력 0건)", () => {
    const { container } = render(<ClaudeText label="AI 한줄평" text="본문" />);

    expect(container.innerHTML).not.toContain("#");
  });
});
