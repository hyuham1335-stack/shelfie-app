"use client";

/**
 * 촬영·선택 진입점 (US-001, FR-001).
 *
 * 이 컴포넌트는 파일을 검증하지 않는다. 고른 것을 그대로 위로 넘기고, 판정은
 * `lib/image.ts`의 `validateSelection`이 한 곳에서 한다 — 화면이 한 번 더 거르면
 * 두 판정이 갈라지고, 갈라졌을 때 사용자가 보는 문장은 언제나 화면 쪽이다.
 *
 * ## 촬영과 선택을 별도 입력으로 둔다
 * 카메라 권한이 거부돼도 파일 선택 경로는 그대로 남아야 한다 (PRD 5번 "권한 없음").
 * 하나의 입력에 `capture`를 붙였다 뗐다 하면 그 폴백이 상태에 묶이는데, 권한 거부는
 * 우리가 관측할 수 없는 사건이라 상태로 다룰 수 없다. 두 경로를 항상 함께 두는 편이 싸다.
 *
 * ## 왜 label로 감싸는가
 * 파일 입력을 감추고 버튼으로 `click()`을 대신 부르면 키보드 포커스가 사라진다.
 * `sr-only` 입력을 label로 감싸면 시각적으로는 버튼이면서 포커스·라벨 연결이 유지된다
 * (TRD 6.6 접근성: 키보드만으로 모든 인터랙션에 도달 가능해야 한다).
 */
import type { ChangeEvent } from "react";
import { SUPPORTED_MIME_TYPES } from "@/lib/image";

/** 허용 MIME는 lib이 단일 출처다. 여기서 목록을 다시 적지 않는다 (HEIC는 PRD Q3에서 배제) */
const ACCEPT = SUPPORTED_MIME_TYPES.join(",");

const PRIMARY_BUTTON =
  "flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-md bg-accent px-5 py-3 text-sm text-white hover:bg-accent-strong";

const SECONDARY_BUTTON =
  "flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-md border border-line bg-card px-5 py-3 text-sm text-ink hover:bg-muted-surface";

export interface PhotoPickerProps {
  /** 고른 파일을 검증 없이 그대로 넘긴다 */
  onSelect: (files: File[]) => void;
  disabled?: boolean;
}

export function PhotoPicker({ onSelect, disabled = false }: PhotoPickerProps) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);

    // 값을 비우지 않으면 같은 파일을 다시 골랐을 때 change가 발생하지 않는다.
    // 재시도가 재선택을 요구하는 화면이 되면 안 된다.
    event.target.value = "";

    if (files.length > 0) onSelect(files);
  }

  return (
    <div className="flex gap-2">
      <label className={disabled ? `${PRIMARY_BUTTON} opacity-60` : PRIMARY_BUTTON}>
        <input
          type="file"
          accept={ACCEPT}
          capture="environment"
          disabled={disabled}
          onChange={handleChange}
          className="sr-only"
        />
        책장 촬영
      </label>

      <label className={disabled ? `${SECONDARY_BUTTON} opacity-60` : SECONDARY_BUTTON}>
        <input
          type="file"
          accept={ACCEPT}
          multiple
          disabled={disabled}
          onChange={handleChange}
          className="sr-only"
        />
        사진 선택
      </label>
    </div>
  );
}
