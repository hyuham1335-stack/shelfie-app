"use client";

/**
 * 분석 결과 화면의 배치 (US-001·US-002, UI_GUIDE 레이아웃).
 *
 * 이 컴포넌트는 데이터를 가져오지 않는다. 세션이 들고 있는 값을 props로 받고, 사용자의
 * 행동은 전부 콜백으로 위로 넘긴다 — fetch와 상태 전이는 페이지의 몫이다
 * (/docs/ARCHITECTURE.md 상태 관리). 세션 모듈에서는 **타입만** 가져온다. 리듀서·액션
 * 같은 런타임 값을 여기서 import하면 화면이 상태 전이를 직접 하게 된다.
 *
 * 배치에 세 가지 원칙이 걸려 있다.
 * ① 부분 실패 배너는 목록 **위**에 둔다. 결과를 다 본 뒤에 실패를 알리면 사용자는
 *    이미 그 목록이 전부인 줄 안다.
 * ② 미확인은 접거나 다른 화면으로 보내지 않고 확인된 책과 같은 화면에 둔다.
 *    실패를 드러내는 화면이 감추는 화면보다 신뢰를 얻는다 (UI_GUIDE 원칙 3).
 * ③ **확인된 책은 한 목록이다.** 사진에서 판독된 책과 사용자가 재검색으로 찾아낸 책은
 *    둘 다 알라딘 대조와 `proof`를 통과했으므로 같은 자격이고(ADR-002·ADR-006),
 *    사용자의 책장은 하나다. 다만 **출처는 숨기지 않는다** — 재검색으로 확인한 책에는
 *    사진 출처도 Claude 한줄평도 없고, 없는 것을 있는 척 채우지 않는다.
 */
import { AladinLink } from "@/components/common/AladinLink";
import { Badge } from "@/components/common/Badge";
import { Notice } from "@/components/common/Notice";
import { MAX_IDENTIFIED_BOOKS } from "@/lib/env";
import type { ShelfBook } from "@/lib/session";
import type { AladinCandidate, ResolvedCandidate, UnidentifiedBook } from "@/types/book";
import { BookCover } from "./BookCover";
import { IdentifiedBookCard } from "./IdentifiedBookCard";
import { UnidentifiedBookCard } from "./UnidentifiedBookCard";

export interface BookListProps {
  /** 확인된 책. 사진에서 온 책과 재검색으로 합류한 책이 **한 목록**에 함께 온다 */
  books: readonly ShelfBook[];
  unidentified: readonly UnidentifiedBook[];
  /** 50권 상한으로 잘려나간 **사진에서 온 책**의 권수 (FR-005) */
  overflowCount: number;
  unidentifiedOverflowCount: number;
  failedPhotoCount: number;
  /** 실패한 사진의 0-based 인덱스 */
  failedPhotoIndexes: readonly number[];
  /** 업로드한 사진 장수. 부분 실패 배너의 분모라 분석 응답만으로는 알 수 없다 */
  photoCount: number;
  onResolve?: (book: UnidentifiedBook) => void;
  onSelectCandidate?: (book: UnidentifiedBook, candidate: AladinCandidate) => void;
  /** `lookup_failed` 한 권의 재조회. 사진 전체 재분석이 아니다 (ADR-005) */
  onRetryLookup?: (book: UnidentifiedBook) => void;
  /** 실패한 사진만 골라 다시 시도한다 (`failedPhotoIndexes`를 그대로 넘긴다) */
  onRetryPhoto?: (photoIndexes: number[]) => void;
  /**
   * 재시도 간격을 기다리는 중이라 지금은 누를 수 없다 (FR-010).
   * 감추지 않고 비활성으로 남긴다 — 이 경로도 결국 분석을 다시 태우므로
   * 에러 화면의 "다시 시도"와 같은 간격을 따른다.
   */
  retryPhotoDisabled?: boolean;
}

