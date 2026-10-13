// An encrypted, authenticated connection to another LocalPilot machine, over any transport that
// moves binary messages: a WebSocket on the home network, or a pipe through the relay. The relay
// only ever sees these sealed frames.
//
// Handshake (JSON, before encryption):
//   initiator -> responder  hi   { id, eph, n, name, mode }          mode: 'session' | 'pair'
//   responder -> initiator  hi2  { id, eph, n, name, sig, mac? }     sig over the transcript
//   initiator -> responder  hi3  { sig, mac? }
//   responder -> initiator  ok | err
// In a session both sides must already trust each other's id (paired, or in the same group).
// In pairing, the mac proves both sides know the 6-digit code shown on the responder.
//
// After that, every message is a sealed frame: [type u8][stream u32][payload].

const { EventEmitter } = require('events');
const crypto = require('crypto');
const c = require('./crypto');

const HANDSHAKE_MS = 10_000;
const F = { OPEN: 1, JSON: 2, DATA: 3, END: 4, CTRL: 5, PING: 6, PONG: 7 };

// Wrap a `ws` WebSocket as a transport.
function wsTransport(ws) {
  const t = new EventEmitter();
  ws.binaryType = 'nodebuffer';
  ws.on('message', (data) => t.emit('message', Buffer.from(data)));
  ws.on('close', () => t.emit('close'));
  ws.on('error', () => {});
  t.send = (buf) => { if (ws.readyState === 1) ws.send(buf); };
  t.close = () => { try { ws.close(); } catch { /* already closed */ } };
  Object.defineProperty(t, 'buffered', { get: () => ws.bufferedAmount });
  return t;
}

// Reads handshake messages in order, keeping anything that arrives early.
class Reader {
  constructor(transport) {
    this.transport = transport;
    this.queue = [];
    this.waiting = null;
    this.closed = false;
    this.onMessage = (buf) => {
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = null;
        w.resolve(buf);
      } else this.queue.push(buf);
    };
    this.onClose = () => {
      this.closed = true;
      if (this.waiting) this.waiting.reject(new Error('The other machine closed the connection.'));
    };
    transport.on('message', this.onMessage);
    transport.on('close', this.onClose);
  }

  next(deadline) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(new Error('The other machine closed the connection.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting = null; reject(new Error('The other machine took too long to answer.')); }, Math.max(0, deadline - Date.now()));
      this.waiting = {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
  }

  async json(deadline) {
    const buf = await this.next(deadline);
    if (buf.length > 4096) throw new Error('Handshake message too large.');
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      throw new Error('Not a LocalPilot machine.');
    }
  }

  detach() {
    this.transport.off('message', this.onMessage);
    this.transport.off('close', this.onClose);
    return this.queue;
  }
}

const sendJson = (transport, obj) => transport.send(Buffer.from(JSON.stringify(obj)));
const isKey = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);
const transcriptOf = (mode, hi, hi2) => c.sha256('localpilot v1', mode, hi.id, hi.eph, hi.n, hi2.id, hi2.eph, hi2.n).toString('hex');
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, 64) || 'Unnamed';

