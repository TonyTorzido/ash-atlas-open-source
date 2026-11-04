import type { PublicProfile } from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import { GameActionPrompt, type GamePromptAction } from "./GameActionPrompt.js";

export type PlayerRelation = "friend" | "neutral" | "enemy";

export type PlayerRelationContext = Readonly<{
  /** Same party as the viewer (the server's ally rule). */
  partyMember?: boolean;
  viewerKingdomId?: string | null;
  viewerSettlementId?: string | null;
  /** The viewer may attack this player back (their aggressor, or fighting). */
  revenge?: boolean;
  /** The viewer's city or kingdom is at war with this player's. */
  atWar?: boolean;
}>;

/** Enemy (marked, aggressor or fighting, or at war) beats friend (party, friends, same city/kingdom); anyone else is neutral. */
export function playerRelation(profile: PublicProfile, context: PlayerRelationContext = {}): PlayerRelation {
  if (profile.relationship.enemyMarkedByViewer || context.revenge === true || context.atWar === true) return "enemy";
  if (
    context.partyMember === true ||
    profile.relationship.friendship === "friends" ||
    (context.viewerKingdomId && profile.kingdom?.id === context.viewerKingdomId) ||
    (context.viewerSettlementId && profile.settlement?.id === context.viewerSettlementId)
  ) return "friend";
  return "neutral";
}

export type PlayerTapMenuProps = Readonly<{
  profile: PublicProfile | null;
  loadingLabel?: string | null;
  relation: PlayerRelation;
  /** PvP status line already formatted (Fighting, Your aggressor, You struck them, with time left). */
  pvpStatusLabel?: string | null;
  /** Hide Attack when the client already knows the server would refuse it. */
  attackBlocked?: boolean;
  /** The attack lands one hit, then the 20-hour block starts unless they fight back. */
  attackOneSwing?: boolean;
  /** Skills usable on this player (own targetable skills, then the active pet's abilities). */
  skillActions?: readonly GamePromptAction[];
  /** Actions on your own character (worn utility gear). */
  selfActions?: readonly GamePromptAction[];
  onAttack(playerId: string): void;
  onViewProfile(): void;
  onClose(): void;
}>;

/** Tapping another player: the standard compact popup with relationship-based actions. */
export function PlayerTapMenu({
  profile,
  loadingLabel = null,
  relation,
  pvpStatusLabel = null,
  attackBlocked = false,
  attackOneSwing = false,
  skillActions = [],
  selfActions = [],
  onAttack,
  onViewProfile,
  onClose
}: PlayerTapMenuProps): React.JSX.Element {
  const [mode, setMode] = useState<"menu" | "confirm" | "engaged">("menu");
  const playerId = profile?.playerId ?? null;
  useEffect(() => { setMode("menu"); }, [playerId]);
  const name = profile?.displayName ?? "Player";
  const canAttack = profile !== null && !profile.isSelf && relation !== "friend" && !attackBlocked;
  const showSkills = canAttack && (relation === "enemy" || mode === "engaged");
  // Skills on cooldown stay visible: their label carries the remaining seconds.
  const skills = showSkills ? skillActions : [];
  const category = profile ? `Level ${profile.level}${profile.class ? ` · ${profile.class.name}` : ""}` : loadingLabel;

  const actions: GamePromptAction[] = [];
  if (profile && mode === "confirm") {
    actions.push({
      key: "attack-confirm",
      label: "Attack",
      tone: "danger",
      onSelect: () => { onAttack(profile.playerId); setMode("engaged"); }
    });
  } else if (profile) {
    if (canAttack && mode !== "engaged") {
      actions.push({
        key: "attack",
        label: "Attack",
        tone: "danger",
        onSelect: () => { if (relation === "enemy") onAttack(profile.playerId); else setMode("confirm"); }
      });
    }
    if (profile.isSelf) actions.push(...selfActions);
    actions.push({ key: "profile", label: "View Profile", tone: "primary", onSelect: onViewProfile });
  }

  return <GameActionPrompt
    compact
    dismissOnOutsideClick
    elevated
    title={mode === "confirm" ? `Attack ${name}?` : name}
    category={mode === "confirm" ? null : category}
    detail={mode === "confirm" && attackOneSwing
      ? "You'll land one hit, then can't attack them for 20h unless they fight back. An Aggressive player fights back at once."
      : pvpStatusLabel}
    ariaLabel={`Actions for ${name}`}
    className="player-tap-menu"
    skills={skills}
    actions={actions}
    cancelLabel={mode === "confirm" ? "Back" : "Cancel"}
    onCancel={mode === "confirm" ? () => setMode("menu") : onClose}
  />;
}
