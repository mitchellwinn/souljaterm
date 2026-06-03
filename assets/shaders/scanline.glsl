// souljaterm — simple scanlines (libretro GLSL format)
#pragma parameter SCANLINE_WEIGHT "Scanline darkness" 0.30 0.0 1.0 0.02
#pragma parameter BRIGHTNESS      "Brightness boost"  1.10 0.5 2.0 0.02

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
uniform COMPAT_PRECISION float SCANLINE_WEIGHT;
uniform COMPAT_PRECISION float BRIGHTNESS;
// Boot warp-in progress (1.0 = fully on). Built-in uniform injected by glslp.js; see crt-lite.glsl.
uniform COMPAT_PRECISION float POWER_ON;
void main() {
    vec2 uv = vTex;
    // CRT power-on: collapsed bright scanline -> wide stretch -> bloom open + flicker -> settle.
    float poBright = 1.0, poSat = 1.0;
    float po = clamp(POWER_ON, 0.0, 1.0);
    if (po <= 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; } // tube off: black until she fires on
    if (po < 1.0) {
        float h, sx;
        if (po < 0.10)      { h = 0.012;               sx = 1.30;               poBright = 7.0;             poSat = 0.0; }
        else if (po < 0.35) { float t = (po-0.10)/0.25; h = mix(0.012,0.05,t);  sx = mix(1.30,1.05,t);     poBright = mix(7.0,4.0,t);  poSat = mix(0.0,0.4,t); }
        else if (po < 0.60) { float t = (po-0.35)/0.25; h = mix(0.05,1.0,t);    sx = mix(1.05,1.0,t);      poBright = mix(4.0,2.0,t);  poSat = mix(0.4,1.6,t); }
        else if (po < 0.82) { float t = (po-0.60)/0.22; h = 1.0;                sx = 1.0;                  poBright = mix(0.5,1.6,t);  poSat = mix(1.2,1.0,t); }
        else                { float t = (po-0.82)/0.18; h = 1.0;                sx = 1.0;                  poBright = mix(1.6,1.0,t);  poSat = 1.0; }
        vec2 c = uv - 0.5;
        c.y /= max(h, 1e-4);
        c.x /= max(sx, 1e-4);
        uv = c + 0.5;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    }
    vec3 col = COMPAT_TEXTURE(Texture, uv).rgb * BRIGHTNESS * poBright;
    if (poSat != 1.0) col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, poSat);
    // one dark band per source texel row
    float line = sin(uv.y * TextureSize.y * 3.14159265);
    float scan = 1.0 - SCANLINE_WEIGHT * (1.0 - abs(line));
    gl_FragColor = vec4(col * scan, 1.0);
}
#endif
