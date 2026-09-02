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
 * ## 세션 진행 상태는 요청에 실려 온다 (`retryIndex`·`irrelevantStreak`)
 * 무상태라 서버가 "이 세션에서 몇 번째 재추천인지", "무관 판정이 몇 번 연속
 * 나왔는지"를 셀 수 없다 (ADR-003). 그래서 두 값은 요청에 **필수 필드**로 실려
 * 온다 (API_SPEC /api/recommend). 기본값을 두면 "보내지 않았다"와 "0이다"가 구분되지
 * 않고, 그것이 `mood_submitted.retry_index`가 언제나 0이던 원인이다.
 *
 * **세는 것은 클라이언트, 판정하는 것은 서버다.** 화면은 횟수만 실어 보내고,
 * "2회 연속이면 무관 판정을 무시한다"는 규칙 자체는 이 라우트가 갖는다 — 판정까지
 * 클라이언트에 맡기면 같은 규칙이 화면마다 다시 구현되고 그중 하나는 반드시 덜
 * 검증된다.
 *
 * 두 값에는 서명을 붙이지 않는다. `proof`가 필요한 이유는 **책이 사실인 척할 수
 * 있기 때문**인데, 이 둘은 위조해도 얻는 것이 **원래 허용된 동작 하나**뿐이다 —
 * `irrelevantStreak`를 2로 보내면 세 번째에 어차피 허용되는 억지 추천 한 번을 앞당길
 * 뿐이고, `retryIndex`는 로그 속성이다. 검증하는 대신 **스키마가 상한을 강제한다**
 * (0~4 · 0~2). 상한 밖은 400이다 (ADR-006, API_SPEC).
 *
 * ## 실패도 이벤트로 남는다
 * 추천이 실패로 끝나도 태운 토큰은 그대로 청구되고 에러율은 집계돼야 한다. 그래서
 * 실패 응답 반환 직전에 `recommend_failed`를 남긴다(PRD 7번). **그 자리에서
 * `recommend_viewed`를 올리지 않는다** — 그것은 추천 수락률의 분모라 실패로
 * 부풀면 North Star가 실제보다 낮게 보인다.
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
import { MAX_IRRELEVANT_STREAK, MAX_RECOMMENDATIONS, isServiceEnabled } from "@/lib/env";
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

/**
 * 무관 판정을 무시하기 시작하는 **연속** 횟수. 여기 도달한 요청은 모델이
 * `relevant: false`를 내도 422로 끊지 않고 추천을 진행한다 — 오탐으로 사용자를
 * 입력 화면에 가두는 것이 억지 추천 한 번보다 나쁘다 (US-003 AC, API_SPEC).
 *
 * 스키마 상한(`MAX_IRRELEVANT_STREAK`)과 **같은 값을 쓴다.** API_SPEC이
 * `irrelevantStreak`의 범위를 0~2로 정한 이유가 "2면 판정을 무시하므로 그보다 큰
 * 값에 의미가 없다"이기 때문이다. 두 숫자가 갈리면 상한이 계약을 설명하지 못한다.
 */
const IRRELEVANT_STREAK_LIMIT = MAX_IRRELEVANT_STREAK;

