/**
 * 촬영 가이드 시트 (FR-015, PRD 8번 "책등 판독 정확도가 조명·각도에 크게 좌우됨").
 *
 * ## 오버레이가 아니다
 * 촬영은 `PhotoPicker`의 `<input type="file" capture="environment">`가 **시스템 카메라
 * 앱**을 여는 구조다. 우리 페이지는 그 프리뷰 위에 아무것도 그릴 수 없으므로, 요령은
 * 촬영 **전**에 읽는 글로만 전달된다. PRD가 한때 "오버레이"라고 적었던 것을 시트로
 * 정정한 이유가 이것이다.
 *
 * ## 모달이 아니다
 * 화면을 덮으면 촬영 버튼과 가이드를 동시에 볼 수 없어 "보면서 찍는다"는 목적이
 * 사라진다 (UI_GUIDE 촬영 가이드 시트).
 *
 * ## 왜 details/summary 인가
 * 펼침·접힘, 키보드 포커스, 스크린리더의 확장 상태 안내가 브라우저 기본으로 따라온다.
 * 직접 만든 토글은 그 셋을 전부 다시 구현해야 하고, 이 리포는 접근성을 요구사항으로
 * 다룬다 (TRD 6.6).
 *
 * ## 상태도, 이벤트도 없다
 * 펼침 여부는 DOM이 갖는 화면의 지역 사실이라 세션 상태가 아니고, 펼쳤다는 사실은
 * 어느 지표에도 연결되지 않으므로 이벤트를 만들지 않는다 (PRD 7번).
 */
import { MAX_PHOTOS } from "@/lib/env";

/**
 * 촬영 요령. 판정 방식(FR-003 — 제목과 저자를 함께 읽는다)과 판독을 흔드는 조건
 * (조명·각도·초점)이 항목의 근거다.
 *
 * **지킬 수 없는 약속은 쓰지 않는다.** 인식률은 이 제품의 목표 지표이지 보장이 아니라서,
 * "이렇게 찍으면 다 읽힌다"는 문장은 그 자체가 사실이 아니다 — 대신 못 읽었을 때
 * 사용자가 할 수 있는 일(US-002 직접 수정)을 마지막에 알린다.
 */
const TIPS: readonly string[] = [
  "책등이 정면으로 보이게 서서 찍어 주세요. 비스듬히 찍으면 글자가 겹쳐 보여요",
  `책장 전체를 한 장에 담기보다 한 칸씩 나눠 찍어 주세요. 한 번에 ${MAX_PHOTOS}장을 함께 분석해요`,
  "밝은 곳에서 찍고, 조명 반사나 그림자가 책등을 덮지 않게 해 주세요",
  "제목과 저자가 함께 보이면 좋아요. 같은 제목의 다른 판본을 저자로 가려내거든요",
  "초점이 맞은 뒤에 찍어 주세요. 흔들린 글자는 읽어내기 어려워요",
  "그래도 못 읽어낸 책은 결과 화면에서 제목을 직접 고쳐 다시 찾을 수 있어요",
];

export function CaptureGuide() {
  return (
    <details className="space-y-2">
      {/* Text 버튼 스타일 (UI_GUIDE 버튼). 목록 표식은 지운다 — 장식이 아니라 문구로 알린다 */}
      <summary className="min-h-11 cursor-pointer list-none text-sm text-subtle underline underline-offset-2 hover:text-ink [&::-webkit-details-marker]:hidden">
        어떻게 찍으면 잘 읽히나요?
      </summary>

      <ul className="space-y-2 rounded-md bg-muted-surface p-4 text-sm text-body">
        {TIPS.map((tip) => (
          <li key={tip}>{tip}</li>
        ))}
      </ul>
    </details>
  );
}
