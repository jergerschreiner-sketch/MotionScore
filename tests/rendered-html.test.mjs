import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the MotionScore role selector", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>惯性谱 MotionScore<\/title>/i);
  assert.match(html, /class="home-shell"/);
  assert.match(html, /电脑舞台端/);
  assert.match(html, /首页扫码配对/);
  assert.match(html, /连接后自动进入舞台/);
  assert.match(html, /手机控制端/);
  assert.match(html, /href="(?:\.\/|\/)phone\.html"/);
  assert.match(html, /无线数字乐器与动作视觉乐谱系统/);
  assert.doesNotMatch(html, /截止日期|2026\.08\.10/);
});

test("keeps the frozen instrument and performance-mode contract", async () => {
  const [app, css, layout] = await Promise.all([
    readFile(new URL("../app/motion-score-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    access(new URL("../public/visual-reference/inertia-glass-handpan-concept-v2-smoked.png", import.meta.url)),
    access(new URL("../public/visual-reference/inertia-pluck-warm-concept-v1.png", import.meta.url)),
    access(new URL("../public/visual-reference/impact-drum-warm-concept-v3.png", import.meta.url)),
  ]);

  assert.match(layout, /title:\s*"惯性谱 MotionScore"/);
  assert.match(app, /className="performance-mode-button"/);
  assert.match(app, /setPerformanceMode\(true\)/);
  assert.match(app, /performance-only/);
  assert.match(app, /EXIT \/ ESC/);
  assert.match(app, /inertia-glass-handpan-concept-v2-smoked\.png/);
  assert.match(app, /inertia-pluck-warm-concept-v1\.png/);
  assert.match(app, /impact-drum-warm-concept-v3\.png/);
  assert.match(app, /<b>Inertia Glass<\/b><small>/);
  assert.match(app, /<b>Inertia Pluck<\/b><small>/);
  assert.match(app, /<b>Impact Drum<\/b><small>/);
  assert.doesNotMatch(app, /<span>采样音色<\/span>|<span>弹拨滑音<\/span>|<span>冲量重鼓<\/span>/);
  assert.match(css, /\.stage-shell\.performance-only > :not\(\.motion-canvas\):not\(\.performance-exit\)/);
  assert.match(css, /\.stage-shell\.performance-only \.performance-exit/);
});
