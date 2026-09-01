/**
 * POST /api/recommend — 확인된 책 목록과 기분 텍스트로 3권을 고른다 (TR-010, US-003).
 *
 * ## 이 라우트의 순서가 곧 설계다
 * 서명 검증 → 화이트리스트. **둘 다 있어야 하고 순서가 있다** (ADR-006).
 * 화이트리스트 검증(FR-009)은 *모델 출력이 입력과 일치하는지*만 본다 — 입력
 * 목록 자체가 지어낸 것이면 그 검사를 그대로 통과한다. 무상태 설계(ADR-003)에서
 * "알라딘 대조를 통과했다"는 판정은 응답과 함께 클라이언트로 나갔다가 이 요청에
 * 다시 들어오므로, 서버는 그것이 자기가 내준 값인지 서명으로만 알 수 있다.
 * 그래서 서명 검증이 먼저이고, **화이트리스트의 기준도 원본 요청 목록이 아니라
 * 서명 검증을 통과한 목록**이다. 버려진 책의 `isbn13`을 모델이 반환하면 그것도
 * 목록 밖이다.
 *
 * 검증 통과가 0권이면 모델을 부르지 않는다. 위조된 목록으로 유료 호출을 하지
 * 않는다는 뜻이며, 400 `UNVERIFIED_BOOKS`로 끊는다.
 *
 * ## 재요청은 1회이고 같은 프롬프트가 아니다
 * 목록 밖 `bookId`가 섞이면 **위반한 ID를 명시하고 허용 목록을 다시 제시해**
 * 1회만 재요청한다(`services/anthropic`의 `correction`). 동일 입력을 그대로
 * 다시 보내면 같은 실패를 반복한다. 재요청 후에도 위반이면 502
 * `RECOMMENDATION_VALIDATION_FAILED`로 끊는다 — 목록 밖 책은 어떤 경로로도
 * 사용자에게 도달하지 않는다.
 *
 * ## 계약의 공백 두 곳 (문서 결정 사항 — 이 라우트에서 메우지 않는다)
 * ① **`IRRELEVANT_MOOD` 2회 연속 무시** — API_SPEC은 "같은 세션에서 2회 연속
 *    `relevant: false`면 판정을 무시하고 추천을 진행한다"고 정했지만, 무상태라
 *    세션별 카운터를 서버에 둘 수 없고 `recommendRequestSchema`에 그 횟수를 담을
 *    필드가 없다. 스키마를 임의로 넓히는 것은 계약 변경이고 문서가 먼저다
 *    (CLAUDE.md CRITICAL). 그래서 **서버는 매 요청을 독립적으로 판정해 422를
 *    반환하고, "2회 연속이면 무시"는 클라이언트 책임**으로 둔다 — 클라이언트가
 *    422를 두 번 받았음을 기억했다가 세 번째에 추천을 강행하는 UI 경로를 갖는다.
 * ② **`mood_submitted.retry_index`** — "다시 추천받기" 횟수 역시 요청에 실려 오지
 *    않아 서버가 알 수 없다. 0으로 기록한다. 두 공백은 같은 원인(요청 스키마에
 *    세션 진행 상태가 없다)에서 나오므로 함께 결정해야 한다.
 *
 * ## `mood`는 데이터다
 * 라우트는 `mood`를 가공하지도, 프롬프트에 이어 붙이지도 않는다. 그대로 넘기면
 * `lib/prompts`가 `<mood>` 데이터 블록 안에 넣는다 (TRD 6.5). 되돌아온
 * `title`·`author`·`claudeNote`도 같은 취급을 받는다.
 *
 * ## 상태를 남기지 않는다 (ADR-003)
 * 파일·전역 변수·쿠키 어디에도 쓰지 않는다.
 */
import { randomUUID } from "node:crypto";

import { logEvent, type AnalyticsEvent } from "@/lib/analytics";
import { createBudget } from "@/lib/budget";
import { MAX_RECOMMENDATIONS, isServiceEnabled } from "@/lib/env";
import { filterVerified } from "@/lib/proof";
import { recommendRequestSchema, recommendResponseSchema } from "@/lib/schemas";
import {
  generateRecommendations,
  type RecommendOutcome,
  type RecommendPick,
} from "@/services/anthropic";
import type { ErrorCode, RecommendRequest, RecommendResponse } from "@/types/api";

/** `lib/proof.ts`가 Node 내장 `crypto`를 쓴다. Edge에서는 동작하지 않는다 (TRD 2번) */
export const runtime = "nodejs";

/** 이 라우트의 하드 상한 30초 (API_SPEC 공통 규약) */
export const maxDuration = 30;

