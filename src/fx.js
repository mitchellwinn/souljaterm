/* souljaterm — CRT shader overlay manager.
 *
 * One full-window WebGL2 canvas at pointer-events:none. Each registered "surface" (the active
 * terminal, Roll's face) hands us a source canvas/image each frame; we run the selected libretro
 * .glslp chain (see glslp.js) and paint the result over that surface's screen rect. Everywhere
 * else stays transparent, so un-shaded chrome shows through crisp and clicks pass to the live DOM.
 *
 * Config persists in localStorage. The shader-editing menu in renderer.js drives this via the
 * public API on window.Fx.
 */
(function () {
  'use strict';

  // xterm's WebGL renderer creates its canvas with preserveDrawingBuffer:false, so drawImage()
  // of it returns a blank buffer — we'd capture nothing to shade. Force the flag on every WebGL
  // context (installed before any terminal is created) so the terminal canvas stays snapshot-able.
  // Cost is a small amount of GPU bandwidth; fine for a terminal.
  (function patchGetContext() {
    const proto = HTMLCanvasElement.prototype;
    if (proto.__fxPatched) return;
    const orig = proto.getContext;
    proto.getContext = function (type, attrs) {
      if (type === 'webgl' || type === 'webgl2') {
        attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
      }
      return orig.call(this, type, attrs);
    };
    proto.__fxPatched = true;
  })();

  const LS_KEY = 'fxConfig';
  const listeners = [];
  let gl = null, canvas = null, chain = null;
  let raf = 0, frame = 0;
  const surfaces = {};            // id -> { el, getSource }
  let shaderList = [];            // [{ where, file, name, preset }]

  const cfg = loadConfig();

  function loadConfig() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (_) { c = {}; }
    return {
      enabled: !!c.enabled,
      preset: c.preset || null,                       // { where, file }
      surfaces: Object.assign({ terminal: true, rollface: true }, c.surfaces || {}),
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
    if (!gl) { console.warn('[fx] WebGL2 unavailable — CRT shaders disabled'); return; }
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

    const cssH = window.innerHeight;
    const scale = dpr();
    for (const id in surfaces) {
      if (!cfg.surfaces[id]) continue;
      const surf = surfaces[id];
      // el may be an element or a function resolving the current element (the active terminal's
      // grid moves between tabs), so the shaded rect tracks the real content, not a fixed box.
      const node = typeof surf.el === 'function' ? safe(surf.el) : surf.el;
      if (!node) continue;
      const src = safe(surf.getSource);
      if (!src) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;

      // CSS rect (origin top-left) -> framebuffer pixels (origin bottom-left).
      const x = Math.round(rect.left * scale);
      const y = Math.round((cssH - (rect.top + rect.height)) * scale);
      const w = Math.round(rect.width * scale);
      const h = Math.round(rect.height * scale);

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
    registerSurface(id, el, getSource) { surfaces[id] = { el, getSource }; }, // el: Element | () => Element
    setEnabled(on) {
      cfg.enabled = !!on; saveConfig();
      if (cfg.enabled) start(); else stop();
      emit();
    },
    toggle() { Fx.setEnabled(!cfg.enabled); },
    setSurface(id, on) { cfg.surfaces[id] = !!on; saveConfig(); emit(); },
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
      surfaces: Object.assign({}, cfg.surfaces),
      list: shaderList.map((s) => ({ where: s.where, file: s.file, name: s.name })),
      params: chain ? chain.paramList().map((p) => Object.assign({}, p, { value: chain.values[p.name] != null ? chain.values[p.name] : p.def })) : [],
      error: chain ? chain.error : null,
    };
  }

  window.Fx = Fx;
})();
