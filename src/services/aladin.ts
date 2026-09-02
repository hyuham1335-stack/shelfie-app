/**
 * 알라딘 OpenAPI 래퍼 (TR-004의 서비스 부분).
 *
 * ## 이 파일은 네트워크만 한다
 * 제목 유사도 판정과 확인/미확인 결정은 `lib/match.ts`의 `judge()`가 이미 한다.
 * 여기서 다시 구현하면 판정 기준이 두 벌이 되어 소리 없이 갈린다. 그래서 검색의
 * 출력은 `judge()`가 그대로 받아먹는 `LookupOutcome`이다.
 *
 * ## 두 엔드포인트를 쓴다
 * - `ItemSearch`(`searchByTitle`·`searchMany`) — 제목·저자로 후보를 찾아 확인/미확인
 *   판정의 재료를 만든다. 출력은 `LookupOutcome`
 * - `ItemLookUp`(`lookupFacts`·`lookupFactsMany`) — **확인으로 승격된 책에만** 걸어
 *   `pages`·`aladinRating`·`aladinLink`를 채운다. 출력은 `FactsOutcome`
 *
 * 둘은 하나의 대조 예산(12s)과 하나의 요청 스코프 브레이커를 나눠 쓴다. 각자 예산을
 * 잡으면 합이 총 예산을 깨고, 브레이커를 따로 두면 이미 죽은 알라딘을 두 번 두드린다.
 *
 * ## 실패와 데이터 없음을 절대 섞지 않는다 (ADR-005, CLAUDE.md CRITICAL)
 * - 알라딘이 200을 주고 결과가 0건 → `{ status: "ok", candidates: [] }`
 *   → `judge()`가 `no_match`("알라딘에 정말 없음")로 판정한다
 * - 5xx·4xx·타임아웃·네트워크 오류·응답 형태 어긋남 → `{ status: "failed" }`
 *   → `judge()`가 `lookup_failed`("지금 확인 못 함")로 판정한다
 *
 * 이 둘을 뭉개면 알라딘이 멈췄을 뿐인데 화면이 "원서·절판일 수 있어요"라고
 * 말하게 된다. 사실이 아닌 설명은 가짜 책을 보여주는 것과 같은 종류의 신뢰
 * 손상이다. **200인데 본문이 우리가 아는 형태가 아닌 경우도 `failed`다** —
 * 형태를 모르면 "책이 없다"고 말할 근거가 없기 때문이다.
 *
 * ## 예외를 던지지 않는다
 * 조회 실패는 예외가 아니라 판별 가능한 값이다(/docs/ARCHITECTURE.md 검증 경계·
 * 강등 패턴). 후보 한 건의 실패로 요청 전체가 죽으면 fail-soft가 성립하지 않는다.
 *
 * ## 상태를 모듈에 남기지 않는다 (ADR-003)
 * 서킷 브레이커는 `createRequestBreaker()`로 **요청마다 새로 만들어** 인자로
 * 넘긴다. 모듈 스코프에 두면 무상태 전제를 문서 없이 우회하는 것이고, 서버리스
 * 인스턴스 간에 공유되지도 않아 동작조차 하지 않는다.
 */
import { z } from "zod";

import { getAladinTtbKey } from "@/lib/env";
import type { LookupOutcome } from "@/lib/match";
import { aladinCandidateSchema, aladinFactsSchema } from "@/lib/schemas";

type AladinCandidate = z.infer<typeof aladinCandidateSchema>;
type AladinFacts = z.infer<typeof aladinFactsSchema>;

/** 알라딘 조회 동시성 상한 (TR-004). 상한 없이 80건을 한꺼번에 던지지 않는다 */
export const ALADIN_CONCURRENCY = 12;

/** 같은 요청 안에서 연속 이만큼 실패하면 브레이커를 연다 (TRD 7번 요청 스코프 브레이커) */
export const BREAKER_CONSECUTIVE_FAILURES = 5;

/**
 * 개별 호출 타임아웃 (TRD 7번 외부 의존성 표).
 * **이 값은 상한일 뿐 예산이 아니다.** 실제 타임아웃은 항상
 * `min(이 값, 남은 데드라인)`이며, 그래서 여러 호출의 합이 대조 단계 예산(12s)을
 * 넘지 못한다 (ADR-005).
 */
export const ALADIN_CALL_TIMEOUT_MS = 5_000;

