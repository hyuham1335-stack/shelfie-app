/**
 * ErrorBanner — 에러 배너 (UI_GUIDE "에러 배너", TRD 6.4 상관관계 ID).
 *
 * requestId 노출 단언은 회귀 테스트다. 삭제하지 않는다 —
 * 화면에 requestId가 없으면 서버 로그를 찾을 수 없어 상관관계 ID 규칙이 무의미해진다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ErrorBanner } from "./ErrorBanner";

afterEach(() => {
  cleanup();
  // 테스트가 심어 둔 클립보드 스텁을 다음 테스트로 흘리지 않는다.
  Reflect.deleteProperty(navigator, "clipboard");
});

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

describe("ErrorBanner", () => {
  it("requestId를 화면에 노출한다 (회귀 — 삭제하지 마라)", () => {
    render(<ErrorBanner code="UPSTREAM_UNAVAILABLE" requestId="req-abc-123" />);

    expect(screen.queryByText(/req-abc-123/)).not.toBeNull();
  });

  it("에러 코드에 대응하는 정해진 문구를 보여준다", () => {
    render(<ErrorBanner code="TIMEOUT" requestId="req-1" />);

    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("시간이 오래 걸려");
  });

  it("알 수 없는 에러 코드에도 기본 문구가 나오고 원문이 새어나오지 않는다", () => {
    render(
      <ErrorBanner
        code={"MODEL_SAID_SOMETHING_WEIRD" as never}
        requestId="req-2"
      />,
    );

    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("문제가 생겼어요");
    expect(banner.textContent).not.toContain("MODEL_SAID_SOMETHING_WEIRD");
  });

  it("복사 버튼이 클립보드에 requestId를 쓴다", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<ErrorBanner code="UPSTREAM_UNAVAILABLE" requestId="req-copy" />);

    fireEvent.click(screen.getByRole("button", { name: /오류 ID/ }));

    expect(writeText).toHaveBeenCalledWith("req-copy");
    // 복사 성공 피드백이 뜰 때까지 기다린다 — requestId는 그대로 남아 있어야 한다.
    expect(await screen.findByText(/복사됨/)).not.toBeNull();
    expect(screen.queryByText(/req-copy/)).not.toBeNull();
  });

  it("클립보드 API가 없어도 던지지 않는다", () => {
    render(<ErrorBanner code="UPSTREAM_UNAVAILABLE" requestId="req-noclip" />);

    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: /오류 ID/ })),
    ).not.toThrow();
    expect(screen.queryByText(/req-noclip/)).not.toBeNull();
  });

  it("클립보드 쓰기가 거부돼도 던지지 않고 배너가 남는다", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    render(<ErrorBanner code="UPSTREAM_UNAVAILABLE" requestId="req-reject" />);

    fireEvent.click(screen.getByRole("button", { name: /오류 ID/ }));
    await Promise.resolve();

    expect(screen.queryByText(/req-reject/)).not.toBeNull();
  });

  it("onRetry를 넘기면 재시도 버튼이 나오고 눌리면 호출된다", () => {
    const onRetry = vi.fn();
    render(
      <ErrorBanner code="TIMEOUT" requestId="req-3" onRetry={onRetry} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("SERVICE_DISABLED면 onRetry를 넘겨도 재시도 버튼이 없다", () => {
    const onRetry = vi.fn();
    render(
      <ErrorBanner
        code="SERVICE_DISABLED"
        requestId="req-4"
        onRetry={onRetry}
      />,
    );

    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("onRetry가 없으면 재시도 버튼을 그리지 않는다", () => {
    render(<ErrorBanner code="UPSTREAM_UNAVAILABLE" requestId="req-5" />);

    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
  });

  it("onReset을 넘기면 처음으로 텍스트 버튼이 나온다", () => {
    const onReset = vi.fn();
    render(
      <ErrorBanner code="TIMEOUT" requestId="req-6" onReset={onReset} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "처음으로" }));

    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("모든 버튼의 터치 타깃이 44px 이상이다", () => {
    render(
      <ErrorBanner
        code="TIMEOUT"
        requestId="req-7"
        onRetry={() => {}}
        onReset={() => {}}
      />,
    );

    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("min-h-11");
    }
  });

  it("에러 상태를 스크린리더에 알린다", () => {
    render(<ErrorBanner code="TIMEOUT" requestId="req-8" />);

    const banner = screen.getByRole("alert");
    expect(banner.className).toContain("border-danger/30");
  });
});
