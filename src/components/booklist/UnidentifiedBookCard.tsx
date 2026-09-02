"use client";

/**
 * 미확인 책 카드 (UI_GUIDE "미확인 사유 문구" 표).
 *
 * 이 카드의 존재 이유는 "못 한 일을 숨기지 않는다"이지만, 드러내는 것만으로는 부족하고
 * **사유가 사실이어야** 한다. 특히 `lookup_failed`(알라딘을 조회하지 못함)에
 * "원서·절판일 수 있어요"를 쓰면 시스템 문제를 데이터 문제로 설명하는 것이 되고,
 * 그것은 없는 책을 지어내는 것과 같은 종류의 거짓말이다 (ADR-005).
 *
 * 그래서 사유 4종은 문장·색·가능한 행동이 전부 다르다.
 * - unreadable    : 우리 쪽 판독 한계 → 제목 직접 입력
 * - no_match      : 알라딘에 정말 없음 → 제목 고쳐 재검색
 * - ambiguous     : 후보가 여럿 → **재검색이 아니라 후보 선택** (US-002 AC)
 * - lookup_failed : 우리 쪽 조회 실패 → 재시도. 절판·원서 안내를 쓰지 않는다
 */
import { Badge } from "@/components/common/Badge";
import type { AladinCandidate, UnidentifiedBook, UnidentifiedReason } from "@/types/book";
import { BookCover } from "./BookCover";

/** UI_GUIDE "미확인 사유 문구" 표를 그대로 옮긴다. 문구를 여기서 지어내지 않는다 */
const DESCRIPTION: Record<UnidentifiedReason, string> = {
  unreadable: "책등 글자를 읽지 못했어요",
  no_match: "알라딘에서 찾을 수 없는 책이에요 (원서·절판일 수 있어요)",
  ambiguous: "비슷한 책이 여러 권이에요. 어느 쪽인가요?",
  // 우리 쪽 문제다. 사용자 책장을 의심하게 만드는 문장을 쓰지 않는다 (ADR-005).
  lookup_failed: "지금 확인할 수 없었어요. 잠시 후 다시 시도해 주세요",
};

/** 재검색 경로의 버튼 문구도 사유에 따라 다르다 — 하나는 입력, 하나는 수정이다 */
const RESOLVE_LABEL: Record<UnidentifiedReason, string> = {
  unreadable: "제목 직접 입력",
  no_match: "제목 고쳐 재검색",
  ambiguous: "제목 고쳐 재검색",
  lookup_failed: "제목 고쳐 재검색",
};

const SECONDARY_BUTTON =
  "min-h-11 rounded-md border border-line bg-card px-5 py-3 text-sm text-ink hover:bg-muted-surface";

export interface UnidentifiedBookCardProps {
  book: UnidentifiedBook;
  /** 제목을 고쳐 다시 찾는 경로 (US-002). 이 컴포넌트는 호출하지 않고 위임만 한다 */
  onResolve?: (book: UnidentifiedBook) => void;
  /** ambiguous 후보를 바로 고르는 경로. 재검색 없이 확인된 책으로 옮긴다 */
  onSelectCandidate?: (book: UnidentifiedBook, candidate: AladinCandidate) => void;
  /** lookup_failed 전용 재시도 경로 */
  onRetryLookup?: () => void;
}

export function UnidentifiedBookCard({
  book,
  onResolve,
  onSelectCandidate,
  onRetryLookup,
}: UnidentifiedBookCardProps) {
  // ambiguous인데 후보가 비어 있으면(스키마상 가능하다) 고를 것이 없으므로
  // 다른 사유와 같은 재검색 경로로 되돌린다.
  const showCandidates = book.reason === "ambiguous" && book.candidates.length > 0;
  const showRetry = book.reason === "lookup_failed";
  const showResolve = !showCandidates && !showRetry;

  return (
    <article className="space-y-2 rounded-sm border border-dashed border-unverified/40 bg-muted-surface p-4">
      <Badge kind="reason" reason={book.reason} />

      {/* 사진에서 읽힌 그대로임을 형태로 알린다 (UI_GUIDE 타이포그래피) */}
      <p className="font-mono text-sm text-body">{book.rawText}</p>
      <p className="text-sm text-subtle">{DESCRIPTION[book.reason]}</p>

      {showCandidates && onSelectCandidate !== undefined && (
        <ul className="space-y-2">
          {book.candidates.map((candidate) => (
            <li key={candidate.isbn13}>
              <button
                type="button"
                onClick={() => onSelectCandidate(book, candidate)}
                className="flex min-h-11 w-full items-center gap-3 rounded-md border border-line bg-card p-3 text-left hover:bg-muted-surface"
              >
                <BookCover
                  coverUrl={candidate.coverUrl}
                  title={candidate.title}
                  className="w-10"
                />
                <span className="min-w-0">
                  <span
                    title={candidate.title}
                    className="line-clamp-2 block text-sm text-ink"
                  >
                    {candidate.title}
                  </span>
                  <span className="line-clamp-1 block text-xs text-subtle">
                    {candidate.author} · {candidate.publisher}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {showRetry && onRetryLookup !== undefined && (
        <button type="button" onClick={onRetryLookup} className={SECONDARY_BUTTON}>
          다시 시도
        </button>
      )}

      {showResolve && onResolve !== undefined && (
        <button
          type="button"
          onClick={() => onResolve(book)}
          className={SECONDARY_BUTTON}
        >
          {RESOLVE_LABEL[book.reason]}
        </button>
      )}
    </article>
  );
}
