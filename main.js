// LocalPilot main process: owns everything with real power (LM Studio, files, shell).
// The renderer only asks for things over IPC; workspace confinement is enforced here.

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { NetworkManager } = require('./network/manager');

const LMS = path.join(os.homedir(), '.lmstudio', 'bin', 'lms');
const LMS_MODELS = path.join(os.homedir(), '.lmstudio', 'models');
const API = 'http://localhost:1234/v1';

// LocalPilot's own engine: a local llama.cpp build (~/llama.cpp) patched to run
// Qwen3.5/3.6 on this Mac's GPU, which LM Studio's bundled llama.cpp crashes on.
const LLAMA_SERVER = path.join(os.homedir(), 'llama.cpp', 'build', 'bin', 'llama-server');
// The same llama.cpp built with RPC (cmake -DGGML_RPC=ON -B build-rpc): it splits a pooled model
// across machines, and its worker serves this Mac's memory to others.
const LLAMA_RPC_BIN = path.join(os.homedir(), 'llama.cpp', 'build-rpc', 'bin');
const ENGINE_PORT = 55991;
const ENGINE_API = `http://127.0.0.1:${ENGINE_PORT}/v1`;
const AUTO_ENGINE_ARCH = /^qwen3(5|6)/;
let engine = null;  // { child, modelKey, displayName, contextLength, ready, pooled? }
let network = null; // Connect: other machines (network/manager.js)
const MAX_TOOL_OUTPUT = 12000;
const MAX_READ_BYTES = 200_000;
// Give up on a stream when the engine goes quiet: a long window for the first token (prompt
// prefill can be slow on a big context), then a shorter gap between tokens once it's flowing.
// Without this, a wedged engine hangs the UI forever on "preparing …".
const STREAM_FIRST_TOKEN_MS = 300_000;
const STREAM_STALL_MS = 90_000;

let win;
const streams = new Map();   // requestId -> AbortController
const commands = new Map();  // requestId -> child process

// ---------- settings & chat storage ----------

const dataDir = () => app.getPath('userData');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const chatsDir = () => path.join(dataDir(), 'chats');

const DEFAULT_SETTINGS = {
  workspace: path.join(os.homedir(), 'projects'),
  model: '',
  effort: 'medium',
  mode: 'auto',
  contextLength: 16384,
  estimate: true,     // token and time estimate under the message box
  promptTips: true,   // prompt suggestions and Improve prompt
};

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(s) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

const safeChatId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '');

// ---------- lms CLI helpers ----------

function runLms(args, { onLine, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(LMS, args, { env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    const feed = (buf, isErr) => {
      const text = buf.toString();
      if (isErr) err += text; else out += text;
      if (onLine) text.split(/[\r\n]+/).filter(Boolean).forEach((l) => onLine(stripAnsi(l)));
    };
    child.stdout.on('data', (b) => feed(b, false));
    child.stderr.on('data', (b) => feed(b, true));
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: stripAnsi(out), err: stripAnsi(err) }); });
  });
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

function parseJson(text, fallback) {
  try {
    const start = text.indexOf('[');
    return JSON.parse(text.slice(start));
  } catch {
    return fallback;
  }
}

// ---------- workspace confinement ----------

async function resolveInWorkspace(rel) {
  const ws = await fsp.realpath(readSettings().workspace);
  const target = path.resolve(ws, rel || '.');
  // Resolve symlinks on the deepest existing ancestor so links can't escape the workspace.
  let probe = target;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const realProbe = await fsp.realpath(probe);
  const real = path.join(realProbe, path.relative(probe, target));
  if (real !== ws && !real.startsWith(ws + path.sep)) {
    throw new Error(`Path "${rel}" is outside the workspace (${ws}).`);
  }
  return real;
}

const clip = (s) => (s.length > MAX_TOOL_OUTPUT ? s.slice(0, MAX_TOOL_OUTPUT) + `\n…[truncated ${s.length - MAX_TOOL_OUTPUT} chars]` : s);

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'LocalPilot',
    backgroundColor: '#0f1115',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Never navigate the app window away; open web links in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

app.whenReady().then(() => {
  killOrphanEngines();
  createWindow();
  startNetwork();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
// Save the open chat's cache before the engine goes away, so it starts warm next launch.
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  const save = engine?.slotOwner ? saveSlot(engine.slotOwner) : Promise.resolve();
  Promise.race([save, new Promise((r) => setTimeout(r, 10_000))])
    .finally(() => Promise.resolve(network?.stop()).catch(() => {}).finally(() => stopEngine().finally(() => app.quit())));
});
process.on('exit', () => { try { engine?.child.kill('SIGKILL'); } catch { /* already gone */ } });

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

// ---------- IPC: settings, chats, workspace ----------

ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  const next = { ...readSettings(), ...patch };
  writeSettings(next);
  return next;
});

ipcMain.handle('workspace:choose', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose workspace folder',
    defaultPath: readSettings().workspace,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return readSettings();
  const next = { ...readSettings(), workspace: res.filePaths[0] };
  writeSettings(next);
  return next;
});

ipcMain.handle('workspace:reveal', () => shell.openPath(readSettings().workspace));

// First name from the macOS account, for the greeting.
ipcMain.handle('app:userName', () => {
  const { spawnSync } = require('child_process');
  const full = spawnSync('/usr/bin/id', ['-F'], { encoding: 'utf8' }).stdout?.trim() || '';
  return full.split(/\s+/)[0] || '';
});

ipcMain.handle('chats:list', async () => {
  await fsp.mkdir(chatsDir(), { recursive: true });
  const files = (await fsp.readdir(chatsDir())).filter((f) => f.endsWith('.json'));
  const chats = [];
  for (const f of files) {
    try {
      const c = JSON.parse(await fsp.readFile(path.join(chatsDir(), f), 'utf8'));
      chats.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, running: !!c.running });
    } catch { /* skip unreadable chat files */ }
  }
  return chats.sort((a, b) => b.updatedAt - a.updatedAt);
});

ipcMain.handle('chats:load', async (_e, id) => {
  return JSON.parse(await fsp.readFile(path.join(chatsDir(), safeChatId(id) + '.json'), 'utf8'));
});

ipcMain.handle('chats:save', async (_e, chat) => {
  await fsp.mkdir(chatsDir(), { recursive: true });
  await fsp.writeFile(path.join(chatsDir(), safeChatId(chat.id) + '.json'), JSON.stringify(chat));
  return true;
});

ipcMain.handle('chats:delete', async (_e, id) => {
  const chatId = safeChatId(id);
  await fsp.rm(path.join(chatsDir(), chatId + '.json'), { force: true });
  // Remove what was derived from the chat too: its saved cache, journal entry and rated answers.
  await fsp.rm(path.join(journalDir(), chatId + '.json'), { force: true });
  for (const dir of [kvDir(), examplesDir()]) {
    const files = await fsp.readdir(dir).catch(() => []);
    for (const f of files) if (f.startsWith(chatId + '-')) await fsp.rm(path.join(dir, f), { force: true });
  }
  if (engine?.slotOwner === chatId) engine.slotOwner = null;
  return true;
});

