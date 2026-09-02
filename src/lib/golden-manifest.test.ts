import { describe, expect, it } from "vitest";
import {
  GOLDEN_MANIFEST_VERSION,
  goldenManifestSchema,
  parseGoldenManifest,
} from "./golden-manifest";

/** 계약을 만족하는 최소 매니페스트. 각 테스트는 여기서 한 군데씩만 어긋뜨린다 */
function validManifest() {
  return {
    version: GOLDEN_MANIFEST_VERSION,
    setId: "hyu-shelf-2026a",
    photos: [
      {
        file: "shelf-01.jpg",
        sha256: "a".repeat(64),
        books: [
          { title: "죽음의 수용소에서", author: "빅터 프랭클", isbn13: "9788935210794" },
          { title: "사피엔스", author: "유발 하라리" },
        ],
      },
    ],
  };
}

describe("정상 매니페스트 (TRD 8번 골든 인식률 계약)", () => {
  it("계약대로 적힌 매니페스트는 통과한다", () => {
    const outcome = parseGoldenManifest(validManifest());

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.manifest.setId).toBe("hyu-shelf-2026a");
    expect(outcome.manifest.photos).toHaveLength(1);
    expect(outcome.manifest.photos[0].books).toHaveLength(2);
  });

  it("isbn13이 없는 책도 통과한다 — 20장 전부에 ISBN을 적는 것은 강제하지 않는다 (TRD 8번)", () => {
    const raw = validManifest();
    raw.photos[0].books = [{ title: "사피엔스", author: "유발 하라리" }];

    const outcome = parseGoldenManifest(raw);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.manifest.photos[0].books[0].isbn13).toBeUndefined();
  });

  it("스키마는 계약에 없는 필드를 도메인 값으로 올리지 않는다", () => {
    const parsed = goldenManifestSchema.safeParse({
      ...validManifest(),
      unknownField: "무시된다",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).not.toHaveProperty("unknownField");
  });
});

describe("버전 실패와 형식 실패를 뭉개지 않는다 (ADR-005와 같은 규율)", () => {
  it("우리가 모르는 미래 버전은 version 실패로 거부한다", () => {
    const raw = { ...validManifest(), version: GOLDEN_MANIFEST_VERSION + 1 };

    const outcome = parseGoldenManifest(raw);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    // 모르는 형식을 아는 척 파싱하면 없는 필드가 조용히 빠진 채 재현율이 계산된다.
    expect(outcome.reason).toBe("version");
    expect(outcome.detail).toContain(String(GOLDEN_MANIFEST_VERSION));
  });

  it("version 실패의 detail은 사람이 할 일(코드를 올린다)을 특정할 수 있게 두 값을 다 담는다", () => {
    const outcome = parseGoldenManifest({ ...validManifest(), version: 99 });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.detail).toContain("99");
  });

  it("version이 과거 값이어도 형식이 맞으면 통과한다 — 미래 버전만 거부한다", () => {
    const outcome = parseGoldenManifest({ ...validManifest(), version: 1 });

    expect(outcome.status).toBe("ok");
  });

  it("version이 숫자가 아니면 version이 아니라 schema 실패다", () => {
    const outcome = parseGoldenManifest({ ...validManifest(), version: "1" });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.reason).toBe("schema");
  });
});

