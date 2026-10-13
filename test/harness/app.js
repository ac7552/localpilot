// The whole app without Electron: the real index.html, renderer.js and connect.js in jsdom, talking
// through the real preload.js to the real main.js handlers. Only the model server (see fake-model.js),
// LM Studio's CLI and the macOS account name are stand-ins. The canvas visuals aren't loaded.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { loadMain, root } = require('./main');
const { JSDOM, VirtualConsole } = require(path.join(root, 'node_modules/jsdom'));

const MODEL = 'test-model';
const MODELS = {
  downloaded: [{ type: 'llm', modelKey: MODEL, displayName: 'Test Model', architecture: 'qwen35', sizeBytes: 5e9, paramsString: '9B', engine: 'lmstudio' }],
  loaded: [{ type: 'llm', modelKey: MODEL, displayName: 'Test Model', contextLength: 16384, engine: 'lmstudio' }],
  remote: [],
  engineAvailable: false,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A callback that was already queued when a test closed its window can still fire; ignore those.
let closed = false;
process.on('uncaughtException', (err) => {
  if (closed && /renderer\/(renderer|connect)\.js/.test(err?.stack)) return;
  throw err;
});

// chunkDelayMs: hold back chat chunks so the stream's reply overtakes them, as can happen in Electron.
async function loadApp({ settings = {}, overrides = {}, chunkDelayMs = 0 } = {}) {
  const m = loadMain();
  fs.writeFileSync(m.settingsFile, JSON.stringify({ workspace: m.workspace, model: MODEL, effort: 'medium', mode: 'auto', ...settings }));

  const handlers = {
    'app:userName': () => 'Tester',
    'server:ensure': () => ({ ok: true }),
    'models:list': () => MODELS,
    'tokens:count': () => null,
    'workspace:reveal': () => '',
    ...overrides,
  };

  const indexFile = path.join(root, 'renderer/index.html');
  const html = fs.readFileSync(indexFile, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e.detail ?? e));
  if (process.env.TEST_CONSOLE) virtualConsole.sendTo(console, { omitJSDOMErrors: true });
  // Scripts run as classic <script>s so they share top-level names, as in the app.
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: pathToFileURL(indexFile).href, virtualConsole });
  const { window } = dom;
  window.addEventListener('unhandledrejection', (e) => errors.push(e.reason));

  // ipcRenderer as preload.js sees it: values are copied across, errors come back as Electron words them.
  const subs = new Map();
  const ipcRenderer = {
    async invoke(channel, arg) {
      const fn = handlers[channel] ?? ((a) => m.invoke(channel, a));
      try {
        return structuredClone(await fn(structuredClone(arg)));
      } catch (err) {
        throw new window.Error(`Error invoking remote method '${channel}': ${err}`);
      }
    },
    on(channel, l) { if (!subs.has(channel)) subs.set(channel, new Set()); subs.get(channel).add(l); },
    removeListener(channel, l) { subs.get(channel)?.delete(l); },
  };
  m.listeners.push((channel, payload) => {
    const copy = structuredClone(payload);
    setTimeout(() => { for (const l of subs.get(channel) ?? []) l({}, copy); }, channel === 'chat:chunk' ? chunkDelayMs : 0);
  });
  const electron = { contextBridge: { exposeInMainWorld: (k, v) => { window[k] = v; } }, ipcRenderer };
  new Function('require', fs.readFileSync(path.join(root, 'preload.js'), 'utf8'))((n) => (n === 'electron' ? electron : require(n)));

  window.navigator.clipboard ??= { writeText: async () => {} };
  for (const f of ['node_modules/marked/lib/marked.umd.js', 'node_modules/dompurify/dist/purify.min.js', 'renderer/renderer.js', 'renderer/connect.js']) {
    const script = window.document.createElement('script');
    script.textContent = `${fs.readFileSync(path.join(root, f), 'utf8')}\n//# sourceURL=${f}`;
    window.document.body.append(script);
  }
  if (errors.length) throw errors[0];

  const ev = (expr) => window.eval(expr);
  const $ = (id) => window.document.getElementById(id);
  async function waitFor(fn, what = 'condition', ms = 10_000) {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
      await sleep(10);
    }
  }
  await waitFor(() => ev('state.settings && state.models.loaded.length && $("modelStatus").textContent.includes("loaded")'), 'the app to start');

  const app = {
    m, window, ev, $, waitFor, errors, workspace: m.workspace,
    // Type a message and send it, as the user would.
    async send(text) {
      $('input').value = text;
      $('input').dispatchEvent(new window.Event('input'));
      await ev('send()');
    },
    // Start sending without waiting, for runs that stop to ask for approval.
    start(text) {
      $('input').value = text;
      return ev('send()');
    },
    buttons: (label) => [...window.document.querySelectorAll('button')].filter((b) => b.textContent.trim() === label && !b.closest('.hidden')),
    async click(label) {
      const b = await waitFor(() => app.buttons(label)[0], `a "${label}" button`);
      b.click();
    },
    lastAnswer: () => [...window.document.querySelectorAll('#messages .msg.assistant')].at(-1),
    text: (el) => el?.textContent.replace(/\s+/g, ' ').trim() ?? '',
    notices: () => [...window.document.querySelectorAll('#messages .notice')].map((n) => n.textContent),
    // Let pending work settle, then shut the window (and its timers) down.
    async close() {
      await waitFor(() => !ev('state.busy'), 'the app to be idle');
      await sleep(50);
      closed = true;
      window.close();
    },
  };
  return app;
}

module.exports = { loadApp, MODEL, sleep };
