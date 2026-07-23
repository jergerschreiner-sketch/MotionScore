import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../app/globals.css";
import { MotionScoreApp } from "../app/motion-score-app";

const root = document.getElementById("root");

if (!root) {
  throw new Error("MotionScore root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <MotionScoreApp />
  </StrictMode>,
);
