import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import {
  BugReportEmailDeliveryError,
  createBugReportEmailSender,
  type BugReportEmail
} from "./bugReportEmail.js";

const report: BugReportEmail = {
  reportCode: "AA-ABC123",
  title: "Tree disappeared",
  category: "gameplay",
  description: "The tree vanished after harvesting.",
  expectedBehavior: "The tree should remain visible until it respawns.",
  reproducibility: "sometimes",
  submittedAt: "2026-09-08T15:00:00.000Z",
  releaseGeneration: "test/t1013"
};

const BUG_REPORT_NOTIFICATION_RECIPIENT = "dev@example.com";

describe("bug report email delivery", () => {
  beforeEach(() => {
    vi.stubEnv("BUG_REPORT_NOTIFICATION_RECIPIENT", BUG_REPORT_NOTIFICATION_RECIPIENT);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed without a provider secret instead of pretending delivery succeeded", async () => {
    const sender = createBugReportEmailSender(loadConfig({ NODE_ENV: "test" }));

    const error = await sender(report).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BugReportEmailDeliveryError);
    expect(error).toMatchObject({ retryable: false });
  });

  it("sends the durable report summary to the fixed developer recipient", async () => {
    const fetcher = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    const config = loadConfig({
      NODE_ENV: "test",
      BUG_REPORT_EMAIL_API_KEY: "test-api-key",
      BUG_REPORT_EMAIL_FROM: "bug-reports@example.com"
    });

    await createBugReportEmailSender(config, fetcher)(report);

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(options?.headers).toMatchObject({
      authorization: "Bearer test-api-key",
      "idempotency-key": "ash-atlas-bug-report:AA-ABC123"
    });
    expect(JSON.parse(String(options?.body))).toMatchObject({
      from: "bug-reports@example.com",
      to: [BUG_REPORT_NOTIFICATION_RECIPIENT],
      subject: "[Ash Atlas] Bug report AA-ABC123: Tree disappeared"
    });
    expect(String(options?.body)).toContain("The tree vanished after harvesting.");
  });

  it("accepts a display-name sender used by the configured provider", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      TELEMETRY_ENABLED: "true",
      BUG_REPORTS_ENABLED: "true",
      RUNTIME_SHA: "a".repeat(40),
      TELEMETRY_DATABASE_URL: "postgres://telemetry:test@127.0.0.1/test",
      BUG_REPORT_EMAIL_API_KEY: "test-api-key",
      BUG_REPORT_EMAIL_FROM: "Ash Atlas <onboarding@resend.dev>"
    });

    expect(config.BUG_REPORT_EMAIL_FROM).toBe("Ash Atlas <onboarding@resend.dev>");
  });

  it("classifies provider failures for truthful retry handling", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      BUG_REPORT_EMAIL_API_KEY: "test-api-key",
      BUG_REPORT_EMAIL_FROM: "bug-reports@example.com"
    });
    const sender = createBugReportEmailSender(
      config,
      vi.fn<
        (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
      >(async () => new Response("rate limited", { status: 429 }))
    );

    const error = await sender(report).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BugReportEmailDeliveryError);
    expect(error).toMatchObject({ retryable: true });
  });
});
