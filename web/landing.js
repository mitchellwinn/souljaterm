/* souljaterm landing: detect OS, wire downloads, and let Roll talk the visitor into it.
   Reuses the app's RollFace engine (frames + voice clips) with a web-relative asset base. */

const REPO = 'https://github.com/mitchellwinn/souljaterm';
const RELEASES = REPO + '/releases/latest';

// --- web shim for the app's Electron shader bridge (main.js read-shader/list-shaders) ---
// fx.js asks window.souljaterm for preset (.glslp) and pass (.glsl) text; on the web we fetch the
// bundled copies over HTTP instead of reading the userData/app dirs. Same base CRT settings ship in
// fx.js's DEFAULT_CONFIG, so visitors see Roll exactly as she looks in the app.
const SHADER_BASE = 'assets/shaders/';
window.souljaterm = window.souljaterm || {};
window.souljaterm.readShader = async (where, file) => {
  if (where !== 'bundled') return null;                  // only bundled presets are served on the web
  const name = String(file || '').split('/').pop();      // basename, like main.js's readShaderSafe
  try { const r = await fetch(SHADER_BASE + name); return r.ok ? await r.text() : null; }
  catch (_) { return null; }
};
window.souljaterm.listShaders = async () => {
  const out = [];
  for (const file of ['crt-lite.glslp', 'scanline.glslp']) {   // the two bundled presets, sorted as main.js returns them
    const preset = await window.souljaterm.readShader('bundled', file);
    if (preset != null) out.push({ where: 'bundled', file, name: file.replace(/\.glslp$/i, ''), preset });
  }
  return out;
};

// --- OS detection for the download label ---
const ua = navigator.userAgent;
const platform = (navigator.userAgentData && navigator.userAgentData.platform) || '';
const os = /Win/i.test(ua + platform) ? 'Windows'
  : /Mac/i.test(ua + platform) ? 'macOS'
  : /Linux|X11|CrOS/i.test(ua + platform) ? 'Linux'
  : '';

const primary = document.getElementById('dl-primary');
primary.href = RELEASES;
primary.textContent = os ? `⤓ Download for ${os}` : '⤓ Download souljaterm';
document.getElementById('dl-mac').href = RELEASES;
document.getElementById('dl-win').href = RELEASES;
document.getElementById('dl-linux').href = RELEASES;
document.getElementById('dl-src').href = REPO;

// --- Roll, reusing the app's face engine with web-relative assets ---
// RollFace's constructor does faceEl.replaceChildren(img), which would wipe the #power button —
// so grab it first and re-append it ON TOP of her screen afterward.
const faceEl = document.getElementById('face');
const powerBtn = faceEl.querySelector('#power');
const face = new window.RollFace(faceEl, document.getElementById('msg'), { base: 'assets/' });
faceEl.appendChild(powerBtn);
faceEl.classList.add('warp-pending'); // hidden until she warps in

// CRT shader over Roll's face — the same engine + base settings as the app (fx.js DEFAULT_CONFIG).
// We feed the shader a fresh-drawn 2D canvas of her current frame rather than the bare <img>: the
// frame's src swaps every animation tick, and an in-flight <img> would skip-flicker the upload, so
// keeping a last-good canvas mirrors the app's faceSource() and renders cleanly.
const faceCanvas = document.createElement('canvas');
const faceCtx = faceCanvas.getContext('2d');
function rollFaceSource() {
  const img = face.img;
  if (img && img.complete && img.naturalWidth) {
    if (faceCanvas.width !== img.naturalWidth) { faceCanvas.width = img.naturalWidth; faceCanvas.height = img.naturalHeight; }
    try { faceCtx.clearRect(0, 0, faceCanvas.width, faceCanvas.height); faceCtx.drawImage(img, 0, 0); } catch (_) {}
  }
  return faceCanvas.width ? faceCanvas : img;
}
if (window.Fx) Fx.registerSurface('rollface', faceEl, rollFaceSource);

// --- mobile detection: phones/tablets get a different reception from Roll ---
const isMobile = !!(navigator.userAgentData && navigator.userAgentData.mobile)
  || /Android|iPhone|iPad|iPod|Mobile|Mobi|Silk|Kindle|BlackBerry|Opera Mini|IEMobile/i.test(ua)
  || (matchMedia('(pointer: coarse)').matches && matchMedia('(max-width: 860px)').matches);
