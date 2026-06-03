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
  sidebarShow: document.getElementById('sidebar-show'),
  face: document.getElementById('face'),
  msgTab: document.getElementById('msg-tab'),
  msg: document.getElementById('msg'),
  fontPicker: document.getElementById('font-picker'),
  rollBrain: document.getElementById('roll-brain'),
  voicePick: document.getElementById('voice-pick'),
  voiceStyle: document.getElementById('roll-voice-style'),
  voiceVol: document.getElementById('voice-vol'),
  blipVol: document.getElementById('blip-vol'),
  sfxVol: document.getElementById('sfx-vol'),
  dirPick: document.getElementById('dir-pick'),
  memClear: document.getElementById('mem-clear'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  assistantMin: document.getElementById('assistant-min'),
  assistantRestore: document.getElementById('assistant-restore'),
  fxScope: document.getElementById('fx-scope'),
  fxScopeModal: document.getElementById('fx-scope-modal'),
  fxEdit: document.getElementById('fx-edit'),
  fxModal: document.getElementById('fx-modal'),
  fxClose: document.getElementById('fx-close'),
  fxPreset: document.getElementById('fx-preset'),
  fxParams: document.getElementById('fx-params'),
  fxFolder: document.getElementById('fx-folder'),
  fxReload: document.getElementById('fx-reload'),
  fxSource: document.getElementById('fx-source'),
  fxApply: document.getElementById('fx-apply'),
  fxError: document.getElementById('fx-error'),
  assistantSettings: document.getElementById('assistant-settings'),
  rollModal: document.getElementById('roll-modal'),
  rollClose: document.getElementById('roll-close'),
  rollSpeed: document.getElementById('roll-speed'),
  rollLang: document.getElementById('roll-lang'),
  rollVerbosity: document.getElementById('roll-verbosity'),
  sysinfo: document.getElementById('sysinfo'),
  siBatt: document.getElementById('si-batt'),
  siDay: document.getElementById('si-day'),
  siClock: document.getElementById('si-clock'),
};

/* ---- color: projects fanned across the rainbow, alphabetical ---- */
// Every known project (a folder in the sidebar) gets an evenly-spaced hue assigned in A–Z
// order, so the sidebar reads as a rainbow top-to-bottom and each tab inherits its project's
// color. Folders we don't know yet (a stray cwd, a subdir) fall back to a stable per-name hash.
let RAINBOW = new Map();           // project name -> hue (0–359), rebuilt when the sidebar loads
function buildRainbow(names) {
  const sorted = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  const n = sorted.length || 1;
  RAINBOW = new Map(sorted.map((name, i) => [name, Math.round((360 * i) / n)]));
}
function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
function basename(p) { const a = String(p).replace(/[\\/]+$/, '').split(/[\\/]/); return a[a.length - 1] || p; } // handles \ and /
function prettyName(p) { return p === HOME ? '~' : basename(p); }
function hueOf(p) { const k = prettyName(p); return RAINBOW.has(k) ? RAINBOW.get(k) : hashHue(k); }
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

  const tab = { id, term, fit, host, cwd, title: prettyName(cwd), activity: '', el: null, status: 'idle' };
  tabs.push(tab);

  // Refit on ANY size change to the active tab's host — window resize, sidebar toggle, minimize,
  // and crucially browser zoom (⌘+/−), which otherwise leaves the grid misaligned with the
  // scrollbar (inactive tabs are display:none → size 0, so only refit the visible one).
  tab.ro = new ResizeObserver(() => {
    if (tab === active) requestAnimationFrame(() => { try { fit.fit(); } catch (_) {} });
  });
  tab.ro.observe(host);

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
  roll('session_open', { project: tab.title, tab: tab.id });
  return tab;
}

function paintTab(tab) {
  const c = colorForPath(tab.cwd);
  tab.el.style.setProperty('--tab-bg', c.tabBg);
  tab.el.style.setProperty('--tab-bg-active', c.tabBgActive);
  tab.el.style.setProperty('--tab-fg', c.tabFg);
  // Label is "dir: what's happening" once Roll has named the task; just the dir otherwise.
  const label = tab.activity ? `${tab.title}: ${tab.activity}` : tab.title;
  tab.el.querySelector('.label').textContent = label;
  tab.el.title = label;   // full text on hover, since background tabs ellipsize
}
// Roll names the current task (≤30 chars); we hang it off the tab as "dir: topic".
// A new topic replaces the old; an empty one leaves the last topic alone.
function setTabActivity(tab, title) {
  if (!tab || !tab.el) return;
  const a = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  if (!a || tab.activity === a) return;
  tab.activity = a;
  paintTab(tab);
}
function setCwd(tab, cwd) {
  if (tab.cwd === cwd) return;
  tab.cwd = cwd; tab.title = prettyName(cwd);
  tab.activity = '';            // moved to a new project → drop the old topic
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
  if (tab.ro) { try { tab.ro.disconnect(); } catch (_) {} }
  tab.term.dispose(); tab.host.remove(); tab.el.remove();
  tabs.splice(i, 1);
  roll('session_close', { project: tab.title });
  if (active === tab) {
    const next = tabs[Math.min(i, tabs.length - 1)];
    if (next) activate(next);
    else { active = null; el.app.classList.remove('has-tabs'); applyTint(null); loadOnboarding(); } // refresh setup status
  }
}

/* ---- per-tab state badge (left of ×) + chiptune alert ----
   idle      → nothing
   thinking  → nothing — "working" is tracked internally but shows NO badge. A persistent
               busy icon flickered (watchdog cleared it, a late tool event re-lit it), and a
               steady indicator isn't worth that: the only thing worth a glance is when a tab
               actually needs you, which the two states below cover.
   done      → ❗  finished its turn while you were elsewhere (flashes + chirps)
   question  → ❓  waiting on you to answer/permit something (flashes + chirps)
   A badge only ever appears on a tab you're NOT looking at; ❗/❓ flash + chirp too. */
const TAB_STATUS = {
  idle:     { icon: '',     flash: false },
  thinking: { icon: '',     flash: false },  // working = no badge (see note above)
  done:     { icon: '❗',  flash: true, sfx: 'done' },
  question: { icon: '❓',  flash: true, sfx: 'question' },
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
  if (tab && (tab.status === 'idle' || tab.status === 'thinking')) {
    const now = Date.now();
    tab.thinkingAt = now;               // any sign of life (hooks OR pty) feeds the watchdog
    setTabStatus(tab, 'thinking');
  }
}
// Watchdog: a working tab emits hooks + terminal output constantly. We clear ⚠️ only when
// the tab goes genuinely SILENT — no hooks AND no pty data — for this long, which means the
// turn ended without a Stop hook (interrupt, crash, dropped event). We deliberately do NOT
// clear a tab that's still actively streaming output just because the last *Claude hook* was
// a while ago: a single long-running tool (a big build/test) emits no intermediate hooks but
// pipes to the pty the whole time. Dropping its ⚠️ mid-turn made the badge flicker off, then
// snap back to ❗ at completion. A finished turn goes quiet → this still catches it in 90s.
const THINKING_IDLE_MS = 90000;        // dead silent (no hooks AND no pty) → drop the badge
setInterval(() => {
  const now = Date.now();
  for (const t of tabs) {
    if (t.status !== 'thinking') continue;
    if (!t.thinkingAt || now - t.thinkingAt > THINKING_IDLE_MS) setTabStatus(t, 'idle');
  }
}, 5000);
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
// Claude Code's inline confirm/permission prompt ("Do you want to proceed?  ❯ 1. Yes …")
// does NOT reliably emit a Notification hook, so the tab would otherwise sit on ⚠️ while it's
// actually blocked waiting on you. Sniff the prompt's signature straight from the pty stream
// and flip the tab to ❓. A false hit self-heals — the next Stop/thinking event clears it.
const CLAUDE_ASKS = /Do you want to (proceed|continue|create|run|make|allow|apply)|❯\s*1\.\s*Yes|No, and tell Claude|\(y\/n\)/i;
window.souljaterm.onData(({ id, data }) => {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  tab.term.write(data);
  if (tab.status === 'thinking') tab.thinkingAt = Date.now(); // live output = still working; keep the watchdog fed
  if (tab.status !== 'question' && CLAUDE_ASKS.test(data))
    setTabStatus(tab, tab === active ? 'idle' : 'question'); // it's blocked on you → ❓ (idle if you're already here)
  if (data.includes('\x07')) flagAttention(tab); // visual flash only, no chatter
});
window.souljaterm.onExit(({ id }) => {
  const tab = tabs.find((t) => t.id === id);
  if (tab) closeTab(tab);
});