// ---------- IPC: models (via lms CLI) ----------

ipcMain.handle('server:ensure', async () => {
  const status = await runLms(['server', 'status'], { timeoutMs: 15_000 });
  if (/running/i.test(status.out + status.err) && !/not running/i.test(status.out + status.err)) return { ok: true };
  const start = await runLms(['server', 'start'], { timeoutMs: 60_000 });
  return { ok: start.code === 0, error: start.err || start.out };
});

// ---------- engine selection ----------

const engineAvailable = () => fs.existsSync(LLAMA_SERVER);

function engineFor(model) {
  const override = readSettings().engineOverrides?.[model.modelKey];
  if (override === 'llamacpp' && engineAvailable()) return 'llamacpp';
  if (override === 'lmstudio') return 'lmstudio';
  return AUTO_ENGINE_ARCH.test(model.architecture || '') && engineAvailable() ? 'llamacpp' : 'lmstudio';
}

async function listDownloaded() {
  const ls = await runLms(['ls', '--json'], { timeoutMs: 30_000 });
  downloadedCache = parseJson(ls.out, []).filter((m) => m.type === 'llm');
  return downloadedCache;
}

let downloadedCache = [];  // last `lms ls`, for model details without asking LM Studio again
let lmsLoaded = [];        // last `lms ps`: models LM Studio has loaded

async function refreshLmsLoaded() {
  const ps = await runLms(['ps', '--json'], { timeoutMs: 30_000 });
  lmsLoaded = parseJson(ps.out, []).filter((m) => m.type === 'llm').map((m) => ({ ...m, engine: 'lmstudio' }));
  network?.localModelsChanged();
}

// The models this Mac can answer with for other machines: whatever is loaded, except a pooled
// model (it already borrows other machines' memory).
function servableModels() {
  const details = (key) => downloadedCache.find((m) => m.modelKey === key) ?? {};
  const out = [];
  if (engine?.ready && !engine.pooled) {
    out.push({ key: engine.modelKey, name: engine.displayName, ctx: engine.contextLength, vision: engine.projector, arch: engine.architecture });
  }
  for (const m of lmsLoaded) {
    if (out.some((x) => x.key === m.modelKey)) continue;
    const d = details(m.modelKey);
    out.push({ key: m.modelKey, name: m.displayName || d.displayName || m.modelKey, ctx: m.contextLength || 0, vision: !!(m.vision ?? d.vision), arch: d.architecture || '' });
  }
  return out;
}

// GPU memory on this Mac, as llama.cpp sees it (it's what splits a pooled model).
async function memoryInfo() {
  const bin = rpcEngineAvailable() ? path.join(LLAMA_RPC_BIN, 'llama-server') : LLAMA_SERVER;
  if (!fs.existsSync(bin)) return null;
  const out = await new Promise((resolve) => {
    let text = '';
    const child = spawn(bin, ['--list-devices']);
    child.stdout.on('data', (b) => { text += b; });
    child.stderr.on('data', (b) => { text += b; });
    child.on('close', () => resolve(text));
    child.on('error', () => resolve(''));
    setTimeout(() => { try { child.kill(); } catch { /* done */ } }, 15_000);
  });
  const m = out.match(/^\s*(MTL\d|CUDA\d|Vulkan\d)[^(]*\((\d+) MiB, (\d+) MiB free\)/m);
  return m ? { device: m[1], totalMiB: Number(m[2]), freeMiB: Number(m[3]) } : null;
}

function rpcServerPath() {
  const bin = path.join(LLAMA_RPC_BIN, 'ggml-rpc-server');
  return fs.existsSync(bin) ? bin : null;
}

function stopEngine() {
  if (!engine) return Promise.resolve();
  const { child, pooled } = engine;
  engine = null;
  if (pooled) network?.stopPool();
  network?.localModelsChanged();
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } resolve(); }, 5000);
  });
}

// An engine left over from a crashed or force-quit LocalPilot keeps holding GPU memory
// and the port. Only match our own engine invocation, never other llama-server runs.
function killOrphanEngines() {
  const { spawnSync } = require('child_process');
  spawnSync('/usr/bin/pkill', ['-f', `${LLAMA_SERVER} .*--port ${ENGINE_PORT}`]);
  spawnSync('/usr/bin/pkill', ['-f', `${path.join(LLAMA_RPC_BIN, 'llama-server')} .*--port ${ENGINE_PORT}`]);
}

const rpcEngineAvailable = () => fs.existsSync(path.join(LLAMA_RPC_BIN, 'llama-server'));

