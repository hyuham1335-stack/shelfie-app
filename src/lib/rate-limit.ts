/**
 * `/api/analyze` 인메모리 고정 윈도 레이트 리밋 (TR-013 · ADR-012 · TRD 7번).
 *
 * ## 이 모듈이 하는 일
 * 요청에서 클라이언트 키를 뽑고(`resolveClientKey`), 그 키의 이번 윈도 카운트를
 * 올려 통과 여부를 정한다(`checkRateLimit`). 저장소는 이 인스턴스의 메모리
 * 하나뿐이다 — 공유 스토어가 없으므로 **실효 상한은 인스턴스 수에 비례하고,
 * 그 수는 재지 않았다.** 콜드 스타트는 카운터를 지우고, 분산 유입은 막지 못한다.
 * 대괄호 없는 일반 IPv6 + 포트는 가르지 못한다(`resolveClientKey` 주석).
 *
 * ## 다섯째 한계 — **키 자체가 신뢰 가능하다는 전제가 플랫폼에 걸려 있다**
 * 이 통제 전체가 「`x-vercel-forwarded-for` 와 `x-forwarded-for` 를 **플랫폼이
 * 덮어쓴다**」는 전제 위에 서 있다. Vercel 위에서는 앞의 헤더가 먼저 읽혀 요청자가
 * 손댈 수 없지만, **폴백이 존재하는 이유가 바로 그 헤더가 없는 환경**(앞단에 프록시를
 * 더 둔 배포·자체 호스팅·로컬)이고, 그 환경에서는 `x-forwarded-for` 의 **왼쪽 끝을
 * 요청자가 직접 정할 수 있다.** 그러면 이 통제는 **켜진 채로 아무도 막지 못한다** —
 * 요청마다 다른 키를 위조하면 상한이 전혀 걸리지 않는다. 증폭도 붙는다: 위조 키로
 * `RATE_LIMIT_MAX_TRACKED_KEYS` 를 혼자 채우면 그 뒤에 오는 정상 사용자 전원이
 * `__shared:overflow__` 의 `RATE_LIMIT_SHARED_MAX_REQUESTS` 안으로 밀려 들어간다.
 * 폴백을 남기는 쪽을 골랐다 — 걷어내면 XFF 만 신뢰할 수 있는 배포에서 **실제
 * 클라이언트 IP 를 읽을 수 있는데도** 전원이 공유 상한을 함께 쓴다. 이 통제는
 * 처음부터 **남용 완화이지 방어가 아니다.**
 *
 * 한계 전부는 ADR-012 에 적혀 있다.
 *
 * ## `lib/` 의 순수 함수 규칙에 대한 예외다
 * `docs/ARCHITECTURE.md` 는 `lib/` 를 외부 호출 없는 순수 함수 자리로 정의하는데,
 * 이 모듈은 프로세스 전역 상태를 갖는다. 외부 호출·네트워크·타이머는 여전히
 * 하나도 쓰지 않는다 — 시계는 인자로 받고, `Date.now()` 를 여기서 부르지 않는다.
 * `checkRateLimit` 이 **동기 함수인 것이 요건**이다. `await` 이 하나라도 들어가면
 * 조건 판정과 맵 갱신 사이에 다른 요청이 끼어들어 카운트가 샌다.
 *
 * ## 무상태 전제(ADR-003)와의 관계
 * ADR-003 이 금지한 것은 요청 간에 **의미를 갖는 사용자 데이터**를 서버가 들고
 * 있는 것이다. 여기 남는 것은 키별 정수 카운터뿐이고, 언제 사라져도 기능이
 * 틀리지 않으며(다음 윈도에서 다시 센다) 사라지는 쪽이 안전한 방향이다.
 * 그 판단과 대가는 ADR-012 에 적혀 있다.
 */
import {
  RATE_LIMIT_MAX_KEY_CHARS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_MAX_TRACKED_KEYS,
  RATE_LIMIT_SHARED_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
} from "@/lib/env";

/** 한 번의 판정 결과. `retryAfterSeconds`는 `Retry-After`가 요구하는 **1 이상의 정수**다 */
export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * 전역 상태는 **컨테이너 하나**다.
 *
 * `windowStart`는 `map`의 속성이 아니라 컨테이너의 **형제 필드**다. `Map`에 필드를
 * 얹어 두면 세대를 넘길 때 맵을 갈아 끼우는 구현이 `windowStart`를 함께 날린다.
 * 그래서 세대 교체는 인스턴스 교체가 아니라 `map.clear()`로 한다.
 */
interface RateLimitState {
  map: Map<string, number>;
  windowStart: number | undefined;
}

declare global {
  // 개발 서버의 HMR은 모듈을 다시 평가한다. 모듈 스코프에 두면 리로드마다
  // 카운터가 리셋되어 로컬에서 이 코드의 동작을 확인할 수 없다.
  var __shelfieRateLimitState: RateLimitState | undefined;
}

/** **이미 있으면 그것을 쓴다.** 새로 만들면 위의 HMR 대책이 무의미해진다 */
const state: RateLimitState = (globalThis.__shelfieRateLimitState ??= {
  map: new Map<string, number>(),
  windowStart: undefined,
});

