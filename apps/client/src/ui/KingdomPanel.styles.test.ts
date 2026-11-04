import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./KingdomPanel.css", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("./KingdomPanel.tsx", import.meta.url), "utf8");
const globalStyles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const seatAsset = readFileSync(new URL("../assets/kingdom-seat-marker.png", import.meta.url));

describe("Kingdom App layout", () => {
  it("uses the shared destination workspace instead of a fixed map overlay", () => {
    expect(styles).toContain(".kingdom-app-panel .destination-shell-content");
    expect(styles).toContain(".kingdom-app-panel .phone-destination-body");
    expect(styles).toContain("grid-template-columns: repeat(5, minmax(0, 1fr));");
    expect(styles).toContain("background: var(--aa-ui-ink-950);");
    expect(styles).toContain("background: var(--aa-ui-wood-700);");
    expect(styles).not.toContain(".kingdom-panel");
    expect(styles).not.toContain("position: fixed");
    expect(styles).not.toContain("#7dd3fc");
    expect(styles).not.toContain("#facc15");
    expect(panelSource).toContain("<DestinationShell");
    expect(panelSource).not.toMatch(/Device(?:Frame|Panel|Screen)/);
    expect(globalStyles).not.toMatch(/developer-tools-panel,\s*html\[data-ui-profile="phone"\] \.kingdom-app[^}]*height: 100%/);
  });
});

describe("Castle marker", () => {
  it("uses the supplied transparent RGBA PNG without the old DOM marker path", () => {
    expect([...seatAsset.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const width = seatAsset.readUInt32BE(16);
    const height = seatAsset.readUInt32BE(20);
    expect(width).toBe(1254);
    expect(height).toBe(1254);
    expect(seatAsset[24]).toBe(8);
    expect(seatAsset[25]).toBe(6);
    const alpha = decodeRgbaPngAlpha(seatAsset);
    expect(alpha[0]).toBeLessThanOrEqual(1);
    expect(alpha[width - 1]).toBeLessThanOrEqual(1);
    expect(alpha[(height - 1) * width]).toBeLessThanOrEqual(1);
    expect(alpha[height * width - 1]).toBeLessThanOrEqual(1);
    expect(alpha).toContain(255);
    expect(styles).not.toContain(".kingdom-map-marker");
    expect(styles).not.toContain(".kingdom-seat-sprite");
  });
});

function decodeRgbaPngAlpha(png: Buffer): number[] {
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const kind = png.toString("ascii", offset + 4, offset + 8);
    if (kind === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const filtered = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[sourceOffset++];
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[sourceOffset++]!;
      const target = y * stride + x;
      const left = x >= bytesPerPixel ? pixels[target - bytesPerPixel]! : 0;
      const above = y > 0 ? pixels[target - stride]! : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel
        ? pixels[target - stride - bytesPerPixel]!
        : 0;
      pixels[target] = (raw + filterDelta(filter!, left, above, upperLeft)) & 0xff;
    }
  }
  return Array.from({ length: width * height }, (_, index) => pixels[index * 4 + 3]!);
}

function filterDelta(filter: number, left: number, above: number, upperLeft: number): number {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return above;
  if (filter === 3) return Math.floor((left + above) / 2);
  if (filter === 4) {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
    if (aboveDistance <= upperLeftDistance) return above;
    return upperLeft;
  }
  throw new Error(`unsupported PNG filter ${filter}`);
}
