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
 * 후보와 그 병합 키를 함께 나르는 쌍.
 *
 * 키는 `reduceBeforeLookup`이 **한 번** 계산하고 그 뒤로 아무도 다시 계산하지
 * 않는다. 병합도 정렬 tie-break도 호출부의 계측도 전부 이 값을 그대로 쓴다 —
 * 같은 후보에 `mergeKey`를 두 번 부르는 자리가 없으면 두 키가 갈릴 수도 없다.
 *
 * **내보내지 않는다.** 검사를 위해 내부 타입을 공개하면 그 이름이 계약이 되어
 * 다음 리팩터링을 막는다. `reduceBeforeLookup`의 반환 타입에 구조적으로
 * 나타나므로 호출부는 이름 없이도 쓸 수 있다.
 */
interface KeyedCandidate {
  candidate: ExtractedCandidate;
  key: string;
}

/**
 * ① 알라딘 조회 전 축소.
 *
 * 강등된 후보도 사용자에게 미확인으로 보여야 하므로 조용히 버리지 않는다
 * (ADR-002 — 왜 빠졌는지 보여준다).
 *
 * ## 바구니는 넷이고 가르는 순서가 곧 계약이다
 * ① `confidence < CONFIDENCE_FLOOR` → `lowConfidence`
 * ② `mergeKey(candidate) === null`(정규화하면 제목이 빈 후보) → `blankTitle`
 * ③ 그 밖 → 키와 짝지어 병합·정렬을 거쳐 `toLookup`과 `capped`로 갈린다
 *
 * **확신도를 먼저 가르는 순서를 뒤집지 마라.** 뒤집으면 확신도가 낮으면서 제목도
 * 빈 후보가 `low_confidence` 대신 `blank_title`로 세어진다. 계측 분해가 코드 한
 * 줄로 조용히 움직이면 지표의 시계열이 끊긴다.
 *
 * ②의 판정은 `mergeKey`를 **한 번 불러 그 반환값으로만** 한다.
 * `normalizeTitle(title) === ""`를 여기서 다시 묻지 않는다 — 같은 판정에 기준이
 * 둘이면 `key: string`만 받도록 만든 병합에 `null`이 새어 든다.
 *
 * ## 왜 `blankTitle`을 병합에서 빼는가
 * 빼지 않으면 제목이 빈 후보들이 **전부 같은 키**(구분자 하나, 또는 구분자 뒤에
 * 저자만)를 갖는다. 서로 다른 책인데도 한 그룹으로 접혀 대표 하나만 남고 나머지는
 * 화면에서 통째로 사라진다 — "왜 빠졌는지 보여준다"는 약속이 정확히 그 자리에서
 * 깨진다. 제목을 못 읽었는데 저자가 같다는 것은 "같은 저자의 어떤 책"이지 "같은
 * 책"이 아니고, 접힘의 축은 책이므로 축이 없는 후보는 접지 않는다.
 *
 * 그래서 **접혀서 사라지는 것은 같은 책의 다른 판독본뿐**이라는 말은 ②를 갈라
 * 낸 뒤에야 참이 된다. 그 판독본들도 대표 하나로 줄어 화면에는 하나만 남는다 —
 * 보존되는 것은 건수가 아니라 **책**이고, 네 바구니의 합이 입력 건수와 같지 않은
 * 이유도 그것이다(합은 입력 건수 **이하**다).
 *
 * ## 왜 `lowConfidence`와 `capped`를 나누는가
 * 응답에서 둘은 같은 사유(`unreadable`)로 접힌다. 사용자가 할 수 있는 일이
 * 같기 때문이다 — 화면 문구("책등 글자를 읽지 못했어요")도 다음 행동(제목 직접
 * 입력)도 동일하고, 상한에 밀린 쪽은 **확신도 오름차순으로 가장 약하게 읽힌
 * 후보들**이라 그 문구가 사실과 어긋나지도 않는다. (`lookup_failed`로 표시하면
 * 조회한 적도 없는 책에 "잠시 후 다시 시도해 주세요"라고 말하게 되어 ADR-005를
 * 어긴다.) `blankTitle`도 같은 문장으로 접힌다.
 *
 * 그런데 **지표에서는 갈라야 한다.** `capped`는 프롬프트 품질이 아니라 우리가 건
 * 조회 상한 때문에 밀린 것이라, 미확인 비율 가드레일의 분자에 넣으면 "상한을
 * 올려야 할 상황"을 "프롬프트가 나빠진 상황"으로 오독하게 된다. 접는 일은
 * `lib/unidentified.ts`가 응답 직전에 하고, 여기서는 나눠 둔 채로 넘긴다 —
 * 한 번 접힌 것은 다시 나눌 수 없기 때문이다.
 */
export function reduceBeforeLookup(candidates: readonly ExtractedCandidate[]): {
  toLookup: KeyedCandidate[];
  lowConfidence: ExtractedCandidate[];
  blankTitle: ExtractedCandidate[];
  capped: KeyedCandidate[];
} {
  const lowConfidence: ExtractedCandidate[] = [];
  const blankTitle: ExtractedCandidate[] = [];
  const readable: KeyedCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.confidence < CONFIDENCE_FLOOR) {
      lowConfidence.push(candidate);
      continue;
    }

    const key = mergeKey(candidate);
    if (key === null) blankTitle.push(candidate);
    else readable.push({ candidate, key });
  }

  const merged = mergeByNormalizedKey(readable);
  const ranked = [...merged].sort(compareByConfidence);

  return {
    toLookup: ranked.slice(0, MAX_CANDIDATES_FOR_LOOKUP),
    lowConfidence,
    blankTitle,
    capped: ranked.slice(MAX_CANDIDATES_FOR_LOOKUP),
  };
}

