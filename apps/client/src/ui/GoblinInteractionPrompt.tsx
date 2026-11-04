import type { CombatEntitySnapshot } from "@ash-atlas/shared";

import {
  GameActionPrompt,
  type GamePromptPresentationState
} from "./GameActionPrompt.js";

export type GoblinInteractionTarget = CombatEntitySnapshot & Readonly<{
  kind: "mob";
  archetypeKey: "goblin";
  npcFaction: NonNullable<CombatEntitySnapshot["npcFaction"]> & Readonly<{
    culture: "goblin";
    relation: "neutral";
  }>;
}>;

export function isGoblinInteractionTarget(
  target: CombatEntitySnapshot | null | undefined
): target is GoblinInteractionTarget {
  return target?.kind === "mob" &&
    target.archetypeKey === "goblin" &&
    target.npcFaction?.culture === "goblin" &&
    target.npcFaction.relation === "neutral";
}

export function combatEntityPrimaryInteraction(
  target: CombatEntitySnapshot
): "talk" | "start-event" | "attack" {
  if (isGoblinInteractionTarget(target)) return "talk";
  return target.archetypeKey === "xoral" && target.bossEventState === "dormant"
    ? "start-event"
    : "attack";
}

export function GoblinInteractionPrompt({
  target,
  conversationLine = null,
  presentationState,
  actionsReady = true,
  onTalk,
  onClose
}: Readonly<{
  target: CombatEntitySnapshot;
  conversationLine?: string | null;
  presentationState?: GamePromptPresentationState | undefined;
  actionsReady?: boolean;
  onTalk(): void;
  onClose(): void;
}>): React.JSX.Element {
  const conversing = conversationLine !== null;
  return <GameActionPrompt
    title={target.name}
    category={conversing ? "CONVERSATION" : "GOBLIN"}
    ariaLabel={`${target.name} conversation`}
    presentationState={presentationState}
    actionsReady={actionsReady}
    content={conversing ? <p>{conversationLine}</p> : null}
    actions={conversing ? [] : [{
      key: "talk",
      label: "Talk",
      onSelect: onTalk
    }]}
    cancelLabel={conversing ? "Close" : "Cancel"}
    onCancel={onClose}
  />;
}
