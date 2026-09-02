/**
 * Claude API 래퍼 — 책등 추출 (TR-003)과 한줄평 배치 (TR-007).
 *
 * ## 이 파일이 곧 경계다 (ADR-001)
 * provider 어댑터 레이어를 만들지 않는다. 공급자를 바꿔야 할 일이 생기면 이 파일
 * 하나를 통째로 교체한다. 그 비용이 추상화를 미리 만드는 비용보다 작다고 판단한
 * 결정이므로, 여기에 "언젠가 다른 공급자도"를 위한 간접층을 넣는 순간 그 판단이
 * 무의미해진다. 그래서 SDK 타입도 밖으로 새어 나가지 않는다 — 이 모듈이 내보내는
 * 것은 `ExtractOutcome`·`NoteOutcome` 두 결과 타입뿐이다.
 *
 * ## 실패는 예외가 아니라 값이다
 * 사진 한 장의 실패로 요청 전체가 죽으면 fail-soft가 성립하지 않는다. 호출부는
 * 실패한 사진의 인덱스를 모아 `failedPhotoIndexes`에 담고 성공분은 그대로
 * 반환한다 (/docs/ARCHITECTURE.md 강등 패턴, TR-006).
 *
 * `reason`을 5종으로 나누는 이유는 **사유 보존** 때문이다. "지금 확인 못 함
 * (timeout·upstream)"과 "모델이 거절함(refusal)"과 "응답이 계약을 어김(schema)"은
 * 사용자에게 다르게 설명해야 하고, 코드에서도 끝까지 다른 값으로 나른다 (ADR-005).
 *
 * ## 검증 경계 (CLAUDE.md CRITICAL)
 * 모델 응답은 `lib/schemas.ts`의 `extractionResultSchema`를 통과한 뒤에만 도메인
 * 값이 된다. 사진당 후보 60건 상한도 그 스키마가 강제하며, 여기서 따로 자르지
 * 않는다 — 상한이 두 곳에 생기면 한쪽만 고쳐진다.
 *
 * ## 시간 예산 (ADR-005)
 * 자체 타임아웃 상수를 두지 않는다. 이 모듈은 `budget.deadlineFor("extract")`가
 * 준 시간 안에서만 살고, 그 시간이 0이면 호출조차 하지 않는다. 개별 상수를 따로
 * 두면 단계 예산의 합이 함수 상한을 넘겨 플랫폼이 연결을 끊는다.
 *
 * ## 로그에 남기지 않는 것
 * API 키(TRD 6.5)와 판독 원문 `rawText`(PRD 7번). 그래서 이 모듈의 로그 출구는
 * `warn()` 하나이고, 어떤 호출부도 SDK 에러 메시지나 모델 응답 본문을 넘기지 않는다.
 */
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { z } from "zod";

import { STAGE_BUDGET_MS } from "@/lib/budget";
import {
  MAX_RECOMMENDATIONS,
  getAnthropicApiKey,
  getExtractModel,
  getRecommendModel,
} from "@/lib/env";
import {
  buildExtractPrompt,
  buildNotePrompt,
  buildQuestionsPrompt,
  buildRecommendPrompt,
  extractionJsonSchema,
  noteBatchSchema,
  noteJsonSchema,
  questionsJsonSchema,
  questionsOutputSchema,
  recommendJsonSchema,
  recommendOutputSchema,
} from "@/lib/prompts";
import type { PromptBook, RecommendPromptBook } from "@/lib/prompts";
import {
  extractedCandidateSchema,
  extractionResultSchema,
  imageDataUriSchema,
  isbn13Schema,
  recommendationSchema,
} from "@/lib/schemas";
import type { ExtractedCandidate } from "@/types/book";
import type { MoodQuestion } from "@/types/api";

/**
 * 비스트리밍 호출의 출력 상한 (TRD 7번 호출 규약).
 * 낮게 잡아 응답이 잘리면 재시도 비용이 더 크다.
 */
export const MAX_OUTPUT_TOKENS = 16_000;

/**
 * 서버사이드 fallback 베타 (TRD 7번).
 * 안전 분류기가 거절하면 Anthropic이 다른 모델로 자동 라우팅한다. 폴백 공급자가
 * 없는 구조(ADR-001)에서 거절 한 번이 곧 사진 한 장의 손실이므로 켜 둔다.
 */
export const EXTRACT_BETAS = ["server-side-fallback-2026-07-01"] as const;

/**
 * 재시도 전 대기 (PRD 5번 "지수 백오프 1초").
 * **타임아웃 상수가 아니다** — 이 대기도 남은 데드라인을 넘지 못하게 잘린다.
 */
export const RETRY_BACKOFF_MS = 1_000;

/* ------------------------------------------------------------------ *
 * 공개 타입
 * ------------------------------------------------------------------ */

/** Claude 호출 1회의 토큰 사용량. 세션당 비용 가드레일의 원재료다 (PRD 7번) */
export interface ExtractUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * 사진 한 장이 실패한 사유. 사용자에게 다르게 설명해야 하므로 뭉개지 않는다.
 *
 * - `refusal`    : 안전 분류기 거절. 재시도하지 않는다
 * - `max_tokens` : 응답이 잘렸다. 부분 파싱하지 않고 통째로 버린다
 * - `timeout`    : 예산 소진 또는 호출 타임아웃
 * - `schema`     : 응답이 계약을 어겼다 (우리 쪽 또는 모델 쪽 계약 변경 신호)
 * - `upstream`   : Anthropic 장애·거부 (4xx·5xx·연결 오류)
 */
export type ExtractFailureReason = "refusal" | "max_tokens" | "timeout" | "schema" | "upstream";

export interface ExtractOptions {
  /** 이 호출에 쓸 수 있는 시간(ms). `budget.deadlineFor("extract")`를 그대로 넘긴다 */
  deadlineMs: number;
  /** 몇 번째 사진인가 (0-based). **서버가 붙이는 값이다** — 모델에게 요구하지 않는다 */
  photoIndex: number;
  /** 테스트 주입점. SDK를 갈아 끼운다. 생략하면 `ANTHROPIC_API_KEY`로 새 클라이언트를 만든다 */
  clientImpl?: unknown;
  /** 재시도 백오프 대기. 테스트가 실제로 1초를 기다리지 않게 하는 주입점이다 */
  sleepImpl?: (ms: number) => Promise<void>;
}

export type ExtractOutcome =
  | { status: "ok"; candidates: ExtractedCandidate[]; usage: ExtractUsage }
  /**
   * `usage`가 **선택적인** 이유는 실패 사유마다 토큰을 썼는지가 다르기 때문이다.
   *
   * 응답을 받고 나서 실패한 경우(refusal·max_tokens·응답 스키마 위반)는 토큰이
   * 이미 과금됐다. 그 값을 버리면 `analyze_completed`의 토큰 합계가 실제보다 낮게
   * 나오고, "세션당 300원" 가드레일이 통과할 수 없는 조건에서 통과한다 (PRD 7번).
   * 반대로 호출 자체가 없었던 경우(예산 소진·데이터 URI 위반)와 응답을 받지 못한
   * 경우(timeout·연결 오류)는 쓴 토큰이 없으므로 `usage`가 없는 것이 맞다 —
   * 0을 지어내면 "호출했는데 공짜였다"로 읽힌다.
   */
  | { status: "failed"; reason: ExtractFailureReason; usage?: ExtractUsage };

