/**
 * 구조화 이벤트 로그 (TR-012).
 *
 * ## 왜 표준 출력인가
 * 저장소가 없으므로(ADR-003) 이벤트 DB를 세울 자리가 없다. 이벤트는 JSON
 * **한 줄**로 표준 출력에 남고 Vercel 로그가 유일한 조회 수단이다. 줄 단위로
 * 집계하므로 pretty-print나 여러 줄 출력은 그 자체로 계약 위반이다.
 *
 * ## 왜 판별 유니온인가
 * 이벤트 이름을 문자열로 받는 느슨한 API는 오타가 조용히 통과해 지표를 비운다.
 * 지표가 비었다는 사실은 집계할 때가 되어서야 드러나고, 그때는 이미 데이터가
 * 없다. 그래서 이름과 속성을 리터럴 유니온으로 묶어 호출부에서 컴파일이
 * 깨지게 한다. 이벤트 목록의 정본은 /docs/PRD.md 7번 표다 — 여기 있는 9종이
 * 그 표와 1:1로 대응하며, 지표에 연결되지 않는 이벤트는 만들지 않는다.
 *
 * ## 왜 속성을 화이트리스트로 투영하는가
 * PII·이미지·파일명·판독 원문(`rawText`)은 절대 로그에 남기지 않는다(PRD 7번).
 * 타입만으로는 객체 리터럴이 아닌 호출(라우트 핸들러가 조립한 변수)에서
 * 초과 속성이 걸러지지 않으므로, 직렬화 직전에 표에 있는 키만 골라 담는다.
 * 실수로 원문을 얹어도 로그에는 닿지 않는다.
 *
 * `lib/`는 외부 호출을 하지 않는 순수 계층이라 로깅 라이브러리를 쓰지 않는다.
 */
import type { z } from "zod";
import type {
  errorCodeSchema,
  recommendRequestSchema,
  recommendationSchema,
  unidentifiedReasonSchema,
} from "./schemas";

/**
 * 미확인 사유별 카운트. 4종을 여기 다시 적지 않고 스키마에서 파생한다 —
 * 사유가 늘거나 이름이 바뀌면 호출부가 컴파일 단계에서 깨져야 한다.
 *
 * 합계 하나로 뭉개지 않는 이유: `lookup_failed`(알라딘 장애)는 미확인 비율
 * 가드레일(20%)의 분자에서 빼야 한다. 외부 장애를 프롬프트 품질 저하로
 * 오독하면 엉뚱한 롤백을 하게 된다 (ADR-005).
 */
export type UnidentifiedReasonCounts = Record<
  z.infer<typeof unidentifiedReasonSchema>,
  number
>;

/**
 * PRD 7번 표의 이벤트 9종.
 *
 * `input_tokens`·`output_tokens`는 Claude를 호출하는 이벤트에서 **옵셔널이
 * 아니다.** 일부 호출의 토큰이 빠지면 세션당 비용이 실제보다 낮게 집계되어
 * "세션당 300원" 가드레일이 통과할 수 없는 조건에서도 통과한다.
 */
export type AnalyticsEvent =
  /** `/api/analyze` 요청 수신 — 세션 완주율의 분모이자 소요 시간의 시작점 */
  | { event: "photo_uploaded"; session_id: string; photo_count: number }
  /** 분석 응답 반환 직전 — 책 인식률·미확인 비율·세션당 비용 */
  | {
      event: "analyze_completed";
      session_id: string;
      identified_count: number;
      unidentified_count: number;
      unidentified_by_reason: UnidentifiedReasonCounts;
      overflow_count: number;
      failed_photo_count: number;
      duration_ms: number;
      input_tokens: number;
      output_tokens: number;
    }
  /** 분석 중 처리 불가 오류 — 에러율 가드레일 */
  | {
      event: "analyze_failed";
      session_id: string;
      error_code: z.infer<typeof errorCodeSchema>;
      failed_photo_count: number;
    }
  /** 문답 응답 반환 직전. `question_count: 0`은 자유 입력 폴백을 뜻한다 */
  | {
      event: "questions_generated";
      session_id: string;
      question_count: number;
      input_tokens: number;
      output_tokens: number;
    }
  /** 기분 텍스트 또는 문답 답변 제출 */
  | {
      event: "mood_submitted";
      session_id: string;
      input_mode: z.infer<typeof recommendRequestSchema>["inputMode"];
      retry_index: number;
    }
  /** 미확인 책을 사용자가 확정 (클라이언트 관측 → /api/events) */
  | {
      event: "book_resolved";
      session_id: string;
      resolve_attempt: number;
      matched: boolean;
    }
  /** 추천 결과 렌더링 (클라이언트 관측) — 추천 수락률의 분모 */
  | {
      event: "recommend_viewed";
      session_id: string;
      recommended_count: number;
      duration_ms: number;
      input_tokens: number;
      output_tokens: number;
    }
  /**
   * 추천 실패 응답 반환 직전 — 에러율(가드레일) · 세션당 비용(가드레일).
   *
   * `recommend_viewed`를 대신 올리지 않는다. 실패가 분모에 섞이면 추천 수락률이
   * 실제보다 낮게 보인다 — `analyze_completed`/`analyze_failed`와 같은 짝이다.
   * 태운 토큰은 실패해도 청구되므로 여기서도 옵셔널이 아니다 (PRD 7번).
   */
  | {
      event: "recommend_failed";
      session_id: string;
      error_code: z.infer<typeof errorCodeSchema>;
      input_tokens: number;
      output_tokens: number;
    }
  /** "이거 읽을래요" 클릭 (클라이언트 관측) — North Star의 분자 */
  | {
      event: "recommend_accepted";
      session_id: string;
      position: z.infer<typeof recommendationSchema>["position"];
    };

