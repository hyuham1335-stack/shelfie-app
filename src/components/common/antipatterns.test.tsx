/**
 * UI_GUIDE "AI 슬롭 안티패턴" 표에 대한 회귀 테스트. 삭제하지 마라.
 *
 * 공통 조각 위에 나머지 화면이 올라가므로, 여기서 안티패턴이 하나 들어가면
 * 그 클래스가 전 화면으로 복제된다.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Badge } from "./Badge";
import { ClaudeText } from "./ClaudeText";
import { ErrorBanner } from "./ErrorBanner";
import { Notice } from "./Notice";
import { Skeleton } from "./Skeleton";

afterEach(cleanup);

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

/** 렌더 가능한 모든 공통 조각을 한 화면에 모은다 */
function renderAll() {
  return render(
    <div>
      <ClaudeText label="AI 한줄평" text="가볍게 읽히는데 여운이 길다" />
      <ClaudeText label="추천 이유" text="지금 컨디션에 분량이 맞는다" />
      <ErrorBanner
        code="UPSTREAM_UNAVAILABLE"
        requestId="req-antipattern"
        onRetry={() => {}}
        onReset={() => {}}
      />
      <Notice>50권까지만 보여드려요 (2권 더 있음)</Notice>
      <Badge kind="reason" reason="unreadable" />
      <Badge kind="reason" reason="no_match" />
      <Badge kind="reason" reason="ambiguous" />
      <Badge kind="reason" reason="lookup_failed" />
      <Badge kind="rating" rating={8.6} />
      <Skeleton className="h-4 w-24" />
    </div>,
  );
}

describe("AI 슬롭 안티패턴", () => {
  it.each(FORBIDDEN)("렌더된 마크업에 %s가 없다", (token) => {
    const { container } = renderAll();

    expect(container.innerHTML).not.toContain(token);
  });

  it("색상은 globals.css 토큰 클래스로만 쓴다 (원시 hex 재입력 0건)", () => {
    const { container } = renderAll();

    expect(container.innerHTML).not.toContain("#");
  });

  it("'Powered by AI' 류의 장식 배지를 그리지 않는다", () => {
    const { container } = renderAll();

    expect(container.textContent).not.toContain("Powered by");
    expect(container.textContent).not.toContain("AI 기반");
  });
});
