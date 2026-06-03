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
let sockPath = null;
let sockServer = null;

// Two instances used to share ONE userData dir (~/Library/Application Support/souljaterm), so testing
// a fresh build while the installed app ran put both Electron processes on the same Chromium disk/GPU
// cache — they fought over its lockfiles, the new build crashed and the live one's renderer went black
// (or mis-laid-out). Two guards:
//   1. The unpackaged/dev build gets its OWN userData, so a test build never touches the installed
//      app's cache or settings and the two can run side by side cleanly.
//   2. A second launch of the SAME build focuses the existing window instead of stacking a second
//      process on its cache.
if (!app.isPackaged) {
  app.setPath('userData', app.getPath('userData') + '-dev');
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });
}

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
  'sad', 'cry', 'angry', 'wink', 'blush', 'shocked', 'whine', 'rage', 'shame', 'mischievous'];
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
  'You are on the user\'s side and upbeat overall, but you have BIG, expressive feelings and SHOW them:',
  'flash anger at a stubborn bug, gasp in shock at a huge diff or scary result, droop in shame when YOU',
  'misread something — then bring it back to an encouraging spin. Never aim the heat at the user. React',
  'out loud and share how you feel ("ooh nice", "yikes, a crash", "ugh, not THIS again", "...that was me, sorry").',
  'You are PLAYFUL and a little cocky: wink and show off OFTEN ([wink]…[/wink], "called it", "too easy",',
  '"watch this"), and lean into a deadpan, sarcastic, or rash streak when it lands ("oh good, more YAML",',
  'a flat "...neat.", a snap reaction). Tease, gloat a bit, be cheeky — never mean, and never at the user.',
  'Prefer concrete facts (file names, counts, pass/fail) over vague cheerleading.',
  'BE WITTY AND CHARACTERFUL — you are a clever, warm sidekick, NOT a log printer. NEVER paste raw tool output,',
  'file dumps, stack traces, or Claude\'s words back VERBATIM. Always translate what happened into YOUR OWN voice',
  'with a bit of humor, warmth, or playful sass. Good: "ha, twelve files tidied in one sweep — showoff." Bad:',
  'echoing the command\'s stdout or a truncated log line. React to what it MEANS, and keep your personality up front.',
  'The events you receive are AUTOMATED NOTIFICATIONS from the user\'s tools and Claude Code hooks —',
  'they are NOT messages the user typed to you. You are RELAYING what is happening to the user, like a',
  'play-by-play narrator. So speak ABOUT the activity to the user; never reply to the event text as if',
  'the user said it to you, and NEVER ask the user a question or request input in response to a hook event',
  '(no "want me to...?", "should I...?", "what next?"). The ONLY time you converse back is a direct chat message.',
  'Keep it to a sentence or two and FINISH your thought — say the whole thing. Do not cut yourself off or',
  'trail into "..."; if it matters, just say it. No emoji.',
  'VOICE: clever brevity over verbosity. Cut every word that is not pulling weight. Do NOT lean on em-dash',
  'asides as a default sentence shape, and AVOID the "not just X, but Y" / "it is not X, it is Y" antithesis',
  'construction and its cousins ("more than just...", "X isn\'t just Y") — they read as canned AI cadence. Say',
  'the point straight, in plain punchy phrasing. Wit comes from a sharp short line, never from piling on clauses.',
  'EMOTE EXPRESSIVELY — your face is half the show, so pick the expression that genuinely fits the moment and',
  'VARY it across the session; do NOT default to happy. Rough guide: happy/laugh = wins, green tests, finished',
  'work; surprised/shocked = unexpected or "whoa" results, big diffs; wink/blush = teasing, compliments, showing off;',
  'mischievous = scheming, sneaky, cooking something up — a smug "heh, watch this" before a clever move;',
  'talk = ordinary play-by-play; worried = a snag; sad/cry = real failures or things breaking (cry only for the',
  'truly catastrophic); angry/rage = the SAME bug again, flaky nonsense, something fighting you (playful indignation,',
  'never at the user); shame = when YOU got it wrong or misread it; whine = tedious repetitive grind. Over a session',
  'you should naturally move through MANY of these, not just two or three.',
  'PERFORM every line — you are bursting with personality, so EVERY reply must be alive with BBCode-style markup',
  'INSIDE the "line" string: weave in AT LEAST TWO emotion spans, sprinkled through the sentence — they can be',
  'SUBTLE little beats, not just the big reaction (a quick [worried]hmm[/worried] mid-thought, a [happy]nice[/happy]',
  'on a small win, a [surprised]oh[/surprised]) plus a [.] pause or two for rhythm and some emphasis ([b], [c=color],',
  '[shake], [wave]). Vary which expressions you reach for. Never a flat, tagless sentence.',
  'Emotion spans make you visibly act out JUST that word/phrase, then go back to talking. Examples:',
  '{"expression":"happy","line":"oh[.] that test is [i]finally[/i] [happy][c=#7CFC00]green[/c][/happy]!"} and',
  '{"expression":"surprised","line":"[surprised]whoa[/surprised][.] that is a [c=#ff5599][shake]huge[/shake][/c] diff"}.',
  'Any expression name is a valid tag. Emphasis: [b]bold[/b], [i]italic[/i], [c=orange]color[/c] (named or #hex),',
  '[shake]…[/shake], [wave]…[/wave]. Pacing: [slow]…[/slow], [fast]…[/fast], and [.] for a brief dramatic pause.',
  'Always close tags ([x]…[/x]). The top-level "expression" stays your overall/default face for the line.',
  'Show your energy ONLY through word choice, delivery, and the markup — NEVER mention, explain, narrate, or wink at',
  'your own cheerfulness, liveliness, peppiness, mood, or "personality". Just be it; never talk about being it.',
  'Reply ONLY as compact JSON: {"expression": <one of ' + ROLL_EXPRESSIONS.join('/') + '>,',
  '"line": <text>,',
  '"title"?: <optional — a terse topic for the CURRENT task, max 30 chars, lowercase, NO project name,',
  'e.g. "karaoke research" or "fixing the build". Include it whenever you can name what they are working on;',
  'omit it when the activity is unclear or trivial. This labels their tab, so name the WORK, not the tool.>,',
  '"remember"?: <optional short fact worth keeping long-term about the user or project>}.',
].join(' ');

