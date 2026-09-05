/**
 * PRD 5번 Edge Cases 표 ↔ 화면·상태 머신 **대응표** (TR-011 AC).
 *
 * TR-011의 AC 한 줄은 "각 상태의 로딩·빈 상태·에러 분기가 PRD 5번 Edge Cases 표와
 * 1:1 대응"이다. 그 대응은 열 런 동안 사람이 눈으로만 확인해 왔고, 표에서 한 행이
 * 사라져도 깨지는 테스트가 없었다. 이 파일이 그 연결을 코드로 옮긴다.
 *
 * **이 파일은 12행 전부를 다시 검사하지 않는다.** 이미 잠긴 행을 두 번 잠그면 한쪽만
 * 고쳐지는 날이 오기 때문이다. 대신 아래 표가 **행마다 어디서 잠겼는지**를 가리키고,
 * 비어 있던 행만 이 파일이 채운다. 표를 읽는 순서는 PRD 5번 표의 행 순서와 같다.
 *
 * | # | PRD 5번 행 | 판정 | 어디서 잠겼는가 |
 * |---|-----------|------|----------------|
 * | 1 | 빈 상태 | 잠김 | `app/page.test.tsx` "EMPTY_SHELF는 빈 목록이 아니라 재촬영 안내로 분기한다" |
 * | 2 | 로딩 | **이 파일이 채운다** (일부 잠김) | 첫 분석의 진행 표시는 `upload/UploadScreen.test.tsx` "분석 중에는 진행 상태를 aria-live로 알리고 입력을 잠근다", 클라이언트 타임아웃 70초는 `lib/api-client.test.ts` "클라이언트 타임아웃은 서버 상한보다 길다". **재시도 중의 진행 화면**은 아무 데서도 잠기지 않았다 → 아래 ①(502 경로)과 ⑥(오프라인 경로). 둘을 나눠 든 이유는 재시도 표식이 예산 카운터에서 떨어져 나온 뒤로 **두 경로가 서로 다른 화면을 그릴 수 있게 됐기** 때문이다(계약 델타 D-1) — ⑥이 그 둘을 같은 단정 함수에 건다. `분석 요청이 300ms를 넘김`이라는 발생 조건 자체는 구현이 없다(스켈레톤이 지연 없이 바로 선다) — 보고만 한다 |
 * | 3 | 실패 | 잠김 | `common/ErrorBanner.test.tsx`(정해진 문구·원문 비노출·재시도 버튼) + `app/page.test.tsx` "분석 실패 후 재시도는 재업로드를 요구하지 않는다". 외부 호출 1회 자동 재시도는 `services/aladin.test.ts`·`services/anthropic.test.ts` |
 * | 4 | 권한 없음 | 일부 잠김 · 일부 **구현 없음** | 촬영이 막혀도 파일 선택 경로가 남는 것은 `upload/PhotoPicker.test.tsx`. 다만 PRD가 "사용자에게 보이는 것"으로 적은 **"사진 접근 권한이 없어요. 갤러리에서 직접 선택해 주세요" 안내는 코드에 없다** — 브라우저가 권한 거부를 알려주지 않아 관측 자체가 불가능하다는 것이 `PhotoPicker.tsx`의 판단이다. 없는 것을 테스트로 지어내지 않는다 |
 * | 5 | 부분 실패 | 잠김 | 배너와 분모는 `booklist/BookList.test.tsx` "목록보다 앞에 렌더되고 분모를 함께 밝힌다", 실패분만 다시 보내는 것은 `app/page.test.tsx` "실패한 사진만 재시도하면 …"(확인 0건 화면). 확인된 책이 1권 이상인 `reviewing` 화면의 재시도는 **닫혔다** — 리듀서가 `reviewing`에서 온 `ANALYZE_RETRIED`를 보존형으로 처리하고, 응답은 기존 책장 위에 합쳐진다. 화면 전환은 `app/page.test.tsx` "reviewing 화면에서 …"가, 병합 규칙은 `lib/session.test.ts`의 합치기 절이 잠근다. 이전에는 상태가 그대로 남아 뒤이은 `ANALYZE_SUCCEEDED`가 버려졌고 모델 비용만 들었다 |
 * | 6 | 대량 데이터 | 잠김 | `booklist/BookList.test.tsx` "overflowCount > 0이면 50권 상한 안내가 나온다" + `lib/merge.test.ts`(결정적 절단·정렬) |
 * | 7 | 오프라인·네트워크 단절 | **이 파일이 채운다** (일부 잠김) | 단절과 상류 장애가 `OFFLINE`·`UPSTREAM_UNAVAILABLE`로 갈리는 것은 `lib/api-client.test.ts` describe "네트워크·타임아웃", 코드→문구 대응은 `common/ErrorBanner.test.tsx` "OFFLINE이면 PRD가 적은 문구를 그대로 쓴다". **끊긴 뒤에도 입력 상태(사진·기분)가 메모리에 남는가**는 잠기지 않았다 → 아래 ②. PRD가 적은 문구 "인터넷 연결을 확인해 주세요"와 재시도 버튼이 화면에서 **함께** 서는가는 아래 ④ (단위 검사는 스스로 `onRetry`를 넘겨 통과시키므로 버튼 절반이 안 잠긴다). 단절이 재시도 몫을 쓰지 않는가는 아래 ⑤ |
 * | 8 | 확인 0건·미확인만 존재 | 잠김 | `app/page.test.tsx` "확인 0건·미확인만 있으면 추천 CTA를 감춘다" + `booklist/BookList.test.tsx` "확인 0건·미확인만이면 빈 상태 문구를 중앙 정렬로 그린다" |
 * | 9 | 결과 이탈 (새로고침·뒤로가기) | **이 파일이 채운다** | 어디에도 없었다 → 아래 ③ |
 * | 10 | 재추천·재시도 반복 | 잠김 | 간격 0→5→15초와 3회 소진은 `app/page.test.tsx` describe "재시도 간격", 재추천 5회 상한은 `lib/session.test.ts` "재추천 5회를 소진하면 더 진행하지 않는다", 소진 뒤 감추지 않고 비활성은 `recommend/RecommendationList.test.tsx` "재추천 상한을 소진하면 버튼을 숨기지 않고 비활성으로 남긴다" |
 * | 11 | 같은 사진 중복 선택 | 잠김 | `upload/UploadScreen.test.tsx` "같은 사진을 두 번 고르면 duplicate로 안내하고 한 장만 남는다" |
 * | 12 | 파노라마·초고해상도 | 잠김 | `upload/UploadScreen.test.tsx` "파노라마처럼 리사이즈 후 판독이 어려운 사진은 경고하되 막지 않는다" + `upload/PhotoThumbnails.test.tsx` |
 *
 * 각 테스트는 그 행의 **"시스템 동작"과 "사용자에게 보이는 것"을 함께** 단정한다.
 * 한쪽만 보면 계약의 절반만 잠긴다 — 사진이 남아 있는가(동작)와 재업로드를 요구하지
 * 않는가(표현)는 서로 다른 문장이다.
 */
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ApiResult } from "@/lib/api-client";
import type { AnalyzeResponse, RecommendResponse } from "@/types/api";
import type { IdentifiedBook } from "@/types/book";

