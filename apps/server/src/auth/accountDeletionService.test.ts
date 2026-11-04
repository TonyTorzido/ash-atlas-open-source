import { describe, expect, it, vi } from "vitest";

import { AccountDeletionService } from "./accountDeletionService.js";

describe("AccountDeletionService", () => {
  it("normalizes a public duplicate without creating another request", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ id: "request-1", status: "pending_verification" }],
        rowCount: 1
      });
    const service = new AccountDeletionService(
      { query } as never,
      () => new Date("2026-09-14T00:00:00.000Z")
    );

    await expect(service.requestPublic("  Player@Example.com ")).resolves.toEqual({
      requestId: "request-1",
      status: "pending_verification",
      repeated: true
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[1]?.[2]).toBe("player@example.com");
    expect(query.mock.calls[1]?.[1]?.[0]).toBe("player@example.com");
  });

  it("ties a new authenticated request to the locked account and suspends it", async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: "account-1", status: "active" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "request-1", status: "pending_processing" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});
    const client = { query: clientQuery, release: vi.fn() };
    const service = new AccountDeletionService(
      { connect: vi.fn(async () => client) } as never,
      () => new Date("2026-09-14T00:00:00.000Z")
    );

    await expect(service.requestAuthenticated({
      accountId: "account-1",
      verifiedEmail: "Player@Example.com"
    })).resolves.toEqual({
      requestId: "request-1",
      status: "pending_processing",
      repeated: false
    });
    expect(clientQuery.mock.calls[1]?.[0]).toContain("FOR UPDATE");
    expect(clientQuery.mock.calls[1]?.[1]).toEqual(["account-1"]);
    expect(clientQuery.mock.calls[4]?.[0]).toContain("'authenticated'");
    expect(clientQuery.mock.calls[4]?.[1]?.[1]).toBe("account-1");
    expect(clientQuery.mock.calls[5]?.[0]).toContain("status = 'suspended'");
    expect(clientQuery.mock.calls[5]?.[0]).toContain("suspended_at = $2");
    expect(clientQuery.mock.calls[5]?.[1]).toEqual(["account-1", new Date("2026-09-14T00:00:00.000Z")]);
    expect(clientQuery).toHaveBeenLastCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("processes an ownership-verified public request transactionally and is replay safe", async () => {
    const clientQuery = vi.fn(async (text: string) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return {};
      if (text.includes("FROM account_deletion_requests") && text.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: "request-1",
            account_id: null,
            email_normalized: "player@example.com",
            status: "pending_verification"
          }],
          rowCount: 1
        };
      }
      if (text.includes("FROM accounts") && text.includes("FOR UPDATE")) {
        return { rows: [{ id: "account-1", status: "active" }], rowCount: 1 };
      }
      if (text.includes("FROM account_identities") && text.includes("email_normalized")) {
        return { rows: [{ account_id: "account-1" }], rowCount: 1 };
      }
      if (text.includes("FROM apple_revocation_jobs")) {
        return { rows: [{ count: "0" }], rowCount: 1 };
      }
      if (text.includes("FROM players WHERE")) {
        return { rows: [{ id: "player-1" }], rowCount: 1 };
      }
      if (text.includes("FROM pg_constraint")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const client = { query: clientQuery, release: vi.fn() };
    const service = new AccountDeletionService(
      { connect: vi.fn(async () => client) } as never,
      () => new Date("2026-09-14T00:00:00.000Z")
    );

    await expect(service.processRequest({
      requestId: "request-1",
      accountId: "account-1",
      processingNote: "verified by support"
    })).resolves.toEqual({
      requestId: "request-1",
      accountId: "account-1",
      status: "completed",
      repeated: false
    });
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'completed'"),
      expect.arrayContaining(["request-1"])
    );
    expect(clientQuery).toHaveBeenCalledWith("COMMIT");
  });

  it("denies a public request when support supplies the wrong owner", async () => {
    const clientQuery = vi.fn(async (text: string) => {
      if (text === "BEGIN" || text === "ROLLBACK") return {};
      if (text.includes("FROM account_deletion_requests")) {
        return {
          rows: [{
            id: "request-1",
            account_id: null,
            email_normalized: "player@example.com",
            status: "pending_verification"
          }],
          rowCount: 1
        };
      }
      if (text.includes("FROM accounts")) {
        return { rows: [{ id: "account-2", status: "active" }], rowCount: 1 };
      }
      if (text.includes("FROM account_identities")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const client = { query: clientQuery, release: vi.fn() };
    const service = new AccountDeletionService(
      { connect: vi.fn(async () => client) } as never
    );

    await expect(service.processRequest({
      requestId: "request-1",
      accountId: "account-2"
    })).rejects.toMatchObject({ code: "DELETION_OWNERSHIP_REQUIRED", statusCode: 403 });
    expect(clientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("SET status = 'completed'"))).toBe(false);
  });

  it("returns a completed request without repeating cleanup", async () => {
    const clientQuery = vi.fn(async (text: string) => {
      if (text === "BEGIN" || text === "COMMIT") return {};
      return {
        rows: [{
          id: "request-1",
          account_id: "account-1",
          email_normalized: null,
          status: "completed"
        }],
        rowCount: 1
      };
    });
    const client = { query: clientQuery, release: vi.fn() };
    const service = new AccountDeletionService(
      { connect: vi.fn(async () => client) } as never
    );

    await expect(service.processRequest({
      requestId: "request-1",
      accountId: "account-1"
    })).resolves.toEqual({
      requestId: "request-1",
      accountId: "account-1",
      status: "completed",
      repeated: true
    });
    expect(clientQuery).toHaveBeenCalledTimes(3);
  });
});
