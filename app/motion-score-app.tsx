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
  STRING_DEFINITIONS,
  allNotesOff,
  createAudioRig,
  isNoteMessage,
  isStringMessage,
  loadBuiltInBank,
  loadPercussionBank,
  loadStringBank,
  noteOff,
  noteOn,
  triggerDelayThrow,
  triggerPercussion,
  triggerPercussionVoice,
  triggerReverbThrow,
  updateMotionEffects,
  startStringVoice,
  updateStringVoice,
  type AudioRig,
  type NoteMessage,
  type StringMessage,
} from "./motion-audio";
import {
  MotionMidiOutput,
  type MidiGestureKey,
  type MidiGestureMappings,
  type MidiPortInfo,
} from "./midi-output";

type Role = "home" | "stage" | "controller";
type InstrumentMode = "tonal" | "strings" | "drum" | "midi";
type MidiStatus = "idle" | "loading" | "ready" | "unsupported" | "error";

type MidiMappingMessage = {
  type: "midi-mapping";
  key: MidiGestureKey;
  enabled: boolean;
};

const DEFAULT_MIDI_MAPPINGS: MidiGestureMappings = {
  pan: { enabled: false, controller: 10 },
  modulation: { enabled: true, controller: 1 },
  expression: { enabled: false, controller: 11 },
};

const MIDI_CONTROLLER_OPTIONS = [
  { value: 1, label: "CC1 · Mod Wheel" },
  { value: 2, label: "CC2 · Breath" },
  { value: 7, label: "CC7 · Volume" },
  { value: 10, label: "CC10 · Pan" },
  { value: 11, label: "CC11 · Expression" },
  { value: 74, label: "CC74 · Brightness" },
] as const;

const MIDI_MAPPING_META = [
  { key: "pan", gesture: "PAN", detail: "BIPOLAR · CENTER 64" },
  { key: "modulation", gesture: "FILTER / MOD", detail: "UNIPOLAR · 0—127" },
  { key: "expression", gesture: "VIBRATO / EXP", detail: "INTENSITY · 0—127" },
] as const satisfies ReadonlyArray<{ key: MidiGestureKey; gesture: string; detail: string }>;

const DRUM_TRIGGER_THRESHOLD = 9.2;

const MIDI_KEYBOARD_NOTES = [
  { midi: 60, name: "C4" }, { midi: 61, name: "C♯4" },
  { midi: 62, name: "D4" }, { midi: 63, name: "E♭4" },
  { midi: 64, name: "E4" }, { midi: 65, name: "F4" },
  { midi: 66, name: "F♯4" }, { midi: 67, name: "G4" },
  { midi: 68, name: "A♭4" }, { midi: 69, name: "A4" },
  { midi: 70, name: "B♭4" }, { midi: 71, name: "B4" },
] as const;

function loadStoredMidiMappings(): MidiGestureMappings {
  if (typeof window === "undefined") return DEFAULT_MIDI_MAPPINGS;
  try {
    const stored = window.localStorage.getItem("motionscore-midi-mappings-v1");
    if (!stored) return DEFAULT_MIDI_MAPPINGS;
    const parsed = JSON.parse(stored) as Partial<MidiGestureMappings>;
    const next = { ...DEFAULT_MIDI_MAPPINGS };
    for (const key of ["pan", "modulation", "expression"] as const) {
      const value = parsed[key];
      if (value && typeof value.enabled === "boolean" && Number.isInteger(value.controller)) {
        next[key] = {
          enabled: value.enabled,
          controller: Math.max(0, Math.min(127, value.controller)),
        };
      }
    }
    return next;
  } catch {
    return DEFAULT_MIDI_MAPPINGS;
  }
}

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
  data: SensorFrame | NoteMessage | StringMessage;
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

