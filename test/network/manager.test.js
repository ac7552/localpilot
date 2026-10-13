// Connect end to end: Bonjour discovery, pairing, chat on another machine, owners first, a pooled model
// through a real llama.cpp RPC worker (needs ~/llama.cpp/build-rpc), reconnecting, and a group via the relay.
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..', '..');
const { NetworkManager } = require(path.join(root, 'network/manager'));

const base = path.join(os.tmpdir(), 'localpilot-test-network');
fs.rmSync(base, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}

const RPC_BIN = path.join(os.homedir(), 'llama.cpp/build-rpc/bin');
function machine(name, { models = [], discovery = true, rpc = false } = {}) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  let settings = { network: { deviceName: name } };
  const local = {
    models,
    busyLog: [],
    servableModels: () => local.models,
    async streamCompletion({ body, signal, onChunk }) {
      for (const w of [`${name} `, 'says ', `hi to ${body.messages.at(-1).content}`]) {
        if (signal.aborted) return { ok: true, aborted: true };
        await sleep(30);
        onChunk({ choices: [{ delta: { content: w } }] });
      }
      return { ok: true };
    },
    memoryInfo: async () => ({ freeMiB: 9000, totalMiB: 10000 }),
    rpcServerPath: () => (rpc ? path.join(RPC_BIN, 'ggml-rpc-server') : null),
    startPool: async (opts) => { local.pool = opts; return { ok: true }; },
  };
  const m = new NetworkManager({
    dataDir: dir,
    readSettings: () => settings,
    writeSettings: (s) => { settings = s; fs.writeFileSync(file, JSON.stringify(s)); },
    secure: { available: () => false },
    local,
    discovery,
  });
  m.local = local;
  return m;
}

async function ask(m, model, slotOwner = 'chat1', signal) {
  let text = '';
  let served = null;
  const res = await m.streamRemote({ body: { model, messages: [{ role: 'user', content: 'you' }] }, slotOwner, signal, onChunk: (c) => { text += c.choices[0].delta.content; }, onServed: (w) => { served = w.peerName; } });
  return { ...res, text, served };
}

