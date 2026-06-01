/* souljaterm renderer: colored tabs, window tint, GPU terminals, Roll assistant. */

const Terminal = window.Terminal;
const FitAddon = window.FitAddon.FitAddon;
const WebglAddon = window.WebglAddon ? window.WebglAddon.WebglAddon : null;

const tabs = [];
let active = null;
let seq = 0;
let HOME = '/';

const el = {
  tabList: document.getElementById('tab-list'),
  newTab: document.getElementById('new-tab'),
  terminals: document.getElementById('terminals'),
  dirList: document.getElementById('dir-list'),
  app: document.getElementById('app'),
  sidebarToggle: document.getElementById('sidebar-toggle'),
  emptyArt: document.getElementById('empty-art'),
  face: document.getElementById('face'),
  msg: document.getElementById('msg'),
  fontPicker: document.getElementById('font-picker'),
  rollBrain: document.getElementById('roll-brain'),
  voicePick: document.getElementById('voice-pick'),
  memClear: document.getElementById('mem-clear'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  assistantMin: document.getElementById('assistant-min'),
  assistantPopout: document.getElementById('assistant-popout'),
  assistantRestore: document.getElementById('assistant-restore'),
};

/* ---- color: stable hue from a path ---- */
function hueOf(p) {
  let h = 0;
  for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) >>> 0;
  return h % 360;
}
function colorForPath(p) {
  const hue = hueOf(p);
  return {
    hue,
    swatch: `hsl(${hue} 60% 50%)`,
    tabBg: `hsl(${hue} 42% 40%)`,
    tabBgActive: `hsl(${hue} 58% 52%)`,
    tabFg: `hsl(${hue} 30% 96%)`,
  };
}
function basename(p) { const a = p.replace(/\/+$/, '').split('/'); return a[a.length - 1] || p; }
function prettyName(p) { return p === HOME ? '~' : basename(p); }

/* ---- fonts ---- */
const FONTS = ['SF Mono', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'IBM Plex Mono',
  'Menlo', 'Monaco', 'Andale Mono', 'Courier New'];
function currentFont() { try { return localStorage.getItem('font') || 'SF Mono'; } catch { return 'SF Mono'; } }
function fontStack(f) { return `"${f}", "SF Mono", Menlo, monospace`; }
function applyFont(f) {
  document.documentElement.style.setProperty('--mono-font', fontStack(f));
  tabs.forEach((t) => { t.term.options.fontFamily = fontStack(f); t.fit.fit(); });
  try { localStorage.setItem('font', f); } catch (_) {}
}
function initFontPicker() {
  const avail = FONTS.filter((f) => { try { return document.fonts.check(`13px "${f}"`); } catch { return true; } });
  if (!avail.length) avail.push('SF Mono');
  const saved = avail.includes(currentFont()) ? currentFont() : avail[0];
  el.fontPicker.replaceChildren(...avail.map((f) => {
    const o = document.createElement('option'); o.value = f; o.textContent = f; o.selected = f === saved; return o;
  }));
  el.fontPicker.addEventListener('change', () => applyFont(el.fontPicker.value));
  applyFont(saved);
}

/* ---- terminal theme ---- */
const THEME = {
  background: '#0e1015', foreground: '#c0caf5', cursor: '#c0caf5', selectionBackground: '#283457',
  black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
  blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
  brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68',
  brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
};

function newTab(cwd) {
  const id = `t${++seq}`;
  cwd = cwd || HOME;
  const term = new Terminal({
    fontFamily: fontStack(currentFont()), fontSize: 13, cursorBlink: true,
    allowProposedApi: true, theme: THEME, macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const host = document.createElement('div');
  host.className = 'term-host';
  el.terminals.appendChild(host);
  term.open(host);

  if (WebglAddon) {
    try { const gl = new WebglAddon(); gl.onContextLoss(() => gl.dispose()); term.loadAddon(gl); }
    catch (_) { /* fall back to canvas */ }
  }

  const tab = { id, term, fit, host, cwd, title: prettyName(cwd), el: null, status: 'idle' };
  tabs.push(tab);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.innerHTML = '<span class="label"></span><span class="status"></span><span class="close">×</span>';
  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('close')) closeTab(tab); else activate(tab);
  });
  el.tabList.appendChild(tabEl);
  tab.el = tabEl;
  paintTab(tab);

  window.souljaterm.spawn({ id, cwd: tab.cwd, cols: term.cols, rows: term.rows });
  term.onData((d) => { window.souljaterm.input(id, d); clearAttention(tab); });
  term.onResize(({ cols, rows }) => window.souljaterm.resize(id, cols, rows));

  term.parser.registerOscHandler(7, (data) => {
    try { setCwd(tab, decodeURIComponent(new URL(data).pathname)); } catch (_) {}
    return false;
  });

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.metaKey) return true;
    if (e.key === 't') { newTab(active ? active.cwd : HOME); return false; }
    if (e.key === 'w') { closeTab(tab); return false; }
    if (e.key === 'b') { toggleSidebar(); return false; }
    if (/^[1-9]$/.test(e.key)) { const t = tabs[+e.key - 1]; if (t) activate(t); return false; }
    if (e.key === '}' || (e.shiftKey && e.key === ']')) { cycle(1); return false; }
    if (e.key === '{' || (e.shiftKey && e.key === '[')) { cycle(-1); return false; }
    return true;
  });

  el.app.classList.add('has-tabs');
  activate(tab);
  window.souljaterm.rollLog('session', tab.title, 'opened');
  roll('session_open', { project: tab.title });
  return tab;
}

