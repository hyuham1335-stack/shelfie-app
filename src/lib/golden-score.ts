/**
 * 골든 인식률의 **판정** (ADR-010 · TRD 8번 판정 규약 표).
 *
 * ## 순수 층이다
 * `fs`도 `services/`도 `process.env`도 모른다. 사진을 읽고 실제 API를 부르는 것은
 * `*.golden.test.ts`의 몫이고(ADR-010 — 러너는 프로덕션 코드가 아니라 테스트 코드다),
 * 표를 그리는 것은 `lib/golden-report.ts`의 몫이다. 판정만 여기 있어야 판정을
 * **값으로** 검증할 수 있다 (ADR-009가 캔버스에 쓴 것과 같은 분리).
 *
 * ## 프로덕션과 같은 잣대로 잰다
 * 정규화와 임계값은 `lib/match.ts`의 것을 그대로 재사용한다. 골든이 자체 유사도
 * 기준을 만들면 골든이 통과해도 실제 판정은 다르게 나고, 그러면 **게이트가 재는
 * 대상이 게이트가 지키려는 대상이 아니게 된다** (TRD 8번).
 *
 * ## 숫자가 부풀지 않게 하는 두 규칙
 * - 짝짓기는 **1:1**이다. 비슷한 제목 여러 권이 한 기대 항목을 채우면 재현율이
 *   실제보다 높게 나온다.
 * - 세트 재현율은 사진별 재현율의 **평균이 아니라** 전체 기대 건수 대비 전체 매칭
 *   건수다. 평균을 내면 책 3권짜리 사진이 30권짜리 사진과 같은 무게를 갖는다.
 */
import { GOLDEN_MAX_MISIDENTIFIED, GOLDEN_MIN_RECALL } from "./env";
import type { GoldenExpectedBook, GoldenPhoto } from "./golden-manifest";
import { MATCH_THRESHOLD, normalizeAuthor, titleSimilarity } from "./match";
import type { ExtractedCandidate, IdentifiedBook } from "@/types/book";

/** 기대 항목 하나가 어떻게 처리됐는가 */
export interface GoldenMatch {
  expected: GoldenExpectedBook;
  /** 짝지어진 추출 후보. 없으면 놓친 것이다 */
  matched: ExtractedCandidate | null;
  similarity: number;
}

/** 사진 1장의 판정 */
export interface GoldenPhotoScore {
  file: string;
  matches: GoldenMatch[];
  /** 기대 목록 어디와도 짝지어지지 않은 채 **확인으로 승격된** 책 (TR-004) */
  misidentified: IdentifiedBook[];
  expectedCount: number;
  matchedCount: number;
  recall: number;
}

/** 세트 전체의 판정 */
export interface GoldenSetScore {
  photos: GoldenPhotoScore[];
  expectedCount: number;
  matchedCount: number;
  recall: number;
  misidentifiedCount: number;
  /** recall >= GOLDEN_MIN_RECALL && misidentifiedCount <= GOLDEN_MAX_MISIDENTIFIED */
  passed: boolean;
}

/** 짝짓기 후보 1쌍. 확정 전이므로 인덱스로만 들고 다닌다 */
interface ScoredPair {
  expectedIndex: number;
  candidateIndex: number;
  similarity: number;
  /** 유사도 동점을 가르는 보조 신호. 1차 기준으로 쓰지 않는다 */
  authorAgrees: boolean;
}

/**
 * 사진 1장을 판정한다 (TR-003 재현율 · TR-004 오확인).
 *
 * 두 축은 서로 다른 입력을 본다 — 재현율은 **추출 후보**(알라딘 이전)를, 오확인은
 * **확인으로 승격된 책**(알라딘 이후)을 본다. 한쪽으로 다른 쪽을 대신할 수 없다:
 * 추출은 잘 됐는데 대조가 엉뚱한 책을 물어 오는 실패가 정확히 TR-004가 막으려는
 * 것이고, 그것은 재현율 숫자에는 전혀 나타나지 않는다.
 */
