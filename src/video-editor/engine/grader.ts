/**
 * The colour pipeline, one WebGL2 fragment shader: up to two sources mixed (a crossfade), then
 * exposure, temperature and tint, contrast, saturation, highlights and shadows, then an optional
 * 3D LUT (a .cube table in a 3D texture) at a strength. The same shader draws the preview and
 * every exported frame, so what the person sees is what the file gets. Each source is drawn to
 * cover the output frame (cropped, centred), which is what a reel wants.
 *
 * Cost: one full-screen pass per frame on the GPU; at 1080×1920 that is well under a millisecond
 * on an integrated GPU, so colour never limits the export. A per-pixel JavaScript loop would cost
 * 20–40 ms per 1080p frame; that is why this is a shader.
 */
import type { CubeLut } from "@shared/cube-lut";
import type { ColourParams } from "@shared/video-project";

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
uniform sampler3D lut;
uniform vec4 fitA; // scale.xy, offset.xy for a cover fit
uniform vec4 fitB;
uniform float mixAB;
uniform int hasB;
uniform float exposure, contrast, saturation, temperature, tint, highlights, shadows, lutStrength;
uniform int hasLut;
uniform int bypass;

vec3 sampleCover(sampler2D t, vec4 fit) {
  vec2 p = (uv - 0.5) * fit.xy + 0.5 + fit.zw;
  // Flip Y: the sources are top-down pictures.
  return texture(t, vec2(p.x, 1.0 - p.y)).rgb;
}

void main() {
  vec3 c = sampleCover(texA, fitA);
  if (hasB == 1) c = mix(c, sampleCover(texB, fitB), mixAB);
  if (bypass == 1) { color = vec4(c, 1.0); return; }
  // Exposure in stops.
  c *= exp2(exposure);
  // Temperature (warm +, cool -) and tint (magenta +, green -) as channel gains.
  c *= vec3(1.0 + 0.15 * temperature - 0.05 * tint, 1.0 - 0.1 * tint, 1.0 - 0.15 * temperature - 0.05 * tint);
  // Contrast around middle grey.
  c = (c - 0.5) * (1.0 + contrast) + 0.5;
  // Saturation against luma.
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, 1.0 + saturation);
  // Shadows lift or crush the dark end, highlights the bright end, each weighted by luma.
  float l = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  float sw = 1.0 - smoothstep(0.0, 0.6, l);
  float hw = smoothstep(0.4, 1.0, l);
  c += shadows * 0.25 * sw;
  c += highlights * 0.25 * hw;
  c = clamp(c, 0.0, 1.0);
  if (hasLut == 1) {
    vec3 g = texture(lut, c).rgb;
    c = mix(c, g, lutStrength);
  }
  color = vec4(c, 1.0);
}`;

export interface GradeSource {
  image: TexImageSource;
  width: number;
  height: number;
}

export interface GradeOptions {
  params: ColourParams;
  lutStrength: number;
  /** Show the footage untouched (the before of before/after). */
  bypass?: boolean;
}

export class Grader {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private texA: WebGLTexture;
  private texB: WebGLTexture;
  private lutTex: WebGLTexture | null = null;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  width: number;
  height: number;

  constructor(width: number, height: number) {
    this.canvas = document.createElement("canvas");
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    const gl = this.canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is not available in this browser; the colour tools need it.");
    this.gl = gl;
    this.program = this.link();
    gl.useProgram(this.program);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(this.program, "pos");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    this.texA = this.texture();
    this.texB = this.texture();
    for (const name of ["texA", "texB", "lut", "fitA", "fitB", "mixAB", "hasB", "exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows", "lutStrength", "hasLut", "bypass"]) this.uniforms.set(name, gl.getUniformLocation(this.program, name));
    gl.uniform1i(this.uniforms.get("texA")!, 0);
    gl.uniform1i(this.uniforms.get("texB")!, 1);
    gl.uniform1i(this.uniforms.get("lut")!, 2);
  }

  private link(): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(s) ?? "failed"}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Shader link: ${gl.getProgramInfoLog(p) ?? "failed"}`);
    return p;
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

  private upload(unit: number, tex: WebGLTexture, src: GradeSource, fit: string): void {
    const gl = this.gl;
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src.image);
    // Cover: scale the UV so the source fills the output, cropping the longer side.
    const sa = src.width / Math.max(1, src.height);
    const oa = this.width / Math.max(1, this.height);
    const sx = sa > oa ? oa / sa : 1;
    const sy = sa > oa ? 1 : sa / oa;
    gl.uniform4f(this.uniforms.get(fit)!, sx, sy, 0, 0);
  }

  /** Draws the frame: source a, blended with b at `mix` when given, graded by `opts`. */
  draw(a: GradeSource, b: { source: GradeSource; mix: number } | null, opts: GradeOptions): void {
    const gl = this.gl;
    const u = (n: string) => this.uniforms.get(n)!;
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.program);
    this.upload(gl.TEXTURE0, this.texA, a, "fitA");
    if (b) this.upload(gl.TEXTURE1, this.texB, b.source, "fitB");
    gl.uniform1i(u("hasB"), b ? 1 : 0);
    gl.uniform1f(u("mixAB"), b?.mix ?? 0);
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
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0.07, 0.07, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.texA);
    gl.deleteTexture(this.texB);
    if (this.lutTex) gl.deleteTexture(this.lutTex);
    gl.deleteProgram(this.program);
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
