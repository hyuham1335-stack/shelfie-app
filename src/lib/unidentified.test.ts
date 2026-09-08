/**
 * 미확인 사유의 두 어휘 — 계측(일곱)과 응답(넷)이 갈린 자리를 잠근다.
 *
 * ## 무엇을 재는가
 * 이 런은 **응답을 한 바이트도 바꾸지 않는다.** 갈라지는 것은 이벤트 로그의
 * 계측뿐이다. 그래서 여기서 재야 하는 것이 넷이다.
 * 1. 계측 어휘가 응답 어휘로 접힐 때 **응답 쪽에 새 값이 생기지 않는가**
 *    (`RESPONSE_REASON`의 상이 정확히 응답 사유 넷과 같은가 — 전사성)
 * 2. `judge`가 낸 응답 사유를 계측으로 올렸다가 다시 접으면 **제자리로
 *    돌아오는가** (왕복 항등식)
 * 3. 그 승격이 **`judge`의 실제 출력과 맞는가** (AC-6). 2번만으로는 부족하다 —
 *    왕복 항등식은 두 상수만의 성질이라 `match.ts`의 판정 순서가 뒤집혀도
 *    그대로 성립한다. 상수끼리 아귀가 맞는 것과 상수가 현실과 맞는 것은 다르다.
 * 4. 가드레일의 **분자와 분모가 같은 모집단을 세는가**
 *
 * ## 왜 목록을 테스트에 다시 적지 않는가
 * 응답 사유 넷의 정본은 `unidentifiedReasonSchema`다. 여기 다시 적으면 스키마가
 * 바뀐 날 이 파일만 옛 목록을 들고 초록불을 내며, 그것은 검증이 아니라 복창이다.
 * 계측 사유 일곱은 `RESPONSE_REASON`의 키가 정본이다(`Record`가 컴파일로 강제).
 *
 * ## 분모가 왜 분자와 같은 모집단이어야 하는가 (05 델타 ①)
 * 옛 분모는 "확인 + 미확인 전부"였다. 분자에서 뺀 셋(`lookup_capped`·
 * `search_failed`·`facts_failed`)이 분모에는 남아 비율을 희석했고, 그래서
 * **알라딘이 통째로 죽은 세션이 0%로 가장 좋은 성적**을 냈다. 조회하지 않았거나
 * 하지 못한 책은 프롬프트 품질을 판정할 근거가 없으므로 모집단 밖이다.
 */
import { describe, expect, it } from "vitest";

import {
  MEASURED_FROM_VERDICT,
  RESPONSE_REASON,
  measureUnidentified,
  type MeasurementReason,
} from "./unidentified";
import { judge, type LookupOutcome } from "./match";
import { unidentifiedReasonSchema } from "./schemas";
import type {
  AladinCandidate,
  ExtractedCandidate,
  UnidentifiedBook,
  UnidentifiedReason,
} from "@/types/book";

/** 응답 사유 넷 — 정본은 스키마다 */
const 응답사유들: readonly UnidentifiedReason[] = unidentifiedReasonSchema.options;

/** 계측 사유 일곱 — 정본은 접힘 매핑의 키다 */
const 계측사유들 = Object.keys(RESPONSE_REASON) as MeasurementReason[];

/**
 * 가드레일 **분자**에 드는 계측 사유. 계약이 권위 있게 정한 넷이다.
 *
 * 아래 "일곱이 빠짐없이 갈린다" 테스트가 이 둘의 합집합이 계측 사유 전체와 같은지를
 * 검사하므로, 나중에 여덟 번째 계측 사유가 생기면 **어느 쪽에 넣을지 정하기 전까지**
 * 반드시 빨간불이 난다. 조용히 분자에 딸려 들어가거나 조용히 빠지는 길을 막는다.
 */
const 분자에_드는_계측사유: readonly MeasurementReason[] = [
  "low_confidence",
  "blank_title",
  "no_match",
  "ambiguous",
];

/** 가드레일 분자에서 **빠지는** 셋. 상한(우리 결정)과 장애(시스템 문제)는 품질이 아니다 */
const 분자에서_빠지는_계측사유: readonly MeasurementReason[] = [
  "lookup_capped",
  "search_failed",
  "facts_failed",
];