/* ---- Roll, the assistant ---- */
const rollFace = new window.RollFace(el.face, el.msg);
el.face.classList.add('warp-pending'); // hidden until the boot warp-in (init → rollFace.intro)
let lastRoll = { expression: 'happy', line: "Hi! I'm Roll. I'll keep an eye on your sessions." }; // localized at boot in init()

// The colored "which tab" header above Roll's message. Driven by the face's onStart hook so it
// flips exactly when the line it belongs to starts typing (Roll queues lines, so the state we
// hand renderRoll isn't always the one on screen yet). A state with no `tab` hides the header.
let _msgTabId = null;
let _msgTaskId = null;
function setMsgHeader(state) {
  const node = el.msgTab;
  if (!node) return;
  const rt = state && state.rollTask;                               // one of Roll's own "!" tasks
  const tab = state && state.tab ? tabs.find((t) => t.id === state.tab) : null;
  node.classList.toggle('roll-task', !!rt);
  if (rt) {                                                         // ROLL-themed header: "ROLL: <task>"
    node.style.removeProperty('--msg-tab-bg');
    node.style.removeProperty('--msg-tab-fg');
    node.textContent = 'ROLL: ' + rt.label;
    node.hidden = false;
    _msgTaskId = rt.id; _msgTabId = null;
  } else if (tab) {                                                 // a project session: its colored tab name
    const c = colorForPath(tab.cwd);
    node.style.setProperty('--msg-tab-bg', c.tabBgActive);
    node.style.setProperty('--msg-tab-fg', c.tabFg);
    node.textContent = tab.title;
    node.hidden = false;
    _msgTabId = tab.id; _msgTaskId = null;
  } else { node.hidden = true; _msgTabId = null; _msgTaskId = null; return; }
  node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash'); // re-trigger flash
}
rollFace.onStart = (state) => setMsgHeader(state);
if (el.msgTab) el.msgTab.addEventListener('click', () => {
  if (_msgTaskId) { openTasks(); highlightTaskCard(_msgTaskId); return; } // her own task → open the panel on it
  const t = tabs.find((x) => x.id === _msgTabId);
  if (t) activate(t);
});

