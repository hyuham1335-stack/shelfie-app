/**
 * 업로드 화면 (US-001, FR-001·FR-002).
 *
 * 이 화면은 판정을 하지 않는다. `lib/image.ts`가 이미 판정했고 화면은 그 결과를
 * 문장으로 옮길 뿐이다 — 두 벌이 되면 반드시 갈라진다. 그래서 테스트도 "화면이
 * 무엇을 다시 계산하는가"가 아니라 "lib의 판정이 어떤 문장·어떤 호출로 나오는가"를 본다.
 *
 * 네트워크는 여기 없다. 행동은 `onAnalyze` 콜백으로 위임하고, 배선은 페이지의 몫이다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MAX_PHOTOS } from "@/lib/env";
import { UploadScreen } from "./UploadScreen";

function 사진(name: string, bytes: number[] = [1, 2, 3, 4]): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });
}

/** 서로 다른 내용의 사진 n장 (같은 내용이면 duplicate로 걸린다) */
function 사진들(n: number): File[] {
  return Array.from({ length: n }, (_, i) => 사진(`shelf-${i}.jpg`, [i, i + 1, i + 2]));
}

function 고르기(files: File[], label = "사진 선택") {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
}

/**
 * jsdom에는 캔버스가 없으므로 디코드·인코드를 대체한다 (image.test.ts와 같은 방식).
 * 새 의존성을 넣지 않고 계약만 고정한다.
 */
function 캔버스대체(blobBytes = 4) {
  const context = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => context as unknown as RenderingContext,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback: BlobCallback) => {
    callback(new Blob([new Uint8Array(blobBytes)], { type: "image/jpeg" }));
  });
}

function 비트맵대체(size = { width: 3000, height: 2000 }) {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ ...size, close: vi.fn() }) as unknown as ImageBitmap),
  );
}

function 디코드실패() {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => {
      throw new TypeError("The source image cannot be decoded.");
    }),
  );
}

/** 썸네일이 뜰 때까지 기다린다 — 파일 해시는 FileReader라 비동기다 */
async function 썸네일(name: string) {
  return waitFor(() => screen.getByLabelText(`${name} 제거`));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("UploadScreen — 첫 화면 (PRD 7번 온보딩)", () => {
  it("촬영 팁과 저장하지 않는다는 사실을 함께 보여 준다", () => {
    render(<UploadScreen onAnalyze={() => {}} />);

    expect(screen.getByText(/책등이 보이도록/)).toBeInTheDocument();
    expect(screen.getByText(/사진은 저장되지 않아요/)).toBeInTheDocument();
  });

  it("사진을 고르기 전에는 분석 CTA가 비활성이다", () => {
    render(<UploadScreen onAnalyze={() => {}} />);

    expect(screen.getByRole("button", { name: "분석 시작" })).toBeDisabled();
  });
});

describe("UploadScreen — 선택 (FR-001)", () => {
  it("고른 사진이 썸네일로 남고 CTA가 활성된다", async () => {
    비트맵대체();
    render(<UploadScreen onAnalyze={() => {}} />);

    고르기([사진("a.jpg")]);

    await 썸네일("a.jpg");
    expect(screen.getByRole("button", { name: "분석 시작" })).toBeEnabled();
  });

  it("상한을 넘겨 고르면 앞의 5장만 남고 too_many를 사유로 말한다", async () => {
    비트맵대체();
    render(<UploadScreen onAnalyze={() => {}} />);

    고르기(사진들(MAX_PHOTOS + 1));

    await waitFor(() => expect(screen.getAllByText("제거")).toHaveLength(MAX_PHOTOS));
    expect(screen.getByText(new RegExp(`${MAX_PHOTOS}장까지`))).toBeInTheDocument();
  });

  it("같은 사진을 두 번 고르면 duplicate로 안내하고 한 장만 남는다", async () => {
    비트맵대체();
    render(<UploadScreen onAnalyze={() => {}} />);

    고르기([사진("a.jpg")]);
    await 썸네일("a.jpg");
    고르기([사진("복사본.jpg")]);

    await waitFor(() => expect(screen.getByText(/같은 사진/)).toBeInTheDocument());
    expect(screen.getAllByText("제거")).toHaveLength(1);
  });

  it("형식이 맞지 않는 파일은 그 파일만 빠지고 나머지는 남는다", async () => {
    비트맵대체();
    render(<UploadScreen onAnalyze={() => {}} />);

    const gif = new File([new Uint8Array([9, 9])], "anim.gif", { type: "image/gif" });
    고르기([gif, 사진("a.jpg")]);

    await 썸네일("a.jpg");
    expect(screen.getByText(/WEBP/)).toBeInTheDocument();
  });

  it("이미 고른 사진에 이어서 고를 수 있다 (덮어쓰지 않는다)", async () => {
    비트맵대체();
    render(<UploadScreen onAnalyze={() => {}} />);

    고르기([사진("a.jpg", [1, 1])]);
    await 썸네일("a.jpg");
    고르기([사진("b.jpg", [2, 2])]);

    await 썸네일("b.jpg");
    expect(screen.getByLabelText("a.jpg 제거")).toBeInTheDocument();
  });

  it("개별 제거로 목록에서 뺄 수 있다", async () => {
    비트맵대체();
    render(<UploadScreen onAnalyze={() => {}} />);

    고르기([사진("a.jpg")]);
    fireEvent.click(await 썸네일("a.jpg"));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "분석 시작" })).toBeDisabled(),
    );
  });

  it("파노라마처럼 리사이즈 후 판독이 어려운 사진은 경고하되 막지 않는다 (TR-001)", async () => {
    비트맵대체({ width: 1200, height: 4000 });
    render(<UploadScreen onAnalyze={() => {}} />);

    고르기([사진("panorama.jpg")]);

    await waitFor(() => expect(screen.getByText(/나눠서/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "분석 시작" })).toBeEnabled();
  });
});

