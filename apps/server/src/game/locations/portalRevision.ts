import { createHash } from "node:crypto";

/** Preserve existing revisions; encode long authored identities within the wire contract. */
export function boundedPortalRevision(revision: string): string {
  return revision.length <= 128 ? revision : `sha256:${createHash("sha256").update(revision).digest("hex")}`;
}
