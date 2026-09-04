/**
 * API 요청·응답·에러 타입. `lib/schemas.ts`에서 파생하며 클라이언트와 공유한다 (TR-002).
 * 계약의 단일 출처는 /docs/API_SPEC.md이고, 이 파일은 그것을 타입으로 옮긴 결과다.
 *
 * `export type`만 내보내므로 런타임 코드가 남지 않는다.
 */
import type { z } from "zod";
import type {
  analyzeRequestSchema,
  analyzeResponseSchema,
  clientEventSchema,
  errorCodeSchema,
  errorResponseSchema,
  eventsRequestSchema,
  eventsResponseSchema,
  moodQuestionSchema,
  moodQuestionsRequestSchema,
  moodQuestionsResponseSchema,
  recommendRequestSchema,
  recommendResponseSchema,
  recommendationSchema,
  resolveRequestSchema,
  resolveResponseSchema,
} from "@/lib/schemas";

/** POST /api/analyze */
export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;
export type AnalyzeResponse = z.infer<typeof analyzeResponseSchema>;

/** POST /api/books/resolve */
export type ResolveRequest = z.infer<typeof resolveRequestSchema>;
export type ResolveResponse = z.infer<typeof resolveResponseSchema>;

/** POST /api/mood/questions */
export type MoodQuestionsRequest = z.infer<typeof moodQuestionsRequestSchema>;
export type MoodQuestionsResponse = z.infer<typeof moodQuestionsResponseSchema>;
export type MoodQuestion = z.infer<typeof moodQuestionSchema>;

/** POST /api/recommend */
export type RecommendRequest = z.infer<typeof recommendRequestSchema>;
export type RecommendResponse = z.infer<typeof recommendResponseSchema>;
export type Recommendation = z.infer<typeof recommendationSchema>;

/** POST /api/events */
export type EventsRequest = z.infer<typeof eventsRequestSchema>;
export type EventsResponse = z.infer<typeof eventsResponseSchema>;
export type ClientEvent = z.infer<typeof clientEventSchema>;

/** 에러 규약 */
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * 클라이언트만 쓰는 실패 어휘.
 *
 * `OFFLINE`은 **서버가 낼 수 없는 값이라 서버 응답 어휘(`errorCodeSchema`)에 넣지
 * 않는다.** 단절은 요청이 서버에 닿지 못한 사실이므로 매길 HTTP 상태가 없고,
 * `lib/api-client`가 돌려주는 `status: 0`이 바로 그 사실이다 — 응답을 하나도
 * 받지 못했다는 뜻이다. 서버 어휘에 섞으면 `/docs/API_SPEC.md`가 서버가 결코
 * 보내지 않는 코드를 계약으로 약속하게 된다.
 *
 * 화면과 상태 머신은 이쪽을 쓰고, 응답 본문을 파싱하는 자리는 `ErrorCode`를 쓴다.
 */
export type ClientErrorCode = ErrorCode | "OFFLINE";
