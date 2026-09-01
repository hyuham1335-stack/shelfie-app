"use client";

/**
 * 표지 이미지와 그 폴백 (UI_GUIDE 레이아웃).
 *
 * 표지가 없을 때와 URL이 있어도 로드에 실패했을 때(404·네트워크)를 같은 폴백으로 흡수한다.
 * 깨진 이미지 아이콘은 "이 화면은 관리되지 않는다"는 신호이고, 사실 정보를 보여주는
 * 화면에서 그 인상은 목록 전체의 신뢰를 깎는다.
 *
 * `next/image`를 쓰지 않는 이유: 표지는 폭이 고정(w-16)이라 최적화 이득이 작은 반면,
 * 로더가 원격 도메인 설정에 묶여 있어 폴백을 우리가 원하는 시점에 잡기 어렵다.
 */
import { useState } from "react";

export interface BookCoverProps {
  /** 알라딘 표지 절대 URL. 없을 수 있다 */
  coverUrl: string | null;
  /** 폴백 글자와 `alt` 문구의 출처 */
  title: string;
  /** 크기 조정용. 기본은 UI_GUIDE의 w-16 */
  className?: string;
}

export function BookCover({ coverUrl, title, className = "w-16" }: BookCoverProps) {
  const [loadFailed, setLoadFailed] = useState(false);

  // 표지는 장식이 아니라 정보다. 빈 alt를 쓰지 않는다 (TRD 6.6 접근성).
  const label = `${title} 표지`;

  if (coverUrl === null || coverUrl === "" || loadFailed) {
    return (
      <span
        role="img"
        aria-label={label}
        className={`flex h-24 shrink-0 items-center justify-center rounded-sm bg-muted-surface text-lg text-subtle ${className}`}
      >
        {title.trim().slice(0, 1)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- 위 주석 참조: 폴백 제어를 위해 img를 직접 쓴다
    <img
      src={coverUrl}
      alt={label}
      onError={() => setLoadFailed(true)}
      className={`h-24 shrink-0 object-contain ${className}`}
    />
  );
}