function paintTab(tab) {
  const c = colorForPath(tab.cwd);
  tab.el.style.setProperty('--tab-bg', c.tabBg);
  tab.el.style.setProperty('--tab-bg-active', c.tabBgActive);
  tab.el.style.setProperty('--tab-fg', c.tabFg);
  tab.el.querySelector('.label').textContent = tab.title;
}
function setCwd(tab, cwd) {
  if (tab.cwd === cwd) return;
  tab.cwd = cwd; tab.title = prettyName(cwd);
  paintTab(tab);
  if (tab === active) applyTint(cwd);
}
function applyTint(cwd) {
  document.documentElement.style.setProperty('--tint-hue', cwd ? hueOf(cwd) : 220);
}

function activate(tab) {
  active = tab;
  tabs.forEach((t) => { t.host.classList.toggle('active', t === tab); t.el.classList.toggle('active', t === tab); });
  applyTint(tab ? tab.cwd : null);
  clearAttention(tab);
  requestAnimationFrame(() => { tab.fit.fit(); tab.term.focus(); });
}
function cycle(dir) {
  if (!active) return;
  const i = tabs.indexOf(active);
  const next = tabs[(i + dir + tabs.length) % tabs.length];
  if (next) activate(next);
}
function closeTab(tab) {
  window.souljaterm.kill(tab.id);
  const i = tabs.indexOf(tab);
  tab.term.dispose(); tab.host.remove(); tab.el.remove();
  tabs.splice(i, 1);
  roll('session_close', { project: tab.title });
  if (active === tab) {
    const next = tabs[Math.min(i, tabs.length - 1)];
    if (next) activate(next);
    else { active = null; el.app.classList.remove('has-tabs'); applyTint(null); }
  }
}

/* ---- per-tab state badge (left of ×) + chiptune alert ----
   idle      → nothing
   thinking  → ⚠️  Claude is working in that session
   done      → ❗  finished its turn while you were elsewhere (flashes + chirps)
   question  → ‼️  waiting on you to answer/permit something (flashes + chirps)
   The badge shows on any tab; the flash + sound only fire when it's NOT the active tab. */
const TAB_STATUS = {
  idle:     { icon: '',     flash: false },
  thinking: { icon: '⚠️',  flash: false },
  done:     { icon: '❗',  flash: true, sfx: 'done' },
  question: { icon: '‼️',  flash: true, sfx: 'question' },
};
function setTabStatus(tab, name) {
  if (!tab || !tab.el || tab.status === name) return;
  const s = TAB_STATUS[name] || TAB_STATUS.idle;
  tab.status = name;
  const dot = tab.el.querySelector('.status');
  if (dot) dot.textContent = s.icon;
  const alert = s.flash && tab !== active;
  tab.el.classList.toggle('attention', alert);
  if (alert && s.sfx) sfx(s.sfx);            // every call here is a fresh transition → chirp once
}
// Streaming thinking events must never stomp a done/question flag the user hasn't seen yet.
function markThinking(tab) {
  if (tab && (tab.status === 'idle' || tab.status === 'thinking')) setTabStatus(tab, 'thinking');
}
function clearAttention(tab) {
  if (!tab || !tab.el) return;
  tab.el.classList.remove('attention');
  if (tab.status === 'done' || tab.status === 'question') setTabStatus(tab, 'idle'); // user looked → handled
}

