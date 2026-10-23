/**
 * The compositor's GPU half, one WebGL2 program shared by the preview and the export: up to two
 * sources (a crossfade) placed in the frame by the shared framing maths (Fill or Fit, zoom, pan,
 * display rotation; shared/video-compose.ts), the background around a Fit picture, then each
 * clip's own grade (shared/video-looks.ts `resolveGrade`): the colour match to a reference (a Lab
 * transfer, shared/colour-match.ts), exposure, temperature and tint, contrast, saturation,
 * vibrance, highlights, shadows, whites and blacks (the preset at its intensity plus the sliders),
 * an optional 3D LUT at a strength, and skin protection; applied to the footage only, each of the
 * two clips of a crossfade with its own grade; last, the overlay layer (text and logos, drawn by
 * the browser's text engine into a 2D canvas, src/video-editor/engine/overlays.ts) blended on top
 * ungraded. What the preview shows is what every exported frame is; the CPU twin of the grade
 * (`gradePixel`) states what a rendered pixel should be.
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
import { addParams, type ClipGrade } from "@shared/video-looks";
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
uniform float lutStrength;
uniform float lutSize;
uniform int hasLut;
uniform int bypass;
uniform float splitX; // < 0: off; else the footage before colour left of this x (0 … 1), preview only
uniform float outW;

// One clip's grade (shared/video-looks.ts resolveGrade; gradePixel there is this, on the CPU).
struct Grade {
  float exposure, contrast, saturation, temperature, tint, highlights, shadows, vibrance, whites, blacks;
  vec3 mScale;
  vec3 mOffset;
  float mAmount;
  int protect;
};
uniform Grade gA;
uniform Grade gB;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// A display UV (top-left) to the coded picture's UV, for a clockwise display rotation.
vec2 coded(vec2 s, int rot) {
  if (rot == 90) return vec2(s.y, 1.0 - s.x);
  if (rot == 180) return vec2(1.0 - s.x, 1.0 - s.y);
  if (rot == 270) return vec2(1.0 - s.y, s.x);
  return s;
}

/* sRGB <-> CIE Lab (D65), as shared/colour-match.ts. */
float toLin(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
float toSrgb(float c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055; }
const float EPS = 216.0 / 24389.0;
const float KAPPA = 24389.0 / 27.0;
const vec3 WHITE = vec3(0.95047, 1.0, 1.08883);
float fLab(float t) { return t > EPS ? pow(t, 1.0 / 3.0) : (KAPPA * t + 16.0) / 116.0; }
float fInv(float t) { return t * t * t > EPS ? t * t * t : (116.0 * t - 16.0) / KAPPA; }
vec3 rgbToLab(vec3 c) {
  vec3 l = vec3(toLin(c.r), toLin(c.g), toLin(c.b));
  vec3 xyz = vec3(dot(l, vec3(0.4124564, 0.3575761, 0.1804375)), dot(l, vec3(0.2126729, 0.7151522, 0.072175)), dot(l, vec3(0.0193339, 0.119192, 0.9503041))) / WHITE;
  vec3 fv = vec3(fLab(xyz.x), fLab(xyz.y), fLab(xyz.z));
  return vec3(116.0 * fv.y - 16.0, 500.0 * (fv.x - fv.y), 200.0 * (fv.y - fv.z));
}
vec3 labToRgb(vec3 lab) {
  float fy = (lab.x + 16.0) / 116.0;
  float fx = fy + lab.y / 500.0;
  float fz = fy - lab.z / 200.0;
  vec3 xyz = vec3(fInv(fx), lab.x > KAPPA * EPS ? fy * fy * fy : lab.x / KAPPA, fInv(fz)) * WHITE;
  vec3 l = vec3(dot(xyz, vec3(3.2404542, -1.5371385, -0.4985314)), dot(xyz, vec3(-0.969266, 1.8760108, 0.041556)), dot(xyz, vec3(0.0556434, -0.2040259, 1.0572252)));
  return clamp(vec3(toSrgb(l.r), toSrgb(l.g), toSrgb(l.b)), 0.0, 1.0);
}

// How much an original colour counts as a skin tone: a hue-range heuristic (shared/video-looks.ts skinWeight).
float skinWeight(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = mx - mn;
  float h = 0.0;
  if (d > 1e-6) {
    if (mx == c.r) h = 60.0 * mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = 60.0 * ((c.b - c.r) / d + 2.0);
    else h = 60.0 * ((c.r - c.g) / d + 4.0);
  }
  float s = mx > 0.0 ? d / mx : 0.0;
  float d0 = abs(h - 20.0);
  float dh = min(d0, 360.0 - d0);
  float hw = 1.0 - smoothstep(15.0, 32.0, dh);
  float sw = smoothstep(0.08, 0.16, s) * (1.0 - smoothstep(0.62, 0.8, s));
  float vw = smoothstep(0.15, 0.3, mx);
  return hw * sw * vw;
}

// On skin tones the grade keeps its brightness, the original's hue, and its chroma within ±15 %.
vec3 protectSkin(vec3 o, vec3 g) {
  float w = skinWeight(o) * 0.9;
  if (w <= 0.0) return g;
  float yo = dot(o, LUMA);
  float yg = dot(g, LUMA);
  vec3 co = o - yo;
  vec3 cg = g - yg;
  float mo = length(co);
  if (mo < 1e-5) return g;
  float k = clamp(length(cg) / mo, 0.85, 1.15);
  return mix(g, clamp(yg + co * k, 0.0, 1.0), w);
}

vec3 sliders(vec3 c, Grade p) {
  c *= exp2(p.exposure);
  c *= vec3(1.0 + 0.15 * p.temperature - 0.05 * p.tint, 1.0 - 0.1 * p.tint, 1.0 - 0.15 * p.temperature - 0.05 * p.tint);
  c = (c - 0.5) * (1.0 + p.contrast) + 0.5;
  float luma = dot(c, LUMA);
  c = mix(vec3(luma), c, 1.0 + p.saturation);
  float sat = clamp(max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)), 0.0, 1.0);
  float l2 = dot(c, LUMA);
  c = mix(vec3(l2), c, 1.0 + p.vibrance * (1.0 - sat));
  float l = clamp(dot(c, LUMA), 0.0, 1.0);
  float sw = 1.0 - smoothstep(0.0, 0.6, l);
  float hw = smoothstep(0.4, 1.0, l);
  float ww = smoothstep(0.65, 1.0, l);
  float bw = 1.0 - smoothstep(0.0, 0.35, l);
  c += p.shadows * 0.25 * sw + p.highlights * 0.25 * hw + p.whites * 0.2 * ww + p.blacks * 0.15 * bw;
  return clamp(c, 0.0, 1.0);
}

