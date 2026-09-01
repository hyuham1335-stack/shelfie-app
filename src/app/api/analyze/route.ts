/**
 * POST /api/analyze — 책장 사진에서 책을 뽑아 알라딘과 대조한다 (TR-006, US-001).
 *
 * ## 이 파일이 하는 일과 하지 않는 일
 * 여기서 하는 것은 **순서를 정하고 값을 나르는 일**뿐이다. 판정(`lib/match`),
 * 상한·중복 제거(`lib/merge`), 예산 계산(`lib/budget`), 서명(`lib/proof`),
 * 네트워크(`services/`)는 전부 이미 만들어져 있고 여기서 다시 구현하지 않는다.
 * 두 벌이 되는 순간 판정 기준이 소리 없이 갈리기 때문이다 (/docs/ARCHITECTURE.md).
 *
 * ## 실패는 요청을 죽이지 않는다 (fail-soft)
 * 사진 한 장이 실패해도, 알라딘이 멈춰도, 한줄평을 못 만들어도 200이다.
 * 502는 **전 사진의 추출이 실패**했을 때뿐이고, 404는 **추출 후보 자체가
 * 0건**일 때뿐이다. 후보는 있는데 확인이 0건인 것은 `EMPTY_SHELF`가 아니다 —
 * 그렇게 응답하면 알라딘이 죽었을 뿐인데 사용자에게 "책이 하나도 없네요"라고
 * 말하게 되고, 이는 시스템 문제를 데이터 문제로 설명하는 것이다 (ADR-005).
 *
 * ## 시간은 예산이다
 * 단계마다 독립된 타임아웃을 두지 않는다. 합이 함수 상한(60s)을 넘기면 플랫폼이
 * 연결을 끊어 API_SPEC이 정의한 504조차 돌려주지 못한다. 총 예산 55s를
 * `lib/budget`이 단계로 쪼개고, 각 단계는 `min(단계 예산, 남은 예산)`만 쓴다.
 * 예산을 넘긴 단계는 요청이 아니라 **그 단계의 산출물만** 강등한다 (ADR-005).
 *
 * ## 상태를 남기지 않는다 (ADR-003)
 * 파일·전역 변수·쿠키 어디에도 쓰지 않는다. 요청 스코프 서킷 브레이커도
 * 요청마다 새로 만들어 요청이 끝나면 사라진다.
 */
import { randomUUID } from "node:crypto";

import { logEvent, type AnalyticsEvent, type UnidentifiedReasonCounts } from "@/lib/analytics";
import { createBudget } from "@/lib/budget";
import {
  isServiceEnabled,
  MAX_OUTPUT_BYTES_PER_IMAGE,
  MAX_OUTPUT_BYTES_TOTAL,
} from "@/lib/env";
import { judge } from "@/lib/match";
import { capIdentified, capUnidentified, dedupeByIsbn, reduceBeforeLookup } from "@/lib/merge";
import { issueProof } from "@/lib/proof";
import { analyzeRequestSchema, analyzeResponseSchema } from "@/lib/schemas";
import { createRequestBreaker, lookupFactsMany, searchMany } from "@/services/aladin";
import { extractFromPhoto, generateNotes } from "@/services/anthropic";
import type { AnalyzeResponse, ErrorCode } from "@/types/api";
import type { AladinCandidate, ExtractedCandidate, IdentifiedBook, UnidentifiedBook } from "@/types/book";

/** `lib/proof.ts`가 Node 내장 `crypto`를 쓴다. Edge에서는 동작하지 않는다 (TRD 2번) */
export const runtime = "nodejs";

/** Vercel 함수 실행 상한 60초. `lib/budget`의 총 예산 55s가 여기서 파생된다 (TRD 7번·9번) */
export const maxDuration = 60;

