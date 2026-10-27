import { open, type FileHandle } from 'node:fs/promises';
import type { AllowedDemuxer } from '@meetops/media-core';

/**
 * Trailing-data check (PR #269 L-1): a valid container followed by other bytes (e.g. appended HTML) is a polyglot.
 * Walks only element/box headers (payloads are skipped, never read), so cost is O(elements), not O(bytes).
 * Returns true when bytes trail the parsed container. Ogg and MP3 have no container end and are not checked.
 */
export async function hasTrailingData(file: string, demuxer: AllowedDemuxer): Promise<boolean> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (demuxer === 'matroska') return await matroskaTrailing(fh, size);
    if (demuxer === 'mov') return await movTrailing(fh, size);
    if (demuxer === 'wav') return await wavTrailing(fh, size);
    return false;
  } finally {
    await fh.close();
  }
}

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const b = Buffer.alloc(len);
  const { bytesRead } = await fh.read(b, 0, len, pos);
  return b.subarray(0, bytesRead);
}

type Vint = { value: number; length: number; unknown: boolean };

function vint(b: Buffer, off: number, keepMarker: boolean): Vint | null {
  const first = b[off];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23; // 1..8
  if (length < 1 || length > 8 || off + length > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[off + i]!;
    if (b[off + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

const SEGMENT = 0x18538067;
const CLUSTER = 0x1f43b675;
const LEVEL1 = new Set([
  0x114d9b74, // SeekHead
  0x1549a966, // Info
  0x1654ae6b, // Tracks
  CLUSTER,
  0x1c53bb6b, // Cues
  0x1941a469, // Attachments
  0x1043a770, // Chapters
  0x1254c367, // Tags
  0xec, // Void
  0xbf, // CRC-32
]);
const CLUSTER_CHILDREN = new Set([0xe7, 0xa3, 0xa0, 0xa7, 0xab, 0xbf, 0xec, 0x5854]);

async function element(fh: FileHandle, pos: number) {
  const b = await readAt(fh, pos, 12);
  const id = vint(b, 0, true);
  if (!id || id.length > 4) return null;
  const sz = vint(b, id.length, false);
  if (!sz) return null;
  return {
    id: id.value,
    dataStart: pos + id.length + sz.length,
    size: sz.value,
    unknown: sz.unknown,
  };
}

async function matroskaTrailing(fh: FileHandle, fileSize: number): Promise<boolean> {
  let pos = 0;
  const ebml = await element(fh, pos);
  if (!ebml || ebml.unknown) return true;
  pos = ebml.dataStart + ebml.size;
  const seg = await element(fh, pos);
  if (!seg || seg.id !== SEGMENT) return true;
  if (!seg.unknown) return seg.dataStart + seg.size < fileSize;
  // Unknown-size Segment (MediaRecorder / live): walk level-1 children to EOF.
  pos = seg.dataStart;
  while (pos < fileSize) {
    const el = await element(fh, pos);
    if (!el || !LEVEL1.has(el.id)) return true;
    if (!el.unknown) {
      pos = el.dataStart + el.size;
      continue;
    }
    if (el.id !== CLUSTER) return true;
    // Unknown-size Cluster ends at the next level-1 element (or EOF).
    pos = el.dataStart;
    while (pos < fileSize) {
      const c = await element(fh, pos);
      if (!c) return true;
      if (LEVEL1.has(c.id) && !CLUSTER_CHILDREN.has(c.id)) break;
      if (!CLUSTER_CHILDREN.has(c.id) || c.unknown) return true;
      pos = c.dataStart + c.size;
    }
  }
  return false; // a truncated final element (pos > fileSize) is not trailing data
}

const MOV_TOP = new Set([
  'ftyp',
  'moov',
  'mdat',
  'free',
  'skip',
  'wide',
  'uuid',
  'moof',
  'mfra',
  'styp',
  'sidx',
  'meta',
  'pdin',
  'emsg',
  'prft',
]);

async function movTrailing(fh: FileHandle, fileSize: number): Promise<boolean> {
  let pos = 0;
  while (pos < fileSize) {
    const h = await readAt(fh, pos, 16);
    if (h.length < 8) return true;
    let size = h.readUInt32BE(0);
    const type = h.subarray(4, 8).toString('latin1');
    if (!MOV_TOP.has(type)) return true;
    if (size === 0) return false; // box extends to EOF
    if (size === 1) {
      if (h.length < 16) return true;
      size = Number(h.readBigUInt64BE(8));
    }
    if (size < 8) return true;
    pos += size;
  }
  return false;
}

async function wavTrailing(fh: FileHandle, fileSize: number): Promise<boolean> {
  const h = await readAt(fh, 0, 8);
  if (h.length < 8) return true;
  const end = 8 + h.readUInt32LE(4);
  return fileSize > end + (end % 2); // RIFF pads odd sizes by one byte
}
