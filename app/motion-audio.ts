export const NOTE_DEFINITIONS = [
  { midi: 60, name: "C4", file: "c4", color: 42 },
  { midi: 62, name: "D4", file: "d4", color: 62 },
  { midi: 64, name: "E4", file: "e4", color: 84 },
  { midi: 67, name: "G4", file: "g4", color: 112 },
  { midi: 69, name: "A4", file: "a4", color: 142 },
  { midi: 72, name: "C5", file: "c5", color: 176 },
  { midi: 74, name: "D5", file: "d5", color: 208 },
  { midi: 76, name: "E5", file: "e5", color: 244 },
] as const;

export type NoteMessage = {
  type: "note";
  action: "on" | "off" | "allOff";
  midi?: number;
  name?: string;
  velocity?: number;
  t: number;
};

type SampleLayer = "soft" | "medium" | "hard";

type Voice = {
  source: AudioBufferSourceNode;
  gain: GainNode;
  midi: number;
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
  convolver: ConvolverNode;
  wet: GainNode;
  delaySend: GainNode;
  delay: DelayNode;
  delayFeedback: GainNode;
  delayWet: GainNode;
  capture: MediaStreamAudioDestinationNode;
  samples: Map<string, AudioBuffer>;
  voices: Map<number, Voice>;
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
  const convolver = context.createConvolver();
  const wet = context.createGain();
  const delaySend = context.createGain();
  const delay = context.createDelay(1.5);
  const delayFeedback = context.createGain();
  const delayWet = context.createGain();
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
  wet.gain.value = 0.10;
  delaySend.gain.value = 0;
  delay.delayTime.value = 0.32;
  delayFeedback.gain.value = 0.46;
  delayWet.gain.value = 0.42;
  convolver.buffer = makeImpulse(context);

  input.connect(filter).connect(tremolo).connect(panner);
  panner.connect(dry).connect(master);
  panner.connect(convolver).connect(wet).connect(master);
  panner.connect(delaySend).connect(delay).connect(delayWet).connect(master);
  delay.connect(delayFeedback).connect(delay);
  tremoloLfo.connect(tremoloDepth).connect(tremolo.gain);
  master.connect(context.destination);
  master.connect(capture);
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
    convolver,
    wet,
    delaySend,
    delay,
    delayFeedback,
    delayWet,
    capture,
    samples: new Map(),
    voices: new Map(),
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
        const response = await fetch(`/audio/inertia-glass/${note.file}_${layer}.wav`);
        if (!response.ok) throw new Error(`Unable to load ${note.name} ${layer}`);
        const buffer = await rig.context.decodeAudioData(await response.arrayBuffer());
        rig.samples.set(sampleKey(note.midi, layer), buffer);
      }),
    ),
  );
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
}

export function updateMotionEffects(
  rig: AudioRig,
  values: { pan: number; brightness: number; shake: number; twist: number },
) {
  const now = rig.context.currentTime;
  const pan = clamp(values.pan, -1, 1);
  const brightness = clamp(values.brightness, 0, 1);
  const shake = clamp(values.shake, 0, 1);
  const twist = clamp(values.twist, 0, 1);
  const cutoff = 320 * Math.pow(28, brightness);
  const depth = shake * 0.46;

  rig.panner.pan.setTargetAtTime(pan, now, 0.05);
  rig.filter.frequency.setTargetAtTime(cutoff, now, 0.055);
  rig.filter.Q.setTargetAtTime(1.1 + brightness * 4.6, now, 0.06);
  rig.tremolo.gain.setTargetAtTime(1 - depth, now, 0.045);
  rig.tremoloDepth.gain.setTargetAtTime(depth, now, 0.045);
  rig.tremoloLfo.frequency.setTargetAtTime(3.2 + shake * 12.5, now, 0.055);
  rig.wet.gain.setTargetAtTime(0.10, now, 0.11);
  rig.dry.gain.setTargetAtTime(0.88, now, 0.12);
  rig.delaySend.gain.setTargetAtTime(twist * 0.74, now, twist > 0 ? 0.025 : 0.07);
  rig.delayFeedback.gain.setTargetAtTime(0.42 + twist * 0.22, now, 0.08);
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
