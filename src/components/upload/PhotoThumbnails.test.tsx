/**
 * 선택된 사진 썸네일과 개별 제거 (US-001 화면 인벤토리).
 *
 * 미리보기 URL은 화면이 만들 수도, 못 만들 수도 있다(`URL.createObjectURL`이 없는
 * 환경). 못 만들었을 때 깨진 이미지를 노출하지 않고 폴백으로 흡수하는 것은 표지
 * 폴백(UI_GUIDE 레이아웃)과 같은 규칙이다.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MAX_PHOTOS } from "@/lib/env";
import { PhotoThumbnails } from "./PhotoThumbnails";
import type { UploadPhoto } from "./PhotoThumbnails";

function 사진(overrides: Partial<UploadPhoto> = {}): UploadPhoto {
  return {
    id: "hash-1",
    name: "shelf.jpg",
    previewUrl: "blob:preview-1",
    tooSmall: false,
    ...overrides,
  };
}

describe("PhotoThumbnails — 목록", () => {
  it("선택이 없으면 아무것도 그리지 않는다", () => {
    const { container } = render(<PhotoThumbnails photos={[]} onRemove={() => {}} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("고른 장수와 상한을 함께 보여 준다", () => {
    render(
      <PhotoThumbnails
        photos={[사진(), 사진({ id: "hash-2" })]}
        onRemove={() => {}}
      />,
    );

    expect(screen.getByText(`2 / ${MAX_PHOTOS}장`)).toBeInTheDocument();
  });

  it("미리보기 URL이 있으면 이미지로, 없으면 폴백으로 그린다", () => {
    render(
      <PhotoThumbnails
        photos={[사진(), 사진({ id: "hash-2", name: "책장.png", previewUrl: null })]}
        onRemove={() => {}}
      />,
    );

    expect(screen.getByAltText("shelf.jpg 미리보기")).toHaveAttribute("src", "blob:preview-1");
    // 폴백은 깨진 이미지 대신 첫 글자를 보여 준다 (UI_GUIDE 레이아웃).
    expect(screen.getByLabelText("책장.png 미리보기")).toHaveTextContent("책");
  });
});

describe("PhotoThumbnails — 개별 제거", () => {
  it("제거 버튼은 어떤 사진인지 이름으로 구분된다", () => {
    const onRemove = vi.fn();
    render(
      <PhotoThumbnails
        photos={[사진(), 사진({ id: "hash-2", name: "b.jpg" })]}
        onRemove={onRemove}
      />,
    );

    fireEvent.click(screen.getByLabelText("b.jpg 제거"));

    expect(onRemove).toHaveBeenCalledWith("hash-2");
  });

  it("분석 중에는 제거 버튼이 비활성이다", () => {
    render(<PhotoThumbnails photos={[사진()]} onRemove={() => {}} disabled />);

    expect(screen.getByLabelText("shelf.jpg 제거")).toBeDisabled();
  });
});

describe("PhotoThumbnails — 판독 하한 경고 (TR-001)", () => {
  it("리사이즈 후 짧은 변이 하한을 밑도는 사진만 표시가 붙는다", () => {
    render(
      <PhotoThumbnails
        photos={[사진({ tooSmall: true }), 사진({ id: "hash-2", name: "b.jpg" })]}
        onRemove={() => {}}
      />,
    );

    // 경고는 차단이 아니다 — 표시만 붙고 사진은 목록에 남는다.
    expect(screen.getAllByText("너무 길어요")).toHaveLength(1);
    expect(screen.getByLabelText("shelf.jpg 제거")).toBeInTheDocument();
  });
});
