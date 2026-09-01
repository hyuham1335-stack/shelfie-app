import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_CANDIDATES_PER_PHOTO } from "@/lib/env";
import { extractedCandidateSchema } from "@/lib/schemas";

import { EXTRACT_BETAS, MAX_OUTPUT_TOKENS, extractFromPhoto } from "./anthropic";

/**
 * 테스트에서 쓰는 Claude API 키.
 * **어떤 로그·에러·반환값에도 이 문자열이 나타나서는 안 된다** (TRD 6.5).
 */
const API_KEY = "sk-ant-test-secret-do-not-leak-0001";

/** 사진에서 읽힌 원문. 로그에 절대 남으면 안 되는 값이다 (PRD 7번) */
const SECRET_RAW_TEXT = "우리집책장_사생활이_섞인_원문";

/** 스키마를 통과하는 최소 base64 데이터 URI */
const IMAGE = "data:image/jpeg;base64,AAAA";

/** 넉넉한 데드라인. 예산을 검증하는 테스트만 이 값을 줄여 쓴다 */
const AMPLE_DEADLINE_MS = 20_000;

/** 재시도 대기를 실제로 기다리지 않는다 — 백오프는 동작만 보고 시간은 보지 않는다 */
const noSleep = async (): Promise<void> => {};

/* ------------------------------------------------------------------ *
 * SDK 스텁 — 실제 Anthropic API를 절대 부르지 않는다 (TRD 8번)
 * ------------------------------------------------------------------ */

type CreateBody = Record<string, unknown>;
type CreateOptions = { timeout?: number } | undefined;

/** `beta.messages.create` 하나만 가진 최소 클라이언트. 호출 인자를 전부 기록한다 */
function stubClient(handler: (body: CreateBody, index: number) => Promise<unknown>) {
  const bodies: CreateBody[] = [];
  const optionsSeen: CreateOptions[] = [];

  const client = {
    beta: {
      messages: {
        create: async (body: CreateBody, options?: CreateOptions) => {
          const index = bodies.length;
          bodies.push(body);
          optionsSeen.push(options);
          return handler(body, index);
        },
      },
    },
  };

  return { client, bodies, optionsSeen, get callCount() {
    return bodies.length;
  } };
}

/** 항상 같은 결과를 주는 스텁 */
function alwaysReturn(value: () => unknown) {
  return stubClient(async () => value());
}

/**
 * 상태 코드가 살아 있는 SDK 오류.
 * `APIError.generate`는 headers가 없으면 상태 코드를 버리고 `APIConnectionError`를
 * 만들어 버리므로, 상태 코드별 재시도 정책을 검증하려면 headers를 반드시 넘긴다.
 */
function apiError(status: number, message: string): APIError {
  return APIError.generate(status, undefined, message, new Headers());
}

/** 항상 같은 오류를 던지는 스텁 */
function alwaysThrow(error: () => unknown) {
  return stubClient(async () => {
    throw error();
  });
}

/** 모델이 돌려주는 후보 1건 (photoIndex는 없다 — 서버가 붙인다) */
function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rawText: "소년이 온다 한강",
    title: "소년이 온다",
    author: "한강",
    confidence: 0.92,
    ...overrides,
  };
}

/** 구조화 출력 응답 봉투 */
function messageResponse(
  payload: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [
      // thinking 블록이 앞에 오는 것이 adaptive thinking의 정상 응답이다.
      { type: "thinking", thinking: "" },
      { type: "text", text: JSON.stringify(payload) },
    ],
    usage: { input_tokens: 1600, output_tokens: 320 },
    ...overrides,
  };
}

