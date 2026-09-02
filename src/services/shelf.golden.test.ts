/**
 * 골든 인식률 러너 (ADR-010 · TRD 8번 · TRD 9번 배포 전 체크리스트).
 *
 * ## 이것은 프로덕션 코드가 아니라 테스트 코드다
 * 러너는 `services/anthropic.ts`와 `services/aladin.ts`를 **둘 다** 부른다.
 * `lib/` → `services/`는 금지고(/docs/ARCHITECTURE.md), `services/`에 두면
 * "외부 API 래퍼"라는 그 디렉토리의 정의가 깨지며, `app/api/`에 두면 존재하지
 * 않는 라우트가 생긴다. 남는 자리는 테스트이고, 실제로 그것이 맞다 — 이 코드는
 * 배포되지 않고 CI에서 돌지 않으며 사람이 배포 전에 한 번 돌린다 (ADR-010).
 *
 * 순수 부품 셋(`golden-manifest`·`golden-score`·`golden-report`)은 `lib/`에 있고
 * 일반 `npm test`가 값으로 검증한다. 여기 남는 것은 **부수효과뿐**이다 —
 * 파일 읽기, 실제 API 호출, 리포트 쓰기.
 *
 * ## 실행
 * ```bash
 * GOLDEN_SET_DIR=/path/to/set npm run test:golden
 * ```
 * `npm test`는 이 파일을 돌리지 않는다 (`vitest.config.ts`가 exclude한다).
 *
 * ## skip은 통과가 아니다
 * 세 사유(`no_set_dir`·`no_manifest`·`no_api_key`) 중 하나면 vitest의 skip 기제로
 * 건너뛰고, 사유를 **콘솔과 리포트 파일 양쪽에** 남긴다. `expect(true)`로 때우면
 * 그것은 통과로 기록되고, 배포 전 체크리스트의 "골든을 돌렸는가"에 거짓으로
 * 답하게 된다.
 *
 * 그중 `no_api_key`가 가장 중요하다. `services/`는 키가 없으면 목업을 돌려주므로
 * (TRD 9번) 키 없이 재면 **재현율이 100%로 나오고 게이트가 통과를 찍는다.**
 * 이 프로젝트에는 "가짜 책이 확인된 책으로 노출"을 탐지할 신호가 달리 없고
 * (TRD 6.4), 그 유일한 감지 장치가 스스로를 속이는 것이 여기서 가능한 최악의
 * 결함이다 (ADR-010).
 *
 * ## 실패와 데이터 없음을 끝까지 가른다 (ADR-005)
 * - 추출이 `failed`인 사진은 **후보 0건으로 접지 않는다.** `refusal`·`timeout`·
 *   `upstream`은 모델의 판독 능력과 무관한데 그것을 "못 읽었다"로 접으면 인프라
 *   문제로 떨어진 숫자를 모델 탓으로 적게 된다. 그 사진은 재현율 분모에서 빼고
 *   실패 사유를 러너 메모로 남긴다.
 * - 알라딘 조회 실패는 `judge`가 이미 `lookup_failed`로 가른다. 그 책은 확인으로
 *   승격되지 않으므로 오확인의 분자에도 분모에도 들어가지 않는다.
 *
 * ## 사진을 로그에 남기지 않는다
 * base64 본문도 파일 내용도 콘솔·리포트에 찍지 않는다. 파일명까지다
 * (/docs/PRD.md 리스크 표 — 업로드 이미지의 사생활).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { getAladinTtbKey, getAnthropicApiKey, getExtractModel, getGoldenSetDir } from "@/lib/env";
import { parseGoldenManifest, type GoldenManifest, type GoldenPhoto } from "@/lib/golden-manifest";
import {
  renderGoldenReport,
  toGoldenReportJson,
  type GoldenOutcome,
  type GoldenRunContext,
  type GoldenSkipReason,
} from "@/lib/golden-report";
import { aggregateScores, scorePhoto, type GoldenPhotoScore } from "@/lib/golden-score";
import { judge } from "@/lib/match";
import { reduceBeforeLookup } from "@/lib/merge";
import { createRequestBreaker, searchByTitle } from "@/services/aladin";
import { extractFromPhoto, type ExtractFailureReason } from "@/services/anthropic";
import type { ExtractedCandidate, IdentifiedBook, UnidentifiedReason } from "@/types/book";

/**
 * 사진 1장 추출에 주는 시간. **프로덕션의 단계 예산(30s)이 아니다.**
 *
 * 그 값은 Vercel 함수 60s 상한에서 나온 것이고(ADR-005), 골든은 사람이 배포 전에
 * 돌리는 것이라 그 상한이 없다. 예산 때문에 강등된 책이 인식률로 계상되면 재는
 * 대상이 판독 품질에서 함수 상한으로 바뀐다.
 */
