"use client";

/**
 * 선택된 사진의 썸네일과 개별 제거 (US-001 화면 인벤토리).
 *
 * 미리보기는 **없을 수 있다.** `URL.createObjectURL`이 없는 환경이 있고, 그때 깨진
 * 이미지 아이콘을 노출하면 "이 화면은 관리되지 않는다"는 인상만 남는다. 표지 폴백과
 * 같은 규칙으로 첫 글자 블록으로 흡수한다 (UI_GUIDE 레이아웃).
 *
 * 판독 하한 경고(`tooSmall`)는 **차단이 아니라 표시**다. 파노라마를 거부하면 사용자는
 * 자기 책장을 올릴 방법이 없어지고, 아무 말 없이 보내면 전부 미확인으로 돌아온다.
 * 그래서 보내되 어느 사진이 문제인지 알려 준다 (TR-001).
 */
import { MAX_PHOTOS } from "@/lib/env";

export interface UploadPhoto {
  /** 파일 내용 해시. 중복 제거 키이자 목록 키다 */
  id: string;
  name: string;
  /** 미리보기 URL. 만들지 못했으면 null이며 폴백으로 그린다 */
  previewUrl: string | null;
  /** 리사이즈 후 짧은 변이 판독 하한을 밑도는가 (TR-001) */
  tooSmall: boolean;
}

export interface PhotoThumbnailsProps {
  photos: readonly UploadPhoto[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}

export function PhotoThumbnails({ photos, onRemove, disabled = false }: PhotoThumbnailsProps) {
  if (photos.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs text-subtle">
        {photos.length} / {MAX_PHOTOS}장
      </p>

      <ul className="flex flex-wrap gap-3">
        {photos.map((photo) => (
          <li key={photo.id} className="flex w-20 flex-col items-center gap-1">
            <Preview photo={photo} />

            {photo.tooSmall && (
              <span className="text-[11px] text-unverified">너무 길어요</span>
            )}

            <button
              type="button"
              aria-label={`${photo.name} 제거`}
              disabled={disabled}
              onClick={() => onRemove(photo.id)}
              className="min-h-11 w-full text-xs text-subtle underline underline-offset-2 hover:text-ink"
            >
              제거
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Preview({ photo }: { photo: UploadPhoto }) {
  const label = `${photo.name} 미리보기`;

  if (photo.previewUrl === null) {
    return (
      <span
        role="img"
        aria-label={label}
        className="flex h-20 w-20 items-center justify-center rounded-sm bg-muted-surface text-lg text-subtle"
      >
        {photo.name.trim().slice(0, 1)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- blob: URL은 next/image 로더 대상이 아니다
    <img
      src={photo.previewUrl}
      alt={label}
      className="h-20 w-20 rounded-sm object-cover"
    />
  );
}
