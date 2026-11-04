import {
  CHAT_CRESTS,
  DEFAULT_CHAT_CREST_ID,
  normalizeChatCrestId,
  type ChatCrestDefinition,
  type ChatCrestId,
  type ChatCrestSelection
} from "@ash-atlas/shared";
import type pg from "pg";

type Queryable = Pick<pg.Pool, "query">;

/**
 * Future achievements, events, or purchases can replace this resolver without
 * changing the chat API or the message projection contract.
 */
export type ChatCrestEntitlementResolver = Readonly<{
  isEntitled(playerId: string, crestId: ChatCrestId): Promise<boolean>;
}>;

export class StarterChatCrestEntitlements implements ChatCrestEntitlementResolver {
  async isEntitled(playerId: string, crestId: ChatCrestId): Promise<boolean> {
    void playerId;
    return CHAT_CRESTS.some((crest) => crest.id === crestId);
  }
}

export class ChatCrestError extends Error {
  constructor(
    readonly code: "CHAT_CREST_INVALID" | "CHAT_CREST_NOT_AVAILABLE" | "CHAT_CREST_PLAYER_REQUIRED",
    message: string,
    readonly statusCode: 400 | 409
  ) {
    super(message);
    this.name = "ChatCrestError";
  }
}

type EquippedCrestRow = { equipped_chat_crest_id: string | null };

export class ChatCrestService {
  constructor(
    private readonly pool: Queryable,
    private readonly entitlements: ChatCrestEntitlementResolver = new StarterChatCrestEntitlements()
  ) {}

  async selectionFor(playerId: string): Promise<ChatCrestSelection> {
    assertPlayer(playerId);
    const [available, equipped] = await Promise.all([
      Promise.all(CHAT_CRESTS.map(async (crest) =>
        await this.entitlements.isEntitled(playerId, crest.id) ? crest : null
      )),
      this.pool.query<EquippedCrestRow>(
        `SELECT equipped_chat_crest_id
           FROM player_profiles
          WHERE player_id = $1`,
        [playerId]
      )
    ]);
    const crests = available.filter((crest): crest is ChatCrestDefinition => crest !== null);
    const equippedId = normalizeChatCrestId(equipped.rows[0]?.equipped_chat_crest_id);
    return {
      crests,
      equippedCrestId: crests.some((crest) => crest.id === equippedId)
        ? equippedId
        : crests[0]?.id ?? DEFAULT_CHAT_CREST_ID
    };
  }

  async equip(playerId: string, crestId: unknown): Promise<ChatCrestSelection> {
    assertPlayer(playerId);
    if (typeof crestId !== "string" || !CHAT_CRESTS.some((crest) => crest.id === crestId)) {
      throw new ChatCrestError("CHAT_CREST_INVALID", "Choose a registered chat crest.", 400);
    }
    const selected = crestId as ChatCrestId;
    if (!(await this.entitlements.isEntitled(playerId, selected))) {
      throw new ChatCrestError("CHAT_CREST_NOT_AVAILABLE", "That chat crest is not available.", 409);
    }
    await this.pool.query(
      `INSERT INTO player_profiles (player_id, equipped_chat_crest_id)
       VALUES ($1, $2)
       ON CONFLICT (player_id) DO UPDATE
         SET equipped_chat_crest_id = EXCLUDED.equipped_chat_crest_id`,
      [playerId, selected]
    );
    return this.selectionFor(playerId);
  }

  async crestIdForPlayer(playerId: string): Promise<ChatCrestId> {
    if (!playerId) return DEFAULT_CHAT_CREST_ID;
    const result = await this.pool.query<EquippedCrestRow>(
      `SELECT equipped_chat_crest_id
         FROM player_profiles
        WHERE player_id = $1`,
      [playerId]
    );
    return normalizeChatCrestId(result.rows[0]?.equipped_chat_crest_id);
  }
}

function assertPlayer(playerId: string): void {
  if (!playerId) {
    throw new ChatCrestError(
      "CHAT_CREST_PLAYER_REQUIRED",
      "Choose a character before selecting a chat crest.",
      409
    );
  }
}
