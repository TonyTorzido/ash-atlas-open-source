import {
  PET_ABILITY_DEFINITIONS,
  PET_GLIMMER_COSTS,
  PET_MAX_LEVEL,
  PET_SPECIES_DEFINITIONS,
  PET_SPECIES_IDS,
  TREANT_DEFINITIONS,
  TREANT_KINDS,
  type TreantKind,
  type PetAbilityId,
  type PetSnapshot,
  type PetEggHolding,
  type PetSpeciesId,
  type PetStateSnapshot
} from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import type { PetBusyAction } from "../features/pets/usePetFeature.js";
import { PET_WHISTLE_ARTWORK_URLS } from "../petArtwork.js";
import { PET_ABILITY_ICON_URLS } from "./petAbilityIcons.js";
import { GameAppActionBar, GameAppButton, GameAppCard, GameAppShell, GameAppState } from "./GameAppShell.js";
import { GameConfirmationPrompt } from "./GameActionPrompt.js";
import "./PetPanel.css";

type PendingSpend =
  | { kind: "feed"; pet: PetSnapshot }
  | { kind: "train"; pet: PetSnapshot }
  | { kind: "unlock"; pet: PetSnapshot; abilityId: PetAbilityId }
  | { kind: "hatch"; itemId: string; species: PetSpeciesId }
  | { kind: "hermit"; species: PetSpeciesId };

type Props = {
  open: boolean;
  state: PetStateSnapshot | null;
  connectionStatus: "offline" | "connecting" | "online";
  busy: PetBusyAction | null;
  error: string | null;
  notice: string | null;
  layout?: "desktop" | "phone";
  onClose(): void;
  onCall(petId: string): void;
  onDismiss(petId: string): void;
  onFeed(petId: string): void;
  onHeal(petId: string): void;
  onTrain(petId: string): void;
  onUnlock(petId: string, abilityId: PetAbilityId): void;
  onHatch(itemId: string): void;
  onBuyFromHermit(species: PetSpeciesId): void;
  onGrowTreant(kind: TreantKind): void;
};

