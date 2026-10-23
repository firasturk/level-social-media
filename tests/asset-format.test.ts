import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { NOTES, formatLabelOf, inspectAssetFile, sanitizeCss, sanitizeSvg, sniffFormat, SvgRefused } from "../server/asset-format";
import { cleanColorMap, extractSvgColors, normalizeColor, recolorSvg } from "../shared/svg-colors";

/**
 * What a downloaded stock file really is, read from its bytes: an SVG (alone or in a vector's ZIP)
 * is sanitised and becomes an editable vector with its colours; a PNG/JPG is a picture; EPS, AI
 * and PSD are never pretended to be editable. The colour scanner lists and rewrites the same
 * paint values on both sides (server swatches, browser recolour).
 */

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0]);
const EPS = enc("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n%%EOF\n");
const AI = enc("%PDF-1.5\n%âãÏÓ\n1 0 obj << /Creator (Adobe Illustrator 27.0) >>\n");
const PSD = enc("8BPS\u0000\u0001");
const ICON = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
  <!ENTITY ns_svg "http://www.w3.org/2000/svg">
  <!ENTITY ns_ai "http://ns.adobe.com/AdobeIllustrator/10.0/">
]>
<svg xmlns="&ns_svg;" xmlns:i="&ns_ai;" viewBox="0 0 100 100" width="100%" height="100%" onload="alert(1)">
  <style>.st0{fill:#C6F432;} @import url(https://evil.test/x.css); .st1{background:url(https://evil.test/a.png)}</style>
  <script>alert(document.cookie)</script>
  <i:pgf id="adobe_illustrator_pgf">AAAA hidden editor data</i:pgf>
  <defs><linearGradient id="g"><stop offset="0" stop-color="#FF0000"/><stop offset="1" style="stop-color:rgb(0,0,255)"/></linearGradient></defs>
  <path class="st0" d="M0 0L10 10" onclick="steal()"/>
  <path d="M5 5L20 20" fill="#111" stroke="black"/>
  <rect width="10" height="10" fill="url(#g)"/>
  <circle r="4" fill="url(https://evil.test/p.svg#x)"/>
  <foreignObject width="10" height="10"><body xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://evil.test"></iframe></body></foreignObject>
  <a xlink:href="javascript:alert(1)"><polygon points="0,0 5,5 0,5"/></a>
  <use href="#g"/><use xlink:href="https://evil.test/sprite.svg#icon"/>
  <image href="https://evil.test/track.png" width="1" height="1"/>
  <image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>
  <image href="data:text/html;base64,PHNjcmlwdD4=" width="1" height="1"/>
  <animate attributeName="href" to="javascript:alert(1)"/>
  <set attributeName="onload" to="alert(1)"/>
  <text x="1" y="9">A &amp; B &lt;ok&gt;</text>
</svg>`;

describe("format sniffing from the bytes", () => {
  it("reads the real format, whatever the name says", () => {
    expect(sniffFormat(PNG)).toBe("png");
    expect(sniffFormat(JPG)).toBe("jpg");
    expect(sniffFormat(zipSync({ "a.txt": enc("x") }))).toBe("zip");
    expect(sniffFormat(PSD)).toBe("psd");
    expect(sniffFormat(EPS)).toBe("eps");
    expect(sniffFormat(AI, "badge.ai")).toBe("ai");
    expect(sniffFormat(enc("%PDF-1.4 plain"), "doc.pdf")).toBe("pdf");
    expect(sniffFormat(enc(ICON))).toBe("svg");
    expect(sniffFormat(enc("﻿<svg viewBox='0 0 1 1'/>"))).toBe("svg");
    expect(sniffFormat(PNG, "looks-like.svg")).toBe("png");
    expect(sniffFormat(enc("hello"))).toBe("unknown");
  });
});

describe("SVG sanitising", () => {
  const clean = sanitizeSvg(ICON);

  it("drops scripts, event handlers, editor data and everything that reaches out", () => {
    expect(clean).not.toMatch(/<script|alert|onload|onclick|steal|foreignObject|iframe|i:pgf|hidden editor data|evil\.test|javascript:|data:text|@import|<animate|<set|DOCTYPE|ENTITY/i);
  });

  it("keeps the drawing: shapes, gradients, local references, embedded pictures, text", () => {
    expect(clean).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink" viewBox="0 0 100 100" width="100" height="100"/);
    expect(clean).toContain('<linearGradient id="g">');
    expect(clean).toContain('fill="url(#g)"');
    expect(clean).toContain('<use href="#g"/>');
    expect(clean).toContain('<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>');
    expect(clean).toContain("<polygon points=\"0,0 5,5 0,5\"/>");
    expect(clean).toContain("A &amp; B &lt;ok&gt;");
    expect(clean).toContain(".st0{fill:#C6F432;}");
    expect(clean).toContain("background:none");
    // The circle lost its outside fill (url to another host) but stays.
    expect(clean).toMatch(/<circle r="4"\/>/);
    // A shape with no fill paints black: said on the root so the swatch can change it.
    expect(clean).toMatch(/^<svg [^>]*fill="#000000"/);
  });

  it("cannot be tricked by split or malformed tags", () => {
    const out = sanitizeSvg('<svg viewBox="0 0 1 1"><scr<script>ipt>alert(1)</script><g onmouseover = "x()" ><path d="M0 0"/></g><p:x>a</p:x><g style="fill:red;behavior:url(x.htc)"/></svg>');
    expect(out).not.toMatch(/<script|onmouseover|x\(\)|behavior|url\(x/);
    expect(out).toContain("<g><path d=\"M0 0\"/></g>");
    expect(out).toContain('style="fill:red;"');
  });

  it("refuses a file that is not an SVG picture", () => {
    expect(() => sanitizeSvg("<html><body>hi</body></html>")).toThrow(SvgRefused);
    expect(() => sanitizeSvg("just text")).toThrow(SvgRefused);
  });

  it("strips outside URLs from CSS", () => {
    expect(sanitizeCss("a{background:url('https://x.test/a.png')} @import 'b.css'; b{fill:url(#ok)}")).toBe("a{background:none}  b{fill:url(#ok)}");
  });
});

describe("what a download becomes", () => {
  it("a vector ZIP with an SVG: the sanitised SVG is the layer, editable, with its colours", () => {
    const zip = zipSync({ "icon/icon.eps": EPS, "icon/icon.svg": enc(ICON), "__MACOSX/icon/._icon.svg": enc("junk"), "icon/License.txt": enc("licence") });
    const r = inspectAssetFile(zip, "icon.zip");
    expect(r.format).toBe("zip");
    expect(r.contents).toEqual(["eps", "svg"]);
    expect(r.editable).toBe(true);
    expect(r.layer?.mime).toBe("image/svg+xml");
    expect(r.layer?.entry).toBe("icon/icon.svg");
    expect(dec(r.layer!.bytes)).not.toMatch(/script|evil/);
    expect(r.colors).toEqual(expect.arrayContaining(["#c6f432", "#111111", "#000000", "#ff0000", "#0000ff"]));
    expect(r.note).toBe(NOTES.zipSvg);
    expect(formatLabelOf(r.format, r.contents)).toBe("SVG");
  });

  it("an EPS-only ZIP is refused as an editable vector, with a plain message", () => {
    const r = inspectAssetFile(zipSync({ "sale/sale.eps": EPS, "sale/sale.ai": AI }), "sale.zip");
    expect(r.layer).toBeNull();
    expect(r.editable).toBe(false);
    expect(r.colors).toEqual([]);
    expect(r.note).toMatch(/^This file is EPS\/AI: colours cannot be changed here\./);
    expect(formatLabelOf(r.format, r.contents)).toBe("EPS/AI");
  });

  it("an EPS ZIP with a PNG places the PNG, and says the colours cannot change", () => {
    const r = inspectAssetFile(zipSync({ "b/b.eps": EPS, "b/b.png": PNG }), "b.zip");
    expect(r.layer?.mime).toBe("image/png");
    expect(r.editable).toBe(false);
    expect(r.note).toBe(NOTES.epsRaster);
  });

  it("a PNG or JPG photo is a raster layer as it is", () => {
    const png = inspectAssetFile(PNG.buffer.slice(0) as ArrayBuffer, "photo.png");
    expect(png).toMatchObject({ format: "png", editable: false, note: NOTES.raster });
    expect(png.layer?.mime).toBe("image/png");
    const jpg = inspectAssetFile(JPG, "photo.jpg");
    expect(jpg).toMatchObject({ format: "jpg", editable: false });
    expect(jpg.layer?.mime).toBe("image/jpeg");
  });

  it("EPS, AI and PSD on their own: no layer file, the note says why", () => {
    expect(inspectAssetFile(EPS, "a.eps")).toMatchObject({ format: "eps", layer: null, note: NOTES.eps });
    expect(inspectAssetFile(AI, "a.ai")).toMatchObject({ format: "ai", layer: null, note: NOTES.eps });
    expect(inspectAssetFile(PSD, "a.psd")).toMatchObject({ format: "psd", layer: null, note: NOTES.psd });
  });

  it("a broken SVG or ZIP never throws: the preview stands in", () => {
    expect(inspectAssetFile(enc("<svg><script>"), "x.svg").layer).not.toBeNull();
    expect(inspectAssetFile(enc("<?xml version='1.0'?><html/>"), "x.svg")).toMatchObject({ layer: null });
    expect(inspectAssetFile(new Uint8Array([80, 75, 3, 4, 1, 2]), "x.zip")).toMatchObject({ format: "zip", layer: null });
  });
});

describe("vector colours", () => {
  it("normalises the ways a colour is written", () => {
    expect(normalizeColor("#ABC")).toBe("#aabbcc");
    expect(normalizeColor(" #C6F432 !important")).toBe("#c6f432");
    expect(normalizeColor("rgb(255, 0, 128)")).toBe("#ff0080");
    expect(normalizeColor("rgba(0,0,0,0.5)")).toBe("#000000");
    expect(normalizeColor("rgb(100%, 0%, 0%)")).toBe("#ff0000");
    expect(normalizeColor("White")).toBe("#ffffff");
    expect(normalizeColor("none")).toBeNull();
    expect(normalizeColor("url(#g)")).toBeNull();
    expect(normalizeColor("currentColor")).toBeNull();
  });

  it("lists the distinct paint colours, most used first, and ignores look-alike properties", () => {
    const svg = '<svg><style>.a{fill:#fff}.b{background-color:#123456}</style><path fill="#FFF"/><path fill="#ffffff" stroke="#000"/><stop stop-color="red"/><rect fill="none"/></svg>';
    expect(extractSvgColors(svg)).toEqual(["#ffffff", "#000000", "#ff0000"]);
  });

  it("rewrites exactly the mapped colours, in attributes, styles and rules, and nothing else", () => {
    const svg = '<svg fill="#000000"><style>.st0{fill:#C6F432 !important;}</style><path class="st0"/><path fill="#c6f432" stroke="#111"/><stop style="stop-color: #C6F432"/><rect fill="url(#g)"/></svg>';
    const out = recolorSvg(svg, { "#C6F432": "#1129d3", "#000000": "#ffffff" });
    expect(out).toBe('<svg fill="#1129d3"><style>.st0{fill:#1129d3 !important;}</style><path class="st0"/><path fill="#1129d3" stroke="#111"/><stop style="stop-color: #1129d3"/><rect fill="url(#g)"/></svg>'.replace('<svg fill="#1129d3">', '<svg fill="#ffffff">'));
    expect(extractSvgColors(out)).toEqual(expect.arrayContaining(["#1129d3", "#ffffff", "#111111"]));
    expect(extractSvgColors(out)).not.toContain("#c6f432");
    expect(recolorSvg(svg, {})).toBe(svg);
    expect(recolorSvg(svg, null)).toBe(svg);
  });

  it("keeps only safe colour maps: hex in, hex out, no identities, at most 32", () => {
    expect(cleanColorMap({ "#FFF": "#000", "#abc": "#ABC", bad: "#000", "#111111": "javascript:x" })).toEqual({ "#ffffff": "#000000" });
    const big = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`#0000${i.toString(16).padStart(2, "0")}`, "#ffffff"]));
    expect(Object.keys(cleanColorMap(big))).toHaveLength(32);
  });
});
