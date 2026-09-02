/**
 * `app/api/` 호출 래퍼 — 클라이언트의 유일한 네트워크 경계.
 *
 * `components/`는 외부 API 래퍼 레이어를 직접 부르지 않고 반드시 `app/api/`를
 * 경유한다 (ARCHITECTURE 레이어 규칙). 그 경유를 여기 한 파일로 모아 화면이
 * `fetch`·`AbortController`·상태 코드를 몰라도 되게 한다. **이 파일이 import하는
 * 것은 스키마와 타입뿐이다** — 서버 전용 모듈(외부 API 래퍼, 서명·프롬프트
 * 모듈)이 클라이언트 번들로 끌려 들어가면 API 키가 새는 경로가 열린다.
 *
 * 두 가지 규율을 지킨다.
 *
 * 1. **던지지 않는다.** 실패는 판별 가능한 값(`ApiResult`)으로 돌려준다.
 *    화면이 try/catch 없이 분기하게 하려는 것이 이 파일의 목적이다.
 * 2. **재시도하지 않는다.** 재시도 정책은 상태 머신(`lib/session.ts`)과 화면의
 *    결정이다. 여기서 숨기면 사용자가 30초를 두 번 기다리는 것을 아무도 모른다
 *    (TRD 7번 — 멱등한 것과 공짜인 것은 다르다).
 */
import { errorResponseSchema } from "@/lib/schemas";
import type {
  AnalyzeResponse,
  ErrorCode,
  MoodQuestionsResponse,
  RecommendRequest,
  RecommendResponse,
  ResolveResponse,
} from "@/types/api";
import type { BookReference } from "@/types/book";

/* ------------------------------------------------------------------ *
 * 결과 타입
 * ------------------------------------------------------------------ */

/**
 * 성공과 실패를 판별 가능한 하나의 값으로 돌려준다 —
 * 알라딘 래퍼의 `FactsOutcome`이 이미 쓰는 방식이다.
 *
 * `status`는 HTTP 상태 코드이고, **응답을 받지 못한 경우(네트워크 단절·클라이언트
 * 타임아웃)는 `0`**이다. 화면이 분기하는 기준은 언제나 `code`이며 `status`는
 * 진단용이다.
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ErrorCode; requestId: string | null; status: number };

/**
 * 클라이언트 타임아웃. **서버 하드 상한보다 길게 잡는다** — 같은 값이면
 * 클라이언트가 먼저 끊어 서버가 보낸 504와 정해진 안내 문구를 받지 못한다
 * (API_SPEC 공통 규약, TRD 6.1).
 *
 * | 호출 | 서버 상한 | 클라이언트 |
 * |---|---|---|
 * | analyze | 60s | 70s |
 * | recommend · questions | 30s | 35s |
 * | resolve | 10s | 15s |
 * | events | 3s | 5s |
 */
export const CLIENT_TIMEOUT_MS = {
  analyze: 70_000,
  resolve: 15_000,
  questions: 35_000,
  recommend: 35_000,
  events: 5_000,
} as const;

/**
 * 클라이언트가 보낼 수 있는 이벤트는 **둘뿐**이다.
 *
 * **추천 결과 조회 이벤트(추천 수락률의 분모)는 이 유니온에 없다.**
 * `app/api/recommend/route.ts`가 이미 남기고 있어, 양쪽이 보내면 North Star의
 * 분모가 이중 계상된다. 라우트가 정본이다 (PRD 7번). 유니온이 그 이름을 아예
 * 표현하지 못하므로, 실수로 보내려 하면 컴파일이 깨진다 — 주석이 아니라 타입이
 * 막는다.
 *
 * 속성은 `app/api/events/route.ts`의 화이트리스트와 같은 모양이어야 한다 —
 * 목록 밖 키는 서버가 어차피 버리고, 모자라면 400이다.
 */
export type ClientEventPayload =
  | {
      sessionId: string;
      event: "recommend_accepted";
      properties: { position: 1 | 2 | 3 };
    }
  | {
      sessionId: string;
      event: "book_resolved";
      properties: { resolve_attempt: number; matched: boolean };
    };

/* ------------------------------------------------------------------ *
 * 엔드포인트
 * ------------------------------------------------------------------ */

/** POST /api/analyze — 책장 사진에서 확인·미확인 책을 뽑는다 (US-001) */
export function analyzePhotos(
  sessionId: string,
  images: string[],
): Promise<ApiResult<AnalyzeResponse>> {
  return post<AnalyzeResponse>("/api/analyze", { sessionId, images }, CLIENT_TIMEOUT_MS.analyze);
}

/** POST /api/books/resolve — 사용자가 고친 제목으로 알라딘 재검색 (US-002) */
export function resolveBook(sessionId: string, query: string): Promise<ApiResult<ResolveResponse>> {
  return post<ResolveResponse>("/api/books/resolve", { sessionId, query }, CLIENT_TIMEOUT_MS.resolve);
}

