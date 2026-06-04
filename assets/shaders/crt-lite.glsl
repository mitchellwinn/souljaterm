// souljaterm — curved CRT: barrel warp, beam scanlines, aperture mask, vignette.
// Single pass, libretro GLSL format. Tuned for crisp terminal text, not games.
#pragma parameter CURVATURE   "Screen curvature"   0.10 0.0 0.40 0.01
#pragma parameter SCAN_WEIGHT "Scanline depth"     0.35 0.0 1.0  0.02
#pragma parameter MASK_WEIGHT "Aperture mask"      0.30 0.0 1.0  0.02
#pragma parameter GLOW        "Phosphor glow"      0.12 0.0 0.6  0.02
#pragma parameter VIGNETTE    "Vignette"           0.25 0.0 1.0  0.02
#pragma parameter BRIGHT      "Brightness"         1.25 0.5 2.0  0.02

#if defined(VERTEX)
COMPAT_ATTRIBUTE vec4 VertexCoord;
COMPAT_ATTRIBUTE vec4 TexCoord;
COMPAT_VARYING vec2 vTex;
uniform mat4 MVPMatrix;
void main() {
    gl_Position = MVPMatrix * VertexCoord;
    vTex = TexCoord.xy;
}
#elif defined(FRAGMENT)
COMPAT_VARYING vec2 vTex;
uniform sampler2D Texture;
uniform COMPAT_PRECISION vec2 TextureSize;
uniform COMPAT_PRECISION vec2 OutputSize;
uniform COMPAT_PRECISION float CURVATURE;
uniform COMPAT_PRECISION float SCAN_WEIGHT;
uniform COMPAT_PRECISION float MASK_WEIGHT;
uniform COMPAT_PRECISION float GLOW;
uniform COMPAT_PRECISION float VIGNETTE;
uniform COMPAT_PRECISION float BRIGHT;
// Boot warp-in progress, fed by Fx during Roll's "power-on" (1.0 = fully on / no effect). Not a
// #pragma param — glslp.js injects it as a built-in uniform so it stays out of the CRT slider UI.
uniform COMPAT_PRECISION float POWER_ON;
// Transient glitch pulse (0 = none), injected by glslp.js and driven by Fx when Roll's face changes
// suddenly — the tube tears/desyncs briefly like aging hardware. FrameCount drives the always-on life.
uniform COMPAT_PRECISION float GLITCH;
uniform int FrameCount;

float hash11(float n) { return fract(sin(n) * 43758.5453123); }
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

// barrel-distort uv around center
vec2 warp(vec2 uv) {
    uv = uv * 2.0 - 1.0;
    vec2 off = abs(uv.yx) / vec2(6.0, 5.0);
    uv = uv + uv * off * off * (CURVATURE * 4.0);
    return uv * 0.5 + 0.5;
}

