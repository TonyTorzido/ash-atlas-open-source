import { useState } from "react";

import {
  type CityInfoSnapshot,
  type CityConstructionAction,
  type CityMembershipSnapshot,
  type CitySnapshot,
  type CityStructureSnapshot,
  type MarketInteger
} from "@ash-atlas/shared";
import {
  GameActionPrompt,
  type GamePromptAction
} from "./GameActionPrompt.js";
import { MaterialChips, type MaterialNeed } from "./MaterialRequirements.js";

type CityPanelProps = {
  city: CitySnapshot | null;
  info: CityInfoSnapshot | null;
  membership: CityMembershipSnapshot | null;
  anchorHouse: CityStructureSnapshot | null;
  ownPlayerId: string;
  online: boolean;
  busy: boolean;
  error: string | null;
  onAdvanceConstruction(cityId: string, action: CityConstructionAction): void;
  onOpenBuild?(): void;
  onVisitCity(cityId: string): void;
  onVisitHouse(structureId: string): void;
  onClose(): void;
  layout?: "desktop" | "phone";
  /** Inventory totals and Gold so the stage cost can show what is missing. */
  materialCounts?: Readonly<Record<string, number>> | undefined;
  goldBalance?: MarketInteger | null | undefined;
};

export function CityPanel({
  city,
  info,
  membership,
  anchorHouse,
  ownPlayerId,
  online,
  busy,
  error,
  onAdvanceConstruction,
  onVisitCity,
  onVisitHouse,
  onClose,
  layout,
  onOpenBuild,
  materialCounts,
  goldBalance
}: CityPanelProps): React.JSX.Element | null {
  const [expandedCityId, setExpandedCityId] = useState<string | null>(null);
  if (!city) return null;
  const isNpcGoblinCity = city.controllerKind === "npc" && city.culture === "goblin";
  const infoExpanded = expandedCityId === city.id;
  const currentMembership = membership?.cityId === city.id ? membership : null;
  const haveOf = (itemId: string): number | undefined => materialCounts ? materialCounts[itemId] ?? 0 : undefined;
  const constructionPhase = city.constructionPhase ?? "complete";
  const underConstruction = constructionPhase !== "complete";
  const alreadyContributed = city.constructionContributions?.some(
    (contribution) => contribution.playerId === ownPlayerId
  ) ?? false;
  const construction: Readonly<{
    action: CityConstructionAction;
    label: string;
    material: MaterialNeed;
  }> | null = constructionPhase === "blueprint"
    ? { action: "build_foundation", label: "Build Foundation", material: { itemId: "stone", name: "Stone", quantity: 120, have: haveOf("stone") } }
    : constructionPhase === "foundation"
      ? { action: "build_frames", label: "Build Frames", material: { itemId: "wood", name: "Wood", quantity: 450, have: haveOf("wood") } }
      : constructionPhase === "framing"
        ? { action: "finish", label: "Finishing Touches", material: { itemId: "gold", name: "Gold", quantity: 4_500, have: goldBalance === null || goldBalance === undefined ? undefined : BigInt(goldBalance) } }
        : null;
  const joinReason = currentMembership
    ? `Member · ${currentMembership.role}`
    : info?.joinReason ?? "Build a City House on this city’s land to become a member.";
  const actions: GamePromptAction[] = !isNpcGoblinCity && underConstruction && construction
    ? [{
        key: "construction",
        label: layout === "phone" && onOpenBuild ? "Open Construction" : construction.label,
        enabled: online && !busy && !alreadyContributed,
        busy,
        disabledReason: alreadyContributed
          ? "A different player must complete this stage."
          : online ? null : "Reconnect to continue construction.",
        onSelect: () => layout === "phone" && onOpenBuild
          ? onOpenBuild()
          : onAdvanceConstruction(city.id, construction.action)
      }]
    : [{
        key: "visit",
        label: isNpcGoblinCity
          ? "Travel to Goblin City"
          : anchorHouse
          ? `Travel to ${anchorHouse.type === "mayor_house" ? "Mayor House" : "City House"}`
          : "Travel to Town Hall",
        enabled: anchorHouse ? anchorHouse.state === "active" : city.jumpable,
        onSelect: () => {
          if (!isNpcGoblinCity && anchorHouse) {
            onVisitHouse(anchorHouse.structureId);
            return;
          }
          onClose();
          onVisitCity(city.id);
        }
      }, {
        key: "info",
        label: "Info",
        tone: "secondary",
        onSelect: () => setExpandedCityId(infoExpanded ? null : city.id)
      }];
  return (
    <GameActionPrompt
      title={city.name}
      category={isNpcGoblinCity ? "GOBLIN CITY" : underConstruction ? "CITY CONSTRUCTION" : "CITY"}
      detail={isNpcGoblinCity
        ? "Neutral goblin trading settlement"
        : underConstruction && construction
        ? constructionPhase === "blueprint" ? "Blueprint" : constructionPhase === "foundation" ? "Foundation" : "Framing"
        : city.regionCode ?? city.countryCode}
      message={error ? { text: error, tone: "error" } : null}
      actions={actions}
      onCancel={onClose}
      content={underConstruction && construction && !isNpcGoblinCity ? (
        <MaterialChips label="Construction stage materials" materials={[construction.material]} />
      ) : infoExpanded ? (
        <dl>
          {isNpcGoblinCity ? (
            <><dt>Settlement</dt><dd>Goblin-controlled neutral trading city</dd></>
          ) : (
            <>
              <dt>Mayor</dt><dd>{city.mayorUsername ?? (city.mayorPlayerId ? "Unknown Mayor" : "Vacant")}</dd>
              <dt>Founder</dt><dd>{city.founderUsername ?? "Unknown founder"}</dd>
            </>
          )}
          <dt>Municipality</dt><dd>{city.name}, {city.regionCode ?? city.countryCode}</dd>
          <dt>Expansion flags</dt>
          <dd>{info
            ? `${info.expansionFlagCount} of ${info.expansionFlagLimit}`
            : "Loading…"}</dd>
          <dt>Founded</dt><dd>{new Date(city.createdAt).toLocaleDateString()}</dd>
          {city.founderMayorClaimDeadline ? (
            <>
              <dt>Founder Mayor claim deadline</dt>
              <dd>{new Date(city.founderMayorClaimDeadline).toLocaleTimeString()}</dd>
            </>
          ) : null}
        </dl>
      ) : isNpcGoblinCity ? (
        <p>This independent Goblin City welcomes neutral travelers and traders.</p>
      ) : !underConstruction && !currentMembership ? (
        <p>{joinReason} Open the Build menu to place it where you are standing.</p>
      ) : null}
    />
  );
}
