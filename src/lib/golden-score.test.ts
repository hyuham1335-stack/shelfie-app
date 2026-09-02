/**
 * 골든 판정(`lib/golden-score.ts`)의 단위 테스트.
 *
 * 이 파일이 지키는 것은 **숫자가 거짓말을 하지 않는 것**이다. 재현율이 부풀려지거나
 * 오확인이 새어 나가면 골든 게이트는 통과를 찍으면서 아무것도 지키지 못한다
 * (TRD 6.4 — 가짜 책이 화면에 떠도 로그에는 정상 응답으로 남는다).
 */
import { describe, expect, it } from "vitest";
import { GOLDEN_MAX_MISIDENTIFIED, GOLDEN_MIN_RECALL } from "./env";
import type { GoldenExpectedBook, GoldenPhoto } from "./golden-manifest";
import { aggregateScores, scorePhoto } from "./golden-score";
import type { ExtractedCandidate, IdentifiedBook } from "@/types/book";

const SHA = "a".repeat(64);

function photo(books: GoldenExpectedBook[], file = "shelf-01.jpg"): GoldenPhoto {
  return { file, sha256: SHA, books };
}

function candidate(
  title: string,
  author: string | null = null,
  confidence = 0.9,
): ExtractedCandidate {
  return { rawText: title, title, author, confidence, photoIndex: 0 };
}

function identified(title: string, isbn13: string): IdentifiedBook {
  return {
    isbn13,
    title,
    author: "저자",
    publisher: "출판사",
    coverUrl: "https://image.aladin.co.kr/cover.jpg",
    pages: 300,
    aladinRating: 9,
    aladinLink: "https://www.aladin.co.kr/item.aspx",
    claudeNote: "",
    photoIndex: 0,
    proof: "proof",
  };
}

describe("scorePhoto — 재현율 짝짓기", () => {
  it("기대 목록이 전건 매칭되면 재현율이 1이다", () => {
    const score = scorePhoto(
      photo([
        { title: "채식주의자", author: "한강" },
        { title: "죽음의 수용소에서", author: "빅터 프랭클" },
      ]),
      [candidate("채식주의자", "한강"), candidate("죽음의 수용소에서", "빅터 프랭클")],
      [],
    );

    expect(score.expectedCount).toBe(2);
    expect(score.matchedCount).toBe(2);
    expect(score.recall).toBe(1);
    expect(score.matches.every((match) => match.matched !== null)).toBe(true);
  });

  it("유사도가 임계값 미만이면 짝지어지지 않는다", () => {
    const score = scorePhoto(photo([{ title: "채식주의자", author: "한강" }]), [
      candidate("총 균 쇠", "재레드 다이아몬드"),
    ], []);

    expect(score.matchedCount).toBe(0);
    expect(score.recall).toBe(0);
    expect(score.matches[0].matched).toBeNull();
    expect(score.matches[0].similarity).toBe(0);
  });

  it("비슷한 후보 둘이 기대 항목 하나를 두고 경쟁하면 하나만 짝지어진다 (1:1)", () => {
    // 둘 다 임계값을 넘지만 기대 항목은 하나다. 다대일을 허용하면 재현율이 부풀려진다.
    const score = scorePhoto(photo([{ title: "해리포터와 마법사의 돌", author: "조앤 롤링" }]), [
      candidate("해리포터와 마법사의 둘"),
      candidate("해리포터와 마법사의 돌"),
    ], []);

    expect(score.expectedCount).toBe(1);
    expect(score.matchedCount).toBe(1);
    // 유사도가 높은 쪽이 이긴다 — 내림차순 그리디
    expect(score.matches[0].matched?.title).toBe("해리포터와 마법사의 돌");
    expect(score.matches[0].similarity).toBe(1);
  });

  it("유사도 동점에서는 저자가 일치하는 후보가 이긴다", () => {
    const score = scorePhoto(photo([{ title: "채식주의자", author: "한강" }]), [
      candidate("채식주의자", "김영하"),
      candidate("채식주의자", "한강"),
    ], []);

    expect(score.matches[0].matched?.author).toBe("한강");
  });

  it("저자까지 동점이면 입력 순서로 결정적으로 깨고, 반복 호출이 같은 결과를 준다", () => {
    const expected = photo([{ title: "채식주의자", author: "한강" }]);
    const candidates = [candidate("채식주의자", null), candidate("채식주의자", null)];

    const first = scorePhoto(expected, candidates, []);
    const second = scorePhoto(expected, candidates, []);

    expect(first.matches[0].matched).toBe(candidates[0]);
    expect(second).toEqual(first);
  });

  it("입력 순서를 섞어도 짝짓기 결과가 같다", () => {
    const books: GoldenExpectedBook[] = [
      { title: "채식주의자", author: "한강" },
      { title: "죽음의 수용소에서", author: "빅터 프랭클" },
      { title: "총 균 쇠", author: "재레드 다이아몬드" },
    ];
    const candidates = [
      candidate("총 균 쇠", "재레드 다이아몬드"),
      candidate("채식주의자", "한강"),
      candidate("죽음의 수용소에서", "빅터 프랭클"),
    ];

    const straight = scorePhoto(photo(books), candidates, []);
    const shuffled = scorePhoto(photo([...books].reverse()), [...candidates].reverse(), []);

    const pairOf = (score: ReturnType<typeof scorePhoto>) =>
      score.matches
        .map((match) => `${match.expected.title}=${match.matched?.title ?? "-"}`)
        .sort();

    expect(pairOf(shuffled)).toEqual(pairOf(straight));
    expect(shuffled.recall).toBe(straight.recall);
  });

  it("기대 항목이 0건인 사진은 재현율이 0이 아니고 분모를 오염시키지 않는다", () => {
    const score = scorePhoto(photo([]), [candidate("채식주의자", "한강")], []);

    expect(score.expectedCount).toBe(0);
    expect(score.matchedCount).toBe(0);
    expect(score.recall).not.toBe(0);
    expect(score.recall).toBe(1);
    expect(score.matches).toEqual([]);
  });
});