/**
 * ItemSearch에서 받아 오는 검색 결과 수.
 *
 * 사용자에게 보여 주는 후보(`MAX_ALADIN_CANDIDATES` = 5)보다 넉넉하게 받는다.
 * 적게 받으면 유사도 0.8을 넘는 두 번째 후보가 순위 밖으로 밀려 `ambiguous`가
 * 되어야 할 책이 **한 건으로 보여 확인으로 승격**한다 — 오확인은 이 제품이
 * 가장 두려워하는 실패다 (ADR-002). 조회 횟수는 늘지 않는다(한 번에 받는다).
 */
export const ALADIN_SEARCH_MAX_RESULTS = 10;

const ALADIN_ITEM_SEARCH_URL = "https://www.aladin.co.kr/ttb/api/ItemSearch.aspx";
const ALADIN_ITEM_LOOKUP_URL = "https://www.aladin.co.kr/ttb/api/ItemLookUp.aspx";
const ALADIN_API_VERSION = "20131101";

/* ------------------------------------------------------------------ *
 * 요청 스코프 서킷 브레이커 (TRD 7번 [MVP])
 * ------------------------------------------------------------------ */

/**
 * 요청 하나의 수명을 갖는 브레이커. **모듈 스코프·전역에 두지 마라** (ADR-003).
 *
 * 인스턴스 간 브레이커는 공유 스토어가 필요해 Scale로 미뤄져 있지만, 한 요청
 * 안에서는 인메모리로 얼마든지 가능하다. 이것이 없으면 알라딘이 완전히 다운됐을
 * 때 한 요청이 후보 80건 × (호출 1 + 재시도 1) = **최대 160회의 실패 호출**을
 * 던지고, 12s 대조 예산을 타임아웃으로만 소진한 뒤에야 끝난다. 이미 죽은 서비스를
 * 계속 두드리는 것은 우리에게도 상대에게도 손해다 (TRD 7번).
 */
export interface RequestBreaker {
  isOpen(): boolean;
  recordSuccess(): void;
  recordFailure(): void;
}

/**
 * 브레이커를 연다. 요청 진입점(라우트 핸들러)이 요청마다 하나씩 만든다.
 *
 * 한 번 열리면 그 요청이 끝날 때까지 닫히지 않는다 — half-open을 두지 않는 것은
 * 의도다. 열린 뒤에는 호출 자체를 하지 않으므로 성공을 관측할 방법이 없고,
 * 상태는 요청이 끝나면 사라지므로 다음 요청이 자연스러운 복구가 된다.
 */
