import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

export default defineConfig({
  test: {
    environment: "jsdom",
    // jest-dom 매처 등록 + RTL 자동 cleanup. 없으면 테스트 파일마다
    // afterEach(cleanup) 을 손으로 부르게 된다 (런 #3·#4가 보고했다).
    setupFiles: ["./vitest.setup.ts"],
    // junit 리포터 — 하네스 게이트가 "테스트가 몇 개 돌았는가"를 기계로 읽는다 (harness/adapters/nextjs-ts.json).
    reporters: ["default", ["junit", { outputFile: "reports/junit/vitest.xml" }]],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // 골든 인식률 테스트는 실제 API를 호출하므로 CI에서 제외한다 (TRD 8번).
    exclude: ["**/node_modules/**", "**/*.golden.test.ts"],
  },
  // postcss.config.mjs는 Next 전용 형식(문자열 플러그인)이라 Vite가 읽지 못한다.
  // 테스트는 CSS를 처리할 필요가 없으므로 빈 설정으로 덮어 파일 탐색을 막는다.
  css: {
    postcss: {},
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