/** IP 키 접두사. 이 접두사 유무가 곧 「한 사람 몫인가 공유 몫인가」의 판정이다 */
const IP_PREFIX = "ip:";

/** 클라이언트 IP를 못 읽었을 때 함께 쓰는 버킷. 우회도 전면 차단도 아닌 셋째 길이다 */
const SHARED_UNKNOWN_KEY = "__shared:unknown__";

/** 추적 키가 상한에 닿았을 때 신규 키가 함께 쓰는 버킷 */
const SHARED_OVERFLOW_KEY = "__shared:overflow__";

/**
 * Vercel이 붙이는 헤더를 먼저 본다. 뒤의 `x-forwarded-for` 는 **플랫폼이 덮어쓸 때만**
 * 믿을 수 있는 값이고, 덮어쓰지 않는 환경에서는 **요청자가 직접 쓸 수 있는 입력**이다.
 * 신뢰 가능한 출처로 읽지 마라 — 위 「다섯째 한계」가 그 대가를 적어 두었다.
 */
const FORWARDED_HEADERS = ["x-vercel-forwarded-for", "x-forwarded-for"] as const;

/** 포트는 순수 숫자다 */
const PURE_DIGITS = /^\d+$/;

/**
 * 요청 헤더에서 레이트 리밋 키를 만든다.
 *
 * ① 쉼표 목록이면 첫 항목 → ② 포트·대괄호 제거 → ③ 길이 자르기 → ④ `ip:` 접두사.
 * **순서가 뒤집히면 안 된다.** 접두사를 먼저 붙이고 자르면 IPv4 사상 IPv6 최대
 * 표기(45자)의 서로 다른 주소가 잘린 자리에서 한 키로 뭉친다.
 *
 * ## 알려진 한계 — 대괄호 없는 일반 IPv6 + 포트는 가르지 못한다
 * `[2001:db8::1]:8080`처럼 대괄호가 있으면 주소와 포트가 명확하고,
 * `::ffff:1.2.3.4:8080`처럼 IPv4 사상 표기면 마지막 앞 세그먼트에 점이 있어
 * 구분된다. 그러나 대괄호 없는 `2001:db8::1:8080`은 **가를 수 없다** —
 * `2001:db8::1`이라는 정상 주소의 마지막 세그먼트 `1`도 순수 숫자라서,
 * 「마지막 콜론 뒤가 숫자면 버린다」로 일반화하면 정상 IPv6이 깎여 서로 다른
 * 주소가 한 키로 뭉친다. RFC 3986이 `host:port`에 대괄호를 요구하는 이유가 이
 * 모호함이고, 그래서 이 갈래는 **값을 그대로 둔다.** 대가는 그런 형태로 오는
 * 요청이 포트별로 다른 키가 되는 것(상한이 느슨해지는 쪽)이고, 이 한계는
 * ADR-012 에도 적혀 있다.
 */
export function resolveClientKey(headers: Headers): string {
  const forwarded = readForwardedFor(headers); // ① 쉼표 목록이면 첫 항목
  if (forwarded === "") {
    // 두 헤더가 다 없거나 비었다. 이 경로에는 `ip:` 접두사를 붙이지 않는다 —
    // 붙이면 한 사람 몫의 상한을 여러 클라이언트가 나눠 쓰게 된다.
    return SHARED_UNKNOWN_KEY;
  }

  const address = stripPort(forwarded); // ② 포트·대괄호 제거
  const truncated = address.slice(0, RATE_LIMIT_MAX_KEY_CHARS); // ③ 길이 자르기
  return `${IP_PREFIX}${truncated}`; // ④ 접두사
}

/**
 * 이번 요청을 통과시킬지 정하고 카운터를 갱신한다.
 *
 * 시계를 인자로 받는다 — 모듈 안에서 `Date.now()`를 부르면 테스트가 윈도 경계와
 * 시계 역전을 값으로 검증할 수 없다.
 */
