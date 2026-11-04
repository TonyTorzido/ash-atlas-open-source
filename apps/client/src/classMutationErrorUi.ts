const CLASS_MUTATION_ERROR_PREFIXES = [
  "CLASS_",
  "TECHNIQUE_",
  "LOADOUT_",
  "SUBCLASS_",
  "TRAINING_"
] as const;

export type ClassMutationErrorUiEffect = {
  clearBusy: boolean;
  clearEquipmentBusy: boolean;
  showActionError: boolean;
};

export function classMutationErrorUiEffect(
  code: string,
  classMutationPending = false
): ClassMutationErrorUiEffect {
  const isClassMutationError =
    (classMutationPending && code === "PLAYER_WORLD_TRANSITION_PENDING")
    || CLASS_MUTATION_ERROR_PREFIXES.some((prefix) => code.startsWith(prefix));
  return {
    clearBusy: isClassMutationError,
    clearEquipmentBusy: code === "CLASS_WEAPON_INCOMPATIBLE"
      || code === "CLASS_ARMOR_INCOMPATIBLE"
      || code === "SUBCLASS_WEAPON_REQUIRED",
    showActionError: isClassMutationError
  };
}

export function equipmentMutationRequestAfterClassError(
  currentRequestId: string | null,
  rejectedRequestId: string | undefined,
  code: string
): string | null {
  const effect = classMutationErrorUiEffect(code);
  return currentRequestId !== null
    && rejectedRequestId === currentRequestId
    && (effect.clearEquipmentBusy || code === "CLASS_MUTATION_PENDING")
    ? null
    : currentRequestId;
}