// Retro chiptune blips (square waves, snappy envelope) — a Mega-Man-ish system chirp, synthesized
// so we ship no copyrighted audio. Honors the same mute switch as Roll's voice.
let _sfxCtx = null;
function sfx(kind) {
  try { if (localStorage.getItem('rollVoice') === 'off') return; } catch (_) {}
  if (!_sfxCtx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    try { _sfxCtx = new C(); } catch (_) { return; }
  }
  const ctx = _sfxCtx;
  if (ctx.state === 'suspended') ctx.resume();
  const seq = kind === 'question'
    ? [[660, 0], [660, 0.12], [988, 0.24]]   // insistent triple, rising — "answer me"
    : [[784, 0], [1175, 0.10]];              // quick two-note ping — "done"
  for (const [freq, at] of seq) {
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + 0.12);
  }
}

// Bells just flash the tab — they carry no info worth narrating, so Roll stays quiet.
function flagAttention(tab) { if (tab !== active) tab.el.classList.add('attention'); }

/* ---- pty -> terminal ---- */
window.souljaterm.onData(({ id, data }) => {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  tab.term.write(data);
  if (data.includes('\x07')) flagAttention(tab); // visual flash only, no chatter
});
window.souljaterm.onExit(({ id }) => {
  const tab = tabs.find((t) => t.id === id);
  if (tab) closeTab(tab);
});

/* ---- Roll, the assistant ---- */
const rollFace = new window.RollFace(el.face, el.msg);
let lastRoll = { expression: 'happy', line: "Hi! I'm Roll. I'll keep an eye on your sessions." };

function renderRoll(state) {
  lastRoll = state;
  rollFace.speak(state);
  window.souljaterm.assistantRender(state); // mirror to popout window if open
}

// brain mode: off (scripted) | cli (subscription) | api (Haiku key)
function currentBrain() { try { return localStorage.getItem('rollBrain') || 'cli'; } catch { return 'cli'; } }
function initBrainPicker() {
  const opts = [['cli', 'Plan (CLI)'], ['api', 'API (Haiku)'], ['off', 'Off (scripted)']];
  const saved = currentBrain();
  el.rollBrain.replaceChildren(...opts.map(([v, label]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = label; o.selected = v === saved; return o;
  }));
  el.rollBrain.addEventListener('change', () => {
    try { localStorage.setItem('rollBrain', el.rollBrain.value); } catch (_) {}
  });
}

// Ask main for an in-character line (Haiku via CLI/API) with scripted fallback.
// Cooldown for LLM summaries (free micro-narration below isn't gated by this).
const ROLL_COOLDOWN_MS = 8000;
let _lastRollAt = 0;
async function roll(kind, ctx) {
  const now = Date.now();
  if (now - _lastRollAt < ROLL_COOLDOWN_MS) return; // global cooldown on LLM lines
  _lastRollAt = now;
  try {
    const state = await window.souljaterm.rollSpeak({ kind, ...ctx, brain: currentBrain(), tabCount: tabs.length });
    if (state && state.line) renderRoll(state);
  } catch (_) { /* never let Roll break the terminal */ }
}

/* ---- narrate real Claude Code activity (fed by hooks via the socket) ---- */
function tabName(id) { const t = tabs.find((x) => x.id === id); return t ? t.title : ''; }
function fileBase(p) { return String(p || '').split('/').pop() || 'a file'; }
const oneline = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const clip = (s, n) => { s = oneline(s); return s.length > n ? s.slice(0, n) + '…' : s; };
const countLines = (s) => { s = String(s || ''); return s ? (s.match(/\n/g) || []).length + 1 : 0; };

// Pull the SUBSTANCE out of a tool's RESULT (PostToolUse, so tool_response exists).
// Returns { expr, line, notable, llm, detail }:
//   line     - cheap scripted fact to show instantly when we don't spend an LLM call
//   notable  - worth surfacing at all (false ⇒ stay quiet, nothing to report)
//   llm      - the result carries real insight; let Roll's brain read `detail` and react
//   detail   - truncated raw result handed to the brain
function summarizeResult(name, input, response) {
  input = input || {};
  const obj = response && typeof response === 'object' ? response : {};
  const txt = typeof response === 'string'
    ? response
    : (obj.stdout || obj.stderr || obj.output || obj.content || obj.result || (response ? JSON.stringify(response) : ''));
  switch (name) {
    case 'Bash': {
      const err = oneline(obj.stderr);
      const code = obj.exit_code ?? obj.returnCode ?? obj.code;
      if (err && code !== 0 && /error|fail|fatal|not found|denied|traceback|exception|cannot/i.test(err))
        return { expr: 'worried', line: `that errored: ${clip(err, 55)}`, notable: true, llm: true, detail: clip(err, 300) };
      const out = oneline(obj.stdout || txt);
      if (!out) return { expr: 'neutral', line: 'command done, no output', notable: false };
      return { expr: 'talk', line: clip(out, 70), notable: true, llm: true, detail: clip(out, 400) };
    }
    case 'Grep': case 'Glob': {
      if (!txt || /no matches|no files|^0\b/i.test(oneline(txt)))
        return { expr: 'neutral', line: 'no matches', notable: true, llm: false };
      const n = countLines(txt);
      return { expr: 'happy', line: `found ${n} hit${n === 1 ? '' : 's'}`, notable: true, llm: true, detail: clip(txt, 400) };
    }
    case 'Read':
      return { expr: 'neutral', line: `read ${fileBase(input.file_path)}`, notable: false, llm: true, detail: clip(txt, 400) };
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return { expr: 'happy', line: `saved ${fileBase(input.file_path || input.notebook_path)}`, notable: true, llm: false };
    case 'WebFetch': case 'WebSearch':
      return { expr: 'neutral', line: clip(txt || 'looked it up', 70), notable: true, llm: true, detail: clip(txt, 400) };
    case 'Task':
      return { expr: 'surprised', line: clip(txt || 'subagent finished', 70), notable: true, llm: true, detail: clip(txt, 400) };
    case 'TodoWrite':
      return { expr: 'neutral', line: 'updated the plan', notable: false, llm: false };
    default:
      return { expr: 'talk', line: clip(txt, 60), notable: false, llm: false };
  }
}