// pool: { rpc: ['127.0.0.1:port', …], split: [MiB here, MiB on each machine…], peers: [names] }
// to split the model across machines (network/manager.js tunnels each address to one of them).
// vision: also load the image projector (~1 GB of GPU memory), so it's only loaded for chats with images.
function startEngine(model, contextLength, pool = null, { vision = false } = {}) {
  return new Promise((resolve) => {
    const args = [
      '-m', path.join(LMS_MODELS, model.path),
      '--alias', model.modelKey,
      '--host', '127.0.0.1', '--port', String(ENGINE_PORT),
      '-ngl', '99', '-c', String(contextLength), '-np', '1',
      // Qwen3.5/3.6 hybrids need matching batch sizes or output silently degrades.
      '-b', '512', '-ub', '512', '-fa', 'on', '--jinja', '--no-webui',
      // Reuse cached prompt prefixes across turns so replies start faster in long chats.
      '--cache-reuse', '256',
    ];
    // Qwen3.5/3.6 need a full-precision KV cache; other models fit ~2x the context with q8.
    if (!AUTO_ENGINE_ARCH.test(model.architecture || '')) args.push('-ctk', 'q8_0', '-ctv', 'q8_0');
    // Speed: a multi-token-prediction draft model, measured ~30% faster for Gemma 4 on this Mac.
    const MTP_DRAFTS = { gemma4: path.join(os.homedir(), 'models', 'mtp-gemma-4-12B-it.gguf') };
    const draft = MTP_DRAFTS[model.architecture];
    const hasDraft = !pool && !!draft && fs.existsSync(draft);
    if (hasDraft) args.push('-md', draft, '--spec-type', 'draft-mtp');
    // A pooled model: this Mac's GPU plus one RPC device per machine, each given its share.
    if (pool) {
      args.push('--rpc', pool.rpc.join(','));
      args.push('-dev', ['MTL0', ...pool.rpc.map((_, i) => `RPC${i}`)].join(','));
      args.push('-ts', pool.split.map((n) => Math.max(1, Math.round(n))).join(','));
    }
    // Keep at most 512 MiB of recent prompt states in RAM (the 8 GiB default is half this Mac,
    // and 2 GiB measurably slowed generation under memory pressure); each chat's cache is saved to disk. Slot files don't cover a draft model's state,
    // and aren't used for pooled models, whose state lives partly on other machines.
    args.push('--cache-ram', '512');
    if (!hasDraft && !pool) {
      fs.mkdirSync(kvDir(), { recursive: true });
      args.push('--slot-save-path', kvDir());
    }
    // Vision: load the projector file that sits next to the model, if there is one.
    // Pooled models keep it loaded, since they aren't reloaded per chat.
    let projector = false;
    if (vision || pool) try {
      const dir = path.dirname(path.join(LMS_MODELS, model.path));
      const mmproj = fs.readdirSync(dir).find((f) => /^mmproj.*\.gguf$/i.test(f) || /\.mmproj-.*\.gguf$/i.test(f));
      if (mmproj && model.vision) {
        args.push('--mmproj', path.join(dir, mmproj));
        projector = true;
      }
    } catch { /* no projector */ }
    const child = spawn(pool ? path.join(LLAMA_RPC_BIN, 'llama-server') : LLAMA_SERVER, args, { env: process.env });
    let log = '';
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const onData = (b) => {
      const text = b.toString();
      log = (log + text).slice(-8000);
      const tensors = text.match(/load_tensors:.*?(\d+)\/(\d+) layers/);
      if (tensors) send('models:loadProgress', { modelKey: model.modelKey, percent: Math.round((tensors[1] / tensors[2]) * 90) });
      if (/listening on/.test(text)) {
        engine.ready = true;
        send('models:loadProgress', { modelKey: model.modelKey, percent: 100 });
        finish({ ok: true });
        network?.localModelsChanged();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code, signal) => {
      if (engine?.child === child) {
        engine = null;
        if (pool) network?.stopPool();
        network?.localModelsChanged();
      }
      const reason = log.split('\n').reverse().find((l) => /GGML_ASSERT|GGML_ABORT|error|failed/i.test(l)) || `exit ${code ?? signal}`;
      finish({ ok: false, error: `Engine stopped while loading (${signal ?? code}): ${reason.trim()}` });
    });
    child.on('error', (err) => finish({ ok: false, error: `Could not start engine: ${err.message}` }));
    engine = {
      child, modelKey: model.modelKey, displayName: model.displayName, contextLength, ready: false,
      slotSave: !hasDraft && !pool, slotOwner: null,  // slotOwner: the chat whose prompt is in the cache now
      pooled: pool ? pool.peers : null,
      architecture: model.architecture, vision: !!model.vision, projector,
    };
    setTimeout(() => {
      if (!settled) {
        stopEngine();
        finish({ ok: false, error: 'Engine took more than 5 minutes to load the model.' });
      }
    }, 300_000);
  });
}

ipcMain.handle('models:list', async () => {
  const [downloaded, ps] = await Promise.all([
    listDownloaded(),
    runLms(['ps', '--json'], { timeoutMs: 30_000 }),
  ]);
  for (const m of downloaded) m.engine = engineFor(m);
  const loaded = parseJson(ps.out, []).filter((m) => m.type === 'llm').map((m) => ({ ...m, engine: 'lmstudio' }));
  lmsLoaded = loaded;
  if (engine?.ready) {
    loaded.push({ modelKey: engine.modelKey, displayName: engine.displayName, contextLength: engine.contextLength, engine: 'llamacpp', pooled: engine.pooled, projector: engine.projector });
  }
  return { downloaded, loaded, remote: network?.remoteModels() ?? [], engineAvailable: engineAvailable(), rpcAvailable: rpcEngineAvailable() };
});

ipcMain.handle('models:estimate', async (_e, { modelKey, contextLength }) => {
  const r = await runLms(['load', modelKey, '--gpu', 'max', '-c', String(contextLength), '--estimate-only', '-y'], { timeoutMs: 60_000 });
  const text = r.out + r.err;
  const gib = text.match(/Estimated Total Memory:\s*([\d.]+)\s*GiB/i);
  return { totalGiB: gib ? Number(gib[1]) : null, willFail: /will fail to load/i.test(text), raw: text.trim() };
});

// Split one model across this Mac and other machines' memory (called by network/manager.js).
async function startPooledModel({ modelKey, contextLength, rpc, split, peers }) {
  if (!rpcEngineAvailable()) {
    return { ok: false, error: 'Pooled models need llama.cpp built with RPC: cmake -S ~/llama.cpp -B ~/llama.cpp/build-rpc -DGGML_RPC=ON, then build llama-server and ggml-rpc-server.' };
  }
  if (engine?.slotOwner) await saveSlot(engine.slotOwner);
  await stopEngine();
  killOrphanEngines();
  await runLms(['unload', '--all'], { timeoutMs: 60_000 });
  refreshLmsLoaded().catch(() => {});
  const model = (await listDownloaded()).find((m) => m.modelKey === modelKey);
  if (!model) return { ok: false, error: 'That model isn\'t downloaded on this Mac.' };
  return startEngine(model, contextLength, { rpc, split, peers });
}

ipcMain.handle('models:load', async (_e, { modelKey, contextLength, vision }) => {
  // Only one model fits in GPU memory at a time, whichever engine runs it.
  if (engine?.slotOwner) await saveSlot(engine.slotOwner);
  await stopEngine();
  killOrphanEngines();
  await runLms(['unload', '--all'], { timeoutMs: 60_000 });

  const model = (await listDownloaded()).find((m) => m.modelKey === modelKey);
  if (model && engineFor(model) === 'llamacpp') return startEngine(model, contextLength, null, { vision });

  const r = await runLms(['load', modelKey, '--gpu', 'max', '-c', String(contextLength), '--parallel', '1', '-y'], {
    timeoutMs: 300_000,
    onLine: (line) => {
      const pct = line.match(/(\d{1,3})%/);
      if (pct) send('models:loadProgress', { modelKey, percent: Number(pct[1]) });
    },
  });
  const errorLine = (r.out + '\n' + r.err).split('\n').find((l) => /^Error/i.test(l.trim()));
  refreshLmsLoaded().catch(() => {});
  return { ok: r.code === 0 && !errorLine, error: errorLine || (r.code !== 0 ? (r.err || r.out).trim().slice(-600) : null) };
});

ipcMain.handle('models:setEngine', (_e, { modelKey, engine: choice }) => {
  const s = readSettings();
  const overrides = { ...(s.engineOverrides || {}) };
  if (choice === 'auto') delete overrides[modelKey];
  else overrides[modelKey] = choice;
  writeSettings({ ...s, engineOverrides: overrides });
  return true;
});

