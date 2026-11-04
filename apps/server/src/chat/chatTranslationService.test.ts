import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  ChatTranslationUnavailableError,
  type ChatTranslationProvider
} from "./googleCloudTranslation.js";
import {
  CHAT_TRANSLATION_MONTHLY_CHARACTER_CAP_MAX,
  ChatTranslationQuotaExceededError,
  ChatTranslationService
} from "./chatTranslationService.js";

describe("ChatTranslationService durable cache and budget", () => {
  it("caches a completed translation by message, target, provider, model, and version", async () => {
    const database = translationDatabase();
    const provider = configuredProvider({ translatedText: "Hello", sourceLanguage: "es" });
    const service = new ChatTranslationService(database.pool, provider);
    const message = { id: messageId(1), body: "Hola" };

    await expect(service.translate(message, "en")).resolves.toEqual({
      translatedText: "Hello",
      sourceLanguage: "es"
    });
    await expect(service.translate(message, "en")).resolves.toEqual({
      translatedText: "Hello",
      sourceLanguage: "es"
    });

    expect(provider.translate).toHaveBeenCalledOnce();
    expect(database.usedCharacters).toBe(4);
    expect(database.cacheSize).toBe(1);
  });

  it("notifies once for a new translation and never for a cache hit", async () => {
    const database = translationDatabase();
    const provider = configuredProvider({ translatedText: "Hello", sourceLanguage: "es" });
    const onTranslationCreated = vi.fn();
    const service = new ChatTranslationService(database.pool, provider, { onTranslationCreated });
    const message = {
      id: messageId(8),
      body: "Hola",
      channelId: "channel-1",
      channelKey: "public:general"
    };

    await service.translate(message, "en");
    await service.translate(message, "en");
    await service.translate({ id: messageId(8), body: "Hola" }, "en");

    expect(provider.translate).toHaveBeenCalledOnce();
    expect(onTranslationCreated).toHaveBeenCalledOnce();
    expect(onTranslationCreated).toHaveBeenCalledWith(
      message,
      "en",
      { translatedText: "Hello", sourceLanguage: "es" }
    );
  });

  it("does not notify or fail when the provider fails or the listener throws", async () => {
    const database = translationDatabase();
    const provider = configuredProvider();
    provider.translate
      .mockRejectedValueOnce(new ChatTranslationUnavailableError())
      .mockResolvedValueOnce({ translatedText: "Hello" });
    const onTranslationCreated = vi.fn(() => { throw new Error("socket down"); });
    const service = new ChatTranslationService(database.pool, provider, { onTranslationCreated });
    const message = { id: messageId(9), body: "Hola" };

    await expect(service.translate(message, "en")).rejects.toBeInstanceOf(
      ChatTranslationUnavailableError
    );
    expect(onTranslationCreated).not.toHaveBeenCalled();
    await expect(service.translate(message, "en")).resolves.toEqual({ translatedText: "Hello" });
    expect(onTranslationCreated).toHaveBeenCalledOnce();
  });

  it("serializes concurrent misses so one upstream request and one budget charge win", async () => {
    const database = translationDatabase();
    const provider = configuredProvider({ translatedText: "Hello" });
    provider.translate.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { translatedText: "Hello" };
    });
    const service = new ChatTranslationService(database.pool, provider);
    const message = { id: messageId(2), body: "Hola" };

    const results = await Promise.all([
      service.translate(message, "en"),
      service.translate(message, "en")
    ]);

    expect(results).toEqual([{ translatedText: "Hello" }, { translatedText: "Hello" }]);
    expect(provider.translate).toHaveBeenCalledOnce();
    expect(database.usedCharacters).toBe(4);
    expect(database.cacheSize).toBe(1);
  });

  it("rolls back usage when the provider fails so a retry is not permanently charged", async () => {
    const database = translationDatabase();
    const provider = configuredProvider();
    provider.translate
      .mockRejectedValueOnce(new ChatTranslationUnavailableError())
      .mockResolvedValueOnce({ translatedText: "Hello" });
    const service = new ChatTranslationService(database.pool, provider);
    const message = { id: messageId(3), body: "Hola" };

    await expect(service.translate(message, "en")).rejects.toBeInstanceOf(
      ChatTranslationUnavailableError
    );
    expect(database.usedCharacters).toBe(0);
    expect(database.cacheSize).toBe(0);
    await expect(service.translate(message, "en")).resolves.toEqual({
      translatedText: "Hello"
    });
    expect(database.usedCharacters).toBe(4);
    expect(provider.translate).toHaveBeenCalledTimes(2);
  });

  it("rejects quota-exceeding requests before calling the provider", async () => {
    const database = translationDatabase();
    const provider = configuredProvider({ translatedText: "Hello" });
    const service = new ChatTranslationService(database.pool, provider, {
      monthlyCharacterCap: 4
    });

    await service.translate({ id: messageId(4), body: "Hola" }, "en");
    await expect(service.translate({ id: messageId(5), body: "World" }, "en"))
      .rejects.toBeInstanceOf(ChatTranslationQuotaExceededError);
    expect(provider.translate).toHaveBeenCalledOnce();
    expect(database.usedCharacters).toBe(4);
  });

  it("locks the shared monthly row across different message keys", async () => {
    const database = translationDatabase();
    const provider = configuredProvider({ translatedText: "Hello" });
    provider.translate.mockImplementation(async (body) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { translatedText: body };
    });
    const service = new ChatTranslationService(database.pool, provider, {
      monthlyCharacterCap: 4
    });

    const results = await Promise.allSettled([
      service.translate({ id: messageId(6), body: "Hola" }, "en"),
      service.translate({ id: messageId(7), body: "Ciao" }, "en")
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(database.usedCharacters).toBe(4);
    expect(provider.translate).toHaveBeenCalledTimes(1);
  });

  it("rejects a cap above the conservative Google free allowance", () => {
    const database = translationDatabase();
    const provider = configuredProvider();
    expect(() => new ChatTranslationService(database.pool, provider, {
      monthlyCharacterCap: CHAT_TRANSLATION_MONTHLY_CHARACTER_CAP_MAX + 1
    })).toThrow(/between 1 and 450000/);
  });
});

