/**
 * 저장 이미지 레이아웃 층 테스트 (FR-014, ADR-009).
 *
 * 이 파일은 **jsdom 없이도 통과해야 한다.** `document`·`HTMLCanvasElement`를 한 번도
 * 만지지 않으며, 글자 폭은 고정 측정기로 주입한다 — 그래서 좌표를 값으로 단정할 수
 * 있다. 그것이 레이아웃과 그리기를 가른 이유 전부다.
 */
import { describe, expect, it } from "vitest";
import { MAX_RECOMMENDATIONS } from "./env";
import {
  buildShareImageLayout,
  SHARE_IMAGE_WIDTH,
  type DrawCommand,
  type MeasureText,
  type ShareImageBook,
} from "./share-image";

/** 글자당 10px. 폭이 결정적이어야 좌표를 단정할 수 있다 */
const CHAR_WIDTH = 10;

function fixedMeasure(): { measure: MeasureText; calls: Array<{ text: string; font: string }> } {
  const calls: Array<{ text: string; font: string }> = [];
  return {
    calls,
    measure: (text, font) => {
      calls.push({ text, font });
      return Array.from(text).length * CHAR_WIDTH;
    },
  };
}

function book(overrides: Partial<ShareImageBook> = {}): ShareImageBook {
  return {
    title: "미움받을 용기",
    author: "기시미 이치로",
    publisher: "인플루엔셜",
    coverUrl: "https://image.aladin.co.kr/cover/1.jpg",
    reason: "지금 지쳐 있다면 이 책의 대화체가 부담 없이 읽힙니다.",
    position: 1,
    ...overrides,
  };
}

function texts(commands: readonly DrawCommand[]): string[] {
  return commands.filter((c) => c.kind === "text").map((c) => c.text);
}

describe("buildShareImageLayout — 규격", () => {
  it("폭은 UI_GUIDE가 정한 1080px 고정이다", () => {
    const { measure } = fixedMeasure();
    expect(buildShareImageLayout([book()], measure).width).toBe(SHARE_IMAGE_WIDTH);
    expect(SHARE_IMAGE_WIDTH).toBe(1080);
  });

  it("첫 명령은 캔버스 전체를 덮는 페이지 톤 배경이다", () => {
    const { measure } = fixedMeasure();
    const layout = buildShareImageLayout([book()], measure);
    const first = layout.commands[0];

    expect(first).toEqual({
      kind: "rect",
      x: 0,
      y: 0,
      width: layout.width,
      height: layout.height,
      color: "#FAF9F7",
    });
  });

  it("하단에 서비스 이름 워터마크 한 줄을 비활성 톤으로 둔다 — 로고·그라데이션 없음", () => {
    const { measure } = fixedMeasure();
    const commands = buildShareImageLayout([book()], measure).commands;
    const last = commands[commands.length - 1];

    expect(last.kind).toBe("text");
    if (last.kind !== "text") return;
    expect(last.text).toBe("Shelfie");
    expect(last.color).toBe("#8C8681");
  });
});

describe("buildShareImageLayout — 결정성", () => {
  it("같은 입력 + 같은 측정기면 명령이 완전히 같다", () => {
    const a = buildShareImageLayout([book(), book({ position: 2 })], fixedMeasure().measure);
    const b = buildShareImageLayout([book(), book({ position: 2 })], fixedMeasure().measure);

    expect(a).toEqual(b);
  });

  it("모든 명령의 좌표가 확정된 숫자다 — 그리기 층이 판단할 것을 남기지 않는다", () => {
    const { measure } = fixedMeasure();
    for (const command of buildShareImageLayout([book()], measure).commands) {
      expect(Number.isFinite(command.x)).toBe(true);
      expect(Number.isFinite(command.y)).toBe(true);
    }
  });
});

