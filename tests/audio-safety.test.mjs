import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../app/motion-audio.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

function engine() {
  const nodes = [];
  function param() { return { value: 0, setValueAtTime(v) { this.value = v; }, exponentialRampToValueAtTime(v) { this.value = v; }, setTargetAtTime(v) { this.value = v; }, cancelScheduledValues() {} }; }
  function node(kind) {
    const n = { kind, outputs: [], connect(target) { this.outputs.push(target); return target; }, start() {}, stop() {}, addEventListener() {} };
    for (const key of ['gain', 'frequency', 'Q', 'delayTime', 'threshold', 'knee', 'ratio', 'attack', 'release', 'pan', 'playbackRate']) n[key] = param();
    nodes.push(n); return n;
  }
  class AudioContext {
    sampleRate = 1000;
    currentTime = 0;
    destination = node('destination');
    createGain() { return node('gain'); }
    createBiquadFilter() { return node('filter'); }
    createOscillator() { return node('oscillator'); }
    createStereoPanner() { return node('panner'); }
    createConvolver() { return node('convolver'); }
    createDelay() { return node('delay'); }
    createDynamicsCompressor() { return node('compressor'); }
    createWaveShaper() { return node('safety'); }
    createMediaStreamDestination() { return node('capture'); }
    createBufferSource() { return node('source'); }
    createBuffer(channels, length) { return { numberOfChannels: channels, getChannelData: () => new Float32Array(length) }; }
  }
  const context = vm.createContext({ exports: {}, AudioContext, Float32Array, Math, Map });
  vm.runInContext(compiled, context);
  return { api: context.exports, nodes };
}

test('audible and recorded outputs both pass through the peak guard', () => {
  const { api, nodes } = engine(); const rig = api.createAudioRig();
  const comp = nodes.find(n => n.kind === 'compressor');
  const safety = nodes.find(n => n.kind === 'safety');
  assert.equal(rig.master.outputs[0], comp);
  assert.equal(comp.outputs.length, 1);
  assert.equal(comp.outputs[0].gain.value, 0.25);
  assert.equal(comp.outputs[0].outputs[0], safety);
  assert.equal(safety.outputs.length, 2);
  assert.ok(safety.outputs.includes(rig.context.destination));
  assert.ok(safety.outputs.includes(rig.capture));
  assert.equal(safety.oversample, '4x');
});

test('guard is linear at ordinary levels and bounded for extreme peaks', () => {
  const { api, nodes } = engine(); api.createAudioRig();
  const curve = nodes.find(n => n.kind === 'safety').curve;
  for (let i = 0; i < curve.length; i++) {
    const input = (i / (curve.length - 1) * 2 - 1) * 4;
    assert.ok(Number.isFinite(curve[i]));
    assert.ok(Math.abs(curve[i]) <= 0.950001);
    if (Math.abs(input) <= 0.85) assert.ok(Math.abs(curve[i] - input) < 1e-6);
    if (i > 0) assert.ok(curve[i] >= curve[i - 1]);
  }
});

test('Glass chord voices reserve headroom before the effects chain', () => {
  const { api, nodes } = engine(); const rig = api.createAudioRig();
  for (const midi of [60, 64, 67]) {
    rig.samples.set(`${midi}:hard`, {});
    assert.equal(api.noteOn(rig, midi, 1), true);
  }
  const sources = nodes.filter(n => n.kind === 'source');
  assert.equal(sources.length, 3);
  for (const voice of sources) assert.ok(voice.outputs[0].gain.value < 0.5);
});