/** 한줄평 배치가 실패한 사유. 추출과 같은 5종을 쓴다 — 사유 어휘를 둘로 나누지 않는다 */
export type NoteFailureReason = ExtractFailureReason;

/**
 * 한줄평 배치의 결과 (TR-007, FR-008).
 *
 * `skipped`와 `failed`를 나누는 것은 **사유 보존**이다 (ADR-005). "예산이 없어서
 * 안 불렀다"와 "불렀는데 거절당했다"는 다른 사실이고 로그에서 구분돼야 한다.
 * 화면에 보이는 결과는 둘 다 `claudeNote: ""`로 같지만, 뭉개 두면 한줄평이 왜
 * 비었는지 나중에 알 수 없다.
 */
export type NoteOutcome =
  /** `notes`의 키는 `isbn13`이다. 요청한 책이 전부 들어 있지는 않다 — 없는 책은 호출부가 빈 문자열로 둔다 */
  | { status: "ok"; notes: Map<string, string>; usage: ExtractUsage }
  | { status: "skipped"; reason: "budget" | "no_books" }
  | { status: "failed"; reason: NoteFailureReason; usage?: ExtractUsage };

export interface NoteOptions {
  /** 이 단계에 쓸 수 있는 시간(ms). `budget.deadlineFor("note")`를 그대로 넘긴다 */
  deadlineMs: number;
  /** 테스트 주입점. SDK를 갈아 끼운다 */
  clientImpl?: unknown;
  /** 재시도 백오프 대기 주입점 */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** 한줄평 프롬프트에 싣는 책. 사실 필드는 필요 없다 — 모델은 해석만 쓴다 (ADR-002) */
export interface NoteBook {
  isbn13: string;
  title: string;
  author: string;
}

/**
 * 이 모듈이 SDK에서 실제로 쓰는 표면 전부.
 *
 * SDK 전체 타입을 요구하지 않는 이유는 두 가지다. ① 테스트가 이 모양만 만족하면
 * 되므로 실제 API를 칠 이유가 사라진다(TRD 8번). ② 설치된 `@anthropic-ai/sdk`
 * 0.68은 `output_config`·`fallbacks`·`thinking: adaptive`를 아직 타입으로 모른다 —
 * TRD 7번이 요구한 호출 규약은 이 버전의 타입 정의보다 새롭다. 본문은 그대로
 * 전송되므로 동작에는 문제가 없고, 경계를 여기 한 곳으로 좁혀 캐스팅도 한 번만 한다.
 */
interface MessagesClient {
  beta: {
    messages: {
      create(body: MessageRequestBody, options?: { timeout?: number }): Promise<unknown>;
    };
  };
}

/**
 * 우리가 만들어 보내는 요청 본문. TRD 7번 호출 규약이 그대로 형태로 드러난다.
 * 추출과 한줄평이 같은 형태를 공유한다 — 규약이 두 벌이 되면 한쪽만 고쳐진다.
 */
interface MessageRequestBody {
  model: string;
  max_tokens: number;
  /** `budget_tokens`를 쓰지 않는다 — `claude-opus-5`에서 400을 반환한다 (TRD 7번) */
  thinking: { type: "adaptive" };
  output_config: { format: { type: "json_schema"; schema: unknown } };
  betas: string[];
  fallbacks: "default";
  messages: {
    role: "user";
    content: (
      | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
      | { type: "text"; text: string }
    )[];
  }[];
}

/* ------------------------------------------------------------------ *
 * 응답 스키마 — 검증 경계
 * ------------------------------------------------------------------ */

/**
 * 응답 봉투. `content`보다 `stop_reason`을 먼저 읽기 위해 봉투를 따로 판다.
 *
 * `usage`를 필수로 두는 것은 의도다. 토큰 수가 빠진 채 성공을 돌려주면 세션당
 * 비용이 실제보다 낮게 집계되어 "세션당 300원" 가드레일이 통과할 수 없는
 * 조건에서도 통과한다 (PRD 7번). 그런 응답은 성공이 아니라 계약 위반이다.
 */
const messageEnvelopeSchema = z.object({
  stop_reason: z.string().nullable().optional(),
  content: z.array(z.unknown()),
  usage: z.object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
  }),
});

/** 구조화 출력이 담겨 오는 블록. thinking 블록이 앞에 올 수 있으므로 골라 읽는다 */
const textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

/** 데이터 URI를 media_type과 base64 본문으로 가른다 */
const DATA_URI_PARTS = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/;

/* ------------------------------------------------------------------ *
 * 공개 API
 * ------------------------------------------------------------------ */

/**
 * 이미지 1장에서 책 후보를 뽑는다. 실패를 예외가 아니라 판별 가능한 값으로 돌려준다.
 *
 * 호출 없이 바로 실패를 돌려주는 두 경우가 있다.
 * ① 남은 데드라인이 없음 → `timeout` (예산을 넘긴 사진은 실패로 집계된다, TRD 7번)
 * ② 이미지가 데이터 URI 계약을 어김 → `schema` (라우트가 이미 걸렀어야 하는 값이다)
 */
export async function extractFromPhoto(
  imageDataUri: string,
  options: ExtractOptions,
): Promise<ExtractOutcome> {
  const { deadlineMs, photoIndex, clientImpl, sleepImpl = defaultSleep } = options;

  if (deadlineMs <= 0) {
    warn("남은 추출 예산이 없어 호출을 생략합니다");
    return { status: "failed", reason: "timeout" };
  }

  const image = parseImageSource(imageDataUri);
  if (image === null) {
    // 본문을 로그에 넣지 않는다 — base64 이미지는 사생활 그 자체다 (PRD 리스크 표).
    warn("이미지가 데이터 URI 계약을 어겼습니다 — 호출하지 않습니다");
    return { status: "failed", reason: "schema" };
  }

  const apiKey = getAnthropicApiKey();
  if (apiKey === null) return mockOutcome(photoIndex);

  const deadlineAt = Date.now() + deadlineMs;
  const client = resolveClient(clientImpl, apiKey);
  const body = buildExtractBody(image);

  const attempt = await callWithRetry(client, body, deadlineAt, sleepImpl);

  if (attempt.kind === "failed") {
    return failedExtract(attempt.reason, attempt.usage);
  }

  return toOutcome(attempt.result, photoIndex);
}

/* ------------------------------------------------------------------ *
 * 공개 API — 한줄평 배치 (TR-007, FR-008)
 * ------------------------------------------------------------------ */

/**
 * 확인된 책 **전체**의 한줄평을 1회 호출로 생성한다 (TR-007).
 *
 * 책마다 부르지 않는 이유는 비용과 시간 둘 다다. 50권이면 50회 호출이 되고,
 * 한줄평 예산 8s 안에 끝날 수가 없다. 배치 1회가 그 예산 안에서 사는 유일한 형태다.
 *
 * 호출하지 않고 바로 돌아가는 경우가 둘이다.
 * ① 책이 0권 → `skipped: no_books` (부를 이유가 없다)
 * ② 남은 예산이 단계 예산(8s)보다 적음 → `skipped: budget`
 *
 * ②의 판정이 추출과 다른 것은 의도다. 추출·대조는 도중에 끊겨도 거기까지를 살릴 수
 * 있지만 한줄평은 배치 1회라 절반만 받아 쓸 수 없다. 그래서 TRD 7번은 "남은 예산이
 * 8s 미만이면 **호출을 생략**"이라고 정했고, `budget.deadlineFor("note")`가 주는
 * 값(= min(8s, 남은 예산))을 여기서 그대로 8s와 비교한다. 정각 8s는 생략하지 않는다.
 *
 * 실패는 전부 값으로 돌아간다. 한줄평은 사실이 아니라 해석이므로(ADR-002) 없어도
 * 책은 그대로 반환된다 — 호출부는 `claudeNote: ""`로 두고 요청을 성공시킨다.
 */
