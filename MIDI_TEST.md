# MotionScore — Motion MIDI Controller

这是独立于内置音色的外部控制器模式。选中 `Motion MIDI Controller` 后，网页不播放内置音色，只向外部音源发送 MIDI Note 和用户开启的动作 CC。

Inertia Glass、Inertia Pluck 和 Impact Drum 继续使用原 Web Audio 引擎，不会因 MIDI 控制器的设置而改变。Kinetic Shaker 已从当前产品范围中移除。

## 当前验证状态（2026-07-13）

- macOS IAC 驱动已上线，端口在“音频 MIDI 设置”中命名为 `MotionScore Test`。
- Web MIDI 端口列表可能显示为 `IAC驱动程序总线1 · Apple Inc.`，Cubase 中显示为 `IAC… MotionScore Test`；二者是同一条 IAC 总线。
- 已在 Cubase 15 建立独立 Kontakt 8 乐器轨，并将 MIDI Input 指定为该 IAC 端口。
- 已从 MotionScore 电脑网页发送 C4，并在 Cubase 轨道中成功录到 Note On / Note Off 事件。
- 隔离测试工程保存在 `cubase-midi-test/MotionScore_MIDI_Test.cpr`，未修改用户原有 Cubase 工程。
- 新增独立 `Motion MIDI Controller` 界面；手机同步切换为 12 键半音阶键盘，支持升降八度。
- 左右倾斜、前后倾斜和连续晃动都有独立开关，电脑端可修改它们的 CC 目标。

## 1. 建立 macOS 虚拟 MIDI 端口

1. 打开 macOS“音频 MIDI 设置”。
2. 选择“窗口 → 显示 MIDI 工作室”。
3. 双击“IAC 驱动程序”。
4. 勾选“设备已在线”。
5. 新建并命名一个总线，例如 `MotionScore Test`。

## 2. 从 MotionScore 发送 MIDI

1. 建议用最新版 Chrome 打开电脑舞台端。
2. 打开“音色库”，选择 `Motion MIDI Controller`。
3. 在右侧“MOTION MIDI CONTROLLER”面板点击“启用 MIDI”。
4. 选择 `MotionScore Test`。
5. 用手机配对后，手机自动显示半音阶 MIDI 键盘和动作开关。

如果虚拟端口断开，MIDI 键盘停止发送，不会影响其他内置乐器。

## 3. 只连接 Kontakt 独立版

1. 打开 Kontakt Standalone。
2. 进入 `File → Options → MIDI`。
3. 在 Inputs 中找到 `MotionScore Test`，将状态设置为 Port A。
4. 加载一个音源并点击 MotionScore 的 C4—C5 按键测试。
5. 用 Kontakt MIDI Learn 将所需 CC 绑定到音源参数。

## 4. 连接 Cubase + Kontakt

1. 在 Cubase 新建 Kontakt 乐器轨。
2. 将轨道 MIDI Input 设为 `MotionScore Test`。
3. 打开轨道 Monitor。
4. 在 Kontakt 或 Cubase MIDI Remote / Quick Controls 中完成参数映射。

## 5. Motion MIDI Controller Profile v1

| 交互 | MIDI 消息 | 建议目标 |
| --- | --- | --- |
| 点击音高 | Note On / Note Off，通道 1 | Kontakt 音符 |
| 左右倾斜 | 默认 CC10，默认关闭 | 声像；双极性，中心值 64 |
| 前后倾斜 | 默认 CC1，默认开启 | Mod Wheel；单极性 0—127 |
| 连续晃动 | 默认 CC11，默认关闭 | Expression；晃动强度 0—127 |
| 全部停止或断开 | CC64=0 + CC123=0 | 释放延音并停止所有音符 |

电脑端可从 CC1、CC2、CC7、CC10、CC11、CC74 中重新选择每个动作的目标。设置保存在本机浏览器，并与已配对手机同步。
