/* souljaterm — CRT shader for Roll's face.
 *
 * One full-window WebGL2 canvas at pointer-events:none. Roll's 32x32 pixel-art face hands us its
 * <img> each frame; we run the selected libretro .glslp chain (see glslp.js) and paint the result
 * over her face's rect. Everywhere else stays transparent, so the rest of the app shows through
 * crisp and clicks pass to the live DOM. Her low-res portrait is what makes scanlines read like a
 * real CRT tube — the effect is pointless on hi-res surfaces, so it's scoped to her box alone.
 *
 * Config persists in localStorage. The shader menu in renderer.js drives this via window.Fx.
 */
(function () {
  'use strict';

  const LS_KEY = 'fxConfig';
  const listeners = [];
  let gl = null, canvas = null, chain = null;
  let raf = 0, frame = 0;
  // CRT power-on ramp: poDur>0 means an animation is in flight; the loop reads currentPowerOn()
  // each frame so the turn-on stays smooth regardless of paint cadence. poVal holds it otherwise.
  let poVal = 1, poStart = 0, poDur = 0;
  // Transient CRT "glitch" pulse (sprite suddenly changed a lot). Decays linearly to 0 over glDur;
  // the loop reads currentGlitch() each frame and feeds it to the shader's GLITCH uniform.
  let glVal = 0, glStart = 0, glDur = 0;
  const perfNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : 0);
  function currentPowerOn() {
    if (!poDur) return poVal;
    const t = (perfNow() - poStart) / poDur;
    if (t >= 1) { poDur = 0; poVal = 1; return 1; }
    return t > 0 ? t : 0;
  }
  function currentGlitch() {
    if (!glDur) return 0;
    const t = (perfNow() - glStart) / glDur;
    if (t >= 1) { glDur = 0; return 0; }
    return glVal * (1 - t);            // ease out to nothing
  }
  const surfaces = {};            // id -> { el, getSource }
  let shaderList = [];            // [{ where, file, name, preset }]

  // First-open default: the CRT look tuned in the original build. A fresh install — or the dev build's
  // own clean userData — opens with the shader already dialed in instead of off/blank. Used ONLY when
  // nothing is saved yet; the moment the user changes anything, their saved localStorage wins.
  const DEFAULT_CONFIG = {
    enabled: true,
    preset: { where: 'bundled', file: 'crt-lite.glslp' },
    params: {
      'bundled/scanline.glslp': { BRIGHTNESS: 1.52, SCANLINE_WEIGHT: 0.26 },
      'bundled/crt-lite.glslp': { GLOW: 0.42, SCAN_WEIGHT: 0.6, CURVATURE: 0.4, VIGNETTE: 0.18, BRIGHT: 1.2, MASK_WEIGHT: 0 },
    },
  };

  const cfg = loadConfig();

  function loadConfig() {
    let raw = null;
    try { raw = localStorage.getItem(LS_KEY); } catch (_) {}
    if (raw == null) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));  // never saved → seed the default
    let c = {};
    try { c = JSON.parse(raw) || {}; } catch (_) { c = {}; }
    return {
      enabled: !!c.enabled,
      preset: c.preset || null,                       // { where, file }
      params: c.params || {},                         // { "where/file": { NAME: val } }
    };
  }
  function saveConfig() { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (_) {} }

  function presetKey(p) { return p ? p.where + '/' + p.file : ''; }
  function emit() { const s = getState(); listeners.forEach((cb) => { try { cb(s); } catch (_) {} }); }

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'fx-overlay';
    document.body.appendChild(canvas);
    gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false });
    if (!gl) { console.warn('[fx] WebGL2 unavailable — CRT shader disabled'); return; }
    chain = new window.Glslp.Chain(gl);
  }

  function dpr() { return window.devicePixelRatio || 1; }

  function resizeCanvas() {
    const w = Math.round(window.innerWidth * dpr());
    const h = Math.round(window.innerHeight * dpr());
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
  }

  function loop() {
    raf = 0;
    if (!cfg.enabled || !gl || !chain || !chain.passes.length) return;
    resizeCanvas();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    frame++;
    chain.powerOn = currentPowerOn();
    chain.glitch = currentGlitch();

    const cssH = window.innerHeight;
    const scale = dpr();
    for (const id in surfaces) {
      const surf = surfaces[id];
      // el may be an element or a function resolving the current element, so the shaded rect
      // tracks the real content rather than a fixed box.
      const node = typeof surf.el === 'function' ? safe(surf.el) : surf.el;
      if (!node) continue;
      const src = safe(surf.getSource);
      if (!src) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;

      // Pull the shaded region IN by `inset` CSS px on every side so the tube sits INSIDE the panel's
      // bezel (the surrounding plastic frame keeps showing) instead of painting over it.
      const ins = (surf.inset || 0) * scale;
      // CSS rect (origin top-left) -> framebuffer pixels (origin bottom-left).
      const x = Math.round(rect.left * scale + ins);
      const y = Math.round((cssH - (rect.top + rect.height)) * scale + ins);
      const w = Math.round(rect.width * scale - ins * 2);
      const h = Math.round(rect.height * scale - ins * 2);
      if (w < 2 || h < 2) continue;

      try {
        chain.uploadSource(src);
        chain.render(w, h, frame, x, y);
      } catch (e) { /* one bad surface shouldn't kill the loop */ }
    }
    raf = requestAnimationFrame(loop);
  }

  function safe(fn) { try { return fn(); } catch (_) { return null; } }

  function start() {
    if (!cfg.enabled) return;
    ensureCanvas();
    if (!gl) { cfg.enabled = false; return; }
    canvas.style.display = 'block';
    if (!raf) raf = requestAnimationFrame(loop);
  }
  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (canvas) canvas.style.display = 'none';
  }

  // Build pass defs from a preset's .glslp text + its referenced .glsl files, then load the chain.
  async function applyPreset(p) {
    ensureCanvas();
    if (!gl) return false;
    if (!p) { chain.dispose(true); emit(); return false; }
    const presetText = await window.souljaterm.readShader(p.where, p.file);
    if (presetText == null) { chain.error = 'preset not found: ' + p.file; emit(); return false; }
    const parsed = window.Glslp.parseGlslp(presetText);
    const defs = [];
    for (const pass of parsed.passes) {
      const source = await window.souljaterm.readShader(p.where, pass.ref);
      if (source == null) { chain.error = 'missing pass file: ' + pass.ref; emit(); return false; }
      defs.push({
        source,
        filterLinear: pass.filterLinear,
        scaleType: pass.scaleType, scaleTypeX: pass.scaleTypeX, scaleTypeY: pass.scaleTypeY,
        scale: pass.scale, scaleX: pass.scaleX, scaleY: pass.scaleY,
        wrapMode: pass.wrapMode, floatFb: pass.floatFb,
      });
    }
    // restore saved param values for this preset, then apply preset-file overrides
    const saved = cfg.params[presetKey(p)] || {};
    chain.values = Object.assign({}, parsed.overrides, saved);
    const ok = chain.setPreset(defs);
    if (ok) { cfg.preset = { where: p.where, file: p.file }; saveConfig(); }
    emit();
    return ok;
  }

  /* ---------- public API ---------- */
  const Fx = {
    async init() {
      try { shaderList = await window.souljaterm.listShaders(); } catch (_) { shaderList = []; }
      // pick saved preset, or default to the first bundled one
      let p = cfg.preset && shaderList.find((s) => s.where === cfg.preset.where && s.file === cfg.preset.file);
      if (!p) p = shaderList[0] || null;
      if (p) await applyPreset(p);
      if (cfg.enabled) start();
      window.addEventListener('resize', () => { /* loop re-reads size each frame */ });
      emit();
    },
    // el: Element | () => Element. opts.inset = CSS px to shrink the shaded rect on each side (keeps
    // the surface's bezel visible around the tube).
    registerSurface(id, el, getSource, opts) { surfaces[id] = { el, getSource, inset: (opts && opts.inset) || 0 }; },
    setEnabled(on) {
      cfg.enabled = !!on; saveConfig();
      if (cfg.enabled) start(); else stop();
      emit();
    },
    toggle() { Fx.setEnabled(!cfg.enabled); },
    async selectPreset(where, file) {
      const ok = await applyPreset({ where, file });
      if (ok && cfg.enabled) start();
      return ok;
    },
    setParam(name, val) {
      if (!chain) return;
      chain.setParam(name, val);
      const k = presetKey(cfg.preset);
      (cfg.params[k] = cfg.params[k] || {})[name] = val;
      saveConfig();
    },
    // Like setParam but transient — drives a uniform live (e.g. WiFi-reactive wobble) without
    // persisting it or overwriting the user's saved value.
    setLiveParam(name, val) { if (chain) chain.setParam(name, val); },
    // Hold the CRT power-on at a fixed progress (0 = collapsed/dark, 1 = fully on). Used to keep
    // Roll's face dark behind the shader during the brief pre-warp hold, before powerOn() ramps it.
    setPowerOn(v) { poDur = 0; poVal = Math.max(0, Math.min(1, v)); },
    // Play the CRT tube turn-on: ramp POWER_ON 0 -> 1 over durationMs (the loop animates the shader).
    powerOn(durationMs) { poVal = 0; poStart = perfNow(); poDur = Math.max(1, durationMs || 1100); start(); },
    // Fire a transient glitch pulse (0..1 intensity) that decays over durationMs — the shader tears/
    // desyncs briefly, as if the old tube struggled with the sudden change. Stacks to the stronger hit.
    glitch(amount, durationMs) {
      const a = Math.max(0, Math.min(1, amount == null ? 0.6 : amount));
      if (a <= 0) return;
      glVal = Math.max(a, currentGlitch());   // don't let a new small hit weaken a big one still ringing
      glStart = perfNow(); glDur = Math.max(60, durationMs || 380);
    },
    // Live-edit: recompile the single-pass current preset from edited source text.
    applySource(text) {
      if (!chain) return { ok: false, error: 'no chain' };
      const ok = chain.setPreset([{ source: text, filterLinear: true, scaleType: 'viewport', scale: 1 }]);
      emit();
      return { ok, error: chain.error };
    },
    async refreshList() { try { shaderList = await window.souljaterm.listShaders(); } catch (_) {} emit(); return shaderList; },
    getState() { return getState(); },
    onChange(cb) { listeners.push(cb); },
    currentSource() {
      // source text of the current single-pass preset (for the editor)
      return chain && chain.passes[0] ? chain.passes[0].def.source : '';
    },
  };

  function getState() {
    return {
      ready: !!gl,
      enabled: cfg.enabled,
      preset: cfg.preset,
      list: shaderList.map((s) => ({ where: s.where, file: s.file, name: s.name })),
      params: chain ? chain.paramList().map((p) => Object.assign({}, p, { value: chain.values[p.name] != null ? chain.values[p.name] : p.def })) : [],
      error: chain ? chain.error : null,
    };
  }

  window.Fx = Fx;
})();
