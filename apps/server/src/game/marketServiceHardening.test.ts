import type pg from "pg";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { noMarketFaults } from "./marketRules.js";
import { MarketService } from "./marketService.js";

describe("MarketService construction hardening", () => {
  const pool = {} as pg.Pool;
  const logger = createLogger("test");

  it("rejects a noncanonical fault injector in production", () => {
    const config = {
      ...loadConfig({ NODE_ENV: "test" }),
      NODE_ENV: "production" as const
    };
    expect(() => new MarketService(pool, config, logger, {
      faultInjector: () => undefined
    })).toThrow(/fault injection is forbidden in production/i);
  });

  it("keeps deterministic fault injection in test and canonical no-op in production", () => {
    expect(() => new MarketService(
      pool,
      loadConfig({ NODE_ENV: "test" }),
      logger,
      { faultInjector: () => undefined }
    )).not.toThrow();
    const productionConfig = {
      ...loadConfig({ NODE_ENV: "test" }),
      NODE_ENV: "production" as const
    };
    expect(() => new MarketService(
      pool,
      productionConfig,
      logger,
      { faultInjector: noMarketFaults }
    )).not.toThrow();
  });
});
