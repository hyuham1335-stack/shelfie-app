import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ImageDecodeError,
  JPEG_QUALITY,
  MAX_LONG_EDGE,
  MAX_OUTPUT_BYTES_PER_IMAGE,
  MAX_OUTPUT_BYTES_TOTAL,
  MAX_SOURCE_BYTES,
  MIN_SHORT_EDGE,
  checkOutputBudget,
  dataUriByteLength,
  hashBytes,
  isTooSmallAfterResize,
  resizeToDataUri,
  targetDimensions,
  validateSelection,
} from "./image";
import { MAX_PHOTOS } from "./env";
import type { SelectedFileMeta } from "./image";

function 파일(overrides: Partial<SelectedFileMeta> & { hash: string }): SelectedFileMeta {
  return {
    name: `${overrides.hash}.jpg`,
    type: "image/jpeg",
    size: 1024,
    ...overrides,
  };
}

/** n장의 서로 다른 정상 파일 */
function 정상파일들(n: number): SelectedFileMeta[] {
  return Array.from({ length: n }, (_, i) => 파일({ hash: `h${i}` }));
}

describe("validateSelection — 장수 상한 (FR-001)", () => {
  it("6장을 고르면 6번째만 too_many로 거부되고 앞 5장은 통과한다", () => {
    const { accepted, rejected } = validateSelection(정상파일들(MAX_PHOTOS + 1));

    expect(accepted.map((a) => a.index)).toEqual([0, 1, 2, 3, 4]);
    expect(rejected).toEqual([{ index: 5, reason: "too_many" }]);
  });

  it("정확히 5장은 전부 통과한다 (경계값)", () => {
    const { accepted, rejected } = validateSelection(정상파일들(MAX_PHOTOS));

    expect(accepted).toHaveLength(MAX_PHOTOS);
    expect(rejected).toEqual([]);
  });

  it("거부된 파일은 장수에서 빠져, 뒤 파일이 상한에 밀리지 않는다", () => {
    // 첫 장이 미지원 형식이면 남은 5장이 그대로 상한을 채운다.
    const files = [파일({ hash: "gif", type: "image/gif" }), ...정상파일들(MAX_PHOTOS)];
    const { accepted, rejected } = validateSelection(files);

    expect(accepted).toHaveLength(MAX_PHOTOS);
    expect(rejected).toEqual([{ index: 0, reason: "unsupported_type" }]);
  });

  it("빈 선택은 빈 결과다 (예외를 던지지 않는다)", () => {
    expect(validateSelection([])).toEqual({ accepted: [], rejected: [] });
  });
});

describe("validateSelection — 원본 크기 (FR-001)", () => {
  it("10MB를 넘는 파일 하나만 제외되고 나머지는 통과한다 (전체 차단이 아니다)", () => {
    const files = [
      파일({ hash: "a" }),
      파일({ hash: "b", size: MAX_SOURCE_BYTES + 1 }),
      파일({ hash: "c" }),
    ];
    const { accepted, rejected } = validateSelection(files);

    expect(accepted.map((a) => a.file.hash)).toEqual(["a", "c"]);
    expect(rejected).toEqual([{ index: 1, reason: "too_large" }]);
  });

  it("정확히 10MB는 통과한다 (경계값)", () => {
    const { accepted, rejected } = validateSelection([파일({ hash: "a", size: MAX_SOURCE_BYTES })]);

    expect(accepted).toHaveLength(1);
    expect(rejected).toEqual([]);
  });
});

describe("validateSelection — MIME 화이트리스트 (FR-001)", () => {
  it("jpeg·png·webp는 통과한다", () => {
    const files = [
      파일({ hash: "a", type: "image/jpeg" }),
      파일({ hash: "b", type: "image/png" }),
      파일({ hash: "c", type: "image/webp" }),
    ];

    expect(validateSelection(files).rejected).toEqual([]);
  });

  it("image/gif와 image/heic는 unsupported_type으로 거부된다", () => {
    const files = [
      파일({ hash: "a", type: "image/gif" }),
      파일({ hash: "b", type: "image/heic" }),
    ];
    const { accepted, rejected } = validateSelection(files);

    expect(accepted).toEqual([]);
    expect(rejected).toEqual([
      { index: 0, reason: "unsupported_type" },
      { index: 1, reason: "unsupported_type" },
    ]);
  });

  it("타입이 빈 문자열이어도 조용히 통과시키지 않는다", () => {
    expect(validateSelection([파일({ hash: "a", type: "" })]).rejected).toEqual([
      { index: 0, reason: "unsupported_type" },
    ]);
  });
});