vi.mock("@/lib/api-client", () => ({
  analyzePhotos: vi.fn(),
  resolveBook: vi.fn(),
  fetchMoodQuestions: vi.fn(),
  requestRecommendations: vi.fn(),
  sendClientEvent: vi.fn(() => Promise.resolve()),
}));

/** 캔버스를 만지는 모듈은 jsdom에서 한 줄도 돌지 않는다 (ADR-009) */
vi.mock("@/lib/share-image", () => ({
  renderShareImage: vi.fn(),
}));

vi.mock("@/lib/image", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/image")>()),
  resizeToDataUri: vi.fn(),
}));

/** 업로드 화면은 자기 테스트를 갖고 있다. 여기서는 콜백만 남긴 스텁으로 둔다 */
vi.mock("@/components/upload/UploadScreen", () => ({
  UploadScreen: ({
    onAnalyze,
  }: {
    onAnalyze: (files: File[], dataUris: string[]) => void;
    isAnalyzing?: boolean;
  }) => (
    <div>
      <p>업로드 화면</p>
      <button type="button" onClick={() => onAnalyze(FILES, IMAGES)}>
        사진 2장 분석
      </button>
    </div>
  ),
}));

import Home from "./page";
import { analyzePhotos, requestRecommendations } from "@/lib/api-client";
import { resizeToDataUri } from "@/lib/image";

const IMAGES = ["data:image/jpeg;base64,AAAA", "data:image/jpeg;base64,BBBB"];

const FILES = [
  new File([new Uint8Array([1, 1])], "shelf-a.jpg", { type: "image/jpeg" }),
  new File([new Uint8Array([2, 2])], "shelf-b.jpg", { type: "image/jpeg" }),
];

