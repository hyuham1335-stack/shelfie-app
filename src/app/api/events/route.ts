/**
 * POST /api/events — 클라이언트에서만 관측되는 이벤트를 서버 로그에 합류시킨다 (TR-014).
 *
 * ## 왜 이 엔드포인트가 있어야 하는가
 * North Star 지표인 추천 수락률의 **분자(`recommend_accepted`)는 순수한 클릭
 * 이벤트라 서버가 알 수 없다.** `recommend_viewed`·`book_resolved`도 마찬가지다.
 * 이 셋을 받을 경로가 없으면 지표의 분자·분모가 서로 다른 곳에 흩어져
 * **가설 검증 자체가 성립하지 않는다** (PRD 7번).
 *
 * ## 받는 것은 3종뿐이다
 * 나머지 5종은 라우트 핸들러가 직접 남긴다. 그것들을 이 경로로도 받으면 같은
 * 이벤트가 두 번 집계되어 지표가 조용히 부풀어 오른다. 목록 밖 이름은 400이다.
 *
 * ## 속성은 화이트리스트로만 통과한다
 * 클라이언트가 보낸 임의의 키를 그대로 로그에 쓰면 **PII·판독 원문이 흘러
 * 들어온다**(PRD 7번, TRD 6.4). 이벤트에 정의된 속성만 남기고 나머지는 조용히
 * 버린다 — 400이 아니라 무시다(API_SPEC). 정의를 여기서 다시 만들지 않고
 * `lib/analytics.ts`의 판별 유니온을 반환 타입으로 삼아, 표가 바뀌면 이 파일이
 * 컴파일 단계에서 깨지게 둔다.
 *
 * ## 저장하지 않는다 (ADR-003)
 * 표준 출력에 JSON 한 줄을 쓰고 끝이다. 파일·DB·전역 변수를 쓰지 않는다.
 *
 * ## 202로 끝낸다
 * 로깅 결과를 기다리지 않고 받았다는 사실만 알린다. 지표 수집 실패가 사용자
 * 화면을 망가뜨리면 본말이 전도된다 (TR-012).
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { logEvent } from "@/lib/analytics";
import { isServiceEnabled } from "@/lib/env";
import { clientEventSchema, eventsRequestSchema, eventsResponseSchema, recommendationSchema } from "@/lib/schemas";
import type { AnalyticsEvent } from "@/lib/analytics";
import type { ErrorCode, EventsResponse } from "@/types/api";

/** 다른 라우트와 같은 런타임을 쓴다. `randomUUID`가 Node 내장 `crypto`에서 온다 */
export const runtime = "nodejs";

/** 이 라우트의 하드 상한 3초 (API_SPEC 공통 규약). 외부 호출이 없어 이보다 길 이유가 없다 */
export const maxDuration = 3;

/**
 * 본문 상한 8KB (API_SPEC).
 * 로그 한 줄로 남길 값에 그 이상이 필요할 이유가 없고, 상한이 없으면 이 무인증
 * 엔드포인트가 로그를 밀어 넣는 통로가 된다.
 */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * `sessionId` 형식 검사 (UUID v4).
 *
 * **값은 신뢰하지 않는다.** 인증이 없으므로 누구든 남의 세션 ID를 흉내 낼 수
 * 있고, 그러면 지표가 오염된다 — 이는 인증 없는 서비스에서 감수하는 비용이며
 * 지표를 절대값이 아니라 추세로 읽는 이유다 (API_SPEC 인증 절). 신뢰하지 않는
 * 것과 아무 문자열이나 로그에 넣는 것은 다르므로 **형식만은 검증한다.**
 *
 * `lib/schemas.ts`의 `sessionIdSchema`가 길이만 보는 것은 분석·추천처럼 실제
 * 작업이 있는 요청을 로깅용 값 하나 때문에 실패시키지 않기 위해서다. 이
 * 엔드포인트에는 지킬 작업이 없다 — 요청의 내용물이 곧 로그 줄이고, 세션에
 * 묶이지 못하는 줄은 수락률 계산에 쓸 수 없다. 그래서 여기서만 더 좁게 본다.
 */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 0 이상의 정수. 카운터·소요 시간·토큰 수가 공유한다 */
const countSchema = z.number().int().min(0);

/**
 * 이벤트별로 로그에 실을 속성. **여기 없는 키는 어떤 경로로도 로그에 닿지 않는다.**
 *
 * 목록의 정본은 PRD 7번 표이고, 이 객체가 그 표와 갈라지면 아래
 * `toAnalyticsEvent`의 반환 타입(`lib/analytics.ts`의 판별 유니온)이 컴파일을
 * 깨뜨린다. `position`은 추천 스키마에서 그대로 가져와 1~3 상한을 두 곳에
 * 적지 않는다.
 */
const propertiesSchema = {
  recommend_viewed: z.object({
    recommended_count: countSchema,
    duration_ms: countSchema,
    // 토큰은 옵셔널이 아니다. 하나라도 빠지면 세션당 비용이 실제보다 낮게
    // 집계되어 "300원" 가드레일이 통과할 수 없는 조건에서도 통과한다 (PRD 2번).
    input_tokens: countSchema,
    output_tokens: countSchema,
  }),
  recommend_accepted: z.object({
    position: recommendationSchema.shape.position,
  }),
  book_resolved: z.object({
    resolve_attempt: countSchema,
    matched: z.boolean(),
  }),
} as const;

/** 사용자에게 그대로 보이는 문구. 이 라우트가 실제로 낼 수 있는 코드만 담는다 (API_SPEC) */
const ERROR_MESSAGES: Record<EventsErrorCode, string> = {
  INVALID_REQUEST: "요청을 처리할 수 없어요.",
  SERVICE_DISABLED: "점검 중이에요. 잠시 후 다시 찾아와 주세요.",
};