// Start a connection. For pairing pass mode 'pair' and the code the user typed.
async function initiate(transport, { identity, name, mode = 'session', code = null, expectId = null, authorize = () => true }) {
  const deadline = Date.now() + HANDSHAKE_MS;
  const reader = new Reader(transport);
  try {
    const eph = c.ephemeral();
    const hi = { t: 'hi', v: 1, id: identity.id, eph: eph.pub, n: c.b64u(crypto.randomBytes(16)), name, mode };
    sendJson(transport, hi);
    const hi2 = await reader.json(deadline);
    if (hi2.t === 'err') throw new Error(hi2.error || 'The other machine refused the connection.');
    if (hi2.t !== 'hi2' || !isKey(hi2.id) || !isKey(hi2.eph) || typeof hi2.n !== 'string') throw new Error('Not a LocalPilot machine.');
    const T = transcriptOf(mode, hi, hi2);
    if (!c.verify(hi2.id, `${T}|R`, hi2.sig)) throw new Error('The other machine failed to prove who it is.');
    if (expectId && hi2.id !== expectId) throw new Error('A different machine answered at that address.');
    let key = null;
    if (mode === 'pair') {
      key = await c.pairingKey(code, `${hi.n}|${hi2.n}`);
      if (!hi2.mac || !c.safeEqual(hi2.mac, c.hmac(key, `R|${T}`))) throw new Error('That code doesn\'t match. Check the code shown on the other machine.');
    } else if (!authorize(hi2.id)) {
      throw new Error('That machine isn\'t paired with you.');
    }
    sendJson(transport, { t: 'hi3', sig: c.sign(identity, `${T}|I`), mac: key ? c.hmac(key, `I|${T}`) : undefined });
    const done = await reader.json(deadline);
    if (done.t !== 'ok') throw new Error(done.error || 'The other machine refused the connection.');
    const keys = c.sessionKeys(c.sharedSecret(eph, hi2.eph), T);
    const leftover = reader.detach();
    return new SecureChannel(transport, { out: keys.initiator, in: keys.responder }, { id: hi2.id, name: cleanName(hi2.name) }, true, leftover);
  } catch (err) {
    reader.detach();
    transport.close();
    throw err;
  }
}

// Answer a connection. pairingCode() returns the code on screen, or null when pairing isn't open.
async function accept(transport, { identity, name, authorize, pairingCode = () => null, onPaired = () => {}, onPairFailed = () => {} }) {
  const deadline = Date.now() + HANDSHAKE_MS;
  const reader = new Reader(transport);
  const refuse = (error) => { sendJson(transport, { t: 'err', error }); throw new Error(error); };
  try {
    const hi = await reader.json(deadline);
    if (hi.t !== 'hi' || hi.v !== 1 || !isKey(hi.id) || !isKey(hi.eph) || typeof hi.n !== 'string') refuse('Not a LocalPilot handshake.');
    const mode = hi.mode === 'pair' ? 'pair' : 'session';
    const code = mode === 'pair' ? pairingCode() : null;
    if (mode === 'pair' && !code) refuse('Pairing isn\'t open on that machine. Turn on sharing there and show the pairing code.');
    if (mode === 'session' && !authorize(hi.id)) refuse('That machine isn\'t paired with you.');
    const eph = c.ephemeral();
    const hi2 = { t: 'hi2', id: identity.id, eph: eph.pub, n: c.b64u(crypto.randomBytes(16)), name };
    const T = transcriptOf(mode, hi, hi2);
    hi2.sig = c.sign(identity, `${T}|R`);
    let key = null;
    if (mode === 'pair') {
      key = await c.pairingKey(code, `${hi.n}|${hi2.n}`);
      hi2.mac = c.hmac(key, `R|${T}`);
    }
    sendJson(transport, hi2);
    const hi3 = await reader.json(deadline);
    if (hi3.t !== 'hi3' || !c.verify(hi.id, `${T}|I`, hi3.sig)) refuse('The other machine failed to prove who it is.');
    if (mode === 'pair') {
      if (!hi3.mac || !c.safeEqual(hi3.mac, c.hmac(key, `I|${T}`))) {
        onPairFailed();
        refuse('That code doesn\'t match.');
      }
      onPaired({ id: hi.id, name: cleanName(hi.name) });
    }
    sendJson(transport, { t: 'ok' });
    const keys = c.sessionKeys(c.sharedSecret(eph, hi.eph), T);
    const leftover = reader.detach();
    return new SecureChannel(transport, { out: keys.responder, in: keys.initiator }, { id: hi.id, name: cleanName(hi.name) }, false, leftover);
  } catch (err) {
    reader.detach();
    setTimeout(() => transport.close(), 50);  // let the error reach the other side first
    throw err;
  }
}

class Stream extends EventEmitter {
  constructor(channel, id, meta) {
    super();
    this.channel = channel;
    this.id = id;
    this.meta = meta;
    this.ended = false;
  }

