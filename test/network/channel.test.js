// Pairing and session handshakes over a real local WebSocket, plus streams, control and ping.
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const { WebSocketServer, WebSocket } = require(path.join(root, 'node_modules/ws'));
const ch = require(path.join(root, 'network/channel'));
const c = require(path.join(root, 'network/crypto'));
const assert = require('assert');

const helper = { ...c.newIdentity() };
const host = { ...c.newIdentity() };
const paired = new Set();
let code = '482913';

const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
wss.on('connection', (ws) => {
  ch.accept(ch.wsTransport(ws), {
    identity: helper, name: 'Helper', authorize: (id) => paired.has(id),
    pairingCode: () => code, onPaired: ({ id }) => paired.add(id),
  }).then((chan) => {
    chan.on('stream', (s, meta) => {
      s.on('json', (m) => s.json({ echo: m, meta }));
      s.on('data', (b) => { s.data(Buffer.concat([b, b])); s.end({ ok: true }); });
    });
    chan.on('ctrl', (m) => chan.ctrl({ got: m }));
  }).catch(() => {});
});

const connect = () => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
  ws.on('open', () => resolve(ch.wsTransport(ws)));
});

(async () => {
  if (!wss.address()) await new Promise((r) => wss.once('listening', r));
  // A session before pairing is refused.
  await assert.rejects(ch.initiate(await connect(), { identity: host, name: 'Host', authorize: () => true }), /isn't paired/);
  // The wrong code fails on the host's side, before anything is stored.
  let t0 = Date.now();
  await assert.rejects(ch.initiate(await connect(), { identity: host, name: 'Host', mode: 'pair', code: '111111' }), /doesn't match/);
  console.log(`wrong code rejected (${Date.now() - t0} ms)`);
  assert(!paired.has(host.id));
  // The right code pairs.
  const pchan = await ch.initiate(await connect(), { identity: host, name: 'Host', mode: 'pair', code: '482 913' });
  assert.equal(pchan.peer.id, helper.id);
  assert(paired.has(host.id));
  pchan.close();
  code = null;
  console.log('paired with the right code');
  // Now a normal session works, and only with the expected machine.
  await assert.rejects(ch.initiate(await connect(), { identity: host, name: 'Host', expectId: host.id }), /different machine/);
  const chan = await ch.initiate(await connect(), { identity: host, name: 'Host', expectId: helper.id, authorize: (id) => id === helper.id });
  const s = chan.open('test', { a: 1 });
  const got = new Promise((resolve) => {
    const out = {};
    s.on('json', (m) => { out.json = m; });
    s.on('data', (b) => { out.data = b.toString(); });
    s.on('end', (info) => resolve({ ...out, info }));
  });
  s.json({ hello: 'world' });
  s.data(Buffer.from('ab'));
  const r = await got;
  assert.deepEqual(r.json, { echo: { hello: 'world' }, meta: { kind: 'test', a: 1 } });
  assert.equal(r.data, 'abab');
  assert.deepEqual(r.info, { ok: true });
  const ctrl = new Promise((resolve) => chan.once('ctrl', resolve));
  chan.ctrl({ models: [] });
  assert.deepEqual(await ctrl, { got: { models: [] } });
  const rtt = await chan.ping();
  assert(rtt != null && rtt < 100);
  console.log(`session: streams, control and ping work (rtt ${rtt.toFixed(2)} ms)`);
  // Closing ends open streams with an error.
  const s2 = chan.open('test');
  const ended = new Promise((resolve) => s2.on('end', resolve));
  chan.close();
  assert.match((await ended).error, /Lost the connection/);
  console.log('closing ends open streams');
  wss.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