type EventsErrorCode = Extract<ErrorCode, "INVALID_REQUEST" | "SERVICE_DISABLED">;

/** 허용 3종. 나머지는 서버가 직접 관측하므로 이 경로로 받지 않는다 */
type ClientEventName = z.infer<typeof clientEventSchema>;

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();

  if (!serviceEnabled()) {
    // 외부 호출이 없어 비용은 발생하지 않지만, 차단 중에는 모든 라우트가 같은
    // 답을 한다 (TRD 7번). 화면이 점검 상태를 한 가지 신호로 읽게 둔다.
    return errorResponse(503, "SERVICE_DISABLED", requestId);
  }

  const body = await readBody(request);
  if (!body.ok) {
    return errorResponse(400, "INVALID_REQUEST", requestId);
  }

  const parsed = eventsRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    // 목록 밖 이벤트명도 여기서 걸린다 — `clientEventSchema`가 화이트리스트다.
    // zod 원본 메시지·필드 경로는 노출하지 않는다 (API_SPEC 에러 규약).
    return errorResponse(400, "INVALID_REQUEST", requestId);
  }

  const { sessionId, event, properties } = parsed.data;

  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return errorResponse(400, "INVALID_REQUEST", requestId);
  }

  const analyticsEvent = toAnalyticsEvent(event, sessionId, properties);
  if (analyticsEvent === null) {
    return errorResponse(400, "INVALID_REQUEST", requestId);
  }

  try {
    logEvent(analyticsEvent);
  } catch (error) {
    // 진짜 `logEvent`는 어떤 예외도 삼키지만(TR-012), 그 성질에 기대어 응답
    // 경로를 무방비로 두지 않는다. 로깅이 어떤 이유로 던져도 202는 나간다.
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[events] 이벤트 기록 실패 — request_id=${requestId}: ${detail}`);
  }

  const responseBody: EventsResponse = { accepted: true };

  const validated = eventsResponseSchema.safeParse(responseBody);
  if (!validated.success) {
    // 들어오는 값만 검증 경계가 아니다. 다만 이 본문은 리터럴이라 여기까지 올
    // 수 없고, 온다면 계약 자체가 바뀐 것이다.
    console.error(`[events] 응답이 계약 스키마를 어겼습니다 — request_id=${requestId}`);
    return errorResponse(400, "INVALID_REQUEST", requestId);
  }

  // 202 — 받았다는 사실만 알리고 로깅 결과를 기다리지 않는다 (API_SPEC).
  return jsonResponse(202, validated.data, requestId);
}

/* ------------------------------------------------------------------ *
 * 내부 헬퍼
 * ------------------------------------------------------------------ */

type BodyOutcome = { ok: true; value: unknown } | { ok: false };

/**
 * 본문을 읽는다. **크기 검사는 파싱보다 먼저 한다** — 파싱한 뒤에 재면 이미
 * 8KB 넘는 값을 객체로 펼친 뒤다.
 *
 * `Content-Length`가 상한을 넘는다고 말하면 스트림을 아예 읽지 않는다. 헤더는
 * 클라이언트가 쓴 값이라 신뢰할 수 없으므로, 읽은 뒤 바이트 길이로 다시 잰다.
 */
async function readBody(request: Request): Promise<BodyOutcome> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false };
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false };
  }

  // 문자 수가 아니라 바이트 수다. 한글은 UTF-8에서 3바이트라 둘이 크게 어긋난다.
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return { ok: false };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * 검증을 통과한 요청을 `lib/analytics.ts`의 이벤트로 옮긴다.
 *
 * 반환 타입이 그 파일의 판별 유니온이므로, PRD 7번 표에 속성이 늘거나 이름이
 * 바뀌면 **여기가 컴파일 단계에서 깨진다.** 이벤트 정의를 라우트에 다시 만들지
 * 않으면서도 경계 검증을 하는 방법이다. 스키마에 없는 키는 zod가 벗겨 내므로
 * 로그 줄에 실리지 않는다.
 */
function toAnalyticsEvent(
  name: ClientEventName,
  sessionId: string,
  properties: Record<string, string | number | boolean> | undefined,
): Extract<AnalyticsEvent, { event: ClientEventName }> | null {
  switch (name) {
    case "recommend_viewed": {
      const parsed = propertiesSchema.recommend_viewed.safeParse(properties);
      return parsed.success ? { event: name, session_id: sessionId, ...parsed.data } : null;
    }
    case "recommend_accepted": {
      const parsed = propertiesSchema.recommend_accepted.safeParse(properties);
      return parsed.success ? { event: name, session_id: sessionId, ...parsed.data } : null;
    }
    case "book_resolved": {
      const parsed = propertiesSchema.book_resolved.safeParse(properties);
      return parsed.success ? { event: name, session_id: sessionId, ...parsed.data } : null;
    }
  }
}

/**
 * 긴급 차단 스위치. 값이 망가져 읽을 수 없으면 **차단 쪽으로 넘어진다** —
 * `analyze`·`resolve`와 같은 규칙이다 (PRD 리스크 표).
 */
function serviceEnabled(): boolean {
  try {
    return isServiceEnabled();
  } catch {
    console.error("[events] SERVICE_ENABLED 값을 해석할 수 없어 요청을 차단합니다");
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
function errorResponse(status: number, code: EventsErrorCode, requestId: string): Response {
  return jsonResponse(status, { error: ERROR_MESSAGES[code], code, requestId }, requestId);
}
