// Proof generator for the content-aware tongue ROI crop (src/lib/tongue-image-roi.ts).
//
// Builds synthetic test images, runs the full pipeline (downscale → classic-CV tissue
// detection → crop), and writes PNG proof images (original with bbox overlay + final crop)
// into artifacts/tongue-roi-proof/. Pure node stdlib — the PNG encoder below is a minimal
// hand-rolled one built on node:zlib deflate; no external dependencies, no server needed.
//
// Run:  ./node_modules/.bin/jiti scripts/proof-tongue-roi.mjs
// Exits non-zero if any case produces an unexpected detection method.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { detectTongueRoi, computeTongueRoiCrop } = await import("../src/lib/tongue-image-roi.ts");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(REPO_ROOT, "artifacts", "tongue-roi-proof");

// ─── Minimal PNG encoder (8-bit RGB, filter 0) ───────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 8 + data.length);
  return out;
}

function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * stride + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ─── Synthetic image helpers ─────────────────────────────────────────────────

function makeImage(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

function rgbaToRgb(image) {
  const { data, width, height } = image;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = data[i * 4];
    rgb[i * 3 + 1] = data[i * 4 + 1];
    rgb[i * 3 + 2] = data[i * 4 + 2];
  }
  return rgb;
}

function strokeRect(rgb, width, height, rect, [r, g, b], thickness = 3) {
  const { x, y, w, h } = rect;
  const x1 = Math.min(width - 1, x + w - 1);
  const y1 = Math.min(height - 1, y + h - 1);
  for (let t = 0; t < thickness; t++) {
    for (let px = Math.max(0, x); px <= x1; px++) {
      for (const py of [y + t, y1 - t]) {
        if (py < 0 || py >= height) continue;
        const i = (py * width + px) * 3;
        rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b;
      }
    }
    for (let py = Math.max(0, y); py <= y1; py++) {
      for (const px of [x + t, x1 - t]) {
        if (px < 0 || px >= width) continue;
        const i = (py * width + px) * 3;
        rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b;
      }
    }
  }
}

function cropToRgb(image, rect) {
  const { data, width } = image;
  const { x, y, w, h } = rect;
  const rgb = new Uint8Array(w * h * 3);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const src = ((y + row) * width + (x + col)) * 4;
      const dst = (row * w + col) * 3;
      rgb[dst] = data[src];
      rgb[dst + 1] = data[src + 1];
      rgb[dst + 2] = data[src + 2];
    }
  }
  return rgb;
}

// ─── Test scenes ─────────────────────────────────────────────────────────────

const SKIN_BG = [214, 182, 160]; // hue ≈ 24° — outside the red/pink tissue band
const NEUTRAL_BG = [203, 201, 198];
const TONGUE_OUTER = [170, 70, 84];
const TONGUE_INNER = [196, 95, 105];
const MOLE = [120, 90, 70];

const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) ** 2) / rx ** 2 + ((y - cy) ** 2) / ry ** 2 <= 1;

function buildCase1() {
  // Off-center ellipse "tongue" on a skin-tone-ish background (with two dark moles).
  const cx = 400, cy = 300, rx = 130, ry = 105;
  return makeImage(640, 480, (x, y) => {
    if (inEllipse(x, y, 90, 80, 9, 7) || inEllipse(x, y, 560, 420, 8, 8)) return MOLE;
    if (inEllipse(x, y, cx, cy, rx * 0.6, ry * 0.6)) return TONGUE_INNER;
    if (inEllipse(x, y, cx, cy, rx, ry)) return TONGUE_OUTER;
    return SKIN_BG;
  });
}

function buildCase2() {
  // Plain uniform background, nothing to localize → conservative center crop.
  return makeImage(640, 480, () => NEUTRAL_BG);
}

function buildCase3() {
  // Cluttered background: many small reddish squares, none large enough to be a tongue.
  // Deterministic pseudo-random placement (LCG) so the proof is reproducible.
  let seed = 0x2f6e2b1;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const squares = [];
  for (let i = 0; i < 26; i++) {
    squares.push({ x: Math.floor(rand() * 620), y: Math.floor(rand() * 460), s: 8 + Math.floor(rand() * 8) });
  }
  return makeImage(640, 480, (x, y) => {
    for (const { x: sx, y: sy, s } of squares) {
      if (x >= sx && x < sx + s && y >= sy && y < sy + s) return [190 + (s % 3) * 10, 70, 85];
    }
    return NEUTRAL_BG;
  });
}

const CASES = [
  { name: "case1-offcenter-tongue", build: buildCase1, expected: "detected" },
  { name: "case2-plain-background", build: buildCase2, expected: "fallback-center" },
  { name: "case3-cluttered-small-blobs", build: buildCase3, expected: "fallback-center" },
];

// ─── Run the pipeline and emit proofs ────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

let failures = 0;
const summary = [];
for (const { name, build, expected } of CASES) {
  const image = build();
  const roi = detectTongueRoi(image);
  const ok = roi.method === expected;
  if (!ok) failures++;

  const overlay = rgbaToRgb(image);
  const boxColor = roi.method === "detected" ? [30, 200, 60] : [240, 150, 20];
  strokeRect(overlay, image.width, image.height, roi, boxColor);
  // Reference: where the fixed center crop would have been (thin gray frame).
  const center = computeTongueRoiCrop(image.width, image.height);
  strokeRect(overlay, image.width, image.height, { x: center.x, y: center.y, w: center.width, h: center.height }, [150, 150, 150], 1);

  const cropRgb = cropToRgb(image, roi);
  const overlayPath = path.join(OUT_DIR, `${name}-original-with-roi.png`);
  const cropPath = path.join(OUT_DIR, `${name}-final-crop.png`);
  writeFileSync(overlayPath, encodePng(image.width, image.height, overlay));
  writeFileSync(cropPath, encodePng(roi.w, roi.h, cropRgb));

  summary.push({
    case: name,
    expected,
    method: roi.method,
    confidence: roi.confidence,
    bbox: `${roi.x},${roi.y} ${roi.w}x${roi.h}`,
    ok,
    files: [path.relative(REPO_ROOT, overlayPath), path.relative(REPO_ROOT, cropPath)],
  });
}

for (const row of summary) {
  console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.case}`);
  console.log(`      method=${row.method} (expected ${row.expected})  confidence=${row.confidence}  bbox=${row.bbox}`);
  for (const f of row.files) console.log(`      wrote ${f}`);
}
console.log(`\nProof images written to ${path.relative(REPO_ROOT, OUT_DIR)}/`);
if (failures > 0) {
  console.error(`${failures} case(s) produced an unexpected detection method`);
  process.exit(1);
}
console.log("All cases produced the expected detection method.");
