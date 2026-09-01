/**
 * 배지 — 미확인 사유용과 평점용 (UI_GUIDE "배지", "미확인 사유 문구").
 *
 * 두 가지 규칙이 이 파일의 존재 이유다.
 * ① 미확인은 색상만으로 구분하지 않는다. 배지에 텍스트를 항상 함께 담는다(색각 접근성).
 * ② `lookup_failed`는 앰버가 아니라 중립색이다 — 사용자 책장의 문제가 아니라 우리 쪽
 *    조회 실패이므로, 주의를 요구하는 색으로 표시하면 시스템 문제를 데이터 문제로
 *    설명하는 것이 된다 (ADR-005).
 */
import type { UnidentifiedReason } from "@/types/book";

/** 사유 4종의 배지 문구. 서로 겹치지 않는 문장을 쓴다 (UI_GUIDE 미확인 사유 문구 표) */
const REASON_LABEL: Record<UnidentifiedReason, string> = {
  unreadable: "못 읽음",
  no_match: "검색 결과 없음",
  ambiguous: "후보 여럿",
  lookup_failed: "확인 못 함",
};

const REASON_TONE: Record<UnidentifiedReason, string> = {
  unreadable: "bg-unverified/10 text-unverified",
  no_match: "bg-unverified/10 text-unverified",
  ambiguous: "bg-unverified/10 text-unverified",
  // 우리 쪽 문제라 주의색을 쓰지 않는다 (ADR-005)
  lookup_failed: "bg-muted-surface text-subtle",
};

export type BadgeProps =
  | { kind: "reason"; reason: UnidentifiedReason }
  | { kind: "rating"; rating: number };

export function Badge(props: BadgeProps) {
  if (props.kind === "rating") {
    // 별 아이콘 없이 출처를 문자로 드러낸다 — 알라딘 독자평점이지 우리 점수가 아니다.
    return (
      <span className="text-xs text-subtle">
        독자 {props.rating.toFixed(1)}
      </span>
    );
  }

  return (
    <span
      className={`rounded-sm px-2 py-0.5 text-xs ${REASON_TONE[props.reason]}`}
    >
      {REASON_LABEL[props.reason]}
    </span>
  );
}
