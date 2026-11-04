/*
 * Atlas Animator: original implementation.
 *
 * The CLI's client for the Appearance Studio bridge (plan 4.3): when the Studio is open, edits go
 * through `POST /api/animator/commands` so the user sees them land live; the bridge applies them
 * with the same command bus and log as the CLI's direct path. Authenticates like the Studio UI:
 * reads the session (origin + CSRF token) from `GET /api/session`, then sends both on writes.
 */
import { relative, resolve, sep } from "node:path";

export interface BridgeSession {
  base: string;
  origin: string;
  csrfToken: string;
  worktreePath: string;
}

export async function openBridgeSession(base: string): Promise<BridgeSession> {
  const url = base.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${url}/api/session`);
  } catch (error) {
    throw new Error(`cannot reach the Studio bridge at ${url} (${error instanceof Error ? error.message : String(error)}); is the Studio open?`);
  }
  if (!response.ok) throw new Error(`Studio bridge session failed: HTTP ${response.status}`);
  const session = (await response.json()) as { origin?: string; csrfToken?: string; workspace?: { worktreePath?: string } };
  if (!session.origin || !session.csrfToken || !session.workspace?.worktreePath) throw new Error("Studio bridge session is missing origin, token or worktree");
  return { base: url, origin: session.origin, csrfToken: session.csrfToken, worktreePath: session.workspace.worktreePath };
}

/** The document path as the bridge names it: relative to the Studio's worktree, '/' separated. */
export function bridgeDocumentPath(session: BridgeSession, path: string): string {
  const rel = relative(resolve(session.worktreePath), resolve(path));
  if (rel.startsWith("..") || resolve(rel) === rel) throw new Error(`${path} is outside the Studio's worktree ${session.worktreePath}`);
  return rel.split(sep).join("/");
}

export async function bridgePost<T>(session: BridgeSession, route: string, body: unknown): Promise<T> {
  const response = await fetch(`${session.base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: session.origin, "x-appearance-studio-token": session.csrfToken },
    body: JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(`Studio bridge ${route}: ${payload.error ?? `HTTP ${response.status}`}`);
  return payload;
}
