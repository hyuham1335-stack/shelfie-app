/**
 * 추천 결과 저장 이미지 — **레이아웃 층** (FR-014, ADR-009, UI_GUIDE "저장 이미지").
 *
 * ## 이 파일은 두 겹으로 갈라진다
 * 여기는 그중 위층이다. 좌표·줄바꿈·잘림·캔버스 크기를 결정해 **드로잉 명령 목록**을
 * 돌려주는 순수 함수만 있고, `document`·`HTMLCanvasElement`·`toBlob`을 만지지 않는다.
 * 명령을 실제 `CanvasRenderingContext2D`에 적용하는 얇은 그리기 층은 같은 파일에
 * 뒤이어 붙는다.
 *
 * ## 왜 가르는가
 * 이 리포의 테스트는 jsdom에서 돌고 **jsdom에는 canvas 구현이 없다.** 판단과 그리기가
 * 한 덩어리면 "테스트를 먼저 쓴다"(CLAUDE.md CRITICAL)가 성립하지 않는다. 성립시키는
 * 길은 `canvas` 네이티브 패키지를 넣거나(새 의존성) 판단을 캔버스 밖으로 빼거나 둘
 * 뿐이고, ADR-009가 후자를 택했다. 그래서 이 층은 값을 넣으면 값이 나오는 평범한
 * 함수이며 좌표를 단정으로 고정할 수 있다.
 *
 * ## 폭을 직접 계산하지 않는다
 * 캔버스는 CSS 폰트 스택을 쓰지 않고, 한글 글꼴은 로딩 시점에 따라 글자 폭이 달라진다.
 * 글자 수 × 상수로 재면 화면마다 다른 곳에서 잘린다. 그래서 폭은 **주입받은 측정
 * 함수**로만 잰다 — 그리기 층이 `ctx.measureText`를 넘기고, 테스트는 고정 폭 측정기를
 * 끼운다. 이것이 이 층이 순수 함수일 수 있는 유일한 조건이다.
 *
 * ## 사실과 해석의 경계는 그림에서도 유지된다
 * 알라딘에서 온 사실(제목·저자·출판사)과 Claude가 쓴 추천 이유를 **다른 시각 층위**로
 * 그린다. 화면에서 지키는 경계가 밖으로 나가는 그림에서 무너지면, 그 그림은 우리 손을
 * 떠나 사실로 유통된다 (ADR-002, UI_GUIDE "저장 이미지").
 *
 * 만든 이미지는 클라이언트에만 존재하고 서버로 보내지 않는다 (ADR-003, 보관 기간 0).
 */
import { MAX_RECOMMENDATIONS } from "./env";

/* ------------------------------------------------------------------ *
 * 렌더 규격
 *
 * 이 값들은 도메인 상한이 아니라 **이 모듈의 렌더 규격**이라 `lib/env.ts`에 두지
 * 않는다. `env.ts`는 "권수·장수·크기·횟수 상한"의 자리이고, 환경변수로 좁힐 수
 * 있는 값의 자리다. 캔버스 여백은 둘 다 아니다.
 *
 * 반대로 **추천 권수 상한은 여기 적지 않는다** — `MAX_RECOMMENDATIONS`가 이미 그
 * 값의 단일 출처다. 같은 값이 두 곳에 생기면 한쪽만 고쳐지는 날이 온다.
 * ------------------------------------------------------------------ */

/** 캔버스 고정 폭 (UI_GUIDE 저장 이미지 표). 화면 레이아웃을 그대로 옮기지 않는다 */
export const SHARE_IMAGE_WIDTH = 1080;

const PADDING_X = 64;
const PADDING_TOP = 64;
const PADDING_BOTTOM = 48;

const COVER_WIDTH = 160;
const COVER_HEIGHT = 240;
/** 표지와 글 사이 간격 */
const COVER_GAP = 32;

/** 책 사이 세로 간격 */
const BOOK_GAP = 48;

const POSITION_LINE_HEIGHT = 34;
const TITLE_LINE_HEIGHT = 52;
const TITLE_MAX_LINES = 2;
const META_LINE_HEIGHT = 40;

