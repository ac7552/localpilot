// LocalPilot relay: lets LocalPilot machines in the same group reach each other from anywhere.
//
// Every app keeps one outgoing WebSocket here and proves its identity by signing a challenge with
// its device key; there are no accounts or passwords. The relay keeps groups (member keys and
// device names), hands out single-use invite codes, and pipes bytes between two members of the
// same group. The apps encrypt everything end to end inside those pipes, so the relay only
// forwards frames it can't read.
//
// Text messages are JSON commands; binary messages are pipe data: [pipe u32][payload].

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_MB_PER_MIN = Number(process.env.MAX_MB_PER_MIN || 300);  // per device, both directions
const MAX_GROUPS_PER_DEVICE = 10;
const MAX_MEMBERS = 20;
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  // no 0/O or 1/I/L

// ---------- storage ----------

const storeFile = path.join(DATA_DIR, 'relay.json');
let db = { groups: {}, invites: {} };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(storeFile, 'utf8')) };
} catch { /* first start */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${storeFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, storeFile);
  }, 200);
}

function pruneInvites() {
  const now = Date.now();
  for (const [code, inv] of Object.entries(db.invites)) if (inv.expires < now || !db.groups[inv.group]) delete db.invites[code];
}

// ---------- helpers ----------

const isKey = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64) || 'Unnamed';
const newId = () => crypto.randomBytes(9).toString('base64url');
const newCode = () => {
  const pick = () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `LP-${Array.from({ length: 4 }, pick).join('')}-${pick()}${pick()}`;
};
const normCode = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function verify(id, data, sig) {
  try {
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: id }, format: 'jwk' });
    return crypto.verify(null, Buffer.from(data), key, Buffer.from(String(sig), 'base64url'));
  } catch {
    return false;
  }
}

// Allow `limit` events per `windowMs` for a key.
const buckets = new Map();
function allowed(key, limit, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

const groupsOf = (id) => Object.values(db.groups).filter((g) => g.members[id]);
const shareGroup = (a, b) => groupsOf(a).some((g) => g.members[b]);

// ---------- connections ----------

const devices = new Map();  // id -> conn

function sendJson(conn, obj) {
  if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(obj));
}

function stateFor(id) {
  const view = (g) => ({
    id: g.id, name: g.name, owner: g.owner,
    members: Object.entries(g.members).map(([mid, m]) => ({ id: mid, name: m.name, online: devices.has(mid) })),
    pending: Object.entries(g.pending).map(([pid, p]) => ({ id: pid, name: p.name, at: p.at })),
  });
  const waiting = Object.values(db.groups).filter((g) => g.pending[id]).map((g) => ({ id: g.id, name: g.name }));
  return { t: 'state', you: id, groups: groupsOf(id).map(view), waiting };
}

function pushState(ids) {
  for (const id of new Set(ids)) {
    const conn = devices.get(id);
    if (conn) sendJson(conn, stateFor(id));
  }
}

const everyoneIn = (g) => [...Object.keys(g.members), ...Object.keys(g.pending)];
const peersOf = (id) => groupsOf(id).flatMap((g) => Object.keys(g.members));

function closePipe(conn, pipe, notifyPeer = true) {
  const link = conn.pipes.get(pipe);
  if (!link) return;
  conn.pipes.delete(pipe);
  link.peer.pipes.delete(link.peerPipe);
  if (notifyPeer) sendJson(link.peer, { t: 'closed', pipe: link.peerPipe });
}

// Bandwidth per device, in a sliding minute.
function countBytes(conn, n) {
  const now = Date.now();
  if (now - conn.windowStart > 60_000) {
    conn.windowStart = now;
    conn.windowBytes = 0;
  }
  conn.windowBytes += n;
  return conn.windowBytes <= MAX_MB_PER_MIN * 1024 * 1024;
}

