"use client";

/**
 * 에러 배너 (UI_GUIDE "에러 배너", API_SPEC 에러 응답 규약).
 *
 * 두 가지가 이 컴포넌트의 계약이다.
 * ① `requestId`가 **있으면** 반드시 화면에 노출한다. 서버 로그를 이 값으로 찾도록
 *    설계돼 있으므로(TRD 6.4 상관관계 ID), 화면에 없으면 규칙 자체가 무의미해진다.
 *    탭하면 복사된다.
 * ② 코드 → 정해진 문구 매핑만 쓴다. 모델이 생성한 문장이나 내부 에러 원문을 넣지 않는다
 *    (API_SPEC: 내부 정보 비노출).
 *
 * `requestId`가 `null`인 경우 — 네트워크가 끊겨 응답 본문 자체가 없었던 때 —
 * 에는 **ID 줄을 그리지 않는다.** 없는 ID를 "(없음)" 같은 문자열로 지어내면
 * 복사 버튼이 서버 로그에서 찾을 수 없는 값을 건네게 되고, 그것은 승격된 책에
 * `photoIndex`를 `0`으로 지어내지 않는 것과 같은 종류의 위조다.
 */
import { useState } from "react";
import type { ErrorCode } from "@/types/api";

/** 에러 코드별로 사용자 언어의 정해진 문구를 쓴다. 필드 경로·zod 원문은 노출하지 않는다 */
const MESSAGE: Record<ErrorCode, string> = {
  INVALID_REQUEST: "요청을 처리할 수 없어요. 입력을 확인하고 다시 시도해 주세요",
  TOO_MANY_PHOTOS: "사진은 최대 5장까지 올릴 수 있어요",
  UNSUPPORTED_IMAGE_TYPE: "JPG·PNG·WEBP 사진만 올릴 수 있어요",
  IMAGE_TOO_LARGE: "사진 한 장이 너무 커요. 다른 사진으로 시도해 주세요",
  PAYLOAD_TOO_LARGE: "사진 용량이 너무 커요. 장수를 줄여 주세요",
  EMPTY_SHELF: "책등이 보이도록 다시 찍어 주세요",
  NOT_FOUND_IN_ALADIN: "알라딘에서 찾을 수 없는 책이에요 (원서·절판일 수 있어요)",
  UNVERIFIED_BOOKS: "책 정보가 만료됐어요. 사진을 다시 분석해 주세요",
  IRRELEVANT_MOOD: "책 고르는 데 참고할 내용을 적어 주세요",
  RATE_LIMITED: "요청이 몰렸어요. 잠시 후 다시 시도해 주세요",
  UPSTREAM_UNAVAILABLE: "지금 책을 확인할 수 없어요. 잠시 후 다시 시도해 주세요",
  RECOMMENDATION_VALIDATION_FAILED:
    "추천을 만들지 못했어요. 잠시 후 다시 시도해 주세요",
  TIMEOUT: "시간이 오래 걸려 중단됐어요. 사진 장수를 줄여 다시 시도해 주세요",
  SERVICE_DISABLED: "지금은 점검 중이에요. 잠시 후 다시 찾아와 주세요",
  // 500. 502와 **같은 문구**를 쓴다 — 사용자가 할 수 있는 일이 재시도 하나로
  // 같기 때문이다. 우리 결함과 남의 장애를 구분하는 자리는 화면이 아니라
  // 로그다 (API_SPEC 에러 응답 규약, UI_GUIDE 안내 문구 표).
  INTERNAL_ERROR: "문제가 생겨 중단했어요. 잠시 후 다시 시도해 주세요",
};

/** 목록에 없는 코드(서버가 새 코드를 내보내거나 응답이 어긋난 경우)의 기본 문구 */
const FALLBACK_MESSAGE = "문제가 생겼어요. 잠시 후 다시 시도해 주세요";

export interface ErrorBannerProps {
  code: ErrorCode;
  /**
   * 에러 응답 본문의 `requestId`. 있으면 화면에서 지우지 않는다.
   * `null`은 "응답 본문이 없었다"는 사실이며(`lib/api-client`가 그렇게 준다),
   * 그 사실을 문자열로 덮지 않는다.
   */
  requestId: string | null;
  /** 재시도 경로가 있을 때만 넘긴다. SERVICE_DISABLED에서는 무시된다 */
  onRetry?: () => void;
  /**
   * 재시도 경로는 있으나 **지금은 누를 수 없는** 상태 (FR-010 재시도 간격).
   * 감추지 않고 비활성으로 남긴다 — 버튼이 사라지면 회복 경로가 없어진 것처럼
   * 읽히고, 대기 안내(남은 시간)가 무엇에 딸린 문장인지도 알 수 없어진다.
   */
  retryDisabled?: boolean;
  onReset?: () => void;
}

export function ErrorBanner({
  code,
  requestId,
  onRetry,
  retryDisabled = false,
  onReset,
}: ErrorBannerProps) {
  const [copied, setCopied] = useState(false);

  // 503은 눌러도 결과가 달라지지 않는다. 없느니만 못한 버튼은 그리지 않는다 (UI_GUIDE).
  const canRetry = onRetry !== undefined && code !== "SERVICE_DISABLED";

  function handleCopy() {
    // 클립보드는 권한·비보안 컨텍스트·구형 브라우저에서 없을 수 있다.
    // 복사가 안 되는 것보다 배너가 사라지는 것이 훨씬 나쁘다 — 실패는 조용히 삼킨다.
    try {
      if (requestId === null) return;
      const clipboard = navigator.clipboard as Clipboard | undefined;
      if (clipboard === undefined) return;
      void clipboard.writeText(requestId).then(
        () => setCopied(true),
        () => undefined,
      );
    } catch {
      // 무시
    }
  }

  return (
    <div
      role="alert"
      className="space-y-2 rounded-md border border-danger/30 bg-card p-4"
    >
      <p className="text-sm text-ink">{MESSAGE[code] ?? FALLBACK_MESSAGE}</p>

      {requestId !== null && (
        <button
          type="button"
          onClick={handleCopy}
          className="flex min-h-11 w-full items-center text-left font-mono text-[11px] text-disabled"
        >
          {copied ? "복사됨 — " : ""}오류 ID: {requestId}
        </button>
      )}

      {(canRetry || onReset !== undefined) && (
        <div className="flex items-center gap-3">
          {canRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={retryDisabled}
              className="min-h-11 rounded-md border border-line bg-card px-5 py-3 text-sm text-ink hover:bg-muted-surface disabled:text-disabled disabled:hover:bg-card"
            >
              다시 시도
            </button>
          )}
          {onReset !== undefined && (
            <button
              type="button"
              onClick={onReset}
              className="min-h-11 text-sm text-subtle underline underline-offset-2 hover:text-ink"
            >
              처음으로
            </button>
          )}
        </div>
      )}
    </div>
  );
}