/**
 * 요청 하나의 내부 총 예산. 함수 상한에서 응답 조립·로깅 여유 2s를 뺀 값이다.
 *
 * **`lib/budget`의 `STAGE_BUDGET_MS`를 쓰지 않는다.** 그 표는 총 예산 55s의
 * `/api/analyze` 전용이며 여기에 넓혀 붙일 이유가 없다 — `mood/questions`(step 1)와
 * 같은 판단이다. 예산을 여는 이유는 같다: 재요청까지 포함한 호출 시간의 합이
 * 함수 상한을 넘기면 플랫폼이 연결을 끊어 API_SPEC이 정의한 504조차 돌려주지
 * 못한다 (ADR-005, TRD 7번). 재요청은 남은 예산 안에서만 산다.
 */
const RECOMMEND_BUDGET_MS = 28_000;

/** 목록 밖 `bookId`에 대한 재요청 횟수. API_SPEC이 1회로 정했다 */
const MAX_CORRECTION_ATTEMPTS = 1;

type RecommendErrorCode = Extract<
  ErrorCode,
  | "INVALID_REQUEST"
  | "UNVERIFIED_BOOKS"
  | "IRRELEVANT_MOOD"
  | "RECOMMENDATION_VALIDATION_FAILED"
  | "UPSTREAM_UNAVAILABLE"
  | "TIMEOUT"
  | "SERVICE_DISABLED"
>;

/**
 * 사용자에게 그대로 보이는 문구. 모델 생성물·내부 원문·위반한 `bookId`는 절대
 * 넣지 않는다 (API_SPEC 에러 규약). 이 라우트가 실제로 낼 수 있는 코드만 담는다.
 */
const ERROR_MESSAGES: Record<RecommendErrorCode, string> = {
  INVALID_REQUEST: "요청을 처리할 수 없어요. 기분과 책 목록을 다시 확인해 주세요.",
  // UI_GUIDE의 재분석 안내와 같은 상태다 — 서명이 만료됐거나 목록이 우리가 내준 것이 아니다.
  UNVERIFIED_BOOKS: "책 정보를 다시 확인해야 해요. 사진을 다시 분석해 주세요.",
  IRRELEVANT_MOOD: "책 고르는 데 참고할 내용을 적어 주세요.",
  RECOMMENDATION_VALIDATION_FAILED:
    "추천을 만들지 못했어요. 잠시 후 다시 시도해 주세요.",
  UPSTREAM_UNAVAILABLE: "지금 추천을 만들 수 없어요. 잠시 후 다시 시도해 주세요.",
  TIMEOUT: "시간이 오래 걸려 중단했어요. 잠시 후 다시 시도해 주세요.",
  SERVICE_DISABLED: "점검 중이에요. 잠시 후 다시 찾아와 주세요.",
};

/** 누적 토큰. 재요청이 일어나면 두 호출을 모두 센다 (PRD 2번 비용 가드레일) */
interface UsageTotal {
  input_tokens: number;
  output_tokens: number;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  // 예산은 **가장 먼저** 연다. 본문을 읽고 서명을 검증하는 시간도 총 예산 안에서 흐른다.
  const budget = createBudget(RECOMMEND_BUDGET_MS);

  if (!serviceEnabled()) {
    // 외부 호출을 하지 않으므로 비용이 발생하지 않는다 (TRD 7번 긴급 차단 스위치).
    return errorResponse(503, "SERVICE_DISABLED", requestId);
  }

  const parsed = await readRequest(request);
  if (!parsed.ok) {
    return errorResponse(400, "INVALID_REQUEST", requestId);
  }

  const { sessionId, books, mood, inputMode } = parsed.value;

  /* --- ① 서명 검증. 화이트리스트보다 먼저다 (ADR-006) --------------- */

  const { verified, rejected } = filterVerified(books);

  if (rejected.length > 0) {
    // 무결성 계측 (TRD 6.4). 0이 기본이며 0이 아니면 클라이언트 상태 조립 버그를
    // 의심한다. 서지 원문은 남기지 않고 사유별 개수만 센다.
    console.warn(
      `[recommend] proof 검증 실패 ${rejected.length}건 — request_id=${requestId} reasons=${countReasons(rejected)}`,
    );
  }

  if (verified.length === 0) {
    // 위조된 목록으로 유료 호출을 하지 않는다. 모델은 아직 부르지 않았다.
    return errorResponse(400, "UNVERIFIED_BOOKS", requestId);
  }

  // 화이트리스트의 기준은 **검증 통과 목록**이다. 버려진 책의 `isbn13`도 목록 밖이다.
  const allowed = new Set(verified.map((book) => book.isbn13));

  // 서명은 벗겨서 넘긴다. 프롬프트에 필요한 것은 서지 값뿐이다.
  const promptBooks = verified.map((book) => ({
    isbn13: book.isbn13,
    title: book.title,
    author: book.author,
    pages: book.pages,
    claudeNote: book.claudeNote,
  }));

  record({ event: "mood_submitted", session_id: sessionId, input_mode: inputMode, retry_index: 0 });

