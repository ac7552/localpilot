// The app's one outgoing connection to the relay. It signs in with the device key, reconnects by
// itself after sleep or network changes, answers group commands, and opens pipes to other group
// members. A pipe behaves like any other transport, so the encrypted channel runs inside it
// unchanged and the relay only forwards sealed frames.

const { EventEmitter } = require('events');
const { WebSocket } = require('ws');
const c = require('./crypto');

class RelayClient extends EventEmitter {
  constructor({ url, identity, name }) {
    super();
    this.url = url;
    this.identity = identity;
    this.name = name;
    this.ws = null;
    this.connected = false;
    this.stopped = false;
    this.backoff = 1000;
    this.rid = 1;
    this.waiting = new Map();   // rid -> { resolve, reject, timer }
    this.pipes = new Map();     // pipe -> transport
    this.nextPipe = 1;
    this.state = null;
    this.error = null;
    this._connect();
  }

  _connect() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(this.url, { handshakeTimeout: 10_000, maxPayload: 4 * 1024 * 1024 });
    } catch (err) {
      this.error = `Bad relay address: ${err.message}`;
      this.emit('status');
      return;
    }
    this.ws = ws;
    ws.binaryType = 'nodebuffer';
    ws.on('message', (data, isBinary) => (isBinary ? this._binary(Buffer.from(data)) : this._text(data.toString('utf8'))));
    ws.on('close', () => this._closed());
    ws.on('error', (err) => {
      this.error = `Can't reach the relay (${err.code || err.message}).`;
      this.emit('status');
    });
  }

  _text(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === 'challenge') {
      this.ws.send(JSON.stringify({ t: 'auth', id: this.identity.id, name: this.name, sig: c.sign(this.identity, `localpilot relay|${msg.n}`) }));
      return;
    }
    if (msg.t === 'state') {
      this.connected = true;
      this.error = null;
      this.backoff = 1000;
      this.state = msg;
      this.emit('status');
      this.emit('state', msg);
      return;
    }
    if (msg.t === 'incoming') {
      const transport = this._pipe(msg.pipe);
      this.emit('incoming', transport, { id: msg.from, name: msg.name });
      return;
    }
    if (msg.t === 'closed') {
      this.pipes.get(msg.pipe)?._end();
      return;
    }
    if (msg.t === 'connect-failed') this.pipes.get(msg.pipe)?._end();
    const w = msg.rid != null && this.waiting.get(msg.rid);
    if (w) {
      this.waiting.delete(msg.rid);
      clearTimeout(w.timer);
      if (msg.t === 'error' || msg.t === 'connect-failed') w.reject(new Error(msg.error || 'The relay refused that.'));
      else w.resolve(msg);
    }
  }

  _binary(buf) {
    if (buf.length < 4) return;
    this.pipes.get(buf.readUInt32BE(0))?.emit('message', buf.subarray(4));
  }

  _closed() {
    const was = this.connected;
    this.connected = false;
    this.ws = null;
    for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(new Error('Lost the connection to the relay.')); }
    this.waiting.clear();
    for (const t of [...this.pipes.values()]) t._end();
    if (was) this.emit('status');
    if (this.stopped) return;
    setTimeout(() => this._connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30_000);
  }

  _pipe(pipe) {
    const t = new EventEmitter();
    t.send = (buf) => {
      if (!this.ws || this.ws.readyState !== 1) return;
      const head = Buffer.alloc(4);
      head.writeUInt32BE(pipe, 0);
      this.ws.send(Buffer.concat([head, buf]));
    };
    t.close = () => {
      if (!this.pipes.has(pipe)) return;
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'close', pipe }));
      t._end();
    };
    t._end = () => {
      if (!this.pipes.delete(pipe)) return;
      t.emit('close');
    };
    Object.defineProperty(t, 'buffered', { get: () => this.ws?.bufferedAmount ?? 0 });
    this.pipes.set(pipe, t);
    return t;
  }

  request(t, payload = {}, timeoutMs = 15_000) {
    if (!this.connected) return Promise.reject(new Error(this.error || 'Not connected to the relay.'));
    const rid = this.rid++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(rid); reject(new Error('The relay didn\'t answer.')); }, timeoutMs);
      this.waiting.set(rid, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ t, rid, ...payload }));
    });
  }

  // A transport to another group member, once the relay has linked the two of you.
  async openPipe(to) {
    const pipe = this.nextPipe++;
    const transport = this._pipe(pipe);
    try {
      await this.request('connect', { to, pipe });
    } catch (err) {
      transport._end();
      throw err;
    }
    return transport;
  }

  rename(name) {
    this.name = name;
    if (this.connected) this.ws.send(JSON.stringify({ t: 'rename-device', name }));
  }

  stop() {
    this.stopped = true;
    try { this.ws?.close(); } catch { /* already closed */ }
  }
}

module.exports = { RelayClient };
