/**
 * 환경 상수와 서버 환경변수 검증.
 * 값의 근거는 /docs/TRD.md 7번(환경변수)과 /docs/PRD.md 4번(FR-001, FR-005)에 있다.
 */
import { z } from "zod";

/** 모든 Claude 호출의 기본 모델. 환경변수로 배포 없이 교체할 수 있다. */
export const DEFAULT_MODEL = "claude-opus-5";

/**
 * 사진 장수 상한의 **천장** (FR-001).
 *
 * 환경변수는 이 값을 넓히지 못하고 좁히기만 한다. `NEXT_PUBLIC_` 값은
 * 클라이언트 번들에 그대로 박히는 공개 값이라, 그것 하나로 서버가 받는
 * 장수가 늘어날 수 있다면 FR-001은 방어가 아니라 권고가 된다.
 */
const MAX_PHOTOS_CEILING = 5;

/**
 * 한 요청에 올릴 수 있는 사진 장수 상한 (FR-001, TRD 7번 `NEXT_PUBLIC_MAX_PHOTOS`).
 *
 * `process.env.NEXT_PUBLIC_MAX_PHOTOS`를 **정적 참조로** 읽는다 — `NEXT_PUBLIC_`
 * 값은 빌드 타임에 문자열로 치환되므로 계산된 키(`process.env[name]`)로 접근하면
 * 치환되지 않아 항상 undefined가 된다.
 *
 * 값이 없거나 숫자가 아니거나 범위를 벗어나면 천장으로 떨어진다. 여기서 던지지
 * 않는 이유는 이 모듈이 클라이언트에서도 import되기 때문이다 — 상수 하나를
 * 가져가려다 화면이 통째로 죽으면 안 된다.
 */
export const MAX_PHOTOS: number = clampPhotoLimit(process.env.NEXT_PUBLIC_MAX_PHOTOS);

function clampPhotoLimit(raw: string | undefined): number {
  if (raw === undefined) return MAX_PHOTOS_CEILING;

  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed)) return MAX_PHOTOS_CEILING;

  // 1 미만이면 사진을 한 장도 못 올리게 되고, 천장을 넘으면 FR-001을 어긴다.
  return Math.min(Math.max(parsed, 1), MAX_PHOTOS_CEILING);
}

/**
 * 리사이즈 산출물 1장의 전송 크기 상한 (FR-002, API_SPEC 공통 규약).
 *
 * 브라우저(`lib/image.ts`)와 서버(`app/api/analyze`)가 **같은 값**을 재야 한다.
 * 서버가 다시 재는 것은 클라이언트 검증을 신뢰하지 않기 때문이지만(TRD 6.5),
 * 그렇다고 두 벌로 적어 둘 이유는 없다 — 값이 갈리면 클라이언트가 통과시킨
 * 요청을 서버가 거부하는 조합이 조용히 생긴다. 그래서 값은 여기 하나로 두고
 * 재는 일은 두 곳에서 각자 한다.
 */
export const MAX_OUTPUT_BYTES_PER_IMAGE = 2 * 1024 * 1024;

/** 리사이즈 산출물 합계의 전송 크기 상한. 플랫폼 상한 4.5MB보다 낮게 잡는다 */
export const MAX_OUTPUT_BYTES_TOTAL = 4 * 1024 * 1024;

/** 확인된 책 목록의 상한 (FR-005) */
export const MAX_IDENTIFIED_BOOKS = 50;

/** 미확인 책 목록의 상한 (TR-005). 넘친 개수는 unidentifiedOverflowCount로만 남긴다 */
export const MAX_UNIDENTIFIED_BOOKS = 100;

/**
 * 사진 한 장에서 받을 수 있는 추출 후보 상한 (TR-003).
 * 아래 세 상한은 전부 증폭 방지 장치다 — 판독 한 번의 이상 동작이
 * 알라딘 일일 한도(5,000회)를 한 요청에 소진시키지 못하게 한다 (TRD 10번).
 */
export const MAX_CANDIDATES_PER_PHOTO = 60;

/** 알라딘 조회 전 후보 총량 상한. confidence 내림차순으로 자른다 (TR-005) */
export const MAX_CANDIDATES_FOR_LOOKUP = 80;

/** 사용자에게 제시하는 알라딘 후보 수. ambiguous 후보와 resolve 결과에 같은 값을 쓴다 (API_SPEC) */
export const MAX_ALADIN_CANDIDATES = 5;

/** 한 번에 추천하는 책 수 (FR-006) */
export const MAX_RECOMMENDATIONS = 3;

/** 책등 추출에 쓸 모델 ID */
export function getExtractModel(): string {
  return process.env.MODEL_EXTRACT ?? DEFAULT_MODEL;
}

/** 한줄평·추천·문답 생성에 쓸 모델 ID */
export function getRecommendModel(): string {
  return process.env.MODEL_RECOMMEND ?? DEFAULT_MODEL;
}

