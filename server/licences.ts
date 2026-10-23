/**
 * The open-source licences page (GET /licences): the software the studio ships to the browser
 * under a licence that asks to be named. Today that is FFmpeg's AAC encoder, which the video
 * editor loads as a separate file (src/video-editor/engine/aac-encoder.wasm) when the browser has
 * no AAC encoder of its own. LGPL-2.1 §6 asks for the notice, the licence text and the source.
 */
export const FFMPEG_VERSION = "8.1.3";

export const LICENCES_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open-source licences · Level Studio</title>
<style>
  body { font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px; color: #1d1d1f; background: #fff; }
  h1 { font-size: 22px; } h2 { font-size: 17px; margin-top: 28px; }
  code { background: #f2f2f4; padding: 1px 5px; border-radius: 4px; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } code { background: #222; } a { color: #8ab4ff; } }
</style>
</head>
<body>
<h1>Open-source licences</h1>
<p>Level Studio uses the software below. Thank you to its authors.</p>

<h2>FFmpeg (AAC audio encoder)</h2>
<p>The video editor encodes a video's sound with FFmpeg's native AAC encoder when the browser has no
AAC encoder of its own. It is FFmpeg ${FFMPEG_VERSION}, built without GPL parts or external libraries,
compiled to WebAssembly and loaded as a separate file (<code>aac-encoder.wasm</code>) that can be
replaced with another build.</p>
<ul>
  <li>Licence: GNU Lesser General Public License, version 2.1 or later
    (<a href="https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html">full text</a>).</li>
  <li>Source: <a href="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz">ffmpeg-${FFMPEG_VERSION}.tar.xz</a>
    from <a href="https://ffmpeg.org/">ffmpeg.org</a>, unmodified; the build script and the small
    glue code that turn it into the WebAssembly file are available from Level MENA on request.</li>
  <li>FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.</li>
</ul>

<h2>Music</h2>
<p>Tracks in the music library carry their own licence and credit line, shown with each track in the
video editor.</p>
</body>
</html>`;