const analyzeMock = vi.mocked(analyzePhotos);
const recommendMock = vi.mocked(requestRecommendations);
const resizeMock = vi.mocked(resizeToDataUri);

let resizeCallCount = 0;

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

/**
 * 연결이 끊겼을 때 `lib/api-client`가 돌려주는 값 (PRD 5번 오프라인·네트워크 단절).
 * `fetch`가 던졌으므로 응답 본문이 없고, 그래서 **`requestId`가 `null`이다** —
 * 없는 ID를 지어내지 않는다는 계약이 이 행에서도 그대로 걸린다.
 *
 * `code`가 `UPSTREAM_UNAVAILABLE`이 아니라 `OFFLINE`인 것이 이 픽스처의 요점이다.
 * 응답을 못 받았다는 사실은 둘이 같지만 **누가 고칠 수 있는가**가 다르다.
 */
const OFFLINE: ApiResult<never> = {
  ok: false,
  code: "OFFLINE",
  requestId: null,
  status: 0,
};

/* 문구 상수가 **둘**인 것은 실수가 아니다.
 *
 * 하나로 두면 단절 문구를 고치는 손이 502를 흘리는 검사까지 함께 고치게 되고,
 * 그러면 "502에도 이 문구가 나온다"는 잘못된 단정이 조용히 통과한다. 사유가
 * 둘이므로 문구도 둘이고, 그 둘을 나눠 쓰는 검사도 둘이다. */

/** 배너가 **연결 단절**(`OFFLINE`)에 쓰는 문구. PRD 5번 7행의 문장 그대로다 */
const DISCONNECTED_MESSAGE = "인터넷 연결을 확인해 주세요";

/** 배너가 **상류 장애**(`UPSTREAM_UNAVAILABLE`, 502)에 쓰는 문구 */
const UPSTREAM_MESSAGE = "지금 책을 확인할 수 없어요. 잠시 후 다시 시도해 주세요";

function makeIdentified(overrides: Partial<IdentifiedBook> = {}): IdentifiedBook {
  return {
    isbn13: "9788934972464",
    title: "코스모스",
    author: "칼 세이건",
    publisher: "사이언스북스",
    coverUrl: "https://image.aladin.co.kr/product/1/1/cover/8934972467.jpg",
    pages: 719,
    aladinRating: 8.6,
    aladinLink: "https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=1",
    claudeNote: "우주를 다루는데 문장이 다정하다",
    photoIndex: 0,
    proof: "proof-cosmos",
    ...overrides,
  };
}

function makeAnalyze(overrides: Partial<AnalyzeResponse> = {}): AnalyzeResponse {
  return {
    sessionId: "00000000-0000-4000-8000-000000000000",
    identified: [makeIdentified()],
    unidentified: [],
    overflowCount: 0,
    unidentifiedOverflowCount: 0,
    failedPhotoCount: 0,
    failedPhotoIndexes: [],
    ...overrides,
  };
}

function makeRecommendation(): RecommendResponse {
  return {
    recommendations: [
      {
        bookId: "9788934972464",
        reason: "지금 컨디션에 분량이 맞고 문장이 다정해서 오늘 밤에 읽기 좋아요",
        position: 1,
      },
    ],
    shortfall: false,
  };
}

/** 손으로 해소하는 약속. "응답이 아직 오지 않은 동안"을 관찰하려면 필요하다 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 업로드 → 분석 성공까지 진행한다 */
async function analyzeInto(response: AnalyzeResponse) {
  analyzeMock.mockResolvedValue(ok(response));
  render(<Home />);
  fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));
  await screen.findByRole("heading", { name: "책장을 이렇게 읽었어요" });
}

/** 분석 → 확인된 책 1권 → 기분 입력까지 진행한다 */
async function reachMoodInput() {
  await analyzeInto(makeAnalyze());
  fireEvent.click(screen.getByRole("button", { name: "추천받기" }));
  await screen.findByRole("heading", { name: "지금 어떤 기분이세요?" });
}