export function scorePhoto(
  photo: GoldenPhoto,
  candidates: readonly ExtractedCandidate[],
  identified: readonly IdentifiedBook[],
): GoldenPhotoScore {
  const expected = photo.books;
  const matched = pairGreedily(expected, candidates);

  const matches: GoldenMatch[] = expected.map((book, index) => {
    const pair = matched.get(index);
    return {
      expected: book,
      matched: pair === undefined ? null : candidates[pair.candidateIndex],
      similarity: pair === undefined ? 0 : pair.similarity,
    };
  });

  const matchedCount = matched.size;

  return {
    file: photo.file,
    matches,
    misidentified: findMisidentified(expected, identified),
    expectedCount: expected.length,
    matchedCount,
    recall: ratio(matchedCount, expected.length),
  };
}

/**
 * 사진별 판정을 세트 전체로 접는다.
 *
 * 재현율은 **합산 후 나눈다** — 사진별 재현율을 평균 내지 않는다(위 헤더 주석).
 * `passed`는 두 축을 **모두** 만족해야 한다. 재현율만 보고 통과시키면 TR-004의
 * 오확인 0건이 게이트를 그냥 통과하는데, 프로덕션에는 그것을 잡을 신호가 아예
 * 없다 (TRD 6.4 — 가짜 책이 떠도 로그에는 정상 응답으로 남는다).
 *
 * 기대 건수가 0이면 잰 것이 없다. `manifest`가 사진 1장 이상·사진당 책 1권 이상을
 * 강제하므로(`golden-manifest.ts`) 실제 세트에서는 나올 수 없는 값이며, 여기서는
 * 0으로 나누지 않기 위해 공허참(1)으로 둔다.
 */
export function aggregateScores(photos: readonly GoldenPhotoScore[]): GoldenSetScore {
  let expectedCount = 0;
  let matchedCount = 0;
  let misidentifiedCount = 0;

  for (const photo of photos) {
    expectedCount += photo.expectedCount;
    matchedCount += photo.matchedCount;
    misidentifiedCount += photo.misidentified.length;
  }

  const recall = ratio(matchedCount, expectedCount);

  return {
    photos: [...photos],
    expectedCount,
    matchedCount,
    recall,
    misidentifiedCount,
    passed: recall >= GOLDEN_MIN_RECALL && misidentifiedCount <= GOLDEN_MAX_MISIDENTIFIED,
  };
}

/**
 * 유사도 내림차순 1:1 그리디 짝짓기 (TRD 8번).
 *
 * 모든 쌍의 유사도를 구해 임계값 이상만 남기고, 높은 쌍부터 확정하며 이미 쓰인
 * 기대 항목과 후보를 제외한다. 다대일을 허용하면 재현율이 부풀려진다.
 *
 * **정렬은 전부 결정적이다.** 같은 입력이 실행마다 다른 숫자를 내면 골든은 회귀
 * 기준이 될 수 없다(FR-005·TR-005가 절단 순서를 결정적으로 못 박은 것과 같은 이유).
 * 키 순서와 근거:
 * 1. 유사도 내림차순 — 1차 기준.
 * 2. 저자 일치 우선 — 동점을 가르는 보조 신호다. `judge`가 `ambiguous`를 저자로
 *    가르는 방식과 같다(FR-003). 저자를 1차 기준으로 쓰지 않는 이유는 기대 목록의
 *    저자 표기(역자 포함·부제)가 추출 결과와 어긋나는 것이 흔하기 때문이다.
 * 3. 기대 항목 인덱스 → 4. 후보 인덱스 오름차순 — 그래도 남는 완전 동점은 **입력
 *    순서**로 깬다. 매니페스트의 책 순서와 추출 응답의 후보 순서는 둘 다 고정된
 *    값이므로, 이 키까지 가면 결과가 한 가지로 확정된다.
 */