/**
 * 데이터 URI 1건과 요청 전체의 전송 크기 상한 (FR-002, API_SPEC 공통 규약).
 *
 * 값은 `lib/env.ts` 하나에서 온다. 클라이언트 검증을 신뢰하지 않고 서버에서
 * **다시 재는 것**이 규칙이지만(TRD 6.5), 재는 일이 두 곳인 것과 값이 두 벌인
 * 것은 다르다 — 값이 갈리면 클라이언트가 통과시킨 요청을 서버가 거부하는
 * 조합이 조용히 생긴다. 브라우저 전용인 `lib/image.ts`에서 가져오지 않는
 * 이유는 그 모듈이 Canvas·FileReader를 쓰기 때문이다(/docs/ARCHITECTURE.md).
 *
 * data URI는 정의상 ASCII이므로 문자 수가 곧 바이트 수다.
 */

/** 사용자에게 그대로 보이는 문구. 모델 생성물·내부 원문은 절대 쓰지 않는다 (API_SPEC) */
const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_REQUEST: "요청을 처리할 수 없어요. 사진을 다시 선택해 주세요.",
  TOO_MANY_PHOTOS: "최대 5장까지 올릴 수 있어요.",
  UNSUPPORTED_IMAGE_TYPE: "JPG·PNG·WEBP 사진만 올릴 수 있어요.",
  IMAGE_TOO_LARGE: "사진 한 장이 너무 커요. 사진을 줄여서 다시 시도해 주세요.",
  PAYLOAD_TOO_LARGE: "사진 용량이 너무 커요. 장수를 줄이거나 화질을 낮춰 주세요.",
  EMPTY_SHELF: "책등이 보이도록 다시 찍어 주세요.",
  NOT_FOUND_IN_ALADIN: "알라딘에서 찾을 수 없는 책이에요.",
  UNVERIFIED_BOOKS: "책 정보를 다시 확인해야 해요. 사진을 다시 분석해 주세요.",
  IRRELEVANT_MOOD: "책 고르는 데 참고할 내용을 적어 주세요.",
  RATE_LIMITED: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.",
  UPSTREAM_UNAVAILABLE: "지금 책을 확인할 수 없어요. 잠시 후 다시 시도해 주세요.",
  RECOMMENDATION_VALIDATION_FAILED: "추천을 만들지 못했어요. 잠시 후 다시 시도해 주세요.",
  TIMEOUT: "시간이 오래 걸려 중단했어요. 사진 장수를 줄여 다시 시도해 주세요.",
  SERVICE_DISABLED: "점검 중이에요. 잠시 후 다시 찾아와 주세요.",
  // 502와 같은 문구를 쓴다. 사용자가 할 수 있는 일이 같기 때문이고, 원인을
  // 구분해야 하는 자리는 응답이 아니라 로그다 (API_SPEC).
  INTERNAL_ERROR: "문제가 생겨 중단했어요. 잠시 후 다시 시도해 주세요.",
};

