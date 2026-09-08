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
import {
  capIdentified,
  capUnidentified,
  dedupeByIsbn,
  mergeKey,
  reduceBeforeLookup,
} from "@/lib/merge";
import { issueProof } from "@/lib/proof";
import { analyzeRequestSchema, analyzeResponseSchema } from "@/lib/schemas";
import {
  measureUnidentified,
  MEASURED_FROM_VERDICT,
  RESPONSE_REASON,
  type MeasuredUnidentified,
} from "@/lib/unidentified";
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

  // 조회 **전**에 줄인다. 확신도 하한과 65건 상한이 여기서 걸리지 않으면
  // 판독 한 번의 이상 동작이 알라딘 일일 한도를 한 요청에 소진시킨다 (FR-012).
  // 강등된 세 바구니는 응답에서 같은 사유(`unreadable`)로 접히지만 지표에서는
  // 갈라야 하므로 나뉜 채로 받는다 (`lib/merge.ts` · `lib/unidentified.ts`).
  //
  // `toLookup`과 `capped`는 후보가 아니라 **후보와 그 병합 키의 쌍**이다. 키는
  // `reduceBeforeLookup`이 한 번 계산했고, 이 파일은 그것을 나르기만 한다 —
  // 여기서 `mergeKey`를 다시 부르면 같은 후보에 키를 만드는 자리가 둘이 되고,
  // 그 둘이 갈리는 날 병합이 접은 책과 계측이 접는 책이 달라진다.
  const { toLookup, lowConfidence, blankTitle, capped } = reduceBeforeLookup(candidates);

  // 브레이커도 데드라인도 **요청 하나**가 ItemSearch와 ItemLookUp에 나눠 준다.
  // 각자 12s를 잡으면 합이 24s가 되어 총 예산이 깨지고, 브레이커를 따로 두면
  // 이미 죽은 알라딘을 두 번 두드린다 (TRD 7번).
  const breaker = createRequestBreaker();
  const lookupDeadlineAt = Date.now() + budget.deadlineFor("lookup");

  const searchOutcomes = await searchMany(
    toLookup.map(({ candidate }) => ({ title: candidate.title, author: candidate.author })),
    { deadlineMs: lookupDeadlineAt - Date.now(), breaker },
  );

  // 미확인은 **쌍**으로 쌓는다. `book`은 사용자가 볼 것이고, `measured`는 그
  // 기전이다. 응답 사유는 `RESPONSE_REASON`이 유도하므로 이 파일이 사유 문자열을
  // 직접 고르는 자리는 없다 — 두 어휘가 갈리려면 매핑 표를 고쳐야 한다.
  const unidentified: MeasuredUnidentified[] = [];
  const promoted: PromotedBook[] = [];

  toLookup.forEach(({ candidate, key }, index) => {
    const verdict = judge(candidate, searchOutcomes[index]);
    if (verdict.kind === "identified") {
      promoted.push({
        isbn13: verdict.candidate.isbn13,
        photoIndex: candidate.photoIndex,
        rawText: candidate.rawText,
        // 계측 키는 **추출 후보**에서 만든 것을 그대로 나른다. 알라딘 후보의
        // 제목·저자로 다시 만들면 같은 책인데 다른 바구니의 항목과 키가 어긋난다.
        // 여기까지 온 후보는 `reduceBeforeLookup`이 키 있는 쪽으로 갈라 놓은
        // 것들뿐이라 `key`는 항상 문자열이고, 좁히는 분기가 필요 없다.
        mergeKey: key,
        candidate: verdict.candidate,
      });
      return;
    }
    // 사유는 끝까지 다른 값으로 나른다 — no_match와 lookup_failed는 화면에서 다른 문장이다.
    // `judge`가 낸 응답 사유를 기전으로 되돌린 뒤(각 사유마다 기전이 하나뿐이라
    // 성립한다) 응답 사유를 다시 유도한다. 왕복이므로 사용자가 보는 값은 그대로다.
    demote(
      unidentified,
      { rawText: candidate.rawText, mergeKey: key },
      MEASURED_FROM_VERDICT[verdict.reason],
      verdict.candidates,
    );
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
      // 기전을 `search_failed`와 나누는 것은 **어느 단계에서 떨어졌는지**를 남기기
      // 위해서다. 어느 엔드포인트가 죽었는지가 아니다 — 브레이커가 열렸거나 예산이
      // 없으면 `services/aladin.ts`가 호출조차 없이 `failed`를 준다.
      demote(unidentified, book, "facts_failed");
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
  // 응답에서는 셋 다 같은 문장으로 접히고(`RESPONSE_REASON`), 갈라지는 곳은 지표뿐이다.
  //
  // 쌓는 순서가 곧 기전의 우선순위다: 저확신 → 빈 제목 → 상한 절단. `lib/merge.ts`가
  // 확신도 하한을 먼저 가르므로 확신도가 낮으면서 제목도 빈 후보는 `low_confidence`로
  // 세어지고, 그 항목의 `mergeKey`는 `null`이다 — 여기는 `null`이 실제로 흐른다.
  for (const candidate of lowConfidence) demote(unidentified, keyed(candidate), "low_confidence");
  for (const candidate of blankTitle) demote(unidentified, keyed(candidate), "blank_title");
  for (const { candidate, key } of capped) {
    demote(unidentified, { rawText: candidate.rawText, mergeKey: key }, "lookup_capped");
  }

  // 확인된 책의 계측 키를 모은다. **`dedupeByIsbn` 전의 `promoted`에서** 모으는
  // 이유는 같은 ISBN에 서로 다른 후보 키가 달릴 수 있기 때문이다 — 중복 제거 뒤에는
  // 대표 하나의 키만 남아, 접혀 사라진 판독본의 키가 미확인 쪽에서 다시 세어진다.
  //
  // 다만 `promoted` 전체가 아니라 `identifiedFacts`와의 **교집합**이다. 사실 조회에
  // 실패해 강등된 책(`facts_failed`)은 확인 목록에 없으므로 그 키가 남의 분자를
  // 깎으면 안 된다 — 그 강등은 `uniquePromoted` 단위로 떨어지고, 그러면 그 ISBN
  // 아래 키가 전부 배제된다.
  const keysByIsbn = new Map<string, string[]>();
  for (const book of promoted) {
    const keys = keysByIsbn.get(book.isbn13);
    if (keys === undefined) keysByIsbn.set(book.isbn13, [book.mergeKey]);
    else keys.push(book.mergeKey);
  }
  const identifiedKeys = new Set<string>();
  for (const book of identifiedFacts) {
    // `identifiedFacts ⊆ uniquePromoted ⊆ promoted`가 구성상 성립하므로 조회가
    // 빗나갈 수 없다. 그래도 폴백을 둔다 — 그 포함 관계를 지키는 것은 몇 줄 떨어진
    // 코드라 리팩터링 한 번에 깨지고, 깨진 자리에서 던지면 요청 전체가 500이 된다.
    // 빈 배열이 도는 일이 실제로 있으면 그것은 회귀이지 정상 경로가 아니다.
    for (const key of keysByIsbn.get(book.isbn13) ?? []) identifiedKeys.add(key);
  }

  // 계측은 **표시 상한 절단 전에** 센다. 절단 뒤에 세면 후보가 쏟아진 요청일수록
  // 미확인 비율이 낮게 나오는 뒤집힌 지표가 된다 (`lib/analytics.ts`의 `raw_` 규칙).
  //
  // 확인 쪽 모집단은 `identifiedFacts`다 — `dedupeByIsbn`을 지나 **책 단위**이고,
  // 미확인 쪽도 `mergeKey`로 접혀 같은 단위가 된다. 둘의 단위가 다르면 흐릿한
  // 사진을 여러 장 넣을수록 지표가 나빠 보인다.
  //
  // 키 집합과 책 수를 **따로** 넘긴다. 키는 분자에서 빼는 데만 쓰고 분모의 확인
  // 쪽은 `identifiedFacts.length`를 쓴다 — 위에서 본 대로 한 ISBN에 키가 여럿일 수
  // 있어 집합 크기가 책 수보다 클 수 있고, 그것을 분모에 넣으면 분모만 부푼다.
  const measurement = measureUnidentified(unidentified, {
    keys: identifiedKeys,
    count: identifiedFacts.length,
  });
  // 규모 관측값이다. 분모가 아니므로 `measurement`와 나누지 않는다.
  const rawCandidateCount = identifiedFacts.length + unidentified.length;

  const { kept: keptIdentified, overflowCount } = capIdentified(identifiedFacts);
  // 절단은 `book`만 보고 기존과 똑같이 한다 — `measured`는 응답 경계를 넘지 않는다.
  const { kept: keptUnidentified, overflowCount: unidentifiedOverflowCount } = capUnidentified(
    unidentified.map((entry) => entry.book),
  );

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
    raw_candidate_count: rawCandidateCount,
    raw_guardrail_denominator: measurement.guardrailDenominator,
    raw_unidentified_guardrail_count: measurement.guardrailCount,
    raw_unidentified_by_measurement: measurement.byMeasurement,
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
  /**
   * 계측 키. 추출 후보에서 미리 만들어 들고 온다 — 여기서 `candidate`(알라딘
   * 후보)로 다시 만들면 같은 책인데 다른 바구니의 항목과 키가 어긋나 계측에서
   * 접히지 않는다.
   *
   * 강등될 때만이 아니라 **확인으로 끝날 때도 쓰인다**: 확인된 책의 키는 미확인
   * 계측의 `seen`을 여는 데 들어가, 같은 책이 분자와 분모 양쪽에 앉는 것을 막는다.
   *
   * `string | null`이 아니라 `string`인 이유는 여기까지 오는 후보가 `toLookup`뿐이고,
   * `reduceBeforeLookup`이 키 없는 후보를 그 앞에서 `blankTitle`로 갈라 냈기
   * 때문이다. 안 흐르는 `null`을 위해 타입을 넓히면 검증할 수 없는 분기가 생긴다.
   */
  mergeKey: string;
  candidate: AladinCandidate;
}

/**
 * 미확인 1건을 쌓는다. **응답 사유를 고르는 유일한 자리다.**
 *
 * 호출부는 기전(`measured`)만 정하고 사용자에게 보일 사유는 `RESPONSE_REASON`이
 * 유도한다. 둘을 따로 적게 두면 언젠가 한쪽만 고쳐져 화면 문장과 지표가 다른
 * 이야기를 하게 된다 (`lib/unidentified.ts`).
 *
 * `mergeKey`는 계측이 판독본이 아니라 **책**을 세게 하는 값이고 응답에는 나가지
 * 않는다. 목록은 접지 않으므로 같은 책의 흐릿한 판독본 다섯 개는 화면에 다섯 개로
 * 그대로 남는다 — 왜 빠졌는지는 사진마다 보여야 한다 (ADR-002).
 *
 * `candidates`는 `ambiguous`에서만 채워지며, 그 규칙은 `unidentifiedBookSchema`의
 * `.refine`이 응답 검증에서 다시 강제한다.
 */
function demote(
  into: MeasuredUnidentified[],
  source: { rawText: string; mergeKey: string | null },
  measured: MeasuredUnidentified["measured"],
  candidates: AladinCandidate[] = [],
): void {
  into.push({
    book: { rawText: source.rawText, reason: RESPONSE_REASON[measured], candidates },
    measured,
    mergeKey: source.mergeKey,
  });
}

/**
 * 추출 후보를 `demote`가 받는 모양으로 바꾼다.
 *
 * 키는 `lib/merge.ts`의 것을 그대로 쓴다. 여기에 다시 구현하면 병합이 접은 책과
 * 계측이 접는 책이 소리 없이 갈린다.
 *
 * 쓰이는 곳은 키를 **나르지 않는** 두 바구니(`lowConfidence`·`blankTitle`)뿐이다.
 * `toLookup`과 `capped`는 `reduceBeforeLookup`이 만든 키를 이미 들고 있어 다시
 * 만들 이유가 없다. 여기서 `mergeKey`가 `null`을 내는 것은 정상이다 —
 * `blankTitle`은 정의상 전부 `null`이고, `lowConfidence`도 확신도 하한을 먼저
 * 가르므로 제목이 빈 후보를 품을 수 있다.
 */
function keyed(candidate: ExtractedCandidate): { rawText: string; mergeKey: string | null } {
  return { rawText: candidate.rawText, mergeKey: mergeKey(candidate) };
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

/**
 * 화면에 실제로 나간 목록의 **응답 사유별** 카운트. 합계로 뭉개면
 * `lookup_failed`를 가드레일 분자에서 뺄 수 없다 (ADR-005).
 *
 * 이것은 절단 **뒤**의 값이고, 가드레일 계산에는 쓰지 않는다 — 분자·분모는
 * `raw_`가 붙은 세 필드가 따로 나른다 (`lib/analytics.ts`).
 *
 * 아래 네 이름은 사유를 **고르는** 값이 아니라 응답 어휘 4종을 빠짐없이 세기
 * 위한 `Record`의 키다. 손으로 적어 두는 편이 낫다 — 사유가 늘거나 이름이
 * 바뀌면 여기서 컴파일이 깨져야 하고, 스키마에서 돌려 만들면 그 못이 빠진다.
 */
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
