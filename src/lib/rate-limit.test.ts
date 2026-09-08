/**
 * `/api/analyze` 레이트 리밋의 순수 판정부 (ADR-012).
 *
 * 이 파일은 시계를 인자로 받는 설계 덕에 `setTimeout`도 가짜 타이머도 쓰지 않는다.
 * 시계 역전·경계 버스트·포화는 전부 **입력으로 넣을 수 있는 값**이다.
 *
 * **상수를 리터럴로 적지 않는다** (AC-4). 상한·윈도·추적 상한·공유 상한·키 길이의
 * 값이 이 파일에 숫자로 등장하면 `env.ts` 한 곳이라는 전제가 그 순간 깨진다.
 * 그래서 아래 픽스처도 전부 `RATE_LIMIT_*`에서 계산한다.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  RATE_LIMIT_MAX_KEY_CHARS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_MAX_TRACKED_KEYS,
  RATE_LIMIT_SHARED_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
} from "@/lib/env";
import { checkRateLimit, resetRateLimit, resolveClientKey } from "@/lib/rate-limit";

/* ------------------------------------------------------------------ *
 * 픽스처
 * ------------------------------------------------------------------ */

/**
 * 테스트가 고른 세대 시작 시각.
 *
 * `resetRateLimit()` 뒤 `windowStart`는 `undefined`이고 모듈이 그것을 노출하지
 * 않는다. 그래서 **첫 호출을 `t0`에 쳐서 테스트가 세대를 연다** — 그러면 그
 * 세대의 경계가 정확히 `t0 + RATE_LIMIT_WINDOW_MS`다. 이 규약이 아래 경계
 * 테스트들이 성립하는 유일한 근거다.
 */
const t0 = 1_700_000_000_000;

const KEY = "ip:203.0.113.7";
const OTHER_KEY = "ip:198.51.100.9";

/** 시스템 버킷 둘. 이름을 여기 한 번만 적는다 */
const UNKNOWN_BUCKET = "__shared:unknown__";
const OVERFLOW_BUCKET = "__shared:overflow__";

/** IP에서 온 키에 붙는 접두사. 키 최대 길이 48은 이것과 상수에서 유도된다 */
const IP_PREFIX = "ip:";

/**
 * IPv4 사상 IPv6의 **최대 표기** 둘. 길이가 `RATE_LIMIT_MAX_KEY_CHARS`와 같고
 * 마지막 한 글자만 다르다.
 * 접두사를 자르기보다 먼저 붙이면 이 둘이 한 키로 뭉친다 (교차검증 F-26).
 */
const MAPPED_MAX_A = "0000:0000:0000:0000:0000:ffff:255.255.255.254";
const MAPPED_MAX_B = "0000:0000:0000:0000:0000:ffff:255.255.255.255";

function headersOf(init: Record<string, string>): Headers {
  return new Headers(init);
}

/** 같은 키·같은 시각으로 `count`번 친다 */
function callTimes(count: number, key: string, now: number) {
  return Array.from({ length: count }, () => checkRateLimit(key, now));
}

function allAllowed(decisions: { allowed: boolean }[]): boolean {
  return decisions.every((decision) => decision.allowed);
}

/**
 * 추적 상한까지 서로 다른 키를 채워 맵을 포화시킨다.
 * 키 목록이 아니라 **개수**만 쓴다 — 상한 값을 이 파일에 적지 않기 위해서다.
 */
function saturate(now: number): void {
  for (let index = 0; index < RATE_LIMIT_MAX_TRACKED_KEYS; index += 1) {
    checkRateLimit(`ip:10.0.${index}`, now);
  }
}

/** `saturate`가 만든 키 중 하나 — 포화 전부터 추적 중이던 키다 */
const TRACKED_BEFORE_SATURATION = "ip:10.0.0";