/** `sessionId`를 읽기 전에 실패했을 때 로그에 쓰는 값 (API_SPEC 인증 절) */
const UNKNOWN_SESSION = "invalid";

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  // 예산은 **가장 먼저** 연다. 본문을 읽는 시간도 총 예산 안에서 흐른다.
  const budget = createBudget();

  if (!serviceEnabled()) {
    // 외부 호출을 하지 않으므로 비용이 발생하지 않는다 (TRD 7번 긴급 차단 스위치).
    return errorResponse(503, "SERVICE_DISABLED", requestId);
  }

  const parsedRequest = await readRequest(request);
  if (!parsedRequest.ok) {
    record({
      event: "analyze_failed",
      session_id: parsedRequest.sessionId,
      error_code: parsedRequest.code,
      failed_photo_count: 0,
    });
    return errorResponse(parsedRequest.status, parsedRequest.code, requestId);
  }

  const { sessionId, images } = parsedRequest.value;
  record({ event: "photo_uploaded", session_id: sessionId, photo_count: images.length });

  const usage = { input_tokens: 0, output_tokens: 0 };

  /* --- 1단계: 책등 추출 (사진별 병렬, 예산 30s) ------------------- */

  // 데드라인은 단계 시작 시점에 한 번 계산한다. 사진들이 병렬이므로 같은 값을 나눠 쓴다.
  const extractDeadlineMs = budget.deadlineFor("extract");
  const extractions = await Promise.all(
    images.map((image, photoIndex) =>
      extractFromPhoto(image, { deadlineMs: extractDeadlineMs, photoIndex }),
    ),
  );

  const candidates: ExtractedCandidate[] = [];
  const failedPhotoIndexes: number[] = [];

  extractions.forEach((outcome, photoIndex) => {
    // 실패한 호출도 응답이 돌아왔다면 토큰은 이미 과금됐다. 빼면 비용이 낮게 집계된다.
    addUsage(usage, outcome.usage);
    if (outcome.status === "ok") candidates.push(...outcome.candidates);
    else failedPhotoIndexes.push(photoIndex);
  });

  if (failedPhotoIndexes.length === images.length) {
    // 전 사진 실패일 때만 502다. 한 장이라도 살아 있으면 그 결과를 돌려준다.
    record({
      event: "analyze_failed",
      session_id: sessionId,
      error_code: "UPSTREAM_UNAVAILABLE",
      failed_photo_count: failedPhotoIndexes.length,
    });
    return errorResponse(502, "UPSTREAM_UNAVAILABLE", requestId);
  }

  if (candidates.length === 0) {
    // **추출 후보 자체가 0건**일 때만 EMPTY_SHELF다 (API_SPEC).
    record({
      event: "analyze_failed",
      session_id: sessionId,
      error_code: "EMPTY_SHELF",
      failed_photo_count: failedPhotoIndexes.length,
    });
    return errorResponse(404, "EMPTY_SHELF", requestId);
  }

  /* --- 2단계: 알라딘 대조 (동시성 12, 예산 12s) ------------------- */

  // 조회 **전**에 줄인다. 확신도 하한과 80건 상한이 여기서 걸리지 않으면
  // 판독 한 번의 이상 동작이 알라딘 일일 한도를 한 요청에 소진시킨다 (FR-012).
  const { toLookup, unreadable } = reduceBeforeLookup(candidates);

  // 브레이커도 데드라인도 **요청 하나**가 ItemSearch와 ItemLookUp에 나눠 준다.
  // 각자 12s를 잡으면 합이 24s가 되어 총 예산이 깨지고, 브레이커를 따로 두면
  // 이미 죽은 알라딘을 두 번 두드린다 (TRD 7번).
  const breaker = createRequestBreaker();
  const lookupDeadlineAt = Date.now() + budget.deadlineFor("lookup");

  const searchOutcomes = await searchMany(
    toLookup.map((candidate) => ({ title: candidate.title, author: candidate.author })),
    { deadlineMs: lookupDeadlineAt - Date.now(), breaker },
  );

  const unidentified: UnidentifiedBook[] = [];
  const promoted: PromotedBook[] = [];

  toLookup.forEach((candidate, index) => {
    const verdict = judge(candidate, searchOutcomes[index]);
    if (verdict.kind === "identified") {
      promoted.push({
        isbn13: verdict.candidate.isbn13,
        photoIndex: candidate.photoIndex,
        rawText: candidate.rawText,
        candidate: verdict.candidate,
      });
      return;
    }
    // 사유는 끝까지 다른 값으로 나른다 — no_match와 lookup_failed는 화면에서 다른 문장이다.
    unidentified.push({
      rawText: candidate.rawText,
      reason: verdict.reason,
      candidates: verdict.candidates,
    });
  });

  // 사실 조회 **전에** ISBN 중복을 없앤다. 같은 책을 두 번 조회하면 알라딘 일일
  // 한도만 축나고 결과는 어차피 같다 (FR-004).
  const uniquePromoted = dedupeByIsbn(promoted);

  const factsOutcomes = await lookupFactsMany(
    uniquePromoted.map((book) => book.isbn13),
    { deadlineMs: lookupDeadlineAt - Date.now(), breaker },
  );

  const identifiedFacts: Omit<IdentifiedBook, "claudeNote" | "proof">[] = [];

  uniquePromoted.forEach((book, index) => {
    const outcome = factsOutcomes[index];
    if (outcome.status !== "ok") {
      // ItemSearch로 찾아낸 책이므로 "알라딘에 없다"고 말할 근거가 없다. 사실을
      // 채우지 못했으니 확인으로도 올리지 않는다 (ADR-002 + ADR-005).
      unidentified.push({ rawText: book.rawText, reason: "lookup_failed", candidates: [] });
      return;
    }

    identifiedFacts.push({
      // 신원 필드는 ItemSearch 후보를 쓴다 — 목업 모드(TTB 키 없음)에서는
      // ItemLookUp이 신원을 만들어 낼 수 없기 때문이다 (services/aladin.ts).
      isbn13: book.candidate.isbn13,
      title: book.candidate.title,
      author: book.candidate.author,
      publisher: book.candidate.publisher,
      coverUrl: book.candidate.coverUrl,
      pages: outcome.facts.pages,
      aladinRating: outcome.facts.aladinRating,
      aladinLink: outcome.facts.aladinLink,
      photoIndex: book.photoIndex,
    });
  });

  // 조회 전에 강등된 후보도 숨기지 않는다. 왜 빠졌는지 보여주는 편이 신뢰를 지킨다.
  for (const candidate of unreadable) {
    unidentified.push({ rawText: candidate.rawText, reason: "unreadable", candidates: [] });
  }

  const { kept: keptIdentified, overflowCount } = capIdentified(identifiedFacts);
  const { kept: keptUnidentified, overflowCount: unidentifiedOverflowCount } =
    capUnidentified(unidentified);

  /* --- 3단계: 한줄평 배치 (1회, 예산 8s) -------------------------- */

  const notes = await collectNotes(keptIdentified, budget, usage);

  /* --- 응답 조립: 확인된 책은 반드시 서명을 달고 나간다 (ADR-006) --- */

  // 한 요청의 서명은 같은 시각을 기준으로 발급한다 — 만료가 책마다 어긋날 이유가 없다.
  const issuedAt = Date.now();
  const identified: IdentifiedBook[] = keptIdentified.map((book) => ({
    ...book,
    claudeNote: notes.get(book.isbn13) ?? "",
    proof: issueProof({ isbn13: book.isbn13, title: book.title, author: book.author }, issuedAt),
  }));

  const body: AnalyzeResponse = {
    sessionId,
    identified,
    unidentified: keptUnidentified,
    overflowCount,
    unidentifiedOverflowCount,
    failedPhotoCount: failedPhotoIndexes.length,
    failedPhotoIndexes,
  };

  // 우리가 만든 응답도 계약을 지키는지 기계로 확인한다. 검증 경계는 들어오는 값에만
  // 있는 것이 아니다 — 여기서 걸리면 계약을 어긴 본문을 사용자에게 보내지 않는다.
  const validated = analyzeResponseSchema.safeParse(body);
  if (!validated.success) {
    // 여기까지 오는 유일한 경로는 `services/`의 검증을 통과한 외부 값이 우리
    // 계약과 어긋나는 경우다. 그것을 502로 내보내면 **우리 결함이 남의 장애로**
    // 기록된다 — 알라딘 장애를 no_match로 적지 않는 것(ADR-005)과 같은 규율이고
    // 방향만 반대다. 500 INTERNAL_ERROR가 이 상황을 왜곡하지 않는 코드다.
    console.error(`[analyze] 응답이 계약 스키마를 어겼습니다 — request_id=${requestId}`);
    record({
      event: "analyze_failed",
      session_id: sessionId,
      error_code: "INTERNAL_ERROR",
      failed_photo_count: failedPhotoIndexes.length,
    });
    return errorResponse(500, "INTERNAL_ERROR", requestId);
  }

  record({
    event: "analyze_completed",
    session_id: sessionId,
    identified_count: identified.length,
    unidentified_count: keptUnidentified.length,
    unidentified_by_reason: countByReason(keptUnidentified),
    overflow_count: overflowCount,
    failed_photo_count: failedPhotoIndexes.length,
    duration_ms: budget.elapsedMs(),
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
  });

  return jsonResponse(200, validated.data, requestId);
}