/**
 * 사진 간 사전 병합. 아직 ISBN이 없으므로 **정규화된 제목+저자**가 키다.
 *
 * 정규화는 `match.ts`의 것을 그대로 쓴다. 여기에 다시 구현하면 두 모듈의 키가
 * 소리 없이 어긋나 — 병합은 됐는데 대조는 안 되거나 그 반대가 — 원인을 찾기
 * 어려운 결함이 된다.
 *
 * **`mergeKey`를 부르지 않는다.** 키는 이미 `reduceBeforeLookup`이 계산해
 * 쌍으로 실어 보냈고, 그 자리에서 `null`인 후보는 `blankTitle`로 갈라져 여기까지
 * 오지 않는다. 그래서 `null`을 볼 일이 없고 도달 불가 분기가 애초에 생기지
 * 않는다 — 안 흐르는 자리에 방어 분기를 두면 그 분기는 영원히 검증되지 않는다.
 *
 * 대표를 고르는 규칙:
 * - **본문은 확신도가 가장 높은 후보**를 쓴다. 같은 책을 여러 장에서 읽었다면
 *   가장 또렷하게 읽힌 판을 알라딘에 던지는 편이 맞고, 낮은 확신도를 물려받으면
 *   65건 절단에서 부당하게 밀린다.
 * - **`photoIndex`는 그룹의 최솟값**으로 덮는다. "최초 등장 사진 인덱스를
 *   유지한다"는 FR-004의 요구는 조회 후 중복 제거만이 아니라 여기에도 걸린다.
 * - 확신도가 동점이면 먼저 등장한 후보가 대표다(입력 순서 보존).
 *
 * 대표가 바뀌어도 **키는 그룹의 키 그대로**다. 같은 그룹의 후보는 정의상 같은
 * 키를 가지므로 고를 필요가 없다.
 */
function mergeByNormalizedKey(candidates: readonly KeyedCandidate[]): KeyedCandidate[] {
  const groups = new Map<string, KeyedCandidate>();

  for (const { candidate, key } of candidates) {
    const seen = groups.get(key);

    if (seen === undefined) {
      groups.set(key, { candidate, key });
      continue;
    }

    const representative =
      candidate.confidence > seen.candidate.confidence ? candidate : seen.candidate;
    groups.set(key, {
      candidate: {
        ...representative,
        photoIndex: Math.min(seen.candidate.photoIndex, candidate.photoIndex),
      },
      key,
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
 *
 * ## `null`은 "물을 근거가 없다"는 뜻이다
 * 제목을 정규화한 결과가 빈 문자열이면 키를 만들지 않고 `null`을 낸다. 실패가
 * 아니라 **"같은 책인지 물을 축이 없다"**는 판정이다 — 접힘이 세는 단위는 책이고
 * 책을 가리키는 것은 제목이라, 제목이 비면 무엇을 접을지 정할 수가 없다.
 *
 * **저자가 있어도 `null`이다.** 제목을 못 읽었는데 저자만 같다는 것은 "같은
 * 저자의 어떤 책"이지 "같은 책"이 아니다. 저자로 접으면 서로 다른 책들이 한
 * 덩어리가 되어 화면에서 통째로 사라진다 (ADR-002).
 *
 * 새 판단이 아니다. `titleSimilarity`가 "어느 한쪽이라도 정규화 결과가 비면 0"을
 * 이미 지키고 있고(`match.ts`), 그 근거도 같다 — 빈 문자열끼리 일치로 세면 판독
 * 실패가 확인으로 승격된다. 이 모듈은 정규화를 `match.ts`에서 그대로 가져다 쓰며
 * 두 모듈의 키가 어긋나지 않는다고 선언하므로, 어긋나 있던 쪽(이 함수)을 맞춘다.
 *
 * ## 왜 내보내는가
 * 계측(`lib/unidentified.ts`)도 "같은 책인가"를 물어야 하는데, 그 판단이 병합과
 * 다른 키를 쓰면 **한 요청 안에서 같은 책의 정의가 둘**이 된다 — 병합은 접었는데
 * 계측은 둘로 세는(또는 그 반대의) 어긋남이고, 어느 쪽이 맞는지 로그만 보고는
 * 알 수 없다. 그래서 키를 두 번 구현하지 않고 이 함수 하나를 함께 쓴다.
 *
 * 매개변수를 `ExtractedCandidate`가 아니라 제목·저자 두 필드로 좁힌 것은 알라딘
 * 후보(`AladinCandidate`)에도 같은 키를 물을 수 있게 하기 위해서다. 키가 보는
 * 것은 그 둘뿐이라 좁혀도 잃는 정보가 없다.
 */
export function mergeKey(candidate: { title: string; author: string | null }): string | null {
  const title = normalizeTitle(candidate.title);
  if (title === "") return null;

  const author = candidate.author === null ? "" : normalizeAuthor(candidate.author);
  return `${title}\u0000${author}`;
}

/**
 * 조회 순위 비교. 확신도 내림차순이 1순위이고, 동점 tie-break는 결정성을 위해서만
 * 존재한다 — 입력 순서에 기대면 사진 처리 순서가 바뀔 때 조회 대상이 달라진다.
 */
function compareByConfidence(a: KeyedCandidate, b: KeyedCandidate): number {
  return (
    b.candidate.confidence - a.candidate.confidence ||
    a.candidate.photoIndex - b.candidate.photoIndex ||
    compareStrings(a.key, b.key)
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
