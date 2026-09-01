"use client";

/**
 * 문답 화면 (US-004, TR-009).
 *
 * ## 생성 실패를 에러로 말하지 않는다
 * 질문 생성 실패도 모델 장애도 서버는 200 + 빈 배열로 돌려준다
 * (API_SPEC /api/mood/questions). 클라이언트가 할 일이 어느 쪽이든 같기 때문이다 —
 * 자유 입력으로 돌아가는 것. 그래서 이 화면은 빈 배열을 받으면 **아무것도 그리지 않고**,
 * 되돌리는 전이는 리듀서(`QUESTIONS_RECEIVED` → `moodInput`)가 맡는다.
 * "질문을 만들지 못했어요" 배너는 사용자가 할 수 있는 일이 없는 실패를 알리는 소음이다.
 *
 * ## 답변은 질문과 함께 합성한다
 * 선택지 문자열만 보내면("가벼운 쪽") 무엇에 대한 답인지 모델이 알 수 없다.
 * 합성 결과는 `mood`로 나가며, 서버 프롬프트에서는 데이터 블록으로만 다뤄진다
 * (TRD 6.5 프롬프트 인젝션).
 */
import { useState } from "react";
import { Skeleton } from "@/components/common/Skeleton";
import type { MoodQuestion } from "@/types/api";
import { MOOD_MAX_LENGTH } from "./MoodInput";

/** 질문 id → 고른 선택지 */
export type MoodAnswers = Record<string, string>;

/**
 * 답변을 기분 텍스트로 합성한다. 답하지 않은 질문은 빼고, `recommendRequestSchema`의
 * 상한(500자)에서 자른다 — 넘겨 보내면 400으로 돌아올 뿐이다.
 */
export function composeMood(
  questions: readonly MoodQuestion[],
  answers: MoodAnswers,
): string {
  return questions
    .filter((question) => answers[question.id] !== undefined)
    .map((question) => `${question.question} ${answers[question.id]}`)
    .join("\n")
    .slice(0, MOOD_MAX_LENGTH);
}

export interface GuidedQuestionsProps {
  /** 2~3개. 빈 배열은 생성 실패를 흡수한 값이며 화면을 그리지 않는다 */
  questions: readonly MoodQuestion[];
  /** 합성된 기분 텍스트. `inputMode`는 `guided`로 나간다 */
  onSubmit: (mood: string) => void;
  /** 건너뛰고 자유 입력으로 (US-004 AC) */
  onSkip: () => void;
  /** 질문 생성 요청 중 */
  isLoading?: boolean;
  /** 추천 요청 중 */
  isSubmitting?: boolean;
}

export function GuidedQuestions({
  questions,
  onSubmit,
  onSkip,
  isLoading = false,
  isSubmitting = false,
}: GuidedQuestionsProps) {
  const [answers, setAnswers] = useState<MoodAnswers>({});

  if (isLoading) {
    return (
      // 진행 상태는 눈으로만 알리지 않는다 (TRD 6.6 접근성).
      <div
        role="status"
        aria-live="polite"
        className="mx-auto w-full max-w-md space-y-2 px-4 py-6"
      >
        <p className="text-sm text-body">질문을 만들고 있어요</p>
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-32" />
      </div>
    );
  }

  // 빈 배열에서 화면을 만들지 않는다. 폴백 전이는 리듀서의 일이다.
  if (questions.length === 0) return null;

  const allAnswered = questions.every((question) => answers[question.id] !== undefined);

  return (
    <div className="mx-auto w-full max-w-md space-y-6 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-ink">몇 가지만 여쭤볼게요</h1>
        <p className="text-sm text-body">책장에 있는 책을 보고 만든 질문이에요</p>
      </header>

      <div className="space-y-6">
        {questions.map((question) => (
          <fieldset key={question.id} className="space-y-2">
            <legend className="text-base font-medium leading-snug text-ink">
              {question.question}
            </legend>
            <div className="space-y-2">
              {question.options.map((option, index) => {
                const id = `${question.id}-${index}`;
                return (
                  <label
                    key={id}
                    htmlFor={id}
                    className="flex min-h-11 items-center gap-3 rounded-md border border-line bg-card px-4 py-2 text-sm text-body hover:bg-muted-surface"
                  >
                    <input
                      type="radio"
                      id={id}
                      name={question.id}
                      value={option}
                      checked={answers[question.id] === option}
                      onChange={() =>
                        setAnswers((prev) => ({ ...prev, [question.id]: option }))
                      }
                      className="accent-accent"
                    />
                    {option}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      <button
        type="button"
        onClick={onSkip}
        className="min-h-11 text-sm text-subtle underline underline-offset-2 hover:text-ink"
      >
        건너뛰고 직접 적기
      </button>

      <div className="sticky bottom-0 border-t border-line bg-page pt-3 pb-4">
        <button
          type="button"
          onClick={() => {
            if (isSubmitting || !allAnswered) return;
            onSubmit(composeMood(questions, answers));
          }}
          disabled={isSubmitting || !allAnswered}
          className="min-h-11 w-full rounded-md bg-accent px-5 py-3 text-white hover:bg-accent-strong disabled:bg-muted-surface disabled:text-disabled"
        >
          추천받기
        </button>
      </div>
    </div>
  );
}