/* ------------------------------------------------------------------ *
 * 내부 헬퍼
 * ------------------------------------------------------------------ */

/** 확인으로 승격됐지만 아직 서지 사실을 못 채운 중간 상태 */
interface PromotedBook {
  isbn13: string;
  photoIndex: number;
  /** 강등될 경우 사용자에게 보여 줄 원문. 확인으로 끝나면 쓰이지 않는다 */
  rawText: string;
  candidate: AladinCandidate;
}

type RequestOutcome =
  | { ok: true; value: { sessionId: string; images: string[] } }
  | { ok: false; status: number; code: ErrorCode; sessionId: string };

/**
 * 본문을 읽고 서버에서 다시 검증한다. 클라이언트 검증을 신뢰하지 않는다 (TRD 6.5).
 *
 * zod 이슈를 그대로 노출하지 않고 **에러 코드로만** 옮긴다 — 필드 경로와 원본
 * 메시지는 사용자에게 의미가 없고 내부 구조를 흘린다 (API_SPEC 에러 규약).
 */
async function readRequest(request: Request): Promise<RequestOutcome> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, status: 400, code: "INVALID_REQUEST", sessionId: UNKNOWN_SESSION };
  }

  const parsed = analyzeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      code: requestErrorCode(parsed.error.issues),
      sessionId: readSessionId(raw),
    };
  }

  const { sessionId, images } = parsed.data;

  // 크기는 스키마가 보지 않는다(MIME과 개수만 본다). 서버가 직접 잰다.
  if (images.some((image) => image.length > MAX_OUTPUT_BYTES_PER_IMAGE)) {
    return { ok: false, status: 400, code: "IMAGE_TOO_LARGE", sessionId };
  }

  const totalBytes = images.reduce((sum, image) => sum + image.length, 0);
  if (totalBytes > MAX_OUTPUT_BYTES_TOTAL) {
    return { ok: false, status: 413, code: "PAYLOAD_TOO_LARGE", sessionId };
  }

  return { ok: true, value: { sessionId, images } };
}

