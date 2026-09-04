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

  it("requestId가 null이면 ID 줄 자체를 그리지 않는다 — '(없음)'을 지어내지 않는다", () => {
    render(<ErrorBanner code="UPSTREAM_UNAVAILABLE" requestId={null} />);

    const banner = screen.getByRole("alert");
    expect(screen.queryByRole("button", { name: /오류 ID/ })).toBeNull();
    expect(banner.textContent).not.toContain("오류 ID");
    // 없는 ID를 문자열로 덮으면 복사 버튼이 로그에서 찾을 수 없는 값을 건넨다.
    expect(banner.textContent).not.toContain("없음");
    // 배너 본문은 그대로 남는다.
    expect(banner.textContent).toContain("지금 책을 확인할 수 없어요");
  });

  it("requestId가 null이어도 재시도·처음으로는 그대로 동작한다", () => {
    const onRetry = vi.fn();
    render(<ErrorBanner code="TIMEOUT" requestId={null} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("에러 코드에 대응하는 정해진 문구를 보여준다", () => {
    render(<ErrorBanner code="TIMEOUT" requestId="req-1" />);

    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("시간이 오래 걸려");
  });

  /**
   * PRD 5번 [오프라인·네트워크 단절]이 적은 문구는 **"인터넷 연결을 확인해 주세요"**다.
   * 한 글자도 바꾸지 않는다 — 여기서 문구를 다듬으면 PRD와 코드가 갈라지고,
   * 갈라진 날 어느 쪽이 정본인지 아무도 모른다.
   */
  it("OFFLINE이면 PRD가 적은 문구를 그대로 쓴다", () => {
    render(<ErrorBanner code="OFFLINE" requestId={null} />);

    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("인터넷 연결을 확인해 주세요");
    // 상류 장애 문구가 함께 서면 두 사유를 가른 의미가 없다.
    expect(banner.textContent).not.toContain("지금 책을 확인할 수 없어요");
    // 목록에 없는 코드로 떨어져 기본 문구를 쓰는 것도 실패다 — 그러면 PRD 문구가
    // 화면에 없는 채로 이 배너가 "문제가 생겼어요"만 말한다.
    expect(banner.textContent).not.toContain("문제가 생겼어요");
  });

  it("OFFLINE에도 재시도 경로가 남는다 — 연결은 사용자가 되살릴 수 있다", () => {
    const onRetry = vi.fn();
    render(<ErrorBanner code="OFFLINE" requestId={null} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("UPSTREAM_UNAVAILABLE 문구는 그대로다 — OFFLINE이 생겨도 상류 장애를 덮지 않는다", () => {
    render(<ErrorBanner code="UPSTREAM_UNAVAILABLE" requestId="req-502" />);

    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("지금 책을 확인할 수 없어요. 잠시 후 다시 시도해 주세요");
    expect(banner.textContent).not.toContain("인터넷 연결을 확인해 주세요");
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