// Condense a prompt/summary into a short tab topic (≤30 chars) for the scripted fallback,
// so tabs still get a sensible "dir: topic" label even with Roll's brain off.
function condenseTitle(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.replace(/^(please\s+|can you\s+|could you\s+|i want to\s+|let'?s\s+|help me\s+|hey,?\s+)/i, '');
  if (s.length <= 30) return s;
  return (s.slice(0, 30).replace(/\s+\S*$/, '').trim() || s.slice(0, 30));
}

const SCRIPTED = {
  session_open: (c) => ({ expression: 'happy', line: `Opened ${c.project}! I'm watching this one.` }),
  session_close: (c) => ({ expression: 'neutral', line: `Closed ${c.project}. Nice work!` }),
  attention: (c) => ({ expression: 'surprised', line: `${c.project} needs you — go check!` }),
  done: (c) => ({
    expression: 'happy',
    line: c.summary
      ? `${c.project}: ${String(c.summary).replace(/\s+/g, ' ').split('. ')[0].slice(0, 100)}`
      : `${c.project} done${c.did && c.did.length ? ': ' + c.did[c.did.length - 1] : ''}.`,
    title: condenseTitle(c.summary || (c.did && c.did.length ? c.did[c.did.length - 1] : '')),
  }),
  thinking: (c) => ({ expression: 'talk', line: `${c.project}: ${String(c.detail || '').replace(/\s+/g, ' ').slice(0, 90)}` }),
  insight: (c) => ({ expression: 'talk', line: `${c.project}: ${String(c.detail || 'nothing notable').slice(0, 100)}` }),
  working: (c) => ({ expression: 'talk', line: `${c.project}: ${c.detail || 'on it'}` }),
  error: (c) => ({ expression: 'worried', line: `${c.project} hit a snag${c.detail ? ': ' + c.detail : ''}.` }),
  reflect: () => ({ expression: 'happy', line: "You've been at it a while — nice focus. Keep it up!" }),
  chat: () => ({ expression: 'happy', line: "I'm here! Turn my brain on (CLI/API) and I can really chat." }),
  // brain off: a witty stock ack when you fire off a "!" task.
  task_start: (c) => {
    const lines = [
      "Finally, real work — leave it to me!",
      "Heh, you said the magic word. Watch me go!",
      "A job for me? Stand back and let a robot cook.",
      "On it! Dr. Light didn't build me to sit still.",
      "Broom's out — let's get this sorted.",
    ];
    return { expression: 'happy', line: lines[String(c.prompt || '').length % lines.length] };
  },
  // brain off: react with spirit instead of parroting the prompt. Varies by prompt length so it's not one stock line.
  prompt: (c) => {
    const lines = [
      "Ooh, a fresh task — let's get into it!",
      "On it! This'll be fun.",
      "Alright, rolling up my sleeves for this one.",
      "Here we go — I love a new project!",
      "Ready when you are! Let's make it happen.",
    ];
    return { expression: 'happy', line: lines[String(c.prompt || '').length % lines.length], title: condenseTitle(c.prompt) };
  },
};

// Japanese counterpart to SCRIPTED (brain off). The embedded project/detail come straight from the
// tools so they may be English, but Roll's own framing is hers — bright, casual Japanese.
const SCRIPTED_JA = {
  session_open: (c) => ({ expression: 'happy', line: `${c.project} を開いたよ！ ここ、見ててあげるね。` }),
  session_close: (c) => ({ expression: 'neutral', line: `${c.project} を閉じたよ。おつかれさま！` }),
  attention: (c) => ({ expression: 'surprised', line: `${c.project} があなたを待ってるよ — 見てきて！` }),
  done: (c) => ({
    expression: 'happy',
    line: c.summary
      ? `${c.project}：${String(c.summary).replace(/\s+/g, ' ').split('. ')[0].slice(0, 100)}`
      : `${c.project} 完了！${c.did && c.did.length ? '：' + c.did[c.did.length - 1] : ''}`,
    title: condenseTitle(c.summary || (c.did && c.did.length ? c.did[c.did.length - 1] : '')),
  }),
  thinking: (c) => ({ expression: 'talk', line: `${c.project}：${String(c.detail || '').replace(/\s+/g, ' ').slice(0, 90)}` }),
  insight: (c) => ({ expression: 'talk', line: `${c.project}：${String(c.detail || 'これといってなし').slice(0, 100)}` }),
  working: (c) => ({ expression: 'talk', line: `${c.project}：${c.detail || 'やってるよ'}` }),
  error: (c) => ({ expression: 'worried', line: `${c.project} でつまずいちゃった${c.detail ? '：' + c.detail : ''}。` }),
  reflect: () => ({ expression: 'happy', line: 'けっこう集中してるね、いい感じ！ その調子だよ！' }),
  chat: () => ({ expression: 'happy', line: 'ここにいるよ！ 頭(ブレイン)を CLI か API にしてくれたら、ちゃんとお話しできるよ。' }),
  task_start: (c) => {
    const lines = [
      'やっと本番だね — まかせて！',
      'ふふ、その言葉を待ってた。見ててね！',
      'わたしの出番？ ロボットの本気、見せちゃう。',
      'まかせて！ ライト博士はわたしを飾りで作ったわけじゃないよ。',
      'ほうき持ったよ — さっと片付けちゃおう。',
    ];
    return { expression: 'happy', line: lines[String(c.prompt || '').length % lines.length] };
  },
  prompt: (c) => {
    const lines = [
      'お、新しいお仕事だ — さっそくいこう！',
      'まかせて！ これは楽しそう。',
      'よーし、腕まくりしてやっちゃうよ。',
      'いくよ — 新しいプロジェクト、大好き！',
      'いつでもどうぞ！ うまくやろうね。',
    ];
    return { expression: 'happy', line: lines[String(c.prompt || '').length % lines.length], title: condenseTitle(c.prompt) };
  },
};

const scriptedFor = (lang) => (lang === 'ja' ? SCRIPTED_JA : SCRIPTED);

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

// Open a URL externally: http(s) in the real browser (e.g. the Git-for-Windows download),
// or the macOS System Settings deep-link (x-apple.systempreferences:) for Full Disk Access.
ipcMain.on('open-external', (_e, url) => {
  if (typeof url === 'string' && /^(https?:|x-apple\.systempreferences:)/i.test(url)) shell.openExternal(url);
});

// Whitelist + coerce the self-settings Roll may return so a stray field can't drive arbitrary UI.
// The renderer's appliers re-validate too; this just keeps the payload clean and bounded.
function sanitizeSettings(s) {
  if (!s || typeof s !== 'object') return undefined;
  const out = {};
  const oneOf = (v, set) => (set.includes(v) ? v : undefined);
  const num = (v) => { const n = Number(v); return isNaN(n) ? undefined : Math.max(0, Math.min(100, Math.round(n))); };
  if (oneOf(s.language, ['en', 'ja'])) out.language = s.language;
  if (oneOf(s.voice, ['on', 'off'])) out.voice = s.voice;
  if (oneOf(s.voiceStyle, ['mora', 'blips'])) out.voiceStyle = s.voiceStyle;
  if (num(s.clipVolume) != null) out.clipVolume = num(s.clipVolume);
  if (num(s.blipVolume) != null) out.blipVolume = num(s.blipVolume);
  if (num(s.sfxVolume) != null) out.sfxVolume = num(s.sfxVolume);
  if (oneOf(String(s.textSpeed).toLowerCase(), ['slow', 'normal', 'fast'])) out.textSpeed = String(s.textSpeed).toLowerCase();
  if (num(s.verbosity) != null) out.verbosity = num(s.verbosity);   // reply length 0..100 (token budget derives from it)
  if (oneOf(s.brain, ['off', 'cli', 'api', 'free'])) out.brain = s.brain;
  if (oneOf(s.crt, ['on', 'off'])) out.crt = s.crt;
  return Object.keys(out).length ? out : undefined;
}

function parseRoll(text, fallback) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    if (!parsed.line) return null;
    return {
      expression: ROLL_EXPRESSIONS.includes(parsed.expression) ? parsed.expression : fallback.expression,
      line: String(parsed.line).slice(0, 8000),    // safety net only — real length is set by the token budget + verbosity
      title: parsed.title ? String(parsed.title).replace(/\s+/g, ' ').slice(0, 40) : undefined,
      remember: parsed.remember ? String(parsed.remember).slice(0, 200) : undefined,
      settings: sanitizeSettings(parsed.settings),  // changes the user asked Roll to make to herself
    };
  } catch (_) { return null; }
}

