import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_FLOOR,
  capIdentified,
  capUnidentified,
  dedupeByIsbn,
  mergeKey,
  reduceBeforeLookup,
} from "./merge";
import {
  ALADIN_CALLS_PER_LOOKUP,
  MAX_ALADIN_CALLS_PER_SESSION,
  MAX_CANDIDATES_FOR_LOOKUP,
  MAX_IDENTIFIED_BOOKS,
  MAX_UNIDENTIFIED_BOOKS,
  MAX_PHOTOS,
} from "./env";
import type { ExtractedCandidate } from "@/types/book";

function 추출(
  overrides: Partial<ExtractedCandidate> & Pick<ExtractedCandidate, "title">,
): ExtractedCandidate {
  return {
    rawText: overrides.title,
    author: null,
    confidence: 0.9,
    photoIndex: 0,
    ...overrides,
  };
}

/** 13자리 ISBN을 인덱스로 만든다. 앞 7자리 고정 + 6자리 일련번호 */
function isbn(n: number): string {
  return `9788936${String(n).padStart(6, "0")}`;
}

type 확인된책 = { isbn13: string; aladinRating: number | null; photoIndex: number };

function 확인(overrides: Partial<확인된책> & { isbn13: string }): 확인된책 {
  return { aladinRating: null, photoIndex: 0, ...overrides };
}

/**
 * `toLookup`·`capped`의 원소 모양.
 *
 * `merge.ts`의 `KeyedCandidate`는 **내보내지 않는다** — 내부 타입을 검사가
 * import하면 그 이름이 계약이 되어 다음 리팩터링을 막는다. 반환 타입에 구조적으로
 * 나타나므로 여기서는 이름 없이 같은 모양을 적어 쓴다.
 */
type 키달린후보 = { candidate: ExtractedCandidate; key: string };

/** 키 달린 바구니에서 후보만 꺼낸다. 네 바구니를 나란히 세는 자리에서 쓴다 */
function 후보만(keyed: readonly 키달린후보[]): ExtractedCandidate[] {
  return keyed.map((entry) => entry.candidate);
}

/**
 * 정규화하면 제목이 통째로 사라지는 원문들.
 *
 * `match.ts`의 정규화가 글자와 숫자만 남기므로 기호뿐인 제목은 빈 문자열이 된다.
 * 서로 **다른 문자열**인 것이 요점이다 — 같은 키로 접히면 안 되는 후보들이
 * 실제로 서로 다른 판독본임을 픽스처가 먼저 보여야 한다.
 */
const 기호뿐인_제목 = ["!!!", "···", "???", "———", "@@@"] as const;

/**
 * 세션당 알라딘 호출 상한 — **이 describe는 지우지 않는다.**
 *
 * TRD 10번이 세션당 260회를 적고 있지만, 그 값을 실제로 만드는 것은 산문이 아니라
 * `lib/env.ts`의 상수들이다. 누군가 `MAX_CANDIDATES_FOR_LOOKUP`을 65에서 200으로
 * 올리면 알라딘 일일 한도(5,000회)가 세션 6회에 소진되는데, 그것을 막는 것이
 * 문서뿐이라면 그 상한은 검증되지 않은 상한이다. 그래서 여기서 **선언(상한)과
 * 유도값(현재 구성이 내는 값)의 관계**를 잠근다. 값을 복창하는 테스트가 아니라
 * 관계를 검사하는 테스트이며, 상한을 올려서 이 테스트를 통과시키는 것은 발견을
 * 지우는 일이다 (TRD 8번의 "삭제하지 않는다" 목록과 같은 성격).
 *
 * 유도식은 **실행 경로에서 읽는다.** `route.ts`는 조회 전 축소를 통과한 후보를
 * ItemSearch에 태우고, 그 전량이 승격될 수 있으므로 같은 수가 ItemLookUp에도
 * 실린다 — 두 단계가 같은 수를 태운다. 그래서 항은 `조회 상한 × 2단계`이지
 * `조회 상한 + 표시 상한`이 아니다. 옛 식은 후보 상한 80에서 260을 냈지만 실행
 * 경로는 320을 냈다 — 선언이 통과하는 동안 실제 호출은 상한을 넘고 있었다.
 *
 * 이 런의 방향은 위 경고의 **반대**다. 상한을 올려 식을 통과시킨 것이 아니라
 * 상한을 80에서 65로 **내리고** 식을 실행 경로에 맞췄다. 새 식은 더 세게
 * 깨진다 — 후보 상한 200이면 `200 × 2 × 2 = 800 > 260`이다.
 */