/** 일곱 칸 분해의 기대값. 적지 않은 칸은 0이다 */
function 계측분해(
  overrides: Partial<Record<MeasurementReason, number>> = {},
): Record<MeasurementReason, number> {
  const 영 = Object.fromEntries(계측사유들.map((measured) => [measured, 0])) as Record<
    MeasurementReason,
    number
  >;
  return { ...영, ...overrides };
}

/**
 * 계측 쌍 하나. 응답 사유를 손으로 적지 않고 **접힘 매핑에서 유도한다** —
 * `route.ts`가 지켜야 하는 규칙("응답 `reason`은 `RESPONSE_REASON[measured]`로
 * 유도한다")을 픽스처가 먼저 지킨다.
 *
 * `mergeKey`는 기본으로 **서로 다른 값**을 준다. 접힘을 보려는 테스트만 같은 키를
 * 명시하게 해서, 접힘이 의도한 자리에서만 일어나는지 눈으로 읽히게 한다.
 */
let 쌍_일련번호 = 0;

function 쌍(
  measured: MeasurementReason,
  mergeKey = `키-${(쌍_일련번호 += 1)}`,
): { book: UnidentifiedBook; measured: MeasurementReason; mergeKey: string | null } {
  return {
    book: { rawText: `원문 ${mergeKey}`, reason: RESPONSE_REASON[measured], candidates: [] },
    measured,
    mergeKey,
  };
}

/**
 * 제목을 정규화하면 비어 **접힘의 축이 없는** 항목. `mergeKey`가 `null`이다.
 *
 * 원문을 서로 다르게 받는 것이 요점이다 — 이것들이 실제로 다른 판독본임을
 * 픽스처가 먼저 보여야 "빈 키 여럿이 하나로 접히지 않는다"는 단언이 공허하지
 * 않다. 제목을 못 읽었는데 저자가 같다는 것은 "같은 저자의 어떤 책"이지 "같은
 * 책"이 아니므로, 축이 없는 후보는 접지 않는다 (`lib/merge.ts`).
 *
 * `measured`를 인자로 여는 이유: `null` 가드는 `measured`를 **보지 않으므로**
 * 빈 키 비접힘은 `blank_title` 한 칸이 아니라 일곱 칸 전부에서 일어난다.
 * 픽스처가 사유를 `blank_title`로 못 박아 두면 그중 분자에 드는 칸이 접히는
 * 회귀를 이 파일이 통째로 놓친다.
 *
 * 이 함수를 `.map(빈키쌍)`으로 바로 넘기지 말 것 — `Array.prototype.map`이
 * 둘째 인자로 **인덱스**를 넘겨 사유가 숫자로 오염된다. 호출부는 화살표로 감싼다.
 */
function 빈키쌍(
  rawText: string,
  measured: MeasurementReason = "blank_title",
): {
  book: UnidentifiedBook;
  measured: MeasurementReason;
  mergeKey: string | null;
} {
  return {
    book: { rawText, reason: RESPONSE_REASON[measured], candidates: [] },
    measured,
    mergeKey: null,
  };
}

/**
 * `measureUnidentified`의 둘째 인자. 숫자 하나에서 **확인 키 집합과 책 수 둘**이 됐다.
 *
 * 두 값을 하나로 뭉치지 않는 이유가 이 런의 핵심이다. 키 집합은 **분자에서 빼는
 * 데만** 쓰고 분모의 확인 쪽은 `count`를 쓴다 — `dedupeByIsbn`이 버린 쪽 키까지
 * 차감하려면 키가 책보다 많아야 하는데(같은 ISBN에 후보 키 둘), 그 키 수를
 * 분모에도 쓰면 확인된 책 하나가 분모를 둘 올려 비율이 조용히 낮아진다.
 */
function 확인쪽(
  count: number,
  keys: readonly string[] = [],
): { keys: ReadonlySet<string>; count: number } {
  return { keys: new Set(keys), count };
}

/* ------------------------------------------------------------------ *
 * judge 픽스처 — AC-6
 * ------------------------------------------------------------------ */

function 후보(title: string, author: string | null = null): ExtractedCandidate {
  return { rawText: title, title, author, confidence: 0.9, photoIndex: 0 };
}

function 알라딘후보(isbn13: string, title: string): AladinCandidate {
  return {
    isbn13,
    title,
    author: "한강 (지은이)",
    publisher: "창비",
    coverUrl: `https://image.aladin.co.kr/cover/${isbn13}.jpg`,
  };
}