type EventName = AnalyticsEvent["event"];
type EventOf<N extends EventName> = Extract<AnalyticsEvent, { event: N }>;

/**
 * 이벤트별로 로그에 실을 속성 목록.
 *
 * 타입이 각 이벤트의 실제 키만 허용하므로 표에 없는 이름은 여기 적을 수 없고,
 * 여기 없는 키는 로그에 실리지 않는다. 누락은 `analytics.test.ts`가 이벤트마다
 * 출력 전체를 대조해 잡는다.
 */
const PROPERTY_KEYS: {
  [N in EventName]: readonly Exclude<keyof EventOf<N>, "event">[];
} = {
  photo_uploaded: ["session_id", "photo_count"],
  analyze_completed: [
    "session_id",
    "identified_count",
    "unidentified_count",
    "unidentified_by_reason",
    "overflow_count",
    "failed_photo_count",
    "duration_ms",
    "input_tokens",
    "output_tokens",
  ],
  analyze_failed: ["session_id", "error_code", "failed_photo_count"],
  questions_generated: ["session_id", "question_count", "input_tokens", "output_tokens"],
  mood_submitted: ["session_id", "input_mode", "retry_index"],
  book_resolved: ["session_id", "resolve_attempt", "matched"],
  recommend_viewed: [
    "session_id",
    "recommended_count",
    "duration_ms",
    "input_tokens",
    "output_tokens",
  ],
  recommend_failed: ["session_id", "error_code", "input_tokens", "output_tokens"],
  recommend_accepted: ["session_id", "position"],
};

/** 표에 있는 키만 골라 담는다. 그 밖의 값은 어떤 경로로 들어와도 버린다 */
function project(event: AnalyticsEvent): Record<string, unknown> {
  const source = event as unknown as Record<string, unknown>;
  const line: Record<string, unknown> = { event: event.event };

  const keys = (PROPERTY_KEYS as Record<EventName, readonly string[]>)[event.event];
  for (const key of keys) {
    line[key] = source[key];
  }

  return line;
}

/**
 * 이벤트 하나를 JSON 한 줄로 표준 출력에 남긴다.
 *
 * 로깅 실패는 절대 호출부로 전파하지 않는다 — 지표 수집이 사용자 화면을
 * 망가뜨리면 본말이 전도된다(TR-012). 다만 조용히 삼키지도 않는다.
 * 삼킨 사실은 표준 에러에 폴백 한 줄로 남겨 두어, 지표가 비었을 때
 * "안 일어난 일"과 "기록에 실패한 일"을 구분할 수 있게 한다.
 */
export function logEvent(event: AnalyticsEvent): void {
  try {
    console.log(JSON.stringify(project(event)));
  } catch (error) {
    try {
      // 폴백은 이벤트가 아니다. `event` 키를 쓰지 않아 집계에 섞이지 않게 둔다.
      const name = (event as { event?: unknown } | null | undefined)?.event;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[analytics] 이벤트 기록 실패: ${String(name)} — ${detail}`);
    } catch {
      // 출력 채널 자체가 죽은 상황이다. 여기서 더 할 수 있는 일이 없다.
    }
  }
}
