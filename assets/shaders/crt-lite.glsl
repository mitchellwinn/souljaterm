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

// barrel-distort uv around center
vec2 warp(vec2 uv) {
    uv = uv * 2.0 - 1.0;
    vec2 off = abs(uv.yx) / vec2(6.0, 5.0);
    uv = uv + uv * off * off * (CURVATURE * 4.0);
    return uv * 0.5 + 0.5;
}

void main() {
    vec2 uv = warp(vTex);

    // off-screen border from the warp -> black
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
    col *= BRIGHT;

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
