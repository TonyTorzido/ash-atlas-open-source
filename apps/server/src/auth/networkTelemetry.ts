import { createHmac } from "node:crypto";
import { isIP } from "node:net";

export type NetworkTelemetry = {
  networkHash: string;
  networkPrefixHash: string;
  keyVersion: string;
};

export class NetworkTelemetryHasher {
  constructor(
    private readonly key: string,
    private readonly keyVersion: string
  ) {}

  derive(rawIp: string): NetworkTelemetry {
    const normalized = normalizeIp(rawIp);
    const prefix = networkPrefix(normalized);
    return {
      networkHash: this.hmac(`ip\0${normalized}`),
      networkPrefixHash: this.hmac(`prefix\0${prefix}`),
      keyVersion: this.keyVersion
    };
  }

  private hmac(value: string): string {
    return `${this.keyVersion}:${createHmac("sha256", this.key).update(value).digest("hex")}`;
  }
}

export function normalizeIp(rawIp: string): string {
  const trimmed = rawIp.trim().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const mapped = trimmed.toLowerCase().startsWith("::ffff:")
    ? trimmed.slice("::ffff:".length)
    : trimmed;
  if (isIP(mapped) === 4) {
    return mapped
      .split(".")
      .map((part) => String(Number(part)))
      .join(".");
  }
  if (isIP(mapped) === 6) {
    return ipv6Bytes(mapped)
      .reduce<string[]>((groups, _byte, index, bytes) => {
        if (index % 2 === 0) {
          groups.push(((bytes[index] ?? 0) * 256 + (bytes[index + 1] ?? 0)).toString(16));
        }
        return groups;
      }, [])
      .join(":");
  }
  return "unknown";
}

export function networkPrefix(normalizedIp: string): string {
  if (isIP(normalizedIp) === 4) {
    const octets = normalizedIp.split(".");
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  if (isIP(normalizedIp) === 6) {
    const bytes = ipv6Bytes(normalizedIp);
    for (let index = 7; index < bytes.length; index += 1) {
      bytes[index] = 0;
    }
    return `${bytes
      .reduce<string[]>((groups, _byte, index) => {
        if (index % 2 === 0) {
          groups.push(((bytes[index] ?? 0) * 256 + (bytes[index + 1] ?? 0)).toString(16));
        }
        return groups;
      }, [])
      .join(":")}/56`;
  }
  return "unknown";
}

function ipv6Bytes(address: string): number[] {
  const [leftRaw, rightRaw] = address.toLowerCase().split("::");
  const left = ipv6Groups(leftRaw ?? "");
  const right = ipv6Groups(rightRaw ?? "");
  const missing = 8 - left.length - right.length;
  const groups = address.includes("::")
    ? [...left, ...Array.from({ length: Math.max(missing, 0) }, () => 0), ...right]
    : left;
  return groups.slice(0, 8).flatMap((group) => [(group >> 8) & 0xff, group & 0xff]);
}

function ipv6Groups(value: string): number[] {
  if (!value) {
    return [];
  }
  return value.split(":").flatMap((part) => {
    if (part.includes(".")) {
      const octets = part.split(".").map(Number);
      return [((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)];
    }
    return [Number.parseInt(part, 16)];
  });
}
