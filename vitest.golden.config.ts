import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

/**
 * 골든 인식률 테스트 전용 설정 (TRD 8번 · ADR-010).
 *
 * `vitest.config.ts`와 분리한 이유가 셋이다.
 *
 * ① `npm test`는 `**\/*.golden.test.ts`를 exclude한다. 골든은 실제 API를
 *    호출하므로 CI에 들어가면 안 되고, 그렇다고 영원히 못 돌릴 수도 없다.
 *    이 파일이 "수동 실행"의 실체다.
 *
 * ② **junit 리포터를 쓰지 않는다.** 하네스 게이트가
 *    `reports/junit/vitest.xml`에서 테스트 수를 읽어 `tests_ran_floor`와
 *    비교하는데(harness/adapters/nextjs-ts.json), 골든이 그 파일을 덮으면
 *    1,000여 건짜리 하한이 사진 20장짜리 숫자와 대조된다. 게이트가 이유 없이
 *    무너지는 자리이고, 리포터 한 줄을 안 쓰는 것으로 끝난다.
 *
 * ③ `environment: "node"` — 골든에는 DOM이 없다. jsdom을 세우면 사진 20장에
 *    대해 아무도 쓰지 않는 환경 구축 비용만 든다.
 *
 * 타임아웃은 넉넉히 잡는다. 사진 1장이 추출 12s + 알라딘 대조까지 가고,
 * 20장이면 직렬로 몇 분이다 — 여기서는 시간 예산이 목적이 아니다.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.golden.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    // 실제 API를 부르므로 파일 간 병렬을 끈다. 알라딘 일일 한도(5,000회)와
    // Anthropic 레이트 리밋을 한 번에 밀어 넣지 않기 위해서다.
    fileParallelism: false,
  },
  css: {
    postcss: {},
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
