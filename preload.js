const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('souljaterm', {
  spawn: (opts) => ipcRenderer.send('pty-spawn', opts),
  input: (id, data) => ipcRenderer.send('pty-input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty-resize', { id, cols, rows }),
  kill: (id) => ipcRenderer.send('pty-kill', { id }),
  onData: (cb) => ipcRenderer.on('pty-data', (_e, payload) => cb(payload)),
  onExit: (cb) => ipcRenderer.on('pty-exit', (_e, payload) => cb(payload)),
  homeInfo: () => ipcRenderer.invoke('home-info'),
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
  memory: () => ipcRenderer.invoke('roll-memory'),
  clearMemory: () => ipcRenderer.send('roll-memory-clear'),
  popoutChat: (msg) => ipcRenderer.send('popout-chat-send', msg),
  onPopoutChat: (cb) => ipcRenderer.on('popout-chat', (_e, msg) => cb(msg)),
});