ipcMain.handle('models:unload', async () => {
  await stopEngine();
  const r = await runLms(['unload', '--all'], { timeoutMs: 60_000 });
  refreshLmsLoaded().catch(() => {});
  return { ok: r.code === 0 };
});

ipcMain.handle('models:download', async (_e, { query, requestId }) => {
  const r = await runLms(['get', query, '--gguf', '-y'], {
    timeoutMs: 6 * 60 * 60 * 1000,
    onLine: (line) => send('models:downloadProgress', { requestId, line }),
  });
  return { ok: r.code === 0, output: (r.out + r.err).trim().slice(-1500) };
});

// ---------- IPC: streaming chat completions ----------

ipcMain.handle('chat:stream', async (_e, { requestId, body, slotOwner = null }) => {
  const controller = new AbortController();
  streams.set(requestId, controller);
  const onChunk = (chunk) => send('chat:chunk', { requestId, chunk });
  try {
    if (NetworkManager.isRemoteKey(body.model)) {
      if (!network) return { ok: false, error: 'Connect isn\'t running.' };
      return await network.streamRemote({
        body, slotOwner, signal: controller.signal, onChunk,
        onServed: (who) => send('network:served', { requestId, slotOwner, ...who }),
      });
    }
    return await streamCompletion({ body, slotOwner, signal: controller.signal, onChunk });
  } finally {
    streams.delete(requestId);
    // This reply can reach the renderer before the last chunks (often the usage), so the renderer
    // waits for this marker, which comes after them on the same channel.
    send('chat:chunk', { requestId, chunk: {}, done: true });
  }
});

