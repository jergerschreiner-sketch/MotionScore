# MotionScore UI / 视觉阶段交接

更新时间：2026-07-18

## 1. 新对话开始时必须先做

1. 完整读取 `PROJECT_BRIEF.md` 和本文件。
2. 查看当前代码、`git status --short`、`git diff --stat` 和最近 Git 提交。
3. 以当前工作区文件为准，不要回退或覆盖未提交修改。
4. 先打开并检查电脑舞台端与手机控制端的实际页面，再提出视觉改造方案。

重要：当前 `HEAD` 是 `578883c Add Inertia Strings performance mode`，明显早于现有产品状态。当前工作区中的 Inertia Pluck、沙锤移除、独立 MIDI 控制器、重鼓阈值等修改尚未全部进入 Git 提交。禁止使用 `git reset --hard`、`git checkout --` 或其他方式恢复旧版本。

## 2. 当前产品状态

核心功能已经满足，正式进入功能冻结后的 UI、视觉效果和演示打磨阶段。除非用户明确要求，不再主动增加新乐器、新手势或 Cubase 功能。

当前保留四个模式：

- `Inertia Glass`：C4—C5 八音、三力度层的旋律采样乐器。
- `Inertia Pluck`：由旧 Inertia Strings 原位替换而来；四个音区、点击锁定最近半音、12px 死区、按住横向连续滑音、松手自然延音。
- `Impact Drum`：高强度冲击触发，当前阈值为 `9.2`，冷却时间 280ms。
- `Motion MIDI Controller`：独立外部音源控制器，半音阶键盘、八度切换、可选 CC 映射。

已经移除：

- `Kinetic Shaker` 已从电脑音色库、手机模式、动作识别和默认音色加载中移除。
- 用户原始 `shaker.mp3` 仅作为本地素材保留，不再由产品加载。

已经验证：

- iPhone 与 Mac 配对、传感器传输。
- Web Audio 内置音色。
- Web MIDI → IAC → Cubase / Kontakt 基础链路。
- 演奏录制、回放、音频和带声音的视频导出。
- `pnpm run build` 通过。
- `pnpm run lint` 为 0 errors；仍有一个已有的 `replayTimersRef.current` React cleanup warning。

## 3. 本阶段边界

本阶段只做：

- 视觉风格统一。
- 信息层级、布局、间距、字号和交互状态优化。
- 动作视觉乐谱的表现力升级。
- Mac 舞台端与 iPhone 控制端的响应式细节。
- 演示、录屏和参赛展示需要的视觉完成度。
- 不改变现有演奏映射前提下的轻量手感修复。

本阶段暂不做：

- 新增乐器或重新引入沙锤。
- 新增动作映射。
- 扩展 Cubase/Kontakt 接入。
- AI 音乐生成。
- 未经确认的大规模功能重构。

## 4. 建议视觉方向

关键词：`精密`、`惯性`、`发光痕迹`、`数字乐器`、`表演舞台`。

建议保持当前深色基底，但提升一致性：

- 主背景：近黑、暖黑，避免普通纯黑网页感。
- 内置乐器：酸性黄绿作为动作能量和激活色。
- MIDI 控制器：保留冷蓝色区分外部控制模式。
- 文字：暖白与分级灰，减少所有元素同时发亮。
- 视觉笔触：具有速度、力度、方向、音高颜色和衰减层级；避免普通粒子烟花。
- UI 气质：像精密仪器与现场乐器，不像管理后台或通用 SaaS Dashboard。
- 玻璃效果只用于层级分离，避免每个面板都使用相同玻璃卡片。

## 5. UI 优化优先级

### 第一阶段：视觉系统

- 统一颜色变量、字体层级、圆角、边框、阴影和动效时间。
- 明确首页、舞台、音色库、录制工具、MIDI 面板之间的视觉主次。
- 为等待、连接、启用、演奏、录制、回放、错误建立一致的状态语言。

### 第二阶段：电脑舞台端

- 让动作视觉画布成为第一视觉中心，控制面板退居辅助层。
- 优化配对码、连接状态、当前音高/手势、音色状态的信息层级。
- 精简音色库卡片并强化四个模式之间的视觉识别。
- 重新整理录制与导出工具，避免与演奏状态争夺注意力。

