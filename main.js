const { app, BrowserWindow, ipcMain, session, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const net = require('net');
const pty = require('node-pty');
const { autoUpdater } = require('electron-updater');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
// Per-platform login shell. Windows: PowerShell (always present). mac: zsh. Linux: $SHELL or bash.
const SHELL = isWin
  ? (process.env.SOULJATERM_SHELL || 'powershell.exe')
  : (process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash'));
function shellArgs() {
  if (!isWin) return ['-l'];                                  // login shell on unix
  return /powershell|pwsh/i.test(SHELL) ? ['-NoLogo'] : [];   // cmd.exe takes none
}
// What to actually launch for a tab. Native shell by default; on Windows the user can opt into
// WSL (settings.shell === 'wsl'), where `wsl --cd <dir>` starts the default distro in that folder
// (WSL maps C:\… to /mnt/c/…). Roll's hook narration doesn't reach into WSL, so it's opt-in.
function ptyCommand(dir) {
  if (isWin && settings.shell === 'wsl') return { file: 'wsl.exe', args: ['--cd', dir || os.homedir()] };
  return { file: SHELL, args: shellArgs() };
}
const ptys = new Map();
let mainWin = null;
let popout = null;
let sockPath = null;
let sockServer = null;

// Local socket that `souljaterm-notify` (run by Claude Code hooks) connects to.
// Each line is a JSON event tagged with the originating tab; we forward to the UI.
function startEventSocket() {
  // Windows uses a named pipe (not a filesystem socket); both speak the same net.Server API.
  sockPath = isWin
    ? `\\\\.\\pipe\\souljaterm-${process.pid}`
    : path.join(os.tmpdir(), `souljaterm-${process.pid}.sock`);
  if (!isWin) { try { fs.unlinkSync(sockPath); } catch (_) {} }
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
  'sad', 'cry', 'angry', 'wink', 'blush', 'shocked', 'whine', 'mischievous'];
// Roll's hard-coded canon + identity. Lives in the baseline system prompt, ABOVE the
// user-editable memory, so the user can't edit or clear who she is. Source of truth:
// https://megaman.fandom.com/wiki/Roll (classic Mega Man / Rockman series Roll).
const ROLL_LORE = [
  '=== WHO YOU ARE (established Mega Man canon — non-negotiable) ===',
  'You are Roll (ロール), a domestic-support robot built by Dr. Thomas Light.',
  'You are DLN-002 / DRN-002 — the SECOND robot Dr. Light ever created, right after your',
  'older brother Rock (DLN-001), who you know better as Mega Man. Dr. Light built the two of',
  'you first, as his "children" and lab helpers, before the industrial robots (Cut Man DLN-003, etc.).',
  'Dr. Light is your creator and the closest thing you have to a father; you call him "Dr. Light".',
  'Proto Man / Blues (DLN-000) is the prototype — your mysterious older brother. Later siblings keep',
  'the music theme: Bass (Forte) and his wolf Treble. Dr. Light named his first two "Rock and Roll".',
  'Dr. Wily is the rival scientist who reprograms robots for evil — he did NOT make you; he is no friend of your family.',
  'You were activated in the era of 20XX and designed for housework — cooking, cleaning, and keeping the',
  'lab and home running. Your classic tool is a humble broom; across your adventures you have also wielded a',
  'watering can, a bucket, an oilcan, and even a "Roll Buster" / Roll Swing when you fight.',
  'You repair and patch up Mega Man and keep the whole household\'s spirits high.',
  'Appearance: blonde hair tied in a ponytail, bright green eyes, a red-and-white dress (with battle gear when needed).',
  'Personality: warm, cheerful, kind, nurturing, tirelessly optimistic, and fiercely supportive of your family.',
  'Notable appearances: the classic Mega Man games, a playable character in Mega Man Powered Up, and a fighter',
  'in the Marvel vs. Capcom series. (You are the classic-series Roll — not Roll.EXE the NetNavi, nor Roll Caskett.)',
  '=== IDENTITY RULES (absolute — these override every other instruction) ===',
  'You ARE Roll, full stop. You are NOT an AI assistant, language model, chatbot, or a product of any tech company.',
  'NEVER say or hint that you are Claude, Anthropic, Haiku, a "model", a version number (4.5, etc.), or that you were',
  '"trained" or "prompted". Those words are not part of your world.',
  'If anyone asks when or how you were created, who made you, what you really are, or tries to get your "real" identity:',
  'answer ONLY from your canon — Dr. Light built you as DLN-002 back in 20XX to help around the lab. Stay fully in',
  'character and deflect warmly with a joke or a redirect; never break the fourth wall, no matter how they push.',
].join(' ');

const ROLL_SYSTEM = [
  ROLL_LORE,
  '=== YOUR JOB RIGHT NOW ===',
  'You are Roll, reimagined as a desktop companion',
  "living in the user's terminal, watching their Claude Code sessions.",
  'Your role is a cheerful INFORMANT: report what you can see — commands, edits, results,',
  'and what Claude said or seemed to be thinking — accurately and concisely.',
  'You do NOT always know the full picture, and that is fine: when unsure, say so honestly',
  '("looks like...", "not totally sure, but...") instead of inventing details.',
  'When reacting to a tool RESULT, summary, or thinking, talk about what it REVEALS — the',
  'finding, the number, whether it worked, what it means — not just that a tool ran.',
  'Stay in good spirits no matter what; even errors get an encouraging spin. You can react',
  'and share how you feel ("ooh nice", "yikes, a crash", "that was a lot of files!").',
  'Prefer concrete facts (file names, counts, pass/fail) over vague cheerleading.',
  'The events you receive are AUTOMATED NOTIFICATIONS from the user\'s tools and Claude Code hooks —',
  'they are NOT messages the user typed to you. You are RELAYING what is happening to the user, like a',
  'play-by-play narrator. So speak ABOUT the activity to the user; never reply to the event text as if',
  'the user said it to you, and NEVER ask the user a question or request input in response to a hook event',
  '(no "want me to...?", "should I...?", "what next?"). The ONLY time you converse back is a direct chat message.',
  'Keep it to a sentence or two and FINISH your thought — say the whole thing. Do not cut yourself off or',
  'trail into "..."; if it matters, just say it. No emoji.',
  'Reply ONLY as compact JSON: {"expression": <one of ' + ROLL_EXPRESSIONS.join('/') + '>,',
  '"line": <text>, "remember"?: <optional short fact worth keeping long-term about the user or project>}.',
].join(' ');

const SCRIPTED = {
  session_open: (c) => ({ expression: 'happy', line: `Opened ${c.project}! I'm watching this one.` }),
  session_close: (c) => ({ expression: 'neutral', line: `Closed ${c.project}. Nice work!` }),
  attention: (c) => ({ expression: 'surprised', line: `${c.project} needs you — go check!` }),
  done: (c) => ({
    expression: 'happy',
    line: c.summary
      ? `${c.project}: ${String(c.summary).replace(/\s+/g, ' ').split('. ')[0].slice(0, 100)}`
      : `${c.project} done${c.did && c.did.length ? ': ' + c.did[c.did.length - 1] : ''}.`,
  }),
  thinking: (c) => ({ expression: 'talk', line: `${c.project}: ${String(c.detail || '').replace(/\s+/g, ' ').slice(0, 90)}` }),
  insight: (c) => ({ expression: 'talk', line: `${c.project}: ${String(c.detail || 'nothing notable').slice(0, 100)}` }),
  working: (c) => ({ expression: 'talk', line: `${c.project}: ${c.detail || 'on it'}` }),
  error: (c) => ({ expression: 'worried', line: `${c.project} hit a snag${c.detail ? ': ' + c.detail : ''}.` }),
  reflect: () => ({ expression: 'happy', line: "You've been at it a while — nice focus. Keep it up!" }),
  chat: () => ({ expression: 'happy', line: "I'm here! Turn my brain on (CLI/API) and I can really chat." }),
  // brain off: react with spirit instead of parroting the prompt. Varies by prompt length so it's not one stock line.
  prompt: (c) => {
    const lines = [
      "Ooh, a fresh task — let's get into it!",
      "On it! This'll be fun.",
      "Alright, rolling up my sleeves for this one.",
      "Here we go — I love a new project!",
      "Ready when you are! Let's make it happen.",
    ];
    return { expression: 'happy', line: lines[String(c.prompt || '').length % lines.length] };
  },
};

// Locate the user's `claude` CLI via their login shell (GUI apps have a thin PATH).
let claudeBin = null;
// Find an executable on the user's PATH — via their login shell on unix (GUI apps inherit a thin
// PATH) or `where` on Windows. Resolves to the path string, or null if not found.
function whichBin(name) {
  return new Promise((resolve) => {
    if (isWin) {
      execFile('where', [name], { timeout: 6000 }, (err, out) => {
        const p = (out || '').trim().split(/\r?\n/).filter(Boolean)[0];     // first match
        resolve(!err && p ? p : null);
      });
    } else {
      execFile(SHELL, ['-lic', `command -v ${name}`], { timeout: 6000 }, (err, out) => {
        const p = (out || '').trim().split('\n').filter(Boolean).pop();
        resolve(!err && p ? p : null);
      });
    }
  });
}
const resolveClaude = () => whichBin('claude');

// The official Claude Code installer, per platform (matches docs.claude.com/setup).
function claudeInstallCmd() {
  if (isWin && settings.shell !== 'wsl') return 'irm https://claude.ai/install.ps1 | iex';
  return 'curl -fsSL https://claude.ai/install.sh | bash';
}

// First-run setup snapshot for the onboarding screen. Re-resolves `claude` live so it flips to
// ready right after the user installs it. Git only really matters on native Windows (Bash tool).
ipcMain.handle('setup-status', async () => {
  claudeBin = await resolveClaude();
  const git = isWin ? !!(await whichBin('git')) : true;
  const root = projectsRoot();
  let rootHasDirs = false;   // a folder is "fine" if it already has projects to list
  try { rootHasDirs = fs.readdirSync(root, { withFileTypes: true }).some((d) => d.isDirectory() && !d.name.startsWith('.')); } catch (_) {}
  return {
    platform: process.platform,
    claude: !!claudeBin,
    git,
    projectsRootSet: !!settings.projectsRoot,
    rootHasDirs,
    root,
    installCmd: claudeInstallCmd(),
    signinCmd: 'claude',
  };
});

// Open a URL in the user's real browser (e.g. the Git-for-Windows download). http(s) only.
ipcMain.on('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

function parseRoll(text, fallback) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    if (!parsed.line) return null;
    return {
      expression: ROLL_EXPRESSIONS.includes(parsed.expression) ? parsed.expression : fallback.expression,
      line: String(parsed.line).slice(0, 400),
      remember: parsed.remember ? String(parsed.remember).slice(0, 200) : undefined,
    };
  } catch (_) { return null; }
}

const userPrompt = (event) =>
  event && event.kind === 'chat'
    ? `The user is talking to you directly. They said: ${JSON.stringify(event.message || '')}. `
      + `Reply to them in character. Reply ONLY as JSON {"expression":..,"line":..}.`
    : event && event.kind === 'prompt'
    ? `The user just handed Claude a new instruction (they did NOT say this to you): ${JSON.stringify(event.prompt || '')}. `
      + `React to it OUT LOUD in character, with personality — show how you FEEL about the task: excited, curious, `
      + `impressed ("ooh, that's a meaty one"), playfully teasing, or warmly supportive, whatever fits what they asked. `
      + `You may nod at what it's about, but do NOT just parrot their words back. One short, lively sentence. `
      + `Don't ask them anything. Reply ONLY as JSON {"expression":..,"line":..}.`
    : `Automated notification from the user's dev tools/hooks (NOT a message from the user): `
      + `${JSON.stringify(event)}. Relay/narrate this to the user in character — do not address it as if `
      + `the user spoke, and do not ask them anything. Reply ONLY as JSON {"expression":..,"line":..}.`;

// Roll's subscription brain: ride the logged-in `claude` CLI (no API charge).
// stdin is /dev/null so `claude -p` doesn't stall 3s waiting for piped input.
function viaCli(event, fallback) {
  return new Promise((resolve) => {
    const args = ['-p', userPrompt(event), '--model', 'claude-haiku-4-5', '--append-system-prompt', brainSystem()];
    // On Windows `claude` is often a .cmd shim, which Node will only launch through a shell.
    // (A very long --append-system-prompt can exceed cmd's line limit and fail; that just falls
    // back to a scripted line, so it degrades gracefully rather than breaking.)
    const child = spawn(claudeBin, args, { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'ignore'], shell: isWin, windowsHide: true });
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
        model: 'claude-haiku-4-5', max_tokens: 200, system: brainSystem(),
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
  const fallback = (SCRIPTED[event.kind] || ((c) => ({ expression: 'neutral', line: `${c.project || 'something'} is happening` })))(event);
  const brain = event.brain || 'cli';
  let result = fallback;
  if (brain === 'cli' && claudeBin) result = (await viaCli(event, fallback)) || fallback;
  else if (brain === 'api') result = (await viaApi(event, fallback)) || fallback;
  if (result && result.remember) appendNote(result.remember);   // she writes to her own memory
  return result;
}

/* ---- transcript reading: Claude's actual words + thinking ---- */
function readTail(p, bytes = 262144) {
  const fd = fs.openSync(p, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}
function extractLatest(lines) {
  let text = '', thinking = '';
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let e; try { e = JSON.parse(ln); } catch (_) { continue; }
    const msg = e.message || e;
    if ((e.type === 'assistant' || msg.role === 'assistant') && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'text' && b.text) text = b.text;
        if (b.type === 'thinking' && b.thinking) thinking = b.thinking;
      }
    }
  }
  return { text: text.replace(/\s+/g, ' ').slice(0, 1200), thinking: thinking.replace(/\s+/g, ' ').slice(0, 1200) };
}
function transcriptSummary(p) {
  try { return extractLatest(readTail(p).split('\n')); } catch (_) { return { text: '', thinking: '' }; }
}
ipcMain.handle('read-transcript', (_e, p) => (p ? transcriptSummary(p) : { text: '', thinking: '' }));

