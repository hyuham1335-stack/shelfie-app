/**
 * 저장 이미지 그리기 층 테스트 (FR-014, ADR-009).
 *
 * **진짜 캔버스로 검증하지 않는다.** jsdom에는 canvas 구현이 없고, 그것이 이 설계가
 * 두 겹으로 갈라진 이유 전부다. 여기서는 `createCanvas`·`loadImage`를 주입해
 * "레이아웃이 정한 명령이 그대로 적용되는가"만 본다 — 좌표가 맞는지는 레이아웃 층의
 * 테스트(`share-image.test.ts`)가 이미 값으로 단정했다.
 */
import { describe, expect, it } from "vitest";
import {
  buildShareImageLayout,
  renderShareImage,
  type DrawCommand,
  type ShareImageBook,
} from "./share-image";

/** 글자당 10px. 가짜 ctx의 측정기와 기대값 계산이 같은 폭을 써야 명령이 일치한다 */
const CHAR_WIDTH = 10;

interface DrawCall {
  op: "fillRect" | "fillText" | "drawImage";
  args: readonly unknown[];
  font: string;
  fillStyle: string;
}

interface FakeCanvas {
  canvas: HTMLCanvasElement;
  size: { width: number; height: number };
  calls: DrawCall[];
  measured: Array<{ text: string; font: string }>;
  blobTypes: Array<string | undefined>;
}

function fakeCanvas(options: { blob?: Blob | null; context?: boolean } = {}): FakeCanvas {
  const calls: DrawCall[] = [];
  const measured: Array<{ text: string; font: string }> = [];
  const blobTypes: Array<string | undefined> = [];

  const ctx = {
    font: "",
    fillStyle: "",
    measureText(text: string) {
      measured.push({ text, font: ctx.font });
      return { width: Array.from(text).length * CHAR_WIDTH };
    },
    fillRect(...args: unknown[]) {
      calls.push({ op: "fillRect", args, font: ctx.font, fillStyle: ctx.fillStyle });
    },
    fillText(...args: unknown[]) {
      calls.push({ op: "fillText", args, font: ctx.font, fillStyle: ctx.fillStyle });
    },
    drawImage(...args: unknown[]) {
      calls.push({ op: "drawImage", args, font: ctx.font, fillStyle: ctx.fillStyle });
    },
  };

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => (options.context === false ? null : ctx),
    toBlob(callback: (blob: Blob | null) => void, type?: string) {
      blobTypes.push(type);
      const blob =
        "blob" in options ? (options.blob ?? null) : new Blob(["png"], { type: "image/png" });
      callback(blob);
    },
  };

  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    size: canvas,
    calls,
    measured,
    blobTypes,
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

function threeBooks(): ShareImageBook[] {
  return [1, 2, 3].map((p) =>
    book({
      position: p as 1 | 2 | 3,
      title: `책 ${p}`,
      coverUrl: `https://image.aladin.co.kr/cover/${p}.jpg`,
    }),
  );
}

/** 레이아웃 명령을 "이렇게 그려져야 한다"로 옮긴다. 표지 성공 여부만 인자로 받는다 */
function expectedCalls(
  commands: readonly DrawCommand[],
  loaded: (src: string) => unknown,
): DrawCall[] {
  const out: DrawCall[] = [];

  for (const command of commands) {
    if (command.kind === "rect") {
      out.push({
        op: "fillRect",
        args: [command.x, command.y, command.width, command.height],
        font: expect.any(String) as unknown as string,
        fillStyle: command.color,
      });
      continue;
    }

    if (command.kind === "text") {
      out.push({
        op: "fillText",
        args: [command.text, command.x, command.y],
        font: command.font,
        fillStyle: command.color,
      });
      continue;
    }

    const image = command.src === "" ? undefined : loaded(command.src);
    if (image === undefined || image === null) {
      out.push(...expectedCalls(command.fallback, loaded));
      continue;
    }

    out.push({
      op: "drawImage",
      args: [image, command.x, command.y, command.width, command.height],
      font: expect.any(String) as unknown as string,
      fillStyle: expect.any(String) as unknown as string,
    });
  }

  return out;
}

