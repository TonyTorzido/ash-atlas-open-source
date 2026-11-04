import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  CommunitySafetyService,
  CURRENT_COMMUNITY_RULES_VERSION
} from "./communitySafety.js";

const REPORTER = "00000000-0000-4000-8000-000000000001";
const TARGET = "00000000-0000-4000-8000-000000000002";
const MESSAGE = "00000000-0000-4000-8000-000000000003";

describe("community safety persistence", () => {
  it("accepts only the current rules version and stores the acceptance timestamp", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ accepted_at: "2026-09-15T00:00:00.000Z" }] });
    const service = new CommunitySafetyService(pool(query), () => new Date("2026-09-15T00:00:00.000Z"));

    expect(await service.hasCurrentTermsAcceptance(REPORTER)).toBe(false);
    await expect(service.acceptCurrentTerms(REPORTER)).resolves.toEqual({
      version: CURRENT_COMMUNITY_RULES_VERSION,
      acceptedAt: "2026-09-15T00:00:00.000Z"
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects self reports and malformed message targets before touching the database", async () => {
    const query = vi.fn();
    const service = new CommunitySafetyService(pool(query));

    await expect(service.createReport({
      reporterPlayerId: REPORTER,
      target: { kind: "player", playerId: REPORTER },
      category: "harassment"
    })).rejects.toMatchObject({ code: "REPORT_SELF" });
    await expect(service.createReport({
      reporterPlayerId: REPORTER,
      target: { kind: "message", messageId: "not-a-uuid" },
      category: "harassment"
    })).rejects.toMatchObject({ code: "REPORT_INVALID" });
    expect(query).not.toHaveBeenCalled();
  });

  it("normalizes report details and returns a durable player report", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{
      id: "00000000-0000-4000-8000-000000000100",
      reporter_player_id: REPORTER,
      target_kind: "player",
      target_message_id: null,
      target_player_id: TARGET,
      channel_id: null,
      category: "harassment",
      explanation: "Repeated threats",
      status: "pending",
      created_at: "2026-09-15T00:00:00.000Z"
    }] });
    const service = new CommunitySafetyService(pool(query), () => new Date("2026-09-15T00:00:00.000Z"));

    await expect(service.createReport({
      reporterPlayerId: REPORTER,
      target: { kind: "player", playerId: TARGET },
      category: "harassment",
      explanation: "  Repeated threats  "
    })).resolves.toMatchObject({
      target: { kind: "player", playerId: TARGET },
      category: "harassment",
      explanation: "Repeated threats",
      status: "pending"
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects unavailable message targets and open duplicate reports", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] });
    const service = new CommunitySafetyService(pool(query));
    await expect(service.createReport({
      reporterPlayerId: REPORTER,
      target: { kind: "message", messageId: MESSAGE },
      category: "spam"
    })).rejects.toMatchObject({
      code: "REPORT_TARGET_UNAVAILABLE",
      statusCode: 404
    });

    query.mockReset();
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] });
    await expect(service.createReport({
      reporterPlayerId: REPORTER,
      target: { kind: "message", messageId: MESSAGE },
      category: "spam"
    })).rejects.toMatchObject({
      code: "REPORT_DUPLICATE",
      statusCode: 409
    });

    query.mockReset();
    query.mockRejectedValueOnce({ code: "23505" });
    await expect(service.createReport({
      reporterPlayerId: REPORTER,
      target: { kind: "player", playerId: TARGET },
      category: "harassment"
    })).rejects.toMatchObject({
      code: "REPORT_DUPLICATE",
      statusCode: 409
    });
  });
});

function pool(query: ReturnType<typeof vi.fn>): pg.Pool {
  return { query } as unknown as pg.Pool;
}
