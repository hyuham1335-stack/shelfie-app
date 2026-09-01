/**
 * 제목 유사도와 확인/미확인 판정 (FR-003, TR-004).
 *
 * ## 이 파일은 네트워크를 모른다
 * 알라딘 조회는 `services/aladin.ts`의 몫이고, 여기서는 그 **결과를 인자로 받아**
 * 판정만 한다. `lib/` → `services/` 방향 import는 금지이며(/docs/ARCHITECTURE.md
 * 레이어 의존 관계), 그 경계 덕분에 이 판정 로직은 모킹 없이 단위 테스트된다.
 *
 * ## 판정의 비대칭 (ADR-002)
 * 이 제품에서 가장 치명적인 실패는 책을 몇 권 놓치는 것이 아니라 **없는 책을
 * 있다고 보여주는 것**이다. 그래서 애매하면 언제나 미확인 쪽으로 기운다 —
 * 후보가 둘이면 아무거나 고르지 않고 `ambiguous`로 내리고, ISBN13이 없는
 * 레코드는 유사도가 1.0이어도 승격하지 않는다.
 *
 * ## 사유는 끝까지 다른 값으로 나른다 (ADR-005)
 * `no_match`(알라딘에 정말 없음)와 `lookup_failed`(지금 조회하지 못함)는
 * 사용자에게 완전히 다른 문장으로 보인다. 조회 실패를 `no_match`로 뭉개면
 * 화면이 "원서·절판일 수 있어요"라는 **사실이 아닌 설명**을 하게 되고,
 * 그것은 가짜 책을 보여주는 것과 같은 종류의 신뢰 손상이다.
 */
import type { z } from "zod";
import { MAX_ALADIN_CANDIDATES } from "./env";
import { isbn13Schema } from "./schemas";
import type {
  aladinCandidateSchema,
  extractedCandidateSchema,
  unidentifiedReasonSchema,
} from "./schemas";

/*
 * 타입은 `types/`가 아니라 스키마에서 직접 파생한다. `types/` → `lib/`는 타입 전용
 * 점선이지만 역방향은 금지이며(/docs/ARCHITECTURE.md), 어차피 `types/book.ts`도
 * 같은 스키마의 `z.infer` 재수출이라 구조적으로 동일한 타입이다.
 */
type AladinCandidate = z.infer<typeof aladinCandidateSchema>;
type ExtractedCandidate = z.infer<typeof extractedCandidateSchema>;
type UnidentifiedReason = z.infer<typeof unidentifiedReasonSchema>;

/** 확인으로 승격하는 제목 유사도 하한 (FR-003, PRD Q4에서 0.8 유지로 재확인) */
export const MATCH_THRESHOLD = 0.8;

/**
 * 괄호로 감싼 구간. 알라딘 제목은 판형·부제를 여기에 담는다
 * ("소년이 온다 (양장본 HardCover)"). 여는 괄호와 닫는 괄호의 짝을 강제하지
 * 않는 이유는, 책등이 잘려 한쪽 괄호만 읽힌 원문도 정리 대상이기 때문이다.
 */
const BRACKETED_SEGMENT = /[([{<〈《「『【][^)\]}>〉》」』】]*[)\]}>〉》」』】]/gu;

/** 글자(모든 문자 체계)와 숫자를 제외한 전부 — 공백·문장부호·기호 */
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

/** 알라딘이 이름 뒤에 붙이는 역할 표기. 괄호 밖에 나오는 형태만 여기서 처리한다 */
const AUTHOR_ROLE_TOKEN = /(?:^|\s)(?:지은이|옮긴이|엮은이|편저|지음|옮김|엮음)(?=\s|$)/gu;

/** 여러 저자를 가르는 구분자 */
const AUTHOR_DELIMITER = /[,;/]/u;

