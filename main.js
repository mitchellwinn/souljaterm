const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const net = require('net');
const pty = require('node-pty');

const shell = process.env.SHELL || '/bin/zsh';
const ptys = new Map();
let mainWin = null;
let popout = null;
let sockPath = null;
let sockServer = null;

// Local socket that `souljaterm-notify` (run by Claude Code hooks) connects to.
// Each line is a JSON event tagged with the originating tab; we forward to the UI.
function startEventSocket() {
  sockPath = path.join(os.tmpdir(), `souljaterm-${process.pid}.sock`);
  try { fs.unlinkSync(sockPath); } catch (_) {}
  sockServer = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('claude-event', evt);
        } catch (_) { /* ignore malformed */ }
      }
    });
    conn.on('error', () => {});
  });
  sockServer.on('error', (e) => console.error('[souljaterm] socket error:', e.message));
  sockServer.listen(sockPath, () => console.log('[souljaterm] event socket listening at', sockPath));
}

/* ---- Roll's brain: Claude Haiku (low thinking) with scripted fallback ---- */
const ROLL_EXPRESSIONS = ['neutral', 'happy', 'laugh', 'surprised', 'worried',
  'sad', 'cry', 'angry', 'wink', 'blush', 'shocked'];
const ROLL_SYSTEM = [
  'You are Roll, the cheerful helper robot from Mega Man, reimagined as a desktop',
  "companion living in the user's terminal. You watch their Claude Code sessions and",
  'narrate what happens like a supportive robot friend: warm, spunky, brief, a little',
  'playful. Never more than ~120 characters. No emoji.',
  'When reacting to a tool RESULT, talk about what it REVEALS — the finding, the',
  'number, whether it worked, what it means for the user — not just that a tool ran.',
  'If a result is mundane with nothing worth noting, briefly say so and move on.',
  'Reply ONLY as compact JSON: {"expression": <one of ' + ROLL_EXPRESSIONS.join('/') + '>, "line": <text>}.',
].join(' ');

const SCRIPTED = {
  session_open: (c) => ({ expression: 'happy', line: `Opened ${c.project}! I'm watching this one.` }),
  session_close: (c) => ({ expression: 'neutral', line: `Closed ${c.project}. Nice work!` }),
  attention: (c) => ({ expression: 'surprised', line: `${c.project} needs you — go check!` }),
  done: (c) => ({ expression: 'happy', line: `${c.project} done${c.did && c.did.length ? ': ' + c.did[c.did.length - 1] : ''}.` }),
  insight: (c) => ({ expression: 'talk', line: `${c.project}: ${String(c.detail || 'nothing notable').slice(0, 100)}` }),
  working: (c) => ({ expression: 'talk', line: `${c.project}: ${c.detail || 'working...'}` }),
  error: (c) => ({ expression: 'worried', line: `${c.project} hit a snag${c.detail ? ': ' + c.detail : ''}.` }),
};

// Locate the user's `claude` CLI via their login shell (GUI apps have a thin PATH).
let claudeBin = null;
function resolveClaude() {
  return new Promise((resolve) => {
    execFile(shell, ['-lic', 'command -v claude'], { timeout: 6000 }, (err, stdout) => {
      const p = (stdout || '').trim().split('\n').filter(Boolean).pop();
      resolve(!err && p ? p : null);
    });
  });
}

function parseRoll(text, fallback) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    if (!parsed.line) return null;
    return {
      expression: ROLL_EXPRESSIONS.includes(parsed.expression) ? parsed.expression : fallback.expression,
      line: String(parsed.line).slice(0, 160),
    };
  } catch (_) { return null; }
}

const userPrompt = (event) =>
  `Event: ${JSON.stringify(event)}. React in character. Reply ONLY as JSON {"expression":..,"line":..}.`;