describe("형식 위반은 전부 schema 실패이고 detail이 이유를 남긴다 (TRD 8번 skip 표)", () => {
  const cases: Array<[string, () => unknown]> = [
    [
      "photos가 빈 배열",
      () => ({ ...validManifest(), photos: [] }),
    ],
    [
      "setId가 빈 문자열",
      () => ({ ...validManifest(), setId: "" }),
    ],
    [
      "sha256이 없다 — 세트가 버전 관리 밖이라 입력을 특정할 유일한 수단이다 (ADR-010)",
      () => {
        const raw = validManifest();
        const { sha256: _dropped, ...rest } = raw.photos[0];
        return { ...raw, photos: [rest] };
      },
    ],
    [
      "sha256이 64자리 hex가 아니다",
      () => {
        const raw = validManifest();
        raw.photos[0].sha256 = "not-a-hash";
        return raw;
      },
    ],
    [
      "file이 빈 문자열",
      () => {
        const raw = validManifest();
        raw.photos[0].file = "";
        return raw;
      },
    ],
    [
      "books가 빈 배열 — 기대 목록이 없으면 그 사진으로 잴 것이 없다",
      () => {
        const raw = validManifest();
        raw.photos[0].books = [];
        return raw;
      },
    ],
    [
      "isbn13이 12자리",
      () => {
        const raw = validManifest();
        raw.photos[0].books[0].isbn13 = "978893521079";
        return raw;
      },
    ],
    [
      "isbn13에 숫자가 아닌 문자가 섞였다",
      () => {
        const raw = validManifest();
        raw.photos[0].books[0].isbn13 = "97889352107X4";
        return raw;
      },
    ],
    [
      "책 제목이 비었다",
      () => {
        const raw = validManifest();
        raw.photos[0].books[0].title = "";
        return raw;
      },
    ],
    [
      "저자가 비었다",
      () => {
        const raw = validManifest();
        raw.photos[0].books[0].author = "";
        return raw;
      },
    ],
    [
      "version이 없다",
      () => {
        const { version: _dropped, ...rest } = validManifest();
        return rest;
      },
    ],
    [
      "version이 0",
      () => ({ ...validManifest(), version: 0 }),
    ],
  ];

  for (const [name, build] of cases) {
    it(`${name} → schema 실패이고 detail이 비어 있지 않다`, () => {
      const outcome = parseGoldenManifest(build());

      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") return;
      expect(outcome.reason).toBe("schema");
      // 세트는 리포 밖에 있어 다른 사람이 고쳐야 하고, 그 사람이 가진 단서는 이 문자열뿐이다.
      expect(outcome.detail.length).toBeGreaterThan(0);
    });
  }

  it("detail은 어느 경로가 왜 틀렸는지를 담는다 (한 줄로 접는다)", () => {
    const raw = validManifest();
    raw.photos[0].sha256 = "not-a-hash";

    const outcome = parseGoldenManifest(raw);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.detail).toContain("photos");
    expect(outcome.detail).toContain("sha256");
    expect(outcome.detail).not.toContain("\n");
  });
});

describe("던지지 않는다 (ARCHITECTURE 검증 경계 패턴)", () => {
  // 파싱 실패는 예외가 아니라 판별 가능한 값이다. 예외로 던지면 호출부가 그것을
  // skip 사유로 바꾸지 못하고, "세트가 잘못됐다"와 "모델이 나빠졌다"가 같은 빨간불이 된다.
  const hostiles: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["문자열", "{}"],
    ["숫자", 42],
    ["배열", [{ version: 1 }]],
    ["빈 객체", {}],
  ];

  for (const [name, raw] of hostiles) {
    it(`${name}을(를) 줘도 던지지 않고 failed를 돌려준다`, () => {
      expect(() => parseGoldenManifest(raw)).not.toThrow();

      const outcome = parseGoldenManifest(raw);
      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") return;
      expect(outcome.reason).toBe("schema");
      expect(outcome.detail.length).toBeGreaterThan(0);
    });
  }
});

describe("형식 버전 상수", () => {
  it("이 코드가 이해하는 버전은 양의 정수다", () => {
    expect(Number.isInteger(GOLDEN_MANIFEST_VERSION)).toBe(true);
    expect(GOLDEN_MANIFEST_VERSION).toBeGreaterThan(0);
  });

  it("TRD 8번 예시가 적은 형식 버전은 1이다", () => {
    expect(GOLDEN_MANIFEST_VERSION).toBe(1);
  });
});