(async () => {
  // ---------- home network ----------
  const studio = machine('Studio', { models: [{ key: 'qwen-27b', name: 'Qwen 27B', ctx: 32768, vision: false, arch: 'qwen35' }], rpc: true });
  const laptop = machine('Laptop');
  studio.start();
  laptop.start();
  studio.setShare({ on: true, models: true, memory: true, memoryGiB: 4 });
  const code = studio.snapshot().pairing.code;
  assert.match(code, /^\d{6}$/);
  const found = await until(() => laptop.snapshot().network.find((p) => p.name === 'Studio' && p.discovered), 15000, 'Bonjour discovery');
  console.log(`discovered Studio on this network at ${found.host}:${found.port}`);
  await assert.rejects(laptop.pair({ id: found.id, code: '000000' }), /doesn't match/);
  const paired = await laptop.pair({ id: found.id, code });
  assert.equal(paired.name, 'Studio');
  assert.equal(studio.snapshot().pairing, null, 'code is single use');
  await until(() => laptop.remoteModels().length === 2, 5000, 'advertised models');
  const models = laptop.remoteModels();
  console.log('Laptop sees:', models.map((m) => `${m.displayName} (${m.modelKey.split(':')[0]}${m.peerName ? ` on ${m.peerName}` : ''})`).join(', '));

  let r = await ask(laptop, models.find((m) => !m.route).modelKey);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Studio says hi to you');
  r = await ask(laptop, 'route:lan');
  assert.equal(r.served, 'Studio');
  console.log(`chat on Studio, direct and through Best available: "${r.text}"`);

  // Stop mid-answer.
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 40);
  r = await ask(laptop, 'route:lan', 'chat2', ac.signal);
  assert.equal(r.aborted, true);
  console.log('stopping mid-answer works');

  // Owners first: while Studio's owner works, requests are turned away.
  studio.setLocalBusy(true);
  await until(() => laptop.remoteModels().find((m) => m.route)?.free === 0, 5000, 'busy advert');
  r = await ask(laptop, 'route:lan');
  assert.equal(r.ok, false);
  console.log(`owner busy: "${r.error}"`);
  studio.setLocalBusy(false);
  await until(() => laptop.remoteModels().find((m) => m.route)?.free === 1, 5000, 'idle advert');

  // ---------- pooled model through the tunnel, with a real llama.cpp RPC worker ----------
  await until(() => laptop.snapshot().poolCandidates.length === 1, 5000, 'memory advert');
  const est = await laptop.poolEstimate([found.id]);
  console.log(`pool estimate: ${est.tokPerSec} tok/s, ${est.totalMiB} MiB total, slow=${est.slow}`);
  const pool = await laptop.loadPool({ modelKey: 'm', contextLength: 4096, peerIds: [found.id] });
  assert.equal(pool.ok, true);
  const opts = laptop.local.pool;
  assert.deepEqual(opts.split, [9000, 4096]);
  const devices = await new Promise((resolve) => {
    let out = '';
    const child = spawn(path.join(RPC_BIN, 'llama-server'), ['--rpc', opts.rpc[0], '--list-devices']);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('close', () => resolve(out));
    setTimeout(() => child.kill(), 30000);
  });
  const rpcLine = devices.split('\n').find((l) => /RPC0/.test(l));
  assert(rpcLine && /MiB free/.test(rpcLine), devices);
  console.log(`llama.cpp reached Studio's RPC worker through the encrypted tunnel: ${rpcLine.trim()}`);
  await laptop.stopPool();

  // ---------- restart: reconnects by itself, no code ----------
  await laptop.stop();
  const laptop2 = machine('Laptop');
  laptop2.start();
  await until(() => laptop2.remoteModels().length === 2, 20000, 'reconnect after restart');
  console.log('after a restart, Laptop reconnected to Studio without a code');
  await laptop2.stop();
  await studio.stop();

  // ---------- remote group through a relay ----------
  const PORT = 58124;
  const relay = spawn(process.execPath, [path.join(root, 'relay/server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(base, 'relay'), NODE_PATH: path.join(root, 'node_modules') }, stdio: 'ignore',
  });
  await sleep(500);
  const url = `ws://127.0.0.1:${PORT}/ws`;
  const jo = machine('Jo', { models: [{ key: 'gemma-12b', name: 'Gemma 12B', ctx: 16384, vision: true, arch: 'gemma4' }], discovery: false });
  const sam = machine('Sam', { discovery: false });
  jo.start(); sam.start();
  jo.setShare({ on: true });
  jo.setRelay(url); sam.setRelay(url);
  await until(() => jo.snapshot().relay.connected && sam.snapshot().relay.connected, 5000, 'relay connections');
  const { group } = await jo.groupCommand('create', { name: 'Campbell lab' });
  const { code: invite } = await jo.groupCommand('invite', { group });
  await sam.groupCommand('join', { code: invite });
  await until(() => jo.snapshot().groups[0]?.pending.length === 1, 5000, 'join request');
  await jo.groupCommand('approve', { group, id: sam.identity.id, ok: true });
  await until(() => sam.remoteModels().some((m) => m.modelKey === `route:${group}`), 10000, 'group link through the relay');
  const link = sam.snapshot().groups[0].members.find((m) => m.name === 'Jo');
  assert.equal(link.via, 'relay');
  r = await ask(sam, `route:${group}`);
  assert.equal(r.text, 'Jo says hi to you');
  console.log(`group "${sam.snapshot().groups[0].name}": Sam chats on Jo through the relay (${link.rtt} ms): "${r.text}"`);

  await jo.groupCommand('leave', { group: group });
  await until(() => sam.remoteModels().length === 0, 5000, 'link closed after leaving');
  console.log('leaving the group closes the link');
  await jo.stop(); await sam.stop();
  relay.kill();
  console.log('ALL PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