describe("validateSelection — 중복 제거 (PRD 5번 Edge Cases)", () => {
  it("같은 해시 파일이 두 번 들어오면 두 번째가 duplicate다", () => {
    const files = [파일({ hash: "same" }), 파일({ hash: "same", name: "복사본.jpg" })];
    const { accepted, rejected } = validateSelection(files);

    expect(accepted.map((a) => a.index)).toEqual([0]);
    expect(rejected).toEqual([{ index: 1, reason: "duplicate" }]);
  });

  it("중복은 장수에서 빠지므로 뒤의 정상 파일이 상한에 밀리지 않는다", () => {
    const files = [파일({ hash: "h0" }), ...정상파일들(MAX_PHOTOS)];
    const { accepted, rejected } = validateSelection(files);

    expect(accepted).toHaveLength(MAX_PHOTOS);
    expect(rejected).toEqual([{ index: 1, reason: "duplicate" }]);
  });
});

describe("validateSelection — 순수성", () => {
  it("입력 배열과 원소를 변형하지 않는다", () => {
    const files = [파일({ hash: "a" }), 파일({ hash: "a" })];
    const snapshot = structuredClone(files);

    validateSelection(files);

    expect(files).toEqual(snapshot);
  });
});

describe("hashBytes — 중복 판정용 해시", () => {
  it("같은 바이트는 같은 해시, 다른 바이트는 다른 해시다", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    const c = new Uint8Array([1, 2, 3, 5]);

    expect(hashBytes(a)).toBe(hashBytes(b));
    expect(hashBytes(a)).not.toBe(hashBytes(c));
  });

  it("길이가 다르면 해시도 다르다", () => {
    expect(hashBytes(new Uint8Array([1, 2, 3]))).not.toBe(hashBytes(new Uint8Array([1, 2, 3, 0])));
  });

  it("빈 배열도 해시를 낸다", () => {
    expect(hashBytes(new Uint8Array([]))).toMatch(/^[0-9a-f]+(-[0-9a-f]+)*$/);
  });
});

describe("targetDimensions — 긴 변 1568 축소 (FR-002)", () => {
  it("3000x2000은 1568x1045가 된다", () => {
    expect(targetDimensions(3000, 2000)).toEqual({ width: MAX_LONG_EDGE, height: 1045 });
  });

  it("세로 사진 2000x3000은 1045x1568이 된다", () => {
    expect(targetDimensions(2000, 3000)).toEqual({ width: 1045, height: MAX_LONG_EDGE });
  });

  it("정사각 3000x3000은 1568x1568이 된다", () => {
    expect(targetDimensions(3000, 3000)).toEqual({ width: MAX_LONG_EDGE, height: MAX_LONG_EDGE });
  });

  it("이미 1568 이하인 이미지는 확대하지 않는다", () => {
    expect(targetDimensions(1000, 800)).toEqual({ width: 1000, height: 800 });
    expect(targetDimensions(MAX_LONG_EDGE, 900)).toEqual({ width: MAX_LONG_EDGE, height: 900 });
  });

  it("축소해도 짧은 변이 0이 되지 않는다 (극단적 파노라마)", () => {
    const { width, height } = targetDimensions(100000, 50);

    expect(width).toBe(MAX_LONG_EDGE);
    expect(height).toBeGreaterThanOrEqual(1);
  });

  it("치수가 0이거나 유효하지 않으면 0을 돌려준다 (디코드 실패로 다룬다)", () => {
    expect(targetDimensions(0, 100)).toEqual({ width: 0, height: 0 });
    expect(targetDimensions(Number.NaN, 100)).toEqual({ width: 0, height: 0 });
  });
});