export function createRequestBreaker(
  threshold: number = BREAKER_CONSECUTIVE_FAILURES,
): RequestBreaker {
  const limit = Math.max(1, threshold);
  let consecutiveFailures = 0;
  let open = false;

  return {
    isOpen: () => open,
    recordSuccess() {
      consecutiveFailures = 0;
    },
    recordFailure() {
      consecutiveFailures += 1;
      if (consecutiveFailures >= limit) open = true;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 응답 스키마 — 검증 경계 (CLAUDE.md CRITICAL)
 * ------------------------------------------------------------------ */

/**
 * ItemSearch 응답 봉투.
 *
 * `totalResults`를 필수로 두는 것이 핵심이다. 봉투 없이 `item`만 옵셔널로 보면
 * `{}`나 알라딘 오류 객체(`{ errorCode: 8 }`)까지 "결과 0건"으로 읽혀 시스템
 * 문제가 `no_match`로 둔갑한다 (ADR-005).
 */
const searchEnvelopeSchema = z.object({
  totalResults: z.number().int().min(0),
  item: z.array(z.unknown()).optional(),
});

/** 알라딘이 오류를 200 본문으로 돌려주는 형태 */
const errorEnvelopeSchema = z.object({
  errorCode: z.union([z.number(), z.string()]),
});

/**
 * 알라딘 원본 레코드에서 우리가 읽는 필드.
 *
 * 값의 형식 검증(13자리 ISBN·절대 URL·길이)은 여기서 하지 않는다.
 * 검증 경계는 `lib/schemas.ts` 하나여야 하므로, 이 스키마는 **필드 이름을 옮기는
 * 일**만 하고 판정은 `aladinCandidateSchema`에 맡긴다.
 */
const aladinItemSchema = z.object({
  isbn13: z.string(),
  title: z.string(),
  author: z.string(),
  publisher: z.string(),
  cover: z.string(),
});

/**
 * ItemLookUp 레코드에서 우리가 읽는 필드. 검색 레코드에 `link`와 서지 사실 둘이 더 붙는다.
 *
 * `customerReviewRank`(독자평점)와 `subInfo.itemPage`(쪽수)를 `unknown`으로 받는 이유는
 * **없음을 표현하는 방식이 하나가 아니기 때문**이다 — 키 자체가 없기도 하고 `0`이 오기도
 * 한다. 여기서 타입을 강제하면 "정보 없는 책"이 통째로 조회 실패가 되어, `null`이 정상값인
 * 필드(API_SPEC)를 시스템 문제로 둔갑시킨다. 값 판정은 `toNullableNumber`가 한 뒤
 * `aladinFactsSchema`가 최종 검증한다.
 */
const aladinLookupItemSchema = aladinItemSchema.extend({
  link: z.string(),
  customerReviewRank: z.unknown(),
  subInfo: z.object({ itemPage: z.unknown() }).optional(),
});

/* ------------------------------------------------------------------ *
 * 공개 API
 * ------------------------------------------------------------------ */

export interface SearchOptions {
  /** 이 조회에 쓸 수 있는 시간(ms). `budget.deadlineFor("lookup")`의 결과를 그대로 넘긴다 */
  deadlineMs: number;
  /** 요청 스코프 브레이커. 생략하면 브레이커 없이 단발 조회한다 */
  breaker?: RequestBreaker;
  /** 테스트 주입점. 생략하면 전역 `fetch` */
  fetchImpl?: typeof fetch;
}

/**
 * 제목·저자로 알라딘을 조회한다. 실패를 예외가 아니라 값으로 돌려준다.
 *
 * 호출하지 않고 바로 `failed`를 주는 두 경우가 있는데, 둘 다 **브레이커에
 * 실패로 세지 않는다** — 알라딘이 죽었다는 증거가 아니기 때문이다.
 * ① 브레이커가 이미 열림 ② 남은 데드라인이 없음(예산 소진).
 */
export async function searchByTitle(
  title: string,
  author: string | null,
  options: SearchOptions,
): Promise<LookupOutcome> {
  const { breaker, deadlineMs, fetchImpl = fetch } = options;

  if (breaker?.isOpen()) return { status: "failed" };
  if (deadlineMs <= 0) return { status: "failed" };

  const ttbKey = getAladinTtbKey();
  if (ttbKey === null) return mockOutcome(title, author);

  const deadlineAt = Date.now() + deadlineMs;
  const attempt = await requestWithRetry(
    buildSearchUrl(ttbKey, title, author),
    deadlineAt,
    fetchImpl,
    parseSearchResponse,
  );

  if (attempt.kind === "ok") {
    breaker?.recordSuccess();
    return { status: "ok", candidates: attempt.value };
  }

  breaker?.recordFailure();
  return { status: "failed" };
}

/**
 * 후보 여러 건을 동시성 제한(12) 아래 조회한다. 결과는 입력 순서를 지킨다.
 *
 * 브레이커는 이 배치 전체가 공유한다. 열리는 순간 잔여 후보는 조회 없이
 * `failed`로 돌아가고, 호출부는 그것을 `lookup_failed`로 강등해 즉시 다음
 * 단계로 넘어간다 (TRD 7번). 데드라인도 배치 전체가 나눠 쓴다 — 각 호출은
 * 시작 시점에 남은 시간을 다시 계산하므로 합이 대조 예산을 넘지 않는다.
 */
export async function searchMany(
  queries: readonly { title: string; author: string | null }[],
  options: SearchOptions,
): Promise<LookupOutcome[]> {
  const breaker = options.breaker ?? createRequestBreaker();
  const deadlineAt = Date.now() + options.deadlineMs;
  const results = new Array<LookupOutcome>(queries.length);

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < queries.length) {
      const index = cursor;
      cursor += 1;
      const query = queries[index];
      results[index] = await searchByTitle(query.title, query.author, {
        ...options,
        breaker,
        deadlineMs: deadlineAt - Date.now(),
      });
    }
  };

  const workerCount = Math.min(ALADIN_CONCURRENCY, queries.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

/* ------------------------------------------------------------------ *
 * 공개 API — ItemLookUp (서지 사실 완성)
 * ------------------------------------------------------------------ */

/**
 * ItemLookUp 결과. 실패는 예외가 아니라 판별 가능한 값이다.
 *
 * `failed`는 호출부가 그 책을 **`lookup_failed`로 강등**하라는 뜻이며, 절대
 * `no_match`가 아니다 — ItemSearch로 찾아낸 책이므로 "알라딘에 없다"고 말할
 * 근거가 없다 (ADR-005).
 */
export type FactsOutcome = { status: "ok"; facts: AladinFacts } | { status: "failed" };

/**
 * ISBN13으로 서지 사실(`pages`·`aladinRating`·`aladinLink`)을 채운다.
 *
 * ## 왜 확인으로 승격된 책에만 부르는가 (호출 수 재검토)
 * 대조 예산은 12s인데 후보 80건 × (ItemSearch + ItemLookUp) = 최대 160회를 그
 * 안에 넣을 수 없다. 그래서 **ItemLookUp은 `judge()`가 확인으로 승격시킨 책에만**
 * 호출한다 — 미확인 책은 화면에 원문과 사유만 보여 주므로 사실 필드가 애초에
 * 필요 없다(API_SPEC의 `UnidentifiedBook`에는 `pages`도 `aladinRating`도 없다).
 * 승격은 후보보다 훨씬 적고 50권 상한(FR-005) 아래이므로, 추가 호출은 후보 수가
 * 아니라 확인된 책 수에 비례한다. 배치 조회는 택하지 않았다 — 알라딘 ItemLookUp은
 * `ItemId` 하나만 받는다.
 *
 * ## 사실을 못 채우면 확인으로 올리지 않는다 (ADR-002)
 * ItemSearch가 찾아냈더라도 여기서 `failed`가 나오면 그 책은 확인이 아니다.
 * 빈 칸을 사실인 것처럼 보여 주는 것은 이 제품이 가장 두려워하는 실패와 같은
 * 종류다. 그래서 이 함수는 **부분적으로 채운 facts를 절대 돌려주지 않는다** —
 * `aladinFactsSchema`를 통째로 통과하거나 `failed`거나 둘 중 하나다.
 *
 * ## 호출부 참고 — 신원 필드
 * 응답의 신원 필드(제목·저자·출판사·표지)는 ItemSearch 후보와 같아야 정상이고,
 * ISBN13 불일치는 여기서 `failed`로 막는다. 그래도 호출부는 후보의 신원 필드를
 * 유지한 채 `pages`·`aladinRating`·`aladinLink`만 취하는 편이 안전하다 —
 * 목업 모드(TTB 키 없음)에서는 신원 필드를 만들어 낼 방법이 없기 때문이다.
 *
 * 호출하지 않고 바로 `failed`를 주는 두 경우(브레이커 열림·예산 소진)는
 * `searchByTitle`과 같은 규약으로 **브레이커 실패에 세지 않는다.**
 */
export async function lookupFacts(isbn13: string, options: SearchOptions): Promise<FactsOutcome> {
  const { breaker, deadlineMs, fetchImpl = fetch } = options;

  if (breaker?.isOpen()) return { status: "failed" };
  if (deadlineMs <= 0) return { status: "failed" };

  const ttbKey = getAladinTtbKey();
  if (ttbKey === null) return mockFacts(isbn13);

  const deadlineAt = Date.now() + deadlineMs;
  const attempt = await requestWithRetry(
    buildLookupUrl(ttbKey, isbn13),
    deadlineAt,
    fetchImpl,
    (body) => parseLookupResponse(body, isbn13),
  );

  if (attempt.kind === "ok") {
    breaker?.recordSuccess();
    return { status: "ok", facts: attempt.value };
  }

  breaker?.recordFailure();
  return { status: "failed" };
}

/**
 * 확인된 책들의 사실을 동시성 제한(12) 아래 채운다. 결과는 입력 순서를 지킨다.
 *
 * 브레이커·데드라인 규약은 `searchMany`와 같다. **같은 요청의 브레이커를 그대로
 * 넘겨라** — ItemSearch에서 이미 알라딘이 죽었다고 판정했는데 ItemLookUp이 처음부터
 * 다시 두드리면 요청 스코프 브레이커를 둔 의미가 없다. 데드라인도 마찬가지로
 * 대조 단계 예산을 ItemSearch와 **나눠 쓴다**: 호출부가 단계 시작 시점에 데드라인
 * 시각을 한 번 잡고 두 호출에 각각 남은 시간을 넘긴다. 각자 12s를 쓰면 합이 24s가
 * 되어 총 예산이 깨진다 (ADR-005).
 */
export async function lookupFactsMany(
  isbn13s: readonly string[],
  options: SearchOptions,
): Promise<FactsOutcome[]> {
  const breaker = options.breaker ?? createRequestBreaker();
  const deadlineAt = Date.now() + options.deadlineMs;
  const results = new Array<FactsOutcome>(isbn13s.length);

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < isbn13s.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await lookupFacts(isbn13s[index], {
        ...options,
        breaker,
        deadlineMs: deadlineAt - Date.now(),
      });
    }
  };

  const workerCount = Math.min(ALADIN_CONCURRENCY, isbn13s.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

/* ------------------------------------------------------------------ *
 * 내부 — 호출 1회
 * ------------------------------------------------------------------ */

type Attempt<T> =
  | { kind: "ok"; value: T }
  /** 다시 걸면 달라질 수 있는 실패 — 5xx·타임아웃·네트워크 오류 */
  | { kind: "retryable" }
  /** 다시 걸어도 같은 실패 — 4xx·응답 형태 어긋남 */
  | { kind: "fatal" };

/** 본문을 결과로 옮기는 함수. 엔드포인트마다 다르고, 전송 규약은 공유한다 */
type ResponseParser<T> = (body: string) => Attempt<T>;

/**
 * 호출 1회 + 조건부 재시도. 두 엔드포인트가 **같은 규약**을 쓰도록 여기 하나로 묶는다.
 *
 * 재시도는 5xx·타임아웃·네트워크 오류에만 한다. 4xx는 우리 요청이 잘못된 것이므로
 * 반복해도 같고, 호출 한 번은 일일 5,000회 한도에서 그대로 빠진다. 재시도도 남은
 * 데드라인 안에서만 한다 — 예산을 넘겨 가며 다시 걸지 않는다.
 */
async function requestWithRetry<T>(
  url: string,
  deadlineAt: number,
  fetchImpl: typeof fetch,
  parse: ResponseParser<T>,
): Promise<Attempt<T>> {
  let attempt = await callOnce(url, remainingTimeout(deadlineAt), fetchImpl, parse);

  if (attempt.kind === "retryable") {
    const remaining = remainingTimeout(deadlineAt);
    if (remaining > 0) {
      attempt = await callOnce(url, remaining, fetchImpl, parse);
    }
  }

  return attempt;
}

async function callOnce<T>(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  parse: ResponseParser<T>,
): Promise<Attempt<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      // 상태 코드만 남긴다. 응답 본문·URL에는 TTB 키가 섞일 수 있다 (TRD 6.5).
      warn(`조회 실패 status=${response.status}`);
      return response.status >= 500 ? { kind: "retryable" } : { kind: "fatal" };
    }

    return parse(await response.text());
  } catch (error) {
    // **메시지를 로그에 넣지 않는다.** fetch 실패 메시지는 요청 URL을 통째로
    // 담을 수 있고, 그 URL에는 ttbkey가 들어 있다 (TRD 6.5).
    warn(`조회 중 오류 name=${error instanceof Error ? error.name : "Unknown"}`);
    return { kind: "retryable" };
  } finally {
    clearTimeout(timer);
  }
}

