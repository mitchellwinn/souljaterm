# souljaterm

A custom terminal for vibing in Claude Code. Electron + xterm.js + node-pty.

## Run

```bash
npm install   # also rebuilds node-pty for Electron's ABI
npm start
```

## What works now (v0.1)

- **Multi-tab** real shells over a PTY (`$SHELL -l`).
- **Tabs colored by directory** — stable hue hashed from the cwd. Each project
  gets its own consistent color dot + active-tab underline.
- **GPU text** via the xterm WebGL renderer (falls back silently if unavailable).
- **Directory sidebar** — lists folders under `~/Projects`; click one to start a
  new session in that directory (Obsidian-style launcher). Color matches its tab.
- **Natural recolor on `cd`** — tabs listen for OSC 7, so the color + name follow
  the directory you move into (see shell setup below).
- **Hotkeys:** `⌘T` new tab · `⌘W` close · `⌘1–9` jump to tab ·
  `⌘⇧[ / ⌘⇧]` cycle · `⌘B` toggle sidebar.
- **Flash-on-bell** — an unfocused tab pulses when its shell emits BEL. This is
  the stand-in until the real Claude Code hook lands (below).

## Shell setup for natural recolor (OSC 7)

Tabs recolor when you `cd` only if your shell reports the cwd. For zsh, add to
`~/.zshrc`:

```sh
function _souljaterm_osc7 { printf '\033]7;file://%s%s\033\\' "$HOST" "$PWD"; }
add-zsh-hook chpwd _souljaterm_osc7; _souljaterm_osc7
```

(Most modern shell-integration setups already emit OSC 7.)

## Roadmap

- [ ] **Default Claude Code hooks** — ship a `settings.json` hooks block + a tiny
      `souljaterm-notify` CLI that signals the app over a local socket, so a tab
      **flashes + plays a sound when Claude needs input** (vs. when it just
      finished). Replaces the BEL stand-in with real state.
- [ ] **Sound effects** — distinct chimes for done / needs-you / error.
- [ ] **Fuller file tree** — expandable sidebar, not just one level.
- [ ] **Hotkey parity with Ghostty** — splits, tab reordering, command palette.
- [ ] **Session HUD** — show every tab's state (working / idle / blocked) at once.
- [ ] **Per-project window tint + themes.**

## Architecture

- `main.js` — Electron main: spawns/owns PTYs, directory-listing IPC.
- `preload.js` — `contextBridge` exposing a safe `window.souljaterm` API.
- `src/renderer.js` — tabs, colored-by-cwd logic, GPU terminals, sidebar.
- `src/styles.css` — layout + tab/flash styling.
