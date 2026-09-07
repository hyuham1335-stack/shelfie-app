/**
 * 미확인 사유의 **계측 어휘** (ADR-002 · ADR-005, PRD 가드레일).
 *
 * ## 왜 어휘가 둘인가
 * 사용자에게 보여 주는 사유는 4종이고 그 목록은 `unidentifiedReasonSchema`가
 * 정한다. 사용자는 "왜 빠졌는가"에 대해 자기가 할 수 있는 일이 같으면 같은
 * 문장을 봐야 하므로 사유를 잘게 쪼갤 이유가 없다. 반면 지표는 반대다 —
 * 응답의 `unreadable` 한 칸에는 기전이 셋(`low_confidence`·`lookup_capped`
 * ·`blank_title`) 들어 있고, 그중 `lookup_capped`는 **우리가 건 조회 상한**
 * 때문에 밀린 것이라 프롬프트 품질 저하로 세면 지표를 오독하게 된다.
 * 화면 어휘로 지표를 세면 "미확인 비율이 올랐다"를 보고도 프롬프트를 만져야
 * 하는지 상한을 올려야 하는지 알 수 없다.
 *
 * 그래서 이 모듈은 계측 사유 일곱을 따로 두고, **응답 사유는 여기서 유도한다.**
 * 반대 방향(응답 사유를 손으로 적고 계측을 따로 매기는 것)이면 두 값이 소리
 * 없이 갈리는 날이 온다.
 *
 * ## 순수 모듈이다
 * Next 런타임도 `analytics.ts`도 부르지 않는다. 스키마에서 파생한 타입만 보고,
 * 로그를 남기는 일은 호출부(`app/api/analyze/route.ts`)가 한다. 계측 규칙을
 * 로깅과 붙여 두면 규칙 하나 확인하는 데 표준 출력을 가로채야 한다.
 */
import type { z } from "zod";
import type { unidentifiedBookSchema, unidentifiedReasonSchema } from "./schemas";

/*
 * `merge.ts`·`match.ts`와 같은 이유로 타입을 스키마에서 직접 파생한다 —
 * `types/` → `lib/`는 타입 전용 점선이고 역방향은 금지다 (/docs/ARCHITECTURE.md).
 */
type UnidentifiedReason = z.infer<typeof unidentifiedReasonSchema>;
type UnidentifiedBook = z.infer<typeof unidentifiedBookSchema>;

/**
 * 계측 사유 일곱. **응답 사유 4종과 별개의 어휘다.**
 *
 * - `low_confidence` : 확신도 하한에 못 미쳐 조회하지 않음 (판독 품질)
 * - `lookup_capped`  : 조회 65건 상한에 밀려 조회하지 못함 (우리가 건 상한)
 * - `blank_title`    : 제목을 정규화하면 빈 문자열 (판독 품질)
 * - `no_match`       : 알라딘에 정말 없음
 * - `ambiguous`      : 후보가 둘 이상이라 하나로 좁히지 못함
 * - `search_failed`  : ItemSearch 단계에서 알라딘 응답을 확보하지 못함
 * - `facts_failed`   : ItemLookUp 단계에서 알라딘 응답을 확보하지 못함
 *
 * ## 조회 실패 둘의 정의역
 * "알라딘이 죽었다"가 **아니다.** `services/aladin.ts`는 브레이커가 이미 열려
 * 있거나 대조 예산이 남지 않았으면 **HTTP를 걸지도 않고** `failed`를 돌려준다
 * (`searchByTitle`·`lookupFacts`). 그래서 정의역은 "그 단계에서 알라딘 응답을
 * **확보하지 못했다** — 호출조차 못 한 경우를 포함해서"다. 둘을 나누는 것은
 * 어느 엔드포인트가 죽었는지를 알기 위해서가 아니라 **파이프라인의 어느 단계에서
 * 떨어졌는지**를 알기 위해서다. 원인(브레이커·예산·5xx)을 더 쪼개려면 어휘를
 * 늘려야 하는데 그것은 이 런의 범위 밖이다.
 *
 * 어느 쪽이든 사용자에게는 `lookup_failed` 하나이고, 프롬프트 품질 판정의
 * 모집단 밖이다 — 조회하지 못한 책은 판독이 좋았는지 나빴는지 말해 주지 않는다.
 */
export type MeasurementReason =
  | "low_confidence"
  | "lookup_capped"
  | "blank_title"
  | "no_match"
  | "ambiguous"
  | "search_failed"
  | "facts_failed";

