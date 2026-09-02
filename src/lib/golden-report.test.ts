/**
 * 골든 리포트(`lib/golden-report.ts`)의 단위 테스트.
 *
 * 이 파일이 지키는 것은 **리포트가 스스로를 속이지 않는 것**이다. 골든은 감지
 * 수단이 없는 가드레일(TRD 6.4)의 유일한 감지 장치이고, 배포 전 체크리스트
 * (TRD 9번)가 "골든을 돌렸는가"를 묻는 근거가 바로 이 출력이다. skip 한 리포트가
 * 통과처럼 읽히면 사람이 돌렸다고 답하게 된다 (ADR-010).
 */
import { describe, expect, it } from "vitest";
import { GOLDEN_MAX_MISIDENTIFIED, GOLDEN_MIN_RECALL } from "./env";
import type { GoldenExpectedBook } from "./golden-manifest";
import {
  MAX_LISTED_ITEMS,
  renderGoldenReport,
  toGoldenReportJson,
  type GoldenOutcome,
  type GoldenRunContext,
  type GoldenSkipReason,
} from "./golden-report";
import type { GoldenMatch, GoldenPhotoScore, GoldenSetScore } from "./golden-score";
import type { ExtractedCandidate, IdentifiedBook } from "@/types/book";

/**
 * 통과로 읽히는 표시들. skip 리포트에 이 중 하나라도 있으면 규칙 1이 깨진다.
 * 문자열 단정으로 고정해 둔다 — 다음 사람이 "보기 좋게" 초록 체크를 붙이는 순간
 * 이 테스트가 막는다.
 */
const PASS_LOOKING = /PASS|\bOK\b|통과|합격|성공|✅|✔|✓|\u{1F7E2}/u;

