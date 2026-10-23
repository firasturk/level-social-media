/**
 * The compositor's GPU half, one WebGL2 program shared by the preview and the export: up to two
 * sources (a crossfade) placed in the frame by the shared framing maths (Fill or Fit, zoom, pan,
 * display rotation; shared/video-compose.ts), the background around a Fit picture, then exposure,
 * temperature and tint, contrast, saturation, highlights and shadows, then an optional 3D LUT at
 * a strength, applied to the footage only; last, the overlay layer (text and logos, drawn by the
 * browser's text engine into a 2D canvas, src/video-editor/engine/overlays.ts) blended on top
 * ungraded. What the preview shows is what every exported frame is.
 *
 * For the export a second pass turns the finished RGB frame into I420 (BT.709, limited range) on
 * the GPU and reads it back, so the encoder gets YUV it does not convert again: the output's
 * colour is the same on every browser and platform, and the file is tagged with it.
 *
 * Cost: one full-screen pass per frame (two for the export); at 1080×1920 well under a millisecond
 * each on an integrated GPU, plus a 3 MB read-back per exported frame.
 */
import type { CubeLut } from "@shared/cube-lut";
import type { ColourParams } from "@shared/video-project";
import { placementUniform, placeSource, type Framing, type Rotation } from "@shared/video-compose";

const VERT = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 uv;
out vec4 color;
uniform sampler2D texA;
uniform sampler2D texB;
uniform sampler2D texO;
uniform sampler3D lut;
uniform vec4 placeA; // scale.xy, offset.xy: output UV (top-left) to the source's display UV
uniform vec4 placeB;
uniform int rotA;
uniform int rotB;
uniform float mixAB;
uniform int hasA;
uniform int hasB;
uniform int hasO;
uniform vec3 bg;
uniform float exposure, contrast, saturation, temperature, tint, highlights, shadows, lutStrength;
uniform int hasLut;
uniform int bypass;

// A display UV (top-left) to the coded picture's UV, for a clockwise display rotation.
vec2 coded(vec2 s, int rot) {
  if (rot == 90) return vec2(s.y, 1.0 - s.x);
  if (rot == 180) return vec2(1.0 - s.x, 1.0 - s.y);
  if (rot == 270) return vec2(1.0 - s.y, s.x);
  return s;
}

vec3 grade(vec3 c) {
  if (bypass == 1) return c;
  c *= exp2(exposure);
  c *= vec3(1.0 + 0.15 * temperature - 0.05 * tint, 1.0 - 0.1 * tint, 1.0 - 0.15 * temperature - 0.05 * tint);
  c = (c - 0.5) * (1.0 + contrast) + 0.5;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, 1.0 + saturation);
  float l = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  float sw = 1.0 - smoothstep(0.0, 0.6, l);
  float hw = smoothstep(0.4, 1.0, l);
  c += shadows * 0.25 * sw;
  c += highlights * 0.25 * hw;
  c = clamp(c, 0.0, 1.0);
  if (hasLut == 1) c = mix(c, texture(lut, c).rgb, lutStrength);
  return c;
}

// The source at this output pixel, graded; the background where the picture does not reach.
vec3 layer(sampler2D t, vec4 place, int rot, vec2 top) {
  vec2 s = (top - place.zw) * place.xy;
  if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0) return bg;
  return grade(texture(t, coded(s, rot)).rgb);
}

void main() {
  vec2 top = vec2(uv.x, 1.0 - uv.y);
  vec3 c = hasA == 1 ? layer(texA, placeA, rotA, top) : bg;
  if (hasB == 1) c = mix(c, layer(texB, placeB, rotB, top), mixAB);
  if (hasO == 1) {
    vec4 o = texture(texO, top);
    c = mix(c, o.rgb, o.a);
  }
  color = vec4(c, 1.0);
}`;

/**
 * RGB to I420, BT.709 limited range, written as bytes four at a time into a target W/4 × 1.5H:
 * rows 0 … H-1 are the Y plane, then U, then V, exactly the I420 layout once read back.
 */
const YUV = `#version 300 es
precision highp float;
precision highp int;
out vec4 color;
uniform sampler2D rgb;
uniform int W;
uniform int H;

vec3 at(vec2 topLeft) {
  return texture(rgb, vec2(topLeft.x, 1.0 - topLeft.y)).rgb;
}