void main() {
    vec2 uv = warp(vTex);

    // CRT power-on: tube fires as a bright collapsed scanline, stretches wide, then blooms open
    // vertically with a flicker before settling. Mirrors the old CSS @keyframes crtOn, but in the
    // shader so it's actually visible THROUGH the overlay (the CSS animated the hidden DOM <img>).
    float poBright = 1.0, poSat = 1.0;
    float po = clamp(POWER_ON, 0.0, 1.0);
    if (po <= 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; } // tube off: black until she fires on
    if (po < 1.0) {
        float h, sx;                                                   // vertical height, horizontal stretch
        if (po < 0.10)      { h = 0.012;               sx = 1.30;               poBright = 7.0;             poSat = 0.0; }
        else if (po < 0.35) { float t = (po-0.10)/0.25; h = mix(0.012,0.05,t);  sx = mix(1.30,1.05,t);     poBright = mix(7.0,4.0,t);  poSat = mix(0.0,0.4,t); }
        else if (po < 0.60) { float t = (po-0.35)/0.25; h = mix(0.05,1.0,t);    sx = mix(1.05,1.0,t);      poBright = mix(4.0,2.0,t);  poSat = mix(0.4,1.6,t); }
        else if (po < 0.82) { float t = (po-0.60)/0.22; h = 1.0;                sx = 1.0;                  poBright = mix(0.5,1.6,t);  poSat = mix(1.2,1.0,t); } // flicker
        else                { float t = (po-0.82)/0.18; h = 1.0;                sx = 1.0;                  poBright = mix(1.6,1.0,t);  poSat = 1.0; }
        vec2 c = uv - 0.5;
        c.y /= max(h, 1e-4);       // collapse/expand around center -> off-band falls outside [0,1] = black
        c.x /= max(sx, 1e-4);      // sx>1 magnifies horizontally = the over-wide stretch, edges clipped
        uv = c + 0.5;
    }

    // off-screen border from the warp (or the power-on collapse) -> black
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    // --- time-based life + glitch (the power-on takeover above owns the screen while it runs) ---
    float fc = float(FrameCount);
    float time = fc * 0.01667;                          // ~seconds at 60fps
    float g = clamp(GLITCH, 0.0, 1.0);
    float chroma = 0.0;
    if (po >= 1.0 && g > 0.001) {
        // shove random scanlines sideways — more rows, further, the bigger the hit
        float row = floor(uv.y * TextureSize.y);
        float n = hash21(vec2(row, floor(time * 36.0)));
        float tear = step(1.0 - g * 0.7, n) * (hash11(row + time) * 2.0 - 1.0) * g * 0.07;
        uv.x = clamp(uv.x + tear, 0.0, 1.0);
        chroma = g * 0.006 * (0.5 + n);                 // RGB split that widens with the glitch
    }

    // sample with a chroma offset (chroma == 0 → identical taps → no split when calm)
    vec3 col;
    col.r = COMPAT_TEXTURE(Texture, uv + vec2(chroma, 0.0)).r;
    col.g = COMPAT_TEXTURE(Texture, uv).g;
    col.b = COMPAT_TEXTURE(Texture, uv - vec2(chroma, 0.0)).b;
    // cheap phosphor glow: blend a few neighbour taps
    vec2 px = 1.0 / TextureSize;
    vec3 glow = COMPAT_TEXTURE(Texture, uv + vec2(px.x, 0.0)).rgb
              + COMPAT_TEXTURE(Texture, uv - vec2(px.x, 0.0)).rgb
              + COMPAT_TEXTURE(Texture, uv + vec2(0.0, px.y)).rgb
              + COMPAT_TEXTURE(Texture, uv - vec2(0.0, px.y)).rgb;
    col += glow * 0.25 * GLOW;
    col *= BRIGHT * poBright;                                          // power-on flash on top of base brightness
    if (poSat != 1.0) col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, poSat); // bleach during turn-on

    // scanlines locked to source rows, with a slow vertical drift so the beam reads as alive
    float beam = sin((uv.y * TextureSize.y - time * 0.6) * 3.14159265);
    float scan = 1.0 - SCAN_WEIGHT * (1.0 - abs(beam));
    col *= scan;

    // aperture mask: vertical RGB stripes per output column triad
    float m = mod(gl_FragCoord.x, 3.0);
    vec3 mask = vec3(1.0 - MASK_WEIGHT);
    if (m < 1.0)      mask.r = 1.0;
    else if (m < 2.0) mask.g = 1.0;
    else              mask.b = 1.0;
    col *= mask;

    // vignette
    vec2 v = vTex * (1.0 - vTex.yx);
    float vig = pow(v.x * v.y * 15.0, VIGNETTE);
    col *= clamp(vig, 0.0, 1.0);

    // --- subtle life so the tube is never frozen ---
    float grain = hash21(gl_FragCoord.xy + vec2(time * 13.0, time * 7.0));
    col *= 1.0 + (grain - 0.5) * 0.05;                  // +/-2.5% animated phosphor noise
    col *= 0.985 + 0.015 * sin(time * 6.2831);           // gentle mains flicker
    float roll = sin((uv.y - time * 0.12) * 6.2831);     // slow rolling brightness band
    col *= 1.0 + max(0.0, roll) * 0.03;
    if (po >= 1.0 && g > 0.001) {                         // sparse white static streaks during a glitch
        float s = hash21(vec2(floor(uv.y * TextureSize.y), floor(time * 26.0)));
        col += vec3(0.6) * g * step(1.0 - g * 0.15, s);
    }

    gl_FragColor = vec4(col, 1.0);
}
#endif