export function PetPanel(props: Props): React.JSX.Element | null {
  const [pending, setPending] = useState<PendingSpend | null>(null);
  const now = useNow(props.open);
  const disabled = props.connectionStatus !== "online" || props.busy !== null;
  const pets = props.state?.pets ?? [];
  const confirm = (): void => {
    if (!pending) return;
    if (pending.kind === "feed") props.onFeed(pending.pet.id);
    else if (pending.kind === "train") props.onTrain(pending.pet.id);
    else if (pending.kind === "unlock") props.onUnlock(pending.pet.id, pending.abilityId);
    else if (pending.kind === "hatch") props.onHatch(pending.itemId);
    else props.onBuyFromHermit(pending.species);
    setPending(null);
  };
  return (
    <GameAppShell
      open={props.open}
      title="Pets"
      menuId="pet-chamber"
      headerStatus={{ value: pets.length, label: pets.length === 1 ? "Whistle" : "Whistles" }}
      closeLabel="Close Pets"
      className="pet-panel-shell"
      {...(props.layout ? { layout: props.layout } : {})}
      onClose={props.onClose}
    >
      <div className="pet-panel">
        {props.notice ? <p className="pet-panel-notice" role="status">{props.notice}</p> : null}
        {props.error ? <p className="pet-panel-error" role="alert">{props.error}</p> : null}
        {!props.state ? (
          <GameAppState variant="loading" title="Whistling for your pets">
            Fetching your whistles.
          </GameAppState>
        ) : (
          <>
            <p className="pet-panel-intro">
              One pet can be out at a time. A pet stays out for an hour, then rests at home.
              Training counts up to level {props.state.gearCapLevel}, the average of your best weapon and armour.
            </p>
            {props.state.hermitOffers.length ? (
              <GameAppCard title="Grove Hermit" badge={`${PET_GLIMMER_COSTS.hermit} Glimmer`}>
                <p>The Hermit raises beasts of the grove and will part with one for Glimmer.</p>
                <GameAppActionBar>
                  {props.state.hermitOffers.map((species) => (
                    <GameAppButton key={species} disabled={disabled} onClick={() => setPending({ kind: "hermit", species })}>
                      {PET_SPECIES_DEFINITIONS[species].displayName}
                    </GameAppButton>
                  ))}
                </GameAppActionBar>
              </GameAppCard>
            ) : null}
            {props.state.eggs.length ? (
              <GameAppCard title="Eggs" badge={`Hatch ${PET_GLIMMER_COSTS.hatch} Glimmer`}>
                <ul className="pet-panel-eggs">
                  {props.state.eggs.map((egg) => {
                    const species = PET_SPECIES_DEFINITIONS[egg.species];
                    const owned = pets.some((pet) => pet.species === egg.species);
                    return (
                      <li key={egg.itemId}>
                        <span>{species.source.kind === "repair" ? "Broken Whistle" : `${species.displayName} egg`} ×{egg.quantity}</span>
                        <GameAppButton
                          variant="primary"
                          disabled={disabled || owned || !species.source.available}
                          title={owned ? `You already have a ${species.displayName}.` : undefined}
                          onClick={() => setPending({ kind: "hatch", itemId: egg.itemId, species: egg.species })}
                        >
                          {props.busy === "hatch" ? "Hatching…" : "Hatch"}
                        </GameAppButton>
                      </li>
                    );
                  })}
                </ul>
              </GameAppCard>
            ) : null}
            {props.state.treantCap || props.state.minions?.length ? (
              <GameAppCard
                title="Minions"
                badge={`${props.state.minions?.length ?? 0} / 5`}
              >
                {props.state.minions?.length ? (
                  <ul className="pet-panel-eggs">
                    {props.state.minions.map((minion, index) => (
                      <li key={`${minion.species}-${index}`}>
                        <span>{minionName(minion.species)}{minion.level > 1 ? ` · level ${minion.level}` : ""}</span>
                        {minion.expiresAt ? <small>{statusLabelUntil(minion.expiresAt, now)}</small> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {props.state.treantCap ? (
                  <>
                    <p>Grove Lore lets you grow {props.state.treantCap} treant{props.state.treantCap === 1 ? "" : "s"} at once. Treants stay until they fall.</p>
                    <GameAppActionBar>
                      {TREANT_KINDS.map((kind) => (
                        <GameAppButton key={kind} disabled={disabled} title={TREANT_DEFINITIONS[kind].description} onClick={() => props.onGrowTreant(kind)}>
                          {TREANT_DEFINITIONS[kind].displayName}
                        </GameAppButton>
                      ))}
                    </GameAppActionBar>
                  </>
                ) : null}
              </GameAppCard>
            ) : null}
            <section className="pet-panel-list" aria-label="Your whistles">
              {pets.map((pet) => (
                <PetCard
                  key={pet.id}
                  pet={pet}
                  nowMs={now}
                  serverTime={props.state!.serverTime}
                  busy={props.busy}
                  disabled={disabled}
                  anotherOut={props.state!.activePetId !== null && props.state!.activePetId !== pet.id}
                  berries={props.state!.healItemQuantity}
                  onCall={() => props.onCall(pet.id)}
                  onDismiss={() => props.onDismiss(pet.id)}
                  onFeed={() => setPending({ kind: "feed", pet })}
                  onHeal={() => props.onHeal(pet.id)}
                  onTrain={() => setPending({ kind: "train", pet })}
                  onUnlock={(abilityId) => setPending({ kind: "unlock", pet, abilityId })}
                />
              ))}
            </section>
            {lockedSpecies(pets).length ? (
              <section className="pet-panel-list" aria-label="Locked pets">
                {lockedSpecies(pets).map((speciesId) => (
                  <LockedPetCard key={speciesId} species={speciesId} eggs={props.state!.eggs} />
                ))}
              </section>
            ) : null}
          </>
        )}
      </div>
      {pending ? (
        <GameConfirmationPrompt
          title={spendTitle(pending)}
          category="Glimmer"
          detail={spendDetail(pending)}
          confirmLabel={`Spend ${spendCost(pending)} Glimmer`}
          busy={props.busy !== null}
          confirmEnabled={!disabled}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </GameAppShell>
  );
}

function PetCard(props: Readonly<{
  pet: PetSnapshot;
  nowMs: number;
  serverTime: string;
  busy: PetBusyAction | null;
  disabled: boolean;
  anotherOut: boolean;
  berries: number;
  onCall(): void;
  onDismiss(): void;
  onFeed(): void;
  onHeal(): void;
  onTrain(): void;
  onUnlock(abilityId: PetAbilityId): void;
}>): React.JSX.Element {
  const { pet } = props;
  const species = PET_SPECIES_DEFINITIONS[pet.species];
  const status = statusLabel(pet, props.nowMs);
  const healthPercent = pet.maxHealth > 0 ? Math.round(pet.health / pet.maxHealth * 100) : 0;
  return (
    <GameAppCard
      title={pet.name}
      badge={status}
      className={`pet-panel-card${pet.status === "active" ? " is-out" : ""}`}
      leading={<img className="pet-panel-whistle" src={PET_WHISTLE_ARTWORK_URLS[pet.species]} alt="" />}
      description={species.displayName}
    >
      <p className="pet-panel-rest">Rests {formatDuration(pet.restDurationMs)} after each outing{pet.level > 0 ? ` (level ${pet.level})` : ""}.</p>
      <dl className="pet-panel-stats">
        <div><dt>Level</dt><dd>{pet.effectiveLevel < pet.level ? `${pet.level} (counts as ${pet.effectiveLevel})` : pet.level}</dd></div>
        <div><dt>Health</dt><dd>{pet.health} / {pet.maxHealth}</dd></div>
        <div><dt>Attack</dt><dd>{pet.damage}</dd></div>
        <div><dt>Defense</dt><dd>{pet.defense}</dd></div>
      </dl>
      <div className="pet-panel-health" role="progressbar" aria-label="Pet health" aria-valuemin={0} aria-valuemax={100} aria-valuenow={healthPercent}>
        <i style={{ width: `${healthPercent}%` }} />
      </div>
      <ul className="pet-panel-abilities">
        {species.abilities.map((abilityId) => {
          const ability = PET_ABILITY_DEFINITIONS[abilityId];
          const unlocked = pet.unlockedAbilities.includes(abilityId);
          return (
            <li key={abilityId} className={unlocked ? "is-unlocked" : undefined}>
              <img src={PET_ABILITY_ICON_URLS[abilityId]} alt="" />
              <span><strong>{ability.name}</strong><small>{ability.description}</small></span>
              {unlocked ? <em>Learned</em> : (
                <GameAppButton disabled={props.disabled} onClick={() => props.onUnlock(abilityId)}>
                  {PET_GLIMMER_COSTS.unlockAbility} Glimmer
                </GameAppButton>
              )}
            </li>
          );
        })}
      </ul>
      <GameAppActionBar>
        {pet.status === "active" ? (
          <GameAppButton disabled={props.disabled} onClick={props.onDismiss}>
            {props.busy === "dismiss" ? "Sending…" : "Send Home"}
          </GameAppButton>
        ) : (
          <GameAppButton
            variant="primary"
            disabled={props.disabled || pet.status === "resting"}
            title={props.anotherOut ? "Your other pet will go home." : undefined}
            onClick={props.onCall}
          >
            {props.busy === "call" ? "Calling…" : "Call"}
          </GameAppButton>
        )}
        <GameAppButton disabled={props.disabled} onClick={props.onFeed}>
          Feed · {PET_GLIMMER_COSTS.feed} Glimmer
        </GameAppButton>
        <GameAppButton
          disabled={props.disabled || pet.health >= pet.maxHealth || props.berries < 1}
          title={props.berries < 1 ? "You need a Giving Berry." : undefined}
          onClick={props.onHeal}
        >
          Heal · 1 Berry
        </GameAppButton>
        <GameAppButton disabled={props.disabled || pet.level >= PET_MAX_LEVEL} onClick={props.onTrain}>
          Train · {PET_GLIMMER_COSTS.train} Glimmer
        </GameAppButton>
      </GameAppActionBar>
    </GameAppCard>
  );
}

function lockedSpecies(pets: readonly PetSnapshot[]): PetSpeciesId[] {
  return PET_SPECIES_IDS.filter((id) => !pets.some((pet) => pet.species === id));
}

/** A pet you don't have yet: shown greyed out with what it takes to get one. */
function LockedPetCard(props: Readonly<{ species: PetSpeciesId; eggs: readonly PetEggHolding[] }>): React.JSX.Element {
  const species = PET_SPECIES_DEFINITIONS[props.species];
  const held = props.eggs.find((egg) => egg.species === props.species)?.quantity ?? 0;
  const itemName = species.source.kind === "repair" ? "Broken Whistle" : `${species.displayName} egg`;
  const requirements = lockedRequirements(props.species);
  return (
    <GameAppCard
      title={species.displayName}
      badge={species.source.available ? "Locked" : "Coming soon"}
      className="pet-panel-card is-locked"
      leading={<img className="pet-panel-whistle" src={PET_WHISTLE_ARTWORK_URLS[props.species]} alt="" />}
    >
      <p className="pet-panel-locked-how">To unlock</p>
      <ul className="pet-panel-requirements">
        {requirements.map((line) => <li key={line}>{line}</li>)}
        {held > 0 ? <li className="is-met">You have {held === 1 ? `${/^[AEIOU]/u.test(itemName) ? "an" : "a"} ${itemName}` : `${held} × ${itemName}`}. Hatch it above.</li> : null}
      </ul>
      <ul className="pet-panel-abilities">
        {species.abilities.map((abilityId) => (
          <li key={abilityId}>
            <img src={PET_ABILITY_ICON_URLS[abilityId]} alt="" />
            <span><strong>{PET_ABILITY_DEFINITIONS[abilityId].name}</strong><small>{PET_ABILITY_DEFINITIONS[abilityId].description}</small></span>
          </li>
        ))}
      </ul>
    </GameAppCard>
  );
}

function lockedRequirements(speciesId: PetSpeciesId): string[] {
  const species = PET_SPECIES_DEFINITIONS[speciesId];
  const lines = [species.source.description];
  if (species.source.kind === "egg") lines.push(`Hatching costs ${PET_GLIMMER_COSTS.hatch} Glimmer.`);
  else if (species.source.kind === "repair") lines.push(`Repairing costs ${PET_GLIMMER_COSTS.hatch} Glimmer.`);
  else if (species.source.kind === "hermit") lines.push(`Costs ${PET_GLIMMER_COSTS.hermit} Glimmer.`);
  if (species.requiresSkill) lines.push(`Needs Rare Beast Mastery rank ${species.requiresSkill.rank}.`);
  if (!species.source.available) lines.push("Its home isn't open yet.");
  return lines;
}

function statusLabel(pet: PetSnapshot, nowMs: number): string {
  if (pet.status === "active" && pet.activeUntil) return `Out ${formatDuration(Date.parse(pet.activeUntil) - nowMs)}`;
  if (pet.status === "resting" && pet.restUntil) return `Resting ${formatDuration(Date.parse(pet.restUntil) - nowMs)}`;
  return "Ready";
}

function minionName(species: string): string {
  if (species.startsWith("treant_")) return TREANT_DEFINITIONS[species.slice("treant_".length) as TreantKind].displayName;
  if (species === "valkyrie") return "Freed Valkyrie";
  return species === "bone_thrall" ? "Bone Thrall" : "Grave Echo";
}

function statusLabelUntil(iso: string, nowMs: number): string {
  return `${formatDuration(Date.parse(iso) - nowMs)} left`;
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function spendCost(pending: PendingSpend): number {
  if (pending.kind === "feed") return PET_GLIMMER_COSTS.feed;
  if (pending.kind === "train") return PET_GLIMMER_COSTS.train;
  if (pending.kind === "unlock") return PET_GLIMMER_COSTS.unlockAbility;
  if (pending.kind === "hatch") return PET_GLIMMER_COSTS.hatch;
  return PET_GLIMMER_COSTS.hermit;
}

function spendTitle(pending: PendingSpend): string {
  if (pending.kind === "feed") return `Feed ${pending.pet.name}`;
  if (pending.kind === "train") return `Train ${pending.pet.name}`;
  if (pending.kind === "unlock") return `Teach ${PET_ABILITY_DEFINITIONS[pending.abilityId].name}`;
  if (pending.kind === "hatch") return `Hatch ${PET_SPECIES_DEFINITIONS[pending.species].displayName}`;
  return `Buy ${PET_SPECIES_DEFINITIONS[pending.species].displayName}`;
}

function spendDetail(pending: PendingSpend): string {
  if (pending.kind === "feed") return "Skips rest, resets hunger aging and brings the pet out for a full hour.";
  if (pending.kind === "train") return `Raises ${pending.pet.name} to level ${pending.pet.level + 1}.`;
  if (pending.kind === "unlock") return PET_ABILITY_DEFINITIONS[pending.abilityId].description;
  if (pending.kind === "hatch") return "Uses the egg. The whistle is bound to you.";
  return "The whistle is bound to you.";
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