/** POST /api/mood/questions — 기분을 비워 둔 사용자를 위한 유도 질문 (US-004) */
export function fetchMoodQuestions(
  sessionId: string,
  books: BookReference[],
): Promise<ApiResult<MoodQuestionsResponse>> {
  return post<MoodQuestionsResponse>(
    "/api/mood/questions",
    { sessionId, books },
    CLIENT_TIMEOUT_MS.questions,
  );
}

/** POST /api/recommend — 확인된 책 목록 안에서만 3권을 고른다 (US-003) */
export function requestRecommendations(
  input: RecommendRequest,
): Promise<ApiResult<RecommendResponse>> {
  return post<RecommendResponse>("/api/recommend", input, CLIENT_TIMEOUT_MS.recommend);
}

/**
 * POST /api/events — 클라이언트에서만 관측되는 이벤트를 서버 로그로 보낸다.
 *
 * **실패를 삼킨다.** 반환값이 없는 것은 의도다 — 로깅 실패가 화면을 막으면
 * 관측이 결함이 된다 (TR-012·TR-014). 서버도 같은 이유로 202를 돌려주고
 * 결과를 기다리지 않는다.
 */
export async function sendClientEvent(event: ClientEventPayload): Promise<void> {
  await post<unknown>("/api/events", event, CLIENT_TIMEOUT_MS.events);
}

/* ------------------------------------------------------------------ *
 * 전송
 * ------------------------------------------------------------------ */

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<ApiResult<T>> {
  const controller = new AbortController();
  // abort의 원인을 구분하기 위한 표식. AbortError만 보면 우리가 건 타임아웃인지
  // 다른 이유인지 알 수 없고, 그러면 네트워크 단절을 TIMEOUT으로 잘못 설명하게 된다.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // 응답을 받지 못했다. 클라이언트 타임아웃은 서버 504와 화면 동작이 같으므로
    // 같은 code로 정규화하고, 그 외(네트워크 단절·오프라인)는 재시도 안내가
    // 붙는 UPSTREAM_UNAVAILABLE로 보낸다.
    return {
      ok: false,
      code: timedOut ? "TIMEOUT" : "UPSTREAM_UNAVAILABLE",
      requestId: null,
      status: 0,
    };
  } finally {
    clearTimeout(timer);
  }

  const text = await readText(response);
  const parsed = parseJson(text);

  if (!response.ok) {
    return failure(response, parsed);
  }

  if (parsed === undefined) {
    // 200인데 본문이 우리 것이 아니다. 상대 장애가 아니라 **우리 쪽 결함**이므로
    // 502가 아니라 INTERNAL_ERROR다 (API_SPEC — 우리 결함을 남의 것으로 돌리지 않는다).
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      requestId: headerRequestId(response),
      status: response.status,
    };
  }

  return { ok: true, data: parsed as T };
}

/**
 * 실패 응답을 결과 값으로 옮긴다.
 *
 * **본문 파싱에 실패해도 반드시 결과를 돌려준다** — 배너를 띄우지 못하면
 * 사용자는 아무 설명도 못 받는다.
 */
function failure(response: Response, parsed: unknown): ApiResult<never> {
  const contract = errorResponseSchema.safeParse(parsed);
  if (contract.success) {
    return {
      ok: false,
      code: contract.data.code,
      requestId: contract.data.requestId,
      status: response.status,
    };
  }

  return {
    ok: false,
    code: inferCode(response.status),
    // 본문이 없어도 헤더에는 있을 수 있다. 없는 ID를 지어내지는 않는다.
    requestId: bodyRequestId(parsed) ?? headerRequestId(response),
    status: response.status,
  };
}

/**
 * 본문을 읽지 못했을 때 상태 코드로 사유를 유추한다.
 *
 * 504만 따로 본다. 5xx를 일괄 INTERNAL_ERROR로 접으면 **타임아웃을 우리 결함으로
 * 오귀속**하게 되고, 사용자는 "사진 장수를 줄여 보세요" 대신 엉뚱한 안내를 받는다.
 */
function inferCode(status: number): ErrorCode {
  if (status === 504) return "TIMEOUT";
  return status >= 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST";
}

function headerRequestId(response: Response): string | null {
  const value = response.headers.get("X-Request-Id");
  return value && value.length > 0 ? value : null;
}

/** 계약을 어긴 본문이라도 requestId만 성하면 건진다 */
function bodyRequestId(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = (parsed as { requestId?: unknown }).requestId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function readText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** 파싱 실패를 `undefined`로 표현한다 — 던지면 이 파일의 존재 이유가 사라진다 */
function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
