import { randomUUID } from "node:crypto";

import {
  DUNGEON_TORCH_MEMBER_MIN,
  DUNGEON_TORCH_TOTAL_MAX,
  DUNGEON_TORCH_TOTAL_MIN,
  describeDungeonEntryCost,
  distanceMeters,
  type DungeonTorchLobbySnapshot,
  type LatLon,
  type ServerMessage
} from "@ash-atlas/shared";

import { DungeonError, type DungeonRuntime, type DungeonTorchEntry } from "../game/dungeon.js";
import type { PartyAuthority } from "../game/party/PartyAuthority.js";

/** Members join the lobby at or near the entrance (tunable). */
export const DUNGEON_TORCH_LOBBY_JOIN_RADIUS_M = 300;
/** A started lobby stays visible this long so members (and reconnects) see it and enter. */
const STARTED_LOBBY_RETENTION_MS = 60_000;

type LobbyConnectionPort = {
  send(playerId: string, message: ServerMessage): unknown;
};

type LobbyMember = {
  playerId: string; name: string; torches: number; ready: boolean;
  /** What one torch costs this member (their own Atlas Pass discount): what they see and pay. */
  entryCost: DungeonTorchEntry["entryCost"];
};

type Lobby = {
  lobbyId: string;
  entry: DungeonTorchEntry;
  status: "open" | "starting" | "started";
  revision: number;
  /** Insertion order is display order; the opener first. */
  members: Map<string, LobbyMember>;
  message: string | null;
  cleanup: NodeJS.Timeout | null;
};

export type DungeonTorchLobbyDependencies = Readonly<{
  dungeon: Pick<DungeonRuntime, "torchEntryFor" | "startTorchRun" | "authorizeEntryGates">;
  parties: Pick<PartyAuthority, "partyForPlayer">;
  connections: LobbyConnectionPort;
  playerName: (playerId: string) => string | null;
  playerPosition: (playerId: string) => LatLon | null;
  /** Read-only pack check for a quick refusal; the start transaction is the authoritative charge. */
  canAfford?: (playerId: string, items: ReadonlyArray<Readonly<{ itemId: string; quantity: number }>>) => Promise<boolean>;
}>;

/**
 * Torch lobbies at dungeon entrances (WP16), one per dungeon instance (the party's, or a solo player's).
 * Members pick how many torches they burn and ready up; any torch or membership change clears every
 * ready state; the party leader (or the solo player) starts the run, which charges everyone atomically
 * through DungeonRuntime.startTorchRun. In-memory only: nothing is paid until start commits.
 * Late joiners enter a paid or running run free and never change its torch total (no adding mid-run).
 */
export class DungeonTorchLobbyService {
  private readonly lobbies = new Map<string, Lobby>();
  private readonly playerLobbies = new Map<string, Lobby>();

  constructor(private readonly deps: DungeonTorchLobbyDependencies) {}

  async join(playerId: string, entranceId: string, requestId: string): Promise<void> {
    const entry = await this.deps.dungeon.torchEntryFor(playerId, entranceId);
    if (!entry) throw new DungeonError("TORCH_LOBBY_UNAVAILABLE", "This entrance burns no torches.");
    const position = this.deps.playerPosition(playerId);
    if (position && distanceMeters(position, entry.position) >
        Math.max(DUNGEON_TORCH_LOBBY_JOIN_RADIUS_M, entry.interactionRadiusM)) {
      throw new DungeonError("TORCH_LOBBY_TOO_FAR", `Walk to the ${entry.dungeonName} entrance to light torches.`);
    }
    const key = lobbyKey(entry);
    const existing = this.lobbies.get(key);
    if (existing && existing.status !== "open") {
      this.sendTo(playerId, this.snapshot(existing, playerId), requestId);
      return;
    }
    if (!existing && entry.paid) {
      // A run is paid or under way (or, in a shared Forge, this player's entry is paid): enter free.
      this.leaveCurrent(playerId, key);
      this.sendTo(playerId, this.inProgressSnapshot(entry, playerId), requestId);
      return;
    }
    await this.deps.dungeon.authorizeEntryGates(playerId, entranceId);
    this.leaveCurrent(playerId, key);
    let lobby = this.lobbies.get(key);
    if (lobby && lobby.status !== "open") {
      this.sendTo(playerId, this.snapshot(lobby, playerId), requestId);
      return;
    }
    if (!lobby) {
      lobby = { lobbyId: randomUUID(), entry, status: "open", revision: 0, members: new Map(), message: null, cleanup: null };
      this.lobbies.set(key, lobby);
    }
    if (!lobby.members.has(playerId)) {
      // The opener lights one torch so a solo run is one tap; later members start at the minimum.
      lobby.members.set(playerId, { playerId, name: this.deps.playerName(playerId) ?? "Player",
        torches: lobby.members.size === 0 ? DUNGEON_TORCH_TOTAL_MIN : DUNGEON_TORCH_MEMBER_MIN, ready: false,
        entryCost: entry.entryCost });
      this.playerLobbies.set(playerId, lobby);
      this.changed(lobby);
    }
    this.publish(lobby, playerId, requestId);
  }