describe("UploadScreen — 분석 시작 (FR-002)", () => {
  it("고른 **원본 File**을 넘긴다 — 재시도의 입력이 되는 값이다 (ARCHITECTURE 상태 관리)", async () => {
    비트맵대체();
    캔버스대체();
    const onAnalyze = vi.fn();
    render(<UploadScreen onAnalyze={onAnalyze} />);

    const files = 사진들(2);
    고르기(files);
    await 썸네일("shelf-1.jpg");
    fireEvent.click(screen.getByRole("button", { name: "분석 시작" }));

    await waitFor(() => expect(onAnalyze).toHaveBeenCalledTimes(1));
    const [sources] = onAnalyze.mock.calls[0];
    // 리사이즈 결과가 아니라 사용자가 고른 그 파일이다. 이것이 없으면 재시도가
    // 열화된 사본에서 출발하고 EXIF·품질·짧은 변 판정을 다시 고를 수 없다.
    expect(sources).toHaveLength(2);
    expect(sources[0]).toBeInstanceOf(File);
    expect(sources.map((file: File) => file.name)).toEqual(["shelf-0.jpg", "shelf-1.jpg"]);
  });

  it("방금 만든 리사이즈 결과를 곁들여 넘긴다 — 첫 요청이 두 번 리사이즈하지 않는다", async () => {
    비트맵대체();
    캔버스대체();
    const onAnalyze = vi.fn();
    render(<UploadScreen onAnalyze={onAnalyze} />);

    고르기(사진들(2));
    await 썸네일("shelf-1.jpg");
    fireEvent.click(screen.getByRole("button", { name: "분석 시작" }));

    await waitFor(() => expect(onAnalyze).toHaveBeenCalledTimes(1));
    const [sources, dataUris] = onAnalyze.mock.calls[0];
    expect(dataUris).toHaveLength(2);
    expect(dataUris[0]).toMatch(/^data:image\/jpeg;base64,/);
    // 파생값은 원본과 같은 순서로 선다 — 부분 실패 배너의 분모(photoCount)도
    // 응답이 아니라 이 배열의 길이에서 나온다.
    expect(dataUris).toHaveLength(sources.length);
  });

  it("전송 예산을 넘기면 보내기 전에 막는다 (413은 마지막 방어선이지 설계가 아니다)", async () => {
    비트맵대체();
    // 장당 상한(2MB)을 넘기는 산출물을 만든다.
    캔버스대체(2 * 1024 * 1024);
    const onAnalyze = vi.fn();
    render(<UploadScreen onAnalyze={onAnalyze} />);

    고르기([사진("a.jpg")]);
    await 썸네일("a.jpg");
    fireEvent.click(screen.getByRole("button", { name: "분석 시작" }));

    await waitFor(() => expect(screen.getByText(/용량/)).toBeInTheDocument());
    expect(onAnalyze).not.toHaveBeenCalled();
  });

  it("브라우저가 열지 못한 사진은 decode_failed로 말하고 조용히 사라지지 않는다 (PRD Q3)", async () => {
    디코드실패();
    캔버스대체();
    const onAnalyze = vi.fn();
    render(<UploadScreen onAnalyze={onAnalyze} />);

    고르기([사진("photo.heic.jpg")]);
    await 썸네일("photo.heic.jpg");
    fireEvent.click(screen.getByRole("button", { name: "분석 시작" }));

    await waitFor(() => expect(screen.getByText(/열지 못했어요/)).toBeInTheDocument());
    expect(onAnalyze).not.toHaveBeenCalled();
    // 보낼 수 없는 사진은 목록에서 빠진다 — 다시 눌러도 같은 실패이기 때문이다.
    expect(screen.queryByLabelText("photo.heic.jpg 제거")).not.toBeInTheDocument();
  });
});

