import type { AppConfig } from "../config.js";

/** Recipient of bug report notifications; empty or unset disables delivery. */
export function bugReportNotificationRecipient(): string {
  return (process.env.BUG_REPORT_NOTIFICATION_RECIPIENT ?? "").trim();
}

export type BugReportEmail = Readonly<{
  reportCode: string;
  title: string;
  category: string;
  description: string;
  expectedBehavior: string;
  reproducibility: string;
  submittedAt: Date | string;
  releaseGeneration: string | null;
}>;

export class BugReportEmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "BugReportEmailDeliveryError";
  }
}

type BugReportEmailConfig = Pick<
  AppConfig,
  "BUG_REPORT_EMAIL_API_KEY" | "BUG_REPORT_EMAIL_FROM" | "BUG_REPORT_EMAIL_TIMEOUT_MS"
>;

type FetchLike = typeof fetch;

export function createBugReportEmailSender(
  config: BugReportEmailConfig,
  fetcher: FetchLike = globalThis.fetch.bind(globalThis)
): (report: BugReportEmail) => Promise<void> {
  return async (report): Promise<void> => {
    const recipient = bugReportNotificationRecipient();
    if (!config.BUG_REPORT_EMAIL_API_KEY || !config.BUG_REPORT_EMAIL_FROM || !recipient) {
      throw new BugReportEmailDeliveryError(
        "bug report email provider is not configured",
        false
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.BUG_REPORT_EMAIL_TIMEOUT_MS
    );
    try {
      const response = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.BUG_REPORT_EMAIL_API_KEY}`,
          "content-type": "application/json",
          "idempotency-key": `ash-atlas-bug-report:${report.reportCode}`
        },
        body: JSON.stringify({
          from: config.BUG_REPORT_EMAIL_FROM,
          to: [recipient],
          subject: `[Ash Atlas] Bug report ${report.reportCode}: ${singleLine(report.title)}`,
          text: formatBugReportEmail(report)
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new BugReportEmailDeliveryError(
          `bug report email provider returned HTTP ${response.status}`,
          response.status === 429 || response.status >= 500
        );
      }
      const body = await response.json().catch(() => null) as { id?: unknown } | null;
      if (!body || typeof body.id !== "string" || body.id.length === 0) {
        throw new BugReportEmailDeliveryError(
          "bug report email provider returned an invalid success response",
          true
        );
      }
    } catch (error) {
      if (error instanceof BugReportEmailDeliveryError) throw error;
      throw new BugReportEmailDeliveryError(
        "bug report email provider was unreachable",
        true
      );
    } finally {
      clearTimeout(timeout);
    }
  };
}

function formatBugReportEmail(report: BugReportEmail): string {
  return [
    "A player submitted a bug report in Ash Atlas.",
    "",
    `Report ID: ${report.reportCode}`,
    `Submitted: ${formatTimestamp(report.submittedAt)}`,
    `Category: ${report.category}`,
    `Reproducibility: ${report.reproducibility}`,
    `Release generation: ${report.releaseGeneration ?? "unknown"}`,
    "",
    `Title: ${report.title}`,
    "",
    "What happened:",
    report.description,
    "",
    "Expected behavior:",
    report.expectedBehavior || "(not provided)"
  ].join("\n");
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

function formatTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