function pairGreedily(
  expected: readonly GoldenExpectedBook[],
  candidates: readonly ExtractedCandidate[],
): Map<number, ScoredPair> {
  const pairs: ScoredPair[] = [];

  for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
    const book = expected[expectedIndex];
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];
      const similarity = titleSimilarity(book.title, candidate.title);
      if (similarity < MATCH_THRESHOLD) continue;

      pairs.push({
        expectedIndex,
        candidateIndex,
        similarity,
        authorAgrees: authorsOverlap(book.author, candidate.author),
      });
    }
  }

  pairs.sort(
    (a, b) =>
      b.similarity - a.similarity ||
      Number(b.authorAgrees) - Number(a.authorAgrees) ||
      a.expectedIndex - b.expectedIndex ||
      a.candidateIndex - b.candidateIndex,
  );

  const byExpected = new Map<number, ScoredPair>();
  const usedCandidates = new Set<number>();

  for (const pair of pairs) {
    if (byExpected.has(pair.expectedIndex)) continue;
    if (usedCandidates.has(pair.candidateIndex)) continue;
    byExpected.set(pair.expectedIndex, pair);
    usedCandidates.add(pair.candidateIndex);
  }

  return byExpected;
}

/**
 * 확인으로 승격된 책 중 기대 목록 어디와도 짝지어지지 않은 것 (TR-004).
 *
 * **`isbn13`이 있으면 그것이 이긴다.** 기대 항목의 ISBN과 같으면 제목 유사도와
 * 무관하게 맞은 것이고(원서 제목·부제 차이는 오확인이 아니다), 어느 ISBN과도
 * 다르면 제목이 비슷해도 다른 판본이므로 맞았다고 하지 않는다. ISBN은 알라딘이
 * 준 **사실**이고 제목 유사도는 우리가 만든 **추정**이다 — 사실이 있는데 추정을
 * 쓰지 않는다 (ADR-002).
 *
 * 그래서 제목 유사도는 **ISBN을 적지 않은 기대 항목**에만 쓴다. 매니페스트가
 * `isbn13`을 선택으로 둔 대가이며(TRD 8번), 적어 둘수록 이 판정이 정확해진다.
 */
function findMisidentified(
  expected: readonly GoldenExpectedBook[],
  identified: readonly IdentifiedBook[],
): IdentifiedBook[] {
  const expectedIsbns = new Set(
    expected
      .map((book) => book.isbn13)
      .filter((isbn13): isbn13 is string => isbn13 !== undefined),
  );
  const titleOnly = expected.filter((book) => book.isbn13 === undefined);

  return identified.filter((book) => {
    if (expectedIsbns.has(book.isbn13)) return false;
    return !titleOnly.some(
      (candidate) => titleSimilarity(candidate.title, book.title) >= MATCH_THRESHOLD,
    );
  });
}

/**
 * 정규화된 저자 목록이 한 명이라도 겹치는가.
 *
 * `normalizeAuthor`는 역할 표기("(지은이)")를 떼고 쉼표로 이어 붙인 이름 목록을
 * 준다 — 역자까지 한 덩어리로 뭉치지 않으므로 여기서 다시 가른다. 읽어내지 못한
 * 저자(null)는 아무와도 겹치지 않는다.
 */
function authorsOverlap(expected: string, candidate: string | null): boolean {
  if (candidate === null) return false;
  const left = splitAuthors(normalizeAuthor(expected));
  if (left.size === 0) return false;
  for (const name of splitAuthors(normalizeAuthor(candidate))) {
    if (left.has(name)) return true;
  }
  return false;
}

function splitAuthors(normalized: string): Set<string> {
  return new Set(normalized.split(",").filter((name) => name !== ""));
}

/** 분모가 0이면 잴 것이 없다는 뜻이다. 0으로 나누지 않고 공허참(1)으로 둔다 */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}
