import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_FLOOR,
  capIdentified,
  capUnidentified,
  dedupeByIsbn,
  reduceBeforeLookup,
} from "./merge";
import {
  MAX_CANDIDATES_FOR_LOOKUP,
  MAX_IDENTIFIED_BOOKS,
  MAX_UNIDENTIFIED_BOOKS,
  MAX_PHOTOS,
} from "./env";
import type { ExtractedCandidate } from "@/types/book";

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

/** 13자리 ISBN을 인덱스로 만든다. 앞 7자리 고정 + 6자리 일련번호 */
function isbn(n: number): string {
  return `9788936${String(n).padStart(6, "0")}`;
}

type 확인된책 = { isbn13: string; aladinRating: number | null; photoIndex: number };

function 확인(overrides: Partial<확인된책> & { isbn13: string }): 확인된책 {
  return { aladinRating: null, photoIndex: 0, ...overrides };
}

describe("reduceBeforeLookup — ① 알라딘 조회 전 축소 (FR-012)", () => {
  it("confidence 0.29는 강등되고 0.30은 조회 대상이다 (경계값)", () => {
    const { toLookup, unreadable } = reduceBeforeLookup([
      추출({ title: "아슬아슬", confidence: 0.29 }),
      추출({ title: "간신히", confidence: CONFIDENCE_FLOOR }),
    ]);

    expect(toLookup.map((c) => c.title)).toEqual(["간신히"]);
    expect(unreadable.map((c) => c.title)).toEqual(["아슬아슬"]);
  });

  it("CONFIDENCE_FLOOR는 0.3이다", () => {
    expect(CONFIDENCE_FLOOR).toBe(0.3);
  });

  it("강등된 후보를 조용히 버리지 않는다 — 전량이 두 바구니 중 하나에 남는다", () => {
    const 입력 = [
      추출({ title: "가", confidence: 0.1 }),
      추출({ title: "나", confidence: 0.5 }),
      추출({ title: "다", confidence: 0.0 }),
    ];

    const { toLookup, unreadable } = reduceBeforeLookup(입력);

    expect(toLookup.length + unreadable.length).toBe(입력.length);
  });

  it("제목+저자가 정규화 후 같은 후보 3건이 1건으로 병합된다", () => {
    const { toLookup } = reduceBeforeLookup([
      추출({ title: "82년생 김지영", author: "조남주", photoIndex: 1 }),
      추출({ title: "82년생김지영", author: "조남주 (지은이)", photoIndex: 2 }),
      추출({ title: "82년생 김지영!", author: "조남주", photoIndex: 3 }),
    ]);

    expect(toLookup).toHaveLength(1);
  });

  it("병합된 대표는 확신도가 가장 높은 후보이고, photoIndex는 최초 등장 값이다", () => {
    const { toLookup } = reduceBeforeLookup([
      추출({ title: "소년이 온다", rawText: "소년이온ㄷ", confidence: 0.4, photoIndex: 1 }),
      추출({ title: "소년이온다", rawText: "소년이 온다", confidence: 0.95, photoIndex: 3 }),
    ]);

    expect(toLookup).toHaveLength(1);
    expect(toLookup[0].confidence).toBe(0.95);
    expect(toLookup[0].rawText).toBe("소년이 온다");
    expect(toLookup[0].photoIndex).toBe(1);
  });

  it("제목이 같아도 저자가 다르면 병합하지 않는다", () => {
    const { toLookup } = reduceBeforeLookup([
      추출({ title: "채식주의자", author: "한강" }),
      추출({ title: "채식주의자", author: null }),
    ]);

    expect(toLookup).toHaveLength(2);
  });

  it("확신도 미달 후보는 병합 대상에서도 빠진다 — 강등이 먼저다", () => {
    const { toLookup, unreadable } = reduceBeforeLookup([
      추출({ title: "파친코", author: "이민진", confidence: 0.2 }),
      추출({ title: "파친코", author: "이민진", confidence: 0.9 }),
    ]);

    expect(toLookup).toHaveLength(1);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].confidence).toBe(0.2);
  });

  it("후보 300건을 넣어도 toLookup이 80건을 넘지 않는다 (TR-005 성공 지표)", () => {
    const 후보들 = Array.from({ length: 300 }, (_, i) =>
      추출({
        title: `서로 다른 책 ${i}`,
        confidence: 0.3 + (i % 70) / 100,
        photoIndex: i % MAX_PHOTOS,
      }),
    );

    const { toLookup } = reduceBeforeLookup(후보들);

    expect(toLookup).toHaveLength(MAX_CANDIDATES_FOR_LOOKUP);
    expect(MAX_CANDIDATES_FOR_LOOKUP).toBe(80);
  });

  it("80건 상한으로 잘린 후보는 버려지지 않고 unreadable로 남는다", () => {
    const 후보들 = Array.from({ length: 300 }, (_, i) =>
      추출({ title: `책 ${i}`, confidence: 0.5, photoIndex: i % MAX_PHOTOS }),
    );

    const { toLookup, unreadable } = reduceBeforeLookup(후보들);

    expect(toLookup.length + unreadable.length).toBe(300);
    expect(unreadable).toHaveLength(300 - MAX_CANDIDATES_FOR_LOOKUP);
  });

  it("조회 대상은 확신도 내림차순으로 남는다", () => {
    const 후보들 = Array.from({ length: 120 }, (_, i) =>
      추출({ title: `책 ${i}`, confidence: i / 200 + 0.3 }),
    );

    const { toLookup } = reduceBeforeLookup(후보들);

    const 최저 = Math.min(...toLookup.map((c) => c.confidence));
    const 최고강등 = Math.max(...reduceBeforeLookup(후보들).unreadable.map((c) => c.confidence));
    expect(최저).toBeGreaterThanOrEqual(최고강등);
  });

  it("입력 순서를 바꿔도 같은 결과를 낸다 (결정성)", () => {
    const 후보들 = Array.from({ length: 200 }, (_, i) =>
      추출({ title: `책 ${i}`, confidence: 0.5, photoIndex: i % MAX_PHOTOS }),
    );
    const 뒤집힌 = [...후보들].reverse();

    const a = reduceBeforeLookup(후보들).toLookup;
    const b = reduceBeforeLookup(뒤집힌).toLookup;

    expect(b).toEqual(a);
  });

  it("입력 배열과 원소를 변형하지 않는다", () => {
    const 원본 = [
      추출({ title: "가", confidence: 0.1 }),
      추출({ title: "가", confidence: 0.9, photoIndex: 2 }),
      추출({ title: "가", confidence: 0.5, photoIndex: 1 }),
    ];
    const 스냅샷 = structuredClone(원본);

    reduceBeforeLookup(원본);

    expect(원본).toEqual(스냅샷);
  });

  it("빈 입력은 빈 결과를 낸다", () => {
    expect(reduceBeforeLookup([])).toEqual({ toLookup: [], unreadable: [] });
  });
});