/**
 * 미확인 1건과 그 기전을 함께 나르는 쌍.
 *
 * 응답에도 스키마에도 나가지 않는다 — `measured`는 서버 안에서만 쓰는 값이고,
 * 응답에 실으면 어휘 4종이라는 계약(`unidentifiedReasonSchema`)이 깨진다.
 */
export interface MeasuredUnidentified {
  book: UnidentifiedBook;
  measured: MeasurementReason;
  /**
   * `lib/merge.ts`의 `mergeKey`로 만든 "같은 책인가" 키.
   *
   * 계측이 판독본이 아니라 **책**을 세게 하는 값이다. 호출부가 채워 넣는 이유는
   * 원본 후보의 제목·저자를 아는 쪽이 호출부이기 때문이고, 여기서 다시 만들면
   * 키가 두 벌이 된다.
   */
  mergeKey: string;
}

/** 미확인 계측 결과. 전부 표시 상한 절단 **전**의 값이다 */
export interface UnidentifiedMeasurement {
  /** 미확인 비율 가드레일의 **분자**. 중복을 접은 뒤의 수다 */
  guardrailCount: number;
  /**
   * 가드레일의 **분모** — 확인된 책 수 + `guardrailCount`.
   *
   * 분자와 **같은 모집단**만 센다. 조회하지 않았거나(`lookup_capped`) 하지 못한
   * (`search_failed`·`facts_failed`) 책은 여기에도 들어가지 않는다.
   */
  guardrailDenominator: number;
  /**
   * 조회 상한에 밀린 수. 상한을 올려야 하는지 판단하는 값이다.
   *
   * `byMeasurement.lookup_capped`와 같은 값이고 그 칸에서 그대로 읽어 온다 —
   * 따로 세면 두 수가 갈릴 수 있다.
   */
  lookupCapped: number;
  /** 계측 사유 일곱의 분해. 접은 뒤의 수이고, 합이 곧 고유 미확인 책 수다 */
  byMeasurement: Record<MeasurementReason, number>;
}

/**
 * 계측 사유 → 응답 사유 접힘 매핑. **응답 사유의 단일 출처다.**
 *
 * `Record`가 일곱 키를 전부 요구하므로 계측 사유를 늘리면 여기서 컴파일이
 * 깨진다 — 새 기전이 응답에서 어떤 문장으로 보일지 정하지 않고 넘어갈 수 없다.
 *
 * 셋이 `unreadable`로 접히는 근거: 세 경우 모두 사용자가 할 수 있는 일이 같다
 * (제목 직접 입력). 특히 `lookup_capped`를 `lookup_failed`로 표시하면 조회한
 * 적도 없는 책에 "잠시 후 다시 시도해 주세요"라고 말하게 되어 ADR-005를 어긴다.
 */
export const RESPONSE_REASON: Record<MeasurementReason, UnidentifiedReason> = {
  low_confidence: "unreadable",
  lookup_capped: "unreadable",
  blank_title: "unreadable",
  no_match: "no_match",
  ambiguous: "ambiguous",
  search_failed: "lookup_failed",
  facts_failed: "lookup_failed",
};

/**
 * `judge`가 낸 응답 사유를 계측 사유로 승격시키는 어댑터.
 *
 * **`RESPONSE_REASON`의 역함수가 아니다.** 역함수는 존재하지 않는다 — 셋이 하나로
 * 접히기 때문이다. 이 표가 성립하는 이유는 정의역이 `judge`의 출력 넷뿐이라는
 * 좁은 사실에 있다. `judge`는 `unreadable`을 제목이 빈 경우에만 내고
 * (`match.ts` — 확신도는 보지 않는다), `lookup_failed`는 ItemSearch 실패에서만
 * 낸다. 그래서 이 자리에서는 각 응답 사유가 기전 하나로 되돌아간다.
 *
 * `judge`의 판정 순서가 바뀌면 이 표가 조용히 거짓이 되므로, 왕복 항등식
 * `RESPONSE_REASON[MEASURED_FROM_VERDICT[r]] === r`을 테스트가 못으로 박는다.
 */
export const MEASURED_FROM_VERDICT: Record<UnidentifiedReason, MeasurementReason> = {
  unreadable: "blank_title",
  no_match: "no_match",
  ambiguous: "ambiguous",
  lookup_failed: "search_failed",
};