// Stream a chat completion from the LocalPilot engine or LM Studio, handing each parsed chunk to
// onChunk. Used for this Mac's own chats and for requests from other machines (Connect).
async function streamCompletion({ body, slotOwner = null, signal, onChunk }) {
  const onEngine = engine?.ready && engine.modelKey === body.model;
  if (onEngine) await prepareSlot(slotOwner ? safeChatId(slotOwner) : null);
  const base = onEngine ? ENGINE_API : API;
  const payload = { ...body, stream: true, stream_options: { include_usage: true } };
  if (onEngine && payload.reasoning_effort === 'none') {
    // llama-server switches thinking off through the chat template instead.
    delete payload.reasoning_effort;
    payload.chat_template_kwargs = { ...(payload.chat_template_kwargs || {}), enable_thinking: false };
  }
  // Watchdog: abort if the engine stops sending data. Chained to the caller's own abort signal.
  const ac = new AbortController();
  const onExternalAbort = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onExternalAbort); }
  let stalled = false;
  let gotChunk = false;
  let watchdog = null;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => { stalled = true; ac.abort(); }, gotChunk ? STREAM_STALL_MS : STREAM_FIRST_TOKEN_MS);
  };
  try {
    arm();
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `LM Studio returned ${res.status}: ${text.slice(0, 800)}` };
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let streamError = null;
    for await (const chunk of res.body) {
      gotChunk = true;
      arm();
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;  // ignore malformed keep-alive lines
        }
        // Engines report mid-stream failures (e.g. a crash) as an error event, not an HTTP status.
        if (parsed.error) {
          streamError = typeof parsed.error === 'string' ? parsed.error : (parsed.error.message || JSON.stringify(parsed.error));
          continue;
        }
        onChunk(parsed);
      }
    }
    if (streamError) {
      const crashed = /terminated|exited|crash/i.test(streamError);
      return {
        ok: false,
        error: crashed
          ? `The model engine crashed while answering ("${streamError}"). It may need to be reloaded — pick the model again from the dropdown.`
          : `The model engine reported an error: ${streamError}`,
      };
    }
    return { ok: true };
  } catch (err) {
    if (stalled) return { ok: false, error: `The model stopped responding (no output for ${Math.round(STREAM_STALL_MS / 1000)}s). The engine may be wedged — pick the model again from the dropdown to reload it.` };
    if (err.name === 'AbortError') return { ok: true, aborted: true };
    return { ok: false, error: `Could not reach ${onEngine ? 'the LocalPilot engine' : 'LM Studio'} at ${base}: ${err.message}` };
  } finally {
    clearTimeout(watchdog);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

// ---------- IPC: Connect (other machines) ----------

function startNetwork() {
  try {
    network = new NetworkManager({
      dataDir: dataDir(),
      readSettings,
      writeSettings,
      secure: {
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: (s) => safeStorage.encryptString(s),
        decrypt: (b) => safeStorage.decryptString(b),
      },
      local: { servableModels, streamCompletion, memoryInfo, rpcServerPath, startPool: startPooledModel },
    });
    network.on('state', (s) => send('network:state', { ...s, remoteModels: network.remoteModels() }));
    network.start();
    listDownloaded().then(refreshLmsLoaded).catch(() => {});
  } catch (err) {
    console.error('Connect failed to start:', err);
    network = null;
  }
}

// Each handler answers { ok, ...result } or { ok: false, error } so the window can show the reason.
const netCall = (fn) => async (_e, arg) => {
  if (!network) return { ok: false, error: 'Connect isn\'t running.' };
  try {
    return { ok: true, ...((await fn(arg ?? {})) ?? {}) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

ipcMain.handle('network:state', netCall(() => ({ state: { ...network.snapshot(), remoteModels: network.remoteModels() } })));
ipcMain.handle('network:setShare', netCall((patch) => network.setShare(patch)));
ipcMain.handle('network:newCode', netCall(() => network.newPairingCode()));
ipcMain.handle('network:pair', netCall((arg) => network.pair(arg)));
ipcMain.handle('network:unpair', netCall(({ id }) => network.unpair(id)));
ipcMain.handle('network:rename', netCall(({ name }) => network.rename(name)));
ipcMain.handle('network:setRelay', netCall(({ url }) => network.setRelay(url)));
ipcMain.handle('network:group', netCall(({ t, ...payload }) => {
  if (!['create', 'invite', 'join', 'approve', 'leave', 'remove'].includes(t)) throw new Error('Unknown group command.');
  return network.groupCommand(t, payload);
}));
ipcMain.handle('network:poolEstimate', netCall(({ peerIds }) => network.poolEstimate(peerIds ?? [])));
ipcMain.handle('network:loadPool', netCall((arg) => network.loadPool(arg)));
ipcMain.handle('network:setBackground', netCall(({ model }) => {
  const s = readSettings();
  writeSettings({ ...s, network: { ...(s.network ?? {}), background: String(model ?? '') } });
}));
ipcMain.handle('network:setBusy', (_e, busy) => { network?.setLocalBusy(!!busy); return true; });

ipcMain.handle('chat:abort', (_e, requestId) => {
  streams.get(requestId)?.abort();
  const child = commands.get(requestId);
  if (child) child.kill('SIGTERM');
  return true;
});

// Exact token count for the estimate under the message box. Only the LocalPilot engine is asked;
// for LM Studio the estimate is calibrated against the prompt sizes it reports instead.
ipcMain.handle('tokens:count', async (_e, { model, text }) => {
  if (!engine?.ready || engine.modelKey !== model) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${ENGINE_PORT}/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json.tokens) ? json.tokens.length : null;
  } catch {
    return null;
  }
});

// ---------- per-chat cache (LocalPilot engine) ----------
// The engine runs one slot, so another chat (or a background summary) throws the current
// chat's processed prompt away. Save it to disk first, and restore a chat's file when it comes
// back; llama-server then only processes what changed since. Files are per model and context.

const kvDir = () => path.join(dataDir(), 'kvcache');
const KV_BUDGET_BYTES = 3 * 1024 ** 3;

function kvFile(chatId) {
  const fp = crypto.createHash('sha1').update(`${engine.modelKey}|${engine.contextLength}`).digest('hex').slice(0, 10);
  return `${chatId}-${fp}.bin`;
}

async function slotAction(action, filename) {
  const res = await fetch(`http://127.0.0.1:${ENGINE_PORT}/slots/0?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename }),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json;
}

async function saveSlot(chatId) {
  if (!engine?.ready || !engine.slotSave || !chatId) return;
  try {
    await slotAction('save', kvFile(chatId));
    await pruneKvCache();
  } catch (err) {
    console.warn(`Could not save the cache for chat ${chatId}: ${err.message}`);
  }
}

async function restoreSlot(chatId) {
  const name = kvFile(chatId);
  const file = path.join(kvDir(), name);
  if (!fs.existsSync(file)) return;
  try {
    await slotAction('restore', name);
    const now = new Date();
    await fsp.utimes(file, now, now);  // most recently used survives pruning
  } catch (err) {
    console.warn(`Could not restore the cache for chat ${chatId}: ${err.message}`);
  }
}

async function prepareSlot(owner) {
  if (!engine?.slotSave || engine.slotOwner === owner) return;
  if (engine.slotOwner) await saveSlot(engine.slotOwner);
  engine.slotOwner = owner;
  if (owner) await restoreSlot(owner);
}

// Keep the cache folder under budget by dropping the least recently used files.
async function pruneKvCache() {
  const files = [];
  for (const f of await fsp.readdir(kvDir()).catch(() => [])) {
    try {
      const st = await fsp.stat(path.join(kvDir(), f));
      files.push({ f, size: st.size, mtime: st.mtimeMs });
    } catch { /* removed meanwhile */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  let total = 0;
  for (const { f, size } of files) {
    total += size;
    if (total > KV_BUDGET_BYTES) await fsp.rm(path.join(kvDir(), f), { force: true });
  }
}

// ---------- IPC: tools ----------

ipcMain.handle('tool:list_files', async (_e, { dir = '.', depth = 2 }) => {
  const root = await resolveInWorkspace(dir);
  const lines = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv']);
  async function walk(abs, rel, level) {
    if (lines.length > 400) return;
    const entries = (await fsp.readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env.example') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        lines.push(`${childRel}/`);
        if (level < depth && !skip.has(e.name)) await walk(path.join(abs, e.name), childRel, level + 1);
      } else {
        lines.push(childRel);
      }
    }
  }
  await walk(root, dir === '.' ? '' : dir.replace(/\/$/, ''), 1);
  return lines.length ? clip(lines.join('\n')) : '(empty directory)';
});

ipcMain.handle('tool:read_file', async (_e, { path: rel }) => {
  const abs = await resolveInWorkspace(rel);
  const stat = await fsp.stat(abs);
  if (stat.size > MAX_READ_BYTES) return `File is ${stat.size} bytes; too large to read in full.`;
  return clip(await fsp.readFile(abs, 'utf8'));
});

ipcMain.handle('tool:file_exists', async (_e, { path: rel }) => {
  const abs = await resolveInWorkspace(rel);
  try {
    return { exists: true, content: (await fsp.readFile(abs, 'utf8')).slice(0, MAX_READ_BYTES) };
  } catch {
    return { exists: false, content: '' };
  }
});

ipcMain.handle('tool:write_file', async (_e, { path: rel, content }) => {
  const abs = await resolveInWorkspace(rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content ?? '');
  return `Wrote ${Buffer.byteLength(content ?? '')} bytes to ${rel}`;
});

ipcMain.handle('tool:run_command', async (_e, { command, requestId, timeoutSec = 60 }) => {
  const cwd = await resolveInWorkspace('.');
  return new Promise((resolve) => {
    const child = spawn('/bin/zsh', ['-lc', command], { cwd, env: { ...process.env, TERM: 'dumb' } });
    commands.set(requestId, child);
    let out = '';
    const timer = setTimeout(() => {
      out += `\n[stopped after ${timeoutSec}s — long-running processes like dev servers should be started in your own Terminal]`;
      child.kill('SIGTERM');
    }, timeoutSec * 1000);
    const onData = (b) => {
      const text = b.toString();
      out += text;
      send('tool:commandOutput', { requestId, text });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      clearTimeout(timer);
      commands.delete(requestId);
      resolve(clip(`exit code: ${code}\n${out}`));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      commands.delete(requestId);
      resolve(`Failed to start command: ${err.message}`);
    });
  });
});

// ---------- checkpoints (undo) ----------
// Before any file change, remember the old contents so a whole agent run can be undone.

const checkpointsFile = (chatId) => path.join(dataDir(), 'checkpoints', safeChatId(chatId) + '.json');
const MAX_CHECKPOINT_BYTES = 20 * 1024 * 1024;

async function readCheckpoints(chatId) {
  try {
    return JSON.parse(await fsp.readFile(checkpointsFile(chatId), 'utf8'));
  } catch {
    return [];
  }
}

async function recordCheckpoint(chatId, runId, abs, rel) {
  if (!chatId || !runId) return;
  const runs = await readCheckpoints(chatId);
  let run = runs.find((r) => r.runId === runId);
  if (!run) {
    run = { runId, ts: Date.now(), files: [] };
    runs.push(run);
  }
  if (run.files.some((f) => f.abs === abs)) return;  // keep the oldest version within a run
  let existed = false;
  let content = null;
  try {
    content = await fsp.readFile(abs, 'utf8');
    existed = true;
  } catch { /* new file */ }
  run.files.push({ abs, rel, existed, content });
  // Drop the oldest runs if the history grows too large.
  while (runs.length > 1 && Buffer.byteLength(JSON.stringify(runs)) > MAX_CHECKPOINT_BYTES) runs.shift();
  await fsp.mkdir(path.dirname(checkpointsFile(chatId)), { recursive: true });
  await fsp.writeFile(checkpointsFile(chatId), JSON.stringify(runs));
}

ipcMain.handle('checkpoint:run', async (_e, { chatId, runId }) => {
  const run = (await readCheckpoints(chatId)).find((r) => r.runId === runId);
  return run ? run.files.map((f) => ({ rel: f.rel, existed: f.existed })) : [];
});

ipcMain.handle('checkpoint:undo', async (_e, { chatId, runId }) => {
  const runs = await readCheckpoints(chatId);
  const idx = runs.findIndex((r) => r.runId === runId);
  if (idx < 0) return { ok: false, error: 'Nothing to undo for this run.' };
  const restored = [];
  for (const f of [...runs[idx].files].reverse()) {
    if (f.existed) {
      await fsp.mkdir(path.dirname(f.abs), { recursive: true });
      await fsp.writeFile(f.abs, f.content);
      restored.push(`restored ${f.rel}`);
    } else {
      await fsp.rm(f.abs, { force: true });
      restored.push(`removed ${f.rel}`);
    }
  }
  runs.splice(idx, 1);
  await fsp.writeFile(checkpointsFile(chatId), JSON.stringify(runs));
  return { ok: true, restored };
});

ipcMain.handle('tool:write_file_tracked', async (_e, { path: rel, content, chatId, runId }) => {
  const abs = await resolveInWorkspace(rel);
  await recordCheckpoint(chatId, runId, abs, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content ?? '');
  return `Wrote ${Buffer.byteLength(content ?? '')} bytes to ${rel}`;
});

// ---------- edit & search ----------

ipcMain.handle('tool:edit_file', async (_e, { path: rel, old_string: oldStr, new_string: newStr, replace_all: all, chatId, runId }) => {
  const abs = await resolveInWorkspace(rel);
  let text;
  try {
    text = await fsp.readFile(abs, 'utf8');
  } catch {
    throw new Error(`${rel} does not exist. Use write_file to create it.`);
  }
  if (!oldStr) throw new Error('old_string is empty. Give the exact text to replace.');
  const count = text.split(oldStr).length - 1;
  if (count === 0) {
    throw new Error(`old_string was not found in ${rel}. It must match the file exactly, including spaces and indentation. Use read_file to see the current text.`);
  }
  if (count > 1 && !all) {
    throw new Error(`old_string appears ${count} times in ${rel}. Include more surrounding lines so it is unique, or set replace_all to true.`);
  }
  await recordCheckpoint(chatId, runId, abs, rel);
  const next = all ? text.split(oldStr).join(newStr ?? '') : text.replace(oldStr, () => newStr ?? '');
  await fsp.writeFile(abs, next);
  return `Edited ${rel}: replaced ${all ? count : 1} occurrence${(all ? count : 1) === 1 ? '' : 's'}.`;
});

ipcMain.handle('tool:search_files', async (_e, { pattern, dir = '.', glob }) => {
  if (!pattern) throw new Error('pattern is required.');
  const root = await resolveInWorkspace(dir);
  const args = ['-rnIE', '--max-count=20', '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist',
    '--exclude-dir=build', '--exclude-dir=__pycache__', '--exclude-dir=.venv', '--exclude-dir=venv'];
  if (glob) args.push(`--include=${glob}`);
  args.push('--', pattern, '.');
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/grep', args, { cwd: root });
    let out = '';
    child.stdout.on('data', (b) => { if (out.length < 40000) out += b.toString(); });
    child.stderr.on('data', (b) => { if (out.length < 40000) out += b.toString(); });
    const timer = setTimeout(() => child.kill('SIGTERM'), 20000);
    child.on('close', () => {
      clearTimeout(timer);
      const lines = out.split('\n').filter(Boolean).map((l) => (l.length > 300 ? l.slice(0, 300) + '…' : l));
      if (!lines.length) return resolve(`No matches for /${pattern}/ in ${dir}.`);
      const shown = lines.slice(0, 100).join('\n');
      resolve(lines.length > 100 ? `${shown}\n…${lines.length - 100} more matches; narrow the search.` : shown);
    });
  });
});

// ---------- self-check after writes ----------

const { session } = require('electron');

function checkHtml(abs) {
  return new Promise((resolve) => {
    // Isolated, offline session: the page can run its own JS but can't reach the network.
    const ses = session.fromPartition('localpilot-check');
    ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !/^(file|data|blob|about):/.test(details.url) }));
    const w = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const errors = [];
    w.webContents.on('console-message', (_ev, level, message, line, sourceId) => {
      if (level >= 3) errors.push(`${message} (${path.basename(sourceId || '')}:${line})`);
    });
    w.webContents.on('did-fail-load', (_ev, code, desc) => errors.push(`failed to load: ${desc}`));
    const done = () => {
      if (!w.isDestroyed()) w.destroy();
      resolve(errors.length ? `Page errors:\n${[...new Set(errors)].slice(0, 10).join('\n')}` : 'Page loaded with no JavaScript errors.');
    };
    w.webContents.once('did-finish-load', () => setTimeout(done, 2000));
    setTimeout(done, 8000);
    w.loadFile(abs).catch(() => {});
  });
}

function runCheck(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: process.env });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    child.on('error', () => resolve(null));  // checker not installed
    child.on('close', (code) => resolve({ code, out: out.trim().slice(0, 2000) }));
  });
}

ipcMain.handle('tool:check_file', async (_e, { path: rel }) => {
  const abs = await resolveInWorkspace(rel);
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.html' || ext === '.htm') return checkHtml(abs);
  if (ext === '.json') {
    try {
      JSON.parse(await fsp.readFile(abs, 'utf8'));
      return 'Valid JSON.';
    } catch (err) {
      return `Invalid JSON: ${err.message}`;
    }
  }
  const checkers = {
    '.py': ['/usr/bin/env', ['python3', '-c',
      'import ast,sys\ntry: ast.parse(open(sys.argv[1]).read(), sys.argv[1])\n'
      + 'except SyntaxError as e: print(f"line {e.lineno}: {e.msg}\\n  {(e.text or \'\').rstrip()}"); sys.exit(1)', abs]],
    '.js': ['/usr/bin/env', ['node', '--check', abs]],
    '.mjs': ['/usr/bin/env', ['node', '--check', abs]],
    '.cjs': ['/usr/bin/env', ['node', '--check', abs]],
    '.sh': ['/bin/zsh', ['-n', abs]],
    '.rb': ['/usr/bin/env', ['ruby', '-c', abs]],
  };
  const c = checkers[ext];
  if (!c) return null;
  const r = await runCheck(...c);
  if (!r) return null;
  return r.code === 0 ? 'Syntax check passed.' : `Syntax check failed:\n${r.out}`;
});

// ---------- web search & fetch ----------

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0'
    || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

ipcMain.handle('tool:web_search', async (_e, { query }) => {
  if (!query) throw new Error('query is required.');
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Search failed with HTTP ${res.status}.`);
  const html = await res.text();
  const results = [];
  const blocks = html.split(/<div class="result results_links/).slice(1);
  for (const b of blocks) {
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = decodeEntities(a[1]);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue;  // ads
    const snippet = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    results.push({ title: stripTags(a[2]), url, snippet: snippet ? stripTags(snippet[1]) : '' });
    if (results.length >= 8) break;
  }
  if (!results.length) return { text: `No results for "${query}".`, urls: [] };
  return {
    text: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n'),
    urls: results.map((r) => r.url),
  };
});

ipcMain.handle('tool:fetch_url', async (_e, { url }) => {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('Not a valid URL.');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https URLs can be fetched.');
  if (isPrivateHost(u.hostname)) throw new Error('Fetching local or private-network addresses is blocked.');
  const res = await fetch(u, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (isPrivateHost(new URL(res.url).hostname)) throw new Error('Redirected to a private address; blocked.');
  const type = res.headers.get('content-type') || '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < 2_000_000) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  reader.cancel().catch(() => {});
  let text = Buffer.concat(chunks).toString('utf8');
  if (/html/.test(type) || /^\s*<!doctype html|<html/i.test(text)) {
    const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    text = text.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|br|pre)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
    text = decodeEntities(text.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
    if (title) text = `# ${stripTags(title)}\n\n${text}`;
  }
  return `HTTP ${res.status} ${res.url}\n\n${text.slice(0, 12000)}${text.length > 12000 ? '\n…[truncated]' : ''}`;
});

// ---------- project memory ----------

const NOTES_LIMIT = 4000;  // characters of each LOCALPILOT.md that go into the prompt

ipcMain.handle('memory:read', async (_e, { project }) => {
  const ws = readSettings().workspace;
  // Cut at a line break so the model never sees half a note; report the full size.
  const read = async (p) => {
    try {
      const text = await fsp.readFile(p, 'utf8');
      if (text.length <= NOTES_LIMIT) return { text, size: text.length };
      const cut = text.lastIndexOf('\n', NOTES_LIMIT);
      return { text: text.slice(0, cut > NOTES_LIMIT / 2 ? cut : NOTES_LIMIT), size: text.length };
    } catch {
      return null;
    }
  };
  const root = await read(path.join(ws, 'LOCALPILOT.md'));
  let proj = null;
  if (project && !project.includes('..')) {
    try {
      proj = await read(path.join(await resolveInWorkspace(project), 'LOCALPILOT.md'));
    } catch { /* outside workspace */ }
  }
  return {
    root: root?.text ?? null, rootSize: root?.size ?? 0,
    project: proj?.text ?? null, projectSize: proj?.size ?? 0,
    limit: NOTES_LIMIT,
  };
});

ipcMain.handle('tool:open_path', async (_e, { path: rel }) => {
  const abs = await resolveInWorkspace(rel);
  const err = await shell.openPath(abs);
  return err ? `Could not open ${rel}: ${err}` : `Opened ${rel}`;
});

// ---------- memory layer ----------
// Three stores, like episodic / semantic / procedural memory:
//   journal/   one dated summary per chat (events), searched only when needed
//   LOCALPILOT.md files in the workspace (facts), always loaded; updated only with approval
//   skills/    instructions and worked examples (skills), loaded by the model on demand

const journalDir = () => path.join(dataDir(), 'journal');
const skillsDir = () => path.join(dataDir(), 'skills');
const examplesDir = () => path.join(dataDir(), 'examples');
const proposalsFile = () => path.join(dataDir(), 'note-proposals.json');
const memoryStateFile = () => path.join(dataDir(), 'memory-state.json');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2));
}