/** 넘침 버킷을 공유 상한까지 태운다. 매번 새 키로 친다 */
function burnOverflowBucket(now: number): void {
  for (let index = 0; index < RATE_LIMIT_SHARED_MAX_REQUESTS; index += 1) {
    checkRateLimit(`ip:192.0.2.${index}`, now);
  }
}

/**
 * 전역 상태는 테스트 사이에 살아남는다. 이것이 없으면 실행 순서에 따라
 * 간헐적으로 깨진다 (교차검증 F-10).
 */
beforeEach(() => {
  resetRateLimit();
});

/* ------------------------------------------------------------------ *
 * checkRateLimit — 상한과 세대
 * ------------------------------------------------------------------ */

describe("checkRateLimit — 상한", () => {
  it("상한까지는 통과하고 그 다음 요청이 막힌다", () => {
    expect(allAllowed(callTimes(RATE_LIMIT_MAX_REQUESTS, KEY, t0))).toBe(true);

    expect(checkRateLimit(KEY, t0).allowed).toBe(false);
  });

  it("서로 다른 키는 서로의 예산을 쓰지 않는다", () => {
    callTimes(RATE_LIMIT_MAX_REQUESTS, KEY, t0);
    expect(checkRateLimit(KEY, t0).allowed).toBe(false);

    expect(checkRateLimit(OTHER_KEY, t0).allowed).toBe(true);
  });

  it("윈도가 지나면 다시 통과한다 — 실제 시간을 기다리지 않는다", () => {
    callTimes(RATE_LIMIT_MAX_REQUESTS, KEY, t0);
    expect(checkRateLimit(KEY, t0).allowed).toBe(false);

    expect(checkRateLimit(KEY, t0 + RATE_LIMIT_WINDOW_MS).allowed).toBe(true);
  });

  it("윈도가 넘어가면 세대가 통째로 죽는다 — 이전 윈도 카운터가 하나도 안 남는다", () => {
    // 두 키를 각각 상한 직전까지 채운다.
    callTimes(RATE_LIMIT_MAX_REQUESTS - 1, KEY, t0);
    callTimes(RATE_LIMIT_MAX_REQUESTS - 1, OTHER_KEY, t0);

    const nextWindow = t0 + RATE_LIMIT_WINDOW_MS;

    // 부분 만료였다면 둘 중 하나는 한두 번 만에 막힌다.
    expect(allAllowed(callTimes(RATE_LIMIT_MAX_REQUESTS, KEY, nextWindow))).toBe(true);
    expect(allAllowed(callTimes(RATE_LIMIT_MAX_REQUESTS, OTHER_KEY, nextWindow))).toBe(true);
  });

  it("windowStart가 없을 때 첫 요청이 세대를 연다", () => {
    // 세대가 `t0`에 열렸다면, `t0`에서 막힌 요청의 대기 시간이 한 윈도 전체다.
    callTimes(RATE_LIMIT_MAX_REQUESTS, KEY, t0);
    const blocked = checkRateLimit(KEY, t0);

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(RATE_LIMIT_WINDOW_MS / 1000);
  });

  it("목 시계가 에포크 0이어도 첫 요청이 세대를 연다", () => {
    // `windowStart`를 falsy로 판정하면 `0`이 매번 새 세대를 열어 카운터가 늘지
    // 않는다 — 상한을 영영 만나지 못한다 (교차검증 F-16).
    expect(allAllowed(callTimes(RATE_LIMIT_MAX_REQUESTS, KEY, 0))).toBe(true);

    expect(checkRateLimit(KEY, 0).allowed).toBe(false);
  });

  it("경계 버스트가 실재한다 — 경계를 걸치면 상한의 두 배가 지나간다", () => {
    // 테스트가 고른 `t0`로 세대를 연다. 이 첫 호출이 경계를 `t0 + WINDOW`로 고정한다.
    expect(checkRateLimit(KEY, t0).allowed).toBe(true);

    // 같은 세대 안, 만료 1밀리초 전까지 상한을 채운다 (첫 호출 포함).
    const beforeBoundary = callTimes(
      RATE_LIMIT_MAX_REQUESTS - 1,
      KEY,
      t0 + RATE_LIMIT_WINDOW_MS - 1,
    );
    expect(allAllowed(beforeBoundary)).toBe(true);

    // 경계를 넘자마자 새 세대가 열려 상한이 통째로 되살아난다.
    const afterBoundary = callTimes(RATE_LIMIT_MAX_REQUESTS, KEY, t0 + RATE_LIMIT_WINDOW_MS);
    expect(allAllowed(afterBoundary)).toBe(true);

    // 짧은 구간에 상한의 두 배가 지나갔다. 숨기지 않고 값으로 박아 둔다.
    // 그 다음 요청은 막힌다 — 버스트가 무한이 아니라는 것까지 본다.
    expect(checkRateLimit(KEY, t0 + RATE_LIMIT_WINDOW_MS).allowed).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * checkRateLimit — 시계 역전
 * ------------------------------------------------------------------ */

describe("checkRateLimit — 시계 역전", () => {
  it("한 윈도보다 큰 역전이면 세대를 새로 연다 — 한 세대에 갇히지 않는다", () => {
    callTimes(RATE_LIMIT_MAX_REQUESTS, KEY, t0);
    expect(checkRateLimit(KEY, t0).allowed).toBe(false);

    // 이 갈래가 없으면 뺄셈이 음수라 만료 조건을 영영 만족하지 못한다 (교차검증 F-14).
    expect(checkRateLimit(KEY, t0 - RATE_LIMIT_WINDOW_MS - 1).allowed).toBe(true);
  });

  it("한 윈도보다 작은 역전은 세대를 비우지 않는다 — 1밀리초로 차단이 풀리지 않는다", () => {
    callTimes(RATE_LIMIT_MAX_REQUESTS, KEY, t0);
    expect(checkRateLimit(KEY, t0).allowed).toBe(false);

    // 마진 안의 역전은 클램프로 흡수한다. 세대를 비우면 여기서 통과가 나온다.
    expect(checkRateLimit(KEY, t0 - 1).allowed).toBe(false);
  });

  it("클램프된 뒤에도 세대가 원래 경계에서 만료된다", () => {
    // ① `t0`에 세대를 연다.
    expect(checkRateLimit(KEY, t0).allowed).toBe(true);
    // ② 미세 역전을 한 번 흡수한다 — 이 호출도 현재 세대에서 세어진다.
    expect(checkRateLimit(KEY, t0 - 1).allowed).toBe(true);
    // ③ 남은 예산을 채운다. ②가 세대를 비웠다면 여기 다음 줄이 통과로 뒤집힌다.
    expect(allAllowed(callTimes(RATE_LIMIT_MAX_REQUESTS - 2, KEY, t0))).toBe(true);
    expect(checkRateLimit(KEY, t0).allowed).toBe(false);

    // ④ 원래 경계에서 세대가 열린다. `windowStart`가 클램프에 오염되면 깨진다
    //    (교차검증 F-25).
    const nextGeneration = callTimes(RATE_LIMIT_MAX_REQUESTS, KEY, t0 + RATE_LIMIT_WINDOW_MS);
    expect(allAllowed(nextGeneration)).toBe(true);
  });

  it("역전된 시계에서도 retryAfterSeconds가 한 윈도를 넘지 않는다", () => {
    callTimes(RATE_LIMIT_MAX_REQUESTS, KEY, t0);

    // `now`를 그대로 쓰면 분자가 WINDOW + 10이 되어 61이 나간다 (교차검증 F-27).
    const blocked = checkRateLimit(KEY, t0 - 10);

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(RATE_LIMIT_WINDOW_MS / 1000);
  });
});

/* ------------------------------------------------------------------ *
 * checkRateLimit — retryAfterSeconds
 * ------------------------------------------------------------------ */

describe("checkRateLimit — retryAfterSeconds", () => {
  it("남은 윈도 시간이다 — 상수가 아니다", () => {
    callTimes(RATE_LIMIT_MAX_REQUESTS, KEY, t0);

    const blocked = checkRateLimit(KEY, t0 + RATE_LIMIT_WINDOW_MS / 2);

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(RATE_LIMIT_WINDOW_MS / 2000);
  });

  it("만료 직전에 막혀도 1 이상의 정수다", () => {
    callTimes(RATE_LIMIT_MAX_REQUESTS, KEY, t0);

    // 남은 시간이 1밀리초다. 올림이 없으면 0.001이, 하한이 없으면 0이 나간다.
    const blocked = checkRateLimit(KEY, t0 + RATE_LIMIT_WINDOW_MS - 1);

    expect(blocked.allowed).toBe(false);
    expect(Number.isInteger(blocked.retryAfterSeconds)).toBe(true);
    expect(blocked.retryAfterSeconds).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * checkRateLimit — 공유 버킷과 포화
 * ------------------------------------------------------------------ */

describe("checkRateLimit — 공유 버킷", () => {
  it.each([UNKNOWN_BUCKET, OVERFLOW_BUCKET])(
    "%s 는 IP별 상한이 아니라 공유 상한을 쓴다",
    (bucket) => {
      // IP별 상한을 넘겨도 아직 통과한다 — 상한 선택이 `ip:` 접두사로 갈린다.
      expect(allAllowed(callTimes(RATE_LIMIT_MAX_REQUESTS + 1, bucket, t0))).toBe(true);

      const remaining = RATE_LIMIT_SHARED_MAX_REQUESTS - RATE_LIMIT_MAX_REQUESTS - 1;
      expect(allAllowed(callTimes(remaining, bucket, t0))).toBe(true);

      expect(checkRateLimit(bucket, t0).allowed).toBe(false);
    },
  );
});

describe("checkRateLimit — 포화", () => {
  it("상한이 차면 새 키가 넘침 버킷으로 가고 거기서도 공유 상한에서 막힌다", () => {
    saturate(t0);

    // 포화 뒤의 새 키는 전부 한 버킷을 나눠 쓴다.
    burnOverflowBucket(t0);

    // 포화가 레이트 리밋을 끄지 않는다는 것이 이 단언의 요점이다.
    expect(checkRateLimit("ip:192.0.2.999", t0).allowed).toBe(false);
  });

  it("포화 상태에서도 이미 추적 중이던 키는 자기 카운터를 그대로 쓴다", () => {
    saturate(t0);
    burnOverflowBucket(t0);
    expect(checkRateLimit("ip:192.0.2.999", t0).allowed).toBe(false);

    // `map.has`를 크기 검사보다 **먼저** 보지 않으면 예산이 남은 기존 사용자까지
    // 넘침으로 튕긴다 (02 교차검증 F-1).
    expect(checkRateLimit(TRACKED_BEFORE_SATURATION, t0).allowed).toBe(true);
  });

  it("차단된 키는 상한 압박에도 지워지지 않는다 — 축출 공격이 재현되지 않는다", () => {
    callTimes(RATE_LIMIT_MAX_REQUESTS, KEY, t0);
    expect(checkRateLimit(KEY, t0).allowed).toBe(false);

    // 공격자가 새 키를 밀어 넣어 자기 카운터를 밀어내려 한다.
    saturate(t0);

    expect(checkRateLimit(KEY, t0).allowed).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * resetRateLimit
 * ------------------------------------------------------------------ */

describe("resetRateLimit", () => {
  it("카운터와 세대를 함께 되돌린다 — 같은 시각으로 다시 쳐도 통과한다", () => {
    callTimes(RATE_LIMIT_MAX_REQUESTS, KEY, t0);
    expect(checkRateLimit(KEY, t0).allowed).toBe(false);

    resetRateLimit();

    // `windowStart`를 `0`으로 되돌리면 목 시계 `0`에서 세대가 안 열린다.
    // 여기서는 `t0`라 통과하지만, 위 에포크 0 테스트가 그 갈래를 잡는다.
    expect(checkRateLimit(KEY, t0).allowed).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * resolveClientKey — 헤더 선택
 * ------------------------------------------------------------------ */

describe("resolveClientKey — 헤더 선택", () => {
  it("x-vercel-forwarded-for가 x-forwarded-for를 이긴다", () => {
    const key = resolveClientKey(
      headersOf({
        "x-vercel-forwarded-for": "1.2.3.4",
        "x-forwarded-for": "9.9.9.9",
      }),
    );

    expect(key).toBe(`${IP_PREFIX}1.2.3.4`);
  });

  it("x-vercel-forwarded-for가 없으면 x-forwarded-for로 떨어진다", () => {
    expect(resolveClientKey(headersOf({ "x-forwarded-for": "9.9.9.9" }))).toBe(
      `${IP_PREFIX}9.9.9.9`,
    );
  });

  it("둘 다 없으면 __shared:unknown__이다 — 접두사를 붙이지 않는다", () => {
    expect(resolveClientKey(headersOf({}))).toBe(UNKNOWN_BUCKET);
  });

  it("값이 빈 문자열이어도 __shared:unknown__이다", () => {
    expect(
      resolveClientKey(headersOf({ "x-vercel-forwarded-for": "", "x-forwarded-for": "" })),
    ).toBe(UNKNOWN_BUCKET);
  });
});

/* ------------------------------------------------------------------ *
 * resolveClientKey — 정규화 네 단계
 * ------------------------------------------------------------------ */

describe("resolveClientKey — 쉼표 목록", () => {
  it("첫 항목만 키가 된다 — 뒤가 바뀌어도 같은 키다", () => {
    const first = resolveClientKey(headersOf({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.9.9.9" }));
    const second = resolveClientKey(headersOf({ "x-forwarded-for": "1.2.3.4,  7.7.7.7" }));

    expect(first).toBe(`${IP_PREFIX}1.2.3.4`);
    expect(second).toBe(first);
  });
});

describe("resolveClientKey — 포트와 대괄호", () => {
  it("IPv4에 포트가 붙어 와도 같은 키다", () => {
    const a = resolveClientKey(headersOf({ "x-forwarded-for": "1.2.3.4:1111" }));
    const b = resolveClientKey(headersOf({ "x-forwarded-for": "1.2.3.4:2222" }));

    expect(a).toBe(`${IP_PREFIX}1.2.3.4`);
    expect(b).toBe(a);
  });

  it("대괄호 IPv6에 포트가 붙어 와도 같은 키다", () => {
    const a = resolveClientKey(headersOf({ "x-forwarded-for": "[2001:db8::1]:8080" }));
    const b = resolveClientKey(headersOf({ "x-forwarded-for": "[2001:db8::1]:9090" }));

    expect(a).toBe(`${IP_PREFIX}2001:db8::1`);
    expect(b).toBe(a);
  });

  it("IPv4 사상 IPv6에 포트가 붙어 와도 같은 키다", () => {
    // 마지막 콜론 뒤가 순수 숫자이고 그 앞 세그먼트에 점이 있는 갈래 (xv F-31).
    const a = resolveClientKey(headersOf({ "x-forwarded-for": "::ffff:1.2.3.4:8080" }));
    const b = resolveClientKey(headersOf({ "x-forwarded-for": "::ffff:1.2.3.4:9090" }));

    expect(a).toBe(`${IP_PREFIX}::ffff:1.2.3.4`);
    expect(b).toBe(a);
  });

  it("포트 없는 IPv6은 깎이지 않는다", () => {
    // `2001:db8::1`의 마지막 세그먼트 `1`도 순수 숫자다. 「마지막 콜론 뒤가 숫자면
    // 버린다」로 일반화하면 여기가 `ip:2001:db8:`가 된다.
    expect(resolveClientKey(headersOf({ "x-forwarded-for": "2001:db8::1" }))).toBe(
      `${IP_PREFIX}2001:db8::1`,
    );
    expect(resolveClientKey(headersOf({ "x-forwarded-for": "::1" }))).toBe(`${IP_PREFIX}::1`);
  });
});

describe("resolveClientKey — 자르기와 접두사", () => {
  it("RATE_LIMIT_MAX_KEY_CHARS보다 긴 헤더 값은 잘린다", () => {
    const long = "a".repeat(RATE_LIMIT_MAX_KEY_CHARS * 2);

    const key = resolveClientKey(headersOf({ "x-forwarded-for": long }));

    expect(key).toBe(`${IP_PREFIX}${"a".repeat(RATE_LIMIT_MAX_KEY_CHARS)}`);
    expect(key).toHaveLength(RATE_LIMIT_MAX_KEY_CHARS + IP_PREFIX.length);
  });

  it("자르기가 접두사보다 먼저다 — 최대 길이 IPv4 사상 IPv6 둘이 서로 다른 키다", () => {
    // 최대 표기 길이라는 사실을 값이 아니라 상수로 확인한다 (AC-4).
    expect(MAPPED_MAX_A).toHaveLength(RATE_LIMIT_MAX_KEY_CHARS);
    expect(MAPPED_MAX_B).toHaveLength(RATE_LIMIT_MAX_KEY_CHARS);

    const a = resolveClientKey(headersOf({ "x-forwarded-for": MAPPED_MAX_A }));
    const b = resolveClientKey(headersOf({ "x-forwarded-for": MAPPED_MAX_B }));

    // 접두사를 먼저 붙이고 잘랐다면 뒤 세 글자가 깎여 둘이 한 키로 뭉친다.
    expect(a).toBe(`${IP_PREFIX}${MAPPED_MAX_A}`);
    expect(b).toBe(`${IP_PREFIX}${MAPPED_MAX_B}`);
    expect(a).not.toBe(b);
    expect(a).toHaveLength(RATE_LIMIT_MAX_KEY_CHARS + IP_PREFIX.length);
  });
});

/* ------------------------------------------------------------------ *
 * resolveClientKey — 접두사 방어
 * ------------------------------------------------------------------ */

describe("resolveClientKey — 접두사 방어", () => {
  it("헤더에 __shared:overflow__를 실어도 공유 버킷을 못 건드린다", () => {
    const key = resolveClientKey(headersOf({ "x-forwarded-for": OVERFLOW_BUCKET }));

    // **기대 키를 값으로 적는다** (plan F-33). 값을 안 적으면 접두사가 빠진
    // 구현도 `not.toBe(OVERFLOW_BUCKET)`만으로는 통과한다.
    // 콜론이 정확히 하나라 ②가 `IPv4:포트`로 보고 앞만 남긴 뒤 ④가 접두사를 붙인다.
    expect(key).toBe("ip:__shared");
    expect(key).not.toBe(OVERFLOW_BUCKET);
  });

  it("헤더에 __shared:unknown__을 실어도 공유 버킷을 못 건드린다", () => {
    const key = resolveClientKey(headersOf({ "x-forwarded-for": UNKNOWN_BUCKET }));

    expect(key).toBe("ip:__shared");
    expect(key).not.toBe(UNKNOWN_BUCKET);
  });

  it("헤더로 만든 키는 공유 상한이 아니라 IP별 상한을 받는다", () => {
    // 접두사가 없으면 공격자가 남의 공유 예산을 직접 태울 수 있다 (교차검증 F-18).
    const key = resolveClientKey(headersOf({ "x-forwarded-for": OVERFLOW_BUCKET }));

    expect(allAllowed(callTimes(RATE_LIMIT_MAX_REQUESTS, key, t0))).toBe(true);
    expect(checkRateLimit(key, t0).allowed).toBe(false);

    // 진짜 공유 버킷은 손대지 않은 채 그대로 남아 있다.
    expect(checkRateLimit(OVERFLOW_BUCKET, t0).allowed).toBe(true);
  });
});
