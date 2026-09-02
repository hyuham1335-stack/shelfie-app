/**
 * POST /api/mood/questions — 확인된 책 목록을 근거로 기분 유도 질문을 만든다 (TR-009, US-004).
 *
 * ## 이 라우트가 특별한 이유: `proof` 검증을 처음 소비한다 (ADR-006)
 * `analyze`·`resolve`는 지금까지 서명을 **발급**만 했다. 여기가 그 서명을
 * 처음으로 되받아 검증하는 자리다. 무상태 설계(ADR-003)에서 "알라딘 대조를
 * 통과했다"는 판정은 응답과 함께 클라이언트로 나갔다가 이 요청에 다시
 * 들어오는데, 서버는 그것이 자기가 내준 값인지 알 방법이 없다. zod 형식 검사는
 * 13자리 숫자인지만 보고, 화이트리스트 검증(FR-009)은 모델 출력이 입력과
 * 일치하는지만 본다 — **둘 다 통과해도 입력 자체가 지어낸 것이면 가짜 책이
 * 그대로 프롬프트에 실린다.** 서명이 그 간극을 메운다.
 *
 * 검증 실패는 요청 전체가 아니라 **그 책만** 폐기한다(TR-015). 시크릿을
 * 교체한 순간 진행 중이던 세션이 통째로 죽는 것을 막기 위해서다.
 *
 * ## 실패는 502가 아니라 빈 배열이다
 * 생성 실패든 모델 장애든 **200과 빈 배열**이다. 클라이언트는 빈 배열을 받으면
 * 자유 입력 화면으로 폴백하고 세션을 끊지 않는다. 상태 코드를 나누면 같은
 * 화면 동작에 두 경로가 생기고 둘 중 하나는 반드시 덜 검증된다 (API_SPEC).
 * 200이 아닌 응답은 요청 자체가 잘못됐을 때(400)와 시간을 다 썼을 때(504),
 * 그리고 긴급 차단 중일 때(503)뿐이다.
 *
 * ## 판정을 여기서 다시 만들지 않는다
 * 서명(`lib/proof`), 계약(`lib/schemas`), 프롬프트·모델 호출(`services/anthropic`)은
 * 이미 있고 여기서 재구현하지 않는다. 이 파일이 하는 일은 순서를 정하고 값을
 * 나르는 것뿐이다 (/docs/ARCHITECTURE.md).
 *
 * ## 상태를 남기지 않는다 (ADR-003)
 * 파일·전역 변수·쿠키 어디에도 쓰지 않는다.
 */
import { randomUUID } from "node:crypto";

import { logEvent, type AnalyticsEvent } from "@/lib/analytics";
import { createBudget } from "@/lib/budget";
import { isServiceEnabled } from "@/lib/env";
import { filterVerified } from "@/lib/proof";
import { moodQuestionsRequestSchema, moodQuestionsResponseSchema } from "@/lib/schemas";
import { generateQuestions } from "@/services/anthropic";
import type { ErrorCode, MoodQuestionsRequest, MoodQuestionsResponse } from "@/types/api";

/** `lib/proof.ts`가 Node 내장 `crypto`를 쓴다. Edge에서는 동작하지 않는다 (TRD 2번) */
export const runtime = "nodejs";

/** 이 라우트의 하드 상한 30초 (API_SPEC 공통 규약) */
export const maxDuration = 30;

/**
 * 요청 하나의 내부 총 예산. 함수 상한에서 응답 조립·로깅 여유 2s를 뺀 값이다.
 *
 * **`lib/budget`의 `STAGE_BUDGET_MS`를 쓰지 않는다.** 그 표(추출 30s · 대조 12s ·
 * 한줄평 8s)는 총 예산 55s의 `/api/analyze` 전용이며, 단계가 하나뿐인 이
 * 라우트에 넓혀 붙일 이유가 없다. 예산을 여기서 잡는 이유는 같다 — 개별 호출
 * 타임아웃의 합이 함수 상한을 넘기면 플랫폼이 연결을 끊어 API_SPEC이 정의한
 * 504조차 돌려주지 못한다 (ADR-005, TRD 7번).
 */