describe("isTooSmallAfterResize — 짧은 변 경고 (TR-001)", () => {
  it("짧은 변 600px은 경고하지 않고 599px은 경고한다 (경계값)", () => {
    expect(isTooSmallAfterResize(MAX_LONG_EDGE, MIN_SHORT_EDGE)).toBe(false);
    expect(isTooSmallAfterResize(MAX_LONG_EDGE, MIN_SHORT_EDGE - 1)).toBe(true);
  });

  it("세로로 긴 파노라마(1200x4000)는 경고 대상이다", () => {
    // 긴 변을 1568로 줄이면 짧은 변이 470px까지 내려가 책등 글자가 뭉개진다.
    expect(targetDimensions(1200, 4000).width).toBeLessThan(MIN_SHORT_EDGE);
    expect(isTooSmallAfterResize(1200, 4000)).toBe(true);
  });

  it("일반적인 책장 사진(3000x2000)은 경고 대상이 아니다", () => {
    expect(isTooSmallAfterResize(3000, 2000)).toBe(false);
  });

  it("원본부터 작은 사진도 경고 대상이다 (확대하지 않으므로)", () => {
    expect(isTooSmallAfterResize(800, 500)).toBe(true);
  });
});

describe("dataUriByteLength · checkOutputBudget — 산출물 상한 (FR-002)", () => {
  /** 전송 바이트가 정확히 `bytes`인 가짜 data URI */
  function 산출물(bytes: number): string {
    const prefix = "data:image/jpeg;base64,";
    return prefix + "A".repeat(Math.max(0, bytes - prefix.length));
  }

  it("전송 바이트는 data URI 문자열 전체다", () => {
    expect(dataUriByteLength("data:image/jpeg;base64,AAAA")).toBe(27);
    expect(dataUriByteLength(산출물(1000))).toBe(1000);
  });

  it("상한 안이면 초과 항목이 없다", () => {
    const result = checkOutputBudget([산출물(1_000_000), 산출물(1_000_000)]);

    expect(result).toEqual({ totalBytes: 2_000_000, oversized: [], totalExceeded: false });
  });

  it("장당 2MB를 넘긴 항목의 인덱스를 돌려준다", () => {
    const result = checkOutputBudget([산출물(1000), 산출물(MAX_OUTPUT_BYTES_PER_IMAGE + 1)]);

    expect(result.oversized).toEqual([1]);
  });

  it("장당 2MB 정확히는 초과가 아니다 (경계값)", () => {
    expect(checkOutputBudget([산출물(MAX_OUTPUT_BYTES_PER_IMAGE)]).oversized).toEqual([]);
  });

  it("합계가 4MB를 넘으면 totalExceeded가 true다", () => {
    const 절반 = MAX_OUTPUT_BYTES_TOTAL / 2;
    expect(checkOutputBudget([산출물(절반), 산출물(절반)]).totalExceeded).toBe(false);
    expect(checkOutputBudget([산출물(절반), 산출물(절반 + 1)]).totalExceeded).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * DOM 의존 경로 — jsdom은 캔버스를 렌더하지 않으므로 디코드·인코드를 대체한다.
 * 새 의존성(canvas·sharp)을 넣지 않고 모킹으로 계약만 고정한다.
 * ------------------------------------------------------------------ */

interface 캔버스기록 {
  size: { width: number; height: number } | null;
  blobArgs: { type: unknown; quality: unknown } | null;
}

function 캔버스대체(options: { context?: boolean; blob?: Blob | null } = {}): 캔버스기록 {
  const 기록: 캔버스기록 = { size: null, blobArgs: null };
  const context = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => (options.context === false ? null : context) as unknown as RenderingContext,
  );

  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
    quality?: unknown,
  ) {
    기록.size = { width: this.width, height: this.height };
    기록.blobArgs = { type, quality };
    const blob =
      options.blob === undefined
        ? new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" })
        : options.blob;
    callback(blob);
  });

  return 기록;
}

/**
 * createImageBitmap 대체. EXIF orientation 6(90도 회전)인 사진을 흉내 낸다 —
 * 저장된 픽셀은 눕혀진 3000x1000이고, `imageOrientation: "from-image"`로
 * 요청했을 때만 정립된 1000x3000이 나온다.
 */
function 비트맵대체(눕힌치수 = { width: 3000, height: 1000 }) {
  const decode = vi.fn(async (_file: Blob, options?: ImageBitmapOptions) => {
    const 정립 = options?.imageOrientation === "from-image";
    return {
      width: 정립 ? 눕힌치수.height : 눕힌치수.width,
      height: 정립 ? 눕힌치수.width : 눕힌치수.height,
      close: vi.fn(),
    } as unknown as ImageBitmap;
  });

  vi.stubGlobal("createImageBitmap", decode);
  return decode;
}

function 사진(): File {
  return new File([new Uint8Array([1, 2, 3, 4])], "shelf.jpg", { type: "image/jpeg" });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resizeToDataUri — EXIF 회전 보정 (TR-001)", () => {
  // 이 테스트는 삭제하지 않는다. 회전 보정을 빠뜨리면 세로 사진이 누운 채
  // 모델에 들어가 판독률이 급락한다 — TR-001이 테스트로 고정하라고 명시한 항목이다.
  it("orientation 6인 사진이 정립된 치수(1045x1568)로 그려진다", async () => {
    비트맵대체({ width: 3000, height: 1000 });
    const 기록 = 캔버스대체();

    await resizeToDataUri(사진());

    // 정립하면 1000x3000 → 긴 변 1568 기준 1045x1568(세로).
    // 보정을 빠뜨리면 1568x523(가로)이 되어 이 단언이 깨진다.
    expect(기록.size).toEqual({ width: 523, height: MAX_LONG_EDGE });
  });

  it("디코드 시 imageOrientation을 from-image로 요청한다", async () => {
    const decode = 비트맵대체();
    캔버스대체();

    await resizeToDataUri(사진());

    expect(decode).toHaveBeenCalledWith(expect.anything(), { imageOrientation: "from-image" });
  });
});

