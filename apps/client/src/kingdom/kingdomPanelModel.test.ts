import type { KingdomChatMessage, KingdomMemberSnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  MAX_KINGDOM_CHAT_HISTORY,
  kingdomErrorMessage,
  mayModerateMember,
  mergeKingdomChatHistory,
  nextSelectedKingdomId,
  normalizeKingdomChatDraft
} from "./kingdomPanelModel.js";

describe("Kingdom panel model", () => {
  it("rejects blank or oversized chat and trims accepted content", () => {
    expect(normalizeKingdomChatDraft("  ")).toBeNull();
    expect(normalizeKingdomChatDraft(` ${"x".repeat(500)} `)).toBe("x".repeat(500));
    expect(normalizeKingdomChatDraft("x".repeat(501))).toBeNull();
  });

  it("deduplicates server messages and retains the newest bounded history", () => {
    const history = Array.from({ length: MAX_KINGDOM_CHAT_HISTORY + 5 }, (_, index) =>
      message(`message-${index}`, index)
    );
    const merged = mergeKingdomChatHistory(history, [
      message("message-104", 104, "authoritative replacement"),
      message("message-105", 105)
    ]);

    expect(merged).toHaveLength(MAX_KINGDOM_CHAT_HISTORY);
    expect(merged[0]?.id).toBe("message-6");
    expect(merged.at(-2)?.content).toBe("authoritative replacement");
    expect(new Set(merged.map((item) => item.id)).size).toBe(merged.length);
  });

  it("permits moderation only down the role hierarchy", () => {
    expect(mayModerateMember(member("leader", "leader"), member("officer", "officer"))).toBe(true);
    expect(mayModerateMember(member("officer", "officer"), member("leader", "leader"))).toBe(false);
    expect(mayModerateMember(member("officer", "same"), member("member", "same"))).toBe(false);
  });

  it("maps required server rejection codes to actionable guidance", () => {
    expect(kingdomErrorMessage("KINGDOM_WORLD_AUTHORITY_UNAVAILABLE", "fallback"))
      .toContain("World land authority is unavailable");
    expect(kingdomErrorMessage("UNKNOWN", "fallback")).toBe("fallback");
    expect(kingdomErrorMessage("KINGDOM_TERRITORY_OVERLAP", "fallback"))
      .toContain("another active Kingdom");
    expect(kingdomErrorMessage("KINGDOM_SEAT_TOO_CLOSE", "fallback"))
      .toContain("Castle");
    expect(kingdomErrorMessage("KINGDOM_PENDING_RESERVATION_CONFLICT", "fallback"))
      .toContain("pending Castle construction reservation");
    expect(kingdomErrorMessage("KINGDOM_FLAG_TERRITORY_OVERLAP", "fallback"))
      .toContain("Kingdom Flag territory");
    expect(kingdomErrorMessage("KINGDOM_ADVANCEMENT_INSUFFICIENT_TREASURY", "fallback"))
      .toContain("required project resources");
  });

  it("preserves an explicit foreign Kingdom selection when private state refreshes", () => {
    expect(nextSelectedKingdomId("foreign-kingdom", "own-kingdom"))
      .toBe("foreign-kingdom");
    expect(nextSelectedKingdomId(null, "own-kingdom")).toBe("own-kingdom");
    expect(nextSelectedKingdomId(null, null)).toBeNull();
  });
});

function message(id: string, second: number, content = id): KingdomChatMessage {
  return {
    id,
    kingdomId: "kingdom-1",
    senderPlayerId: "player-1",
    senderDisplayName: "Scout",
    content,
    createdAt: new Date(second * 1_000).toISOString()
  };
}

function member(role: KingdomMemberSnapshot["role"], playerId: string): KingdomMemberSnapshot {
  return {
    membershipId: `${playerId}-membership`,
    playerId,
    displayName: playerId,
    role,
    status: "active",
    joinedAt: "2026-07-10T00:00:00.000Z",
    endedAt: null,
    perkQualifiedAt: "2026-07-10T00:05:00.000Z",
    chatMutedUntil: null,
    chatMute: { state: "not_muted" }
  };
}
