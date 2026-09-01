import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  MAX_PHOTOS,
  MAX_IDENTIFIED_BOOKS,
  MAX_UNIDENTIFIED_BOOKS,
  MAX_CANDIDATES_PER_PHOTO,
  MAX_CANDIDATES_FOR_LOOKUP,
  MAX_ALADIN_CANDIDATES,
} from "./env";

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

describe("증폭 방지 상한 (TRD 10번 — 판독 한 번의 이상 동작이 알라딘 일일 한도를 소진하지 못하게 한다)", () => {
  it("미확인 목록 상한은 100이다 (TR-005)", () => {
    expect(MAX_UNIDENTIFIED_BOOKS).toBe(100);
  });

  it("사진 한 장에서 뽑을 수 있는 후보는 60건이다 (TR-003)", () => {
    expect(MAX_CANDIDATES_PER_PHOTO).toBe(60);
  });

  it("알라딘 조회 전 후보 총량은 80건으로 자른다 (TR-005)", () => {
    expect(MAX_CANDIDATES_FOR_LOOKUP).toBe(80);
  });

  it("사용자에게 보여줄 알라딘 후보는 5건이다 (TR-008, ambiguous 후보와 같은 값)", () => {
    expect(MAX_ALADIN_CANDIDATES).toBe(5);
  });

  it("조회 전 총량 상한은 사진당 상한보다 크고, 5장 전량(300건)보다는 작다", () => {
    expect(MAX_CANDIDATES_FOR_LOOKUP).toBeGreaterThan(MAX_CANDIDATES_PER_PHOTO);
    expect(MAX_CANDIDATES_FOR_LOOKUP).toBeLessThan(MAX_CANDIDATES_PER_PHOTO * MAX_PHOTOS);
  });
});