/**
 * `judge`를 태워 미확인 사유를 얻는다. 확인으로 승격되면 **던진다** —
 * 조용히 건너뛰면 그것이 초록불로 기록되고, 판정 순서가 바뀐 사실이 묻힌다.
 */
function 판정된_사유(extracted: ExtractedCandidate, lookup: LookupOutcome): UnidentifiedReason {
  const verdict = judge(extracted, lookup);
  if (verdict.kind !== "unidentified") {
    throw new Error(`미확인을 기대했는데 확인으로 승격됐습니다: ${verdict.candidate.isbn13}`);
  }
  return verdict.reason;
}

describe("RESPONSE_REASON — 계측 사유를 응답 사유로 접는다 (응답 어휘의 단일 출처)", () => {
  it("상이 응답 사유 넷과 정확히 같다 — 전사이고, 넷 밖의 값은 만들어지지 않는다", () => {
    const 상 = [...new Set(Object.values(RESPONSE_REASON))].sort();

    // `toEqual`이지 `arrayContaining`이 아니다. 한쪽만 검사하면 응답에 다섯 번째
    // 사유가 새로 생겨도, 넷 중 하나가 아무도 도달할 수 없게 되어도 통과한다.
    expect(상).toEqual([...응답사유들].sort());
  });

  it("응답 사유 전부가 실제로 스키마를 통과한다 — 화면 매핑이 못 읽는 값이 없다", () => {
    for (const measured of 계측사유들) {
      expect(unidentifiedReasonSchema.safeParse(RESPONSE_REASON[measured]).success).toBe(true);
    }
  });

  it("접힘은 여러 계측 사유를 한 응답 사유로 모은다 — 그래서 응답만 보고는 되돌릴 수 없다", () => {
    const 접힌_그룹 = 응답사유들.map(
      (응답) => 계측사유들.filter((measured) => RESPONSE_REASON[measured] === 응답).length,
    );

    // 한 응답 사유 뒤에 계측 사유가 둘 이상 있다는 것이 이 런의 전제다. 전부 1:1이면
    // 어휘를 가를 이유가 없었다는 뜻이고, 가드레일 분자를 응답으로 세도 됐다는 뜻이다.
    expect(Math.max(...접힌_그룹)).toBeGreaterThan(1);
    // 도달 불가능한 응답 사유는 없다.
    expect(Math.min(...접힌_그룹)).toBeGreaterThan(0);
  });
});

describe("MEASURED_FROM_VERDICT — judge의 응답 사유를 계측으로 승격시킨다", () => {
  it("정의역이 judge의 출력 넷과 정확히 같다", () => {
    expect(Object.keys(MEASURED_FROM_VERDICT).sort()).toEqual([...응답사유들].sort());
  });

  it("왕복 항등식이 응답 사유 넷 전부에서 성립한다 — 올렸다 접으면 제자리다", () => {
    for (const 응답 of 응답사유들) {
      expect(RESPONSE_REASON[MEASURED_FROM_VERDICT[응답]]).toBe(응답);
    }
  });

  it("승격 결과는 전부 계측 어휘 안의 값이다", () => {
    for (const 응답 of 응답사유들) {
      expect(계측사유들).toContain(MEASURED_FROM_VERDICT[응답]);
    }
  });

  it("RESPONSE_REASON의 역함수가 아니다 — 어떤 verdict도 낼 수 없는 계측 사유가 남는다", () => {
    const 승격으로_도달가능 = new Set(Object.values(MEASURED_FROM_VERDICT));
    const 도달불가 = 계측사유들.filter((measured) => !승격으로_도달가능.has(measured));

    // 역함수라면 이 목록이 비어야 한다. 비지 않는 것이 의도다 — 아래 둘은 judge가
    // 아니라 **라우트가 바구니 이름으로 직접 배정**하는 사유이고, 그래서 judge의
    // 출력만 보고 계측을 복원하려는 시도는 반드시 이 둘을 놓친다.
    expect(도달불가).toContain("lookup_capped");
    expect(도달불가).toContain("low_confidence");
  });
});

/* ------------------------------------------------------------------ *
 * AC-6 — 상수끼리가 아니라 judge와 맞는지 본다
 * ------------------------------------------------------------------ */