async function readAllJson(dir) {
  const out = [];
  for (const f of (await fsp.readdir(dir).catch(() => [])).filter((x) => x.endsWith('.json'))) {
    const j = await readJson(path.join(dir, f), null);
    if (j) out.push(j);
  }
  return out;
}

const visibleText = (content) => (Array.isArray(content)
  ? content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
  : String(content ?? ''));

// ----- journal (events) -----

ipcMain.handle('journal:list', async () => (await readAllJson(journalDir())).sort((a, b) => b.date - a.date));

ipcMain.handle('journal:save', async (_e, entry) => {
  if (!fs.existsSync(path.join(chatsDir(), safeChatId(entry.chatId) + '.json'))) return false;  // deleted meanwhile
  await writeJson(path.join(journalDir(), safeChatId(entry.chatId) + '.json'), entry);
  return true;
});

// Chats that changed since they were last summarized and have an actual answer in them.
ipcMain.handle('journal:pending', async (_e, { exclude } = {}) => {
  const journal = new Map((await readAllJson(journalDir())).map((j) => [j.chatId, j]));
  const pending = [];
  for (const c of await readAllJson(chatsDir())) {
    if (c.id === exclude) continue;
    if ((journal.get(c.id)?.chatUpdatedAt ?? 0) >= c.updatedAt) continue;
    if (!c.messages?.some((m) => m.role === 'assistant' && m.content)) continue;
    pending.push({ id: c.id, updatedAt: c.updatedAt });
  }
  return pending.sort((a, b) => b.updatedAt - a.updatedAt).map((p) => p.id);
});