  /* --- ② 추천 생성 + 화이트리스트 (필요하면 교정 재요청 1회) -------- */

  const usage: UsageTotal = { input_tokens: 0, output_tokens: 0 };
  let violations: string[] = [];

  for (let attempt = 0; attempt <= MAX_CORRECTION_ATTEMPTS; attempt += 1) {
    const outcome: RecommendOutcome = await generateRecommendations(promptBooks, mood, {
      deadlineMs: budget.remainingMs(),
      // 첫 시도에는 교정이 없다. 두 번째에만 위반 ID와 허용 목록을 다시 싣는다.
      ...(violations.length > 0 ? { correction: { violatingBookIds: violations } } : {}),
    });

    accumulate(usage, outcome);

    if (outcome.status === "failed") {
      // 응답을 못 받았거나 계약을 어겼다. 사유는 뭉개지 않는다 (ADR-005) —
      // 예산 소진(timeout)은 재시도하면 달라질 수 있고 화면 안내도 다르다.
      const failureCode: RecommendErrorCode =
        outcome.reason === "timeout" ? "TIMEOUT" : "UPSTREAM_UNAVAILABLE";
      warnBurnedTokens(requestId, failureCode, usage);
      return errorResponse(outcome.reason === "timeout" ? 504 : 502, failureCode, requestId);
    }

    if (!outcome.relevant) {
      // 판정 주체는 모델이다. 서버가 키워드로 판정하지 않는다 (API_SPEC).
      // "2회 연속이면 무시"는 세션을 아는 클라이언트 몫이다 — 파일 상단 참고.
      warnBurnedTokens(requestId, "IRRELEVANT_MOOD", usage);
      return errorResponse(422, "IRRELEVANT_MOOD", requestId);
    }

    violations = outsideAllowed(outcome.picks, allowed);

    if (violations.length === 0) {
      return success(outcome.picks, allowed, verified.length, sessionId, usage, budget.elapsedMs(), requestId);
    }

    console.warn(
      `[recommend] 목록 밖 bookId ${violations.length}건 — request_id=${requestId} attempt=${attempt}`,
    );
  }

  // 재요청 후에도 목록 밖이다. 3권을 채우려고 남은 것만 골라 내보내지 않는다 —
  // 모델이 목록을 벗어났다는 사실 자체가 그 응답 전체를 신뢰할 수 없다는 뜻이다.
  warnBurnedTokens(requestId, "RECOMMENDATION_VALIDATION_FAILED", usage);
  return errorResponse(502, "RECOMMENDATION_VALIDATION_FAILED", requestId);
}

/* ------------------------------------------------------------------ *
 * 응답 조립
 * ------------------------------------------------------------------ */

function success(
  picks: readonly RecommendPick[],
  allowed: ReadonlySet<string>,
  verifiedCount: number,
  sessionId: string,
  usage: UsageTotal,
  durationMs: number,
  requestId: string,
): Response {
  const recommendations = dedupe(picks).slice(0, MAX_RECOMMENDATIONS);

  const candidate: RecommendResponse = {
    recommendations,
    // 확인된 책이 3권 미만이라 추천 수가 부족한 경우다 (FR-006). 기준은 검증
    // 통과 권수다 — 서명에 실패해 2권만 남았어도 사용자에게는 같은 안내가 맞다.
    shortfall: verifiedCount < MAX_RECOMMENDATIONS,
  };

  // 우리가 만든 응답도 계약을 지키는지 기계로 확인한다. 검증 경계는 들어오는
  // 값에만 있는 것이 아니다. 여기서 빈 배열로 폴백하지 않는 이유는, 추천 0건은
  // "고를 책이 없었다"는 뜻이 되어 사실이 아닌 화면을 만들기 때문이다.
  const validated = recommendResponseSchema.safeParse(candidate);
  if (!validated.success) {
    console.error(`[recommend] 생성된 추천이 계약을 어겼습니다 — request_id=${requestId}`);
    warnBurnedTokens(requestId, "UPSTREAM_UNAVAILABLE", usage);
    return errorResponse(502, "UPSTREAM_UNAVAILABLE", requestId);
  }

  // 방어적 재확인. 위에서 이미 걸렀지만, 목록 밖 책이 응답에 실릴 수 있는 경로가
  // 하나도 없어야 한다 (FR-009, PRD 가드레일 0건).
  if (validated.data.recommendations.some((item) => !allowed.has(item.bookId))) {
    console.error(`[recommend] 목록 밖 bookId가 응답 조립까지 도달했습니다 — request_id=${requestId}`);
    return errorResponse(502, "RECOMMENDATION_VALIDATION_FAILED", requestId);
  }

  record({
    event: "recommend_viewed",
    session_id: sessionId,
    recommended_count: validated.data.recommendations.length,
    duration_ms: durationMs,
    ...usage,
  });

  return jsonResponse(200, validated.data, requestId);
}