/** 남은 시간과 개별 호출 상한 중 작은 쪽. 음수는 0으로 clamp한다 */
function remainingTimeout(deadlineAt: number): number {
  return Math.max(0, Math.min(ALADIN_CALL_TIMEOUT_MS, deadlineAt - Date.now()));
}

function buildSearchUrl(ttbKey: string, title: string, author: string | null): string {
  const url = new URL(ALADIN_ITEM_SEARCH_URL);
  url.searchParams.set("ttbkey", ttbKey);
  // 저자를 아는 경우 함께 실어 검색 정확도를 높인다 (FR-003의 저자 tie-break 전 단계)
  url.searchParams.set("Query", author === null ? title : `${title} ${author}`);
  url.searchParams.set("QueryType", "Keyword");
  url.searchParams.set("SearchTarget", "Book");
  url.searchParams.set("MaxResults", String(ALADIN_SEARCH_MAX_RESULTS));
  url.searchParams.set("start", "1");
  url.searchParams.set("output", "js");
  url.searchParams.set("Version", ALADIN_API_VERSION);
  return url.toString();
}

/**
 * ItemLookUp URL. ISBN13 하나를 키로 조회한다.
 *
 * 쪽수(`subInfo.itemPage`)와 독자평점(`customerReviewRank`)은 기본 응답에 들어
 * 있으므로 `OptResult`를 붙이지 않는다. 필요 없는 옵션은 응답만 키운다.
 */