const toolBuffer = {};            // tab id -> recent RESULT summaries (what came back, not what ran)
let _microAt = 0;
let _microKey = '';
let _thinkAt = 0;
function narrateClaude(evt) {
  const h = evt.hook || {};
  const name = h.hook_event_name;
  const proj = tabName(evt.tab) || evt.project || 'a session';
  const tabObj = tabs.find((t) => t.id === evt.tab);
  if (h.transcript_path) window.souljaterm.watchTranscript(h.transcript_path, evt.tab); // live thinking
  if (name === 'UserPromptSubmit') {
    setTabStatus(tabObj, 'thinking');         // user just acted → working, clears any stale flag
    const p = clip(h.prompt, 80);
    window.souljaterm.rollLog('prompt', proj, p);
    if (/\broll\b/i.test(p)) chatToRoll(p);                          // user addressed Roll directly
    else reactToPrompt(proj, clip(h.prompt, 240));                   // she reacts with personality, not a verbatim echo
  } else if (name === 'PreToolUse') {
    markThinking(tabObj);
    // Results carry Roll's voice now — don't chatter about every tool *starting*.
    // The one "about to" beat worth flagging is spawning a subagent.
    if (h.tool_name === 'Task') renderRoll({ expression: 'surprised', line: `${proj}: spinning up a subagent` });
  } else if (name === 'PostToolUse') {
    markThinking(tabObj);
    const r = summarizeResult(h.tool_name, h.tool_input, h.tool_response);
    if (!r.line) return;
    (toolBuffer[evt.tab] || (toolBuffer[evt.tab] = [])).push(r.line);
    if (toolBuffer[evt.tab].length > 12) toolBuffer[evt.tab].shift();
    const now = Date.now();
    // Real insight + LLM brain off cooldown ⇒ let Roll READ the result and react
    // to what it reveals. Otherwise drop the cheap scripted fact (free, throttled).
    if (r.notable && r.llm && now - _lastRollAt >= ROLL_COOLDOWN_MS) {
      roll('insight', { project: proj, tool: h.tool_name, detail: r.detail || r.line, did: (toolBuffer[evt.tab] || []).slice(-8) });
    } else if (r.notable) {
      const key = `${evt.tab}:${r.line}`;
      if (now - _microAt < 2500 || key === _microKey) return; // light throttle, no instant dupes
      _microAt = now; _microKey = key;
      renderRoll({ expression: r.expr, line: `${proj}: ${r.line}` });
    }
  } else if (name === 'Notification') {
    setTabStatus(tabObj, 'question');          // ‼️ blocked on the user — answer/permission needed
    window.souljaterm.rollLog('needs-you', proj, h.message || '');
    renderRoll({ expression: 'surprised', line: `${proj} needs you${h.message ? ': ' + h.message : ''}` });
  } else if (name === 'Stop' || name === 'SubagentStop') {
    // Main Stop = turn's over: flag done (❗ + chirp) unless you're already watching this tab.
    // SubagentStop = a helper finished but the main turn rolls on, so keep the working badge.
    if (name === 'Stop') setTabStatus(tabObj, tabObj === active ? 'idle' : 'done');
    else markThinking(tabObj);
    const did = (toolBuffer[evt.tab] || []).slice(-8);
    toolBuffer[evt.tab] = [];
    (async () => {
      // read Claude's actual final words + thinking so the summary is real, not guessed
      let tr = { text: '', thinking: '' };
      try { tr = (await window.souljaterm.readTranscript(h.transcript_path)) || tr; } catch (_) {}
      window.souljaterm.rollLog('done', proj, tr.text || did.join(', '));
      roll('done', { project: proj, did, summary: tr.text, thinking: tr.thinking });
    })();
  }
}
window.souljaterm.onClaudeEvent(narrateClaude);

