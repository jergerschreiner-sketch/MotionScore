export const NOTE_DEFINITIONS = [
  { midi: 60, name: "C4", file: "c4", color: 42 },
  { midi: 62, name: "D4", file: "d4", color: 62 },
  { midi: 64, name: "E4", file: "e4", color: 84 },
  { midi: 65, name: "F4", file: "f4", color: 104 },
  { midi: 67, name: "G4", file: "g4", color: 132 },
  { midi: 69, name: "A4", file: "a4", color: 164 },
  { midi: 71, name: "B4", file: "b4", color: 202 },
  { midi: 72, name: "C5", file: "c5", color: 238 },
] as const;

export type NoteMessage = {
  type: "note";
  action: "on" | "off" | "allOff";
  midi?: number;
  name?: string;
  velocity?: number;
  t: number;
};

export const STRING_DEFINITIONS = [
  { midi: 55, name: "G3", file: "g3" },
  { midi: 62, name: "D4", file: "d4" },
  { midi: 69, name: "A4", file: "a4" },
  { midi: 76, name: "E5", file: "e5" },
] as const;

export type StringMessage = {
  type: "string";
  action: "start" | "move" | "end";
  stringIndex: number;
  midi: number;
  expression: number;
  t: number;
};

type SampleLayer = "soft" | "medium" | "hard";

type Voice = {
  source: AudioBufferSourceNode;
  gain: GainNode;
  midi: number;
};

type StringVoice = {
  source: AudioBufferSourceNode;
  gain: GainNode;
  stringIndex: number;
  baseMidi: number;
};

export type AudioRig = {
  context: AudioContext;
  master: GainNode;
  input: GainNode;
  filter: BiquadFilterNode;
  tremolo: GainNode;
  tremoloDepth: GainNode;
  tremoloLfo: OscillatorNode;
  panner: StereoPannerNode;
  dry: GainNode;
  reverbSend: GainNode;
  convolver: ConvolverNode;
  wet: GainNode;
  delaySend: GainNode;
  delay: DelayNode;
  delayFeedback: GainNode;
  delayWet: GainNode;
  capture: MediaStreamAudioDestinationNode;
  samples: Map<string, AudioBuffer>;
  voices: Map<number, Voice>;
  stringVoice: StringVoice | null;
  customHit: AudioBuffer | null;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function makeImpulse(context: AudioContext, seconds = 2.4) {
  const length = Math.floor(context.sampleRate * seconds);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      const position = index / length;
      const decay = Math.pow(1 - position, 3.2);
      data[index] = (Math.random() * 2 - 1) * decay * (channel === 0 ? 0.72 : 0.68);
    }
  }
  return impulse;
}

export function createAudioRig(): AudioRig {
  const context = new AudioContext({ latencyHint: "interactive" });
  const master = context.createGain();
  const input = context.createGain();
  const filter = context.createBiquadFilter();
  const tremolo = context.createGain();
  const tremoloDepth = context.createGain();
  const tremoloLfo = context.createOscillator();
  const panner = context.createStereoPanner();
  const dry = context.createGain();
  const reverbSend = context.createGain();
  const convolver = context.createConvolver();
  const wet = context.createGain();
  const delaySend = context.createGain();
  const delay = context.createDelay(1.5);
  const delayFeedback = context.createGain();
  const delayWet = context.createGain();
  const limiter = context.createDynamicsCompressor();
  const capture = context.createMediaStreamDestination();

  master.gain.value = 0.78;
  input.gain.value = 0.92;
  filter.type = "lowpass";
  filter.frequency.value = 7_000;
  filter.Q.value = 1.4;
  tremolo.gain.value = 1;
  tremoloDepth.gain.value = 0;
  tremoloLfo.type = "sine";
  tremoloLfo.frequency.value = 5;
  dry.gain.value = 0.86;
  reverbSend.gain.value = 0.06;
  wet.gain.value = 1.18;
  delaySend.gain.value = 0;
  delay.delayTime.value = 0.38;
  delayFeedback.gain.value = 0.62;
  delayWet.gain.value = 1.0;
  limiter.threshold.value = -4;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.18;
  convolver.buffer = makeImpulse(context);

  input.connect(filter).connect(tremolo).connect(panner);
  panner.connect(dry).connect(master);
  panner.connect(reverbSend).connect(convolver).connect(wet).connect(master);
  panner.connect(delaySend).connect(delay).connect(delayWet).connect(master);
  delay.connect(delayFeedback).connect(delay);
  tremoloLfo.connect(tremoloDepth).connect(tremolo.gain);
  master.connect(limiter);
  limiter.connect(context.destination);
  limiter.connect(capture);
  tremoloLfo.start();

  return {
    context,
    master,
    input,
    filter,
    tremolo,
    tremoloDepth,
    tremoloLfo,
    panner,
    dry,
    reverbSend,
    convolver,
    wet,
    delaySend,
    delay,
    delayFeedback,
    delayWet,
    capture,
    samples: new Map(),
    voices: new Map(),
    stringVoice: null,
    customHit: null,
  };
}

