/**
 * 거부된 파일의 사유별 안내 (FR-001, PRD Q3).
 *
 * 사유 5종은 **서로 다른 문장**이다. 사용자가 할 수 있는 일이 사유마다 다르기 때문이고,
 * 한 문장으로 뭉개면 무엇을 고쳐야 하는지 알 수 없게 된다.
 *
 * 특히 `decode_failed`와 `unsupported_type`을 같은 문장으로 쓰지 않는다.
 * 앞의 것은 **브라우저가 열지 못한 것**(시스템 문제)이고 뒤의 것은 **우리가 받지 않는
 * 것**(정책 문제)이다. 둘을 뭉개는 것은 ADR-005가 `lookup_failed`와 `no_match`에 대해
 * 금지한 것과 같은 구조 — 시스템 문제를 데이터·정책 문제로 설명하는 오귀속이다.
 *
 * 에러가 아니라 안내이므로 색을 쓰지 않고 `Notice`로만 그린다 (UI_GUIDE 안내 문구).
 */
import { Notice } from "@/components/common/Notice";
import { MAX_PHOTOS } from "@/lib/env";
import type { RejectReason } from "@/lib/image";

/** 표시 순서. 파일 자체의 결함을 먼저 말하고 선택의 결함을 뒤에 둔다 */
const ORDER: readonly RejectReason[] = [
  "unsupported_type",
  "decode_failed",
  "too_large",
  "duplicate",
  "too_many",
];

const MESSAGE: Record<RejectReason, (count: number) => string> = {
  // 정책: 우리가 받지 않는 형식이다. 무엇으로 바꾸면 되는지 목록을 준다.
  unsupported_type: (n) => `JPG·PNG·WEBP만 올릴 수 있어요. 사진 ${n}장은 뺐어요`,
  // 시스템: 브라우저가 디코드하지 못했다. 형식 목록이 아니라 내보내기 경로를 안내한다.
  decode_failed: (n) =>
    `사진 ${n}장을 열지 못했어요. 사진 앱에서 JPG로 내보낸 뒤 다시 올려 주세요 (아이폰이면 카메라 포맷을 '높은 호환성'으로 바꾸면 됩니다)`,
  too_large: (n) => `10MB가 넘는 사진 ${n}장은 뺐어요. 다른 사진을 골라 주세요`,
  // 사용자가 할 일이 없다. 이미 골랐다는 사실만 알린다.
  duplicate: (n) => `같은 사진 ${n}장은 제외했어요`,
  too_many: (n) => `사진은 ${MAX_PHOTOS}장까지 올릴 수 있어요. ${n}장은 빼고 진행할게요`,
};

export interface RejectedNoticeProps {
  /** 거부된 파일의 사유. 같은 사유가 여러 번 들어올 수 있다 */
  reasons: readonly RejectReason[];
}

export function RejectedNotice({ reasons }: RejectedNoticeProps) {
  if (reasons.length === 0) return null;

  const counts = new Map<RejectReason, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);

  return (
    // 선택 직후에 나타나는 문장이므로 스크린 리더에도 알린다 (TRD 6.6).
    <div role="status" aria-live="polite" className="space-y-1">
      {ORDER.filter((reason) => counts.has(reason)).map((reason) => (
        <Notice key={reason}>{MESSAGE[reason](counts.get(reason) ?? 0)}</Notice>
      ))}
    </div>
  );
}