// match -> sliders -> LUT -> skin protection (measured against the original colour).
vec3 grade(vec3 src, Grade p, bool before) {
  if (before) return src;
  vec3 c = src;
  if (p.mAmount > 0.0) c = mix(c, labToRgb(rgbToLab(c) * p.mScale + p.mOffset), p.mAmount);
  c = sliders(c, p);
  if (hasLut == 1) {
    // Texel centres: 0 and 1 land on the table's first and last entries.
    vec3 lc = c * ((lutSize - 1.0) / lutSize) + 0.5 / lutSize;
    c = mix(c, texture(lut, lc).rgb, lutStrength);
  }
  if (p.protect == 1) c = protectSkin(src, c);
  return c;
}

// The source at this output pixel, graded; the background where the picture does not reach.
vec3 layer(sampler2D t, vec4 place, int rot, vec2 top, Grade p) {
  vec2 s = (top - place.zw) * place.xy;
  if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0) return bg;
  bool before = bypass == 1 || (splitX >= 0.0 && top.x < splitX);
  return grade(texture(t, coded(s, rot)).rgb, p, before);
}

void main() {
  vec2 top = vec2(uv.x, 1.0 - uv.y);
  vec3 c = hasA == 1 ? layer(texA, placeA, rotA, top, gA) : bg;
  if (hasB == 1) c = mix(c, layer(texB, placeB, rotB, top, gB), mixAB);
  if (hasO == 1) {
    vec4 o = texture(texO, top);
    c = mix(c, o.rgb, o.a);
  }
  // The split view's dividing line (the preview only: a render never sets splitX).
  if (splitX >= 0.0 && abs(top.x - splitX) * outW < 1.0) c = vec3(1.0);
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
  /** Source a's grade (the clip on screen, or the outgoing one in a crossfade). */
  grade: ClipGrade;
  /** Source b's grade (the incoming clip of a crossfade); a's when absent. */
  gradeB?: ClipGrade;
  lutStrength: number;
  /** Show the footage untouched (the before of before/after). */
  bypass?: boolean;
  /** Split view: the footage before colour left of this fraction of the width (preview only). */
  split?: number | null;
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

/** The slider fields of a grade, as the shader's `Grade` struct names them. */
const GRADE_FIELDS: (keyof ColourParams)[] = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows", "vibrance", "whites", "blacks"];

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
  private lutSize = 2;
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
    const names = ["texA", "texB", "texO", "lut", "placeA", "placeB", "rotA", "rotB", "mixAB", "hasA", "hasB", "hasO", "bg", "lutStrength", "lutSize", "hasLut", "bypass", "splitX", "outW"];
    for (const g of ["gA", "gB"]) for (const f of [...GRADE_FIELDS, "mScale", "mOffset", "mAmount", "protect"]) names.push(`${g}.${f}`);
    for (const name of names) this.uniforms.set(name, gl.getUniformLocation(this.program, name));
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
    this.lutSize = n;
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

  private setGrade(prefix: "gA" | "gB", g: ClipGrade): void {
    const gl = this.gl;
    const u = (n: string) => this.uniforms.get(`${prefix}.${n}`) ?? null;
    for (const f of GRADE_FIELDS) gl.uniform1f(u(f), g.params[f] ?? 0);
    const m = g.match;
    const scale = m ? m.scale : [1, 1, 1];
    const offset = m ? m.offset : [0, 0, 0];
    gl.uniform3f(u("mScale"), scale[0], scale[1], scale[2]);
    gl.uniform3f(u("mOffset"), offset[0], offset[1], offset[2]);
    gl.uniform1f(u("mAmount"), m ? Math.min(1, Math.max(0, m.amount)) : 0);
    gl.uniform1i(u("protect"), g.protectSkin ? 1 : 0);
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
    this.setGrade("gA", opts.grade);
    this.setGrade("gB", opts.gradeB ?? opts.grade);
    gl.uniform1i(u("hasLut"), this.lutTex ? 1 : 0);
    gl.uniform1f(u("lutSize"), this.lutSize);
    gl.uniform1f(u("lutStrength"), opts.lutStrength);
    gl.uniform1i(u("bypass"), opts.bypass ? 1 : 0);
    gl.uniform1f(u("splitX"), typeof opts.split === "number" ? Math.min(1, Math.max(0, opts.split)) : -1);
    gl.uniform1f(u("outW"), this.width);
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
  return extra ? addParams(base, extra) : base;
}
