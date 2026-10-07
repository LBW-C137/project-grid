import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets');
fs.mkdirSync(target, { recursive: true });
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const kind = Buffer.from(name); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([kind, data])));
  return Buffer.concat([length, kind, data, crc]);
}
function makeIcon(alert, size = 256) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const squares = [[43, 43], [136, 43], [43, 136], [136, 136]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sampleX = (x + .5) * 256 / size, sampleY = (y + .5) * 256 / size;
    let color = [22, 27, 35, 255];
    for (let i = 0; i < squares.length; i++) {
      const [sx, sy] = squares[i];
      if (sampleX >= sx && sampleX < sx + 77 && sampleY >= sy && sampleY < sy + 77) color = i === 3 || (alert && i === 1) ? [239, 118, 129, 255] : [190, 207, 224, 255];
    }
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    color.forEach((c, index) => { raw[offset + index] = c; });
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// macOS draws application icons as a rounded square inside a transparent margin (824 of 1024 pixels, corner
// radius 185). The same four squares sit on it; edges are sampled 4 x 4 per pixel so they stay smooth.
function makeMacIcon(size = 1024) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const scale = size / 1024, inset = 100 * scale, body = 824 * scale, radius = 185 * scale;
  const squares = [[43, 43], [136, 43], [43, 136], [136, 136]];
  const inBody = (x, y) => {
    const dx = Math.max(inset + radius - x, 0, x - (inset + body - radius)), dy = Math.max(inset + radius - y, 0, y - (inset + body - radius));
    return x >= inset && x < inset + body && y >= inset && y < inset + body && dx * dx + dy * dy <= radius * radius;
  };
  const colorAt = (x, y) => {
    const u = (x - inset) * 256 / body, v = (y - inset) * 256 / body;
    for (let i = 0; i < squares.length; i++) {
      const [sx, sy] = squares[i];
      if (u >= sx && u < sx + 77 && v >= sy && v < sy + 77) return i === 3 ? [239, 118, 129] : [190, 207, 224];
    }
    return [22, 27, 35];
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, covered = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + .5) / 4, py = y + (sy + .5) / 4;
      if (!inBody(px, py)) continue;
      const [cr, cg, cb] = colorAt(px, py); r += cr; g += cg; b += cb; covered++;
    }
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    if (covered) { raw[offset] = Math.round(r / covered); raw[offset + 1] = Math.round(g / covered); raw[offset + 2] = Math.round(b / covered); raw[offset + 3] = Math.round(covered * 255 / 16); }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
fs.writeFileSync(path.join(target, 'icon-mac.png'), makeMacIcon());
const png = makeIcon(false);
fs.writeFileSync(path.join(target, 'icon.png'), png);
fs.writeFileSync(path.join(target, 'icon-alert.png'), makeIcon(true));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map(size => makeIcon(false, size));
const ico = Buffer.alloc(6 + sizes.length * 16); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(sizes.length, 4);
let offset = ico.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16; ico[entry] = ico[entry + 1] = size === 256 ? 0 : size;
  ico.writeUInt16LE(1, entry + 4); ico.writeUInt16LE(32, entry + 6);
  ico.writeUInt32LE(images[index].length, entry + 8); ico.writeUInt32LE(offset, entry + 12); offset += images[index].length;
}
fs.writeFileSync(path.join(target, 'icon.ico'), Buffer.concat([ico, ...images]));
