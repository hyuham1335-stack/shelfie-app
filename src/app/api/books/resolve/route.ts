/**
 * POST /api/books/resolve — 사용자가 고친 제목으로 알라딘을 다시 찾는다 (TR-008, US-002).
 *
 * ## 왜 이 경로에도 서명이 붙는가 (ADR-006)
 * `/api/recommend`는 책마다 `proof`를 검증한다. 그런데 이 라우트가 서명 없는
 * 책을 돌려주면, 클라이언트는 `analyze`를 거치지 않고 여기서 받은 아무 책이나
 * 추천 목록에 밀어 넣을 수 있다 — **자물쇠를 달고 옆문을 열어 두는 것**이다.
 * 그래서 여기서 나가는 후보는 확인된 책과 **동등한 증명**을 갖는다.
 * 후보 하나라도 서명 없이 나가면 US-002가 곧 검증 우회 통로가 된다.
 *
 * ## 서버는 고르지 않는다
 * 유사도가 가장 높은 1건을 서버가 확정하지 않는다. 알라딘 검색 순위 그대로
 * 최대 5건을 돌려주고 선택은 사용자에게 맡긴다 — 그것이 US-002의 설계다.
 * 재정렬도 하지 않는다.
 *
 * ## 없는 것과 못 찾은 것은 다른 응답이다 (ADR-005)
 * 검색 결과 0건은 404(`NOT_FOUND_IN_ALADIN`, "원서·절판일 수 있어요")이고,
 * 알라딘이 5xx·타임아웃으로 답하지 못한 것은 502("지금 확인할 수 없었어요")다.
 * 시스템 문제를 데이터 문제로 설명하면 사용자는 사실이 아닌 설명을 받는다.
 *
 * ## Claude를 부르지 않는다
 * 이 응답에는 `claudeNote`가 없다. 사용자가 후보를 확정한 뒤 클라이언트가
 * 목록에 합류시키며 한줄평은 비워 둔다 (API_SPEC).
 *
 * ## 상태를 남기지 않는다 (ADR-003)
 * 요청 스코프 브레이커도 요청마다 새로 만들어 요청이 끝나면 사라진다.
 */
import { randomUUID } from "node:crypto";

import { createBudget } from "@/lib/budget";
import { isServiceEnabled, MAX_ALADIN_CANDIDATES } from "@/lib/env";
import { issueProof } from "@/lib/proof";
import { resolveRequestSchema, resolveResponseSchema } from "@/lib/schemas";
import { createRequestBreaker, lookupFactsMany, searchByTitle } from "@/services/aladin";
import type { ErrorCode, ResolveResponse } from "@/types/api";

/** `lib/proof.ts`가 Node 내장 `crypto`를 쓴다. Edge에서는 동작하지 않는다 (TRD 2번) */
export const runtime = "nodejs";

/** 이 라우트의 하드 상한 10초 (API_SPEC 공통 규약) */
export const maxDuration = 10;

/**
 * 요청 하나의 내부 총 예산. 함수 상한에서 응답 조립·서명 발급 여유 1s를 뺀 값이다.
 *
 * `analyze`가 55s를 세 단계로 쪼갠 것과 같은 규칙이되(TRD 7번), 이 라우트는
 * 단계가 하나(알라딘 조회)뿐이라 `lib/budget`의 단계 배분표를 쓰지 않고
 * 남은 시간을 그대로 조회에 넘긴다. 예산을 여기서 잡는 이유는 같다 — 개별
 * 호출 타임아웃(5s × 재시도)의 합이 함수 상한을 넘기면 플랫폼이 연결을 끊어
 * API_SPEC이 정의한 504조차 돌려주지 못한다 (ADR-005).
 */
const RESOLVE_BUDGET_MS = 9_000;

/**
 * 사용자에게 그대로 보이는 문구. 모델 생성물·내부 원문은 절대 쓰지 않는다 (API_SPEC).
 * 이 라우트가 실제로 낼 수 있는 코드만 담는다.
 */