function handleCommand(conn, msg) {
  const id = conn.id;
  const reply = (obj) => sendJson(conn, { ...obj, rid: msg.rid });
  const fail = (error) => reply({ t: 'error', ref: msg.t, error });
  const group = typeof msg.group === 'string' ? db.groups[msg.group] : null;
  const member = group?.members[id];

  switch (msg.t) {
    case 'create': {
      if (groupsOf(id).length >= MAX_GROUPS_PER_DEVICE) return fail(`You can be in at most ${MAX_GROUPS_PER_DEVICE} groups.`);
      const g = { id: newId(), name: cleanName(msg.name || 'My group'), owner: id, created: Date.now(), members: { [id]: { name: conn.name, joined: Date.now() } }, pending: {} };
      db.groups[g.id] = g;
      save();
      reply({ t: 'created', group: g.id });
      return pushState([id]);
    }
    case 'invite': {
      if (!member) return fail('You\'re not in that group.');
      if (!allowed(`invite:${id}`, 20, 60 * 60 * 1000)) return fail('Too many invites. Try again in an hour.');
      pruneInvites();
      let code;
      do code = newCode(); while (db.invites[normCode(code)]);
      const expires = Date.now() + INVITE_TTL_MS;
      db.invites[normCode(code)] = { group: group.id, by: id, expires };
      save();
      return reply({ t: 'invite', group: group.id, code, expires });
    }
    case 'join': {
      if (!allowed(`join:${id}`, 10, 10 * 60 * 1000) || !allowed(`join-ip:${conn.ip}`, 30, 10 * 60 * 1000)) {
        return fail('Too many attempts. Try again in a few minutes.');
      }
      pruneInvites();
      const inv = db.invites[normCode(msg.code)];
      const g = inv && db.groups[inv.group];
      if (!g) return fail('That invite code isn\'t valid or has expired.');
      if (g.members[id]) return reply({ t: 'joined', group: g.id, status: 'member' });
      if (Object.keys(g.members).length >= MAX_MEMBERS) return fail(`That group is full (${MAX_MEMBERS} machines).`);
      delete db.invites[normCode(msg.code)];  // single use
      g.pending[id] = { name: conn.name, at: Date.now() };
      save();
      reply({ t: 'joined', group: g.id, status: 'pending' });
      return pushState(everyoneIn(g));
    }
    case 'approve': {
      if (!member) return fail('You\'re not in that group.');
      const pending = isKey(msg.id) && group.pending[msg.id];
      if (!pending) return fail('That request is no longer waiting.');
      delete group.pending[msg.id];
      if (msg.ok) group.members[msg.id] = { name: pending.name, joined: Date.now() };
      save();
      reply({ t: 'approved', group: group.id });
      return pushState([...everyoneIn(group), msg.id]);
    }
    case 'leave':
    case 'remove': {
      const target = msg.t === 'leave' ? id : msg.id;
      if (!group || !(group.members[target] || group.pending[target])) return fail('Not in that group.');
      if (msg.t === 'remove' && group.owner !== id) return fail('Only the group\'s owner can remove machines.');
      const notify = everyoneIn(group);
      delete group.members[target];
      delete group.pending[target];
      if (!Object.keys(group.members).length) delete db.groups[group.id];
      else if (group.owner === target) {
        group.owner = Object.entries(group.members).sort((a, b) => a[1].joined - b[1].joined)[0][0];
      }
      save();
      // Close pipes between machines that no longer share a group.
      for (const c of devices.values()) {
        for (const [pipe, link] of c.pipes) if (!shareGroup(c.id, link.peer.id)) closePipe(c, pipe);
      }
      reply({ t: 'left', group: group.id });
      return pushState(notify);
    }
    case 'rename-device': {
      conn.name = cleanName(msg.name);
      for (const g of groupsOf(id)) g.members[id].name = conn.name;
      save();
      return pushState([id, ...peersOf(id)]);
    }
    case 'connect': {
      const pipe = Number(msg.pipe);
      const target = isKey(msg.to) && devices.get(msg.to);
      if (!Number.isInteger(pipe) || pipe <= 0 || conn.pipes.has(pipe)) return fail('Bad pipe number.');
      if (!target || msg.to === id) return reply({ t: 'connect-failed', pipe, error: 'That machine isn\'t online.' });
      if (!shareGroup(id, msg.to)) return reply({ t: 'connect-failed', pipe, error: 'You\'re not in a group with that machine.' });
      if (conn.pipes.size >= 256) return reply({ t: 'connect-failed', pipe, error: 'Too many open connections.' });
      const peerPipe = target.nextPipe++;
      conn.pipes.set(pipe, { peer: target, peerPipe });
      target.pipes.set(peerPipe, { peer: conn, peerPipe: pipe });
      sendJson(target, { t: 'incoming', pipe: peerPipe, from: id, name: conn.name });
      return reply({ t: 'connected', pipe });
    }
    case 'close':
      return closePipe(conn, Number(msg.pipe));
    default:
      return fail('Unknown command.');
  }
}

