"use client";

/**
 * 추천 1권 카드 (US-003, TR-010, UI_GUIDE "카드").
 *
 * ## 이 파일에서 가장 조심할 것
 * `recommendation.reason`은 **Claude가 지어낸 문장**이고, 표지·제목·저자·출판사·쪽수·
 * 평점은 알라딘에서 온 사실이다. 둘을 같은 문단·같은 색으로 흘리면 사용자는 무엇이
 * 검증된 정보인지 알 수 없게 된다 (ADR-002, CLAUDE.md CRITICAL). 그래서 이유는
 * 예외 없이 `ClaudeText` 블록을 거친다 — 이 카드가 이유를 직접 렌더하는 순간
 * 두 층을 가르는 유일한 장치가 사라진다.
 *
 * ## 반경이 다르다
 * 확인된 책은 `rounded-md`, 미확인은 `rounded-sm`, 추천은 `rounded-lg`다. 색을
 * 구별하지 못해도 형태로 세 목록이 다른 것으로 읽혀야 하고, 전부 같은 반경으로
 * 두는 것은 UI_GUIDE가 안티패턴으로 명시한 템플릿 느낌 그 자체다.
 *
 * ## 사실은 `AladinFacts`로만 받는다
 * `IdentifiedBook`·`ResolvedCandidate` 둘 다 이 층을 갖는다. 좁은 타입으로 받으면
 * Claude 생성 필드(`claudeNote`)가 이 카드에 흘러들어올 수 없다 — 추천 화면에서
 * 붙는 해석은 추천 이유 하나여야 한다.
 */
import { BookCover } from "@/components/booklist/BookCover";
import { AladinLink } from "@/components/common/AladinLink";
import { Badge } from "@/components/common/Badge";
import { ClaudeText } from "@/components/common/ClaudeText";
import type { Recommendation } from "@/types/api";
import type { AladinFacts } from "@/types/book";

export interface RecommendationCardProps {
  /** 알라딘 원본 사실만 담긴 층 (ADR-002) */
  book: AladinFacts;
  /** `bookId`가 확인된 책 목록 안에 있음은 서버가 이미 검증했다 (FR-009) */
  recommendation: Recommendation;
  /** "이거 읽을래요" — 이벤트 전송은 위에서 한다 (North Star 분자) */
  onAccept?: (bookId: string, position: 1 | 2 | 3) => void;
  /** 이미 고른 책인가. 선택은 시각적으로 반영된다 (US-003 AC) */
  accepted?: boolean;
}

export function RecommendationCard({
  book,
  recommendation,
  onAccept,
  accepted = false,
}: RecommendationCardProps) {
  // 알라딘에 값이 없으면 없는 대로 둔다. null을 0으로 표시하는 것도 지어내는 것이다.
  const hasMeta = book.pages !== null || book.aladinRating !== null;

  return (
    <article className="space-y-3 rounded-lg border border-accent/30 bg-card p-5">
      <p className="text-xs text-subtle">추천 {recommendation.position}</p>

      <div className="flex gap-3">
        <BookCover coverUrl={book.coverUrl} title={book.title} />

        <div className="min-w-0 flex-1 space-y-1">
          <h3
            title={book.title}
            className="line-clamp-2 text-base font-medium leading-snug text-ink"
          >
            {book.title}
          </h3>
          <p title={book.author} className="line-clamp-1 text-sm text-body">
            {book.author}
          </p>
          <p title={book.publisher} className="line-clamp-1 text-sm text-body">
            {book.publisher}
          </p>

          {hasMeta && (
            <div data-testid="book-meta" className="flex items-center gap-2">
              {book.pages !== null && (
                <span className="text-xs text-subtle">{book.pages}쪽</span>
              )}
              {book.aladinRating !== null && (
                <Badge kind="rating" rating={book.aladinRating} />
              )}
            </div>
          )}

          {/* 알라딘 사실이므로 추천 이유 블록 밖에 둔다 (FR-013, ADR-002) */}
          <AladinLink href={book.aladinLink} title={book.title} />
        </div>
      </div>

      {/* Claude가 쓴 문장이 사실과 섞이지 않는 유일한 형태 (ADR-002) */}
      <ClaudeText label="추천 이유" text={recommendation.reason} />

      <button
        type="button"
        aria-pressed={accepted}
        disabled={accepted}
        onClick={() => onAccept?.(recommendation.bookId, recommendation.position)}
        className={
          accepted
            ? "min-h-11 w-full rounded-md border border-accent bg-muted-surface px-5 py-3 text-accent"
            : "min-h-11 w-full rounded-md bg-accent px-5 py-3 text-white hover:bg-accent-strong"
        }
      >
        {accepted ? "읽을 책으로 골랐어요" : "이거 읽을래요"}
      </button>
    </article>
  );
}
