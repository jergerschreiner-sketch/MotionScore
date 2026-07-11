"use client";

import type { DataConnection, Peer as PeerInstance } from "peerjs";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Role = "home" | "stage" | "controller";

type SensorFrame = {
  type: "sensor";
  ax: number;
  ay: number;
  az: number;
  alpha: number;
  beta: number;
  gamma: number;
  rx: number;
  ry: number;
  rz: number;
  magnitude: number;
  t: number;
};

type AudioRig = {
  context: AudioContext;
  master: GainNode;
  textureGain: GainNode;
  textureFilter: BiquadFilterNode;
  texturePan: StereoPannerNode;
  sample: AudioBuffer | null;
};

const INITIAL_FRAME: SensorFrame = {
  type: "sensor",
  ax: 0,
  ay: 0,
  az: 0,
  alpha: 0,
  beta: 0,
  gamma: 0,
  rx: 0,
  ry: 0,
  rz: 0,
  magnitude: 0,
  t: 0,
};

function makeRoomCode() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from({ length: 5 }, () =>
    alphabet.charAt(Math.floor(Math.random() * alphabet.length)),
  ).join("");
}

function peerId(code: string) {
  return `motionscore-${code.trim().toLowerCase()}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isSensorFrame(value: unknown): value is SensorFrame {
  if (!value || typeof value !== "object") return false;
  return (value as { type?: string }).type === "sensor";
}

function createNoiseBuffer(context: AudioContext, seconds = 2) {
  const length = context.sampleRate * seconds;
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) {
    data[index] = Math.random() * 2 - 1;
  }
  return buffer;
}

function createAudioRig(): AudioRig {
  const context = new AudioContext();
  const master = context.createGain();
  master.gain.value = 0.72;
  master.connect(context.destination);

  const texture = context.createBufferSource();
  texture.buffer = createNoiseBuffer(context);
  texture.loop = true;

  const textureFilter = context.createBiquadFilter();
  textureFilter.type = "bandpass";
  textureFilter.frequency.value = 1800;
  textureFilter.Q.value = 2.8;

  const texturePan = context.createStereoPanner();
  const textureGain = context.createGain();
  textureGain.gain.value = 0;

  texture
    .connect(textureFilter)
    .connect(texturePan)
    .connect(textureGain)
    .connect(master);
  texture.start();

  return {
    context,
    master,
    textureGain,
    textureFilter,
    texturePan,
    sample: null,
  };
}

function triggerHit(rig: AudioRig, velocity: number, pan: number) {
  const now = rig.context.currentTime;
  const gain = rig.context.createGain();
  const panner = rig.context.createStereoPanner();
  panner.pan.value = clamp(pan, -1, 1);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(clamp(velocity, 0.08, 1), now + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
  gain.connect(panner).connect(rig.master);

  if (rig.sample) {
    const source = rig.context.createBufferSource();
    source.buffer = rig.sample;
    source.connect(gain);
    source.start(now);
    return;
  }

  const oscillator = rig.context.createOscillator();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(170, now);
  oscillator.frequency.exponentialRampToValueAtTime(58, now + 0.2);
  oscillator.connect(gain);
  oscillator.start(now);
  oscillator.stop(now + 0.25);
}

function updateTexture(
  rig: AudioRig,
  intensity: number,
  pan: number,
  brightness: number,
) {
  const now = rig.context.currentTime;
  rig.textureGain.gain.setTargetAtTime(intensity * 0.18, now, 0.045);
  rig.texturePan.pan.setTargetAtTime(clamp(pan, -1, 1), now, 0.06);
  const frequency = 260 + clamp(brightness, 0, 1) * 5400;
  rig.textureFilter.frequency.setTargetAtTime(frequency, now, 0.06);
}

function MotionCanvas({
  frame,
  pulse,
}: {
  frame: SensorFrame;
  pulse: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(frame);
  const pulseRef = useRef(pulse);
  const pointRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    frameRef.current = frame;
    pulseRef.current = pulse;
  }, [frame, pulse]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let animation = 0;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, rect.width * ratio);
      canvas.height = Math.max(1, rect.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      pointRef.current = { x: rect.width / 2, y: rect.height / 2 };
    };

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const current = frameRef.current;
      const previous = pointRef.current;
      const targetX = rect.width / 2 + clamp(current.gamma / 48, -1, 1) * rect.width * 0.38;
      const targetY = rect.height / 2 + clamp((current.beta - 45) / 70, -1, 1) * rect.height * 0.35;
      const x = previous.x + (targetX - previous.x) * 0.16 + current.ax * 0.45;
      const y = previous.y + (targetY - previous.y) * 0.16 + current.ay * 0.45;

      context.fillStyle = "rgba(8, 9, 8, 0.055)";
      context.fillRect(0, 0, rect.width, rect.height);

      const energy = clamp(current.magnitude / 14, 0, 1);
      const hue = 38 + clamp((current.rz + 180) / 360, 0, 1) * 105;
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.quadraticCurveTo(
        previous.x + current.rx * 0.04,
        previous.y + current.ry * 0.04,
        x,
        y,
      );
      context.lineCap = "round";
      context.lineWidth = 1.2 + energy * 13 + pulseRef.current * 3;
      context.strokeStyle = `hsla(${hue}, 94%, ${62 + energy * 20}%, ${0.18 + energy * 0.72})`;
      context.shadowBlur = 6 + energy * 26;
      context.shadowColor = `hsla(${hue}, 100%, 70%, .7)`;
      context.stroke();
      context.shadowBlur = 0;

      if (pulseRef.current > 0.1) {
        context.beginPath();
        context.arc(x, y, 8 + pulseRef.current * 34, 0, Math.PI * 2);
        context.strokeStyle = `rgba(255, 244, 210, ${pulseRef.current * 0.7})`;
        context.lineWidth = 1;
        context.stroke();
      }

      pointRef.current = { x, y };
      animation = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener("resize", resize);
    animation = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animation);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas className="motion-canvas" ref={canvasRef} aria-label="动作视觉乐谱" />;
}

export function MotionScoreApp() {
  const [role, setRole] = useState<Role>("home");
  const [roomCode, setRoomCode] = useState(makeRoomCode);
  const [inputCode, setInputCode] = useState("");
  const [connectionState, setConnectionState] = useState<
    "idle" | "waiting" | "connecting" | "connected" | "error"
  >("idle");
  const [sensorState, setSensorState] = useState<
    "idle" | "active" | "denied" | "unsupported"
  >("idle");
  const [frame, setFrame] = useState(INITIAL_FRAME);
  const [pulse, setPulse] = useState(0);
  const [soundReady, setSoundReady] = useState(false);
  const [sampleName, setSampleName] = useState("内置测试音");
  const [message, setMessage] = useState("");

  const peerRef = useRef<PeerInstance | null>(null);
  const connectionRef = useRef<DataConnection | null>(null);
  const audioRef = useRef<AudioRig | null>(null);
  const lastHitRef = useRef(0);
  const shakeRef = useRef(0);
  const orientationRef = useRef({ alpha: 0, beta: 0, gamma: 0 });
  const lastSentRef = useRef(0);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const statusLabel = useMemo(() => {
    if (connectionState === "connected") return "已连接";
    if (connectionState === "waiting") return "等待手机";
    if (connectionState === "connecting") return "正在连接";
    if (connectionState === "error") return "连接异常";
    return "尚未连接";
  }, [connectionState]);

  const processFrame = useCallback((next: SensorFrame) => {
    setFrame(next);
    const energy = clamp(next.magnitude / 12, 0, 1);
    shakeRef.current = shakeRef.current * 0.76 + energy * 0.24;
    const pan = clamp(next.gamma / 45, -1, 1);
    const brightness = clamp((next.beta + 30) / 120, 0, 1);

    if (audioRef.current) {
      updateTexture(audioRef.current, shakeRef.current, pan, brightness);
    }

    const now = performance.now();
    if (next.magnitude > 5.2 && now - lastHitRef.current > 115) {
      lastHitRef.current = now;
      setPulse(1);
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = setTimeout(() => setPulse(0), 150);
      if (audioRef.current) {
        triggerHit(audioRef.current, clamp(next.magnitude / 15, 0.12, 1), pan);
      }
    }
  }, []);

  useEffect(() => {
    if (role !== "stage") return;
    let cancelled = false;
    setConnectionState("waiting");
    setMessage("");

    void import("peerjs").then(({ Peer }) => {
      if (cancelled) return;
      const peer = new Peer(peerId(roomCode), { debug: 1 });
      peerRef.current = peer;

      peer.on("connection", (connection) => {
        connectionRef.current?.close();
        connectionRef.current = connection;
        connection.on("open", () => {
          setConnectionState("connected");
          setMessage("手机动作数据正在实时传输");
        });
        connection.on("data", (data) => {
          if (isSensorFrame(data)) processFrame(data);
        });
        connection.on("close", () => {
          setConnectionState("waiting");
          setMessage("连接已断开，等待重新连接");
        });
        connection.on("error", () => setConnectionState("error"));
      });

      peer.on("error", (error) => {
        if (error.type === "unavailable-id") {
          setRoomCode(makeRoomCode());
          return;
        }
        setConnectionState("error");
        setMessage("暂时无法建立点对点连接，请刷新后重试");
      });
    });

    return () => {
      cancelled = true;
      connectionRef.current?.close();
      peerRef.current?.destroy();
      connectionRef.current = null;
      peerRef.current = null;
    };
  }, [processFrame, role, roomCode]);

  useEffect(() => {
    return () => {
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
      void audioRef.current?.context.close();
    };
  }, []);

  const connectController = useCallback(async () => {
    const normalized = inputCode.trim().toUpperCase();
    if (normalized.length < 4) {
      setMessage("请输入电脑舞台端显示的配对码");
      return;
    }
    setConnectionState("connecting");
    setMessage("");
    peerRef.current?.destroy();
    const { Peer } = await import("peerjs");
    const peer = new Peer({ debug: 1 });
    peerRef.current = peer;

    peer.on("open", () => {
      const connection = peer.connect(peerId(normalized), {
        reliable: false,
        serialization: "json",
      });
      connectionRef.current = connection;
      connection.on("open", () => {
        setConnectionState("connected");
        setMessage("连接成功，现在启用动作传感器");
      });
      connection.on("close", () => {
        setConnectionState("idle");
        setMessage("连接已断开");
      });
      connection.on("error", () => {
        setConnectionState("error");
        setMessage("连接失败，请确认配对码");
      });
    });
    peer.on("error", () => {
      setConnectionState("error");
      setMessage("连接失败，请确认电脑端仍在等待");
    });
  }, [inputCode]);

  const enableSensors = useCallback(async () => {
    if (!("DeviceMotionEvent" in window)) {
      setSensorState("unsupported");
      setMessage("当前浏览器不支持运动传感器");
      return;
    }

    type PermissionMotionEvent = typeof DeviceMotionEvent & {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    type PermissionOrientationEvent = typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<"granted" | "denied">;
    };

    try {
      const motionClass = DeviceMotionEvent as PermissionMotionEvent;
      const orientationClass = DeviceOrientationEvent as PermissionOrientationEvent;
      const motionPermission = motionClass.requestPermission
        ? await motionClass.requestPermission()
        : "granted";
      const orientationPermission = orientationClass.requestPermission
        ? await orientationClass.requestPermission()
        : "granted";

      if (motionPermission !== "granted" || orientationPermission !== "granted") {
        setSensorState("denied");
        setMessage("没有获得动作与方向传感器权限");
        return;
      }

      const orientationHandler = (event: DeviceOrientationEvent) => {
        orientationRef.current = {
          alpha: event.alpha ?? 0,
          beta: event.beta ?? 0,
          gamma: event.gamma ?? 0,
        };
      };

      const motionHandler = (event: DeviceMotionEvent) => {
        const now = performance.now();
        if (now - lastSentRef.current < 28) return;
        lastSentRef.current = now;
        const acceleration = event.acceleration ?? event.accelerationIncludingGravity;
        const ax = acceleration?.x ?? 0;
        const ay = acceleration?.y ?? 0;
        const az = acceleration?.z ?? 0;
        const rotation = event.rotationRate;
        const orientation = orientationRef.current;
        const next: SensorFrame = {
          type: "sensor",
          ax,
          ay,
          az,
          alpha: orientation.alpha,
          beta: orientation.beta,
          gamma: orientation.gamma,
          rx: rotation?.alpha ?? 0,
          ry: rotation?.beta ?? 0,
          rz: rotation?.gamma ?? 0,
          magnitude: Math.sqrt(ax * ax + ay * ay + az * az),
          t: Date.now(),
        };
        setFrame(next);
        if (connectionRef.current?.open) connectionRef.current.send(next);
      };

      window.addEventListener("deviceorientation", orientationHandler);
      window.addEventListener("devicemotion", motionHandler);
      setSensorState("active");
      setMessage("动作传感已启用，请握紧手机开始演奏");
    } catch {
      setSensorState("denied");
      setMessage("无法启用动作传感器，请检查 Safari 权限设置");
    }
  }, []);

  const enableAudio = useCallback(async () => {
    if (!audioRef.current) audioRef.current = createAudioRig();
    await audioRef.current.context.resume();
    setSoundReady(true);
  }, []);

  const loadSample = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!audioRef.current) audioRef.current = createAudioRig();
    const data = await file.arrayBuffer();
    audioRef.current.sample = await audioRef.current.context.decodeAudioData(data);
    setSampleName(file.name);
    setSoundReady(true);
  }, []);

  const simulate = useCallback(
    (kind: "hit" | "tilt-left" | "tilt-right" | "shake") => {
      const map: Record<typeof kind, Partial<SensorFrame>> = {
        hit: { ax: 8, ay: 4, az: 7, magnitude: 11, gamma: 0, beta: 45 },
        "tilt-left": { magnitude: 0.4, gamma: -38, beta: 45, ax: -1 },
        "tilt-right": { magnitude: 0.4, gamma: 38, beta: 45, ax: 1 },
        shake: { ax: 5.2, ay: -3.8, az: 2.1, magnitude: 6.8, gamma: 12, beta: 72 },
      };
      processFrame({ ...INITIAL_FRAME, ...map[kind], t: Date.now() });
    },
    [processFrame],
  );

  if (role === "home") {
    return (
      <main className="home-shell">
        <div className="ambient ambient-one" />
        <div className="ambient ambient-two" />
        <header className="brand-row">
          <span className="brand-mark">MS</span>
          <span>惯性谱 / MotionScore</span>
          <span className="prototype-tag">PROTOTYPE 01</span>
        </header>

        <section className="hero">
          <p className="eyebrow">MOTION · SOUND · TRACE</p>
          <h1>
            用一次动作，
            <br />
            同时写下<span>声音与光。</span>
          </h1>
          <p className="hero-copy">
            iPhone 是无线动作传感器，Mac 是声音与视觉引擎。
            每次甩动、倾斜与旋转，都成为可演奏、可看见的音乐事件。
          </p>
        </section>

        <section className="role-grid" aria-label="选择设备角色">
          <button className="role-card stage-card" onClick={() => setRole("stage")}>
            <span className="role-index">01</span>
            <span className="role-title">电脑舞台端</span>
            <span className="role-description">接收动作 · 播放声音 · 生成视觉谱</span>
            <span className="role-action">在 Mac 上进入 ↗</span>
          </button>
          <button
            className="role-card controller-card"
            onClick={() => setRole("controller")}
          >
            <span className="role-index">02</span>
            <span className="role-title">手机控制端</span>
            <span className="role-description">读取传感器 · 发送动作 · 实时演奏</span>
            <span className="role-action">在 iPhone 上进入 ↗</span>
          </button>
        </section>

        <footer className="home-footer">
          <span>无线数字乐器与动作视觉乐谱系统</span>
          <span>截止日期 / 2026.08.10</span>
        </footer>
      </main>
    );
  }

  if (role === "controller") {
    return (
      <main className="controller-shell">
        <header className="compact-header">
          <button className="back-button" onClick={() => setRole("home")}>
            ← 返回
          </button>
          <span>手机控制端</span>
          <span className={`status-dot ${connectionState}`} />
        </header>

        <section className="controller-main">
          <div className="phone-orbit">
            <div className={`phone-core ${sensorState === "active" ? "active" : ""}`}>
              <span>MOVE</span>
              <strong>{frame.magnitude.toFixed(1)}</strong>
              <small>m/s²</small>
            </div>
            <i className="orbit orbit-a" />
            <i className="orbit orbit-b" />
          </div>

          <div className="controller-panel">
            <label htmlFor="room-code">输入电脑端配对码</label>
            <input
              id="room-code"
              inputMode="text"
              maxLength={5}
              placeholder="例如 7KX9P"
              value={inputCode}
              onChange={(event) =>
                setInputCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
              }
            />
            <button
              className="primary-button"
              onClick={() => void connectController()}
              disabled={connectionState === "connecting"}
            >
              {connectionState === "connected" ? "已连接电脑" : "连接电脑"}
            </button>
            <button
              className="sensor-button"
              onClick={() => void enableSensors()}
              disabled={sensorState === "active"}
            >
              {sensorState === "active" ? "动作传感已启用" : "启用动作传感"}
            </button>
            <p className="inline-message">{message || "连接后请允许 Safari 访问动作与方向数据"}</p>
          </div>

          <div className="sensor-readout">
            <span><b>X</b>{frame.ax.toFixed(2)}</span>
            <span><b>Y</b>{frame.ay.toFixed(2)}</span>
            <span><b>Z</b>{frame.az.toFixed(2)}</span>
            <span><b>倾斜</b>{frame.gamma.toFixed(0)}°</span>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="stage-shell">
      <MotionCanvas frame={frame} pulse={pulse} />
      <header className="stage-header">
        <button className="back-button light" onClick={() => setRole("home")}>
          ← 退出舞台
        </button>
        <div className="stage-title">
          <span>惯性谱</span>
          <small>MOTION SCORE / LIVE CANVAS</small>
        </div>
        <div className={`connection-pill ${connectionState}`}>
          <i /> {statusLabel}
        </div>
      </header>

      <section className="stage-overlay">
        <div className="pair-card glass-card">
          <span className="panel-label">PAIRING CODE</span>
          <strong>{roomCode}</strong>
          <p>在 iPhone 控制端输入此码</p>
        </div>

        <div className="meters glass-card">
          <span className="panel-label">MOTION DATA</span>
          <div className="meter-row"><span>冲击</span><i><b style={{ width: `${clamp(frame.magnitude / 14, 0, 1) * 100}%` }} /></i></div>
          <div className="meter-row"><span>横向</span><i><b style={{ width: `${clamp((frame.gamma + 45) / 90, 0, 1) * 100}%` }} /></i></div>
          <div className="meter-row"><span>俯仰</span><i><b style={{ width: `${clamp((frame.beta + 30) / 120, 0, 1) * 100}%` }} /></i></div>
        </div>
      </section>

      <section className="stage-controls glass-card">
        <div>
          <span className="panel-label">SOUND ENGINE</span>
          <strong>{sampleName}</strong>
        </div>
        <button className={soundReady ? "active" : ""} onClick={() => void enableAudio()}>
          {soundReady ? "声音已启用" : "启用声音"}
        </button>
        <label className="upload-button">
          更换采样
          <input
            type="file"
            accept="audio/*"
            onChange={(event) => void loadSample(event.target.files?.[0])}
          />
        </label>
      </section>

      <section className="simulator glass-card">
        <span className="panel-label">电脑模拟测试</span>
        <div>
          <button onClick={() => simulate("hit")}>甩动</button>
          <button onClick={() => simulate("shake")}>摇动</button>
          <button onClick={() => simulate("tilt-left")}>左倾</button>
          <button onClick={() => simulate("tilt-right")}>右倾</button>
        </div>
      </section>

      <footer className="stage-footer">
        <span>{message || "等待动作输入"}</span>
        <span>{new Date().toLocaleTimeString("zh-CN", { hour12: false })}</span>
      </footer>
    </main>
  );
}