### 第三阶段：手机控制端

- 保证单手操作和安全区适配。
- 保留 Inertia Pluck 的 32 个半音参考点，但控制文字密度。
- 触摸反馈必须明确区分“准确起音”“死区锁定”“进入滑音”。
- MIDI 键盘、旋律键盘、弹拨界面、重鼓界面应共享品牌语言，同时保持不同演奏逻辑。

### 第四阶段：动作视觉乐谱

- 视觉轨迹应根据速度、力度、方向、当前音高和乐器模式变化。
- Inertia Glass：清晰、晶体感、短暂折射。
- Inertia Pluck：触发时出现明确节点，滑音形成有张力的弧线，尾音逐渐衰减。
- Impact Drum：强冲击产生低频扩张与结构化波纹，不使用廉价爆炸粒子。
- MIDI Controller：冷蓝、克制，强调控制数据与外部连接。
- 录制视频时的画面应在无 UI 或低 UI 状态下仍然成立。

## 6. 关键文件

- `PROJECT_BRIEF.md`：项目总览和功能边界。
- `app/motion-score-app.tsx`：主应用、电脑舞台、动作画布、音色库、录制导出。
- `app/globals.css`：整体视觉样式和响应式布局。
- `app/motion-audio.ts`：Web Audio、Inertia Glass、Inertia Pluck、Impact Drum。
- `app/midi-output.ts`：独立 MIDI 控制器。
- `public/phone.html`：iPhone 控制端的完整 HTML/CSS/JS。
- `scripts/generate-string-bank.py`：Inertia Pluck 四个物理建模拨弦采样生成器。
- `MIDI_TEST.md`：MIDI/Cubase 测试说明；本阶段只保持兼容，不扩展。
- `scripts/local-secure.mjs`：iPhone HTTPS 局域网测试服务。

## 7. 本地运行与验证

全局 `npm` 可能不可用，优先使用工作区可用的 `pnpm`。

```bash
pnpm run dev
pnpm run dev:secure
pnpm run build
pnpm run lint
```

- 电脑页面：`http://localhost:3000/`
- iPhone 地址不要写死；运行 `pnpm run dev:secure` 后使用终端输出的 `https://<当前局域网IP>:3443/phone.html`。
- 手机和电脑需要在同一 Wi-Fi。
- 局域网 IP 改变时，`local-secure.mjs` 会更新本地服务器证书；MotionScore CA 已信任时通常无需重复安装。

每次较大视觉修改后至少验证：

1. 首页能进入电脑舞台和手机页面。
2. 四种模式都能选择，且不存在 Kinetic Shaker 卡片。
3. 声音能启用，Inertia Pluck 电脑试听显示准确 F4。
4. 手机页面脚本语法正常，四个模式同步正常。
5. 录制、回放和导出按钮的启用/禁用状态没有被视觉改造破坏。
6. `pnpm run build` 通过，`pnpm run lint` 无新增错误。

## 8. 已知问题与注意事项

- `tests/rendered-html.test.mjs` 可能仍包含旧 starter skeleton 断言；不要把它的失败误判为现有产品功能回归。进入视觉阶段时应更新为当前 MotionScore 页面契约。
- 当前有一个既存 React lint warning：effect cleanup 直接读取 `replayTimersRef.current`。
- 当前工作树包含用户和前序开发的未提交修改；只修改本任务相关文件，保留所有既有工作。
- 不要删除用户根目录下的 `shaker.mp3`，它是原始素材。
- 不要因为视觉重构改变传感器阈值、MIDI CC、配对通信或音频映射。

## 9. 新对话的第一项产出

先完成一次 UI/视觉审计，不立即大改：

1. 截图或检查首页、电脑舞台、音色库、Inertia Pluck、Impact Drum、MIDI Controller 和手机页面。
2. 列出 5—8 个最影响完成度的问题，按优先级排序。
3. 给出一个统一视觉系统和第一阶段改造范围。
4. 先向用户确认整体方向，再分阶段实施；每阶段保持可运行并完成构建验证。
