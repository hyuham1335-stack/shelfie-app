/**
 * 촬영·선택 진입점 (US-001, FR-001).
 *
 * 여기서 고정하는 것은 두 가지다.
 * ① `accept`는 `SUPPORTED_MIME_TYPES`에서 만든다 — 목록을 손으로 옮겨 적으면
 *    lib과 화면이 갈라지고, 갈라진 쪽은 언제나 화면이다.
 * ② 촬영 경로가 막혀도(카메라 권한 거부) 파일 선택 경로는 남는다 (PRD 5번 Edge Cases).
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SUPPORTED_MIME_TYPES } from "@/lib/image";
import { PhotoPicker } from "./PhotoPicker";

function 사진(name = "shelf.jpg"): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: "image/jpeg" });
}

/** jsdom의 `files`는 FileList만 받으므로 정의로 갈아끼운다 */
function 고르기(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
}

describe("PhotoPicker — 입력 계약 (FR-001)", () => {
  it("두 경로 모두 accept를 SUPPORTED_MIME_TYPES에서 만든다", () => {
    render(<PhotoPicker onSelect={() => {}} />);

    for (const label of ["책장 촬영", "사진 선택"]) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      expect(input.getAttribute("accept")).toBe(SUPPORTED_MIME_TYPES.join(","));
    }
  });

  it("accept에 HEIC가 들어가지 않는다 (PRD Q3에서 배제했다)", () => {
    render(<PhotoPicker onSelect={() => {}} />);

    expect(screen.getByLabelText("사진 선택").getAttribute("accept")).not.toContain("heic");
  });

  it("촬영 경로는 후면 카메라를 열고, 선택 경로는 여러 장을 받는다", () => {
    render(<PhotoPicker onSelect={() => {}} />);

    expect(screen.getByLabelText("책장 촬영")).toHaveAttribute("capture", "environment");
    const gallery = screen.getByLabelText("사진 선택") as HTMLInputElement;
    expect(gallery).not.toHaveAttribute("capture");
    expect(gallery.multiple).toBe(true);
  });

  it("촬영과 선택은 서로 다른 입력이라 한쪽이 막혀도 다른 쪽이 남는다", () => {
    render(<PhotoPicker onSelect={() => {}} />);

    expect(screen.getByLabelText("책장 촬영")).not.toBe(screen.getByLabelText("사진 선택"));
  });
});

describe("PhotoPicker — 선택 위임", () => {
  it("고른 파일을 배열로 그대로 넘긴다 (검증하지 않는다)", () => {
    const onSelect = vi.fn();
    render(<PhotoPicker onSelect={onSelect} />);

    const a = 사진("a.jpg");
    const b = 사진("b.jpg");
    고르기(screen.getByLabelText("사진 선택") as HTMLInputElement, [a, b]);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith([a, b]);
  });

  it("같은 파일을 두 번 고를 수 있도록 선택 후 input을 비운다", () => {
    const onSelect = vi.fn();
    render(<PhotoPicker onSelect={onSelect} />);

    const input = screen.getByLabelText("사진 선택") as HTMLInputElement;
    고르기(input, [사진()]);

    expect(input.value).toBe("");
  });

  it("아무것도 고르지 않고 창을 닫으면 콜백을 부르지 않는다", () => {
    const onSelect = vi.fn();
    render(<PhotoPicker onSelect={onSelect} />);

    고르기(screen.getByLabelText("사진 선택") as HTMLInputElement, []);

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("disabled면 두 입력이 모두 비활성이다", () => {
    render(<PhotoPicker onSelect={() => {}} disabled />);

    expect(screen.getByLabelText("책장 촬영")).toBeDisabled();
    expect(screen.getByLabelText("사진 선택")).toBeDisabled();
  });
});