const QUESTIONS_BUDGET_MS = 28_000;

/**
 * 사용자에게 그대로 보이는 문구. 모델 생성물·내부 원문은 절대 쓰지 않는다 (API_SPEC).
 * 이 라우트가 실제로 낼 수 있는 코드만 담는다.
 */
const ERROR_MESSAGES: Record<QuestionsErrorCode, string> = {
  INVALID_REQUEST: "요청을 처리할 수 없어요. 책 목록을 다시 확인해 주세요.",
  // UI_GUIDE의 재분석 안내와 같은 상태다 — 서명이 만료됐거나 목록이 우리가 내준 것이 아니다.
  UNVERIFIED_BOOKS: "책 정보를 다시 확인해야 해요. 사진을 다시 분석해 주세요.",
  TIMEOUT: "시간이 오래 걸려 중단했어요. 잠시 후 다시 시도해 주세요.",
  SERVICE_DISABLED: "점검 중이에요. 잠시 후 다시 찾아와 주세요.",
};

type QuestionsErrorCode = Extract<
  ErrorCode,
  "INVALID_REQUEST" | "UNVERIFIED_BOOKS" | "TIMEOUT" | "SERVICE_DISABLED"
>;

/** 생성 실패·계약 위반을 흡수하는 폴백. 클라이언트는 이 값을 자유 입력으로 읽는다 */
const FALLBACK_QUESTIONS: MoodQuestionsResponse = { questions: [] };

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  // 예산은 **가장 먼저** 연다. 본문을 읽고 서명을 검증하는 시간도 총 예산 안에서 흐른다.
  const budget = createBudget(QUESTIONS_BUDGET_MS);

  if (!serviceEnabled()) {
    // 외부 호출을 하지 않으므로 비용이 발생하지 않는다 (TRD 7번 긴급 차단 스위치).
    return errorResponse(503, "SERVICE_DISABLED", requestId);
  }

  const parsed = await readRequest(request);
  if (!parsed.ok) {
    return errorResponse(400, "INVALID_REQUEST", requestId);
  }

  const { sessionId, books } = parsed.value;

  /* --- 서명 검증이 먼저다. 통과 0권이면 모델을 부르지 않는다 (ADR-006) --- */

  const { verified, rejected } = filterVerified(books);

  if (rejected.length > 0) {
    // 무결성 계측 (TRD 6.4). 0이 기본이며 0이 아니면 클라이언트 상태 조립 버그를
    // 의심한다. 서지 원문은 남기지 않고 사유별 개수만 센다.
    console.warn(
      `[questions] proof 검증 실패 ${rejected.length}건 — request_id=${requestId} reasons=${countReasons(rejected)}`,
    );
  }

  if (verified.length === 0) {
    // **API_SPEC은 `mood/questions`에 대해 이 경우를 명시하지 않았다.**
    // `/api/recommend`와 같은 규약(400 `UNVERIFIED_BOOKS`)을 택한다 — 두 라우트가
    // 같은 서명을 같은 방식으로 검증하는데 통과 0권의 응답만 다르면, 클라이언트가
    // "다시 분석해 주세요"로 이어지는 경로를 두 벌 만들어야 한다. 여기서 200 + 빈
    // 배열로 흡수하지 않는 이유는, 그것이 "질문을 못 만들었다"는 뜻이 되어 목록이
    // 통째로 검증에 실패했다는 사실을 사용자에게도 로그에도 숨기기 때문이다.
    return errorResponse(400, "UNVERIFIED_BOOKS", requestId);
  }

  /* --- 질문 생성 (1회 호출) ---------------------------------------- */

  const outcome = await generateQuestions(
    // 서명은 벗겨서 넘긴다. 프롬프트에 필요한 것은 서지 최소값뿐이다.
    // 되돌아온 `title`·`author`는 `lib/prompts`가 데이터 블록으로만 다룬다 (TRD 6.5).
    verified.map((book) => ({ isbn13: book.isbn13, title: book.title, author: book.author })),
    { deadlineMs: budget.remainingMs() },
  );

  // 응답을 받고 나서 실패한 경우(refusal·max_tokens·스키마 위반)는 토큰이 이미
  // 과금됐다. 빼면 세션당 비용이 실제보다 낮게 집계된다 (PRD 2번 가드레일).
  const usage = {
    input_tokens: outcome.usage?.input_tokens ?? 0,
    output_tokens: outcome.usage?.output_tokens ?? 0,
  };

  if (outcome.status === "failed" && outcome.reason === "timeout") {
    // 우리 예산이 바닥났다. 이것만 200이 아니다 — 모델 장애와 달리 재시도하면
    // 달라질 수 있고, 화면도 다른 안내를 해야 한다 (API_SPEC).
    record({
      event: "questions_generated",
      session_id: sessionId,
      question_count: 0,
      ...usage,
    });
    return errorResponse(504, "TIMEOUT", requestId);
  }

  /* --- 응답 조립: 계약을 어긴 본문은 내보내지 않고 폴백한다 --------- */

  const candidate: MoodQuestionsResponse = {
    questions: outcome.status === "ok" ? [...outcome.questions] : [],
  };

  // 우리가 만든 응답도 계약을 지키는지 기계로 확인한다. 검증 경계는 들어오는
  // 값에만 있는 것이 아니다. 질문이 1개이거나 4개인 응답은 문답 화면을
  // 성립시키지 못하므로, 그런 본문을 보내는 대신 **폴백(빈 배열)으로 강등**한다 —
  // 여기서 502를 쓰면 클라이언트가 폴백 경로를 두 벌 갖게 된다.
  const validated = moodQuestionsResponseSchema.safeParse(candidate);
  if (!validated.success) {
    console.error(`[questions] 생성된 질문이 계약을 어겨 폴백합니다 — request_id=${requestId}`);
  }

  const body = validated.success ? validated.data : FALLBACK_QUESTIONS;

  record({
    event: "questions_generated",
    session_id: sessionId,
    // 0이면 자유 입력 폴백이라는 뜻이다 (PRD 7번).
    question_count: body.questions.length,
    ...usage,
  });

  return jsonResponse(200, body, requestId);
}

