const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('souljaterm', {
  platform: process.platform,                 // 'darwin' | 'win32' | 'linux' — for OS-specific UI
  spawn: (opts) => ipcRenderer.send('pty-spawn', opts),
  input: (id, data) => ipcRenderer.send('pty-input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty-resize', { id, cols, rows }),
  kill: (id) => ipcRenderer.send('pty-kill', { id }),
  onData: (cb) => ipcRenderer.on('pty-data', (_e, payload) => cb(payload)),
  onExit: (cb) => ipcRenderer.on('pty-exit', (_e, payload) => cb(payload)),
  homeInfo: () => ipcRenderer.invoke('home-info'),
  pickProjectsRoot: () => ipcRenderer.invoke('pick-projects-root'),
  setupStatus: () => ipcRenderer.invoke('setup-status'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  listDir: (dir) => ipcRenderer.invoke('list-dir', dir),
  // Roll the assistant
  rollSpeak: (event) => ipcRenderer.invoke('roll-speak', event),
  assistantRender: (state) => ipcRenderer.send('assistant-render', state),
  popout: () => ipcRenderer.send('assistant-popout'),
  popin: () => ipcRenderer.send('assistant-popin'),
  onPopoutOpened: (cb) => ipcRenderer.on('popout-opened', () => cb()),
  onPopoutClosed: (cb) => ipcRenderer.on('popout-closed', () => cb()),
  onAssistantState: (cb) => ipcRenderer.on('assistant-state', (_e, s) => cb(s)),
  onClaudeEvent: (cb) => ipcRenderer.on('claude-event', (_e, evt) => cb(evt)),
  readTranscript: (p) => ipcRenderer.invoke('read-transcript', p),
  watchTranscript: (p, tab) => ipcRenderer.send('watch-transcript', { path: p, tab }),
  onTranscriptLive: (cb) => ipcRenderer.on('transcript-live', (_e, d) => cb(d)),
  rollLog: (kind, project, text) => ipcRenderer.send('roll-log', { kind, project, text }),
  // Roll's task manager
  taskRoute: (prompt) => ipcRenderer.invoke('task-route', prompt),
  taskStart: (opts) => ipcRenderer.send('task-start', opts),
  taskCancel: (id) => ipcRenderer.send('task-cancel', id),
  taskHistory: () => ipcRenderer.invoke('task-history'),
  onTaskEvent: (cb) => ipcRenderer.on('task-event', (_e, p) => cb(p)),
  memory: () => ipcRenderer.invoke('roll-memory'),
  clearMemory: () => ipcRenderer.send('roll-memory-clear'),
  onRollNote: (cb) => ipcRenderer.on('roll-note', (_e, s) => cb(s)),
  popoutChat: (msg) => ipcRenderer.send('popout-chat-send', msg),
  onPopoutChat: (cb) => ipcRenderer.on('popout-chat', (_e, msg) => cb(msg)),
  // RetroArch shaders
  listShaders: () => ipcRenderer.invoke('list-shaders'),
  readShader: (where, file) => ipcRenderer.invoke('read-shader', { where, file }),
  openShaderDir: () => ipcRenderer.invoke('open-shader-dir'),
  // auto-update
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, s) => cb(s)),
  updateStatusGet: () => ipcRenderer.invoke('update-status-get'),
  updateDownload: () => ipcRenderer.send('update-download'),
  updateInstall: () => ipcRenderer.send('update-install'),
});
