// Narrow bridge between the sandboxed UI and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (arg) => ipcRenderer.invoke(channel, arg);

function subscribe(channel, handler) {
  const listener = (_e, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('localpilot', {
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  chooseWorkspace: invoke('workspace:choose'),
  revealWorkspace: invoke('workspace:reveal'),
  userName: invoke('app:userName'),

  listChats: invoke('chats:list'),
  loadChat: invoke('chats:load'),
  saveChat: invoke('chats:save'),
  deleteChat: invoke('chats:delete'),

  ensureServer: invoke('server:ensure'),
  listModels: invoke('models:list'),
  estimateModel: invoke('models:estimate'),
  loadModel: invoke('models:load'),
  unloadModels: invoke('models:unload'),
  setModelEngine: invoke('models:setEngine'),
  downloadModel: invoke('models:download'),
  onLoadProgress: (h) => subscribe('models:loadProgress', h),
  onDownloadProgress: (h) => subscribe('models:downloadProgress', h),

  streamChat: invoke('chat:stream'),
  abort: invoke('chat:abort'),
  onChatChunk: (h) => subscribe('chat:chunk', h),

  tools: {
    list_files: invoke('tool:list_files'),
    read_file: invoke('tool:read_file'),
    file_exists: invoke('tool:file_exists'),
    write_file: invoke('tool:write_file_tracked'),
    edit_file: invoke('tool:edit_file'),
    search_files: invoke('tool:search_files'),
    check_file: invoke('tool:check_file'),
    web_search: invoke('tool:web_search'),
    fetch_url: invoke('tool:fetch_url'),
    run_command: invoke('tool:run_command'),
    open_path: invoke('tool:open_path'),
  },
  runChanges: invoke('checkpoint:run'),
  undoRun: invoke('checkpoint:undo'),
  readMemory: invoke('memory:read'),
  onCommandOutput: (h) => subscribe('tool:commandOutput', h),
});
