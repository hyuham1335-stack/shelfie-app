/**
 * 외부에서 들어오는 모든 값의 검증 경계 (TR-002).
 *
 * HTTP 요청 본문, Claude 응답, 알라딘 응답은 전부 이 파일의 스키마를 통과한 뒤에만
 * 도메인 값으로 취급한다. 실패는 예외가 아니라 판별 가능한 값이므로 호출부는
 * `parse`가 아니라 `safeParse`를 쓴다 (/docs/ARCHITECTURE.md 검증 경계 패턴).
 *
 * 타입은 이 파일에서만 파생한다. `types/`는 `z.infer` 재수출만 하고
 * 인터페이스를 다시 선언하지 않는다 — 중복 정의가 곧 계약 어긋남이다.
 */
import { z } from "zod";
import {
  MAX_ALADIN_CANDIDATES,
  MAX_CANDIDATES_PER_PHOTO,
  MAX_IDENTIFIED_BOOKS,
  MAX_IRRELEVANT_STREAK,
  MAX_PHOTOS,
  MAX_RECOMMENDATIONS,
  MAX_RETRY_INDEX,
  MAX_UNIDENTIFIED_BOOKS,
} from "./env";

/* ------------------------------------------------------------------ *
 * 원시 값
 * ------------------------------------------------------------------ */

/**
 * 13자리 숫자. 중복 제거 키이자 추천 화이트리스트의 유일한 식별자다.
 * 이 값이 없는 알라딘 레코드는 확인된 책으로 승격하지 않는다 (ADR-002).
 */
export const isbn13Schema = z.string().regex(/^\d{13}$/);

/**
 * 이벤트 로그에서 한 세션의 요청을 묶는 상관관계 ID.
 * UUID v4로 강제하지 않는다 — API_SPEC 공통 규약이 "서버는 이 값을 신뢰하거나
 * 검증하지 않는다"고 정했다. 형식이 틀렸다고 400을 내면 분석 요청 자체가
 * 로깅용 값 하나 때문에 실패한다.
 */
export const sessionIdSchema = z.string().min(1).max(64);

/** 0-based 사진 인덱스. 장수 상한 안에 있어야 한다 */
export const photoIndexSchema = z.number().int().min(0).max(MAX_PHOTOS - 1);

/** 판독 자체에 대한 모델의 확신도 */
export const confidenceSchema = z.number().min(0).max(1);

/** 절대 URL. 표지 도메인 제한은 next.config.ts가 담당하므로 여기서 중복 검사하지 않는다 */
export const absoluteUrlSchema = z.string().url();

/**
 * base64 데이터 URI. jpeg·png·webp만 받는다 (UNSUPPORTED_IMAGE_TYPE).
 * MIME 화이트리스트를 스키마에 두면 라우트 핸들러가 클라이언트 검증을
 * 신뢰하지 않고 서버에서 다시 확인한다는 규칙이 코드로 강제된다 (TRD 6.5).
 */
export const imageDataUriSchema = z
  .string()
  .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/);

/** 사진에서 읽힌 원문·제목의 공통 길이 제약 */
const shortTextSchema = z.string().min(1).max(200);

/** 0 이상의 정수 카운터 */
const countSchema = z.number().int().min(0);

/* ------------------------------------------------------------------ *
 * 도메인 — 아래에서 위로 조립한다.
 * 필드를 두 번 적지 않기 위해 상위 스키마는 .extend()/.pick()으로만 만든다.
 * ------------------------------------------------------------------ */

/** 알라딘 검색 결과 1건. 사용자에게 후보로 제시하는 최소 정보 */
export const aladinCandidateSchema = z.object({
  isbn13: isbn13Schema,
  title: shortTextSchema,
  author: z.string().min(1),
  publisher: z.string().min(1),
  coverUrl: absoluteUrlSchema,
});

/**
 * 알라딘 원본 사실만 모은 층. 이 경계가 타입에 드러나 있어야
 * 화면에서 사실과 Claude 해석을 다른 시각 층위로 렌더할 수 있다 (ADR-002).
 */
export const aladinFactsSchema = aladinCandidateSchema.extend({
  pages: z.number().int().positive().nullable(),
  aladinRating: z.number().min(0).max(10).nullable(),
  aladinLink: absoluteUrlSchema,
});

/**
 * 알라딘 대조를 통과한 책. 알라딘 사실 + Claude 생성 한줄평 + 서버 서명.
 * `proof`는 이 판정이 요청 경계를 넘어도 위조를 판별하게 해 준다 (ADR-006).
 */
export const identifiedBookSchema = aladinFactsSchema.extend({
  claudeNote: z.string().max(60),
  photoIndex: photoIndexSchema,
  proof: z.string().min(1),
});

/** /api/books/resolve가 돌려주는 후보. 확인된 책과 동등한 증명을 갖는다 */
export const resolvedCandidateSchema = aladinFactsSchema.extend({
  proof: z.string().min(1),
});

