/**
 * Minimal STORED-only zip writer — no dependencies, ~3 KB compiled.
 *
 * Audio/video assets are already compressed; deflate-on-write would
 * burn battery for ~0% gain. JSON entries are small. So we ship a
 * STORED-only writer that any unzip tool reads natively.
 *
 * Spec references:
 *   - PKWARE APPNOTE 6.3.x (Local File Header / Central Directory / EOCD)
 *   - ZIP64 NOT supported — total bundle must stay under 4 GiB and per-file
 *     under 4 GiB. For our V1.1 case bundles that's not a real limit; if it
 *     becomes one we'll wire ZIP64 then.
 *
 * All offsets/sizes are little-endian. Filenames are UTF-8 (bit 11 of
 * general-purpose flag set).
 */

export interface ZipEntry {
  /** Path inside the archive, slash-separated (e.g. "media/case-x/clip.webm"). */
  path: string;
  /** Bytes to store. */
  data: Uint8Array;
  /** Modification time. Defaults to now. */
  mtime?: Date;
}

const SIG_LFH = 0x04034b50;          // Local file header
const SIG_CFH = 0x02014b50;          // Central directory file header
const SIG_EOCD = 0x06054b50;         // End of central directory

const ZIP_VERSION = 20;              // 2.0 = STORED + folders
const FLAG_UTF8 = 1 << 11;
const COMP_STORED = 0;

// Pre-compute the CRC-32 table (IEEE polynomial).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { time, date };
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function writeU16LE(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}
function writeU32LE(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

interface PreparedEntry {
  pathBytes: Uint8Array;
  data: Uint8Array;
  crc: number;
  size: number;
  time: number;
  date: number;
  /** Offset of this entry's local file header in the final archive. */
  offset: number;
}

/**
 * Build a complete zip archive in memory and return it as a Blob.
 * Suitable for case bundles up to a few hundred MB; for large videos prefer
 * a streaming writer (not implemented in V1).
 */
export function buildZip(entries: ZipEntry[]): Blob {
  const prepared: PreparedEntry[] = [];
  let offset = 0;
  const localChunks: Uint8Array[] = [];

  for (const entry of entries) {
    const pathBytes = utf8(entry.path);
    const data = entry.data;
    const crc = crc32(data);
    const { time, date } = dosTime(entry.mtime ?? new Date());

    // --- Local File Header ---
    // 30 bytes fixed + filename + extra (none) + data
    const lfh = new Uint8Array(30 + pathBytes.length);
    const lfhView = new DataView(lfh.buffer);
    writeU32LE(lfhView, 0, SIG_LFH);
    writeU16LE(lfhView, 4, ZIP_VERSION);          // version needed
    writeU16LE(lfhView, 6, FLAG_UTF8);            // gp flag
    writeU16LE(lfhView, 8, COMP_STORED);          // compression
    writeU16LE(lfhView, 10, time);                // last mod time
    writeU16LE(lfhView, 12, date);                // last mod date
    writeU32LE(lfhView, 14, crc);                 // crc-32
    writeU32LE(lfhView, 18, data.length);         // compressed size
    writeU32LE(lfhView, 22, data.length);         // uncompressed size
    writeU16LE(lfhView, 26, pathBytes.length);    // file name length
    writeU16LE(lfhView, 28, 0);                   // extra field length
    lfh.set(pathBytes, 30);

    localChunks.push(lfh, data);

    prepared.push({ pathBytes, data, crc, size: data.length, time, date, offset });
    offset += lfh.length + data.length;
  }

  // --- Central Directory ---
  const centralChunks: Uint8Array[] = [];
  let centralSize = 0;
  for (const e of prepared) {
    // 46 bytes fixed + filename + extra (none) + comment (none)
    const cfh = new Uint8Array(46 + e.pathBytes.length);
    const cfhView = new DataView(cfh.buffer);
    writeU32LE(cfhView, 0, SIG_CFH);
    writeU16LE(cfhView, 4, ZIP_VERSION);          // version made by
    writeU16LE(cfhView, 6, ZIP_VERSION);          // version needed
    writeU16LE(cfhView, 8, FLAG_UTF8);            // gp flag
    writeU16LE(cfhView, 10, COMP_STORED);
    writeU16LE(cfhView, 12, e.time);
    writeU16LE(cfhView, 14, e.date);
    writeU32LE(cfhView, 16, e.crc);
    writeU32LE(cfhView, 20, e.size);              // compressed
    writeU32LE(cfhView, 24, e.size);              // uncompressed
    writeU16LE(cfhView, 28, e.pathBytes.length);
    writeU16LE(cfhView, 30, 0);                   // extra
    writeU16LE(cfhView, 32, 0);                   // comment
    writeU16LE(cfhView, 34, 0);                   // disk number start
    writeU16LE(cfhView, 36, 0);                   // internal attrs
    writeU32LE(cfhView, 38, 0);                   // external attrs
    writeU32LE(cfhView, 42, e.offset);            // local header offset
    cfh.set(e.pathBytes, 46);
    centralChunks.push(cfh);
    centralSize += cfh.length;
  }

  const centralOffset = offset;

  // --- End of Central Directory ---
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  writeU32LE(eocdView, 0, SIG_EOCD);
  writeU16LE(eocdView, 4, 0);                     // disk
  writeU16LE(eocdView, 6, 0);                     // disk with cd
  writeU16LE(eocdView, 8, prepared.length);       // entries on this disk
  writeU16LE(eocdView, 10, prepared.length);      // total entries
  writeU32LE(eocdView, 12, centralSize);          // size of cd
  writeU32LE(eocdView, 16, centralOffset);        // offset of cd
  writeU16LE(eocdView, 20, 0);                    // comment length

  // Cast through unknown — strict lib.dom types insist on Uint8Array<ArrayBuffer>
  // but Uint8Array<ArrayBufferLike> is a structurally identical superset.
  const parts = [...localChunks, ...centralChunks, eocd] as unknown as BlobPart[];
  return new Blob(parts, { type: "application/zip" });
}

/** Convenience for common text entries. */
export function textEntry(path: string, text: string, mtime?: Date): ZipEntry {
  return { path, data: utf8(text), mtime };
}

/** Convenience for JSON entries (pretty-printed). */
export function jsonEntry(path: string, value: unknown, mtime?: Date): ZipEntry {
  return textEntry(path, JSON.stringify(value, null, 2), mtime);
}
