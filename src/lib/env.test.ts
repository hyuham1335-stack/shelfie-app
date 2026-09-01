import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, MAX_PHOTOS, MAX_IDENTIFIED_BOOKS } from "./env";

describe("환경 상수", () => {
  it("모델 기본값은 claude-opus-5다 (TRD 2번 기술 스택)", () => {
    expect(DEFAULT_MODEL).toBe("claude-opus-5");
  });

  it("사진 장수 상한은 5다 (FR-001)", () => {
    expect(MAX_PHOTOS).toBe(5);
  });

  it("확인된 책 목록 상한은 50이다 (FR-005)", () => {
    expect(MAX_IDENTIFIED_BOOKS).toBe(50);
  });
});
