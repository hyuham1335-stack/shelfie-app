/**
 * 업로드 파일 검증과 전송 전 축소 (FR-001·FR-002, TR-001).
 *
 * ## 이 파일만 브라우저 API에 의존한다
 * `createImageBitmap`·`<canvas>`·`FileReader`를 쓰므로 **서버 코드(`app/api/`·
 * `services/`)에서 import하지 않는다** (/docs/ARCHITECTURE.md 레이어 의존 관계).
 * 그래서 DOM을 만지는 코드는 `resizeToDataUri` 하나로 몰고, 판정 규칙은 전부
 * 순수 함수로 빼 두었다 — 규칙이 캔버스 없이 테스트되어야 규칙을 신뢰할 수 있다.
 *
 * ## 클라이언트 검증은 서버 검증을 대신하지 않는다
 * 여기서 거른 값은 어차피 라우트 핸들러가 zod로 다시 검사한다 (TRD 6.5).
 * 이 단계의 목적은 보안이 아니라 **비용과 시간**이다 — 못 쓸 파일을 4MB
 * 실어 보낸 뒤 400을 받는 것보다, 고르는 순간 이유를 말해 주는 편이 싸다.
 *
 * ## 왜 1568px인가 (ADR-001, FR-002)
 * 긴 변을 1568px로 고정하면 이미지 토큰이 장당 약 1,600으로 고정되어 세션당
 * 비용이 예측 가능해진다. 더 키워도 책등 판독이 그만큼 좋아지지 않고, 더
 * 줄이면 글자가 뭉개진다.
 */
import { MAX_OUTPUT_BYTES_PER_IMAGE, MAX_OUTPUT_BYTES_TOTAL, MAX_PHOTOS } from "./env";
import { imageDataUriSchema } from "./schemas";

/** 리사이즈 후 긴 변의 목표 픽셀 (FR-002) */
export const MAX_LONG_EDGE = 1568;

/**
 * 리사이즈 후 짧은 변의 경고 하한.
 * 세로로 긴 파노라마를 긴 변 기준으로 줄이면 짧은 변이 이 값 아래로 내려가
 * 책등 글자가 판독 불가 수준으로 뭉개진다. **차단이 아니라 경고**이며,
 * 사용자에게는 "책장을 나눠서 여러 장으로 찍어 주세요"로 안내한다 (PRD 5번).
 */
export const MIN_SHORT_EDGE = 600;

/** JPEG 인코딩 품질 (FR-002) */
export const JPEG_QUALITY = 0.85;

/** 원본 파일 1장의 크기 상한 (FR-001) */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

/**
 * 전송 크기 상한은 `lib/env.ts`가 단일 출처다 — 서버(`app/api/analyze`)도 같은
 * 값으로 다시 재야 하는데, 브라우저 전용인 이 모듈을 서버가 import할 수 없기
 * 때문이다(/docs/ARCHITECTURE.md). 이름은 여기서도 계속 내보낸다:
 * 이 두 상한은 리사이즈 산출물의 성질이라 호출부가 `image`에서 찾는 것이 자연스럽다.
 */
export { MAX_OUTPUT_BYTES_PER_IMAGE, MAX_OUTPUT_BYTES_TOTAL } from "./env";

/**
 * 업로드를 허용하는 MIME (FR-001).
 *
 * HEIC(`image/heic`)는 여기 없으므로 선택 단계에서 거부된다. PRD Q3가 말한
 * "캔버스 디코드를 시도하고 실패하면 명시적으로 거부한다"는 **형식을 속인
 * 파일**에 대한 두 번째 그물이다 — iOS는 HEIC를 `image/jpeg`로 신고하고
 * 넘기는 경우가 있고, 그때 실제 디코드에서 걸러져 `decode_failed`가 된다.
 * 어느 경로든 조용히 빈 결과를 주지 않고 이유를 말한다.
 */
export const SUPPORTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/**
 * 파일이 거부되는 이유. 사용자가 할 수 있는 일이 사유마다 다르므로
 * 하나로 뭉개지 않는다 (강등할 때 사유를 보존하는 규칙과 같은 이유).
 */
export type RejectReason =
  | "too_many"
  | "too_large"
  | "unsupported_type"
  | "duplicate"
  | "decode_failed";

/** 검증에 필요한 파일 메타데이터. `File` 자체를 받지 않아 순수 함수로 남는다 */
export interface SelectedFileMeta {
  name: string;
  type: string;
  size: number;
  /** 같은 사진을 두 번 고른 경우를 잡는 내용 해시. `hashBytes`로 만든다 */
  hash: string;
}

export interface SelectionResult<T extends SelectedFileMeta> {
  /** 통과한 파일. 원본 인덱스를 유지해 호출자가 실제 `File`로 되돌릴 수 있다 */
  accepted: Array<{ index: number; file: T }>;
  rejected: Array<{ index: number; reason: RejectReason }>;
}

