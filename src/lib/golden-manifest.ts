/**
 * 골든 인식률 세트의 **매니페스트 계약** (ADR-010 · TRD 8번).
 *
 * 세트(사진 20장 + 기대 목록)는 리포지토리 밖에 있고 `GOLDEN_SET_DIR`이 가리킨다.
 * 리포에 남는 것은 계약·판정·리포트뿐이며, 이 파일이 그중 계약이다.
 *
 * 이 모듈은 **순수 층**이다 — `fs`도 `services/`도 `process.env`도 모른다.
 * 디렉토리를 뒤지고 파일을 읽는 것은 `*.golden.test.ts`의 몫이고, 그 분리가 있어야
 * 이 계약을 일반 `npm test`에서 값으로 검증할 수 있다 (ADR-009와 같은 수법).
 *
 * 파싱 실패는 예외가 아니라 **판별 가능한 실패 값**이다
 * (/docs/ARCHITECTURE.md 검증 경계 패턴). 호출부는 이 실패를 skip 사유로 바꾸는데,
 * 예외로 던지면 그것이 테스트 실패가 되어 "세트가 잘못됐다"와 "모델이 나빠졌다"가
 * 같은 빨간불이 된다.
 */
import { z } from "zod";
import { isbn13Schema } from "./schemas";

/**
 * 이 코드가 이해하는 매니페스트 형식 버전. 스키마를 바꿀 때 함께 올린다.
 * 매니페스트의 `version`이 이 값보다 크면 파싱하지 않고 거부한다 — 모르는 형식을
 * 아는 척 읽으면 없는 필드가 조용히 빠진 채 재현율이 계산된다.
 */
export const GOLDEN_MANIFEST_VERSION = 1;

/* ------------------------------------------------------------------ *
 * 스키마 — TRD 8번 "매니페스트 형식"이 단일 출처다
 * ------------------------------------------------------------------ */

/** SHA-256 16진 표기 64자리 */
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i);

/**
 * 사진 한 장에서 사람이 읽을 수 있는 책 1권.
 *
 * `isbn13`은 **선택**이다 — 있으면 오확인 판정이 ISBN으로 정확해지고, 없으면 제목
 * 유사도로 판정한다. 20장 전부에 ISBN을 적는 것은 부담이라 강제하지 않는다(TRD 8번).
 * 다만 적었다면 13자리 숫자여야 한다 — 형식은 프로덕션 판정과 같은 스키마를 쓴다.
 */
export const goldenExpectedBookSchema = z.object({
  title: z.string().min(1),
  author: z.string().min(1),
  isbn13: isbn13Schema.optional(),
});

/**
 * 사진 1장과 그 사진의 기대 목록.
 *
 * `sha256`은 필수다. 세트가 버전 관리 밖에 있어(ADR-010) 리포트가 "어느 입력을
 * 쟀는가"를 특정할 유일한 수단이 이 해시다. `books`가 비면 그 사진으로 잴 것이 없다.
 */
export const goldenPhotoSchema = z.object({
  file: z.string().min(1),
  sha256: sha256Schema,
  books: z.array(goldenExpectedBookSchema).min(1),
});

/** 세트 전체. `setId`·`version`은 리포트에 그대로 실려 결과와 입력을 묶는다 */
export const goldenManifestSchema = z.object({
  version: z.number().int().positive(),
  setId: z.string().min(1),
  photos: z.array(goldenPhotoSchema).min(1),
});

export type GoldenExpectedBook = z.infer<typeof goldenExpectedBookSchema>;
export type GoldenPhoto = z.infer<typeof goldenPhotoSchema>;
export type GoldenManifest = z.infer<typeof goldenManifestSchema>;

/* ------------------------------------------------------------------ *
 * 판정
 * ------------------------------------------------------------------ */

/**
 * 매니페스트를 쓸 수 없는 사유 2종. 뭉개지 않는다 — 사람이 할 일이 다르다.
 * - schema : 형식이 계약을 어겼다 → **매니페스트를 고친다**
 * - version: 우리가 모르는 형식 버전이다 → **코드를 올린다**
 *
 * `lookup_failed`와 `no_match`를 끝까지 다른 값으로 나르는 것과 같은 규율이다 (ADR-005).
 */
export type GoldenManifestFailureReason = "schema" | "version";

export type ParseGoldenManifestOutcome =
  | { status: "ok"; manifest: GoldenManifest }
  | { status: "failed"; reason: GoldenManifestFailureReason; detail: string };

/**
 * zod의 issue 목록을 사람이 읽을 수 있는 **한 줄**로 접는다.
 *
 * 세트는 리포 밖에 있어 다른 사람이 고쳐야 하고, 그 사람이 가진 단서는 리포트에
 * 실린 이 문자열뿐이다 (TRD 8번 skip 표: "파싱 실패는 사유 문자열에 이유를 남긴다").
 */
function foldIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join(" · ");
}

/**
 * 원시 값(`JSON.parse` 결과)을 매니페스트로 판정한다. **던지지 않는다.**
 *
 * 버전을 먼저 본다 — 형식 검사보다 앞이어야 미래 버전의 매니페스트가 "필드가
 * 틀렸다"는 엉뚱한 사유로 보고되지 않는다. 버전을 읽을 수 없는 값(숫자가 아니거나
 * 객체가 아님)은 버전 문제가 아니라 형식 문제이므로 아래 스키마 검사로 넘어간다.
 */
export function parseGoldenManifest(raw: unknown): ParseGoldenManifestOutcome {
  const versioned = z.object({ version: z.number().int().positive() }).safeParse(raw);
  if (versioned.success && versioned.data.version > GOLDEN_MANIFEST_VERSION) {
    return {
      status: "failed",
      reason: "version",
      detail: `매니페스트 형식 버전 ${versioned.data.version}은 이 코드가 이해하는 버전(${GOLDEN_MANIFEST_VERSION})보다 높습니다. lib/golden-manifest.ts를 올리세요.`,
    };
  }

  const parsed = goldenManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "failed", reason: "schema", detail: foldIssues(parsed.error) };
  }

  return { status: "ok", manifest: parsed.data };
}
