"use client";

/**
 * 추천 결과 화면 (US-003, FR-006·FR-010, UI_GUIDE 안내 문구).
 *
 * ## 사실이 없는 카드는 그리지 않는다
 * 추천은 확인된 책 목록 안에서만 나오고(FR-009), 서버가 그것을 검증한 뒤에 응답한다.
 * 그럼에도 이 화면은 `bookId`를 목록에서 **찾아서** 그린다 — 못 찾으면 그 카드를
 * 버린다. 서지 사실 없이 카드를 세우려면 어딘가에서 지어내야 하고, 이 제품에서
 * 가장 심각한 결함이 정확히 그것이기 때문이다 (ADR-002).
 *
 * ## 수락은 한 번만 센다
 * `recommend_accepted`는 North Star의 분자다. 같은 책을 두 번 눌렀다고 두 번 세면
 * 지표가 조용히 부풀고, 지표를 추세로 읽는 이 프로젝트에서는 그 오염을 나중에
 * 되돌릴 방법이 없다. 그래서 고른 책은 이 화면이 기억하고 콜백을 다시 부르지 않는다.
 *
 * ## 저장하지 않는다
 * 고른 책도 재추천 횟수도 `localStorage`에 남기지 않는다. 새로고침 시 소실은 무상태
 * 설계의 의도된 결과다 (ADR-003).
 *
 * ## 이미지도 여기서 만들지 않는다
 * "이미지로 저장"(FR-014)은 누가 눌렀다는 사실만 콜백으로 올린다. 캔버스·`Blob`·
 * `<a download>`는 브라우저 API를 만지는 부수 효과이고, 표현 층이 그것을 직접 하면
 * 이 화면의 테스트가 매번 그 API를 흉내 내야 한다 (ARCHITECTURE 레이어 규칙).
 */
import { useState } from "react";
import { Notice } from "@/components/common/Notice";
import type { Recommendation } from "@/types/api";
import type { AladinFacts } from "@/types/book";
import { RecommendationCard } from "./RecommendationCard";

export interface RecommendationListProps {
  recommendations: readonly Recommendation[];
  /** 확인된 책 목록. 추천의 서지 사실은 전부 여기서 온다 */
  books: readonly AladinFacts[];
  /** 확인된 책이 3권 미만이라 추천 수가 부족한가 (FR-006) */
  shortfall: boolean;
  /** 재추천 상한(FR-010)이 남았는가. 판정은 `lib/session.ts`의 셀렉터가 한다 */
  canRecommendAgain: boolean;
  /**
   * 저장 이미지를 만드는 중인가 (FR-014).
   *
   * 이 화면은 이미지를 만들지 않는다 — 캔버스·`Blob`·다운로드는 브라우저 API를 만지는
   * 부수 효과라 페이지의 일이다 (ARCHITECTURE 레이어 규칙). 여기 오는 것은 그 진행을
   * **그리기 위한 값**뿐이다.
   */
  isSavingImage: boolean;
  /** 직전 저장이 실패했는가. 실패는 안내로만 알리고 화면 상태를 바꾸지 않는다 */
  saveImageFailed: boolean;
  onAccept: (bookId: string, position: 1 | 2 | 3) => void;
  onRecommendAgain: () => void;
  onSaveImage: () => void;
}

