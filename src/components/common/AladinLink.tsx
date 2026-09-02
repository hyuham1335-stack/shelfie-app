/**
 * 알라딘 상품 페이지로 나가는 링크 (FR-013, UI_GUIDE "외부 링크").
 *
 * ## URL 을 만들지 않는다
 * `href` 로 받는 값은 알라딘이 응답에 실어 준 `aladinLink` 그대로여야 한다.
 * ISBN 으로 조립한 URL 은 형태가 같아 보여도 **우리가 만든 사실**이고, 우리가 만든
 * 것을 알라딘 사실처럼 보여 주는 것이 이 프로젝트에서 가장 심각한 결함이다 (ADR-002).
 * 그래서 이 컴포넌트는 URL 을 조합할 재료(ISBN)를 아예 받지 않는다.
 *
 * ## 사실 층에 속한다
 * 링크는 알라딘에서 온 사실이므로 `ClaudeText` 블록 안에 두지 않는다. 그 블록은
 * Claude 가 쓴 문장의 자리이고, 한 블록에 섞이면 사실·해석 구분이 시각적으로 무너진다.
 *
 * ## 아이콘을 만들지 않는다
 * UI_GUIDE 가 아이콘을 카메라·재시도·닫기·체크 4종으로 제한한다. 외부로 나간다는 것은
 * 문구로 알린다.
 *
 * ## 접근성
 * 같은 문구("알라딘에서 보기")가 목록의 카드마다 반복되므로, 보이는 문구만으로는
 * 스크린리더 사용자가 링크들을 구분할 수 없다. 접근성 이름에 책 제목과 "새 창"을
 * 함께 담아 어느 책의 링크이고 어디서 열리는지 알 수 있게 한다 (TRD 6.6).
 */

export interface AladinLinkProps {
  /** 알라딘이 준 `aladinLink` 원본. 조립한 URL 을 넘기지 마라 */
  href: string;
  /** 접근성 이름에서 링크를 구별하는 책 제목 (화면에는 보이지 않는다) */
  title: string;
}

export function AladinLink({ href, title }: AladinLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${title} — 알라딘에서 보기 (새 창)`}
      className="inline-flex min-h-11 items-center text-sm text-subtle underline underline-offset-2 hover:text-ink"
    >
      알라딘에서 보기
    </a>
  );
}