/**
 * 가드레일 분자에 들어가는가. **이 규칙의 소유자는 이 표 하나다.**
 *
 * 넷(`low_confidence`·`blank_title`·`no_match`·`ambiguous`)만 `true`다. 이 넷은
 * "읽어서 알라딘에 물어봤거나, 물어볼 가치가 없을 만큼 못 읽은" 책들 — 즉
 * **판독 품질이 실제로 판정된** 책들이다.
 *
 * 빠지는 셋은 판정 자체가 일어나지 않은 책이라 판독 품질을 증언하지 못한다.
 * - `lookup_capped` : 우리가 건 상한 때문에 밀렸다. 조회한 적이 없다
 * - `search_failed`·`facts_failed` : 그 단계에서 알라딘 응답을 확보하지 못했다
 *   (브레이커 개방·예산 소진으로 **호출조차 못 한** 경우 포함). 외부 사정을
 *   프롬프트 품질 저하로 오독하면 엉뚱한 롤백을 하게 된다 (ADR-005)
 *
 * 셋은 분자에서만 빠지는 것이 아니라 **분모에서도 빠진다**. 분자에서만 빼면
 * 비율이 희석되어, 알라딘이 전면 장애인 세션이 가장 좋은 성적을 내게 된다.
 *
 * 집합이 아니라 `Record`인 것은 의도다 — 계측 사유가 늘면 "분자에 넣을지"를
 * 여기서 반드시 정하게 되고, 빠뜨리면 컴파일이 깨진다.
 */
const COUNTS_TOWARD_GUARDRAIL: Record<MeasurementReason, boolean> = {
  low_confidence: true,
  lookup_capped: false,
  blank_title: true,
  no_match: true,
  ambiguous: true,
  search_failed: false,
  facts_failed: false,
};

/**
 * 미확인 쌍 목록을 훑어 가드레일 분자·분모와 사유별 분해를 센다.
 *
 * ## 세는 단위는 판독본이 아니라 책이다
 * 같은 `mergeKey`를 가진 항목은 **하나로 접어 센다.** 접지 않으면 단위가
 * 어긋난다 — 같은 책이 사진 다섯 장에 흐릿하게 찍히면 분자가 5 오르는데,
 * 또렷하게 읽혀 확인으로 올라간 같은 책은 `dedupeByIsbn`을 지나 분모에 1만
 * 더한다. 흐릿한 사진을 많이 넣을수록 지표가 나빠 보이는 것은 이 런이 막겠다고
 * 한 오독과 같은 방향이다.
 *
 * 접힘은 **첫 항목이 대표**다. 호출부가 쌓는 순서가 결정적이므로(판정 → 사실
 * 조회 실패 → 저확신 → 상한 절단) 같은 입력이면 같은 수가 나온다.
 *
 * **응답 목록은 접지 않는다.** 접는 것은 세는 자리뿐이고, 사용자는 자기가 올린
 * 사진마다 왜 빠졌는지를 그대로 봐야 한다 (ADR-002).
 *
 * `identifiedCount`는 분모의 나머지 절반이다. 기본값 `0`은 "확인된 책이 없는
 * 모집단"이라는 뜻이고 거짓말이 아니다 — 그 경우 분모는 분자와 같아진다.
 *
 * 입력을 변형하지 않고 외부를 건드리지 않는다.
 */
export function measureUnidentified(
  entries: readonly MeasuredUnidentified[],
  identifiedCount = 0,
): UnidentifiedMeasurement {
  const byMeasurement = emptyByMeasurement();
  const seen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.mergeKey)) continue;
    seen.add(entry.mergeKey);
    byMeasurement[entry.measured] += 1;
  }

  let guardrailCount = 0;
  for (const [measured, count] of Object.entries(byMeasurement)) {
    if (COUNTS_TOWARD_GUARDRAIL[measured as MeasurementReason]) guardrailCount += count;
  }

  return {
    guardrailCount,
    guardrailDenominator: identifiedCount + guardrailCount,
    lookupCapped: byMeasurement.lookup_capped,
    byMeasurement,
  };
}

/**
 * 일곱 칸을 전부 `0`으로 연 분해표.
 *
 * 손으로 적어 두면 계측 사유가 늘 때 여기서 컴파일이 깨진다 — 빈 객체에서
 * 시작해 채우면 없는 사유가 `undefined`로 새어 로그에 빈 칸이 생긴다.
 */
function emptyByMeasurement(): Record<MeasurementReason, number> {
  return {
    low_confidence: 0,
    lookup_capped: 0,
    blank_title: 0,
    no_match: 0,
    ambiguous: 0,
    search_failed: 0,
    facts_failed: 0,
  };
}
