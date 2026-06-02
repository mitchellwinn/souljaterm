/* souljaterm — libretro .glslp runner on WebGL2.
 *
 * Targets the libretro GLSL ES 1.00 ("COMPAT") format used by the glsl-shaders repo:
 * one .glsl file per pass holding both stages, split by #if defined(VERTEX)/FRAGMENT, with
 * RetroArch's standard uniforms (MVPMatrix, OutputSize, TextureSize, InputSize, FrameCount,
 * FrameDirection, sampler2D Texture). We compile each file twice (VERTEX / FRAGMENT) on a
 * WebGL2 context — WebGL2 still accepts #version 100 — which covers the bulk of the CRT
 * presets without dragging in SPIRV-Cross for the modern .slangp family.
 *
 * Supported preset keys: shaders, shaderN, filter_linearN, scale_typeN/scale_type_xN/yN,
 * scaleN/scale_xN/yN, wrap_modeN, float_framebufferN, frame_count_modN, plus #pragma parameter
 * and `name = value` overrides. Cross-pass samplers beyond Original/Source are not wired yet.
 */
(function () {
  'use strict';

  // Fullscreen quad: clip-space position (xy in -1..1) + uv (0..1). VertexCoord is fed as
  // vec4(pos,0,1); with MVPMatrix=identity, gl_Position = MVPMatrix*VertexCoord is correct.
  const QUAD = new Float32Array([
    //  x     y     u    v
    -1, -1, 0, 0,
    1, -1, 1, 0,
    -1, 1, 0, 1,
    -1, 1, 0, 1,
    1, -1, 1, 0,
    1, 1, 1, 1,
  ]);

  function preamble(stage) {
    const isVert = stage === 'VERTEX';
    return [
      '#version 100',
      'precision highp float;',
      'precision highp int;',
      '#define ' + stage,
      isVert ? '#define COMPAT_VARYING varying' : '#define COMPAT_VARYING varying',
      '#define COMPAT_ATTRIBUTE attribute',
      '#define COMPAT_TEXTURE texture2D',
      '#define COMPAT_PRECISION',
      // core-format shaders write FragColor / call texture(); map them onto GLES2 builtins.
      isVert ? '' : '#define FragColor gl_FragColor',
      '#define texture texture2D',
      '#define out_FragColor gl_FragColor',
      '',
    ].filter((l) => l !== null).join('\n') + '\n';
  }

  function stripVersion(src) {
    // Drop any #version the shader declares; we supply our own.
    return src.replace(/^[\t ]*#version[^\n]*\n/m, '');
  }

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      const tag = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
      throw new Error('[' + tag + '] ' + log + '\n--- source ---\n' + numberLines(src));
    }
    return sh;
  }

  function numberLines(src) {
    return src.split('\n').map((l, i) => (i + 1) + '\t' + l).join('\n');
  }

  function link(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error('link: ' + log);
    }
    return p;
  }

  // #pragma parameter NAME "Human readable" default min max step
  function parseParams(src) {
    const out = [];
    const re = /#pragma\s+parameter\s+(\w+)\s+"([^"]*)"\s+([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)(?:\s+([\-0-9.]+))?/g;
    let m;
    while ((m = re.exec(src))) {
      out.push({
        name: m[1], desc: m[2],
        def: parseFloat(m[3]), min: parseFloat(m[4]), max: parseFloat(m[5]),
        step: m[6] != null ? parseFloat(m[6]) : 0.01,
      });
    }
    return out;
  }

  function scaleSize(scaleType, scale, inputSize, viewport) {
    switch (scaleType) {
      case 'viewport': return Math.max(1, Math.round(viewport * scale));
      case 'absolute': return Math.max(1, Math.round(scale));
      case 'source':
      default: return Math.max(1, Math.round(inputSize * scale));
    }
  }

  function wrapConst(gl, mode) {
    switch (mode) {
      case 'repeat': return gl.REPEAT;
      case 'mirrored_repeat': return gl.MIRRORED_REPEAT;
      // WebGL has no CLAMP_TO_BORDER; edge is the closest.
      case 'clamp_to_border':
      case 'clamp_to_edge':
      default: return gl.CLAMP_TO_EDGE;
    }
  }

  class Pass {
    constructor(gl, def, index) {
      this.gl = gl;
      this.def = def;            // { source, filterLinear, scaleType, scale, wrapMode, floatFb }
      this.index = index;
      const src = stripVersion(def.source);
      const vs = compile(gl, gl.VERTEX_SHADER, preamble('VERTEX') + src);
      const fs = compile(gl, gl.FRAGMENT_SHADER, preamble('FRAGMENT') + src);
      this.program = link(gl, vs, fs);
      gl.deleteShader(vs); gl.deleteShader(fs);
      this.params = parseParams(def.source);

      this.loc = {
        VertexCoord: gl.getAttribLocation(this.program, 'VertexCoord'),
        TexCoord: gl.getAttribLocation(this.program, 'TexCoord'),
        COLOR: gl.getAttribLocation(this.program, 'COLOR'),
        MVPMatrix: gl.getUniformLocation(this.program, 'MVPMatrix'),
        OutputSize: gl.getUniformLocation(this.program, 'OutputSize'),
        TextureSize: gl.getUniformLocation(this.program, 'TextureSize'),
        InputSize: gl.getUniformLocation(this.program, 'InputSize'),
        FrameCount: gl.getUniformLocation(this.program, 'FrameCount'),
        FrameDirection: gl.getUniformLocation(this.program, 'FrameDirection'),
        Texture: gl.getUniformLocation(this.program, 'Texture'),
        Original: gl.getUniformLocation(this.program, 'Original'),
        OriginalSize: gl.getUniformLocation(this.program, 'OriginalSize'),
      };
      this.paramLoc = {};
      this.params.forEach((p) => { this.paramLoc[p.name] = gl.getUniformLocation(this.program, p.name); });

      // Output framebuffer (last pass renders to the default fb, so it has none).
      this.fbo = null;
      this.tex = null;
      this.texW = 0;
      this.texH = 0;
    }

    ensureTarget(w, h, isLast) {
      if (isLast) return;            // last pass draws straight to the canvas
      const gl = this.gl;
      if (this.tex && this.texW === w && this.texH === h) return;
      if (this.tex) gl.deleteTexture(this.tex);
      if (this.fbo) gl.deleteFramebuffer(this.fbo);
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      const lin = this.def.filterLinear ? gl.LINEAR : gl.NEAREST;
      const wrap = wrapConst(gl, this.def.wrapMode);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, lin);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      if (this.def.floatFb) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      this.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
      this.texW = w; this.texH = h;
    }
  }

  const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  class Chain {
    constructor(gl) {
      this.gl = gl;
      this.vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
      this.passes = [];
      this.values = {};            // param name -> current value
      this.error = null;
      // Source texture (the surface we're shading), uploaded each frame.
      this.srcTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      try { gl.getExtension('EXT_color_buffer_float'); } catch (_) {}
    }

    /* defs: [{ source, filterLinear, scaleType, scale, wrapMode, floatFb }] */
    setPreset(defs) {
      this.dispose(true);
      this.error = null;
      try {
        this.passes = defs.map((d, i) => new Pass(this.gl, d, i));
      } catch (e) {
        this.passes = [];
        this.error = String(e.message || e);
        return false;
      }
      // Seed any param defaults we don't already have a user value for.
      this.paramList().forEach((p) => {
        if (!(p.name in this.values)) this.values[p.name] = p.def;
      });
      return true;
    }

    paramList() {
      const seen = {};
      const out = [];
      this.passes.forEach((pass) => pass.params.forEach((p) => {
        if (!seen[p.name]) { seen[p.name] = 1; out.push(p); }
      }));
      return out;
    }

    setParam(name, val) { this.values[name] = val; }

    uploadSource(srcCanvas) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      this.srcW = srcCanvas.naturalWidth || srcCanvas.width;
      this.srcH = srcCanvas.naturalHeight || srcCanvas.height;
    }

    bindQuad(pass) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      const stride = 16;
      if (pass.loc.VertexCoord >= 0) {
        gl.enableVertexAttribArray(pass.loc.VertexCoord);
        gl.vertexAttribPointer(pass.loc.VertexCoord, 2, gl.FLOAT, false, stride, 0);
      }
      if (pass.loc.TexCoord >= 0) {
        gl.enableVertexAttribArray(pass.loc.TexCoord);
        gl.vertexAttribPointer(pass.loc.TexCoord, 2, gl.FLOAT, false, stride, 8);
      }
      if (pass.loc.COLOR >= 0) {
        gl.disableVertexAttribArray(pass.loc.COLOR);
        gl.vertexAttrib4f(pass.loc.COLOR, 1, 1, 1, 1);
      }
    }

    /* Render the chain into the canvas' default framebuffer (outFbo=null).
       outW/outH = pixel size of the output region; outX/outY = its lower-left
       origin in framebuffer pixels (lets several surfaces share one overlay). */
    render(outW, outH, frameCount, outX, outY) {
      const gl = this.gl;
      if (!this.passes.length) return false;
      outX = outX || 0; outY = outY || 0;

      let inTex = this.srcTex;
      let inW = this.srcW, inH = this.srcH;
      const origTex = this.srcTex, origW = this.srcW, origH = this.srcH;

      for (let i = 0; i < this.passes.length; i++) {
        const pass = this.passes[i];
        const isLast = i === this.passes.length - 1;
        let ow, oh;
        if (isLast) {
          ow = outW; oh = outH;
        } else {
          const stX = pass.def.scaleTypeX || pass.def.scaleType || 'source';
          const stY = pass.def.scaleTypeY || pass.def.scaleType || 'source';
          const sX = pass.def.scaleX != null ? pass.def.scaleX : (pass.def.scale != null ? pass.def.scale : 1);
          const sY = pass.def.scaleY != null ? pass.def.scaleY : (pass.def.scale != null ? pass.def.scale : 1);
          ow = scaleSize(stX, sX, inW, outW);
          oh = scaleSize(stY, sY, inH, outH);
        }
        pass.ensureTarget(ow, oh, isLast);

        gl.bindFramebuffer(gl.FRAMEBUFFER, isLast ? null : pass.fbo);
        gl.viewport(isLast ? outX : 0, isLast ? outY : 0, ow, oh);
        gl.useProgram(pass.program);

        if (pass.loc.MVPMatrix) gl.uniformMatrix4fv(pass.loc.MVPMatrix, false, IDENTITY);
        if (pass.loc.OutputSize) gl.uniform2f(pass.loc.OutputSize, ow, oh);
        if (pass.loc.TextureSize) gl.uniform2f(pass.loc.TextureSize, inW, inH);
        if (pass.loc.InputSize) gl.uniform2f(pass.loc.InputSize, inW, inH);
        if (pass.loc.FrameCount) gl.uniform1i(pass.loc.FrameCount, frameCount | 0);
        if (pass.loc.FrameDirection) gl.uniform1i(pass.loc.FrameDirection, 1);
        if (pass.loc.OriginalSize) gl.uniform2f(pass.loc.OriginalSize, origW, origH);

        // texture unit 0 = input, unit 1 = original source image
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, inTex);
        if (pass.loc.Texture) gl.uniform1i(pass.loc.Texture, 0);
        if (pass.loc.Original) {
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, origTex);
          gl.uniform1i(pass.loc.Original, 1);
          gl.activeTexture(gl.TEXTURE0);
        }

        pass.params.forEach((p) => {
          const loc = pass.paramLoc[p.name];
          if (loc) gl.uniform1f(loc, this.values[p.name] != null ? this.values[p.name] : p.def);
        });

        this.bindQuad(pass);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        if (!isLast) { inTex = pass.tex; inW = ow; inH = oh; }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return true;
    }

    dispose(keepSrc) {
      const gl = this.gl;
      this.passes.forEach((p) => {
        if (p.program) gl.deleteProgram(p.program);
        if (p.tex) gl.deleteTexture(p.tex);
        if (p.fbo) gl.deleteFramebuffer(p.fbo);
      });
      this.passes = [];
      if (!keepSrc && this.srcTex) { gl.deleteTexture(this.srcTex); this.srcTex = null; }
    }
  }

  /* Parse a .glslp into { count, refs:[relpath], filters, scales, ... }.
     Caller resolves the shaderN paths to source text, then builds pass defs. */
  function parseGlslp(text) {
    const cfg = {};
    text.split('\n').forEach((raw) => {
      const line = raw.replace(/#.*$/, '').trim();    // strip comments
      const m = line.match(/^(\w+)\s*=\s*"?([^"]*?)"?\s*$/);
      if (m) cfg[m[1]] = m[2];
    });
    const count = parseInt(cfg.shaders || '0', 10) || 0;
    const num = (k, d) => (cfg[k] != null && cfg[k] !== '' ? parseFloat(cfg[k]) : d);
    const bool = (k) => /^(true|1)$/i.test(cfg[k] || '');
    const passes = [];
    for (let i = 0; i < count; i++) {
      passes.push({
        ref: cfg['shader' + i],
        filterLinear: /^(true|1)$/i.test(cfg['filter_linear' + i] || 'false'),
        scaleType: cfg['scale_type' + i] || cfg['scale_type_x' + i] || null,
        scaleTypeX: cfg['scale_type_x' + i] || null,
        scaleTypeY: cfg['scale_type_y' + i] || null,
        scale: num('scale' + i, undefined),
        scaleX: num('scale_x' + i, undefined),
        scaleY: num('scale_y' + i, undefined),
        wrapMode: cfg['wrap_mode' + i] || 'clamp_to_edge',
        floatFb: bool('float_framebuffer' + i),
      });
    }
    // param overrides given directly in the preset (name = value)
    const overrides = {};
    Object.keys(cfg).forEach((k) => {
      if (/^(shaders|shader\d|filter_|scale|wrap_|float_|alias|frame_count|srgb|mipmap|feedback|textures)/.test(k)) return;
      const v = parseFloat(cfg[k]);
      if (!isNaN(v) && /^[\-0-9.]+$/.test(cfg[k])) overrides[k] = v;
    });
    return { count, passes, overrides };
  }

  window.Glslp = { Chain, parseGlslp, parseParams };
})();