/** 사실 줄과 추천 이유 블록 사이 간격 */
const REASON_TOP_GAP = 24;
/** 이유 블록 왼쪽 세로선 (UI_GUIDE: Claude 생성 텍스트 블록의 border-l-2) */
const REASON_RULE_WIDTH = 4;
/** 세로선과 본문 사이 들여쓰기 (UI_GUIDE: pl-3) */
const REASON_RULE_GAP = 16;
const REASON_LABEL_LINE_HEIGHT = 30;
const REASON_LINE_HEIGHT = 40;
const REASON_MAX_LINES = 4;

const WATERMARK_GAP = 40;
const WATERMARK_LINE_HEIGHT = 32;

/** 글 기둥의 왼쪽 기준선. 사실도 이유 세로선도 여기서 시작한다 */
const TEXT_X = PADDING_X + COVER_WIDTH + COVER_GAP;
const TEXT_WIDTH = SHARE_IMAGE_WIDTH - TEXT_X - PADDING_X;
const REASON_TEXT_X = TEXT_X + REASON_RULE_WIDTH + REASON_RULE_GAP;
const REASON_TEXT_WIDTH = SHARE_IMAGE_WIDTH - REASON_TEXT_X - PADDING_X;

/** UI_GUIDE 색상표. 캔버스는 CSS 변수를 읽지 못하므로 값으로 적는다 */
const COLOR_PAGE = "#FAF9F7";
const COLOR_INK = "#1A1A1A";
const COLOR_BODY = "#3D3A36";
const COLOR_SUBTLE = "#6B6560";
const COLOR_DISABLED = "#8C8681";
const COLOR_MUTED_SURFACE = "#F5F2ED";
/** 액센트 딥그린 40% — 이유 블록의 세로선. 그라데이션·글로우는 안티패턴이다 */
const COLOR_ACCENT_RULE = "rgba(47, 93, 80, 0.4)";

/**
 * 글꼴. 캔버스는 CSS 폰트 스택을 쓰지 않으므로 여기서 정한 것이 전부이고,
 * 그래서 폭 계산을 `measure`에 맡긴다 (위 주석 참조).
 */
const FONT_POSITION = "400 22px sans-serif";
const FONT_TITLE = "600 40px sans-serif";
const FONT_META = "400 28px sans-serif";
const FONT_REASON_LABEL = "400 20px sans-serif";
const FONT_REASON = "italic 400 26px sans-serif";
const FONT_COVER_FALLBACK = "400 72px sans-serif";
const FONT_WATERMARK = "400 22px sans-serif";

const ELLIPSIS = "…";
const WATERMARK_TEXT = "Shelfie";

/* ------------------------------------------------------------------ *
 * 공개 타입
 * ------------------------------------------------------------------ */

/**
 * 저장 이미지에 그릴 책 한 권.
 *
 * 화면 타입(`AladinFacts`·`Recommendation`)을 그대로 받지 않고 필요한 것만 좁힌다 —
 * 좁혀 두면 `claudeNote` 같은 다른 생성 필드가 이 층에 흘러들어올 수 없다.
 */
export interface ShareImageBook {
  title: string;
  author: string;
  publisher: string;
  /** 알라딘 표지 절대 URL. 빈 문자열이면 불러올 것이 없다는 뜻이다 */
  coverUrl: string;
  /** Claude가 쓴 추천 이유 — 사실이 아니다 (ADR-002) */
  reason: string;
  position: 1 | 2 | 3;
}

