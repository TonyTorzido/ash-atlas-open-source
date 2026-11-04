import {
  distanceMeters,
  type CombatEntitySnapshot,
  type PartyCombatMemberDelta,
  type PartyCombatMemberSnapshot,
  type PartyCombatSnapshot,
  type PartyServerMessage,
  type ServerMessage,
  type SpecializationId
} from "@ash-atlas/shared";

import type { PartyAuthority, PartySnapshot } from "../game/party/PartyAuthority.js";
import type { PlayerRecord } from "../game/state.js";

type PartyCombatConnectionPort = {
  activePlayerIds(): string[];
  activeConnectionIdForPlayer(playerId: string): string | null;
  hasPlayerPresence(playerId: string): boolean;
  send(playerId: string, message: ServerMessage, mode?: "critical" | "replaceable"): unknown;
};

type PartyCombatStatePort = {
  getPlayer(playerId: string): PlayerRecord | undefined;
};

type PartyCombatEntityPort = {
  entity(playerId: string): CombatEntitySnapshot | null;
  isPlayerVisibleToPlayer(viewerPlayerId: string, targetPlayerId: string): boolean;
  /** The active class (Ronin, Warrior; null for none or a hidden old class). When present it replaces the legacy class. */
  playerActiveSpecializationId?(playerId: string): SpecializationId | null;
};

type RecipientProjection = {
  partyId: string;
  membershipRevision: number;
  sequence: number;
  members: Map<string, PartyCombatMemberSnapshot>;
};

export class PartyCombatPublisher {
  private readonly projections = new Map<string, RecipientProjection>();

  constructor(
    private readonly parties: PartyAuthority,
    private readonly connections: PartyCombatConnectionPort,
    private readonly gameState: PartyCombatStatePort,
    private readonly combat: PartyCombatEntityPort
  ) {}

  sendSnapshot(playerId: string): void {
    const party = this.parties.partyForPlayer(playerId);
    if (!party) {
      this.projections.delete(playerId);
      return;
    }
    const previous = this.projections.get(playerId);
    const sequence = (previous?.sequence ?? 0) + 1;
    const members = this.projectMembers(playerId, party, previous?.members);
    const membershipRevision = membershipRevisionOf(party);
    const message: PartyCombatSnapshot = {
      type: "PARTY_COMBAT_SNAPSHOT",
      partyId: party.partyId,
      membershipRevision,
      sequence,
      serverTime: Date.now(),
      members: [...members.values()]
    };
    this.connections.send(playerId, message, "critical");
    this.projections.set(playerId, { partyId: party.partyId, membershipRevision, sequence, members });
  }

  sendSnapshots(playerIds: Iterable<string>): void {
    for (const playerId of new Set(playerIds)) {
      if (this.connections.activeConnectionIdForPlayer(playerId)) this.sendSnapshot(playerId);
      else this.projections.delete(playerId);
    }
  }

  flush(): void {
    const activePlayerIds = this.connections.activePlayerIds();
    const active = new Set(activePlayerIds);
    for (const playerId of this.projections.keys()) {
      if (!active.has(playerId)) this.projections.delete(playerId);
    }
    for (const playerId of activePlayerIds) {
      const party = this.parties.partyForPlayer(playerId);
      if (!party) {
        this.projections.delete(playerId);
        continue;
      }
      const membershipRevision = membershipRevisionOf(party);
      const previous = this.projections.get(playerId);
      if (
        !previous ||
        previous.partyId !== party.partyId ||
        previous.membershipRevision !== membershipRevision
      ) {
        this.sendSnapshot(playerId);
        continue;
      }
      const members = this.projectMembers(playerId, party, previous.members);
      if ([...members].some(([memberPlayerId, member]) =>
        previous.members.get(memberPlayerId)?.worldRelation !== member.worldRelation
      )) {
        this.sendSnapshot(playerId);
        continue;
      }
      const deltas = diffMembers(previous.members, members);
      if (deltas.length === 0) continue;
      const sequence = previous.sequence + 1;
      const message: PartyServerMessage = {
        type: "PARTY_COMBAT_DELTA",
        partyId: party.partyId,
        membershipRevision,
        sequence,
        serverTime: Date.now(),
        members: deltas
      };
      this.connections.send(playerId, message);
      this.projections.set(playerId, { ...previous, sequence, members });
    }
  }