export function RecommendationList({
  recommendations,
  books,
  shortfall,
  canRecommendAgain,
  isSavingImage,
  saveImageFailed,
  onAccept,
  onRecommendAgain,
  onSaveImage,
}: RecommendationListProps) {
  // 추천 묶음이 바뀌면 수락 표시를 비운다. 이 화면은 "다시 추천받기" 사이에 언마운트되지만,
  // 그 전제를 화면 밖(페이지의 렌더 구조)에 두면 한 번의 배선 변경으로 조용히 깨진다 —
  // 그때 잃는 것은 표시가 아니라 **수락 이벤트 하나**이고, 그것이 North Star의 분자다.
  const signature = recommendations.map((item) => item.bookId).join(",");
  const [accepted, setAccepted] = useState<{ signature: string; ids: readonly string[] }>({
    signature,
    ids: [],
  });
  const acceptedIds = accepted.signature === signature ? accepted.ids : [];

  const byIsbn = new Map(books.map((book) => [book.isbn13, book]));
  const rows = recommendations
    .map((recommendation) => ({
      recommendation,
      book: byIsbn.get(recommendation.bookId),
    }))
    .filter((row): row is { recommendation: Recommendation; book: AladinFacts } =>
      row.book !== undefined,
    );

  function handleAccept(bookId: string, position: 1 | 2 | 3) {
    if (acceptedIds.includes(bookId)) return;

    setAccepted({ signature, ids: [...acceptedIds, bookId] });
    onAccept(bookId, position);
  }

  return (
    <div className="mx-auto w-full max-w-md space-y-6 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-ink">이 책은 어때요?</h1>
        <p className="text-sm text-body">책장에 있는 책 중에서 골랐어요</p>
      </header>

      {rows.length === 0 ? (
        // 서버 검증(FR-009)을 통과했는데도 여기 오면 우리 쪽 조립 결함이다.
        // 빈 화면으로 두면 사용자는 아무 설명 없이 막힌다.
        <Notice>추천한 책을 목록에서 찾지 못했어요</Notice>
      ) : (
        <ul className="space-y-3">
          {rows.map(({ recommendation, book }) => (
            <li key={recommendation.bookId}>
              <RecommendationCard
                book={book}
                recommendation={recommendation}
                accepted={acceptedIds.includes(recommendation.bookId)}
                onAccept={handleAccept}
              />
            </li>
          ))}
        </ul>
      )}

      {/* UI_GUIDE 안내 문구 표의 문장을 그대로 쓴다 */}
      {shortfall && (
        <Notice>
          확인된 책이 {books.length}권뿐이에요. 책장을 더 찍으면 더 잘 고를 수 있어요
        </Notice>
      )}

      <div className="sticky bottom-0 space-y-2 border-t border-line bg-page pt-3 pb-4">
        <button
          type="button"
          onClick={() => {
            if (!canRecommendAgain) return;
            onRecommendAgain();
          }}
          disabled={!canRecommendAgain}
          className="min-h-11 w-full rounded-md border border-line bg-card px-5 py-3 text-ink hover:bg-muted-surface disabled:bg-muted-surface disabled:text-disabled"
        >
          다시 추천받기
        </button>
        {/* 소진된 버튼을 숨기지 않는다 — 사라진 버튼은 왜 못 누르는지 말해 주지 않는다 */}
        {!canRecommendAgain && <Notice>기분을 바꿔 적어 보세요</Notice>}

        {/*
          그릴 카드가 없으면 저장 버튼도 없다. 사실 없이 만든 그림은 밖으로 나가서
          사실처럼 유통된다 (ADR-002) — 그릴 것이 없을 때는 그리지 않는 것이 맞다.
        */}
        {rows.length > 0 && (
          <button
            type="button"
            onClick={() => {
              if (isSavingImage) return;
              onSaveImage();
            }}
            disabled={isSavingImage}
            aria-busy={isSavingImage}
            className="min-h-11 w-full rounded-md border border-line bg-card px-5 py-3 text-ink hover:bg-muted-surface disabled:bg-muted-surface disabled:text-disabled"
          >
            이미지로 저장
          </button>
        )}

        {/*
          진행과 실패를 눈으로만 알리지 않는다 (TRD 6.6). 영역을 항상 세워 두어야
          내용이 바뀔 때 보조기술이 읽는다. 실패에도 `role="alert"`를 쓰지 않는다 —
          저장 실패는 화면을 바꾸지 않는 안내다 (UI_GUIDE 안내 문구).
        */}
        <div role="status" aria-live="polite">
          {isSavingImage && <Notice>이미지를 만들고 있어요</Notice>}
          {!isSavingImage && saveImageFailed && (
            <Notice>이미지를 만들지 못했어요. 다시 시도해 주세요</Notice>
          )}
        </div>
      </div>
    </div>
  );
}
