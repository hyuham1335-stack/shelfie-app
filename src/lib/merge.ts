/**
 * 증폭 방지·중복 제거·결정적 절단 (TR-005, FR-004·FR-005·FR-012).
 *
 * ## 이 모듈이 없으면 무엇이 터지는가
 * 알라딘은 일 5,000회 한도가 있고, 조회 전 상한이 없으면 판독 한 번의 이상
 * 동작 — 모델이 후보를 수백 건 쏟아내는 것 — 이 그 한도를 **한 요청에**
 * 소진시킨다 (TRD 10번). 그래서 상한은 성능 최적화가 아니라 안전장치다.
 *
 * ## 순서가 곧 계약이다
 * ① 조회 **전** 축소(확신도 강등 → 사전 병합 → 65건 절단)
 * ② 조회 **후** ISBN13 중복 제거
 * ③ 표시 상한 절단(확인 50 · 미확인 100)
 * ①을 조회 뒤로 미루면 상한이 아무것도 막지 못하고, ②를 ① 자리에 놓으면
 * 아직 ISBN이 없어 병합할 키가 없다.
 *
 * ## 전부 순수 함수다
 * 입력을 제자리에서 바꾸지 않는다. `Array.prototype.sort`가 원본을 변형하므로
 * 항상 복사한 뒤 정렬한다. 호출자가 같은 배열을 두 번 넘겨도 결과가 달라지지
 * 않아야 이 모듈을 모킹 없이 단위 테스트할 수 있다 (/docs/ARCHITECTURE.md).
 */
import {
  MAX_CANDIDATES_FOR_LOOKUP,
  MAX_IDENTIFIED_BOOKS,
  MAX_UNIDENTIFIED_BOOKS,
} from "./env";
import { normalizeAuthor, normalizeTitle } from "./match";
import type { z } from "zod";
import type { extractedCandidateSchema } from "./schemas";

/*
 * match.ts와 같은 이유로 타입을 스키마에서 직접 파생한다 — `types/` → `lib/`는
 * 타입 전용 점선이고 역방향은 금지다 (/docs/ARCHITECTURE.md).
 */
type ExtractedCandidate = z.infer<typeof extractedCandidateSchema>;

/**
 * 알라딘을 조회할 가치가 있는 판독 확신도의 하한 (FR-012).
 *
 * 이 값 미만은 조회하지 **않고** 바로 강등한다. 확신도가 낮은 후보는 조회해도
 * 대부분 `no_match`가 되는데, 그 한 번의 호출이 일일 한도에서 그대로 빠진다.
 * 임계값을 여기 한 곳에만 두는 이유는 `match.ts`가 확신도를 보지 않기
 * 때문이다 — 두 모듈이 각자 걸러내면 어느 쪽이 강등했는지 알 수 없게 된다.
 */
export const CONFIDENCE_FLOOR = 0.3;

/**
 * ① 알라딘 조회 전 축소.
 *
 * 반환하는 두 바구니의 합은 **항상 입력 건수와 같다.** 강등된 후보도 사용자에게
 * 미확인으로 보여야 하므로 조용히 버리지 않는다 (ADR-002 — 왜 빠졌는지 보여준다).
 *
 * `unreadable` 바구니에는 두 종류가 섞인다.
 * - 확신도가 하한에 못 미친 후보
 * - 65건 상한에 밀려 조회되지 못한 후보
 * 둘을 나누지 않는 이유는 사용자가 할 수 있는 일이 같기 때문이다 — 화면 문구
 * ("책등 글자를 읽지 못했어요")도 다음 행동(제목 직접 입력)도 동일하다. 그리고
 * 상한에 밀린 쪽은 **확신도 오름차순으로 가장 약하게 읽힌 후보들**이라 이 설명이
 * 사실과 어긋나지 않는다. `lookup_failed`로 표시하면 조회한 적도 없는 책에
 * "잠시 후 다시 시도해 주세요"라고 말하게 되어 ADR-005를 어긴다.
 */