/** 후보 n건을 담은 정상 응답 */
function okResponse(candidates: Record<string, unknown>[] = [candidate()]) {
  return messageResponse({ candidates });
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

/** 이 테스트 실행 중 콘솔에 나간 모든 문자열 */
function loggedText(): string {
  return [...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join("\n");
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", API_KEY);
  vi.stubEnv("MODEL_EXTRACT", undefined);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * 호출 규약 (TRD 7번) — 어기면 400이 나거나 조용히 품질이 떨어진다
 * ------------------------------------------------------------------ */

describe("호출 규약 — TRD 7번 Anthropic 호출 규약", () => {
  it("max_tokens는 16000이다", () => {
    expect(MAX_OUTPUT_TOKENS).toBe(16_000);
  });

  it("thinking은 adaptive이고 budget_tokens를 싣지 않는다 (claude-opus-5는 400을 반환한다)", async () => {
    const { client, bodies } = alwaysReturn(() => okResponse());

    await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
    });

    expect(bodies[0].thinking).toEqual({ type: "adaptive" });
    expect(JSON.stringify(bodies[0])).not.toContain("budget_tokens");
  });

  it("서버사이드 fallback을 켠다 — betas와 fallbacks가 실린다", async () => {
    const { client, bodies } = alwaysReturn(() => okResponse());

    await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
    });

    expect(bodies[0].betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(EXTRACT_BETAS).toEqual(["server-side-fallback-2026-07-01"]);
    expect(bodies[0].fallbacks).toBe("default");
  });

  it("구조화 출력은 output_config.format으로 싣는다", async () => {
    const { client, bodies } = alwaysReturn(() => okResponse());

    await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
    });

    const outputConfig = bodies[0].output_config as { format: { type: string; schema: unknown } };
    expect(outputConfig.format.type).toBe("json_schema");
    expect(outputConfig.format.schema).toMatchObject({ type: "object" });
  });

  it("max_tokens와 이미지 블록을 싣는다 — 데이터 URI는 base64 소스로 분해된다", async () => {
    const { client, bodies } = alwaysReturn(() => okResponse());

    await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
    });

    expect(bodies[0].max_tokens).toBe(MAX_OUTPUT_TOKENS);
    const messages = bodies[0].messages as { role: string; content: Record<string, unknown>[] }[];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
    });
    expect(messages[0].content[1]).toMatchObject({ type: "text" });
  });

  it("모델 ID는 getExtractModel()에서 온다 — MODEL_EXTRACT를 바꾸면 따라간다", async () => {
    const { client, bodies } = alwaysReturn(() => okResponse());

    await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
    });
    expect(bodies[0].model).toBe("claude-opus-5");

    vi.stubEnv("MODEL_EXTRACT", "claude-sonnet-5");
    await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
    });
    expect(bodies[1].model).toBe("claude-sonnet-5");
  });

  it("남은 데드라인을 개별 호출 타임아웃으로 넘긴다 — 자체 상수를 쓰지 않는다 (ADR-005)", async () => {
    const { client, optionsSeen } = alwaysReturn(() => okResponse());

    await extractFromPhoto(IMAGE, { deadlineMs: 4_000, photoIndex: 0, clientImpl: client });

    expect(optionsSeen[0]?.timeout).toBeGreaterThan(0);
    expect(optionsSeen[0]?.timeout).toBeLessThanOrEqual(4_000);
  });
});

/* ------------------------------------------------------------------ *
 * 정상 경로
 * ------------------------------------------------------------------ */

describe("extractFromPhoto — 정상 응답", () => {
  it("후보를 돌려주고 photoIndex를 서버가 붙인다", async () => {
    const { client } = alwaysReturn(() =>
      okResponse([candidate(), candidate({ title: "채식주의자", confidence: 0.41 })]),
    );

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 3,
      clientImpl: client,
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.candidates).toHaveLength(2);
    for (const found of outcome.candidates) {
      expect(extractedCandidateSchema.safeParse(found).success).toBe(true);
      expect(found.photoIndex).toBe(3);
    }
    expect(outcome.candidates[0]).toEqual({
      rawText: "소년이 온다 한강",
      title: "소년이 온다",
      author: "한강",
      confidence: 0.92,
      photoIndex: 3,
    });
  });

  it("후보 0건도 정상이다 — 빈 책장은 실패가 아니다", async () => {
    const { client } = alwaysReturn(() => okResponse([]));

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
    });

    expect(outcome).toEqual({
      status: "ok",
      candidates: [],
      usage: { input_tokens: 1600, output_tokens: 320 },
    });
  });

  it("author가 null인 후보를 그대로 받는다 — 제목으로 저자를 추측하지 않는다", async () => {
    const { client } = alwaysReturn(() => okResponse([candidate({ author: null })]));

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.candidates[0].author).toBeNull();
  });

  it("usage의 input_tokens·output_tokens를 반환값에 싣는다 (PRD 7번 세션당 비용)", async () => {
    const { client } = alwaysReturn(() =>
      messageResponse({ candidates: [candidate()] }, { usage: { input_tokens: 1811, output_tokens: 77 } }),
    );

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.usage).toEqual({ input_tokens: 1811, output_tokens: 77 });
  });
});

