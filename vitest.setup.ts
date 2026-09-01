/**
 * 테스트 전역 설정.
 *
 * 이것이 없어 컴포넌트 테스트 9개 파일이 각자 `afterEach(cleanup)`을 불렀고
 * (파일럿 런 #3·#4가 세 번 보고했다), jest-dom 매처는 의존성에 있으면서도
 * 등록되지 않아 아무도 쓰지 못했다. 설정 파일은 `main_owned_paths`라 step
 * 세션이 고칠 수 없다 — 워커가 보고할 수는 있어도 해결할 수는 없는 자리다.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// RTL 은 자동 cleanup 을 globals 환경에서만 건다. 이 리포는 globals 를 켜지
// 않았으므로 여기서 명시적으로 건다. 빠지면 이전 테스트의 DOM 이 남아
// `getByText` 가 중복 매치로 죽는다.
afterEach(cleanup);
