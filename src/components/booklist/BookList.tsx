"use client";

/**
 * 분석 결과 화면의 배치 (US-001·US-002, UI_GUIDE 레이아웃).
 *
 * 이 컴포넌트는 데이터를 가져오지 않는다. `/api/analyze` 응답을 props로 받고, 사용자의
 * 행동은 전부 콜백으로 위로 넘긴다 — fetch와 상태 전이는 페이지의 몫이다
 * (/docs/ARCHITECTURE.md 상태 관리).
 *
 * 배치에 두 가지 원칙이 걸려 있다.
 * ① 부분 실패 배너는 목록 **위**에 둔다. 결과를 다 본 뒤에 실패를 알리면 사용자는
 *    이미 그 목록이 전부인 줄 안다.
 * ② 미확인은 접거나 다른 화면으로 보내지 않고 확인된 책과 같은 화면에 둔다.
 *    실패를 드러내는 화면이 감추는 화면보다 신뢰를 얻는다 (UI_GUIDE 원칙 3).
 */
import { Notice } from "@/components/common/Notice";
import type { AnalyzeResponse } from "@/types/api";
import type { AladinCandidate, UnidentifiedBook } from "@/types/book";
import { IdentifiedBookCard } from "./IdentifiedBookCard";
import { UnidentifiedBookCard } from "./UnidentifiedBookCard";

export interface BookListProps {
  /** `/api/analyze` 응답 전체 */
  result: AnalyzeResponse;
  /** 업로드한 사진 장수. 부분 실패 배너의 분모라 응답만으로는 알 수 없다 */
  photoCount: number;
  onResolve?: (book: UnidentifiedBook) => void;
  onSelectCandidate?: (book: UnidentifiedBook, candidate: AladinCandidate) => void;
  onRetryLookup?: () => void;
  /** 실패한 사진만 골라 다시 시도한다 (`failedPhotoIndexes`를 그대로 넘긴다) */
  onRetryPhoto?: (photoIndexes: number[]) => void;
}

export function BookList({
  result,
  photoCount,
  onResolve,
  onSelectCandidate,
  onRetryLookup,
  onRetryPhoto,
}: BookListProps) {
  const {
    identified,
    unidentified,
    overflowCount,
    failedPhotoCount,
    failedPhotoIndexes,
  } = result;

  // 후보는 있었으나 확인 0건인 상태. 빈 상태로 보내지 않고 미확인 목록을 그대로 남긴다
  // (API_SPEC: EMPTY_SHELF가 아니라 unidentifiedOnly 분기).
  const identifiedIsEmpty = identified.length === 0;

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
              onClick={() => onRetryPhoto(failedPhotoIndexes)}
              className="min-h-11 text-sm text-subtle underline underline-offset-2 hover:text-ink"
            >
              이 사진만 다시 시도
            </button>
          )}
        </div>
      )}

      {identifiedIsEmpty ? (
        <div data-testid="empty-identified" className="space-y-2 py-6 text-center">
          <Notice>읽어낸 책을 알라딘에서 확인하지 못했어요</Notice>
        </div>
      ) : (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-ink">
            확인된 책 {identified.length}권
          </h2>
          <ul className="space-y-3">
            {identified.map((book) => (
              <li key={book.isbn13}>
                <IdentifiedBookCard book={book} />
              </li>
            ))}
          </ul>
          {overflowCount > 0 && (
            <Notice>50권까지만 보여드려요 ({overflowCount}권 더 있음)</Notice>
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
        </section>
      )}
    </div>
  );
}
