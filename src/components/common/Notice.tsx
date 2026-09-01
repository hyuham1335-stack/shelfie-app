/**
 * 목록에 딸린 짧은 사실 안내 (UI_GUIDE "안내 문구").
 *
 * 에러가 아니므로 색을 쓰지 않는다 — "50권까지만 보여드려요"를 경고색으로 칠하면
 * 정상 동작을 문제처럼 읽게 만든다. 에러는 ErrorBanner의 일이다.
 */
import type { ReactNode } from "react";

export interface NoticeProps {
  children: ReactNode;
}

export function Notice({ children }: NoticeProps) {
  return <p className="text-xs text-subtle">{children}</p>;
}