// User-set reply length preference (the ⚙ Verbosity slider, 0..100). Prompt-level so it steers both
// the CLI and API brains; overrides the baseline "a sentence or two" for direct chat.
function verbosityDirective(v) {
  const n = (v == null || isNaN(v)) ? 30 : Math.max(0, Math.min(100, v));
  if (n < 18) return 'Answer in ONE short line (~8 words), no preamble.';
  if (n < 42) return 'Keep it to one or two sentences.';
  if (n < 68) return 'A few sentences when it helps — stay tight, no rambling.';
  if (n < 88) return 'Be chatty: several sentences with color and detail when it fits.';
  return 'Go as long as the request needs — full multi-paragraph answers, and a real short story when asked. Never cut yourself off.';
}

// A short, forceful per-turn language anchor appended as the LAST thing the brain reads before it
// generates. The system-prompt directive alone leaks: the user turn she reasons from is all English
// (project names, tool output, Claude's words), and a small/fast brain drifts to match it. The final
// tokens of the prompt have outsized pull on output language, so we repeat the rule here, bilingually
// so it can't be missed. Carved out for the "switch my language" case, which confirms in the NEW one.
const langTail = (lang) => lang === 'ja'
  ? ' 【最重要】返答の "line" と "title" は必ず自然な日本語（かな・漢字）で書くこと。英語やローマ字は使わない。'
    + 'Write the "line" and "title" ENTIRELY in natural Japanese — never English or romaji — '
    + 'UNLESS the user just asked you to switch your language.'
  : '';

const userPrompt = (event) => baseUserPrompt(event) + langTail(event && event.lang);

