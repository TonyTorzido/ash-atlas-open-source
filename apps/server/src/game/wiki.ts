import type {
  CreateWikiPageRequest,
  UpdateWikiPageRequest,
  WikiAccess,
  WikiCollaborator,
  WikiMutationResponse,
  WikiPage,
  WikiPageListResponse,
  WikiPlayerSearchResult,
  WikiCollaboratorRole
} from "@ash-atlas/shared";
import type pg from "pg";

type PageRow = {
  id: string; slug: string; title: string; summary: string; body: string;
  current_revision: number; created_at: Date; updated_at: Date;
};
type RevisionRow = PageRow & { operation_key: string; revision: number };

export class WikiError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message); this.name = "WikiError";
  }
}

export class WikiService {
  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<WikiPageListResponse> {
    const result = await this.pool.query<PageRow>(
      `SELECT id, slug, title, summary, body, current_revision, created_at, updated_at
       FROM wiki_pages ORDER BY title COLLATE "C", slug LIMIT 100`
    );
    return { pages: result.rows.map((row) => ({
      slug: row.slug, title: row.title, summary: row.summary,
      currentRevision: row.current_revision, updatedAt: row.updated_at.toISOString()
    })) };
  }

  async get(slug: string): Promise<WikiPage> {
    const result = await this.pool.query<PageRow>(
      `SELECT id, slug, title, summary, body, current_revision, created_at, updated_at
       FROM wiki_pages WHERE slug = $1`, [slug]
    );
    if (!result.rows[0]) throw new WikiError("WIKI_PAGE_NOT_FOUND", "Wiki page was not found", 404);
    return pageFromRow(result.rows[0]);
  }

  async access(accountId: string, implicitOwner: boolean): Promise<WikiAccess> {
    if (implicitOwner) return "owner";
    const result = await this.pool.query<{ role: WikiAccess }>(
      `SELECT role FROM wiki_collaborators WHERE account_id = $1`, [accountId]
    );
    return result.rows[0]?.role ?? "none";
  }

