import { z } from "zod";

import { SAPLING_PLANT_SOURCES } from "../givingSaplings.js";
import { PET_ABILITY_IDS, PET_SPECIES_IDS, TREANT_KINDS } from "../petSystem.js";

const requestIdSchema = z.string().min(1).max(128);
const petIdSchema = z.string().uuid();

export const requestPetStateMessageSchema = z.object({
  type: z.literal("REQUEST_PET_STATE"),
  requestId: requestIdSchema
}).strict();

export const callPetMessageSchema = z.object({
  type: z.literal("CALL_PET"), requestId: requestIdSchema, petId: petIdSchema
}).strict();

export const dismissPetMessageSchema = z.object({
  type: z.literal("DISMISS_PET"), requestId: requestIdSchema, petId: petIdSchema
}).strict();

export const commandPetMessageSchema = z.object({
  type: z.literal("COMMAND_PET"), requestId: requestIdSchema, petId: petIdSchema,
  command: z.enum(["stay", "follow"]),
  /** Stay only: the pet walks to this spot and stays there (drag-to-place). */
  destination: z.object({ lat: z.number().finite(), lon: z.number().finite() }).strict().optional()
}).strict();

export const feedPetMessageSchema = z.object({
  type: z.literal("FEED_PET"), requestId: requestIdSchema, petId: petIdSchema
}).strict();

export const healPetMessageSchema = z.object({
  type: z.literal("HEAL_PET"), requestId: requestIdSchema, petId: petIdSchema
}).strict();

export const trainPetMessageSchema = z.object({
  type: z.literal("TRAIN_PET"), requestId: requestIdSchema, petId: petIdSchema
}).strict();

export const unlockPetAbilityMessageSchema = z.object({
  type: z.literal("UNLOCK_PET_ABILITY"), requestId: requestIdSchema, petId: petIdSchema,
  abilityId: z.enum(PET_ABILITY_IDS)
}).strict();

export const usePetAbilityMessageSchema = z.object({
  type: z.literal("USE_PET_ABILITY"), requestId: requestIdSchema, petId: petIdSchema,
  abilityId: z.enum(PET_ABILITY_IDS),
  /** Enemy-targeted abilities: the enemy picked in the target menu (else the owner's current target). */
  targetEntityId: z.string().min(1).max(200).optional()
}).strict();

export const hatchPetEggMessageSchema = z.object({
  type: z.literal("HATCH_PET_EGG"), requestId: requestIdSchema, itemId: z.string().min(1).max(80)
}).strict();

export const buyHermitPetMessageSchema = z.object({
  type: z.literal("BUY_HERMIT_PET"), requestId: requestIdSchema, species: z.enum(PET_SPECIES_IDS)
}).strict();

export const growTreantMessageSchema = z.object({
  type: z.literal("GROW_TREANT"), requestId: requestIdSchema, kind: z.enum(TREANT_KINDS)
}).strict();

/** Developer tools: grant every pet whistle with both abilities, ready to call (no Glimmer). */
export const grantOwnDevPetsMessageSchema = z.object({
  type: z.literal("GRANT_OWN_DEV_PETS"), requestId: requestIdSchema
}).strict();

const saplingIdSchema = z.string().uuid();

export const requestSaplingsMessageSchema = z.object({
  type: z.literal("REQUEST_SAPLINGS"), requestId: requestIdSchema
}).strict();

/**
 * Plant at the player's own authoritative position, or, with `target` (the planting planner), at the
 * tree-lattice point nearest that target. The server re-snaps the target to the lattice and range-checks
 * it against its own position for the player; the client's coordinates are never trusted as-is.
 */
export const plantSaplingMessageSchema = z.object({
  type: z.literal("PLANT_SAPLING"), requestId: requestIdSchema, source: z.enum(SAPLING_PLANT_SOURCES),
  target: z.object({ lat: z.number().finite().min(-90).max(90), lon: z.number().finite().min(-180).max(180) }).strict().optional()
}).strict();

/** Tiller Boot: plant a 3x3 block of saplings centred on the player. */
export const plantSaplingsGridMessageSchema = z.object({
  type: z.literal("PLANT_SAPLINGS_GRID"), requestId: requestIdSchema
}).strict();

export const requestSaplingDetailMessageSchema = z.object({
  type: z.literal("REQUEST_SAPLING_DETAIL"), requestId: requestIdSchema, saplingId: saplingIdSchema
}).strict();

export const tendSaplingMessageSchema = z.object({
  type: z.literal("TEND_SAPLING"), requestId: requestIdSchema, saplingId: saplingIdSchema
}).strict();

export const pullSaplingMessageSchema = z.object({
  type: z.literal("PULL_SAPLING"), requestId: requestIdSchema, saplingId: saplingIdSchema
}).strict();

export const gatherSaplingBerryMessageSchema = z.object({
  type: z.literal("GATHER_SAPLING_BERRY"), requestId: requestIdSchema, saplingId: saplingIdSchema
}).strict();
