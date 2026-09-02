/**
 * TRD 6.6 접근성 계약 회귀 테스트. **삭제하지 마라.**
 *
 * TRD 6.6은 다섯 줄이다 — 키보드 도달 · 대비 WCAG AA · 표지 `alt` · 미확인 배지의
 * 텍스트 라벨 · 진행 상태 `aria-live`. 다섯 줄 모두 코드가 대체로 지키고 있었지만
 * **지켜지는지 검사하는 것이 없었다.** 누가 `alt`를 지우거나 배지에서 텍스트를 빼도
 * 아무 테스트도 깨지지 않는 상태였다. 이 파일이 그 다섯 줄을 잠근다.
 *
 * ## 왜 한 파일인가
 * 다섯 계약이 전부 **여러 컴포넌트에 걸쳐** 있다. 배지는 `Badge`가 그리지만 그 배지가
 * 색만으로 구분되지 않는지는 `UnidentifiedBookCard` 안에서만 판정되고, 대비는 글자색과
 * 배경색이 서로 다른 컴포넌트에 있을 때 비로소 정해진다. 컴포넌트별 파일에 흩으면
 * 계약 하나가 여러 곳으로 쪼개져 **어느 줄이 무너졌는지 이름으로 알 수 없게 된다.**
 * 그래서 `describe` 이름이 TRD 6.6의 다섯 줄을 번호째로 달고 있다
 * (`common/antipatterns.test.tsx`가 UI_GUIDE 안티패턴 표에 대해 쓰는 것과 같은 수법이다).
 *
 * ## 키보드 검사를 무엇으로 하는가 — 지어내지 않은 것을 밝힌다
 * `@testing-library/user-event`가 이 리포에 **없다.** 새 npm 의존성은 ADR이 먼저이므로
 * (CLAUDE.md CRITICAL) 넣지 않았다. 그리고 jsdom은 네이티브 요소의 **기본 활성화 동작을
 * 구현하지 않는다** — `<button>`에 `keyDown{Enter}`를 쏴도 `click`이 발생하지 않는다.
 * 그러므로 여기서 `fireEvent.keyDown(button, { key: "Enter" })`을 쏘고 콜백을 기대하는
 * 검사는 **브라우저가 아니라 우리 테스트가 만든 통과**가 된다. 그런 검사는 쓰지 않는다.
 *
 * 대신 키보드 조작 가능성을 만드는 **실제 조건 넷**을 검사한다:
 *   ⓐ Tab 순서에 있는가 (`tabOrder`가 문서 순서로 포커스 가능 요소를 모은다)
 *   ⓑ `focus()`로 실제 포커스를 받는가 (`div`는 여기서 떨어진다)
 *   ⓒ **네이티브 활성화 요소**인가 (`button`·`input`·`a[href]`·`summary`·`textarea`).
 *      Enter/Space 활성화는 이 요소들에 대해 **플랫폼이 보장**하는 것이고, `role`·`tabIndex`로
 *      흉내 낸 요소에는 보장되지 않는다 (UI_GUIDE 안티패턴).
 *   ⓓ 핸들러가 실제로 연결돼 있는가 (`fireEvent.click` — 네이티브 요소에서 Enter/Space가
 *      최종적으로 발화시키는 바로 그 `click` 이벤트를 그대로 쏜다)
 *
 * 넷을 함께 통과하면 "Tab으로 닿고 키보드로 눌린다"가 성립한다. `fireEvent.click`만 쓰는
 * 기존 테스트들이 검사하지 못하던 것이 ⓐⓑⓒ다.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, within } from "@testing-library/react";
import type { ShelfBook } from "@/lib/session";
import type { MoodQuestion, Recommendation } from "@/types/api";
import type {
  AladinCandidate,
  IdentifiedBook,
  UnidentifiedBook,
  UnidentifiedReason,
} from "@/types/book";
import { BookCover } from "./booklist/BookCover";
import { BookList } from "./booklist/BookList";
import { IdentifiedBookCard } from "./booklist/IdentifiedBookCard";
import { UnidentifiedBookCard } from "./booklist/UnidentifiedBookCard";
import { AladinLink } from "./common/AladinLink";
import { Badge } from "./common/Badge";
import { ClaudeText } from "./common/ClaudeText";
import { ErrorBanner } from "./common/ErrorBanner";
import { Notice } from "./common/Notice";
import { Skeleton } from "./common/Skeleton";
import { GuidedQuestions } from "./mood/GuidedQuestions";
import { MoodInput } from "./mood/MoodInput";
import { RecommendationCard } from "./recommend/RecommendationCard";
import { RecommendationList } from "./recommend/RecommendationList";
import { CaptureGuide } from "./upload/CaptureGuide";
import { PhotoPicker } from "./upload/PhotoPicker";
import { PhotoThumbnails } from "./upload/PhotoThumbnails";
import { RejectedNotice } from "./upload/RejectedNotice";
import { UploadScreen } from "./upload/UploadScreen";

// ---------------------------------------------------------------- 픽스처
// 이 리포는 픽스처를 공유 모듈로 두지 않고 테스트 파일마다 세운다. 그 관행을 따른다.

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
    proof: "proof-1",
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<AladinCandidate> = {}): AladinCandidate {
  return {
    isbn13: "9788937460777",
    title: "데미안",
    author: "헤르만 헤세",
    publisher: "민음사",
    coverUrl: "https://image.aladin.co.kr/product/2/2/cover/8937460777.jpg",
    ...overrides,
  };
}

function makeUnidentified(
  reason: UnidentifiedReason,
  candidates: AladinCandidate[] = [],
): UnidentifiedBook {
  return { rawText: "코스모ㅅ 칼세이", reason, candidates };
}

function photoBook(): ShelfBook {
  return { origin: "photo", book: makeIdentified() };
}

const QUESTIONS: MoodQuestion[] = [
  {
    id: "q1",
    question: "지금 머리를 쓰고 싶으세요?",
    options: ["가볍게", "깊게", "상관없어요"],
  },
  {
    id: "q2",
    question: "얼마나 길게 읽으실 건가요?",
    options: ["짧게", "길게", "모르겠어요"],
  },
];

const RECOMMENDATION: Recommendation = {
  bookId: "9788934972464",
  reason: "분량은 두껍지만 한 장씩 끊어 읽기 좋아 지금 컨디션에 맞는다",
  position: 1,
};

// ------------------------------------------------- 키보드 도달 검사 도구 (①)

/** 네이티브로 Enter/Space 활성화가 보장되는 요소들 */
const NATIVE_INTERACTIVE = ["A", "BUTTON", "INPUT", "SELECT", "SUMMARY", "TEXTAREA"];

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[tabindex]",
].join(",");

