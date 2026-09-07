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

/**
 * 알라딘 조회 전 후보 총량 상한. confidence 내림차순으로 자른다 (TR-005).
 *
 * 이 값이 세션당 알라딘 호출 수를 혼자 정한다. 실행 경로에서 축소는 조회
 * **전**에 한 번만 일어나고, 그렇게 남은 후보는 ItemSearch와 ItemLookUp
 * **두 단계**를 그대로 통과한다 — 검색한 것이 전부 조회된다. 그래서 유도식은
 *
 *   MAX_CANDIDATES_FOR_LOOKUP × 2단계 × ALADIN_CALLS_PER_LOOKUP
 *     = 65 × 2 × 2 = 260 ≤ MAX_ALADIN_CALLS_PER_SESSION
 *
 * 이고, 여기에 `MAX_IDENTIFIED_BOOKS`(50)는 들어가지 않는다. 표시 상한 절단은
 * 조회가 **끝난 뒤**에 걸리므로 호출 수를 줄이지 못한다. 두 단계가 같은 수를
 * 받는다는 것이 이 값의 근거이고, 이 값을 올리면 선언(260)이 조용히 깨진다.
 */
export const MAX_CANDIDATES_FOR_LOOKUP = 65;

/**
 * 한 요청(세션 1회 분석)이 알라딘에 낼 수 있는 호출 수의 **상한** (TRD 10번).
 *
 * 이것은 **선언**이다 — 우리가 알라딘 일일 한도(5,000회)에 대해 감수하기로 한
 * 세션당 최악값이고, 이 값에서 "하루 약 19세션"이라는 실질 상한이 나온다.
 * 현재 구성이 실제로 내는 값(유도값)은 아래 상수들에서 계산되며, **유도값이 이
 * 선언을 넘지 않는지는 상수가 아니라 회귀 테스트가 잠근다**(`merge.test.ts`).
 * 260을 손으로 적은 상수와 계산한 상수를 둘 다 두면 한쪽만 고쳐지는 날이 온다.
 */
export const MAX_ALADIN_CALLS_PER_SESSION = 260;

/**
 * 조회 한 건이 낼 수 있는 최대 HTTP 호출 수 — ItemSearch/ItemLookUp 각각의 재시도 포함.
 *
 * `services/aladin.ts`의 `requestWithRetry`가 호출 1회 + 5xx·타임아웃일 때의
 * 조건부 재시도 1회로 끝나므로 2다. 재시도 정책이 바뀌면 이 값도 함께 바뀌어야
 * 하고, 그러면 아래 유도값이 상한을 넘는지 테스트가 즉시 알려 준다.
 */
export const ALADIN_CALLS_PER_LOOKUP = 2;

/** 사용자에게 제시하는 알라딘 후보 수. ambiguous 후보와 resolve 결과에 같은 값을 쓴다 (API_SPEC) */
export const MAX_ALADIN_CANDIDATES = 5;

/** 한 번에 추천하는 책 수 (FR-006) */
export const MAX_RECOMMENDATIONS = 3;

/**
 * 분석 재시도의 **간격 스케줄** (FR-010: "세션당 3회(간격 0초 → 5초 → 15초)").
 *
 * PRD 한 줄과 눈으로 대조되도록 조건문 사다리가 아니라 **값**으로 둔다. 재시도
 * 회차(0-based)를 그대로 인덱스로 쓴다 — 첫 재시도는 0초라 즉시 나가고, 그
 * 다음부터 벌어진다.
 *
 * 간격이 있는 이유는 남용 방어가 아니다. 업스트림 5xx·타임아웃에서 **즉시 재시도는
 * 같은 실패를 부르고 모델 비용만 새로 든다**(FR-010). 벌려 두면 그 사이에 상황이
 * 바뀔 여지가 생긴다.
 */
export const ANALYZE_RETRY_DELAYS_MS = [0, 5_000, 15_000] as const;

/**
 * 분석 재시도 상한 (FR-010).
 *
 * **스케줄 길이가 곧 상한이다.** 둘을 따로 적으면 갈라질 수 있고, 갈라지는 순간
 * 마지막 재시도의 간격이 `undefined`가 된다. 그래서 별도 리터럴을 두지 않고
 * 스케줄에서 유도한다.
 */
export const MAX_ANALYZE_RETRIES: number = ANALYZE_RETRY_DELAYS_MS.length;

/**
 * `retryIndex`의 상한. FR-010의 "세션당 5회"를 0-based로 센 값이다.
 * 넘겨 보내면 400이므로 요청을 조립하는 화면이 이 값으로 클램프한다.
 */
export const MAX_RETRY_INDEX = 4;

/**
 * `irrelevantStreak`의 상한. 2회 연속 무관 판정이면 서버가 판정을 무시하고
 * 추천을 진행하므로(API_SPEC /api/recommend) 그보다 큰 값에는 의미가 없다.
 */
export const MAX_IRRELEVANT_STREAK = 2;

/**
 * 골든 인식률의 재현율 하한 (TR-003 · ADR-010).
 *
 * 판정 임계값도 도메인 상수다. 골든 쪽에 따로 적어 두면 TRD 8번 판정 규약 표와
 * 코드가 갈라져도 아무도 모른다.
 */
export const GOLDEN_MIN_RECALL = 0.9;

/**
 * 골든 세트에서 허용되는 오확인 건수 (TR-004 · ADR-010).
 * 0이다 — 없는 책을 있다고 보여주는 것이 이 제품의 가장 심각한 결함이다 (ADR-002).
 */
export const GOLDEN_MAX_MISIDENTIFIED = 0;

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
 * 골든 인식률 세트가 있는 리포 밖 디렉토리 (TRD 7번 `GOLDEN_SET_DIR`, ADR-010).
 *
 * 없거나 공백이면 null이다. **던지지 않는다** — 세트가 없는 것은 오류가 아니라
 * skip 사유(`no_set_dir`)다. 여기서 던지면 세트를 갖지 않은 개발자의 로컬에서
 * 골든 테스트가 빨간불이 되고, 그러면 아무도 안 돌리게 된다 (TRD 8번 skip 표).
 *
 * 이 값을 읽는 것은 테스트뿐이다. 프로덕션 코드는 골든 세트를 모른다.
 */
export function getGoldenSetDir(): string | null {
  const raw = process.env.GOLDEN_SET_DIR;
  if (raw === undefined) {
    return null;
  }

  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
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
