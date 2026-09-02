/**
 * 골든 인식률 결과의 **표현** (ADR-010 · TRD 8번 "결과 기록", TRD 9번 배포 전 체크리스트).
 *
 * ## 순수 층이다
 * `fs`도 `services/`도 `process.env`도 모른다. 문자열과 객체를 돌려줄 뿐이고,
 * `reports/golden/{ISO}.json`에 실제로 쓰는 것은 `*.golden.test.ts`의 몫이다
 * (ADR-010 — 러너는 프로덕션 코드가 아니라 테스트 코드다). 이 분리가 있어야 출력을
 * **값으로** 검증할 수 있고, `npm test`가 돌 때마다 `reports/`에 쓰레기가 남지 않는다.
 *
 * ## 이 리포트가 지켜야 하는 것
 * 골든은 **감지 수단이 없는 가드레일의 유일한 감지 장치**다 (TRD 6.4 — 가짜 책이
 * 화면에 떠도 로그에는 정상 응답으로 남는다). 그리고 배포 전 체크리스트의
 * "골든을 돌렸는가"(TRD 9번)에 답하는 근거가 이 출력이다. 그래서:
 *
 * - **skip 은 통과가 아니다.** skip 리포트의 첫 줄은 재지 못했다는 사실과 사유이고,
 *   통과로 읽히는 표시(PASS·체크마크)를 쓰지 않는다. skip 한 리포트가 초록색이면
 *   사람이 돌렸다고 답하게 된다.
 * - **판정은 여기서 하지 않는다.** `passed`·`recall`·`misidentifiedCount`는
 *   `lib/golden-score.ts`가 계산한 값을 그대로 표시한다. 임계값과 다시 비교하면
 *   판정이 두 곳에 생기고, 한쪽만 고쳐지는 날이 온다. 다만 **기준값은 함께 보여준다**
 *   — 사람이 얼마나 모자란지 알아야 한다.
 * - **입력이 무엇이었는지 남긴다.** 세트는 버전 관리 밖에 있으므로(ADR-010)
 *   `setId`·`manifestVersion`·`photoHashes`·`extractModel`이 없으면 결과만 남고
 *   무엇을 쟀는지 모르는 상태가 된다.
 *
 * ## 콘솔용이다
 * 이 문자열은 브라우저가 아니라 터미널과 리다이렉트된 파일로 간다. `/docs/UI_GUIDE.md`는
 * 화면 규칙이라 여기 적용되지 않고, 색상 이스케이프도 넣지 않는다 — 파일에 들어간
 * ANSI 코드는 다음에 읽는 사람에게 잡음이다.
 */
import { GOLDEN_MAX_MISIDENTIFIED, GOLDEN_MIN_RECALL } from "./env";
import type { GoldenExpectedBook } from "./golden-manifest";
import type { GoldenPhotoScore, GoldenSetScore } from "./golden-score";
import type { IdentifiedBook } from "@/types/book";

/** JSON 리포트 형식 버전. 형태를 바꿀 때 올린다 */
export const GOLDEN_REPORT_VERSION = 1;

/**
 * 콘솔 목록 한 블록에 찍는 최대 항목 수.
 *
 * 20장짜리 세트가 전부 빗나가면 수백 줄이 되어 정작 맨 위의 판정이 스크롤 밖으로
 * 밀린다. 자르되 **잘랐다는 사실과 전체 건수를 반드시 남긴다** — 조용히 자르면
 * 그 아래가 없는 것이 된다. JSON 쪽은 자르지 않는다.
 */
export const MAX_LISTED_ITEMS = 10;

/** 골든이 돌지 못한 사유 (TRD 8번 skip 표) */
export type GoldenSkipReason = "no_set_dir" | "no_manifest" | "no_api_key";

/** 이 런이 무엇이었는가 — 잰 것이냐 못 잰 것이냐 */
export type GoldenOutcome =
  | { status: "scored"; score: GoldenSetScore }
  | { status: "skipped"; reason: GoldenSkipReason; detail: string };

/** 결과만 보고도 입력을 특정할 수 있게 하는 값들 (ADR-010) */
export interface GoldenRunContext {
  setId: string | null;
  manifestVersion: number | null;
  /** 사진 파일명 → sha256 */
  photoHashes: Record<string, string>;
  extractModel: string;
  ranAt: string; // ISO 8601
}

