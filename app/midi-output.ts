export type MidiPortInfo = {
  id: string;
  name: string;
  manufacturer: string;
};

export type MidiGestureKey = "pan" | "modulation" | "expression";

export type MidiGestureMapping = {
  enabled: boolean;
  controller: number;
};

export type MidiGestureMappings = Record<MidiGestureKey, MidiGestureMapping>;

type MidiOutputLike = {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  state?: string;
  send: (data: number[] | Uint8Array, timestamp?: number) => void;
  open?: () => Promise<unknown>;
  close?: () => Promise<unknown>;
};

type MidiAccessLike = {
  outputs: {
    values: () => IterableIterator<MidiOutputLike>;
  };
  onstatechange: ((event: Event) => void) | null;
};

type MidiNavigator = Navigator & {
  requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MidiAccessLike>;
};

const MIDI_CHANNEL = 0;
const STATUS_NOTE_OFF = 0x80 | MIDI_CHANNEL;
const STATUS_NOTE_ON = 0x90 | MIDI_CHANNEL;
const STATUS_CC = 0xb0 | MIDI_CHANNEL;

function midiValue(value: number) {
  return Math.max(0, Math.min(127, Math.round(value)));
}

function normalizedMidi(value: number) {
  return midiValue(value * 127);
}

export class MotionMidiOutput {
  private access: MidiAccessLike | null = null;
  private output: MidiOutputLike | null = null;
  private outputId = "";
  private onPortsChanged: (() => void) | null = null;
  private lastControllers = new Map<number, number>();
  private throwTimers: number[] = [];

  static supported() {
    return typeof navigator !== "undefined" &&
      typeof (navigator as MidiNavigator).requestMIDIAccess === "function";
  }

  async connect(onPortsChanged?: () => void) {
    const requestMIDIAccess = (navigator as MidiNavigator).requestMIDIAccess;
    if (!requestMIDIAccess) throw new Error("Web MIDI is not supported");
    this.onPortsChanged = onPortsChanged ?? null;
    this.access = await requestMIDIAccess.call(navigator, { sysex: false });
    this.access.onstatechange = () => {
      this.restoreSelectedOutput();
      this.onPortsChanged?.();
    };
    this.restoreSelectedOutput();
    return this.ports();
  }

  ports(): MidiPortInfo[] {
    if (!this.access) return [];
    return Array.from(this.access.outputs.values())
      .filter((port) => port.state !== "disconnected")
      .map((port) => ({
        id: port.id,
        name: port.name || "未命名 MIDI 输出",
        manufacturer: port.manufacturer || "",
      }));
  }

  selectedId() {
    return this.output?.id ?? "";
  }

  async select(id: string) {
    this.allNotesOff();
    if (this.output?.close) await this.output.close();
    this.outputId = id;
    this.output = this.findOutput(id);
    this.lastControllers.clear();
    if (this.output?.open) await this.output.open();
    return Boolean(this.output);
  }

  ready() {
    return Boolean(this.output);
  }

  noteOn(note: number, velocity = 0.64) {
    this.send([STATUS_NOTE_ON, midiValue(note), normalizedMidi(velocity)]);
  }

  noteOff(note: number) {
    this.send([STATUS_NOTE_OFF, midiValue(note), 0]);
  }

  allNotesOff() {
    this.sendController(64, 0, true);
    this.sendController(123, 0, true);
  }

  sendGlassExpression(values: { pan: number; brightness: number; shake: number }) {
    const pan = normalizedMidi((Math.max(-1, Math.min(1, values.pan)) + 1) / 2);
    const brightness = normalizedMidi(Math.max(0, Math.min(1, values.brightness)));
    const shake = Math.max(0, Math.min(1, values.shake));

    // Inertia Glass MIDI profile v1:
    // CC10 pan, CC74 filter cutoff, CC71 resonance, CC1 shake depth,
    // CC76 shake/tremolo rate, CC91 reverb send, CC20 delay throw.
    this.sendController(10, pan);
    this.sendController(74, brightness);
    this.sendController(71, normalizedMidi(0.08 + values.brightness * 0.72));
    this.sendController(1, normalizedMidi(shake));
    this.sendController(76, normalizedMidi(0.15 + shake * 0.78));
  }

  sendGestureExpression(
    values: { pan: number; modulation: number; expression: number },
    mappings: MidiGestureMappings,
  ) {
    if (mappings.pan.enabled) {
      this.sendController(
        mappings.pan.controller,
        normalizedMidi((Math.max(-1, Math.min(1, values.pan)) + 1) / 2),
      );
    }
    if (mappings.modulation.enabled) {
      this.sendController(
        mappings.modulation.controller,
        normalizedMidi(Math.max(0, Math.min(1, values.modulation))),
      );
    }
    if (mappings.expression.enabled) {
      this.sendController(
        mappings.expression.controller,
        normalizedMidi(Math.max(0, Math.min(1, values.expression))),
      );
    }
  }

  resetGestureMapping(key: MidiGestureKey, controller: number) {
    const neutral = key === "pan" ? 64 : key === "expression" ? 127 : 0;
    this.sendController(controller, neutral, true);
  }

  triggerEffectThrow(strength: number) {
    const amount = normalizedMidi(0.72 + Math.max(0, Math.min(1, strength)) * 0.28);
    this.clearThrowTimers();
    this.sendController(91, amount, true);
    this.sendController(20, amount, true);
    if (typeof window === "undefined") return;
    this.throwTimers.push(window.setTimeout(() => {
      this.sendController(91, 48, true);
      this.sendController(20, 32, true);
    }, 420));
    this.throwTimers.push(window.setTimeout(() => {
      this.sendController(91, 8, true);
      this.sendController(20, 0, true);
      this.throwTimers = [];
    }, 720));
  }

  reset() {
    this.clearThrowTimers();
    this.allNotesOff();
    this.lastControllers.clear();
  }

  dispose() {
    this.reset();
    if (this.access) this.access.onstatechange = null;
    void this.output?.close?.();
    this.output = null;
    this.access = null;
  }

  private findOutput(id: string) {
    if (!this.access) return null;
    return Array.from(this.access.outputs.values()).find((port) => port.id === id) ?? null;
  }

  private restoreSelectedOutput() {
    const ports = this.ports();
    const nextId = ports.some((port) => port.id === this.outputId)
      ? this.outputId
      : ports[0]?.id ?? "";
    this.outputId = nextId;
    this.output = nextId ? this.findOutput(nextId) : null;
    if (this.output?.open) void this.output.open();
  }

  private sendController(controller: number, value: number, force = false) {
    const next = midiValue(value);
    if (!force && this.lastControllers.get(controller) === next) return;
    this.lastControllers.set(controller, next);
    this.send([STATUS_CC, midiValue(controller), next]);
  }

  private send(data: number[]) {
    if (!this.output) return;
    try {
      this.output.send(data);
    } catch {
      // A disconnected virtual port is reported through onstatechange; keep the
      // original Web Audio engine running while the user reconnects MIDI.
    }
  }

  private clearThrowTimers() {
    if (typeof window !== "undefined") this.throwTimers.forEach(window.clearTimeout);
    this.throwTimers = [];
  }
}
