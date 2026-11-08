import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const phone = await readFile(new URL('../public/phone.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../app/motion-score-app.tsx', import.meta.url), 'utf8');

class Events {
  handlers = {};
  open = false;
  sent = [];
  on(name, callback) { (this.handlers[name] ??= []).push(callback); }
  emit(name, value) { if (name === 'open') this.open = true; for (const fn of this.handlers[name] ?? []) fn(value); }
  send(value) { this.sent.push(value); }
  close() { this.open = false; this.emit('close'); }
}

function phoneHarness(search) {
  const elements = new Map();
  const timers = new Map();
  const peers = [];
  let timerId = 0;
  const context = vm.createContext({
    URLSearchParams,
    window: { location: { search } },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { value: '', disabled: false, textContent: '', classList: { add() {}, remove() {} }, addEventListener(name, fn) { this[name] = fn; }, click() { this.click?.handler?.(); } });
      const el = elements.get(id);
      el.addEventListener = (name, fn) => { if (name === 'click') el.click = fn; else el[name] = fn; };
      return el;
    } },
    Peer: class extends Events {
      constructor() { super(); peers.push(this); }
      connect() { return this.link = new Events(); }
      destroy() { this.destroyed = true; }
    },
  });
  const start = phone.indexOf('    window.__MOTIONSCORE_READY__=true;');
  const end = phone.indexOf('    document.querySelectorAll(".mode")', start);
  vm.runInContext(phone.slice(start, end), context);
  vm.runInContext('function clearNotes(){} function endString(){} function setInstrument(){} function applyMidiConfig(){}', context);
  const auto = phone.slice(phone.indexOf('    var roomFromLink='), phone.indexOf('  })();'));
  vm.runInContext(auto, context);
  return { context, elements, peers, timers };
}

test('QR link auto-fills and connects; plain or malformed links stay manual', () => {
  const h = phoneHarness('?room=abc23');
  assert.equal(h.elements.get('code').value, 'ABC23');
  assert.equal(h.peers.length, 1);
  assert.equal(h.elements.get('connect').disabled, true);
  for (const search of ['', '?room=%3Cscript%3E', '?room=ABCDE123']) {
    assert.equal(phoneHarness(search).peers.length, 0);
  }
});

test('busy and ended sessions keep their notice, stop sending and allow explicit retry', () => {
  for (const type of ['stage-busy', 'session-ended']) {
    const h = phoneHarness('?room=ABCDE');
    const p = h.peers[0]; p.emit('open'); p.link.emit('open');
    p.link.emit('data', { type });
    assert.equal(h.context.connection, null);
    assert.equal(h.elements.get('connect').disabled, false);
    const notice = h.elements.get('message').textContent;
    assert.match(notice, type === 'stage-busy' ? /舞台使用中/ : /体验已结束/);
    h.context.send({ type: 'sensor' });
    assert.equal(h.elements.get('message').textContent, notice);
    h.elements.get('connect').click();
    assert.equal(h.peers.length, 2);
    p.link.emit('close');
    assert.equal(h.elements.get('connect').disabled, true);
  }
});

test('failed connection times out and offers retry', () => {
  const h = phoneHarness('?room=ABCDE');
  [...h.timers.values()][0]();
  assert.match(h.elements.get('message').textContent, /连接超时/);
  assert.equal(h.elements.get('connect').disabled, false);
  assert.equal(h.peers[0].destroyed, true);
});

test('stage reserves one slot, rejects another phone and ignores stale events', () => {
  const peer = new Events();
  const connectionRef = { current: null };
  let frameCount = 0;
  let releaseCount = 0;
  const context = vm.createContext({ peer, connectionRef,
    window: { setTimeout() {}, clearTimeout() {} },
    handshakeTimer: undefined,
    releaseController() { releaseCount++; connectionRef.current = null; },
    setMessage() {}, setConnectionState() {}, setRole() {},
    instrumentModeRef: { current: 'tonal' }, midiMappingsRef: { current: {} },
    isSensorFrame: (data) => data.type === 'sensor',
    processFrame: () => frameCount++,
    isNoteMessage: () => false, isStringMessage: () => false, isMidiMappingMessage: () => false,
  });
  const start = app.indexOf('      peer.on("connection", (connection) => {');
  const end = app.indexOf('\n      peer.on("error",', start);
  vm.runInContext(app.slice(start, end), context);
  const a = new Events(); const b = new Events(); const c = new Events();
  peer.emit('connection', a);
  peer.emit('connection', b); b.emit('open');
  assert.equal(connectionRef.current, a);
  assert.equal(b.sent[0].type, 'stage-busy');
  a.emit('open'); a.emit('data', { type: 'sensor' });
  assert.equal(frameCount, 1);
  a.close();
  assert.equal(releaseCount, 1);
  peer.emit('connection', c); c.emit('open');
  a.emit('close'); a.emit('error'); a.emit('data', { type: 'sensor' });
  assert.equal(connectionRef.current, c);
  assert.equal(frameCount, 1);
  assert.equal(releaseCount, 1);
});


test('QR URLs preserve project paths and replace old query strings', async () => {
  const source = await readFile(new URL('../app/pairing-card.tsx', import.meta.url), 'utf8');
  const snippet = source.slice(source.indexOf('    const url ='), source.indexOf('    const qr ='));
  for (const [href, expected] of [
    ['https://example.github.io/MotionScore/', 'https://example.github.io/MotionScore/phone.html?room=ABCDE'],
    ['https://example.github.io/MotionScore/index.html?old=yes#stage', 'https://example.github.io/MotionScore/phone.html?room=ABCDE'],
    ['https://example.com/', 'https://example.com/phone.html?room=ABCDE'],
  ]) {
    const result = vm.runInNewContext(snippet + 'url.href;', { URL, roomCode: 'ABCDE', window: { location: { href } } });
    assert.equal(result, expected);
  }
});