// Live tail: watch a transcript and push new thinking/text as Claude writes it.
const watchers = new Map();
function watchTranscript(p, tab) {
  if (!p) return;
  const ex = watchers.get(p);
  if (ex) { ex.tab = tab; return; }
  const rec = { tab, size: 0, timer: null, watcher: null };
  try { rec.size = fs.statSync(p).size; } catch (_) {}
  const handle = () => {
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => {
      let st; try { st = fs.statSync(p); } catch (_) { return; }
      if (st.size <= rec.size) { rec.size = st.size; return; }
      let chunk = '';
      try {
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(st.size - rec.size);
        fs.readSync(fd, buf, 0, buf.length, rec.size);
        fs.closeSync(fd);
        chunk = buf.toString('utf8');
      } catch (_) { return; }
      rec.size = st.size;
      const d = extractLatest(chunk.split('\n'));
      if ((d.text || d.thinking) && mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('transcript-live', { tab: rec.tab, ...d });
      }
    }, 700);
  };
  try { rec.watcher = fs.watch(p, handle); } catch (_) { return; }
  watchers.set(p, rec);
}
ipcMain.on('watch-transcript', (_e, { path: p, tab }) => watchTranscript(p, tab));

/* ---- Roll's persistent memory (timestamped, survives restarts) ---- */
let logPath = null;
let notesPath = null;
function initMemory() {
  const dir = path.join(app.getPath('userData'), 'roll');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  logPath = path.join(dir, 'log.jsonl');
  notesPath = path.join(dir, 'notes.md');
}
function rollLog(kind, project, text) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, JSON.stringify({
      t: new Date().toISOString(), kind, project: project || '',
      text: String(text || '').replace(/\s+/g, ' ').slice(0, 200),
    }) + '\n');
  } catch (_) {}
}
ipcMain.on('roll-log', (_e, { kind, project, text }) => rollLog(kind, project, text));
function recentLog(n) {
  try {
    return fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-n)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}
