import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "惯性谱 MotionScore",
  description: "以手机动作书写声音与视觉的无线数字乐器",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
