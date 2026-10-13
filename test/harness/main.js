// Loads the real main.js in plain Node with a stand-in for Electron, so its IPC handlers can be
// called directly. The app never "becomes ready": no window, engine cleanup or Connect starts.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..', '..');

const temps = [];
process.on('exit', () => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function tempDir(name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `localpilot-${name}-`)));
  temps.push(dir);
  return dir;  // real path: /var → /private/var on macOS, as the workspace check resolves it
}

function loadMain() {
  const dataDir = tempDir('data');
  const workspace = tempDir('workspace');
  const handlers = {};
  const sent = [];        // every main → renderer message, in order
  const listeners = [];   // (channel, payload) callbacks, e.g. the renderer harness

  const electron = {
    app: {
      getPath: () => dataDir,
      whenReady: () => new Promise(() => {}),
      on() {},
      quit() {},
    },
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    BrowserWindow: Object.assign(function BrowserWindow() { throw new Error('No windows in tests'); }, { getAllWindows: () => [] }),
    dialog: {},
    shell: { openPath: async () => '', openExternal() {} },
    safeStorage: { isEncryptionAvailable: () => false },
    session: { fromPartition() { throw new Error('No sessions in tests'); } },
  };

  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    return request === 'electron' ? electron : load.call(this, request, parent, isMain);
  };
  // `send` in main.js writes to its private `win`; give the test a way to set one.
  const file = path.join(root, 'main.js');
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(root);
  const exitListeners = process.listeners('exit');
  mod._compile(`${fs.readFileSync(file, 'utf8')}\nmodule.exports.__setWindow = (w) => { win = w; };`, file);
  Module._load = load;
  // Its exit hook only stops the engine, which tests never start.
  for (const l of process.listeners('exit')) if (!exitListeners.includes(l)) process.removeListener('exit', l);

  mod.exports.__setWindow({
    isDestroyed: () => false,
    webContents: {
      send(channel, payload) {
        sent.push({ channel, payload });
        for (const l of listeners) l(channel, payload);
      },
    },
  });

  const invoke = async (channel, arg) => {
    if (!handlers[channel]) throw new Error(`No handler for ${channel}`);
    return handlers[channel]({}, arg);
  };
  const settingsFile = path.join(dataDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ workspace }));

  return { handlers, invoke, sent, listeners, dataDir, workspace, settingsFile };
}

module.exports = { loadMain, tempDir, root };