function submitMood(mood: string) {
  fireEvent.change(screen.getByLabelText("지금 기분이나 상황"), { target: { value: mood } });
  fireEvent.click(screen.getByRole("button", { name: "추천받기" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  resizeCallCount = 0;
  resizeMock.mockImplementation(async (file: File) => {
    resizeCallCount += 1;
    return `data:image/jpeg;base64,RESIZED-${file.name}-${resizeCallCount}`;
  });
});

/* ------------------------------------------------------------------ *
 * ① PRD 5번 [로딩] — 재시도 중의 진행 표시
 *
 * 첫 분석의 진행 표시는 업로드 화면이 그리고 그쪽 테스트가 잠갔다. 재시도는 업로드
 * 화면을 떠나 별도 화면으로 가므로 **같은 계약이 다른 코드에 다시 걸린다** — 그
 * 화면이 조용해지면 사용자는 자기가 누른 버튼이 먹었는지 알 수 없다.
 * ------------------------------------------------------------------ */

describe("PRD 5번 [로딩] — 재시도 중에도 진행을 알린다", () => {
  /** 분석이 502로 실패한 에러 화면까지 진행한다 */
  async function reachAnalyzeError() {
    analyzeMock.mockResolvedValue({
      ok: false,
      code: "UPSTREAM_UNAVAILABLE",
      requestId: "req-502",
      status: 502,
    });
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));
    // 진짜 502다. 단절 문구가 아니라 상류 장애 문구를 기다려야 한다.
    await screen.findByText(UPSTREAM_MESSAGE);
  }

  it("재시도 중에는 진행 화면이 서고, 진행을 눈으로만 알리지 않는다", async () => {
    await reachAnalyzeError();

    const pending = deferred<ApiResult<AnalyzeResponse>>();
    analyzeMock.mockReturnValue(pending.promise);

    // 1회차 재시도는 간격이 0초라 즉시 나간다 (FR-010).
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));

    // 시스템 동작 — 에러 화면도 업로드 화면도 아닌 진행 화면으로 옮겨 갔다.
    const status = await screen.findByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    // 사용자에게 보이는 것 — 몇 장을 다시 읽는지 분모까지 말한다.
    expect(status).toHaveTextContent("사진 2장을 다시 읽고 있어요");
    expect(screen.queryByText("업로드 화면")).toBeNull();
    expect(screen.queryByText(UPSTREAM_MESSAGE)).toBeNull();

    await act(async () => {
      pending.resolve(ok(makeAnalyze()));
      await pending.promise;
    });

    // 응답이 오면 진행 문구는 남지 않는다 — 낡은 문구가 결과 위에 겹치면
    // 사용자는 아직 읽는 중인 줄 안다.
    await screen.findByRole("heading", { name: "책장을 이렇게 읽었어요" });
    expect(screen.queryByText("사진 2장을 다시 읽고 있어요")).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * ② PRD 5번 [오프라인·네트워크 단절]
 *
 * 계약은 "요청을 중단하고 입력 상태(선택한 사진·기분 텍스트)를 메모리에 유지"다.
 * 요청 중단(AbortSignal)은 `lib/api-client`가 잠갔고, **유지되는 쪽**이 여기다.
 * step 0이 세션의 보존 대상을 리사이즈 결과에서 원본 `File[]`로 바꿨으므로
 * 이 행이 실제로 지키는 값도 그때 바뀌었다.
 * ------------------------------------------------------------------ */

describe("PRD 5번 [오프라인·네트워크 단절] — 고른 사진과 기분이 그대로 남는다", () => {
  it("분석 중 연결이 끊겨도 고른 사진은 남아 재업로드를 요구하지 않는다", async () => {
    analyzeMock.mockResolvedValue(OFFLINE);
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));

    // 사용자에게 보이는 것 — 정해진 문구와 재시도 버튼.
    await screen.findByText(DISCONNECTED_MESSAGE);
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeEnabled();
    // 응답 본문이 없었으므로 오류 ID 줄을 지어내지 않는다.
    expect(screen.queryByText(/오류 ID/)).toBeNull();

    // 시스템 동작 — 사진을 다시 고르라고 하지 않는다. 업로드 화면으로 되돌아가지도 않는다.
    expect(screen.queryByText("업로드 화면")).toBeNull();

    analyzeMock.mockResolvedValue(ok(makeAnalyze()));
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await screen.findByRole("heading", { name: "책장을 이렇게 읽었어요" });

    // 남아 있던 것은 **원본 File** 두 장이고, 재시도는 그 원본에서 다시 만든다.
    expect(resizeMock.mock.calls.map(([file]) => file)).toEqual(FILES);
  });

  it("추천 중 연결이 끊겨도 적었던 기분은 입력창에 그대로 남는다", async () => {
    await reachMoodInput();
    recommendMock.mockResolvedValue(OFFLINE);

    submitMood("번아웃이라 가볍게 읽을 것");
    await screen.findByText(DISCONNECTED_MESSAGE);

    // 사용자에게 보이는 것 — 같은 기분으로 다시 보내는 길과 고쳐 쓰는 길이 함께 있다.
    expect(screen.getByRole("button", { name: "같은 기분으로 다시 추천" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "기분 다시 입력" }));

    // 시스템 동작 — 문장을 다시 쓰게 하지 않는다. 외부 장애 한 번에 사용자가
    // 입력을 잃으면 재시도 비용이 0이 아니게 된다 (PRD 8번 리스크).
    const input = await screen.findByLabelText("지금 기분이나 상황");
    expect(input).toHaveValue("번아웃이라 가볍게 읽을 것");
    // 화면만 옮겼을 뿐 모델을 다시 부르지 않았다.
    expect(recommendMock).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ *
 * ③ PRD 5번 [결과 이탈 (새로고침·뒤로가기)]
 *
 * 무상태라 새로고침하면 사진도 결과도 사라지고 재분석에 모델 비용이 다시 든다
 * (ADR-003). 그래서 `reviewing` 이후에는 이탈을 한 번 되묻는다. **되묻지 않는
 * 쪽도 계약이다** — 잃을 것이 없는 화면에서까지 확인창을 띄우면 경고가 소음이 되고,
 * 정작 결과를 들고 있을 때의 경고까지 무시하게 된다.
 * ------------------------------------------------------------------ */

describe("PRD 5번 [결과 이탈] — 잃을 것이 생긴 뒤에만 되묻는다", () => {
  /** 브라우저가 창을 닫으려 할 때. 우리가 막았으면 `true` */
  function unloadIsWarned(): boolean {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it("업로드 화면(idle)에서는 되묻지 않는다", () => {
    render(<Home />);

    expect(screen.getByText("업로드 화면")).toBeInTheDocument();
    expect(unloadIsWarned()).toBe(false);
  });

  it("첫 분석이 도는 동안에도 아직 되묻지 않는다 — 잃을 결과가 없다", async () => {
    const pending = deferred<ApiResult<AnalyzeResponse>>();
    analyzeMock.mockReturnValue(pending.promise);
    render(<Home />);

    fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));
    expect(unloadIsWarned()).toBe(false);

    await act(async () => {
      pending.resolve(ok(makeAnalyze()));
      await pending.promise;
    });
    await screen.findByRole("heading", { name: "책장을 이렇게 읽었어요" });
  });

  it("결과를 손에 쥔 뒤(reviewing)에는 이탈을 한 번 되묻는다", async () => {
    await analyzeInto(makeAnalyze());

    expect(unloadIsWarned()).toBe(true);
  });

  it("확인 0건·미확인만 남아도 되묻는다 — 미확인 목록도 30초를 들여 얻은 결과다", async () => {
    await analyzeInto(
      makeAnalyze({
        identified: [],
        unidentified: [{ rawText: "읽히지 않은 책등", reason: "lookup_failed", candidates: [] }],
      }),
    );

    expect(screen.getByText("읽어낸 책을 알라딘에서 확인하지 못했어요")).toBeInTheDocument();
    expect(unloadIsWarned()).toBe(true);
  });

  it("추천 결과 화면에서도 되묻는다", async () => {
    await reachMoodInput();
    recommendMock.mockResolvedValue(ok(makeRecommendation()));

    submitMood("번아웃이라 가볍게 읽을 것");
    await screen.findByRole("heading", { name: "이 책은 어때요?" });

    expect(unloadIsWarned()).toBe(true);
  });

  it("사용자가 스스로 처음으로 돌아가면 다시 되묻지 않는다", async () => {
    await analyzeInto(
      makeAnalyze({
        identified: [],
        unidentified: [{ rawText: "읽히지 않은 책등", reason: "no_match", candidates: [] }],
      }),
    );
    expect(unloadIsWarned()).toBe(true);

    // 버리기로 한 것은 사용자다. 그 뒤에 되묻는 것은 자기가 한 선택을 되묻는 것이다.
    fireEvent.click(screen.getByRole("button", { name: "다시 찍기" }));

    expect(screen.getByText("업로드 화면")).toBeInTheDocument();
    expect(unloadIsWarned()).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * ④ PRD 5번 [오프라인·네트워크 단절] — 단절과 상류 장애가 다른 문장을 쓴다
 *
 * `fetch`가 던졌다는 사실은 둘이 같지만 **사용자가 할 수 있는 일**이 다르다.
 * 끊긴 사람에게 "잠시 후 다시 시도해 주세요"라고 말하면 기다려도 아무 일이
 * 일어나지 않고, 상류 장애를 "인터넷 연결을 확인해 주세요"라고 말하면 멀쩡한
 * 연결을 껐다 켜게 만든다. 시스템 문제를 환경 문제로 설명하지 않는다 (ADR-005).
 *
 * **문구와 버튼을 한 검사에서 함께 본다.** `ErrorBanner`의 단위 검사는 자기가
 * `onRetry`를 넘겨 통과시키므로, 화면이 실제로 그 콜백을 넘기는지는 잠기지 않는다.
 * 회복 경로 없는 배너는 사용자가 읽고 나서 할 일이 없는 화면이다.
 * ------------------------------------------------------------------ */

describe("PRD 5번 [오프라인·네트워크 단절] — 단절은 단절이라고 말한다", () => {
  it("분석이 단절로 실패하면 PRD 문구와 재시도 버튼이 함께 선다", async () => {
    analyzeMock.mockResolvedValue(OFFLINE);
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));

    const banner = await screen.findByRole("alert");
    // 사용자에게 보이는 것 — PRD 5번 7행의 문장 그대로.
    expect(banner).toHaveTextContent(DISCONNECTED_MESSAGE);
    // 그리고 눌러서 나갈 문. 화면이 `onRetry`를 실제로 넘겨야만 이 버튼이 선다.
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeEnabled();
    // 상류 장애 문구가 같은 배너에 함께 서면 두 사유를 가른 의미가 없다.
    expect(banner).not.toHaveTextContent(UPSTREAM_MESSAGE);
  });

  it("같은 화면이 502에는 상류 장애 문구를 쓴다", async () => {
    analyzeMock.mockResolvedValue({
      ok: false,
      code: "UPSTREAM_UNAVAILABLE",
      requestId: "req-502",
      status: 502,
    });
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(UPSTREAM_MESSAGE);
    // 이 절반이 없으면 두 코드가 같은 문구로 다시 합쳐져도 위 검사만으로 통과한다.
    expect(banner).not.toHaveTextContent(DISCONNECTED_MESSAGE);
  });
});

/* ------------------------------------------------------------------ *
 * ⑤ PRD 5번 [재추천·재시도 반복] × [오프라인] — 단절은 재시도 몫을 쓰지 않는다
 *
 * FR-010의 재시도 3회는 **비용이 드는 요청**을 세는 예산이다. 연결이 끊겨
 * 상류에 닿지도 못한 요청은 모델 비용을 한 푼도 쓰지 않았으므로 그 몫을 깎을
 * 근거가 없다. 깎으면 지하철에서 세 번 눌러 본 사용자가 지상으로 올라온 순간
 * 재시도 버튼을 잃는다 — 자기가 고칠 수 있었던 문제를 고쳤는데 문이 닫혀 있다.
 *
 * **대조군을 같은 자리에 둔다.** 가드가 "언제나 예산을 쓰지 않는다"로 잘못
 * 구현돼도 앞 검사 하나만으로는 통과하기 때문이다. 간격 의미론(0→5→15초) 자체는
 * `app/page.test.tsx` describe "재시도 간격"이 잠근다 — 여기서 502를 흘리는 것은
 * **몫이 줄어드는 쪽도 살아 있는가**를 보기 위해서다.
 * ------------------------------------------------------------------ */

describe("PRD 5번 [오프라인] — 끊긴 요청은 재시도 예산을 쓰지 않는다 (FR-010)", () => {
  afterEach(() => {
    vi.useRealTimers();
    // `navigator.onLine`을 덮은 채로 두면 뒤따르는 검사가 전부 오프라인 분기를
    // 탄다. `delete`로 되돌리지 않는다 — 원본이 프로토타입의 getter라 `delete`는
    // 그 동작을 되살리지 못하고 `undefined`로 굳힌다.
    vi.restoreAllMocks();
  });

  /**
   * 사용자의 연결 상태. 화면은 `api-client`가 돌려준 **코드**를 보고 분기하므로
   * (그래서 여기서는 `api-client`를 통째로 스텁했다) 이 값은 장면을 맞추는 쪽이다.
   * 그래도 덮는다 — "연결이 돌아온 뒤에도 문이 열려 있는가"가 이 검사의 문장이고,
   * 그 문장을 코드로 적지 않으면 다음 사람이 무엇을 보는 검사인지 알 수 없다.
   */
  function setOnLine(value: boolean): void {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(value);
  }

  function retryButton(): HTMLElement {
    return screen.getByRole("button", { name: "다시 시도" });
  }

  it("세 번 끊겨도 재시도 버튼이 남는다 — 연결이 돌아오면 쓸 수 있어야 한다", async () => {
    setOnLine(false);
    analyzeMock.mockResolvedValue(OFFLINE);
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));
    await screen.findByText(DISCONNECTED_MESSAGE);

    // 502였다면 이 세 번으로 몫이 소진되고 버튼이 사라진다 (아래 대조군).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      fireEvent.click(retryButton());
      await screen.findByText(DISCONNECTED_MESSAGE);
    }

    // 시스템 동작 — 세 번 모두 실제로 나갔다. 버튼만 남고 요청이 막혀 있으면
    // 남아 있다는 사실이 거짓말이 된다.
    expect(analyzeMock).toHaveBeenCalledTimes(4);
    // 몫을 쓰지 않았으므로 간격도 0초에 머문다 (`ANALYZE_RETRY_DELAYS_MS[0]`).
    expect(screen.queryByText(/뒤에 다시 시도할게요/)).toBeNull();

    // 사용자가 지상으로 올라왔다.
    setOnLine(true);
    expect(retryButton()).toBeEnabled();
    // 예산 소진 안내가 서 있으면 버튼과 문장이 서로 다른 말을 하는 화면이 된다.
    expect(screen.queryByText("잠시 후 다시 시도해 주세요")).toBeNull();

    // 버튼이 서 있다는 것만으로는 몫이 남았다고 증명되지 않는다 — 눌러서 결과까지
    // 가는 것이 증명이다. 연결이 돌아온 사용자가 실제로 회복하는 경로가 여기다.
    analyzeMock.mockResolvedValue(ok(makeAnalyze()));
    fireEvent.click(retryButton());
    await screen.findByRole("heading", { name: "책장을 이렇게 읽었어요" });
  });

  it("대조군 — 502로 세 번 실패하면 몫이 소진돼 버튼이 사라진다", async () => {
    analyzeMock.mockResolvedValue({
      ok: false,
      code: "UPSTREAM_UNAVAILABLE",
      requestId: "req-502",
      status: 502,
    });
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));
    await screen.findByText(UPSTREAM_MESSAGE);
    // 에러 화면까지는 실제 타이머로 온다(`findBy*`가 가짜 타이머 아래서 멈춘다).
    // 5초·15초를 진짜로 기다리면 그 비용이 이 리포의 모든 실행에 곱해진다.
    vi.useFakeTimers();

    for (const delayMs of [0, 5_000, 15_000]) {
      fireEvent.click(retryButton());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delayMs);
      });
      // 리사이즈·분석이 비동기라 마이크로태스크를 한 번 더 흘린다.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    expect(analyzeMock).toHaveBeenCalledTimes(4);
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
    expect(screen.getByText("잠시 후 다시 시도해 주세요")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * ⑥ PRD 5번 [로딩] × [오프라인] — 재시도 화면은 실패 사유를 따라 갈리지 않는다
 *   (계약 델타 D-1 · AC-7)
 *
 * ①이 잠근 "재시도 중에도 진행을 알린다"는 **502 경로로만** 흘러 있었다. AC-6의
 * 가드가 들어오면서 오프라인 재시도는 예산 회차를 올리지 않게 됐고, 회차를
 * "이번 분석이 재시도인가"의 답으로 겸해 읽던 자리가 오프라인에서만 틀린 답을
 * 받게 된다 — 그 자리가 업로드 화면과 진행 화면을 가른다.
 *
 * **표식의 이름을 단정하지 않는다.** 무엇으로 재시도를 표시하는지는 구현의 몫이고,
 * 계약은 화면에 무엇이 서는가다. 그래서 두 경로에 **같은 단정 함수**를 건다 —
 * 사유가 무엇이든 사용자가 보는 화면은 하나여야 한다는 것이 이 검사의 문장이다.
 * ------------------------------------------------------------------ */

describe("PRD 5번 [로딩] — 재시도 화면은 실패 사유에 따라 갈리지 않는다", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * 분석을 한 번 실패시킨 뒤 재시도를 걸고, **응답이 오기 전**에 멈춘다.
   * 진행 화면은 그 창 안에만 존재하므로 해소는 호출자가 한다.
   */
  async function retryWhileInFlight(failure: ApiResult<never>, bannerMessage: string) {
    analyzeMock.mockResolvedValue(failure);
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));
    await screen.findByText(bannerMessage);

    const pending = deferred<ApiResult<AnalyzeResponse>>();
    analyzeMock.mockReturnValue(pending.promise);
    // 1회차 재시도는 간격이 0초라 즉시 나간다 (FR-010).
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    return pending;
  }

  /** 두 경로가 **같은** 화면을 그려야 한다. 그래서 단정도 한 벌이다 */
  async function expectRetryProgressScreen() {
    const status = await screen.findByRole("status");
    // 진행을 눈으로만 알리지 않는다.
    expect(status).toHaveAttribute("aria-live", "polite");
    // 몇 장을 다시 읽는지 분모까지 말한다.
    expect(status).toHaveTextContent("사진 2장을 다시 읽고 있어요");
    // 업로드 화면으로 되돌아가면 사용자는 자기가 누른 재시도가 먹지 않고 처음으로
    // 튕긴 줄 안다 — 고른 사진은 그대로인데 화면이 그렇게 말한다.
    expect(screen.queryByText("업로드 화면")).toBeNull();
  }

  it("오프라인 재시도 중에도 진행 표시가 서고 업로드 화면이 서지 않는다", async () => {
    // 예산을 쓰지 않는 것(AC-6)과 재시도임을 아는 것(AC-7)은 서로 다른 질문이다.
    // 한 값이 둘 다 답하면 한쪽을 고치는 순간 다른 쪽이 틀린다.
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const pending = await retryWhileInFlight(OFFLINE, DISCONNECTED_MESSAGE);

    await expectRetryProgressScreen();
    // 낡은 실패 문구가 진행 화면 위에 남으면 재시도가 이미 실패한 것처럼 읽힌다.
    expect(screen.queryByText(DISCONNECTED_MESSAGE)).toBeNull();

    await act(async () => {
      pending.resolve(ok(makeAnalyze()));
      await pending.promise;
    });
    await screen.findByRole("heading", { name: "책장을 이렇게 읽었어요" });
  });

  it("대조군 — 502 재시도도 같은 진행 화면을 그린다", async () => {
    // ①이 이미 502 경로를 잠갔다. 여기서 다시 흘리는 것은 **두 경로가 같은가**를
    // 보기 위해서이고, 그래서 위 검사와 단정 함수를 공유한다. 이 절반이 없으면
    // 오프라인만 통과하는 별도 화면을 만들어도 위 검사가 통과한다.
    const pending = await retryWhileInFlight(
      { ok: false, code: "UPSTREAM_UNAVAILABLE", requestId: "req-502", status: 502 },
      UPSTREAM_MESSAGE,
    );

    await expectRetryProgressScreen();
    expect(screen.queryByText(UPSTREAM_MESSAGE)).toBeNull();

    await act(async () => {
      pending.resolve(ok(makeAnalyze()));
      await pending.promise;
    });
    await screen.findByRole("heading", { name: "책장을 이렇게 읽었어요" });
  });

  it("처음으로 돌아가면 표식이 내려간다 — 새 세션의 첫 분석 중에는 업로드 화면이 선다", async () => {
    // 세우는 자리만 잠그면 **내리는 두 자리를 함께** 지워도 관측되지 않는다(서로를
    // 덮어 주므로 한쪽만 지운 것은 어차피 안 보인다). 그러면 재시도를 겪은 세션에서
    // 첫 분석 중에 진행 화면이 서고, 사용자가 방금 고른 사진과 썸네일이 사라진다.
    const pending = await retryWhileInFlight(OFFLINE, DISCONNECTED_MESSAGE);
    await act(async () => {
      pending.resolve(OFFLINE);
      await pending.promise;
    });
    await screen.findByText(DISCONNECTED_MESSAGE);

    fireEvent.click(screen.getByRole("button", { name: "처음으로" }));
    // 새 세션의 첫 분석. 응답을 주지 않아 진행 중인 창을 열어 둔다.
    analyzeMock.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "사진 2장 분석" }));

    // 첫 분석·재시도·새 세션의 첫 분석 — 세 번. 이 단정이 없으면 분석이 시작조차
    // 하지 않은(그래서 업로드 화면이 그냥 서 있는) 상태로도 아래가 통과한다.
    expect(analyzeMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText("업로드 화면")).toBeInTheDocument();
    expect(screen.queryByText("사진 2장을 다시 읽고 있어요")).toBeNull();
  });
});
