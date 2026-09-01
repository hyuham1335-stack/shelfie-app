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

/** 책등 추출에 쓸 모델 ID */
export function getExtractModel(): string {
  return process.env.MODEL_EXTRACT ?? DEFAULT_MODEL;
}

/** 한줄평·추천·문답 생성에 쓸 모델 ID */
export function getRecommendModel(): string {
  return process.env.MODEL_RECOMMEND ?? DEFAULT_MODEL;
}