function onBinary(conn, buf) {
  if (buf.length < 4) return;
  const pipe = buf.readUInt32BE(0);
  const link = conn.pipes.get(pipe);
  if (!link) return;
  if (!countBytes(conn, buf.length) || !countBytes(link.peer, buf.length)) {
    sendJson(conn, { t: 'error', ref: 'pipe', error: `Over the relay's limit of ${MAX_MB_PER_MIN} MB a minute.` });
    closePipe(conn, pipe);
    sendJson(conn, { t: 'closed', pipe });
    return;
  }
  const out = Buffer.from(buf);
  out.writeUInt32BE(link.peerPipe, 0);
  if (link.peer.ws.readyState === 1) link.peer.ws.send(out);
}

// ---------- server ----------

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('LocalPilot relay');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!allowed(`conn:${ip}`, 60, 60_000)) return ws.close(1008, 'Too many connections');
  const challenge = crypto.randomBytes(24).toString('base64url');
  const conn = { ws, ip, id: null, name: null, pipes: new Map(), nextPipe: 1, alive: true, windowStart: Date.now(), windowBytes: 0 };
  ws.on('pong', () => { conn.alive = true; });
  const authTimer = setTimeout(() => { if (!conn.id) ws.close(1008, 'No authentication'); }, 10_000);
  ws.send(JSON.stringify({ t: 'challenge', n: challenge }));

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (conn.id) onBinary(conn, Buffer.from(data));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (!conn.id) {
      if (msg.t !== 'auth' || !isKey(msg.id) || !verify(msg.id, `localpilot relay|${challenge}`, msg.sig)) {
        return ws.close(1008, 'Authentication failed');
      }
      clearTimeout(authTimer);
      conn.id = msg.id;
      conn.name = cleanName(msg.name);
      devices.get(conn.id)?.ws.close(4000, 'Connected from somewhere else');
      devices.set(conn.id, conn);
      // Keep stored names current.
      for (const g of groupsOf(conn.id)) if (g.members[conn.id].name !== conn.name) { g.members[conn.id].name = conn.name; save(); }
      sendJson(conn, stateFor(conn.id));
      return pushState(peersOf(conn.id));
    }
    if (!allowed(`cmd:${conn.id}`, 120, 60_000)) return sendJson(conn, { t: 'error', ref: msg.t, rid: msg.rid, error: 'Slow down.' });
    handleCommand(conn, msg);
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    for (const pipe of [...conn.pipes.keys()]) closePipe(conn, pipe);
    if (conn.id && devices.get(conn.id) === conn) {
      devices.delete(conn.id);
      pushState(peersOf(conn.id));
    }
  });
  ws.on('error', () => {});
});

// Drop connections that stopped answering.
setInterval(() => {
  for (const ws of wss.clients) {
    const conn = [...devices.values()].find((c) => c.ws === ws);
    if (conn && !conn.alive) { ws.terminate(); continue; }
    if (conn) conn.alive = false;
    try { ws.ping(); } catch { /* closing */ }
  }
}, 25_000).unref();

server.listen(PORT, () => console.log(`LocalPilot relay listening on ${PORT}`));