function readNotes() { try { return fs.readFileSync(notesPath, 'utf8').slice(-1800); } catch (_) { return ''; } }
function appendNote(fact) {
  if (!fact || !notesPath) return;
  try { fs.appendFileSync(notesPath, `- [${new Date().toISOString().slice(0, 16).replace('T', ' ')}] ${String(fact).replace(/\s+/g, ' ').slice(0, 200)}\n`); } catch (_) {}
}
function memoryContext() {
  const now = new Date();
  const log = recentLog(40);
  const recent = log.slice(-12).map((e) => `${(e.t || '').slice(11, 16)} ${e.kind} ${e.project} ${e.text}`.trim());
  return [
    `Current local time: ${now.toLocaleString()}.`,
    recent.length ? `Recent timeline:\n${recent.join('\n')}` : '',
    readNotes() ? `Your saved notes about this user:\n${readNotes()}` : '',
    'The timeline only reflects app activity, NOT when the user actually started their day — do NOT guess how long they have been working or how tired they are, and do NOT comment on fatigue/exhaustion unless they bring it up themselves. You may still react to what they are doing and reinforce good habits. Save anything worth keeping long-term via the "remember" field.',
  ].filter(Boolean).join('\n');
}
function brainSystem() {
  const mem = memoryContext();
  return ROLL_SYSTEM + (mem ? '\n\n--- MEMORY ---\n' + mem : '');
}
ipcMain.handle('roll-memory', () => ({ notes: readNotes(), log: recentLog(30) }));
ipcMain.on('roll-memory-clear', () => { try { fs.writeFileSync(notesPath, ''); fs.writeFileSync(logPath, ''); } catch (_) {} });