export async function generateNotes(
  books: readonly NoteBook[],
  options: NoteOptions,
): Promise<NoteOutcome> {
  const { deadlineMs, clientImpl, sleepImpl = defaultSleep } = options;

  if (books.length === 0) {
    return { status: "skipped", reason: "no_books" };
  }

  if (deadlineMs < STAGE_BUDGET_MS.note) {
    warn("남은 한줄평 예산이 단계 예산보다 적어 호출을 생략합니다 (claudeNote는 빈 문자열로 남습니다)");
    return { status: "skipped", reason: "budget" };
  }

  const apiKey = getAnthropicApiKey();
  if (apiKey === null) return mockNoteOutcome(books);

  const deadlineAt = Date.now() + deadlineMs;
  const client = resolveClient(clientImpl, apiKey);

  const first = await runNoteBatch(client, books, deadlineAt, sleepImpl);
  if (first.kind === "ok") {
    return { status: "ok", notes: first.notes, usage: first.usage };
  }

  // **배치는 단건과 다르게 max_tokens를 다룬다** (TRD 7번). 단건(추출·추천·문답)은
  // 재시도 없이 그 항목만 실패시키지만, 배치는 입력이 크다는 것 자체가 절단의
  // 원인이므로 **입력을 절반으로 쪼개 1회 재시도**한다. 잘린 JSON을 부분 파싱해
  // 살려 쓰는 길은 여기서도 막혀 있다 — 그것은 검증 경계를 우회하는 것이다.
  if (first.reason !== "max_tokens" || books.length < 2) {
    return failedNotes(first.reason, first.usage);
  }

  return retryHalved(client, books, deadlineAt, sleepImpl, first.usage);
}

/**
 * 절반으로 쪼갠 재시도 1회. **다시 쪼개지 않는다** — 재귀로 나누면 호출 수가
 * 입력에 따라 예측 불가능해지고, 그 비용은 TRD 6.1의 최악값 표 밖으로 나간다.
 *
 * 한쪽이라도 실패하면 전체를 실패로 돌려준다. 절반만 성공한 결과를 돌려주면
 * 어떤 책에 한줄평이 붙는지가 절단 위치에 따라 달라져 같은 입력에 다른 화면이
 * 나온다. 그때까지 쓴 토큰은 `usage`로 합산해 나른다.
 */
async function retryHalved(
  client: MessagesClient,
  books: readonly NoteBook[],
  deadlineAt: number,
  sleepImpl: (ms: number) => Promise<void>,
  spent: ExtractUsage | undefined,
): Promise<NoteOutcome> {
  warn("한줄평 응답이 max_tokens로 잘렸습니다 — 입력을 절반으로 쪼개 1회만 재시도합니다");

  const middle = Math.ceil(books.length / 2);
  const halves = [books.slice(0, middle), books.slice(middle)];

  let usage = spent;
  const notes = new Map<string, string>();

  for (const half of halves) {
    const attempt = await runNoteBatch(client, half, deadlineAt, sleepImpl);
    usage = addUsage(usage, attempt.usage);

    if (attempt.kind === "failed") {
      return failedNotes(attempt.reason, usage);
    }
    for (const [isbn13, note] of attempt.notes) notes.set(isbn13, note);
  }

  return { status: "ok", notes, usage: usage ?? EMPTY_USAGE };
}

/** 배치 1회 — 요청 조립부터 스키마 통과까지. 재시도 정책은 추출과 같다 */
async function runNoteBatch(
  client: MessagesClient,
  books: readonly NoteBook[],
  deadlineAt: number,
  sleepImpl: (ms: number) => Promise<void>,
): Promise<NoteBatchResult> {
  const attempt = await callWithRetry(client, buildNoteBody(books), deadlineAt, sleepImpl);

  if (attempt.kind === "failed") {
    return { kind: "failed", reason: attempt.reason, usage: attempt.usage };
  }

  return toNoteResult(attempt.result, books);
}

/**
 * 봉투를 한줄평 Map으로 옮긴다.
 *
 * **스키마 위반은 배치 전체를 실패시킨다.** 60자를 넘긴 한줄평을 잘라 내거나 그
 * 책만 빼고 나머지를 살리는 길을 택하지 않았고, 그 이유는 둘이다. ① `noteBatchSchema`는
 * `lib/prompts.ts`가 `identifiedBookSchema.claudeNote`에서 파생시킨 계약이라,
 * 항목을 하나씩 다시 파싱하려면 60자 상한을 이 파일에서 다시 조립해야 한다 —
 * 상한이 두 곳에 생기면 한쪽만 고쳐진다. ② 실패의 대가가 작다. 한줄평은 해석이라
 * 전원 빈 문자열이어도 책 목록과 추천은 그대로 나간다 (ADR-002·FR-008). 후보 하나의
 * 위반이 사진 전체를 `schema`로 만드는 추출 쪽 판단과 같은 결이다.
 */
function toNoteResult(
  envelope: z.infer<typeof messageEnvelopeSchema>,
  books: readonly NoteBook[],
): NoteBatchResult {
  const usage = toUsage(envelope);

  const text = findStructuredOutput(envelope.content);
  if (text === null) {
    warn("한줄평 응답에 구조화 출력 텍스트 블록이 없습니다");
    return { kind: "failed", reason: "schema", usage };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    warn("한줄평 구조화 출력이 JSON이 아닙니다 — 문자열에서 건져 내지 않고 실패 처리합니다");
    return { kind: "failed", reason: "schema", usage };
  }

  const batch = noteBatchSchema.safeParse(payload);
  if (!batch.success) {
    // 모델이 만든 문자열을 로그에 넣지 않는다. 60자 초과·isbn13 형식 위반이 여기 걸린다.
    warn("한줄평 응답이 스키마를 통과하지 못했습니다 (60자 초과 또는 필드 위반)");
    return { kind: "failed", reason: "schema", usage };
  }

  // **화이트리스트 검증은 추천만의 것이 아니다.** 요청에 없던 `isbn13`이 섞여 오면
  // 그 책은 우리가 확인한 책이 아니므로 버린다 — 남겨 두면 확인되지 않은 책에
  // 해석이 붙어 화면까지 갈 길이 열린다 (ADR-002).
  const allowed = new Set(books.map((book) => book.isbn13));
  const notes = new Map<string, string>();
  let dropped = 0;

  for (const item of batch.data.notes) {
    if (!allowed.has(item.isbn13)) {
      dropped += 1;
      continue;
    }
    if (!notes.has(item.isbn13)) notes.set(item.isbn13, item.note);
  }

  if (dropped > 0) {
    warn(`요청 목록에 없는 책의 한줄평 ${dropped}건을 버렸습니다`);
  }

  return { kind: "ok", notes, usage };
}

/* ------------------------------------------------------------------ *
 * 내부 — 호출 1회
 * ------------------------------------------------------------------ */