/** zod 이슈를 에러 코드로 옮긴다. 어떤 조건을 어겼는지만 남기고 경로는 버린다 */
function requestErrorCode(issues: readonly { code: string; path: (string | number)[] }[]): ErrorCode {
  for (const issue of issues) {
    if (issue.path[0] !== "images") continue;
    // path가 ["images"]면 배열 자체(장수), ["images", n]이면 원소(데이터 URI 형식)다.
    if (issue.path.length === 1) {
      if (issue.code === "too_big") return "TOO_MANY_PHOTOS";
      continue;
    }
    return "UNSUPPORTED_IMAGE_TYPE";
  }
  return "INVALID_REQUEST";
}

/**
 * 검증에 실패한 본문에서도 `sessionId`만은 건져 로그를 잇는다.
 * 값을 신뢰하지는 않으므로 길이를 자르고, 형태가 아니면 `invalid`로 치환한다 (API_SPEC).
 */
function readSessionId(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return UNKNOWN_SESSION;
  const value = (raw as { sessionId?: unknown }).sessionId;
  if (typeof value !== "string" || value === "") return UNKNOWN_SESSION;
  return value.slice(0, 64);
}

/**
 * 한줄평을 모은다. 실패도 생략도 결과는 같다 — 그 책의 `claudeNote`가 빈 문자열이다.
 *
 * 남은 예산이 단계 예산(8s)보다 적으면 **호출 자체를 하지 않는다.** 배치 1회
 * 호출이라 절반만 받아 쓸 수 없기 때문이다 (TRD 7번, ADR-005).
 */