/* ------------------------------------------------------------------ *
 * stop_reason — refusal과 max_tokens를 분리한다 (TRD 7번)
 * ------------------------------------------------------------------ */

describe("stop_reason 처리", () => {
  it("refusal이면 재시도하지 않고 해당 사진만 실패한다", async () => {
    const refusing = stubClient(async () =>
      messageResponse({ candidates: [] }, { stop_reason: "refusal", content: [] }),
    );

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: refusing.client,
      sleepImpl: noSleep,
    });

    expect(outcome).toEqual({ status: "failed", reason: "refusal" });
    expect(refusing.callCount).toBe(1);
  });

  it("max_tokens는 refusal과 다른 사유로 분리된다", async () => {
    const { client } = stubClient(async () =>
      messageResponse({ candidates: [candidate()] }, { stop_reason: "max_tokens" }),
    );

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
      sleepImpl: noSleep,
    });

    expect(outcome).toEqual({ status: "failed", reason: "max_tokens" });
  });

  it("max_tokens면 content가 완전한 JSON이어도 파싱하지 않는다 — stop_reason을 content보다 먼저 본다 (검증 경계 우회 금지)", async () => {
    // 이 테스트를 삭제하지 마라. 잘린 응답을 부분 파싱해 살려 쓰면
    // 반쪽 데이터가 확인된 책으로 올라간다 (ADR-002).
    const { client } = alwaysReturn(() =>
      messageResponse({ candidates: [candidate(), candidate()] }, { stop_reason: "max_tokens" }),
    );

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
      sleepImpl: noSleep,
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.reason).toBe("max_tokens");
    expect(outcome).not.toHaveProperty("candidates");
  });

  it("잘린 JSON을 부분 파싱해 살리려 시도하지 않는다", async () => {
    const truncated = '{"candidates":[{"rawText":"소년이 온다","title":"소년이';
    const { client } = stubClient(async () => ({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: truncated }],
      usage: { input_tokens: 1600, output_tokens: 16_000 },
    }));

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
      sleepImpl: noSleep,
    });

    expect(outcome).toEqual({ status: "failed", reason: "max_tokens" });
  });
});

/* ------------------------------------------------------------------ *
 * 재시도 — 429·5xx만, 1회
 * ------------------------------------------------------------------ */

describe("재시도 정책", () => {
  it("429는 1회 재시도하고 성공하면 ok다", async () => {
    const stub = stubClient(async (_body, index) => {
      if (index === 0) throw apiError(429, "rate limited");
      return okResponse();
    });

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: stub.client,
      sleepImpl: noSleep,
    });

    expect(outcome.status).toBe("ok");
    expect(stub.callCount).toBe(2);
  });

  it("429가 두 번이면 upstream이고 호출은 2회에서 멈춘다", async () => {
    const stub = alwaysThrow(() => apiError(429, "rate limited"));

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: stub.client,
      sleepImpl: noSleep,
    });

    expect(outcome).toEqual({ status: "failed", reason: "upstream" });
    expect(stub.callCount).toBe(2);
  });

  it("5xx는 1회 재시도한다", async () => {
    const stub = stubClient(async (_body, index) => {
      if (index === 0) throw apiError(503, "overloaded");
      return okResponse();
    });

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: stub.client,
      sleepImpl: noSleep,
    });

    expect(outcome.status).toBe("ok");
    expect(stub.callCount).toBe(2);
  });

  it("400은 재시도하지 않는다 — 같은 요청은 같은 실패다", async () => {
    const stub = alwaysThrow(() => apiError(400, "bad request"));

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: stub.client,
      sleepImpl: noSleep,
    });

    expect(outcome).toEqual({ status: "failed", reason: "upstream" });
    expect(stub.callCount).toBe(1);
  });

  it("401도 재시도하지 않는다", async () => {
    const stub = alwaysThrow(() => apiError(401, "unauthorized"));

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: stub.client,
      sleepImpl: noSleep,
    });

    expect(outcome).toEqual({ status: "failed", reason: "upstream" });
    expect(stub.callCount).toBe(1);
  });

  it("연결 오류는 재시도한다", async () => {
    const stub = stubClient(async (_body, index) => {
      if (index === 0) throw new APIConnectionError({ message: "socket hang up" });
      return okResponse();
    });

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: stub.client,
      sleepImpl: noSleep,
    });

    expect(outcome.status).toBe("ok");
    expect(stub.callCount).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * 시간 예산 (ADR-005)
 * ------------------------------------------------------------------ */

