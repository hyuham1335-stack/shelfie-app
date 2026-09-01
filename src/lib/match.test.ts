import { describe, expect, it } from "vitest";
import {
  MATCH_THRESHOLD,
  judge,
  normalizeAuthor,
  normalizeTitle,
  titleSimilarity,
  type LookupOutcome,
} from "./match";
import { MAX_ALADIN_CANDIDATES } from "./env";
import { unidentifiedBookSchema } from "./schemas";
import type { AladinCandidate, ExtractedCandidate } from "@/types/book";

function 후보(
  overrides: Partial<AladinCandidate> & Pick<AladinCandidate, "title" | "author">,
): AladinCandidate {
  return {
    isbn13: "9788936434120",
    publisher: "창비",
    coverUrl: "https://image.aladin.co.kr/product/1/cover/9788936434120.jpg",
    ...overrides,
  };
}

function 추출(
  overrides: Partial<ExtractedCandidate> & Pick<ExtractedCandidate, "title">,
): ExtractedCandidate {
  return {
    rawText: overrides.title,
    author: null,
    confidence: 0.9,
    photoIndex: 0,
    ...overrides,
  };
}

const ok = (candidates: AladinCandidate[]): LookupOutcome => ({ status: "ok", candidates });
const failed: LookupOutcome = { status: "failed" };

describe("normalizeTitle — 비교용 정규화", () => {
  it("공백·문장부호·대소문자 차이를 없앤다", () => {
    expect(normalizeTitle("소년이 온다!")).toBe(normalizeTitle("소년이온다"));
    expect(normalizeTitle("The Great Gatsby")).toBe(normalizeTitle("the  great, gatsby"));
  });

  it("괄호 부제를 떼어낸다 (알라딘 제목의 판형·부제 표기)", () => {
    expect(normalizeTitle("소년이 온다 (양장본 HardCover)")).toBe(normalizeTitle("소년이 온다"));
    expect(normalizeTitle("데미안 [개정판]")).toBe(normalizeTitle("데미안"));
  });

  it("제목 전체가 괄호로 감싸여 있으면 내용을 살린다 — 빈 문자열로 만들지 않는다", () => {
    expect(normalizeTitle("《채식주의자》")).toBe(normalizeTitle("채식주의자"));
  });

  it("자모 분리(NFD)로 들어온 한글을 같은 값으로 정규화한다", () => {
    expect(normalizeTitle("소년이 온다".normalize("NFD"))).toBe(normalizeTitle("소년이 온다"));
  });

  it("권 번호는 남긴다 — 다른 책을 같은 책으로 만들지 않기 위해서다", () => {
    expect(normalizeTitle("파친코 1")).not.toBe(normalizeTitle("파친코 2"));
  });

  it("글자와 숫자가 하나도 없으면 빈 문자열이다 (판독 불가 신호)", () => {
    expect(normalizeTitle("--- ??")).toBe("");
  });
});

describe("normalizeAuthor — 역할 표기를 떼고 이름만 남긴다", () => {
  it("알라딘의 역할 괄호를 제거한다", () => {
    expect(normalizeAuthor("한강 (지은이)")).toBe(normalizeAuthor("한강"));
  });

  it("공동 저자·역자는 쉼표로 구분해 보존한다", () => {
    expect(normalizeAuthor("이민진 (지은이), 신승미 (옮긴이)")).toBe("이민진,신승미");
  });

  it("괄호 없는 역할 표기도 떼어낸다", () => {
    expect(normalizeAuthor("한강 지음")).toBe(normalizeAuthor("한강"));
  });
});

describe("titleSimilarity — 정규화 후 Levenshtein 기반 0~1", () => {
  it("같은 제목은 1.0이다", () => {
    expect(titleSimilarity("소년이 온다", "소년이 온다")).toBe(1);
  });

  it("공백·문장부호·괄호 부제만 다르면 임계값을 넘는다", () => {
    expect(titleSimilarity("소년이온다", "소년이 온다 (양장본)")).toBeGreaterThanOrEqual(
      MATCH_THRESHOLD,
    );
  });

  it("완전히 다른 제목은 임계값에 한참 못 미친다", () => {
    expect(titleSimilarity("소년이 온다", "코스모스")).toBeLessThan(0.3);
  });

  it("한 글자 차이는 임계값을 넘고, 절반이 다르면 넘지 못한다", () => {
    expect(titleSimilarity("코스모스", "코스모스2")).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(titleSimilarity("어린 왕자", "어린 왕좌 이야기")).toBeLessThan(MATCH_THRESHOLD);
  });

  it("정규화 후 비교할 글자가 없으면 0이다 — 기호끼리 일치시키지 않는다", () => {
    expect(titleSimilarity("!!!", "???")).toBe(0);
  });

  it("임계값은 0.8이다 (FR-003)", () => {
    expect(MATCH_THRESHOLD).toBe(0.8);
  });
});

