/**
 * 도메인 타입. 전부 `lib/schemas.ts`의 zod 스키마에서 파생한다 (TR-002).
 *
 * 인터페이스를 손으로 다시 선언하지 않는다 — 스키마와 타입이 따로 관리되는 순간
 * 런타임 검증과 컴파일 타임 계약이 어긋나고, 그 어긋남은 아무 테스트도 잡지 못한다.
 *
 * 이 파일은 `export type`만 내보내므로 런타임 코드가 남지 않는다.
 * `types/` → `lib/` 방향은 타입 전용 의존이며 /docs/ARCHITECTURE.md에 명시돼 있다.
 */
import type { z } from "zod";
import type {
  aladinCandidateSchema,
  aladinFactsSchema,
  bookReferenceSchema,
  extractedCandidateFromModelSchema,
  extractedCandidateSchema,
  extractionResultSchema,
  identifiedBookSchema,
  recommendBookSchema,
  resolvedCandidateSchema,
  unidentifiedBookSchema,
  unidentifiedReasonSchema,
} from "@/lib/schemas";

/** Claude가 사진에서 읽어낸 원시 후보. 아직 사실로 취급하지 않는다 */
export type ExtractedCandidateFromModel = z.infer<typeof extractedCandidateFromModelSchema>;

/** 서버가 사진 인덱스를 붙인 뒤의 후보 */
export type ExtractedCandidate = z.infer<typeof extractedCandidateSchema>;

/** 사진 1장에 대한 추출 응답 (사진당 60건 상한) */
export type ExtractionResult = z.infer<typeof extractionResultSchema>;

/** 알라딘 검색 결과 1건 */
export type AladinCandidate = z.infer<typeof aladinCandidateSchema>;

/** 알라딘 원본 사실만 모은 층 — Claude 생성물이 섞이지 않은 경계 (ADR-002) */
export type AladinFacts = z.infer<typeof aladinFactsSchema>;

/** 알라딘 대조를 통과한 책 */
export type IdentifiedBook = z.infer<typeof identifiedBookSchema>;

/** /api/books/resolve가 돌려주는 후보 — 확인된 책과 동등한 증명을 갖는다 */
export type ResolvedCandidate = z.infer<typeof resolvedCandidateSchema>;

/** 확인에 실패한 책 */
export type UnidentifiedBook = z.infer<typeof unidentifiedBookSchema>;

/** 미확인 사유 4종 (ADR-005) */
export type UnidentifiedReason = z.infer<typeof unidentifiedReasonSchema>;

/** 요청에 실어 보내는 확인된 책의 최소 형태 (mood/questions) */
export type BookReference = z.infer<typeof bookReferenceSchema>;

/** 추천 요청에 실어 보내는 확인된 책 */
export type RecommendBook = z.infer<typeof recommendBookSchema>;