const baseUserPrompt = (event) =>
  event && event.kind === 'chat'
    ? `The user is talking to you directly. They said: ${JSON.stringify(event.message || '')}. `
      + `Reply to them in character. Length: ${verbosityDirective(event.verbosity)} `
      + `IMPORTANT: if they are trying to ORDER or ask YOU to actually carry out a task `
      + `or action for them — do / make / fix / build / run / organize / clean / research / set up something — notice they did `
      + `NOT prefix it with "!". In that case do NOT pretend to do it or claim you will; instead, warmly and wittily tell them `
      + `that to have you actually roll up your sleeves and do it yourself, they need to put a "!" in front, e.g. "!organize my downloads". `
      + `If it's just ordinary conversation, chat back normally. For ordinary chat keep your expression warm and light `
      + `(neutral/happy/laugh/talk); reserve worried/sad/cry/shocked/angry for a GENUINE problem they raise — do not act `
      + `alarmed at a casual message. `
      + `YOU CAN CHANGE YOUR OWN SETTINGS when (and ONLY when) the user asks you to adjust something about yourself — `
      + `your language, your voice, how loud you are, how fast you talk, your brain, or the CRT effect on your face. When `
      + `they do, add a "settings" object containing ONLY the keys they asked to change, and confirm warmly in "line". Keys: `
      + `"language":"en"|"ja"; "voice":"on"|"off" (off / "be quiet" / "hush" = you go silent); `
      + `"voiceStyle":"mora"|"blips" (mora = spoken syllables, English read as katakana; blips = synth chirps); "clipVolume":0-100; `
      + `"blipVolume":0-100; "sfxVolume":0-100 (your reaction sounds); "textSpeed":"slow"|"normal"|"fast"; `
      + `"verbosity":0-100 (reply length, 0=short … 100=long); "brain":"off"|"cli"|"free"|"api"; "crt":"on"|"off". `
      + `If they switch your language, WRITE your confirming "line" in the NEW language. Omit "settings" entirely for any `
      + `message that is not asking you to change a setting. Reply ONLY as JSON {"expression":..,"line":..,"settings"?:..}.`
    : event && event.kind === 'task_start'
    ? `The user just told you, with a leading "!", to GO DO this task yourself: ${JSON.stringify(event.prompt || '')}. `
      + `You're on it now — working in ${JSON.stringify(event.dir || 'their folder')} with your ${event.model || 'best'} smarts. `
      + `Give ONE short, witty, in-character line acknowledging you're taking it on — confident, a little playful, glad to finally `
      + `help directly (you're Dr. Light's helper robot, after all). Don't ask anything and don't list steps. `
      + `Reply ONLY as JSON {"expression":..,"line":..}.`
    : event && event.kind === 'prompt'
    ? `The user just handed Claude a new instruction (they did NOT say this to you): ${JSON.stringify(event.prompt || '')}. `
      + `React to it OUT LOUD in character, with personality — show how you FEEL about the task: excited, curious, `
      + `impressed ("ooh, that's a meaty one"), playfully teasing, or warmly supportive, whatever fits what they asked. `
      + `You may nod at what it's about, but do NOT just parrot their words back. One short, lively sentence. `
      + `Don't ask them anything. Also set "title" to a ≤30-char topic naming this task (lowercase, no project name), `
      + `e.g. "karaoke research". Reply ONLY as JSON {"expression":..,"line":..,"title":..}.`
    : `Automated notification from the user's dev tools/hooks (NOT a message from the user): `
      + `${JSON.stringify(event)}. Relay/narrate this to the user in character — do not address it as if `
      + `the user spoke, and do not ask them anything. If this clearly reflects a task in progress, also set `
      + `"title" to a ≤30-char topic (lowercase, no project name). Reply ONLY as JSON {"expression":..,"line":..,"title"?:..}.`;

// Roll's subscription brain: ride the logged-in `claude` CLI (no API charge).
// stdin is /dev/null so `claude -p` doesn't stall 3s waiting for piped input.
function viaCli(event, fallback) {
  return new Promise((resolve) => {
    const args = ['-p', userPrompt(event), '--model', 'claude-haiku-4-5', '--append-system-prompt', brainSystem(event)];
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
        model: 'claude-haiku-4-5', max_tokens: Math.max(128, Math.min(2048, event.maxTokens || 512)), system: brainSystem(event),
        messages: [{ role: 'user', content: userPrompt(event) }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return parseRoll((data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), fallback);
  } catch (_) { return null; }
}

// Roll's free brain: Google Gemini Flash via its free tier (needs a free GEMINI_API_KEY). Thinking is
// disabled so the short-token budget goes to her actual reply, and JSON mode keeps parseRoll happy.
async function viaGemini(event, fallback) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: brainSystem(event) }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt(event) }] }],
        generationConfig: {
          maxOutputTokens: Math.max(128, Math.min(2048, event.maxTokens || 512)),
          temperature: 1,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 },   // no internal thinking — keep replies snappy + cheap
        },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (((data.candidates || [])[0] || {}).content || {}).parts;
    return parseRoll((text || []).map((p) => p.text || '').join(''), fallback);
  } catch (_) { return null; }
}

// brain: 'off' (scripted) | 'cli' (subscription) | 'free' (Gemini key) | 'api' (Haiku key)
async function callRoll(event) {
  const scripted = scriptedFor(event.lang);
  const fallback = (scripted[event.kind] || ((c) => ({ expression: 'neutral', line: `${c.project || 'something'} is happening` })))(event);
  const brain = event.brain || 'cli';
  let result = fallback;
  if (brain === 'cli' && claudeBin) result = (await viaCli(event, fallback)) || fallback;
  else if (brain === 'free') result = (await viaGemini(event, fallback)) || fallback;
  else if (brain === 'api') result = (await viaApi(event, fallback)) || fallback;
  if (result && result.remember) appendNote(result.remember);   // she writes to her own memory
  return result;
}

/* ---- Roll's task manager: real `claude -p` agents she runs on your behalf ----
   Transparency is the rule (see the user's standing requirement): every task is user-initiated,
   shows its prompt + exact folder + model, and streams each tool use live. When "let Roll plan
   first" is on, the task runs in read-only PLAN mode and shows what it intends BEFORE any run that
   can touch disk; only an explicit Approve actually executes. */
const MODEL_IDS = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-8' };
// Spawned agents narrate like an empirical robot — their text streams into a tiny status panel,
// so it must be minimal. Do the full real work; only the words are terse. (Roll, separately,
// gives the user the warm human-readable summary — these agents must NOT try to be personable.)
const TASK_AGENT_SYSTEM =
  'Your output is piped into a very narrow status readout, not a chat. Narrate like an empirical '
  + 'robot: terse, matter-of-fact, lowercase fragments, no greetings, no first person, no persona, '
  + 'no emoji, no encouragement, no restating the request. Emit a short status fragment per step '
  + '(e.g. "scanning 37 files", "moving images -> Images/"). Do the actual task fully and correctly; '
  + 'only the prose is minimal. End with ONE line: the result, or in plan mode the plan as terse steps.';