/**
 * 같은 책을 두 번 추천한 응답에서 뒤엣것을 버린다.
 *
 * `position`은 다시 매기지 않는다 — 그것은 모델의 판단이고 계약의 일부다
 * (`services/anthropic`의 `RecommendPick` 주석). 중복만 걷어 내면 검증 통과 권수가
 * 곧 추천 상한이 되므로 "있는 만큼만"(FR-006)이 자연히 지켜진다.
 */
function dedupe(picks: readonly RecommendPick[]): RecommendPick[] {
  const seen = new Set<string>();
  const unique: RecommendPick[] = [];

  for (const pick of picks) {
    if (seen.has(pick.bookId)) {
      continue;
    }
    seen.add(pick.bookId);
    unique.push(pick);
  }

  return unique;
}

/** 허용 목록 밖 `bookId`를 중복 없이 등장 순서대로 모은다 (FR-009) */
function outsideAllowed(
  picks: readonly RecommendPick[],
  allowed: ReadonlySet<string>,
): string[] {
  const violations: string[] = [];

  for (const pick of picks) {
    if (!allowed.has(pick.bookId) && !violations.includes(pick.bookId)) {
      violations.push(pick.bookId);
    }
  }

  return violations;
}

/* ------------------------------------------------------------------ *
 * 내부 헬퍼
 * ------------------------------------------------------------------ */

type RequestOutcome = { ok: true; value: RecommendRequest } | { ok: false };

/**
 * 본문을 읽고 서버에서 다시 검증한다. 클라이언트 검증을 신뢰하지 않는다 (TRD 6.5).
 *
 * zod 이슈를 그대로 노출하지 않는다 — 필드 경로와 원본 메시지는 사용자에게 의미가
 * 없고 내부 구조를 흘린다 (API_SPEC 에러 규약). 목록이 비었거나 50개를 넘는 경우,
 * `mood`가 2자 미만·500자 초과인 경우, `proof` 필드가 아예 없는 경우도 여기서 걸린다.
 */
async function readRequest(request: Request): Promise<RequestOutcome> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false };
  }

  const parsed = recommendRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false };
  }

  return { ok: true, value: parsed.data };
}

/**
 * 호출 하나의 토큰을 누적한다.
 *
 * 응답을 받고 나서 실패한 경우(refusal·max_tokens·스키마 위반)도 토큰이 이미
 * 과금됐다. 빼면 세션당 비용이 실제보다 낮게 집계된다 (PRD 2번 가드레일).
 * 호출이 없었거나 응답을 못 받은 경우에는 `usage` 키 자체가 없다.
 */
function accumulate(total: UsageTotal, outcome: RecommendOutcome): void {
  total.input_tokens += outcome.usage?.input_tokens ?? 0;
  total.output_tokens += outcome.usage?.output_tokens ?? 0;
}

/**
 * 실패로 끝난 요청이 태운 토큰을 남긴다.
 *
 * **이벤트가 아니라 경고 한 줄이다.** `recommend_viewed`는 추천 수락률의 분모라
 * 실패 분기에서 올리면 North Star가 왜곡되고, 실패 전용 이벤트는 PRD 7번 표에
 * 없으므로 `lib/analytics`의 유니온에도 없다(이 step에서 `lib/`을 고치지 않는다).
 * 그래서 비용만 사람이 읽을 수 있는 형태로 남긴다 — 집계에 섞이지 않도록
 * `event` 키를 쓰지 않는다.
 */
function warnBurnedTokens(requestId: string, code: RecommendErrorCode, usage: UsageTotal): void {
  if (usage.input_tokens === 0 && usage.output_tokens === 0) {
    return;
  }
  console.warn(
    `[recommend] 실패로 끝난 요청의 토큰 — request_id=${requestId} code=${code} input=${usage.input_tokens} output=${usage.output_tokens}`,
  );
}

/** 무결성 로그용 사유 집계. 책의 서지 값은 남기지 않는다 (TRD 6.4) */
function countReasons(rejected: readonly { reason: string }[]): string {
  const counts = new Map<string, number>();
  for (const item of rejected) {
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  }
  return [...counts].map(([reason, count]) => `${reason}=${count}`).join(",");
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
 * `analyze`·`resolve`·`events`·`mood/questions`와 같은 규칙이다 (PRD 리스크 표).
 */
function serviceEnabled(): boolean {
  try {
    return isServiceEnabled();
  } catch {
    console.error("[recommend] SERVICE_ENABLED 값을 해석할 수 없어 요청을 차단합니다");
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
function errorResponse(status: number, code: RecommendErrorCode, requestId: string): Response {
  return jsonResponse(status, { error: ERROR_MESSAGES[code], code, requestId }, requestId);
}
