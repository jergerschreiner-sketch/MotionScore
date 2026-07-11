import type { Metadata } from "next";
import { MotionScoreApp } from "./motion-score-app";

export const metadata: Metadata = {
  title: "惯性谱 MotionScore",
  description: "以手机动作书写声音与视觉的无线数字乐器",
};

export default function Home() {
  return <MotionScoreApp />;
}