function sampleKey(midi: number, layer: SampleLayer) {
  return `${midi}:${layer}`;
}

export async function loadBuiltInBank(rig: AudioRig) {
  const layers: SampleLayer[] = ["soft", "medium", "hard"];
  await Promise.all(
    NOTE_DEFINITIONS.flatMap((note) =>
      layers.map(async (layer) => {
        const response = await fetch(`./audio/inertia-glass/${note.file}_${layer}.wav`);
        if (!response.ok) throw new Error(`Unable to load ${note.name} ${layer}`);
        const buffer = await rig.context.decodeAudioData(await response.arrayBuffer());
        rig.samples.set(sampleKey(note.midi, layer), buffer);
      }),
    ),
  );
}

export async function loadPercussionBank(rig: AudioRig) {
  const response = await fetch("./audio/kinetic-percussion/heavy-drum.wav");
  if (!response.ok) throw new Error("Unable to load heavy-drum");
  rig.samples.set("percussion:heavy-drum", await rig.context.decodeAudioData(await response.arrayBuffer()));
}

export async function loadStringBank(rig: AudioRig) {
  await Promise.all(
    STRING_DEFINITIONS.map(async (string, index) => {
      const response = await fetch(`./audio/inertia-strings/${string.file}.wav`);
      if (!response.ok) throw new Error(`Unable to load ${string.name} string`);
      rig.samples.set(`string:${index}`, await rig.context.decodeAudioData(await response.arrayBuffer()));
    }),
  );
}

export function stopStringVoice(rig: AudioRig, release = 0.18) {
  const voice = rig.stringVoice;
  if (!voice) return;
  rig.stringVoice = null;
  const now = rig.context.currentTime;
  voice.gain.gain.cancelScheduledValues(now);
  voice.gain.gain.setValueAtTime(Math.max(voice.gain.gain.value, 0.0001), now);
  voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + release);
  voice.source.stop(now + release + 0.04);
}

export function startStringVoice(
  rig: AudioRig,
  stringIndex: number,
  midi: number,
  expression = 0.62,
) {
  stopStringVoice(rig, 0.075);
  const definition = STRING_DEFINITIONS[stringIndex];
  const buffer = rig.samples.get(`string:${stringIndex}`);
  if (!definition || !buffer) return false;

  const now = rig.context.currentTime;
  const source = rig.context.createBufferSource();
  const gain = rig.context.createGain();
  source.buffer = buffer;
  source.playbackRate.value = Math.pow(2, (midi - definition.midi) / 12);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(clamp(0.36 + expression * 0.56, 0.28, 0.9), now + 0.004);
  gain.gain.setTargetAtTime(clamp(0.22 + expression * 0.36, 0.18, 0.62), now + 0.055, 1.35);
  source.connect(gain).connect(rig.input);
  source.start(now);
  const voice: StringVoice = { source, gain, stringIndex, baseMidi: definition.midi };
  rig.stringVoice = voice;
  source.addEventListener("ended", () => {
    if (rig.stringVoice === voice) rig.stringVoice = null;
  });
  return true;
}

export function updateStringVoice(
  rig: AudioRig,
  values: { midi?: number; expression?: number },
) {
  const voice = rig.stringVoice;
  if (!voice) return;
  const now = rig.context.currentTime;
  if (typeof values.midi === "number") {
    voice.source.playbackRate.setTargetAtTime(Math.pow(2, (values.midi - voice.baseMidi) / 12), now, 0.018);
  }
  if (typeof values.expression === "number") {
    voice.gain.gain.setTargetAtTime(clamp(0.2 + values.expression * 0.44, 0.18, 0.68), now, 0.045);
  }
}

export function triggerPercussionVoice(
  rig: AudioRig,
  kind: "heavy-drum",
  strength: number,
) {
  const buffer = rig.samples.get(`percussion:${kind}`);
  if (!buffer) return false;
  const now = rig.context.currentTime;
  const source = rig.context.createBufferSource();
  const gain = rig.context.createGain();
  source.buffer = buffer;
  source.playbackRate.value = 0.94 + Math.random() * 0.07;
  source.connect(gain).connect(rig.input);

  const level = clamp(0.58 + strength * 0.42, 0.55, 1);
  const playbackDuration = buffer.duration / source.playbackRate.value;
  const fadeDuration = clamp(playbackDuration * 0.38, 0.28, 0.48);
  const fadeStart = now + Math.max(0.12, playbackDuration - fadeDuration);
  gain.gain.setValueAtTime(level, now);
  gain.gain.setValueAtTime(level, fadeStart);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + playbackDuration);
  source.start(now);
  source.stop(now + playbackDuration + 0.02);
  return true;
}

function velocityLayer(velocity: number): SampleLayer {
  if (velocity < 0.42) return "soft";
  if (velocity > 0.76) return "hard";
  return "medium";
}