  async setTorches(playerId: string, lobbyId: string, torches: number, requestId: string): Promise<void> {
    const lobby = this.requireOpenMember(playerId, lobbyId);
    const member = lobby.members.get(playerId)!;
    if (!Number.isInteger(torches) || torches < DUNGEON_TORCH_MEMBER_MIN || torches > DUNGEON_TORCH_TOTAL_MAX) {
      throw new DungeonError("DUNGEON_TORCHES_INVALID", "Pick a whole number of torches.");
    }
    if (this.total(lobby) - member.torches + torches > DUNGEON_TORCH_TOTAL_MAX) {
      throw new DungeonError("DUNGEON_TORCHES_INVALID", `The party can burn at most ${DUNGEON_TORCH_TOTAL_MAX} torches.`);
    }
    if (torches > member.torches && this.deps.canAfford) {
      const cost = torchCost(member.entryCost, torches);
      if (!await this.deps.canAfford(playerId, cost)) {
        throw new DungeonError("DUNGEON_ENTRY_COST_UNAFFORDABLE",
          `${torches} ${torches === 1 ? "torch costs" : "torches cost"} ${describeDungeonEntryCost(cost)}.`);
      }
    }
    // Re-check after the pack read: the lobby may have started, closed or changed meanwhile.
    const current = this.requireOpenMember(playerId, lobbyId);
    const currentMember = current.members.get(playerId)!;
    if (this.total(current) - currentMember.torches + torches > DUNGEON_TORCH_TOTAL_MAX) {
      throw new DungeonError("DUNGEON_TORCHES_INVALID", `The party can burn at most ${DUNGEON_TORCH_TOTAL_MAX} torches.`);
    }
    if (currentMember.torches !== torches) {
      currentMember.torches = torches;
      this.changed(current);
    }
    this.publish(current, playerId, requestId);
  }

  setReady(playerId: string, lobbyId: string, ready: boolean, requestId: string): void {
    const lobby = this.requireOpenMember(playerId, lobbyId);
    lobby.members.get(playerId)!.ready = ready;
    lobby.revision += 1;
    this.publish(lobby, playerId, requestId);
  }

  async start(playerId: string, lobbyId: string, requestId: string): Promise<void> {
    const lobby = this.findLobby(lobbyId);
    if (lobby && lobby.status !== "open" && lobby.members.has(playerId)) {
      // A repeated start while charging or after it changes nothing.
      this.sendTo(playerId, this.snapshot(lobby, playerId), requestId);
      return;
    }
    const open = this.requireOpenMember(playerId, lobbyId);
    const leader = this.leaderOf(open);
    if (leader !== playerId) {
      throw new DungeonError("TORCH_LOBBY_NOT_LEADER", "Only the party leader can start the run.");
    }
    const waiting = [...open.members.values()].filter((member) => member.playerId !== playerId && !member.ready);
    if (waiting.length > 0) {
      throw new DungeonError("TORCH_LOBBY_NOT_READY", `Waiting for ${waiting.map((member) => member.name).join(", ")} to ready up.`);
    }
    const total = this.total(open);
    if (total < DUNGEON_TORCH_TOTAL_MIN || total > DUNGEON_TORCH_TOTAL_MAX) {
      throw new DungeonError("DUNGEON_TORCHES_INVALID",
        `The party burns ${DUNGEON_TORCH_TOTAL_MIN} to ${DUNGEON_TORCH_TOTAL_MAX} torches in total.`);
    }
    open.status = "starting";
    open.message = null;
    open.revision += 1;
    this.publish(open);
    try {
      await this.deps.dungeon.startTorchRun({
        entranceId: open.entry.entranceId,
        members: [...open.members.values()].map(({ playerId: id, name, torches }) => ({ playerId: id, name, torches })),
        ...(open.entry.bossesAlive !== undefined ? { expectedBossesAlive: open.entry.bossesAlive } : {})
      });
    } catch (error) {
      open.status = "open";
      for (const member of open.members.values()) member.ready = false;
      open.message = error instanceof Error ? error.message : "The run could not start.";
      // A shared Forge's price moved (a boss fell): show everyone the new price before they ready again.
      if (error instanceof DungeonError && error.code === "DUNGEON_ENTRY_PRICE_CHANGED") await this.reprice(open);
      open.revision += 1;
      if (this.lobbies.get(lobbyKey(open.entry)) === open) this.publish(open);
      throw error;
    }
    open.status = "started";
    open.revision += 1;
    open.cleanup = setTimeout(() => this.dispose(open, true), STARTED_LOBBY_RETENTION_MS);
    open.cleanup.unref?.();
    if (this.lobbies.get(lobbyKey(open.entry)) === open) this.publish(open, playerId, requestId);
  }

