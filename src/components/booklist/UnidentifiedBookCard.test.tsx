/**
 * 미확인 책 카드 — 사유 4종이 서로 다른 문장·다른 행동으로 나오는지 고정한다.
 *
 * ADR-005 회귀 테스트가 여기 있다. 삭제하지 마라.
 * 알라딘이 멈춰서 못 찾은 책(`lookup_failed`)에 "절판일 수 있어요"라고 쓰는 것은
 * 시스템 문제를 데이터 문제로 설명하는 것이고, 없는 책을 지어내는 것과 같은 종류의 거짓말이다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { AladinCandidate, UnidentifiedBook } from "@/types/book";
import { UnidentifiedBookCard } from "./UnidentifiedBookCard";

afterEach(cleanup);

function makeBook(overrides: Partial<UnidentifiedBook> = {}): UnidentifiedBook {
  return {
    rawText: "데미아 헤르만헤세",
    reason: "unreadable",
    candidates: [],
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

describe("UnidentifiedBookCard — 사유 4종", () => {
  it("unreadable은 '책등 글자를 읽지 못했어요'를 쓴다", () => {
    const { container } = render(
      <UnidentifiedBookCard book={makeBook({ reason: "unreadable" })} />,
    );

    expect(container.textContent).toContain("못 읽음");
    expect(container.textContent).toContain("책등 글자를 읽지 못했어요");
  });

  it("no_match는 '알라딘에서 찾을 수 없는 책이에요 (원서·절판일 수 있어요)'를 쓴다", () => {
    const { container } = render(
      <UnidentifiedBookCard book={makeBook({ reason: "no_match" })} />,
    );

    expect(container.textContent).toContain("검색 결과 없음");
    expect(container.textContent).toContain(
      "알라딘에서 찾을 수 없는 책이에요 (원서·절판일 수 있어요)",
    );
  });

  it("ambiguous는 '비슷한 책이 여러 권이에요. 어느 쪽인가요?'를 쓴다", () => {
    const { container } = render(
      <UnidentifiedBookCard
        book={makeBook({ reason: "ambiguous", candidates: [makeCandidate()] })}
      />,
    );

    expect(container.textContent).toContain("후보 여럿");
    expect(container.textContent).toContain("비슷한 책이 여러 권이에요. 어느 쪽인가요?");
  });

  it("lookup_failed는 '지금 확인할 수 없었어요. 잠시 후 다시 시도해 주세요'를 쓴다", () => {
    const { container } = render(
      <UnidentifiedBookCard book={makeBook({ reason: "lookup_failed" })} />,
    );

    expect(container.textContent).toContain("확인 못 함");
    expect(container.textContent).toContain(
      "지금 확인할 수 없었어요. 잠시 후 다시 시도해 주세요",
    );
  });

  it("사유 4종의 설명 문장이 서로 전부 다르다", () => {
    const reasons = ["unreadable", "no_match", "ambiguous", "lookup_failed"] as const;

    const texts = reasons.map((reason) => {
      const { container } = render(<UnidentifiedBookCard book={makeBook({ reason })} />);
      const text = container.textContent ?? "";
      cleanup();
      return text;
    });

    expect(new Set(texts).size).toBe(4);
  });

  it("[ADR-005 회귀] lookup_failed 문구에 '절판'·'원서'·'찾을 수 없' 이 없다", () => {
    const { container } = render(
      <UnidentifiedBookCard book={makeBook({ reason: "lookup_failed" })} />,
    );

    const text = container.textContent ?? "";
    expect(text).not.toContain("절판");
    expect(text).not.toContain("원서");
    expect(text).not.toContain("찾을 수 없");
  });

  it("[ADR-005 회귀] lookup_failed 배지는 중립색이고 미확인 앰버가 아니다", () => {
    const { getByText } = render(
      <UnidentifiedBookCard book={makeBook({ reason: "lookup_failed" })} />,
    );

    const badge = getByText("확인 못 함").getAttribute("class") ?? "";
    expect(badge).toContain("text-subtle");
    expect(badge).not.toContain("text-unverified");
  });

  it("나머지 3종 배지는 미확인 앰버를 쓴다", () => {
    const cases = [
      ["unreadable", "못 읽음"],
      ["no_match", "검색 결과 없음"],
      ["ambiguous", "후보 여럿"],
    ] as const;

    for (const [reason, label] of cases) {
      const { getByText } = render(<UnidentifiedBookCard book={makeBook({ reason })} />);
      expect(getByText(label).getAttribute("class")).toContain("text-unverified");
      cleanup();
    }
  });
});

describe("UnidentifiedBookCard — 형태와 원문", () => {
  it("미확인 카드는 rounded-sm + 점선 테두리로 확인된 책과 형태가 다르다", () => {
    const { container } = render(<UnidentifiedBookCard book={makeBook()} />);

    const className = container.firstElementChild?.getAttribute("class") ?? "";
    expect(className).toContain("rounded-sm");
    expect(className).toContain("border-dashed");
    expect(className).toContain("bg-muted-surface");
    expect(className).not.toContain("rounded-md");
  });

  it("읽힌 원문을 font-mono로 그대로 노출한다", () => {
    const { getByText } = render(<UnidentifiedBookCard book={makeBook()} />);

    expect(getByText("데미아 헤르만헤세").getAttribute("class")).toContain("font-mono");
  });

  it("접거나 숨기지 않는다 (details·hidden 없음)", () => {
    const { container } = render(<UnidentifiedBookCard book={makeBook()} />);

    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("[hidden]")).toBeNull();
    expect(container.innerHTML).not.toContain("sr-only");
  });
});

describe("UnidentifiedBookCard — 행동", () => {
  it("unreadable은 제목 직접 입력 경로를 주고 콜백에 그 책을 넘긴다", () => {
    const onResolve = vi.fn();
    const book = makeBook({ reason: "unreadable" });
    const { getByRole } = render(
      <UnidentifiedBookCard book={book} onResolve={onResolve} />,
    );

    fireEvent.click(getByRole("button", { name: "제목 직접 입력" }));

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(book);
  });

  it("no_match는 제목 고쳐 재검색 경로를 준다", () => {
    const onResolve = vi.fn();
    const { getByRole } = render(
      <UnidentifiedBookCard book={makeBook({ reason: "no_match" })} onResolve={onResolve} />,
    );

    fireEvent.click(getByRole("button", { name: "제목 고쳐 재검색" }));

    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it("lookup_failed는 재시도 경로를 주고 재검색 버튼을 주지 않는다", () => {
    const onRetryLookup = vi.fn();
    const onResolve = vi.fn();
    const { getByRole, queryByRole } = render(
      <UnidentifiedBookCard
        book={makeBook({ reason: "lookup_failed" })}
        onResolve={onResolve}
        onRetryLookup={onRetryLookup}
      />,
    );

    fireEvent.click(getByRole("button", { name: "다시 시도" }));

    expect(onRetryLookup).toHaveBeenCalledTimes(1);
    expect(queryByRole("button", { name: "제목 고쳐 재검색" })).toBeNull();
  });

  it("ambiguous는 재검색이 아니라 후보 선택 UI를 준다", () => {
    const onSelectCandidate = vi.fn();
    const candidate = makeCandidate();
    const book = makeBook({ reason: "ambiguous", candidates: [candidate] });
    const { container, getByRole, queryByRole } = render(
      <UnidentifiedBookCard book={book} onSelectCandidate={onSelectCandidate} />,
    );

    expect(container.textContent).toContain("데미안");
    expect(container.textContent).toContain("헤르만 헤세");
    expect(queryByRole("button", { name: "제목 고쳐 재검색" })).toBeNull();

    fireEvent.click(getByRole("button", { name: /데미안/ }));

    expect(onSelectCandidate).toHaveBeenCalledTimes(1);
    expect(onSelectCandidate).toHaveBeenCalledWith(book, candidate);
  });

  it("ambiguous인데 후보가 비어 있으면 재검색 경로로 되돌린다", () => {
    const onResolve = vi.fn();
    const { getByRole } = render(
      <UnidentifiedBookCard
        book={makeBook({ reason: "ambiguous", candidates: [] })}
        onResolve={onResolve}
      />,
    );

    fireEvent.click(getByRole("button", { name: "제목 고쳐 재검색" }));

    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it("콜백을 넘기지 않으면 눌러도 달라지지 않는 버튼을 그리지 않는다", () => {
    const { queryAllByRole } = render(<UnidentifiedBookCard book={makeBook()} />);

    expect(queryAllByRole("button").length).toBe(0);
  });
});