describe("buildShareImageLayout — 권수에 따라 높이가 달라진다", () => {
  const three = [book({ position: 1 }), book({ position: 2 }), book({ position: 3 })];

  it("3권 / 1권 / 0권의 높이가 서로 다르다 — 고정 높이로 자르지 않는다", () => {
    const h3 = buildShareImageLayout(three, fixedMeasure().measure).height;
    const h1 = buildShareImageLayout([book()], fixedMeasure().measure).height;
    const h0 = buildShareImageLayout([], fixedMeasure().measure).height;

    expect(h3).toBeGreaterThan(h1);
    expect(h1).toBeGreaterThan(h0);
  });

  it("0권에서도 던지지 않고 배경과 워터마크만 남는다", () => {
    const { measure } = fixedMeasure();
    const layout = buildShareImageLayout([], measure);

    expect(layout.height).toBeGreaterThan(0);
    expect(layout.commands.filter((c) => c.kind === "cover")).toHaveLength(0);
    expect(texts(layout.commands)).toEqual(["Shelfie"]);
  });

  it("추천 권수 상한을 넘겨 받아도 MAX_RECOMMENDATIONS 권까지만 그린다", () => {
    const { measure } = fixedMeasure();
    const many = [1, 2, 3].map((p) => book({ position: p as 1 | 2 | 3, title: `책 ${p}` }));
    const overflow = [...many, book({ position: 3, title: "넷째 책" })];

    const layout = buildShareImageLayout(overflow, measure);

    expect(layout.commands.filter((c) => c.kind === "cover")).toHaveLength(MAX_RECOMMENDATIONS);
    expect(texts(layout.commands)).not.toContain("넷째 책");
  });

  it("책마다 아래로 쌓인다 — 두 번째 책의 표지가 첫 책보다 아래에 있다", () => {
    const { measure } = fixedMeasure();
    const covers = buildShareImageLayout(
      [book({ position: 1 }), book({ position: 2 })],
      measure,
    ).commands.filter((c) => c.kind === "cover");

    expect(covers).toHaveLength(2);
    expect(covers[1].y).toBeGreaterThan(covers[0].y);
    expect(covers[1].x).toBe(covers[0].x);
  });
});

describe("buildShareImageLayout — 말줄임", () => {
  it("아주 긴 제목이 …로 끝나고 원문보다 짧다", () => {
    const { measure } = fixedMeasure();
    const long = "가".repeat(600);
    const layout = buildShareImageLayout([book({ title: long })], measure);

    const clipped = texts(layout.commands).find((t) => t.endsWith("…"));
    expect(clipped).toBeDefined();
    expect(clipped!.length).toBeLessThan(long.length);
  });

  it("잘린 줄도 최대 폭 안에 들어간다 — 넘쳐 잘린 글자가 그대로 나가지 않는다", () => {
    const { measure } = fixedMeasure();
    const layout = buildShareImageLayout(
      [book({ title: "나".repeat(400), author: "다".repeat(400), reason: "라".repeat(2000) })],
      measure,
    );

    for (const command of layout.commands) {
      if (command.kind !== "text") continue;
      const right = command.x + Array.from(command.text).length * CHAR_WIDTH;
      expect(right).toBeLessThanOrEqual(SHARE_IMAGE_WIDTH);
    }
  });

  it("한 줄에 들어가는 저자는 자르지 않는다", () => {
    const { measure } = fixedMeasure();
    const layout = buildShareImageLayout([book({ author: "김초엽" })], measure);

    expect(texts(layout.commands)).toContain("김초엽");
  });
});

describe("buildShareImageLayout — 사실과 해석을 가른다 (ADR-002)", () => {
  it("추천 이유에 라벨이 붙는다", () => {
    const { measure } = fixedMeasure();
    expect(texts(buildShareImageLayout([book()], measure).commands)).toContain("추천 이유");
  });

  it("추천 이유는 제목과 다른 색·글꼴로 그려진다", () => {
    const { measure } = fixedMeasure();
    const commands = buildShareImageLayout([book({ reason: "가벼운 문장" })], measure).commands;

    const title = commands.find((c) => c.kind === "text" && c.text === "미움받을 용기");
    const reason = commands.find((c) => c.kind === "text" && c.text === "가벼운 문장");

    expect(title?.kind).toBe("text");
    expect(reason?.kind).toBe("text");
    if (title?.kind !== "text" || reason?.kind !== "text") return;

    expect(reason.color).not.toBe(title.color);
    expect(reason.font).not.toBe(title.font);
    expect(reason.color).toBe("#6B6560");
  });

  it("추천 이유 왼쪽에 세로선이 서고 본문이 그만큼 들여쓰인다", () => {
    const { measure } = fixedMeasure();
    const commands = buildShareImageLayout([book({ reason: "가벼운 문장" })], measure).commands;

    // 배경(0번)을 뺀 나머지 rect 중 세로로 길고 액센트 톤인 것이 이유 블록의 세로선이다
    const rule = commands
      .slice(1)
      .find((c) => c.kind === "rect" && c.height > c.width && c.color.startsWith("rgba"));

    expect(rule).toBeDefined();
    if (rule?.kind !== "rect") return;

    const reason = commands.find((c) => c.kind === "text" && c.text === "가벼운 문장");
    if (reason?.kind !== "text") return;

    expect(reason.x).toBeGreaterThan(rule.x + rule.width);

    // 사실인 제목은 세로선 왼쪽 기준선에 그대로 선다
    const title = commands.find((c) => c.kind === "text" && c.text === "미움받을 용기");
    if (title?.kind !== "text") return;
    expect(title.x).toBe(rule.x);
    expect(title.x).toBeLessThan(reason.x);
  });

  it("추천 이유가 비어 있으면 라벨도 세로선도 그리지 않는다 — 없는 해석을 지어내지 않는다", () => {
    const { measure } = fixedMeasure();
    const commands = buildShareImageLayout([book({ reason: "   " })], measure).commands;

    expect(texts(commands)).not.toContain("추천 이유");
    expect(
      commands.slice(1).filter((c) => c.kind === "rect" && c.color.startsWith("rgba")),
    ).toHaveLength(0);
  });
});

