// Connect: sharing models and memory with other LocalPilot machines.
//
// - Home network: a machine that shares listens on LAN_PORT and announces itself with Bonjour.
//   Others pair with it once using the 6-digit code it shows, then reconnect by themselves.
// - Remote groups: every machine keeps one connection to the relay (see relay/), which links two
//   members of the same group. Machines on the same network still talk directly.
// - Either way the link is an encrypted channel (channel.js). Over it a machine advertises what
//   it shares, serves chat requests with its loaded model (owners first), and tunnels llama.cpp
//   RPC so one model can be split across machines (a pooled model).

const { EventEmitter } = require('events');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const ch = require('./channel');
const c = require('./crypto');
const { RelayClient } = require('./relay-client');

const LAN_PORT = 55990;
const SERVICE = 'localpilot';
const PAIRING_MS = 5 * 60 * 1000;
const MAX_PAIR_FAILS = 3;
const SLOW_POOL_RTT_MS = 20;
const TUNNEL_HIGH_WATER = 8 * 1024 * 1024;

const DEFAULTS = {
  deviceName: '',
  share: { on: false, models: true, memory: false, memoryGiB: 6, onlyIdle: true },
  relayUrl: '',
  background: '',  // model key for background jobs; '' means the chat's model
};

const shortId = (id) => String(id).slice(0, 8);
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64);

function computerName() {
  try {
    return execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    return os.hostname().replace(/\.local$/, '');
  }
}

// Pipe a TCP socket through a channel stream, pausing the socket while the link is backed up.
function pipeSocket(stream, sock, chan) {
  sock.on('data', (buf) => {
    stream.data(buf);
    if (chan.buffered > TUNNEL_HIGH_WATER) {
      sock.pause();
      const t = setInterval(() => {
        if (chan.closed || chan.buffered < TUNNEL_HIGH_WATER / 4) {
          clearInterval(t);
          sock.resume();
        }
      }, 10);
    }
  });
  stream.on('data', (buf) => sock.write(buf));
  stream.on('end', () => sock.destroy());
  sock.on('close', () => stream.end({}));
  sock.on('error', () => {});
}

class NetworkManager extends EventEmitter {
  // local: what this machine can do for others and for itself (see main.js).
  constructor({ dataDir, readSettings, writeSettings, secure, local, discovery = true }) {
    super();
    this.useDiscovery = discovery;
    this.dir = path.join(dataDir, 'network');
    this.readSettings = readSettings;
    this.writeSettings = writeSettings;
    this.secure = secure;
    this.local = local;
    this.identity = this._loadIdentity();
    this.paired = this._readJson('peers.json', {});
    this.live = new Map();          // id -> { id, name, via, chan, adv }
    this.connecting = new Set();
    this.discovered = new Map();    // id -> { id, name, host, port }
    this.lastTried = new Map();     // id -> time of the last dial
    this.sticky = new Map();        // chat -> peer id, for "best available"
    this.serving = new Set();       // requests this machine is answering for others
    this.pairing = null;            // { code, expires, fails }
    this.localBusy = false;
    this.memFree = null;
    this.pool = null;
    this.rpc = null;                // { child, port }
    this.lan = { server: null, wss: null, port: null, error: null };
    this.relay = null;
    this.relayState = null;
    this.timer = null;
  }

  // ---------- settings & storage ----------

  settings() {
    const n = this.readSettings().network ?? {};
    return { ...DEFAULTS, ...n, share: { ...DEFAULTS.share, ...(n.share ?? {}) } };
  }

  _saveSettings(patch) {
    const s = this.readSettings();
    this.writeSettings({ ...s, network: { ...this.settings(), ...patch } });
  }

  get name() { return cleanName(this.settings().deviceName) || computerName() || 'This Mac'; }

