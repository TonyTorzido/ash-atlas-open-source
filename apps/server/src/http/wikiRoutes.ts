import {
  createWikiPageRequestSchema,
  setWikiCollaboratorRequestSchema,
  updateWikiPageRequestSchema,
  wikiSlugSchema
} from "@ash-atlas/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { hasDeveloperCapability } from "../auth/developerAuthorization.js";
import { requireRequestSession, sendAuthError } from "../auth/authGuard.js";
import { AuthError } from "../auth/types.js";
import type { AppConfig } from "../config.js";
import { WikiError, type WikiService } from "../game/wiki.js";
import { builtInWikiContent } from "../wiki/builtInWiki.js";
import { sendError } from "./errors.js";

export function registerWikiRoutes(app: FastifyInstance, config: AppConfig, wiki: WikiService): void {
  app.get("/api/wiki", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (_request, reply) => {
    try { return { ...await wiki.list(), builtIn: builtInWikiContent() }; } catch { return sendError(reply, 503, "WIKI_UNAVAILABLE", "The wiki is temporarily unavailable"); }
  });
  app.get("/api/wiki/:slug", { config: { rateLimit: { max: 90, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = z.object({ slug: wikiSlugSchema }).safeParse(request.params);
    if (!parsed.success) return sendError(reply, 400, "WIKI_SLUG_INVALID", "Wiki slug is invalid");
    try { return await wiki.get(parsed.data.slug); } catch (error) { return wikiFailure(reply, error); }
  });
  app.get("/api/wiki-access", async (request, reply) => {
    try {
      const session = requireRequestSession(request);
      const implicitDeveloperOwner = hasDeveloperCapability(config, session, "developer:wiki-manage");
      return { access: await wiki.access(session.account.id, implicitDeveloperOwner), implicitDeveloperOwner };
    } catch (error) { return wikiFailure(reply, error); }
  });
  app.post("/api/wiki", { bodyLimit: 262_144, config: { rateLimit: { max: 12, timeWindow: "1 minute" } } }, async (request, reply) => {
    const input = createWikiPageRequestSchema.safeParse(request.body);
    if (!input.success) return sendError(reply, 400, "WIKI_PAGE_INVALID", "Wiki page content is invalid");
    try {
      const session = await requireEditor(request, reply, wiki, config); if (!session) return;
      return await wiki.create(session.account.id, input.data);
    } catch (error) { return wikiFailure(reply, error); }
  });
  app.put("/api/wiki/:slug", { bodyLimit: 262_144, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const params = z.object({ slug: wikiSlugSchema }).safeParse(request.params);
    const input = updateWikiPageRequestSchema.safeParse(request.body);
    if (!params.success || !input.success) return sendError(reply, 400, "WIKI_PAGE_INVALID", "Wiki page content is invalid");
    try {
      const session = await requireEditor(request, reply, wiki, config); if (!session) return;
      return await wiki.update(session.account.id, params.data.slug, input.data);
    } catch (error) { return wikiFailure(reply, error); }
  });
  app.get("/api/wiki-team", async (request, reply) => {
    try {
      if (!await requireOwner(request, reply, wiki, config)) return;
      return { collaborators: await wiki.listCollaborators() };
    } catch (error) { return wikiFailure(reply, error); }
  });
  app.get("/api/wiki-team/players", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = z.object({ q: z.string().trim().min(2).max(40) }).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "WIKI_SEARCH_INVALID", "Enter at least two characters");
    try {
      if (!await requireOwner(request, reply, wiki, config)) return;
      return { players: await wiki.searchPlayers(parsed.data.q) };
    } catch (error) { return wikiFailure(reply, error); }
  });
  app.put("/api/wiki-team/:accountId", { bodyLimit: 1024, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const params = z.object({ accountId: z.string().uuid() }).safeParse(request.params);
    const input = setWikiCollaboratorRequestSchema.safeParse(request.body);
    if (!params.success || !input.success || params.data.accountId !== input.data.accountId) return sendError(reply, 400, "WIKI_COLLABORATOR_INVALID", "Collaborator is invalid");
    try {
      const session = await requireOwner(request, reply, wiki, config); if (!session) return;
      await wiki.setCollaborator(session.account.id, input.data.accountId, input.data.role); return { ok: true };
    } catch (error) { return wikiFailure(reply, error); }
  });
  app.delete("/api/wiki-team/:accountId", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const params = z.object({ accountId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "WIKI_COLLABORATOR_INVALID", "Collaborator is invalid");
    try {
      if (!await requireOwner(request, reply, wiki, config)) return;
      await wiki.removeCollaborator(params.data.accountId); return { ok: true };
    } catch (error) { return wikiFailure(reply, error); }
  });
}

async function requireEditor(request: FastifyRequest, reply: FastifyReply, wiki: WikiService, config: AppConfig) {
  const session = requireRequestSession(request);
  const access = await wiki.access(session.account.id, hasDeveloperCapability(config, session, "developer:wiki-manage"));
  if (access === "none") { sendError(reply, 403, "WIKI_EDIT_FORBIDDEN", "Wiki editor access is required"); return null; }
  return session;
}
async function requireOwner(request: FastifyRequest, reply: FastifyReply, wiki: WikiService, config: AppConfig) {
  const session = requireRequestSession(request);
  const access = await wiki.access(session.account.id, hasDeveloperCapability(config, session, "developer:wiki-manage"));
  if (access !== "owner") { sendError(reply, 403, "WIKI_OWNER_FORBIDDEN", "Wiki owner access is required"); return null; }
  return session;
}
function wikiFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) return sendAuthError(reply, error);
  if (error instanceof WikiError) return sendError(reply, error.statusCode, error.code, error.message);
  return sendError(reply, 503, "WIKI_UNAVAILABLE", "The wiki is temporarily unavailable");
}
