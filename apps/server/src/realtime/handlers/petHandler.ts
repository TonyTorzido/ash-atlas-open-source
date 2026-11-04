import { PET_SPECIES_DEFINITIONS, PET_SPECIES_IDS, type ServerMessage } from "@ash-atlas/shared";

import { PetError, type PetMutationResult, type PetService } from "../../game/petService.js";
import type { SocketLike } from "../connectionRegistry.js";
import type { RealtimeFamilyHandler, RealtimeMessageRouter } from "../messageRouter.js";
import { requireHello, type RealtimeConnectionState } from "./handlerExecutionContext.js";
import type { AuthenticatedSession } from "../../auth/types.js";
import type { AppLogger } from "../../logger.js";
import { PetAbilityError, type PetCompanionRuntime } from "../../game/combat/petCompanionRuntime.js";
import { MinionError, type MinionRuntime } from "../../game/combat/minionRuntime.js";

export type PetHandlerContext = Readonly<{
  state: Pick<RealtimeConnectionState, "playerId">;
  socket: SocketLike;
  authenticatedSession: AuthenticatedSession | null | undefined;
  pets?: PetService | undefined;
  petCompanions?: PetCompanionRuntime | undefined;
  /** True while the player stands in the Grove Hermit's clearing (the Hermit sells pets). */
  isAtGroveHermit?: ((playerId: string) => boolean) | undefined;
  minions?: MinionRuntime | undefined;
  /** Same developer gate as the other dev grants; resolves false (and reports) when denied. */
  authorizeDeveloperGrant?: ((command: string, requestId: string) => Promise<boolean>) | undefined;
  logger?: Pick<AppLogger, "info"> | undefined;
  /** Tail Lash: one full hit on each attackable structure in reach, through the normal warfare rules. */
  strikeStructures?: ((input: Readonly<{ origin: { lat: number; lon: number }; radiusM: number; activationId: string }>) =>
    Promise<Readonly<{ hit: number; skipped: number }>>) | undefined;
  /** Grove Lore rank (treants at once). */
  groveLoreRank?: ((playerId: string) => Promise<number>) | undefined;
  sendCombatScopeSnapshot(playerId: string): unknown;
  safeSendServerMessage(socket: SocketLike, message: ServerMessage): boolean;
}>;