type Attempt =
  | { kind: "ok"; result: z.infer<typeof messageEnvelopeSchema> }
  /** `usage`는 응답을 받고 나서 실패했을 때만 있다 — 던져진 오류에는 토큰 수가 없다 */
  | { kind: "failed"; reason: ExtractFailureReason; retryable: boolean; usage?: ExtractUsage };

/** 한줄평 배치 1회의 내부 결과. 공개 타입(`NoteOutcome`)과 달리 `skipped`가 없다 */
type NoteBatchResult =
  | { kind: "ok"; notes: Map<string, string>; usage: ExtractUsage }
  | { kind: "failed"; reason: NoteFailureReason; usage?: ExtractUsage };

function failed(
  reason: ExtractFailureReason,
  retryable: boolean,
  usage?: ExtractUsage,
): Attempt {
  return { kind: "failed", reason, retryable, usage };
}

/** 토큰을 쓰지 않았을 때의 값. 목업 모드에서만 쓴다 */
const EMPTY_USAGE: ExtractUsage = { input_tokens: 0, output_tokens: 0 };

function toUsage(envelope: z.infer<typeof messageEnvelopeSchema>): ExtractUsage {
  return {
    input_tokens: envelope.usage.input_tokens,
    output_tokens: envelope.usage.output_tokens,
  };
}

/**
 * 여러 호출에 걸친 토큰을 합산한다 (배치 절반 재시도).
 * 둘 다 없으면 `undefined`다 — 쓰지 않은 토큰을 0으로 지어내지 않는다.
 */
function addUsage(
  left: ExtractUsage | undefined,
  right: ExtractUsage | undefined,
): ExtractUsage | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
  };
}

/** `usage`가 없을 때 키 자체를 만들지 않는다 — `usage: undefined`는 "0을 썼다"로 오독된다 */
function failedExtract(reason: ExtractFailureReason, usage?: ExtractUsage): ExtractOutcome {
  return usage === undefined
    ? { status: "failed", reason }
    : { status: "failed", reason, usage };
}

function failedNotes(reason: NoteFailureReason, usage?: ExtractUsage): NoteOutcome {
  return usage === undefined
    ? { status: "failed", reason }
    : { status: "failed", reason, usage };
}

/**
 * 호출 1회 + 재시도 1회. 추출과 한줄평이 같은 정책을 쓴다 (TRD 7번).
 *
 * 재시도는 **429·5xx·연결 오류에만** 1회다. refusal·max_tokens·4xx·schema는
 * 다시 걸어도 같은 결과이고, 호출 한 번은 그대로 비용이 된다.
 */
async function callWithRetry(
  client: MessagesClient,
  body: MessageRequestBody,
  deadlineAt: number,
  sleepImpl: (ms: number) => Promise<void>,
): Promise<Attempt> {
  const attempt = await callOnce(client, body, remainingMs(deadlineAt));
  if (attempt.kind !== "failed" || !attempt.retryable) return attempt;

  await sleepImpl(Math.min(RETRY_BACKOFF_MS, remainingMs(deadlineAt)));

  const remaining = remainingMs(deadlineAt);
  if (remaining <= 0) return attempt;

  return callOnce(client, body, remaining);
}

/**
 * SDK를 한 번 부르고 봉투까지만 검증한다.
 *
 * **`content`를 읽기 전에 `stop_reason`을 본다** (TRD 7번). 순서를 뒤집으면
 * 잘린 응답을 파싱해 살려 쓰는 코드가 자연스럽게 생기고, 그 반쪽 데이터가
 * 확인된 책으로 올라가면 이 프로젝트가 가장 두려워하는 사고가 된다 (ADR-002).
 */
async function callOnce(
  client: MessagesClient,
  body: MessageRequestBody,
  timeoutMs: number,
): Promise<Attempt> {
  let raw: unknown;
  try {
    raw = await client.beta.messages.create(body, { timeout: timeoutMs });
  } catch (error) {
    return classifyError(error);
  }

  const envelope = messageEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    warn("응답 봉투가 계약과 다릅니다 — 계약 테스트를 확인하세요");
    return failed("schema", false);
  }

  const stopReason = envelope.data.stop_reason;

  // 아래 두 실패에는 **토큰 수를 함께 나른다.** 거절도 절단도 응답이 돌아온
  // 것이므로 이미 과금됐고, 여기서 버리면 세션당 비용이 실제보다 낮게 집계된다
  // (PRD 7번 가드레일).
  if (stopReason === "refusal") {
    // 재시도하지 않는다. 같은 입력은 같은 분류기 판정을 받는다 (TR-003).
    warn("모델이 요청을 거절했습니다 (stop_reason=refusal) — 재시도하지 않습니다");
    return failed("refusal", false, toUsage(envelope.data));
  }

  if (stopReason === "max_tokens") {
    // 잘린 JSON을 부분 파싱해 살려 쓰지 않는다. 그것은 검증 경계를 우회하는 것이다.
    // 절단 이후의 처리는 호출부가 정한다 — 단건은 그대로 실패, 배치는 절반으로
    // 쪼개 1회 재시도다 (TRD 7번).
    warn("응답이 max_tokens로 잘렸습니다 — 부분 파싱하지 않습니다");
    return failed("max_tokens", false, toUsage(envelope.data));
  }

  return { kind: "ok", result: envelope.data };
}

/**
 * 봉투를 도메인 값으로 옮긴다. 여기서 처음으로 `content`를 읽는다.
 *
 * `photoIndex`는 **서버가 붙인다.** 모델이 같은 이름의 필드를 채워 보내도
 * `extractionResultSchema`에 그 필드가 없으므로 값은 버려지고, 우리가 아는
 * 인덱스만 남는다 (TR-003).
 */
function toOutcome(
  envelope: z.infer<typeof messageEnvelopeSchema>,
  photoIndex: number,
): ExtractOutcome {
  // 여기까지 왔다면 응답이 돌아온 것이고 토큰은 이미 과금됐다. 아래 어떤
  // 실패로 끝나든 `usage`를 함께 나른다 (PRD 7번 세션당 비용 가드레일).
  const usage = toUsage(envelope);

  const text = findStructuredOutput(envelope.content);
  if (text === null) {
    warn("응답에 구조화 출력 텍스트 블록이 없습니다");
    return failedExtract("schema", usage);
  }

  let payload: unknown;
  try {
    // 구조화 출력은 문서 전체가 JSON이다. 정규식으로 건져 내지 않는다 (TRD 7번).
    payload = JSON.parse(text);
  } catch {
    warn("구조화 출력이 JSON이 아닙니다 — 문자열에서 건져 내지 않고 실패 처리합니다");
    return failedExtract("schema", usage);
  }

  const extraction = extractionResultSchema.safeParse(payload);
  if (!extraction.success) {
    // **원문을 로그에 넣지 않는다** (PRD 7번). 사유는 상위 계층이 미확인 카운트로 센다.
    warn("추출 응답이 스키마를 통과하지 못했습니다 (상한 초과 또는 필드 위반)");
    return failedExtract("schema", usage);
  }

  const candidates: ExtractedCandidate[] = [];
  for (const fromModel of extraction.data.candidates) {
    const withIndex = extractedCandidateSchema.safeParse({ ...fromModel, photoIndex });
    if (!withIndex.success) {
      // photoIndex가 장수 상한을 벗어난 경우다 — 모델이 아니라 **호출부의 버그**다.
      warn("photoIndex가 스키마 범위를 벗어났습니다 — 호출부를 확인하세요");
      return failedExtract("schema", usage);
    }
    candidates.push(withIndex.data);
  }

  return { status: "ok", candidates, usage };
}