function buildLookupUrl(ttbKey: string, isbn13: string): string {
  const url = new URL(ALADIN_ITEM_LOOKUP_URL);
  url.searchParams.set("ttbkey", ttbKey);
  url.searchParams.set("itemIdType", "ISBN13");
  url.searchParams.set("ItemId", isbn13);
  url.searchParams.set("output", "js");
  url.searchParams.set("Version", ALADIN_API_VERSION);
  return url.toString();
}

/**
 * 본문을 후보 목록으로 옮긴다.
 *
 * 파싱 실패는 전부 `fatal`이다 — 같은 본문이 다시 올 뿐이라 재시도할 이유가 없고,
 * **`ok` + 빈 배열로 내려서도 안 된다.** 그것은 "알라딘에 그 책이 없다"는
 * 완전히 다른 주장이 된다 (ADR-005).
 */
function parseSearchResponse(body: string): Attempt<AladinCandidate[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    warn("응답 본문이 JSON이 아닙니다 — 결과 없음으로 다루지 않고 조회 실패로 강등합니다");
    return { kind: "fatal" };
  }

  const errorEnvelope = errorEnvelopeSchema.safeParse(raw);
  if (errorEnvelope.success) {
    // errorMessage는 남기지 않는다. 알라딘이 요청 문자열을 되돌려주는 경우가 있다.
    warn(`오류 응답 errorCode=${errorEnvelope.data.errorCode}`);
    return { kind: "fatal" };
  }

  const envelope = searchEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    warn("응답 형태가 계약과 다릅니다 — 조회 실패로 강등합니다 (계약 테스트 확인 필요)");
    return { kind: "fatal" };
  }

  const items = envelope.data.item;
  if (items === undefined) {
    // 결과가 0건이면 알라딘은 item을 비워 보낸다. totalResults가 있는데 item이
    // 없는 것은 우리가 모르는 형태이므로 "없다"고 말하지 않는다.
    if (envelope.data.totalResults === 0) return { kind: "ok", value: [] };
    warn("결과가 있다고 하면서 item이 없습니다 — 조회 실패로 강등합니다");
    return { kind: "fatal" };
  }

  const candidates: AladinCandidate[] = [];
  for (const item of items) {
    const candidate = toCandidate(item);
    if (candidate !== null) candidates.push(candidate);
  }

  const dropped = items.length - candidates.length;
  if (dropped > 0) {
    // 조용히 버리지 않는다. ISBN13이 없는 세트·구간 상품(ADR-002)과 알라딘의
    // 스키마 변경은 둘 다 여기로 나타나며, 카운트가 늘면 계약 테스트를 본다.
    warn(`검색 결과 ${items.length}건 중 ${dropped}건을 스키마 검증에서 제외했습니다`);
  }

  return { kind: "ok", value: candidates };
}

