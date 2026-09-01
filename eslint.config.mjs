import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

// eslint-config-next 16은 flat config 배열을 직접 내보낸다.
// next, next/typescript, next/core-web-vitals가 모두 포함되어 있어 FlatCompat이 필요 없다.
const eslintConfig = [
  ...nextCoreWebVitals,
  {
    // next-env.d.ts는 Next가 생성하는 파일이라 규칙 적용 대상이 아니다.
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "phases/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