/** 레이아웃 층이 쓰는 것과 같은 폭 측정기 — 기대 명령을 만들 때 쓴다 */
const sameMeasure = (text: string) => Array.from(text).length * CHAR_WIDTH;

const stubImage = { tag: "loaded-cover" } as unknown as CanvasImageSource;

describe("renderShareImage — 명령을 그대로 적용한다 (ADR-009)", () => {
  it("레이아웃이 만든 명령이 하나도 빠짐없이 그 순서대로 ctx에 적용된다", async () => {
    const fake = fakeCanvas();
    const books = threeBooks();

    await renderShareImage(books, {
      createCanvas: () => fake.canvas,
      loadImage: async () => stubImage,
    });

    const layout = buildShareImageLayout(books, sameMeasure);
    expect(fake.calls).toEqual(expectedCalls(layout.commands, () => stubImage));
  });

  it("캔버스 크기를 레이아웃이 정한 값으로 맞춘다 — 크기도 스스로 정하지 않는다", async () => {
    const fake = fakeCanvas();

    await renderShareImage([book()], {
      createCanvas: () => fake.canvas,
      loadImage: async () => stubImage,
    });

    const layout = buildShareImageLayout([book()], sameMeasure);
    expect(fake.size.width).toBe(layout.width);
    expect(fake.size.height).toBe(layout.height);
  });

  it("measure로 ctx.measureText가 넘어간다 — 실제 글꼴 폭으로 잘린다", async () => {
    const fake = fakeCanvas();

    await renderShareImage([book()], {
      createCanvas: () => fake.canvas,
      loadImage: async () => stubImage,
    });

    expect(fake.measured.length).toBeGreaterThan(0);
    // 폰트를 세운 뒤에 재야 한다 — 캔버스는 글꼴마다 폭이 다르다
    expect(fake.measured.every((m) => m.font.length > 0)).toBe(true);
  });
});

describe("renderShareImage — 표지는 따로 불러온다 (ADR-009)", () => {
  it("주입된 loadImage를 쓰고 표지 URL을 그대로 넘긴다", async () => {
    const fake = fakeCanvas();
    const requested: string[] = [];

    await renderShareImage(threeBooks(), {
      createCanvas: () => fake.canvas,
      loadImage: async (src) => {
        requested.push(src);
        return stubImage;
      },
    });

    expect(requested.sort()).toEqual([
      "https://image.aladin.co.kr/cover/1.jpg",
      "https://image.aladin.co.kr/cover/2.jpg",
      "https://image.aladin.co.kr/cover/3.jpg",
    ]);
  });

  it("표지 3장을 함께 기다린다 — 순차로 하나씩 기다리지 않는다", () => {
    const fake = fakeCanvas();
    const started: string[] = [];
    const release: Array<() => void> = [];

    const promise = renderShareImage(threeBooks(), {
      createCanvas: () => fake.canvas,
      loadImage: (src) =>
        new Promise((resolve) => {
          started.push(src);
          release.push(() => resolve(stubImage));
        }),
    });

    // 한 장도 응답하지 않았는데 세 장이 모두 출발해 있어야 한다
    expect(started).toHaveLength(3);

    release.forEach((fn) => fn());
    return promise;
  });

  it("표지 URL이 비어 있으면 부르지 않고 곧바로 폴백을 그린다", async () => {
    const fake = fakeCanvas();
    const requested: string[] = [];

    await renderShareImage([book({ coverUrl: "" })], {
      createCanvas: () => fake.canvas,
      loadImage: async (src) => {
        requested.push(src);
        return stubImage;
      },
    });

    expect(requested).toHaveLength(0);
    expect(fake.calls.filter((c) => c.op === "drawImage")).toHaveLength(0);
    expect(fake.calls.some((c) => c.op === "fillText" && c.args[0] === "미")).toBe(true);
  });
});

