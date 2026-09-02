import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertServerEnv,
  getAladinTtbKey,
  getAnthropicApiKey,
  isServiceEnabled,
  getGoldenSetDir,
  DEFAULT_MODEL,
  GOLDEN_MIN_RECALL,
  GOLDEN_MAX_MISIDENTIFIED,
  MAX_PHOTOS,
  MAX_IDENTIFIED_BOOKS,
  MAX_UNIDENTIFIED_BOOKS,
  MAX_CANDIDATES_PER_PHOTO,
  MAX_CANDIDATES_FOR_LOOKUP,
  MAX_ALADIN_CANDIDATES,
  ANALYZE_RETRY_DELAYS_MS,
  MAX_ANALYZE_RETRIES,
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

describe("서버 전용 시크릿 접근자 (TRD 7번 — 조용한 폴백 금지)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("키가 없으면 null을 돌려준다 — 부재는 오류가 아니라 목업 모드다 (TRD 9번)", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("ALADIN_TTB_KEY", undefined);

    expect(getAnthropicApiKey()).toBeNull();
    expect(getAladinTtbKey()).toBeNull();
  });

  it("빈 문자열도 부재로 본다 (.env.example이 비워 두는 것을 기본으로 정했다)", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ALADIN_TTB_KEY", "");

    expect(getAnthropicApiKey()).toBeNull();
    expect(getAladinTtbKey()).toBeNull();
  });

  it("값이 있으면 그 값을 돌려주고 양끝 공백은 떼어 낸다", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "  sk-ant-test-key  ");

    expect(getAnthropicApiKey()).toBe("sk-ant-test-key");
  });

  it("공백만 있는 값은 zod가 거부한다 — 부재와 달리 '잘못 설정한 것'이다", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "   ");

    expect(() => getAnthropicApiKey()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("검증 실패 메시지에 값이 들어 있지 않다 (시크릿 유출 회귀 — 이 테스트는 삭제하지 않는다)", () => {
    // 시크릿이 로그로 새는 가장 흔한 경로가 검증 에러 메시지다 (TRD 6.5).
    const leaked = "s3cr3t-should-never-appear";
    vi.stubEnv("SERVICE_ENABLED", leaked);

    let message = "";
    try {
      isServiceEnabled();
    } catch (error) {
      message = error instanceof Error ? [error.message, error.stack].join(" ") : String(error);
    }

    expect(message).toContain("SERVICE_ENABLED");
    expect(message).not.toContain(leaked);
  });
});

describe("긴급 차단 스위치 (TRD 7번 SERVICE_ENABLED)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("미설정이면 활성이다 — 기본값 true", () => {
    vi.stubEnv("SERVICE_ENABLED", undefined);

    expect(isServiceEnabled()).toBe(true);
  });

  it("false면 비활성이다", () => {
    vi.stubEnv("SERVICE_ENABLED", "false");

    expect(isServiceEnabled()).toBe(false);
  });

  it("true면 활성이다", () => {
    vi.stubEnv("SERVICE_ENABLED", "true");

    expect(isServiceEnabled()).toBe(true);
  });

  it("true도 false도 아닌 값은 거부한다 — 오타로 차단 스위치가 조용히 죽으면 안 된다", () => {
    vi.stubEnv("SERVICE_ENABLED", "0");

    expect(() => isServiceEnabled()).toThrow(/SERVICE_ENABLED/);
  });
});