float byteAt(int idx) {
  int ySize = W * H;
  if (idx < ySize) {
    int row = idx / W;
    int col = idx - row * W;
    vec3 c = at(vec2((float(col) + 0.5) / float(W), (float(row) + 0.5) / float(H)));
    float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
    return (16.0 + 219.0 * y) / 255.0;
  }
  int cw = W / 2;
  int ch = H / 2;
  int i = idx - ySize;
  bool isV = i >= cw * ch;
  if (isV) i -= cw * ch;
  int row = i / cw;
  int col = i - row * cw;
  // The middle of the 2×2 block: linear filtering averages its four pixels.
  vec3 c = at(vec2(float(2 * col + 1) / float(W), float(2 * row + 1) / float(H)));
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float v = isV ? (c.r - y) / 1.5748 : (c.b - y) / 1.8556;
  return (128.0 + 224.0 * v) / 255.0;
}

void main() {
  int x = int(gl_FragCoord.x);
  int y = int(gl_FragCoord.y);
  int base = y * W + x * 4;
  color = vec4(byteAt(base), byteAt(base + 1), byteAt(base + 2), byteAt(base + 3));
}`;

export interface GradeSource {
  image: TexImageSource;
  /** The size the source shows at (after its rotation). */
  width: number;
  height: number;
  /** Clockwise rotation from the coded picture to the display (0 for a <video>, which turns it itself). */
  rotation?: Rotation;
  framing: Framing;
}

export interface GradeOptions {
  params: ColourParams;
  lutStrength: number;
  /** Show the footage untouched (the before of before/after). */
  bypass?: boolean;
  /** The colour around a Fit picture, "#rrggbb". */
  background?: string;
  /** The text and logo layer (a canvas the size of the output, transparent where empty). */
  overlay?: TexImageSource | null;
}

function link(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(s) ?? "failed"}`);
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vert));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag));
  gl.bindAttribLocation(p, 0, "pos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Shader link: ${gl.getProgramInfoLog(p) ?? "failed"}`);
  return p;
}

const hex = (s: string | undefined): [number, number, number] => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s ?? "");
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0, 0, 0];
};

export class Grader {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private yuvProgram: WebGLProgram | null = null;
  private texA: WebGLTexture;
  private texB: WebGLTexture;
  private texO: WebGLTexture;
  private lutTex: WebGLTexture | null = null;
  private rgbTex: WebGLTexture | null = null;
  private yuvTex: WebGLTexture | null = null;
  private yuvFbo: WebGLFramebuffer | null = null;
  private yuvSize = "";
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  width: number;
  height: number;

  constructor(width: number, height: number) {
    this.canvas = document.createElement("canvas");
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    const gl = this.canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error("WebGL2 is not available in this browser; the colour tools need it.");
    this.gl = gl;
    this.program = link(gl, VERT, FRAG);
    gl.useProgram(this.program);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.texA = this.texture();
    this.texB = this.texture();
    this.texO = this.texture();
    for (const name of ["texA", "texB", "texO", "lut", "placeA", "placeB", "rotA", "rotB", "mixAB", "hasA", "hasB", "hasO", "bg", "exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows", "lutStrength", "hasLut", "bypass"]) this.uniforms.set(name, gl.getUniformLocation(this.program, name));
    gl.uniform1i(this.uniforms.get("texA")!, 0);
    gl.uniform1i(this.uniforms.get("texB")!, 1);
    gl.uniform1i(this.uniforms.get("lut")!, 2);
    gl.uniform1i(this.uniforms.get("texO")!, 3);
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  /** The LUT as a 3D texture (null removes it). */
  setLut(lut: CubeLut | null): void {
    const gl = this.gl;
    if (this.lutTex) {
      gl.deleteTexture(this.lutTex);
      this.lutTex = null;
    }
    if (!lut) return;
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    // 8-bit RGB is plenty for a display LUT and is supported everywhere WebGL2 is.
    const n = lut.size;
    const bytes = new Uint8Array(n * n * n * 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(lut.data[i] * 255);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, n, n, n, 0, gl.RGB, gl.UNSIGNED_BYTE, bytes);
    this.lutTex = t;
  }

  private upload(unit: number, tex: WebGLTexture, src: GradeSource, place: string, rot: string): void {
    const gl = this.gl;
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src.image);
    const rect = placeSource({ width: src.width, height: src.height }, { width: this.width, height: this.height }, src.framing);
    gl.uniform4f(this.uniforms.get(place)!, ...placementUniform(rect, { width: this.width, height: this.height }));
    gl.uniform1i(this.uniforms.get(rot)!, src.rotation ?? 0);
  }

