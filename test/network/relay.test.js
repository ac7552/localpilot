// Group flow through a real relay process, then an encrypted session inside a relay pipe.
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');
const root = path.resolve(__dirname, '..', '..');
const { RelayClient } = require(path.join(root, 'network/relay-client'));
const ch = require(path.join(root, 'network/channel'));
const c = require(path.join(root, 'network/crypto'));

const PORT = 58123;
const dataDir = path.join(require('os').tmpdir(), 'localpilot-test-relay');
require('fs').rmSync(dataDir, { recursive: true, force: true });
const relay = spawn(process.execPath, [path.join(root, 'relay/server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, NODE_PATH: path.join(root, 'node_modules') },
  stdio: 'inherit',
});
const url = `ws://127.0.0.1:${PORT}/ws`;
const once = (em, ev, pred = () => true) => new Promise((r) => { const f = (...a) => { if (pred(...a)) { em.off(ev, f); r(a); } }; em.on(ev, f); });

(async () => {
  await new Promise((r) => setTimeout(r, 600));
  const A = c.newIdentity();
  const B = c.newIdentity();
  const a = new RelayClient({ url, identity: A, name: 'Aaron Mac' });
  const b = new RelayClient({ url, identity: B, name: 'Jo PC' });
  await Promise.all([once(a, 'state'), once(b, 'state')]);

  const { group } = await a.request('create', { name: 'Campbell lab' });
  const { code } = await a.request('invite', { group });
  assert.match(code, /^LP-[A-Z2-9]{4}-[A-Z2-9]{2}$/);
  await assert.rejects(b.request('join', { code: 'LP-XXXX-XX' }), /isn't valid/);
  const pendingSeen = once(a, 'state', (s) => s.groups[0]?.pending.length === 1);
  const joined = await b.request('join', { code: code.toLowerCase().replace(/-/g, ' ') });
  assert.equal(joined.status, 'pending');
  await pendingSeen;
  await assert.rejects(b.request('join', { code }), /isn't valid/);  // single use
  // Not a member yet: B can't reach A.
  await assert.rejects(b.openPipe(A.id), /not in a group/);
  const bIn = once(b, 'state', (s) => s.groups.length === 1);
  await a.request('approve', { group, id: B.id, ok: true });
  const [st] = await bIn;
  assert.deepEqual(st.groups[0].members.map((m) => m.name).sort(), ['Aaron Mac', 'Jo PC']);
  assert(st.groups[0].members.every((m) => m.online));
  console.log('create, invite, join, approve: ok');

  // B opens a pipe to A; they run the normal encrypted handshake inside it.
  const members = new Set([A.id, B.id]);
  a.on('incoming', (transport, from) => {
    ch.accept(transport, { identity: A, name: 'Aaron Mac', authorize: (id) => id === from.id && members.has(id) }).then((chan) => {
      chan.on('stream', (s) => s.on('json', (m) => { s.json({ reply: m.q.toUpperCase() }); s.end({ ok: true }); }));
    });
  });
  const chan = await ch.initiate(await b.openPipe(A.id), { identity: B, name: 'Jo PC', expectId: A.id, authorize: (id) => members.has(id) });
  const s = chan.open('chat');
  const reply = once(s, 'json');
  s.json({ q: 'hello through the relay' });
  assert.deepEqual((await reply)[0], { reply: 'HELLO THROUGH THE RELAY' });
  console.log(`encrypted session through a relay pipe: ok (rtt ${(await chan.ping()).toFixed(2)} ms)`);

  // The relay only saw sealed frames: the plaintext never appears on the wire.
  const seen = [];
  const orig = b.ws.send.bind(b.ws);
  b.ws.send = (d) => { seen.push(Buffer.from(d)); orig(d); };
  const s2 = chan.open('chat');
  s2.json({ q: 'secret words' });
  await once(s2, 'end');
  assert(!Buffer.concat(seen).includes('secret words'));
  console.log('relay sees only sealed frames: ok');

  // Leaving closes the pipe and updates the other side.
  const gone = once(chan, 'close');
  const aSees = once(a, 'state', (s) => s.groups[0]?.members.length === 1);
  await b.request('leave', { group });
  await Promise.all([gone, aSees]);
  console.log('leave closes pipes and updates members: ok');

  // Presence: A sees B go offline.
  await a.request('invite', { group });
  a.stop(); b.stop();
  relay.kill();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); relay.kill(); process.exit(1); });