describe("judge — 확인/미확인 판정 (FR-003, TR-004)", () => {
  it("유사도 0.8 이상 후보가 정확히 1건이면 확인이다", () => {
    const verdict = judge(
      추출({ title: "소년이 온다" }),
      ok([
        후보({ title: "소년이 온다 (양장본)", author: "한강 (지은이)" }),
        후보({ isbn13: "9788954699914", title: "코스모스", author: "칼 세이건" }),
      ]),
    );

    expect(verdict.kind).toBe("identified");
    if (verdict.kind === "identified") {
      expect(verdict.candidate.isbn13).toBe("9788936434120");
    }
  });

  it("유사도 0.8 이상 후보가 0건이면 no_match이고 후보를 붙이지 않는다", () => {
    const verdict = judge(
      추출({ title: "소년이 온다" }),
      ok([후보({ title: "코스모스", author: "칼 세이건" })]),
    );

    expect(verdict).toEqual({ kind: "unidentified", reason: "no_match", candidates: [] });
  });

  it("검색 결과가 빈 배열이면 no_match다", () => {
    const verdict = judge(추출({ title: "소년이 온다" }), ok([]));

    expect(verdict).toMatchObject({ kind: "unidentified", reason: "no_match" });
  });

  it("0.8 이상이 2건이어도 저자가 하나만 일치하면 tie-break로 확인이다", () => {
    const verdict = judge(
      추출({ title: "채식주의자", author: "한강" }),
      ok([
        후보({ isbn13: "9788936434595", title: "채식주의자", author: "김영하 (지은이)" }),
        후보({ isbn13: "9788936433598", title: "채식주의자 (개정판)", author: "한강 (지은이)" }),
      ]),
    );

    expect(verdict.kind).toBe("identified");
    if (verdict.kind === "identified") {
      expect(verdict.candidate.isbn13).toBe("9788936433598");
    }
  });

  it("0.8 이상이 2건이고 저자로도 좁혀지지 않으면 ambiguous이고 후보를 채운다", () => {
    const verdict = judge(
      추출({ title: "채식주의자", author: null }),
      ok([
        후보({ isbn13: "9788936434595", title: "채식주의자", author: "한강 (지은이)" }),
        후보({ isbn13: "9788936433598", title: "채식주의자 (개정판)", author: "한강 (지은이)" }),
      ]),
    );

    expect(verdict).toMatchObject({ kind: "unidentified", reason: "ambiguous" });
    if (verdict.kind === "unidentified") {
      expect(verdict.candidates.map((c) => c.isbn13)).toEqual([
        "9788936434595",
        "9788936433598",
      ]);
    }
  });

  it("저자가 둘 다 일치해도 좁혀지지 않으면 ambiguous다 — 아무거나 고르지 않는다", () => {
    const verdict = judge(
      추출({ title: "채식주의자", author: "한강 지음" }),
      ok([
        후보({ isbn13: "9788936434595", title: "채식주의자", author: "한강 (지은이)" }),
        후보({ isbn13: "9788936433598", title: "채식주의자", author: "한강 (지은이)" }),
      ]),
    );

    expect(verdict).toMatchObject({ kind: "unidentified", reason: "ambiguous" });
  });

  it("ambiguous 후보는 MAX_ALADIN_CANDIDATES(5)건을 넘지 않는다", () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      후보({ isbn13: `978893643400${i}`, title: "채식주의자", author: "한강" }),
    );

    const verdict = judge(추출({ title: "채식주의자", author: null }), ok(many));

    expect(verdict).toMatchObject({ kind: "unidentified", reason: "ambiguous" });
    if (verdict.kind === "unidentified") {
      expect(verdict.candidates).toHaveLength(MAX_ALADIN_CANDIDATES);
    }
  });

  // ADR-005 회귀 테스트 — 삭제 금지.
  it("조회에 실패하면 후보가 있든 없든 lookup_failed다 (ADR-005)", () => {
    const verdict = judge(추출({ title: "소년이 온다" }), failed);

    expect(verdict).toEqual({ kind: "unidentified", reason: "lookup_failed", candidates: [] });
  });

  it("조회 실패를 no_match로 뭉개지 않는다 — 같은 입력의 두 사유가 다른 값이다 (ADR-005)", () => {
    const 후보목록 = [후보({ title: "소년이 온다", author: "한강" })];
    const 성공 = judge(추출({ title: "소년이 온다" }), ok(후보목록));
    const 실패 = judge(추출({ title: "소년이 온다" }), failed);

    expect(성공.kind).toBe("identified");
    expect(실패).toMatchObject({ reason: "lookup_failed" });
    expect(실패).not.toMatchObject({ reason: "no_match" });
  });

  it("ISBN13이 없는 레코드는 유사도가 1.0이어도 확인으로 승격하지 않는다 (TR-004)", () => {
    const verdict = judge(
      추출({ title: "소년이 온다", author: "한강" }),
      ok([후보({ isbn13: "", title: "소년이 온다", author: "한강 (지은이)" })]),
    );

    expect(verdict).toMatchObject({ kind: "unidentified", reason: "no_match" });
  });

  it("ISBN13 형식이 틀린 레코드도 승격하지 않고, 남은 정상 후보만 본다", () => {
    const verdict = judge(
      추출({ title: "소년이 온다" }),
      ok([
        후보({ isbn13: "89893643412", title: "소년이 온다", author: "한강" }),
        후보({ isbn13: "9788936434120", title: "소년이 온다 (양장본)", author: "한강" }),
      ]),
    );

    expect(verdict.kind).toBe("identified");
    if (verdict.kind === "identified") {
      expect(verdict.candidate.isbn13).toBe("9788936434120");
    }
  });

  it("ISBN13 없는 후보는 ambiguous 후보 목록에도 들어가지 않는다", () => {
    const verdict = judge(
      추출({ title: "채식주의자", author: null }),
      ok([
        후보({ isbn13: "9788936434595", title: "채식주의자", author: "한강" }),
        후보({ isbn13: "9788936433598", title: "채식주의자", author: "한강" }),
        후보({ isbn13: "1234", title: "채식주의자", author: "한강" }),
      ]),
    );

    expect(verdict).toMatchObject({ kind: "unidentified", reason: "ambiguous" });
    if (verdict.kind === "unidentified") {
      expect(verdict.candidates).toHaveLength(2);
    }
  });

  it("판독 자체가 불완전하면 알라딘 후보를 보지도 않고 unreadable이다", () => {
    const verdict = judge(
      추출({ title: "…", rawText: "…" }),
      ok([후보({ title: "…", author: "한강" })]),
    );

    expect(verdict).toEqual({ kind: "unidentified", reason: "unreadable", candidates: [] });
  });

  it("판독 불가는 조회 실패보다 먼저 판정된다 — 우리 쪽 한계를 시스템 장애로 보고하지 않는다", () => {
    expect(judge(추출({ title: "###" }), failed)).toMatchObject({ reason: "unreadable" });
  });
});