function pitchName(midi: number) {
  const names = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  const rounded = Math.round(midi);
  const cents = Math.round((midi - rounded) * 100);
  const name = `${names[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
  return Math.abs(cents) < 3 ? name : `${name} ${cents > 0 ? "+" : ""}${cents}¢`;
}

function isSensorFrame(value: unknown): value is SensorFrame {
  if (!value || typeof value !== "object") return false;
  return (value as { type?: string }).type === "sensor";
}

function isMidiGestureKey(value: unknown): value is MidiGestureKey {
  return value === "pan" || value === "modulation" || value === "expression";
}

function isMidiMappingMessage(value: unknown): value is MidiMappingMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { type?: unknown; key?: unknown; enabled?: unknown };
  return message.type === "midi-mapping" &&
    isMidiGestureKey(message.key) &&
    typeof message.enabled === "boolean";
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

// Normalized to the approved smoked-glass handpan image. C4 and C5 share Ding.
const GLASS_HANDPAN_HIT_ZONES = [
  { x: 0, y: -0.142, rotation: 0, scale: 1.45 },
  { x: -0.214, y: -0.126, rotation: -0.12, scale: 0.98 },
  { x: 0.214, y: -0.126, rotation: 0.12, scale: 0.98 },
  { x: -0.311, y: -0.026, rotation: -0.58, scale: 1 },
  { x: 0.311, y: -0.026, rotation: 0.58, scale: 1 },
  { x: -0.211, y: 0.057, rotation: -0.78, scale: 1.05 },
  { x: 0.211, y: 0.057, rotation: 0.78, scale: 1.05 },
  { x: 0, y: -0.142, rotation: 0, scale: 1.45 },
] as const;

type TimeRibbonSample = {
  at: number;
  voice: number;
  pitch: number;
  energy: number;
  pan: number;
  filter: number;
  vibrato: number;
  impulse: number;
  echo: number;
  accent: boolean;
  active: boolean;
  hue: number;
  mode: InstrumentMode;
};

function MotionCanvas({
  frame,
  pulse,
  noteIndex,
  activeNoteIndices,
  noteActive,
  mode,
}: {
  frame: SensorFrame;
  pulse: number;
  noteIndex: number;
  activeNoteIndices: number[];
  noteActive: boolean;
  mode: InstrumentMode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(frame);
  const pulseRef = useRef(pulse);
  const noteIndexRef = useRef(noteIndex);
  const activeNoteIndicesRef = useRef(activeNoteIndices);
  const noteActiveRef = useRef(noteActive);
  const modeRef = useRef(mode);
  const drawnModeRef = useRef(mode);
  const struckNoteRef = useRef(Math.max(0, noteIndex));
  const pointRef = useRef({ x: 0, y: 0 });
  const modulationRef = useRef({ shake: 0, phase: 0, echo: 0, impact: 0 });
  const timeRibbonRef = useRef<TimeRibbonSample[]>([]);
  const lastRibbonSampleAtRef = useRef(0);
  const lastRibbonAccentAtRef = useRef(0);
  const drumWaterfallPitchRef = useRef(3.5);

  useEffect(() => {
    frameRef.current = frame;
    pulseRef.current = pulse;
    noteIndexRef.current = noteIndex;
    activeNoteIndicesRef.current = activeNoteIndices;
    noteActiveRef.current = noteActive;
    modeRef.current = mode;
  }, [frame, pulse, noteIndex, activeNoteIndices, noteActive, mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let animation = 0;
    const sculptureSources: Partial<Record<InstrumentMode, string>> = {
      tonal: "/visual-reference/inertia-glass-handpan-concept-v2-smoked.png",
      strings: "/visual-reference/inertia-pluck-warm-concept-v1.png",
      drum: "/visual-reference/impact-drum-warm-concept-v3.png",
    };
    const sculptureImages: Partial<Record<InstrumentMode, HTMLImageElement>> = {};
    for (const [instrument, source] of Object.entries(sculptureSources)) {
      const image = new Image();
      image.decoding = "async";
      image.src = source;
      sculptureImages[instrument as InstrumentMode] = image;
    }
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, rect.width * ratio);
      canvas.height = Math.max(1, rect.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      pointRef.current = { x: rect.width / 2, y: rect.height / 2 };
      context.fillStyle = "#080908";
      context.fillRect(0, 0, rect.width, rect.height);
    };

    const drawTimeRibbon = (
      displayRect: DOMRect,
      now: number,
      performanceOnly: boolean,
    ) => {
      // Work in a rotated score space: current notes enter at the top and history falls downward.
      const rect = { width: displayRect.height, height: displayRect.width };
      const ribbonMode = modeRef.current;
      const duration = ribbonMode === "strings"
        ? performanceOnly ? 5200 : 4200
        : performanceOnly ? 6800 : 5600;
      const samples = timeRibbonRef.current.filter((sample) => now - sample.at <= duration);
      timeRibbonRef.current = samples;
      if (samples.length < 2) return;
      const voiceGroups = new Map<string, TimeRibbonSample[]>();
      for (const sample of samples) {
        const key = `${sample.mode}:${sample.voice}`;
        const voiceSamples = voiceGroups.get(key);
        if (voiceSamples) voiceSamples.push(sample);
        else voiceGroups.set(key, [sample]);
      }

      const left = rect.width * (performanceOnly ? 0.035 : 0.07);
      const right = rect.width * (performanceOnly ? 0.965 : 0.93);
      const activeRibbonMode = samples.at(-1)!.mode;
      const scoreCenter = rect.height * 0.5;
      const scoreHeight = rect.height * (activeRibbonMode === "drum"
        ? performanceOnly ? 0.92 : 0.78
        : performanceOnly ? 0.76 : 0.62);
      const opacityScale = performanceOnly ? 1.18 : 0.76;
      const position = (sample: TimeRibbonSample) => {
        const age = now - sample.at;
        const x = left + (age / duration) * (right - left);
        const pitch = clamp(sample.pitch, 0, 7) / 7;
        const ripple = Math.sin(sample.at * 0.019) * sample.vibrato * (4 + sample.energy * 8);
        return {
          x,
          y: scoreCenter + (0.5 - pitch) * scoreHeight * 0.76 + ripple,
          fade: clamp(1 - age / duration, 0, 1),
        };
      };

      context.save();
      context.translate(displayRect.width / 2, displayRect.height / 2);
      context.rotate(Math.PI / 2);
      context.translate(-displayRect.height / 2, -displayRect.width / 2);
      context.globalCompositeOperation = "screen";
      context.lineCap = "round";
      context.lineJoin = "round";

      for (const voiceSamples of voiceGroups.values()) {
        for (let index = 1; index < voiceSamples.length; index += 1) {
        const previous = voiceSamples[index - 1];
        const current = voiceSamples[index];
        if (previous.mode !== current.mode) continue;
        if (!previous.active && !current.active) continue;
        const beginsNewNote = !previous.active && current.active;
        const tonalPitchJump = current.mode === "tonal"
          && Math.abs(previous.pitch - current.pitch) > 0.08;
        const disconnectFromPrevious = beginsNewNote
          || tonalPitchJump
          || (current.mode === "drum" && current.accent);
        const from = position(disconnectFromPrevious
          ? { ...previous, pitch: current.pitch }
          : previous);
        const to = position(current);
        if (to.x < left || from.x > right) continue;

        const strength = clamp(
          0.22 + current.energy * 0.56 + current.echo * 0.5 + current.impulse * 0.68,
          0,
          1,
        );
        const restingWidth = current.mode === "tonal" ? 10 : current.mode === "strings" ? 11.5 : 5.5;
        const halfWidth = restingWidth
          + current.energy * (current.mode === "drum" ? 5 : current.mode === "strings" ? 10 : 12)
          + current.echo * (current.mode === "drum" ? 4 : current.mode === "strings" ? 7 : 10)
          + current.impulse * (current.mode === "drum" ? 7 : current.mode === "strings" ? 10 : 15);
        const topBias = current.pan * halfWidth * 0.48;
        const bottomBias = -current.pan * halfWidth * 0.48;
        const alpha = strength * to.fade * opacityScale;
        const timeGrain = 0.82 + Math.sin(current.at * 0.011 + index * 0.37) * 0.18;

        if (current.mode === "tonal") {
          // Glass score: independent translucent note slabs with restrained edge light.
          for (let veil = -1; veil <= 1; veil += 1) {
            const veilWidth = halfWidth * (0.68 + Math.abs(veil) * 0.28);
            const veilOffset = veil * halfWidth * 0.5 + Math.sin(current.at * 0.004 + veil * 1.7) * 2.4;
            const glassVeil = context.createLinearGradient(from.x, from.y, to.x, to.y);
            glassVeil.addColorStop(0, `hsla(${previous.hue + veil * 4}, 76%, ${54 + previous.filter * 21}%, ${alpha * (veil === 0 ? 0.28 : 0.12) * timeGrain})`);
            glassVeil.addColorStop(0.54, `hsla(${current.hue + 8}, 88%, ${62 + current.filter * 22}%, ${alpha * (veil === 0 ? 0.42 : 0.18) * timeGrain})`);
            glassVeil.addColorStop(1, `hsla(${current.hue + 17}, 92%, 82%, ${alpha * (veil === 0 ? 0.31 : 0.1)})`);
            context.beginPath();
            context.moveTo(from.x - 0.8, from.y + veilOffset - veilWidth + topBias);
            context.quadraticCurveTo(
              (from.x + to.x) / 2,
              (from.y + to.y) / 2 + veilOffset - veilWidth + current.pan * 2,
              to.x + 0.8,
              to.y + veilOffset - veilWidth + topBias,
            );
            context.lineTo(to.x + 0.8, to.y + veilOffset + veilWidth + bottomBias);
            context.quadraticCurveTo(
              (from.x + to.x) / 2,
              (from.y + to.y) / 2 + veilOffset + veilWidth - current.pan * 2,
              from.x - 0.8,
              from.y + veilOffset + veilWidth + bottomBias,
            );
            context.closePath();
            context.fillStyle = glassVeil;
            context.fill();
          }

          for (const edge of [-1, 1]) {
            context.beginPath();
            context.moveTo(from.x, from.y + halfWidth * edge * 0.9);
            context.quadraticCurveTo(
              (from.x + to.x) / 2,
              (from.y + to.y) / 2 + halfWidth * edge * 0.9 + current.pan * 1.4,
              to.x,
              to.y + halfWidth * edge * 0.9,
            );
            context.strokeStyle = `hsla(${current.hue + 18}, 84%, 88%, ${alpha * 0.2 * timeGrain})`;
            context.lineWidth = 0.58;
            context.stroke();
          }

          if (current.accent) {
            const lens = context.createRadialGradient(to.x, to.y, 0, to.x, to.y, 18 + halfWidth * 1.4);
            lens.addColorStop(0, `hsla(${current.hue + 20}, 96%, 92%, ${alpha * 0.78})`);
            lens.addColorStop(0.34, `hsla(${current.hue + 9}, 94%, 68%, ${alpha * 0.38})`);
            lens.addColorStop(1, `hsla(${current.hue}, 82%, 44%, 0)`);
            context.beginPath();
            context.ellipse(to.x, to.y, 12 + halfWidth * 0.9, 6 + halfWidth * 0.42, current.pan * 0.24, 0, Math.PI * 2);
            context.fillStyle = lens;
            context.shadowBlur = 8 + strength * 16;
            context.shadowColor = `hsla(${current.hue + 14}, 96%, 70%, ${alpha * 0.62})`;
            context.fill();
            context.shadowBlur = 0;
            for (let petal = 0; petal < 4; petal += 1) {
              context.beginPath();
              context.ellipse(
                to.x,
                to.y,
                8 + halfWidth * (0.78 + petal * 0.13),
                3 + halfWidth * (0.18 + petal * 0.07),
                petal * Math.PI / 4 + current.pan * 0.18,
                0,
                Math.PI * 2,
              );
              context.strokeStyle = `hsla(${current.hue + 20}, 86%, 88%, ${alpha * (0.44 - petal * 0.07)})`;
              context.lineWidth = 0.55;
              context.stroke();
            }
          }
        } else if (current.mode === "strings") {
          // Pluck score: a warm Möbius-like ribbon whose two edges exchange sides.
          const flow = Math.sin(current.at * 0.006 + index * 0.12)
            * (1.2 + current.vibrato * 4.2);
          const centerY = (from.y + to.y) / 2 + flow + current.pan * 1.4;
          const twistFrom = Math.sin(previous.at * 0.0028);
          const twistTo = Math.sin(current.at * 0.0028);
          const twistMid = (twistFrom + twistTo) / 2;
          const facingFront = twistMid >= 0;
          const surface = context.createLinearGradient(from.x, from.y, to.x, to.y);
          if (facingFront) {
            surface.addColorStop(0, `hsla(18, 76%, 38%, ${alpha * 0.34})`);
            surface.addColorStop(0.48, `hsla(34, 92%, ${58 + current.filter * 13}%, ${alpha * 0.62 * timeGrain})`);
            surface.addColorStop(1, `hsla(47, 90%, 78%, ${alpha * 0.46})`);
          } else {
            surface.addColorStop(0, `hsla(344, 56%, 28%, ${alpha * 0.25})`);
            surface.addColorStop(0.52, `hsla(8, 76%, ${42 + current.filter * 12}%, ${alpha * 0.5 * timeGrain})`);
            surface.addColorStop(1, `hsla(24, 82%, 61%, ${alpha * 0.34})`);
          }
          context.beginPath();
          context.moveTo(from.x, from.y - halfWidth * twistFrom);
          context.quadraticCurveTo(
            (from.x + to.x) / 2,
            centerY - halfWidth * twistMid,
            to.x,
            to.y - halfWidth * twistTo,
          );
          context.lineTo(to.x, to.y + halfWidth * twistTo);
          context.quadraticCurveTo(
            (from.x + to.x) / 2,
            centerY + halfWidth * twistMid,
            from.x,
            from.y + halfWidth * twistFrom,
          );
          context.closePath();
          context.fillStyle = surface;
          context.shadowBlur = facingFront ? 5 + strength * 7 : 2;
          context.shadowColor = facingFront
            ? `hsla(35, 94%, 66%, ${alpha * 0.34})`
            : `hsla(348, 72%, 48%, ${alpha * 0.2})`;
          context.fill();
          context.shadowBlur = 0;

          for (const edge of [-1, 1]) {
            const edgeHue = edge === 1 ? 42 : 350;
            context.beginPath();
            context.moveTo(from.x, from.y + edge * halfWidth * twistFrom);
            context.quadraticCurveTo(
              (from.x + to.x) / 2,
              centerY + edge * halfWidth * twistMid,
              to.x,
              to.y + edge * halfWidth * twistTo,
            );
            context.strokeStyle = `hsla(${edgeHue}, ${edge === 1 ? 92 : 72}%, ${edge === 1 ? 82 : 66}%, ${alpha * (facingFront ? 0.66 : 0.42)})`;
            context.lineWidth = 0.85 + strength * 0.75;
            context.stroke();
          }

          const sheenOffset = twistMid * halfWidth * 0.34;
          const sheen = context.createLinearGradient(from.x, from.y, to.x, to.y);
          sheen.addColorStop(0, `hsla(20, 72%, 58%, ${alpha * 0.12})`);
          sheen.addColorStop(0.55, `hsla(45, 100%, 91%, ${alpha * (facingFront ? 0.58 : 0.24)})`);
          sheen.addColorStop(1, `hsla(350, 76%, 76%, ${alpha * 0.2})`);
          context.beginPath();
          context.moveTo(from.x, from.y + twistFrom * halfWidth * 0.34);
          context.quadraticCurveTo(
            (from.x + to.x) / 2,
            centerY + sheenOffset,
            to.x,
            to.y + twistTo * halfWidth * 0.34,
          );
          context.strokeStyle = sheen;
          context.lineWidth = 0.65 + strength * 0.65;
          context.stroke();

          if (current.accent) {
            const knotRadius = 9 + strength * 7;
            const knot = context.createRadialGradient(to.x, to.y, 0, to.x, to.y, knotRadius);
            knot.addColorStop(0, `hsla(46, 100%, 94%, ${alpha * 0.92})`);
            knot.addColorStop(0.34, `hsla(27, 94%, 65%, ${alpha * 0.56})`);
            knot.addColorStop(0.72, `hsla(350, 72%, 48%, ${alpha * 0.22})`);
            knot.addColorStop(1, "hsla(340, 62%, 32%, 0)");
            context.beginPath();
            context.ellipse(
              to.x,
              to.y,
              knotRadius,
              3.8 + halfWidth * 0.34,
              twistTo * 0.5 + current.pan * 0.12,
              0,
              Math.PI * 2,
            );
            context.fillStyle = knot;
            context.fill();
          }
        } else if (current.mode === "drum") {
          // Drum score: a smoked membrane strip carrying discrete pressure fossils.
          const membrane = context.createLinearGradient(from.x, from.y - halfWidth, to.x, to.y + halfWidth);
          membrane.addColorStop(0, `hsla(${previous.hue - 4}, 74%, 31%, ${alpha * 0.13})`);
          membrane.addColorStop(0.5, `hsla(${current.hue + 8}, 82%, 52%, ${alpha * 0.29 * timeGrain})`);
          membrane.addColorStop(1, `hsla(${current.hue + 18}, 76%, 72%, ${alpha * 0.12})`);
          context.beginPath();
          context.moveTo(from.x, from.y - halfWidth);
          context.quadraticCurveTo((from.x + to.x) / 2, (from.y + to.y) / 2 - halfWidth * 0.82, to.x, to.y - halfWidth);
          context.lineTo(to.x, to.y + halfWidth);
          context.quadraticCurveTo((from.x + to.x) / 2, (from.y + to.y) / 2 + halfWidth * 0.82, from.x, from.y + halfWidth);
          context.closePath();
          context.fillStyle = membrane;
          context.fill();

          if (current.accent) {
            const pressureGlow = context.createRadialGradient(to.x, to.y, 0, to.x, to.y, halfWidth * 1.85);
            pressureGlow.addColorStop(0, `hsla(${current.hue + 22}, 94%, 86%, ${alpha * 0.54})`);
            pressureGlow.addColorStop(0.25, `hsla(${current.hue + 8}, 88%, 56%, ${alpha * 0.28})`);
            pressureGlow.addColorStop(1, `hsla(${current.hue - 8}, 70%, 24%, 0)`);
            context.beginPath();
            context.ellipse(to.x, to.y, 7 + halfWidth * 0.72, halfWidth * 1.08, 0, 0, Math.PI * 2);
            context.fillStyle = pressureGlow;
            context.fill();
            for (let ring = 0; ring < 3; ring += 1) {
              context.beginPath();
              context.ellipse(
                to.x,
                to.y,
                5 + ring * 4 + strength * 2.5,
                halfWidth * (0.52 + ring * 0.24),
                (ring - 1) * 0.07,
                0,
                Math.PI * 2,
              );
              context.strokeStyle = `hsla(${current.hue + 22 - ring * 3}, 90%, ${82 - ring * 8}%, ${alpha * (0.68 - ring * 0.11)})`;
              context.lineWidth = 0.75 + current.impulse * 1.1;
              context.shadowBlur = ring === 0 ? 6 + current.impulse * 12 : 0;
              context.shadowColor = `hsla(${current.hue + 14}, 96%, 62%, ${alpha * 0.48})`;
              context.stroke();
            }
            for (let fracture = 0; fracture < 4; fracture += 1) {
              const angle = fracture * 1.27 + current.at * 0.002;
              const startRadius = halfWidth * 0.28;
              const endRadius = halfWidth * (0.5 + fracture * 0.07);
              context.beginPath();
              context.moveTo(to.x + Math.cos(angle) * startRadius, to.y + Math.sin(angle) * startRadius);
              context.lineTo(to.x + Math.cos(angle + 0.12) * endRadius, to.y + Math.sin(angle + 0.12) * endRadius);
              context.strokeStyle = `hsla(${current.hue + 26}, 84%, 84%, ${alpha * 0.42})`;
              context.lineWidth = 0.55;
              context.stroke();
            }
            context.shadowBlur = 0;
          }
        }
        }
      }
      context.restore();
    };

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const current = frameRef.current;
      const currentMode = modeRef.current;
      const previous = pointRef.current;
      if (drawnModeRef.current !== currentMode) {
        context.fillStyle = "#090705";
        context.fillRect(0, 0, rect.width, rect.height);
        drawnModeRef.current = currentMode;
      }
      const pan = clamp(current.gamma / 45, -1, 1);
      const filter = clamp((current.beta + 30) / 120, 0, 1);
      const targetX = rect.width / 2 + pan * rect.width * 0.34;
      const targetY = rect.height / 2 + clamp((current.beta - 45) / 70, -1, 1) * rect.height * 0.31;
      const x = previous.x + (targetX - previous.x) * 0.16 + current.ax * 0.45;
      const y = previous.y + (targetY - previous.y) * 0.16 + current.ay * 0.45;

      context.fillStyle = "#090705";
      context.fillRect(0, 0, rect.width, rect.height);

      const energy = clamp(current.magnitude / 14, 0, 1);
      const modeHue = currentMode === "midi" ? 36 : currentMode === "drum" ? 17 : currentMode === "strings" ? 25 : 32;
      const baseHue = currentMode === "tonal" ? modeHue + noteIndexRef.current * 1.2 : modeHue;
      const hue = baseHue + clamp(current.rz / 220, -1, 1) * 5 - 9 + filter * 24;
      const modulation = modulationRef.current;
      const shakeTarget = current.magnitude >= 8.5
        ? 0
        : clamp((current.magnitude - 0.55) / 6.5, 0, 1);
      modulation.shake += (shakeTarget - modulation.shake) * 0.16;
      modulation.phase += 0.05 + modulation.shake * 0.34;
      modulation.echo = Math.max(modulation.echo * 0.92, pulseRef.current);
      modulation.impact = Math.max(modulation.impact * 0.88, current.magnitude >= 8.5 ? energy : 0);
      if (noteIndexRef.current >= 0) struckNoteRef.current = noteIndexRef.current % 8;

      const performanceOnly = canvas.parentElement?.classList.contains("performance-only") ?? false;
      const now = performance.now();
      if (now - lastRibbonSampleAtRef.current >= 34) {
        const accent = pulseRef.current > 0.08 && now - lastRibbonAccentAtRef.current >= 175;
        if (currentMode === "drum" && accent) {
          let nextDrumPitch = 0.25 + Math.random() * 6.5;
          if (Math.abs(nextDrumPitch - drumWaterfallPitchRef.current) < 1.25) {
            nextDrumPitch = (nextDrumPitch + 3.15) % 7;
          }
          drumWaterfallPitchRef.current = nextDrumPitch;
        }
        const targetPitch = currentMode === "drum"
          ? drumWaterfallPitchRef.current
          : noteIndexRef.current >= 0 ? noteIndexRef.current % 8 : struckNoteRef.current;
        const previousRibbonSample = timeRibbonRef.current.at(-1);
        const ribbonPitch = currentMode === "drum" || currentMode === "tonal" || currentMode === "midi"
          ? targetPitch
          : previousRibbonSample
          ? previousRibbonSample.pitch + (targetPitch - previousRibbonSample.pitch) * 0.22
          : targetPitch;
        const sharedSample = {
          at: now,
          energy,
          pan,
          filter,
          vibrato: modulation.shake,
          impulse: modulation.impact,
          echo: modulation.echo,
          mode: currentMode,
        };
        if (currentMode === "tonal") {
          const activePitches = new Set(activeNoteIndicesRef.current);
          for (let pitch = 0; pitch < NOTE_DEFINITIONS.length; pitch += 1) {
            const active = activePitches.has(pitch);
            timeRibbonRef.current.push({
              ...sharedSample,
              voice: pitch,
              pitch,
              accent: accent && active,
              active,
              hue: hue + (pitch - Math.max(0, noteIndexRef.current)) * 1.2,
            });
          }
        } else {
          timeRibbonRef.current.push({
            ...sharedSample,
            voice: 0,
            pitch: ribbonPitch,
            accent,
            active: currentMode === "drum"
              ? modulation.impact > 0.025 || pulseRef.current > 0.04
              : currentMode === "strings"
              ? noteActiveRef.current || modulation.echo > 0.012 || pulseRef.current > 0.04
              : noteActiveRef.current || pulseRef.current > 0.04,
            hue,
          });
        }
        if (accent) lastRibbonAccentAtRef.current = now;
        lastRibbonSampleAtRef.current = now;
      }
      const coreX = rect.width / 2;
      const coreY = rect.height / 2;
      const coreWidth = Math.min(rect.width * (performanceOnly ? 0.68 : 0.58), performanceOnly ? 860 : 720);
      const coreHeight = Math.min(rect.height * (performanceOnly ? 0.46 : 0.34), performanceOnly ? 340 : 260);
      const vibrato = Math.sin(modulation.phase) * modulation.shake;
      const sculptureImage = sculptureImages[currentMode];
      const sculptureReady = Boolean(sculptureImage?.complete && sculptureImage.naturalWidth);

      if (sculptureReady && sculptureImage) {
        context.save();
        context.translate(rect.width / 2, rect.height / 2);
        context.globalAlpha = performanceOnly ? 0.62 : 0.42;
        context.globalCompositeOperation = "screen";
        context.filter = `brightness(${0.68 + filter * 0.38}) saturate(${0.82 + filter * 0.34}) contrast(1.06)`;
        context.drawImage(sculptureImage, -rect.width / 2, -rect.height / 2, rect.width, rect.height);

        if (currentMode === "tonal" && modulation.echo > 0.018) {
          const strike = modulation.echo;
          const toneIndex = struckNoteRef.current;
          const zone = GLASS_HANDPAN_HIT_ZONES[toneIndex];
          const toneWidth = (30 + strike * 34) * zone.scale;
          const toneHeight = (17 + strike * 19) * zone.scale;
          const toneHue = 25 + toneIndex * 1.25;
          const strikeLight = context.createRadialGradient(
            -toneWidth * 0.18,
            -toneHeight * 0.24,
            1,
            0,
            0,
            toneWidth,
          );
          strikeLight.addColorStop(0, `hsla(${toneHue + 16}, 92%, 90%, ${0.82 * strike})`);
          strikeLight.addColorStop(0.36, `hsla(${toneHue + 7}, 94%, 63%, ${0.64 * strike})`);
          strikeLight.addColorStop(1, `hsla(${toneHue - 4}, 84%, 28%, 0)`);

          context.save();
          context.filter = "none";
          context.globalAlpha = performanceOnly ? 1 : 0.82;
          context.translate(zone.x * rect.width, zone.y * rect.height);
          context.rotate(zone.rotation);
          context.scale(1 + strike * 0.08, 1 - strike * 0.12);
          context.beginPath();
          context.moveTo(0, -toneHeight);
          context.bezierCurveTo(toneWidth * 0.72, -toneHeight * 0.74, toneWidth, toneHeight * 0.08, 0, toneHeight);
          context.bezierCurveTo(-toneWidth, toneHeight * 0.08, -toneWidth * 0.72, -toneHeight * 0.74, 0, -toneHeight);
          context.closePath();
          context.fillStyle = strikeLight;
          context.shadowBlur = 12 + strike * 26;
          context.shadowColor = `hsla(${toneHue + 9}, 96%, 62%, ${0.68 * strike})`;
          context.fill();
          context.shadowBlur = 0;

          for (let streak = -1; streak <= 1; streak += 1) {
            context.beginPath();
            context.moveTo(streak * 4, -toneHeight * 0.12);
            context.bezierCurveTo(
              streak * 7,
              -toneHeight * 0.52,
              streak * 10,
              -toneHeight * (0.86 + strike * 0.36),
              streak * 12,
              -toneHeight * (0.98 + strike * 0.46),
            );
            context.strokeStyle = `hsla(${toneHue + 18}, 92%, 84%, ${(0.1 + strike * 0.32) * (1 - Math.abs(streak) * 0.18)})`;
            context.lineWidth = streak === 0 ? 1.05 : 0.65;
            context.stroke();
          }
          context.restore();
        }

        context.restore();
      }

      // FILTER / EQ: warm illumination travels through the material instead of drawing a meter.
      const lightX = coreX - coreWidth * 0.22 + pan * coreWidth * 0.25;
      const lightField = context.createRadialGradient(
        lightX,
        coreY,
        0,
        coreX,
        coreY,
        coreWidth * (0.28 + filter * 0.42),
      );
      lightField.addColorStop(0, `hsla(${hue + 8}, 94%, ${58 + filter * 18}%, ${0.12 + filter * 0.16})`);
      lightField.addColorStop(0.48, `hsla(${hue}, 76%, 36%, ${0.05 + filter * 0.08})`);
      lightField.addColorStop(1, "rgba(8, 5, 3, 0)");
      context.fillStyle = lightField;
      context.fillRect(0, 0, rect.width, rect.height);

      // PAN: transfer light energy between the two sides; the sculpture itself stays fixed.
      const panStrength = Math.abs(pan);
      if (panStrength > 0.025) {
        context.save();
        const stereoShade = context.createLinearGradient(0, 0, rect.width, 0);
        if (pan < 0) {
          stereoShade.addColorStop(0, `hsla(38, 88%, 65%, ${0.08 + panStrength * 0.25})`);
          stereoShade.addColorStop(0.38, "rgba(20, 10, 4, 0)");
          stereoShade.addColorStop(1, `rgba(3, 2, 1, ${panStrength * 0.24})`);
        } else {
          stereoShade.addColorStop(0, `rgba(3, 2, 1, ${panStrength * 0.24})`);
          stereoShade.addColorStop(0.62, "rgba(20, 10, 4, 0)");
          stereoShade.addColorStop(1, `hsla(38, 88%, 65%, ${0.08 + panStrength * 0.25})`);
        }
        context.fillStyle = stereoShade;
        context.fillRect(0, 0, rect.width, rect.height);

        const edgeX = pan < 0 ? rect.width * 0.08 : rect.width * 0.92;
        const edgeGlow = context.createRadialGradient(edgeX, coreY, 0, edgeX, coreY, rect.width * 0.34);
        edgeGlow.addColorStop(0, `hsla(40, 92%, 76%, ${panStrength * 0.22})`);
        edgeGlow.addColorStop(0.45, `hsla(27, 84%, 47%, ${panStrength * 0.1})`);
        edgeGlow.addColorStop(1, "rgba(12, 6, 2, 0)");
        context.globalCompositeOperation = "screen";
        context.fillStyle = edgeGlow;
        context.fillRect(0, 0, rect.width, rect.height);
        context.restore();
      }

      // EQ: low tilt creates a broad amber body; high tilt resolves into sharp caustic filaments.
      const lowBand = clamp((0.52 - filter) / 0.52, 0, 1);
      const highBand = clamp((filter - 0.48) / 0.52, 0, 1);
      if (lowBand > 0.015) {
        const lowBody = context.createRadialGradient(
          coreX,
          coreY + coreHeight * 0.22,
          coreWidth * 0.04,
          coreX,
          coreY + coreHeight * 0.2,
          coreWidth * 0.62,
        );
        lowBody.addColorStop(0, `hsla(18, 88%, 46%, ${0.12 + lowBand * 0.23})`);
        lowBody.addColorStop(0.5, `hsla(12, 76%, 29%, ${lowBand * 0.15})`);
        lowBody.addColorStop(1, "rgba(24, 8, 2, 0)");
        context.fillStyle = lowBody;
        context.fillRect(0, 0, rect.width, rect.height);
      }
      if (highBand > 0.015) {
        const highSheen = context.createRadialGradient(
          coreX,
          coreY - coreHeight * 0.3,
          coreWidth * 0.03,
          coreX,
          coreY - coreHeight * 0.12,
          coreWidth * 0.58,
        );
        highSheen.addColorStop(0, `hsla(44, 72%, 91%, ${highBand * 0.28})`);
        highSheen.addColorStop(0.42, `hsla(38, 76%, 67%, ${highBand * 0.12})`);
        highSheen.addColorStop(1, "rgba(255, 206, 137, 0)");
        context.save();
        context.globalCompositeOperation = "screen";
        context.fillStyle = highSheen;
        context.fillRect(0, 0, rect.width, rect.height);
        context.restore();

        if (currentMode !== "tonal" && currentMode !== "drum") {
          context.save();
          context.globalCompositeOperation = "screen";
          context.lineCap = "round";
          for (let band = 0; band < 6; band += 1) {
            const lane = (band - 2.5) * coreHeight * 0.105;
            const arc = (band % 2 === 0 ? 1 : -1) * coreHeight * (0.045 + highBand * 0.035);
            context.beginPath();
            context.moveTo(coreX - coreWidth * 0.46, coreY + lane);
            context.bezierCurveTo(
              coreX - coreWidth * 0.18,
              coreY + lane + arc,
              coreX + coreWidth * 0.19,
              coreY + lane - arc,
              coreX + coreWidth * 0.46,
              coreY + lane,
            );
            context.strokeStyle = `hsla(${42 + band * 0.8}, 78%, 88%, ${highBand * (0.09 + band * 0.013)})`;
            context.lineWidth = 0.45 + highBand * 0.85;
            context.shadowBlur = 4 + highBand * 9;
            context.shadowColor = `hsla(36, 90%, 72%, ${highBand * 0.24})`;
            context.stroke();
          }
          context.restore();
        }
      }

      // The score is projected over the fixed sculpture, so it reads as performance history.
      drawTimeRibbon(rect, now, performanceOnly);

      context.save();
      context.translate(coreX, coreY);
      context.globalAlpha = sculptureReady ? (performanceOnly ? 0.36 : 0.28) : 1;

      if (currentMode === "tonal" && sculptureReady) {
        // The approved image and its image-space strike zones are rendered above.
      } else if (currentMode === "tonal") {
        // INERTIA GLASS — a single blown-glass resonant body with a luminous chamber.
        for (let layer = 6; layer >= 0; layer -= 1) {
          const depth = layer / 6;
          const width = coreWidth * (0.76 + depth * 0.04);
          const height = coreHeight * (0.43 + depth * 0.07 + filter * 0.035);
          const offset = (layer - 3) * 3.2 + vibrato * layer * 1.5;
          const glass = context.createLinearGradient(-width / 2, -height, width / 2, height);
          glass.addColorStop(0, `hsla(${hue + 8}, 78%, 76%, ${0.055 + (1 - depth) * 0.055})`);
          glass.addColorStop(0.32 + pan * 0.08, `hsla(${hue + 2}, 92%, ${48 + filter * 18}%, ${0.11 + filter * 0.055})`);
          glass.addColorStop(0.68, `hsla(${hue - 7}, 82%, 39%, ${0.08 + depth * 0.04})`);
          glass.addColorStop(1, `hsla(${hue + 12}, 88%, 74%, 0.035)`);
          context.beginPath();
          context.moveTo(-width * 0.5, offset - height * 0.02);
          context.bezierCurveTo(-width * 0.51, -height * 0.52, -width * 0.39, -height * 0.72, -width * 0.25, -height * 0.24);
          context.bezierCurveTo(-width * 0.17, -height * 0.67, width * 0.02, -height * 0.84, width * 0.18, -height * 0.46);
          context.bezierCurveTo(width * 0.3, -height * 0.54, width * 0.43, -height * 0.2, width * 0.5, -height * 0.04 + offset * 0.2);
          context.bezierCurveTo(width * 0.43, height * 0.14, width * 0.31, height * 0.28, width * 0.2, height * 0.27);
          context.bezierCurveTo(width * 0.08, height * 0.78, -width * 0.12, height * 0.7, -width * 0.21, height * 0.31);
          context.bezierCurveTo(-width * 0.33, height * 0.72, -width * 0.49, height * 0.44, -width * 0.5, offset - height * 0.02);
          context.closePath();
          context.fillStyle = glass;
          context.fill();
        }

        const chamberWidth = coreWidth * (0.13 + filter * 0.02);
        const chamberHeight = coreHeight * (0.29 + filter * 0.035 + Math.abs(vibrato) * 0.018);
        const chamber = context.createRadialGradient(
          -chamberWidth * 0.18 + pan * 9,
          -chamberHeight * 0.24,
          2,
          0,
          0,
          chamberWidth,
        );
        chamber.addColorStop(0, `hsla(${hue + 18}, 96%, ${76 + filter * 10}%, .72)`);
        chamber.addColorStop(0.26, `hsla(${hue + 7}, 94%, ${48 + filter * 13}%, .46)`);
        chamber.addColorStop(0.74, `hsla(${hue - 5}, 86%, 30%, .23)`);
        chamber.addColorStop(1, `hsla(${hue + 12}, 90%, 70%, .08)`);
        context.beginPath();
        context.ellipse(coreWidth * 0.035, vibrato * 2.5, chamberWidth, chamberHeight, pan * 0.04, 0, Math.PI * 2);
        context.fillStyle = chamber;
        context.shadowBlur = 12 + filter * 24;
        context.shadowColor = `hsla(${hue + 10}, 96%, 62%, ${0.25 + filter * 0.25})`;
        context.fill();
        context.shadowBlur = 0;

        // Curved caustics read as refraction, never as strings.
        for (let caustic = -1; caustic <= 1; caustic += 1) {
          context.beginPath();
          context.moveTo(-coreWidth * 0.34, caustic * coreHeight * 0.075);
          context.bezierCurveTo(
            -coreWidth * 0.2,
            caustic * coreHeight * 0.16 + vibrato * 4,
            -chamberWidth * 0.9,
            caustic * coreHeight * 0.04,
            -chamberWidth * 0.72,
            caustic * coreHeight * 0.025,
          );
          context.strokeStyle = `hsla(${hue + 17}, 92%, 80%, ${0.035 + filter * 0.085})`;
          context.lineWidth = 0.7 + (caustic === 0 ? 0.35 : 0);
          context.stroke();
        }

        for (let shard = 0; shard < 7; shard += 1) {
          const drift = modulation.echo * (18 + shard * 7);
          const shardX = coreWidth * (0.35 + shard * 0.027) + drift;
          const shardY = Math.sin(shard * 2.1 + modulation.phase * 0.25) * coreHeight * (0.08 + modulation.echo * 0.12);
          context.save();
          context.translate(shardX, shardY);
          context.rotate(shard * 0.36 + vibrato * 0.16);
          context.fillStyle = `hsla(${hue + shard * 2}, 84%, 66%, ${0.04 + modulation.echo * 0.2})`;
          context.fillRect(-5, -1.5, 10 + shard * 1.8, 3);
          context.restore();
        }
      } else if (currentMode === "strings") {
        // INERTIA PLUCK — carved wooden resonator and individually vibrating brass strings.
        for (let rib = 0; rib < 7; rib += 1) {
          const ribY = (rib - 3) * coreHeight * 0.048;
          const bow = (rib % 2 === 0 ? 1 : -1) * coreHeight * (0.12 + rib * 0.008);
          const wood = context.createLinearGradient(-coreWidth * 0.46, ribY, coreWidth * 0.46, ribY + bow);
          wood.addColorStop(0, `hsla(${hue + 5}, 58%, ${24 + filter * 11}%, 0.34)`);
          wood.addColorStop(0.46, `hsla(${hue - 6}, 66%, ${17 + filter * 13}%, 0.64)`);
          wood.addColorStop(1, `hsla(${hue + 11}, 72%, ${35 + filter * 8}%, 0.28)`);
          context.beginPath();
          context.moveTo(-coreWidth * 0.49, ribY);
          context.bezierCurveTo(-coreWidth * 0.26, ribY + bow, coreWidth * 0.15, ribY - bow * 0.8, coreWidth * 0.48, ribY + bow * 0.16);
          context.bezierCurveTo(coreWidth * 0.18, ribY - bow * 0.45 + 7, -coreWidth * 0.25, ribY + bow * 0.65 + 7, -coreWidth * 0.49, ribY + 5);
          context.closePath();
          context.fillStyle = wood;
          context.fill();
          context.strokeStyle = `hsla(${hue + 13}, 72%, 61%, ${0.12 + filter * 0.11})`;
          context.stroke();
        }

        for (let stringIndex = 0; stringIndex < 4; stringIndex += 1) {
          const stringY = (stringIndex - 1.5) * 13;
          const amplitude = modulation.shake * (10 + stringIndex * 2.2) + modulation.echo * 7;
          context.beginPath();
          for (let segment = 0; segment <= 36; segment += 1) {
            const t = segment / 36;
            const stringX = -coreWidth * 0.47 + t * coreWidth * 0.94;
            const wave = Math.sin(t * Math.PI * 5 + modulation.phase + stringIndex) * amplitude * Math.sin(t * Math.PI);
            if (segment === 0) context.moveTo(stringX, stringY);
            else context.lineTo(stringX, stringY + wave);
          }
          context.strokeStyle = `hsla(${hue + 18}, 82%, ${60 + filter * 16}%, ${0.34 + filter * 0.35})`;
          context.lineWidth = 0.65 + stringIndex * 0.13;
          context.shadowBlur = 3 + modulation.shake * 8;
          context.shadowColor = `hsla(${hue + 15}, 90%, 68%, .35)`;
          context.stroke();
        }
        context.shadowBlur = 0;

        for (const bridgeX of [-0.31, 0.12, 0.38]) {
          context.fillStyle = `hsla(${hue + 22}, 48%, ${61 + filter * 10}%, .54)`;
          context.fillRect(coreWidth * bridgeX - 2, -31, 4, 62);
        }
      } else if (currentMode === "drum") {
        // IMPACT DRUM — modern composite membrane, smoked-copper rim and precise tension lugs.
        const radiusY = Math.min(coreWidth * 0.2, coreHeight * 0.53);
        const radiusX = radiusY * 1.46;
        const compression = 1 - modulation.impact * 0.075;

        if (modulation.impact > 0.025) {
          context.beginPath();
          context.ellipse(0, 0, radiusX * (1.08 + modulation.impact * 0.28), radiusY * (1.08 + modulation.impact * 0.2), 0, 0, Math.PI * 2);
          context.strokeStyle = `hsla(${hue + 17}, 82%, 58%, ${modulation.impact * 0.18})`;
          context.lineWidth = 1.2 + modulation.impact * 2.5;
          context.stroke();
        }

        if (!sculptureReady) {
          const shell = context.createLinearGradient(-radiusX, -radiusY, radiusX, radiusY);
          shell.addColorStop(0, `hsla(${hue + 8}, 48%, 26%, .92)`);
          shell.addColorStop(0.48, `hsla(${hue - 3}, 44%, 10%, .96)`);
          shell.addColorStop(1, `hsla(${hue + 13}, 58%, 32%, .88)`);
          context.beginPath();
          context.ellipse(0, radiusY * 0.08, radiusX * 1.06, radiusY * 1.08, 0, 0, Math.PI * 2);
          context.fillStyle = shell;
          context.fill();

          const membrane = context.createRadialGradient(
            -radiusX * pan * 0.24,
            -radiusY * 0.24,
            radiusY * 0.04,
            0,
            radiusY * modulation.impact * 0.035,
            radiusX,
          );
          membrane.addColorStop(0, `hsla(${hue + 17}, 82%, ${65 + filter * 13}%, .92)`);
          membrane.addColorStop(0.38, `hsla(${hue + 6}, 75%, ${43 + filter * 11}%, .9)`);
          membrane.addColorStop(0.76, `hsla(${hue - 2}, 68%, 27%, .94)`);
          membrane.addColorStop(1, `hsla(${hue - 8}, 56%, 13%, .98)`);
          context.beginPath();
          context.ellipse(0, 0, radiusX * 0.94, radiusY * 0.94 * compression, 0, 0, Math.PI * 2);
          context.fillStyle = membrane;
          context.shadowBlur = 18 + filter * 22 + modulation.impact * 28;
          context.shadowColor = `hsla(${hue + 9}, 84%, 48%, .34)`;
          context.fill();
          context.shadowBlur = 0;

          context.lineWidth = 7.5;
          context.strokeStyle = `hsla(${hue + 10}, 54%, ${36 + filter * 15}%, .88)`;
          context.beginPath();
          context.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2);
          context.stroke();

          for (let lug = 0; lug < 16; lug += 1) {
            const angle = lug * (Math.PI * 2 / 16);
            const lugX = Math.cos(angle) * radiusX * 1.015;
            const lugY = Math.sin(angle) * radiusY * 1.015;
            context.save();
            context.translate(lugX, lugY);
            context.rotate(angle + Math.PI / 2);
            context.fillStyle = `hsla(${hue + 16}, 46%, ${39 + filter * 14}%, .92)`;
            context.fillRect(-5.5, -3, 11, 6);
            context.fillStyle = "rgba(10, 7, 5, .72)";
            context.fillRect(-1.2, -4.5, 2.4, 9);
            context.restore();
          }
        }

        const strike = context.createRadialGradient(0, 0, 0, 0, 0, radiusY * 0.42);
        strike.addColorStop(0, `hsla(${hue - 8}, 48%, 8%, ${0.25 + modulation.impact * 0.42})`);
        strike.addColorStop(1, "rgba(16, 8, 4, 0)");
        context.fillStyle = strike;
        context.fillRect(-radiusY * 0.45, -radiusY * 0.45, radiusY * 0.9, radiusY * 0.9);

        for (let crack = 0; crack < 6; crack += 1) {
          const angle = crack * (Math.PI * 2 / 6) + 0.35;
          const length = radiusY * (0.12 + modulation.impact * (0.28 + (crack % 2) * 0.12));
          context.beginPath();
          context.moveTo(Math.cos(angle) * radiusY * 0.06, Math.sin(angle) * radiusY * 0.06);
          context.lineTo(Math.cos(angle + 0.08) * length * 0.58, Math.sin(angle + 0.08) * length * 0.58);
          context.lineTo(Math.cos(angle - 0.045) * length, Math.sin(angle - 0.045) * length);
          context.strokeStyle = `hsla(${hue + 25}, 88%, 76%, ${0.035 + modulation.impact * 0.42})`;
          context.lineWidth = 0.7;
          context.stroke();
        }
      } else {
        // MOTION MIDI — a restrained control lattice, not a fourth fantasy instrument.
        const latticeWidth = coreWidth * 0.72;
        const latticeHeight = coreHeight * 0.5;
        context.fillStyle = "rgba(18, 13, 8, .54)";
        context.fillRect(-latticeWidth / 2, -latticeHeight / 2, latticeWidth, latticeHeight);
        for (let index = 0; index < 12; index += 1) {
          const unitX = -latticeWidth / 2 + (index + 0.5) * (latticeWidth / 12);
          const level = 0.16 + ((index + noteIndexRef.current) % 5) * 0.1 + energy * 0.24;
          context.fillStyle = `hsla(${hue + index * 0.7}, 68%, ${52 + filter * 18}%, ${0.13 + level * 0.36})`;
          context.fillRect(unitX - 2, latticeHeight / 2 - latticeHeight * level, 4, latticeHeight * level);
        }
        context.strokeStyle = `hsla(${hue + 8}, 65%, 68%, .24)`;
        context.lineWidth = 0.6;
        context.strokeRect(-latticeWidth / 2, -latticeHeight / 2, latticeWidth, latticeHeight);
      }

      context.restore();

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
  const [midiStatus, setMidiStatus] = useState<MidiStatus>("idle");
  const [midiPorts, setMidiPorts] = useState<MidiPortInfo[]>([]);
  const [selectedMidiPort, setSelectedMidiPort] = useState("");
  const [midiMappings, setMidiMappings] = useState<MidiGestureMappings>(loadStoredMidiMappings);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [performanceMode, setPerformanceMode] = useState(false);
  const [activeNotes, setActiveNotes] = useState<number[]>([]);
  const [stringVisualMidi, setStringVisualMidi] = useState<number | null>(null);
  const [stringActive, setStringActive] = useState(false);
  const [currentNoteName, setCurrentNoteName] = useState("—");
  const [gestureLabel, setGestureLabel] = useState("IDLE");
  const [isRecording, setIsRecording] = useState(false);
  const [isReplaying, setIsReplaying] = useState(false);
  const [recordedCount, setRecordedCount] = useState(0);
  const [audioRecording, setAudioRecording] = useState<Blob | null>(null);
  const [videoRecording, setVideoRecording] = useState<Blob | null>(null);
  const [message, setMessage] = useState("");

  const peerRef = useRef<PeerInstance | null>(null);
  const connectionRef = useRef<DataConnection | null>(null);
  const audioRef = useRef<AudioRig | null>(null);
  const midiRef = useRef<MotionMidiOutput | null>(null);
  const midiMappingsRef = useRef<MidiGestureMappings>(midiMappings);
  const instrumentModeRef = useRef<InstrumentMode>("tonal");
  const lastDrumRef = useRef(0);
  const activeNotesRef = useRef<number[]>([]);
  const activeStringRef = useRef<{ stringIndex: number; midi: number } | null>(null);
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

  const captureEvent = useCallback((data: SensorFrame | NoteMessage | StringMessage) => {
    if (!recordingRef.current || replayingRef.current) return;
    performanceRef.current.push({ at: performance.now() - recordingStartRef.current, data });
    if (performanceRef.current.length % 12 === 0) setRecordedCount(performanceRef.current.length);
  }, []);

  const statusLabel = useMemo(() => {
    if (connectionState === "connected") return "已连接";
    if (connectionState === "waiting") return "等待控制端";
    if (connectionState === "connecting") return "连接中";
    if (connectionState === "error") return "连接错误";
    return "离线";
  }, [connectionState]);

  useEffect(() => {
    midiMappingsRef.current = midiMappings;
    window.localStorage.setItem("motionscore-midi-mappings-v1", JSON.stringify(midiMappings));
    if (connectionRef.current?.open) {
      connectionRef.current.send({ type: "midi-config", mappings: midiMappings });
    }
  }, [connectionState, midiMappings]);

  useEffect(() => {
    if (!performanceMode) return;
    const exitPerformanceMode = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPerformanceMode(false);
    };
    window.addEventListener("keydown", exitPerformanceMode);
    return () => window.removeEventListener("keydown", exitPerformanceMode);
  }, [performanceMode]);

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
    const isMidiController = instrumentModeRef.current === "midi";
    const webAudioActive = !isMidiController;
    const midiActive = isMidiController && midiRef.current?.ready();

    if (audioRef.current && webAudioActive) {
      updateMotionEffects(audioRef.current, {
        pan,
        brightness,
        shake: instrumentModeRef.current === "tonal" ? shakeRef.current : 0,
      });
    }
    if (midiActive) {
      midiRef.current?.sendGestureExpression(
        { pan, modulation: brightness, expression: shakeRef.current },
        midiMappingsRef.current,
      );
    }

    if (isMidiController) {
      const enabledCount = Object.values(midiMappingsRef.current).filter((mapping) => mapping.enabled).length;
      setGestureLabel(midiActive
        ? `CC ACTIVE · ${enabledCount}`
        : "MIDI OFFLINE");
      return;
    }

    if (instrumentModeRef.current === "strings") {
      if (activeStringRef.current) {
        setGestureLabel("PLUCK / GLIDE");
      }
      return;
    }

    if (instrumentModeRef.current === "drum") {
      if (next.magnitude > DRUM_TRIGGER_THRESHOLD && now - lastDrumRef.current > 280) {
        lastDrumRef.current = now;
        if (audioRef.current) triggerPercussionVoice(audioRef.current, "heavy-drum", clamp(next.magnitude / 14, 0.45, 1));
        setGestureLabel("IMPACT");
        setPulse(1);
        if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
        pulseTimerRef.current = setTimeout(() => setPulse(0), 170);
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
          if (webAudioActive) {
            triggerReverbThrow(audioRef.current, strength);
            triggerDelayThrow(audioRef.current, strength);
          }
        }
        if (midiActive) midiRef.current?.triggerEffectThrow(strength);
        setGestureLabel("FX THROW");
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
    if (instrumentModeRef.current !== "tonal" && instrumentModeRef.current !== "midi") return;
    const webAudioActive = instrumentModeRef.current === "tonal";
    const midiActive = instrumentModeRef.current === "midi" && midiRef.current?.ready();
    if (note.action === "allOff") {
      activeNotesRef.current = [];
      setActiveNotes([]);
      setCurrentNoteName("—");
      setGestureLabel("ALL NOTES OFF");
      if (audioRef.current && webAudioActive) allNotesOff(audioRef.current);
      if (midiActive) midiRef.current?.allNotesOff();
      return;
    }
    if (typeof note.midi !== "number") return;
    if (note.action === "on") {
      const next = [...activeNotesRef.current.filter((value) => value !== note.midi), note.midi];
      activeNotesRef.current = next;
      setActiveNotes(next);
      setCurrentNoteName(note.name ?? String(note.midi));
      setGestureLabel("NOTE ON");
      setPulse(0.55);
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = setTimeout(() => setPulse(0), 130);
      if (midiActive) midiRef.current?.noteOn(note.midi, note.velocity ?? 0.58);
      if (webAudioActive && audioRef.current && audioRef.current.samples.size > 0) {
        noteOn(audioRef.current, note.midi, note.velocity ?? 0.58);
      } else if (webAudioActive) {
        setMessage("已收到音符，请先点击“启用声音”加载音色");
      } else if (!midiActive) {
        setMessage("已收到音符，请先启用 MIDI 并选择输出端口");
      }
      return;
    }
    activeNotesRef.current = activeNotesRef.current.filter((value) => value !== note.midi);
    setActiveNotes(activeNotesRef.current);
    if (audioRef.current && webAudioActive) noteOff(audioRef.current, note.midi);
    if (midiActive) midiRef.current?.noteOff(note.midi);
  }, [captureEvent]);

  const processString = useCallback((event: StringMessage) => {
    captureEvent(event);
    if (instrumentModeRef.current !== "strings") return;
    if (event.action === "end") {
      activeStringRef.current = null;
      setStringActive(false);
      setCurrentNoteName("—");
      setGestureLabel("RELEASE / DECAY");
      return;
    }

    const string = STRING_DEFINITIONS[event.stringIndex];
    if (!string) return;
    const changedString = activeStringRef.current?.stringIndex !== event.stringIndex;
    activeStringRef.current = { stringIndex: event.stringIndex, midi: event.midi };
    setStringActive(true);
    setStringVisualMidi(event.midi);
    setCurrentNoteName(pitchName(event.midi));
    setGestureLabel(changedString || event.action === "start" ? `${string.name} · PLUCK` : "GLIDE");
    setPulse(0.28);
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = setTimeout(() => setPulse(0), 90);

    if (!audioRef.current || !audioRef.current.samples.has(`string:${event.stringIndex}`)) {
      setMessage("已收到拨弦手势，请先点击“启用声音”加载音色");
      return;
    }
    if (event.action === "start" || changedString || !audioRef.current.stringVoice) {
      startStringVoice(audioRef.current, event.stringIndex, event.midi, event.expression);
    } else {
      updateStringVoice(audioRef.current, { midi: event.midi, expression: event.expression });
    }
  }, [captureEvent]);

  const updateMidiMapping = useCallback((
    key: MidiGestureKey,
    patch: Partial<MidiGestureMappings[MidiGestureKey]>,
  ) => {
    setMidiMappings((current) => {
      const previous = current[key];
      const nextMapping = { ...previous, ...patch };
      if (
        previous.enabled &&
        (!nextMapping.enabled || previous.controller !== nextMapping.controller)
      ) {
        midiRef.current?.resetGestureMapping(key, previous.controller);
      }
      return { ...current, [key]: nextMapping };
    });
  }, []);

  useEffect(() => {
    if (role !== "stage") return;
    let cancelled = false;

    void import("peerjs").then(({ Peer }) => {
      if (cancelled) return;
      const peer = new Peer(peerId(roomCode), { debug: 1 });
      peerRef.current = peer;

      peer.on("connection", (connection) => {
        connectionRef.current?.close();
        connectionRef.current = connection;
        connection.on("open", () => {
          setConnectionState("connected");
          setMessage("MOTION STREAM / ACTIVE");
          connection.send({ type: "instrument", mode: instrumentModeRef.current });
          connection.send({ type: "midi-config", mappings: midiMappingsRef.current });
        });
        connection.on("data", (data) => {
          if (isSensorFrame(data)) processFrame(data);
          else if (isNoteMessage(data)) processNote(data);
          else if (isStringMessage(data)) processString(data);
          else if (isMidiMappingMessage(data)) {
            updateMidiMapping(data.key, { enabled: data.enabled });
          }
        });
        connection.on("close", () => {
          if (audioRef.current) allNotesOff(audioRef.current);
          midiRef.current?.allNotesOff();
          activeNotesRef.current = [];
          setActiveNotes([]);
          setConnectionState("waiting");
          setMessage("连接已断开，等待重新连接");
        });
        connection.on("error", () => setConnectionState("error"));
      });

      peer.on("error", (error) => {
        if (error.type === "unavailable-id") {
          setConnectionState("waiting");
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
  }, [processFrame, processNote, processString, role, roomCode, updateMidiMapping]);

  useEffect(() => {
    return () => {
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
      replayTimersRef.current.forEach(window.clearTimeout);
      mediaRecordersRef.current.forEach((recorder) => {
        if (recorder.state !== "inactive") recorder.stop();
      });
      mediaStreamsRef.current.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
      midiRef.current?.dispose();
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

  const syncMidiPorts = useCallback(() => {
    const bridge = midiRef.current;
    const ports = bridge?.ports() ?? [];
    setMidiPorts(ports);
    setSelectedMidiPort(bridge?.selectedId() ?? "");
    if (!ports.length && instrumentModeRef.current === "midi") {
      setMessage("MIDI 输出已断开；手机键盘已停止发送");
    }
  }, []);

  const enableMidi = useCallback(async () => {
    if (!MotionMidiOutput.supported()) {
      setMidiStatus("unsupported");
      setMessage("当前电脑浏览器不支持 Web MIDI，请用最新版 Chrome 打开舞台端");
      return;
    }
    setMidiStatus("loading");
    setMessage("正在读取电脑上的 MIDI 输出端口…");
    try {
      const bridge = midiRef.current ?? new MotionMidiOutput();
      midiRef.current = bridge;
      const ports = await bridge.connect(syncMidiPorts);
      setMidiPorts(ports);
      setSelectedMidiPort(bridge.selectedId());
      setMidiStatus("ready");
      setMessage(ports.length
        ? `MIDI 已就绪：${ports.find((port) => port.id === bridge.selectedId())?.name ?? ports[0].name}`
        : "未检测到 MIDI 输出；请先在“音频 MIDI 设置”中启用 IAC Driver");
    } catch {
      setMidiStatus("error");
      setMessage("无法启用 MIDI，请允许浏览器访问 MIDI 设备后重试");
    }
  }, [syncMidiPorts]);

  const selectMidiPort = useCallback(async (id: string) => {
    const bridge = midiRef.current;
    if (!bridge) return;
    const selected = await bridge.select(id);
    setSelectedMidiPort(selected ? id : "");
    const port = bridge.ports().find((value) => value.id === id);
    setMessage(selected ? `MIDI 输出已切换到 ${port?.name ?? "所选端口"}` : "MIDI 输出端口不可用");
  }, []);

  const enableAudio = useCallback(async () => {
    if (!audioRef.current || audioRef.current.context.state === "closed") {
      audioRef.current = createAudioRig();
    }
    await audioRef.current.context.resume();
    if (audioRef.current.samples.size === 0) {
      setBankStatus("loading");
      setMessage("正在加载旋律与打击乐音色库…");
      try {
        await loadBuiltInBank(audioRef.current);
        await loadPercussionBank(audioRef.current);
        await loadStringBank(audioRef.current);
        setBankStatus("ready");
        setSampleName(instrumentModeRef.current === "tonal" ? "Inertia Glass · 24-bit 多采样" : instrumentModeRef.current === "strings" ? "Inertia Pluck · 四弦弹拨滑音" : instrumentModeRef.current === "drum" ? "Impact Drum · 重鼓" : "Motion MIDI Controller · 外部音源");
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
    setSampleName(mode === "tonal" ? "Inertia Glass · 24-bit 多采样" : mode === "strings" ? "Inertia Pluck · 四弦弹拨滑音" : mode === "drum" ? "Impact Drum · 重鼓" : "Motion MIDI Controller · 外部音源");
    setCurrentNoteName(mode === "drum" ? "DRUM" : "—");
    setGestureLabel(mode === "tonal" ? "NOTE INPUT" : mode === "strings" ? "PLUCK INPUT" : mode === "drum" ? "IMPACT INPUT" : "MIDI INPUT");
    if (audioRef.current) allNotesOff(audioRef.current);
    midiRef.current?.allNotesOff();
    activeNotesRef.current = [];
    activeStringRef.current = null;
    setStringVisualMidi(null);
    setStringActive(false);
    setActiveNotes([]);
    if (connectionRef.current?.open) connectionRef.current.send({ type: "instrument", mode });
  }, []);

  const replaceDrumSample = useCallback(async (file: File | undefined) => {
    if (!file) return;
    await enableAudio();
    if (!audioRef.current) return;
    const data = await file.arrayBuffer();
    const buffer = await audioRef.current.context.decodeAudioData(data);
    audioRef.current.samples.set("percussion:heavy-drum", buffer);
    setSoundReady(true);
    setMessage(`重鼓采样已替换为 ${file.name}`);
  }, [enableAudio]);

  const previewNote = useCallback(async (midi: number, name: string) => {
    if (instrumentModeRef.current !== "midi") {
      await enableAudio();
      if (!audioRef.current || audioRef.current.samples.size === 0) return;
    }
    processNote({ type: "note", action: "on", midi, name, velocity: 0.64, t: Date.now() });
    window.setTimeout(() => {
      processNote({ type: "note", action: "off", midi, name, t: Date.now() });
    }, 900);
  }, [enableAudio, processNote]);

  const previewStringStart = useCallback(async () => {
    await enableAudio();
    if (!audioRef.current) return;
    startStringVoice(audioRef.current, 1, 65, 0.72);
    setStringVisualMidi(65);
    setStringActive(true);
    setCurrentNoteName(pitchName(65));
    setGestureLabel("电脑试听 · 准确拨弦 F4");
    setPulse(0.28);
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = setTimeout(() => setPulse(0), 90);
  }, [enableAudio]);

  const previewStringStop = useCallback(() => {
    setStringActive(false);
    setCurrentNoteName("—");
  }, []);

  const previewDrum = useCallback(() => {
    if (!audioRef.current) return;
    triggerPercussionVoice(audioRef.current, "heavy-drum", 0.9);
    setPulse(1);
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = setTimeout(() => setPulse(0), 170);
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
      if (kind === "shake") {
        [55, 110, 180, 350].forEach((delay) => {
          window.setTimeout(() => {
            processFrame({ ...INITIAL_FRAME, magnitude: delay < 180 ? 0.12 : 0.04, t: Date.now() });
          }, delay);
        });
      }
      if (kind === "hit" && audioRef.current && instrumentModeRef.current !== "midi") {
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
        else if (isNoteMessage(event.data)) processNote(event.data);
        else processString(event.data);
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
  }, [enableAudio, isReplaying, processFrame, processNote, processString]);

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

  const visualNoteIndex = instrumentMode === "strings" && stringVisualMidi !== null
    ? clamp(((stringVisualMidi - 55) / 28) * 7, 0, 7)
    : NOTE_DEFINITIONS.findIndex((note) => note.midi === activeNotes.at(-1));
  const activeVisualNoteIndices = instrumentMode === "tonal"
    ? activeNotes
      .map((midi) => NOTE_DEFINITIONS.findIndex((note) => note.midi === midi))
      .filter((index) => index >= 0)
    : [];

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
          <p className="eyebrow">MOTION · SOUND · SCORE</p>
          <h1>
            动作成为声音，
            <br />
            轨迹成为<span>乐谱。</span>
          </h1>
          <p className="hero-copy">
            iPhone 采集姿态与冲量，Mac 完成声音合成、动作映射与实时视觉谱。
          </p>
        </section>

        <section className="role-grid" aria-label="选择设备角色">
          <button className="role-card stage-card" onClick={() => {
            setConnectionState("waiting");
            setMessage("");
            setRole("stage");
          }}>
            <span className="role-index">01</span>
            <span className="role-title">电脑舞台端</span>
            <span className="role-description">音频引擎 · 动作分析 · 实时视觉谱</span>
            <span className="role-action">ENTER STAGE ↗</span>
          </button>
          <a
            className="role-card controller-card"
            href="/phone.html"
          >
            <span className="role-index">02</span>
            <span className="role-title">手机控制端</span>
            <span className="role-description">传感采集 · 音高输入 · 无线控制</span>
            <span className="role-action">OPEN CONTROLLER ↗</span>
          </a>
        </section>

        <footer className="home-footer">
          <span>无线数字乐器与动作视觉乐谱系统</span>
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
    <main className={`stage-shell ${instrumentMode}${performanceMode ? " performance-only" : ""}`}>
      <MotionCanvas
        frame={frame}
        pulse={pulse}
        noteIndex={visualNoteIndex}
        activeNoteIndices={activeVisualNoteIndices}
        noteActive={instrumentMode === "strings" ? stringActive : instrumentMode === "drum" ? pulse > 0 : activeNotes.length > 0}
        mode={instrumentMode}
      />
      <button
        className="performance-exit"
        onClick={() => setPerformanceMode(false)}
        aria-label="退出演奏模式"
      >
        EXIT / ESC
      </button>
      <header className="stage-header">
        <button className="back-button light" onClick={() => setRole("home")}>
          ← 退出舞台
        </button>
        <div className="stage-title">
          <span>惯性谱</span>
          <small>MOTION SCORE / LIVE CANVAS</small>
        </div>
        <div className="stage-header-actions">
          <button className="performance-mode-button" onClick={() => setPerformanceMode(true)}>
            演奏模式
          </button>
          <div className={`connection-pill ${connectionState}`}>
            <i /> {statusLabel}
          </div>
        </div>
      </header>

      <section className="stage-overlay">
        <div className="pair-card glass-card">
          <span className="panel-label">DEVICE LINK</span>
          <strong>{roomCode}</strong>
          <p>PHONE / ENTER CODE</p>
        </div>

        <div className="meters glass-card">
          <span className="panel-label">MOTION VECTOR</span>
          <div className="meter-row"><span>冲量</span><i><b style={{ width: `${clamp(frame.magnitude / 14, 0, 1) * 100}%` }} /></i></div>
          <div className="meter-row"><span>声像</span><i><b style={{ width: `${clamp((frame.gamma + 45) / 90, 0, 1) * 100}%` }} /></i></div>
          <div className="meter-row"><span>滤波</span><i><b style={{ width: `${clamp((frame.beta + 30) / 120, 0, 1) * 100}%` }} /></i></div>
          <div className="meter-row"><span>垂直</span><i><b style={{ width: `${clamp(Math.abs(worldVerticalAcceleration(frame)) / 8, 0, 1) * 100}%` }} /></i></div>
        </div>
      </section>

      <section className="performance-state glass-card">
        <span className="panel-label">PERFORMANCE MONITOR</span>
        <div><strong>{currentNoteName}</strong><span>{gestureLabel}</span></div>
        <small>{instrumentMode === "strings" ? "SNAP · DEAD ZONE · GLIDE" : instrumentMode === "drum" ? "IMPULSE / VELOCITY" : instrumentMode === "midi" ? selectedMidiPort ? `CH 1 · ${activeNotes.length} ACTIVE` : "OUTPUT NOT ASSIGNED" : activeNotes.length ? `${activeNotes.length} NOTES ACTIVE` : "AWAITING NOTE"}</small>
      </section>

      <section className="stage-controls glass-card">
        <div>
          <span className="panel-label">{instrumentMode === "midi" ? "MIDI OUTPUT" : "SOUND ENGINE"}</span>
          <strong>{sampleName}</strong>
        </div>
        {instrumentMode === "midi" ? (
          <button className={midiStatus === "ready" ? "active midi-ready" : ""} onClick={() => void enableMidi()} disabled={midiStatus === "loading"}>
            {midiStatus === "loading" ? "读取端口中…" : midiStatus === "ready" ? "MIDI 已启用" : "启用 MIDI"}
          </button>
        ) : (
          <button className={soundReady ? "active" : ""} onClick={() => void enableAudio()} disabled={bankStatus === "loading"}>
            {bankStatus === "loading" ? "加载音色中…" : soundReady ? "声音已启用" : "启用声音"}
          </button>
        )}
        <button onClick={() => setLibraryOpen((value) => !value)}>音色库</button>
      </section>

      {libraryOpen && (
        <section className="library-manager glass-card">
          <header><div><span className="panel-label">INSTRUMENT BANK</span><strong>乐器库</strong></div><button onClick={() => setLibraryOpen(false)}>关闭</button></header>
          <div className="library-grid">
            <button className={instrumentMode === "tonal" ? "active" : ""} onClick={() => selectInstrument("tonal")}>
              <b>Inertia Glass</b><small>8 PITCH · 3 VELOCITY</small>
            </button>
            <button className={instrumentMode === "strings" ? "active" : ""} onClick={() => selectInstrument("strings")}>
              <b>Inertia Pluck</b><small>SNAP · GLIDE · DECAY</small>
            </button>
            <button className={instrumentMode === "drum" ? "active" : ""} onClick={() => selectInstrument("drum")}>
              <b>Impact Drum</b><small>IMPACT · VELOCITY</small>
            </button>
            <button className={`midi-library-card ${instrumentMode === "midi" ? "active" : ""}`} onClick={() => selectInstrument("midi")}>
              <b>Motion MIDI Controller</b><span>外部控制器</span><small>12-TONE · CC MATRIX</small>
            </button>
          </div>
          <div className="sample-replace">
            <span>自定义重鼓采样</span>
            <label>替换重鼓<input type="file" accept="audio/*" onChange={(event) => void replaceDrumSample(event.target.files?.[0])} /></label>
          </div>
        </section>
      )}

      {instrumentMode !== "midi" && (
        <section className="performance-tools glass-card">
          <div className="tool-heading">
            <span className="panel-label">SESSION CAPTURE</span>
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
      )}

      <section className={`stage-keyboard glass-card ${instrumentMode}`}>
        <span className="panel-label">{instrumentMode === "tonal" ? "PREVIEW / SCALE" : instrumentMode === "strings" ? "PREVIEW / PLUCK" : instrumentMode === "drum" ? "PREVIEW / IMPACT" : "PREVIEW / MIDI C4—B4"}</span>
        <div>
          {instrumentMode === "tonal" ? NOTE_DEFINITIONS.map((note) => (
            <button key={note.midi} onClick={() => void previewNote(note.midi, note.name)}>
              {note.name}
            </button>
          )) : instrumentMode === "strings" ?
            <button onClick={() => void previewStringStart()} onPointerLeave={previewStringStop}>点击试听 · F4</button> :
            instrumentMode === "drum" ? <button onClick={previewDrum}>重鼓</button> :
            MIDI_KEYBOARD_NOTES.map((note) => (
              <button key={note.midi} className={note.name.includes("♯") || note.name.includes("♭") ? "accidental" : ""} onClick={() => void previewNote(note.midi, note.name)}>{note.name}</button>
            ))}
        </div>
      </section>

      <section className="simulator glass-card">
        <span className="panel-label">MOTION DIAGNOSTIC</span>
        <div>
          <button onClick={() => simulate("hit")}>IMPULSE</button>
          <button onClick={() => simulate("shake")}>VIBRATO</button>
          <button onClick={() => simulate("tilt-left")}>PAN L</button>
          <button onClick={() => simulate("tilt-right")}>PAN R</button>
        </div>
      </section>

      {instrumentMode === "midi" && (
        <section className={`midi-test midi-controller-panel glass-card ${midiStatus === "ready" ? "active" : ""}`}>
          <div className="midi-test-heading">
            <div><span className="panel-label">MOTION MIDI CONTROLLER</span><strong>键盘 + 可选动作映射</strong></div>
          </div>
          <select
            aria-label="MIDI 输出端口"
            value={selectedMidiPort}
            onChange={(event) => void selectMidiPort(event.target.value)}
            disabled={!midiPorts.length}
          >
            {!midiPorts.length && <option value="">{midiStatus === "unsupported" ? "请使用 Chrome 电脑端" : "尚未发现 MIDI 输出"}</option>}
            {midiPorts.map((port) => <option key={port.id} value={port.id}>{port.name}{port.manufacturer ? ` · ${port.manufacturer}` : ""}</option>)}
          </select>
          <div className="midi-note-status"><span>NOTE ON/OFF</span><b>通道 1</b><em>{selectedMidiPort ? "READY" : "WAITING"}</em></div>
          <div className="midi-mapping-list">
            {MIDI_MAPPING_META.map(({ key, gesture, detail }) => (
              <div className={`midi-mapping-row ${midiMappings[key].enabled ? "enabled" : ""}`} key={key}>
                <button
                  className="mapping-toggle"
                  type="button"
                  aria-pressed={midiMappings[key].enabled}
                  onClick={() => updateMidiMapping(key, { enabled: !midiMappings[key].enabled })}
                >
                  <i />
                  <span><b>{gesture}</b><small>{detail}</small></span>
                </button>
                <select
                  aria-label={`${gesture} MIDI CC`}
                  value={midiMappings[key].controller}
                  onChange={(event) => updateMidiMapping(key, { controller: Number(event.target.value) })}
                >
                  {MIDI_CONTROLLER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
            ))}
          </div>
          <small>CC OFF = NO DATA · NOTE ON/OFF ALWAYS ACTIVE</small>
        </section>
      )}

      <footer className="stage-footer">
        <span>{message || "MOTION STREAM / STANDBY"}</span>
        <span>{new Date().toLocaleTimeString("zh-CN", { hour12: false })}</span>
      </footer>
    </main>
  );
}