describe("scorePhoto — 오확인 (TR-004)", () => {
  it("ISBN이 일치하면 제목이 달라도 오확인이 아니다", () => {
    const score = scorePhoto(
      photo([{ title: "죽음의 수용소에서", author: "빅터 프랭클", isbn13: "9788935210794" }]),
      [],
      [identified("Man's Search for Meaning", "9788935210794")],
    );

    expect(score.misidentified).toEqual([]);
  });

  it("ISBN도 제목도 기대 목록과 어긋나면 오확인이다", () => {
    const book = identified("전혀 다른 책", "9791234567890");
    const score = scorePhoto(
      photo([{ title: "죽음의 수용소에서", author: "빅터 프랭클", isbn13: "9788935210794" }]),
      [],
      [book],
    );

    expect(score.misidentified).toEqual([book]);
  });

  it("ISBN이 없는 기대 항목은 제목 유사도로 판정한다", () => {
    const score = scorePhoto(
      photo([{ title: "채식주의자", author: "한강" }]),
      [],
      [identified("채식주의자", "9788936433598")],
    );

    expect(score.misidentified).toEqual([]);
  });
});

describe("aggregateScores", () => {
  function photoScore(expectedTitles: string[], matchedCount: number, file: string) {
    const books = expectedTitles.map((title) => ({ title, author: "저자" }));
    const candidates = expectedTitles
      .slice(0, matchedCount)
      .map((title) => candidate(title, "저자"));
    return scorePhoto(photo(books, file), candidates, []);
  }

  it("사진별 재현율의 평균이 아니라 전체 기대 건수 대비 전체 매칭 건수다", () => {
    const small = photoScore(["제목1", "제목2", "제목3"], 3, "shelf-01.jpg");
    const large = photoScore(
      Array.from({ length: 10 }, (_, index) => `대작${index + 1}권`),
      5,
      "shelf-02.jpg",
    );

    const set = aggregateScores([small, large]);

    expect(set.expectedCount).toBe(13);
    expect(set.matchedCount).toBe(8);
    // 사진별 평균이면 0.75가 된다 — 책 3권짜리 사진이 10권짜리와 같은 무게를 가진다
    expect(set.recall).toBeCloseTo(8 / 13, 10);
    expect(set.recall).not.toBeCloseTo(0.75, 10);
  });

  it("기대 0건 사진이 분모에 들어가지 않는다", () => {
    const real = photoScore(["제목1", "제목2"], 2, "shelf-01.jpg");
    const empty = scorePhoto(photo([], "shelf-02.jpg"), [], []);

    const set = aggregateScores([real, empty]);

    expect(set.expectedCount).toBe(2);
    expect(set.recall).toBe(1);
  });

  it("재현율과 오확인 두 축을 모두 만족해야 통과다", () => {
    const clean = photoScore(["제목1", "제목2"], 2, "shelf-01.jpg");
    expect(aggregateScores([clean]).passed).toBe(true);

    const dirty = scorePhoto(
      photo([{ title: "제목1", author: "저자" }, { title: "제목2", author: "저자" }]),
      [candidate("제목1", "저자"), candidate("제목2", "저자")],
      [identified("전혀 다른 책", "9791234567890")],
    );
    const set = aggregateScores([dirty]);

    expect(set.recall).toBe(1);
    expect(set.recall).toBeGreaterThanOrEqual(GOLDEN_MIN_RECALL);
    expect(set.misidentifiedCount).toBe(1);
    expect(set.misidentifiedCount).toBeGreaterThan(GOLDEN_MAX_MISIDENTIFIED);
    expect(set.passed).toBe(false);
  });

  it("재현율이 하한에 못 미치면 오확인이 0건이어도 통과가 아니다", () => {
    const half = photoScore(["제목1", "제목2"], 1, "shelf-01.jpg");
    const set = aggregateScores([half]);

    expect(set.misidentifiedCount).toBe(0);
    expect(set.recall).toBeLessThan(GOLDEN_MIN_RECALL);
    expect(set.passed).toBe(false);
  });

  it("사진이 하나도 없으면 판정할 것이 없다", () => {
    const set = aggregateScores([]);

    expect(set.photos).toEqual([]);
    expect(set.expectedCount).toBe(0);
    expect(set.matchedCount).toBe(0);
    expect(set.misidentifiedCount).toBe(0);
  });
});