export function checkRateLimit(key: string, now: number): RateLimitDecision {
  /* ① 세대 판정. 이 단계만 `now`를 직접 쓴다 --------------------- */
  let windowStart = state.windowStart;
  if (
    // **falsy 검사가 아니다.** 목 시계의 에포크 `0`이 세대를 못 열게 된다.
    windowStart === undefined ||
    // 윈도가 끝났다.
    now - windowStart >= RATE_LIMIT_WINDOW_MS ||
    // 시계가 윈도 하나보다 크게 뒤로 갔다. 그대로 두면 카운터가 영원히 안 풀린다.
    windowStart - now > RATE_LIMIT_WINDOW_MS
  ) {
    // **컨테이너를 유지하고 항목만 비운다.** 맵 인스턴스를 갈아 끼우지 않는다 —
    // 세대가 넘어가면 이전 윈도의 카운터가 하나도 안 남는다는 뜻은 이것으로 충분하다.
    state.map.clear();
    windowStart = now;
    state.windowStart = now;
  }

  /* ② 시계 역전 클램프. ① 뒤라 `windowStart`는 반드시 숫자다 ------ */
  // ① 앞에서 계산하면 `Math.max(now, undefined)`가 `NaN`이 되고, 그 뒤 전부가 무의미해진다.
  // 마진 안의 역전(윈도 하나 이내)에서는 `windowStart`를 건드리지 않는다 — 세대를
  // 열지 않기로 판정한 것을 여기서 뒤집으면 ①이 두 벌이 된다.
  const effectiveNow = Math.max(now, windowStart);

  /* ③ 버킷 선택 ------------------------------------------------- */
  // **`has`를 먼저 본다.** 크기 검사를 먼저 하면 이미 예산을 쓰고 있던 기존
  // 사용자까지 넘침 버킷으로 튕겨 나간다.
  let bucketKey = key;
  if (!state.map.has(key) && state.map.size >= RATE_LIMIT_MAX_TRACKED_KEYS) {
    bucketKey = SHARED_OVERFLOW_KEY;
  }

  /* ④ 상한 선택 ------------------------------------------------- */
  // 접두사로 판정한다. 시스템 버킷 **이름 목록**으로 판정하면 목록이 늘어난 날
  // 한쪽만 고쳐진다. 공유 버킷이 한 사람 몫(20회)을 쓰면 인프라 결함 하나로
  // 전원이 즉시 막히므로 상한을 분리한다.
  const limit = bucketKey.startsWith(IP_PREFIX)
    ? RATE_LIMIT_MAX_REQUESTS
    : RATE_LIMIT_SHARED_MAX_REQUESTS;

  /* ⑤ 카운트 판정 ------------------------------------------------ */
  const used = (state.map.get(bucketKey) ?? 0) + 1;
  state.map.set(bucketKey, used);

  return {
    allowed: used <= limit,
    // `now`가 아니라 `effectiveNow`다. 역전된 시계를 그대로 쓰면 윈도 길이보다
    // 큰 `Retry-After`가 나간다. 1 미만으로도 내려가지 않는다 — `Retry-After`는
    // 정수 초를 요구하고 `0`은 "지금 다시 보내라"가 되어 차단의 뜻을 잃는다.
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((windowStart + RATE_LIMIT_WINDOW_MS - effectiveNow) / 1000),
    ),
  };
}

/**
 * 카운터를 초기 상태로 되돌린다. 테스트 간 격리가 용도다.
 *
 * `windowStart`는 **`0`이 아니라 `undefined`** 로 되돌린다 — `0`으로 되돌리면
 * 목 시계가 에포크 `0`일 때 ①의 세 조건이 전부 거짓이 되어 세대가 안 열린다.
 * `globalThis`의 컨테이너 자체는 지우지 않는다.
 */
export function resetRateLimit(): void {
  state.map.clear();
  state.windowStart = undefined;
}

/** ① 두 헤더를 차례로 보고 첫 항목을 꺼낸다. 없거나 비었으면 빈 문자열 */
function readForwardedFor(headers: Headers): string {
  for (const name of FORWARDED_HEADERS) {
    const raw = headers.get(name);
    if (raw === null) continue;

    // 프록시 체인은 `client, proxy1, proxy2` 순이라 **첫 항목**이 클라이언트다.
    //
    // 왼쪽 끝을 고르는 것이 이 헤더에서 가장 위조하기 쉬운 자리를 고르는 것임을
    // 알고 고른다(위 「다섯째 한계」). 나머지 둘이 더 나쁘기 때문이다:
    // 문자열 **전체**를 키로 쓰면 중간 프록시가 하나 바뀔 때마다 새 키가 되어
    // 같은 클라이언트가 상한을 그냥 우회하고, **신뢰 홉 수를 세는** 방식은 그 홉
    // 수를 설정 상수로 들여와야 하는데 **재지 않은 상수를 하나 더 만들지 않는다**는
    // 이 런의 규율에 걸린다.
    const first = raw.split(",")[0].trim();
    if (first !== "") return first;
  }
  return "";
}

/**
 * ② 포트와 대괄호를 떼어 낸다. 판정은 넷이고, 넷째가 위 「알려진 한계」다.
 */
function stripPort(value: string): string {
  // (1) 대괄호로 시작하면 **대괄호 안이 주소**이고 그 뒤의 `:포트`는 버린다.
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    return close === -1 ? value.slice(1) : value.slice(1, close);
  }

  const segments = value.split(":");

  // (2) 콜론이 정확히 하나면 `IPv4:포트`다.
  if (segments.length === 2) {
    return segments[0];
  }

  if (segments.length > 2) {
    const last = segments[segments.length - 1];
    const previous = segments[segments.length - 2];
    // (3) IPv4 사상 IPv6 + 포트(`::ffff:1.2.3.4:8080`). 마지막 뒤가 순수 숫자이고
    // **바로 앞 세그먼트에 점이 있는** 경우에만 마지막 세그먼트를 버린다.
    if (PURE_DIGITS.test(last) && previous.includes(".")) {
      return segments.slice(0, -1).join(":");
    }
  }

  // (4) 그 밖에는 그대로 둔다. 대괄호 없는 일반 IPv6 + 포트는 여기서 못 가른다.
  return value;
}