export function BookList({
  books,
  unidentified,
  overflowCount,
  unidentifiedOverflowCount,
  failedPhotoCount,
  failedPhotoIndexes,
  photoCount,
  onResolve,
  onSelectCandidate,
  onRetryLookup,
  onRetryPhoto,
  retryPhotoDisabled = false,
}: BookListProps) {
  // 후보는 있었으나 확인 0건인 상태. 빈 상태로 보내지 않고 미확인 목록을 그대로 남긴다
  // (API_SPEC: EMPTY_SHELF가 아니라 unidentifiedOnly 분기).
  const booksAreEmpty = books.length === 0;

  return (
    <div className="space-y-8">
      {failedPhotoCount > 0 && (
        <div className="space-y-2 rounded-md border border-line bg-muted-surface px-4 py-3 text-sm text-body">
          {/* 분모를 함께 밝힌다 — "1장 실패"만으로는 몇 장 중 하나인지 알 수 없다 */}
          <p>
            사진 {photoCount}장 중 {failedPhotoCount}장은 읽지 못했어요
          </p>
          {onRetryPhoto !== undefined && (
            <button
              type="button"
              onClick={() => onRetryPhoto([...failedPhotoIndexes])}
              disabled={retryPhotoDisabled}
              className="min-h-11 text-sm text-subtle underline underline-offset-2 hover:text-ink disabled:text-disabled disabled:no-underline disabled:hover:text-disabled"
            >
              이 사진만 다시 시도
            </button>
          )}
        </div>
      )}

      {booksAreEmpty ? (
        <div data-testid="empty-identified" className="space-y-2 py-6 text-center">
          <Notice>읽어낸 책을 알라딘에서 확인하지 못했어요</Notice>
        </div>
      ) : (
        <section className="space-y-3">
          {/* 권수는 두 출처의 합계다. 사용자의 책장은 하나이므로 목록도 하나다 */}
          <h2 className="text-base font-semibold text-ink">확인된 책 {books.length}권</h2>
          <ul className="space-y-3">
            {books.map((entry) => (
              <li key={entry.book.isbn13}>
                {entry.origin === "photo" ? (
                  <IdentifiedBookCard book={entry.book} />
                ) : (
                  <ResolvedBookCard book={entry.book} />
                )}
              </li>
            ))}
          </ul>
          {/* 잘림은 **사진에서 온 책**의 상한이다. 재검색으로 합류한 책과 무관하다 */}
          {overflowCount > 0 && (
            <Notice>
              {MAX_IDENTIFIED_BOOKS}권까지만 보여드려요 ({overflowCount}권 더 있음)
            </Notice>
          )}
        </section>
      )}

      {unidentified.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-ink">
            미확인 {unidentified.length}권
          </h2>
          <ul className="space-y-3">
            {unidentified.map((book, index) => (
              // rawText는 중복될 수 있고(같은 책이 두 장에 걸쳐 잘려 읽힘) 다른 식별자가
              // 없으므로 인덱스를 키로 쓴다. 이 목록은 재정렬되지 않는다.
              <li key={`${book.reason}-${index}`}>
                <UnidentifiedBookCard
                  book={book}
                  onResolve={onResolve}
                  onSelectCandidate={onSelectCandidate}
                  onRetryLookup={onRetryLookup}
                />
              </li>
            ))}
          </ul>
          {/* 잘려 나간 미확인을 말하지 않으면, 숨기는 대상이 하필 **우리가 실패한
              쪽**이 된다 — "못 한 일을 숨기지 않는다"를 정면으로 어긴다 (UI_GUIDE). */}
          {unidentifiedOverflowCount > 0 && (
            <Notice>
              못 읽어낸 책 {unidentifiedOverflowCount}권은 목록에서 생략했어요
            </Notice>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * 재검색으로 합류한 책 카드 (US-002).
 *
 * 사진에서 온 책과 같은 목록에 서지만 **같은 정보를 가진 척하지 않는다.**
 * - Claude 한줄평이 **없다.** 빈 문자열을 만들어 `ClaudeText`에 넘기지 않는다 —
 *   없는 해석을 있는 것처럼 만드는 것이고, 그것이 ADR-002가 막으려는 것이다.
 * - `photoIndex`가 **없다.** 사진이 아니라 재검색에서 왔기 때문이고, 0으로 지어내면
 *   출처를 위조하는 것이다 (ARCHITECTURE 상태 관리).
 *
 * 출처 라벨은 중립색(`text-subtle`)이다. 사용자가 직접 확인한 책은 문제가 아니므로
 * 주의를 요구하는 색을 쓰지 않는다 (UI_GUIDE 색상).
 */
function ResolvedBookCard({ book }: { book: ResolvedCandidate }) {
  const hasMeta = book.pages !== null || book.aladinRating !== null;

  return (
    <article className="flex gap-3 rounded-md border border-line bg-card p-4">
      <BookCover coverUrl={book.coverUrl} title={book.title} />

      <div className="min-w-0 flex-1 space-y-1">
        <span
          data-testid="resolved-origin"
          className="inline-block rounded-sm bg-muted-surface px-2 py-0.5 text-xs text-subtle"
        >
          직접 확인
        </span>
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
            {book.pages !== null && <span className="text-xs text-subtle">{book.pages}쪽</span>}
            {book.aladinRating !== null && <Badge kind="rating" rating={book.aladinRating} />}
          </div>
        )}

        {/* 나란히 선 카드가 한쪽만 링크를 가지면 사용자는 그것을 "이 책은 알라딘에
            없다"로 읽는다. 같은 목록에 서는 두 출처는 같은 표현을 갖는다 (FR-013) */}
        <AladinLink href={book.aladinLink} title={book.title} />
      </div>
    </article>
  );
}