describe("세션당 알라딘 호출 상한 (TRD 10번 — 문서에만 있는 상한은 검증되지 않은 상한이다)", () => {
  it("실행 경로의 유도값이 선언된 상한과 같다 — 검색·조회 두 단계가 같은 수를 태운다", () => {
    // `≤`가 아니라 **동등**이다. 상한 쪽만 올려서 통과시키는 길을 막는다 —
    // `MAX_ALADIN_CALLS_PER_SESSION`을 9999로 올리면 여기서 깨진다.
    const 유도값 = MAX_CANDIDATES_FOR_LOOKUP * 2 * ALADIN_CALLS_PER_LOOKUP;

    expect(유도값).toBe(MAX_ALADIN_CALLS_PER_SESSION);
  });

  it("reduceBeforeLookup이 실제로 그 상한 안에서 자른다 — 후보 300건도 조회는 상한만큼뿐이다", () => {
    const 후보들 = Array.from({ length: 300 }, (_, i) =>
      추출({ title: `서로 다른 책 ${i}`, confidence: 0.3 + (i % 70) / 100, photoIndex: i % MAX_PHOTOS }),
    );

    const { toLookup } = reduceBeforeLookup(후보들);

    expect(toLookup.length).toBeLessThanOrEqual(MAX_CANDIDATES_FOR_LOOKUP);
    // 조회 대상에서 유도한 ItemSearch 호출 수도 상한 안이어야 한다.
    expect(toLookup.length * ALADIN_CALLS_PER_LOOKUP).toBeLessThanOrEqual(
      MAX_ALADIN_CALLS_PER_SESSION,
    );
  });

  it("표시 상한은 조회 상한을 넘지 않는다 — 넘으면 capIdentified의 절단이 죽은 상수가 된다", () => {
    // 유도식에서 `MAX_IDENTIFIED_BOOKS`가 빠졌으므로 이제 이 상수가 잠그는 것은
    // 호출량이 아니라 **뜻**이다. 조회 상한보다 많이 표시하겠다고 선언하면
    // 확인된 책이 표시 상한에 닿는 일이 영원히 없어 `overflowCount`가 언제나
    // 0이 된다 — 발화하지 않는 절단은 있으나 마나 한 절단이다 (FR-005).
    expect(MAX_IDENTIFIED_BOOKS).toBeLessThanOrEqual(MAX_CANDIDATES_FOR_LOOKUP);
  });
});