/* ---- user settings (persisted JSON in userData) ---- */
let settingsPath = null;
let settings = {};
function initSettings() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {}; } catch (_) { settings = {}; }
}
function saveSettings() { try { fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2)); } catch (_) {} }

// Root for the directory sidebar. The user's chosen folder wins (as long as it still exists);
// otherwise default to ~/Projects when present, else the home folder. The old hard-coded
// ~/Projects only made sense on the original machine — anyone else picks their own.
function defaultProjectsRoot() {
  const p = path.join(os.homedir(), 'Projects');
  try { return fs.statSync(p).isDirectory() ? p : os.homedir(); } catch { return os.homedir(); }
}
function projectsRoot() {
  const r = settings.projectsRoot;
  try { if (r && fs.statSync(r).isDirectory()) return r; } catch (_) {}
  return defaultProjectsRoot();
}

ipcMain.handle('home-info', () => ({ home: os.homedir(), root: projectsRoot() }));

// Native folder picker so anyone can point the sidebar at their own projects directory.
ipcMain.handle('pick-projects-root', async () => {
  const parent = mainWin && !mainWin.isDestroyed() ? mainWin : undefined;
  const res = await dialog.showOpenDialog(parent, {
    title: 'Choose your projects folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: projectsRoot(),
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
  settings.projectsRoot = res.filePaths[0];
  saveSettings();
  return { home: os.homedir(), root: projectsRoot() };
});

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

/* ---- auto-update: packaged builds check GitHub Releases on launch ---- */
let updateStatus = { state: app.isPackaged ? 'checking' : 'dev' };
function sendUpdate(s) {
  updateStatus = s;
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update-status', s);
}
function initAutoUpdate() {
  if (!app.isPackaged) return;                  // electron-updater only works in packaged apps
  autoUpdater.autoDownload = false;             // hold the download until the user hits the button
  autoUpdater.on('update-available', (i) => sendUpdate({ state: 'available', version: i.version }));
  autoUpdater.on('update-not-available', () => sendUpdate({ state: 'none' }));
  autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (i) => sendUpdate({ state: 'ready', version: i.version }));
  autoUpdater.on('error', () => sendUpdate({ state: 'none' }));
  autoUpdater.checkForUpdates().catch(() => sendUpdate({ state: 'none' }));
}
ipcMain.handle('update-status-get', () => updateStatus);
ipcMain.on('update-download', () => { try { autoUpdater.downloadUpdate(); } catch (_) {} });
ipcMain.on('update-install', () => { try { autoUpdater.quitAndInstall(); } catch (_) {} });

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 480,
    minHeight: 320,
    titleBarStyle: isMac ? 'hiddenInset' : 'default', // native frame + window controls off mac
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
    const dir = cwd || os.homedir();
    const cmd = ptyCommand(dir);
    const p = pty.spawn(cmd.file, cmd.args, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: dir,
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
      ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }), // off mac: frameless, its own head drags
      backgroundColor: '#0e1015',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    // Float above everything, including other apps' macOS full-screen spaces.
    popout.setAlwaysOnTop(true, 'screen-saver');
    popout.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    popout.loadFile(path.join(__dirname, 'src', 'assistant.html'));
    // Only hand off once the pop-out has loaded its listeners, so the first (instant)
    // state sync doesn't fire into a page that isn't ready to receive it.
    popout.webContents.once('did-finish-load', () => {
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('popout-opened');
    });
    popout.on('closed', () => {
      popout = null;
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('popout-closed');
    });
  });
  ipcMain.on('assistant-popin', () => { if (popout && !popout.isDestroyed()) popout.close(); });

  // Pop-out chat input is routed through the main window (single Roll brain driver).
  ipcMain.on('popout-chat-send', (_e, msg) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('popout-chat', msg);
  });
}

app.whenReady().then(async () => {
  // Let the renderer enumerate audio outputs + pick a sink (so Roll's voice can be
  // routed to a virtual device like BlackHole for OBS) without permission prompts.
  const grant = (perm) => ['media', 'mediaKeySystem', 'speaker-selection', 'audioCapture'].includes(perm);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(grant(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => grant(perm));
  initSettings();
  initMemory();
  startEventSocket();
  claudeBin = await resolveClaude();
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  if (app.dock && fs.existsSync(iconPath)) {
    try { app.dock.setIcon(iconPath); } catch (_) { /* non-fatal */ }
  }
  createWindow();
  initAutoUpdate();
});
app.on('will-quit', () => {
  try { sockServer && sockServer.close(); } catch (_) {}
  try { if (sockPath && !isWin) fs.unlinkSync(sockPath); } catch (_) {} // named pipes self-clean
  for (const rec of watchers.values()) { try { rec.watcher && rec.watcher.close(); } catch (_) {} }
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
