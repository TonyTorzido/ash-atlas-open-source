const MASKED_TERMS = [
  "asshole",
  "bitch",
  "cunt",
  "fuck",
  "shit",
  "slut",
  "whore"
] as const;

const HIGH_RISK_PATTERNS = [
  /\b(?:kill\s+yourself|k\s*y\s*s|go\s+die)\b/i,
  /\b(?:child\s+sexual|sexual\s+exploitation\s+of\s+(?:a\s+)?minor)\b/i
] as const;

export type FilteredChatBody =
  | { allowed: true; body: string; masked: boolean }
  | { allowed: false; reason: "high_risk_content" };

/**
 * A bounded first-line guard only. Human review and the durable moderation
 * queue remain authoritative for context, evasion, and appeals.
 */
export function filterChatBody(body: string): FilteredChatBody {
  const normalized = body.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "");
  const compact = normalized.replace(/[\s._-]+/g, " ");
  if (HIGH_RISK_PATTERNS.some((pattern) => pattern.test(compact))) {
    return { allowed: false, reason: "high_risk_content" };
  }
  let masked = false;
  const filtered = normalized.replace(/\b[a-z]+\b/gi, (word) => {
    const lower = word.toLowerCase();
    if (!(MASKED_TERMS as readonly string[]).includes(lower)) return word;
    masked = true;
    return "*".repeat(word.length);
  });
  return { allowed: true, body: filtered, masked };
}