  _readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8'));
    } catch {
      return fallback;
    }
  }

  _writeJson(file, value) {
    fs.mkdirSync(this.dir, { recursive: true });
    const p = path.join(this.dir, file);
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(value, null, 1), { mode: 0o600 });
    fs.renameSync(`${p}.tmp`, p);
  }

  // The device key, kept encrypted with the macOS Keychain when that's available.
  _loadIdentity() {
    const stored = this._readJson('identity.json', null);
    try {
      if (stored?.sealed && this.secure.available()) return JSON.parse(this.secure.decrypt(Buffer.from(stored.sealed, 'base64')));
      if (stored?.jwk) return { id: stored.id, jwk: stored.jwk };
    } catch { /* unreadable: make a new one */ }
    const identity = c.newIdentity();
    const record = this.secure.available()
      ? { id: identity.id, sealed: this.secure.encrypt(JSON.stringify(identity)).toString('base64') }
      : { id: identity.id, jwk: identity.jwk };
    this._writeJson('identity.json', record);
    return identity;
  }

  // ---------- lifecycle ----------

  start() {
    if (this.useDiscovery) this._startDiscovery();
    this._applyShare();
    this._applyRelay();
    this.timer = setInterval(() => this._tick(), 10_000);
    this._tick();
  }

  async stop() {
    clearInterval(this.timer);
    this.relay?.stop();
    for (const p of this.live.values()) p.chan.close();
    this._stopLan();
    try { this.browser?.stop(); this.bonjour?.destroy(); } catch { /* already stopped */ }
    await this.stopPool();
    this._stopRpcServer();
  }

  changed() {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.emit('state', this.snapshot()), 120);
  }

  // ---------- trust ----------

  groupMembers() {
    const ids = new Set();
    for (const g of this.relayState?.groups ?? []) for (const m of g.members) if (m.id !== this.identity.id) ids.add(m.id);
    return ids;
  }

  trusted(id) { return !!this.paired[id] || this.groupMembers().has(id); }

  // ---------- home network ----------

  _startDiscovery() {
    try {
      const { Bonjour } = require('bonjour-service');
      this.bonjour = new Bonjour();
      this.browser = this.bonjour.find({ type: SERVICE });
      const seen = (svc) => {
        const id = svc.txt?.id;
        if (!id || id === this.identity.id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return;
        const host = (svc.addresses ?? []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || svc.referer?.address;
        if (!host) return;
        let name = id;
        try { name = cleanName(decodeURIComponent(svc.txt.name || '')) || shortId(id); } catch { /* keep the id */ }
        this.discovered.set(id, { id, name, host, port: svc.port, seen: Date.now() });
        this.changed();
        this._tick();
      };
      this.browser.on('up', seen);
      this.browser.on('down', (svc) => { if (svc.txt?.id && this.discovered.delete(svc.txt.id)) this.changed(); });
    } catch (err) {
      this.discoveryError = `Can't look for machines on this network: ${err.message}`;
    }
  }

  _applyShare() {
    const share = this.settings().share;
    if (share.on && !this.lan.server) this._startLan();
    if (!share.on && this.lan.server) this._stopLan();
    if (!share.on || !share.memory) this._stopRpcServer();
    if (share.on && !this.pairing) this.newPairingCode();
    if (!share.on) this.pairing = null;
    if (share.on && share.memory) this._refreshMemory();
    this._advertiseAll();
    this.changed();
  }

  _startLan(port = LAN_PORT, attempt = 0) {
    const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ server, path: '/lp', maxPayload: 4 * 1024 * 1024 });
    wss.on('connection', (ws) => {
      ch.accept(ch.wsTransport(ws), {
        identity: this.identity,
        name: this.name,
        authorize: (id) => this.trusted(id),
        pairingCode: () => this._currentCode(),
        onPaired: (p) => this._addPaired(p, null),
        onPairFailed: () => this._pairFailed(),
      }).then((chan) => this._attach(chan, 'lan')).catch(() => {});
    });
    server.on('error', (err) => {
      // Fall back above 56000: the ports right after LAN_PORT belong to the engine.
      if (err.code === 'EADDRINUSE' && attempt < 10) return this._startLan(56000 + attempt, attempt + 1);
      this.lan = { server: null, wss: null, port: null, error: `Can't share on this network: ${err.message}` };
      this.changed();
    });
    server.listen(port, '0.0.0.0', () => {
      this.lan = { server, wss, port, error: null };
      try {
        this.published = this.bonjour?.publish({
          name: `LocalPilot ${shortId(this.identity.id)}`, type: SERVICE, port,
          txt: { id: this.identity.id, name: encodeURIComponent(this.name), v: '1' },
        });
      } catch { /* discovery is optional; Add by address still works */ }
      this.changed();
    });
  }

  _stopLan() {
    try { this.published?.stop?.(); } catch { /* not published */ }
    this.published = null;
    this.lan.wss?.close();
    this.lan.server?.close();
    this.lan = { server: null, wss: null, port: null, error: null };
  }

  newPairingCode() {
    this.pairing = { code: c.newPairingCode(), expires: Date.now() + PAIRING_MS, fails: 0 };
    this.changed();
    return this.pairing;
  }

  _currentCode() {
    const p = this.pairing;
    if (!p || Date.now() > p.expires || p.fails >= MAX_PAIR_FAILS) return null;
    return p.code;
  }

  _pairFailed() {
    if (!this.pairing) return;
    this.pairing.fails += 1;
    if (this.pairing.fails >= MAX_PAIR_FAILS) this.pairing.expires = 0;  // too many wrong codes: needs a new one
    this.changed();
  }

  _addPaired({ id, name }, addr) {
    this.paired[id] = { name: cleanName(name) || shortId(id), addr: addr ?? this.paired[id]?.addr ?? null, pairedAt: Date.now() };
    this._writeJson('peers.json', this.paired);
    if (this.pairing) this.pairing = { ...this.pairing, expires: 0 };  // codes are single use
    this.changed();
  }

  _dialLan(host, port, opts) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}:${port}/lp`, { handshakeTimeout: 5000, maxPayload: 4 * 1024 * 1024 });
      ws.once('open', () => ch.initiate(ch.wsTransport(ws), { identity: this.identity, name: this.name, ...opts }).then(resolve, reject));
      ws.once('error', (err) => reject(new Error(err.code === 'ECONNREFUSED' ? 'Nothing is listening there. Is sharing on?' : `Can't reach ${host}:${port} (${err.code || err.message}).`)));
    });
  }

  // Pair with a machine on this network, by its discovered id or a typed address.
  async pair({ id, address, code }) {
    let host;
    let port;
    if (id) {
      const d = this.discovered.get(id);
      if (!d) throw new Error('That machine isn\'t visible any more.');
      ({ host, port } = d);
    } else {
      const m = String(address ?? '').trim().match(/^\[?([^\]\s]+?)\]?(?::(\d{2,5}))?$/);
      if (!m) throw new Error('Enter an address like 192.168.1.20 or studio.local:55990.');
      host = m[1];
      port = Number(m[2] || LAN_PORT);
    }
    if (!/^\d{3}\s?\d{3}$/.test(String(code ?? '').trim())) throw new Error('Enter the 6-digit code shown on the other machine.');
    const chan = await this._dialLan(host, port, { mode: 'pair', code, expectId: id || null });
    this._addPaired(chan.peer, `${host}:${port}`);
    this._attach(chan, 'lan');
    return { id: chan.peer.id, name: chan.peer.name };
  }

  unpair(id) {
    delete this.paired[id];
    this._writeJson('peers.json', this.paired);
    const p = this.live.get(id);
    if (p && !this.groupMembers().has(id)) p.chan.close();
    this.changed();
  }

  rename(name) {
    this._saveSettings({ deviceName: cleanName(name) });
    this.relay?.rename(this.name);
    this._advertiseAll();
    if (this.lan.server) { this._stopLan(); this._startLan(); }
    this.changed();
  }

  // ---------- relay & groups ----------

  _applyRelay() {
    const url = this.settings().relayUrl;
    if (this.relay?.url === url) return;
    this.relay?.stop();
    this.relay = null;
    this.relayState = null;
    if (!url) return this.changed();
    this.relay = new RelayClient({ url, identity: this.identity, name: this.name });
    this.relay.on('status', () => this.changed());
    this.relay.on('state', (state) => {
      this.relayState = state;
      // Close links to machines we no longer share a group or pairing with.
      for (const p of this.live.values()) if (!this.trusted(p.id)) p.chan.close();
      this.changed();
      this._tick();
    });
    this.relay.on('incoming', (transport, from) => {
      ch.accept(transport, {
        identity: this.identity, name: this.name,
        authorize: (id) => id === from.id && this.groupMembers().has(id),
      }).then((chan) => this._attach(chan, 'relay')).catch(() => {});
    });
    this.changed();
  }

  setRelay(url) {
    const u = String(url ?? '').trim();
    if (u && !/^wss?:\/\/[^\s/]+(\/\S*)?$/.test(u)) throw new Error('Enter a relay address like wss://relay.example.com/ws.');
    this._saveSettings({ relayUrl: u });
    this._applyRelay();
  }

  async groupCommand(t, payload) {
    if (!this.relay) throw new Error('No relay is set up yet.');
    return this.relay.request(t, payload);
  }

  // ---------- links ----------

  // Keep one link per machine: a direct one beats one through the relay; between two of the same
  // kind, both sides keep the one started by the machine with the smaller id.
  _attach(chan, via) {
    const id = chan.peer.id;
    const existing = this.live.get(id);
    if (existing && !existing.chan.closed) {
      const starter = (x) => (x.chan.initiator ? this.identity.id : x.id);
      const keepNew = (via === 'lan' && existing.via === 'relay')
        || (via === existing.via && (chan.initiator ? this.identity.id : id) < starter(existing));
      if (!keepNew) return chan.close();
      existing.replaced = true;
      existing.chan.close();
    }
    const entry = { id, name: chan.peer.name, via, chan, adv: null };
    this.live.set(id, entry);
    if (this.paired[id] && this.paired[id].name !== entry.name) {
      this.paired[id].name = entry.name;
      this._writeJson('peers.json', this.paired);
    }
    chan.on('ctrl', (m) => {
      if (m.t !== 'adv') return;
      entry.adv = {
        sharing: !!m.sharing,
        busy: !!m.busy,
        models: (Array.isArray(m.models) ? m.models : []).slice(0, 20).map((x) => ({
          key: String(x.key ?? ''), name: cleanName(x.name) || String(x.key ?? ''), ctx: Number(x.ctx) || 0,
          vision: !!x.vision, arch: String(x.arch ?? ''),
        })).filter((x) => x.key),
        memory: m.memory ? { capMiB: Number(m.memory.capMiB) || 0, freeMiB: Number(m.memory.freeMiB) || 0 } : null,
      };
      if (m.name) entry.name = cleanName(m.name) || entry.name;
      this.changed();
    });
    chan.on('stream', (s, meta) => this._serve(entry, s, meta));
    const pinger = setInterval(() => chan.ping().then(() => this.changed()), 15_000);
    chan.ping().then(() => this.changed());
    chan.on('close', () => {
      clearInterval(pinger);
      if (this.live.get(id) === entry) this.live.delete(id);
      this.changed();
      if (!entry.replaced) setTimeout(() => this._tick(), 2000);
    });
    chan.ctrl(this._advert());
    this.changed();
  }

  // Dial machines we trust and aren't linked to yet.
  _tick() {
    const now = Date.now();
    const due = (id, every) => !this.live.has(id) && !this.connecting.has(id) && now - (this.lastTried.get(id) ?? 0) > every;
    const dial = (id, fn) => {
      this.connecting.add(id);
      this.lastTried.set(id, now);
      fn().then((chan) => this._attach(chan, chan.via)).catch(() => {}).finally(() => { this.connecting.delete(id); this.changed(); });
    };
    // Directly, when the machine is on this network and sharing (it's listening).
    for (const d of this.discovered.values()) {
      if (!this.trusted(d.id) || !due(d.id, 5000)) continue;
      if (this.lan.server && this.identity.id > d.id) continue;  // both listening: the smaller id dials
      dial(d.id, async () => Object.assign(await this._dialLan(d.host, d.port, { expectId: d.id, authorize: (x) => x === d.id }), { via: 'lan' }));
    }
    // By the address it was paired at, when Bonjour doesn't see it.
    for (const [id, p] of Object.entries(this.paired)) {
      if (!p.addr || this.discovered.has(id) || !due(id, 60_000)) continue;
      const [host, port] = [p.addr.slice(0, p.addr.lastIndexOf(':')), Number(p.addr.slice(p.addr.lastIndexOf(':') + 1))];
      dial(id, async () => Object.assign(await this._dialLan(host, port, { expectId: id, authorize: (x) => x === id }), { via: 'lan' }));
    }
    // Through the relay, for group members that are online elsewhere. The smaller id dials.
    if (this.relay?.connected) {
      for (const g of this.relayState?.groups ?? []) {
        for (const m of g.members) {
          if (m.id === this.identity.id || !m.online || this.discovered.has(m.id) || this.identity.id > m.id || !due(m.id, 5000)) continue;
          dial(m.id, async () => {
            const transport = await this.relay.openPipe(m.id);
            const chan = await ch.initiate(transport, { identity: this.identity, name: this.name, expectId: m.id, authorize: (x) => x === m.id });
            return Object.assign(chan, { via: 'relay' });
          });
        }
      }
    }
    if (this.settings().share.on && this.settings().share.memory) this._refreshMemory();
  }

  // ---------- what this machine shares ----------

  _advert() {
    const share = this.settings().share;
    const memory = share.on && share.memory && this.local.rpcServerPath()
      ? { capMiB: Math.round(share.memoryGiB * 1024), freeMiB: this.memFree ?? 0 }
      : null;
    return {
      t: 'adv', name: this.name, sharing: !!share.on,
      busy: this.localBusy && share.onlyIdle,
      models: share.on && share.models ? this.local.servableModels() : [],
      memory,
    };
  }

  _advertiseAll() {
    const adv = this._advert();
    for (const p of this.live.values()) p.chan.ctrl(adv);
  }

  localModelsChanged() {
    this._advertiseAll();
    this.changed();
  }

  // The owner is using this machine: others wait (or go elsewhere) while sharing is owners-first.
  setLocalBusy(busy) {
    if (this.localBusy === !!busy) return;
    this.localBusy = !!busy;
    if (busy && this.settings().share.onlyIdle) {
      for (const job of this.serving) {
        job.stream.end({ ok: false, busy: true, error: `${this.name}'s owner started using it.` });
        job.controller.abort();
      }
    }
    this._advertiseAll();
    this.changed();
  }

  async _refreshMemory() {
    if (this.memBusy || Date.now() - (this.memAt ?? 0) < 60_000) return;
    this.memBusy = true;
    try {
      const info = await this.local.memoryInfo();
      this.memAt = Date.now();
      if (info && info.freeMiB !== this.memFree) {
        this.memFree = info.freeMiB;
        this._advertiseAll();
        this.changed();
      }
    } finally {
      this.memBusy = false;
    }
  }

  setShare(patch) {
    const share = { ...this.settings().share, ...patch };
    share.memoryGiB = Math.max(1, Math.min(512, Number(share.memoryGiB) || DEFAULTS.share.memoryGiB));
    this._saveSettings({ share });
    this._applyShare();
  }

  _serve(peer, stream, meta) {
    if (meta.kind === 'chat') return this._serveChat(peer, stream, meta);
    if (meta.kind === 'rpc') return this._serveRpc(peer, stream);
    return stream.end({ ok: false, error: 'Unknown request.' });
  }

  _serveChat(peer, stream, meta) {
    const share = this.settings().share;
    if (!share.on || !share.models) return stream.end({ ok: false, error: `${this.name} isn't sharing models right now.` });
    if (this.localBusy && share.onlyIdle) return stream.end({ ok: false, busy: true, error: `${this.name}'s owner is using it right now.` });
    const body = meta.body;
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return stream.end({ ok: false, error: 'Bad request.' });
    if (!this.local.servableModels().some((m) => m.key === body.model)) {
      return stream.end({ ok: false, busy: true, error: `${this.name} doesn't have that model loaded any more.` });
    }
    const controller = new AbortController();
    const job = { controller, stream, peer: peer.name };
    this.serving.add(job);
    this.changed();
    stream.on('end', () => controller.abort());
    // Each remote chat gets its own warm cache on this machine's engine.
    const slot = `r-${shortId(peer.id).replace(/[^a-zA-Z0-9]/g, '')}-${String(meta.slotOwner ?? 'x').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)}`;
    this.local.streamCompletion({ body, slotOwner: slot, signal: controller.signal, onChunk: (chunk) => stream.json({ t: 'chunk', chunk }) })
      .then((res) => stream.end(res))
      .catch((err) => stream.end({ ok: false, error: err.message }))
      .finally(() => { this.serving.delete(job); this.changed(); });
  }

  async _ensureRpcServer() {
    if (this.rpc?.port && this.rpc.child.exitCode === null) return this.rpc.port;
    const bin = this.local.rpcServerPath();
    if (!bin) return null;
    const port = await new Promise((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    const { spawn } = require('child_process');
    const child = spawn(bin, ['-H', '127.0.0.1', '-p', String(port), '-c'], { stdio: 'ignore' });
    this.rpc = { child, port };
    child.on('exit', () => { if (this.rpc?.child === child) this.rpc = null; });
    for (let i = 0; i < 50; i++) {
      const ok = await new Promise((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); });
        s.on('error', () => resolve(false));
      });
      if (ok) return port;
      await new Promise((r) => setTimeout(r, 200));
    }
    this._stopRpcServer();
    return null;
  }

  _stopRpcServer() {
    try { this.rpc?.child.kill('SIGTERM'); } catch { /* already gone */ }
    this.rpc = null;
  }

  async _serveRpc(peer, stream) {
    const share = this.settings().share;
    if (!share.on || !share.memory) return stream.end({ ok: false, error: `${this.name} isn't sharing memory.` });
    // llama.cpp starts talking at once; keep what arrives while the worker starts.
    const early = [];
    const hold = (buf) => early.push(buf);
    stream.on('data', hold);
    const port = await this._ensureRpcServer();
    stream.off('data', hold);
    if (!port) return stream.end({ ok: false, error: `${this.name} can't run the pooled-model worker (llama.cpp with RPC isn't built there).` });
    const sock = net.connect(port, '127.0.0.1');
    early.forEach((buf) => sock.write(buf));
    pipeSocket(stream, sock, peer.chan);
  }

  // ---------- using other machines ----------

  static isRemoteKey(key) { return /^(remote|route):/.test(String(key ?? '')); }

  _scopeName(scope) {
    if (scope === 'lan') return 'this network';
    return this.relayState?.groups.find((g) => g.id === scope)?.name ?? 'your group';
  }

  _inScope(peer, scope) {
    if (scope === 'lan') return peer.via === 'lan';
    return !!this.relayState?.groups.find((g) => g.id === scope)?.members.some((m) => m.id === peer.id);
  }

  _candidates(scope) {
    return [...this.live.values()]
      .filter((p) => this._inScope(p, scope) && p.adv?.sharing && p.adv.models.length)
      .sort((a, b) => (a.adv.busy - b.adv.busy) || ((a.chan.rtt ?? 999) - (b.chan.rtt ?? 999)));
  }

  // Models other machines share, plus one "best available" entry per network or group.
  remoteModels() {
    const out = [];
    const scopes = new Set();
    for (const p of this.live.values()) {
      if (!p.adv?.sharing) continue;
      for (const m of p.adv.models) {
        out.push({
          modelKey: `remote:${p.id}:${m.key}`, displayName: m.name, contextLength: m.ctx, vision: m.vision,
          architecture: m.arch, engine: 'remote', peerId: p.id, peerName: p.name, via: p.via,
          rtt: p.chan.rtt == null ? null : Math.round(p.chan.rtt), busy: p.adv.busy,
          scopes: this._scopesOf(p),
        });
      }
      this._scopesOf(p).forEach((s) => scopes.add(s));
    }
    for (const scope of scopes) {
      const cands = this._candidates(scope);
      if (!cands.length) continue;
      const models = cands.flatMap((p) => p.adv.models);
      out.push({
        modelKey: `route:${scope}`, displayName: 'Best available', engine: 'remote', route: true,
        scopes: [scope], scopeName: this._scopeName(scope),
        free: cands.filter((p) => !p.adv.busy).length, machines: cands.length,
        contextLength: Math.min(...models.map((m) => m.ctx || 8192)),
        vision: models.every((m) => m.vision),
        architecture: models[0]?.arch ?? '',
      });
    }
    return out;
  }

  _scopesOf(p) {
    const s = [];
    if (p.via === 'lan') s.push('lan');
    for (const g of this.relayState?.groups ?? []) if (g.members.some((m) => m.id === p.id)) s.push(g.id);
    return s;
  }

  // Answer a chat request on another machine. onChunk gets the same chunks the local engine gives.
  async streamRemote({ body, slotOwner, signal, onChunk, onServed = () => {} }) {
    const key = String(body.model);
    let targets;
    let route = null;
    if (key.startsWith('remote:')) {
      const [, id, ...rest] = key.split(':');
      const p = this.live.get(id);
      if (!p) return { ok: false, error: `${this.paired[id]?.name ?? 'That machine'} isn't connected right now.` };
      targets = [{ peer: p, model: rest.join(':') }];
    } else {
      route = key.slice('route:'.length);
      const cands = this._candidates(route);
      const stuck = this.sticky.get(slotOwner);
      cands.sort((a, b) => (b.id === stuck) - (a.id === stuck));
      targets = cands.map((p) => {
        const prev = p.adv.models.find((m) => m.key === this.stickyModel?.get(slotOwner));
        return { peer: p, model: (prev ?? p.adv.models[0]).key };
      });
      if (!targets.length) return { ok: false, error: `No machine on ${this._scopeName(route)} is sharing a model right now.` };
    }
    let last = null;
    for (const t of targets) {
      if (signal?.aborted) return { ok: true, aborted: true };
      onServed({ peerId: t.peer.id, peerName: t.peer.name, model: t.model, via: t.peer.via });
      last = await this._requestChat(t, body, slotOwner, signal, onChunk);
      if (route && last.busy && !last.started) continue;  // try the next machine
      if (route && last.ok) {
        this.sticky.set(slotOwner, t.peer.id);
        (this.stickyModel ??= new Map()).set(slotOwner, t.model);
      }
      return last;
    }
    return { ok: false, error: `Every machine on ${this._scopeName(route)} is busy right now. ${last?.error ?? ''}`.trim() };
  }

  _requestChat({ peer, model }, body, slotOwner, signal, onChunk) {
    return new Promise((resolve) => {
      const stream = peer.chan.open('chat', { body: { ...body, model }, slotOwner });
      let started = false;
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve({ ...r, started }); } };
      stream.on('json', (m) => {
        if (m.t !== 'chunk') return;
        started = true;
        onChunk(m.chunk);
      });
      stream.on('end', (info) => finish({ ok: !!info.ok, error: info.error, aborted: !!info.aborted, busy: !!info.busy }));
      signal?.addEventListener('abort', () => { stream.end({ aborted: true }); finish({ ok: true, aborted: true }); }, { once: true });
    });
  }

  // ---------- pooled models ----------

  poolCandidates() {
    return [...this.live.values()].filter((p) => p.adv?.memory).map((p) => ({
      id: p.id, name: p.name, via: p.via, rtt: p.chan.rtt == null ? null : Math.round(p.chan.rtt),
      capMiB: p.adv.memory.capMiB, freeMiB: p.adv.memory.freeMiB,
    }));
  }

  // Speed if one model is split across this Mac and these machines: every token passes through
  // each of them and back, so it's limited by the round trips.
  async poolEstimate(ids) {
    const peers = [];
    for (const id of ids) {
      const p = this.live.get(id);
      if (!p?.adv?.memory) throw new Error(`${this.paired[id]?.name ?? 'A machine'} isn't sharing memory any more.`);
      const rtts = [];
      for (let i = 0; i < 3; i++) rtts.push(await p.chan.ping());
      const ok = rtts.filter((x) => x != null).sort((a, b) => a - b);
      peers.push({ id, name: p.name, via: p.via, rtt: ok.length ? ok[Math.floor(ok.length / 2)] : null, shareMiB: Math.min(p.adv.memory.capMiB, p.adv.memory.freeMiB || p.adv.memory.capMiB) });
    }
    const local = await this.local.memoryInfo();
    const netMs = peers.reduce((sum, p) => sum + 2 * (p.rtt ?? 100), 0);
    const tokPerSec = 1000 / (netMs + 45);
    return {
      peers,
      localMiB: local?.freeMiB ?? null,
      totalMiB: (local?.freeMiB ?? 0) + peers.reduce((s, p) => s + p.shareMiB, 0),
      tokPerSec: Math.round(tokPerSec * 10) / 10,
      slow: peers.some((p) => (p.rtt ?? 999) > SLOW_POOL_RTT_MS),
    };
  }

  async loadPool({ modelKey, contextLength, peerIds }) {
    await this.stopPool();
    const estimate = await this.poolEstimate(peerIds);
    const tunnels = [];
    for (const p of estimate.peers) {
      const peer = this.live.get(p.id);
      const server = net.createServer((sock) => {
        const live = this.live.get(p.id);
        if (!live) return sock.destroy();
        pipeSocket(live.chan.open('rpc'), sock, live.chan);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      tunnels.push({ server, port: server.address().port, name: peer.name, shareMiB: p.shareMiB });
    }
    // Starting the engine stops the previous one, so the new pool is recorded only once it runs.
    const res = await this.local.startPool({
      modelKey, contextLength,
      rpc: tunnels.map((t) => `127.0.0.1:${t.port}`),
      split: [estimate.localMiB ?? 8192, ...tunnels.map((t) => t.shareMiB)],
      peers: tunnels.map((t) => t.name),
    });
    if (res.ok) this.pool = { modelKey, peers: tunnels.map((t) => t.name), tunnels, slow: estimate.slow };
    else tunnels.forEach((t) => t.server.close());
    this.changed();
    return { ...res, slow: estimate.slow, tokPerSec: estimate.tokPerSec };
  }

  async stopPool() {
    if (!this.pool) return;
    for (const t of this.pool.tunnels) t.server.close();
    this.pool = null;
    this.changed();
  }

  // ---------- state for the window ----------

  snapshot() {
    const s = this.settings();
    const pairing = this._currentCode() ? { code: this.pairing.code, expires: this.pairing.expires } : null;
    const groups = (this.relayState?.groups ?? []).map((g) => ({
      ...g,
      mine: g.owner === this.identity.id,
      members: g.members.map((m) => {
        const p = this.live.get(m.id);
        return { ...m, me: m.id === this.identity.id, connected: !!p, via: p?.via ?? null, rtt: p?.chan.rtt == null ? null : Math.round(p.chan.rtt), adv: p?.adv ?? null };
      }),
    }));
    const lanPeers = new Map();
    for (const [id, p] of Object.entries(this.paired)) lanPeers.set(id, { id, name: p.name, paired: true, addr: p.addr });
    for (const d of this.discovered.values()) lanPeers.set(d.id, { ...lanPeers.get(d.id), id: d.id, name: lanPeers.get(d.id)?.name ?? d.name, discovered: true, host: d.host, port: d.port, paired: !!this.paired[d.id] });
    return {
      me: { id: this.identity.id, name: this.name },
      share: s.share,
      background: s.background,
      lan: { listening: !!this.lan.server, port: this.lan.port, error: this.lan.error || this.discoveryError || null },
      pairing,
      network: [...lanPeers.values()].map((p) => {
        const live = this.live.get(p.id);
        return { ...p, connected: !!live, connecting: this.connecting.has(p.id), via: live?.via ?? null, rtt: live?.chan.rtt == null ? null : Math.round(live.chan.rtt), adv: live?.adv ?? null };
      }).sort((a, b) => (b.paired - a.paired) || a.name.localeCompare(b.name)),
      relay: { url: s.relayUrl, connected: !!this.relay?.connected, error: this.relay?.error ?? null },
      groups,
      waiting: this.relayState?.waiting ?? [],
      serving: [...this.serving].map((j) => j.peer),
      pool: this.pool ? { modelKey: this.pool.modelKey, peers: this.pool.peers, slow: this.pool.slow } : null,
      poolCandidates: this.poolCandidates(),
      rpcAvailable: !!this.local.rpcServerPath(),
      online: [...this.live.values()].filter((p) => p.adv?.sharing).length,
    };
  }
}

module.exports = { NetworkManager, LAN_PORT };
