/**
 * 환경 상수와 서버 환경변수 검증.
 * 값의 근거는 /docs/TRD.md 7번(환경변수)과 /docs/PRD.md 4번(FR-001, FR-005)에 있다.
 */

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
