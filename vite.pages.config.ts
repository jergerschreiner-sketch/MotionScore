import { copyFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const repositoryName = "MotionScore";
const outputDirectory = resolve(import.meta.dirname, "pages-dist");

function pagesRuntimeAssets(): Plugin {
  return {
    name: "motionscore-pages-runtime-assets",
    closeBundle() {
      mkdirSync(resolve(outputDirectory, "audio"), { recursive: true });
      mkdirSync(resolve(outputDirectory, "visual-reference"), {
        recursive: true,
      });
      cpSync(
        resolve(import.meta.dirname, "public/audio/inertia-glass"),
        resolve(outputDirectory, "audio/inertia-glass"),
        { recursive: true },
      );
      cpSync(
        resolve(import.meta.dirname, "public/audio/inertia-strings"),
        resolve(outputDirectory, "audio/inertia-strings"),
        { recursive: true },
      );
      mkdirSync(resolve(outputDirectory, "audio/kinetic-percussion"), {
        recursive: true,
      });
      copyFileSync(
        resolve(
          import.meta.dirname,
          "public/audio/kinetic-percussion/heavy-drum.wav",
        ),
        resolve(outputDirectory, "audio/kinetic-percussion/heavy-drum.wav"),
      );
      for (const file of [
        "impact-drum-warm-concept-v3.png",
        "inertia-glass-handpan-concept-v2-smoked.png",
        "inertia-pluck-warm-concept-v1.png",
      ]) {
        copyFileSync(
          resolve(import.meta.dirname, "public/visual-reference", file),
          resolve(outputDirectory, "visual-reference", file),
        );
      }
      copyFileSync(
        resolve(import.meta.dirname, "public/phone.html"),
        resolve(outputDirectory, "phone.html"),
      );
      copyFileSync(
        resolve(import.meta.dirname, "public/favicon.svg"),
        resolve(outputDirectory, "favicon.svg"),
      );
      copyFileSync(
        resolve(
          import.meta.dirname,
          "node_modules/peerjs/dist/peerjs.min.js",
        ),
        resolve(outputDirectory, "local-peerjs.js"),
      );
      writeFileSync(resolve(outputDirectory, ".nojekyll"), "");
    },
  };
}

export default defineConfig({
  root: resolve(import.meta.dirname, "github-pages"),
  base: `/${repositoryName}/`,
  publicDir: false,
  plugins: [react(), pagesRuntimeAssets()],
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
  },
});