const EXTRACT_DEADLINE_MS = 120_000;

/**
 * 사진 1장의 알라딘 대조 전체에 주는 시간. 위와 같은 이유로 프로덕션 예산(12s)보다
 * 넉넉하다. 개별 호출은 `services/aladin.ts`가 5s로 잘라 쓴다.
 */
const LOOKUP_DEADLINE_MS = 300_000;

/**
 * 확장자 → MIME. **모르는 확장자를 `image/jpeg`로 조용히 보내지 않는다** —
 * 잘못된 MIME으로 거절당한 사진이 "판독 실패"로 기록되면 그것도 인프라 문제를
 * 모델 탓으로 적는 것이다.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const REPORT_DIR = join("reports", "golden");

/* ------------------------------------------------------------------ *
 * 러너 메모 — golden-report 가 표현하지 않는 것
 * ------------------------------------------------------------------ */

/**
 * `GoldenOutcome`은 "쟀다/못 쟀다" 둘뿐이라 **사진 단위 실패**를 담을 자리가 없다.
 * 그것을 `lib/golden-report.ts`에 밀어 넣는 대신(step 2 산출물이고 계약은 TRD 8번에
 * 있다) 러너가 자기 메모로 콘솔과 JSON 양쪽에 덧붙인다.
 */
type RunnerPhotoStatus = "scored" | "unsupported_type" | "read_failed" | "extract_failed";

interface RunnerPhotoNote {
  file: string;
  status: RunnerPhotoStatus;
  /** 추출 실패 사유. `status`가 `extract_failed`일 때만 채운다 (ADR-005 — 사유 보존) */
  extractFailureReason?: ExtractFailureReason;
  detail?: string;
  /** 아래는 `scored`일 때만 채운다 */
  candidateCount?: number;
  lookedUpCount?: number;
  identifiedCount?: number;
  unidentifiedByReason?: Record<UnidentifiedReason, number>;
}

/* ------------------------------------------------------------------ *
 * 준비 — 세트를 찾고 매니페스트를 읽고 키를 확인한다 (전부 동기)
 * ------------------------------------------------------------------ */

type Preparation =
  | { status: "ready"; dir: string; manifest: GoldenManifest }
  | {
      status: "skipped";
      reason: GoldenSkipReason;
      detail: string;
      /** `no_api_key`는 매니페스트를 이미 읽은 뒤라 맥락(세트·해시)을 리포트에 실을 수 있다 */
      manifest: GoldenManifest | null;
    };