/* ------------------------------------------------------------------ *
 * 내부 헬퍼
 * ------------------------------------------------------------------ */

type RequestOutcome = { ok: true; value: MoodQuestionsRequest } | { ok: false };

/**
 * 본문을 읽고 서버에서 다시 검증한다. 클라이언트 검증을 신뢰하지 않는다 (TRD 6.5).
 *
 * zod 이슈를 그대로 노출하지 않는다 — 필드 경로와 원본 메시지는 사용자에게
 * 의미가 없고 내부 구조를 흘린다 (API_SPEC 에러 규약). 이 라우트의 400 사유는
 * 전부 "요청이 계약을 어겼다" 하나로 모이므로 코드도 `INVALID_REQUEST` 하나다.
 * 목록이 비었거나 50개를 넘는 경우, `proof` 필드가 아예 없는 경우도 여기서 걸린다.
 */
async function readRequest(request: Request): Promise<RequestOutcome> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false };
  }

  const parsed = moodQuestionsRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false };
  }

  return { ok: true, value: parsed.data };
}

/** 무결성 로그용 사유 집계. 책의 서지 값은 남기지 않는다 (TRD 6.4) */
function countReasons(rejected: readonly { reason: string }[]): string {
  const counts = new Map<string, number>();
  for (const item of rejected) {
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  }
  return [...counts]
    .map(([reason, count]) => `${reason}=${count}`)
    .join(",");
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
 * `analyze`·`resolve`·`events`와 같은 규칙이다 (PRD 리스크 표).
 */
function serviceEnabled(): boolean {
  try {
    return isServiceEnabled();
  } catch {
    console.error("[questions] SERVICE_ENABLED 값을 해석할 수 없어 요청을 차단합니다");
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
function errorResponse(status: number, code: QuestionsErrorCode, requestId: string): Response {
  return jsonResponse(status, { error: ERROR_MESSAGES[code], code, requestId }, requestId);
}
