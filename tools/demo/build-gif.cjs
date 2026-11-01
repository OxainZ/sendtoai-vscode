// Assembles tools/demo/frames/*.png into images/demo.gif (max ~960 px wide,
// duplicate frames merged, GIF delays from the real timestamps).
const path = require('node:path');
const fs = require('node:fs');
const { PNG } = require('pngjs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const frames = path.join(__dirname, 'frames');
const out = path.resolve(__dirname, '..', '..', 'images', 'demo.gif');
const TARGET_W = 960;
const MAX_FPS = 8;
const INSET = 12;          // px trimmed on every side: Windows window rects include an invisible border
const SKIP_BEFORE_MS = 4000; // startup notifications before the panel has rendered

const files = fs.readdirSync(frames).filter(f => f.endsWith('.png')).sort();
if (files.length === 0) { console.error('no frames'); process.exit(1); }
const ts = (f) => parseInt(f.split('_')[1], 10);

function crop(png, inset) {
  const w = png.width - 2 * inset, h = png.height - 2 * inset;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) { png.data.copy(data, y * w * 4, ((y + inset) * png.width + inset) * 4, ((y + inset) * png.width + inset + w) * 4); }
  return { width: w, height: h, data };
}

function downscale(png, w) {
  const scale = png.width / w;
  const h = Math.round(png.height / scale);
  const outBuf = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * scale), sy1 = Math.min(png.height, Math.floor((y + 1) * scale) || sy0 + 1);
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * scale), sx1 = Math.min(png.width, Math.floor((x + 1) * scale) || sx0 + 1);
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
        const i = (sy * png.width + sx) * 4; r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++;
      }
      const o = (y * w + x) * 4;
      outBuf[o] = r / n; outBuf[o + 1] = g / n; outBuf[o + 2] = b / n; outBuf[o + 3] = 255;
    }
  }
  return { data: outBuf, width: w, height: h };
}

const gif = GIFEncoder();
let last = null, lastTs = null, written = 0, pendingDelay = 0;
const minGap = 1000 / MAX_FPS;
for (let i = 0; i < files.length; i++) {
  const t = ts(files[i]);
  if (t < SKIP_BEFORE_MS) { continue; }
  if (lastTs !== null && t - lastTs < minGap) { continue; }
  const png = crop(PNG.sync.read(fs.readFileSync(path.join(frames, files[i]))), INSET);
  const w = Math.min(TARGET_W, png.width);
  const img = downscale(png, w);
  const same = last && Buffer.compare(Buffer.from(img.data), Buffer.from(last.data)) === 0;
  if (same) { pendingDelay += t - lastTs; lastTs = t; continue; }
  const next = files.slice(i + 1).find(f => ts(f) - t >= minGap);
  let delay = next ? ts(next) - t : 1500;
  delay += pendingDelay; pendingDelay = 0;
  const palette = quantize(img.data, 256);
  const index = applyPalette(img.data, palette);
  gif.writeFrame(index, img.width, img.height, { palette, delay: Math.max(60, delay) });
  last = img; lastTs = t; written++;
}
gif.finish();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, gif.bytes());
console.log(`wrote ${out}: ${written} frames, ${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB`);