// Live thinking as Claude writes it to the transcript (throttled; needs her brain on).
window.souljaterm.onTranscriptLive(({ tab, thinking, text }) => {
  markThinking(tabs.find((t) => t.id === tab));   // badge follows real activity even with her brain off
  if (currentBrain() === 'off') return;
  const note = thinking || text;
  if (!note) return;
  const now = Date.now();
  if (now - _thinkAt < 16000) return;
  _thinkAt = now;
  roll('thinking', { project: tabName(tab) || '', detail: oneline(note).slice(0, 400) });
});

// Periodic supportive reflection while there's activity (she reads her timestamped memory).
setInterval(() => { if (tabs.length) roll('reflect', { project: active ? active.title : '' }); }, 25 * 60 * 1000);

// Direct chat to Roll (chat bar, or a prompt that mentions her) — bypasses the cooldown.
async function chatToRoll(message) {
  if (!message || !message.trim()) return;
  renderRoll({ expression: 'talk', line: '...' });
  try {
    const state = await window.souljaterm.rollSpeak({ kind: 'chat', message, brain: currentBrain(), tabCount: tabs.length });
    if (state && state.line) renderRoll(state);
  } catch (_) {}
}
window.souljaterm.onPopoutChat((msg) => chatToRoll(msg));

// When the user fires off a prompt to Claude, Roll reacts to it with personality (brain reads the
// task and riffs; brain-off falls back to a spirited canned line). Bypasses the LLM cooldown — a
// fresh prompt is exactly the moment a reaction is wanted.
async function reactToPrompt(project, prompt) {
  try {
    const state = await window.souljaterm.rollSpeak({ kind: 'prompt', project, prompt, brain: currentBrain(), tabCount: tabs.length });
    if (state && state.line) renderRoll(state);
  } catch (_) {}
}

/* ---- sidebar ---- */
async function loadSidebar() {
  const { root } = await window.souljaterm.homeInfo();
  const dirs = await window.souljaterm.listDir(root);
  el.dirList.innerHTML = '';
  for (const d of dirs) {
    const item = document.createElement('div');
    item.className = 'dir-item';
    item.innerHTML = `<span class="dir-swatch" style="background:${colorForPath(d.path).swatch}"></span><span>${d.name}</span>`;
    item.title = `New session in ${d.path}`;
    item.addEventListener('click', () => newTab(d.path));
    el.dirList.appendChild(item);
  }
}
function toggleSidebar() {
  el.app.classList.toggle('sidebar-collapsed');
  requestAnimationFrame(() => active && active.fit.fit());
}

/* ---- assistant dock / popout ---- */
el.assistantMin.addEventListener('click', () => el.app.classList.add('assistant-min'));
el.assistantRestore.addEventListener('click', () => el.app.classList.remove('assistant-min'));
el.assistantPopout.addEventListener('click', () => window.souljaterm.popout());
el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = el.chatInput.value;
  el.chatInput.value = '';
  chatToRoll(v);
});
el.memClear.addEventListener('click', () => {
  window.souljaterm.clearMemory();
  renderRoll({ expression: 'neutral', line: 'memory cleared — fresh start!' });
});
function initVoicePick() {
  let v = 'on';
  try { v = localStorage.getItem('rollVoice') || 'on'; } catch (_) {}
  el.voicePick.value = v;
  el.voicePick.addEventListener('change', () => {
    try { localStorage.setItem('rollVoice', el.voicePick.value); } catch (_) {}
  });
}
window.souljaterm.onPopoutOpened(() => { el.app.classList.add('assistant-out'); renderRoll(lastRoll); });
window.souljaterm.onPopoutClosed(() => el.app.classList.remove('assistant-out'));

/* ---- wiring ---- */
el.newTab.addEventListener('click', () => newTab(active ? active.cwd : HOME));
el.sidebarToggle.addEventListener('click', toggleSidebar);
window.addEventListener('resize', () => active && active.fit.fit());

(async function init() {
  const info = await window.souljaterm.homeInfo();
  HOME = info.home;
  initFontPicker();
  initBrainPicker();
  initVoicePick();
  rollFace.speak(lastRoll);
  await loadSidebar();
})();