describe("reduceBeforeLookup — ① 알라딘 조회 전 축소 (FR-012)", () => {
  it("confidence 0.29는 강등되고 0.30은 조회 대상이다 (경계값)", () => {
    const { toLookup, lowConfidence, capped } = reduceBeforeLookup([
      추출({ title: "아슬아슬", confidence: 0.29 }),
      추출({ title: "간신히", confidence: CONFIDENCE_FLOOR }),
    ]);

    // `toLookup`의 원소는 이제 후보와 키를 함께 나른다 — 키를 라우트가 다시
    // 계산하지 않게 하려는 변경이고, 그래서 후보를 한 겹 들어가서 읽는다.
    expect(toLookup.map((c) => c.candidate.title)).toEqual(["간신히"]);
    expect(lowConfidence.map((c) => c.title)).toEqual(["아슬아슬"]);
    // 상한에 밀린 것이 아니다. 두 강등을 한 바구니에 뭉치면 이 구분이 사라진다.
    expect(capped).toEqual([]);
  });

  it("CONFIDENCE_FLOOR는 0.3이다", () => {
    expect(CONFIDENCE_FLOOR).toBe(0.3);
  });

  it("강등된 후보를 조용히 버리지 않는다 — 전량이 세 바구니 중 하나에 남는다", () => {
    // 바구니가 넷이 되면서 이 세 후보가 걸릴 수 있는 곳도 하나 늘었다. 제목이 빈
    // 후보를 세지 않으면 `blankTitle`로 간 판독본이 어느 칸에도 잡히지 않은 채
    // 합이 맞아 버린다 — 조용히 버리지 않는다는 이 테스트의 주장이 거짓이 된다.
    const 입력 = [
      추출({ title: "가", confidence: 0.1 }),
      추출({ title: "나", confidence: 0.5 }),
      추출({ title: "다", confidence: 0.0 }),
      추출({ title: "!!!", confidence: 0.7 }),
    ];

    const { toLookup, lowConfidence, blankTitle, capped } = reduceBeforeLookup(입력);

    expect(toLookup.length + lowConfidence.length + blankTitle.length + capped.length).toBe(
      입력.length,
    );
    expect(blankTitle.map((c) => c.title)).toEqual(["!!!"]);
  });

  it("제목+저자가 정규화 후 같은 후보 3건이 1건으로 병합된다", () => {
    const { toLookup } = reduceBeforeLookup([
      추출({ title: "82년생 김지영", author: "조남주", photoIndex: 1 }),
      추출({ title: "82년생김지영", author: "조남주 (지은이)", photoIndex: 2 }),
      추출({ title: "82년생 김지영!", author: "조남주", photoIndex: 3 }),
    ]);

    expect(toLookup).toHaveLength(1);
  });

  it("병합된 대표는 확신도가 가장 높은 후보이고, photoIndex는 최초 등장 값이다", () => {
    const { toLookup } = reduceBeforeLookup([
      추출({ title: "소년이 온다", rawText: "소년이온ㄷ", confidence: 0.4, photoIndex: 1 }),
      추출({ title: "소년이온다", rawText: "소년이 온다", confidence: 0.95, photoIndex: 3 }),
    ]);

    expect(toLookup).toHaveLength(1);
    expect(toLookup[0].candidate.confidence).toBe(0.95);
    expect(toLookup[0].candidate.rawText).toBe("소년이 온다");
    expect(toLookup[0].candidate.photoIndex).toBe(1);
  });

  it("제목이 같아도 저자가 다르면 병합하지 않는다", () => {
    const { toLookup } = reduceBeforeLookup([
      추출({ title: "채식주의자", author: "한강" }),
      추출({ title: "채식주의자", author: null }),
    ]);

    expect(toLookup).toHaveLength(2);
  });

  it("확신도 미달 후보는 병합 대상에서도 빠진다 — 강등이 먼저다", () => {
    const { toLookup, lowConfidence } = reduceBeforeLookup([
      추출({ title: "파친코", author: "이민진", confidence: 0.2 }),
      추출({ title: "파친코", author: "이민진", confidence: 0.9 }),
    ]);

    expect(toLookup).toHaveLength(1);
    expect(lowConfidence).toHaveLength(1);
    expect(lowConfidence[0].confidence).toBe(0.2);
  });

  it("후보 300건을 넣어도 toLookup이 조회 상한을 넘지 않는다 (TR-005 성공 지표)", () => {
    const 후보들 = Array.from({ length: 300 }, (_, i) =>
      추출({
        title: `서로 다른 책 ${i}`,
        confidence: 0.3 + (i % 70) / 100,
        photoIndex: i % MAX_PHOTOS,
      }),
    );

    const { toLookup } = reduceBeforeLookup(후보들);

    expect(toLookup).toHaveLength(MAX_CANDIDATES_FOR_LOOKUP);
    expect(MAX_CANDIDATES_FOR_LOOKUP).toBe(65);
  });

  it("조회 상한으로 잘린 후보는 버려지지 않고 capped로 남는다", () => {
    const 후보들 = Array.from({ length: 300 }, (_, i) =>
      추출({ title: `책 ${i}`, confidence: 0.5, photoIndex: i % MAX_PHOTOS }),
    );

    const { toLookup, lowConfidence, capped } = reduceBeforeLookup(후보들);

    expect(toLookup.length + lowConfidence.length + capped.length).toBe(300);
    // 전부 하한 위이므로 강등은 오직 상한 때문이다. 이 둘이 한 바구니에 섞이면
    // 조회 상한에 밀린 수를 따로 셀 수 없어져 가드레일 분자가 부풀어 오른다.
    expect(lowConfidence).toEqual([]);
    expect(capped).toHaveLength(300 - MAX_CANDIDATES_FOR_LOOKUP);
  });

  it("조회 대상은 확신도 내림차순으로 남는다", () => {
    const 후보들 = Array.from({ length: 120 }, (_, i) =>
      추출({ title: `책 ${i}`, confidence: i / 200 + 0.3 }),
    );

    const { toLookup } = reduceBeforeLookup(후보들);

    const 최저 = Math.min(...toLookup.map((c) => c.candidate.confidence));
    const 최고강등 = Math.max(
      ...reduceBeforeLookup(후보들).capped.map((c) => c.candidate.confidence),
    );
    expect(최저).toBeGreaterThanOrEqual(최고강등);
  });

  it("입력 순서를 바꿔도 같은 결과를 낸다 (결정성)", () => {
    const 후보들 = Array.from({ length: 200 }, (_, i) =>
      추출({ title: `책 ${i}`, confidence: 0.5, photoIndex: i % MAX_PHOTOS }),
    );
    const 뒤집힌 = [...후보들].reverse();

    const a = reduceBeforeLookup(후보들).toLookup;
    const b = reduceBeforeLookup(뒤집힌).toLookup;

    expect(b).toEqual(a);
  });

  it("입력 배열과 원소를 변형하지 않는다", () => {
    const 원본 = [
      추출({ title: "가", confidence: 0.1 }),
      추출({ title: "가", confidence: 0.9, photoIndex: 2 }),
      추출({ title: "가", confidence: 0.5, photoIndex: 1 }),
    ];
    const 스냅샷 = structuredClone(원본);

    reduceBeforeLookup(원본);

    expect(원본).toEqual(스냅샷);
  });

  it("빈 입력은 빈 결과를 낸다", () => {
    // 바구니가 셋에서 넷이 되었으므로 정확 일치가 하드하게 깨진다. `blankTitle`을
    // 빠뜨린 채 통과하는 형태를 남기지 않으려고 `toEqual`을 그대로 둔다.
    expect(reduceBeforeLookup([])).toEqual({
      toLookup: [],
      lowConfidence: [],
      blankTitle: [],
      capped: [],
    });
  });

  it("네 바구니가 입력을 분할한다 — 각 후보가 정확히 한 바구니에만 든다", () => {
    // 이름과 단언이 함께 움직였다. 제목이 빈 후보가 `blankTitle`로 갈라진 뒤로는
    // "셋이 분할한다"가 거짓이다 — 셋만 세면 빈 제목 판독본이 어디에도 없는데도
    // 합이 맞아, 조용히 사라진 상태가 초록불로 기록된다.
    const 미달 = Array.from({ length: 4 }, (_, i) =>
      추출({ title: `흐릿 ${i}`, confidence: 0.1 }),
    );
    const 빈제목 = 기호뿐인_제목.map((title) => 추출({ title, confidence: 0.8 }));
    const 또렷 = Array.from({ length: MAX_CANDIDATES_FOR_LOOKUP + 6 }, (_, i) =>
      추출({ title: `또렷 ${i}`, confidence: 0.5 + (i % 40) / 100, photoIndex: i % MAX_PHOTOS }),
    );
    const 입력 = [...미달, ...빈제목, ...또렷];

    const { toLookup, lowConfidence, blankTitle, capped } = reduceBeforeLookup(입력);
    const 전체 = [...후보만(toLookup), ...lowConfidence, ...blankTitle, ...후보만(capped)];

    expect(전체).toHaveLength(입력.length);
    // 제목이 전부 달라 사전 병합이 일어나지 않으므로 원소 동일성으로 셀 수 있다.
    // "정확히 하나"를 재는 것이 핵심이다 — 개수만 맞추면 한 후보가 두 바구니에
    // 들어가고 다른 후보가 사라진 상태도 통과한다.
    for (const 후보 of 입력) {
      expect(전체.filter((c) => c === 후보)).toHaveLength(1);
    }

    expect(toLookup).toHaveLength(MAX_CANDIDATES_FOR_LOOKUP);
    expect(lowConfidence).toHaveLength(미달.length);
    expect(blankTitle).toHaveLength(기호뿐인_제목.length);
    expect(capped).toHaveLength(6);
  });

  it("두 강등 바구니는 서로 다른 기전으로 갈린다 — 확신도 하한과 조회 상한", () => {
    const 입력 = [
      ...Array.from({ length: 7 }, (_, i) => 추출({ title: `흐릿 ${i}`, confidence: 0.29 })),
      ...Array.from({ length: MAX_CANDIDATES_FOR_LOOKUP + 3 }, (_, i) =>
        추출({ title: `또렷 ${i}`, confidence: 0.9, photoIndex: i % MAX_PHOTOS }),
      ),
    ];

    const { lowConfidence, capped } = reduceBeforeLookup(입력);

    // 하한 미만은 조회조차 시도되지 않은 판독 실패이고, 상한에 밀린 것은 우리가
    // 스스로 건 제한이다. 둘을 한 이름으로 부르면 후자가 판독 품질로 계상된다.
    expect(lowConfidence.every((c) => c.confidence < CONFIDENCE_FLOOR)).toBe(true);
    expect(capped.every((c) => c.candidate.confidence >= CONFIDENCE_FLOOR)).toBe(true);
    expect(lowConfidence).toHaveLength(7);
    expect(capped).toHaveLength(3);
  });

  /* --- 빈 키를 접지 않는다 (② 접힘 규칙 재설계) --------------------- */

  it("확신도가 충분해도 제목이 빈 후보는 조회 대상이 아니라 blankTitle이다", () => {
    // ②-응답-분기. 알라딘에 던질 질의가 없는 후보를 조회에 태우면 확실한
    // `no_match` 하나를 일일 한도에서 빼 쓰는 것이고, 화면에는 "알라딘에 없는 책"
    // 이라는 사실이 아닌 설명이 남는다.
    const 빈제목 = 기호뿐인_제목.map((title) => 추출({ title, confidence: 0.95 }));

    const { toLookup, blankTitle, lowConfidence, capped } = reduceBeforeLookup(빈제목);

    expect(toLookup).toEqual([]);
    // N=3이 아니라 다섯을 넣는다. 서로 다른 판독본이 **하나로 접히지 않고**
    // 전부 남는지를 보려면 둘로는 "두 번째만 세는 실수"를 가를 수 없다.
    expect(blankTitle).toHaveLength(기호뿐인_제목.length);
    expect(blankTitle.map((c) => c.title)).toEqual([...기호뿐인_제목]);
    // 확신도 하한에 걸린 것도, 조회 상한에 밀린 것도 아니다. 세 기전을 한
    // 바구니에 뭉치면 지표에서 다시 나눌 수 없다.
    expect(lowConfidence).toEqual([]);
    expect(capped).toEqual([]);
  });

  it("확신도를 먼저 가른다 — 확신도도 낮고 제목도 빈 후보는 lowConfidence다", () => {
    const { lowConfidence, blankTitle } = reduceBeforeLookup([
      추출({ title: "!!!", confidence: 0.1 }),
      추출({ title: "???", confidence: 0.9 }),
    ]);

    // 순서를 뒤집으면 저확신 판독이 `blank_title`로 세어져 계측 분해의 시계열이
    // 코드 한 줄로 조용히 끊긴다.
    expect(lowConfidence.map((c) => c.title)).toEqual(["!!!"]);
    expect(blankTitle.map((c) => c.title)).toEqual(["???"]);
  });

  it("빈 제목은 병합에 도달하지 않는다 — 저자가 같아도 서로 접히지 않는다", () => {
    // ②-병합 미도달. 옛 키는 빈 제목 후보 전부를 `"\u0000조남주"` 하나로 만들어
    // 서로 다른 책을 한 그룹으로 접었고, 대표 하나만 남아 나머지는 화면에서
    // 통째로 사라졌다. `mergeByNormalizedKey`는 export되지 않으므로 직접 부르지
    // 않고, 바구니가 갈린 결과로 그 사실을 잰다.
    const 입력 = [
      추출({ title: "!!!", author: "조남주" }),
      추출({ title: "???", author: "조남주" }),
      추출({ title: "82년생 김지영", author: "조남주", photoIndex: 0 }),
      추출({ title: "82년생김지영", author: "조남주 (지은이)", photoIndex: 2 }),
    ];

    const { toLookup, blankTitle } = reduceBeforeLookup(입력);

    // 빈 쪽은 둘 다 남고,
    expect(blankTitle.map((c) => c.title)).toEqual(["!!!", "???"]);
    // 읽히는 쪽만 접힌다.
    expect(toLookup).toHaveLength(1);
    expect(toLookup[0].candidate.title).toBe("82년생 김지영");
    expect(toLookup[0].candidate.photoIndex).toBe(0);
  });

  it("제목이 있는 같은 책은 여전히 접힌다 — 고치면서 접힘 자체를 끄지 않았다", () => {
    // ②-대칭. 빈 제목을 병합에서 빼는 변경이 "아무것도 안 접는다"로 미끄러지면
    // 같은 책이 사진 수만큼 조회돼 알라딘 일일 한도를 그대로 축낸다.
    const { toLookup, blankTitle } = reduceBeforeLookup([
      추출({ title: "소년이 온다", author: "한강", photoIndex: 3 }),
      추출({ title: "소년이온다!", author: "한강 (지은이)", photoIndex: 1 }),
      추출({ title: "《소년이 온다》", author: "한강", photoIndex: 4 }),
    ]);

    expect(toLookup).toHaveLength(1);
    expect(toLookup[0].candidate.photoIndex).toBe(1);
    expect(blankTitle).toEqual([]);
  });

  it("나르는 키가 mergeKey의 계산과 같고, 동점 정렬이 그 키로 결정된다", () => {
    // 키 계산 단일. 축소가 키를 한 번 계산해 들고 다니는 것이 이 변경의 요지이고,
    // 그 키가 `mergeKey`가 지금 내는 값과 갈리면 병합이 접은 책과 계측이 접는
    // 책이 소리 없이 달라진다.
    const 입력 = [
      추출({ title: "C", confidence: 0.5, photoIndex: 2 }),
      추출({ title: "A", confidence: 0.5, photoIndex: 2 }),
      추출({ title: "b", confidence: 0.5, photoIndex: 2 }),
    ];

    const { toLookup } = reduceBeforeLookup(입력);

    for (const 원소 of toLookup) {
      expect(원소.key).toBe(mergeKey(원소.candidate));
    }
    // 확신도도 photoIndex도 동점이라 남은 것은 키 순서뿐이다. 여기서 입력 순서에
    // 기대면 사진 처리 순서가 바뀔 때 조회 대상이 달라진다.
    expect(toLookup.map((c) => c.key)).toEqual(["a\u0000", "b\u0000", "c\u0000"]);
    expect(toLookup.map((c) => c.candidate.title)).toEqual(["A", "b", "C"]);
  });
});

