import { describe, expect, it, vi } from "vitest";

import { createRequestId } from "./requestId.js";

describe("createRequestId", () => {
  it("uses randomUUID when the origin exposes it", () => {
    const randomUUID = vi.fn(() => "native-id" as `${string}-${string}-${string}-${string}-${string}`);
    expect(createRequestId({ randomUUID })).toBe("native-id");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("falls back to getRandomValues on plain-HTTP LAN origins", () => {
    expect(createRequestId({
      getRandomValues: (array) => {
        const bytes = array as unknown as Uint8Array;
        bytes.forEach((_, index) => { bytes[index] = index; });
        return array;
      }
    })).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });
});