  async create(actorAccountId: string, input: CreateWikiPageRequest): Promise<WikiMutationResponse> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [input.operationKey]);
      const replay = await this.replayForOperation(client, input.operationKey);
      if (replay) {
        if (replay.revision !== 1 || replay.slug !== input.slug || replay.title !== input.title || replay.summary !== input.summary || replay.body !== input.body) {
          throw new WikiError("WIKI_OPERATION_CONFLICT", "Operation key was already used with different content", 409);
        }
        await client.query("COMMIT");
        return { page: pageFromRow(replay), replayed: true };
      }
      const inserted = await client.query<PageRow>(
        `INSERT INTO wiki_pages (slug, title, summary, body, created_by_account_id, updated_by_account_id)
         VALUES ($1,$2,$3,$4,$5,$5)
         RETURNING id, slug, title, summary, body, current_revision, created_at, updated_at`,
        [input.slug, input.title, input.summary, input.body, actorAccountId]
      );
      const page = inserted.rows[0]!;
      await client.query(
        `INSERT INTO wiki_page_revisions (page_id, revision, slug, title, summary, body, editor_account_id, operation_key)
         VALUES ($1,1,$2,$3,$4,$5,$6,$7)`,
        [page.id, page.slug, page.title, page.summary, page.body, actorAccountId, input.operationKey]
      );
      await client.query("COMMIT");
      return { page: pageFromRow(page), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (isPgUnique(error, "wiki_pages_slug_key")) throw new WikiError("WIKI_SLUG_CONFLICT", "A wiki page already uses this slug", 409);
      throw error;
    } finally { client.release(); }
  }

  async update(actorAccountId: string, slug: string, input: UpdateWikiPageRequest): Promise<WikiMutationResponse> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [input.operationKey]);
      const replay = await this.replayForOperation(client, input.operationKey);
      if (replay) {
        if (replay.slug !== slug || replay.revision !== input.expectedRevision + 1 || replay.title !== input.title || replay.summary !== input.summary || replay.body !== input.body) {
          throw new WikiError("WIKI_OPERATION_CONFLICT", "Operation key was already used with different content", 409);
        }
        await client.query("COMMIT");
        return { page: pageFromRow(replay), replayed: true };
      }
      const selected = await client.query<PageRow>(
        `SELECT id, slug, title, summary, body, current_revision, created_at, updated_at
         FROM wiki_pages WHERE slug = $1 FOR UPDATE`, [slug]
      );
      const current = selected.rows[0];
      if (!current) throw new WikiError("WIKI_PAGE_NOT_FOUND", "Wiki page was not found", 404);
      if (current.current_revision !== input.expectedRevision) {
        throw new WikiError("WIKI_STALE_REVISION", "This page changed while you were editing. Reload it before retrying.", 409);
      }
      const updated = await client.query<PageRow>(
        `UPDATE wiki_pages SET title=$2, summary=$3, body=$4,
           current_revision=current_revision+1, updated_by_account_id=$5, updated_at=now()
         WHERE id=$1 RETURNING id, slug, title, summary, body, current_revision, created_at, updated_at`,
        [current.id, input.title, input.summary, input.body, actorAccountId]
      );
      const page = updated.rows[0]!;
      await client.query(
        `INSERT INTO wiki_page_revisions (page_id, revision, slug, title, summary, body, editor_account_id, operation_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [page.id, page.current_revision, page.slug, page.title, page.summary, page.body, actorAccountId, input.operationKey]
      );
      await client.query("COMMIT");
      return { page: pageFromRow(page), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async searchPlayers(query: string): Promise<WikiPlayerSearchResult[]> {
    const result = await this.pool.query<{ account_id: string; username: string }>(
      `SELECT player.account_id, player.username FROM players player
       JOIN accounts account ON account.id = player.account_id
       WHERE account.status = 'active' AND player.account_id IS NOT NULL
         AND player.username ILIKE $1
       ORDER BY player.username COLLATE "C", player.id LIMIT 20`, [`%${query}%`]
    );
    return result.rows.map((row) => ({ accountId: row.account_id, playerName: row.username }));
  }

  async listCollaborators(): Promise<WikiCollaborator[]> {
    const result = await this.pool.query<{ account_id: string; username: string; role: WikiCollaboratorRole; granted_at: Date }>(
      `SELECT collaborator.account_id, player.username, collaborator.role, collaborator.granted_at
       FROM wiki_collaborators collaborator JOIN players player ON player.account_id=collaborator.account_id
       ORDER BY collaborator.role, player.username COLLATE "C" LIMIT 100`
    );
    return result.rows.map((row) => ({ accountId: row.account_id, playerName: row.username, role: row.role, grantedAt: row.granted_at.toISOString() }));
  }

  async setCollaborator(actorAccountId: string, accountId: string, role: WikiCollaboratorRole): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO wiki_collaborators (account_id, role, granted_by_account_id)
       SELECT account.id, $2, $3 FROM accounts account JOIN players player ON player.account_id=account.id
       WHERE account.id=$1 AND account.status='active'
       ON CONFLICT (account_id) DO UPDATE SET role=EXCLUDED.role, granted_by_account_id=EXCLUDED.granted_by_account_id, granted_at=now()
       RETURNING account_id`, [accountId, role, actorAccountId]
    );
    if (!result.rows[0]) throw new WikiError("WIKI_PLAYER_NOT_FOUND", "An active player account is required", 404);
  }

  async removeCollaborator(accountId: string): Promise<void> {
    await this.pool.query(`DELETE FROM wiki_collaborators WHERE account_id=$1`, [accountId]);
  }

  private async replayForOperation(client: pg.PoolClient, operationKey: string): Promise<RevisionRow | null> {
    const result = await client.query<RevisionRow>(
      `SELECT page.id, revision.slug, revision.title, revision.summary, revision.body,
              revision.revision, revision.revision AS current_revision, page.created_at,
              revision.created_at AS updated_at, revision.operation_key
       FROM wiki_page_revisions revision JOIN wiki_pages page ON page.id=revision.page_id
       WHERE revision.operation_key=$1`, [operationKey]
    );
    return result.rows[0] ?? null;
  }
}

function pageFromRow(row: PageRow): WikiPage {
  return { slug: row.slug, title: row.title, summary: row.summary, body: row.body,
    currentRevision: row.current_revision, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
function isPgUnique(error: unknown, constraint: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "23505"
    && "constraint" in error && (error as { constraint: unknown }).constraint === constraint;
}
