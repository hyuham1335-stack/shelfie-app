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
