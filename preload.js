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
});