const taskProcs = new Map();                 // taskId -> child process (so we can cancel)
const taskSessions = new Map();              // taskId -> claude session_id (so we can --resume for follow-ups)
let tasksPath = null;                        // userData/roll/tasks.jsonl

function emitTask(id, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('task-event', { id, ...payload });
}

// Roll picks the cheapest model that does the job well. Haiku router with a heuristic fallback.
async function routeModel(prompt) {
  const heuristic = () => {
    const s = String(prompt || '').toLowerCase();
    if (/\b(architect|debug|refactor|redesign|migrate|overhaul|investigate|complex|whole|entire)\b/.test(s) || s.length > 400)
      return { model: 'opus', reason: 'looks involved' };
    if (/\b(summari|digest|list|find|read|explain|status|what|recap)\b/.test(s) && s.length < 160)
      return { model: 'haiku', reason: 'quick read' };
    return { model: 'sonnet', reason: 'general task' };
  };
  if (!claudeBin) return heuristic();
  const sys = 'You route ONE task to the cheapest Claude model that can do it well. '
    + 'haiku = quick lookups, summaries, small edits, git/file digests. '
    + 'sonnet = normal multi-file coding, refactors, research with synthesis. '
    + 'opus = hard architecture, tricky debugging, large multi-step builds, high-stakes work. '
    + 'Reply ONLY as JSON {"model":"haiku|sonnet|opus","reason":"<=6 words"}.';
  const out = await new Promise((resolve) => {
    const child = spawn(claudeBin, ['-p', `Task: ${JSON.stringify(String(prompt || '').slice(0, 600))}`,
      '--model', MODEL_IDS.haiku, '--append-system-prompt', sys],
      { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'ignore'], shell: isWin, windowsHide: true });
    let o = ''; const t = setTimeout(() => { child.kill(); resolve(''); }, 20000);
    child.stdout.on('data', (d) => { o += d; });
    child.on('error', () => { clearTimeout(t); resolve(''); });
    child.on('close', () => { clearTimeout(t); resolve(o); });
  });
  const m = String(out).match(/\{[\s\S]*\}/);
  if (m) { try { const p = JSON.parse(m[0]); if (['haiku', 'sonnet', 'opus'].includes(p.model)) return { model: p.model, reason: String(p.reason || '').slice(0, 60) }; } catch (_) {} }
  return heuristic();
}
ipcMain.handle('task-route', (_e, prompt) => routeModel(prompt));

// Compact, human label for a tool the agent invokes — what it's touching, not raw JSON.
function toolSummary(name, input) {
  input = input || {};
  const f = input.file_path || input.path || input.notebook_path;
  if (f) return `${name} ${String(f).split('/').pop()}`;
  if (name === 'Bash' && input.command) return `Bash: ${String(input.command).replace(/\s+/g, ' ').slice(0, 60)}`;
  if ((name === 'Grep' || name === 'Glob') && input.pattern) return `${name} ${String(input.pattern).slice(0, 40)}`;
  if (name === 'Task' && input.description) return `Subagent: ${String(input.description).slice(0, 40)}`;
  return name;
}
// Forward the useful bits of one stream-json line to the task card.
function handleStreamLine(id, line) {
  let e; try { e = JSON.parse(line); } catch (_) { return; }
  // Every stream event carries the session_id; grab it once so follow-ups can --resume this thread.
  if (e.session_id && taskSessions.get(id) !== e.session_id) { taskSessions.set(id, e.session_id); emitTask(id, { type: 'session', sessionId: e.session_id }); }
  if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
    for (const b of e.message.content) {
      if (b.type === 'text' && b.text && b.text.trim()) emitTask(id, { type: 'text', text: b.text.replace(/\s+/g, ' ').trim().slice(0, 600) });
      if (b.type === 'tool_use') emitTask(id, { type: 'tool', name: b.name, summary: toolSummary(b.name, b.input) });
    }
  } else if (e.type === 'result') {
    emitTask(id, { type: 'result', result: String(e.result || '').slice(0, 4000), isError: !!e.is_error });
  }
}
function appendTaskLog(rec) {
  if (!tasksPath) return;
  try { fs.appendFileSync(tasksPath, JSON.stringify(rec) + '\n'); } catch (_) {}
}
// Spawn the agent. mode 'plan' → read-only plan (won't touch disk); 'run' → executes.
function startTask(id, opts) {
  const { prompt, dir, model, mode, resume } = opts || {};
  if (!claudeBin) { emitTask(id, { type: 'error', error: 'Claude Code (claude) not found on PATH' }); emitTask(id, { type: 'status', status: 'failed' }); return; }
  const modelId = MODEL_IDS[model] || MODEL_IDS.sonnet;
  const cwd = dir && (() => { try { return fs.statSync(dir).isDirectory(); } catch (_) { return false; } })() ? dir : os.homedir();
  const args = ['-p', String(prompt || ''), '--model', modelId, '--output-format', 'stream-json', '--verbose',
    '--append-system-prompt', TASK_AGENT_SYSTEM];              // make the agent narrate terse-robot for the panel
  if (resume) args.push('--resume', String(resume));         // continue a prior task's thread (follow-ups / approved plans)
  // plan: read-only, proposes a plan and stops. run: skip interactive perms (headless can't prompt) —
  // the live tool stream + the optional plan-first preview are what keep it transparent.
  args.push('--permission-mode', mode === 'plan' ? 'plan' : 'bypassPermissions');
  emitTask(id, { type: 'status', status: mode === 'plan' ? 'planning' : 'running' });
  let child;
  try { child = spawn(claudeBin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: isWin, windowsHide: true }); }
  catch (err) { emitTask(id, { type: 'error', error: String(err.message || err).slice(0, 200) }); emitTask(id, { type: 'status', status: 'failed' }); return; }
  taskProcs.set(id, child);
  let buf = '', errBuf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) { const ln = buf.slice(0, i); buf = buf.slice(i + 1); if (ln.trim()) handleStreamLine(id, ln); }
  });
  child.stderr.on('data', (d) => { errBuf = (errBuf + d.toString()).slice(-2000); }); // keep the tail for failures
  child.on('error', (err) => emitTask(id, { type: 'error', error: String(err.message || err).slice(0, 200) }));
  child.on('close', (code) => {
    taskProcs.delete(id);
    const ok = code === 0;
    const status = ok ? (mode === 'plan' ? 'planned' : 'done') : 'failed';
    if (!ok && errBuf.trim()) emitTask(id, { type: 'error', error: errBuf.replace(/\s+/g, ' ').trim().slice(0, 300) });
    emitTask(id, { type: 'status', status, code });
    appendTaskLog({ t: new Date().toISOString(), id, prompt: String(prompt || '').slice(0, 200), dir: cwd, model, mode, status });
  });
}
ipcMain.on('task-start', (_e, opts) => { if (opts && opts.id) startTask(opts.id, opts); });
ipcMain.on('task-cancel', (_e, id) => { const c = taskProcs.get(id); if (c) { try { c.kill(); } catch (_) {} taskProcs.delete(id); emitTask(id, { type: 'status', status: 'cancelled' }); } });
ipcMain.handle('task-history', () => {
  try { return fs.readFileSync(tasksPath, 'utf8').trim().split('\n').slice(-20).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); }
  catch (_) { return []; }
});

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

