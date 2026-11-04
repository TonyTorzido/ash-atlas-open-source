// Minimal DER reader for the App Attest leaf certificate: node:crypto's
// X509Certificate verifies chains but does not expose arbitrary extensions.
// Bounds-checked; malformed input returns null rather than throwing.

export type DerNode = Readonly<{
  tag: number;
  // Contents (without tag and length).
  value: Buffer;
  // Offset just past this node in the parent buffer.
  end: number;
}>;

/** Reads one TLV at `offset`; null when truncated, indefinite or oversized. */
export function readDer(buffer: Buffer, offset = 0): DerNode | null {
  if (offset + 2 > buffer.length) return null;
  const tag = buffer[offset]!;
  // High-tag-number form never appears in the structures read here.
  if ((tag & 0x1f) === 0x1f) return null;
  let length = buffer[offset + 1]!;
  let cursor = offset + 2;
  if (length & 0x80) {
    const octets = length & 0x7f;
    if (octets === 0 || octets > 4 || cursor + octets > buffer.length) return null;
    length = 0;
    for (let index = 0; index < octets; index += 1) length = length * 256 + buffer[cursor + index]!;
    cursor += octets;
  }
  const end = cursor + length;
  if (end > buffer.length) return null;
  return { tag, value: buffer.subarray(cursor, end), end };
}

/** Children of a constructed node (SEQUENCE, SET, context-specific). */
export function derChildren(value: Buffer): DerNode[] | null {
  const children: DerNode[] = [];
  let offset = 0;
  while (offset < value.length) {
    const child = readDer(value, offset);
    if (!child) return null;
    children.push(child);
    offset = child.end;
  }
  return children;
}

export function decodeOid(value: Buffer): string | null {
  if (value.length === 0) return null;
  const parts = [Math.floor(value[0]! / 40), value[0]! % 40];
  let current = 0;
  for (let index = 1; index < value.length; index += 1) {
    const byte = value[index]!;
    current = current * 128 + (byte & 0x7f);
    if (current > Number.MAX_SAFE_INTEGER / 128) return null;
    if ((byte & 0x80) === 0) {
      parts.push(current);
      current = 0;
    }
  }
  return (value[value.length - 1]! & 0x80) === 0 ? parts.join(".") : null;
}

const SEQUENCE = 0x30;
const OID = 0x06;
const BOOLEAN = 0x01;
const OCTET_STRING = 0x04;
const EXTENSIONS = 0xa3; // [3] EXPLICIT in TBSCertificate

/** extnValue contents of the extension `oid` in a DER certificate, or null. */
export function certificateExtension(certificateDer: Buffer, oid: string): Buffer | null {
  const certificate = readDer(certificateDer);
  if (!certificate || certificate.tag !== SEQUENCE) return null;
  const tbs = derChildren(certificate.value)?.[0];
  if (!tbs || tbs.tag !== SEQUENCE) return null;
  const extensionsWrapper = derChildren(tbs.value)?.find((node) => node.tag === EXTENSIONS);
  if (!extensionsWrapper) return null;
  const list = derChildren(extensionsWrapper.value)?.[0];
  if (!list || list.tag !== SEQUENCE) return null;
  for (const extension of derChildren(list.value) ?? []) {
    if (extension.tag !== SEQUENCE) continue;
    const fields = derChildren(extension.value);
    if (!fields || fields[0]?.tag !== OID || decodeOid(fields[0].value) !== oid) continue;
    const valueNode = fields[1]?.tag === BOOLEAN ? fields[2] : fields[1];
    return valueNode?.tag === OCTET_STRING ? valueNode.value : null;
  }
  return null;
}

/** Apple App Attest nonce extension: SEQUENCE { [1] EXPLICIT OCTET STRING nonce }. */
export function appAttestNonce(extensionValue: Buffer): Buffer | null {
  const sequence = readDer(extensionValue);
  if (!sequence || sequence.tag !== SEQUENCE || sequence.end !== extensionValue.length) return null;
  const tagged = derChildren(sequence.value)?.find((node) => node.tag === 0xa1);
  if (!tagged) return null;
  const octets = readDer(tagged.value);
  return octets && octets.tag === OCTET_STRING ? octets.value : null;
}