  leave(playerId: string, lobbyId: string, requestId: string): void {
    const lobby = this.playerLobbies.get(playerId);
    if (lobby && lobby.lobbyId === lobbyId) this.removeMember(lobby, playerId);
    this.deps.connections.send(playerId, { type: "DUNGEON_TORCH_LOBBY", requestId, lobby: null });
  }

  /**
   * A disconnected member can't consent: in an open lobby they leave, which clears everyone's ready state.
   * Once the start is under way they readied (consented) and pay, so they stay a member and see the
   * started run when they reconnect, and can still enter it while in the party.
   */
  disconnect(playerId: string): void {
    const lobby = this.playerLobbies.get(playerId);
    if (lobby && lobby.status === "open") this.removeMember(lobby, playerId);
  }

  /** Session bootstrap: the player's lobby, or null to clear a stale one after a reconnect. */
  sendForPlayer(playerId: string): void {
    const lobby = this.playerLobbies.get(playerId);
    this.deps.connections.send(playerId, { type: "DUNGEON_TORCH_LOBBY", lobby: lobby ? this.snapshot(lobby, playerId) : null });
  }

  /** Re-reads each member's price (and the entry's boss count) after a refused start. Best effort. */
  private async reprice(lobby: Lobby): Promise<void> {
    for (const member of lobby.members.values()) {
      const fresh = await this.deps.dungeon.torchEntryFor(member.playerId, lobby.entry.entranceId).catch(() => null);
      if (!fresh || lobbyKey(fresh) !== lobbyKey(lobby.entry)) continue;
      member.entryCost = fresh.entryCost;
      if (member.playerId === this.leaderOf(lobby)) lobby.entry = { ...fresh, paid: lobby.entry.paid };
    }
  }

  close(): void {
    for (const lobby of this.lobbies.values()) if (lobby.cleanup) clearTimeout(lobby.cleanup);
    this.lobbies.clear();
    this.playerLobbies.clear();
  }

  private requireOpenMember(playerId: string, lobbyId: string): Lobby {
    const lobby = this.playerLobbies.get(playerId);
    if (!lobby || lobby.lobbyId !== lobbyId) {
      throw new DungeonError("TORCH_LOBBY_NOT_FOUND", "That torch lobby is closed. Tap the entrance again.");
    }
    if (lobby.status !== "open") throw new DungeonError("TORCH_LOBBY_STARTED", "This run has already started.");
    if (this.prune(lobby) && !lobby.members.has(playerId)) {
      throw new DungeonError("TORCH_LOBBY_NOT_FOUND", "You are no longer in this party's torch lobby.");
    }
    return lobby;
  }

  private findLobby(lobbyId: string): Lobby | undefined {
    for (const lobby of this.lobbies.values()) if (lobby.lobbyId === lobbyId) return lobby;
    return undefined;
  }

  /** Drops members who left the lobby's party; their run is another instance now. */
  private prune(lobby: Lobby): boolean {
    if (!lobby.entry.partyScoped) return false;
    const gone = [...lobby.members.keys()].filter((playerId) =>
      (this.deps.parties.partyForPlayer(playerId)?.partyId ?? null) !== lobby.entry.partyId);
    for (const playerId of gone) {
      this.removeMember(lobby, playerId);
      this.deps.connections.send(playerId, { type: "DUNGEON_TORCH_LOBBY", lobby: null });
    }
    return gone.length > 0;
  }

  private removeMember(lobby: Lobby, playerId: string): void {
    if (!lobby.members.delete(playerId)) return;
    if (this.playerLobbies.get(playerId) === lobby) this.playerLobbies.delete(playerId);
    if (lobby.members.size === 0) {
      this.dispose(lobby, false);
      return;
    }
    if (lobby.status === "open") this.changed(lobby);
    else lobby.revision += 1;
    this.publish(lobby);
  }