type RecommendErrorCode = Extract<
  ErrorCode,
  | "INVALID_REQUEST"
  | "UNVERIFIED_BOOKS"
  | "IRRELEVANT_MOOD"
  | "RECOMMENDATION_VALIDATION_FAILED"
  | "UPSTREAM_UNAVAILABLE"
  | "TIMEOUT"
  | "SERVICE_DISABLED"
  | "INTERNAL_ERROR"
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
  // 우리 쪽 결함(500). 문구는 502와 같다 — 사용자가 할 수 있는 일이 같기 때문이고,
  // 원인을 구분해야 하는 자리는 응답이 아니라 로그다 (API_SPEC).
  INTERNAL_ERROR: "문제가 생겨 중단했어요. 잠시 후 다시 시도해 주세요.",
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

  const { sessionId, books, mood, inputMode, retryIndex, irrelevantStreak } = parsed.value;

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
    //
    // **이 400도 `recommend_failed`를 남긴다.** 토큰은 0이지만 그것은 누락이 아니라
    // 사실이다 — 여기까지의 실패는 비용을 태우지 않았고, 비용 가드레일에는 0으로,
    // 에러율과 `proof` 무결성 계측(TRD 6.4)에는 1건으로 들어가야 한다. 실패를
    // 세지 않으면 클라이언트 상태 조립 버그가 지표에서 조용히 사라진다.
    recordFailure(sessionId, "UNVERIFIED_BOOKS", { input_tokens: 0, output_tokens: 0 });
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

  // `retry_index`는 요청이 실어 온 "다시 추천받기" 횟수 그대로다. 하드코딩된 0이
  // 아니다 — 무상태라 서버가 셀 수 없고, 0으로 적으면 지표가 조용히 거짓말한다.
  record({
    event: "mood_submitted",
    session_id: sessionId,
    input_mode: inputMode,
    retry_index: retryIndex,
  });

  /* --- ② 추천 생성 + 화이트리스트 (필요하면 교정 재요청 1회) -------- */

  const usage: UsageTotal = { input_tokens: 0, output_tokens: 0 };
  let violations: string[] = [];
  /** 무관 판정 강행을 요청당 한 번만 기록하기 위한 표시. 응답에는 나가지 않는다 */
  let forcedIrrelevant = false;

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
      recordFailure(sessionId, failureCode, usage);
      return errorResponse(outcome.reason === "timeout" ? 504 : 502, failureCode, requestId);
    }

    if (!outcome.relevant) {
      // 판정 주체는 **모델**이다. 서버가 키워드로 판정하지 않는다 (API_SPEC).
      // 이 라우트가 정하는 것은 *판정을 언제 무시하는가*뿐이다.
      if (irrelevantStreak < IRRELEVANT_STREAK_LIMIT) {
        recordFailure(sessionId, "IRRELEVANT_MOOD", usage);
        return errorResponse(422, "IRRELEVANT_MOOD", requestId);
      }

      // 2회 연속 무관 판정 뒤의 요청이다. 판정을 무시하고 계속 진행한다 —
      // **모델을 다시 부르지 않는다.** `outcome.picks`는 이미 손에 있고, 다시
      // 부르면 같은 응답에 비용만 두 배가 된다.
      //
      // 무시하는 것은 무관 판정 하나뿐이다. 아래 화이트리스트 검증(FR-009)은
      // 그대로 지난다 — 목록 밖 책은 이 경로로도 사용자에게 도달하지 않는다.
      if (!forcedIrrelevant) {
        forcedIrrelevant = true;
        // 이벤트가 아니라 경고 한 줄이다. 오탐률을 나중에 읽기 위한 것이고,
        // `mood` 원문은 절대 싣지 않는다 (PRD 7번).
        console.warn(
          `[recommend] 무관 판정을 무시하고 추천을 강행합니다 — request_id=${requestId} session_id=${sessionId} streak=${irrelevantStreak}`,
        );
      }
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
  recordFailure(sessionId, "RECOMMENDATION_VALIDATION_FAILED", usage);
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
    // 우리가 조립한 본문이 우리 계약을 어긴 것이므로 우리 결함이다(500).
    // 모델이 목록 밖 책을 준 경우는 아래에서 502로 따로 남는다 — 두 실패의
    // 원인이 다르므로 로그에서도 구분한다 (API_SPEC).
    console.error(`[recommend] 생성된 추천이 계약을 어겼습니다 — request_id=${requestId}`);
    recordFailure(sessionId, "INTERNAL_ERROR", usage);
    return errorResponse(500, "INTERNAL_ERROR", requestId);
  }

  // 방어적 재확인. 위에서 이미 걸렀지만, 목록 밖 책이 응답에 실릴 수 있는 경로가
  // 하나도 없어야 한다 (FR-009, PRD 가드레일 0건).
  if (validated.data.recommendations.some((item) => !allowed.has(item.bookId))) {
    console.error(`[recommend] 목록 밖 bookId가 응답 조립까지 도달했습니다 — request_id=${requestId}`);
    recordFailure(sessionId, "RECOMMENDATION_VALIDATION_FAILED", usage);
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
 * 실패 응답 반환 직전에 `recommend_failed`를 남긴다 (PRD 7번).
 *
 * **`recommend_viewed`를 대신 올리지 않는다.** 그것은 추천 수락률의 분모이고,
 * 실패로 부풀면 North Star가 실제보다 낮게 보인다. `analyze_completed`/
 * `analyze_failed`와 같은 짝이다.
 *
 * **태운 토큰을 빼지 않는다.** 응답을 받고 나서 실패한 경우(refusal·max_tokens·
 * 스키마 위반)도 이미 과금됐고, 빼면 세션당 비용 가드레일이 실패분을 보지 못한다.
 * 토큰이 0인 실패(`UNVERIFIED_BOOKS`처럼 모델을 부르기 전에 끊긴 경우)도 그대로
 * 0으로 남긴다 — 값이 없는 것이 아니라 0인 것이 사실이고, 에러율에는 세어야 한다.
 *
 * `sessionId`를 반드시 싣는다. 세션 없이 남긴 이벤트는 어느 지표에도 붙지 않는다.
 * 요청 본문 파싱 자체가 실패한 400(`INVALID_REQUEST`)에서는 `sessionId`를 알 수
 * 없어 이벤트를 남기지 않는다 — 세션에 붙지 않는 실패를 세면 분모만 흐려진다.
 * 503(`SERVICE_DISABLED`)도 남기지 않는다. 그것은 실패가 아니라 우리가 켜고 끄는
 * 스위치이며, 외부 호출도 비용도 없다 (TRD 7번).
 */
function recordFailure(
  sessionId: string,
  code: RecommendErrorCode,
  usage: UsageTotal,
): void {
  record({
    event: "recommend_failed",
    session_id: sessionId,
    error_code: code,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
  });
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
