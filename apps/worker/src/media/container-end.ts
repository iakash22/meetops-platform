import { open, type FileHandle } from 'node:fs/promises';
import type { AllowedDemuxer } from '@meetops/media-core';

/**
 * Trailing-data check (PR #269 L-1): a valid container followed by other bytes (e.g. appended HTML) is a polyglot.
 * Walks only element/box headers (payloads are skipped, never read), so cost is O(elements), not O(bytes).
 * Returns true when bytes trail the parsed container. Ogg and MP3 have no container end and are not checked.
 */
export type ContainerEnd = 'ok' | 'trailing' | 'truncated';

/** True when bytes trail the container (polyglot). Kept for callers that only need that. */
export async function hasTrailingData(file: string, demuxer: AllowedDemuxer): Promise<boolean> {
  return (await containerEnd(file, demuxer)) === 'trailing';
}

/**
 * 'trailing': bytes after the container end; 'truncated': an element/box (or the declared Segment/RIFF size) runs
 * past EOF, i.e. an incomplete upload whose header may still claim the full duration (PR #269 M-1 variant).
 */
export async function containerEnd(file: string, demuxer: AllowedDemuxer): Promise<ContainerEnd> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (demuxer === 'matroska') return await matroskaEnd(fh, size);
    if (demuxer === 'mov') return await movEnd(fh, size);
    if (demuxer === 'wav') return await wavEnd(fh, size);
    return 'ok';
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

const VOID = 0xec;
/** Padding (Matroska Void, MP4 free/skip) larger than this, or not all zero bytes, is treated as smuggled data. */
const MAX_PADDING_BYTES = 1024 * 1024;

async function zeroPadding(fh: FileHandle, pos: number, size: number): Promise<boolean> {
  if (size > MAX_PADDING_BYTES) return false;
  const b = await readAt(fh, pos, size);
  return b.length === size && b.every((x) => x === 0);
}

async function matroskaEnd(fh: FileHandle, fileSize: number): Promise<ContainerEnd> {
  let pos = 0;
  const ebml = await element(fh, pos);
  if (!ebml || ebml.unknown) return 'trailing';
  pos = ebml.dataStart + ebml.size;
  const seg = await element(fh, pos);
  if (!seg || seg.id !== SEGMENT) return 'trailing';
  // A known Segment size must match the file exactly, and its children are walked like an unknown-size one, so bytes
  // hidden behind an enlarged Segment size are found (N-2).
  let limit = fileSize;
  if (!seg.unknown) {
    const end = seg.dataStart + seg.size;
    if (end < fileSize) return 'trailing';
    if (end > fileSize) return 'truncated';
    limit = end;
  }
  pos = seg.dataStart;
  while (pos < limit) {
    const el = await element(fh, pos);
    if (!el || !LEVEL1.has(el.id)) return 'trailing';
    if (el.id === VOID && !(await zeroPadding(fh, el.dataStart, el.size))) return 'trailing';
    if (!el.unknown) {
      pos = el.dataStart + el.size;
      continue;
    }
    if (el.id !== CLUSTER) return 'trailing';
    // Unknown-size Cluster ends at the next level-1 element (or EOF).
    pos = el.dataStart;
    while (pos < limit) {
      const c = await element(fh, pos);
      if (!c) return 'trailing';
      if (LEVEL1.has(c.id) && !CLUSTER_CHILDREN.has(c.id)) break;
      if (!CLUSTER_CHILDREN.has(c.id) || c.unknown) return 'trailing';
      if (c.id === VOID && !(await zeroPadding(fh, c.dataStart, c.size))) return 'trailing';
      pos = c.dataStart + c.size;
    }
  }
  return pos > limit ? 'truncated' : 'ok';
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

async function movEnd(fh: FileHandle, fileSize: number): Promise<ContainerEnd> {
  let pos = 0;
  while (pos < fileSize) {
    const h = await readAt(fh, pos, 16);
    if (h.length < 8) return 'truncated';
    let size = h.readUInt32BE(0);
    const type = h.subarray(4, 8).toString('latin1');
    if (!MOV_TOP.has(type)) return 'trailing';
    if (size === 0) return 'ok'; // box extends to EOF
    if (size === 1) {
      if (h.length < 16) return 'truncated';
      size = Number(h.readBigUInt64BE(8));
    }
    if (size < 8) return 'trailing';
    const hdr = h.readUInt32BE(0) === 1 ? 16 : 8;
    if ((type === 'free' || type === 'skip') && !(await zeroPadding(fh, pos + hdr, size - hdr)))
      return 'trailing';
    pos += size;
  }
  return pos > fileSize ? 'truncated' : 'ok';
}

async function wavEnd(fh: FileHandle, fileSize: number): Promise<ContainerEnd> {
  const h = await readAt(fh, 0, 8);
  if (h.length < 8) return 'truncated';
  const end = 8 + h.readUInt32LE(4);
  if (fileSize > end + (end % 2)) return 'trailing'; // RIFF pads odd sizes by one byte
  return fileSize < end ? 'truncated' : 'ok';
}