  /**
   * The member's class label. The party wire field carries the legacy class ids, so only Warrior maps across:
   * Ronin, no class, and the hidden old classes (Ninja and the rest) all send null ("Adventurer"), never a removed
   * class. An offline member (no entity) keeps the last value sent.
   */
  private memberClassId(
    playerId: string,
    entity: CombatEntitySnapshot | null,
    last: PartyCombatMemberSnapshot | undefined
  ): PartyCombatMemberSnapshot["classId"] {
    if (!entity) return last?.classId ?? null;
    if (!this.combat.playerActiveSpecializationId) return entity.classCombat?.activeClassId ?? last?.classId ?? null;
    return this.combat.playerActiveSpecializationId(playerId) === "warrior" ? "warrior" : null;
  }

  private projectMembers(
    recipientPlayerId: string,
    party: PartySnapshot,
    previous: ReadonlyMap<string, PartyCombatMemberSnapshot> | undefined
  ): Map<string, PartyCombatMemberSnapshot> {
    const recipientEntity = this.combat.entity(recipientPlayerId);
    const slots = party.memberSlots?.length === party.memberPlayerIds.length
      ? [...party.memberSlots]
      : [...party.memberPlayerIds].sort().map((playerId, slotIndex) => ({ playerId, slotIndex }));
    const members = new Map<string, PartyCombatMemberSnapshot>();
    for (const { playerId, slotIndex } of slots.sort(
      (left, right) => left.slotIndex - right.slotIndex || left.playerId.localeCompare(right.playerId)
    )) {
      const entity = this.combat.entity(playerId);
      const player = this.gameState.getPlayer(playerId);
      const last = previous?.get(playerId);
      const sameLayer = playerId === recipientPlayerId ||
        this.combat.isPlayerVisibleToPlayer(recipientPlayerId, playerId);
      const classId = this.memberClassId(playerId, entity, last);
      const member: PartyCombatMemberSnapshot = {
        playerId,
        slotIndex,
        displayName: player?.username ?? entity?.name ?? last?.displayName ?? "Party member",
        classId,
        role: roleForClass(classId),
        currentHealth: entity?.currentHealth ?? last?.currentHealth ?? 0,
        maxHealth: entity?.maxHealth ?? last?.maxHealth ?? 100,
        ward: entity?.ward ?? last?.ward ?? 0,
        lifeState: entity?.lifeState ?? last?.lifeState ?? "respawning",
        downedUntil: entity ? entity.downedUntil ?? null : last?.downedUntil ?? null,
        presence: this.connections.activeConnectionIdForPlayer(playerId)
          ? "online"
          : this.connections.hasPlayerPresence(playerId)
            ? "reconnecting"
            : "offline",
        worldRelation: sameLayer ? "same_layer" : "different_area",
        ...(sameLayer && entity && recipientEntity
          ? { distanceMeters: distanceMeters(
              { lat: recipientEntity.lat, lon: recipientEntity.lon },
              { lat: entity.lat, lon: entity.lon }
            ) }
          : {})
      };
      members.set(playerId, member);
    }
    return members;
  }
}

function membershipRevisionOf(party: PartySnapshot): number {
  return party.membershipRevision ?? party.revision;
}

function roleForClass(
  classId: PartyCombatMemberSnapshot["classId"]
): PartyCombatMemberSnapshot["role"] {
  if (classId === "warrior") return "tank";
  if (classId === "hunter") return "damage";
  return null;
}

function diffMembers(
  previous: ReadonlyMap<string, PartyCombatMemberSnapshot>,
  next: ReadonlyMap<string, PartyCombatMemberSnapshot>
): PartyCombatMemberDelta[] {
  if (
    previous.size !== next.size ||
    [...previous.keys()].some((playerId) => !next.has(playerId))
  ) {
    return [...next.values()];
  }
  const deltas: PartyCombatMemberDelta[] = [];
  for (const [playerId, current] of next) {
    const before = previous.get(playerId);
    if (!before) {
      deltas.push(current);
      continue;
    }
    const delta: Record<string, unknown> = { playerId };
    for (const key of [
      "slotIndex",
      "displayName",
      "classId",
      "role",
      "currentHealth",
      "maxHealth",
      "ward",
      "lifeState",
      "downedUntil",
      "presence",
      "worldRelation"
    ] as const) {
      if (current[key] !== before[key]) delta[key] = current[key];
    }
    if (current.distanceMeters !== before.distanceMeters) {
      delta.distanceMeters = current.distanceMeters ?? null;
    }
    if (JSON.stringify(current.priorityEffects) !== JSON.stringify(before.priorityEffects)) {
      delta.priorityEffects = current.priorityEffects ?? [];
    }
    if (Object.keys(delta).length > 1) deltas.push(delta as PartyCombatMemberDelta);
  }
  return deltas;
}