/**
 * 비교용 제목 정규화.
 *
 * **정규화는 되돌릴 수 없다.** 아래에서 버리는 것과 남기는 것을 명시해 둔다.
 *
 * 버리는 것
 * - 유니코드 결합 형태 차이 → NFC로 합성한다. iOS·macOS에서 온 한글은 자모가
 *   분해된 NFD로 들어오는 일이 흔한데, 눈으로 같은 글자가 코드포인트로는 달라
 *   Levenshtein 거리가 통째로 벌어진다. 한글이 주 대상인 이 제품에서 이 한 줄이
 *   없으면 정상 매칭이 조용히 실패한다.
 * - 대소문자 → 영문 원서 제목의 표기 차이만 없애며, 한글에는 영향이 없다.
 * - 괄호 구간 → "(양장본)", "[개정판]" 같은 판형·부제 표기. 다만 제목 전체가
 *   괄호에 감싸인 경우(《채식주의자》)까지 지우면 비교할 문자가 사라지므로,
 *   결과가 비면 괄호 문자만 벗기고 내용은 살린다.
 * - 공백·문장부호 → 세로쓰기 책등은 띄어쓰기가 불안정하게 읽힌다("82년생 김지영"
 *   / "82년생김지영"). 공백을 남기면 이 차이가 그대로 거리로 잡힌다.
 *
 * 남기는 것
 * - **숫자와 `-`·`:` 뒤의 부제**. "파친코 1"과 "파친코 2", "완전정복 - 상"과
 *   "완전정복 - 하"는 서로 다른 책이다. 이것까지 잘라내면 두 권이 같은 문자열이
 *   되어 오확인(ADR-002가 금지하는 실패)이 생긴다. 부제 차이로 인한 오탈락은
 *   임계값을 낮춰서가 아니라 저자 tie-break로 회수한다는 것이 PRD Q4의 결정이다.
 *
 * 반환값이 빈 문자열이면 비교할 글자가 하나도 없다는 뜻이다 — 판독 실패 신호로
 * 쓰인다.
 */
export function normalizeTitle(raw: string): string {
  const base = raw.normalize("NFC").toLowerCase();
  const withoutBrackets = stripSymbols(base.replace(BRACKETED_SEGMENT, " "));
  // 괄호를 지웠더니 아무것도 남지 않으면 제목 전체가 괄호 안에 있었던 것이다.
  return withoutBrackets === "" ? stripSymbols(base) : withoutBrackets;
}

/**
 * 비교용 저자 정규화.
 *
 * 알라딘의 저자 필드는 "이민진 (지은이), 신승미 (옮긴이)" 형태로 역할이 함께
 * 온다. 역할 표기를 떼고 이름만 남기되 **저자 구분(쉼표)은 보존한다** — 역자까지
 * 한 덩어리로 뭉치면 "이민진"과 대조할 수 없다. 반환 형태는 쉼표로 이어 붙인
 * 정규화된 이름 목록이다.
 */
export function normalizeAuthor(raw: string): string {
  return raw
    .normalize("NFC")
    .toLowerCase()
    .replace(BRACKETED_SEGMENT, " ")
    .split(AUTHOR_DELIMITER)
    .map((name) => stripSymbols(name.replace(AUTHOR_ROLE_TOKEN, " ")))
    .filter((name) => name !== "")
    .join(",");
}

/**
 * 정규화 후 Levenshtein 거리 기반 유사도. 1.0이 완전 일치다.
 *
 * 어느 한쪽이라도 정규화 결과가 비면 0을 돌려준다 — 기호만 남은 문자열끼리
 * "둘 다 빈 문자열이니 일치"로 판정하면 판독 실패가 확인으로 승격된다.
 */
export function titleSimilarity(a: string, b: string): number {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (left === "" || right === "") return 0;
  if (left === right) return 1;

  const leftChars = [...left];
  const rightChars = [...right];
  const distance = levenshtein(leftChars, rightChars);
  return 1 - distance / Math.max(leftChars.length, rightChars.length);
}

/**
 * 알라딘 조회 결과. 이 함수는 네트워크를 모르므로 성공·실패를 **값으로** 받는다.
 * `failed`는 5xx·타임아웃·대조 예산 소진처럼 "지금 확인하지 못한" 경우다.
 */
export type LookupOutcome =
  | { status: "ok"; candidates: readonly AladinCandidate[] }
  | { status: "failed" };

/** 후보 1건에 대한 판정. 미확인이면 사유를 함께 나른다 (사유 보존 패턴) */
export type MatchVerdict =
  | { kind: "identified"; candidate: AladinCandidate }
  | { kind: "unidentified"; reason: UnidentifiedReason; candidates: AladinCandidate[] };

