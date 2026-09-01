/**
 * Claude API 래퍼 — 책등 추출 (TR-003).
 *
 * ## 이 파일이 곧 경계다 (ADR-001)
 * provider 어댑터 레이어를 만들지 않는다. 공급자를 바꿔야 할 일이 생기면 이 파일
 * 하나를 통째로 교체한다. 그 비용이 추상화를 미리 만드는 비용보다 작다고 판단한
 * 결정이므로, 여기에 "언젠가 다른 공급자도"를 위한 간접층을 넣는 순간 그 판단이
 * 무의미해진다. 그래서 SDK 타입도 밖으로 새어 나가지 않는다 — 이 모듈이 내보내는
 * 것은 `ExtractOutcome` 하나뿐이다.
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

import { getAnthropicApiKey, getExtractModel } from "@/lib/env";
import { buildExtractPrompt, extractionJsonSchema } from "@/lib/prompts";
import {
  extractedCandidateSchema,
  extractionResultSchema,
  imageDataUriSchema,
} from "@/lib/schemas";
import type { ExtractedCandidate } from "@/types/book";

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
  | { status: "failed"; reason: ExtractFailureReason };

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
      create(body: ExtractRequestBody, options?: { timeout?: number }): Promise<unknown>;
    };
  };
}

/** 우리가 만들어 보내는 요청 본문. TRD 7번 호출 규약이 그대로 형태로 드러난다 */
interface ExtractRequestBody {
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
  const body = buildRequestBody(image);

  let attempt = await callOnce(client, body, remainingMs(deadlineAt));

  // 재시도는 **429·5xx·연결 오류에만** 1회다. refusal·max_tokens·4xx·schema는
  // 다시 걸어도 같은 결과이고, 호출 한 번은 그대로 비용이 된다 (TRD 7번).
  if (attempt.kind === "failed" && attempt.retryable) {
    await sleepImpl(Math.min(RETRY_BACKOFF_MS, remainingMs(deadlineAt)));
    const remaining = remainingMs(deadlineAt);
    if (remaining > 0) {
      attempt = await callOnce(client, body, remaining);
    }
  }

  if (attempt.kind === "failed") {
    return { status: "failed", reason: attempt.reason };
  }

  return toOutcome(attempt.result, photoIndex);
}

/* ------------------------------------------------------------------ *
 * 내부 — 호출 1회
 * ------------------------------------------------------------------ */

type Attempt =
  | { kind: "ok"; result: z.infer<typeof messageEnvelopeSchema> }
  | { kind: "failed"; reason: ExtractFailureReason; retryable: boolean };

function failed(reason: ExtractFailureReason, retryable: boolean): Attempt {
  return { kind: "failed", reason, retryable };
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
  body: ExtractRequestBody,
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

  if (stopReason === "refusal") {
    // 재시도하지 않는다. 같은 입력은 같은 분류기 판정을 받는다 (TR-003).
    warn("모델이 이 사진을 거절했습니다 (stop_reason=refusal) — 재시도하지 않습니다");
    return failed("refusal", false);
  }

  if (stopReason === "max_tokens") {
    // 잘린 JSON을 부분 파싱해 살려 쓰지 않는다. 그것은 검증 경계를 우회하는 것이다.
    warn("응답이 max_tokens로 잘렸습니다 — 부분 파싱하지 않고 이 사진만 실패 처리합니다");
    return failed("max_tokens", false);
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
  const text = findStructuredOutput(envelope.content);
  if (text === null) {
    warn("응답에 구조화 출력 텍스트 블록이 없습니다");
    return { status: "failed", reason: "schema" };
  }

  let payload: unknown;
  try {
    // 구조화 출력은 문서 전체가 JSON이다. 정규식으로 건져 내지 않는다 (TRD 7번).
    payload = JSON.parse(text);
  } catch {
    warn("구조화 출력이 JSON이 아닙니다 — 문자열에서 건져 내지 않고 실패 처리합니다");
    return { status: "failed", reason: "schema" };
  }

  const extraction = extractionResultSchema.safeParse(payload);
  if (!extraction.success) {
    // **원문을 로그에 넣지 않는다** (PRD 7번). 사유는 상위 계층이 미확인 카운트로 센다.
    warn("추출 응답이 스키마를 통과하지 못했습니다 (상한 초과 또는 필드 위반)");
    return { status: "failed", reason: "schema" };
  }

  const candidates: ExtractedCandidate[] = [];
  for (const fromModel of extraction.data.candidates) {
    const withIndex = extractedCandidateSchema.safeParse({ ...fromModel, photoIndex });
    if (!withIndex.success) {
      // photoIndex가 장수 상한을 벗어난 경우다 — 모델이 아니라 **호출부의 버그**다.
      warn("photoIndex가 스키마 범위를 벗어났습니다 — 호출부를 확인하세요");
      return { status: "failed", reason: "schema" };
    }
    candidates.push(withIndex.data);
  }

  return {
    status: "ok",
    candidates,
    usage: {
      input_tokens: envelope.usage.input_tokens,
      output_tokens: envelope.usage.output_tokens,
    },
  };
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

function buildRequestBody(image: { mediaType: string; data: string }): ExtractRequestBody {
  return {
    model: getExtractModel(),
    max_tokens: MAX_OUTPUT_TOKENS,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: extractionJsonSchema } },
    betas: [...EXTRACT_BETAS],
    fallbacks: "default",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: image.mediaType, data: image.data },
          },
          { type: "text", text: buildExtractPrompt() },
        ],
      },
    ],
  };
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

  return { status: "ok", candidates, usage: { input_tokens: 0, output_tokens: 0 } };
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
