/**
 * 분석 결과 화면의 배치 — 부분 실패 배너·확인 목록·미확인 섹션·안내 문구.
 *
 * "못 한 일을 숨기지 않는다"(UI_GUIDE 원칙 3)가 배치의 문제이기도 하다는 점을 고정한다.
 * 실패를 목록 뒤에 알리면 사용자는 이미 그 목록이 전부인 줄 안다.
 *
 * 확인된 책이 **한 목록**이라는 것도 여기서 고정한다. 사진에서 온 책과 재검색으로
 * 합류한 책은 같은 자격이므로(ADR-002·ADR-006) 목록을 가르지 않되, 출처는 숨기지
 * 않고 없는 값(한줄평·사진 출처)을 지어내지도 않는다.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { ShelfBook } from "@/lib/session";
import type {
  AladinCandidate,
  IdentifiedBook,
  ResolvedCandidate,
  UnidentifiedBook,
} from "@/types/book";
import { BookList } from "./BookList";
import type { BookListProps } from "./BookList";

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

function makeResolved(overrides: Partial<ResolvedCandidate> = {}): ResolvedCandidate {
  return {
    isbn13: "9788937460777",
    title: "데미안",
    author: "헤르만 헤세",
    publisher: "민음사",
    coverUrl: "https://image.aladin.co.kr/product/2/2/cover/8937460777.jpg",
    pages: 240,
    aladinRating: 9.1,
    aladinLink: "https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=2",
    proof: "proof-2",
    ...overrides,
  };
}

function photoBook(overrides: Partial<IdentifiedBook> = {}): ShelfBook {
  return { origin: "photo", book: makeIdentified(overrides) };
}

function resolvedBook(overrides: Partial<ResolvedCandidate> = {}): ShelfBook {
  return { origin: "resolved", book: makeResolved(overrides) };
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

function makeUnidentified(overrides: Partial<UnidentifiedBook> = {}): UnidentifiedBook {
  return {
    rawText: "데미아 헤르만헤세",
    reason: "unreadable",
    candidates: [],
    ...overrides,
  };
}

function makeProps(overrides: Partial<BookListProps> = {}): BookListProps {
  return {
    books: [photoBook()],
    unidentified: [],
    overflowCount: 0,
    unidentifiedOverflowCount: 0,
    failedPhotoCount: 0,
    failedPhotoIndexes: [],
    photoCount: 1,
    ...overrides,
  };
}

describe("BookList — 목록", () => {
  it("확인된 책과 미확인 책을 같은 화면에 함께 그린다", () => {
    const { container } = render(
      <BookList {...makeProps({ unidentified: [makeUnidentified()] })} />,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("코스모스");
    expect(text).toContain("데미아 헤르만헤세");
    expect(container.querySelector("details")).toBeNull();
  });

  it("확인된 책이 여러 권이면 전부 그린다", () => {
    const { container } = render(
      <BookList
        {...makeProps({
          books: [photoBook(), photoBook({ isbn13: "9788937460777", title: "데미안" })],
        })}
      />,
    );

    expect(container.textContent).toContain("코스모스");
    expect(container.textContent).toContain("데미안");
  });
});

describe("BookList — 두 출처가 한 목록에 선다", () => {
  it("사진에서 온 책과 재검색으로 합류한 책을 한 섹션에 함께 그린다", () => {
    const { container, getAllByRole } = render(
      <BookList {...makeProps({ books: [photoBook(), resolvedBook()] })} />,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("코스모스");
    expect(text).toContain("데미안");

    // 목록이 갈라지면 사용자는 자기 책장을 두 개로 본다. 확인된 책 섹션은 하나다.
    const headings = getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    expect(headings).toEqual(["확인된 책 2권"]);
    expect(text).not.toContain("직접 확인한 책");
  });

  it("헤더의 권수는 두 출처의 합계다", () => {
    const { getByRole } = render(
      <BookList
        {...makeProps({
          books: [
            photoBook(),
            resolvedBook(),
            resolvedBook({ isbn13: "9791162540213", title: "싯다르타" }),
          ],
        })}
      />,
    );

    expect(getByRole("heading", { name: "확인된 책 3권" })).not.toBeNull();
  });

  it("재검색으로 합류한 책은 출처가 화면에 드러난다", () => {
    const { container, getByTestId } = render(
      <BookList {...makeProps({ books: [photoBook(), resolvedBook()] })} />,
    );

    const origin = getByTestId("resolved-origin");
    expect(origin.textContent).toBe("직접 확인");
    // 사용자가 직접 확인한 책은 문제가 아니다 — 주의를 요구하는 색을 쓰지 않는다.
    expect(origin.getAttribute("class")).toContain("text-subtle");
    expect(origin.getAttribute("class")).not.toContain("unverified");
    expect(origin.getAttribute("class")).not.toContain("error");

    // 사진에서 온 책에는 이 라벨이 붙지 않는다.
    expect(container.querySelectorAll("[data-testid='resolved-origin']").length).toBe(1);
  });

  it("재검색으로 합류한 책에도 알라딘 사실은 그대로 그린다", () => {
    const { container } = render(<BookList {...makeProps({ books: [resolvedBook()] })} />);

    const text = container.textContent ?? "";
    expect(text).toContain("데미안");
    expect(text).toContain("헤르만 헤세");
    expect(text).toContain("민음사");
    expect(text).toContain("240쪽");
    expect(text).toContain("독자 9.1");
  });

  it("[ADR-002] 재검색으로 합류한 책에 한줄평 자리를 지어내지 않는다", () => {
    const { container } = render(<BookList {...makeProps({ books: [resolvedBook()] })} />);

    // Claude 생성 텍스트 블록(왼쪽 보더 + 라벨)이 아예 없어야 한다.
    expect(container.textContent).not.toContain("AI 한줄평");
    expect(container.querySelector(".border-l-2")).toBeNull();
    expect(container.innerHTML).not.toContain("italic");
  });

  it("사진에서 온 책의 한줄평은 그대로 Claude 블록으로 나간다", () => {
    const { container } = render(<BookList {...makeProps({ books: [photoBook()] })} />);

    expect(container.textContent).toContain("AI 한줄평");
    expect(container.textContent).toContain("우주를 다루는데 문장이 다정하다");
  });

  it("확인된 책이 재검색분뿐이어도 빈 상태로 보내지 않는다", () => {
    const { container, queryByTestId } = render(
      <BookList {...makeProps({ books: [resolvedBook()] })} />,
    );

    expect(queryByTestId("empty-identified")).toBeNull();
    expect(container.textContent).toContain("확인된 책 1권");
  });
});

describe("BookList — 부분 실패 배너", () => {
  it("목록보다 앞에 렌더되고 분모를 함께 밝힌다", () => {
    const { container } = render(
      <BookList
        {...makeProps({ failedPhotoCount: 1, failedPhotoIndexes: [2], photoCount: 3 })}
      />,
    );

    const text = container.textContent ?? "";
    const banner = "사진 3장 중 1장은 읽지 못했어요";
    expect(text).toContain(banner);
    expect(text.indexOf(banner)).toBeLessThan(text.indexOf("코스모스"));
  });

  it("실패한 사진 인덱스를 콜백으로 넘긴다", () => {
    const onRetryPhoto = vi.fn();
    const { getByRole } = render(
      <BookList
        {...makeProps({
          failedPhotoCount: 2,
          failedPhotoIndexes: [1, 3],
          photoCount: 4,
          onRetryPhoto,
        })}
      />,
    );

    fireEvent.click(getByRole("button", { name: "이 사진만 다시 시도" }));

    expect(onRetryPhoto).toHaveBeenCalledWith([1, 3]);
  });

  it("실패한 사진이 없으면 배너를 그리지 않는다", () => {
    const { container } = render(<BookList {...makeProps()} />);

    expect(container.textContent).not.toContain("읽지 못했어요");
  });
});

describe("BookList — 안내 문구", () => {
  it("overflowCount > 0이면 50권 상한 안내가 나온다", () => {
    const { container } = render(<BookList {...makeProps({ overflowCount: 7 })} />);

    expect(container.textContent).toContain("50권까지만 보여드려요 (7권 더 있음)");
  });

  it("overflowCount가 0이면 안내를 그리지 않는다", () => {
    const { container } = render(<BookList {...makeProps()} />);

    expect(container.textContent).not.toContain("50권까지만");
  });

  it("확인 0건·미확인만이면 빈 상태 문구를 중앙 정렬로 그린다", () => {
    const { container, getByText } = render(
      <BookList {...makeProps({ books: [], unidentified: [makeUnidentified()] })} />,
    );

    expect(getByText("읽어낸 책을 알라딘에서 확인하지 못했어요")).not.toBeNull();

    const empty = container.querySelector("[data-testid='empty-identified']");
    expect(empty).not.toBeNull();
    expect(empty?.getAttribute("class")).toContain("text-center");
  });

  it("확인 0건이어도 미확인 목록은 그대로 보여준다", () => {
    const { container } = render(
      <BookList
        {...makeProps({
          books: [],
          unidentified: [makeUnidentified({ reason: "lookup_failed" })],
        })}
      />,
    );

    expect(container.textContent).toContain("데미아 헤르만헤세");
    expect(container.textContent).toContain("지금 확인할 수 없었어요");
  });

  it("확인된 책이 있으면 빈 상태 문구를 그리지 않는다", () => {
    const { container } = render(
      <BookList {...makeProps({ unidentified: [makeUnidentified()] })} />,
    );

    expect(container.textContent).not.toContain(
      "읽어낸 책을 알라딘에서 확인하지 못했어요",
    );
  });

  it("unidentifiedOverflowCount > 0이면 잘려나간 미확인을 말한다", () => {
    const { container } = render(
      <BookList
        {...makeProps({
          unidentified: [makeUnidentified()],
          unidentifiedOverflowCount: 4,
        })}
      />,
    );

    expect(container.textContent).toContain("못 읽어낸 책 4권은 목록에서 생략했어요");
  });
});

describe("BookList — 콜백 위임", () => {
  it("미확인 카드의 재검색 콜백을 그대로 전달한다", () => {
    const onResolve = vi.fn();
    const book = makeUnidentified({ reason: "no_match" });
    const { getByRole } = render(
      <BookList {...makeProps({ unidentified: [book], onResolve })} />,
    );

    fireEvent.click(getByRole("button", { name: "제목 고쳐 재검색" }));

    expect(onResolve).toHaveBeenCalledWith(book);
  });

  it("ambiguous 후보 선택 콜백을 그대로 전달한다", () => {
    const onSelectCandidate = vi.fn();
    const candidate = makeCandidate();
    const book = makeUnidentified({ reason: "ambiguous", candidates: [candidate] });
    const { getByRole } = render(
      <BookList {...makeProps({ unidentified: [book], onSelectCandidate })} />,
    );

    fireEvent.click(getByRole("button", { name: /데미안/ }));

    expect(onSelectCandidate).toHaveBeenCalledWith(book, candidate);
  });

  it("lookup_failed 재시도 콜백에 **그 책**을 넘긴다 — 사진 전체가 아니다", () => {
    const onRetryLookup = vi.fn();
    const book = makeUnidentified({ reason: "lookup_failed" });
    const { getByRole } = render(
      <BookList {...makeProps({ unidentified: [book], onRetryLookup })} />,
    );

    fireEvent.click(getByRole("button", { name: "다시 시도" }));

    expect(onRetryLookup).toHaveBeenCalledTimes(1);
    expect(onRetryLookup).toHaveBeenCalledWith(book);
  });

  it("lookup_failed가 여러 권이면 누른 책만 넘어간다", () => {
    const onRetryLookup = vi.fn();
    const first = makeUnidentified({ reason: "lookup_failed", rawText: "첫 번째 원문" });
    const second = makeUnidentified({ reason: "lookup_failed", rawText: "두 번째 원문" });
    const { getAllByRole } = render(
      <BookList {...makeProps({ unidentified: [first, second], onRetryLookup })} />,
    );

    fireEvent.click(getAllByRole("button", { name: "다시 시도" })[1]);

    expect(onRetryLookup).toHaveBeenCalledWith(second);
  });

  it("네트워크를 직접 부르지 않는다 (fetch 호출 0건)", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(
      <BookList
        {...makeProps({ unidentified: [makeUnidentified()], onResolve: () => {} })}
      />,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("BookList — AI 슬롭 안티패턴 회귀", () => {
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
    "hover:scale",
    "hover:-translate",
    "hover:translate",
    "transition",
  ];

  function renderAll() {
    return render(
      <BookList
        {...makeProps({
          books: [
            photoBook(),
            photoBook({
              isbn13: "9788937460770",
              pages: null,
              aladinRating: null,
              claudeNote: "",
            }),
            resolvedBook(),
            resolvedBook({ isbn13: "9791162540213", pages: null, aladinRating: null }),
          ],
          unidentified: [
            makeUnidentified({ reason: "unreadable" }),
            makeUnidentified({ reason: "no_match" }),
            makeUnidentified({ reason: "ambiguous", candidates: [makeCandidate()] }),
            makeUnidentified({ reason: "lookup_failed" }),
          ],
          overflowCount: 3,
          unidentifiedOverflowCount: 2,
          failedPhotoCount: 1,
          failedPhotoIndexes: [0],
          photoCount: 2,
          onResolve: () => {},
          onSelectCandidate: () => {},
          onRetryLookup: () => {},
          onRetryPhoto: () => {},
        })}
      />,
    );
  }

  it.each(FORBIDDEN)("렌더된 마크업에 %s가 없다", (token) => {
    const { container } = renderAll();

    expect(container.innerHTML).not.toContain(token);
  });

  it("색상은 globals.css 토큰 클래스로만 쓴다 (원시 hex 0건)", () => {
    const { container } = renderAll();

    const classAttributes = (container.innerHTML.match(/class="[^"]*"/g) ?? []).join(" ");
    expect(classAttributes).not.toContain("#");
  });

  it("장식 아이콘을 쓰지 않는다", () => {
    const { container } = renderAll();

    expect(container.querySelector("svg")).toBeNull();
  });
});