describe("mergeKey — 접힘의 축 (빈 제목에는 축이 없다)", () => {
  it("정규화한 제목과 저자를 제어 문자로 이어 붙인다", () => {
    // 구분자는 제목·저자 정규화 결과에 절대 나타나지 않는 문자여야 한다.
    expect(mergeKey({ title: "82년생 김지영!", author: "조남주 (지은이)" })).toBe(
      "82년생김지영\u0000조남주",
    );
  });

  it("저자를 읽어내지 못하면 저자부가 빈 문자열이다 — 저자가 있는 후보와 합치지 않는다", () => {
    expect(mergeKey({ title: "채식주의자", author: null })).toBe("채식주의자\u0000");
    expect(mergeKey({ title: "채식주의자", author: null })).not.toBe(
      mergeKey({ title: "채식주의자", author: "한강" }),
    );
  });

  it("정규화하면 제목이 비는 후보는 null이다 — **저자가 있어도** null이다", () => {
    for (const title of 기호뿐인_제목) {
      expect(mergeKey({ title, author: null })).toBeNull();
      // 저자가 같다는 것은 "같은 저자의 어떤 책"이지 "같은 책"이 아니다. 여기서
      // 저자만으로 키를 만들면 서로 다른 책이 한 그룹으로 접힌다.
      expect(mergeKey({ title, author: "조남주" })).toBeNull();
    }
  });

  it("제목 전체가 괄호에 감싸여 있으면 내용을 살려 키를 만든다 — null이 아니다", () => {
    // 정규화가 괄호 구간을 지우고도 비면 괄호 문자만 벗긴다 (`match.ts`).
    // 이 회수 경로가 없으면 《채식주의자》가 판독 실패로 강등된다.
    expect(mergeKey({ title: "《채식주의자》", author: "한강" })).toBe(
      mergeKey({ title: "채식주의자", author: "한강" }),
    );
  });
});