export function noteOn(rig: AudioRig, midi: number, velocity = 0.58) {
  noteOff(rig, midi, 0.035);
  const layer = velocityLayer(velocity);
  const buffer = rig.samples.get(sampleKey(midi, layer));
  if (!buffer) return false;

  const now = rig.context.currentTime;
  const source = rig.context.createBufferSource();
  const gain = rig.context.createGain();
  source.buffer = buffer;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(clamp(0.42 + velocity * 0.58, 0.18, 1), now + 0.008);
  gain.gain.setTargetAtTime(clamp(0.34 + velocity * 0.32, 0.2, 0.72), now + 0.10, 1.8);
  source.connect(gain).connect(rig.input);
  source.start(now);
  source.addEventListener("ended", () => {
    if (rig.voices.get(midi)?.source === source) rig.voices.delete(midi);
  });
  rig.voices.set(midi, { source, gain, midi });
  return true;
}

export function noteOff(rig: AudioRig, midi: number, release = 0.22) {
  const voice = rig.voices.get(midi);
  if (!voice) return;
  const now = rig.context.currentTime;
  voice.gain.gain.cancelScheduledValues(now);
  voice.gain.gain.setValueAtTime(Math.max(voice.gain.gain.value, 0.0001), now);
  voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + release);
  voice.source.stop(now + release + 0.03);
  rig.voices.delete(midi);
}

export function allNotesOff(rig: AudioRig) {
  for (const midi of Array.from(rig.voices.keys())) noteOff(rig, midi, 0.12);
  stopStringVoice(rig, 0.12);
}

export function updateMotionEffects(
  rig: AudioRig,
  values: { pan: number; brightness: number; shake: number },
) {
  const now = rig.context.currentTime;
  const pan = clamp(values.pan, -1, 1);
  const brightness = clamp(values.brightness, 0, 1);
  const shake = clamp(values.shake, 0, 1);
  const cutoff = 320 * Math.pow(28, brightness);
  const depth = shake * 0.46;

  rig.panner.pan.setTargetAtTime(pan, now, 0.05);
  rig.filter.frequency.setTargetAtTime(cutoff, now, 0.055);
  rig.filter.Q.setTargetAtTime(1.1 + brightness * 4.6, now, 0.06);
  rig.tremolo.gain.setTargetAtTime(1 - depth, now, 0.045);
  rig.tremoloDepth.gain.setTargetAtTime(depth, now, 0.045);
  rig.tremoloLfo.frequency.setTargetAtTime(3.2 + shake * 12.5, now, 0.055);
  rig.dry.gain.setTargetAtTime(0.88, now, 0.12);
}

export function triggerReverbThrow(rig: AudioRig, strength: number) {
  const now = rig.context.currentTime;
  const amount = clamp(strength, 0, 1);
  rig.reverbSend.gain.cancelScheduledValues(now);
  rig.reverbSend.gain.setValueAtTime(Math.max(0.06, rig.reverbSend.gain.value), now);
  rig.reverbSend.gain.linearRampToValueAtTime(1.32 + amount * 0.48, now + 0.025);
  rig.reverbSend.gain.setTargetAtTime(0.06, now + 0.55, 0.11);
}

export function triggerDelayThrow(rig: AudioRig, strength: number) {
  const now = rig.context.currentTime;
  const amount = clamp(strength, 0, 1);
  rig.delaySend.gain.cancelScheduledValues(now);
  rig.delayFeedback.gain.cancelScheduledValues(now);
  rig.delaySend.gain.setValueAtTime(Math.max(0.0001, rig.delaySend.gain.value), now);
  rig.delaySend.gain.linearRampToValueAtTime(1.12 + amount * 0.42, now + 0.02);
  rig.delaySend.gain.setTargetAtTime(0.0001, now + 0.45, 0.085);
  rig.delayFeedback.gain.setTargetAtTime(0.60 + amount * 0.15, now, 0.06);
}

export function triggerPercussion(rig: AudioRig, velocity: number, pan: number) {
  const now = rig.context.currentTime;
  const gain = rig.context.createGain();
  const panner = rig.context.createStereoPanner();
  panner.pan.value = clamp(pan, -1, 1);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(clamp(velocity, 0.08, 1), now + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
  gain.connect(panner).connect(rig.master);

  if (rig.customHit) {
    const source = rig.context.createBufferSource();
    source.buffer = rig.customHit;
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

export function isNoteMessage(value: unknown): value is NoteMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { type?: unknown; action?: unknown };
  return candidate.type === "note" && ["on", "off", "allOff"].includes(String(candidate.action));
}

export function isStringMessage(value: unknown): value is StringMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { type?: unknown; action?: unknown; stringIndex?: unknown; midi?: unknown };
  return candidate.type === "string" &&
    ["start", "move", "end"].includes(String(candidate.action)) &&
    typeof candidate.stringIndex === "number" &&
    typeof candidate.midi === "number";
}
