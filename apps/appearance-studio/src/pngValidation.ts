export const MAX_APPEARANCE_PNG_BYTES = 4 * 1024 * 1024;
export const MAX_APPEARANCE_PNG_DIMENSION = 4096;
export const MAX_APPEARANCE_PNG_PIXELS = 16_000_000;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function validatePng(buffer: Buffer): { width: number; height: number } {
  if (buffer.length > MAX_APPEARANCE_PNG_BYTES) {
    throw new Error("PNG exceeds the 4 MiB appearance-asset limit");
  }
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("File is not a valid PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIend = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (next > buffer.length) throw new Error("PNG contains a truncated chunk");
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(buffer.subarray(offset + 4, offset + 8 + length));
    if (expectedCrc !== actualCrc) throw new Error("PNG contains a corrupt chunk");
    if (!sawIhdr) {
      if (type !== "IHDR" || length !== 13) {
        throw new Error("PNG does not begin with a valid IHDR chunk");
      }
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
      sawIhdr = true;
    }
    if (type === "IEND") {
      if (length !== 0 || next !== buffer.length) {
        throw new Error("PNG has malformed data after IEND");
      }
      sawIend = true;
      break;
    }
    offset = next;
  }
  if (!sawIhdr || !sawIend || width < 1 || height < 1) {
    throw new Error("PNG is incomplete");
  }
  if (
    width > MAX_APPEARANCE_PNG_DIMENSION ||
    height > MAX_APPEARANCE_PNG_DIMENSION ||
    width * height > MAX_APPEARANCE_PNG_PIXELS
  ) {
    throw new Error("PNG dimensions exceed the appearance-asset limit");
  }
  return { width, height };
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
