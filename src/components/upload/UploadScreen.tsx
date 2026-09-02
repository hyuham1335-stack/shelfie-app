"use client";

/**
 * 업로드 화면 (US-001, FR-001·FR-002, TR-001).
 *
 * 첫 행동까지의 마찰이 이 제품의 전환율을 정한다. 그래서 이 화면이 하는 일은 두 가지뿐이다 —
 * **고르게 하고, 왜 안 되는지 정확히 말한다.**
 *
 * ## 판정은 여기서 하지 않는다
 * 장수·크기·형식·중복은 `validateSelection`, 판독 하한은 `isTooSmallAfterResize`,
 * 전송 예산은 `checkOutputBudget`이 정한다. 화면은 그 결과를 문장으로 옮길 뿐이다.
 * 두 벌로 두면 반드시 갈라지고, 갈라졌을 때 사용자가 보는 쪽은 언제나 화면이다.
 *
 * ## 네트워크가 없다
 * `fetch`도 `lib/api-client.ts`도 부르지 않는다. 리사이즈까지 마친 data URI를
 * `onAnalyze`로 넘기고 끝낸다 — 요청과 상태 전이는 페이지의 몫이다
 * (/docs/ARCHITECTURE.md 상태 관리).
 *
 * ## `photoCount`가 여기서 나온다
 * `/api/analyze` 응답에는 보낸 장수가 없다. 그런데 부분 실패 배너("사진 3장 중 1장은
 * 읽지 못했어요")의 **분모**가 바로 그 값이라, 보낸 쪽이 기억해 두지 않으면 화면이
 * 실패를 분모 없이 말하게 된다 (UI_GUIDE 부분 실패 배너).
 */
import { useEffect, useRef, useState } from "react";
import { Notice } from "@/components/common/Notice";
import { Skeleton } from "@/components/common/Skeleton";
import {
  checkOutputBudget,
  hashBytes,
  isTooSmallAfterResize,
  resizeToDataUri,
  validateSelection,
} from "@/lib/image";
import type { RejectReason, SelectedFileMeta } from "@/lib/image";
import { PhotoPicker } from "./PhotoPicker";
import { PhotoThumbnails } from "./PhotoThumbnails";
import type { UploadPhoto } from "./PhotoThumbnails";
import { RejectedNotice } from "./RejectedNotice";

interface SelectedPhoto extends UploadPhoto {
  file: File;
  meta: SelectedFileMeta;
}

/** `validateSelection`에 넘길 항목. 이미 고른 사진과 새로 고른 파일을 같은 줄에 세운다 */
type Entry = SelectedFileMeta &
  ({ kind: "existing"; photo: SelectedPhoto } | { kind: "new"; file: File });

export interface UploadScreenProps {
  /**
   * 리사이즈까지 마친 data URI와 **실제로 보내는 장수**를 넘긴다.
   * `photoCount`는 `dataUris.length`와 같지만, 뒤 단계가 분모로 쓰는 값이라 명시적으로 전달한다.
   */
  onAnalyze: (dataUris: string[], photoCount: number) => void;
  /** 페이지가 분석 요청 중임을 알린다. 화면은 이 값을 만들지 않는다 */
  isAnalyzing?: boolean;
}

