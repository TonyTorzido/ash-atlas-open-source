import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/types.js";
import type { AppConfig } from "../config.js";
import { WikiError } from "../game/wiki.js";
import { registerWikiRoutes } from "./wikiRoutes.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("wiki routes", () => {
  it("serves bounded public reads and denies unauthenticated mutation", async () => {
    const { app, wiki } = await fixture();
    expect((await app.inject({ method: "GET", url: "/api/wiki" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/wiki/getting-started" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/wiki", payload: validCreate() })).statusCode).toBe(401);
    expect(wiki.create).not.toHaveBeenCalled();
  });

  it("merges the built-in articles into the list read, and keeps provenance out of it", async () => {
    const { app } = await fixture();
    const body = (await app.inject({ method: "GET", url: "/api/wiki" })).json();
    expect(body.pages).toEqual([]);
    expect(body.builtIn.articles.map((article: { slug: string }) => article.slug)).toContain("getting-started/controls");
    expect(body.builtIn.categories).toHaveLength(6);
    expect(JSON.stringify(body)).toContain("Keep this page open while you play");
    expect(JSON.stringify(body)).not.toContain("sourcePath");
  });

  it("allows editors to mutate content but not manage the team", async () => {
    const { app, wiki } = await fixture("editor");
    expect((await app.inject({ method: "POST", url: "/api/wiki", headers: { "x-test-auth": "editor" }, payload: validCreate() })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/wiki-team", headers: { "x-test-auth": "editor" } })).statusCode).toBe(403);
    expect(wiki.create).toHaveBeenCalledOnce(); expect(wiki.listCollaborators).not.toHaveBeenCalled();
  });

  it("accepts the maximum Unicode article within the bounded transport envelope", async () => {
    const { app, wiki } = await fixture("editor");
    const result = await app.inject({
      method: "POST", url: "/api/wiki", headers: { "x-test-auth": "editor" },
      payload: { ...validCreate(), body: "界".repeat(50_000) }
    });
    expect(result.statusCode).toBe(200);
    expect(wiki.create).toHaveBeenCalledOnce();
  });

  it("allows stored owners and implicit developer owners to manage collaborators", async () => {
    const stored = await fixture("owner");
    expect((await stored.app.inject({ method: "GET", url: "/api/wiki-team", headers: { "x-test-auth": "owner" } })).statusCode).toBe(200);
    const developer = await fixture("none", "developer-subject");
    expect((await developer.app.inject({ method: "GET", url: "/api/wiki-team", headers: { "x-test-auth": "developer" } })).statusCode).toBe(200);
  });

  it("returns stale conflicts and successful exact replay results", async () => {
    const stale = await fixture("editor");
    stale.wiki.update.mockRejectedValueOnce(new WikiError("WIKI_STALE_REVISION", "Reload before retrying", 409));
    const staleResponse = await stale.app.inject({ method: "PUT", url: "/api/wiki/getting-started", headers: { "x-test-auth": "editor" }, payload: validUpdate() });
    expect(staleResponse.statusCode).toBe(409); expect(staleResponse.json().error.code).toBe("WIKI_STALE_REVISION");
    stale.wiki.update.mockResolvedValueOnce({ page: page, replayed: true });
    const replay = await stale.app.inject({ method: "PUT", url: "/api/wiki/getting-started", headers: { "x-test-auth": "editor" }, payload: validUpdate() });
    expect(replay.statusCode).toBe(200); expect(replay.json().replayed).toBe(true);
  });
});

const page = { slug: "getting-started", title: "Getting Started", summary: "Begin", body: "Welcome", currentRevision: 1, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
function validCreate() { return { operationKey: "11111111-1111-4111-8111-111111111111", slug: page.slug, title: page.title, summary: page.summary, body: page.body }; }
function validUpdate() { return { operationKey: "11111111-1111-4111-8111-111111111111", expectedRevision: 1, title: page.title, summary: page.summary, body: page.body }; }

async function fixture(storedAccess: "none" | "editor" | "owner" = "none", developerSubject?: string) {
  const app = Fastify(); apps.push(app); app.decorateRequest("authSession", null);
  app.addHook("preHandler", async (request) => { request.authSession = request.headers["x-test-auth"] ? session(request.headers["x-test-auth"] === "developer" ? developerSubject ?? null : null) : null; });
  app.setErrorHandler((error, _request, reply) => { if (error instanceof Error && error.name === "AuthError") reply.code(401).send({ error: { code: "AUTHENTICATION_REQUIRED" } }); else reply.send(error); });
  const wiki = {
    list: vi.fn(async () => ({ pages: [] })), get: vi.fn(async () => page),
    access: vi.fn(async (_account: string, implicit: boolean) => implicit ? "owner" : storedAccess),
    create: vi.fn(async () => ({ page, replayed: false })), update: vi.fn(async () => ({ page, replayed: false })),
    listCollaborators: vi.fn(async () => []), searchPlayers: vi.fn(async () => []),
    setCollaborator: vi.fn(async () => undefined), removeCollaborator: vi.fn(async () => undefined)
  };
  registerWikiRoutes(app, {
    TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS: [], DEV_AUTHORIZED_GOOGLE_SUBJECTS: developerSubject ? [developerSubject] : [],
    DEV_TOOLS_ENABLED: false, DEV_PRIVATE_LEADERBOARD_GOOGLE_SUBJECTS: [], DEV_ADMIN_TOOLS_ENABLED: false
  } as unknown as AppConfig, wiki as never);
  await app.ready(); return { app, wiki };
}
function session(subject: string | null): AuthenticatedSession {
  return { sessionId: "session", verifiedGoogleSubject: subject, verifiedEmail: "player@example.com", account: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "active", trustTier: "new", riskScore: 0, testAccessStatus: "approved", testAccessRequestedAt: new Date(), testAccessDecidedAt: new Date(), createdAt: new Date(), lastLoginAt: null }, player: null, deviceInstallationId: null, csrfToken: "csrf" };
}
