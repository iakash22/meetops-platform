#!/usr/bin/env node
/* global console */
/**
 * Rasterize public/favicon.svg into industry PNG sizes + a multi-size favicon.ico.
 * Requires: sharp (devDependency of @meetops/web).
 */
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'public/favicon.svg'));
const iconsDir = join(root, 'public/icons');
mkdirSync(iconsDir, { recursive: true });

async function png(size, out) {
  await sharp(svg).resize(size, size).png().toFile(out);
}

const png32 = await sharp(svg).resize(32, 32).png().toBuffer();
const png16 = await sharp(svg).resize(16, 16).png().toBuffer();

await Promise.all([
  png(180, join(root, 'public/apple-touch-icon.png')),
  png(32, join(root, 'public/favicon-32x32.png')),
  png(16, join(root, 'public/favicon-16x16.png')),
  png(192, join(iconsDir, 'icon-192.png')),
  png(512, join(iconsDir, 'icon-512.png')),
]);

// Minimal ICO: header + two PNG image entries (16 + 32).
function icoFromPngs(parts) {
  const count = parts.length;
  const headerSize = 6 + count * 16;
  let offset = headerSize;
  const entries = [];
  for (const buf of parts) {
    entries.push({ buf, offset, size: buf.length });
    offset += buf.length;
  }
  const out = Buffer.alloc(offset);
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2);
  out.writeUInt16LE(count, 4);
  let entryAt = 6;
  for (const [i, part] of entries.entries()) {
    const dim = i === 0 ? 16 : 32;
    out.writeUInt8(dim === 256 ? 0 : dim, entryAt);
    out.writeUInt8(dim === 256 ? 0 : dim, entryAt + 1);
    out.writeUInt8(0, entryAt + 2);
    out.writeUInt8(0, entryAt + 3);
    out.writeUInt16LE(1, entryAt + 4);
    out.writeUInt16LE(32, entryAt + 6);
    out.writeUInt32LE(part.size, entryAt + 8);
    out.writeUInt32LE(part.offset, entryAt + 12);
    part.buf.copy(out, part.offset);
    entryAt += 16;
  }
  return out;
}

writeFileSync(join(root, 'public/favicon.ico'), icoFromPngs([png16, png32]));
console.log('Generated favicon.ico, apple-touch-icon.png, and PNG icon sizes.');
