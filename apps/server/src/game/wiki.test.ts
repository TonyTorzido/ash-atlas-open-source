import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import { WikiService } from "./wiki.js";

const operationKey = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-09-01T12:00:00.000Z");
const pageRow = {
  id: "22222222-2222-4222-8222-222222222222", slug: "getting-started",
  title: "Getting Started", summary: "Begin your journey", body: "# Welcome",
  current_revision: 1, created_at: now, updated_at: now
};

function transactionalPool(query: ReturnType<typeof vi.fn>): pg.Pool {
  return { connect: vi.fn(async () => ({ query, release: vi.fn() })) } as unknown as pg.Pool;
}

describe("WikiService", () => {
  it("returns public pages without article bodies and resolves stored access only by account", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [pageRow] })
      .mockResolvedValueOnce({ rows: [{ role: "editor" }] });
    const service = new WikiService({ query } as unknown as pg.Pool);
    await expect(service.list()).resolves.toEqual({ pages: [{
      slug: pageRow.slug, title: pageRow.title, summary: pageRow.summary,
      currentRevision: 1, updatedAt: now.toISOString()
    }] });
    await expect(service.access("account", false)).resolves.toBe("editor");
    await expect(service.access("account", true)).resolves.toBe("owner");
  });

  it("commits a page and its immutable first revision in one transaction", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // operation lock
      .mockResolvedValueOnce({ rows: [] }) // replay lookup
      .mockResolvedValueOnce({ rows: [pageRow] }) // page
      .mockResolvedValueOnce({ rows: [] }) // revision
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const service = new WikiService(transactionalPool(query));
    await expect(service.create("account", { operationKey, slug: pageRow.slug, title: pageRow.title, summary: pageRow.summary, body: pageRow.body }))
      .resolves.toMatchObject({ replayed: false, page: { currentRevision: 1 } });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO wiki_page_revisions"))).toBe(true);
  });

  it("accepts exact operation replay and rejects the same key with different content", async () => {
    const replay = { ...pageRow, operation_key: operationKey, revision: 1 };
    const exact = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [replay] }).mockResolvedValueOnce({ rows: [] });
    await expect(new WikiService(transactionalPool(exact)).create("account", {
      operationKey, slug: pageRow.slug, title: pageRow.title, summary: pageRow.summary, body: pageRow.body
    })).resolves.toMatchObject({ replayed: true });

    const conflict = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [replay] }).mockResolvedValueOnce({ rows: [] });
    await expect(new WikiService(transactionalPool(conflict)).create("account", {
      operationKey, slug: pageRow.slug, title: "Changed", summary: pageRow.summary, body: pageRow.body
    })).rejects.toMatchObject({ code: "WIKI_OPERATION_CONFLICT", statusCode: 409 });
  });

  it("atomically rejects stale revisions while retaining the stored page", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ ...pageRow, current_revision: 2 }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(new WikiService(transactionalPool(query)).update("account", pageRow.slug, {
      operationKey, expectedRevision: 1, title: pageRow.title, summary: pageRow.summary, body: pageRow.body
    })).rejects.toMatchObject({ code: "WIKI_STALE_REVISION", statusCode: 409 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE wiki_pages"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("ROLLBACK"))).toBe(true);
  });

  it("requires an existing active player account for collaborator grants", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const service = new WikiService({ query } as unknown as pg.Pool);
    await expect(service.setCollaborator("owner", "missing", "editor"))
      .rejects.toMatchObject({ code: "WIKI_PLAYER_NOT_FOUND" });
    expect(query.mock.calls[0]?.[0]).toContain("account.status='active'");
  });
});