export function reduceBeforeLookup(candidates: readonly ExtractedCandidate[]): {
  toLookup: ExtractedCandidate[];
  unreadable: ExtractedCandidate[];
} {
  const unreadable: ExtractedCandidate[] = [];
  const readable: ExtractedCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.confidence < CONFIDENCE_FLOOR) unreadable.push(candidate);
    else readable.push(candidate);
  }

  const merged = mergeByNormalizedKey(readable);
  const ranked = [...merged].sort(compareByConfidence);

  return {
    toLookup: ranked.slice(0, MAX_CANDIDATES_FOR_LOOKUP),
    unreadable: [...unreadable, ...ranked.slice(MAX_CANDIDATES_FOR_LOOKUP)],
  };
}

/**
 * 사진 간 사전 병합. 아직 ISBN이 없으므로 **정규화된 제목+저자**가 키다.
 *
 * 정규화는 `match.ts`의 것을 그대로 쓴다. 여기에 다시 구현하면 두 모듈의 키가
 * 소리 없이 어긋나 — 병합은 됐는데 대조는 안 되거나 그 반대가 — 원인을 찾기
 * 어려운 결함이 된다.
 *
 * 대표를 고르는 규칙:
 * - **본문은 확신도가 가장 높은 후보**를 쓴다. 같은 책을 여러 장에서 읽었다면
 *   가장 또렷하게 읽힌 판을 알라딘에 던지는 편이 맞고, 낮은 확신도를 물려받으면
 *   65건 절단에서 부당하게 밀린다.
 * - **`photoIndex`는 그룹의 최솟값**으로 덮는다. "최초 등장 사진 인덱스를
 *   유지한다"는 FR-004의 요구는 조회 후 중복 제거만이 아니라 여기에도 걸린다.
 * - 확신도가 동점이면 먼저 등장한 후보가 대표다(입력 순서 보존).
 */
function mergeByNormalizedKey(candidates: readonly ExtractedCandidate[]): ExtractedCandidate[] {
  const groups = new Map<string, ExtractedCandidate>();

  for (const candidate of candidates) {
    const key = mergeKey(candidate);
    const seen = groups.get(key);

    if (seen === undefined) {
      groups.set(key, candidate);
      continue;
    }

    const representative = candidate.confidence > seen.confidence ? candidate : seen;
    groups.set(key, {
      ...representative,
      photoIndex: Math.min(seen.photoIndex, candidate.photoIndex),
    });
  }

  return [...groups.values()];
}

/**
 * 병합 키. 저자를 읽어내지 못한 후보(`null`)는 저자가 있는 후보와 합치지 않는다 —
 * 제목만 같고 저자가 다른 별개의 책일 수 있고, 애매하면 미확인 쪽으로 기우는
 * 것이 이 제품의 기본값이다 (ADR-002).
 *
 * 구분자는 제목·저자 정규화 결과에 절대 나타나지 않는 문자여야 한다. 정규화가
 * 글자와 숫자만 남기므로(`match.ts`) 제어 문자를 쓴다.
 */
function mergeKey(candidate: ExtractedCandidate): string {
  const author = candidate.author === null ? "" : normalizeAuthor(candidate.author);
  return `${normalizeTitle(candidate.title)}\u0000${author}`;
}

/**
 * 조회 순위 비교. 확신도 내림차순이 1순위이고, 동점 tie-break는 결정성을 위해서만
 * 존재한다 — 입력 순서에 기대면 사진 처리 순서가 바뀔 때 조회 대상이 달라진다.
 */
function compareByConfidence(a: ExtractedCandidate, b: ExtractedCandidate): number {
  return (
    b.confidence - a.confidence ||
    a.photoIndex - b.photoIndex ||
    compareStrings(mergeKey(a), mergeKey(b))
  );
}