/**
 * 미확인 사유 4종. 서로 겹치지 않는다 (ADR-005).
 * - unreadable   : 책등 판독 자체가 불완전 (우리 쪽 인식 한계)
 * - no_match     : 알라딘에 정말 없음 (원서·절판·독립출판)
 * - ambiguous    : 유사 후보가 둘 이상이라 하나로 좁히지 못함
 * - lookup_failed: 알라딘을 조회하지 못함 — 데이터가 아니라 시스템 문제
 */
export const unidentifiedReasonSchema = z.enum([
  "unreadable",
  "no_match",
  "ambiguous",
  "lookup_failed",
]);

/** 확인에 실패한 책. 숨기지 않고 사유와 함께 그대로 노출한다 */
export const unidentifiedBookSchema = z
  .object({
    rawText: shortTextSchema,
    reason: unidentifiedReasonSchema,
    candidates: z.array(aladinCandidateSchema).max(MAX_ALADIN_CANDIDATES),
  })
  .refine(
    (book) => book.reason === "ambiguous" || book.candidates.length === 0,
    // ambiguous가 아닌데 후보가 붙어 있으면 화면이 "왜 빠졌는지"를 잘못 설명하게 된다.
    { message: "candidates는 reason이 ambiguous일 때만 채운다", path: ["candidates"] },
  );

/** Claude가 사진 한 장에서 돌려주는 후보. photoIndex가 없다 — 사진 인덱스는 서버가 붙인다 */
export const extractedCandidateFromModelSchema = z.object({
  rawText: shortTextSchema,
  title: shortTextSchema,
  author: z.string().min(1).max(200).nullable(),
  confidence: confidenceSchema,
});

/** 서버가 사진 인덱스를 붙인 뒤의 후보 */
export const extractedCandidateSchema = extractedCandidateFromModelSchema.extend({
  photoIndex: photoIndexSchema,
});

/**
 * 사진 1장에 대한 Claude 추출 응답.
 * 상한을 스키마에 두는 이유는 모델이 후보를 대량으로 쏟아냈을 때
 * 알라딘 호출이 증폭되는 것을 파싱 단계에서 끊기 위해서다 (TR-003).
 */
export const extractionResultSchema = z.object({
  candidates: z.array(extractedCandidateFromModelSchema).max(MAX_CANDIDATES_PER_PHOTO),
});

/** 추천 1건. bookId는 반드시 요청 목록의 isbn13 중 하나여야 한다 (FR-009) */
export const recommendationSchema = z.object({
  bookId: isbn13Schema,
  reason: z.string().min(20).max(200),
  position: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

/** 기분을 모를 때 제시하는 유도 질문 (US-004) */
export const moodQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(10).max(60),
  options: z.array(z.string().min(1)).min(3).max(4),
});

/* ------------------------------------------------------------------ *
 * API 계약 — /docs/API_SPEC.md가 단일 출처다
 * ------------------------------------------------------------------ */

export const analyzeRequestSchema = z.object({
  sessionId: sessionIdSchema,
  images: z.array(imageDataUriSchema).min(1).max(MAX_PHOTOS),
});

export const analyzeResponseSchema = z.object({
  sessionId: sessionIdSchema,
  identified: z.array(identifiedBookSchema).max(MAX_IDENTIFIED_BOOKS),
  unidentified: z.array(unidentifiedBookSchema).max(MAX_UNIDENTIFIED_BOOKS),
  overflowCount: countSchema,
  unidentifiedOverflowCount: countSchema,
  failedPhotoCount: countSchema,
  failedPhotoIndexes: z.array(photoIndexSchema),
});

export const resolveRequestSchema = z.object({
  sessionId: sessionIdSchema,
  query: shortTextSchema,
  author: z.string().min(1).max(200).nullable().optional(),
});

export const resolveResponseSchema = z.object({
  candidates: z.array(resolvedCandidateSchema).max(MAX_ALADIN_CANDIDATES),
});

/**
 * 요청에 실어 보내는 확인된 책의 최소 형태.
 * `proof`가 빠지면 서버는 이 목록이 자기가 내준 것인지 알 수 없다 (ADR-006).
 */
export const bookReferenceSchema = identifiedBookSchema.pick({
  isbn13: true,
  title: true,
  author: true,
  proof: true,
});

export const moodQuestionsRequestSchema = z.object({
  sessionId: sessionIdSchema,
  books: z.array(bookReferenceSchema).min(1).max(MAX_IDENTIFIED_BOOKS),
});

