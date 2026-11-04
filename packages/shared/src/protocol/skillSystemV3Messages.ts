import type { PremiumWalletSnapshot } from "../premiumCurrency.js";
import type {
  GeneralSkillId,
  SkillSystemV3Snapshot,
  SpecializationId,
  WorldKnowledgeSkillId
} from "../skillSystemV3.js";

export type SkillSystemV3ServerMessage =
  | {
      type: "SKILL_TREE_SNAPSHOT";
      requestId: string;
      snapshot: SkillSystemV3Snapshot;
    }
  | {
      type: "SKILL_MUTATION_CONFIRMED";
      requestId: string;
      action: "spend" | "refund" | "equip" | "use" | "respec" | "dev_reset" | "offer";
      replayed: boolean;
      snapshot: SkillSystemV3Snapshot;
      /** Only after a paid respec. */
      premiumWallet?: PremiumWalletSnapshot;
    }
  | {
      type: "SPECIALIZATION_MUTATION_CONFIRMED";
      requestId: string;
      action: "spend" | "refund" | "activate";
      specializationId: SpecializationId | null;
      replayed: boolean;
      snapshot: SkillSystemV3Snapshot;
    }
  | {
      /** Sent only to connections that advertise `skill-unlock-offerings-v1`. */
      type: "SKILL_UNLOCK_STATE";
      discoveredGeneralSkills: GeneralSkillId[];
      classWrits: SpecializationId[];
    };

export type SkillPointMutationTarget =
  | Readonly<{ kind: "general_skill"; skillId: GeneralSkillId }>
  | Readonly<{ kind: "specialization"; specializationId: SpecializationId }>
  | Readonly<{ kind: "world_knowledge"; skillId: WorldKnowledgeSkillId }>;