const ERROR_MESSAGES: Record<ResolveErrorCode, string> = {
  INVALID_REQUEST: "찾을 제목을 1~200자로 입력해 주세요.",
  // UI_GUIDE의 `no_match` 문장과 같은 것을 쓴다 — 이 404가 곧 그 상태다.
  NOT_FOUND_IN_ALADIN: "알라딘에서 찾을 수 없는 책이에요 (원서·절판일 수 있어요).",
  UPSTREAM_UNAVAILABLE: "지금 확인할 수 없었어요. 잠시 후 다시 시도해 주세요.",
  TIMEOUT: "시간이 오래 걸려 중단했어요. 잠시 후 다시 시도해 주세요.",
  SERVICE_DISABLED: "점검 중이에요. 잠시 후 다시 찾아와 주세요.",
  // 우리 쪽 결함(500). 문구는 502와 같다 — 사용자가 할 수 있는 일이 같기 때문이고,
  // 원인을 구분해야 하는 자리는 응답이 아니라 로그다 (API_SPEC).
  INTERNAL_ERROR: "문제가 생겨 중단했어요. 잠시 후 다시 시도해 주세요.",
};

type ResolveErrorCode = Extract<
  ErrorCode,
  | "INVALID_REQUEST"
  | "NOT_FOUND_IN_ALADIN"
  | "UPSTREAM_UNAVAILABLE"
  | "TIMEOUT"
  | "SERVICE_DISABLED"
  | "INTERNAL_ERROR"
>;

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  // 예산은 **가장 먼저** 연다. 본문을 읽는 시간도 총 예산 안에서 흐른다.
  const budget = createBudget(RESOLVE_BUDGET_MS);

  if (!serviceEnabled()) {
    // 외부 호출을 하지 않으므로 비용이 발생하지 않는다 (TRD 7번 긴급 차단 스위치).
    return errorResponse(503, "SERVICE_DISABLED", requestId);
  }

  const parsed = await readRequest(request);
  if (!parsed.ok) {
    return errorResponse(400, "INVALID_REQUEST", requestId);
  }

  const { query, author } = parsed.value;

  // 브레이커도 데드라인도 **요청 하나**가 ItemSearch와 ItemLookUp에 나눠 준다.
  // 각자 예산을 따로 잡으면 합이 함수 상한을 넘고, 브레이커를 따로 두면 이미
  // 죽은 알라딘을 두 번 두드린다 (TRD 7번 요청 스코프 브레이커).
  const breaker = createRequestBreaker();

  const search = await searchByTitle(query, author, {
    deadlineMs: budget.remainingMs(),
    breaker,
  });

  if (search.status === "failed") {
    // 알라딘이 답하지 못한 것이다. "그 책은 없다"고 말할 근거가 전혀 없다 (ADR-005).
    return upstreamFailure(budget, requestId);
  }

  if (search.candidates.length === 0) {
    // 검색은 성공했고 결과가 정말 0건이다. 이때만 404다.
    return errorResponse(404, "NOT_FOUND_IN_ALADIN", requestId);
  }

  // **자르고 나서 조회한다.** 어차피 5건만 돌려주므로 나머지까지 ItemLookUp을
  // 부르면 알라딘 일일 한도(5,000회)만 축난다 (TRD 10번).
  const shortlist = search.candidates.slice(0, MAX_ALADIN_CANDIDATES);

  const factsOutcomes = await lookupFactsMany(
    shortlist.map((candidate) => candidate.isbn13),
    { deadlineMs: budget.remainingMs(), breaker },
  );

  // 한 요청의 서명은 같은 시각을 기준으로 발급한다 — 만료가 책마다 어긋날 이유가 없다.
  const issuedAt = Date.now();
  const candidates: ResolveResponse["candidates"] = [];

  shortlist.forEach((candidate, index) => {
    const outcome = factsOutcomes[index];
    if (outcome.status !== "ok") {
      // 사실을 못 채운 책은 후보로 내보내지 않는다. 빈 칸을 사실인 것처럼 보여
      // 주는 것이 이 제품이 가장 두려워하는 실패다 (ADR-002). 그 책만 버리고
      // 나머지는 그대로 나간다 — 강등(fail-soft) 패턴이다.
      return;
    }

    candidates.push({
      // 신원 필드는 ItemSearch 후보를 쓴다 — 목업 모드(TTB 키 없음)에서는
      // ItemLookUp이 신원을 만들어 낼 수 없기 때문이다 (services/aladin.ts).
      isbn13: candidate.isbn13,
      title: candidate.title,
      author: candidate.author,
      publisher: candidate.publisher,
      coverUrl: candidate.coverUrl,
      pages: outcome.facts.pages,
      aladinRating: outcome.facts.aladinRating,
      aladinLink: outcome.facts.aladinLink,
      // 확인된 책과 동등한 증명. 하나라도 빠지면 검증 우회 통로가 열린다 (ADR-006).
      proof: issueProof(
        { isbn13: candidate.isbn13, title: candidate.title, author: candidate.author },
        issuedAt,
      ),
    });
  });

  if (candidates.length === 0) {
    // 검색은 찾아냈는데 사실을 하나도 못 채웠다 — 알라딘에 없다는 뜻이 아니므로
    // 404가 아니다. 위 `search.status === "failed"`와 같은 종류의 실패다.
    return upstreamFailure(budget, requestId);
  }

  const body: ResolveResponse = { candidates };

  // 우리가 만든 응답도 계약을 지키는지 기계로 확인한다. 검증 경계는 들어오는
  // 값에만 있는 것이 아니다 — 여기서 걸리면 계약을 어긴 본문을 내보내지 않는다.
  const validated = resolveResponseSchema.safeParse(body);
  if (!validated.success) {
    // 여기까지 오는 유일한 경로는 `services/`의 검증을 통과한 외부 값이 우리
    // 계약과 어긋나는 경우다. 502로 내보내면 **우리 결함이 알라딘 장애로**
    // 기록된다. 알라딘이 실제로 실패한 위쪽 경로는 그대로 502로 남는다.
    console.error(`[resolve] 응답이 계약 스키마를 어겼습니다 — request_id=${requestId}`);
    return errorResponse(500, "INTERNAL_ERROR", requestId);
  }

  return jsonResponse(200, validated.data, requestId);
}