/** 채워진 사각형. 배경·세로선·표지 폴백 블록이 전부 이것이다 */
export interface RectCommand {
  kind: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

/** 글자 한 줄. `y`는 **베이스라인**이고 줄바꿈은 이미 끝나 있다 */
export interface TextCommand {
  kind: "text";
  x: number;
  y: number;
  text: string;
  font: string;
  color: string;
}

/**
 * 표지 한 장.
 *
 * `fallback`에 **표지를 못 그렸을 때의 명령이 미리 실려 있다.** 그리기 층은 이미지
 * 로드에 실패해도 레이아웃을 다시 계산하지 않고 이 목록을 그대로 실행하면 된다 —
 * 표지 실패로 저장 자체가 취소되지 않는 것이 여기서 더 중요하다 (ADR-009).
 * `src`가 빈 문자열이면 불러올 것이 없으므로 곧바로 `fallback`을 그린다.
 */
export interface CoverCommand {
  kind: "cover";
  x: number;
  y: number;
  width: number;
  height: number;
  src: string;
  fallback: readonly (RectCommand | TextCommand)[];
}

/** 그리기 층이 그대로 실행할 명령. 판단은 전부 여기 들어오기 전에 끝나 있다 */
export type DrawCommand = RectCommand | TextCommand | CoverCommand;

/** 글자 폭 측정기. 그리기 층이 `ctx.measureText`를 넘긴다 */
export type MeasureText = (text: string, font: string) => number;

export interface ShareImageLayout {
  width: number;
  height: number;
  commands: readonly DrawCommand[];
}

/* ------------------------------------------------------------------ *
 * 글자 자르기·줄바꿈
 *
 * 공백이 아니라 **글자 단위**로 끊는다. 한국어 제목·추천 이유는 어절 사이 공백이
 * 없는 구간이 길어 단어 단위 줄바꿈으로는 한 줄이 통째로 넘치는 일이 흔하다.
 * ------------------------------------------------------------------ */

/** 폭에 맞을 때까지 뒤에서 잘라 내고 반드시 `…`로 끝낸다 */
function ellipsize(
  text: string,
  font: string,
  maxWidth: number,
  measure: MeasureText,
): string {
  const chars = Array.from(text);
  let cut = chars.length;

  while (cut > 0 && measure(chars.slice(0, cut).join("") + ELLIPSIS, font) > maxWidth) {
    cut -= 1;
  }

  return chars.slice(0, cut).join("") + ELLIPSIS;
}

/** 한 줄에 넣는다. 넘치면 `…`로 자른다 */
function fitOneLine(
  text: string,
  font: string,
  maxWidth: number,
  measure: MeasureText,
): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  if (measure(trimmed, font) <= maxWidth) return trimmed;
  return ellipsize(trimmed, font, maxWidth, measure);
}

/** 폭에 맞춰 전부 쪼갠다 */
function wrapAll(
  text: string,
  font: string,
  maxWidth: number,
  measure: MeasureText,
): string[] {
  const lines: string[] = [];
  let current = "";

  for (const char of Array.from(text)) {
    if (char === "\n") {
      lines.push(current);
      current = "";
      continue;
    }

    const next = current + char;
    // 한 글자가 폭보다 넓은 퇴화 케이스에서도 무한히 빈 줄을 만들지 않는다
    if (current !== "" && measure(next, font) > maxWidth) {
      lines.push(current);
      current = char;
    } else {
      current = next;
    }
  }

  lines.push(current);
  return lines;
}

/** 최대 줄 수까지만 남기고, 잘려 나간 내용이 있으면 마지막 줄을 `…`로 끝낸다 */
function wrapToLines(
  text: string,
  font: string,
  maxWidth: number,
  maxLines: number,
  measure: MeasureText,
): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  const all = wrapAll(trimmed, font, maxWidth, measure);
  if (all.length <= maxLines) return all;

  const kept = all.slice(0, maxLines);
  kept[maxLines - 1] = ellipsize(kept[maxLines - 1], font, maxWidth, measure);
  return kept;
}

/* ------------------------------------------------------------------ *
 * 레이아웃
 * ------------------------------------------------------------------ */

