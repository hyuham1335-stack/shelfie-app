import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterVerified, issueProof, verifyProof, type ProofSubject } from "./proof";

const TTL_MS = 2 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

const 소년이온다: ProofSubject = {
  isbn13: "9788936434120",
  title: "소년이 온다",
  author: "한강",
};

const 파친코: ProofSubject = {
  isbn13: "9791188810554",
  title: "파친코 1",
  author: "이민진",
};

/** proof는 `base64url(exp).mac` 형태다. 서명부만 골라 1글자 바꾼다 */
function tamperSignature(proof: string): string {
  const [exp, mac] = proof.split(".");
  const last = mac.slice(-1);
  return `${exp}.${mac.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

beforeEach(() => {
  vi.stubEnv("BOOK_PROOF_SECRET", "test-secret-0123456789abcdef0123456789abcdef");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("issueProof / verifyProof — 확인 판정을 요청 경계 너머로 나른다 (ADR-006)", () => {
  it("발급한 서명은 같은 책에 대해 검증을 통과한다", () => {
    const proof = issueProof(소년이온다, NOW);
    expect(verifyProof(소년이온다, proof, NOW)).toEqual({ ok: true });
  });

  it("서명 문자열을 1글자 바꾸면 bad_signature다", () => {
    const proof = issueProof(소년이온다, NOW);
    expect(verifyProof(소년이온다, tamperSignature(proof), NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("형식이 아예 다른 문자열은 malformed다 — 서명 불일치와 구분한다 (사유 보존)", () => {
    for (const bogus of ["", "구분자가없다", "a.b.c", ".mac", "ZXhw."]) {
      expect(verifyProof(소년이온다, bogus, NOW)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("만료 시각이 숫자로 복원되지 않으면 malformed다", () => {
    const notANumber = Buffer.from("영원히", "utf8").toString("base64url");
    expect(verifyProof(소년이온다, `${notANumber}.mac`, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("TTL 2시간 (TR-015)", () => {
  it("2시간 - 1초 시점에는 통과한다", () => {
    const proof = issueProof(소년이온다, NOW);
    expect(verifyProof(소년이온다, proof, NOW + TTL_MS - 1000)).toEqual({ ok: true });
  });

  it("2시간 + 1초 시점에는 expired다", () => {
    const proof = issueProof(소년이온다, NOW);
    expect(verifyProof(소년이온다, proof, NOW + TTL_MS + 1000)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("만료됐더라도 위조된 서명은 bad_signature다 — 서명을 먼저 본다", () => {
    const proof = issueProof(소년이온다, NOW);
    expect(verifyProof(소년이온다, tamperSignature(proof), NOW + TTL_MS + 1000)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});

describe("교차 사용 차단 — 한 책의 증명을 다른 책에 붙일 수 없다", () => {
  it("A 책의 proof를 B 책에 붙이면 bad_signature다", () => {
    const proof = issueProof(소년이온다, NOW);
    expect(verifyProof(파친코, proof, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("isbn13이 같으면 통과한다 — 서명 대상은 isbn13과 만료 시각이다 (ADR-006)", () => {
    const proof = issueProof(소년이온다, NOW);
    const 제목이바뀐같은책 = { ...소년이온다, title: "소년이온다(개정판)", author: "한 강" };
    expect(verifyProof(제목이바뀐같은책, proof, NOW)).toEqual({ ok: true });
  });
});

describe("filterVerified — 실패한 책만 버리고 나머지는 살린다 (fail-soft)", () => {
  // 서명 발급은 시크릿을 읽으므로 stubEnv가 걸린 뒤(=테스트 실행 시점)에 해야 한다.
  let 정상1: ProofSubject & { proof: string };
  let 정상2: ProofSubject & { proof: string };

  beforeEach(() => {
    정상1 = { ...소년이온다, proof: issueProof(소년이온다, NOW) };
    정상2 = { ...파친코, proof: issueProof(파친코, NOW) };
  });

  it("위조 1권 + 정상 2권에서 정상 2권만 남긴다", () => {
    const 위조 = { ...소년이온다, isbn13: "9999999999999", proof: tamperSignature(정상1.proof) };

    const { verified, rejected } = filterVerified([정상1, 위조, 정상2], NOW);

    expect(verified).toEqual([정상1, 정상2]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].book).toBe(위조);
    expect(rejected[0].reason).toBe("bad_signature");
  });

  it("버린 책의 사유를 함께 돌려준다 — 왜 버렸는지를 끝까지 나른다", () => {
    const 만료 = { ...소년이온다, proof: issueProof(소년이온다, NOW - TTL_MS - 1000) };
    const 형식오류 = { ...파친코, proof: "" };

    const { verified, rejected } = filterVerified([만료, 형식오류], NOW);

    expect(verified).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(["expired", "malformed"]);
  });

  it("전량 통과하면 rejected는 비어 있다", () => {
    const { verified, rejected } = filterVerified([정상1, 정상2], NOW);
    expect(verified).toHaveLength(2);
    expect(rejected).toEqual([]);
  });
});

describe("BOOK_PROOF_SECRET 처리 (TRD 7번)", () => {
  it("시크릿이 바뀌면 이전 서명이 전부 실패한다 — 교체는 배포 창에서만 한다", () => {
    const proof = issueProof(소년이온다, NOW);

    vi.stubEnv("BOOK_PROOF_SECRET", "rotated-secret-fedcba9876543210fedcba98765432");

    expect(verifyProof(소년이온다, proof, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("프로덕션에서 시크릿이 없으면 예외를 던진다 — 조용한 폴백은 서명 없는 서명이다", async () => {
    vi.resetModules();
    vi.stubEnv("BOOK_PROOF_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");

    const { issueProof: freshIssue, verifyProof: freshVerify } = await import("./proof");

    // 구조 검사는 시크릿 없이도 끝나므로, 서명 계산까지 도달하는 형태를 넘긴다.
    const 형식은맞는proof = `${Buffer.from(String(NOW + 1000), "utf8").toString("base64url")}.mac`;

    expect(() => freshIssue(소년이온다, NOW)).toThrow(/BOOK_PROOF_SECRET/);
    expect(() => freshVerify(소년이온다, 형식은맞는proof, NOW)).toThrow(/BOOK_PROOF_SECRET/);
  });

  it("프로덕션이 아니면 개발용 값으로 대체하고 경고를 한 번만 남긴다 (목업 모드)", async () => {
    vi.resetModules();
    vi.stubEnv("BOOK_PROOF_SECRET", "");
    vi.stubEnv("NODE_ENV", "test");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const fresh = await import("./proof");
    const proof = fresh.issueProof(소년이온다, NOW);

    expect(fresh.verifyProof(소년이온다, proof, NOW)).toEqual({ ok: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("시크릿 판정은 모듈 로드가 아니라 호출 시점에 한다 — import만으로는 던지지 않는다", async () => {
    vi.resetModules();
    vi.stubEnv("BOOK_PROOF_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");

    await expect(import("./proof")).resolves.toBeDefined();
  });
});
