#!/usr/bin/env node
/* Merge souljaterm's Claude Code hooks into ~/.claude/settings.json so Roll can
   narrate real activity. Non-destructive: backs up first, preserves existing
   hooks/keys, and is idempotent. Run: npm run install-hooks   (undo: restore the
   .bak file it prints, or run with `uninstall`). */
const fs = require('fs');
const path = require('path');
const os = require('os');

const NOTIFY = path.join(__dirname, '..', 'bin', 'souljaterm-notify.js');
const CMD = `node "${NOTIFY}"`;   // quote: Windows paths have spaces/backslashes
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop'];
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const uninstall = process.argv[2] === 'uninstall';

function read() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (_) { return {}; }
}
function isOurs(entry) {
  return (entry.hooks || []).some((h) => (h.command || '').includes('souljaterm-notify'));
}

const settings = read();
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
if (fs.existsSync(settingsPath)) {
  const bak = settingsPath + '.bak';
  fs.copyFileSync(settingsPath, bak);
  console.log('backed up ->', bak);
}

settings.hooks = settings.hooks || {};
for (const ev of EVENTS) {
  const list = (settings.hooks[ev] || []).filter((e) => !isOurs(e)); // drop any prior souljaterm entry
  if (!uninstall) {
    list.push({ matcher: '', hooks: [{ type: 'command', command: CMD }] });
  }
  settings.hooks[ev] = list;
  if (!settings.hooks[ev].length) delete settings.hooks[ev];
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
console.log(uninstall ? 'removed souljaterm hooks from' : 'installed souljaterm hooks into', settingsPath);
console.log('events:', EVENTS.join(', '));