describe("dedupeByIsbn — ② ISBN13 중복 제거 (FR-004)", () => {
  it("같은 책이 사진 5장에 모두 등장해도 결과 1권이고 photoIndex는 최초 등장 값이다", () => {
    const 책들 = Array.from({ length: MAX_PHOTOS }, (_, i) =>
      확인({ isbn13: isbn(1), photoIndex: i }),
    );

    const 결과 = dedupeByIsbn([...책들].reverse());

    expect(결과).toHaveLength(1);
    expect(결과[0].photoIndex).toBe(0);
  });

  it("서로 다른 ISBN은 입력 순서 그대로 남는다", () => {
    const 결과 = dedupeByIsbn([
      확인({ isbn13: isbn(3) }),
      확인({ isbn13: isbn(1) }),
      확인({ isbn13: isbn(2) }),
    ]);

    expect(결과.map((b) => b.isbn13)).toEqual([isbn(3), isbn(1), isbn(2)]);
  });

  it("중복이 아닌 필드는 최초 등장 레코드의 값을 유지한다", () => {
    const 결과 = dedupeByIsbn([
      { isbn13: isbn(1), photoIndex: 2, aladinRating: 9.1, claudeNote: "먼저" },
      { isbn13: isbn(1), photoIndex: 1, aladinRating: 3.0, claudeNote: "나중" },
    ]);

    expect(결과).toHaveLength(1);
    expect(결과[0].claudeNote).toBe("먼저");
    expect(결과[0].aladinRating).toBe(9.1);
    expect(결과[0].photoIndex).toBe(1);
  });

  it("입력 배열과 원소를 변형하지 않는다", () => {
    const 원본 = [
      확인({ isbn13: isbn(1), photoIndex: 3 }),
      확인({ isbn13: isbn(1), photoIndex: 1 }),
    ];
    const 스냅샷 = structuredClone(원본);

    dedupeByIsbn(원본);

    expect(원본).toEqual(스냅샷);
  });

  it("빈 입력은 빈 배열을 낸다", () => {
    expect(dedupeByIsbn([])).toEqual([]);
  });
});