describe("dedupeByIsbn — ② ISBN13 중복 제거 (FR-004)", () => {
  it("같은 책이 사진 5장에 모두 등장해도 결과 1권이고 photoIndex는 최초 등장 값이다", () => {
    const 책들 = Array.from({ length: MAX_PHOTOS }, (_, i) =>
      확인({ isbn13: isbn(1), photoIndex: i }),
    );

    const 결과 = dedupeByIsbn([...책들].reverse());

    expect(결과).toHaveLength(1);
    expect(결과[0].photoIndex).toBe(0);
  });

  it("서로 다른 ISBN은 입력 순서 그대로 남는다", () => {
    const 결과 = dedupeByIsbn([
      확인({ isbn13: isbn(3) }),
      확인({ isbn13: isbn(1) }),
      확인({ isbn13: isbn(2) }),
    ]);

    expect(결과.map((b) => b.isbn13)).toEqual([isbn(3), isbn(1), isbn(2)]);
  });

  it("중복이 아닌 필드는 최초 등장 레코드의 값을 유지한다", () => {
    const 결과 = dedupeByIsbn([
      { isbn13: isbn(1), photoIndex: 2, aladinRating: 9.1, claudeNote: "먼저" },
      { isbn13: isbn(1), photoIndex: 1, aladinRating: 3.0, claudeNote: "나중" },
    ]);

    expect(결과).toHaveLength(1);
    expect(결과[0].claudeNote).toBe("먼저");
    expect(결과[0].aladinRating).toBe(9.1);
    expect(결과[0].photoIndex).toBe(1);
  });

  it("입력 배열과 원소를 변형하지 않는다", () => {
    const 원본 = [
      확인({ isbn13: isbn(1), photoIndex: 3 }),
      확인({ isbn13: isbn(1), photoIndex: 1 }),
    ];
    const 스냅샷 = structuredClone(원본);

    dedupeByIsbn(원본);

    expect(원본).toEqual(스냅샷);
  });

  it("빈 입력은 빈 배열을 낸다", () => {
    expect(dedupeByIsbn([])).toEqual([]);
  });
});