// ----- search_history -----

ipcMain.handle('history:search', async (_e, { query, excludeChatId }) => {
  const terms = [...new Set(String(query || '').toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter((t) => t.length > 1))];
  if (!terms.length) throw new Error('query is required.');
  const journal = new Map((await readAllJson(journalDir())).map((j) => [j.chatId, j]));
  const count = (text, t) => text.split(t).length - 1;
  const results = [];
  for (const c of await readAllJson(chatsDir())) {
    if (c.id === excludeChatId) continue;
    const summary = (journal.get(c.id)?.summary || '').toLowerCase();
    const title = (c.title || '').toLowerCase();
    const body = (c.messages || []).filter((m) => (m.role === 'user' && !m.hidden) || m.role === 'assistant')
      .map((m) => visibleText(m.content)).join('\n');
    const lower = body.toLowerCase();
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      const hits = 3 * count(summary, t) + 3 * count(title, t) + Math.min(count(lower, t), 10);
      if (hits) matched++;
      score += hits;
    }
    if (!score) continue;
    // Favor chats that match more of the words, and recent ones, without hiding old exact matches.
    const ageDays = (Date.now() - (c.updatedAt || 0)) / 86_400_000;
    score *= (matched / terms.length) * (0.6 + 0.4 * Math.exp(-ageDays / 60));
    const snippets = [];
    for (const t of terms) {
      const i = lower.indexOf(t);
      if (i >= 0 && snippets.length < 2) snippets.push('…' + body.slice(Math.max(0, i - 120), i + 160).replace(/\s+/g, ' ').trim() + '…');
    }
    results.push({ c, score, summary: journal.get(c.id)?.summary, snippets });
  }
  results.sort((a, b) => b.score - a.score);
  if (!results.length) return `No earlier chats match "${query}".`;
  return results.slice(0, 5).map(({ c, summary, snippets }) => {
    const date = new Date(c.updatedAt).toISOString().slice(0, 10);
    const head = `## ${date} · ${c.title}${c.project ? ` · project ${c.project}` : ''}`;
    return [head, summary ? `Summary:\n${summary}` : null, snippets.length ? `Matching text:\n${snippets.join('\n')}` : null]
      .filter(Boolean).join('\n');
  }).join('\n\n').slice(0, MAX_TOOL_OUTPUT);
});