describe("assertServerEnv — 부팅 시 1회 검증 (TRD 7번 '런타임 중 조용한 실패 금지')", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function stubKeys(value: string | undefined): void {
    vi.stubEnv("ANTHROPIC_API_KEY", value);
    vi.stubEnv("ALADIN_TTB_KEY", value);
    vi.stubEnv("BOOK_PROOF_SECRET", value);
  }

  it("프로덕션에서 필수 키가 없으면 던진다", () => {
    vi.stubEnv("NODE_ENV", "production");
    stubKeys(undefined);

    expect(() => assertServerEnv()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("프로덕션 에러 메시지는 빠진 변수를 한 번에 모두 알린다", () => {
    vi.stubEnv("NODE_ENV", "production");
    stubKeys(undefined);

    let message = "";
    try {
      assertServerEnv();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("ANTHROPIC_API_KEY");
    expect(message).toContain("ALADIN_TTB_KEY");
    expect(message).toContain("BOOK_PROOF_SECRET");
  });

  it("프로덕션이라도 키가 전부 있으면 던지지 않는다", () => {
    vi.stubEnv("NODE_ENV", "production");
    stubKeys("filled-value-for-test");

    expect(() => assertServerEnv()).not.toThrow();
  });

  it("개발 환경에서 키가 없어도 던지지 않고 경고만 남긴다 (목업 모드 원칙 — TRD 9번)", () => {
    vi.stubEnv("NODE_ENV", "development");
    stubKeys(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => assertServerEnv()).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it("개발 환경이어도 형식이 틀린 값은 거부한다", () => {
    vi.stubEnv("NODE_ENV", "development");
    stubKeys("   ");

    expect(() => assertServerEnv()).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("모듈 최상위 부수효과 금지 (회귀)", () => {
  it("환경변수가 전부 비어 있어도 import만으로는 아무 예외도 나지 않는다", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("ALADIN_TTB_KEY", undefined);
    vi.stubEnv("BOOK_PROOF_SECRET", undefined);
    vi.stubEnv("SERVICE_ENABLED", undefined);

    vi.resetModules();
    await expect(import("./env")).resolves.toBeDefined();

    vi.unstubAllEnvs();
  });
});

describe("분석 재시도 간격 (FR-010)", () => {
  it("스케줄이 PRD 한 줄 그대로다 — 0초 → 5초 → 15초", () => {
    expect([...ANALYZE_RETRY_DELAYS_MS]).toEqual([0, 5_000, 15_000]);
  });

  it("상한과 스케줄 길이가 갈라지지 않는다 (회귀 — 삭제하지 마라)", () => {
    // 갈라지는 순간 마지막 재시도의 간격이 undefined가 된다.
    expect(MAX_ANALYZE_RETRIES).toBe(3);
    expect(ANALYZE_RETRY_DELAYS_MS.length).toBe(MAX_ANALYZE_RETRIES);
    for (let attempt = 0; attempt < MAX_ANALYZE_RETRIES; attempt += 1) {
      expect(typeof ANALYZE_RETRY_DELAYS_MS[attempt]).toBe("number");
    }
  });

  it("첫 재시도는 간격이 0이라 즉시 나간다", () => {
    expect(ANALYZE_RETRY_DELAYS_MS[0]).toBe(0);
  });
});

describe("골든 인식률 임계값 (TRD 8번 판정 규약 · ADR-010)", () => {
  it("재현율 하한은 0.90이다 (TR-003)", () => {
    expect(GOLDEN_MIN_RECALL).toBe(0.9);
  });

  it("허용 오확인은 0건이다 (TR-004 — 없는 책을 있다고 보여주지 않는다)", () => {
    expect(GOLDEN_MAX_MISIDENTIFIED).toBe(0);
  });
});

describe("골든 세트 디렉토리 접근자 (TRD 7번 GOLDEN_SET_DIR)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("미설정이면 null이다 — 세트가 없는 것은 오류가 아니라 skip 사유다", () => {
    vi.stubEnv("GOLDEN_SET_DIR", undefined);

    expect(getGoldenSetDir()).toBeNull();
  });

  it("빈 문자열·공백만 있는 값도 null이다. 던지지 않는다", () => {
    vi.stubEnv("GOLDEN_SET_DIR", "   ");

    expect(() => getGoldenSetDir()).not.toThrow();
    expect(getGoldenSetDir()).toBeNull();
  });

  it("값이 있으면 양끝 공백을 떼고 돌려준다", () => {
    vi.stubEnv("GOLDEN_SET_DIR", "  /tmp/golden-set  ");

    expect(getGoldenSetDir()).toBe("/tmp/golden-set");
  });
});
