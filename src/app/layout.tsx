import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shelfie — 책장에서 오늘 읽을 책 고르기",
  description:
    "책장을 찍으면 책등에서 제목을 읽어내고, 지금 기분에 맞는 책을 골라줍니다.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body className="min-h-dvh bg-page text-ink antialiased">{children}</body>
    </html>
  );
}