/* ------------------------------------------------------------------ *
 * skip 문구 — TRD 8번 skip 표를 사람이 읽는 문장으로 옮긴 것
 * ------------------------------------------------------------------ */

const SKIP_HEADLINES: Record<GoldenSkipReason, string> = {
  no_set_dir: "GOLDEN_SET_DIR 이 설정되지 않아 골든 세트를 찾지 못했습니다.",
  no_manifest: "세트 디렉토리에 manifest.json 이 없거나 형식이 계약을 어겼습니다.",
  no_api_key: "ANTHROPIC_API_KEY · ALADIN_TTB_KEY 가 없습니다.",
};

/**
 * 사유별로 사람이 할 일. 사유 코드만 찍으면 다음에 보는 사람이 무엇을 해야 하는지
 * 모른다 (`lookup_failed`와 `no_match`를 끝까지 다른 값으로 나르는 것과 같은 규율 — ADR-005).
 */
const SKIP_ACTIONS: Record<GoldenSkipReason, string> = {
  no_set_dir: "세트 디렉토리를 GOLDEN_SET_DIR 에 지정하고 다시 실행하세요.",
  no_manifest: "매니페스트를 고치거나(형식 오류) lib/golden-manifest.ts 를 올리세요(버전).",
  no_api_key: "실제 키를 넣고 다시 실행하세요. 키 없이 잰 수치는 근거가 되지 않습니다.",
};

/**
 * `no_api_key`만 위험 문구를 갖는다 — 세 사유 중 **유일하게 그럴듯한 숫자를 만들어 내는**
 * 사유이기 때문이다. 키가 없으면 `services/`가 목업 픽스처를 돌려주므로(TRD 9번),
 * 그대로 재면 재현율이 100% 로 나온다. 모델 품질을 재려던 게이트가 반대로 작동한다
 * (ADR-010). 사유 코드만 찍으면 다음에 보는 사람이 "키 없어도 돌아가네"라고 읽는다.
 */
const SKIP_DANGERS: Partial<Record<GoldenSkipReason, string>> = {
  no_api_key:
    "!! 키가 없으면 services/ 가 목업 픽스처를 돌려주므로, 이대로 재면 재현율이 100% 로 나옵니다. " +
    "모델 품질을 재려던 게이트가 정반대로 작동하는 자리입니다 (ADR-010).",
};

/* ------------------------------------------------------------------ *
 * 콘솔 표
 * ------------------------------------------------------------------ */

/**
 * 콘솔에 찍을 사람용 표.
 *
 * 폭은 터미널 기준 80칸 안팎으로 잡는다. 정렬을 맞추는 열(파일명·숫자)은 전부
 * ASCII 이고, 한글이 들어가는 제목·저자는 표가 아니라 목록에 둔다 — 한글은 터미널에서
 * 두 칸을 차지하므로 `padEnd`로 맞춘 열에 섞으면 정렬이 어긋난다.
 */
export function renderGoldenReport(outcome: GoldenOutcome, context: GoldenRunContext): string {
  const lines =
    outcome.status === "skipped" ? renderSkip(outcome.reason, outcome.detail) : renderScored(outcome.score);

  return [...lines, "", ...renderContext(context)].join("\n");
}

function renderSkip(reason: GoldenSkipReason, detail: string): string[] {
  const lines = [
    // 첫 줄이다. 여기서 "재지 못했다"를 말하지 않으면 나머지는 읽히지 않는다.
    `[골든 인식률] 재지 못했습니다 — skip: ${reason}`,
  ];

  const danger = SKIP_DANGERS[reason];
  if (danger !== undefined) {
    lines.push(danger);
  }

  lines.push(`사유: ${SKIP_HEADLINES[reason]}`);
  if (detail !== "") {
    lines.push(`상세: ${detail}`);
  }
  lines.push(`할 일: ${SKIP_ACTIONS[reason]}`);
  lines.push(
    `기준: 재현율 ${formatRecall(GOLDEN_MIN_RECALL)} 이상 · 오확인 ${GOLDEN_MAX_MISIDENTIFIED}건 — 이번 런은 두 축 모두 재지 않았습니다.`,
  );

  return lines;
}