describe("capIdentified — ③ 확인된 책 결정적 절단 (FR-005)", () => {
  it("51권 입력 시 정확히 50권 + overflowCount 1", () => {
    const 책들 = Array.from({ length: MAX_IDENTIFIED_BOOKS + 1 }, (_, i) =>
      확인({ isbn13: isbn(i), aladinRating: 10 - i / 100 }),
    );

    const { kept, overflowCount } = capIdentified(책들);

    expect(kept).toHaveLength(MAX_IDENTIFIED_BOOKS);
    expect(overflowCount).toBe(1);
  });

  it("상한 이하면 넘친 개수가 0이다", () => {
    const { kept, overflowCount } = capIdentified([확인({ isbn13: isbn(1) })]);

    expect(kept).toHaveLength(1);
    expect(overflowCount).toBe(0);
  });

  it("평점 내림차순으로 정렬한다", () => {
    const { kept } = capIdentified([
      확인({ isbn13: isbn(1), aladinRating: 7.0 }),
      확인({ isbn13: isbn(2), aladinRating: 9.5 }),
      확인({ isbn13: isbn(3), aladinRating: 8.2 }),
    ]);

    expect(kept.map((b) => b.aladinRating)).toEqual([9.5, 8.2, 7.0]);
  });

  it("평점이 null인 책은 최하위다 — 0점보다도 뒤로 간다", () => {
    const { kept } = capIdentified([
      확인({ isbn13: isbn(1), aladinRating: null }),
      확인({ isbn13: isbn(2), aladinRating: 0 }),
      확인({ isbn13: isbn(3), aladinRating: 5 }),
    ]);

    expect(kept.map((b) => b.isbn13)).toEqual([isbn(3), isbn(2), isbn(1)]);
  });

  it("평점이 동점이면 photoIndex 오름차순으로 갈린다", () => {
    const { kept } = capIdentified([
      확인({ isbn13: isbn(1), aladinRating: 8, photoIndex: 4 }),
      확인({ isbn13: isbn(2), aladinRating: 8, photoIndex: 0 }),
      확인({ isbn13: isbn(3), aladinRating: 8, photoIndex: 2 }),
    ]);

    expect(kept.map((b) => b.photoIndex)).toEqual([0, 2, 4]);
  });

  it("평점 동점 + photoIndex 동점이면 isbn13 오름차순으로 갈린다", () => {
    const { kept } = capIdentified([
      확인({ isbn13: isbn(30), aladinRating: 8, photoIndex: 1 }),
      확인({ isbn13: isbn(10), aladinRating: 8, photoIndex: 1 }),
      확인({ isbn13: isbn(20), aladinRating: 8, photoIndex: 1 }),
    ]);

    expect(kept.map((b) => b.isbn13)).toEqual([isbn(10), isbn(20), isbn(30)]);
  });

  it("null끼리도 photoIndex·isbn13으로 결정적으로 갈린다", () => {
    const { kept } = capIdentified([
      확인({ isbn13: isbn(2), aladinRating: null, photoIndex: 1 }),
      확인({ isbn13: isbn(1), aladinRating: null, photoIndex: 1 }),
      확인({ isbn13: isbn(3), aladinRating: null, photoIndex: 0 }),
    ]);

    expect(kept.map((b) => b.isbn13)).toEqual([isbn(3), isbn(1), isbn(2)]);
  });

  it("절단 순서 결정성 — 평점 null이 섞인 입력을 순서만 바꿔 넣어도 결과가 같다", () => {
    const 책들 = Array.from({ length: MAX_IDENTIFIED_BOOKS + 20 }, (_, i) =>
      확인({
        isbn13: isbn(i),
        // 평점을 일부러 뭉치게 만들어 동점 tie-break를 타게 한다. 3의 배수는 null
        aladinRating: i % 3 === 0 ? null : (i % 5) * 2,
        photoIndex: i % MAX_PHOTOS,
      }),
    );

    const 정순 = capIdentified(책들);
    const 역순 = capIdentified([...책들].reverse());
    const 섞음 = capIdentified([...책들].sort((a, b) => a.isbn13.localeCompare(b.isbn13)));

    expect(역순).toEqual(정순);
    expect(섞음).toEqual(정순);
    expect(정순.kept).toHaveLength(MAX_IDENTIFIED_BOOKS);
    expect(정순.overflowCount).toBe(20);
  });

  it("입력 배열과 원소를 변형하지 않는다", () => {
    const 원본 = [
      확인({ isbn13: isbn(2), aladinRating: 1 }),
      확인({ isbn13: isbn(1), aladinRating: 9 }),
    ];
    const 스냅샷 = structuredClone(원본);

    capIdentified(원본);

    expect(원본).toEqual(스냅샷);
  });

  it("빈 입력은 빈 결과를 낸다", () => {
    expect(capIdentified([])).toEqual({ kept: [], overflowCount: 0 });
  });
});

