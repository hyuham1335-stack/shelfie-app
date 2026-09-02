/**
 * 정적 스켈레톤 블록 (UI_GUIDE 애니메이션 절).
 *
 * 펄스를 쓰지 않는다. 허용된 애니메이션은 fade-in 하나뿐이고 그것도 결과·추천 카드 등장에만 쓴다.
 * 크기는 호출부가 className으로 정한다 — 표지 자리(w-16)와 제목 줄은 크기가 다르다.
 */
export interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = "h-4 w-full" }: SkeletonProps) {
  // 진행 상태는 화면이 aria-live로 알린다(TRD 6.6). 블록 자체는 장식이므로 숨긴다.
  return (
    <div aria-hidden="true" className={`rounded-sm bg-muted-surface ${className}`} />
  );
}
