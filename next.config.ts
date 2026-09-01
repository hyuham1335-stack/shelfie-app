import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // TRD 6.5 — 알라딘 표지 도메인만 허용해 SSRF 표면을 좁힌다.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "image.aladin.co.kr",
      },
    ],
  },
};

export default nextConfig;