describe("판정 결과는 unidentifiedBookSchema를 그대로 통과한다 (계약 정합성)", () => {
  it.each(["no_match", "lookup_failed", "unreadable"] as const)(
    "%s 판정에는 후보가 붙지 않아 .refine을 통과한다",
    (reason) => {
      const verdict =
        reason === "lookup_failed"
          ? judge(추출({ title: "소년이 온다" }), failed)
          : reason === "unreadable"
            ? judge(추출({ title: "###" }), ok([]))
            : judge(추출({ title: "소년이 온다" }), ok([]));

      expect(verdict.kind).toBe("unidentified");
      if (verdict.kind === "unidentified") {
        expect(verdict.reason).toBe(reason);
        const parsed = unidentifiedBookSchema.safeParse({
          rawText: "소년이 온다",
          reason: verdict.reason,
          candidates: verdict.candidates,
        });
        expect(parsed.success).toBe(true);
      }
    },
  );

  it("ambiguous 판정의 후보 목록도 스키마를 통과한다", () => {
    const verdict = judge(
      추출({ title: "채식주의자", author: null }),
      ok([
        후보({ isbn13: "9788936434595", title: "채식주의자", author: "한강" }),
        후보({ isbn13: "9788936433598", title: "채식주의자", author: "한강" }),
      ]),
    );

    if (verdict.kind !== "unidentified") throw new Error("ambiguous 판정이어야 한다");
    const parsed = unidentifiedBookSchema.safeParse({
      rawText: "채식주의자",
      reason: verdict.reason,
      candidates: verdict.candidates,
    });
    expect(parsed.success).toBe(true);
  });
});
