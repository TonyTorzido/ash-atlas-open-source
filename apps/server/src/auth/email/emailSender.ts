import type { AppConfig } from "../../config.js";
import type { AppLogger } from "../../logger.js";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  category: "login_code";
  /** Diagnostic context for the log sender only; never sent to a provider. */
  diagnostics?: { codeId: string; code?: string };
};

export type EmailSendResult = { provider: string; messageId: string | null };

export interface EmailSender {
  readonly provider: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export class EmailDeliveryError extends Error {
  constructor(message: string, readonly provider: string) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 10_000;

/** Development/test sender: records that a code was issued, never delivers it. */
export class LogEmailSender implements EmailSender {
  readonly provider = "log";

  constructor(
    private readonly logger: Pick<AppLogger, "info">,
    private readonly logCodes: boolean
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.logger.info(
      {
        to: maskEmail(message.to),
        category: message.category,
        codeId: message.diagnostics?.codeId ?? null,
        ...(this.logCodes && message.diagnostics?.code
          ? { devLoginCode: message.diagnostics.code }
          : {})
      },
      "email sign-in code issued (log sender; not delivered)"
    );
    return { provider: this.provider, messageId: null };
  }
}

export class ResendEmailSender implements EmailSender {
  readonly provider = "resend";

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetcher: typeof fetch,
    private readonly timeoutMs = RESEND_TIMEOUT_MS
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    let response: Response;
    try {
      response = await this.fetcher(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {})
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const timedOut = error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      throw new EmailDeliveryError(
        timedOut ? "email provider timed out" : "email provider was unreachable",
        this.provider
      );
    }
    if (!response.ok) {
      throw new EmailDeliveryError(`email provider returned HTTP ${response.status}`, this.provider);
    }
    const body = await response.json().catch(() => null) as { id?: unknown } | null;
    const messageId = body && typeof body.id === "string" && body.id.length > 0
      ? body.id.slice(0, 256)
      : null;
    return { provider: this.provider, messageId };
  }
}

export function createEmailSender(
  config: Pick<
    AppConfig,
    "AUTH_EMAIL_SENDER" | "AUTH_EMAIL_RESEND_API_KEY" | "AUTH_EMAIL_FROM" | "AUTH_EMAIL_DEV_LOG_CODES" | "NODE_ENV"
  >,
  logger: Pick<AppLogger, "info">,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis)
): EmailSender {
  if (config.AUTH_EMAIL_SENDER === "resend") {
    return new ResendEmailSender(config.AUTH_EMAIL_RESEND_API_KEY, config.AUTH_EMAIL_FROM, fetcher);
  }
  return new LogEmailSender(
    logger,
    config.AUTH_EMAIL_DEV_LOG_CODES && config.NODE_ENV !== "production"
  );
}

export function loginCodeEmail(code: string, ttlMinutes: number): Pick<EmailMessage, "subject" | "text" | "html"> {
  return {
    subject: `Your Ash Atlas sign-in code: ${code}`,
    text: [
      `Your Ash Atlas sign-in code is ${code}.`,
      "",
      `It expires in ${ttlMinutes} minutes and can be used once.`,
      "If you did not request this code, you can ignore this email."
    ].join("\n"),
    html: [
      `<p>Your Ash Atlas sign-in code is <strong style="font-size:20px;letter-spacing:2px">${code}</strong>.</p>`,
      `<p>It expires in ${ttlMinutes} minutes and can be used once.</p>`,
      "<p>If you did not request this code, you can ignore this email.</p>"
    ].join("")
  };
}

function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