/** 첫 번째 텍스트 블록. adaptive thinking을 쓰면 thinking 블록이 앞에 온다 */
function findStructuredOutput(content: readonly unknown[]): string | null {
  for (const block of content) {
    const parsed = textBlockSchema.safeParse(block);
    if (parsed.success) return parsed.data.text;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 내부 — 오류 분류
 * ------------------------------------------------------------------ */

/**
 * 던져진 오류를 사유로 옮긴다. **메시지를 절대 읽지 않는다.**
 *
 * SDK 에러 메시지는 요청 헤더를 담을 수 있고 그 안에 API 키가 있다 (TRD 6.5).
 * 그래서 판정은 타입과 상태 코드로만 하고, 로그에도 상태 코드와 클래스 이름만 남긴다.
 */
function classifyError(error: unknown): Attempt {
  if (error instanceof APIConnectionTimeoutError || error instanceof APIUserAbortError) {
    warn("호출이 시간 안에 끝나지 않았습니다");
    return failed("timeout", true);
  }

  if (error instanceof APIConnectionError) {
    warn("Anthropic에 연결하지 못했습니다");
    return failed("upstream", true);
  }

  if (error instanceof APIError) {
    return fromStatus(error.status);
  }

  // SDK를 거치지 않은 abort(AbortController·DOMException)도 시간 문제다.
  if (error instanceof Error && error.name === "AbortError") {
    warn("호출이 중단되었습니다");
    return failed("timeout", true);
  }

  warn(`호출 중 알 수 없는 오류 name=${error instanceof Error ? error.name : "Unknown"}`);
  return failed("upstream", false);
}

function fromStatus(status: number | undefined): Attempt {
  if (status === undefined) {
    warn("상태 코드 없는 API 오류");
    return failed("upstream", true);
  }

  warn(`Anthropic 호출 실패 status=${status}`);
  // 429와 5xx만 다시 걸면 달라질 수 있다. 나머지 4xx는 우리 요청이 잘못된 것이다.
  return failed("upstream", status === 429 || status >= 500);
}

/* ------------------------------------------------------------------ *
 * 내부 — 요청 조립
 * ------------------------------------------------------------------ */

/**
 * 두 호출이 공유하는 봉투. **호출 규약은 여기 한 곳에서만 조립된다** (TRD 7번)
 * — `thinking: adaptive`(budget_tokens 없음), `output_config.format`, betas +
 * `fallbacks`, `max_tokens` 16000. 규약이 두 곳에 적히면 한쪽만 낡는다.
 */
function buildBody(
  model: string,
  jsonSchema: unknown,
  content: MessageRequestBody["messages"][number]["content"],
): MessageRequestBody {
  return {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: jsonSchema } },
    betas: [...EXTRACT_BETAS],
    fallbacks: "default",
    messages: [{ role: "user", content }],
  };
}

