import {
  PET_ABILITY_DEFINITIONS,
  PET_SPECIES_DEFINITIONS,
  isPetSpeciesId,
  type CombatEntitySnapshot,
  type PetAbilityId,
  type PetCompanionCommand,
  type PetSnapshot
} from "@ash-atlas/shared";
import { GameActionPrompt, type GamePromptPresentationState } from "./GameActionPrompt.js";

/** Tapping your own pet: Stay / Follow plus its learned abilities. */
export function PetCompanionPrompt(props: Readonly<{
  pet: CombatEntitySnapshot;
  snapshot: PetSnapshot | null;
  busy: boolean;
  nowMs: number;
  presentationState?: GamePromptPresentationState;
  actionsReady?: boolean;
  onCommand(command: PetCompanionCommand): void;
  onAbility(abilityId: PetAbilityId): void;
  onClose(): void;
}>): React.JSX.Element {
  const staying = props.pet.companion?.mode === "sit";
  const companionSpecies = props.pet.companion?.species;
  const species = companionSpecies && isPetSpeciesId(companionSpecies) ? PET_SPECIES_DEFINITIONS[companionSpecies] : null;
  const abilityActions = (species?.abilities ?? []).flatMap((abilityId) => {
    if (!props.snapshot?.unlockedAbilities.includes(abilityId)) return [];
    const readyAt = props.snapshot.abilityReadyAt[abilityId];
    const remainingMs = readyAt ? Date.parse(readyAt) - props.nowMs : 0;
    return [{
      key: `ability-${abilityId}`,
      label: remainingMs > 0
        ? `${PET_ABILITY_DEFINITIONS[abilityId].name} (${Math.ceil(remainingMs / 1_000)}s)`
        : PET_ABILITY_DEFINITIONS[abilityId].name,
      enabled: remainingMs <= 0,
      busy: props.busy,
      onSelect: () => props.onAbility(abilityId)
    }];
  });
  return <GameActionPrompt
    title={props.pet.name}
    category={species?.displayName ?? "Minion"}
    {...(props.presentationState ? { presentationState: props.presentationState } : {})}
    {...(props.actionsReady === undefined ? {} : { actionsReady: props.actionsReady })}
    actions={!species ? [] : [{
      key: staying ? "follow" : "stay",
      label: staying ? "Follow" : "Stay",
      enabled: true,
      busy: props.busy,
      onSelect: () => props.onCommand(staying ? "follow" : "stay"),
    }, ...abilityActions]}
    onCancel={props.onClose}
  />;
}