/** 표지 폴백 — 제목 첫 글자를 `#F5F2ED` 블록 위에 가운데로 둔다 (UI_GUIDE 레이아웃) */
function buildCoverFallback(
  title: string,
  x: number,
  y: number,
  measure: MeasureText,
): readonly (RectCommand | TextCommand)[] {
  const block: RectCommand = {
    kind: "rect",
    x,
    y,
    width: COVER_WIDTH,
    height: COVER_HEIGHT,
    color: COLOR_MUTED_SURFACE,
  };

  const letter = title.trim().slice(0, 1);
  if (letter === "") return [block];

  const letterWidth = measure(letter, FONT_COVER_FALLBACK);

  return [
    block,
    {
      kind: "text",
      x: x + (COVER_WIDTH - letterWidth) / 2,
      // 베이스라인을 블록 중앙보다 조금 아래로 내려 시각적 중앙에 맞춘다
      y: y + COVER_HEIGHT / 2 + 24,
      text: letter,
      font: FONT_COVER_FALLBACK,
      color: COLOR_SUBTLE,
    },
  ];
}

/** 책 한 권을 그리고 다음 책이 시작할 y를 돌려준다 */
function layoutBook(
  book: ShareImageBook,
  top: number,
  measure: MeasureText,
  out: DrawCommand[],
): number {
  out.push({
    kind: "cover",
    x: PADDING_X,
    y: top,
    width: COVER_WIDTH,
    height: COVER_HEIGHT,
    src: book.coverUrl,
    fallback: buildCoverFallback(book.title, PADDING_X, top, measure),
  });

  let y = top;

  // 사실 층 — 화면과 같은 위계(제목 ink · 저자·출판사 body)를 그대로 옮긴다
  y += POSITION_LINE_HEIGHT;
  out.push({
    kind: "text",
    x: TEXT_X,
    y,
    text: `추천 ${book.position}`,
    font: FONT_POSITION,
    color: COLOR_SUBTLE,
  });

  for (const line of wrapToLines(book.title, FONT_TITLE, TEXT_WIDTH, TITLE_MAX_LINES, measure)) {
    y += TITLE_LINE_HEIGHT;
    out.push({ kind: "text", x: TEXT_X, y, text: line, font: FONT_TITLE, color: COLOR_INK });
  }

  for (const value of [book.author, book.publisher]) {
    const line = fitOneLine(value, FONT_META, TEXT_WIDTH, measure);
    if (line === "") continue;
    y += META_LINE_HEIGHT;
    out.push({ kind: "text", x: TEXT_X, y, text: line, font: FONT_META, color: COLOR_BODY });
  }

  // 표지가 글보다 길면 표지 아래가 기준이 된다
  const rowBottom = Math.max(top + COVER_HEIGHT, y);

  const reasonLines = wrapToLines(
    book.reason,
    FONT_REASON,
    REASON_TEXT_WIDTH,
    REASON_MAX_LINES,
    measure,
  );

  // 이유가 없으면 라벨도 세로선도 그리지 않는다 — 없는 해석을 빈 블록으로 지어내지 않는다
  if (reasonLines.length === 0) {
    return rowBottom;
  }

  const reasonTop = rowBottom + REASON_TOP_GAP;
  const reasonHeight = REASON_LABEL_LINE_HEIGHT + reasonLines.length * REASON_LINE_HEIGHT;

  // 해석 층 — 세로선 + 들여쓰기 + 보조 톤 + 라벨. 이 넷이 사실과 가르는 장치다 (ADR-002)
  out.push({
    kind: "rect",
    x: TEXT_X,
    y: reasonTop,
    width: REASON_RULE_WIDTH,
    height: reasonHeight,
    color: COLOR_ACCENT_RULE,
  });

  let reasonY = reasonTop + REASON_LABEL_LINE_HEIGHT;
  out.push({
    kind: "text",
    x: REASON_TEXT_X,
    y: reasonY,
    text: "추천 이유",
    font: FONT_REASON_LABEL,
    color: COLOR_DISABLED,
  });

  for (const line of reasonLines) {
    reasonY += REASON_LINE_HEIGHT;
    out.push({
      kind: "text",
      x: REASON_TEXT_X,
      y: reasonY,
      text: line,
      font: FONT_REASON,
      color: COLOR_SUBTLE,
    });
  }

  return reasonTop + reasonHeight;
}