describe("capIdentified — ③ 확인된 책 결정적 절단 (FR-005)", () => {
  it("51권 입력 시 정확히 50권 + overflowCount 1", () => {
    const 책들 = Array.from({ length: MAX_IDENTIFIED_BOOKS + 1 }, (_, i) =>
      확인({ isbn13: isbn(i), aladinRating: 10 - i / 100 }),
    );

    const { kept, overflowCount } = capIdentified(책들);

    expect(kept).toHaveLength(MAX_IDENTIFIED_BOOKS);
    expect(overflowCount).toBe(1);
  });

  it("상한 이하면 넘친 개수가 0이다", () => {
    const { kept, overflowCount } = capIdentified([확인({ isbn13: isbn(1) })]);

    expect(kept).toHaveLength(1);
    expect(overflowCount).toBe(0);
  });

  it("평점 내림차순으로 정렬한다", () => {
    const { kept } = capIdentified([
      확인({ isbn13: isbn(1), aladinRating: 7.0 }),
      확인({ isbn13: isbn(2), aladinRating: 9.5 }),
      확인({ isbn13: isbn(3), aladinRating: 8.2 }),
    ]);

    expect(kept.map((b) => b.aladinRating)).toEqual([9.5, 8.2, 7.0]);
  });

  it("평점이 null인 책은 최하위다 — 0점보다도 뒤로 간다", () => {
    const { kept } = capIdentified([
      확인({ isbn13: isbn(1), aladinRating: null }),
      확인({ isbn13: isbn(2), aladinRating: 0 }),
      확인({ isbn13: isbn(3), aladinRating: 5 }),
    ]);

    expect(kept.map((b) => b.isbn13)).toEqual([isbn(3), isbn(2), isbn(1)]);
  });

  it("평점이 동점이면 photoIndex 오름차순으로 갈린다", () => {
    const { kept } = capIdentified([
      확인({ isbn13: isbn(1), aladinRating: 8, photoIndex: 4 }),
      확인({ isbn13: isbn(2), aladinRating: 8, photoIndex: 0 }),
      확인({ isbn13: isbn(3), aladinRating: 8, photoIndex: 2 }),
    ]);

    expect(kept.map((b) => b.photoIndex)).toEqual([0, 2, 4]);
  });

  it("평점 동점 + photoIndex 동점이면 isbn13 오름차순으로 갈린다", () => {
    const { kept } = capIdentified([
      확인({ isbn13: isbn(30), aladinRating: 8, photoIndex: 1 }),
      확인({ isbn13: isbn(10), aladinRating: 8, photoIndex: 1 }),
      확인({ isbn13: isbn(20), aladinRating: 8, photoIndex: 1 }),
    ]);

    expect(kept.map((b) => b.isbn13)).toEqual([isbn(10), isbn(20), isbn(30)]);
  });

  it("null끼리도 photoIndex·isbn13으로 결정적으로 갈린다", () => {
    const { kept } = capIdentified([
      확인({ isbn13: isbn(2), aladinRating: null, photoIndex: 1 }),
      확인({ isbn13: isbn(1), aladinRating: null, photoIndex: 1 }),
      확인({ isbn13: isbn(3), aladinRating: null, photoIndex: 0 }),
    ]);

    expect(kept.map((b) => b.isbn13)).toEqual([isbn(3), isbn(1), isbn(2)]);
  });

  it("절단 순서 결정성 — 평점 null이 섞인 입력을 순서만 바꿔 넣어도 결과가 같다", () => {
    const 책들 = Array.from({ length: MAX_IDENTIFIED_BOOKS + 20 }, (_, i) =>
      확인({
        isbn13: isbn(i),
        // 평점을 일부러 뭉치게 만들어 동점 tie-break를 타게 한다. 3의 배수는 null
        aladinRating: i % 3 === 0 ? null : (i % 5) * 2,
        photoIndex: i % MAX_PHOTOS,
      }),
    );

    const 정순 = capIdentified(책들);
    const 역순 = capIdentified([...책들].reverse());
    const 섞음 = capIdentified([...책들].sort((a, b) => a.isbn13.localeCompare(b.isbn13)));

    expect(역순).toEqual(정순);
    expect(섞음).toEqual(정순);
    expect(정순.kept).toHaveLength(MAX_IDENTIFIED_BOOKS);
    expect(정순.overflowCount).toBe(20);
  });

  it("입력 배열과 원소를 변형하지 않는다", () => {
    const 원본 = [
      확인({ isbn13: isbn(2), aladinRating: 1 }),
      확인({ isbn13: isbn(1), aladinRating: 9 }),
    ];
    const 스냅샷 = structuredClone(원본);

    capIdentified(원본);

    expect(원본).toEqual(스냅샷);
  });

  it("빈 입력은 빈 결과를 낸다", () => {
    expect(capIdentified([])).toEqual({ kept: [], overflowCount: 0 });
  });
});