describe("renderShareImage — 표지를 못 얻어도 저장은 성공한다", () => {
  it("로드가 reject해도 Blob이 나오고 그 자리에 폴백 명령이 적용된다", async () => {
    const fake = fakeCanvas();
    const books = [book()];

    const blob = await renderShareImage(books, {
      createCanvas: () => fake.canvas,
      loadImage: async () => {
        throw new Error("CORS");
      },
    });

    expect(blob).toBeInstanceOf(Blob);

    const layout = buildShareImageLayout(books, sameMeasure);
    expect(fake.calls).toEqual(expectedCalls(layout.commands, () => null));
    expect(fake.calls.filter((c) => c.op === "drawImage")).toHaveLength(0);
  });

  it("loadImage가 null을 줘도 같은 폴백으로 흡수한다", async () => {
    const fake = fakeCanvas();

    const blob = await renderShareImage([book()], {
      createCanvas: () => fake.canvas,
      loadImage: async () => null,
    });

    expect(blob).toBeInstanceOf(Blob);
    expect(fake.calls.filter((c) => c.op === "drawImage")).toHaveLength(0);
    // 폴백 블록(#F5F2ED)과 제목 첫 글자가 그려진다
    expect(fake.calls.some((c) => c.op === "fillRect" && c.fillStyle === "#F5F2ED")).toBe(true);
    expect(fake.calls.some((c) => c.op === "fillText" && c.args[0] === "미")).toBe(true);
  });

  it("3장 중 1장만 실패해도 나머지 2장은 그려진다", async () => {
    const fake = fakeCanvas();
    const books = threeBooks();
    const failing = "https://image.aladin.co.kr/cover/2.jpg";

    await renderShareImage(books, {
      createCanvas: () => fake.canvas,
      loadImage: async (src) => {
        if (src === failing) throw new Error("404");
        return stubImage;
      },
    });

    expect(fake.calls.filter((c) => c.op === "drawImage")).toHaveLength(2);

    const layout = buildShareImageLayout(books, sameMeasure);
    expect(fake.calls).toEqual(
      expectedCalls(layout.commands, (src) => (src === failing ? null : stubImage)),
    );
  });
});

describe("renderShareImage — 실패는 실패로 다룬다", () => {
  it("toBlob이 null을 주면 reject한다 — 절반만 그려진 캔버스를 성공으로 돌려주지 않는다", async () => {
    const fake = fakeCanvas({ blob: null });

    await expect(
      renderShareImage([book()], {
        createCanvas: () => fake.canvas,
        loadImage: async () => stubImage,
      }),
    ).rejects.toThrow();
  });

  it("getContext가 null이면 명확한 에러로 실패한다 — 빈 Blob을 돌려주지 않는다", async () => {
    const fake = fakeCanvas({ context: false });

    await expect(
      renderShareImage([book()], {
        createCanvas: () => fake.canvas,
        loadImage: async () => stubImage,
      }),
    ).rejects.toThrow();
  });
});

describe("renderShareImage — 산출물", () => {
  it("성공 경로에서 PNG Blob이 나온다", async () => {
    const fake = fakeCanvas();

    const blob = await renderShareImage([book()], {
      createCanvas: () => fake.canvas,
      loadImage: async () => stubImage,
    });

    expect(blob.type).toBe("image/png");
    expect(fake.blobTypes).toEqual(["image/png"]);
  });

  it("책이 0권이어도 던지지 않고 배경과 워터마크만 그린다", async () => {
    const fake = fakeCanvas();

    const blob = await renderShareImage([], {
      createCanvas: () => fake.canvas,
      loadImage: async () => stubImage,
    });

    expect(blob).toBeInstanceOf(Blob);
    expect(fake.calls.filter((c) => c.op === "drawImage")).toHaveLength(0);
    expect(fake.calls.filter((c) => c.op === "fillText").map((c) => c.args[0])).toEqual([
      "Shelfie",
    ]);
  });
});