describe("시간 예산", () => {
  it("데드라인이 0이면 SDK를 부르지 않고 즉시 timeout이다", async () => {
    const stub = alwaysReturn(() => okResponse());

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: 0,
      photoIndex: 0,
      clientImpl: stub.client,
    });

    expect(outcome).toEqual({ status: "failed", reason: "timeout" });
    expect(stub.callCount).toBe(0);
  });

  it("데드라인이 음수여도 예외를 던지지 않고 timeout이다", async () => {
    const stub = alwaysReturn(() => okResponse());

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: -1,
      photoIndex: 0,
      clientImpl: stub.client,
    });

    expect(outcome).toEqual({ status: "failed", reason: "timeout" });
    expect(stub.callCount).toBe(0);
  });

  it("SDK 타임아웃은 upstream이 아니라 timeout으로 나른다 (사유 보존)", async () => {
    const stub = alwaysThrow(() => new APIConnectionTimeoutError({}));

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: stub.client,
      sleepImpl: noSleep,
    });

    expect(outcome).toEqual({ status: "failed", reason: "timeout" });
  });

  it("요청 중단도 timeout이다", async () => {
    const stub = alwaysThrow(() => new APIUserAbortError({}));

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: stub.client,
      sleepImpl: noSleep,
    });

    expect(outcome).toEqual({ status: "failed", reason: "timeout" });
  });
});

/* ------------------------------------------------------------------ *
 * 검증 경계 (CLAUDE.md CRITICAL)
 * ------------------------------------------------------------------ */

