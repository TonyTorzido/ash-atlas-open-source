import type { ClientMessage, LatLon, PetAbilityId, PetCompanionCommand, PetSpeciesId, SaplingPlantSource, TreantKind } from "@ash-atlas/shared";

import { requestIdCrypto as crypto } from "../../requestId.js";
import type { ClientCommandPort } from "../clientCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";

export class PetClient {
  constructor(private readonly port: ClientCommandPort) {}

  requestPetState(): string | null {
    return this.sendWithRequestId((requestId) => ({ type: "REQUEST_PET_STATE", requestId }));
  }

  callPet(petId: string): string | null {
    return this.sendWithRequestId((requestId) => ({ type: "CALL_PET", requestId, petId }));
  }

  dismissPet(petId: string): string | null {
    return this.sendWithRequestId((requestId) => ({ type: "DISMISS_PET", requestId, petId }));
  }

  commandPet(petId: string, command: PetCompanionCommand, destination?: Readonly<{ lat: number; lon: number }>): string | null {
    return this.sendWithRequestId((requestId) => ({
      type: "COMMAND_PET", requestId, petId, command,
      ...(destination ? { destination: { lat: destination.lat, lon: destination.lon } } : {})
    }));
  }

  feedPet(petId: string): string | null {
    return this.sendWithRequestId((requestId) => ({ type: "FEED_PET", requestId, petId }));
  }

  healPet(petId: string): string | null {
    return this.sendWithRequestId((requestId) => ({ type: "HEAL_PET", requestId, petId }));
  }

  trainPet(petId: string): string | null {
    return this.sendWithRequestId((requestId) => ({ type: "TRAIN_PET", requestId, petId }));
  }

  unlockPetAbility(petId: string, abilityId: PetAbilityId): string | null {
    return this.sendWithRequestId((requestId) => ({ type: "UNLOCK_PET_ABILITY", requestId, petId, abilityId }));
  }

  usePetAbility(petId: string, abilityId: PetAbilityId, targetEntityId?: string): string | null {
    return this.sendWithRequestId((requestId) => ({
      type: "USE_PET_ABILITY", requestId, petId, abilityId, ...(targetEntityId ? { targetEntityId } : {})
    }));
  }

  hatchPetEgg(itemId: string): string | null {
    return this.sendWithRequestId((requestId) => ({ type: "HATCH_PET_EGG", requestId, itemId }));
  }

  buyHermitPet(species: PetSpeciesId): string | null {
    return this.sendWithRequestId((requestId) => ({ type: "BUY_HERMIT_PET", requestId, species }));
  }

  growTreant(kind: TreantKind): string | null {
    return this.sendWithRequestId((requestId) => ({ type: "GROW_TREANT", requestId, kind }));
  }

  /** Saplings and grown player trees around the player (Giving Tree saplings). */
  requestSaplings(): string | null {
    return this.sendWithRequestId((requestId) => ({ type: "REQUEST_SAPLINGS", requestId }));
  }

  /** One tree with its owner and exact timers (the tap prompt). */
  requestSaplingDetail(saplingId: string): string | null {
    return this.sendWithRequestId((requestId) => ({ type: "REQUEST_SAPLING_DETAIL", requestId, saplingId }));
  }

  /** Plant at the player's own position, spending a Giving Berry or a pulled sapling. */
  plantSapling(source: SaplingPlantSource, target?: LatLon): string | null {
    return this.sendWithRequestId((requestId) => ({
      type: "PLANT_SAPLING", requestId, source, ...(target ? { target: { lat: target.lat, lon: target.lon } } : {})
    }));
  }

  /** Tiller Boot: plant up to nine saplings around the player. */
  plantSaplingsGrid(): string | null {
    return this.sendWithRequestId((requestId) => ({ type: "PLANT_SAPLINGS_GRID", requestId }));
  }

  tendSapling(saplingId: string): string | null {
    return this.sendWithRequestId((requestId) => ({ type: "TEND_SAPLING", requestId, saplingId }));
  }

  pullSapling(saplingId: string): string | null {
    return this.sendWithRequestId((requestId) => ({ type: "PULL_SAPLING", requestId, saplingId }));
  }

  gatherSaplingBerry(saplingId: string): string | null {
    return this.sendWithRequestId((requestId) => ({ type: "GATHER_SAPLING_BERRY", requestId, saplingId }));
  }

  grantOwnDevPets(): string | null {
    return this.sendWithRequestId((requestId) => ({ type: "GRANT_OWN_DEV_PETS", requestId }));
  }

  private sendWithRequestId(
    message: (requestId: string) => ClientMessage
  ): string | null {
    const requestId = crypto.randomUUID();
    return wasClientMessageSent(this.port.send(message(requestId))) ? requestId : null;
  }
}
