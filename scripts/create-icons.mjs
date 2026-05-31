/**
 * Generates all icon assets for the Café Vie Print Agent:
 *   assets/icon.png           512×512 app icon (used by electron-builder)
 *   src/tray-icons.generated.ts  inline base64 PNG tray icons (connected/disconnected)
 *
 * Pure Node.js — no external dependencies.
 * Run automatically via `npm run build`.
 */

import zlib from "zlib";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT   = join(__dir, "..");
const ASSETS = join(ROOT, "assets");
const SRC    = join(ROOT, "src");
mkdirSync(ASSETS, { recursive: true });
mkdirSync(SRC,    { recursive: true });

// ── CRC32 ──────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf  = Buffer.allocUnsafe(4);  lenBuf.writeUInt32BE(data.length);
  const crcBuf  = Buffer.allocUnsafe(4);  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// ── PNG builder — RGB (no alpha) ───────────────────────────────────────────────
function makePNG(size, drawPixel) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.allocUnsafe(1 + size * 3);
    row[0] = 0; // filter = none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = drawPixel(x, y, size);
      row[1 + x * 3]     = r;
      row[1 + x * 3 + 1] = g;
      row[1 + x * 3 + 2] = b;
    }
    rows.push(row);
  }
  const compressed = zlib.deflateSync(Buffer.concat(rows), { level: 9 });
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Pixel helpers ──────────────────────────────────────────────────────────────
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

/** Antialiased circle on white background */
function circlePixel(r, g, b) {
  return (x, y, S) => {
    const cx = (S - 1) / 2, cy = (S - 1) / 2, radius = S / 2 - 1.5;
    const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    if (dist <= radius - 0.5) return [r, g, b];
    if (dist <= radius + 0.5) {
      const t = radius + 0.5 - dist; // 0..1
      return [lerp(255, r, t), lerp(255, g, t), lerp(255, b, t)];
    }
    return [255, 255, 255];
  };
}

/** App icon — rounded rect in terracotta #B7472A with simple printer shape */
function appIconPixel(x, y, S) {
  const [PR, PG, PB] = [183, 71, 42];  // primary terracotta
  const [LR, LG, LB] = [220, 130, 110]; // light terracotta
  const [CR, CG, CB] = [250, 248, 245]; // cream bg

  const pad = S * 0.07, r = S * 0.18;
  const cx = S / 2, cy = S / 2;
  const qx = Math.abs(x - cx) - (S / 2 - pad - r);
  const qy = Math.abs(y - cy) - (S / 2 - pad - r);
  const dist = Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) - r;
  if (dist > 0.5) return [CR, CG, CB];

  // Printer body
  const bx = S * 0.22, bw = S * 0.56, by = S * 0.30, bh = S * 0.38;
  const inBody = x >= bx && x <= bx + bw && y >= by && y <= by + bh;

  // Paper slots (top + bottom)
  const px = S * 0.33, pw = S * 0.34;
  const inPaper = x >= px && x <= px + pw && (y >= S * 0.18 && y <= S * 0.33);
  const inTray  = x >= px && x <= px + pw && (y >= S * 0.60 && y <= S * 0.82);

  // Indicator dot
  const dotCx = bx + bw - S * 0.09, dotCy = by + bh / 2, dotR = S * 0.045;
  if ((x - dotCx) ** 2 + (y - dotCy) ** 2 <= dotR ** 2) return [255, 255, 255];
  if (inPaper || inTray) return [LR, LG, LB];
  if (inBody)  return [PR, PG, PB];
  return [PR, PG, PB];
}

// ── Generate files ─────────────────────────────────────────────────────────────

// 512×512 app icon
const appIcon = makePNG(512, appIconPixel);
writeFileSync(join(ASSETS, "icon.png"), appIcon);
console.log("✅  assets/icon.png (512×512 app icon)");

// 24×24 tray icons — connected (green) and disconnected (grey)
const trayOn  = makePNG(24, circlePixel(34, 197, 94));   // #22c55e
const trayOff = makePNG(24, circlePixel(156, 163, 175)); // #9ca3af

writeFileSync(join(ASSETS, "tray-on.png"),  trayOn);
writeFileSync(join(ASSETS, "tray-off.png"), trayOff);
console.log("✅  assets/tray-on.png + tray-off.png (24×24 tray icons)");

// Embed as base64 in a generated TS module so esbuild bundles them inline
// (avoids runtime path resolution — works identically in dev and packaged)
const generated = `// AUTO-GENERATED by scripts/create-icons.mjs — do not edit
export const TRAY_ON_PNG  = "data:image/png;base64,${trayOn.toString("base64")}";
export const TRAY_OFF_PNG = "data:image/png;base64,${trayOff.toString("base64")}";
`;
writeFileSync(join(SRC, "tray-icons.generated.ts"), generated);
console.log("✅  src/tray-icons.generated.ts (inline PNG data URLs)");
console.log("    Replace assets/icon.png with your actual logo for production.");