/**
 * 브라우저가 Tab으로 훑는 순서 — 문서 순서의 포커스 가능 요소들.
 *
 * `disabled`와 `tabindex="-1"`은 순서에서 빠진다. 이것이 "비활성 버튼이 포커스를
 * 삼키지 않는다"를 검사할 수 있게 해 준다.
 */
function tabOrder(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      !el.hasAttribute("disabled") &&
      el.getAttribute("aria-hidden") !== "true" &&
      el.getAttribute("tabindex") !== "-1",
  );
}

/**
 * ⓐ Tab 순서에 있고 ⓑ 실제로 포커스를 받고 ⓒ 네이티브 활성화 요소인지를 한 번에 단정한다.
 * ⓓ(핸들러 연결)는 호출부가 `fireEvent.click` 뒤 콜백으로 확인한다.
 */
function expectKeyboardOperable(container: HTMLElement, el: HTMLElement) {
  expect(tabOrder(container)).toContain(el);

  el.focus();
  expect(document.activeElement).toBe(el);

  // role/tabIndex 로 흉내 낸 요소는 여기서 떨어진다 — 시맨틱 요소로 될 일을
  // ARIA 로 대신하는 것이 UI_GUIDE 가 말하는 안티패턴이다.
  expect(NATIVE_INTERACTIVE).toContain(el.tagName);
}