/**
 * 선택한 파일들을 검증한다 (FR-001).
 *
 * **한 장이 나쁘다고 전부 막지 않는다.** 10MB를 넘긴 파일은 그 파일만 빼고
 * 나머지는 진행하며, 장수 상한도 *통과한* 파일에만 적용한다 — 거부된 파일이
 * 자리를 차지하면 사용자는 멀쩡한 사진이 왜 빠졌는지 알 수 없다.
 *
 * 사유 우선순위는 **파일 자체의 결함 → 선택의 결함** 순이다:
 * `unsupported_type` → `too_large` → `duplicate` → `too_many`.
 * 형식이 틀린 파일에 "5장을 넘었어요"라고 말하면 사용자는 사진을 지우고
 * 다시 시도하지만 결과는 같다.
 */
export function validateSelection<T extends SelectedFileMeta>(
  files: readonly T[],
): SelectionResult<T> {
  const accepted: Array<{ index: number; file: T }> = [];
  const rejected: Array<{ index: number; reason: RejectReason }> = [];
  const seenHashes = new Set<string>();

  files.forEach((file, index) => {
    const reason = rejectReasonFor(file, seenHashes, accepted.length);

    if (reason !== null) {
      rejected.push({ index, reason });
      return;
    }

    seenHashes.add(file.hash);
    accepted.push({ index, file });
  });

  return { accepted, rejected };
}

function rejectReasonFor(
  file: SelectedFileMeta,
  seenHashes: ReadonlySet<string>,
  acceptedCount: number,
): RejectReason | null {
  if (!isSupportedType(file.type)) return "unsupported_type";
  if (file.size > MAX_SOURCE_BYTES) return "too_large";
  if (seenHashes.has(file.hash)) return "duplicate";
  if (acceptedCount >= MAX_PHOTOS) return "too_many";
  return null;
}

function isSupportedType(type: string): boolean {
  return (SUPPORTED_MIME_TYPES as readonly string[]).includes(type);
}

/**
 * 중복 판정용 내용 해시.
 *
 * 암호학적 해시가 아니다 — 여기서 막는 것은 공격이 아니라 "갤러리에서 같은
 * 사진을 두 번 골랐다"는 실수이고, 그 실수의 비용은 API 호출 두 배다.
 * 대신 **길이를 함께 담고 서로 다른 오프셋의 FNV-1a 두 개를 이어 붙여**
 * 우연한 충돌로 멀쩡한 사진이 사라지는 일이 없게 한다. Web Crypto의
 * `digest`는 비동기라 순수 함수로 둘 수 없어 쓰지 않았다.
 */
export function hashBytes(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;

  for (let i = 0; i < bytes.length; i += 1) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
    h2 = Math.imul(h2 + bytes[i] + i, 0x85ebca6b) ^ (h2 >>> 13);
  }

  return `${bytes.length.toString(16)}-${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}`;
}

/**
 * 리사이즈 후 치수 (FR-002).
 *
 * 긴 변을 1568px로 맞추고 비율을 유지한다. **확대는 하지 않는다** — 작은
 * 사진을 늘려도 없는 글자가 생기지 않고 전송 바이트만 커진다.
 * 유효하지 않은 치수(0·NaN)는 0을 돌려주고, 호출자는 이를 디코드 실패로 다룬다.
 */
