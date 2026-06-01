/* souljaterm landing: detect OS, wire downloads, and let Roll talk the visitor into it.
   Reuses the app's RollFace engine (frames + voice clips) with a web-relative asset base. */

const REPO = 'https://github.com/mitchellwinn/souljaterm';
const RELEASES = REPO + '/releases/latest';

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

// Her scripted welcome pitch (the queue paces these; clips throttle themselves).
const lines = [
  { expression: 'happy',     line: "Hi! I'm Roll — welcome to souljaterm!" },
  { expression: 'talk',      line: "It's a terminal that runs Claude Code… and I live inside it, cheering you on." },
  { expression: 'surprised', line: "Colored tabs, my voice, alerts the moment Claude needs you — all the vibes.", clip: 'mitete' },
  { expression: 'happy',     line: `Wanna try it? Grab it below${os ? ' for ' + os : ''} — it's free, and it uses your own Claude login!`, clip: 'ikuyo' },
];

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
  face.play('idle');
  face._playClip('appear');                              // entrance sound — the click just unlocked it
  setTimeout(() => faceEl.classList.remove('warp-in'), 1100);
  setTimeout(() => { for (const l of lines) face.speak(l); }, 250); // queue her pitch
}
powerBtn.addEventListener('click', powerOn); // only Roll's screen powers on

// If they linger, she keeps the energy up.
const nudges = [
  { expression: 'wink',  line: "Still here? Go on — I'll keep your sessions company!", clip: 'sore' },
  { expression: 'happy', line: "Psst — it runs on macOS, Windows and Linux. No excuses!", clip: 'makasete' },
];
let n = 0;
setInterval(() => { if (warped) { face.speak(nudges[n % nudges.length]); n++; } }, 40000); // only once powered on

// A click on download earns a cheer.
primary.addEventListener('click', () => face.speak({ expression: 'laugh', line: "Yes!! See you in the terminal!", clip: 'yattane' }));
