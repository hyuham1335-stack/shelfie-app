/**
 * 확인된 책 1권당 서버 HMAC 서명 발급·검증 (TR-015, ADR-006).
 *
 * ## 왜 필요한가
 * 이 앱은 무상태다(ADR-003). "알라딘 대조를 통과했다"는 판정은 응답과 함께
 * 클라이언트로 나갔다가 다음 요청(`/api/recommend`·`/api/mood/questions`)에
 * 다시 들어오는데, 서버는 그 목록이 자기가 내준 것인지 알 방법이 없다.
 * zod 형식 검사는 값이 그럴듯한지만 보고, 화이트리스트 검증(FR-009)은
 * 모델 출력이 입력과 일치하는지만 본다 — 둘 다 통과해도 입력 자체가 지어낸
 * 것이면 가짜 책이 추천까지 도달한다. `proof`가 그 간극을 메운다.
 *
 * ## 서명 대상: `isbn13` + 만료 시각(exp), 그 둘뿐이다
 * ADR-006이 정한 형식 그대로다 — `base64url(exp) + "." + HMAC(secret, isbn13 + "|" + exp)`.
 * - `isbn13`을 넣는 이유: 중복 제거 키이자 추천 화이트리스트의 유일한 식별자이며
 *   (ADR-002), 이 값이 서명 대상이어야 한 책의 증명을 다른 책에 붙여 쓸 수 없다.
 * - `exp`를 넣는 이유: 무상태에서 무한 재사용을 막을 유일한 수단이다. 발급된
 *   서명을 서버가 취소할 수 없으므로 만료 시각 자체가 서명 대상이어야 한다.
 * - `title`·`author`를 넣지 **않는** 이유: 이 서명이 증명하는 것은 "그 ISBN이
 *   알라딘 대조를 통과했다"이지 "그 문자열이 그대로 돌아왔다"가 아니다.
 *   클라이언트를 거쳐 되돌아오는 텍스트는 어차피 데이터 블록으로만 다루고
 *   (TRD 6.5 프롬프트 인젝션), 화면에 뜨는 사실은 `isbn13`으로 다시 조회한
 *   알라딘 원본이다. 서지 문자열까지 서명에 묶으면 공백·개정판 표기 차이 하나로
 *   정상 세션의 책이 통째로 폐기된다.
 *
 * `lib/`는 외부 호출을 하지 않는 순수 계층이므로 Node 내장 `node:crypto`만 쓴다.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** 서명 유효기간 2시간 (ADR-006, TR-015) */
const PROOF_TTL_MS = 2 * 60 * 60 * 1000;

/** `base64url(exp)`와 MAC을 가르는 구분자 */
const SEPARATOR = ".";

/**
 * 프로덕션이 아닐 때만 쓰는 고정 개발용 키.
 * API 키 없이도 전 구간을 돌릴 수 있어야 한다는 목업 모드 원칙(TRD 9번)을 지킨다.
 */
const DEV_SECRET = "shelfie-dev-book-proof-secret-not-for-production";

/** 개발용 키 경고는 요청마다가 아니라 프로세스당 한 번만 남긴다 */
let devSecretWarned = false;

/** 서명 대상. `isbn13`은 반드시 포함한다 */
export interface ProofSubject {
  isbn13: string;
  title: string;
  author: string;
}

/** 검증 결과. 실패 사유는 뭉개지 않고 구분 가능한 값으로 돌려준다 (사유 보존 패턴) */
export type ProofVerdict =
  | { ok: true }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * HMAC 키를 읽는다.
 *
 * 이 판정을 모듈 최상위 부수효과로 두지 않는다 — 그렇게 하면 import 시점의
 * 환경변수에 고정되어 시크릿 교체·테스트가 불가능해진다.
 */