function renderScored(score: GoldenSetScore): string[] {
  const verdict = score.passed ? "PASS" : "FAIL";
  const lines = [
    `[골든 인식률] ${verdict}`,
    `재현율 ${formatRecall(score.recall)} (기준 ${formatRecall(GOLDEN_MIN_RECALL)}) · ` +
      `매칭 ${score.matchedCount}/${score.expectedCount}건`,
    `오확인 ${score.misidentifiedCount}건 (기준 ${GOLDEN_MAX_MISIDENTIFIED}건)`,
    "",
    ...renderPhotoTable(score.photos),
  ];

  const missed = collectMissed(score.photos);
  if (missed.length > 0) {
    lines.push("", ...renderMissed(missed));
  }

  const misidentified = collectMisidentified(score.photos);
  if (misidentified.length > 0) {
    lines.push("", ...renderMisidentified(misidentified));
  }

  return lines;
}

function renderPhotoTable(photos: readonly GoldenPhotoScore[]): string[] {
  const fileWidth = Math.max(4, ...photos.map((photo) => displayWidth(photo.file)));
  const header = `${padColumn("파일", fileWidth)}  기대  매칭   재현율  오확인`;

  return [
    "사진별 판정",
    `  ${header}`,
    ...photos.map(
      (photo) =>
        `  ${padColumn(photo.file, fileWidth)}  ${pad(photo.expectedCount, 4)}  ${pad(photo.matchedCount, 4)}  ` +
        `${formatRecall(photo.recall).padStart(6)}  ${pad(photo.misidentified.length, 6)}`,
    ),
  ];
}

/** 놓친 책 1건 — 사진과 기대 항목을 함께 들고 다닌다 */
interface MissedEntry {
  file: string;
  book: GoldenExpectedBook;
}

function collectMissed(photos: readonly GoldenPhotoScore[]): MissedEntry[] {
  return photos.flatMap((photo) =>
    photo.matches
      .filter((match) => match.matched === null)
      .map((match) => ({ file: photo.file, book: match.expected })),
  );
}

/**
 * 숫자만 있으면 사람이 할 일이 없다. 어느 사진의 어떤 책이 안 읽혔는지가 있어야
 * 추출 프롬프트를 고칠 수 있다 (TRD 6.4 — 판단 근거는 남긴다).
 */
function renderMissed(entries: readonly MissedEntry[]): string[] {
  return renderList(
    `놓친 책 · 기대 목록에 있으나 추출 후보와 짝지어지지 않음 — ${entries.length}건`,
    entries,
    (entry) => `${entry.file}  ${entry.book.title} / ${entry.book.author}`,
  );
}

/** 오확인 1건 */
interface MisidentifiedEntry {
  file: string;
  book: IdentifiedBook;
}

function collectMisidentified(photos: readonly GoldenPhotoScore[]): MisidentifiedEntry[] {
  return photos.flatMap((photo) =>
    photo.misidentified.map((book) => ({ file: photo.file, book })),
  );
}

/**
 * 오확인 목록.
 *
 * 여기 찍히는 제목·저자·ISBN13 은 **알라딘이 준 사실**이다. 우리가 만든 추정(제목
 * 유사도)을 같은 층위로 섞지 않는다 — 블록 제목에 출처를 밝히고, 유사도 점수는
 * 이 목록에 넣지 않는다 (ADR-002 · CLAUDE.md 출처 분리).
 */
function renderMisidentified(entries: readonly MisidentifiedEntry[]): string[] {
  return renderList(
    `오확인 · 확인으로 승격됐으나 기대 목록에 없음 — ${entries.length}건 [알라딘 사실: ISBN13 / 제목 / 저자]`,
    entries,
    (entry) => `${entry.file}  ${entry.book.isbn13}  ${entry.book.title} / ${entry.book.author}`,
  );
}

/**
 * 목록 블록 하나. 길면 자르되 **잘린 건수와 전체 건수를 남긴다**.
 * 조용히 자르면 그 아래가 없는 것이 되고, 그러면 리포트가 사실을 숨긴 것이 된다.
 */
function renderList<T>(title: string, entries: readonly T[], format: (entry: T) => string): string[] {
  const shown = entries.slice(0, MAX_LISTED_ITEMS);
  const lines = [title, ...shown.map((entry) => `  ${format(entry)}`)];

  const hidden = entries.length - shown.length;
  if (hidden > 0) {
    lines.push(`  … 그 밖 ${hidden}건은 표시를 생략했습니다 (전체 ${entries.length}건, JSON 리포트에는 전부 있습니다)`);
  }

  return lines;
}