/**
 * 추천 결과를 저장 이미지의 드로잉 명령으로 옮긴다.
 *
 * **높이는 내용이 정한다.** 고정 높이로 자르면 1권일 때 아래가 비고 3권일 때 잘린다.
 * 그래서 배경 사각형은 모든 책을 배치한 뒤 마지막에 앞으로 끼워 넣는다.
 *
 * 책이 0권이어도 던지지 않는다 — 저장은 화면의 부가 동작이고, 예외로 화면 상태를
 * 바꾸지 않는 것이 UI_GUIDE가 정한 실패 규율이다.
 */
export function buildShareImageLayout(
  books: readonly ShareImageBook[],
  measure: MeasureText,
): ShareImageLayout {
  const commands: DrawCommand[] = [];

  // 추천 권수 상한은 FR-006의 값 하나뿐이다. 리터럴로 다시 적지 않는다
  const drawn = books.slice(0, MAX_RECOMMENDATIONS);

  let y = PADDING_TOP;
  drawn.forEach((book, index) => {
    if (index > 0) y += BOOK_GAP;
    y = layoutBook(book, y, measure, commands);
  });

  if (drawn.length > 0) {
    y += WATERMARK_GAP;
  }

  y += WATERMARK_LINE_HEIGHT;
  commands.push({
    kind: "text",
    x: PADDING_X,
    y,
    text: WATERMARK_TEXT,
    font: FONT_WATERMARK,
    color: COLOR_DISABLED,
  });

  const height = y + PADDING_BOTTOM;

  return {
    width: SHARE_IMAGE_WIDTH,
    height,
    commands: [
      { kind: "rect", x: 0, y: 0, width: SHARE_IMAGE_WIDTH, height, color: COLOR_PAGE },
      ...commands,
    ],
  };
}

/* ================================================================== *
 * 그리기 층
 *
 * 여기는 **판단하지 않는다.** 좌표·줄바꿈·잘림·캔버스 크기는 위층이 이미 정했고,
 * 이 층이 하는 일은 명령 목록을 받은 순서대로 `CanvasRenderingContext2D`에 옮기는
 * 것뿐이다. 여기서 `if`로 위치를 조정하기 시작하면 그 판단은 jsdom이 검사할 수 없는
 * 곳으로 옮겨간 것이고, 두 겹으로 가른 이유가 사라진다 (ADR-009).
 *
 * 만든 `Blob`은 값으로만 돌려준다 — 서버로 보내지도 저장하지도 않는다
 * (ADR-003, 보관 기간 0). 다운로드 배선은 이 파일 밖의 일이다.
 * ================================================================== */

/**
 * 그리기에 필요한 바깥 세계 둘. 기본값은 브라우저의 것이고, 테스트는 여기에
 * 가짜를 끼운다 — jsdom에는 canvas 구현이 없으므로 이 주입 지점이 없으면
 * 이 층은 한 줄도 검사할 수 없다.
 */
export interface RenderShareImageOptions {
  /** 캔버스를 만드는 방법. 기본은 `document.createElement("canvas")` */
  createCanvas?: () => HTMLCanvasElement;
  /** 표지 한 장을 불러온다. 실패하면 reject 또는 `null` — 어느 쪽이든 저장은 계속된다 */
  loadImage?: (src: string) => Promise<CanvasImageSource | null>;
}

const BLOB_TYPE = "image/png";

function createDefaultCanvas(): HTMLCanvasElement {
  return document.createElement("canvas");
}

/**
 * 저장용 표지를 **화면의 `<img>`와 별도로** 받는다.
 *
 * 화면의 `BookCover`에 `crossOrigin="anonymous"`를 붙이면 CORS 헤더를 주지 않는
 * 호스트의 표지가 그 순간부터 화면에서도 안 뜬다 — 지금 잘 뜨는 표지를 저장 기능
 * 때문에 잃는 것은 명백한 회귀다. 반대로 `crossOrigin` 없이 그린 이미지는 캔버스를
 * 오염시켜 `toBlob`이 SecurityError로 죽는다. 그래서 저장용은 따로 받는 것 말고
 * 다른 답이 없다 (ADR-009).
 *
 * 실패를 던지지 않고 `null`로 돌려준다 — 표지는 이 그림의 목적이 아니다.
 */
