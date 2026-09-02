/**
 * 거부 사유 문구 (FR-001, PRD Q3).
 *
 * 이 파일이 지키는 규칙은 하나다 — **사유 5종은 서로 다른 문장이다.**
 * 사용자가 할 수 있는 일이 사유마다 다르기 때문이다. 특히 `decode_failed`(브라우저가
 * 열지 못함)와 `unsupported_type`(우리가 받지 않음)을 같은 문장으로 쓰면 시스템 문제와
 * 정책 문제를 뭉개는 것이 되고, 그것은 ADR-005가 `lookup_failed`/`no_match`에 대해
 * 금지한 것과 같은 구조다.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RejectReason } from "@/lib/image";
import { MAX_PHOTOS } from "@/lib/env";
import { RejectedNotice } from "./RejectedNotice";

const REASONS: RejectReason[] = [
  "too_many",
  "too_large",
  "unsupported_type",
  "duplicate",
  "decode_failed",
];

function 문장(reason: RejectReason, count = 1): string {
  const { container } = render(<RejectedNotice reasons={Array<RejectReason>(count).fill(reason)} />);
  return container.textContent ?? "";
}

describe("RejectedNotice — 사유 5종은 겹치지 않는다", () => {
  it("5종이 전부 서로 다른 문장이다", () => {
    const 문장들 = REASONS.map((reason) => 문장(reason));

    expect(new Set(문장들).size).toBe(REASONS.length);
  });

  it("decode_failed는 unsupported_type과 다른 문장이고 JPG 내보내기를 안내한다", () => {
    const decode = 문장("decode_failed");
    const unsupported = 문장("unsupported_type");

    expect(decode).not.toBe(unsupported);
    expect(decode).toContain("JPG");
    // 브라우저가 못 연 것이지 형식 정책 위반이 아니다 — 목록을 나열하지 않는다.
    expect(decode).not.toContain("WEBP");
  });

  it("unsupported_type은 허용 형식을 알려 준다", () => {
    expect(문장("unsupported_type")).toContain("WEBP");
  });

  it("too_many는 장수 상한을 숫자로 말한다", () => {
    expect(문장("too_many")).toContain(String(MAX_PHOTOS));
  });

  it("duplicate는 사용자가 할 일을 요구하지 않는다 (이미 골랐다는 안내다)", () => {
    const text = 문장("duplicate");

    expect(text).toContain("같은 사진");
    expect(text).not.toContain("주세요");
  });

  it("too_large는 10MB 상한을 말한다", () => {
    expect(문장("too_large")).toContain("10MB");
  });
});

describe("RejectedNotice — 집계", () => {
  it("같은 사유가 여러 건이면 한 줄로 묶고 개수를 밝힌다", () => {
    render(<RejectedNotice reasons={["duplicate", "duplicate", "duplicate"]} />);

    expect(screen.getByText(/3장/)).toBeInTheDocument();
  });

  it("사유가 섞이면 사유마다 한 줄씩 나온다", () => {
    const { container } = render(
      <RejectedNotice reasons={["duplicate", "too_large", "duplicate"]} />,
    );

    expect(container.querySelectorAll("p")).toHaveLength(2);
  });

  it("거부가 없으면 아무것도 그리지 않는다", () => {
    const { container } = render(<RejectedNotice reasons={[]} />);

    expect(container).toBeEmptyDOMElement();
  });
});