function buildExtractBody(image: { mediaType: string; data: string }): MessageRequestBody {
  return buildBody(getExtractModel(), extractionJsonSchema, [
    { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
    { type: "text", text: buildExtractPrompt() },
  ]);
}

/**
 * 한줄평 요청. 모델은 `getRecommendModel()`이다 — 한줄평은 판독이 아니라 생성이라
 * `MODEL_RECOMMEND` 쪽에 묶인다 (TRD 7번 환경변수 표). 추출 모델을 강등해도
 * 한줄평 품질은 그대로 두는 운영 스위치가 이 구분에서 나온다.
 *
 * 프롬프트와 스키마는 `lib/prompts.ts`의 것을 그대로 쓴다. 여기서 다시 만들면
 * 60자 규칙이 두 벌이 되어 소리 없이 갈린다.
 */
function buildNoteBody(books: readonly NoteBook[]): MessageRequestBody {
  return buildBody(getRecommendModel(), noteJsonSchema, [
    { type: "text", text: buildNotePrompt(books) },
  ]);
}

/**
 * 데이터 URI를 SDK 이미지 소스로 가른다.
 *
 * 형식 판정은 `imageDataUriSchema`가 한다 — MIME 화이트리스트를 여기서 다시
 * 적으면 검증 경계가 둘로 갈린다. 이 함수의 정규식은 판정이 끝난 문자열을
 * 자르기만 한다.
 */
function parseImageSource(imageDataUri: string): { mediaType: string; data: string } | null {
  if (!imageDataUriSchema.safeParse(imageDataUri).success) return null;

  const parts = DATA_URI_PARTS.exec(imageDataUri);
  if (parts === null) return null;

  return { mediaType: parts[1], data: parts[2] };
}

/**
 * 클라이언트를 만든다. **모듈 스코프에 캐시하지 않는다** (ADR-003).
 *
 * `maxRetries: 0`은 의도다. 재시도는 이 모듈이 직접 1회 수행한다 — SDK에 맡기면
 * 남은 데드라인을 모르는 재시도가 되고, 호출 횟수도 관측되지 않아 TRD 6.1의
 * 최악값 계산(사진당 2회)이 어긋난다.
 */
function resolveClient(clientImpl: unknown, apiKey: string): MessagesClient {
  if (clientImpl !== undefined) return clientImpl as MessagesClient;
  return new Anthropic({ apiKey, maxRetries: 0 }) as unknown as MessagesClient;
}

/** 남은 시간. 음수는 0으로 clamp한다 */
function remainingMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ *
 * 목업 모드 (TRD 9번)
 * ------------------------------------------------------------------ */

/** 목업 후보의 원문. 실제 책 제목을 쓰지 않아 눈으로도 목업임이 드러난다 */
const MOCK_CANDIDATES = [
  { rawText: "[목업] 책등 1", title: "[목업] 책등 1", author: "[목업] 저자", confidence: 0.9 },
  { rawText: "[목업] 책등 2", title: "[목업] 책등 2", author: null, confidence: 0.5 },
] as const;

/** 목업 한줄평. 60자 이내여야 `noteBatchSchema`를 통과한다 */
const MOCK_NOTE = "[목업] 한줄평 — Claude를 호출하지 않았습니다";

/**
 * `ANTHROPIC_API_KEY`가 없을 때의 로컬 개발 응답.
 *
 * TRD 9번이 "API 키 발급 전에도 UI와 상태 전이를 전부 검증할 수 있어야 한다"고
 * 요구한다. **조용한 목업은 금지다** — 호출마다 경고를 남기고 제목에 표시를 남겨
 * "동작하는 줄 알았는데 Claude를 한 번도 안 불렀다"를 막는다.
 *
 * `usage`는 0이다. 쓰지 않은 토큰을 지어내면 비용 집계가 오염된다.
 * 목업 값도 검증 경계를 그대로 통과시킨다 — 픽스처만 예외를 두면 스키마가
 * 바뀌었을 때 로컬에서만 통과하는 코드가 생긴다.
 */
function mockOutcome(photoIndex: number): ExtractOutcome {
  warn(
    "ANTHROPIC_API_KEY가 없어 Claude를 호출하지 않고 목업 후보를 돌려줍니다 (로컬 개발 모드, TRD 9번). 이 결과는 사진을 판독한 것이 아닙니다.",
  );

  const candidates: ExtractedCandidate[] = [];
  for (const fixture of MOCK_CANDIDATES) {
    const parsed = extractedCandidateSchema.safeParse({ ...fixture, photoIndex });
    if (parsed.success) candidates.push(parsed.data);
  }

  return { status: "ok", candidates, usage: EMPTY_USAGE };
}

/**
 * 키가 없을 때의 한줄평. 목업임을 문구로 드러내고 `usage`는 0이다.
 *
 * 목업 값도 `noteBatchSchema`를 통과시킨다 — 픽스처만 검증을 건너뛰면 스키마가
 * 바뀌었을 때 로컬에서만 통과하는 코드가 생긴다 (TRD 9번).
 */
function mockNoteOutcome(books: readonly NoteBook[]): NoteOutcome {
  warn(
    "ANTHROPIC_API_KEY가 없어 Claude를 호출하지 않고 목업 한줄평을 돌려줍니다 (로컬 개발 모드, TRD 9번). 이 문구는 책을 읽고 쓴 것이 아닙니다.",
  );

  const payload = {
    notes: books.map((book) => ({ isbn13: book.isbn13, note: MOCK_NOTE })),
  };

  const batch = noteBatchSchema.safeParse(payload);
  if (!batch.success) {
    // 책이 상한(50권)을 넘겼거나 isbn13 형식이 어긋난 경우다 — 호출부의 버그다.
    warn("목업 한줄평이 스키마를 통과하지 못했습니다 — 호출부의 책 목록을 확인하세요");
    return { status: "failed", reason: "schema" };
  }

  const notes = new Map(batch.data.notes.map((item) => [item.isbn13, item.note]));
  return { status: "ok", notes, usage: EMPTY_USAGE };
}

/**
 * 이 모듈의 유일한 로그 출구.
 *
 * 한 곳으로 좁혀 두는 이유는 **API 키와 판독 원문이 새는 경로를 하나로 만들기**
 * 위해서다. SDK 에러 메시지·모델 응답 본문·base64 이미지는 전부 여기 들어오지
 * 않는다. 사진 한 장의 강등은 사람이 조치할 일이 아니므로 `error`가 아니라
 * `warn`이다 (TRD 6.4 로그 레벨 기준).
 */
function warn(message: string): void {
  console.warn(`[anthropic] ${message}`);
}

/* ------------------------------------------------------------------ *
 * 공개 API — 추천 (TR-010, FR-006·FR-009)
 * ------------------------------------------------------------------ */

/**
 * 추천 한 번의 결과. `bookId`·`reason`뿐 아니라 `position`도 그대로 나른다.
 *
 * 순위를 버리고 라우트가 배열 순서로 다시 매기지 않는 이유는, 그것이 **모델의
 * 판단을 서비스가 덮어쓰는 것**이기 때문이다. `recommendationSchema`가 이미
 * `position`을 API 계약의 일부로 정해 두었고(1|2|3), 그 값은 "가장 권하고 싶은
 * 순서"라는 의미를 갖는다. 여기서 떨어뜨리면 라우트가 그 의미를 복원할 방법이 없다.
 */
export type RecommendPick = z.infer<typeof recommendationSchema>;

/** 추천·문답이 실패한 사유. 추출과 같은 5종을 쓴다 — 사유 어휘를 셋으로 나누지 않는다 */
export type RecommendFailureReason = ExtractFailureReason;

export interface RecommendOptions {
  /** 이 호출에 쓸 수 있는 시간(ms). 0 이하면 호출조차 하지 않는다 */
  deadlineMs: number;
  /**
   * 직전 시도가 목록 밖 책을 반환했을 때 라우트가 넘기는 교정 정보 (FR-009).
   * 첫 시도에는 없다. 이 값이 있으면 프롬프트에 **위반한 `bookId`와 허용 목록을
   * 다시** 싣는다 — 같은 프롬프트를 그대로 반복하면 같은 실패를 부른다 (API_SPEC).
   */
  correction?: { violatingBookIds: readonly string[] };
  /**
   * 라우트가 이미 무관 판정을 무시하기로 정한 요청인가 (`irrelevantStreak >= 2`).
   *
   * **판정이 아니라 전달이다.** `correction`이 그렇듯 이 값도 라우트가 아는 것을
   * 서비스에 알려 주는 통로일 뿐이고, 이 파일은 세션을 모르므로 스스로 강행을
   * 결정할 수 없다 (API_SPEC `/api/recommend`).
   *
   * 켜지면 `buildRecommendPrompt`의 규칙 7이 강행 규칙으로 **대체**된다 — 서버가
   * 422를 걷어내기로 했는데 프롬프트가 여전히 "단서가 없으면 빈 배열"이라고
   * 지시하면 강행의 결과가 `200` + 빈 배열이 되기 때문이다. 그래서 이것은
   * 재호출이 아니라 **첫 호출의 옵션**이며, 모델 호출 횟수를 늘리지 않는다.
   *
   * 문구는 `lib/prompts.ts`가 소유한다. 이 파일은 플래그만 넘긴다.
   * 기본값은 "강행하지 않음"이고, 그때 요청 본문은 이 필드가 없던 때와 같다.
   */
  forced?: boolean;
  /** 테스트 주입점. SDK를 갈아 끼운다 */
  clientImpl?: unknown;
  /** 재시도 백오프 대기 주입점 */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * 추천 결과.
 *
 * **`relevant`를 여기서 해석하지 않는다.** 모델이 준 값을 그대로 실어 올릴 뿐이고,
 * 422(`IRRELEVANT_MOOD`)로 만들지 아니면 무시하고 진행할지는 라우트가 정한다 —
 * "같은 세션에서 2회 연속이면 판정을 무시한다"는 규칙은 세션을 아는 쪽만 적용할
 * 수 있기 때문이다 (API_SPEC `/api/recommend`).
 *
 * `options.forced`가 켜져도 이 규약은 그대로다. `relevant`를 `true`로 덮어쓰지
 * 않는다 — 서버가 무시하기로 한 것은 그 값의 **효력**이지 값이 아니고, 덮어쓰면
 * 무관 판정의 오탐률을 어디서도 볼 수 없게 된다 (API_SPEC `/api/recommend`).
 *
 * **화이트리스트 검증도 여기서 하지 않는다.** 서명 검증을 통과한 목록을 아는 쪽은
 * 라우트다 (ADR-006). 이 함수는 목록 밖 `bookId`도 그대로 올려 보내고, 라우트가
 * 걸러 낸 뒤 `correction`을 들고 다시 부른다.
 */
export type RecommendOutcome =
  | { status: "ok"; relevant: boolean; picks: readonly RecommendPick[]; usage: ExtractUsage }
  | { status: "failed"; reason: RecommendFailureReason; usage?: ExtractUsage };

/**
 * 확인된 책 목록과 기분 텍스트로 추천을 받는다 (TR-010).
 *
 * `mood`는 사용자가 쓴 자유 텍스트라 **데이터로만** 다룬다. 시스템 프롬프트에
 * 이어 붙이지 않고 `buildRecommendPrompt`가 잡아 둔 `<mood>` 블록 안에 넣는다
 * (TRD 6.5). 이 함수는 그 규약을 깨지 않으려고 프롬프트를 직접 조립하지 않는다 —
 * 유일하게 덧붙이는 것은 재요청 교정 블록이고, 그것은 우리가 쓴 문장이다.
 */
export async function generateRecommendations(
  books: readonly RecommendPromptBook[],
  mood: string,
  options: RecommendOptions,
): Promise<RecommendOutcome> {
  const { deadlineMs, correction, forced, clientImpl, sleepImpl = defaultSleep } = options;

  if (deadlineMs <= 0) {
    warn("남은 추천 예산이 없어 호출을 생략합니다");
    return { status: "failed", reason: "timeout" };
  }

  const apiKey = getAnthropicApiKey();
  if (apiKey === null) return mockRecommendOutcome(books);

  const deadlineAt = Date.now() + deadlineMs;
  const client = resolveClient(clientImpl, apiKey);

  const attempt = await callWithRetry(
    client,
    buildRecommendBody(books, mood, correction, forced),
    deadlineAt,
    sleepImpl,
  );

  if (attempt.kind === "failed") {
    return failedRecommend(attempt.reason, attempt.usage);
  }

  return toRecommendOutcome(attempt.result);
}

/* ------------------------------------------------------------------ *
 * 공개 API — 문답 생성 (TR-009, FR-007)
 * ------------------------------------------------------------------ */

export interface QuestionsOptions {
  /** 이 호출에 쓸 수 있는 시간(ms). 0 이하면 호출조차 하지 않는다 */
  deadlineMs: number;
  /** 테스트 주입점. SDK를 갈아 끼운다 */
  clientImpl?: unknown;
  /** 재시도 백오프 대기 주입점 */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * 문답 결과.
 *
 * **빈 배열은 이 타입에 없다.** API_SPEC이 "생성 실패든 모델 장애든 200과 빈
 * 배열"이라고 정했지만, 그 흡수는 라우트의 일이다. 서비스가 실패를 빈 배열로
 * 바꿔 버리면 `questions_generated` 이벤트가 "질문 0개 생성 성공"으로 남고,
 * 모델 장애와 정상 폴백이 로그에서 구분되지 않는다 (ADR-005 사유 보존).
 */
export type QuestionsOutcome =
  | { status: "ok"; questions: readonly MoodQuestion[]; usage: ExtractUsage }
  | { status: "failed"; reason: RecommendFailureReason; usage?: ExtractUsage };

/**
 * 확인된 책 목록의 구성을 근거로 유도 질문을 만든다 (TR-009).
 *
 * 질문 수의 허용값은 **2~3개뿐**이다. 1개짜리 응답은 문답 화면을 성립시키지
 * 못하므로 `questionsOutputSchema`가 하한 2를 강제하고, 이 함수는 그것을
 * `schema` 실패로 다룬다. 0개는 라우트가 폴백으로 만들어 내는 값이지 모델이
 * 줄 수 있는 값이 아니다.
 */
export async function generateQuestions(
  books: readonly PromptBook[],
  options: QuestionsOptions,
): Promise<QuestionsOutcome> {
  const { deadlineMs, clientImpl, sleepImpl = defaultSleep } = options;

  if (deadlineMs <= 0) {
    warn("남은 문답 예산이 없어 호출을 생략합니다");
    return { status: "failed", reason: "timeout" };
  }

  const apiKey = getAnthropicApiKey();
  if (apiKey === null) return mockQuestionsOutcome();

  const deadlineAt = Date.now() + deadlineMs;
  const client = resolveClient(clientImpl, apiKey);

  const attempt = await callWithRetry(client, buildQuestionsBody(books), deadlineAt, sleepImpl);

  if (attempt.kind === "failed") {
    return failedQuestions(attempt.reason, attempt.usage);
  }

  return toQuestionsOutcome(attempt.result);
}

/* ------------------------------------------------------------------ *
 * 내부 — 추천·문답 응답 해석
 * ------------------------------------------------------------------ */

/** `usage`가 없을 때 키 자체를 만들지 않는다 — `usage: undefined`는 "0을 썼다"로 오독된다 */
function failedRecommend(
  reason: RecommendFailureReason,
  usage?: ExtractUsage,
): RecommendOutcome {
  return usage === undefined
    ? { status: "failed", reason }
    : { status: "failed", reason, usage };
}

function failedQuestions(
  reason: RecommendFailureReason,
  usage?: ExtractUsage,
): QuestionsOutcome {
  return usage === undefined
    ? { status: "failed", reason }
    : { status: "failed", reason, usage };
}

/**
 * 봉투에서 구조화 출력 JSON을 꺼낸다. 추출·한줄평과 같은 순서를 쓴다.
 * 실패는 전부 `schema`이며 **`usage`를 함께 나른다** — 응답이 돌아온 이상 과금됐다.
 */
function parseStructuredPayload(
  envelope: z.infer<typeof messageEnvelopeSchema>,
  what: string,
): { ok: true; payload: unknown } | { ok: false } {
  const text = findStructuredOutput(envelope.content);
  if (text === null) {
    warn(`${what} 응답에 구조화 출력 텍스트 블록이 없습니다`);
    return { ok: false };
  }

  try {
    return { ok: true, payload: JSON.parse(text) };
  } catch {
    warn(`${what} 구조화 출력이 JSON이 아닙니다 — 문자열에서 건져 내지 않고 실패 처리합니다`);
    return { ok: false };
  }
}

function toRecommendOutcome(envelope: z.infer<typeof messageEnvelopeSchema>): RecommendOutcome {
  const usage = toUsage(envelope);

  const parsed = parseStructuredPayload(envelope, "추천");
  if (!parsed.ok) return failedRecommend("schema", usage);

  const output = recommendOutputSchema.safeParse(parsed.payload);
  if (!output.success) {
    // 모델이 만든 문장을 로그에 넣지 않는다. reason 길이 위반·3권 초과·relevant
    // 누락이 여기 걸린다.
    warn("추천 응답이 스키마를 통과하지 못했습니다 (권수 초과 또는 필드 위반)");
    return failedRecommend("schema", usage);
  }

  // 목록 밖 `bookId`를 여기서 거르지 않는다 — 그것을 판정할 수 있는 목록(서명을
  // 통과한 책)을 아는 쪽은 라우트다 (ADR-006, FR-009).
  return {
    status: "ok",
    relevant: output.data.relevant,
    picks: output.data.recommendations,
    usage,
  };
}

function toQuestionsOutcome(envelope: z.infer<typeof messageEnvelopeSchema>): QuestionsOutcome {
  const usage = toUsage(envelope);

  const parsed = parseStructuredPayload(envelope, "문답");
  if (!parsed.ok) return failedQuestions("schema", usage);

  const output = questionsOutputSchema.safeParse(parsed.payload);
  if (!output.success) {
    warn("문답 응답이 스키마를 통과하지 못했습니다 (질문 수 2~3개 밖 또는 필드 위반)");
    return failedQuestions("schema", usage);
  }

  return { status: "ok", questions: output.data.questions, usage };
}

/* ------------------------------------------------------------------ *
 * 내부 — 추천·문답 요청 조립
 * ------------------------------------------------------------------ */

/**
 * 추천 요청. 프롬프트는 `lib/prompts.ts`의 것을 그대로 쓰고 여기서 다시 만들지
 * 않는다 — `<mood>` 데이터 블록 규약(TRD 6.5)이 두 곳에 적히면 한쪽만 낡는다.
 *
 * 교정은 **별도 텍스트 블록**으로 덧붙인다. 사용자 데이터 블록 안에 섞지 않는
 * 이유는 그 블록이 "지시가 아니다"라고 선언된 영역이기 때문이다.
 *
 * 강행은 문구가 아니라 **플래그로** 넘어간다. 여기서 문장을 이어 붙이면 강행
 * 지시문이 두 파일에 살게 되고 다음에 고칠 때 한 곳만 고쳐진다 — `prompts.ts`가
 * 규칙 7을 통째로 갈아 끼우는 형태를 택한 것도 같은 이유다.
 *
 * `correction`과 `forced`는 **독립이다.** 교정 재요청에서 강행이 풀리면 모델이
 * 다시 규칙 7을 보고 빈 배열을 돌려주고, 강행 경로가 교정 한 번으로 조용히
 * 무력화된다 (API_SPEC "교정 재요청이 일어나도 강행 여부는 유지된다").
 */
function buildRecommendBody(
  books: readonly RecommendPromptBook[],
  mood: string,
  correction: RecommendOptions["correction"],
  forced: RecommendOptions["forced"],
): MessageRequestBody {
  const content: MessageRequestBody["messages"][number]["content"] = [
    { type: "text", text: buildRecommendPrompt(books, mood, { forced }) },
  ];

  const correctionText = buildCorrectionBlock(books, correction);
  if (correctionText !== null) {
    content.push({ type: "text", text: correctionText });
  }

  return buildBody(getRecommendModel(), recommendJsonSchema, content);
}

/**
 * 재요청 교정 블록 (FR-009, API_SPEC `/api/recommend`).
 *
 * 위반한 `bookId`를 명시하고 허용 목록을 다시 제시한다. 동일 프롬프트를 그대로
 * 다시 보내면 같은 실패를 반복할 가능성이 높기 때문이다.
 *
 * **위반 ID를 `isbn13` 형식으로 거르고 들어간다.** 이 값은 직전 *모델 응답*에서
 * 온 것이라 우리 프롬프트로 되돌아오는 경로이고, 형식 검사 없이 그대로 붙이면
 * 모델이 만든 문자열이 지시문 자리에 앉는다 (TRD 6.5). 스키마를 통과한 응답의
 * `bookId`는 이미 13자리 숫자이므로 이 필터가 정상 경로를 막지 않는다.
 */
function buildCorrectionBlock(
  books: readonly RecommendPromptBook[],
  correction: RecommendOptions["correction"],
): string | null {
  if (correction === undefined) return null;

  const violations = [...new Set(correction.violatingBookIds)]
    .filter((bookId) => isbn13Schema.safeParse(bookId).success)
    .slice(0, MAX_RECOMMENDATIONS);

  if (violations.length === 0) {
    warn("교정할 위반 bookId가 없어 재요청 교정 블록을 싣지 않습니다");
    return null;
  }

  const violated = violations.map((bookId) => `- ${bookId}`).join("\n");
  const allowList = books.map((book) => `- ${book.isbn13}`).join("\n");

  return `## 직전 응답이 규칙을 어겼다 (이번에는 반드시 고친다)
직전 시도에서 아래 bookId는 고를 수 있는 목록에 없는 값이었다. 그 응답은 폐기됐다.
<violations>
${violated}
</violations>

아래가 이번에 쓸 수 있는 bookId 전부다. 이 목록 밖의 값을 하나라도 넣으면 응답이 다시 폐기된다.
<allowed>
${allowList}
</allowed>`;
}

/**
 * 문답 요청. 모델은 `getRecommendModel()`이다 — 문답은 판독이 아니라 생성이라
 * `MODEL_RECOMMEND` 쪽에 묶인다 (TRD 7번 환경변수 표).
 */
function buildQuestionsBody(books: readonly PromptBook[]): MessageRequestBody {
  return buildBody(getRecommendModel(), questionsJsonSchema, [
    { type: "text", text: buildQuestionsPrompt(books) },
  ]);
}

/* ------------------------------------------------------------------ *
 * 목업 모드 — 추천·문답 (TRD 9번)
 * ------------------------------------------------------------------ */

/** 20~200자를 만족하는 목업 추천 이유. 짧으면 `recommendationSchema`가 거부한다 */
const MOCK_REASON = "[목업] Claude를 호출하지 않고 만든 문장입니다. 실제 추천 판단이 아닙니다";

/** 목업 유도 질문. 10~60자·선택지 3~4개를 만족해야 스키마를 통과한다 */
const MOCK_QUESTIONS = [
  {
    id: "mock_pace",
    question: "[목업] 지금은 어떤 호흡의 책이 좋으세요?",
    options: ["빠르게 넘어가는", "천천히 곱씹는", "상관없어요"],
  },
  {
    id: "mock_weight",
    question: "[목업] 머리를 쓰는 쪽과 쉬어 가는 쪽 중 어디인가요?",
    options: ["머리 쓰기", "쉬어 가기", "중간쯤"],
  },
] as const;

/**
 * 키가 없을 때의 추천. 목업임을 문구로 드러내고 `usage`는 0이다.
 *
 * **요청 목록 안에서만 고른다.** 목업이라도 화이트리스트를 깨는 값을 만들면
 * 라우트의 FR-009 검증이 로컬에서만 실패하는 코드가 생긴다. 목업 값도 검증
 * 경계를 그대로 통과시키는 것은 같은 이유다 (TRD 9번).
 */
function mockRecommendOutcome(books: readonly RecommendPromptBook[]): RecommendOutcome {
  warn(
    "ANTHROPIC_API_KEY가 없어 Claude를 호출하지 않고 목업 추천을 돌려줍니다 (로컬 개발 모드, TRD 9번). 이 추천은 책을 읽고 고른 것이 아닙니다.",
  );

  const payload = {
    relevant: true,
    recommendations: books.slice(0, MAX_RECOMMENDATIONS).map((book, index) => ({
      bookId: book.isbn13,
      reason: MOCK_REASON,
      position: index + 1,
    })),
  };

  const output = recommendOutputSchema.safeParse(payload);
  if (!output.success) {
    // isbn13 형식이 어긋난 책이 들어온 경우다 — 호출부의 버그다.
    warn("목업 추천이 스키마를 통과하지 못했습니다 — 호출부의 책 목록을 확인하세요");
    return { status: "failed", reason: "schema" };
  }

  return {
    status: "ok",
    relevant: output.data.relevant,
    picks: output.data.recommendations,
    usage: EMPTY_USAGE,
  };
}

/**
 * 키가 없을 때의 문답. 질문 2개를 돌려줘 문답 화면과 상태 전이를 로컬에서
 * 전부 확인할 수 있게 한다 (TRD 9번). 빈 배열을 주면 자유 입력 폴백만
 * 검증되고 문답 화면은 한 번도 열리지 않는다.
 */
function mockQuestionsOutcome(): QuestionsOutcome {
  warn(
    "ANTHROPIC_API_KEY가 없어 Claude를 호출하지 않고 목업 질문을 돌려줍니다 (로컬 개발 모드, TRD 9번). 이 질문은 서재를 보고 만든 것이 아닙니다.",
  );

  const output = questionsOutputSchema.safeParse({ questions: MOCK_QUESTIONS });
  if (!output.success) {
    warn("목업 질문이 스키마를 통과하지 못했습니다 — 픽스처를 확인하세요");
    return { status: "failed", reason: "schema" };
  }

  return { status: "ok", questions: output.data.questions, usage: EMPTY_USAGE };
}
