import type {
  ChatMessage,
  ChatTranslationTargetLanguage
} from "@ash-atlas/shared";
import {
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_TRANSLATION_TARGET_LANGUAGES
} from "@ash-atlas/shared";
import {
  CHAT_TRANSLATION_MODEL,
  CHAT_TRANSLATION_PROVIDER,
  CHAT_TRANSLATION_VERSION,
  ChatTranslationUnavailableError,
  type ChatTranslationProvider,
  type ChatTranslationResult
} from "./googleCloudTranslation.js";
import type pg from "pg";

export const CHAT_TRANSLATION_MONTHLY_CHARACTER_CAP_MAX = 450_000;
export const CHAT_TRANSLATION_MONTHLY_CHARACTER_CAP_DEFAULT = 450_000;

export class ChatTranslationQuotaExceededError extends ChatTranslationUnavailableError {
  constructor() {
    super();
    this.name = "ChatTranslationQuotaExceededError";
  }
}

export type ChatTranslationSubject =
  Pick<ChatMessage, "id" | "body"> & Partial<Pick<ChatMessage, "channelId" | "channelKey" | "createdAt">>;

export type ChatTranslationExecutor = {
  translate(
    message: ChatTranslationSubject,
    targetLanguage: ChatTranslationTargetLanguage
  ): Promise<ChatTranslationResult>;
};

export type ChatTranslationServiceOptions = {
  monthlyCharacterCap?: number;
  /** Called once, after commit, only when the provider was called and a new translation cached. */
  onTranslationCreated?(
    message: ChatTranslationSubject,
    targetLanguage: ChatTranslationTargetLanguage,
    translation: ChatTranslationResult
  ): void | Promise<void>;
};

type TranslationPool = Pick<pg.Pool, "connect">;
type TranslationClient = Pick<pg.PoolClient, "query" | "release">;

type CachedTranslationRow = {
  translated_text: string;
  source_language: string | null;
};

type TranslationUsageRow = {
  source_characters: string | number;
};

export class ChatTranslationService implements ChatTranslationExecutor {
  private readonly monthlyCharacterCap: number;
  private readonly onTranslationCreated: ChatTranslationServiceOptions["onTranslationCreated"];

  constructor(
    private readonly pool: TranslationPool,
    private readonly provider: ChatTranslationProvider,
    options: ChatTranslationServiceOptions = {}
  ) {
    this.monthlyCharacterCap = configuredMonthlyCharacterCap(options.monthlyCharacterCap);
    this.onTranslationCreated = options.onTranslationCreated;
  }

  async translate(
    message: ChatTranslationSubject,
    targetLanguage: ChatTranslationTargetLanguage
  ): Promise<ChatTranslationResult> {
    const sourceCharacters = Array.from(message.body).length;
    if (
      !isSupportedTargetLanguage(targetLanguage) ||
      sourceCharacters < 1 ||
      sourceCharacters > CHAT_MESSAGE_MAX_LENGTH
    ) {
      throw new ChatTranslationUnavailableError();
    }

    const cacheKey = [
      CHAT_TRANSLATION_PROVIDER,
      CHAT_TRANSLATION_MODEL,
      CHAT_TRANSLATION_VERSION,
      message.id,
      targetLanguage
    ].join(":");
    const client = await this.pool.connect() as TranslationClient;
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [cacheKey]
      );

      const cached = await client.query<CachedTranslationRow>(
        `SELECT translated_text, source_language
           FROM chat_translation_cache
          WHERE message_id = $1
            AND target_language = $2
            AND provider = $3
            AND model = $4
            AND version = $5`,
        [
          message.id,
          targetLanguage,
          CHAT_TRANSLATION_PROVIDER,
          CHAT_TRANSLATION_MODEL,
          CHAT_TRANSLATION_VERSION
        ]
      );
      const cachedRow = cached.rows[0];
      if (cachedRow) {
        await client.query("COMMIT");
        transactionOpen = false;
        return {
          translatedText: cachedRow.translated_text,
          ...(cachedRow.source_language ? { sourceLanguage: cachedRow.source_language } : {})
        };
      }

      if (!this.provider.isConfigured()) {
        throw new ChatTranslationUnavailableError();
      }

      await client.query(
        `INSERT INTO chat_translation_usage (usage_month, source_characters)
         VALUES (date_trunc('month', now() AT TIME ZONE 'UTC')::date, 0)
         ON CONFLICT (usage_month) DO NOTHING`
      );
      const usage = await client.query<TranslationUsageRow>(
        `SELECT source_characters
           FROM chat_translation_usage
          WHERE usage_month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
          FOR UPDATE`
      );
      const usedCharacters = parseUsageCharacters(usage.rows[0]?.source_characters);
      if (usedCharacters + sourceCharacters > this.monthlyCharacterCap) {
        throw new ChatTranslationQuotaExceededError();
      }

      const translation = await this.provider.translate(message.body, targetLanguage);
      if (!translation.translatedText || translation.translatedText.trim().length === 0) {
        throw new ChatTranslationUnavailableError();
      }

      await client.query(
        `INSERT INTO chat_translation_cache (
           message_id, target_language, provider, model, version,
           translated_text, source_language, source_characters
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          message.id,
          targetLanguage,
          CHAT_TRANSLATION_PROVIDER,
          CHAT_TRANSLATION_MODEL,
          CHAT_TRANSLATION_VERSION,
          translation.translatedText,
          translation.sourceLanguage ?? null,
          sourceCharacters
        ]
      );
      await client.query(
        `UPDATE chat_translation_usage
            SET source_characters = source_characters + $1,
                updated_at = now()
          WHERE usage_month = date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
        [sourceCharacters]
      );
      await client.query("COMMIT");
      transactionOpen = false;
      this.notifyTranslationCreated(message, targetLanguage, translation);
      return translation;
    } catch (error) {
      if (transactionOpen) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      if (error instanceof ChatTranslationUnavailableError) throw error;
      throw new ChatTranslationUnavailableError();
    } finally {
      client.release();
    }
  }

  private notifyTranslationCreated(
    message: ChatTranslationSubject,
    targetLanguage: ChatTranslationTargetLanguage,
    translation: ChatTranslationResult
  ): void {
    if (!this.onTranslationCreated) return;
    try {
      void Promise.resolve(this.onTranslationCreated(message, targetLanguage, translation))
        .catch(() => undefined);
    } catch {
      // A failed broadcast must never fail a translation that is already cached.
    }
  }
}

function configuredMonthlyCharacterCap(value: number | undefined): number {
  const cap = value ?? CHAT_TRANSLATION_MONTHLY_CHARACTER_CAP_DEFAULT;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > CHAT_TRANSLATION_MONTHLY_CHARACTER_CAP_MAX) {
    throw new Error(
      `Chat translation monthly character cap must be an integer between 1 and ${CHAT_TRANSLATION_MONTHLY_CHARACTER_CAP_MAX}`
    );
  }
  return cap;
}

function parseUsageCharacters(value: string | number | undefined): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Chat translation usage returned an invalid character count");
  }
  return parsed;
}

function isSupportedTargetLanguage(value: string): value is ChatTranslationTargetLanguage {
  return (CHAT_TRANSLATION_TARGET_LANGUAGES as readonly string[]).includes(value);
}
