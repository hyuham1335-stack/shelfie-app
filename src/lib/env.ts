/**
 * 환경 상수와 서버 환경변수 검증.
 * 값의 근거는 /docs/TRD.md 7번(환경변수)과 /docs/PRD.md 4번(FR-001, FR-005)에 있다.
 */
import { z } from "zod";

/** 모든 Claude 호출의 기본 모델. 환경변수로 배포 없이 교체할 수 있다. */
export const DEFAULT_MODEL = "claude-opus-5";

/** 한 요청에 올릴 수 있는 사진 장수 상한 (FR-001) */
export const MAX_PHOTOS = 5;

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