export function targetDimensions(width: number, height: number): { width: number; height: number } {
  if (!isPositiveFinite(width) || !isPositiveFinite(height)) return { width: 0, height: 0 };

  const longEdge = Math.max(width, height);
  if (longEdge <= MAX_LONG_EDGE) return { width: Math.round(width), height: Math.round(height) };

  const scale = MAX_LONG_EDGE / longEdge;
  return {
    // 반올림이 0을 만들 수 있는 극단적 비율(예: 100000x50)에서도 1px은 남긴다.
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * 리사이즈 후 짧은 변이 판독 하한을 밑도는가 (TR-001).
 *
 * **경고 판정이지 차단이 아니다.** 파노라마를 통째로 거부하면 사용자는 자기
 * 책장을 올릴 방법이 없어지고, 그냥 보내면 전부 미확인으로 돌아온다. 그래서
 * 보내되 "나눠서 찍어 주세요"를 함께 말한다.
 */
export function isTooSmallAfterResize(width: number, height: number): boolean {
  const target = targetDimensions(width, height);
  if (target.width === 0 || target.height === 0) return true;

  return Math.min(target.width, target.height) < MIN_SHORT_EDGE;
}

/**
 * data URI 하나가 요청 본문에서 차지하는 바이트.
 * data URI는 정의상 ASCII(base64 + 접두사)라 문자 수가 곧 바이트 수다.
 */
export function dataUriByteLength(dataUri: string): number {
  return dataUri.length;
}

/**
 * 전송 전 크기 예산 검사 (FR-002, TRD 6.2).
 *
 * 플랫폼 상한(4.5MB)에 걸려 413을 받기 **전에** 클라이언트가 먼저 안다.
 * 여기서 걸리면 장수를 줄이거나 품질을 낮추도록 안내한다 (API_SPEC 413 항목).
 */
export function checkOutputBudget(dataUris: readonly string[]): {
  totalBytes: number;
  /** 장당 상한을 넘긴 항목의 인덱스 */
  oversized: number[];
  /** 합계가 요청 본문 상한을 넘겼는가 */
  totalExceeded: boolean;
} {
  let totalBytes = 0;
  const oversized: number[] = [];

  dataUris.forEach((uri, index) => {
    const bytes = dataUriByteLength(uri);
    totalBytes += bytes;
    if (bytes > MAX_OUTPUT_BYTES_PER_IMAGE) oversized.push(index);
  });

  return { totalBytes, oversized, totalExceeded: totalBytes > MAX_OUTPUT_BYTES_TOTAL };
}

/**
 * 이미지를 처리하지 못했음을 **명시적으로** 알리는 실패.
 *
 * 조용히 빈 결과를 주지 않는다 — 사용자는 자기가 고른 사진이 왜 사라졌는지
 * 알아야 하고, HEIC라면 "카메라 포맷을 '높은 호환성'으로 바꿔 주세요"라는
 * 다음 행동이 있다 (PRD Q3).
 */
export class ImageDecodeError extends Error {
  readonly reason: RejectReason = "decode_failed";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImageDecodeError";
  }
}

/**
 * 파일 1장을 정립·축소해 base64 data URI로 만든다 (FR-002, TR-001).
 *
 * 이 함수만 DOM에 의존하므로 최대한 얇게 유지한다. 판정은 전부 위의 순수
 * 함수가 이미 했고, 여기서는 그 결과를 캔버스에 적용할 뿐이다.
 *
 * **EXIF orientation을 반드시 적용한다.** `imageOrientation: "from-image"`를
 * 빼면 세로로 찍은 사진이 누운 채 모델에 들어가 판독률이 급락한다 (TR-001).
 * 캔버스에 그리고 나면 회전 정보는 픽셀에 녹아들어 사라지므로, 정립은 디코드
 * 시점에 한 번뿐이고 되돌릴 기회가 없다.
 *
 * 어떤 단계가 실패하든 원본 예외를 그대로 흘리지 않고 `ImageDecodeError`로
 * 바꿔 던진다. 브라우저마다 다른 예외 문구가 화면 분기 조건이 되면 안 된다.
 */
export async function resizeToDataUri(file: File): Promise<string> {
  try {
    return await encodeResized(file);
  } catch (cause) {
    if (cause instanceof ImageDecodeError) throw cause;
    throw new ImageDecodeError("이미지를 처리하지 못했어요", { cause });
  }
}

async function encodeResized(file: File): Promise<string> {
  const bitmap = await decodeUpright(file);

  try {
    const { width, height } = targetDimensions(bitmap.width, bitmap.height);
    if (width === 0 || height === 0) throw new ImageDecodeError("이미지 크기를 읽지 못했어요");

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (context === null) throw new ImageDecodeError("이미지를 그릴 수 없어요");
    context.drawImage(bitmap, 0, 0, width, height);

    const dataUri = await readAsDataUri(await encodeJpeg(canvas));

    // 클라이언트가 만든 값이라도 서버 계약(imageDataUriSchema)을 통과해야 한다.
    // 여기서 걸러야 4MB를 실어 보낸 뒤 400을 받는 일이 없다.
    if (!imageDataUriSchema.safeParse(dataUri).success) {
      throw new ImageDecodeError("이미지를 JPEG로 인코딩하지 못했어요");
    }

    return dataUri;
  } finally {
    bitmap.close();
  }
}

/** EXIF orientation을 적용해 정립된 비트맵으로 디코드한다 */
async function decodeUpright(file: File): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") {
    throw new ImageDecodeError("이 브라우저에서는 사진을 처리할 수 없어요");
  }

  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (cause) {
    // HEIC처럼 브라우저가 디코드하지 못하는 형식이 여기로 온다 (PRD Q3).
    throw new ImageDecodeError("사진을 열지 못했어요", { cause });
  }
}

function encodeJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const fail = () => reject(new ImageDecodeError("이미지를 JPEG로 인코딩하지 못했어요"));

    try {
      canvas.toBlob((blob) => (blob === null ? fail() : resolve(blob)), "image/jpeg", JPEG_QUALITY);
    } catch {
      fail();
    }
  });
}

function readAsDataUri(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new ImageDecodeError("이미지를 읽지 못했어요"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") resolve(result);
      else reject(new ImageDecodeError("이미지를 읽지 못했어요"));
    };

    reader.readAsDataURL(blob);
  });
}
