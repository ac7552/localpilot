// LocalPilot main process: owns everything with real power (LM Studio, files, shell).
// The renderer only asks for things over IPC; workspace confinement is enforced here.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const LMS = path.join(os.homedir(), '.lmstudio', 'bin', 'lms');
const LMS_MODELS = path.join(os.homedir(), '.lmstudio', 'models');
const API = 'http://localhost:1234/v1';

// LocalPilot's own engine: a local llama.cpp build (~/llama.cpp) patched to run
// Qwen3.5/3.6 on this Mac's GPU, which LM Studio's bundled llama.cpp crashes on.
const LLAMA_SERVER = path.join(os.homedir(), 'llama.cpp', 'build', 'bin', 'llama-server');
const ENGINE_PORT = 55991;
const ENGINE_API = `http://127.0.0.1:${ENGINE_PORT}/v1`;
const AUTO_ENGINE_ARCH = /^qwen3(5|6)/;
let engine = null;  // { child, modelKey, displayName, contextLength, ready }
const MAX_TOOL_OUTPUT = 12000;
const MAX_READ_BYTES = 200_000;

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
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => stopEngine());
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
      chats.push({ id: c.id, title: c.title, updatedAt: c.updatedAt });
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
  await fsp.rm(path.join(chatsDir(), safeChatId(id) + '.json'), { force: true });
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
  return parseJson(ls.out, []).filter((m) => m.type === 'llm');
}

function stopEngine() {
  if (!engine) return Promise.resolve();
  const { child } = engine;
  engine = null;
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
}

function startEngine(model, contextLength) {
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
    if (draft && fs.existsSync(draft)) args.push('-md', draft, '--spec-type', 'draft-mtp');
    // Vision: load the projector file that sits next to the model, if there is one.
    try {
      const dir = path.dirname(path.join(LMS_MODELS, model.path));
      const mmproj = fs.readdirSync(dir).find((f) => /^mmproj.*\.gguf$/i.test(f) || /\.mmproj-.*\.gguf$/i.test(f));
      if (mmproj && model.vision) args.push('--mmproj', path.join(dir, mmproj));
    } catch { /* no projector */ }
    const child = spawn(LLAMA_SERVER, args, { env: process.env });
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
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code, signal) => {
      if (engine?.child === child) engine = null;
      const reason = log.split('\n').reverse().find((l) => /GGML_ASSERT|GGML_ABORT|error|failed/i.test(l)) || `exit ${code ?? signal}`;
      finish({ ok: false, error: `Engine stopped while loading (${signal ?? code}): ${reason.trim()}` });
    });
    child.on('error', (err) => finish({ ok: false, error: `Could not start engine: ${err.message}` }));
    engine = { child, modelKey: model.modelKey, displayName: model.displayName, contextLength, ready: false };
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
  if (engine?.ready) {
    loaded.push({ modelKey: engine.modelKey, displayName: engine.displayName, contextLength: engine.contextLength, engine: 'llamacpp' });
  }
  return { downloaded, loaded, engineAvailable: engineAvailable() };
});

ipcMain.handle('models:estimate', async (_e, { modelKey, contextLength }) => {
  const r = await runLms(['load', modelKey, '--gpu', 'max', '-c', String(contextLength), '--estimate-only', '-y'], { timeoutMs: 60_000 });
  const text = r.out + r.err;
  const gib = text.match(/Estimated Total Memory:\s*([\d.]+)\s*GiB/i);
  return { totalGiB: gib ? Number(gib[1]) : null, willFail: /will fail to load/i.test(text), raw: text.trim() };
});

ipcMain.handle('models:load', async (_e, { modelKey, contextLength }) => {
  // Only one model fits in GPU memory at a time, whichever engine runs it.
  await stopEngine();
  killOrphanEngines();
  await runLms(['unload', '--all'], { timeoutMs: 60_000 });

  const model = (await listDownloaded()).find((m) => m.modelKey === modelKey);
  if (model && engineFor(model) === 'llamacpp') return startEngine(model, contextLength);

  const r = await runLms(['load', modelKey, '--gpu', 'max', '-c', String(contextLength), '--parallel', '1', '-y'], {
    timeoutMs: 300_000,
    onLine: (line) => {
      const pct = line.match(/(\d{1,3})%/);
      if (pct) send('models:loadProgress', { modelKey, percent: Number(pct[1]) });
    },
  });
  const errorLine = (r.out + '\n' + r.err).split('\n').find((l) => /^Error/i.test(l.trim()));
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

ipcMain.handle('chat:stream', async (_e, { requestId, body }) => {
  const controller = new AbortController();
  streams.set(requestId, controller);
  const onEngine = engine?.ready && engine.modelKey === body.model;
  const base = onEngine ? ENGINE_API : API;
  const payload = { ...body, stream: true, stream_options: { include_usage: true } };
  if (onEngine && payload.reasoning_effort === 'none') {
    // llama-server switches thinking off through the chat template instead.
    delete payload.reasoning_effort;
    payload.chat_template_kwargs = { ...(payload.chat_template_kwargs || {}), enable_thinking: false };
  }
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `LM Studio returned ${res.status}: ${text.slice(0, 800)}` };
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let streamError = null;
    for await (const chunk of res.body) {
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
        send('chat:chunk', { requestId, chunk: parsed });
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
    if (err.name === 'AbortError') return { ok: true, aborted: true };
    return { ok: false, error: `Could not reach ${onEngine ? 'the LocalPilot engine' : 'LM Studio'} at ${base}: ${err.message}` };
  } finally {
    streams.delete(requestId);
  }
});

ipcMain.handle('chat:abort', (_e, requestId) => {
  streams.get(requestId)?.abort();
  const child = commands.get(requestId);
  if (child) child.kill('SIGTERM');
  return true;
});

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

ipcMain.handle('memory:read', async (_e, { project }) => {
  const ws = readSettings().workspace;
  const read = async (p) => {
    try {
      return (await fsp.readFile(p, 'utf8')).slice(0, 4000);
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
  return { root, project: proj };
});

ipcMain.handle('tool:open_path', async (_e, { path: rel }) => {
  const abs = await resolveInWorkspace(rel);
  const err = await shell.openPath(abs);
  return err ? `Could not open ${rel}: ${err}` : `Opened ${rel}`;
});