/* ------------------------------------------------------------------ *
 * 내부 헬퍼
 * ------------------------------------------------------------------ */

type RequestOutcome =
  | { ok: true; value: { sessionId: string; query: string; author: string | null } }
  | { ok: false };

/**
 * 본문을 읽고 서버에서 다시 검증한다. 클라이언트 검증을 신뢰하지 않는다 (TRD 6.5).
 *
 * zod 이슈를 그대로 노출하지 않는다 — 필드 경로와 원본 메시지는 사용자에게
 * 의미가 없고 내부 구조를 흘린다 (API_SPEC 에러 규약). 이 라우트의 400은
 * 조건이 하나뿐(제목 길이)이라 코드도 `INVALID_REQUEST` 하나로 끝난다.
 */
async function readRequest(request: Request): Promise<RequestOutcome> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false };
  }

  const parsed = resolveRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false };
  }

  const { sessionId, query, author } = parsed.data;
  // 저자는 선택이다. 없음을 한 가지 값(null)으로 좁혀 `services/`에 넘긴다.
  return { ok: true, value: { sessionId, query, author: author ?? null } };
}

/**
 * 알라딘을 조회하지 못했을 때의 응답.
 *
 * 우리 예산이 바닥났으면 504, 알라딘 쪽이 실패한 것이면 502다. 둘을 뭉개면
 * "사진 장수를 줄여 보라"와 "잠시 후 다시 시도하라" 중 어느 안내를 해야 할지
 * 화면이 알 수 없게 된다 (API_SPEC 에러 규약).
 */
function upstreamFailure(budget: ReturnType<typeof createBudget>, requestId: string): Response {
  if (budget.remainingMs() <= 0) {
    return errorResponse(504, "TIMEOUT", requestId);
  }
  return errorResponse(502, "UPSTREAM_UNAVAILABLE", requestId);
}

/**
 * 긴급 차단 스위치. 값이 망가져 읽을 수 없으면 **차단 쪽으로 넘어진다** —
 * 스위치를 해석하지 못하는 상태로 외부 API를 계속 부르는 것보다, 점검 안내를
 * 보여 주고 비용을 0으로 두는 편이 안전하다 (PRD 리스크 표).
 */
function serviceEnabled(): boolean {
  try {
    return isServiceEnabled();
  } catch {
    console.error("[resolve] SERVICE_ENABLED 값을 해석할 수 없어 요청을 차단합니다");
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
function errorResponse(status: number, code: ResolveErrorCode, requestId: string): Response {
  return jsonResponse(status, { error: ERROR_MESSAGES[code], code, requestId }, requestId);
}