/* ------------------------------------------------------------------ *
 * 서버 전용 환경변수 검증 (TRD 7번)
 *
 * ## 왜 함수 안에서 평가하는가
 * `env.ts`는 상수(MAX_PHOTOS 등)를 가져가려고 match·merge·image·analytics가
 * import한다. 검증을 모듈 최상위 부수효과로 두면 키 없는 환경에서 그 모듈들이
 * import만으로 죽고, 시크릿 교체·테스트도 불가능해진다. `lib/proof.ts`가
 * BOOK_PROOF_SECRET을 다룬 방식과 같게 — 값을 읽는 함수 안에서 평가한다.
 *
 * ## 부재와 오설정을 구분한다
 * ANTHROPIC_API_KEY·ALADIN_TTB_KEY는 **비어 있는 것이 오류가 아니다.**
 * .env.example이 "비워 두면 services/가 목업 픽스처를 반환한다"고 정했고,
 * TRD 9번이 "로컬에서 키 없이도 전 구간을 돌릴 수 있어야 한다"고 요구한다.
 * 그래서 부재는 null로 돌려주고, **공백만 있는 값처럼 명백히 잘못 설정한 값**만
 * zod가 거부한다. 프로덕션에서의 부재는 assertServerEnv()가 부팅 시 잡는다.
 * ------------------------------------------------------------------ */

/** 값이 있다면 공백만 있어서는 안 된다. 양끝 공백은 떼어 낸다 */
const secretSchema = z.string().trim().min(1);

/** 긴급 차단 스위치는 true/false 둘 중 하나여야 한다 */
const serviceEnabledSchema = z.enum(["true", "false"]);

/** 프로덕션에서 반드시 있어야 하는 서버 전용 변수 (TRD 7번 환경변수 표) */
const REQUIRED_IN_PRODUCTION = [
  "ANTHROPIC_API_KEY",
  "ALADIN_TTB_KEY",
  "BOOK_PROOF_SECRET",
] as const;

/**
 * 검증 실패를 알린다.
 *
 * **메시지에 값을 절대 넣지 않는다.** 변수 이름만 적는다 — 검증 에러 메시지는
 * 시크릿이 로그로 새는 가장 흔한 경로다 (TRD 6.5).
 */
function invalidEnvError(name: string, expectation: string): Error {
  return new Error(`${name} 환경변수 값이 올바르지 않습니다. ${expectation}`);
}

/**
 * 서버 전용 문자열 변수를 읽는다.
 * 부재(미설정·빈 문자열)는 null, 형식이 틀린 값은 예외.
 */
function readOptionalSecret(name: (typeof REQUIRED_IN_PRODUCTION)[number]): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return null;
  }

  const parsed = secretSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalidEnvError(name, "공백만 있는 값은 쓸 수 없습니다. 비워 두거나 실제 값을 넣으세요.");
  }
  return parsed.data;
}

/**
 * Claude API 키. 없으면 null — services/가 목업 픽스처로 동작한다 (TRD 9번).
 * 서버 전용이므로 절대 NEXT_PUBLIC_ 접두사를 붙이지 않는다 (TRD 6.5).
 */
export function getAnthropicApiKey(): string | null {
  return readOptionalSecret("ANTHROPIC_API_KEY");
}

/** 알라딘 OpenAPI TTB 키. 없으면 null — 위와 같다 */
export function getAladinTtbKey(): string | null {
  return readOptionalSecret("ALADIN_TTB_KEY");
}

/**
 * 긴급 차단 스위치 (TRD 7번). 미설정이면 활성(true).
 * true/false가 아닌 값은 거부한다 — 오타 하나로 차단 스위치가 조용히
 * 죽으면, 사고 시 재배포 없이 끌 수 있어야 한다는 전제가 무너진다.
 */
export function isServiceEnabled(): boolean {
  const raw = process.env.SERVICE_ENABLED;
  if (raw === undefined || raw === "") {
    return true;
  }

  const parsed = serviceEnabledSchema.safeParse(raw.trim().toLowerCase());
  if (!parsed.success) {
    throw invalidEnvError("SERVICE_ENABLED", '"true" 또는 "false"만 쓸 수 있습니다.');
  }
  return parsed.data === "true";
}

/**
 * 서버 진입점이 부팅 시 한 번 호출한다.
 *
 * - 프로덕션: 필수 키가 하나라도 없으면 **던진다.** 조용한 폴백을 남기면 키가
 *   빠진 채로 배포돼도 첫 사용자 요청에서야 드러난다 (TRD 7번).
 * - 그 외 환경: 경고만 남기고 통과시킨다. 로컬에서 키 없이도 전 구간을 돌릴 수
 *   있어야 한다는 목업 모드 원칙(TRD 9번) 때문이다.
 * - 환경과 무관하게 **형식이 틀린 값**은 어디서든 거부한다.
 */
export function assertServerEnv(): void {
  const missing: string[] = [];

  for (const name of REQUIRED_IN_PRODUCTION) {
    // 형식 검증은 환경과 무관하게 수행한다. 틀린 값은 여기서 던진다.
    if (readOptionalSecret(name) === null) {
      missing.push(name);
    }
  }

  // SERVICE_ENABLED도 부팅 시 함께 본다. 값이 틀렸다면 여기서 던진다.
  isServiceEnabled();

  if (missing.length === 0) {
    return;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `프로덕션에 필요한 서버 환경변수가 없습니다: ${missing.join(", ")}. Vercel 환경변수에 설정하세요 (TRD 7번).`,
    );
  }

  console.warn(
    `[env] 서버 환경변수가 비어 있어 목업 모드로 동작합니다: ${missing.join(", ")}. 프로덕션에서는 필수입니다.`,
  );
}