  /** Draws the frame: source a (or the background alone), blended with b at `mix`, graded, the overlay on top. */
  draw(a: GradeSource | null, b: { source: GradeSource; mix: number } | null, opts: GradeOptions): void {
    const gl = this.gl;
    const u = (n: string) => this.uniforms.get(n)!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.program);
    if (a) this.upload(gl.TEXTURE0, this.texA, a, "placeA", "rotA");
    if (b) this.upload(gl.TEXTURE1, this.texB, b.source, "placeB", "rotB");
    gl.uniform1i(u("hasA"), a ? 1 : 0);
    gl.uniform1i(u("hasB"), b ? 1 : 0);
    gl.uniform1f(u("mixAB"), b?.mix ?? 0);
    gl.uniform3f(u("bg"), ...hex(opts.background));
    if (opts.overlay) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.texO);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, opts.overlay);
    }
    gl.uniform1i(u("hasO"), opts.overlay ? 1 : 0);
    const p = opts.params;
    gl.uniform1f(u("exposure"), p.exposure);
    gl.uniform1f(u("contrast"), p.contrast);
    gl.uniform1f(u("saturation"), p.saturation);
    gl.uniform1f(u("temperature"), p.temperature);
    gl.uniform1f(u("tint"), p.tint);
    gl.uniform1f(u("highlights"), p.highlights);
    gl.uniform1f(u("shadows"), p.shadows);
    gl.uniform1i(u("hasLut"), this.lutTex ? 1 : 0);
    gl.uniform1f(u("lutStrength"), opts.lutStrength);
    gl.uniform1i(u("bypass"), opts.bypass ? 1 : 0);
    if (this.lutTex) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** A dark frame when nothing is on the timeline at this time. */
  clear(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0.07, 0.07, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** True when the YUV pass can run at this size (the width a multiple of 4, the height even). */
  get canReadI420(): boolean {
    return this.width % 4 === 0 && this.height % 2 === 0;
  }

  /**
   * The frame just drawn as I420 bytes (BT.709, limited range): Y (W×H), then U and V (W/2×H/2
   * each), converted on the GPU and read back in one call.
   */
  readI420(): Uint8Array {
    const gl = this.gl;
    const w = this.width;
    const h = this.height;
    if (!this.canReadI420) throw new Error(`The I420 pass needs a width that is a multiple of 4 (${w}×${h}).`);
    this.yuvProgram ??= link(gl, VERT, YUV);
    const size = `${w}x${h}`;
    gl.activeTexture(gl.TEXTURE4);
    if (this.yuvSize !== size) {
      if (this.rgbTex) gl.deleteTexture(this.rgbTex);
      if (this.yuvTex) gl.deleteTexture(this.yuvTex);
      if (this.yuvFbo) gl.deleteFramebuffer(this.yuvFbo);
      this.rgbTex = this.texture();
      this.yuvTex = this.texture();
      gl.bindTexture(gl.TEXTURE_2D, this.yuvTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w / 4, (h * 3) / 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.yuvFbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.yuvFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.yuvTex, 0);
      this.yuvSize = size;
    }
    // The finished RGB frame (the canvas) copied into a texture, then packed.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.rgbTex);
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 0, 0, w, h, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.yuvFbo);
    gl.viewport(0, 0, w / 4, (h * 3) / 2);
    gl.useProgram(this.yuvProgram);
    gl.uniform1i(gl.getUniformLocation(this.yuvProgram, "rgb"), 4);
    gl.uniform1i(gl.getUniformLocation(this.yuvProgram, "W"), w);
    gl.uniform1i(gl.getUniformLocation(this.yuvProgram, "H"), h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const out = new Uint8Array((w * h * 3) / 2);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, w / 4, (h * 3) / 2, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.program);
    return out;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.texA);
    gl.deleteTexture(this.texB);
    gl.deleteTexture(this.texO);
    if (this.lutTex) gl.deleteTexture(this.lutTex);
    if (this.rgbTex) gl.deleteTexture(this.rgbTex);
    if (this.yuvTex) gl.deleteTexture(this.yuvTex);
    if (this.yuvFbo) gl.deleteFramebuffer(this.yuvFbo);
    gl.deleteProgram(this.program);
    if (this.yuvProgram) gl.deleteProgram(this.yuvProgram);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** The two colour sets combined: the project's (with its look as the base) plus a clip's own. */
export function combineColour(base: ColourParams, extra: ColourParams | undefined): ColourParams {
  if (!extra) return base;
  const out = { ...base };
  for (const k of Object.keys(out) as (keyof ColourParams)[]) out[k] = Math.max(-2, Math.min(2, base[k] + extra[k]));
  return out;
}