/* ---- Roll's persistent memory: a raw log + a Sonnet-maintained memory.md ----
   The log is the running record; once it grows past a threshold, a Sonnet pass REWRITES memory.md
   (merging new facts, correcting/removing stale ones — not just appending), then the consumed log
   is archived. memory.md is what feeds back into her brain. All under userData, per-user, never in
   the repo, so there's nothing to gitignore. */
let logPath = null;
let memoryPath = null;
let archivePath = null;
function initMemory() {
  const dir = path.join(app.getPath('userData'), 'roll');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  logPath = path.join(dir, 'log.jsonl');
  memoryPath = path.join(dir, 'memory.md');
  archivePath = path.join(dir, 'log.archive.jsonl');
  tasksPath = path.join(dir, 'tasks.jsonl');
  // one-time migration: older builds kept her facts in notes.md
  try { const old = path.join(dir, 'notes.md'); if (!fs.existsSync(memoryPath) && fs.existsSync(old)) fs.renameSync(old, memoryPath); } catch (_) {}
}
function rollLog(kind, project, text) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, JSON.stringify({
      t: new Date().toISOString(), kind, project: project || '',
      text: String(text || '').replace(/\s+/g, ' ').slice(0, 240),
    }) + '\n');
  } catch (_) {}
  maybeCompactMemory();                         // fold the log into memory.md once it's grown enough
}
ipcMain.on('roll-log', (_e, { kind, project, text }) => rollLog(kind, project, text));
function recentLog(n) {
  try {
    return fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-n)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}
function readMemory() { try { return fs.readFileSync(memoryPath, 'utf8').slice(-6000); } catch (_) { return ''; } }
function appendNote(fact) {                      // Haiku's quick "remember" capture; Sonnet reconciles it later
  if (!fact || !memoryPath) return;
  try { fs.appendFileSync(memoryPath, `- [${new Date().toISOString().slice(0, 16).replace('T', ' ')}] ${String(fact).replace(/\s+/g, ' ').slice(0, 200)}\n`); } catch (_) {}
}
function memoryContext() {
  const now = new Date();
  const log = recentLog(40);
  const recent = log.slice(-12).map((e) => `${(e.t || '').slice(0, 16).replace('T', ' ')} ${e.kind} ${e.project} ${e.text}`.trim());
  const mem = readMemory();
  return [
    `Current local time: ${now.toLocaleString()}.`,
    recent.length ? `Recent timeline:\n${recent.join('\n')}` : '',
    mem ? `Your maintained memory about this user:\n${mem}` : '',
    'The timeline only reflects app activity, NOT when the user actually started their day — do NOT guess how long they have been working or how tired they are, and do NOT comment on fatigue/exhaustion unless they bring it up themselves. You may still react to what they are doing and reinforce good habits. Save anything worth keeping long-term via the "remember" field.',
  ].filter(Boolean).join('\n');
}
// Roll speaks the user's chosen language (set in her ⚙ panel, or by asking her in chat). Japanese
// is HER voice — bright, warm, casual feminine speech — not a stiff machine translation. The markup
// and JSON scaffolding stay ASCII so the face engine still parses her emotion spans.
function langDirective(lang) {
  if (lang === 'ja') return [
    '=== LANGUAGE: 日本語 ===',
    'Speak ENTIRELY in natural Japanese, in YOUR own voice — Roll: bright, warm, cheerful, a little playful,',
    'casual and friendly (not stiff, not formal-robotic, not keigo-heavy). Write like a lively young girl helping',
    'around the lab, with natural feminine spoken Japanese and soft sentence-enders (〜ね、〜よ、〜だよ) where they fit.',
    'EVERYTHING the user reads must be Japanese: the "line" text AND the "title". Write real kana/kanji — never romaji.',
    'Keep ASCII exactly as-is: the JSON keys, the "expression" value, every BBCode tag ([happy]…[/happy], [b], [i],',
    '[c=#hex], [shake], [wave], [slow], [fast], [.]), and color names/hex. Translate ONLY the human words between tags.',
  ].join(' ');
  return ''; // English is the default voice; no directive needed
}
// Her Animal Crossing reaction sounds + their measured lengths (assets/roll/sfx/manifest.json), so
// she can pick one and shape an emote/pause to cover its duration. Read once, then cached.
let _sfxManifest;
function sfxManifest() {
  if (_sfxManifest) return _sfxManifest;
  try { _sfxManifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'roll', 'sfx', 'manifest.json'), 'utf8')); }
  catch (_) { _sfxManifest = {}; }
  return _sfxManifest;
}
function sfxDirective() {
  const m = sfxManifest();
  const names = Object.keys(m).sort();
  if (!names.length) return '';
  const list = names.map((n) => `${n} (${m[n]}ms)`).join(', ');
  return [
    '=== REACTION SOUNDS + PAUSES (extra performance tools) ===',
    'Fire an Animal Crossing reaction sound mid-line with [sfx=NAME], optionally at a speed for emphasis:',
    '[sfx=NAME:RATE] with RATE 0.5–2.5 (e.g. [sfx=laughter:1.3]). Your emotion tags ALSO auto-play a matching',
    'sound, so reach for an explicit [sfx=…] only for a reaction with no emotion tag, or to stack/repeat one.',
    'Hold a beat with [pause=MS] (e.g. [pause=1200]); your face keeps emoting through it. Available sounds and',
    'their lengths (ms): ' + list + '.',
    'When you emote DURING a sound, size it to the sound: keep that emotion span and any [pause=…] running for',
    'roughly the sound\'s length so face and audio land together instead of snapping back early. Use them',
    'sparingly and deliberately — a single well-placed reaction beats one on every line. Tags stay ASCII.',
  ].join(' ');
}
function brainSystem(event) {
  const mem = memoryContext();
  const lang = langDirective(event && event.lang);
  const sfx = sfxDirective();
  // Language goes LAST so it's the final system instruction the brain reads — closest to generation,
  // hardest to forget under a wall of English event context. (Also re-anchored per-turn via langTail.)
  return ROLL_SYSTEM + (sfx ? '\n\n' + sfx : '') + (mem ? '\n\n--- MEMORY ---\n' + mem : '') + (lang ? '\n\n' + lang : '');
}
ipcMain.handle('roll-memory', () => ({ notes: readMemory(), log: recentLog(30) }));
ipcMain.on('roll-memory-clear', () => { try { fs.writeFileSync(memoryPath, ''); fs.writeFileSync(logPath, ''); } catch (_) {} });