describe("resizeToDataUri — 인코딩 계약 (FR-002)", () => {
  it("JPEG 품질 0.85로 인코딩하고 base64 data URI를 돌려준다", async () => {
    비트맵대체({ width: 3000, height: 2000 });
    const 기록 = 캔버스대체();

    const uri = await resizeToDataUri(사진());

    expect(기록.blobArgs).toEqual({ type: "image/jpeg", quality: JPEG_QUALITY });
    expect(uri).toMatch(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/);
  });

  it("긴 변이 1568을 넘지 않는 치수로 캔버스를 잡는다", async () => {
    // 눕혀 저장된 3000x4000 → 정립하면 4000x3000(가로).
    비트맵대체({ width: 3000, height: 4000 });
    const 기록 = 캔버스대체();

    await resizeToDataUri(사진());

    expect(기록.size?.width).toBe(MAX_LONG_EDGE);
    expect(기록.size?.height).toBe(1176);
  });
});

describe("resizeToDataUri — 실패는 decode_failed로 명시한다 (PRD Q3)", () => {
  it("디코드가 실패하면 ImageDecodeError를 던진다 (예외가 그대로 새어 나가지 않는다)", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new TypeError("The source image cannot be decoded.");
      }),
    );
    캔버스대체();

    await expect(resizeToDataUri(사진())).rejects.toBeInstanceOf(ImageDecodeError);
    await expect(resizeToDataUri(사진())).rejects.toMatchObject({ reason: "decode_failed" });
  });

  it("createImageBitmap이 없는 브라우저에서도 조용히 넘어가지 않는다", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    캔버스대체();

    await expect(resizeToDataUri(사진())).rejects.toBeInstanceOf(ImageDecodeError);
  });

  it("2D 컨텍스트를 얻지 못하면 decode_failed다", async () => {
    비트맵대체();
    캔버스대체({ context: false });

    await expect(resizeToDataUri(사진())).rejects.toBeInstanceOf(ImageDecodeError);
  });

  it("toBlob이 null을 돌려주면 decode_failed다", async () => {
    비트맵대체();
    캔버스대체({ blob: null });

    await expect(resizeToDataUri(사진())).rejects.toBeInstanceOf(ImageDecodeError);
  });

  it("치수가 0인 이미지는 decode_failed다", async () => {
    비트맵대체({ width: 0, height: 0 });
    캔버스대체();

    await expect(resizeToDataUri(사진())).rejects.toBeInstanceOf(ImageDecodeError);
  });

  it("서버가 받지 못할 형태로 인코딩되면 decode_failed다", async () => {
    비트맵대체();
    // 빈 blob → base64 본문이 없는 data URI. imageDataUriSchema를 통과하지 못한다.
    캔버스대체({ blob: new Blob([], { type: "image/jpeg" }) });

    await expect(resizeToDataUri(사진())).rejects.toBeInstanceOf(ImageDecodeError);
  });
});
