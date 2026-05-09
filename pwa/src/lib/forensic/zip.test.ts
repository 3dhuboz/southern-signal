import { describe, expect, test } from "vitest";
import { buildZip, textEntry, type ZipEntry } from "./zip";

const SIG_LFH = 0x04034b50;
const SIG_CFH = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const EOCD_SIZE = 22;

/** Independent CRC-32 (IEEE) implementation for verification — deliberately not
 *  shared with zip.ts so a bug in either side surfaces. */
function independentCrc32(bytes: Uint8Array): number {
  const POLY = 0xEDB88320;
  let c = 0xFFFFFFFF >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = (c ^ bytes[i]) >>> 0;
    for (let k = 0; k < 8; k++) {
      c = ((c & 1) ? (POLY ^ (c >>> 1)) : (c >>> 1)) >>> 0;
    }
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function buildZipBytes(entries: ZipEntry[]): Promise<{ bytes: Uint8Array; view: DataView }> {
  const blob = buildZip(entries);
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  return { bytes, view };
}

/** Find the EOCD by reading the fixed last-22-byte slot (writer always emits
 *  zero-length comment, per the file-level spec note). */
function readEocd(view: DataView): { offset: number; sig: number; totalEntries: number; cdSize: number; cdOffset: number; commentLen: number } {
  const offset = view.byteLength - EOCD_SIZE;
  return {
    offset,
    sig: view.getUint32(offset + 0, true),
    totalEntries: view.getUint16(offset + 10, true),
    cdSize: view.getUint32(offset + 12, true),
    cdOffset: view.getUint32(offset + 16, true),
    commentLen: view.getUint16(offset + 20, true),
  };
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s);

describe("buildZip", () => {
  test("empty archive: just an EOCD with zero entries", async () => {
    const blob = buildZip([]);
    const { bytes, view } = await buildZipBytes([]);
    expect(bytes.length).toBe(EOCD_SIZE);
    const eocd = readEocd(view);
    expect(eocd.sig).toBe(SIG_EOCD);
    expect(eocd.totalEntries).toBe(0);
    expect(eocd.cdSize).toBe(0);
    expect(eocd.cdOffset).toBe(0);
    expect(eocd.commentLen).toBe(0);
    expect(blob.type).toBe("application/zip");
  });

  test("single text entry: full structural round-trip", async () => {
    const { bytes, view } = await buildZipBytes([textEntry("hello.txt", "world")]);
    const filenameBytes = utf8Bytes("hello.txt");
    const dataBytes = utf8Bytes("world");

    // Local file header at offset 0.
    expect(view.getUint32(0, true)).toBe(SIG_LFH);
    const lfhCompression = view.getUint16(8, true);
    expect(lfhCompression).toBe(0); // STORED
    const lfhCrc = view.getUint32(14, true);
    const lfhCompSize = view.getUint32(18, true);
    const lfhUncompSize = view.getUint32(22, true);
    const lfhNameLen = view.getUint16(26, true);
    const lfhExtraLen = view.getUint16(28, true);

    expect(lfhNameLen).toBe(filenameBytes.length);
    expect(lfhExtraLen).toBe(0);
    expect(lfhCompSize).toBe(5);
    expect(lfhUncompSize).toBe(5);

    // Filename "hello.txt" sits immediately after the 30-byte fixed LFH.
    const filename = new TextDecoder().decode(bytes.slice(30, 30 + lfhNameLen));
    expect(filename).toBe("hello.txt");

    // Independent CRC of "world" should match what the writer stored.
    const expectedCrc = independentCrc32(dataBytes);
    expect(expectedCrc).toBe(0x3a771143);
    expect(lfhCrc >>> 0).toBe(expectedCrc);

    // The 5 bytes of file payload follow LFH + filename.
    const dataStart = 30 + lfhNameLen;
    const stored = bytes.slice(dataStart, dataStart + 5);
    expect(Array.from(stored)).toEqual(Array.from(dataBytes));

    // Central directory file header follows the data.
    const cdhStart = dataStart + 5;
    expect(view.getUint32(cdhStart, true)).toBe(SIG_CFH);

    // EOCD at the end with one entry.
    const eocd = readEocd(view);
    expect(eocd.sig).toBe(SIG_EOCD);
    expect(eocd.totalEntries).toBe(1);
    expect(eocd.cdOffset).toBe(cdhStart);
  });

  test("multiple entries: central directory preserves order and offsets are monotonic", async () => {
    const entries = [
      textEntry("a.txt", "alpha"),
      textEntry("beta.txt", "second entry"),
      textEntry("dir/three.txt", "three is three"),
    ];
    const { view } = await buildZipBytes(entries);
    const eocd = readEocd(view);
    expect(eocd.totalEntries).toBe(3);

    // Walk the central directory and read each (filename, local-header offset).
    let cursor = eocd.cdOffset;
    const seen: Array<{ name: string; localOffset: number }> = [];
    for (let i = 0; i < eocd.totalEntries; i++) {
      expect(view.getUint32(cursor, true)).toBe(SIG_CFH);
      const nameLen = view.getUint16(cursor + 28, true);
      const extraLen = view.getUint16(cursor + 30, true);
      const commentLen = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const nameBytes = new Uint8Array(view.buffer, cursor + 46, nameLen);
      const name = new TextDecoder().decode(nameBytes);
      seen.push({ name, localOffset });
      cursor += 46 + nameLen + extraLen + commentLen;
    }

    expect(seen.map(e => e.name)).toEqual(["a.txt", "beta.txt", "dir/three.txt"]);
    expect(seen[0].localOffset).toBe(0);
    expect(seen[1].localOffset).toBeGreaterThan(seen[0].localOffset);
    expect(seen[2].localOffset).toBeGreaterThan(seen[1].localOffset);
  });

  test("binary safety: 0..255 byte values round-trip exactly", async () => {
    const payload = new Uint8Array(256);
    for (let i = 0; i < 256; i++) payload[i] = i;

    const { bytes, view } = await buildZipBytes([{ path: "blob.bin", data: payload }]);

    // Read LFH, skip past filename, take compressedSize bytes.
    expect(view.getUint32(0, true)).toBe(SIG_LFH);
    const compSize = view.getUint32(18, true);
    const nameLen = view.getUint16(26, true);
    const extraLen = view.getUint16(28, true);
    expect(compSize).toBe(256);

    const dataStart = 30 + nameLen + extraLen;
    const extracted = bytes.slice(dataStart, dataStart + compSize);
    expect(extracted.length).toBe(256);
    for (let i = 0; i < 256; i++) {
      expect(extracted[i]).toBe(i);
    }

    // CRC of the payload should match what the writer stored.
    const lfhCrc = view.getUint32(14, true) >>> 0;
    expect(lfhCrc).toBe(independentCrc32(payload));
  });

  test("CRC-32 spot-check: '123456789' yields IEEE standard 0xCBF43926", async () => {
    const { view } = await buildZipBytes([textEntry("check.txt", "123456789")]);
    const lfhCrc = view.getUint32(14, true) >>> 0;
    expect(lfhCrc).toBe(0xCBF43926);
    // Cross-check against the independent implementation too.
    expect(lfhCrc).toBe(independentCrc32(utf8Bytes("123456789")));
  });

  test("filename UTF-8 flag: bit 11 (0x0800) is set in the LFH general-purpose flag", async () => {
    const { view } = await buildZipBytes([textEntry("flag.txt", "x")]);
    const flags = view.getUint16(6, true);
    expect(flags & 0x0800).toBe(0x0800);
  });

  test("MIME type on empty archive is application/zip", () => {
    expect(buildZip([]).type).toBe("application/zip");
  });
});
