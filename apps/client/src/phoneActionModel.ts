import type { Handedness } from "./uiEnvironment.js";

export type PhoneActionCategory = "combat" | "context" | "world" | "system";
export type PhoneActionSide = "left" | "right";
export type PhoneActionIcon = "attack" | "stop" | "harvest" | "pickup" | "amount" | "visit" | "build" | "water" | "city" | "delete" | "more";

export type PhoneAction = {
  id: string;
  label: string;
  icon: PhoneActionIcon;
  category: PhoneActionCategory;
  priority: number;
  preferredSide?: PhoneActionSide;
  overflowOnly?: boolean;
  enabled: boolean;
  disabledReason?: string | null;
  active?: boolean;
  cooldownLabel?: string | null;
  count?: number | null;
  execute(): void;
};

export type PhoneActionLayout = {
  left: PhoneAction[];
  right: PhoneAction[];
  overflow: PhoneAction[];
};

export function layoutPhoneActions(
  actions: readonly PhoneAction[],
  handedness: Handedness,
  perSide = 3
): PhoneActionLayout {
  const sorted = [...actions].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const left: PhoneAction[] = [];
  const right: PhoneAction[] = [];
  const overflow: PhoneAction[] = [];
  for (const action of sorted) {
    if (action.overflowOnly) {
      overflow.push(action);
      continue;
    }
    const preferred = handedness === "left" ? mirror(action.preferredSide) : action.preferredSide;
    const first = preferred === "left" ? left : preferred === "right" ? right : left.length <= right.length ? left : right;
    const second = first === left ? right : left;
    if (first.length < perSide) first.push(action);
    else if (second.length < perSide) second.push(action);
    else overflow.push(action);
  }
  return { left, right, overflow };
}

function mirror(side: PhoneActionSide | undefined): PhoneActionSide | undefined {
  return side === "left" ? "right" : side === "right" ? "left" : undefined;
}