function prepare(): Preparation {
  const dir = getGoldenSetDir();
  if (dir === null) {
    return {
      status: "skipped",
      reason: "no_set_dir",
      detail: "GOLDEN_SET_DIR 환경변수가 비어 있거나 설정되지 않았습니다.",
      manifest: null,
    };
  }

  const manifestPath = join(dir, "manifest.json");

  let body: string;
  try {
    body = readFileSync(manifestPath, "utf8");
  } catch (error) {
    return skippedManifest(`${manifestPath} 을 읽지 못했습니다 — ${describeError(error)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (error) {
    return skippedManifest(`${manifestPath} 이 JSON 이 아닙니다 — ${describeError(error)}`);
  }

  const parsed = parseGoldenManifest(raw);
  if (parsed.status === "failed") {
    // reason(schema/version)을 그대로 나른다 — 사람이 할 일이 다르다.
    // schema 면 매니페스트를 고치고, version 이면 lib/golden-manifest.ts 를 올린다.
    return skippedManifest(`${parsed.reason}: ${parsed.detail}`);
  }

  const missingKeys = [
    getAnthropicApiKey() === null ? "ANTHROPIC_API_KEY" : null,
    getAladinTtbKey() === null ? "ALADIN_TTB_KEY" : null,
  ].filter((name): name is string => name !== null);

  if (missingKeys.length > 0) {
    // 이 리포에서 가장 중요한 한 줄이다. 키가 없으면 services/ 가 목업을 돌려주므로
    // 그대로 재면 재현율이 100% 로 나온다 — 게이트가 정확히 반대로 작동한다 (ADR-010).
    return {
      status: "skipped",
      reason: "no_api_key",
      detail: `${missingKeys.join(" · ")} 가 없습니다. 목업 위에서 잰 수치는 근거가 되지 않습니다.`,
      manifest: parsed.manifest,
    };
  }

  return { status: "ready", dir, manifest: parsed.manifest };
}

function skippedManifest(detail: string): Preparation {
  return { status: "skipped", reason: "no_manifest", detail, manifest: null };
}

/** 예외를 한 줄로 접는다. 스택은 남기지 않는다 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    // fs 예외는 메시지가 이미 코드로 시작한다 — 앞에 또 붙이면 "ENOENT: ENOENT: …"가 된다.
    if (code === undefined || error.message.startsWith(code)) return error.message;
    return `${code}: ${error.message}`;
  }
  return String(error);
}

/* ------------------------------------------------------------------ *
 * 리포트 — 콘솔과 파일 양쪽
 * ------------------------------------------------------------------ */

function buildContext(manifest: GoldenManifest | null): GoldenRunContext {
  const photoHashes: Record<string, string> = {};
  for (const photo of manifest?.photos ?? []) {
    photoHashes[photo.file] = photo.sha256;
  }

  return {
    setId: manifest?.setId ?? null,
    manifestVersion: manifest?.version ?? null,
    extractModel: getExtractModel(),
    photoHashes,
    ranAt: new Date().toISOString(),
  };
}

/**
 * 리포트를 콘솔에 찍고 `reports/golden/{ISO8601}.json`에 쓴다 (TRD 8번 "결과 기록").
 * `reports/`는 `.gitignore`에 이미 덮여 있어 커밋되지 않는다.
 *
 * **skip 일 때도 쓴다.** 재지 못했다는 사실 자체가 기록이어야 배포 전 체크리스트가
 * skip 한 리포트를 근거로 삼지 못한다.
 */
function emitReport(
  outcome: GoldenOutcome,
  context: GoldenRunContext,
  notes: readonly RunnerPhotoNote[],
): void {
  const sections = [renderGoldenReport(outcome, context)];
  const memo = renderRunnerNotes(notes);
  if (memo.length > 0) sections.push(memo.join("\n"));

  console.log(`\n${sections.join("\n\n")}\n`);

  const base = toGoldenReportJson(outcome, context) as Record<string, unknown>;
  const json = { ...base, runner: { photos: notes } };

  mkdirSync(REPORT_DIR, { recursive: true });
  // Windows 는 파일명에 ':' 를 허용하지 않는다. 정확한 ISO 8601 값은
  // context.ranAt 안에 그대로 남으므로 파일명만 치환한다.
  writeFileSync(
    join(REPORT_DIR, `${context.ranAt.replaceAll(":", "-")}.json`),
    `${JSON.stringify(json, null, 2)}\n`,
    "utf8",
  );
}

function renderRunnerNotes(notes: readonly RunnerPhotoNote[]): string[] {
  if (notes.length === 0) return [];

  const unmeasured = notes.filter((note) => note.status !== "scored");
  const lines = ["러너 메모 · 사진 단위 실패와 알라딘 상태 (golden-report 가 표현하지 않는 것)"];

  if (unmeasured.length > 0) {
    lines.push(
      `  !! 재지 못한 사진 ${unmeasured.length}장 — 이 사진들의 기대 책은 재현율 분모에서 빠졌습니다.`,
      `     위 숫자는 세트 ${notes.length}장이 아니라 ${notes.length - unmeasured.length}장에 대한 답입니다.`,
    );
  }

  for (const note of notes) {
    lines.push(`  ${note.file}  ${describeNote(note)}`);
  }

  return lines;
}

function describeNote(note: RunnerPhotoNote): string {
  if (note.status === "scored") {
    const byReason = note.unidentifiedByReason;
    return (
      `후보 ${note.candidateCount} · 조회 ${note.lookedUpCount} · 확인 ${note.identifiedCount} · ` +
      `lookup_failed ${byReason?.lookup_failed ?? 0} · no_match ${byReason?.no_match ?? 0} · ` +
      `ambiguous ${byReason?.ambiguous ?? 0} · unreadable ${byReason?.unreadable ?? 0}`
    );
  }

  const reason =
    note.status === "extract_failed"
      ? `추출 실패(${note.extractFailureReason})`
      : note.status === "unsupported_type"
        ? "지원하지 않는 확장자"
        : "파일을 읽지 못함";

  return `재지 못함 — ${reason}${note.detail === undefined ? "" : ` · ${note.detail}`}`;
}

/* ------------------------------------------------------------------ *
 * 측정 — 사진 1장
 * ------------------------------------------------------------------ */

interface PhotoMeasurement {
  /** 재지 못했으면 `null`. 재현율 분모에서 빠진다 */
  score: GoldenPhotoScore | null;
  note: RunnerPhotoNote;
}

async function measurePhoto(
  dir: string,
  photo: GoldenPhoto,
  photoIndex: number,
): Promise<PhotoMeasurement> {
  const mime = MIME_BY_EXTENSION[extname(photo.file).toLowerCase()];
  if (mime === undefined) {
    return {
      score: null,
      note: {
        file: photo.file,
        status: "unsupported_type",
        detail: `허용 확장자: ${Object.keys(MIME_BY_EXTENSION).join(" · ")}`,
      },
    };
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(join(dir, photo.file));
  } catch (error) {
    return {
      score: null,
      note: { file: photo.file, status: "read_failed", detail: describeError(error) },
    };
  }

  // 본문은 여기서 끝난다 — 아래 어디에서도 데이터 URI 를 로그·리포트에 넣지 않는다.
  const extracted = await extractFromPhoto(`data:${mime};base64,${bytes.toString("base64")}`, {
    deadlineMs: EXTRACT_DEADLINE_MS,
    photoIndex,
  });

  if (extracted.status === "failed") {
    // 후보 0건으로 접지 않는다. refusal·timeout·upstream 은 판독 능력과 무관하다 (ADR-005).
    return {
      score: null,
      note: { file: photo.file, status: "extract_failed", extractFailureReason: extracted.reason },
    };
  }

  const lookup = await matchAgainstAladin(extracted.candidates);

  return {
    score: scorePhoto(photo, extracted.candidates, lookup.identified),
    note: {
      file: photo.file,
      status: "scored",
      candidateCount: extracted.candidates.length,
      lookedUpCount: lookup.lookedUpCount,
      identifiedCount: lookup.identified.length,
      unidentifiedByReason: lookup.byReason,
    },
  };
}

interface LookupSummary {
  identified: IdentifiedBook[];
  lookedUpCount: number;
  byReason: Record<UnidentifiedReason, number>;
}

/**
 * 후보를 알라딘과 대조해 확인 승격분을 모은다.
 *
 * 프로덕션과 **같은 잣대**로 돈다: 조회 전 축소(`reduceBeforeLookup` — 확신도 0.3
 * 미만 강등 + 사전 병합 + 80건 절단)를 그대로 쓰고, 판정은 `judge`가 한다. 여기서
 * 다른 규칙을 쓰면 골든이 통과해도 실제 판정은 다르게 난다.
 *
 * 조회는 **직렬**이다. 알라딘 일일 한도가 5,000회이고(TRD 6.1) 20장을 한꺼번에
 * 밀어 넣으면 한도와 레이트 리밋에 동시에 부딪히는데, 그 실패가 인식률 숫자로
 * 둔갑한다. 브레이커는 프로덕션과 같이 **요청(= 사진 1장) 스코프**로 만든다
 * (ADR-003 — 모듈 스코프에 두지 않는다).
 */
async function matchAgainstAladin(
  candidates: readonly ExtractedCandidate[],
): Promise<LookupSummary> {
  const { toLookup, unreadable } = reduceBeforeLookup(candidates);

  const identified: IdentifiedBook[] = [];
  const byReason: Record<UnidentifiedReason, number> = {
    unreadable: unreadable.length,
    no_match: 0,
    ambiguous: 0,
    lookup_failed: 0,
  };

  const breaker = createRequestBreaker();
  const deadlineAt = Date.now() + LOOKUP_DEADLINE_MS;

  for (const candidate of toLookup) {
    const outcome = await searchByTitle(candidate.title, candidate.author, {
      deadlineMs: deadlineAt - Date.now(),
      breaker,
    });

    const verdict = judge(candidate, outcome);
    if (verdict.kind === "identified") {
      identified.push(toIdentified(verdict.candidate, candidate.photoIndex));
    } else {
      // lookup_failed 를 no_match 로 만들지 않는다 — judge 가 가른 값을 그대로 나른다.
      // 확인되지 않은 것과 잘못 확인된 것은 다르므로, 이 책들은 오확인 판정의
      // 분자에도 분모에도 들어가지 않는다 (ADR-005 · TR-004).
      byReason[verdict.reason] += 1;
    }
  }

  return { identified, lookedUpCount: toLookup.length, byReason };
}

/**
 * 확인 승격분을 `IdentifiedBook` 모양으로 옮긴다.
 *
 * **사실을 지어내지 않는다.** 골든은 `ItemLookUp`을 부르지 않으므로(호출 수를
 * 두 배로 만들 이유가 없다 — 골든이 보는 것은 신원 필드뿐이다) `pages`·
 * `aladinRating`·`aladinLink`를 알 방법이 없고, 모르는 값을 그럴듯하게 채우는 것이
 * 이 제품이 가장 두려워하는 결함과 같은 종류다 (ADR-002). `proof`도 발급하지
 * 않는다 — 서명은 확인된 책이 **요청 경계를 넘을 때** 붙는 것이고(ADR-006) 이
 * 객체는 화면으로도 네트워크로도 나가지 않는다.
 *
 * `lib/golden-score.ts`가 오확인 판정에 쓰는 것은 `isbn13`과 `title`이고,
 * `lib/golden-report.ts`가 찍는 것은 여기에 `author`·`publisher`까지다 —
 * 넷 다 알라딘이 준 사실이다.
 */
function toIdentified(
  candidate: { isbn13: string; title: string; author: string; publisher: string; coverUrl: string },
  photoIndex: number,
): IdentifiedBook {
  return {
    ...candidate,
    pages: null,
    aladinRating: null,
    aladinLink: "",
    claudeNote: "",
    photoIndex,
    proof: "",
  };
}

/* ------------------------------------------------------------------ *
 * 실행
 * ------------------------------------------------------------------ */

const preparation = prepare();

if (preparation.status === "skipped") {
  // skip 도 기록이다. 콘솔과 리포트 파일 양쪽에 사유를 남긴다 (TRD 8번 skip 표).
  emitReport(
    { status: "skipped", reason: preparation.reason, detail: preparation.detail },
    buildContext(preparation.manifest),
    [],
  );
}

const ready = preparation.status === "ready" ? preparation : null;

describe.skipIf(ready === null)("골든 인식률 (실제 API 호출 · ADR-010)", () => {
  it("재현율이 기준 이상이고 오확인이 0건이다", async () => {
    if (ready === null) {
      // describe.skipIf 가 이미 막았으므로 닿지 않는다. 조용히 return 하면 그것이
      // 통과로 기록되므로 던진다 — skip 을 통과로 바꾸지 않기 위한 안전장치다.
      throw new Error("skip 조건인데 본문이 실행됐습니다");
    }

    const scores: GoldenPhotoScore[] = [];
    const notes: RunnerPhotoNote[] = [];

    // 직렬이다. 병렬로 밀어 넣으면 알라딘 한도·레이트 리밋에 부딪히고 그 실패가
    // 인식률 숫자로 둔갑한다 (vitest.golden.config.ts 의 fileParallelism: false 와 같은 이유).
    for (const [index, photo] of ready.manifest.photos.entries()) {
      const measurement = await measurePhoto(ready.dir, photo, index);
      notes.push(measurement.note);
      if (measurement.score !== null) scores.push(measurement.score);
    }

    const score = aggregateScores(scores);
    emitReport({ status: "scored", score }, buildContext(ready.manifest), notes);

    // 재지 못한 사진이 하나라도 있으면 이 런은 세트 전체에 대한 답이 아니다.
    // 그런데 aggregateScores 는 남은 사진만 보고 passed 를 낼 수 있고, 사람은 그
    // passed 를 배포 전 체크리스트에 적는다 — skip 이 통과가 아닌 것과 같은 이유로
    // 부분 측정도 통과가 아니다.
    const unmeasured = notes.filter((note) => note.status !== "scored");
    expect(
      unmeasured.map((note) => `${note.file}(${note.status})`),
      "재지 못한 사진이 있다 — 위 러너 메모의 사유를 고치고 다시 돌린다",
    ).toEqual([]);

    expect(
      score.passed,
      `재현율 ${score.recall.toFixed(3)} · 오확인 ${score.misidentifiedCount}건 — 위 리포트의 놓친 책·오확인 목록을 본다`,
    ).toBe(true);
  });
});