describe("judge를 실제로 태운 승격 (AC-6 — 왕복 항등식만으로는 못 잡는 것)", () => {
  /**
   * 왕복 항등식은 `RESPONSE_REASON`과 `MEASURED_FROM_VERDICT` 둘만의 성질이다.
   * `match.ts`가 빈 제목을 `no_match`로 판정하도록 바뀌어도 그 항등식은 그대로
   * 성립하고, 그러면 판독 실패가 "알라딘에 없는 책"으로 계측된다 — 프롬프트를
   * 고쳐야 할 신호가 도서 DB 탓으로 기록되는 것이다. 그래서 여기서 실제 판정을
   * 태운다.
   */
  it("빈 제목 후보는 blank_title로 승격된다 — 판정 순서가 바뀌면 여기서 깨진다", () => {
    // 정규화가 글자와 숫자만 남기므로 기호뿐인 제목은 빈 문자열이 된다.
    const 사유 = 판정된_사유(후보("···"), { status: "ok", candidates: [] });

    expect(사유).toBe("unreadable");
    expect(MEASURED_FROM_VERDICT[사유]).toBe("blank_title");
  });

  it("조회 실패는 search_failed로 승격된다 — 응답을 확보하지 못한 모든 경우가 여기다", () => {
    // `{ status: "failed" }`는 5xx·타임아웃만이 아니라 **브레이커 개방·대조 예산
    // 소진처럼 HTTP를 걸지도 못한 경우**를 포함한다 (services/aladin.ts 규약).
    // 그래서 이 계측 사유를 "ItemSearch가 죽었다"로 읽으면 거짓이 된다.
    const 사유 = 판정된_사유(후보("소년이 온다"), { status: "failed" });

    expect(사유).toBe("lookup_failed");
    expect(MEASURED_FROM_VERDICT[사유]).toBe("search_failed");
  });

  it("알라딘에 없는 책은 no_match로 승격된다", () => {
    const 사유 = 판정된_사유(후보("존재하지 않는 책"), { status: "ok", candidates: [] });

    expect(사유).toBe("no_match");
    expect(MEASURED_FROM_VERDICT[사유]).toBe("no_match");
  });

  it("후보가 둘이라 좁히지 못하면 ambiguous로 승격된다", () => {
    const 사유 = 판정된_사유(후보("데미안"), {
      status: "ok",
      candidates: [알라딘후보("9788900000090", "데미안"), 알라딘후보("9788900000091", "데미안")],
    });

    expect(사유).toBe("ambiguous");
    expect(MEASURED_FROM_VERDICT[사유]).toBe("ambiguous");
  });

  it("judge의 출력 넷이 전부 승격표를 통과한다 — 표에 도달하지 않는 칸이 없다", () => {
    const 실제로_나온_사유 = new Set<UnidentifiedReason>([
      판정된_사유(후보("···"), { status: "ok", candidates: [] }),
      판정된_사유(후보("소년이 온다"), { status: "failed" }),
      판정된_사유(후보("존재하지 않는 책"), { status: "ok", candidates: [] }),
      판정된_사유(후보("데미안"), {
        status: "ok",
        candidates: [알라딘후보("9788900000090", "데미안"), 알라딘후보("9788900000091", "데미안")],
      }),
    ]);

    // 승격표의 정의역이 judge의 실제 출력과 같다는 것을 값으로 확인한다.
    expect([...실제로_나온_사유].sort()).toEqual(Object.keys(MEASURED_FROM_VERDICT).sort());
  });
});