function getSecret(): string {
  const secret = process.env.BOOK_PROOF_SECRET;
  if (secret !== undefined && secret.length > 0) {
    return secret;
  }

  if (process.env.NODE_ENV === "production") {
    // 조용한 폴백은 "서명 없는 서명"이 되어 ADR-006을 통째로 무력화한다.
    throw new Error(
      "BOOK_PROOF_SECRET가 설정되지 않았습니다. 프로덕션에서는 확인된 책에 서명을 붙일 수 없습니다 (ADR-006).",
    );
  }

  if (!devSecretWarned) {
    devSecretWarned = true;
    console.warn(
      "[proof] BOOK_PROOF_SECRET가 없어 개발용 고정 키를 씁니다. 프로덕션에서는 반드시 설정하세요.",
    );
  }
  return DEV_SECRET;
}

/** `isbn13 + "|" + exp`에 대한 HMAC-SHA256 (base64url) */
function sign(isbn13: string, exp: number): string {
  return createHmac("sha256", getSecret()).update(`${isbn13}|${exp}`).digest("base64url");
}

/**
 * 길이가 다른 버퍼를 `timingSafeEqual`에 넘기면 예외가 나므로 길이를 먼저 본다.
 * 문자열 `===` 비교는 타이밍 공격에 노출되므로 쓰지 않는다.
 */
function safeEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/** 발급. `now`는 테스트를 위한 주입점이며 기본값은 `Date.now()` */
export function issueProof(subject: ProofSubject, now: number = Date.now()): string {
  const exp = now + PROOF_TTL_MS;
  const encodedExp = Buffer.from(String(exp), "utf8").toString("base64url");
  return `${encodedExp}${SEPARATOR}${sign(subject.isbn13, exp)}`;
}

/**
 * 검증. 구조 → 서명 → 만료 순으로 본다.
 *
 * 서명을 만료보다 먼저 보는 이유: 위조된 서명이 우연히 만료 시각까지 지났다고
 * `expired`로 보고되면, 운영에서 "세션이 오래됐다"와 "클라이언트 상태 조립
 * 버그"를 구분할 수 없게 된다 (TRD 6.4 무결성 계측).
 */
export function verifyProof(
  subject: ProofSubject,
  proof: string,
  now: number = Date.now(),
): ProofVerdict {
  const parts = proof.split(SEPARATOR);
  if (parts.length !== 2) {
    return { ok: false, reason: "malformed" };
  }

  const [encodedExp, mac] = parts;
  if (encodedExp.length === 0 || mac.length === 0) {
    return { ok: false, reason: "malformed" };
  }

  const decodedExp = Buffer.from(encodedExp, "base64url").toString("utf8");
  if (!/^\d+$/.test(decodedExp)) {
    return { ok: false, reason: "malformed" };
  }

  const exp = Number(decodedExp);
  if (!Number.isSafeInteger(exp)) {
    return { ok: false, reason: "malformed" };
  }

  if (!safeEqual(mac, sign(subject.isbn13, exp))) {
    return { ok: false, reason: "bad_signature" };
  }

  if (now >= exp) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true };
}

/**
 * 확인된 책 목록에서 검증 통과분만 남긴다.
 *
 * 검증 실패는 요청 전체가 아니라 **그 책만** 폐기한다 — 강등(fail-soft) 패턴이며,
 * 시크릿을 교체한 순간 진행 중이던 세션이 통째로 죽는 것을 막는다(ADR-006).
 * 남은 책이 0권일 때 400 `UNVERIFIED_BOOKS`로 끊는 판단은 라우트 핸들러 몫이다.
 */
export function filterVerified<T extends ProofSubject & { proof: string }>(
  books: readonly T[],
  now: number = Date.now(),
): { verified: T[]; rejected: Array<{ book: T; reason: string }> } {
  const verified: T[] = [];
  const rejected: Array<{ book: T; reason: string }> = [];

  for (const book of books) {
    const verdict = verifyProof(book, book.proof, now);
    if (verdict.ok) {
      verified.push(book);
    } else {
      rejected.push({ book, reason: verdict.reason });
    }
  }

  return { verified, rejected };
}