if (isMobile) {
  document.body.classList.add('mobile');
  primary.textContent = '⤓ Get it on a computer';          // nothing to install on a phone
  const hint = document.querySelector('.boot-hint');
  if (hint) hint.textContent = "▸ Tap Roll's screen to power on ↓";
}

// Her scripted welcome pitch (the queue paces these; clips throttle themselves).
// Roll is Dr. Light's helper robot from the year 20XX — sweet, optimistic, and squarely
// in your corner, like the support unit she is for her brother.
const desktopLines = [
  { expression: 'happy',       line: "Hi, I'm Roll! Dr. Light built me to keep house. These days I keep your terminal company instead." },
  { expression: 'talk',        line: "Down there is a real shell running Claude Code, and I live in the corner of it, rooting for you." },
  { expression: 'talk',        line: "Need a hand? Just type \"!do this\" and I'll take the job myself — I route it, run it, and show you every step in a live panel." },
  { expression: 'wink',        line: "I also ping you the instant Claude needs a human, so you're never stuck babysitting a stalled prompt.", clip: 'mitete' },
  { expression: 'happy',       line: `Grab it below${os ? ' for ' + os : ''}. It's free and runs on your own Claude login, no key required.`, clip: 'ikuyo' },
];

// Phone visitors: she's a robot from 20XX, so a pocket supercomputer genuinely impresses her…
// right before she tells you to go sit at a real machine.
const mobileLines = [
  { expression: 'surprised',   line: "Hold on, let me scan your hardware… you're running me on a phone?!", clip: 'kya' },
  { expression: 'talk',        line: "Astonishing. A whole computer in one hand. I'm from 20XX and even WE thought this was sci-fi." },
  { expression: 'wink',        line: "Pocket supercomputer, opening a terminal site on the go. Very cute. Very advanced. Dr. Light would faint.", clip: 'mitete' },
  { expression: 'happy',       line: "But robot to human: souljaterm runs real shells and Claude Code. For actual work, you want a proper computer." },
  { expression: 'talk',        line: "That's where I really shine — type \"!do this\" and I'll take the job myself, running it as an agent and showing you every step." },
  { expression: 'wink',        line: "Bookmark me, come back on a desktop. macOS, Windows or Linux. I'll keep your seat warm!", clip: 'makasete' },
];

const lines = isMobile ? mobileLines : desktopLines;

// The autoplay block becomes the feature: almost nothing shows until you click Roll's TV. That
// click is the user gesture that unlocks audio, so she powers on WITH her "appear" clip + voice.
let warped = false;
function powerOn() {
  if (warped) return;
  warped = true;
  document.body.classList.add('on');                     // reveal the pitch + download
  try { face._audio && face._audio.resume(); } catch (_) {}
  try { face._cap && face._cap.resume(); } catch (_) {}
  faceEl.classList.remove('warp-pending');
  faceEl.classList.add('warp-in');
  if (window.Fx) Fx.init();                              // boot the CRT shader over her face (held off until the gate clears)
  face.play('idle');
  face._playClip('appear');                              // entrance sound — the click just unlocked it
  setTimeout(() => faceEl.classList.remove('warp-in'), 1100);
  setTimeout(() => { for (const l of lines) face.speak(l); }, 250); // queue her pitch
}
powerBtn.addEventListener('click', powerOn); // only Roll's screen powers on

// If they linger, she keeps the energy up.
const nudges = isMobile ? [
  { expression: 'wink',        line: "Still thumbing away on the pocket marvel? Adorable. A desktop's ready whenever you're serious.", clip: 'sore' },
  { expression: 'wink',        line: "Tiny screen, big dreams. Come find me on a real machine and let's actually build something.", clip: 'makasete' },
] : [
  { expression: 'wink',        line: "Still here? Go on, I'll keep your sessions tidy while you work.", clip: 'sore' },
  { expression: 'happy',       line: "I run native on macOS, Windows and Linux. Dr. Light made me very portable.", clip: 'makasete' },
];
let n = 0;
setInterval(() => { if (warped) { face.speak(nudges[n % nudges.length]); n++; } }, 40000); // only once powered on

// A click on download earns a cheer.
primary.addEventListener('click', () => face.speak({ expression: 'laugh', line: "Yes!! See you in the terminal!", clip: 'yattane' }));