export const moodQuestionsResponseSchema = z
  .object({
    questions: z.array(moodQuestionSchema).max(3),
  })
  .refine(
    // 생성 실패·모델 장애는 빈 배열로 흡수하고 클라이언트가 자유 입력으로 폴백한다.
    // 질문이 딱 1개인 응답은 문답 화면을 성립시키지 못하므로 유효한 상태가 아니다.
    (value) => value.questions.length === 0 || value.questions.length >= 2,
    { message: "questions는 0개(폴백) 또는 2~3개다", path: ["questions"] },
  );

export const recommendBookSchema = identifiedBookSchema.pick({
  isbn13: true,
  title: true,
  author: true,
  pages: true,
  claudeNote: true,
  proof: true,
});

/**
 * 추천 요청.
 *
 * `retryIndex`·`irrelevantStreak`는 **옵셔널도 기본값도 아니다.** 기본값을 주면
 * "보내지 않았다"와 "0이다"가 구분되지 않고, 클라이언트가 배선을 잊어도 지표가
 * 조용히 0으로 채워진다 — `mood_submitted.retry_index`가 언제나 0이던 원인이
 * 정확히 그것이다. 버저닝이 없고 클라이언트와 서버가 같은 배포 단위라 버전
 * 스큐가 없으므로 필수로 두는 비용도 없다 (API_SPEC /api/recommend).
 *
 * 두 값에 `proof` 서명을 붙이지 않는다. 서명은 **사실인 척할 수 있는 값**(책)에만
 * 붙는다 — 이 둘은 위조해도 얻는 것이 원래 허용된 동작 하나뿐이고, 전부 서명하면
 * 무상태 설계가 세션 상태를 서버로 되가져오는 방향으로 밀린다 (ADR-006).
 */
export const recommendRequestSchema = z.object({
  sessionId: sessionIdSchema,
  books: z.array(recommendBookSchema).min(1).max(MAX_IDENTIFIED_BOOKS),
  mood: z.string().min(2).max(500),
  inputMode: z.enum(["free_text", "guided"]),
  /** "다시 추천받기" 횟수. `mood_submitted.retry_index`가 되는 값 (FR-010) */
  retryIndex: z.number().int().min(0).max(MAX_RETRY_INDEX),
  /** 직전까지 **연속으로** 받은 `IRRELEVANT_MOOD` 횟수. 무상태라 화면이 센다 */
  irrelevantStreak: z.number().int().min(0).max(MAX_IRRELEVANT_STREAK),
});

export const recommendResponseSchema = z.object({
  recommendations: z.array(recommendationSchema).max(MAX_RECOMMENDATIONS),
  shortfall: z.boolean(),
});

/**
 * 클라이언트에서만 관측 가능한 이벤트 2종.
 * 나머지는 서버가 직접 관측하므로 이 경로로 받지 않는다 (TR-014).
 *
 * **`recommend_viewed`는 여기 없다.** 추천 수락률의 분모는
 * `app/api/recommend/route.ts`가 응답 직전에 서버에서 남기며, 이 경로로도 받으면
 * 같은 조회가 두 번 집계된다. 보내는 클라이언트가 없다는 것과 받을 수 있다는
 * 것은 다른 문제다 (API_SPEC /api/events).
 */
export const clientEventSchema = z.enum([
  "recommend_accepted",
  "book_resolved",
]);

export const eventsRequestSchema = z.object({
  sessionId: sessionIdSchema,
  event: clientEventSchema,
  // 원시값만 받는다. 임의의 객체를 그대로 로그에 쓰면 PII가 흘러들어올 수 있다.
  properties: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const eventsResponseSchema = z.object({
  accepted: z.literal(true),
});

/* ------------------------------------------------------------------ *
 * 에러 규약
 * ------------------------------------------------------------------ */

export const errorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "TOO_MANY_PHOTOS",
  "UNSUPPORTED_IMAGE_TYPE",
  "IMAGE_TOO_LARGE",
  "PAYLOAD_TOO_LARGE",
  "EMPTY_SHELF",
  "NOT_FOUND_IN_ALADIN",
  "UNVERIFIED_BOOKS",
  "IRRELEVANT_MOOD",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "RECOMMENDATION_VALIDATION_FAILED",
  "TIMEOUT",
  "SERVICE_DISABLED",
  // 우리 쪽 결함 (500). 502와 뭉개지 않는다 — 우리 응답이 우리 계약을 어긴 것을
  // 502로 내보내면 남의 장애로 기록된다. 사용자에게 보이는 문구가 같은 것과
  // 로그에 남는 원인이 같은 것은 다른 문제다 (API_SPEC 에러 응답 규약).
  "INTERNAL_ERROR",
]);

/**
 * 모든 에러 응답의 형태. `requestId`는 선택이 아니다 —
 * 사용자가 화면에서 읽어 신고한 ID로 서버 로그를 바로 찾을 수 있어야 한다 (TRD 6.4).
 */
export const errorResponseSchema = z.object({
  error: z.string().min(1),
  code: errorCodeSchema,
  requestId: z.string().min(1),
});
