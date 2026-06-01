#!/usr/bin/env node
/* Invoked by Claude Code hooks. Reads the hook's JSON from stdin, tags it with
   the souljaterm tab (from env), and forwards it to the app's local socket.
   No-op (exits 0) when not running inside a souljaterm tab, so it's safe to put
   in global ~/.claude/settings.json. Must be fast and never block Claude. */
const net = require('net');

const sock = process.env.SOULJATERM_SOCK;
if (!sock) process.exit(0); // not inside souljaterm — do nothing

let input = '';
let done = false;
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', send);
setTimeout(send, 700); // fire even if stdin never closes

function send() {
  if (done) return;
  done = true;
  let hook = {};
  try { hook = JSON.parse(input || '{}'); } catch (_) {}
  const payload = JSON.stringify({
    tab: process.env.SOULJATERM_TAB || '',
    project: process.env.SOULJATERM_PROJECT || '',
    hook,
  }) + '\n';
  const c = net.connect(sock, () => c.write(payload, () => c.end()));
  c.on('error', () => process.exit(0));
  c.on('close', () => process.exit(0));
  setTimeout(() => process.exit(0), 1200);
}