/**
 * 알라딘 레코드 1건 → 후보. 통과하지 못하면 `null`이다.
 *
 * ISBN13이 없는 레코드가 여기서 걸린다 — `aladinCandidateSchema`의 13자리 검사가
 * 막는다. 그 값은 중복 제거 키이자 추천 화이트리스트의 유일한 식별자라, 없으면
 * FR-009 검증을 수행할 수가 없다 (ADR-002, TR-004).
 */
function toCandidate(raw: unknown): AladinCandidate | null {
  const item = aladinItemSchema.safeParse(raw);
  if (!item.success) return null;

  const candidate = aladinCandidateSchema.safeParse({
    isbn13: item.data.isbn13,
    title: item.data.title,
    author: item.data.author,
    publisher: item.data.publisher,
    coverUrl: item.data.cover,
  });
  return candidate.success ? candidate.data : null;
}

/**
 * 본문을 서지 사실 1건으로 옮긴다.
 *
 * **여기에는 "결과 없음"이라는 성공 경로가 없다.** ItemSearch가 이미 찾아낸 책을
 * 다시 묻는 조회이므로, 0건이 오면 그것은 "알라딘에 없는 책"이 아니라 우리가
 * 모르는 상태다. `no_match`로 내려보내면 사용자에게 사실이 아닌 설명을 하게
 * 되므로(ADR-005), 전부 `fatal` → `lookup_failed`로 강등한다.
 */
