"use client";

/**
 * 기분 입력 화면 (US-003·US-004, FR-007).
 *
 * ## 비워 두는 것은 실패가 아니다
 * 빈 입력창 앞에서 막히는 것이 이 단계의 이탈 사유다(PRD 7번 4단계). 그래서 비운 채
 * 진행하는 것은 막아야 할 오류가 아니라 **문답으로 가는 설계된 분기**다(FR-007).
 * 여기에 경고색과 "필수 입력입니다"를 붙이면 우리가 열어 둔 길을 우리가 막는 셈이 된다.
 *
 * ## 무관 판정 연속 횟수를 화면이 센다
 * API_SPEC은 "같은 세션에서 `relevant: false`가 2회 연속이면 판정을 무시한다"고 정했지만,
 * 서버는 무상태라 그 횟수를 셀 수 없다(ADR-003). 세는 자리는 화면이고, 이 파일은 그
 * 규칙(`nextIrrelevantCount`)과 표현을 함께 갖는다. **저장소에 남기지 않는다** —
 * 새로고침하면 카운터가 사라지지만, 이 상한은 남용 방어가 아니라 오탐으로 사용자를
 * 입력 화면에 가두지 않기 위한 장치라 그 정도면 충분하다.
 *
 * ## 네트워크가 없다
 * `fetch`도 `lib/api-client.ts`도 부르지 않는다. 기분 텍스트를 콜백으로 넘기고 끝낸다.
 */
import { useState } from "react";
import { Notice } from "@/components/common/Notice";
import type { ErrorCode } from "@/types/api";

/** `recommendRequestSchema.mood`의 제약을 화면에서도 그대로 쓴다 */
export const MOOD_MIN_LENGTH = 2;
export const MOOD_MAX_LENGTH = 500;

/** 이 횟수부터는 같은 요구를 반복하지 않고 예시를 강조한다 (API_SPEC /api/recommend) */
export const IRRELEVANT_EMPHASIS_THRESHOLD = 2;

/** 예시 문장 3개 (PRD 화면 인벤토리 "기분 입력") */
export const MOOD_EXAMPLES = [
  "요즘 번아웃이라 가볍게 읽을 것",
  "출퇴근길에 짧게 끊어 읽고 싶어요",
  "머리가 복잡한데 푹 빠질 만한 이야기",
] as const;

/**
 * 무관 판정의 **연속** 횟수를 갱신한다.
 *
 * 연속이 아니면 의미가 없다 — 세션 초반에 한 번 오탐이 났다고 그 뒤의 정상 입력까지
 * 누적해 세면, 판정을 무시하는 시점이 앞당겨져 억지 추천이 늘어난다.
 */
export function nextIrrelevantCount(current: number, code: ErrorCode | null): number {
  return code === "IRRELEVANT_MOOD" ? current + 1 : 0;
}

export interface MoodInputProps {
  /** 공백을 다듬은 2자 이상의 기분 텍스트만 올라온다 */
  onSubmit: (mood: string) => void;
  /** 비운 채 진행하는 경로 (FR-007). 문답 생성은 페이지가 요청한다 */
  onGuidedStart: () => void;
  /** 직전 추천이 무관 판정(422)을 받은 연속 횟수. 세는 것은 페이지의 몫이다 */
  irrelevantCount?: number;
  /** 추천 요청 중. 같은 기분을 두 번 보내면 비용만 두 배가 된다 */
  isSubmitting?: boolean;
  /** "다시 추천받기"로 돌아왔을 때 직전 입력을 이어서 고치게 한다 */
  defaultMood?: string;
}

export function MoodInput({
  onSubmit,
  onGuidedStart,
  irrelevantCount = 0,
  isSubmitting = false,
  defaultMood = "",
}: MoodInputProps) {
  const [mood, setMood] = useState(defaultMood);
  const [tooShort, setTooShort] = useState(false);

  const trimmed = mood.trim();
  const emphasizeExamples = irrelevantCount >= IRRELEVANT_EMPHASIS_THRESHOLD;

  function handleSubmit() {
    if (isSubmitting) return;

    // 비운 채 진행 = 문답. 막는 것이 아니라 다른 길로 보내는 것이다 (FR-007).
    if (trimmed === "") {
      setTooShort(false);
      onGuidedStart();
      return;
    }

    // 한 글자로는 추천 근거가 되지 않고 서버 스키마(min 2)도 통과하지 못한다.
    if (trimmed.length < MOOD_MIN_LENGTH) {
      setTooShort(true);
      return;
    }

    setTooShort(false);
    onSubmit(trimmed);
  }

  return (
    <div className="mx-auto w-full max-w-md space-y-6 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-ink">지금 어떤 기분이세요?</h1>
        <p className="text-sm text-body">책장에 있는 책 중에서 골라 드려요</p>
      </header>

      <div className="space-y-2">
        <label htmlFor="mood-input" className="block text-sm text-body">
          지금 기분이나 상황
        </label>
        <textarea
          id="mood-input"
          value={mood}
          maxLength={MOOD_MAX_LENGTH}
          rows={3}
          onChange={(event) => {
            setMood(event.target.value);
            setTooShort(false);
          }}
          placeholder="한 줄이면 충분해요"
          className="w-full rounded-md border border-line bg-card px-4 py-3 text-ink placeholder:text-disabled focus:border-accent focus:outline-none"
        />
        <p className="text-right text-xs text-subtle">
          {mood.length}/{MOOD_MAX_LENGTH}
        </p>
      </div>

      {tooShort && <Notice>조금만 더 적어 주세요. 한 글자로는 고르기 어려워요</Notice>}

      {/* 1회째는 PRD 문구로 다시 받고, 2회 연속부터는 같은 요구를 반복하지 않는다 */}
      {irrelevantCount === 1 && <Notice>책 고르는 데 참고할 내용을 적어 주세요</Notice>}

      <div
        className={
          emphasizeExamples ? "space-y-2 rounded-md bg-muted-surface p-3" : "space-y-2"
        }
      >
        <p className="text-xs text-subtle">
          {emphasizeExamples ? "이렇게 적으면 잘 골라져요" : "이런 식으로 적어도 돼요"}
        </p>
        <ul className="space-y-2">
          {MOOD_EXAMPLES.map((example) => (
            <li key={example}>
              <button
                type="button"
                onClick={() => {
                  setMood(example);
                  setTooShort(false);
                }}
                className="min-h-11 w-full rounded-md border border-line bg-card px-4 py-2 text-left text-sm text-body hover:bg-muted-surface"
              >
                {example}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <button
        type="button"
        onClick={onGuidedStart}
        className="min-h-11 text-sm text-subtle underline underline-offset-2 hover:text-ink"
      >
        뭘 읽고 싶은지 모르겠어요
      </button>

      <div className="sticky bottom-0 space-y-2 border-t border-line bg-page pt-3 pb-4">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting}
          className="min-h-11 w-full rounded-md bg-accent px-5 py-3 text-white hover:bg-accent-strong disabled:bg-muted-surface disabled:text-disabled"
        >
          추천받기
        </button>
        {/* 비워 두면 어디로 가는지 미리 말해 둔다 — 눌러 보고 알게 하지 않는다 */}
        <Notice>비워 두고 누르면 짧은 질문으로 좁혀 드려요</Notice>
      </div>
    </div>
  );
}