/**
 * 실행 맥락. **skip 리포트에도 붙인다** — 어떤 환경에서 못 쟀는지가 남아야 다음 사람이
 * 같은 조건을 재현하거나 고칠 수 있다.
 *
 * 해시는 자르지 않고 전문을 찍는다. 세트가 버전 관리 밖에 있어(ADR-010) 두 리포트를
 * 나란히 놓고 "같은 입력을 쟀는가"를 답할 유일한 수단이다.
 */
function renderContext(context: GoldenRunContext): string[] {
  const files = Object.keys(context.photoHashes).sort();
  const lines = [
    "실행 맥락",
    `  세트: ${context.setId ?? "(알 수 없음)"} · 매니페스트 형식 v${context.manifestVersion ?? "?"}`,
    `  추출 모델: ${context.extractModel}`,
    `  실행 시각: ${context.ranAt}`,
  ];

  if (files.length > 0) {
    lines.push("  사진 sha256");
    for (const file of files) {
      lines.push(`    ${file}  ${context.photoHashes[file]}`);
    }
  }

  return lines;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width);
}

/**
 * 한글·한자·가나는 터미널에서 **두 칸**을 차지한다. `padEnd`는 코드 포인트를 세므로
 * 그대로 쓰면 한글이 섞인 열의 정렬이 어긋난다 — 표 머리글("파일")이 바로 그 경우다.
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += isWide(char) ? 2 : 1;
  }
  return width;
}

function isWide(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f) || // 한글 자모
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK 부수 ~ 이(Yi)
    (code >= 0xac00 && code <= 0xd7a3) || // 한글 음절
    (code >= 0xf900 && code <= 0xfaff) || // CJK 호환 한자
    (code >= 0xff00 && code <= 0xff60) // 전각 형태
  );
}

function padColumn(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/** 재현율은 소수 셋째 자리까지. 기준값과 나란히 놓고 눈으로 빼기 위함이다 */
function formatRecall(value: number): string {
  return value.toFixed(3);
}

/* ------------------------------------------------------------------ *
 * JSON 리포트
 * ------------------------------------------------------------------ */

/**
 * `reports/golden/{ISO}.json`에 쓸 기계용 객체. **파일로 쓰는 것은 여기가 아니다.**
 *
 * 콘솔 표와 달리 목록을 자르지 않는다 — 사람이 스크롤하는 출력이 아니라 나중에
 * 대조하는 기록이기 때문이다. `passed`는 skip 일 때 `null`이다: `false`로 두면
 * "재서 떨어졌다"와 "재지 않았다"가 같은 값이 되고, 그것이 이 리포트가 가장 하지
 * 말아야 할 일이다.
 */
export function toGoldenReportJson(outcome: GoldenOutcome, context: GoldenRunContext): unknown {
  const common = {
    schema: "shelfie.golden-report",
    reportVersion: GOLDEN_REPORT_VERSION,
    context,
    thresholds: {
      minRecall: GOLDEN_MIN_RECALL,
      maxMisidentified: GOLDEN_MAX_MISIDENTIFIED,
    },
  };

  if (outcome.status === "skipped") {
    return {
      ...common,
      status: "skipped" as const,
      passed: null,
      skip: {
        reason: outcome.reason,
        detail: outcome.detail,
        headline: SKIP_HEADLINES[outcome.reason],
        danger: SKIP_DANGERS[outcome.reason] ?? null,
      },
    };
  }

  const { score } = outcome;

  return {
    ...common,
    status: "scored" as const,
    passed: score.passed,
    totals: {
      expectedCount: score.expectedCount,
      matchedCount: score.matchedCount,
      recall: score.recall,
      misidentifiedCount: score.misidentifiedCount,
    },
    photos: score.photos.map((photo) => ({
      file: photo.file,
      expectedCount: photo.expectedCount,
      matchedCount: photo.matchedCount,
      recall: photo.recall,
      missed: photo.matches.filter((match) => match.matched === null).map((match) => match.expected),
      misidentified: photo.misidentified.map((book) => ({
        // 알라딘 사실만 싣는다. claudeNote·proof 는 이 기록의 관심사가 아니다
        isbn13: book.isbn13,
        title: book.title,
        author: book.author,
        publisher: book.publisher,
      })),
    })),
  };
}