function loadCoverImage(src: string): Promise<CanvasImageSource | null> {
  return new Promise((resolve) => {
    const image = new Image();
    // src보다 먼저 세워야 한다. 뒤에 세우면 이미 시작된 요청에 적용되지 않는다
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/**
 * 표지를 **함께** 기다린다. 한 장씩 순차로 기다리면 저장이 눈에 띄게 느려지고,
 * 한 장의 실패가 나머지를 무너뜨려서도 안 된다 — 그래서 실패를 개별로 삼킨다.
 * 같은 URL은 한 번만 받는다.
 */
async function loadCovers(
  commands: readonly DrawCommand[],
  loadImage: (src: string) => Promise<CanvasImageSource | null>,
): Promise<Map<string, CanvasImageSource>> {
  const sources = new Set<string>();
  for (const command of commands) {
    // 빈 문자열은 불러올 것이 없다는 뜻이다 — 요청조차 만들지 않는다
    if (command.kind === "cover" && command.src !== "") sources.add(command.src);
  }

  const results = await Promise.all(
    Array.from(sources, async (src) => {
      try {
        return [src, await loadImage(src)] as const;
      } catch {
        return [src, null] as const;
      }
    }),
  );

  const loaded = new Map<string, CanvasImageSource>();
  for (const [src, image] of results) {
    if (image !== null) loaded.set(src, image);
  }
  return loaded;
}

/** 명령 하나를 옮긴다. 분기는 명령 종류와 "표지를 얻었는가" 둘뿐이다 */
function applyCommand(
  ctx: CanvasRenderingContext2D,
  command: DrawCommand,
  covers: ReadonlyMap<string, CanvasImageSource>,
): void {
  if (command.kind === "rect") {
    ctx.fillStyle = command.color;
    ctx.fillRect(command.x, command.y, command.width, command.height);
    return;
  }

  if (command.kind === "text") {
    ctx.font = command.font;
    ctx.fillStyle = command.color;
    ctx.fillText(command.text, command.x, command.y);
    return;
  }

  const image = command.src === "" ? undefined : covers.get(command.src);
  if (image === undefined) {
    // 폴백은 위층이 미리 실어 보냈다. 레이아웃을 다시 계산하지 않는다
    for (const fallback of command.fallback) applyCommand(ctx, fallback, covers);
    return;
  }

  ctx.drawImage(image, command.x, command.y, command.width, command.height);
}

/** `toBlob`이 `null`이면 실패다 — 절반만 그려진 캔버스를 성공으로 돌려주지 않는다 */
function toPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("저장 이미지를 PNG로 인코딩하지 못했습니다"));
        return;
      }
      resolve(blob);
    }, BLOB_TYPE);
  });
}

/**
 * 추천 결과를 PNG `Blob` 한 장으로 그린다 (FR-014).
 *
 * 폭 측정기로 `ctx.measureText`를 넘겨 **실제 글꼴 폭**으로 줄바꿈·잘림이 정해지게
 * 한다. 표지는 따로 받고, 못 얻은 책은 위층이 실어 보낸 폴백으로 그린 뒤 계속
 * 진행한다 — 표지 때문에 저장이 실패하지 않는 것이 여기서 더 중요하다.
 */
export async function renderShareImage(
  books: readonly ShareImageBook[],
  options: RenderShareImageOptions = {},
): Promise<Blob> {
  const canvas = (options.createCanvas ?? createDefaultCanvas)();
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("캔버스 2d 컨텍스트를 얻지 못했습니다");
  }

  const measure: MeasureText = (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };

  const layout = buildShareImageLayout(books, measure);
  canvas.width = layout.width;
  canvas.height = layout.height;

  const covers = await loadCovers(layout.commands, options.loadImage ?? loadCoverImage);

  for (const command of layout.commands) applyCommand(ctx, command, covers);

  return toPngBlob(canvas);
}