// Pick a voice clip by MEANING — the same way her expression is chosen. Most lines get none
// (just animalese); the notable beats get a Japanese exclamation from the downloaded set.
function pickClip(s) {
  const expr = s.expression;
  const line = String(s.line || '').toLowerCase();
  const kind = s.kind;
  if (kind === 'attention' || kind === 'error' || expr === 'worried' || expr === 'cry' || expr === 'sad'
      || /error|fail|crash|snag|stuck|denied|can'?t|cannot|broke/.test(line)) return 'tasukete';     // help!
  if (kind === 'done' || expr === 'laugh' || /\bdone\b|passed|fixed|works|success|complete|shipped/.test(line)) return 'yattane'; // we did it!
  if (kind === 'insight' || expr === 'surprised' || /found|discover|turns out|\bhits?\b|matches/.test(line)) return 'mitete';     // watch this!
  if (kind === 'reflect' || /keep it up|you'?ve got|don'?t worry|i'?m here|hang in|got your back|nice focus/.test(line)) return 'makasete'; // leave it to me (reassurance)
  if (kind === 'prompt' || kind === 'session_open' || /let'?s|\bstart|new task|here we go/.test(line))
    return (line.length % 3 === 0) ? 'makasete' : 'ikuyo'; // mostly "here we go", occasionally "leave it to me"
  return null;
}

function renderRoll(state) {
  lastRoll = state;
  // If Roll named the task, retitle its tab as "dir: topic" (rides the brain calls she already makes).
  if (state.title && state.tab) setTabActivity(tabs.find((t) => t.id === state.tab), state.title);
  if (state.clip === undefined) state.clip = pickClip(state); // choose her exclamation (or none)
  rollFace.speak(state);
}

// The language Roll speaks — her brain output AND the scripted micro-narrations below.
function currentLang() { try { return localStorage.getItem('rollLang') || 'en'; } catch { return 'en'; } }
// Localized scripted snippets Roll says without her brain (saved X, found N, tab labels, etc.).
// Brain-ON lines are translated by the model via the language directive; these cover the free path.
const I18N = {
  en: {
    saved: (f) => `saved ${f}`,
    found: (n) => `found ${n} hit${n === 1 ? '' : 's'}`,
    noMatches: () => 'no matches',
    subagent: () => 'spinning up a subagent',
    needsYou: (p, msg) => `${p} needs you${msg ? ': ' + msg : ''}`,
    greeting: () => "Hi! I'm Roll. I'll keep an eye on your sessions.",
    brainOffChat: () => "…my brain's off — flip it to CLI/API and I can really chat.",
    oops: () => '…that one tripped me up. Try again?',
  },
  ja: {
    saved: (f) => `${f} を保存したよ`,
    found: (n) => `${n}件 見つけた！`,
    noMatches: () => 'ヒットなし',
    subagent: () => 'サブエージェント、起動するね',
    needsYou: (p, msg) => `${p} があなたを待ってるよ${msg ? '：' + msg : ''}`,
    greeting: () => 'やっほー！ ロールだよ。セッション、見ててあげるね！',
    brainOffChat: () => '…いま頭(ブレイン)がオフなんだ。CLI か API にしてくれたら、ちゃんとお話しできるよ！',
    oops: () => '…うまくいかなかった。もう一回ためしてみて？',
  },
};
function L() { return I18N[currentLang()] || I18N.en; }

// Roll changing her OWN settings on request (her brain returns a whitelisted `settings` object;
// see main.js userPrompt). Each applier persists the value AND syncs the matching ⚙-panel control
// so the UI reflects what she just did. Unknown keys/values are ignored.
const clamp01to100 = (v) => Math.max(0, Math.min(100, Math.round(Number(v))));
const ROLL_SETTING_APPLIERS = {
  language(v) { if (v === 'en' || v === 'ja') setRollLang(v); },
  voice(v) {
    if (v !== 'on' && v !== 'off') return;
    try { localStorage.setItem('rollVoice', v); } catch (_) {}
    if (el.voicePick) el.voicePick.value = v;
  },
  voiceStyle(v) {
    if (v !== 'mora' && v !== 'blips') return;
    try { localStorage.setItem('rollVoiceStyle', v); } catch (_) {}
    if (el.voiceStyle) el.voiceStyle.value = v;
  },
  clipVolume(v) {
    if (isNaN(Number(v))) return; const n = clamp01to100(v);
    try { localStorage.setItem('rollClipVol', String(n / 100)); } catch (_) {}
    if (el.voiceVol) el.voiceVol.value = n;
  },
  blipVolume(v) {
    if (isNaN(Number(v))) return; const n = clamp01to100(v);
    try { localStorage.setItem('rollBlipVol', String(n / 100)); } catch (_) {}
    if (el.blipVol) el.blipVol.value = n;
  },
  sfxVolume(v) {
    if (isNaN(Number(v))) return; const n = clamp01to100(v);
    try { localStorage.setItem('rollSfxVol', String(n / 100)); } catch (_) {}
    if (el.sfxVol) el.sfxVol.value = n;
  },
  textSpeed(v) {
    const ms = { slow: SPEED_MS_MAX, normal: 38, fast: SPEED_MS_MIN }[String(v).toLowerCase()];
    if (ms == null) return;
    try { localStorage.setItem('rollTextSpeed', String(ms)); } catch (_) {}
    if (el.rollSpeed) el.rollSpeed.value = speedToSlider(ms);
  },
  brain(v) {
    if (!['off', 'cli', 'api', 'free'].includes(v)) return;
    try { localStorage.setItem('rollBrain', v); } catch (_) {}
    if (el.rollBrain) el.rollBrain.value = v;
  },
  verbosity(v) {   // reply length 0..100 (short↔long); the token budget derives from it
    if (isNaN(Number(v))) return; const n = Math.max(0, Math.min(100, Math.round(Number(v))));
    try { localStorage.setItem('rollVerbosity', String(n)); } catch (_) {}
    if (el.rollVerbosity) el.rollVerbosity.value = n;
  },
  crt(v) {
    if (v !== 'on' && v !== 'off') return;
    if (window.Fx) Fx.setEnabled(v === 'on');   // Fx.onChange(renderFxUI) syncs the on/off selects
  },
};
function applyRollSettings(s) {
  if (!s || typeof s !== 'object') return;
  for (const k of Object.keys(s)) { try { ROLL_SETTING_APPLIERS[k] && ROLL_SETTING_APPLIERS[k](s[k]); } catch (_) {} }
}

function setRollLang(v) {
  try { localStorage.setItem('rollLang', v); } catch (_) {}
  if (el.rollLang) el.rollLang.value = v;
}

// One reply-length control (0..100, left=short → right=long): it both steers the brain's prompt
// (brevity↔chatty, CLI + API) AND sizes the token ceiling underneath, so it can never truncate her at
// the length she's aiming for. Stored as rollVerbosity; the token budget is derived, not a separate knob.
const TOKENS_MIN = 128, TOKENS_MAX = 1536;
function currentVerbosity() { try { const s = localStorage.getItem('rollVerbosity'); if (s != null && s !== '') return Math.max(0, Math.min(100, parseInt(s, 10))); } catch (_) {} return 30; }
function lengthToTokens(v) { return Math.max(TOKENS_MIN, Math.min(TOKENS_MAX, Math.round(160 + (v / 100) * 1376))); }
function currentMaxTokens() { return lengthToTokens(currentVerbosity()); }
function initVerbosity() {
  if (!el.rollVerbosity) return;
  el.rollVerbosity.value = currentVerbosity();
  el.rollVerbosity.addEventListener('input', () => { try { localStorage.setItem('rollVerbosity', String(el.rollVerbosity.value)); } catch (_) {} });
}
function initRollLang() {
  if (!el.rollLang) return;
  el.rollLang.value = currentLang();
  el.rollLang.addEventListener('change', () => setRollLang(el.rollLang.value));
}

// brain mode: off (scripted) | cli (subscription) | api (Haiku key)
function currentBrain() { try { return localStorage.getItem('rollBrain') || 'cli'; } catch { return 'cli'; } }
function initBrainPicker() {
  const opts = [['cli', 'Plan (CLI)'], ['free', 'Free (Gemini)'], ['api', 'API (Haiku)'], ['off', 'Off (scripted)']];
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
// Roll is "off duty" while minimized: tab badges still fire, but she does no hook narration —
// which also means no brain calls, so she isn't burning credits when you've tucked her away.
function rollActive() { return !el.app.classList.contains('assistant-min'); }
async function roll(kind, ctx) {
  if (!rollActive()) return;                         // minimized → don't spend a brain call
  const now = Date.now();
  if (now - _lastRollAt < ROLL_COOLDOWN_MS) return; // global cooldown on LLM lines
  _lastRollAt = now;
  try {
    const state = await window.souljaterm.rollSpeak({ kind, ...ctx, brain: currentBrain(), lang: currentLang(), maxTokens: currentMaxTokens(), verbosity: currentVerbosity(), tabCount: tabs.length });
    if (state && state.settings) applyRollSettings(state.settings);    // she can adjust her own settings on request
    if (state && state.line) renderRoll({ ...state, tab: ctx.tab, kind }); // carry tab (header) + kind (clip choice)
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
        return { expr: 'worried', line: `that errored: ${clip(err, 55)}`, notable: true, llm: true, raw: true, detail: clip(err, 300) };
      const out = oneline(obj.stdout || txt);
      if (!out) return { expr: 'neutral', line: 'command done, no output', notable: false };
      return { expr: 'talk', line: clip(out, 70), notable: true, llm: true, raw: true, detail: clip(out, 400) };
    }
    case 'Grep': case 'Glob': {
      if (!txt || /no matches|no files|^0\b/i.test(oneline(txt)))
        return { expr: 'neutral', line: L().noMatches(), notable: true, llm: false };
      const n = countLines(txt);
      return { expr: 'happy', line: L().found(n), notable: true, llm: true, detail: clip(txt, 400) };
    }
    case 'Read':
      return { expr: 'neutral', line: `read ${fileBase(input.file_path)}`, notable: false, llm: true, detail: clip(txt, 400) };
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return { expr: 'happy', line: L().saved(fileBase(input.file_path || input.notebook_path)), notable: true, llm: false };
    case 'WebFetch': case 'WebSearch':
      return { expr: 'neutral', line: clip(txt || 'looked it up', 70), notable: true, llm: true, raw: true, detail: clip(txt, 400) };
    case 'Task':
      return { expr: 'surprised', line: clip(txt || 'subagent finished', 70), notable: true, llm: true, raw: true, detail: clip(txt, 400) };
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
    if (tabObj) tabObj.thinkingAt = Date.now();
    setTabStatus(tabObj, 'thinking');         // user just acted → working, clears any stale flag
    const p = clip(h.prompt, 80);
    window.souljaterm.rollLog('prompt', proj, p);
    if (/\broll\b/i.test(p)) chatToRoll(p);                          // user addressed Roll directly
    else reactToPrompt(proj, clip(h.prompt, 240), evt.tab);          // she reacts with personality, not a verbatim echo
  } else if (name === 'PreToolUse') {
    markThinking(tabObj);
    // Results carry Roll's voice now — don't chatter about every tool *starting*.
    // The one "about to" beat worth flagging is spawning a subagent.
    if (h.tool_name === 'Task' && rollActive()) renderRoll({ expression: 'surprised', line: `${proj}: ${L().subagent()}`, tab: evt.tab });
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
      roll('insight', { project: proj, tool: h.tool_name, detail: r.detail || r.line, did: (toolBuffer[evt.tab] || []).slice(-8), tab: evt.tab });
    } else if (r.notable && !r.raw) {
      // Only paraphrased facts (found N hits, saved X, no matches) go through the free path.
      // Raw tool output never gets echoed verbatim — it waits for her brain to put it in her words.
      const key = `${evt.tab}:${r.line}`;
      if (now - _microAt < 2500 || key === _microKey) return; // light throttle, no instant dupes
      _microAt = now; _microKey = key;
      if (rollActive()) renderRoll({ expression: r.expr, line: `${proj}: ${r.line}`, tab: evt.tab });
    }
  } else if (name === 'Notification') {
    // Notification fires for real permission/answer prompts AND for plain idle nudges
    // ("waiting for your input"). Only a genuine ask is a ‼️ question; everything else is
    // just a ❗ done-style ping. And if you're already on the tab, none of it applies —
    // no icon, no flash, no chirp.
    const msg = h.message || '';
    const isQuestion = /permission|approve|grant|allow|confirm|respond|answer|choose|select|waiting|input|y\/n|\?/i.test(msg);
    const status = tabObj === active ? 'idle' : (isQuestion ? 'question' : 'done');
    setTabStatus(tabObj, status);
    window.souljaterm.rollLog('needs-you', proj, msg);
    if (rollActive()) renderRoll({ expression: 'surprised', line: L().needsYou(proj, msg), tab: evt.tab, kind: 'attention' });
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
      roll('done', { project: proj, did, summary: tr.text, thinking: tr.thinking, tab: evt.tab });
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
  roll('thinking', { project: tabName(tab) || '', detail: oneline(note).slice(0, 400), tab });
});

// Periodic supportive reflection while there's activity (she reads her timestamped memory).
setInterval(() => { if (tabs.length) roll('reflect', { project: active ? active.title : '', tab: active ? active.id : undefined }); }, 25 * 60 * 1000);

// Direct chat to Roll (chat bar, or a prompt that mentions her) — bypasses the cooldown.
async function chatToRoll(message) {
  if (!message || !message.trim()) return;
  const m = message.trim();
  if (m === '!') { openTasks(); return; }                          // bare "!" → just open the task panel
  if (m.startsWith('!')) { launchTask(m.slice(1).trim()); return; } // "!do something" → Roll actually does it
  window.souljaterm.rollLog('you', '', m);                          // your side of the conversation (timestamped)
  rollFace.thinking();                                              // looping "Roll is thinking..." until she answers
  try {
    const state = await window.souljaterm.rollSpeak({ kind: 'chat', message, brain: currentBrain(), lang: currentLang(), maxTokens: currentMaxTokens(), verbosity: currentVerbosity(), tabCount: tabs.length });
    if (state && state.settings) applyRollSettings(state.settings);   // "speak Japanese" / "be quiet" / etc. — she does it herself
    if (state && state.line) { renderRoll(state); window.souljaterm.rollLog('roll', '', state.line); } // and hers (stops thinking)
    else rollFace.show({ expression: 'neutral', line: L().brainOffChat() });
  } catch (_) { rollFace.show({ expression: 'neutral', line: L().oops() }); }
}
// Roll's own housekeeping notices (e.g. memory compaction) — pushed from main, rendered in character.
if (window.souljaterm.onRollNote) window.souljaterm.onRollNote((s) => { if (s && s.line && rollActive()) renderRoll(s); });

// When the user fires off a prompt to Claude, Roll reacts to it with personality (brain reads the
// task and riffs; brain-off falls back to a spirited canned line). Bypasses the LLM cooldown — a
// fresh prompt is exactly the moment a reaction is wanted.
async function reactToPrompt(project, prompt, tab) {
  if (!rollActive()) return;                         // minimized → no personality reaction (saves a brain call)
  try {
    const state = await window.souljaterm.rollSpeak({ kind: 'prompt', project, prompt, brain: currentBrain(), lang: currentLang(), maxTokens: currentMaxTokens(), verbosity: currentVerbosity(), tabCount: tabs.length });
    if (state && state.settings) applyRollSettings(state.settings);
    if (state && state.line) renderRoll({ ...state, tab, kind: 'prompt' });
  } catch (_) {}
}

/* ---- sidebar ---- */
async function loadSidebar() {
  const { root } = await window.souljaterm.homeInfo();
  if (el.dirPick) { el.dirPick.textContent = prettyName(root); el.dirPick.title = `Sidebar folder: ${root} — click to change`; }
  const dirs = await window.souljaterm.listDir(root);
  buildRainbow(dirs.map((d) => d.name));   // assign the rainbow A–Z before painting anything
  tabs.forEach(paintTab);                  // recolor any already-open tabs to match
  if (active) applyTint(active.cwd);
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

/* ---- first-run onboarding, rendered into the empty terminal ---- */
function h(tag, attrs, ...kids) {           // tiny CSP-safe element builder (no innerHTML)
  const e = document.createElement(tag);
  for (const k in (attrs || {})) { if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
  for (const c of kids) e.append(c && c.nodeType ? c : document.createTextNode(c == null ? '' : c));
  return e;
}
function runInNewTab(cmd) {                  // open a session and type a command into it
  const tab = newTab(active ? active.cwd : HOME);
  setTimeout(() => window.souljaterm.input(tab.id, cmd + '\r'), 700); // let the shell draw its prompt first
  return tab;
}
async function pickFolderThenReload() {
  const info = await window.souljaterm.pickProjectsRoot();
  if (info) await loadSidebar();
  loadOnboarding();
}
function onboardStep(st) {
  const row = h('div', { class: 'ob-step' },
    h('span', { class: 'ob-mark ' + (st.ok ? 'ok' : 'no') }, st.mark || (st.ok ? '✓' : '•')),
    h('div', { class: 'ob-body' },
      h('div', { class: 'ob-title' }, st.title),
      h('div', { class: 'ob-note' }, st.note || '')));
  if (st.actions && st.actions.length) {
    const acts = h('div', { class: 'ob-actions' });
    for (const a of st.actions) { const b = h('button', { class: 'btn' }, a.label); b.addEventListener('click', a.run); acts.append(b); }
    row.append(acts);
  }
  return row;
}
/* auto-updater banner (shown atop the empty-state, before any tab is opened) */
let updateState = { state: 'none' };
function updateCard() {
  const s = updateState || {};
  if (s.state === 'available') {
    // Unsigned mac (s.manual) can't self-install — it downloads the DMG and opens it for a drag.
    const btn = h('button', { class: 'btn big ob-update' },
      s.manual ? `⤓ Download v${s.version} & update` : `⤓ Update to v${s.version} & restart`);
    btn.addEventListener('click', () => {
      window.souljaterm.updateDownload();
      updateState = { state: 'downloading', percent: 0, manual: s.manual };
      loadOnboarding();
    });
    return h('div', { class: 'ob-banner' }, h('div', { class: 'ob-bantxt' }, 'A new souljaterm is available!'), btn);
  }
  if (s.state === 'downloading') return h('div', { class: 'ob-banner' }, h('div', { class: 'ob-bantxt' }, `Downloading update… ${s.percent || 0}%`));
  // Manual mac: DMG downloaded + opened — tell them the last step (Squirrel can't do it for us).
  if (s.state === 'manual-ready') return h('div', { class: 'ob-banner' }, h('div', { class: 'ob-bantxt' }, 'Downloaded — drag souljaterm into Applications, then reopen to finish. ✨'));
  if (s.state === 'ready') return h('div', { class: 'ob-banner' }, h('div', { class: 'ob-bantxt' }, 'Update ready — restarting…'));
  return null;
}
function initUpdates() {
  if (!window.souljaterm.onUpdateStatus) return;
  window.souljaterm.onUpdateStatus((s) => {
    updateState = s || { state: 'none' };
    if (updateState.state === 'ready') { window.souljaterm.updateInstall(); return; }   // they asked → relaunch into it
    if (updateState.state === 'available' && rollActive())
      renderRoll({ expression: 'surprised', line: `Ooh — souljaterm v${updateState.version} is out! Hit update.`, clip: 'mitete' });
    loadOnboarding();
  });
  if (window.souljaterm.updateStatusGet)
    window.souljaterm.updateStatusGet().then((s) => {
      if (!s) return;
      updateState = s;
      // A 'ready' that landed before our listener attached would otherwise stick on
      // "restarting…" forever — catch it here so the install still fires.
      if (s.state === 'ready') { window.souljaterm.updateInstall(); return; }
      loadOnboarding();
    }).catch(() => {});
}
async function loadOnboarding() {
  const host = document.getElementById('onboard');
  if (!host) return;
  let s; try { s = await window.souljaterm.setupStatus(); } catch (_) { return; }
  const win = s.platform === 'win32';
  const folderOk = !!(s.projectsRootSet || s.rootHasDirs);
  const steps = [];

  // 1. Claude Code CLI — one-button install + sign in if missing
  steps.push(s.claude
    ? { ok: true, title: 'Claude Code is ready', note: "Roll's CLI brain is good to go" }
    : { ok: false, title: 'Install Claude Code', note: 'so you can code + Roll can think',
        actions: [
          { label: 'Install', run: () => runInNewTab(s.installCmd) },
          { label: 'Sign in', run: () => runInNewTab(s.signinCmd) },
        ] });

  // Native Windows: Claude's Bash tool wants Git for Windows
  if (win && !s.git) steps.push({ ok: false, title: 'Install Git for Windows', note: "Claude's Bash tool needs it",
    actions: [{ label: 'Get Git', run: () => window.souljaterm.openExternal('https://git-scm.com/download/win') }] });

  // 2. Projects folder
  steps.push({ ok: folderOk, title: folderOk ? 'Projects folder set' : 'Pick your projects folder',
    note: prettyName(s.root), actions: [{ label: 'Choose…', run: pickFolderThenReload }] });

  // macOS: one-time Full Disk Access. We can't trigger the grant (no API) — only deep-link
  // to the pane; the user flips it once. Paired with the ad-hoc signature, the grant then
  // persists across launches, so TCC stops re-prompting every time Claude touches files.
  if (s.platform === 'darwin') steps.push({ ok: false, mark: '🔓', title: 'Allow Full Disk Access (one-time)',
    note: 'so macOS stops asking every launch',
    actions: [{ label: 'Open Settings', run: () => window.souljaterm.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles') }] });

  // 3. Go — plain session, plus a one-click Claude that skips its tool-permission prompts
  const goActions = [{ label: 'New session', run: () => newTab(active ? active.cwd : HOME) }];
  if (s.claude) goActions.push({ label: 'Claude (skip perms)', run: () => runInNewTab('claude --dangerously-skip-permissions') });
  steps.push({ ok: false, mark: '▸', title: 'Open a session', note: 'pick a folder at left, or ⌘T', actions: goActions });

  const recheck = h('button', { class: 'btn ob-recheck' }, '↻ re-check');
  recheck.addEventListener('click', loadOnboarding);
  const upd = updateCard();
  host.replaceChildren(
    ...(upd ? [upd] : []),
    h('h2', {}, 'SOULJATERM'),
    h('div', { class: 'sub' }, s.claude && folderOk ? 'you’re set — jump in.' : 'let’s get you set up.'),
    ...steps.map(onboardStep),
    recheck,
  );

  // Roll nudges — only when something's actually missing, so she's not chatty once you're set up.
  if (rollActive() && !(s.claude && folderOk)) {
    renderRoll({
      expression: 'happy', clip: null,
      line: !s.claude ? 'Install Claude Code and sign in — then I can really think!'
                      : 'Pick your projects folder and I’ll list them on the left!',
    });
  }
}

/* ---- assistant dock ---- */
// Minimizing reclaims her strip: refit so the terminal grows into it instead of leaving a black gap.
function refitActive() { requestAnimationFrame(() => active && active.fit.fit()); }
el.assistantMin.addEventListener('click', () => { el.app.classList.add('assistant-min'); refitActive(); });
el.assistantRestore.addEventListener('click', () => { el.app.classList.remove('assistant-min'); refitActive(); });
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
// Voice style: spoken syllables (kana + English-as-katakana) vs the synth blips. Unset defaults to
// syllables for Japanese, blips for English — same rule roll-face uses, so the control matches what plays.
function initVoiceStyle() {
  if (!el.voiceStyle) return;
  let v = null;
  try { v = localStorage.getItem('rollVoiceStyle'); } catch (_) {}
  el.voiceStyle.value = (v === 'mora' || v === 'blips') ? v : (currentLang() === 'ja' ? 'mora' : 'blips');
  el.voiceStyle.addEventListener('change', () => {
    try { localStorage.setItem('rollVoiceStyle', el.voiceStyle.value); } catch (_) {}
  });
}
// Voice-clip volume (her recorded clips sit much hotter than the animalese, so this dials them
// down/up to taste). Stored as rollClipVol 0..1; roll-face reads it on every clip.
function initVoiceVol() {
  if (!el.voiceVol) return;
  let v = 0.3;
  try { const s = localStorage.getItem('rollClipVol'); if (s != null && s !== '') v = parseFloat(s); } catch (_) {}
  if (isNaN(v)) v = 0.3;
  el.voiceVol.value = Math.round(Math.max(0, Math.min(1, v)) * 100);
  el.voiceVol.addEventListener('input', () => {
    try { localStorage.setItem('rollClipVol', String(el.voiceVol.value / 100)); } catch (_) {}
  });
}
// Animalese-blip volume (her per-keystroke typing chirps). Stored as rollBlipVol 0..1; roll-face
// reads it on every blip. Default 0.55 ≈ the original baked-in level.
function initBlipVol() {
  if (!el.blipVol) return;
  let v = 0.55;
  try { const s = localStorage.getItem('rollBlipVol'); if (s != null && s !== '') v = parseFloat(s); } catch (_) {}
  if (isNaN(v)) v = 0.55;
  el.blipVol.value = Math.round(Math.max(0, Math.min(1, v)) * 100);
  el.blipVol.addEventListener('input', () => {
    try { localStorage.setItem('rollBlipVol', String(el.blipVol.value / 100)); } catch (_) {}
  });
}
// Reaction-sound (Animal Crossing emote) volume. roll-face reads 'rollSfxVol' 0..1 per play; default
// 0.45. Shares the master voice on/off; this only sets level, like the clip/blip sliders.
function initSfxVol() {
  if (!el.sfxVol) return;
  let v = 0.45;
  try { const s = localStorage.getItem('rollSfxVol'); if (s != null && s !== '') v = parseFloat(s); } catch (_) {}
  if (isNaN(v)) v = 0.45;
  el.sfxVol.value = Math.round(Math.max(0, Math.min(1, v)) * 100);
  el.sfxVol.addEventListener('input', () => {
    try { localStorage.setItem('rollSfxVol', String(el.sfxVol.value / 100)); } catch (_) {}
  });
}
// Baseline typing speed for her replies. roll-face reads 'rollTextSpeed' (ms per character) at the
// start of every line. Slider runs SLOW (left) → FAST (right); we map 0..100 onto SPEED_MS_MAX..MIN
// so dragging right speeds her up. Default ≈ the engine's built-in 38ms/char.
const SPEED_MS_MIN = 14, SPEED_MS_MAX = 75;
function speedToSlider(ms) { return Math.round(((SPEED_MS_MAX - ms) / (SPEED_MS_MAX - SPEED_MS_MIN)) * 100); }
function sliderToSpeed(v) { return Math.round(SPEED_MS_MAX - (v / 100) * (SPEED_MS_MAX - SPEED_MS_MIN)); }
function initTextSpeed() {
  if (!el.rollSpeed) return;
  let ms = 38;
  try { const s = localStorage.getItem('rollTextSpeed'); if (s != null && s !== '') ms = parseFloat(s); } catch (_) {}
  if (isNaN(ms)) ms = 38;
  el.rollSpeed.value = speedToSlider(Math.max(SPEED_MS_MIN, Math.min(SPEED_MS_MAX, ms)));
  el.rollSpeed.addEventListener('input', () => {
    try { localStorage.setItem('rollTextSpeed', String(sliderToSpeed(+el.rollSpeed.value))); } catch (_) {}
  });
}
// Roll's settings modal (the ⚙ in her header): voice on/off + clip/blip volume + speech speed.
function initRollSettings() {
  if (!el.assistantSettings || !el.rollModal) return;
  const open = () => { el.rollModal.hidden = false; };
  const close = () => { el.rollModal.hidden = true; };
  el.assistantSettings.addEventListener('click', open);
  if (el.rollClose) el.rollClose.addEventListener('click', close);
  el.rollModal.addEventListener('click', (e) => { if (e.target === el.rollModal) close(); });
}

/* ---- system-info HUD (battery / day / clock) on the right of the title bar ---- */
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function tickClock() {
  if (!el.siClock) return;
  const d = new Date();
  let hh = d.getHours();
  const mm = pad2(d.getMinutes());
  const ampm = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12; if (hh === 0) hh = 12;
  el.siClock.textContent = `${hh}:${mm} ${ampm}`;
  el.siDay.textContent = `${DAYS[d.getDay()]} ${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
}
function renderBattery(b) {
  if (!el.siBatt) return;
  if (!b) { el.siBatt.textContent = ''; return; }    // desktop / no battery API → hide the cell
  const pct = Math.round(b.level * 100);
  el.siBatt.textContent = (b.charging ? '⚡' : '') + 'BAT ' + pct + '%';
  el.sysinfo.classList.toggle('charging', b.charging);
  el.sysinfo.classList.toggle('low', !b.charging && pct <= 20);
}
function initSysInfo() {
  if (!el.sysinfo) return;
  tickClock();
  setInterval(tickClock, 15000);   // minute-resolution clock; 15s keeps it honest near the rollover
  // collapse to clock-only on click; remembered across launches
  try { if (localStorage.getItem('sysinfoCollapsed') === '1') el.sysinfo.classList.add('collapsed'); } catch (_) {}
  el.sysinfo.addEventListener('click', () => {
    const c = el.sysinfo.classList.toggle('collapsed');
    try { localStorage.setItem('sysinfoCollapsed', c ? '1' : '0'); } catch (_) {}
  });
  if (navigator.getBattery) {
    navigator.getBattery().then((b) => {
      renderBattery(b);
      for (const ev of ['levelchange', 'chargingchange']) b.addEventListener(ev, () => renderBattery(b));
    }).catch(() => renderBattery(null));
  } else {
    renderBattery(null);
  }
}
/* ---- Roll's task manager: free-form "!do this" agents she runs for you ---- */
// No input box here on purpose — the one way to start a task is to "!type" it to Roll in her
// chat. The panel is just the live view of what she's doing.
const taskEls = {
  panel: document.getElementById('tasks-panel'),
  close: document.getElementById('tasks-close'),
  hud: document.getElementById('tasks-hud'),
  list: document.getElementById('task-list'),
  empty: document.getElementById('task-empty'),
};
const taskCards = new Map();      // id -> { data, el, headEl, statusEl, actionsEl, logEl }
let _hudTimer = null;
const STATUS_LABEL = {
  routing: 'routing…', planning: 'planning…', planned: 'plan ready',
  running: 'running…', done: 'done', failed: 'failed', cancelled: 'cancelled',
};

function tasksOpen() { return taskEls.panel && !taskEls.panel.hidden; }
function openTasks() {
  if (!taskEls.panel) return;
  taskEls.panel.hidden = false;
  renderHud();
  updateTaskEmpty();
  if (!_hudTimer) _hudTimer = setInterval(renderHud, 2000);
  requestAnimationFrame(() => active && active.fit.fit());   // terminal narrowed — refit it
}
// Show the getting-started blurb only while no task cards exist.
function updateTaskEmpty() {
  if (taskEls.empty) taskEls.empty.hidden = taskCards.size > 0;
}
// Scroll a task's card into view and flash it (used when you click Roll's "ROLL: <task>" header).
function highlightTaskCard(id) {
  const card = taskCards.get(id); if (!card) return;
  card.el.scrollIntoView({ block: 'nearest' });
  card.el.classList.remove('flash'); void card.el.offsetWidth; card.el.classList.add('flash');
}
function closeTasks() {
  if (!taskEls.panel) return;
  taskEls.panel.hidden = true;
  if (_hudTimer) { clearInterval(_hudTimer); _hudTimer = null; }
  requestAnimationFrame(() => active && active.fit.fit());   // terminal widened again — refit it
}

const HUD_ICON = { idle: '○', thinking: '◐', done: '❗', question: '❓' };
function renderHud() {
  if (!taskEls.hud) return;
  if (!tabs.length) { taskEls.hud.replaceChildren(h('div', { class: 'hud-empty' }, 'no open sessions')); return; }
  taskEls.hud.replaceChildren(...tabs.map((t) => {
    const c = colorForPath(t.cwd);
    const label = t.activity ? `${t.title}: ${t.activity}` : t.title;
    const row = h('div', { class: 'hud-row' + (t === active ? ' active' : '') },
      h('span', { class: 'hud-dot', style: `background:${c.swatch}` }),
      h('span', { class: 'hud-name' }, label),
      h('span', { class: 'hud-state s-' + t.status }, HUD_ICON[t.status] || ''));
    row.title = label;
    row.addEventListener('click', () => activate(t));
    return row;
  }));
}

// Launch a task: route the model if Auto, show a live card, kick off the agent, and have Roll
// acknowledge it in character. plan-first runs read-only first and waits for Approve.
async function launchTask(promptText, opts) {
  opts = opts || {};
  const prompt = String(promptText || '').trim();
  if (!prompt) return;
  if (!tasksOpen()) openTasks();
  const dir = opts.dir || (taskEls.dir && taskEls.dir.value) || (active && active.cwd) || HOME;
  const planFirst = opts.plan != null ? opts.plan : (taskEls.plan ? taskEls.plan.checked : true);
  let model = opts.model || (taskEls.model && taskEls.model.value) || 'auto';
  const id = `task-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const card = createTaskCard(id, { prompt, dir, model, plan: planFirst });
  if (model === 'auto') {
    setCardStatus(id, 'routing');
    try { const r = await window.souljaterm.taskRoute(prompt); model = r.model || 'sonnet'; card.data.reason = r.reason; }
    catch (_) { model = 'sonnet'; }
  }
  card.data.model = model;
  renderCardHead(id);
  window.souljaterm.taskStart({ id, prompt, dir, model, mode: planFirst ? 'plan' : 'run' });
  (async () => {                                  // witty in-character ack (her brain, with scripted fallback)
    try {
      const ack = await window.souljaterm.rollSpeak({ kind: 'task_start', prompt, dir, model, brain: currentBrain(), lang: currentLang(), maxTokens: currentMaxTokens(), verbosity: currentVerbosity() });
      if (ack && ack.settings) applyRollSettings(ack.settings);
      if (ack && ack.line && rollActive()) renderRoll({ ...ack, kind: 'prompt', rollTask: { id, label: clip(prompt, 40) } });
    } catch (_) {}
  })();
}

function createTaskCard(id, data) {
  const headEl = h('div', { class: 'task-card-head' });   // top row: model badge + status
  const statusEl = h('span', { class: 'task-status' });
  const promptEl = h('div', { class: 'task-prompt' });     // the asked prompt, full width, wraps
  const actionsEl = h('div', { class: 'task-actions' });
  const logEl = h('div', { class: 'task-log' });
  const card = { data: { id, status: 'queued', ...data }, headEl, statusEl, promptEl, actionsEl, logEl };
  card.el = h('div', { class: 'task-card' }, headEl, promptEl, logEl, actionsEl);
  taskCards.set(id, card);
  taskEls.list.prepend(card.el);
  updateTaskEmpty();
  renderCardHead(id);
  renderCardActions(id);
  return card;
}
function renderCardHead(id) {
  const card = taskCards.get(id); if (!card) return;
  const d = card.data;
  const dismiss = h('button', { class: 'btn task-dismiss', title: 'Dismiss task' }, '×');
  dismiss.addEventListener('click', () => removeTaskCard(id));
  card.headEl.replaceChildren(
    h('span', { class: 'task-model m-' + (d.model || 'auto') }, String(d.model || 'auto').toUpperCase()),
    card.statusEl,                                          // pushed to the right of the badge row
    dismiss,
  );
  card.promptEl.textContent = clip(d.prompt, 160);
  card.promptEl.title = `${d.prompt}\n${d.dir}${d.reason ? `\nRoll picked ${d.model}: ${d.reason}` : ''}`;
}
// Clear a card off the list. If it's still working, cancel it first so nothing keeps running.
function removeTaskCard(id) {
  const card = taskCards.get(id); if (!card) return;
  if (['routing', 'planning', 'running'].includes(card.data.status)) {
    try { window.souljaterm.taskCancel(id); } catch (_) {}
  }
  card.el.remove();
  taskCards.delete(id);
  updateTaskEmpty();
}
function setCardStatus(id, status) {
  const card = taskCards.get(id); if (!card) return;
  card.data.status = status;
  card.statusEl.textContent = STATUS_LABEL[status] || status;
  card.statusEl.className = 'task-status st-' + status;
  renderCardActions(id);
  if (status === 'done' || status === 'failed' || status === 'cancelled') narrateTaskEnd(card.data);
  else if (status === 'planned') narrateTaskPlanned(card.data);
}
function renderCardActions(id) {
  const card = taskCards.get(id); if (!card) return;
  const d = card.data;
  const acts = [];
  if (d.status === 'planned') {
    const approve = h('button', { class: 'btn' }, '✓ Approve & run');
    approve.addEventListener('click', () => {
      appendTaskLine(id, '— approved, running for real —', 'sys');
      // Resume the SAME session the plan was made in, so it executes that exact plan instead of re-planning.
      window.souljaterm.taskStart(d.sessionId
        ? { id, prompt: 'Approved — go ahead and carry out that plan now.', dir: d.dir, model: d.model, mode: 'run', resume: d.sessionId }
        : { id, prompt: d.prompt, dir: d.dir, model: d.model, mode: 'run' });
    });
    acts.push(approve);
  }
  if (d.status === 'planning' || d.status === 'running') {
    const cancel = h('button', { class: 'btn' }, '✕ Cancel');
    cancel.addEventListener('click', () => window.souljaterm.taskCancel(id));
    acts.push(cancel);
  }
  // Finished thread → let you keep going in the same context (claude --resume).
  if ((d.status === 'done' || d.status === 'failed' || d.status === 'cancelled') && d.sessionId) {
    const form = h('form', { class: 'task-followup' });
    const input = h('input', { type: 'text', placeholder: 'ask Roll to keep going…' });
    form.append(input);
    form.addEventListener('submit', (e) => { e.preventDefault(); const v = input.value; input.value = ''; launchFollowup(id, v); });
    acts.push(form);
  }
  card.actionsEl.replaceChildren(...acts);
}
// Continue an existing task's thread with a new instruction (remembers everything the run did).
function launchFollowup(id, text) {
  const card = taskCards.get(id); if (!card) return;
  const followup = String(text || '').trim(); if (!followup) return;
  const d = card.data;
  if (!d.sessionId) { appendTaskLine(id, '⚠ no session to resume', 'err'); return; }
  d._narrated = false;                                         // let her react to the follow-up's outcome too
  appendTaskLine(id, `— follow-up: ${followup} —`, 'sys');
  const planFirst = taskEls.plan ? taskEls.plan.checked : false;
  window.souljaterm.taskStart({ id, prompt: followup, dir: d.dir, model: d.model, mode: planFirst ? 'plan' : 'run', resume: d.sessionId });
}
function appendTaskLine(id, text, cls) {
  const card = taskCards.get(id); if (!card || !text) return;
  card.logEl.appendChild(h('div', { class: 'log-line' + (cls ? ' log-' + cls : '') }, text));
  card.logEl.scrollTop = card.logEl.scrollHeight;
  while (card.logEl.childNodes.length > 200) card.logEl.removeChild(card.logEl.firstChild);
}
// Roll herself always stays in character — she's the one giving you the warm, readable update
// about her agents' work (the agents themselves talk terse robot, in their own card logs). Each
// of her task reports rides a "ROLL: <task>" header so you know which job she's talking about.
function taskReport(d, line, expression, voiceClip) {
  if (!rollActive()) return;
  renderRoll({ expression, line, clip: voiceClip || null, rollTask: { id: d.id, label: clip(d.prompt, 40) } });
}
function narrateTaskEnd(d) {
  if (d._narrated) return;
  d._narrated = true;
  const t = clip(d.prompt, 38);
  if (d.status === 'done') taskReport(d, `Done with "${t}" — told you I'd handle it!`, 'laugh', 'yattane');
  else if (d.status === 'failed') taskReport(d, `Eep — "${t}" hit a snag. Peek at the log?`, 'worried', 'tasukete');
  else if (d.status === 'cancelled') taskReport(d, `Okay, I dropped "${t}".`, 'neutral');
}
function narrateTaskPlanned(d) {
  taskReport(d, `Plan's ready for "${clip(d.prompt, 38)}" — wanna look it over?`, 'surprised', 'mitete');
}

window.souljaterm.onTaskEvent(({ id, type, ...p }) => {
  const card = taskCards.get(id); if (!card) return;
  if (type === 'session') { card.data.sessionId = p.sessionId; return; }
  if (type === 'status') setCardStatus(id, p.status);
  else if (type === 'tool') appendTaskLine(id, `▸ ${p.summary}`, 'tool');
  else if (type === 'text') appendTaskLine(id, p.text, 'text');
  else if (type === 'result') appendTaskLine(id, p.result, p.isError ? 'err' : 'result');
  else if (type === 'error') appendTaskLine(id, `⚠ ${p.error}`, 'err');
});

function initTaskUI() {
  const openBtn = document.getElementById('assistant-tasks');
  if (openBtn) openBtn.addEventListener('click', () => (tasksOpen() ? closeTasks() : openTasks()));
  if (taskEls.close) taskEls.close.addEventListener('click', closeTasks);
}

/* ---- wiring ---- */
el.newTab.addEventListener('click', () => newTab(active ? active.cwd : HOME));
if (el.dirPick) el.dirPick.addEventListener('click', async () => {
  const info = await window.souljaterm.pickProjectsRoot(); // native folder dialog; null if cancelled
  if (info) await loadSidebar();                            // re-list + recolor + relabel for the new root
});
el.sidebarToggle.addEventListener('click', toggleSidebar);
el.sidebarShow.addEventListener('click', toggleSidebar);
window.addEventListener('resize', () => active && active.fit.fit());

document.body.classList.add(window.souljaterm.platform || 'darwin'); // lets CSS tune chrome per-OS

/* ---- CRT shader for Roll's face (RetroArch .glslp; engine in fx.js) ---- */
// Roll's pixel-art portrait is the only shaded surface — her low res is what makes scanlines read
// like a real CRT. Hand the engine her <img> each frame.
function getRollFaceSource() {
  // Composite of her mouth/base + blink-eyes overlay (see RollFace.faceSource), so the shader keeps
  // her blink — sampling the raw <img> alone would drop it under the canvas.
  return rollFace.faceSource();
}

function fmt(v) { return (Math.round(v * 100) / 100).toString(); }

function renderFxUI(s) {
  // on/off (sidebar foot + modal mirror each other)
  el.fxScope.value = s.enabled ? 'on' : 'off';
  el.fxScopeModal.value = s.enabled ? 'on' : 'off';

  // preset picker (rebuild only when the list changes)
  const opts = s.list.map((p) => `<option value="${p.where}/${p.file}">${p.name}</option>`).join('');
  if (el.fxPreset.dataset.sig !== opts) { el.fxPreset.innerHTML = opts; el.fxPreset.dataset.sig = opts; }
  el.fxPreset.value = s.preset ? s.preset.where + '/' + s.preset.file : '';
  el.fxError.textContent = s.error || '';

  // parameter sliders (rebuild only when the param set changes, so live dragging isn't interrupted)
  const sig = s.params.map((p) => p.name).join(',');
  if (el.fxParams.dataset.sig !== sig) {
    el.fxParams.dataset.sig = sig;
    el.fxParams.replaceChildren(...s.params.map((p) => {
      const wrap = h('div', { class: 'fx-param' });
      const top = h('div', { class: 'fx-param-top' }, h('span', {}, p.desc || p.name));
      const val = h('span', { class: 'v' }, fmt(p.value));
      top.appendChild(val);
      const range = h('input', { type: 'range', min: p.min, max: p.max, step: p.step || 0.01 });
      range.value = p.value;
      range.addEventListener('input', () => { Fx.setParam(p.name, parseFloat(range.value)); val.textContent = fmt(parseFloat(range.value)); });
      wrap.append(top, range);
      return wrap;
    }));
  } else {
    // keep values fresh without rebuilding (e.g. preset switch reusing same param names)
    const ranges = el.fxParams.querySelectorAll('input[type=range]');
    s.params.forEach((p, i) => { if (ranges[i] && document.activeElement !== ranges[i]) ranges[i].value = p.value; });
  }
}

function openFxModal() {
  el.fxSource.value = Fx.currentSource();
  el.fxError.textContent = Fx.getState().error || '';
  el.fxModal.hidden = false;
}

function initFx() {
  Fx.registerSurface('rollface', el.face, getRollFaceSource);
  Fx.onChange(renderFxUI);

  el.fxScope.addEventListener('change', () => Fx.setEnabled(el.fxScope.value === 'on'));
  el.fxScopeModal.addEventListener('change', () => Fx.setEnabled(el.fxScopeModal.value === 'on'));
  el.fxPreset.addEventListener('change', async () => {
    const [where, file] = el.fxPreset.value.split('/');
    if (where && file) await Fx.selectPreset(where, file);
  });
  el.fxEdit.addEventListener('click', openFxModal);
  el.fxClose.addEventListener('click', () => { el.fxModal.hidden = true; });
  el.fxModal.addEventListener('click', (e) => { if (e.target === el.fxModal) el.fxModal.hidden = true; });
  el.fxApply.addEventListener('click', () => {
    const r = Fx.applySource(el.fxSource.value);
    el.fxError.textContent = r.ok ? '' : (r.error || 'compile failed');
  });
  el.fxFolder.addEventListener('click', async () => { await window.souljaterm.openShaderDir(); });
  el.fxReload.addEventListener('click', async () => { await Fx.refreshList(); });

  Fx.init();
}

(async function init() {
  const info = await window.souljaterm.homeInfo();
  HOME = info.home;
  initFontPicker();
  initBrainPicker();
  initVoicePick();
  initVoiceStyle();           // ⚙ panel: spoken syllables vs synth blips (works for either language)
  initVoiceVol();
  initBlipVol();
  initSfxVol();               // ⚙ panel: Animal Crossing reaction-sound volume
  initTextSpeed();            // baseline typing speed (Roll settings ⚙)
  initRollSettings();         // ⚙ panel: voice on/off + volumes + speed
  initRollLang();             // ⚙ panel: English / 日本語 (also settable by asking Roll in chat)
  initVerbosity();            // ⚙ panel: reply length (short ↔ long; also sizes her token budget)
  lastRoll = { expression: 'happy', line: L().greeting() };  // greet in the saved language
  initSysInfo();              // battery / day / clock HUD on the right of the title bar
  initTaskUI();               // Roll's task manager panel (☰ in her header, or "!" in chat)
  initFx();                   // RetroArch CRT shaders over screen surfaces (CRT picker in sidebar foot)
  rollFace.intro(lastRoll);   // absent for a beat → "appear" clip + CRT warp-in → greeting
  await loadSidebar();
  loadOnboarding();           // populate the empty-state setup checklist
  initUpdates();              // check GitHub Releases; banner appears if a newer version exists
})();