/**
 * 추출 후보 1건과 알라딘 조회 결과로 확인/미확인을 판정한다 (FR-003).
 *
 * 판정 순서에 의미가 있다.
 * 1. 판독 자체가 불완전하면(`unreadable`) 조회 결과를 보지 않는다. 우리 쪽
 *    인식 한계를 알라딘 장애로 보고하면 사용자는 엉뚱한 재시도를 하게 된다.
 * 2. 조회 실패는 `lookup_failed`다. 이 지점에서 `no_match`로 새면 ADR-005가
 *    막으려던 "시스템 문제를 데이터 문제로 설명하는" 결함이 된다.
 * 3. ISBN13이 없거나 형식이 틀린 레코드는 후보에서 제외한다. 사진 간 중복
 *    제거(FR-004)와 서명(FR-011)이 전부 이 값을 키로 삼으므로, 없으면 FR-009
 *    검증을 수행할 수가 없다 (ADR-002).
 *
 * `confidence`가 낮은 후보를 걸러내는 일은 여기서 하지 않는다 — 그 강등은
 * 알라딘을 호출하기 **전에** 일어나야 의미가 있어 `lib/merge.ts`(TR-005)가
 * 맡는다. 임계값을 두 곳에서 관리하지 않기 위해서다.
 */
export function judge(extracted: ExtractedCandidate, lookup: LookupOutcome): MatchVerdict {
  if (normalizeTitle(extracted.title) === "") return unidentified("unreadable");
  if (lookup.status === "failed") return unidentified("lookup_failed");

  const promotable = lookup.candidates.filter(
    (candidate) => isbn13Schema.safeParse(candidate.isbn13).success,
  );

  const matches = promotable
    .map((candidate) => ({
      candidate,
      similarity: titleSimilarity(extracted.title, candidate.title),
    }))
    .filter((scored) => scored.similarity >= MATCH_THRESHOLD)
    // 유사한 순으로 보여준다. 동점은 알라딘 검색 순위를 그대로 두어 결정적으로 만든다.
    .sort((a, b) => b.similarity - a.similarity)
    .map((scored) => scored.candidate);

  if (matches.length === 0) return unidentified("no_match");
  if (matches.length === 1) return { kind: "identified", candidate: matches[0] };

  // 임계값을 낮추는 대신 저자로 좁힌다 (PRD Q4). 동명 제목·개정판 상당수가 여기서 한 건이 된다.
  const byAuthor = matches.filter((candidate) => authorMatches(extracted.author, candidate.author));
  if (byAuthor.length === 1) return { kind: "identified", candidate: byAuthor[0] };

  // 그래도 복수면 고르지 않는다. 사용자가 직접 집을 수 있게 후보를 함께 넘긴다.
  const shortlist = byAuthor.length > 1 ? byAuthor : matches;
  return unidentified("ambiguous", shortlist.slice(0, MAX_ALADIN_CANDIDATES));
}

/**
 * 미확인 판정을 만든다. `candidates`는 `ambiguous`에서만 채워지며, 그 규칙은
 * `unidentifiedBookSchema`의 `.refine`이 이미 강제하고 있다 — 다른 사유에 후보가
 * 붙으면 화면이 "왜 빠졌는지"를 잘못 설명하게 된다.
 */
function unidentified(
  reason: UnidentifiedReason,
  candidates: AladinCandidate[] = [],
): MatchVerdict {
  return { kind: "unidentified", reason, candidates };
}

/** 정규화된 저자 목록이 한 명이라도 겹치는가. 읽어내지 못한 저자(null)는 아무와도 겹치지 않는다 */
function authorMatches(extracted: string | null, candidate: string): boolean {
  if (extracted === null) return false;
  const left = splitAuthors(normalizeAuthor(extracted));
  if (left.size === 0) return false;
  for (const name of splitAuthors(normalizeAuthor(candidate))) {
    if (left.has(name)) return true;
  }
  return false;
}

function splitAuthors(normalized: string): Set<string> {
  return new Set(normalized.split(",").filter((name) => name !== ""));
}

function stripSymbols(value: string): string {
  return value.replace(NON_ALPHANUMERIC, "");
}

/**
 * Levenshtein 거리. 새 의존성을 들이지 않기 위해 직접 구현한다 (CLAUDE.md).
 *
 * 행 전체를 보관하지 않고 이전 행 하나만 들고 굴러 O(min(n,m)) 메모리로 끝낸다.
 * 제목은 200자 상한이라 시간은 문제가 되지 않지만, 후보 80건 × 검색 결과만큼
 * 반복 호출되므로 할당을 줄여 두는 편이 낫다.
 */
function levenshtein(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length];
}
