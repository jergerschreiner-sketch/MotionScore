"use client";

import type { DataConnection, Peer as PeerInstance } from "peerjs";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  NOTE_DEFINITIONS,
  allNotesOff,
  createAudioRig,
  isNoteMessage,
  loadBuiltInBank,
  loadPercussionBank,
  noteOff,
  noteOn,
  triggerDelayThrow,
  triggerPercussion,
  triggerPercussionVoice,
  triggerReverbThrow,
  updateMotionEffects,
  type AudioRig,
  type NoteMessage,
} from "./motion-audio";

type Role = "home" | "stage" | "controller";
type InstrumentMode = "tonal" | "shaker" | "drum";

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

type PerformanceEvent = {
  at: number;
  data: SensorFrame | NoteMessage;
};

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

function supportedMime(candidates: string[]) {
  return candidates.find((value) => MediaRecorder.isTypeSupported(value)) ?? "";
}

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

function worldVerticalAcceleration(frame: SensorFrame) {
  const beta = (frame.beta * Math.PI) / 180;
  const gamma = (frame.gamma * Math.PI) / 180;
  return (
    -Math.cos(beta) * Math.sin(gamma) * frame.ax +
    Math.sin(beta) * frame.ay +
    Math.cos(beta) * Math.cos(gamma) * frame.az
  );
}