async function collectNotes(
  books: readonly Omit<IdentifiedBook, "claudeNote" | "proof">[],
  budget: ReturnType<typeof createBudget>,
  usage: { input_tokens: number; output_tokens: number },
): Promise<Map<string, string>> {
  if (books.length === 0 || budget.isExhaustedFor("note")) return new Map();

  const outcome = await generateNotes(
    books.map((book) => ({ isbn13: book.isbn13, title: book.title, author: book.author })),
    { deadlineMs: budget.deadlineFor("note") },
  );

  if (outcome.status === "ok") {
    addUsage(usage, outcome.usage);
    return outcome.notes;
  }

  if (outcome.status === "failed") addUsage(usage, outcome.usage);
  return new Map();
}

/** 사유별 카운트. 합계로 뭉개면 `lookup_failed`를 가드레일 분자에서 뺄 수 없다 (ADR-005) */
function countByReason(books: readonly UnidentifiedBook[]): UnidentifiedReasonCounts {
  const counts: UnidentifiedReasonCounts = {
    unreadable: 0,
    no_match: 0,
    ambiguous: 0,
    lookup_failed: 0,
  };
  for (const book of books) counts[book.reason] += 1;
  return counts;
}

/** 토큰 누산. `usage`가 없는 실패(호출 자체가 없었거나 응답을 못 받음)는 더할 것이 없다 */
function addUsage(
  total: { input_tokens: number; output_tokens: number },
  used: { input_tokens: number; output_tokens: number } | undefined,
): void {
  if (used === undefined) return;
  total.input_tokens += used.input_tokens;
  total.output_tokens += used.output_tokens;
}

/**
 * 이벤트 기록. `logEvent`는 이미 예외를 삼키지만(TR-012) 그 보장에 기대지 않는다 —
 * 지표 수집이 사용자 화면을 망가뜨리는 일은 이 계층에서도 막혀 있어야 한다.
 */
function record(event: AnalyticsEvent): void {
  try {
    logEvent(event);
  } catch {
    // 로깅 실패는 응답에 영향을 주지 않는다.
  }
}

/**
 * 긴급 차단 스위치. 값이 망가져 읽을 수 없으면 **차단 쪽으로 넘어진다** —
 * 스위치를 해석하지 못하는 상태에서 장당 45원짜리 모델을 계속 부르는 것보다,
 * 점검 안내를 보여 주고 비용을 0으로 두는 편이 안전하다 (PRD 리스크 표).
 */
function serviceEnabled(): boolean {
  try {
    return isServiceEnabled();
  } catch {
    console.error("[analyze] SERVICE_ENABLED 값을 해석할 수 없어 요청을 차단합니다");
    return false;
  }
}

/** 성공 응답. `X-Request-Id`는 성공·실패 모두에 붙인다 (TRD 6.4) */
function jsonResponse(status: number, body: unknown, requestId: string): Response {
  return Response.json(body, { status, headers: { "X-Request-Id": requestId } });
}

/**
 * 에러 응답. 본문에도 `requestId`를 담는다 — 사용자가 화면에서 읽어 신고한 ID로
 * 서버 로그를 바로 찾을 수 있어야 상관관계 ID 규칙이 의미를 갖는다 (API_SPEC).
 */
function errorResponse(status: number, code: ErrorCode, requestId: string): Response {
  return jsonResponse(status, { error: ERROR_MESSAGES[code], code, requestId }, requestId);
}