describe("검증 경계 — extractionResultSchema를 통과한 뒤에만 도메인 값이다", () => {
  it("스키마를 어긴 후보가 있으면 schema로 실패하고 예외가 새어 나가지 않는다", async () => {
    const { client } = alwaysReturn(() => okResponse([candidate({ confidence: 2 })]));

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
    });

    expect(outcome).toEqual({ status: "failed", reason: "schema" });
  });

  it("모델이 photoIndex 같은 서버 소관 필드를 채워 보내도 결과에 반영하지 않는다", async () => {
    const { client } = alwaysReturn(() => okResponse([candidate({ photoIndex: 99 })]));

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 1,
      clientImpl: client,
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.candidates[0].photoIndex).toBe(1);
  });

  it(`후보 ${MAX_CANDIDATES_PER_PHOTO + 1}건은 스키마가 거부한다 — 증폭 방지는 스키마가 강제한다`, async () => {
    const many = Array.from({ length: MAX_CANDIDATES_PER_PHOTO + 1 }, (_unused, index) =>
      candidate({ title: `책 ${index}` }),
    );
    const { client } = alwaysReturn(() => okResponse(many));

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
    });

    expect(outcome).toEqual({ status: "failed", reason: "schema" });
  });

  it(`후보 ${MAX_CANDIDATES_PER_PHOTO}건은 통과한다 (상한 경계)`, async () => {
    const many = Array.from({ length: MAX_CANDIDATES_PER_PHOTO }, (_unused, index) =>
      candidate({ title: `책 ${index}` }),
    );
    const { client } = alwaysReturn(() => okResponse(many));

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.candidates).toHaveLength(MAX_CANDIDATES_PER_PHOTO);
  });

  it("본문이 JSON이 아니면 schema다 — 정규식으로 건져 내지 않는다", async () => {
    const { client } = alwaysReturn(() => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "책이 세 권 보입니다: 소년이 온다, 채식주의자" }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }));

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
    });

    expect(outcome).toEqual({ status: "failed", reason: "schema" });
  });

  it("텍스트 블록이 하나도 없으면 schema다", async () => {
    const { client } = alwaysReturn(() => ({
      stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "" }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }));

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
    });

    expect(outcome).toEqual({ status: "failed", reason: "schema" });
  });

  it("응답 봉투가 계약과 다르면 schema다 — 예외를 던지지 않는다", async () => {
    const { client } = alwaysReturn(() => ({ unexpected: true }));

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
    });

    expect(outcome).toEqual({ status: "failed", reason: "schema" });
  });

  it("이미지가 데이터 URI 계약을 어기면 SDK를 부르지 않고 schema다", async () => {
    const stub = alwaysReturn(() => okResponse());

    const outcome = await extractFromPhoto("https://example.com/shelf.jpg", {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: stub.client,
    });

    expect(outcome).toEqual({ status: "failed", reason: "schema" });
    expect(stub.callCount).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 목업 모드 (TRD 9번)
 * ------------------------------------------------------------------ */

describe("목업 모드 — ANTHROPIC_API_KEY가 없을 때", () => {
  it("SDK를 호출하지 않고 목업 후보를 돌려준다", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const stub = alwaysReturn(() => okResponse());

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 2,
      clientImpl: stub.client,
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(stub.callCount).toBe(0);
    expect(outcome.candidates.length).toBeGreaterThan(0);
    for (const found of outcome.candidates) {
      expect(extractedCandidateSchema.safeParse(found).success).toBe(true);
      expect(found.photoIndex).toBe(2);
    }
  });

  it("목업이라는 사실을 경고로 남긴다 — 조용한 목업은 금지다", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    await extractFromPhoto(IMAGE, { deadlineMs: AMPLE_DEADLINE_MS, photoIndex: 0 });

    expect(warnSpy).toHaveBeenCalled();
    expect(loggedText()).toContain("목업");
  });

  it("토큰을 쓰지 않았으므로 usage는 0이다 — 비용 집계를 부풀리지 않는다", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

/* ------------------------------------------------------------------ *
 * 시크릿·PII 유출 회귀 테스트 — 삭제하지 마라 (TRD 6.5, PRD 7번)
 * ------------------------------------------------------------------ */

describe("시크릿·PII 유출 방지", () => {
  it("SDK 오류 메시지에 API 키가 섞여 있어도 로그에 남기지 않는다", async () => {
    const stub = alwaysThrow(() => apiError(500, `upstream failed for x-api-key=${API_KEY}`));

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: stub.client,
      sleepImpl: noSleep,
    });

    expect(outcome).toEqual({ status: "failed", reason: "upstream" });
    expect(loggedText()).not.toContain(API_KEY);
    expect(JSON.stringify(outcome)).not.toContain(API_KEY);
  });

  it("판독 원문(rawText)을 로그에 남기지 않는다", async () => {
    const { client } = alwaysReturn(() =>
      okResponse([candidate({ rawText: SECRET_RAW_TEXT, confidence: 7 })]),
    );

    const outcome = await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
    });

    expect(outcome).toEqual({ status: "failed", reason: "schema" });
    expect(loggedText()).not.toContain(SECRET_RAW_TEXT);
  });

  it("성공 경로에서도 원문과 이미지 데이터를 로그에 남기지 않는다", async () => {
    const { client } = alwaysReturn(() => okResponse([candidate({ rawText: SECRET_RAW_TEXT })]));

    await extractFromPhoto(IMAGE, {
      deadlineMs: AMPLE_DEADLINE_MS,
      photoIndex: 0,
      clientImpl: client,
    });

    const logged = loggedText();
    expect(logged).not.toContain(SECRET_RAW_TEXT);
    expect(logged).not.toContain("base64");
  });
});
