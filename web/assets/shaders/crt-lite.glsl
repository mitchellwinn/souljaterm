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

    vec3 col = COMPAT_TEXTURE(Texture, uv).rgb;
    // cheap phosphor glow: blend a few neighbour taps
    vec2 px = 1.0 / TextureSize;
    vec3 glow = COMPAT_TEXTURE(Texture, uv + vec2(px.x, 0.0)).rgb
              + COMPAT_TEXTURE(Texture, uv - vec2(px.x, 0.0)).rgb
              + COMPAT_TEXTURE(Texture, uv + vec2(0.0, px.y)).rgb
              + COMPAT_TEXTURE(Texture, uv - vec2(0.0, px.y)).rgb;
    col += glow * 0.25 * GLOW;
    col *= BRIGHT * poBright;                                          // power-on flash on top of base brightness
    if (poSat != 1.0) col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, poSat); // bleach during turn-on

    // scanlines locked to source rows
    float beam = sin(uv.y * TextureSize.y * 3.14159265);
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

    gl_FragColor = vec4(col, 1.0);
}
#endif