type CachedValue = {
  translated_text: string;
  source_language: string | null;
};

function translationDatabase(): {
  pool: Pick<pg.Pool, "connect">;
  usedCharacters: number;
  cacheSize: number;
} {
  const cache = new Map<string, CachedValue>();
  let usedCharacters = 0;
  const keyLock = new KeyLock();
  const usageLock = new KeyLock();

  const pool = {
    connect: async () => new FakeTranslationClient(cache, keyLock, usageLock, {
      get used() { return usedCharacters; },
      add(value: number) { usedCharacters += value; }
    })
  } as unknown as Pick<pg.Pool, "connect">;
  return {
    pool,
    get usedCharacters() { return usedCharacters; },
    get cacheSize() { return cache.size; }
  };
}

class FakeTranslationClient {
  private lockRelease: (() => void) | null = null;
  private usageRelease: (() => void) | null = null;
  private pendingCache: { key: string; value: CachedValue } | null = null;
  private pendingUsage = 0;

  constructor(
    private readonly cache: Map<string, CachedValue>,
    private readonly keyLock: KeyLock,
    private readonly usageLock: KeyLock,
    private readonly usage: { readonly used: number; add(value: number): void }
  ) {}

  async query<T = { rows: unknown[] }>(sql: string, values: readonly unknown[] = []): Promise<T> {
    const compact = sql.replace(/\s+/gu, " ").trim();
    if (compact === "BEGIN") return { rows: [] } as T;
    if (compact === "COMMIT") {
      if (this.pendingCache) this.cache.set(this.pendingCache.key, this.pendingCache.value);
      if (this.pendingUsage) this.usage.add(this.pendingUsage);
      this.releaseLocks();
      return { rows: [] } as T;
    }
    if (compact === "ROLLBACK") {
      this.pendingCache = null;
      this.pendingUsage = 0;
      this.releaseLocks();
      return { rows: [] } as T;
    }
    if (compact.startsWith("SELECT pg_advisory_xact_lock")) {
      this.lockRelease = await this.keyLock.acquire(String(values[0]));
      return { rows: [] } as T;
    }
    if (compact.includes("FROM chat_translation_cache")) {
      const key = values.slice(0, 5).map(String).join(":");
      const cached = this.cache.get(key);
      return { rows: cached ? [cached] : [] } as T;
    }
    if (compact.startsWith("INSERT INTO chat_translation_usage")) {
      return { rows: [] } as T;
    }
    if (compact.includes("FROM chat_translation_usage")) {
      this.usageRelease = await this.usageLock.acquire("utc-month");
      return { rows: [{ source_characters: this.usage.used }] } as T;
    }
    if (compact.startsWith("INSERT INTO chat_translation_cache")) {
      const key = values.slice(0, 5).map(String).join(":");
      this.pendingCache = {
        key,
        value: {
          translated_text: String(values[5]),
          source_language: values[6] === null ? null : String(values[6])
        }
      };
      return { rows: [] } as T;
    }
    if (compact.startsWith("UPDATE chat_translation_usage")) {
      this.pendingUsage += Number(values[0]);
      return { rows: [] } as T;
    }
    throw new Error(`Unexpected translation SQL: ${compact}`);
  }

  release(): void {
    this.releaseLocks();
  }

  private releaseLocks(): void {
    this.lockRelease?.();
    this.usageRelease?.();
    this.lockRelease = null;
    this.usageRelease = null;
  }
}

class KeyLock {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, next);
    await previous;
    return () => {
      release();
      if (this.tails.get(key) === next) this.tails.delete(key);
    };
  }
}

function configuredProvider(result: { translatedText: string; sourceLanguage?: string } = {
  translatedText: "translated"
}) {
  return {
    isConfigured: vi.fn(() => true),
    translate: vi.fn(async () => result)
  } as unknown as ChatTranslationProvider & {
    translate: ReturnType<typeof vi.fn>;
  };
}

function messageId(value: number): string {
  return `05000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}
