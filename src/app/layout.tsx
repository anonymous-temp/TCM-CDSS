import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "中医CDSS",
  description: "面向中医门诊场景的一诉五史、四诊合参、辨病辨证、候选方药与风险随访支持系统",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