describe("capUnidentified — ③ 미확인 절단", () => {
  it("101건 입력 시 100건 + overflowCount 1", () => {
    const 미확인 = Array.from({ length: MAX_UNIDENTIFIED_BOOKS + 1 }, (_, i) => ({
      rawText: `원문 ${i}`,
    }));

    const { kept, overflowCount } = capUnidentified(미확인);

    expect(kept).toHaveLength(MAX_UNIDENTIFIED_BOOKS);
    expect(overflowCount).toBe(1);
  });

  it("입력 순서를 그대로 유지한다 — 사진에서 읽힌 순서가 곧 표시 순서다", () => {
    const { kept } = capUnidentified([{ rawText: "가" }, { rawText: "나" }, { rawText: "다" }]);

    expect(kept.map((b) => b.rawText)).toEqual(["가", "나", "다"]);
  });

  it("상한 이하면 넘친 개수가 0이다", () => {
    expect(capUnidentified([{ rawText: "가" }]).overflowCount).toBe(0);
  });

  it("입력 배열을 변형하지 않는다", () => {
    const 원본 = Array.from({ length: MAX_UNIDENTIFIED_BOOKS + 5 }, (_, i) => ({ rawText: `${i}` }));
    const 스냅샷 = structuredClone(원본);

    capUnidentified(원본);

    expect(원본).toEqual(스냅샷);
  });

  it("빈 입력은 빈 결과를 낸다", () => {
    expect(capUnidentified([])).toEqual({ kept: [], overflowCount: 0 });
  });
});