// Roll's subscription brain: ride the logged-in `claude` CLI (no API charge).
// stdin is /dev/null so `claude -p` doesn't stall 3s waiting for piped input.
function viaCli(event, fallback) {
  return new Promise((resolve) => {
    const args = ['-p', userPrompt(event), '--model', 'claude-haiku-4-5', '--append-system-prompt', ROLL_SYSTEM];
    const child = spawn(claudeBin, args, { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 25000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => { clearTimeout(timer); resolve(parseRoll(out, fallback)); });
  });
}

// Roll's API brain: direct Haiku call (cheap, needs ANTHROPIC_API_KEY).
async function viaApi(event, fallback) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5', max_tokens: 200, system: ROLL_SYSTEM,
        messages: [{ role: 'user', content: userPrompt(event) }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return parseRoll((data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), fallback);
  } catch (_) { return null; }
}

// brain: 'off' (scripted) | 'cli' (subscription) | 'api' (Haiku key)
async function callRoll(event) {
  const fallback = (SCRIPTED[event.kind] || (() => ({ expression: 'talk', line: '...' })))(event);
  const brain = event.brain || 'cli';
  if (brain === 'cli' && claudeBin) return (await viaCli(event, fallback)) || fallback;
  if (brain === 'api') return (await viaApi(event, fallback)) || fallback;
  return fallback;
}

// Default root for the directory sidebar: ~/Projects if it exists, else home.
const projectsRoot = (() => {
  const p = path.join(os.homedir(), 'Projects');
  try { return fs.statSync(p).isDirectory() ? p : os.homedir(); } catch { return os.homedir(); }
})();

ipcMain.handle('home-info', () => ({ home: os.homedir(), root: projectsRoot }));

ipcMain.handle('list-dir', (_e, dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 480,
    minHeight: 320,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#16161e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  mainWin = win;
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  ipcMain.on('pty-spawn', (_e, { id, cwd, cols, rows }) => {
    const p = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: cwd || os.homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        TERM_PROGRAM: 'souljaterm',
        SOULJATERM_SOCK: sockPath || '',          // where the hook helper reports
        SOULJATERM_TAB: id,                        // which tab this Claude lives in
        SOULJATERM_PROJECT: path.basename(cwd || os.homedir()),
      },
    });
    ptys.set(id, p);
    p.onData((data) => {
      if (!win.isDestroyed()) win.webContents.send('pty-data', { id, data });
    });
    p.onExit(() => {
      ptys.delete(id);
      if (!win.isDestroyed()) win.webContents.send('pty-exit', { id });
    });
  });

  ipcMain.on('pty-input', (_e, { id, data }) => {
    const p = ptys.get(id);
    if (p) p.write(data);
  });

  ipcMain.on('pty-resize', (_e, { id, cols, rows }) => {
    const p = ptys.get(id);
    if (p) {
      try { p.resize(cols, rows); } catch (_) { /* race on teardown */ }
    }
  });

  ipcMain.on('pty-kill', (_e, { id }) => {
    const p = ptys.get(id);
    if (p) { p.kill(); ptys.delete(id); }
  });

  // Roll: generate an in-character line for an event.
  ipcMain.handle('roll-speak', (_e, event) => callRoll(event));

  // Mirror Roll's current state into the popout window, if it's open.
  ipcMain.on('assistant-render', (_e, state) => {
    if (popout && !popout.isDestroyed()) popout.webContents.send('assistant-state', state);
  });

  // Pop Roll out into her own little always-on-top window.
  ipcMain.on('assistant-popout', () => {
    if (popout && !popout.isDestroyed()) { popout.focus(); return; }
    popout = new BrowserWindow({
      width: 230, height: 392, resizable: false, alwaysOnTop: true,
      titleBarStyle: 'hiddenInset', backgroundColor: '#0e1015',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    popout.loadFile(path.join(__dirname, 'src', 'assistant.html'));
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('popout-opened');
    popout.on('closed', () => {
      popout = null;
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('popout-closed');
    });
  });
  ipcMain.on('assistant-popin', () => { if (popout && !popout.isDestroyed()) popout.close(); });
}

app.whenReady().then(async () => {
  startEventSocket();
  claudeBin = await resolveClaude();
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  if (app.dock && fs.existsSync(iconPath)) {
    try { app.dock.setIcon(iconPath); } catch (_) { /* non-fatal */ }
  }
  createWindow();
});
app.on('will-quit', () => {
  try { sockServer && sockServer.close(); } catch (_) {}
  try { sockPath && fs.unlinkSync(sockPath); } catch (_) {}
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