describe("UploadScreen — 진행 상태 (PRD 5번 로딩)", () => {
  it("분석 중에는 진행 상태를 aria-live로 알리고 입력을 잠근다", async () => {
    비트맵대체();
    render(<UploadScreen onAnalyze={() => {}} isAnalyzing />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("책등을 읽고 있어요");
    expect(screen.getByRole("button", { name: "분석 시작" })).toBeDisabled();
    expect(screen.getByLabelText("사진 선택")).toBeDisabled();
  });

  it("진행 표시에 펄스를 쓰지 않는다 (UI_GUIDE 애니메이션)", () => {
    const { container } = render(<UploadScreen onAnalyze={() => {}} isAnalyzing />);

    expect(container.innerHTML).not.toContain("animate-pulse");
  });
});

describe("UploadScreen — AI 슬롭 안티패턴 (UI_GUIDE)", () => {
  const FORBIDDEN = [
    "backdrop-blur",
    "backdrop-filter",
    "bg-gradient-to",
    "bg-clip-text",
    "animate-pulse",
    "rounded-2xl",
    "shadow-",
    "indigo",
    "purple",
    "violet",
    "blur-3xl",
    "#",
  ];

  it.each(FORBIDDEN)("렌더된 마크업에 %s가 없다", (token) => {
    const { container } = render(<UploadScreen onAnalyze={() => {}} />);

    expect(container.innerHTML).not.toContain(token);
  });
});

describe("UploadScreen — 촬영 가이드 시트 (FR-015)", () => {
  it("시트는 접힌 채로 붙고, 촬영 팁 한 줄은 그대로 보인다", () => {
    const { container } = render(<UploadScreen onAnalyze={() => {}} />);

    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);
    // 시트는 펼치지 않는 사용자를 위한 한 줄을 대체하지 않는다.
    expect(screen.getByText(/책등이 보이도록/)).toBeInTheDocument();
  });

  it("시트를 펼쳐도 촬영 팁 한 줄이 화면에 남는다", () => {
    render(<UploadScreen onAnalyze={() => {}} />);

    fireEvent.click(screen.getByText("어떻게 찍으면 잘 읽히나요?"));

    expect(screen.getByText(/책등이 보이도록/)).toBeInTheDocument();
  });

  it("가이드는 업로드·분석 흐름을 막지 않는다", async () => {
    비트맵대체();
    캔버스대체();
    const onAnalyze = vi.fn();
    render(<UploadScreen onAnalyze={onAnalyze} />);

    fireEvent.click(screen.getByText("어떻게 찍으면 잘 읽히나요?"));
    고르기([사진("a.jpg")]);
    await 썸네일("a.jpg");
    fireEvent.click(screen.getByRole("button", { name: "분석 시작" }));

    await waitFor(() => expect(onAnalyze).toHaveBeenCalledTimes(1));
  });

  it("가이드를 펼쳐도 이벤트를 보내지 않는다 (PRD 7번)", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<UploadScreen onAnalyze={() => {}} />);

    fireEvent.click(screen.getByText("어떻게 찍으면 잘 읽히나요?"));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