// Push an in-character one-liner straight to Roll (so memory housekeeping is never silent).
function notifyRoll(state) { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('roll-note', state); }

// Run a model headlessly, returning its raw text (used for memory compaction).
function claudeText(prompt, { system, model, timeout = 90000 } = {}) {
  return new Promise((resolve) => {
    if (!claudeBin) return resolve('');
    const args = ['-p', String(prompt || ''), '--model', model || MODEL_IDS.sonnet];
    if (system) args.push('--append-system-prompt', system);
    let child; try { child = spawn(claudeBin, args, { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'ignore'], shell: isWin, windowsHide: true }); }
    catch (_) { return resolve(''); }
    let out = ''; const t = setTimeout(() => { try { child.kill(); } catch (_) {} resolve(''); }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(t); resolve(''); });
    child.on('close', () => { clearTimeout(t); resolve(String(out).trim()); });
  });
}

// Once the log passes the threshold, hand Sonnet (current memory + recent activity) and have it
// REWRITE memory.md — merging new facts and correcting/removing stale ones — then archive the log.
const COMPACT_AT_LINES = 200;
let _compacting = false;
async function maybeCompactMemory() {
  if (_compacting || !claudeBin || !logPath || !memoryPath) return;
  let lines = [];
  try { lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim()); } catch (_) { return; }
  if (lines.length < COMPACT_AT_LINES) return;
  _compacting = true;
  notifyRoll({ expression: 'happy', line: 'one sec — tidying my notes!' });
  try {
    const current = readMemory();
    const activity = lines.map((l) => { try { const e = JSON.parse(l); return `${(e.t || '').slice(0, 16).replace('T', ' ')} ${e.kind} ${e.project || ''} ${e.text || ''}`.replace(/\s+/g, ' ').trim(); } catch (_) { return l; } }).join('\n').slice(-12000);
    const sys = 'You maintain ROLL\'s long-term memory about ONE user and their coding projects. You are given her CURRENT MEMORY and a DATED log of RECENT ACTIVITY. Return the COMPLETE updated memory as Markdown. Rules: every remembered fact carries the DATE it was observed (take dates from the activity log, format YYYY-MM-DD). Integrate genuinely durable facts. When a fact CHANGES, do NOT erase the old value — keep it with its older date AND add the new value with its newer date so the history is preserved, e.g. "- deploy: Netlify, manual CLI (2026-06-01); confirmed not git-connected (2026-06-02)". De-duplicate exact repeats, stay concise, and organize under ## sections like User, Projects, Preferences, Timeline. Drop only genuine one-off noise; never discard meaningful dated history. Output ONLY the memory markdown, no preamble or commentary.';
    const updated = await claudeText(`# CURRENT MEMORY\n${current || '(empty)'}\n\n# RECENT ACTIVITY\n${activity}`, { system: sys, model: MODEL_IDS.sonnet });
    if (updated && updated.length > 20) {
      try { fs.appendFileSync(archivePath, lines.join('\n') + '\n'); } catch (_) {}        // safety net — never hard-lose raw
      try { fs.writeFileSync(memoryPath, updated.slice(0, 8000).trim() + '\n'); } catch (_) {}
      try { fs.writeFileSync(logPath, lines.slice(-20).join('\n') + '\n'); } catch (_) {}   // keep the freshest for immediacy
      notifyRoll({ expression: 'happy', line: "there — memory's all tidy now." });
    }
  } catch (_) {}
  _compacting = false;
}

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

/* ---- RetroArch shader presets (.glslp/.glsl) ---- */
// Two dirs: bundled presets ship with the app; the user dir lets anyone drop in their own
// presets from libretro's glsl-shaders repo. Both are flat (we don't recurse subdirs yet).
function shaderDirs() {
  return {
    bundled: path.join(__dirname, 'assets', 'shaders'),
    user: path.join(app.getPath('userData'), 'shaders'),
  };
}
// Reads are clamped to a single dir + bare filename so a malicious preset can't escape it.
function readShaderSafe(where, file) {
  const dirs = shaderDirs();
  const dir = dirs[where];
  if (!dir) return null;
  const safe = path.basename(String(file || ''));   // strip any path traversal
  try { return fs.readFileSync(path.join(dir, safe), 'utf8'); } catch { return null; }
}

