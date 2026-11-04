import type { AppConfig } from "../../config.js";

// Store-review accounts (TRUST_REVIEW_ACCOUNT_IDS): Apple reviewers and Play
// pre-launch devices use simulators, emulators and far-away locations. These
// accounts count as Settled, are never red-zone locked or held, and their trust
// signals are recorded at weight 0 and never revoke anything.

export type TrustReviewConfig = Partial<Pick<AppConfig, "TRUST_REVIEW_ACCOUNT_IDS">>;

export function isTrustReviewAccount(config: TrustReviewConfig, accountId: string | null | undefined): boolean {
  if (!accountId) return false;
  const ids = config.TRUST_REVIEW_ACCOUNT_IDS;
  return Array.isArray(ids) && ids.length > 0 && ids.includes(accountId.toLowerCase());
}
