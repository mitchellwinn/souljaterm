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
void main() {
    vec3 col = COMPAT_TEXTURE(Texture, vTex).rgb * BRIGHTNESS;
    // one dark band per source texel row
    float line = sin(vTex.y * TextureSize.y * 3.14159265);
    float scan = 1.0 - SCANLINE_WEIGHT * (1.0 - abs(line));
    gl_FragColor = vec4(col * scan, 1.0);
}
#endif