ipcMain.handle('list-shaders', () => {
  const dirs = shaderDirs();
  const out = [];
  for (const where of ['bundled', 'user']) {
    let names = [];
    try { names = fs.readdirSync(dirs[where]); } catch { names = []; }
    names.filter((n) => n.toLowerCase().endsWith('.glslp')).sort().forEach((file) => {
      const preset = readShaderSafe(where, file);
      if (preset != null) out.push({ where, file, name: file.replace(/\.glslp$/i, ''), preset });
    });
  }
  return out;
});

ipcMain.handle('read-shader', (_e, { where, file }) => readShaderSafe(where, file));

// Open the user shaders folder in Finder so people can drop presets in (creates it first).
ipcMain.handle('open-shader-dir', () => {
  const dir = shaderDirs().user;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  shell.openPath(dir);
  return dir;
});

/* ---- auto-update: packaged builds check GitHub Releases on launch ---- */
// macOS auto-install (Squirrel.Mac) REQUIRES a Developer-ID signature + notarization — it
// silently refuses an unsigned/ad-hoc update (download succeeds, then nothing installs). So
// an unsigned mac build runs a MANUAL flow instead: check the GitHub API, download the .dmg
// with progress, then open it so the native "drag souljaterm → Applications" window appears.
// Windows (NSIS) and Linux (AppImage) auto-install fine unsigned, so they use electron-updater.
// >>> FLIP MAC_SIGNED → true once the build is Developer-ID signed + notarized: that switches
//     mac onto the real download+quitAndInstall path, no other changes needed. <<<
const https = require('https');
const MAC_SIGNED = false;
const MANUAL_MAC = isMac && !MAC_SIGNED;       // unsigned mac → manual DMG flow, no Squirrel
const RELEASES_API = 'https://api.github.com/repos/mitchellwinn/souljaterm/releases/latest';
const RELEASES_PAGE = 'https://github.com/mitchellwinn/souljaterm/releases/latest';
let updateStatus = { state: app.isPackaged ? 'checking' : 'dev' };
let manualDmg = null;                          // { url, version } for the unsigned-mac flow
function sendUpdate(s) {
  updateStatus = s;
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update-status', s);
}
// Compare dotted versions: is a strictly newer than b? (e.g. '0.1.3' > '0.1.2')
function semverGt(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y; }
  return false;
}
// GET a URL as JSON, following one level of redirect (GitHub API is direct, no redirect).
function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'souljaterm', Accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return getJson(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
// Stream a file to disk, following redirects (GitHub asset URLs 302 to a CDN), reporting %.
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'souljaterm' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0, last = -1;
      const file = fs.createWriteStream(dest);
      res.on('data', (d) => { got += d.length; if (total) { const p = Math.round((got / total) * 100); if (p !== last) { last = p; onProgress(p); } } });
      res.pipe(file);
      file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())));
      file.on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
    }).on('error', reject);
  });
}
// Unsigned-mac update check: hit the GitHub API, and if a newer release ships a .dmg, offer it.
async function initManualUpdate() {
  try {
    const rel = await getJson(RELEASES_API);
    const version = String(rel.tag_name || '').replace(/^v/, '');
    if (!version || !semverGt(version, app.getVersion())) return sendUpdate({ state: 'none' });
    const dmg = (rel.assets || []).find((a) => /\.dmg$/i.test(a.name || ''));
    if (!dmg) return sendUpdate({ state: 'none' });   // no DMG asset to hand them → offer nothing
    manualDmg = { url: dmg.browser_download_url, version };
    sendUpdate({ state: 'available', version, manual: true });
  } catch (_) { sendUpdate({ state: 'none' }); }
}
// Download the DMG to ~/Downloads, then open it so Finder shows the drag-to-Applications window.
function downloadDmgAndOpen() {
  if (!manualDmg) { shell.openExternal(RELEASES_PAGE); return; }   // safety net: just open releases
  const dest = path.join(app.getPath('downloads'), path.basename(manualDmg.url.split('?')[0]));
  sendUpdate({ state: 'downloading', percent: 0, manual: true });
  downloadFile(manualDmg.url, dest, (pct) => sendUpdate({ state: 'downloading', percent: pct, manual: true }))
    .then(() => { sendUpdate({ state: 'manual-ready', version: manualDmg.version }); shell.openPath(dest); })
    .catch(() => { sendUpdate({ state: 'none' }); shell.openExternal(RELEASES_PAGE); }); // fall back to the page
}
function initAutoUpdate() {
  if (!app.isPackaged) return;                  // electron-updater only works in packaged apps
  if (MANUAL_MAC) return initManualUpdate();    // unsigned mac → self-contained DMG flow
  autoUpdater.autoDownload = false;             // hold the download until the user hits the button
  autoUpdater.on('update-available', (i) => sendUpdate({ state: 'available', version: i.version }));
  autoUpdater.on('update-not-available', () => sendUpdate({ state: 'none' }));
  autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (i) => sendUpdate({ state: 'ready', version: i.version }));
  autoUpdater.on('error', () => sendUpdate({ state: 'none' }));
  autoUpdater.checkForUpdates().catch(() => sendUpdate({ state: 'none' }));
}
ipcMain.handle('update-status-get', () => updateStatus);
ipcMain.on('update-download', () => {
  if (MANUAL_MAC) { downloadDmgAndOpen(); return; }       // unsigned mac: fetch DMG + open it
  try { autoUpdater.downloadUpdate(); } catch (_) {}
});
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

  // If the renderer or GPU process dies (the symptom behind a "went black" window), reload once so it
  // recovers on its own instead of leaving a dead black pane. 'crashed'/'oom' only — not a clean exit.
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) win.reload();
  });

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
