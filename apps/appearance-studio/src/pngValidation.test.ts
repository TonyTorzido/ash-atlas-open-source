import { describe, expect, it } from "vitest";

import {
  MAX_APPEARANCE_PNG_BYTES,
  validatePng
} from "./pngValidation.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

describe("appearance PNG validation", () => {
  it("accepts a structurally valid bounded PNG", () => {
    expect(validatePng(ONE_PIXEL_PNG)).toEqual({ width: 1, height: 1 });
  });

  it("rejects signatures, corrupt chunks, oversized payloads, and dimension bombs", () => {
    expect(() => validatePng(Buffer.from("not-png"))).toThrow(/valid PNG/u);
    const corrupt = Buffer.from(ONE_PIXEL_PNG);
    corrupt[42] = corrupt[42]! ^ 0xff;
    expect(() => validatePng(corrupt)).toThrow(/corrupt/u);
    expect(() => validatePng(Buffer.alloc(MAX_APPEARANCE_PNG_BYTES + 1)))
      .toThrow(/4 MiB/u);

    const dimensionBomb = Buffer.from(ONE_PIXEL_PNG);
    dimensionBomb.writeUInt32BE(4097, 16);
    rewriteIhdrCrc(dimensionBomb);
    expect(() => validatePng(dimensionBomb)).toThrow(/dimensions/u);
  });
});

function rewriteIhdrCrc(buffer: Buffer): void {
  const data = buffer.subarray(12, 29);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  buffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
}