describe("capUnidentified — ③ 미확인 절단", () => {
  it("101건 입력 시 100건 + overflowCount 1", () => {
    const 미확인 = Array.from({ length: MAX_UNIDENTIFIED_BOOKS + 1 }, (_, i) => ({
      rawText: `원문 ${i}`,
    }));

    const { kept, overflowCount } = capUnidentified(미확인);

    expect(kept).toHaveLength(MAX_UNIDENTIFIED_BOOKS);
    expect(overflowCount).toBe(1);
  });

  it("입력 순서를 그대로 유지한다 — 사진에서 읽힌 순서가 곧 표시 순서다", () => {
    const { kept } = capUnidentified([{ rawText: "가" }, { rawText: "나" }, { rawText: "다" }]);

    expect(kept.map((b) => b.rawText)).toEqual(["가", "나", "다"]);
  });

  it("상한 이하면 넘친 개수가 0이다", () => {
    expect(capUnidentified([{ rawText: "가" }]).overflowCount).toBe(0);
  });

  it("입력 배열을 변형하지 않는다", () => {
    const 원본 = Array.from({ length: MAX_UNIDENTIFIED_BOOKS + 5 }, (_, i) => ({ rawText: `${i}` }));
    const 스냅샷 = structuredClone(원본);

    capUnidentified(원본);

    expect(원본).toEqual(스냅샷);
  });

  it("빈 입력은 빈 결과를 낸다", () => {
    expect(capUnidentified([])).toEqual({ kept: [], overflowCount: 0 });
  });
});