  json(obj) { if (!this.ended) this.channel._send(F.JSON, this.id, Buffer.from(JSON.stringify(obj))); }
  data(buf) { if (!this.ended) this.channel._send(F.DATA, this.id, buf); }

  end(info = {}) {
    if (this.ended) return;
    this.ended = true;
    this.channel._send(F.END, this.id, Buffer.from(JSON.stringify(info)));
    this.channel.streams.delete(this.id);
  }

  _remoteEnd(info) {
    if (this.ended) return;
    this.ended = true;
    this.channel.streams.delete(this.id);
    this.emit('end', info);
  }
}

class SecureChannel extends EventEmitter {
  constructor(transport, keys, peer, initiator, leftover = []) {
    super();
    this.transport = transport;
    this.out = new c.FrameCipher(keys.out);
    this.in = new c.FrameCipher(keys.in);
    this.peer = peer;
    this.initiator = initiator;
    this.nextId = initiator ? 1 : 2;
    this.streams = new Map();
    this.pings = new Map();
    this.rtt = null;
    this.closed = false;
    transport.on('message', (buf) => this._receive(buf));
    transport.on('close', () => this._closed());
    // Frames that arrived during the handshake are handled once the owner has attached listeners.
    setImmediate(() => leftover.forEach((buf) => this._receive(buf)));
  }

  get buffered() { return this.transport.buffered ?? 0; }

  open(kind, meta = {}) {
    const id = this.nextId;
    this.nextId += 2;
    const stream = new Stream(this, id, { kind, ...meta });
    this.streams.set(id, stream);
    this._send(F.OPEN, id, Buffer.from(JSON.stringify({ kind, ...meta })));
    return stream;
  }

  ctrl(obj) { this._send(F.CTRL, 0, Buffer.from(JSON.stringify(obj))); }

  ping(timeoutMs = 5000) {
    const id = crypto.randomBytes(8);
    const key = id.toString('hex');
    const started = process.hrtime.bigint();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pings.delete(key); resolve(null); }, timeoutMs);
      this.pings.set(key, () => {
        clearTimeout(timer);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        this.rtt = this.rtt == null ? ms : this.rtt * 0.7 + ms * 0.3;
        resolve(ms);
      });
      this._send(F.PING, 0, id);
    });
  }

  close() { this.transport.close(); }

  _send(type, streamId, payload) {
    if (this.closed) return;
    const head = Buffer.alloc(5);
    head.writeUInt8(type, 0);
    head.writeUInt32BE(streamId, 1);
    this.transport.send(this.out.seal(Buffer.concat([head, payload])));
  }

  _receive(sealed) {
    if (this.closed) return;
    let frame;
    try {
      frame = this.in.open(sealed);
    } catch {
      this.close();  // tampered with or out of order
      return;
    }
    const type = frame.readUInt8(0);
    const id = frame.readUInt32BE(1);
    const payload = frame.subarray(5);
    const parse = () => { try { return JSON.parse(payload.toString('utf8')); } catch { return {}; } };
    if (type === F.PING) return this._send(F.PONG, 0, payload);
    if (type === F.PONG) return this.pings.get(payload.toString('hex'))?.();
    if (type === F.CTRL) return this.emit('ctrl', parse());
    if (type === F.OPEN) {
      const meta = parse();
      const stream = new Stream(this, id, meta);
      this.streams.set(id, stream);
      return this.emit('stream', stream, meta);
    }
    const stream = this.streams.get(id);
    if (!stream) return;
    if (type === F.JSON) stream.emit('json', parse());
    else if (type === F.DATA) stream.emit('data', payload);
    else if (type === F.END) stream._remoteEnd(parse());
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    for (const s of [...this.streams.values()]) s._remoteEnd({ error: `Lost the connection to ${this.peer.name}.` });
    this.emit('close');
  }
}

module.exports = { initiate, accept, wsTransport, SecureChannel };
