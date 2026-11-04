import type { DeveloperCapability } from "../auth.js";
import type { BugReportSubmitResultMessage } from "../bugReports.js";
import type { AshAtlasProtocolWelcomeMetadata } from "../protocolCompatibility.js";
import type { FlagBuildMaterial } from "./flagMessages.js";
import type { PlayerWalletSnapshot } from "../wallet.js";
import type { GlimmerCostsSnapshot, PremiumWalletSnapshot } from "../premiumCurrency.js";
import type { CreatureBookSnapshot } from "../creatureBook.js";
import type { HungerSnapshot } from "../hunger.js";
import type { VersionClients } from "../version.js";
import type { WorldZoneDiscoverableBiome, WorldZoneResolution } from "../worldZones.js";
import type { BiomeDiscoveryCelebration } from "../biomeDiscoveryCelebration.js";

export type SessionServerMessage =
  | BugReportSubmitResultMessage
  | { type: "SESSION_REPLACED"; message: string }
  | { type: "CREATURE_BOOK_SNAPSHOT"; snapshot: CreatureBookSnapshot }
  | {
      type: "BIOME_DISCOVERY_SNAPSHOT";
      /** Every biome this player has discovered, oldest first. */
      biomes: WorldZoneDiscoverableBiome[];
      /** Set only when this request recorded a first discovery. */
      newlyDiscovered: WorldZoneDiscoverableBiome | null;
      /** The zone at the player's authoritative position; null outside the open world. */
      current: WorldZoneResolution | null;
      /** Set only on the request that recorded a first discovery, with the Legends it completed. */
      celebration: BiomeDiscoveryCelebration | null;
    }
  | {
      type: "AUTH_SESSION_INVALID";
      code:
        | "SESSION_EXPIRED"
        | "ACCOUNT_SUSPENDED"
        | "SESSION_REVOKED"
        | "TEST_ACCESS_PENDING"
        | "TEST_ACCESS_DENIED"
        | "TEST_ACCESS_REVOKED";
      message: string;
    }
  | {
      type: "WELCOME";
      playerId: string;
      username: string;
      spawn: { lat: number; lon: number };
      anchor: { lat: number; lon: number };
      moveLeashRadiusM: number;
      flagClaimRadiusM: number;
      flagBuildRecipe?: FlagBuildMaterial[];
      buoyBuildRecipe?: FlagBuildMaterial[];
      playerSpeedMps: number;
      serverTickHz: number;
      regionCode: string;
      zoneId: string;
      worldAuthorityEpoch?: string;
      connectionId?: string;
      connectionGeneration?: number;
      gameplayViewGeneration?: number;
      relocationRevision?: number;
      resourceVisionRevision?: number;
      developerCapabilities: DeveloperCapability[];
      bugReportsEnabled?: boolean;
      /** ACTION_COMBAT_ENABLED on this server: SWING is accepted (combined with the client preference). */
      actionCombat?: boolean;
      /** CLERIC_ARC_ENABLED on this server: a readied scepter casts the holy arc (the client draws and aims it). */
      clericArc?: boolean;
      wallet?: PlayerWalletSnapshot;
      premiumWallet?: PremiumWalletSnapshot;
      /** Glimmer progression costs; present only when at least one Glimmer fee is on. */
      glimmerCosts?: GlimmerCostsSnapshot;
      hunger?: HungerSnapshot;
      serverTime: number;
      /** Runtime/server component SHA, advertised only with welcome-release-sha. */
      releaseSha?: string;
      protocol?: AshAtlasProtocolWelcomeMetadata;
      /** Shared updater identity, capability-gated for rolling protocol compatibility. */
      clients?: VersionClients;
      serverVersion?: string | null;
      protocolMin?: number;
      protocolMax?: number;
      publicVersion?: string | null;
      generation?: string | null;
    }
  | {
      type: "PRESENTATION_SNAPSHOT_COMPLETE";
      connectionId: string;
      connectionGeneration: number;
      gameplayViewGeneration: number;
      relocationRevision: number;
      resourceVisionRevision: number;
      populationPreparationGeneration: number;
    }
  | {
      type: "ERROR";
      requestId?: string;
      code: string;
      message: string;
      retryable?: boolean;
      details?: {
        dropId?: string;
        nodeId?: string;
        sessionId?: string;
        remainingQuantity?: number;
        retryAfterMs?: number;
        stateRevision?: number;
        populationV2StateRevision?: number;
        authoritativeDistanceM?: number;
        maximumDistanceM?: number;
        reconciliation?: "remove-node" | "refresh-node";
        sessionStatusBeforeCleanup?: "active" | "completed" | "cancelled" | "expired";
        sessionStatusAfterCleanup?: "active" | "completed" | "cancelled" | "expired";
        terminalCleanupOutcome?:
          | "cancelled"
          | "expired"
          | "already-terminal"
          | "completed"
          | "not-found";
        currentTollGold?: string;
        requiredGold?: string;
        targetEntityId?: string;
        relocationRevision?: number;
        resourceVisionRevision?: number;
        gameplayViewGeneration?: number;
        presentationOwner?: "population" | "repeatable-resource" | "resource-vision";
        combatValidationPredicate?: string;
        attackerZoneId?: string;
        targetZoneId?: string;
        attackerRegionCode?: string;
        targetRegionCode?: string;
        attackerInsideAuthoritativeView?: boolean;
        targetInsideAuthoritativeView?: boolean;
      };
    }
  | { type: "PONG"; clientTime: number; serverTime: number };