describe("buildShareImageLayout — 표지", () => {
  it("표지는 좌표가 확정된 cover 명령으로 나가고 원본 URL을 그대로 싣는다", () => {
    const { measure } = fixedMeasure();
    const cover = buildShareImageLayout([book()], measure).commands.find((c) => c.kind === "cover");

    expect(cover).toBeDefined();
    if (cover?.kind !== "cover") return;
    expect(cover.src).toBe("https://image.aladin.co.kr/cover/1.jpg");
    expect(cover.width).toBeGreaterThan(0);
    expect(cover.height).toBeGreaterThan(0);
  });

  it("표지 실패 폴백이 같은 명령에 미리 실려 있다 — 그리기 층이 레이아웃을 다시 계산하지 않는다", () => {
    const { measure } = fixedMeasure();
    const cover = buildShareImageLayout([book()], measure).commands.find((c) => c.kind === "cover");
    if (cover?.kind !== "cover") return;

    const block = cover.fallback.find((c) => c.kind === "rect");
    const letter = cover.fallback.find((c) => c.kind === "text");

    expect(block).toEqual({
      kind: "rect",
      x: cover.x,
      y: cover.y,
      width: cover.width,
      height: cover.height,
      color: "#F5F2ED",
    });
    expect(letter?.kind).toBe("text");
    if (letter?.kind !== "text") return;
    expect(letter.text).toBe("미");
  });

  it("표지 URL이 비어 있어도 자리와 폴백은 그대로다 — 저장을 취소하지 않는다", () => {
    const { measure } = fixedMeasure();
    const withCover = buildShareImageLayout([book()], measure);
    const without = buildShareImageLayout([book({ coverUrl: "" })], measure);

    expect(without.height).toBe(withCover.height);

    const cover = without.commands.find((c) => c.kind === "cover");
    if (cover?.kind !== "cover") return;
    expect(cover.src).toBe("");
    expect(cover.fallback.length).toBeGreaterThan(0);
  });
});

describe("buildShareImageLayout — 폭은 주입받은 측정기로만 잰다", () => {
  it("measure가 실제로 호출된다 (글자 수 × 상수로 대체하지 않았다)", () => {
    const { measure, calls } = fixedMeasure();
    buildShareImageLayout([book()], measure);

    expect(calls.length).toBeGreaterThan(0);
    // 폰트 인자도 함께 넘긴다 — 캔버스는 글꼴마다 폭이 다르다
    expect(calls.every((c) => typeof c.font === "string" && c.font.length > 0)).toBe(true);
  });

  it("측정기가 다르면 줄바꿈 결과가 달라진다", () => {
    const narrow: MeasureText = (text) => Array.from(text).length * 40;
    const wide: MeasureText = (text) => Array.from(text).length * 4;
    const long = book({ reason: "마".repeat(120) });

    expect(buildShareImageLayout([long], narrow).height).toBeGreaterThan(
      buildShareImageLayout([long], wide).height,
    );
  });
});

describe("buildShareImageLayout — 브라우저 API에 손대지 않는다", () => {
  it("document를 만지지 않는다 — jsdom 없이도 통과해야 한다", () => {
    const originalDocument = globalThis.document;
    // @ts-expect-error 이 층이 document를 참조하면 여기서 죽는다
    delete globalThis.document;

    try {
      expect(() => buildShareImageLayout([book()], fixedMeasure().measure)).not.toThrow();
    } finally {
      globalThis.document = originalDocument;
    }
  });
});
