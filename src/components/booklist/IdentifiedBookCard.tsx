/**
 * 확인된 책 카드 (UI_GUIDE "카드", 타이포그래피).
 *
 * 알라딘 대조를 통과한 책만 이 카드로 그린다 (ADR-002). 카드 안에서
 * 사실(제목·저자·출판사·쪽수·평점)과 해석(한줄평)은 절대 같은 층위로 놓지 않는다 —
 * 해석은 `ClaudeText` 블록으로만 나가고, 그 형태가 두 층을 가르는 유일한 장치다.
 *
 * 모서리 반경(rounded-md)은 미확인 카드(rounded-sm)와 다르다. 색뿐 아니라 형태로도
 * 구분해야 색을 구별하지 못하는 사용자에게도 두 목록이 다른 것으로 읽힌다.
 */
import { AladinLink } from "@/components/common/AladinLink";
import { Badge } from "@/components/common/Badge";
import { ClaudeText } from "@/components/common/ClaudeText";
import type { IdentifiedBook } from "@/types/book";
import { BookCover } from "./BookCover";

export interface IdentifiedBookCardProps {
  book: IdentifiedBook;
}

export function IdentifiedBookCard({ book }: IdentifiedBookCardProps) {
  // 알라딘에 값이 없으면 없는 대로 둔다. null을 0으로 표시하면 "쪽수 0쪽"이라는
  // 사실이 아닌 정보를 만들어 내는 것이고, 그것도 지어낸 값이다.
  const hasMeta = book.pages !== null || book.aladinRating !== null;

  return (
    <article className="flex gap-3 rounded-md border border-line bg-card p-4">
      <BookCover coverUrl={book.coverUrl} title={book.title} />

      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-1">
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

          {/* 알라딘이 준 URL 그대로. 사실 층이므로 ClaudeText 블록 밖이다 (FR-013) */}
          <AladinLink href={book.aladinLink} title={book.title} />
        </div>

        {/* 생성 실패 시 빈 문자열로 오며, 그때는 블록 자체가 그려지지 않는다 (TR-007) */}
        <ClaudeText label="AI 한줄평" text={book.claudeNote} />
      </div>
    </article>
  );
}