/** ANSI 이스케이프. 리다이렉트된 파일에서는 잡음이므로 넣지 않는다 */
const ANSI = /\u001b\[/;

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const CONTEXT: GoldenRunContext = {
  setId: "hyu-shelf-2026a",
  manifestVersion: 1,
  photoHashes: { "shelf-01.jpg": SHA_A, "shelf-02.jpg": SHA_B },
  extractModel: "claude-opus-5",
  ranAt: "2026-09-02T15:34:33.000Z",
};

const EMPTY_CONTEXT: GoldenRunContext = {
  setId: null,
  manifestVersion: null,
  photoHashes: {},
  extractModel: "claude-opus-5",
  ranAt: "2026-09-02T15:34:33.000Z",
};

function expectedBook(title: string, author = "저자", isbn13?: string): GoldenExpectedBook {
  return isbn13 === undefined ? { title, author } : { title, author, isbn13 };
}

function candidate(title: string): ExtractedCandidate {
  return { rawText: title, title, author: null, confidence: 0.9, photoIndex: 0 };
}

function identified(title: string, isbn13: string, author = "프랜시스 후쿠야마"): IdentifiedBook {
  return {
    isbn13,
    title,
    author,
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

function hit(book: GoldenExpectedBook, similarity = 1): GoldenMatch {
  return { expected: book, matched: candidate(book.title), similarity };
}

function miss(book: GoldenExpectedBook): GoldenMatch {
  return { expected: book, matched: null, similarity: 0 };
}

function photoScore(
  file: string,
  matches: GoldenMatch[],
  misidentified: IdentifiedBook[] = [],
): GoldenPhotoScore {
  const matchedCount = matches.filter((match) => match.matched !== null).length;
  return {
    file,
    matches,
    misidentified,
    expectedCount: matches.length,
    matchedCount,
    recall: matches.length === 0 ? 1 : matchedCount / matches.length,
  };
}

/** step 1이 계산한 값을 그대로 들고 다니는 세트 판정. 리포트는 다시 계산하지 않는다 */
function setScore(photos: GoldenPhotoScore[], passed: boolean): GoldenSetScore {
  let expectedCount = 0;
  let matchedCount = 0;
  let misidentifiedCount = 0;
  for (const photo of photos) {
    expectedCount += photo.expectedCount;
    matchedCount += photo.matchedCount;
    misidentifiedCount += photo.misidentified.length;
  }
  return {
    photos,
    expectedCount,
    matchedCount,
    recall: expectedCount === 0 ? 1 : matchedCount / expectedCount,
    misidentifiedCount,
    passed,
  };
}

function skipped(reason: GoldenSkipReason, detail = ""): GoldenOutcome {
  return { status: "skipped", reason, detail };
}

const SKIP_REASONS: GoldenSkipReason[] = ["no_set_dir", "no_manifest", "no_api_key"];

describe("renderGoldenReport — skip", () => {
  it.each(SKIP_REASONS)("%s: 첫 줄에 재지 않았다는 사실과 사유가 있다", (reason) => {
    const report = renderGoldenReport(skipped(reason), EMPTY_CONTEXT);
    const firstLine = report.split("\n")[0];

    expect(firstLine).toContain(reason);
    expect(firstLine).toContain("재지 못했");
  });

  it.each(SKIP_REASONS)("%s: 통과로 읽히는 표시가 하나도 없다", (reason) => {
    const report = renderGoldenReport(skipped(reason, "무언가 잘못됐습니다"), CONTEXT);

    expect(report).not.toMatch(PASS_LOOKING);
  });

  it("no_manifest의 detail(파싱 실패 이유)을 그대로 싣는다", () => {
    const detail = "photos.0.sha256: Invalid";
    const report = renderGoldenReport(skipped("no_manifest", detail), EMPTY_CONTEXT);

    expect(report).toContain(detail);
  });

  it("no_api_key는 목업 때문에 재현율이 100%로 나온다는 위험을 문구로 설명한다", () => {
    const report = renderGoldenReport(skipped("no_api_key"), EMPTY_CONTEXT);

    expect(report).toContain("목업");
    expect(report).toContain("100%");
    expect(report).toContain("재현율");
  });

  it("skip 리포트에도 실행 맥락이 실린다 — 어떤 환경에서 못 쟀는지가 남아야 한다", () => {
    const report = renderGoldenReport(skipped("no_api_key"), CONTEXT);

    expect(report).toContain("hyu-shelf-2026a");
    expect(report).toContain("claude-opus-5");
  });
});

describe("renderGoldenReport — 판정 결과", () => {
  it("실패한 판정은 FAIL로 표시하고 기준값을 함께 보여준다", () => {
    const photos = [
      photoScore("shelf-01.jpg", [
        hit(expectedBook("채식주의자", "한강")),
        miss(expectedBook("총, 균, 쇠", "재레드 다이아몬드")),
      ]),
      photoScore(
        "shelf-02.jpg",
        [hit(expectedBook("데미안", "헤르만 헤세"))],
        [identified("역사의 종말", "9788934972464")],
      ),
    ];
    const report = renderGoldenReport({ status: "scored", score: setScore(photos, false) }, CONTEXT);

    expect(report).toContain("FAIL");
    expect(report).not.toMatch(/\bPASS\b/);
    // 얼마나 모자란지 보이려면 실측값과 기준값이 함께 있어야 한다 (규칙 4)
    expect(report).toContain("0.667");
    expect(report).toContain(GOLDEN_MIN_RECALL.toFixed(3));
    expect(report).toContain(String(GOLDEN_MAX_MISIDENTIFIED));
  });

  it("통과한 판정은 PASS로 표시한다", () => {
    const photos = [photoScore("shelf-01.jpg", [hit(expectedBook("채식주의자", "한강"))])];
    const report = renderGoldenReport({ status: "scored", score: setScore(photos, true) }, CONTEXT);

    expect(report).toContain("PASS");
    expect(report).not.toContain("FAIL");
  });

  it("판정을 다시 하지 않는다 — step 1이 준 passed를 그대로 쓴다", () => {
    // 재현율 0인데 passed: true인 모순된 입력. 여기서 임계값과 다시 비교하면
    // 판정이 두 곳에 생기고, 한쪽만 고쳐지는 날이 온다 (규칙 4).
    const photos = [photoScore("shelf-01.jpg", [miss(expectedBook("채식주의자", "한강"))])];
    const report = renderGoldenReport({ status: "scored", score: setScore(photos, true) }, CONTEXT);

    expect(report).toContain("PASS");
  });

  it("놓친 책을 사진과 제목으로 찍는다", () => {
    const photos = [
      photoScore("shelf-01.jpg", [
        hit(expectedBook("채식주의자", "한강")),
        miss(expectedBook("총, 균, 쇠", "재레드 다이아몬드")),
      ]),
    ];
    const report = renderGoldenReport({ status: "scored", score: setScore(photos, false) }, CONTEXT);
    const missedBlock = report.slice(report.indexOf("놓친 책"));

    expect(missedBlock).toContain("총, 균, 쇠");
    expect(missedBlock).toContain("재레드 다이아몬드");
    expect(missedBlock).toContain("shelf-01.jpg");
    // 짝지어진 책은 놓친 목록에 없다
    expect(missedBlock).not.toContain("채식주의자");
  });

  it("오확인을 제목·저자·ISBN으로 찍고 알라딘 사실임을 구분해 표시한다", () => {
    const photos = [
      photoScore(
        "shelf-01.jpg",
        [hit(expectedBook("채식주의자", "한강"))],
        [identified("역사의 종말", "9788934972464")],
      ),
    ];
    const report = renderGoldenReport({ status: "scored", score: setScore(photos, false) }, CONTEXT);
    const block = report.slice(report.indexOf("오확인"));

    expect(block).toContain("역사의 종말");
    expect(block).toContain("프랜시스 후쿠야마");
    expect(block).toContain("9788934972464");
    // 알라딘이 준 사실과 우리가 만든 추정(유사도)을 같은 층위로 섞지 않는다 (ADR-002)
    expect(block).toContain("알라딘 사실");
    expect(block).not.toContain("유사도");
  });

  it("목록이 길면 자르되 잘랐다는 사실과 전체 건수를 남긴다", () => {
    const total = MAX_LISTED_ITEMS + 5;
    const matches = Array.from({ length: total }, (_, index) =>
      miss(expectedBook(`놓친책-${String(index).padStart(2, "0")}`)),
    );
    const report = renderGoldenReport(
      { status: "scored", score: setScore([photoScore("shelf-01.jpg", matches)], false) },
      CONTEXT,
    );

    expect(report).toContain("놓친책-00");
    expect(report).not.toContain(`놓친책-${String(total - 1).padStart(2, "0")}`);
    // 잘린 아래가 없는 것이 되지 않도록 전체 건수와 잘린 건수를 남긴다
    expect(report).toContain(String(total));
    expect(report).toContain(String(total - MAX_LISTED_ITEMS));
  });

  it("사진별 재현율 표를 낸다", () => {
    const photos = [
      photoScore("shelf-01.jpg", [hit(expectedBook("채식주의자", "한강"))]),
      photoScore("shelf-02.jpg", [miss(expectedBook("데미안", "헤르만 헤세"))]),
    ];
    const report = renderGoldenReport({ status: "scored", score: setScore(photos, false) }, CONTEXT);

    expect(report).toContain("shelf-01.jpg");
    expect(report).toContain("shelf-02.jpg");
    expect(report).toContain("1.000");
    expect(report).toContain("0.000");
  });

  it("색상 이스케이프 코드를 넣지 않는다 — 리다이렉트된 파일에서는 잡음이다", () => {
    const photos = [photoScore("shelf-01.jpg", [hit(expectedBook("채식주의자", "한강"))])];

    expect(renderGoldenReport({ status: "scored", score: setScore(photos, true) }, CONTEXT)).not.toMatch(
      ANSI,
    );
    expect(renderGoldenReport(skipped("no_api_key"), CONTEXT)).not.toMatch(ANSI);
  });
});

describe("GoldenRunContext — 두 출력 모두에 실린다", () => {
  const outcomes: GoldenOutcome[] = [
    skipped("no_api_key"),
    {
      status: "scored",
      score: setScore([photoScore("shelf-01.jpg", [hit(expectedBook("채식주의자", "한강"))])], true),
    },
  ];

  it.each(outcomes.map((outcome) => [outcome.status, outcome] as const))(
    "%s: 콘솔 표에 setId·매니페스트 버전·모델·실행 시각·해시가 있다",
    (_status, outcome) => {
      const report = renderGoldenReport(outcome, CONTEXT);

      expect(report).toContain("hyu-shelf-2026a");
      expect(report).toContain("claude-opus-5");
      expect(report).toContain("2026-09-02T15:34:33.000Z");
      expect(report).toContain(SHA_A);
      expect(report).toContain(SHA_B);
    },
  );

  it.each(outcomes.map((outcome) => [outcome.status, outcome] as const))(
    "%s: JSON에 컨텍스트가 통째로 실린다",
    (_status, outcome) => {
      const json = toGoldenReportJson(outcome, CONTEXT) as { context: GoldenRunContext };

      expect(json.context).toEqual(CONTEXT);
    },
  );

  it("세트를 찾지 못했으면 setId·manifestVersion은 null로 남는다 — 지어내지 않는다", () => {
    const json = toGoldenReportJson(skipped("no_set_dir"), EMPTY_CONTEXT) as {
      context: GoldenRunContext;
    };

    expect(json.context.setId).toBeNull();
    expect(json.context.manifestVersion).toBeNull();
    expect(json.context.photoHashes).toEqual({});
  });
});

describe("toGoldenReportJson", () => {
  it("직렬화할 수 있다", () => {
    const photos = [
      photoScore(
        "shelf-01.jpg",
        [hit(expectedBook("채식주의자", "한강", "9788936434120")), miss(expectedBook("데미안"))],
        [identified("역사의 종말", "9788934972464")],
      ),
    ];
    const json = toGoldenReportJson({ status: "scored", score: setScore(photos, false) }, CONTEXT);

    const serialized = JSON.stringify(json);
    expect(serialized).toContain("9788934972464");
    expect(JSON.parse(serialized)).toEqual(JSON.parse(serialized));
  });

  it("skip은 status로 판별되고 passed가 true로 새지 않는다", () => {
    const json = toGoldenReportJson(skipped("no_api_key", "키 없음"), EMPTY_CONTEXT) as {
      status: string;
      passed: boolean | null;
      skip: { reason: string; detail: string };
    };

    expect(json.status).toBe("skipped");
    expect(json.passed).toBeNull();
    expect(json.skip.reason).toBe("no_api_key");
    expect(json.skip.detail).toBe("키 없음");
  });

  it("판정 결과에는 step 1의 수치와 기준값이 함께 담긴다", () => {
    const photos = [
      photoScore("shelf-01.jpg", [
        hit(expectedBook("채식주의자", "한강")),
        miss(expectedBook("데미안")),
      ]),
    ];
    const json = toGoldenReportJson(
      { status: "scored", score: setScore(photos, false) },
      CONTEXT,
    ) as {
      status: string;
      passed: boolean;
      totals: {
        expectedCount: number;
        matchedCount: number;
        recall: number;
        misidentifiedCount: number;
      };
      thresholds: { minRecall: number; maxMisidentified: number };
      photos: { file: string; missed: GoldenExpectedBook[] }[];
    };

    expect(json.status).toBe("scored");
    expect(json.passed).toBe(false);
    expect(json.totals).toEqual({
      expectedCount: 2,
      matchedCount: 1,
      recall: 0.5,
      misidentifiedCount: 0,
    });
    expect(json.thresholds).toEqual({
      minRecall: GOLDEN_MIN_RECALL,
      maxMisidentified: GOLDEN_MAX_MISIDENTIFIED,
    });
    expect(json.photos[0].file).toBe("shelf-01.jpg");
    expect(json.photos[0].missed).toEqual([{ title: "데미안", author: "저자" }]);
  });

  it("JSON은 목록을 자르지 않는다 — 자르는 것은 콘솔 표시뿐이다", () => {
    const total = MAX_LISTED_ITEMS + 5;
    const matches = Array.from({ length: total }, (_, index) =>
      miss(expectedBook(`놓친책-${index}`)),
    );
    const json = toGoldenReportJson(
      { status: "scored", score: setScore([photoScore("shelf-01.jpg", matches)], false) },
      CONTEXT,
    ) as { photos: { missed: GoldenExpectedBook[] }[] };

    expect(json.photos[0].missed).toHaveLength(total);
  });
});