function parseLookupResponse(body: string, expectedIsbn13: string): Attempt<AladinFacts> {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    warn("상품 조회 본문이 JSON이 아닙니다 — 조회 실패로 강등합니다");
    return { kind: "fatal" };
  }

  const errorEnvelope = errorEnvelopeSchema.safeParse(raw);
  if (errorEnvelope.success) {
    warn(`상품 조회 오류 응답 errorCode=${errorEnvelope.data.errorCode}`);
    return { kind: "fatal" };
  }

  const envelope = searchEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    warn("상품 조회 응답 형태가 계약과 다릅니다 — 조회 실패로 강등합니다 (계약 테스트 확인 필요)");
    return { kind: "fatal" };
  }

  const item = envelope.data.item?.[0];
  if (item === undefined) {
    warn("상품 조회 결과가 0건입니다 — 확인으로 승격하지 않고 조회 실패로 강등합니다");
    return { kind: "fatal" };
  }

  const facts = toFacts(item, expectedIsbn13);
  if (facts === null) {
    // 조용히 버리지 않는다. 알라딘의 스키마 변경이 여기로 나타나며, 카운트가
    // 늘면 계약 테스트를 본다.
    warn("상품 조회 레코드가 스키마 검증을 통과하지 못했습니다 — 확인으로 승격하지 않습니다");
    return { kind: "fatal" };
  }

  return { kind: "ok", value: facts };
}

/**
 * ItemLookUp 레코드 1건 → 서지 사실. 통과하지 못하면 `null`이다.
 *
 * **부분적으로 채운 값을 돌려주지 않는다.** `aladinLink`가 없거나 절대 URL이
 * 아니면 그 책은 확인으로 올라가지 않는다 — 빈 칸을 사실인 것처럼 보여 주는 것은
 * 가짜 책을 보여 주는 것과 같은 종류의 결함이다 (ADR-002).
 *
 * ISBN13 일치도 강제한다. 다른 책의 사실을 이 책에 붙이는 것이 바로 그 결함이다.
 */
function toFacts(raw: unknown, expectedIsbn13: string): AladinFacts | null {
  const item = aladinLookupItemSchema.safeParse(raw);
  if (!item.success) return null;

  if (item.data.isbn13 !== expectedIsbn13) {
    // ISBN은 식별자일 뿐 비밀이 아니므로 로그에 남겨도 된다 (TRD 6.4의 금지 목록에 없다).
    warn(`상품 조회 결과의 ISBN13이 요청과 다릅니다 requested=${expectedIsbn13}`);
    return null;
  }

  const facts = aladinFactsSchema.safeParse({
    isbn13: item.data.isbn13,
    title: item.data.title,
    author: item.data.author,
    publisher: item.data.publisher,
    coverUrl: item.data.cover,
    pages: toNullableNumber(item.data.subInfo?.itemPage),
    aladinRating: toNullableNumber(item.data.customerReviewRank),
    aladinLink: item.data.link,
  });
  return facts.success ? facts.data : null;
}

/**
 * 알라딘의 "정보 없음"을 `null`로 옮긴다.
 *
 * `null`은 정상값이다 — 쪽수·평점이 없는 책은 확인된 책으로 정상 표시되며,
 * 이것을 조회 실패와 섞으면 안 된다 (API_SPEC의 `pages`·`aladinRating`).
 * 알라딘은 없음을 **키 누락과 `0` 두 가지**로 표현하므로 둘 다 `null`로 본다 —
 * `0`을 그대로 쓰면 화면이 "독자 0.0", "0쪽"이라는 **없는 사실**을 말하게 된다.
 * 그 밖의 값은 손대지 않고 `aladinFactsSchema`가 판정한다(범위를 벗어난 값은
 * 우리가 아는 응답 형태가 아니므로 그 레코드를 통째로 실패시킨다).
 */