function MotionCanvas({
  frame,
  pulse,
  noteIndex,
}: {
  frame: SensorFrame;
  pulse: number;
  noteIndex: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(frame);
  const pulseRef = useRef(pulse);
  const noteIndexRef = useRef(noteIndex);
  const pointRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    frameRef.current = frame;
    pulseRef.current = pulse;
    noteIndexRef.current = noteIndex;
  }, [frame, pulse, noteIndex]);

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
      const baseHue = NOTE_DEFINITIONS[noteIndexRef.current]?.color ?? 42;
      const hue = baseHue + clamp(current.rz / 220, -1, 1) * 24;
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
  const [bankStatus, setBankStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [sampleName, setSampleName] = useState("Inertia Glass · 原创多采样音色");
  const [instrumentMode, setInstrumentMode] = useState<InstrumentMode>("tonal");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [activeNotes, setActiveNotes] = useState<number[]>([]);
  const [currentNoteName, setCurrentNoteName] = useState("—");
  const [gestureLabel, setGestureLabel] = useState("等待演奏");
  const [isRecording, setIsRecording] = useState(false);
  const [isReplaying, setIsReplaying] = useState(false);
  const [recordedCount, setRecordedCount] = useState(0);
  const [audioRecording, setAudioRecording] = useState<Blob | null>(null);
  const [videoRecording, setVideoRecording] = useState<Blob | null>(null);
  const [message, setMessage] = useState("");

  const peerRef = useRef<PeerInstance | null>(null);
  const connectionRef = useRef<DataConnection | null>(null);
  const audioRef = useRef<AudioRig | null>(null);
  const instrumentModeRef = useRef<InstrumentMode>("tonal");
  const lastShakerRef = useRef(0);
  const lastDrumRef = useRef(0);
  const activeNotesRef = useRef<number[]>([]);
  const shakeRef = useRef(0);
  const verticalGestureRef = useRef<{
    direction: -1 | 0 | 1;
    startedAt: number;
    peak: number;
    reversals: number;
    lastSign: -1 | 0 | 1;
  }>({ direction: 0, startedAt: 0, peak: 0, reversals: 0, lastSign: 0 });
  const verticalCooldownRef = useRef(0);
  const orientationRef = useRef({ alpha: 0, beta: 0, gamma: 0 });
  const lastSentRef = useRef(0);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingRef = useRef(false);
  const replayingRef = useRef(false);
  const recordingStartRef = useRef(0);
  const performanceRef = useRef<PerformanceEvent[]>([]);
  const replayTimersRef = useRef<number[]>([]);
  const mediaRecordersRef = useRef<MediaRecorder[]>([]);
  const mediaStreamsRef = useRef<MediaStream[]>([]);

  const captureEvent = useCallback((data: SensorFrame | NoteMessage) => {
    if (!recordingRef.current || replayingRef.current) return;
    performanceRef.current.push({ at: performance.now() - recordingStartRef.current, data });
    if (performanceRef.current.length % 12 === 0) setRecordedCount(performanceRef.current.length);
  }, []);

  const statusLabel = useMemo(() => {
    if (connectionState === "connected") return "已连接";
    if (connectionState === "waiting") return "等待手机";
    if (connectionState === "connecting") return "正在连接";
    if (connectionState === "error") return "连接异常";
    return "尚未连接";
  }, [connectionState]);

  const processFrame = useCallback((next: SensorFrame) => {
    captureEvent(next);
    setFrame(next);
    const energy = clamp(next.magnitude / 12, 0, 1);
    shakeRef.current = shakeRef.current * 0.76 + energy * 0.24;
    const pan = clamp(next.gamma / 45, -1, 1);
    const brightness = clamp((next.beta + 30) / 120, 0, 1);
    const now = performance.now();
    const vertical = worldVerticalAcceleration(next);
    const rotationSpeed = Math.sqrt(next.rx ** 2 + next.ry ** 2 + next.rz ** 2);

    if (audioRef.current) {
      updateMotionEffects(audioRef.current, {
        pan,
        brightness,
        shake: instrumentModeRef.current === "tonal" ? shakeRef.current : 0,
      });
    }

    if (instrumentModeRef.current === "drum") {
      if (next.magnitude > 7.8 && now - lastDrumRef.current > 280) {
        lastDrumRef.current = now;
        if (audioRef.current) triggerPercussionVoice(audioRef.current, "heavy-drum", clamp(next.magnitude / 14, 0.45, 1));
        setGestureLabel("重冲击 · 重鼓");
        setPulse(1);
        if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
        pulseTimerRef.current = setTimeout(() => setPulse(0), 170);
      }
      return;
    }

    if (instrumentModeRef.current === "shaker") {
      const shakerIntensity = clamp((next.magnitude - 0.55) / 4.8, 0, 1);
      const interval = 175 - shakerIntensity * 115;
      if (next.magnitude > 0.7 && now - lastShakerRef.current > interval) {
        lastShakerRef.current = now;
        if (audioRef.current) triggerPercussionVoice(audioRef.current, "shaker", clamp(0.2 + shakerIntensity * 0.8, 0.2, 1));
        setGestureLabel("连续晃动 · 沙锤");
        setPulse(0.34);
        if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
        pulseTimerRef.current = setTimeout(() => setPulse(0), 90);
      }
      return;
    }

    const verticalStrength = Math.abs(vertical);
    const dominance = verticalStrength / Math.max(next.magnitude, 0.01);
    const gesture = verticalGestureRef.current;

    if (gesture.direction === 0 && now >= verticalCooldownRef.current) {
      if (vertical > 2.9 && dominance > 0.68 && rotationSpeed < 85) {
        const direction = 1 as const;
        verticalGestureRef.current = {
          direction,
          startedAt: now,
          peak: verticalStrength,
          reversals: 0,
          lastSign: direction,
        };
      }
    } else if (gesture.direction !== 0) {
      const elapsed = now - gesture.startedAt;
      gesture.peak = Math.max(gesture.peak, verticalStrength);
      if (verticalStrength > 1.8) {
        const sign: -1 | 1 = vertical > 0 ? 1 : -1;
        if (sign !== gesture.lastSign) {
          gesture.reversals += 1;
          gesture.lastSign = sign;
        }
      }

      if (gesture.reversals >= 2 || rotationSpeed > 120 || elapsed > 460) {
        verticalGestureRef.current = { direction: 0, startedAt: 0, peak: 0, reversals: 0, lastSign: 0 };
        verticalCooldownRef.current = now + 180;
      } else if (elapsed >= 180 && (verticalStrength < 1.15 || elapsed >= 300)) {
        const strength = clamp((gesture.peak - 2.9) / 6.5, 0.2, 1);
        if (audioRef.current) {
          triggerReverbThrow(audioRef.current, strength);
          triggerDelayThrow(audioRef.current, strength);
        }
        setGestureLabel("快速上提 · 混响 + 延迟");
        setPulse(0.8);
        if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
        pulseTimerRef.current = setTimeout(() => setPulse(0), 180);
        verticalGestureRef.current = { direction: 0, startedAt: 0, peak: 0, reversals: 0, lastSign: 0 };
        verticalCooldownRef.current = now + 620;
      }
    }
  }, [captureEvent]);

  const processNote = useCallback((note: NoteMessage) => {
    captureEvent(note);
    if (instrumentModeRef.current !== "tonal") return;
    if (note.action === "allOff") {
      activeNotesRef.current = [];
      setActiveNotes([]);
      setCurrentNoteName("—");
      setGestureLabel("全部释音");
      if (audioRef.current) allNotesOff(audioRef.current);
      return;
    }
    if (typeof note.midi !== "number") return;
    if (note.action === "on") {
      const next = [...activeNotesRef.current.filter((value) => value !== note.midi), note.midi];
      activeNotesRef.current = next;
      setActiveNotes(next);
      setCurrentNoteName(note.name ?? String(note.midi));
      setGestureLabel("触键 · 发音");
      setPulse(0.55);
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = setTimeout(() => setPulse(0), 130);
      if (audioRef.current && audioRef.current.samples.size > 0) {
        noteOn(audioRef.current, note.midi, note.velocity ?? 0.58);
      } else {
        setMessage("已收到音符，请先点击“启用声音”加载音色");
      }
      return;
    }
    activeNotesRef.current = activeNotesRef.current.filter((value) => value !== note.midi);
    setActiveNotes(activeNotesRef.current);
    if (audioRef.current) noteOff(audioRef.current, note.midi);
  }, [captureEvent]);

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
          connection.send({ type: "instrument", mode: instrumentModeRef.current });
        });
        connection.on("data", (data) => {
          if (isSensorFrame(data)) processFrame(data);
          else if (isNoteMessage(data)) processNote(data);
        });
        connection.on("close", () => {
          if (audioRef.current) allNotesOff(audioRef.current);
          activeNotesRef.current = [];
          setActiveNotes([]);
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
  }, [processFrame, processNote, role, roomCode]);

  useEffect(() => {
    return () => {
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
      replayTimersRef.current.forEach(window.clearTimeout);
      mediaRecordersRef.current.forEach((recorder) => {
        if (recorder.state !== "inactive") recorder.stop();
      });
      mediaStreamsRef.current.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
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
    if (audioRef.current.samples.size === 0) {
      setBankStatus("loading");
      setMessage("正在加载旋律与打击乐音色库…");
      try {
        await loadBuiltInBank(audioRef.current);
        await loadPercussionBank(audioRef.current);
        setBankStatus("ready");
        setSampleName(instrumentModeRef.current === "tonal" ? "Inertia Glass · 24-bit 多采样" : instrumentModeRef.current === "shaker" ? "Kinetic Shaker · 4 变体" : "Impact Drum · 重鼓");
        setMessage("音色引擎就绪：触屏定音，动作塑形");
      } catch {
        setBankStatus("error");
        setMessage("音色加载失败，请刷新页面后重试");
        return;
      }
    }
    setSoundReady(true);
  }, []);

  const selectInstrument = useCallback((mode: InstrumentMode) => {
    instrumentModeRef.current = mode;
    setInstrumentMode(mode);
    setSampleName(mode === "tonal" ? "Inertia Glass · 24-bit 多采样" : mode === "shaker" ? "Kinetic Shaker · 4 变体" : "Impact Drum · 重鼓");
    setCurrentNoteName(mode === "tonal" ? "—" : mode === "shaker" ? "SHAKER" : "DRUM");
    setGestureLabel(mode === "tonal" ? "手机触键演奏" : mode === "shaker" ? "等待连续晃动" : "等待明显冲击");
    if (audioRef.current) allNotesOff(audioRef.current);
    activeNotesRef.current = [];
    setActiveNotes([]);
    if (connectionRef.current?.open) connectionRef.current.send({ type: "instrument", mode });
  }, []);

  const replacePercussionSample = useCallback(async (kind: "shaker" | "heavy-drum", file: File | undefined) => {
    if (!file) return;
    await enableAudio();
    if (!audioRef.current) return;
    const data = await file.arrayBuffer();
    const buffer = await audioRef.current.context.decodeAudioData(data);
    if (kind === "shaker") {
      ["shaker", "shaker-2", "shaker-3", "shaker-4"].forEach((name) => audioRef.current?.samples.set(`percussion:${name}`, buffer));
    } else {
      audioRef.current.samples.set("percussion:heavy-drum", buffer);
    }
    setSoundReady(true);
    setMessage(`${kind === "shaker" ? "沙锤" : "重鼓"}采样已替换为 ${file.name}`);
  }, [enableAudio]);

  const previewNote = useCallback(async (midi: number, name: string) => {
    await enableAudio();
    if (!audioRef.current || audioRef.current.samples.size === 0) return;
    processNote({ type: "note", action: "on", midi, name, velocity: 0.64, t: Date.now() });
    window.setTimeout(() => {
      processNote({ type: "note", action: "off", midi, name, t: Date.now() });
    }, 900);
  }, [enableAudio, processNote]);

  const simulate = useCallback(
    (kind: "hit" | "tilt-left" | "tilt-right" | "shake") => {
      const map: Record<typeof kind, Partial<SensorFrame>> = {
        hit: { ax: 8, ay: 4, az: 7, magnitude: 11, gamma: 0, beta: 45 },
        "tilt-left": { magnitude: 0.4, gamma: -38, beta: 45, ax: -1 },
        "tilt-right": { magnitude: 0.4, gamma: 38, beta: 45, ax: 1 },
        shake: { ax: 5.2, ay: -3.8, az: 2.1, magnitude: 6.8, gamma: 12, beta: 72 },
      };
      processFrame({ ...INITIAL_FRAME, ...map[kind], t: Date.now() });
      if (kind === "hit" && audioRef.current) {
        triggerPercussion(audioRef.current, 0.72, 0);
      }
    },
    [processFrame],
  );

  const toggleRecording = useCallback(async () => {
    if (recordingRef.current) {
      recordingRef.current = false;
      mediaRecordersRef.current.forEach((recorder) => {
        if (recorder.state !== "inactive") recorder.stop();
      });
      mediaStreamsRef.current.forEach((stream) => stream.getVideoTracks().forEach((track) => track.stop()));
      setIsRecording(false);
      setRecordedCount(performanceRef.current.length);
      setMessage("录制完成，正在生成音频和视频文件…");
      return;
    }
    if (!("MediaRecorder" in window)) {
      setMessage("当前浏览器不支持媒体录制，请使用最新版 Chrome 或 Safari");
      return;
    }
    await enableAudio();
    const rig = audioRef.current;
    const canvas = document.querySelector<HTMLCanvasElement>(".motion-canvas");
    if (!rig || !canvas) return;
    replayTimersRef.current.forEach(window.clearTimeout);
    performanceRef.current = [];
    setAudioRecording(null);
    setVideoRecording(null);
    mediaRecordersRef.current = [];
    mediaStreamsRef.current = [];

    const audioMime = supportedMime(["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]);
    const videoMime = supportedMime(["video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]);
    const audioChunks: BlobPart[] = [];
    const videoChunks: BlobPart[] = [];
    const audioRecorder = new MediaRecorder(rig.capture.stream, audioMime ? { mimeType: audioMime } : undefined);
    audioRecorder.ondataavailable = (event) => { if (event.data.size) audioChunks.push(event.data); };
    audioRecorder.onstop = () => setAudioRecording(new Blob(audioChunks, { type: audioRecorder.mimeType || audioMime || "audio/webm" }));
    mediaRecordersRef.current.push(audioRecorder);

    const canvasStream = canvas.captureStream(30);
    const combinedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...rig.capture.stream.getAudioTracks().map((track) => track.clone()),
    ]);
    mediaStreamsRef.current.push(canvasStream, combinedStream);
    const videoRecorder = new MediaRecorder(combinedStream, videoMime ? { mimeType: videoMime } : undefined);
    videoRecorder.ondataavailable = (event) => { if (event.data.size) videoChunks.push(event.data); };
    videoRecorder.onstop = () => {
      setVideoRecording(new Blob(videoChunks, { type: videoRecorder.mimeType || videoMime || "video/webm" }));
      combinedStream.getAudioTracks().forEach((track) => track.stop());
      setMessage(`录制完成：${performanceRef.current.length} 个演奏事件，可导出音频或视频`);
    };
    mediaRecordersRef.current.push(videoRecorder);
    audioRecorder.start(500);
    videoRecorder.start(500);
    recordingStartRef.current = performance.now();
    recordingRef.current = true;
    setRecordedCount(0);
    setIsRecording(true);
    setMessage("正在记录音符、动作和视觉轨迹…");
  }, [enableAudio]);

  const replayPerformance = useCallback(async () => {
    if (!performanceRef.current.length || isReplaying) return;
    await enableAudio();
    replayTimersRef.current.forEach(window.clearTimeout);
    replayingRef.current = true;
    setIsReplaying(true);
    setMessage("正在回放演奏记录");
    const events = [...performanceRef.current];
    for (const event of events) {
      const timer = window.setTimeout(() => {
        if (isSensorFrame(event.data)) processFrame(event.data);
        else processNote(event.data);
      }, event.at);
      replayTimersRef.current.push(timer);
    }
    const end = events.at(-1)?.at ?? 0;
    replayTimersRef.current.push(window.setTimeout(() => {
      replayingRef.current = false;
      setIsReplaying(false);
      if (audioRef.current) allNotesOff(audioRef.current);
      setMessage("回放完成");
    }, end + 600));
  }, [enableAudio, isReplaying, processFrame, processNote]);

  const exportAudio = useCallback(() => {
    if (!audioRecording) return;
    const extension = audioRecording.type.includes("mp4") ? "m4a" : "webm";
    downloadBlob(audioRecording, `motionscore-audio-${Date.now()}.${extension}`);
  }, [audioRecording]);

  const exportVideo = useCallback(() => {
    if (!videoRecording) return;
    const extension = videoRecording.type.includes("mp4") ? "mp4" : "webm";
    downloadBlob(videoRecording, `motionscore-video-${Date.now()}.${extension}`);
  }, [videoRecording]);

  const visualNoteIndex = NOTE_DEFINITIONS.findIndex(
    (note) => note.midi === activeNotes.at(-1),
  );

  if (role === "home") {
    return (
      <main className="home-shell">
        <div className="ambient ambient-one" />
        <div className="ambient ambient-two" />
        <header className="brand-row">
          <span className="brand-mark">MS</span>
          <span>惯性谱 / MotionScore</span>
          <span className="prototype-tag">PROTOTYPE 02</span>
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
            每次触键、倾斜与垂直投掷，都成为可演奏、可看见的音乐事件。
          </p>
        </section>

        <section className="role-grid" aria-label="选择设备角色">
          <button className="role-card stage-card" onClick={() => setRole("stage")}>
            <span className="role-index">01</span>
            <span className="role-title">电脑舞台端</span>
            <span className="role-description">接收动作 · 播放声音 · 生成视觉谱</span>
            <span className="role-action">在 Mac 上进入 ↗</span>
          </button>
          <a
            className="role-card controller-card"
            href="/phone.html"
          >
            <span className="role-index">02</span>
            <span className="role-title">手机控制端</span>
            <span className="role-description">读取传感器 · 发送动作 · 实时演奏</span>
            <span className="role-action">在 iPhone 上进入 ↗</span>
          </a>
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
      <MotionCanvas frame={frame} pulse={pulse} noteIndex={visualNoteIndex} />
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
          <div className="meter-row"><span>升降</span><i><b style={{ width: `${clamp(Math.abs(worldVerticalAcceleration(frame)) / 8, 0, 1) * 100}%` }} /></i></div>
        </div>
      </section>

      <section className="performance-state glass-card">
        <span className="panel-label">PERFORMANCE STATE</span>
        <div><strong>{currentNoteName}</strong><span>{gestureLabel}</span></div>
        <small>{instrumentMode === "shaker" ? "晃动越快 · 沙锤越密" : instrumentMode === "drum" ? "明显冲击触发重鼓" : activeNotes.length ? `${activeNotes.length} 个音正在保持` : "手机触键选择音高"}</small>
      </section>

      <section className="stage-controls glass-card">
        <div>
          <span className="panel-label">SOUND ENGINE</span>
          <strong>{sampleName}</strong>
        </div>
        <button className={soundReady ? "active" : ""} onClick={() => void enableAudio()} disabled={bankStatus === "loading"}>
          {bankStatus === "loading" ? "加载音色中…" : soundReady ? "声音已启用" : "启用声音"}
        </button>
        <button onClick={() => setLibraryOpen((value) => !value)}>音色库</button>
      </section>

      {libraryOpen && (
        <section className="library-manager glass-card">
          <header><div><span className="panel-label">SOUND LIBRARY</span><strong>音色库管理</strong></div><button onClick={() => setLibraryOpen(false)}>关闭</button></header>
          <div className="library-grid">
            <button className={instrumentMode === "tonal" ? "active" : ""} onClick={() => selectInstrument("tonal")}>
              <b>Inertia Glass</b><span>旋律采样乐器</span><small>8 音高 · 24 多力度采样</small>
            </button>
            <button className={instrumentMode === "shaker" ? "active" : ""} onClick={() => selectInstrument("shaker")}>
              <b>Kinetic Shaker</b><span>动作沙锤</span><small>连续晃动 · 密度响应</small>
            </button>
            <button className={instrumentMode === "drum" ? "active" : ""} onClick={() => selectInstrument("drum")}>
              <b>Impact Drum</b><span>动作重鼓</span><small>明显冲击 · 力度响应</small>
            </button>
          </div>
          <div className="sample-replace">
            <span>自定义打击乐采样</span>
            <label>替换沙锤<input type="file" accept="audio/*" onChange={(event) => void replacePercussionSample("shaker", event.target.files?.[0])} /></label>
            <label>替换重鼓<input type="file" accept="audio/*" onChange={(event) => void replacePercussionSample("heavy-drum", event.target.files?.[0])} /></label>
          </div>
        </section>
      )}

      <section className="performance-tools glass-card">
        <div className="tool-heading">
          <span className="panel-label">PERFORMANCE CAPTURE</span>
          <small>{recordedCount} EVENTS</small>
        </div>
        <div className="tool-buttons">
          <button className={isRecording ? "recording" : ""} onClick={() => void toggleRecording()}>
            {isRecording ? "停止录制" : "开始录制"}
          </button>
          <button disabled={!recordedCount || isRecording} onClick={() => void replayPerformance()}>{isReplaying ? "回放中" : "回放"}</button>
          <button disabled={!audioRecording || isRecording} onClick={exportAudio}>导出音频</button>
          <button disabled={!videoRecording || isRecording} onClick={exportVideo}>导出视频</button>
        </div>
      </section>

      <section className={`stage-keyboard glass-card ${instrumentMode}`}>
        <span className="panel-label">{instrumentMode === "tonal" ? "电脑试听音阶" : instrumentMode === "shaker" ? "电脑试听沙锤" : "电脑试听重鼓"}</span>
        <div>
          {instrumentMode === "tonal" ? NOTE_DEFINITIONS.map((note) => (
            <button key={note.midi} onClick={() => void previewNote(note.midi, note.name)}>
              {note.name}
            </button>
          )) : instrumentMode === "shaker" ?
            <button onClick={() => audioRef.current && triggerPercussionVoice(audioRef.current, "shaker", 0.55)}>沙锤</button> :
            <button onClick={() => audioRef.current && triggerPercussionVoice(audioRef.current, "heavy-drum", 0.9)}>重鼓</button>}
        </div>
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