export function UploadScreen({ onAnalyze, isAnalyzing = false }: UploadScreenProps) {
  const [photos, setPhotos] = useState<SelectedPhoto[]>([]);
  const [rejected, setRejected] = useState<RejectReason[]>([]);
  const [budgetExceeded, setBudgetExceeded] = useState(false);
  const [preparing, setPreparing] = useState(false);

  // 선택 처리와 리사이즈가 비동기라 state 스냅샷이 낡을 수 있다. 목록의 최신값은 ref가 갖는다.
  const photosRef = useRef<SelectedPhoto[]>([]);

  // 미리보기 URL은 화면을 떠날 때까지 살아 있으므로 언마운트에서 한 번에 해제한다.
  useEffect(() => () => photosRef.current.forEach((photo) => revokePreview(photo.previewUrl)), []);

  const busy = preparing || isAnalyzing;
  const hasTooSmall = photos.some((photo) => photo.tooSmall);

  /** 목록을 갈아 끼우고, 빠진 사진의 미리보기 URL을 해제한다 */
  function commitPhotos(next: SelectedPhoto[]) {
    const kept = new Set(next.map((photo) => photo.id));
    photosRef.current
      .filter((photo) => !kept.has(photo.id))
      .forEach((photo) => revokePreview(photo.previewUrl));

    photosRef.current = next;
    setPhotos(next);
  }

  async function handleSelect(files: File[]) {
    setBudgetExceeded(false);

    const incoming: Entry[] = [];
    for (const file of files) {
      incoming.push({ ...(await readMeta(file)), kind: "new", file });
    }

    // 이미 고른 사진을 앞에 세워야 중복·장수 상한이 **새로 고른 쪽**에 적용된다.
    const existing: Entry[] = photosRef.current.map((photo) => ({
      ...photo.meta,
      kind: "existing",
      photo,
    }));

    const result = validateSelection<Entry>([...existing, ...incoming]);

    const next = await Promise.all(
      result.accepted.map(({ file: entry }) =>
        entry.kind === "existing" ? entry.photo : createPhoto(entry.file, entry),
      ),
    );

    commitPhotos(next);
    setRejected(result.rejected.map((item) => item.reason));
  }

  function handleRemove(id: string) {
    commitPhotos(photosRef.current.filter((photo) => photo.id !== id));
  }

  async function handleAnalyze() {
    if (busy || photosRef.current.length === 0) return;

    setPreparing(true);
    setRejected([]);
    setBudgetExceeded(false);

    const dataUris: string[] = [];
    const failed = new Set<string>();

    for (const photo of photosRef.current) {
      try {
        dataUris.push(await resizeToDataUri(photo.file));
      } catch {
        // 조용히 빈 결과를 주지 않는다. 왜 빠졌는지 말하고 목록에서도 뺀다 (PRD Q3).
        failed.add(photo.id);
      }
    }

    setPreparing(false);

    if (failed.size > 0) {
      commitPhotos(photosRef.current.filter((photo) => !failed.has(photo.id)));
      setRejected(Array<RejectReason>(failed.size).fill("decode_failed"));
      // 보낸 장수가 사용자가 본 장수와 달라지므로, 남은 사진으로 다시 누르게 한다.
      return;
    }

    if (dataUris.length === 0) return;

    // 4MB를 실어 보낸 뒤 413을 받는 것은 마지막 방어선이지 설계가 아니다 (API_SPEC 413).
    const budget = checkOutputBudget(dataUris);
    if (budget.totalExceeded || budget.oversized.length > 0) {
      setBudgetExceeded(true);
      return;
    }

    onAnalyze(dataUris, dataUris.length);
  }

  return (
    <div className="mx-auto w-full max-w-md space-y-6 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-ink">책장을 찍어 주세요</h1>
        {/* 촬영 팁 한 줄 — 뭘 찍어야 할지 몰라 이탈하는 것이 1단계의 이탈 사유다 (PRD 7번) */}
        <p className="text-sm text-body">책등이 보이도록 한 칸씩 찍으면 잘 읽혀요</p>
      </header>

      <PhotoPicker onSelect={handleSelect} disabled={busy} />

      <PhotoThumbnails photos={photos} onRemove={handleRemove} disabled={busy} />

      <RejectedNotice reasons={rejected} />

      {hasTooSmall && (
        <Notice>사진이 너무 길어요. 책장을 나눠서 여러 장으로 찍어 주세요</Notice>
      )}

      {budgetExceeded && (
        <Notice>사진 용량이 너무 커요. 장수를 줄이거나 다른 사진을 골라 주세요</Notice>
      )}

      {busy && (
        // 진행 상태는 눈으로만 알리지 않는다 (TRD 6.6 접근성).
        <div role="status" aria-live="polite" className="space-y-2">
          <p className="text-sm text-body">
            {preparing ? "사진을 준비하고 있어요" : "책등을 읽고 있어요"}
          </p>
          {!preparing && (
            <p className="text-xs text-subtle">사진 {photos.length}장 기준 최대 30초쯤 걸려요</p>
          )}
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-24" />
        </div>
      )}

      {/* 사진을 남기지 않는 것은 부수 효과가 아니라 지켜야 할 성질이다 (PRD 8번 리스크) */}
      <p className="text-xs text-subtle">사진은 저장되지 않아요</p>

      <div className="sticky bottom-0 border-t border-line bg-page pt-3 pb-4">
        <button
          type="button"
          onClick={handleAnalyze}
          disabled={busy || photos.length === 0}
          className="min-h-11 w-full rounded-md bg-accent px-5 py-3 text-white hover:bg-accent-strong disabled:bg-muted-surface disabled:text-disabled"
        >
          분석 시작
        </button>
      </div>
    </div>
  );
}

/** 파일 메타 + 중복 판정용 내용 해시 */
async function readMeta(file: File): Promise<SelectedFileMeta> {
  return { name: file.name, type: file.type, size: file.size, hash: await hashFile(file) };
}

/**
 * 내용 해시. 읽지 못하면 이름+크기로 대신하고 선택 자체를 막지 않는다 —
 * 여기서 막는 것은 공격이 아니라 "같은 사진을 두 번 골랐다"는 실수이고,
 * 정말 못 읽는 파일이라면 리사이즈 단계에서 `decode_failed`로 드러난다.
 */
function hashFile(file: File): Promise<string> {
  return new Promise((resolve) => {
    const fallback = `${file.name}-${file.size}`;
    const reader = new FileReader();

    reader.onerror = () => resolve(fallback);
    reader.onload = () => {
      const result = reader.result;
      resolve(result instanceof ArrayBuffer ? hashBytes(new Uint8Array(result)) : fallback);
    };

    reader.readAsArrayBuffer(file);
  });
}

async function createPhoto(file: File, meta: SelectedFileMeta): Promise<SelectedPhoto> {
  return {
    id: meta.hash,
    name: meta.name,
    previewUrl: createPreview(file),
    tooSmall: await measureTooSmall(file),
    file,
    meta,
  };
}

/**
 * 리사이즈 후 판독 하한을 밑도는지 **고르는 순간** 재 둔다 (TR-001).
 *
 * 분석 시작까지 기다렸다 말하면 사용자는 이미 30초를 쓴 뒤에 "나눠서 찍으라"는 말을
 * 듣는다. 판정 자체는 `isTooSmallAfterResize`가 하고 여기서는 치수만 잰다.
 * 잴 수 없는 환경(캔버스 없음)에서는 경고하지 않는다 — 없는 근거로 경고하지 않는다.
 */
async function measureTooSmall(file: File): Promise<boolean> {
  if (typeof createImageBitmap !== "function") return false;

  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const tooSmall = isTooSmallAfterResize(bitmap.width, bitmap.height);
    bitmap.close();
    return tooSmall;
  } catch {
    // 디코드 실패는 여기서 말하지 않는다. 분석 시작에서 decode_failed로 한 번만 말한다.
    return false;
  }
}

function createPreview(file: File): string | null {
  try {
    if (typeof URL.createObjectURL !== "function") return null;
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

function revokePreview(previewUrl: string | null) {
  if (previewUrl === null) return;

  try {
    URL.revokeObjectURL(previewUrl);
  } catch {
    // 해제 실패는 사용자에게 아무 의미가 없다.
  }
}
