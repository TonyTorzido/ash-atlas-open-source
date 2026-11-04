import { DISPOSABLE_EMAIL_DOMAINS, RELAY_EMAIL_DOMAINS } from "./disposableDomains.js";

export type EmailDomainPolicy = {
  mode: "blocklist" | "allowlist";
  /** Owner additions; the built-in DEFAULT_EMAIL_DOMAIN_ALLOWLIST always applies too. */
  allowlist: readonly string[];
  blocklistExtra: readonly string[];
};

/**
 * Mainstream mailbox providers accepted by the default allowlist policy. Exact
 * domain match only: subdomains and look-alikes are rejected.
 */
export const DEFAULT_EMAIL_DOMAIN_ALLOWLIST: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "hotmail.de",
  "hotmail.it",
  "hotmail.es",
  "outlook.fr",
  "outlook.de",
  "outlook.es",
  "outlook.it",
  "live.co.uk",
  "live.ca",
  "live.com.au",
  "live.fr",
  "live.de",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.ca",
  "yahoo.com.au",
  "yahoo.fr",
  "yahoo.de",
  "yahoo.es",
  "yahoo.it",
  "yahoo.co.jp",
  "yahoo.co.in",
  "ymail.com",
  "rocketmail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "gmx.com",
  "gmx.net",
  "gmx.de"
]);

const GMAIL_DOMAINS: ReadonlySet<string> = new Set(["gmail.com", "googlemail.com"]);

const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Trims and lowercases, then accepts only a conservative ASCII addr-spec:
 * dot-atom local part (<= 64) and a multi-label hostname with an alphabetic
 * TLD. No dot or plus rewriting: this is the deliverable, displayable address.
 */
export function normalizeEmailAddress(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (value.length < 3 || value.length > 320) return null;
  const at = value.lastIndexOf("@");
  if (at <= 0 || value.indexOf("@") !== at) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || !LOCAL_PART.test(local)) return null;
  if (domain.length > 253) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return null;
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels[labels.length - 1]!)) return null;
  return value;
}

/**
 * Mailbox identity used for uniqueness, limits, and cross-provider checks:
 * lowercase, "+tag" stripped for every domain, and for Gmail dots removed and
 * googlemail.com mapped to gmail.com. Must stay identical to the SQL function
 * auth_canonical_email (db/migrations/0880_email_login_identity.sql).
 */
export function canonicalEmail(email: string): string {
  const value = email.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at < 0) return value;
  let local = value.slice(0, at);
  let domain = value.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replaceAll(".", "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

export function emailDomain(emailNormalized: string): string {
  return emailNormalized.slice(emailNormalized.lastIndexOf("@") + 1);
}

export function isEmailDomainAllowed(emailNormalized: string, policy: EmailDomainPolicy): boolean {
  const domain = emailDomain(emailNormalized);
  if (policy.mode === "allowlist") {
    return DEFAULT_EMAIL_DOMAIN_ALLOWLIST.has(domain) || policy.allowlist.includes(domain);
  }
  const extra = new Set(policy.blocklistExtra);
  for (const candidate of domainAndParents(domain)) {
    if (
      DISPOSABLE_EMAIL_DOMAINS.has(candidate) ||
      RELAY_EMAIL_DOMAINS.has(candidate) ||
      extra.has(candidate)
    ) {
      return false;
    }
  }
  return true;
}

function domainAndParents(domain: string): string[] {
  const labels = domain.split(".");
  const result: string[] = [];
  for (let index = 0; index < labels.length - 1; index += 1) {
    result.push(labels.slice(index).join("."));
  }
  return result;
}
