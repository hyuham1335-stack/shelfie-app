/**
 * Claude가 생성한 해석을 렌더하는 유일한 형태 (UI_GUIDE "Claude 생성 텍스트 블록").
 *
 * 알라딘에서 온 사실(제목·저자·출판사·쪽수·평점)과 Claude가 쓴 해석(한줄평·추천 이유)은
 * 절대 같은 시각 층위로 렌더하지 않는다 (ADR-002, CLAUDE.md CRITICAL).
 * 사용자가 라벨을 읽지 않고도 구분할 수 있어야 하므로, 형태(왼쪽 보더 + italic + 낮은 대비)로 가른다.
 *
 * 한줄평·추천 이유를 이 컴포넌트를 거치지 않고 렌더하는 코드가 생기면 그 전제가 깨진다.
 */

/** 이 블록이 붙을 수 있는 자리는 두 곳뿐이다 — 한줄평(TR-007)과 추천 이유(TR-010) */
export type ClaudeTextLabel = "AI 한줄평" | "추천 이유";

export interface ClaudeTextProps {
  label: ClaudeTextLabel;
  /** Claude 생성 문자열. 생성 실패 시 빈 문자열로 온다 (API_SPEC `claudeNote`) */
  text: string;
}

export function ClaudeText({ label, text }: ClaudeTextProps) {
  // 한줄평 생성 실패는 빈 문자열로 온다(TR-007). 빈 인용 블록을 그리면
  // 화면에 "AI가 뭔가 말했는데 안 보인다"는 인상만 남는다 — 아예 그리지 않는다.
  if (text.trim() === "") return null;

  return (
    <div className="border-l-2 border-accent/40 pl-3 text-sm italic leading-relaxed text-subtle">
      <p className="text-[11px] uppercase tracking-wide text-disabled not-italic">
        {label}
      </p>
      <p>{text}</p>
    </div>
  );
}