describe("measureUnidentified — 가드레일 분자·분모와 사유별 분해를 센다", () => {
  it("계측 사유 일곱이 분자에 드는 넷과 빠지는 셋으로 빠짐없이 갈린다", () => {
    const 갈린_전체 = [...분자에_드는_계측사유, ...분자에서_빠지는_계측사유].sort();

    // 여덟 번째 계측 사유가 생기면 여기서 먼저 깨진다 — 어느 쪽인지 정하지 않은 채
    // 분자에 딸려 들어가거나 소리 없이 빠지는 길을 막는다.
    expect(갈린_전체).toEqual([...계측사유들].sort());
  });

  it("빈 입력이면 분자·상한 강등이 0이고 분해 일곱 칸이 전부 0이다", () => {
    expect(measureUnidentified([], 확인쪽(0))).toEqual({
      guardrailCount: 0,
      guardrailDenominator: 0,
      lookupCapped: 0,
      byMeasurement: 계측분해(),
    });
  });

  it("미확인이 없으면 분모가 확인된 책 수 그대로다", () => {
    expect(measureUnidentified([], 확인쪽(12))).toMatchObject({
      guardrailCount: 0,
      guardrailDenominator: 12,
    });
  });

  it("lookup_capped만 있으면 분자가 0이고 **분모도 확인된 책 수와 같다**", () => {
    const 밀린것 = [쌍("lookup_capped"), 쌍("lookup_capped"), 쌍("lookup_capped")];

    // 상한에 밀린 책은 분자에서만 빠지는 것이 아니라 **분모에서도 빠진다.**
    // 분모에만 남기면 비율이 희석돼, 사진을 많이 올릴수록 성적이 좋아진다.
    expect(measureUnidentified(밀린것, 확인쪽(20))).toEqual({
      guardrailCount: 0,
      guardrailDenominator: 20,
      lookupCapped: 3,
      byMeasurement: 계측분해({ lookup_capped: 3 }),
    });
  });

  it("분자에 드는 넷은 하나씩 넣으면 각각 분자와 분모를 함께 1 올린다", () => {
    for (const measured of 분자에_드는_계측사유) {
      expect(measureUnidentified([쌍(measured)], 확인쪽(9))).toMatchObject({
        guardrailCount: 1,
        // 분자에 들어간 항목은 반드시 분모에도 들어간다. 한쪽만 오르면 비율이
        // 1을 넘거나 영원히 0에 붙는다.
        guardrailDenominator: 10,
      });
    }
  });

  it("빠지는 셋은 하나씩 넣어도 분자도 분모도 움직이지 않는다", () => {
    for (const measured of 분자에서_빠지는_계측사유) {
      expect(measureUnidentified([쌍(measured)], 확인쪽(9))).toMatchObject({
        guardrailCount: 0,
        guardrailDenominator: 9,
        lookupCapped: measured === "lookup_capped" ? 1 : 0,
      });
    }
  });

  it("계측 사유 일곱이 한 번씩 섞이면 분자 4 · 분모는 확인 + 4 · 분해는 일곱 칸 1씩이다", () => {
    const 전부 = 계측사유들.map((measured) => 쌍(measured));

    expect(measureUnidentified(전부, 확인쪽(30))).toEqual({
      guardrailCount: 분자에_드는_계측사유.length,
      guardrailDenominator: 30 + 분자에_드는_계측사유.length,
      lookupCapped: 1,
      byMeasurement: 계측분해(
        Object.fromEntries(계측사유들.map((measured) => [measured, 1])) as Partial<
          Record<MeasurementReason, number>
        >,
      ),
    });
  });

  it("분해 일곱 칸의 합이 (접은) 미확인 총수와 맞는다", () => {
    const 입력 = [
      쌍("no_match"),
      쌍("no_match"),
      쌍("lookup_capped"),
      쌍("facts_failed"),
      쌍("blank_title"),
    ];

    const { byMeasurement } = measureUnidentified(입력, 확인쪽(4));
    const 합 = Object.values(byMeasurement).reduce((sum, n) => sum + n, 0);

    // mergeKey가 전부 다르므로 접힘이 없다 — 합이 곧 입력 건수다.
    expect(합).toBe(입력.length);
    expect(Object.keys(byMeasurement).sort()).toEqual([...계측사유들].sort());
  });

  it("같은 사유가 여러 번 나오면 그만큼 센다 — 집합이 아니라 개수다", () => {
    const 입력 = [
      쌍("no_match"),
      쌍("no_match"),
      쌍("no_match"),
      쌍("lookup_capped"),
      쌍("lookup_capped"),
    ];

    expect(measureUnidentified(입력, 확인쪽(0))).toMatchObject({
      guardrailCount: 3,
      guardrailDenominator: 3,
      lookupCapped: 2,
    });
  });

  /* --- 중복 접기 (05 델타 ②) --------------------------------------- */

  it("같은 mergeKey를 가진 저확신 항목 다섯이면 분자에 1만 더한다", () => {
    const 같은_책 = Array.from({ length: 5 }, () => 쌍("low_confidence", "82년생김지영\u0000조남주"));

    // 같은 책이 다섯 장에 흐릿하게 찍혔다. 이것을 5로 세면, 또렷하게 읽혀 분모에
    // 1만 더하는 같은 책과 **단위가 달라진다** — 사진을 여러 장 올릴수록 판독
    // 품질이 나빠 보이는 오독이고, 이 런이 막겠다고 선언한 것과 같은 방향이다.
    expect(measureUnidentified(같은_책, 확인쪽(0))).toEqual({
      guardrailCount: 1,
      guardrailDenominator: 1,
      lookupCapped: 0,
      byMeasurement: 계측분해({ low_confidence: 1 }),
    });
  });

  it("mergeKey가 다르면 접지 않는다 — 접힘은 같은 책에만 걸린다", () => {
    const 서로_다른_책 = [
      쌍("low_confidence", "가\u0000"),
      쌍("low_confidence", "나\u0000"),
      쌍("low_confidence", "다\u0000"),
    ];

    expect(measureUnidentified(서로_다른_책, 확인쪽(0))).toMatchObject({
      guardrailCount: 3,
      byMeasurement: 계측분해({ low_confidence: 3 }),
    });
  });

  it("상한에 밀린 같은 책도 접어 센다 — 분자 밖이어도 단위는 같아야 한다", () => {
    const 밀린_같은_책 = Array.from({ length: 4 }, () => 쌍("lookup_capped", "같은키\u0000저자"));

    expect(measureUnidentified(밀린_같은_책, 확인쪽(0))).toMatchObject({
      guardrailCount: 0,
      lookupCapped: 1,
      byMeasurement: 계측분해({ lookup_capped: 1 }),
    });
  });

  /* --- 분모의 존재 이유 (05 델타 ①) -------------------------------- */

  it("알라딘 전면 장애 세션은 분모가 0이라 비율을 내지 않는다 — 0%가 아니다", () => {
    // 리뷰어가 든 반례를 그대로 옮긴 것이다. 옛 분모(확인 + 미확인 전부)로 세면
    // 분자 0 / 분모 8 = 0% 로 **가장 좋은 성적**이 나왔다. 조회 응답을 하나도
    // 확보하지 못한 세션은 프롬프트 품질을 판정할 근거가 없으므로, 좋은 성적을
    // 받는 것이 아니라 **모집단에서 빠져야** 한다.
    const 장애 = Array.from({ length: 8 }, () => 쌍("search_failed"));
    const 결과 = measureUnidentified(장애, 확인쪽(0));

    expect(결과.guardrailCount).toBe(0);
    expect(결과.guardrailDenominator).toBe(0);
    // 0/0은 비율이 아니다. 옛 분모였다면 8이 되어 0%가 계산됐다.
    expect(Number.isNaN(결과.guardrailCount / 결과.guardrailDenominator)).toBe(true);
  });

  it("조회 못 한 책이 분모를 희석하지 않는다 — 판정 실패율이 그대로 드러난다", () => {
    // 판정을 실제로 한 것은 확인 2건 + no_match 2건뿐이고, 나머지 여섯은 조회
    // 상한과 장애로 판정 자체가 없었다. 실패율은 2/4 = 50%이지 2/10 = 20%가 아니다.
    const 입력 = [
      쌍("no_match"),
      쌍("no_match"),
      ...Array.from({ length: 5 }, () => 쌍("lookup_capped")),
      쌍("facts_failed"),
    ];

    const { guardrailCount, guardrailDenominator } = measureUnidentified(입력, 확인쪽(2));

    expect(guardrailCount).toBe(2);
    expect(guardrailDenominator).toBe(4);
    expect(guardrailCount / guardrailDenominator).toBe(0.5);
  });

  it("분자는 언제나 분모 이하다 — 분자에 든 항목이 분모에도 있기 때문이다", () => {
    const 입력 = 계측사유들.flatMap((measured) => [쌍(measured), 쌍(measured)]);

    for (const 확인된_책_수 of [0, 1, 50]) {
      const { guardrailCount, guardrailDenominator } = measureUnidentified(
        입력,
        확인쪽(확인된_책_수),
      );
      expect(guardrailCount).toBeLessThanOrEqual(guardrailDenominator);
      expect(guardrailDenominator - guardrailCount).toBe(확인된_책_수);
    }
  });

  /* --- 빈 키는 접힘의 축이 없다 (② 접힘 규칙 재설계) ---------------- */

  it("제목이 빈 서로 다른 항목 셋이 분자에 셋으로 든다 — 하나로 접히지 않는다", () => {
    // 셋 이상이어야 한다. 둘이면 "구현이 첫 항목만 세는 실수"와 "두 번째만 세는
    // 실수"를 가르지 못한 채 1이라는 같은 답이 나오는 조합이 있다.
    // 화살표로 감싸는 이유는 `빈키쌍` 주석에 있다 — `map`의 인덱스가 사유 자리로 샌다.
    const 빈키들 = ["!!!", "···", "???"].map((rawText) => 빈키쌍(rawText));

    expect(measureUnidentified(빈키들, 확인쪽(0))).toEqual({
      guardrailCount: 3,
      guardrailDenominator: 3,
      lookupCapped: 0,
      byMeasurement: 계측분해({ blank_title: 3 }),
    });
  });

  it("미확인 쪽 키가 null이면 차감 검사를 건너뛴다 — 확인된 책과도 접히지 않는다", () => {
    // 키가 없다는 것은 "같은 책인지 판단할 축이 없다"는 뜻이지 "아무 책과도 같다"가
    // 아니다. `seen`을 먼저 물으면 `null`이 한 번 들어간 뒤 나머지 빈 키 전부가
    // 이미 본 것으로 취급돼, 서로 다른 판독본 셋이 화면에는 셋인데 지표에는 하나로
    // 남는다 — 응답과 계측이 다른 이야기를 하는 상태다.
    // 화살표로 감싸는 이유는 `빈키쌍` 주석에 있다 — `map`의 인덱스가 사유 자리로 샌다.
    const 빈키들 = ["!!!", "···", "???"].map((rawText) => 빈키쌍(rawText));

    const 결과 = measureUnidentified(빈키들, 확인쪽(2, ["키A", "키B"]));

    expect(결과.byMeasurement.blank_title).toBe(3);
    expect(결과.guardrailCount).toBe(3);
    expect(결과.guardrailDenominator).toBe(2 + 3);
  });

  it("키가 null인 저확신 항목 셋도 접히지 않는다 — 빈 키 비접힘은 blank_title 한 칸의 일이 아니다", () => {
    // 이 검사가 위의 `blank_title` 검사와 별개로 있어야 하는 이유: `null` 가드는
    // `entry.measured`를 보지 않으므로 빈 키 비접힘은 **일곱 칸 전부**에서 일어난다.
    // 그리고 실제로 가장 크게 움직이는 칸은 `blank_title`이 아니라 `low_confidence`다 —
    // `reduceBeforeLookup`이 확신도 하한을 **먼저** 가르기 때문에, 확신도가 낮으면서
    // 제목도 빈 후보는 `blankTitle`이 아니라 저확신 바구니로 가고 라우트가 그것을
    // `low_confidence`로 강등하며 그 항목의 `mergeKey`는 `null`이다.
    //
    // `low_confidence`는 `COUNTS_TOWARD_GUARDRAIL`이 `true`인 칸이라, 이 경로가
    // 되돌아가면 분해표 한 칸이 아니라 **분자와 분모가 함께** 접혀 비율 자체가
    // 거짓이 된다. 그래서 셋을 다 문다.
    //
    // 셋 이상인 이유도 위와 같다 — 둘이면 "첫 항목만 센다"와 "두 번째만 센다"가
    // 같은 답(1)을 내는 조합이 있어 갈리지 않는다.
    const 빈키_저확신 = ["!!!", "···", "???"].map((rawText) => 빈키쌍(rawText, "low_confidence"));

    expect(measureUnidentified(빈키_저확신, 확인쪽(0))).toEqual({
      guardrailCount: 3,
      guardrailDenominator: 3,
      lookupCapped: 0,
      byMeasurement: 계측분해({ low_confidence: 3 }),
    });

    // 확인된 책이 있는 세션에서도 셋이 그대로 분자에 들고, 분모가 그만큼 함께 오른다.
    // 접히면 분자와 분모가 같이 2씩 내려가 비율이 조용히 좋아 보인다.
    const 확인_있는_세션 = measureUnidentified(빈키_저확신, 확인쪽(2, ["키A", "키B"]));

    expect(확인_있는_세션.byMeasurement.low_confidence).toBe(3);
    expect(확인_있는_세션.guardrailCount).toBe(3);
    expect(확인_있는_세션.guardrailDenominator).toBe(2 + 3);
  });

  /* --- 확인된 책과 겹치는 키는 차감한다 (① 회계) -------------------- */

  it("같은 키가 확인·미확인 양쪽에 있으면 분자에서 빠진다 — 그 책은 이미 분모에 있다", () => {
    // 흐릿하게 한 번, 또렷하게 한 번 읽힌 같은 책이다. 또렷한 쪽이 확인으로
    // 올라가 분모에 1을 더했는데 흐릿한 쪽이 분자에도 1을 더하면, 한 권이 성공과
    // 실패로 동시에 세어져 비율이 사진 장수를 따라 움직인다.
    const 결과 = measureUnidentified(
      [쌍("low_confidence", "소년이온다-한강")],
      확인쪽(1, ["소년이온다-한강"]),
    );

    expect(결과.guardrailCount).toBe(0);
    expect(결과.byMeasurement.low_confidence).toBe(0);
    expect(결과.guardrailDenominator).toBe(1);
  });

  it("dedupe가 버린 쪽 키를 가진 판독본도 차감된다 — 키는 둘, 책은 하나다", () => {
    // 저자를 읽어낸 판독본과 못 읽은 판독본은 병합 키가 갈리지만 알라딘이 같은
    // ISBN을 돌려주면 `dedupeByIsbn`이 한 권으로 접는다. 확인 키를 dedupe **뒤**의
    // 목록에서 모으면 버려진 쪽 키가 집합에 없어, 같은 책의 흐릿한 판독본이
    // 차감되지 않고 분자에 남는다.
    const 대표키 = "소년이온다-한강";
    const 버려진키 = "소년이온다-저자없음";

    const 결과 = measureUnidentified([쌍("no_match", 버려진키)], 확인쪽(1, [대표키, 버려진키]));

    expect(결과.guardrailCount).toBe(0);
    expect(결과.byMeasurement.no_match).toBe(0);
    // 분모의 확인 쪽은 **책 수(1)**다. 키 개수(2)를 쓰면 2가 되어 여기서 깨진다.
    expect(결과.guardrailDenominator).toBe(1);
  });

  it("분모의 확인 쪽은 키 개수가 아니라 책 수를 따른다", () => {
    // 키 셋이 한 권을 가리키는 경우다. 집합 크기를 분모에 쓰면 확인된 책이
    // 부풀어 미확인 비율이 실제보다 좋아 보인다.
    const 결과 = measureUnidentified([쌍("no_match", "겹치지않는키")], 확인쪽(1, ["가", "나", "다"]));

    expect(결과.guardrailCount).toBe(1);
    expect(결과.guardrailDenominator).toBe(1 + 1);
  });

  it("차감은 일곱 칸 전부에 균일하다 — lookup_capped도 확인된 책과 겹치면 줄어든다", () => {
    // 이 성질을 무는 검사가 여기 하나뿐이다. `lookup_capped`는 분자 밖이라
    // 차감해도 비율이 안 움직이고, 그래서 예외를 두고 싶어지는 자리다. 예외를
    // 두면 차감 규칙이 둘이 되고 어느 칸이 어느 규칙을 따르는지 로그만 보고는 알
    // 수 없게 된다 — 사람이 알고 고른 균일 동작이다.
    const 결과 = measureUnidentified(
      [쌍("lookup_capped", "겹치는키"), 쌍("lookup_capped", "안겹치는키")],
      확인쪽(1, ["겹치는키"]),
    );

    expect(결과.byMeasurement.lookup_capped).toBe(1);
    // 상한 강등 수는 분해표의 그 칸에서 그대로 읽어 온다 — 따로 세면 두 수가 갈린다.
    expect(결과.lookupCapped).toBe(1);
    expect(결과.guardrailCount).toBe(0);
    expect(결과.guardrailDenominator).toBe(1);
  });

  it("입력 배열과 원소를 변형하지 않는다 (부수효과 없음)", () => {
    const 원본 = 계측사유들.map((measured) => 쌍(measured));
    const 스냅샷 = structuredClone(원본);
    // 확인 키 집합도 호출자의 것이다. 루프가 여기에 직접 넣으면 호출부가 나중에
    // 같은 집합을 다시 쓰는 날 미확인 키가 확인 키인 척하게 된다.
    const 확인키 = new Set(["키A", "키B"]);

    measureUnidentified(원본, { keys: 확인키, count: 3 });

    expect(원본).toEqual(스냅샷);
    expect([...확인키]).toEqual(["키A", "키B"]);
  });
});
