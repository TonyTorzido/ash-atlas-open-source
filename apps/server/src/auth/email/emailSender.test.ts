import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../config.js";
import {
  EmailDeliveryError,
  LogEmailSender,
  ResendEmailSender,
  createEmailSender,
  loginCodeEmail
} from "./emailSender.js";

const message = {
  to: "player@example.com",
  category: "login_code" as const,
  ...loginCodeEmail("123456", 10),
  diagnostics: { codeId: "code-1", code: "123456" }
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

describe("Resend email sender", () => {
  it("posts the message with a bearer key and returns the provider id", async () => {
    const fetcher = vi.fn<Fetcher>(async () =>
      new Response(JSON.stringify({ id: "resend-message-1" }), { status: 200 })
    );
    const sender = new ResendEmailSender("re_test_key", "Ash Atlas <login@example.com>", fetcher);

    await expect(sender.send(message)).resolves.toEqual({
      provider: "resend",
      messageId: "resend-message-1"
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: "Bearer re_test_key" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      from: "Ash Atlas <login@example.com>",
      to: ["player@example.com"],
      subject: "Your Ash Atlas sign-in code: 123456"
    });
    expect(body.text).toContain("123456");
    expect(body).not.toHaveProperty("diagnostics");
    expect(body).not.toHaveProperty("category");
  });

  it("fails on a non-2xx provider response", async () => {
    const sender = new ResendEmailSender(
      "re_test_key",
      "login@example.com",
      vi.fn<Fetcher>(async () => new Response("{}", { status: 422 }))
    );
    await expect(sender.send(message)).rejects.toThrow(EmailDeliveryError);
    await expect(sender.send(message)).rejects.toThrow("HTTP 422");
  });

  it("fails when the provider does not answer before the timeout", async () => {
    const fetcher = vi.fn<Fetcher>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    const sender = new ResendEmailSender("re_test_key", "login@example.com", fetcher, 20);
    await expect(sender.send(message)).rejects.toThrow("email provider timed out");
  });
});

describe("log email sender", () => {
  it("logs the issued code only when development code logging is enabled", async () => {
    const quiet = { info: vi.fn() };
    await new LogEmailSender(quiet, false).send(message);
    expect(JSON.stringify(quiet.info.mock.calls)).not.toContain("123456");
    expect(JSON.stringify(quiet.info.mock.calls)).not.toContain("player@example.com");

    const verbose = { info: vi.fn() };
    await new LogEmailSender(verbose, true).send(message);
    expect(verbose.info.mock.calls[0]?.[0]).toMatchObject({
      codeId: "code-1",
      devLoginCode: "123456"
    });
  });

  it("never logs codes from a production configuration", () => {
    const sender = createEmailSender(
      { ...loadConfig({ NODE_ENV: "test", AUTH_EMAIL_DEV_LOG_CODES: "true" }), NODE_ENV: "production" },
      { info: vi.fn() }
    );
    expect(sender).toBeInstanceOf(LogEmailSender);
    expect((sender as unknown as { logCodes: boolean }).logCodes).toBe(false);
  });
});