export function createPetHandler(
  context: PetHandlerContext
): RealtimeFamilyHandler<"pet"> {
  return async (message) => {
    const { state, socket, authenticatedSession, pets, petCompanions, isAtGroveHermit, minions, groveLoreRank, authorizeDeveloperGrant, sendCombatScopeSnapshot, safeSendServerMessage } = context;
    requireHello(state.playerId);
    const playerId = state.playerId;
    const accountId = authenticatedSession?.account.id;
    if (!accountId || !pets) {
      sendError(socket, message.requestId, new PetError("PET_UNAVAILABLE", "Pets are temporarily unavailable.", true), safeSendServerMessage);
      return;
    }
    const owner = { accountId, playerId };
    const treantCap = await (groveLoreRank?.(playerId) ?? Promise.resolve(0)).catch(() => 0);
    const reply = (
      result: PetMutationResult,
      action?: Extract<ServerMessage, { type: "PET_STATE" }>["action"],
      ping?: Extract<ServerMessage, { type: "PET_STATE" }>["ping"],
      openLand?: { lat: number; lon: number },
      stayAt?: { lat: number; lon: number }
    ): void => {
      const readyAt = petCompanions?.abilityReadyAt(playerId) ?? {};
      safeSendServerMessage(socket, {
        type: "PET_STATE",
        requestId: message.requestId,
        ...(action ? { action } : {}),
        state: {
          ...result.state,
          hermitOffers: isAtGroveHermit?.(playerId) ? HERMIT_SPECIES : [],
          minions: minions?.snapshot(playerId) ?? [],
          treantCap: Math.max(0, Math.min(3, treantCap)),
          pets: result.state.pets.map((pet) => pet.id === result.state.activePetId ? { ...pet, abilityReadyAt: readyAt } : pet)
        },
        ...(ping ? { ping } : {}),
        ...(openLand ? { openLand: { lat: openLand.lat, lon: openLand.lon } } : {}),
        ...(stayAt ? { stayAt: { lat: stayAt.lat, lon: stayAt.lon } } : {}),
        ...(result.notice ? { notice: result.notice } : {}),
        ...(result.inventory ? { inventory: result.inventory } : {}),
        ...(result.premiumWallet ? { premiumWallet: result.premiumWallet } : {})
      });
    };
    const syncCompanion = (result: PetMutationResult): void => {
      petCompanions?.sync(playerId, result.active);
      sendCombatScopeSnapshot(playerId);
    };
    const requireOutsideDungeon = (): void => {
      if (petCompanions?.isOwnerInDungeon(playerId)) {
        throw new PetError("PET_DUNGEON", "Pets are not allowed in dungeons.");
      }
    };

    try {
      switch (message.type) {
        case "REQUEST_PET_STATE": {
          const result = await pets.state(owner);
          syncCompanion(result);
          reply(result);
          return;
        }
        case "CALL_PET": {
          requireOutsideDungeon();
          const result = await pets.call(owner, message.petId);
          syncCompanion(result);
          reply(result, "call");
          return;
        }
        case "DISMISS_PET": {
          const result = await pets.sendHome(owner, message.petId);
          syncCompanion(result);
          reply(result, "dismiss");
          return;
        }
        case "COMMAND_PET": {
          if (!petCompanions) throw new PetError("INVALID_PET_STATE", "That pet is not out right now.");
          if (message.destination && message.command !== "stay") {
            throw new PetError("INVALID_PET_STATE", "Only Stay takes a spot.");
          }
          if (message.destination) {
            petCompanions.placeStay(playerId, message.petId, message.destination);
          } else if (!petCompanions.command(playerId, message.petId, message.command)) {
            throw new PetError("INVALID_PET_STATE", "That pet is not out right now.");
          }
          petCompanions.update(playerId);
          sendCombatScopeSnapshot(playerId);
          reply(await pets.state(owner), "command", undefined, undefined, petCompanions.stayAt(playerId) ?? undefined);
          return;
        }
        case "FEED_PET": {
          requireOutsideDungeon();
          const result = await pets.feed(owner, message.petId, message.requestId);
          syncCompanion(result);
          reply(result, "feed");
          return;
        }
        case "HEAL_PET": {
          const result = await pets.heal(owner, message.petId, message.requestId);
          petCompanions?.restoreHealth(playerId, message.petId);
          sendCombatScopeSnapshot(playerId);
          reply(result, "heal");
          return;
        }
        case "TRAIN_PET": {
          const result = await pets.train(owner, message.petId, message.requestId);
          syncCompanion(result);
          reply(result, "train");
          return;
        }
        case "UNLOCK_PET_ABILITY": {
          const result = await pets.unlockAbility(owner, message.petId, message.abilityId, message.requestId);
          syncCompanion(result);
          reply(result, "unlock");
          return;
        }
        case "USE_PET_ABILITY": {
          if (!petCompanions) throw new PetError("PET_UNAVAILABLE", "Pets are temporarily unavailable.", true);
          let used: Awaited<ReturnType<PetCompanionRuntime["useAbility"]>>;
          try {
            used = await petCompanions.useAbility(playerId, message.petId, message.abilityId, Date.now(), message.targetEntityId ?? null);
          } catch (error) {
            context.logger?.info({ playerId, abilityId: message.abilityId, outcome: "rejected",
              code: error instanceof PetAbilityError ? error.code : "PET_ABILITY_FAILED" }, "pet ability");
            throw error;
          }
          context.logger?.info({ playerId, abilityId: message.abilityId, outcome: "used", notice: used.notice,
            ...(used.searchMs === undefined ? {} : { searchMs: used.searchMs }),
            ...(used.ping ? { ping: { lat: used.ping.lat, lon: used.ping.lon, distanceM: used.ping.distanceM } } : {}) }, "pet ability");
          let notice = used.notice;
          if (used.structureStrike && context.strikeStructures) {
            const struck = await context.strikeStructures({ ...used.structureStrike, activationId: message.requestId });
            if (struck.hit > 0) notice += ` ${struck.hit} structure${struck.hit === 1 ? "" : "s"} took a full hit.`;
            context.logger?.info({ playerId, abilityId: message.abilityId, structuresHit: struck.hit, structuresSkipped: struck.skipped }, "pet tail lash structures");
          }
          sendCombatScopeSnapshot(playerId);
          reply({ ...(await pets.state(owner)), notice }, "ability", used.ping, used.travelTo);
          return;
        }
        case "GROW_TREANT": {
          if (!minions) throw new PetError("PET_UNAVAILABLE", "Treants are temporarily unavailable.", true);
          minions.growTreant(playerId, message.kind, treantCap);
          sendCombatScopeSnapshot(playerId);
          reply({ ...(await pets.state(owner)), notice: "A treant takes root beside you." }, "treant");
          return;
        }
        case "GRANT_OWN_DEV_PETS": {
          if (!authorizeDeveloperGrant || !(await authorizeDeveloperGrant("pets.grant", message.requestId))) {
            throw new PetError("DEVELOPER_COMMAND_FORBIDDEN", "Developer command is unavailable");
          }
          const result = await pets.grantAllForDeveloper(owner);
          syncCompanion(result);
          reply(result, "dev_grant");
          return;
        }
        case "HATCH_PET_EGG": {
          const result = await pets.hatch(owner, message.itemId, message.requestId);
          reply(result, "hatch");
          return;
        }
        case "BUY_HERMIT_PET": {
          if (!isAtGroveHermit?.(playerId)) {
            throw new PetError("PET_HERMIT_REQUIRED", "Find the Grove Hermit in Blightwood Grove to buy a beast.");
          }
          const result = await pets.buyFromHermit(owner, message.species, message.requestId);
          reply(result, "hermit");
          return;
        }
      }
    } catch (error) {
      sendError(socket, message.requestId, error, safeSendServerMessage);
    }
  };
}

const HERMIT_SPECIES = PET_SPECIES_IDS.filter((id) => PET_SPECIES_DEFINITIONS[id].source.kind === "hermit");

export function registerPetHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"pet">
): void {
  router.register("pet", handler);
}

function sendError(
  socket: SocketLike,
  requestId: string | undefined,
  error: unknown,
  send: (socket: SocketLike, message: ServerMessage) => boolean
): void {
  const petError = error instanceof PetError || error instanceof PetAbilityError || error instanceof MinionError ? error : null;
  send(socket, {
    type: "PET_ERROR",
    ...(requestId ? { requestId } : {}),
    code: petError?.code ?? "PET_REQUEST_REJECTED",
    message: petError?.message ?? "Pet request rejected.",
    retryable: petError instanceof PetError ? petError.retryable : false
  });
}