  private leaveCurrent(playerId: string, keepInstanceId: string): void {
    const current = this.playerLobbies.get(playerId);
    if (current && lobbyKey(current.entry) !== keepInstanceId) this.removeMember(current, playerId);
  }

  /** Any torch or membership change clears every ready state. */
  private changed(lobby: Lobby): void {
    for (const member of lobby.members.values()) member.ready = false;
    lobby.message = null;
    lobby.revision += 1;
  }

  private dispose(lobby: Lobby, notify: boolean): void {
    if (lobby.cleanup) clearTimeout(lobby.cleanup);
    if (this.lobbies.get(lobbyKey(lobby.entry)) === lobby) this.lobbies.delete(lobbyKey(lobby.entry));
    for (const playerId of lobby.members.keys()) {
      if (this.playerLobbies.get(playerId) !== lobby) continue;
      this.playerLobbies.delete(playerId);
      if (notify) this.deps.connections.send(playerId, { type: "DUNGEON_TORCH_LOBBY", lobby: null });
    }
  }

  /** The starter: the party leader when they are in the lobby, otherwise the earliest-joined member. */
  private leaderOf(lobby: Lobby): string {
    const [first] = lobby.members.keys();
    if (!lobby.entry.partyId) return first!;
    const leader = this.deps.parties.partyForPlayer(first!)?.leaderPlayerId;
    return leader && lobby.members.has(leader) ? leader : first!;
  }

  private total(lobby: Lobby): number {
    let total = 0;
    for (const member of lobby.members.values()) total += member.torches;
    return total;
  }

  private publish(lobby: Lobby, requesterId?: string, requestId?: string): void {
    for (const playerId of lobby.members.keys()) {
      this.sendTo(playerId, this.snapshot(lobby, playerId), playerId === requesterId ? requestId : undefined);
    }
  }

  private sendTo(playerId: string, lobby: DungeonTorchLobbySnapshot, requestId: string | undefined): void {
    this.deps.connections.send(playerId, requestId
      ? { type: "DUNGEON_TORCH_LOBBY", requestId, lobby }
      : { type: "DUNGEON_TORCH_LOBBY", lobby });
  }

  /** The lobby as `viewerId` sees it: the torch price is the viewer's own (what their start would charge). */
  private snapshot(lobby: Lobby, viewerId: string): DungeonTorchLobbySnapshot {
    const viewerCost = lobby.members.get(viewerId)?.entryCost ?? lobby.entry.entryCost;
    return {
      ...this.baseSnapshot(lobby.entry),
      torchCost: viewerCost.map((item) => ({ ...item })),
      lobbyId: lobby.lobbyId,
      leaderPlayerId: this.leaderOf(lobby),
      status: lobby.status,
      revision: lobby.revision,
      totalTorches: this.total(lobby),
      members: [...lobby.members.values()].map(({ playerId, name, torches, ready }) => ({ playerId, name, torches, ready })),
      message: lobby.message
    };
  }

  private inProgressSnapshot(entry: DungeonTorchEntry, playerId: string): DungeonTorchLobbySnapshot {
    return {
      ...this.baseSnapshot(entry),
      lobbyId: entry.instanceId,
      leaderPlayerId: this.deps.parties.partyForPlayer(playerId)?.leaderPlayerId ?? playerId,
      status: "in_progress", revision: 0, totalTorches: 0, members: [], message: null
    };
  }

  private baseSnapshot(entry: DungeonTorchEntry): Pick<DungeonTorchLobbySnapshot,
    "entranceId" | "dungeonId" | "dungeonName" | "partyId" | "torchCost" | "minTotalTorches" | "maxTotalTorches"> {
    return {
      entranceId: entry.entranceId, dungeonId: entry.dungeonId, dungeonName: entry.dungeonName,
      partyId: entry.partyId, torchCost: entry.entryCost.map((item) => ({ ...item })),
      minTotalTorches: DUNGEON_TORCH_TOTAL_MIN, maxTotalTorches: DUNGEON_TORCH_TOTAL_MAX
    };
  }
}

function torchCost(entryCost: DungeonTorchEntry["entryCost"], torches: number): Array<{ itemId: string; quantity: number }> {
  return entryCost.map((item) => ({ itemId: item.itemId, quantity: item.quantity * torches }));
}

/** Lobbies gather per instance, or per party for a shared Golem Forge run (DungeonTorchEntry.lobbyKey). */
function lobbyKey(entry: DungeonTorchEntry): string {
  return entry.lobbyKey ?? entry.instanceId;
}