/**
 * ② ISBN13 기준 중복 제거 (FR-004).
 *
 * 최초 등장 레코드를 남기되 `photoIndex`만 그룹의 최솟값으로 맞춘다. 같은 책이
 * 사진 5장에 모두 있어도 결과는 1권이고, 사용자는 "몇 번째 사진에서 처음
 * 나왔는가"를 그대로 본다.
 *
 * ISBN13이 없는 책은 애초에 확인으로 올라오지 않으므로(TR-004) 대체 키 병합
 * 경로를 두지 않는다. 일어나지 않는 경우를 위한 분기는 검증할 수 없는 코드다.
 */
export function dedupeByIsbn<T extends { isbn13: string; photoIndex: number }>(
  books: readonly T[],
): T[] {
  const byIsbn = new Map<string, T>();

  for (const book of books) {
    const seen = byIsbn.get(book.isbn13);

    if (seen === undefined) {
      byIsbn.set(book.isbn13, book);
      continue;
    }

    if (book.photoIndex < seen.photoIndex) {
      byIsbn.set(book.isbn13, { ...seen, photoIndex: book.photoIndex });
    }
  }

  return [...byIsbn.values()];
}

/**
 * ③ 확인된 책 절단 (FR-005).
 *
 * **정렬 순서가 곧 계약이다**: 평점 내림차순 → `null`은 최하위 → `photoIndex`
 * 오름차순 → `isbn13` 오름차순. 같은 사진을 두 번 분석했을 때 목록이 달라지면
 * 사용자는 "아까 있던 책이 왜 사라졌지"를 묻게 되고, 우리는 그것을 재현할 수
 * 없다. 절단이 있는 곳에는 반드시 전순서(total order)가 있어야 한다.
 */
export function capIdentified<
  T extends { aladinRating: number | null; photoIndex: number; isbn13: string },
>(books: readonly T[]): { kept: T[]; overflowCount: number } {
  const sorted = [...books].sort(compareForCap);
  return {
    kept: sorted.slice(0, MAX_IDENTIFIED_BOOKS),
    overflowCount: Math.max(0, books.length - MAX_IDENTIFIED_BOOKS),
  };
}

/**
 * 절단 정렬 비교자.
 *
 * `null` 평점을 뺄셈에 넣지 않는다 — JavaScript는 `null`을 0으로 강제 변환해
 * 평점 0점인 책과 구분하지 못하고, `null - null`은 `NaN`이라 비교자가 0도 아닌
 * 값을 흘려 정렬이 통째로 비결정적이 된다. 그래서 `null` 여부를 먼저 가른다.
 */
function compareForCap<T extends { aladinRating: number | null; photoIndex: number; isbn13: string }>(
  a: T,
  b: T,
): number {
  if (a.aladinRating === null || b.aladinRating === null) {
    if (a.aladinRating !== b.aladinRating) return a.aladinRating === null ? 1 : -1;
  } else if (a.aladinRating !== b.aladinRating) {
    return b.aladinRating - a.aladinRating;
  }

  return a.photoIndex - b.photoIndex || compareStrings(a.isbn13, b.isbn13);
}

/**
 * ③ 미확인 절단.
 *
 * 확인된 책과 달리 재정렬하지 않는다. 미확인 목록은 사진에서 읽힌 순서가 곧
 * 표시 순서이고, 여기에는 순위를 매길 기준(평점)도 없다. 넘친 개수만 남기는
 * 이유는 상한이 없으면 모델이 후보를 쏟아냈을 때 응답과 화면이 함께 무너지기
 * 때문이다 (API_SPEC).
 */
export function capUnidentified<T>(books: readonly T[]): { kept: T[]; overflowCount: number } {
  return {
    kept: books.slice(0, MAX_UNIDENTIFIED_BOOKS),
    overflowCount: Math.max(0, books.length - MAX_UNIDENTIFIED_BOOKS),
  };
}

/** 로케일에 의존하지 않는 문자열 비교. 같은 입력이면 어느 환경에서든 같은 순서다 */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