// ----- skills (procedures) -----

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

function parseSkill(text, fallbackName) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  for (const line of (m ? m[1] : '').split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { name: meta.name || fallbackName, description: meta.description || '', body: (m ? m[2] : text).trim() };
}

ipcMain.handle('skills:list', async () => {
  const out = [];
  for (const f of (await fsp.readdir(skillsDir()).catch(() => [])).filter((x) => x.endsWith('.md'))) {
    const s = parseSkill(await fsp.readFile(path.join(skillsDir(), f), 'utf8'), f.slice(0, -3));
    out.push({ name: f.slice(0, -3), description: s.description });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
});

ipcMain.handle('skills:get', async (_e, name) => {
  if (!SKILL_NAME.test(String(name))) throw new Error(`No skill named "${name}".`);
  try {
    return parseSkill(await fsp.readFile(path.join(skillsDir(), name + '.md'), 'utf8'), name);
  } catch {
    throw new Error(`No skill named "${name}".`);
  }
});

ipcMain.handle('skills:save', async (_e, { name, description, body, previousName }) => {
  if (!SKILL_NAME.test(String(name))) throw new Error('Use lowercase letters, numbers and dashes for the name.');
  const oneLine = String(description || '').replace(/\s+/g, ' ').trim();
  await fsp.mkdir(skillsDir(), { recursive: true });
  await fsp.writeFile(path.join(skillsDir(), name + '.md'), `---\nname: ${name}\ndescription: ${oneLine}\n---\n\n${String(body || '').trim()}\n`);
  if (previousName && previousName !== name && SKILL_NAME.test(previousName)) {
    await fsp.rm(path.join(skillsDir(), previousName + '.md'), { force: true });
  }
  return true;
});

ipcMain.handle('skills:delete', async (_e, name) => {
  if (SKILL_NAME.test(String(name))) await fsp.rm(path.join(skillsDir(), name + '.md'), { force: true });
  return true;
});

ipcMain.handle('skills:reveal', async () => {
  await fsp.mkdir(skillsDir(), { recursive: true });
  return shell.openPath(skillsDir());
});

// ----- LOCALPILOT.md update proposals (facts) -----

async function notesPath(project) {
  return resolveInWorkspace(project ? path.join(project, 'LOCALPILOT.md') : 'LOCALPILOT.md');
}

ipcMain.handle('notes:get', async (_e, { project }) => {
  const abs = await notesPath(project);
  const rel = project ? `${project}/LOCALPILOT.md` : 'LOCALPILOT.md';
  try {
    return { rel, exists: true, content: (await fsp.readFile(abs, 'utf8')).slice(0, 50_000) };
  } catch {
    return { rel, exists: false, content: '' };
  }
});

ipcMain.handle('proposals:list', async () => readJson(proposalsFile(), []));

ipcMain.handle('proposals:add', async (_e, p) => {
  const all = await readJson(proposalsFile(), []);
  all.push({ ...p, id: crypto.randomUUID(), status: 'pending', createdAt: Date.now() });
  // Keep the pending ones and the last few decisions (for undo).
  const decided = all.filter((x) => x.status !== 'pending').slice(-10);
  await writeJson(proposalsFile(), [...decided, ...all.filter((x) => x.status === 'pending')]);
  return true;
});

ipcMain.handle('proposals:resolve', async (_e, { id, action, content }) => {
  const all = await readJson(proposalsFile(), []);
  const p = all.find((x) => x.id === id);
  if (!p || p.status !== 'pending') return { ok: false, error: 'This proposal was already handled.' };
  if (p.workspace !== readSettings().workspace) return { ok: false, error: 'This proposal is for a different workspace.' };
  if (action === 'apply') {
    const abs = await notesPath(p.project);
    const current = await fsp.readFile(abs, 'utf8').catch(() => '');
    if (current !== p.before) {
      return { ok: false, error: `${p.rel} changed after this was proposed, so applying it could undo your edits. Reject it, or copy what you want from Edit into the file yourself.` };
    }
    const next = String(content ?? p.after).trimEnd() + '\n';
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, next);
    Object.assign(p, { status: 'applied', applied: next, decidedAt: Date.now() });
  } else {
    Object.assign(p, { status: 'rejected', decidedAt: Date.now() });
  }
  await writeJson(proposalsFile(), all);
  return { ok: true };
});

ipcMain.handle('proposals:undo', async (_e, { id }) => {
  const all = await readJson(proposalsFile(), []);
  const p = all.find((x) => x.id === id && x.status === 'applied');
  if (!p) return { ok: false, error: 'Nothing to undo.' };
  if (p.workspace !== readSettings().workspace) return { ok: false, error: 'This change was made in a different workspace.' };
  const abs = await notesPath(p.project);
  const current = await fsp.readFile(abs, 'utf8').catch(() => '');
  if (current !== p.applied) return { ok: false, error: `${p.rel} was edited after this change, so it can't be undone safely.` };
  if (p.existed) await fsp.writeFile(abs, p.before);
  else await fsp.rm(abs, { force: true });
  p.status = 'undone';
  await writeJson(proposalsFile(), all);
  return { ok: true };
});

ipcMain.handle('memstate:get', async () => readJson(memoryStateFile(), { consolidatedAt: {} }));

ipcMain.handle('memstate:mark', async (_e, { key, at }) => {
  const s = await readJson(memoryStateFile(), { consolidatedAt: {} });
  s.consolidatedAt = { ...s.consolidatedAt, [key]: Math.max(at, s.consolidatedAt?.[key] ?? 0) };
  await writeJson(memoryStateFile(), s);
  return s;
});

// ----- rated answers (future fine-tuning data) -----

const safeExampleId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '');

ipcMain.handle('examples:save', async (_e, { id, record }) => {
  await writeJson(path.join(examplesDir(), safeExampleId(id) + '.json'), record);
  return true;
});

ipcMain.handle('examples:delete', async (_e, id) => {
  await fsp.rm(path.join(examplesDir(), safeExampleId(id) + '.json'), { force: true });
  return true;
});

ipcMain.handle('examples:count', async () => (await fsp.readdir(examplesDir()).catch(() => [])).filter((f) => f.endsWith('.json')).length);

ipcMain.handle('examples:reveal', async () => {
  await fsp.mkdir(examplesDir(), { recursive: true });
  return shell.openPath(examplesDir());
});
