import type { CombatEvent, LatLon } from "@ash-atlas/shared";

export const CLASS_ABILITY_ACTIVATION_PULSE_DURATION_MS = 720;

export type ClassAbilityActivationPulsePresentation = {
  eventId: string;
  abilityId: string;
  position: LatLon;
  radiusM: number | null;
  color: number;
  progress: number;
  opacity: number;
};

type ActivePulse = Omit<
  ClassAbilityActivationPulsePresentation,
  "progress" | "opacity"
> & { startedAtMs: number };

const CLASS_FAMILY_COLORS: Readonly<Record<string, number>> = {
  warrior: 0xef4444,
  knight: 0x94a3b8,
  ranger: 0x22c55e,
  hunter: 0xf97316,
  druid: 0x84cc16,
  ninja: 0xa855f7
};
const FALLBACK_COLOR = 0xf8fafc;

export function classAbilityActivationColor(abilityId: string): number {
  return CLASS_FAMILY_COLORS[abilityId.split("_")[0] ?? ""] ?? FALLBACK_COLOR;
}

export class ClassAbilityActivationPulseState {
  private readonly active = new Map<string, ActivePulse>();

  enqueue(events: readonly CombatEvent[], nowMs: number): void {
    for (const event of events) {
      if (
        event.type !== "CLASS_ABILITY_ACTIVATED" ||
        !event.abilityId ||
        !event.sourceEntityId ||
        !event.position
      ) continue;
      this.active.set(event.eventId, {
        eventId: event.eventId,
        abilityId: event.abilityId,
        position: { ...event.position },
        radiusM: event.radiusM ?? null,
        color: classAbilityActivationColor(event.abilityId),
        startedAtMs: nowMs
      });
    }
  }

  presentations(nowMs: number): ClassAbilityActivationPulsePresentation[] {
    const presentations: ClassAbilityActivationPulsePresentation[] = [];
    for (const [eventId, pulse] of this.active) {
      const progress = Math.max(
        0,
        (nowMs - pulse.startedAtMs) / CLASS_ABILITY_ACTIVATION_PULSE_DURATION_MS
      );
      if (progress >= 1) {
        this.active.delete(eventId);
        continue;
      }
      presentations.push({
        eventId: pulse.eventId,
        abilityId: pulse.abilityId,
        position: { ...pulse.position },
        radiusM: pulse.radiusM,
        color: pulse.color,
        progress,
        opacity: 1 - progress
      });
    }
    return presentations;
  }

  clear(): void {
    this.active.clear();
  }
}