function toNullableNumber(raw: unknown): number | null {
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/* ------------------------------------------------------------------ *
 * 목업 모드 (TRD 9번)
 * ------------------------------------------------------------------ */

const MOCK_AUTHOR = "목업 저자";
const MOCK_PUBLISHER = "목업 출판사";
const MOCK_COVER_URL = "https://image.aladin.co.kr/mock/cover.jpg";

/**
 * `ALADIN_TTB_KEY`가 없을 때의 로컬 개발 응답.
 *
 * TRD 9번이 "API 키 발급 전에도 UI와 상태 전이를 전부 검증할 수 있어야 한다"고
 * 요구했다. 그래서 요청한 제목을 그대로 후보로 돌려준다 — 그래야 `judge()`가
 * 확인으로 승격시켜 확인된 책 화면을 볼 수 있다.
 *
 * **조용한 목업은 금지다.** 호출마다 경고를 남기고, ISBN도 실제 접두사(978·979)를
 * 쓰지 않는 `0000000######` 형태로 만들어 눈으로도 구분되게 한다. "동작하는 줄
 * 알았는데 알라딘 대조를 한 번도 안 했다"가 이 모드의 유일한 위험이다.
 * 목업 값도 검증 경계를 그대로 통과시킨다 — 픽스처만 예외를 두면 스키마가
 * 바뀌었을 때 로컬에서만 통과하는 코드가 생긴다.
 */
function mockOutcome(title: string, author: string | null): LookupOutcome {
  warn(
    "ALADIN_TTB_KEY가 없어 네트워크를 호출하지 않고 목업 후보를 돌려줍니다 (로컬 개발 모드, TRD 9번). 이 결과는 알라딘 대조를 거치지 않았습니다.",
  );

  const candidate = aladinCandidateSchema.safeParse({
    isbn13: mockIsbn13(title),
    title,
    author: author ?? MOCK_AUTHOR,
    publisher: MOCK_PUBLISHER,
    coverUrl: MOCK_COVER_URL,
  });

  return { status: "ok", candidates: candidate.success ? [candidate.data] : [] };
}

/** 제목에서 결정적으로 만드는 가짜 ISBN13. 같은 책이면 같은 값이라 중복 제거(FR-004)도 확인된다 */
function mockIsbn13(title: string): string {
  let hash = 0;
  for (const char of title) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1_000_000;
  }
  return `0000000${String(hash).padStart(6, "0")}`;
}

/**
 * 키 없이도 서지 사실 화면(쪽수·평점·상품 링크)을 볼 수 있게 하는 로컬 응답.
 *
 * ISBN13 말고는 아는 것이 없으므로 제목·저자는 목업 값이다. **호출부는 ItemSearch
 * 후보의 신원 필드를 유지하고 여기서는 `pages`·`aladinRating`·`aladinLink`만
 * 가져가는 것을 권한다** — 그러면 로컬에서도 목록의 제목이 정상으로 보인다.
 * 목업 값도 검증 경계를 그대로 통과시킨다: 픽스처만 예외를 두면 스키마가 바뀌었을
 * 때 로컬에서만 통과하는 코드가 생긴다.
 */
function mockFacts(isbn13: string): FactsOutcome {
  warn(
    "ALADIN_TTB_KEY가 없어 네트워크를 호출하지 않고 목업 서지 사실을 돌려줍니다 (로컬 개발 모드, TRD 9번). 이 쪽수·평점은 알라딘에서 온 값이 아닙니다.",
  );

  const facts = aladinFactsSchema.safeParse({
    isbn13,
    title: `목업 도서 ${isbn13}`,
    author: MOCK_AUTHOR,
    publisher: MOCK_PUBLISHER,
    coverUrl: MOCK_COVER_URL,
    pages: 234,
    aladinRating: 8.6,
    aladinLink: `https://www.aladin.co.kr/shop/wproduct.aspx?ISBN=${isbn13}`,
  });

  return facts.success ? { status: "ok", facts: facts.data } : { status: "failed" };
}

/**
 * 이 모듈의 유일한 로그 출구.
 *
 * 여기를 하나로 묶어 두는 이유는 **TTB 키가 새는 경로를 한 곳으로 좁히기**
 * 위해서다. URL·응답 본문·fetch 에러 메시지는 전부 키를 담을 수 있으므로 어떤
 * 호출부도 그것들을 넘기지 않는다. 미확인 강등은 사람이 조치할 일이 아니므로
 * `error`가 아니라 `warn`이다 (TRD 6.4 로그 레벨 기준).
 */
function warn(message: string): void {
  console.warn(`[aladin] ${message}`);
}