describe("TRD 6.6 ① 키보드만으로 모든 인터랙션에 도달한다", () => {
  it("파일 선택 — 촬영·선택 두 경로가 모두 Tab 순서의 네이티브 input 이다", () => {
    const { container, getByLabelText } = render(<PhotoPicker onSelect={vi.fn()} />);

    // 카메라 권한이 거부돼도 파일 선택 경로가 남아야 하므로 둘 다 항상 있어야 한다 (PRD 5번).
    for (const label of ["책장 촬영", "사진 선택"]) {
      expectKeyboardOperable(container, getByLabelText(label));
    }

    expect(tabOrder(container)).toHaveLength(2);
  });

  it("미확인 수정 입력 — 사유별 진입 경로가 키보드로 눌린다", () => {
    const onResolve = vi.fn();
    const unreadable = render(
      <UnidentifiedBookCard book={makeUnidentified("unreadable")} onResolve={onResolve} />,
    );
    const resolveButton = within(unreadable.container).getByRole("button", {
      name: "제목 직접 입력",
    });
    expectKeyboardOperable(unreadable.container, resolveButton);
    fireEvent.click(resolveButton);
    expect(onResolve).toHaveBeenCalledTimes(1);

    const onRetryLookup = vi.fn();
    const failed = render(
      <UnidentifiedBookCard
        book={makeUnidentified("lookup_failed")}
        onRetryLookup={onRetryLookup}
      />,
    );
    const retryButton = within(failed.container).getByRole("button", { name: "다시 시도" });
    expectKeyboardOperable(failed.container, retryButton);
    fireEvent.click(retryButton);
    expect(onRetryLookup).toHaveBeenCalledTimes(1);

    // ambiguous 는 재검색이 아니라 후보 선택이 경로다 (US-002 AC).
    const onSelectCandidate = vi.fn();
    const ambiguous = render(
      <UnidentifiedBookCard
        book={makeUnidentified("ambiguous", [makeCandidate()])}
        onSelectCandidate={onSelectCandidate}
      />,
    );
    const candidateButton = within(ambiguous.container).getAllByRole("button")[0];
    expectKeyboardOperable(ambiguous.container, candidateButton);
    fireEvent.click(candidateButton);
    expect(onSelectCandidate).toHaveBeenCalledTimes(1);
  });

  it("추천 수락 버튼 — 키보드로 눌리고, 수락 뒤에는 비활성이되 사라지지 않는다", () => {
    const onAccept = vi.fn();
    const { container, getByRole, rerender } = render(
      <RecommendationCard
        book={makeIdentified()}
        recommendation={RECOMMENDATION}
        onAccept={onAccept}
      />,
    );

    const accept = getByRole("button", { name: "이거 읽을래요" });
    expectKeyboardOperable(container, accept);
    fireEvent.click(accept);
    expect(onAccept).toHaveBeenCalledWith("9788934972464", 1);

    rerender(
      <RecommendationCard
        book={makeIdentified()}
        recommendation={RECOMMENDATION}
        onAccept={onAccept}
        accepted
      />,
    );

    // 감추지 않고 비활성 — 다만 비활성 버튼이 Tab 순서를 삼키지는 않는다.
    const chosen = getByRole("button", { name: "읽을 책으로 골랐어요" });
    expect(chosen).toBeInTheDocument();
    expect(tabOrder(container)).not.toContain(chosen);
  });

  it("문답 선택지 — 라디오가 Tab 순서에 있고 선택이 반영된다", () => {
    const { container, getByLabelText, getByRole } = render(
      <GuidedQuestions questions={QUESTIONS} onSubmit={vi.fn()} onSkip={vi.fn()} />,
    );

    const option = getByLabelText("가볍게");
    expectKeyboardOperable(container, option);
    fireEvent.click(option);
    expect((option as HTMLInputElement).checked).toBe(true);

    // 모두 답하기 전에는 제출이 비활성이고, 그때도 DOM 에서 사라지지 않는다.
    const submit = getByRole("button", { name: "추천받기" });
    expect(submit).toBeInTheDocument();
    expect(tabOrder(container)).not.toContain(submit);
  });

  it("기분 입력 — textarea·예시·제출이 모두 네이티브 요소로 Tab 순서에 있다", () => {
    const onSubmit = vi.fn();
    const { container, getByLabelText, getByRole } = render(
      <MoodInput onSubmit={onSubmit} onGuidedStart={vi.fn()} />,
    );

    expectKeyboardOperable(container, getByLabelText("지금 기분이나 상황"));

    const example = getByRole("button", { name: "요즘 번아웃이라 가볍게 읽을 것" });
    expectKeyboardOperable(container, example);
    fireEvent.click(example);

    const submit = getByRole("button", { name: "추천받기" });
    expectKeyboardOperable(container, submit);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith("요즘 번아웃이라 가볍게 읽을 것");
  });

  it("촬영 가이드 시트 — summary 로 펼쳐 키보드·스크린리더가 기본 동작을 받는다", () => {
    const { container, getByText } = render(<CaptureGuide />);

    // 직접 만든 토글이면 펼침·포커스·확장 상태를 전부 다시 구현해야 한다.
    expectKeyboardOperable(container, getByText("어떻게 찍으면 잘 읽히나요?"));
  });

  it("에러 배너 — 재시도·처음으로·오류 ID 복사가 전부 버튼이다", () => {
    const onRetry = vi.fn();
    const { container, getByRole } = render(
      <ErrorBanner
        code="UPSTREAM_UNAVAILABLE"
        requestId="req-a11y"
        onRetry={onRetry}
        onReset={vi.fn()}
      />,
    );

    for (const name of ["다시 시도", "처음으로", /오류 ID/]) {
      expectKeyboardOperable(container, getByRole("button", { name }));
    }

    fireEvent.click(getByRole("button", { name: "다시 시도" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("에러 배너 — 재시도 대기 중에는 감추지 않고 비활성한다 (FR-010)", () => {
    const { container, getByRole } = render(
      <ErrorBanner code="TIMEOUT" requestId={null} onRetry={vi.fn()} retryDisabled />,
    );

    const retry = getByRole("button", { name: "다시 시도" });
    expect(retry).toBeInTheDocument();
    expect(tabOrder(container)).not.toContain(retry);
  });

  it("분석 결과 화면 — 부분 실패 재시도와 알라딘 링크가 키보드로 닿는다", () => {
    const onRetryPhoto = vi.fn();
    const { container, getByRole } = render(
      <BookList
        books={[photoBook()]}
        unidentified={[makeUnidentified("no_match")]}
        overflowCount={0}
        unidentifiedOverflowCount={0}
        failedPhotoCount={1}
        failedPhotoIndexes={[2]}
        photoCount={3}
        onRetryPhoto={onRetryPhoto}
        onResolve={vi.fn()}
      />,
    );

    const retry = getByRole("button", { name: "이 사진만 다시 시도" });
    expectKeyboardOperable(container, retry);
    fireEvent.click(retry);
    expect(onRetryPhoto).toHaveBeenCalledWith([2]);

    // 외부 링크도 인터랙션이다 — a[href] 라야 Tab 과 Enter 가 따라온다 (FR-013).
    expectKeyboardOperable(container, getByRole("link", { name: /알라딘에서 보기/ }));
  });

  it("썸네일 제거 · 추천 결과의 두 버튼이 모두 Tab 순서에 있다", () => {
    const onRemove = vi.fn();
    const thumbs = render(
      <PhotoThumbnails
        photos={[{ id: "a", name: "shelf.jpg", previewUrl: null, tooSmall: false }]}
        onRemove={onRemove}
      />,
    );
    const remove = within(thumbs.container).getByRole("button", { name: "shelf.jpg 제거" });
    expectKeyboardOperable(thumbs.container, remove);
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledWith("a");

    const onSaveImage = vi.fn();
    const list = render(
      <RecommendationList
        recommendations={[RECOMMENDATION]}
        books={[makeIdentified()]}
        shortfall={false}
        canRecommendAgain
        isSavingImage={false}
        saveImageFailed={false}
        onAccept={vi.fn()}
        onRecommendAgain={vi.fn()}
        onSaveImage={onSaveImage}
      />,
    );
    const save = within(list.container).getByRole("button", { name: "이미지로 저장" });
    expectKeyboardOperable(list.container, save);
    fireEvent.click(save);
    expect(onSaveImage).toHaveBeenCalledTimes(1);

    expectKeyboardOperable(
      list.container,
      within(list.container).getByRole("button", { name: "다시 추천받기" }),
    );
  });

  it("어느 화면에도 role/tabIndex 로 흉내 낸 버튼이 없다", () => {
    for (const { container } of renderEveryScreen()) {
      // 시맨틱 요소가 있는데 ARIA 로 대신하는 것이 안티패턴이다 (UI_GUIDE).
      for (const faked of container.querySelectorAll('[role="button"], [role="link"]')) {
        expect(NATIVE_INTERACTIVE).toContain(faked.tagName);
      }

      // 포커스 순서를 손으로 재배열한 곳이 없어야 문서 순서 = Tab 순서가 유지된다.
      for (const el of container.querySelectorAll("[tabindex]")) {
        expect(Number(el.getAttribute("tabindex"))).toBeLessThanOrEqual(0);
      }
    }
  });
});

describe("TRD 6.6 ② 표지 이미지의 alt 는 '{제목} 표지'다", () => {
  it("표지가 있으면 img 의 alt 가 제목을 담는다 (빈 alt 를 쓰지 않는다)", () => {
    const { getByAltText } = render(
      <BookCover coverUrl="https://image.aladin.co.kr/cover.jpg" title="코스모스" />,
    );

    const img = getByAltText("코스모스 표지");
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("alt")).not.toBe("");
  });

  it("표지가 없을 때와 로드에 실패했을 때 같은 폴백이 같은 이름을 유지한다", () => {
    const missing = render(<BookCover coverUrl={null} title="코스모스" />);
    expect(
      within(missing.container).getByRole("img", { name: "코스모스 표지" }),
    ).toBeInTheDocument();

    const broken = render(
      <BookCover coverUrl="https://image.aladin.co.kr/404.jpg" title="데미안" />,
    );
    fireEvent.error(within(broken.container).getByAltText("데미안 표지"));
    // 깨진 이미지 아이콘을 노출하지 않되, 접근 가능한 이름은 잃지 않는다.
    expect(
      within(broken.container).getByRole("img", { name: "데미안 표지" }),
    ).toBeInTheDocument();
    expect(broken.container.querySelector("img")).toBeNull();
  });

  it("제목이 비어도 'undefined 표지'·'null 표지' 같은 문자열이 새지 않는다", () => {
    const { getByRole } = render(<BookCover coverUrl={null} title="" />);

    const name = getByRole("img").getAttribute("aria-label") ?? "";
    expect(name).not.toContain("undefined");
    expect(name).not.toContain("null");
    expect(name).toContain("표지");
  });

  it("사진 썸네일도 장식이 아니라 정보로 이름을 갖는다", () => {
    const withPreview = render(
      <PhotoThumbnails
        photos={[{ id: "a", name: "shelf.jpg", previewUrl: "blob:x", tooSmall: false }]}
        onRemove={vi.fn()}
      />,
    );
    expect(
      within(withPreview.container).getByAltText("shelf.jpg 미리보기"),
    ).toBeInTheDocument();

    const withoutPreview = render(
      <PhotoThumbnails
        photos={[{ id: "b", name: "shelf2.jpg", previewUrl: null, tooSmall: false }]}
        onRemove={vi.fn()}
      />,
    );
    expect(
      within(withoutPreview.container).getByRole("img", { name: "shelf2.jpg 미리보기" }),
    ).toBeInTheDocument();
  });
});

describe("TRD 6.6 ③ 미확인 배지는 색상만으로 구분하지 않는다", () => {
  const REASONS: UnidentifiedReason[] = [
    "unreadable",
    "no_match",
    "ambiguous",
    "lookup_failed",
  ];

  it.each(REASONS)("%s 배지에 텍스트 라벨이 함께 있다", (reason) => {
    const { container } = render(<Badge kind="reason" reason={reason} />);

    expect(container.textContent?.trim()).not.toBe("");
  });

  it("평점 배지도 이름이 비어 있지 않고 출처를 밝힌다", () => {
    const { container } = render(<Badge kind="rating" rating={8.6} />);

    // 별 아이콘 없이 "독자 8.6" — 우리 점수가 아니라 알라딘 독자평점이다.
    expect(container.textContent).toContain("독자");
    expect(container.textContent).toContain("8.6");
  });

  it("사유 4종의 배지 문구가 서로 겹치지 않는다", () => {
    const labels = REASONS.map(
      (reason) => render(<Badge kind="reason" reason={reason} />).container.textContent,
    );

    expect(new Set(labels).size).toBe(REASONS.length);
  });

  /**
   * ADR-005 가 화면에서 무너지는 지점이 정확히 여기다. `lookup_failed`(지금 확인 못 함)와
   * `no_match`(알라딘에 정말 없음)는 사용자에게 **다른 사실**인데, 그 차이가 배지 색으로만
   * 표현되면 색을 구분하지 못하는 사용자에게는 두 사유가 같은 것이 된다.
   */
  it("lookup_failed 와 no_match 가 배지·설명 문장 모두에서 텍스트로 갈린다", () => {
    const failed = render(<UnidentifiedBookCard book={makeUnidentified("lookup_failed")} />);
    const noMatch = render(<UnidentifiedBookCard book={makeUnidentified("no_match")} />);

    const failedText = failed.container.textContent ?? "";
    const noMatchText = noMatch.container.textContent ?? "";

    expect(failedText).toContain("확인 못 함");
    expect(failedText).toContain("지금 확인할 수 없었어요");
    expect(noMatchText).toContain("검색 결과 없음");
    expect(noMatchText).toContain("원서·절판일 수 있어요");

    // 시스템 문제를 데이터 문제로 설명하지 않는다 — 이 한 줄이 ADR-005 그 자체다.
    expect(failedText).not.toContain("절판");
    expect(failedText).not.toContain("원서");
  });
});

describe("TRD 6.6 ④ 진행 상태를 aria-live 로 알린다", () => {
  it("분석 진행 — 시작하면 라이브 영역에 문구가 들어오고 끝나면 낡은 문구가 남지 않는다", () => {
    const { queryByRole, getByRole, rerender } = render(
      <UploadScreen onAnalyze={vi.fn()} isAnalyzing={false} />,
    );

    expect(queryByRole("status")).toBeNull();

    rerender(<UploadScreen onAnalyze={vi.fn()} isAnalyzing />);
    const live = getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live.textContent).toContain("책등을 읽고 있어요");

    rerender(<UploadScreen onAnalyze={vi.fn()} isAnalyzing={false} />);
    expect(queryByRole("status")).toBeNull();
  });

  it("문답 생성 진행도 같은 방식으로 알린다", () => {
    const { getByRole, queryByRole, rerender } = render(
      <GuidedQuestions questions={[]} onSubmit={vi.fn()} onSkip={vi.fn()} isLoading />,
    );

    const live = getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live.textContent).toContain("질문을 만들고 있어요");

    rerender(<GuidedQuestions questions={QUESTIONS} onSubmit={vi.fn()} onSkip={vi.fn()} />);
    expect(queryByRole("status")).toBeNull();
  });

  it("이미지 저장 — 진행·실패가 같은 라이브 영역에서 갈리고 낡은 문구를 남기지 않는다", () => {
    function list(isSavingImage: boolean, saveImageFailed: boolean) {
      return (
        <RecommendationList
          recommendations={[RECOMMENDATION]}
          books={[makeIdentified()]}
          shortfall={false}
          canRecommendAgain
          isSavingImage={isSavingImage}
          saveImageFailed={saveImageFailed}
          onAccept={vi.fn()}
          onRecommendAgain={vi.fn()}
          onSaveImage={vi.fn()}
        />
      );
    }

    const { getByRole, rerender } = render(list(true, false));
    const live = getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live.textContent).toContain("이미지를 만들고 있어요");

    rerender(list(false, true));
    // 실패도 화면을 바꾸지 않는 안내다 — role="alert" 를 쓰지 않는다 (UI_GUIDE).
    expect(getByRole("status").textContent).toContain("이미지를 만들지 못했어요");

    rerender(list(false, false));
    expect(getByRole("status").textContent).toBe("");
  });

  it("거부된 파일 안내도 선택 직후 라이브 영역으로 들어온다", () => {
    const { queryByRole, getByRole, rerender } = render(<RejectedNotice reasons={[]} />);

    expect(queryByRole("status")).toBeNull();

    rerender(<RejectedNotice reasons={["too_many"]} />);
    expect(getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(getByRole("status").textContent).toContain("장까지 올릴 수 있어요");
  });

  it("스켈레톤은 장식이므로 보조기술에서 숨긴다 (진행 문구와 이중으로 읽히지 않는다)", () => {
    const { container } = render(<Skeleton className="h-4 w-24" />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");

    // 진행 중 화면에서도 읽히는 것은 문구뿐이고 스켈레톤은 전부 숨겨져 있다.
    const busy = render(<UploadScreen onAnalyze={vi.fn()} isAnalyzing />);
    const live = busy.getByRole("status");
    expect(live.querySelectorAll("[aria-hidden='true']").length).toBeGreaterThan(0);
    expect(within(live).getByText("책등을 읽고 있어요")).toBeInTheDocument();
  });
});

// ------------------------------------------------------- 대비 계산 도구 (⑤)

/**
 * UI_GUIDE 색상표. 토큰 → hex 의 단일 출처는 `src/app/globals.css` 의 `@theme` 이고,
 * 그 값은 UI_GUIDE 색상 절에서 왔다. 여기 표가 그 둘과 어긋나면 이 테스트는 실제 화면이
 * 아니라 자기 상상에 대해 도는 것이 되므로, **토큰을 추가·변경할 때 함께 고친다.**
 */
const TOKEN_HEX: Record<string, string> = {
  page: "#faf9f7",
  card: "#ffffff",
  "muted-surface": "#f5f2ed",
  line: "#e5e1da",
  ink: "#1a1a1a",
  body: "#3d3a36",
  subtle: "#6b6560",
  disabled: "#8c8681",
  accent: "#2f5d50",
  "accent-strong": "#264a40",
  unverified: "#b45309",
  danger: "#b3261e",
  white: "#ffffff",
};

const TOKEN_NAMES = Object.keys(TOKEN_HEX);

function toRgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/** WCAG 2.1 상대 휘도 */
function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 명도 대비. AA 본문 기준은 4.5:1 (TRD 6.6) */
function contrastRatio(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** 반투명 배경(`bg-unverified/10` 등)을 아래 배경 위에 합성한다 */
function composite(hex: string, alpha: number, under: string): string {
  const [f, u] = [toRgb(hex), toRgb(under)];
  return `#${f
    .map((v, i) =>
      Math.round(v * alpha + u[i] * (1 - alpha))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** 변형 접두사(`hover:`·`disabled:`·`placeholder:`)가 붙은 클래스는 기본 상태가 아니다 */
function baseClasses(el: Element): string[] {
  return (el.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter((cls) => cls !== "" && !cls.includes(":"));
}

function tokenOf(el: Element, prefix: "text" | "bg"): { name: string; alpha: number } | null {
  for (const cls of baseClasses(el)) {
    const match = /^(text|bg)-([a-z-]+)(?:\/(\d+))?$/.exec(cls);
    if (match === null || match[1] !== prefix) continue;
    if (!TOKEN_NAMES.includes(match[2])) continue;
    return { name: match[2], alpha: match[3] === undefined ? 1 : Number(match[3]) / 100 };
  }
  return null;
}

interface Layer {
  hex: string;
  label: string;
}

/** 자기 자신부터 위로 올라가며 배경을 찾고, 반투명이면 그 아래 배경과 합성한다 */
function backgroundAt(el: Element | null): Layer {
  if (el === null || el.nodeName === "BODY") return { hex: TOKEN_HEX.page, label: "page" };

  const bg = tokenOf(el, "bg");
  if (bg === null) return backgroundAt(el.parentElement);
  if (bg.alpha === 1) return { hex: TOKEN_HEX[bg.name], label: bg.name };

  const under = backgroundAt(el.parentElement);
  return {
    hex: composite(TOKEN_HEX[bg.name], bg.alpha, under.hex),
    label: `${bg.name}/${Math.round(bg.alpha * 100)} over ${under.label}`,
  };
}

/** 글자색은 상속된다 — 자기 자신부터 위로 찾고, 없으면 body 기본색(ink)이다 */
function foregroundAt(el: Element | null): string {
  if (el === null || el.nodeName === "BODY") return "ink";
  const fg = tokenOf(el, "text");
  return fg === null ? foregroundAt(el.parentElement) : fg.name;
}

/** 직접 텍스트를 가진 요소만 판정 대상이다 — 컨테이너는 글자를 그리지 않는다 */
function hasOwnText(el: Element): boolean {
  return Array.from(el.childNodes).some(
    (node) => node.nodeType === 3 && (node.textContent ?? "").trim() !== "",
  );
}

/** 화면 전체에서 실제로 쓰인 (글자색, 배경색) 조합을 모은다 */
function collectUsedPairs(): Set<string> {
  const pairs = new Set<string>();
  for (const { container } of renderEveryScreen()) {
    for (const el of container.querySelectorAll("*")) {
      if (!hasOwnText(el)) continue;
      pairs.add(`${foregroundAt(el)} on ${backgroundAt(el).label}`);
    }
  }
  return pairs;
}

function ratioOfPair(pair: string): number {
  const [fg, bgLabel] = pair.split(" on ");
  const over = /^(.+)\/(\d+) over (.+)$/.exec(bgLabel);
  const bgHex =
    over === null
      ? TOKEN_HEX[bgLabel]
      : composite(TOKEN_HEX[over[1]], Number(over[2]) / 100, TOKEN_HEX[over[3]]);
  return contrastRatio(TOKEN_HEX[fg], bgHex);
}

/**
 * 화면에서 쓰이는 글자색·배경색 조합 전부. 컴포넌트가 이 밖의 조합을 쓰면 실패한다.
 *
 * 목록을 손으로 들고 있는 이유는 Tailwind 클래스만으로는 **렌더된 실제 색을 계산할 수
 * 없기** 때문이다(jsdom 은 CSS 를 적용하지 않고 `@theme` 토큰은 빌드 시점에 해석된다).
 * 그러므로 이 검사가 재는 것은 "브라우저가 칠한 픽셀"이 아니라 **"마크업이 요구한 토큰
 * 조합"**이다. 그 한계는 이 describe 의 마지막 `it` 이 명시적으로 적어 둔다.
 */
const ALLOWED_PAIRS: readonly string[] = [
  "ink on page",
  "ink on card",
  "body on page",
  "body on card",
  "body on muted-surface",
  "subtle on page",
  "subtle on card",
  "subtle on muted-surface",
  "accent on muted-surface",
  "unverified on page",
  "white on accent",
  // 아래 셋은 UI_GUIDE 가 그 자리에 그 색을 지정한 조합이면서 AA(4.5:1)를 통과하지 못한다.
  // 새 토큰을 만들어 덮지 않고 드러낸 채로 둔다 — 색상표 변경은 문서의 결정이다.
  "disabled on page",
  "disabled on card",
  "unverified on unverified/10 over muted-surface",
];

/** AA 미달인 채로 남기기로 한 조합. 늘어나면 아래 테스트가 깨진다 */
const BELOW_AA: readonly string[] = [
  // ClaudeText 라벨 — UI_GUIDE "Claude 생성 텍스트 블록"이 text-[#8C8681] 로 지정 (3.42:1)
  "disabled on page",
  // ErrorBanner 오류 ID 줄 — UI_GUIDE "에러 배너"가 text-[#8C8681] 로 지정 (3.59:1)
  "disabled on card",
  // 미확인 배지 — UI_GUIDE "배지"가 bg-[#B45309]/10 text-[#B45309] 로 지정 (3.95:1)
  "unverified on unverified/10 over muted-surface",
];

/** 화면 다섯 종을 이루는 조각 전부. ①의 "흉내 낸 버튼" 검사와 ⑤가 함께 쓴다 */
function renderEveryScreen() {
  return [
    render(
      <BookList
        books={[photoBook()]}
        unidentified={[
          makeUnidentified("unreadable"),
          makeUnidentified("no_match"),
          makeUnidentified("ambiguous", [makeCandidate()]),
          makeUnidentified("lookup_failed"),
        ]}
        overflowCount={2}
        unidentifiedOverflowCount={3}
        failedPhotoCount={1}
        failedPhotoIndexes={[1]}
        photoCount={3}
        onResolve={vi.fn()}
        onSelectCandidate={vi.fn()}
        onRetryLookup={vi.fn()}
        onRetryPhoto={vi.fn()}
      />,
    ),
    render(<IdentifiedBookCard book={makeIdentified()} />),
    render(<UploadScreen onAnalyze={vi.fn()} isAnalyzing />),
    render(<PhotoPicker onSelect={vi.fn()} />),
    render(
      <PhotoThumbnails
        photos={[{ id: "a", name: "shelf.jpg", previewUrl: null, tooSmall: true }]}
        onRemove={vi.fn()}
      />,
    ),
    render(<RejectedNotice reasons={["too_many", "decode_failed"]} />),
    render(<CaptureGuide />),
    render(<MoodInput onSubmit={vi.fn()} onGuidedStart={vi.fn()} irrelevantCount={2} />),
    render(<GuidedQuestions questions={QUESTIONS} onSubmit={vi.fn()} onSkip={vi.fn()} />),
    render(
      <RecommendationList
        recommendations={[RECOMMENDATION]}
        books={[makeIdentified()]}
        shortfall
        canRecommendAgain={false}
        isSavingImage={false}
        saveImageFailed
        onAccept={vi.fn()}
        onRecommendAgain={vi.fn()}
        onSaveImage={vi.fn()}
      />,
    ),
    render(
      <RecommendationCard
        book={makeIdentified()}
        recommendation={RECOMMENDATION}
        onAccept={vi.fn()}
        accepted
      />,
    ),
    render(
      <ErrorBanner
        code="INTERNAL_ERROR"
        requestId="req-a11y"
        onRetry={vi.fn()}
        onReset={vi.fn()}
      />,
    ),
    render(<ClaudeText label="AI 한줄평" text="가볍게 읽히는데 여운이 길다" />),
    render(<Notice>50권까지만 보여드려요 (2권 더 있음)</Notice>),
    render(<AladinLink href="https://www.aladin.co.kr/shop/x" title="코스모스" />),
    render(<BookCover coverUrl={null} title="코스모스" />),
  ];
}

describe("TRD 6.6 ⑤ 텍스트 대비 WCAG AA (4.5:1)", () => {
  it("UI_GUIDE 색상표가 허용한 글자색·배경색 조합만 쓴다", () => {
    // 목록 밖 조합이 하나라도 들어오면 여기서 이름과 함께 드러난다.
    const unexpected = [...collectUsedPairs()].filter(
      (pair) => !ALLOWED_PAIRS.includes(pair),
    );

    expect(unexpected).toEqual([]);
  });

  it("허용 목록에 죽은 조합이 없다 (검사가 실제 화면에 대해 돈다)", () => {
    const used = collectUsedPairs();

    // 쓰이지 않는 조합을 목록에 남겨 두면 허용 목록이 조용히 느슨해진다.
    expect(ALLOWED_PAIRS.filter((pair) => !used.has(pair))).toEqual([]);
  });

  it("AA 미달로 남은 조합은 UI_GUIDE 가 그 자리에 지정한 셋뿐이다", () => {
    const failing = ALLOWED_PAIRS.filter((pair) => ratioOfPair(pair) < 4.5);

    // 늘어나면 깨진다. 문서가 색을 고쳐 줄어들면 그때 두 목록을 함께 줄인다.
    expect(failing).toEqual([...BELOW_AA]);
  });

  it("AA 미달 셋을 뺀 나머지는 모두 4.5:1 이상이다", () => {
    for (const pair of ALLOWED_PAIRS) {
      if (BELOW_AA.includes(pair)) continue;
      expect(ratioOfPair(pair), pair).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("대비 계산기 자체가 WCAG 기준값을 재현한다", () => {
    // 계산기가 틀리면 위 검사들이 전부 무의미해진다. 알려진 기준점으로 고정한다.
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // #767676 은 흰 배경에서 AA 를 겨우 통과하는 것으로 알려진 경계값이다.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#797979", "#ffffff")).toBeLessThan(4.5);
  });

  /**
   * **재지 못한 것을 통과로 적지 않는다** (골든 세트의 skip 과 같은 규율, ADR-010).
   *
   * 여기서 재는 것은 마크업이 요구한 **토큰 조합**이지 브라우저가 칠한 픽셀이 아니다.
   * jsdom 은 CSS 를 적용하지 않고 `@theme` 토큰은 빌드 시점에 해석되므로, 실제 렌더 색을
   * 읽어 재는 검사는 이 환경에서 성립하지 않는다. 그래서 아래는 **재지 못한다**:
   *   · `hover:`·`focus:`·`placeholder:` 등 변형 상태의 색 (기본 상태만 잰다)
   *   · 글자 크기·굵기에 따른 AA Large(3:1) 완화 (전부 4.5:1 로 엄격하게 잰다)
   *   · 이미지·표지 위에 겹치는 글자 (이 화면들에는 그런 배치가 없다)
   * 이 검사가 사라지면 다음 사람은 대비가 전부 검증된 줄 안다.
   */
  it("변형 상태의 색은 재지 않는다는 사실 자체를 고정한다", () => {
    const textarea = render(
      <MoodInput onSubmit={vi.fn()} onGuidedStart={vi.fn()} />,
    ).getByLabelText("지금 기분이나 상황");

    // 이 클래스는 실제로 존재하지만 (변형 접두사가 붙어) 위 대비 검사의 대상이 아니다.
    expect(textarea.getAttribute("class")).toContain("placeholder:text-disabled");
    expect(baseClasses(textarea)).not.toContain("placeholder:text-disabled");
  });
});
